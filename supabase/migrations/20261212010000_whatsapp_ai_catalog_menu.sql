-- LISTAGEM DO CATÁLOGO pela IA do WhatsApp ("manda o cardápio", "quero ver o catálogo", "o que vocês vendem?", "quais bebidas têm?").
-- Função NOVA e somente de leitura: devolve, do cadastro REAL da empresa do job, as categorias ativas com seus produtos ativos e
-- à venda (nome e preço). A empresa vem SEMPRE do job (service_role). Nada de IA, nada de texto livre: o texto da resposta é montado
-- pelo worker a partir destes dados. Não altera nenhuma função existente (a consulta de conhecimento segue igual).
--   p_query: a mensagem do cliente. Palavras genéricas (cardápio, catálogo, menu, vendem, produtos, mostra...) são ignoradas; o que sobrar
--            tem de pertencer ao nome de uma categoria ativa (ex.: "bebidas") — senão 'no_category' (o fluxo normal segue).
--   Disponibilidade: produto inativo, categoria inativa ou fora de venda (available_for_sale=false) nunca entra; no modo 'live' também
--            não entra o produto com estoque controlado zerado. No modo 'catalog' não se promete estoque (mesma regra da consulta atual).
create function public.whatsapp_ai_catalog_menu_job(p_job_id uuid, p_query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_job public.whatsapp_ai_jobs;
  v_s public.company_whatsapp_ai_settings;
  v_company uuid;
  v_generic constant text[] := array[
    'manda','mande','mandar','envia','envie','enviar','mostra','mostre','mostrar','ver','vejo','quero','queria','gostaria','pode','poderia',
    'catalogo','cardapio','menu','vendem','vende','vendo','vender','produto','produtos','opcao','opcoes','item','itens','categoria','categorias',
    'tem','temos','tudo','todos','todas','todo','completo','completa','oferecem','oferece','servem','serve','trabalham','disponivel','disponiveis',
    'voces','pra','para','hoje','agora','favor','pfv','nao','sim','ola','oi'];
  v_tokens text[];
  v_content text[];
  v_cat_ids uuid[];
  v_scope text;
  v_cats jsonb;
  v_total integer;
begin
  select * into v_job from public.whatsapp_ai_jobs where id = p_job_id and status = 'processing';
  if not found then
    raise exception 'Job não encontrado ou não está em processamento.' using errcode = 'PT404';
  end if;
  v_company := v_job.company_id;
  select * into v_s from public.company_whatsapp_ai_settings where company_id = v_company;
  if not found or not v_s.knowledge_enabled then
    return jsonb_build_object('enabled', false);
  end if;

  v_tokens := public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_canon_text(coalesce(p_query, '')));
  select coalesce(array_agg(t), '{}'::text[]) into v_content from unnest(v_tokens) t where not (t = any (v_generic));

  if cardinality(v_content) = 0 then
    v_scope := 'all';
    select coalesce(array_agg(c.id), '{}'::uuid[]) into v_cat_ids from public.product_categories c where c.company_id = v_company and c.is_active;
  else
    v_scope := 'category';
    select coalesce(array_agg(c.id), '{}'::uuid[]) into v_cat_ids
      from public.product_categories c
     where c.company_id = v_company and c.is_active
       and v_content <@ public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_canon_text(c.name));
    if cardinality(v_cat_ids) = 0 then
      return jsonb_build_object('result', 'no_category');
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'count', x.n, 'products', x.items) order by x.name), '[]'::jsonb),
         coalesce(sum(jsonb_array_length(x.items)), 0)::int
    into v_cats, v_total
    from (
      select c.name,
             (select count(*)::int from public.products q
               where q.company_id = v_company and q.category_id = c.id and q.is_active and q.available_for_sale
                 and (v_s.ai_availability_mode <> 'live' or q.stock_control = 'none' or q.stock_quantity > 0)) as n,
             (select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'price', p.sale_price) order by p.name), '[]'::jsonb)
                from (
                  select p0.name, p0.sale_price
                    from public.products p0
                   where p0.company_id = v_company and p0.category_id = c.id and p0.is_active and p0.available_for_sale
                     and (v_s.ai_availability_mode <> 'live' or p0.stock_control = 'none' or p0.stock_quantity > 0)
                   order by p0.name
                   limit 60
                ) p) as items
        from public.product_categories c
       where c.company_id = v_company and c.id = any (v_cat_ids)
       order by c.name
       limit 20
    ) x
   where jsonb_array_length(x.items) > 0;

  if v_total = 0 then
    return jsonb_build_object('result', 'empty', 'scope', v_scope);
  end if;
  return jsonb_build_object('result', 'ok', 'scope', v_scope, 'total', v_total, 'categories', v_cats,
                            'business_name', (select c.name from public.companies c where c.id = v_company));
end;
$$;
revoke execute on function public.whatsapp_ai_catalog_menu_job(uuid, text) from public, anon, authenticated;
grant execute on function public.whatsapp_ai_catalog_menu_job(uuid, text) to service_role;

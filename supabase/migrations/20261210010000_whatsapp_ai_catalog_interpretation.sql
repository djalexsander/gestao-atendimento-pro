-- IA do WhatsApp — INTERPRETAÇÃO INTELIGENTE DO CATÁLOGO (sem IA extra, sem novo módulo): reaproveita a consulta existente (whatsapp_ai_knowledge_core, a MESMA usada pelo
-- automático e pela sugestão) e a deixa mais esperta, sempre dentro do catálogo da PRÓPRIA empresa (a empresa vem do job/conversa; produtos ativos em categoria ativa; preço cadastrado).
--
--   * whatsapp_ai_canon_text (nova, interna): apelidos/abreviações/expressões populares em UM lugar, aplicados à pergunta E aos nomes do catálogo (os dois lados falam a mesma língua):
--     espetinho->espeto, refri->refrigerante, breja/cerva/cervejinha->cerveja, coquinha->coca, cocacola->coca cola, zerinho/zerado/diet/sem açúcar->zero, latinha->lata, longneck->long neck.
--   * whatsapp_ai_knowledge_core: (1) corrige erros de digitação pelo vocabulário DA EMPRESA (mesma letra inicial, distância de edição curta, candidato ÚNICO; "haineken"->heineken);
--     (2) separa o que foi pedido e NÃO existe no cardápio: tipo/marca conhecida (Brahma, Pepsi...) e atributos (zero, lata, long neck...); (3) exact_match: só é verdadeiro quando algum produto
--     cobre TODOS os termos e nada pedido ficou sem correspondência — assim a IA nunca troca "Coca Zero" por "Coca" sozinha; (4) alternatives: até 3 produtos REAIS da mesma família quando a marca
--     pedida não existe, sem repetir o que já veio; (5) catalog_size/produtos/categorias/perfil/entrega continuam como antes.
--   Resultado ACRESCENTA as chaves exact_match, corrections, missing{brands,attrs}, requested_type e alternatives; as demais não mudam (a lista de produtos de quem já casava continua a mesma).
--   Ausência no catálogo NÃO é indisponibilidade: 'availability' continua vindo só do estoque/venda dos produtos que existem.
-- NÃO MEXE: order flow (pedidos da IA), cardápio PDF, webhook, Coexistence, envio, cobrança, módulos, query_terms/tokens/norm_text (usados pelos pedidos) nem o formato de nenhuma outra função.
-- Aditiva e reversível: supabase/rollbacks/whatsapp-ai-catalog-interpretation/20261210010000_rollback.sql.

create function public.whatsapp_ai_canon_text(p_text text)
returns text
language sql
immutable
set search_path = public
as $$
  select btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(' ' || public.whatsapp_ai_norm_text(p_text) || ' ', '\m(espetinhos?)\M', ' espeto ', 'g'), '\m(refris?|refrigerantes?)\M', ' refrigerante ', 'g'), '\m(brejas?|cervas?|cervejinhas?|cervejas?)\M', ' cerveja ', 'g'), '\m(coquinha|coquinhas)\M', ' coca ', 'g'), '\m(cocacola)\M', ' coca cola ', 'g'), '\m(zerinho|zerado|zerada|diet|sem acucar|sem acuc)\M', ' zero ', 'g'), '\m(latinhas?|latas?)\M', ' lata ', 'g'), '\m(longnecks?)\M', ' long neck ', 'g'), '\s+', ' ', 'g'))
$$;
revoke execute on function public.whatsapp_ai_canon_text(text) from public, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.whatsapp_ai_knowledge_core(p_company_id uuid, p_query text, p_limit integer DEFAULT 8)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_s public.company_whatsapp_ai_settings;
  v_company uuid;
  v_mode text;
  v_terms jsonb;
  v_req text[];
  v_bonus text[];
  v_nreq integer;
  v_limit integer := least(greatest(coalesce(p_limit, 8), 1), 20);
  v_cat_ids uuid[];
  v_listing boolean := false;
  v_total integer := 0;
  v_products jsonb := '[]'::jsonb;
  v_ambiguous boolean := false;
  v_categories jsonb;
  v_profile public.company_business_profile;
  v_c public.companies;
  v_d public.company_delivery_settings;
  v_tokens text[];
  v_zone jsonb;
  v_delivery jsonb;
  v_top numeric;
  v_top_n integer;
  v_vocab text[];
  -- interpretação do pedido (20261210010000)
  v_raw text[];
  v_i integer;
  v_t text;
  v_lim integer;
  v_cands text[];
  v_corr jsonb := '[]'::jsonb;
  v_unk text[];
  v_missing_brands text[] := '{}';
  v_missing_attrs text[] := '{}';
  v_type text;
  v_type_tokens text[];
  v_exact boolean := false;
  v_alt jsonb := '[]'::jsonb;
  v_types constant jsonb := '{"cerveja":["cerveja","heineken","brahma","skol","budweiser","stella","corona","amstel","itaipava","eisenbahn","devassa","bohemia","petra","becks","chopp","lager","pilsen"],"refrigerante":["refrigerante","coca","pepsi","fanta","sprite","guarana","kuat","sukita","schweppes","tonica"],"suco":["suco","del","valle"],"energetico":["energetico","red","bull","monster"],"agua":["agua","mineral"]}'::jsonb;
  v_attrs constant text[] := array['zero','diet','light','lata','garrafa','long','neck','litro','grande','medio','pequeno','familia'];
  v_m text[];
begin
  v_company := p_company_id;

  select * into v_s from public.company_whatsapp_ai_settings where company_id = v_company;
  if not found or not v_s.knowledge_enabled then
    return jsonb_build_object('enabled', false);
  end if;
  v_mode := v_s.ai_availability_mode;

  v_terms := public.whatsapp_ai_knowledge_query_terms(public.whatsapp_ai_canon_text(p_query));
  select coalesce(array_agg(x), '{}'::text[]) into v_req from jsonb_array_elements_text(v_terms -> 'required') x;
  select coalesce(array_agg(x), '{}'::text[]) into v_bonus from jsonb_array_elements_text(v_terms -> 'bonus') x;
  -- só contam os termos que existem no catálogo da empresa ("está", "R$ 10"... não viram exigência)
  select coalesce(array_agg(distinct x), '{}'::text[]) into v_vocab
    from (
      select unnest(public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_canon_text(p.name))
                    || public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_canon_text(c.name))
                    || public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_canon_text(coalesce(p.description, '')))) as x
        from public.products p
        join public.product_categories c on c.id = p.category_id and c.company_id = p.company_id
       where p.company_id = v_company and p.is_active and c.is_active
    ) t;
  -- INTERPRETAÇÃO (sem IA, sem custo): palavra da pergunta que NÃO existe no catálogo desta empresa tenta ser corrigida pelo vocabulário DELA
  -- (mesma letra inicial, distância de edição pequena e candidato ÚNICO); o que continuar sem correspondência é classificado (tipo/marca conhecida
  -- ou atributo como zero/lata/long neck) para a IA nunca confundir "não existe no cardápio" com falta de estoque e nunca trocar o produto sozinha.
  v_raw := v_req;
  for v_i in 1..coalesce(cardinality(v_raw), 0) loop
    v_t := v_raw[v_i];
    if v_t = any (v_vocab) or char_length(v_t) < 4 or v_t ~ '[0-9]' then continue; end if;
    v_lim := case when char_length(v_t) >= 7 then 2 else 1 end;
    select array_agg(q.x order by q.x) into v_cands
      from (
        select z.x, z.d, min(z.d) over () as md
          from (
            select x, public.whatsapp_ai_edit_distance(v_t, x, v_lim) as d
              from unnest(v_vocab) x
             where left(x, 1) = left(v_t, 1) and abs(char_length(x) - char_length(v_t)) <= 2 and x !~ '[0-9]'
          ) z
         where z.d <= v_lim
      ) q
     where q.d = q.md;
    if cardinality(v_cands) = 1 then
      v_corr := v_corr || jsonb_build_array(jsonb_build_object('from', v_t, 'to', v_cands[1]));
      v_raw[v_i] := v_cands[1];
    end if;
  end loop;
  select coalesce(array_agg(distinct r), '{}'::text[]) into v_unk from unnest(v_raw) r where r <> all (v_vocab);
  v_missing_attrs := coalesce((select array_agg(u) from unnest(v_unk) u where u = any (v_attrs)), '{}'::text[]);
  -- tamanho pedido ("600 ml", "2 litros") que nenhum produto ativo da empresa tem: atributo ausente (quantidade "2 heineken" NÃO é tamanho)
  for v_m in select array[coalesce(m[1], m[2]), case when m[1] is not null then 'ml' else 'l' end]
               from regexp_matches(public.whatsapp_ai_canon_text(p_query), '(?:^| )(?:([0-9]{2,4}) ?ml|([0-9]{1,2}) ?(?:l|litros?))(?: |$)', 'g') m loop
    if not exists (
      select 1 from public.products p join public.product_categories c on c.id = p.category_id and c.company_id = p.company_id
       where p.company_id = v_company and p.is_active and c.is_active
         and public.whatsapp_ai_canon_text(p.name || ' ' || coalesce(p.description, '')) ~ ('(^| )' || v_m[1] || ' ?' || case when v_m[2] = 'ml' then 'ml' else '(l|litros?)' end || '( |$)')
    ) then
      v_missing_attrs := v_missing_attrs || (v_m[1] || v_m[2]);
    end if;
  end loop;
  select coalesce(array_agg(u), '{}'::text[]) into v_missing_brands
    from unnest(v_unk) u
   where exists (select 1 from jsonb_each(v_types) e where e.value ? u);
  if cardinality(v_missing_brands) > 0 then
    select e.key into v_type from jsonb_each(v_types) e where e.value ? v_missing_brands[1] limit 1;
  end if;
  select coalesce(array_agg(distinct r), '{}'::text[]) into v_req from unnest(v_raw) r where r = any (v_vocab);
  v_nreq := cardinality(v_req);

  -- categorias ativas (resumo compacto, sempre)
  select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'products', t.n) order by t.name), '[]'::jsonb)
    into v_categories
    from (
      select c.name, count(p.id)::int as n
        from public.product_categories c
        join public.products p on p.category_id = c.id and p.company_id = c.company_id and p.is_active
       where c.company_id = v_company and c.is_active
       group by c.id, c.name
       order by c.name
       limit 20
    ) t;

  if v_nreq > 0 then
    -- pergunta genérica de categoria ("quais espetos vocês têm?"): todos os termos pertencem ao nome de uma categoria ativa
    select coalesce(array_agg(c.id), '{}'::uuid[]) into v_cat_ids
      from public.product_categories c
     where c.company_id = v_company and c.is_active
       and v_req <@ public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_canon_text(c.name));
    v_listing := cardinality(v_cat_ids) > 0;

    if v_listing then
      v_limit := least(greatest(v_limit, 15), 20);
      select count(*)::int into v_total
        from public.products p
       where p.company_id = v_company and p.is_active and p.category_id = any (v_cat_ids);
      select coalesce(jsonb_agg(jsonb_build_object(
               'name', t.name, 'category', t.cat_name, 'price', t.sale_price,
               'description', t.descr, 'availability', t.avail) order by t.name), '[]'::jsonb)
        into v_products
        from (
          select p.name, c.name as cat_name, p.sale_price, nullif(left(btrim(coalesce(p.description, '')), 200), '') as descr,
                 case when v_mode = 'live' then
                        case when p.available_for_sale and (p.stock_control = 'none' or p.stock_quantity > 0) then 'available' else 'unavailable' end
                      else 'in_menu' end as avail
            from public.products p
            join public.product_categories c on c.id = p.category_id and c.company_id = p.company_id
           where p.company_id = v_company and p.is_active and c.is_active and p.category_id = any (v_cat_ids)
           order by p.name
           limit v_limit
        ) t;
    else
      with prods as materialized (
        select p.name, c.name as cat_name, p.sale_price, nullif(left(btrim(coalesce(p.description, '')), 200), '') as descr,
               case when v_mode = 'live' then
                      case when p.available_for_sale and (p.stock_control = 'none' or p.stock_quantity > 0) then 'available' else 'unavailable' end
                    else 'in_menu' end as avail,
               public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_canon_text(p.name)) as nt,
               public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_canon_text(c.name)) as ct,
               public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_canon_text(coalesce(p.description, ''))) as dt
          from public.products p
          join public.product_categories c on c.id = p.category_id and c.company_id = p.company_id
         where p.company_id = v_company and p.is_active and c.is_active
      ), scored as materialized (
        select pr.*,
               (select count(*) from unnest(v_req) r where r = any (pr.nt)) as n_name,
               (select count(*) from unnest(v_req) r where r = any (pr.ct)) as n_cat,
               (select count(*) from unnest(v_req) r where r = any (pr.dt)) as n_desc,
               (select count(*) from unnest(v_req) r where r = any (pr.nt) or r = any (pr.ct) or r = any (pr.dt)) as n_cov,
               (select count(*) from unnest(v_bonus) b where b = any (pr.nt)) as n_bonus
          from prods pr
      ), ranked as materialized (
        select s.*,
               -- nome do produto INTEIRO presente na pergunta (ex.: 'espeto de carne' -> Espeto de carne) vale muito mais que
               -- produtos que só compartilham uma palavra (Espeto de costela)
               (4 * s.n_name + 2 * s.n_cat + s.n_desc + s.n_bonus
                + case when cardinality(s.nt) > 0
                        and cardinality(s.nt) = (select count(*) from unnest(s.nt) t where t = any (v_req)) then 10 else 0 end)::numeric as score
          from scored s where s.n_cov > 0
      ), agg as (
        select max(score) filter (where n_cov = v_nreq) as best_full, max(score) as best_any from ranked
      ), picked as materialized (
        select r.* from ranked r, agg a
         where case when a.best_full is not null then r.n_cov = v_nreq and r.score >= a.best_full
                    else r.score >= greatest(1, a.best_any / 2.0) end
         order by r.score desc, r.name
         limit v_limit
      )
      select coalesce(jsonb_agg(jsonb_build_object(
               'name', k.name, 'category', k.cat_name, 'price', k.sale_price, 'description', k.descr, 'availability', k.avail)
               order by k.score desc, k.name), '[]'::jsonb),
             count(*)::int, max(k.score), count(*) filter (where k.score = (select max(score) from picked)),
             coalesce((select a.best_full is not null from agg a limit 1), false)
        into v_products, v_total, v_top, v_top_n, v_exact
        from picked k;
      v_ambiguous := v_total > 1 and v_top_n > 1;
    end if;
  end if;
  -- pergunta genérica de categoria conta como correspondência exata; o resto vale o que a busca disse, menos tipo/atributo ausente
  if v_listing then v_exact := true; end if;
  v_exact := v_exact and cardinality(v_missing_brands) = 0 and cardinality(v_missing_attrs) = 0;

  -- ALTERNATIVAS REAIS (até 3, mesma família): marca/tipo pedido que o cardápio não tem (ex.: Brahma -> cervejas cadastradas). Nunca inventa
  -- produto, só devolve ativos em categoria ativa, e não repete o que já veio na busca.
  if v_type is not null and cardinality(v_missing_brands) > 0 then
    select array(select jsonb_array_elements_text(v_types -> v_type)) into v_type_tokens;
    select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'category', t.cat_name, 'price', t.sale_price, 'description', t.descr, 'availability', t.avail) order by t.name), '[]'::jsonb)
      into v_alt
      from (
        select p.name, c.name as cat_name, p.sale_price, nullif(left(btrim(coalesce(p.description, '')), 200), '') as descr,
               case when v_mode = 'live' then
                      case when p.available_for_sale and (p.stock_control = 'none' or p.stock_quantity > 0) then 'available' else 'unavailable' end
                    else 'in_menu' end as avail
          from public.products p
          join public.product_categories c on c.id = p.category_id and c.company_id = p.company_id
         where p.company_id = v_company and p.is_active and c.is_active
           and (public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_canon_text(p.name)) || public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_canon_text(c.name))
                || public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_canon_text(coalesce(p.description, '')))) && v_type_tokens
           and not exists (select 1 from jsonb_array_elements(v_products) x where x ->> 'name' = p.name)
         order by p.name
         limit 3
      ) t;
  end if;

  -- perfil comercial (Etapa 1): só se existir
  select * into v_profile from public.company_business_profile where company_id = v_company;
  select * into v_c from public.companies where id = v_company;

  -- entrega: nunca expõe a taxa padrão como taxa final; a taxa da zona só quando bairro/cidade da zona estão na pergunta
  select * into v_d from public.company_delivery_settings where company_id = v_company;
  if found then
    v_tokens := public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_norm_text(left(coalesce(p_query, ''), 500)));
    select jsonb_build_object('name', z.name, 'neighborhood', z.neighborhood, 'city', z.city, 'fee', z.fee)
      into v_zone
      from public.delivery_zones z
     where z.company_id = v_company and z.is_active
       and cardinality(public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_norm_text(z.neighborhood))) > 0
       and public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_norm_text(z.neighborhood)) <@ v_tokens
     order by z.neighborhood
     limit 1;
    v_delivery := jsonb_build_object(
      'delivery_enabled', v_d.delivery_enabled, 'pickup_enabled', v_d.pickup_enabled,
      'delivery_minutes', v_d.delivery_minutes, 'pickup_minutes', v_d.pickup_minutes,
      'zone', v_zone,
      'zones_active', (select count(*) from public.delivery_zones z where z.company_id = v_company and z.is_active));
  end if;

  return jsonb_build_object(
    'enabled', true,
    'availability_mode', v_mode,
    'business', jsonb_build_object('name', coalesce(nullif(btrim(v_s.business_name), ''), v_c.name)),
    'query_matched', v_nreq > 0 and jsonb_array_length(v_products) > 0,
    'category_listing', v_listing,
    'ambiguous', v_ambiguous,
    'truncated', v_total > jsonb_array_length(v_products),
    'catalog_size', (select count(*)::int from public.products p2
                       join public.product_categories c2 on c2.id = p2.category_id and c2.company_id = p2.company_id
                      where p2.company_id = v_company and p2.is_active and c2.is_active),
    'products', v_products,
    'exact_match', v_exact,
    'corrections', v_corr,
    'missing', jsonb_build_object('brands', to_jsonb(v_missing_brands), 'attrs', to_jsonb(v_missing_attrs)),
    'requested_type', v_type,
    'alternatives', v_alt,
    'categories', v_categories,
    'profile', case when v_profile.company_id is null then null else jsonb_build_object(
        'address', v_profile.address_text, 'timezone', v_profile.timezone, 'hours', v_profile.weekly_hours,
        'closed_dates', v_profile.closed_dates, 'payment_methods', to_jsonb(v_profile.payment_methods),
        'pix_instructions', v_profile.pix_instructions, 'notes', v_profile.public_notes) end,
    'delivery', v_delivery);
end;
$function$;

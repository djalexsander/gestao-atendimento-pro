-- Pedido conversacional (WhatsApp AUTO): resolução de produto tolerante a DESCRITORES genéricos ("coca lata", "coca normal").
--
-- Bug real (conversa de 2026-10-21): "2 coca lata" não casou com "Coca-cola 350ml" / "COCA COLA ZERO 350ML" porque a busca exige que
-- TODOS os termos do pedido existam no nome do produto e "lata" não aparece nesses nomes. O pedido virou "não encontrei" e a
-- conversa seguinte caiu em handoff. Esta migration só muda a RESOLUÇÃO (nada de financeiro, nada de entrega):
--   * 1ª tentativa: igual a antes (todos os termos no nome).
--   * se NÃO houver nenhum candidato, 2ª tentativa SEM os descritores genéricos (lata, latinha, gelada, refrigerante, normal...);
--     "normal/tradicional/comum" também EXCLUI as variações zero/diet/light;
--   * resultado da 2ª tentativa NUNCA é 'exact': sempre 'ambiguous' (mesmo com 1 candidato) com relaxed=true, porque o descritor
--     ignorado pode importar ("heineken lata" x Heineken Long Neck). O cliente escolhe.
--   * 'none' continua devolvendo 'near' (produtos que dividem algum termo) para o worker mostrar opções reais.
-- Migration aditiva (create or replace; mesma assinatura e mesmos GRANT/REVOKE).

create or replace function public.whatsapp_order_resolve_item(p_job_id uuid, p_mention text, p_limit integer default 5)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx jsonb := public.whatsapp_order_ctx(p_job_id);
  v_company uuid;
  v_text text := left(btrim(coalesce(p_mention, '')), 120);
  v_norm text;
  v_req text[];
  v_req0 text[];
  v_soft constant text[] := array['lata', 'latinha', 'gelada', 'geladinha', 'refri', 'refrigerante', 'normal', 'tradicional', 'comum'];
  v_diet constant text[] := array['zero', 'diet', 'light'];
  v_normalish boolean;
  v_relaxed boolean := false;
  v_limit integer := least(greatest(coalesce(p_limit, 5), 1), 10);
  v_ids uuid[];
  v_exact uuid[];
  v_near jsonb;
  v_p jsonb;
begin
  if not (v_ctx ->> 'ok')::boolean then
    return jsonb_build_object('result', 'blocked', 'reason', v_ctx ->> 'reason');
  end if;
  v_company := (v_ctx ->> 'company_id')::uuid;
  v_norm := public.whatsapp_ai_norm_text(v_text);
  select coalesce(array_agg(t), '{}'::text[]) into v_req0
    from jsonb_array_elements_text(public.whatsapp_ai_knowledge_query_terms(v_text) -> 'required') t;
  v_req := v_req0;
  if cardinality(v_req) = 0 then
    return jsonb_build_object('result', 'none', 'near', '[]'::jsonb);
  end if;
  v_normalish := v_req && array['normal', 'tradicional', 'comum'];

  -- 1ª tentativa: produto ATIVO de categoria ATIVA cujo nome contém TODOS os termos do pedido
  select coalesce(array_agg(x.id order by x.name, x.id), '{}'::uuid[]),
         coalesce(array_agg(x.id order by x.name, x.id) filter (where x.nn = v_norm), '{}'::uuid[])
    into v_ids, v_exact
    from (
      select p.id, p.name, public.whatsapp_ai_norm_text(p.name) as nn,
             public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_norm_text(p.name)) as nt
        from public.products p
        join public.product_categories c on c.company_id = p.company_id and c.id = p.category_id and c.is_active
       where p.company_id = v_company and p.is_active
    ) x
   where v_req <@ x.nt;

  -- 2ª tentativa (só quando a 1ª não achou nada): sem os descritores genéricos; nunca 'exact'
  if cardinality(v_ids) = 0 then   -- G2
    select coalesce(array_agg(t), '{}'::text[]) into v_req from unnest(v_req0) t where t <> all (v_soft);
    if cardinality(v_req) > 0 and v_req <> v_req0 then
      select coalesce(array_agg(x.id order by x.name, x.id), '{}'::uuid[])
        into v_ids
        from (
          select p.id, p.name, public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_norm_text(p.name)) as nt
            from public.products p
            join public.product_categories c on c.company_id = p.company_id and c.id = p.category_id and c.is_active
           where p.company_id = v_company and p.is_active
        ) x
       where v_req <@ x.nt and (not v_normalish or not (x.nt && v_diet));
      v_exact := '{}'::uuid[];
      v_relaxed := cardinality(v_ids) > 0;
    end if;
  end if;

  if cardinality(v_exact) = 1 then
    v_ids := v_exact;
  end if;
  if cardinality(v_ids) = 0 then
    select coalesce(jsonb_agg(jsonb_build_object('name', y.name, 'price', y.sale_price) order by y.name), '[]'::jsonb) into v_near
      from (
        select p.name, p.sale_price
          from public.products p
          join public.product_categories c on c.company_id = p.company_id and c.id = p.category_id and c.is_active
         where p.company_id = v_company and p.is_active
           and public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_norm_text(p.name)) && (select coalesce(array_agg(t), '{}'::text[]) from unnest(v_req0) t where t <> all (v_soft))
         order by p.name limit 5
      ) y;
    return jsonb_build_object('result', 'none', 'near', v_near);
  end if;
  if cardinality(v_ids) = 1 and not v_relaxed then
    v_p := public.whatsapp_order_product_json(v_company, v_ids[1]);
    return jsonb_build_object('result', case when (v_p ->> 'available')::boolean then 'exact' else 'unavailable' end, 'product', v_p);
  end if;
  return jsonb_build_object('result', 'ambiguous', 'relaxed', v_relaxed,
    'candidates', (select coalesce(jsonb_agg(public.whatsapp_order_product_json(v_company, i) order by ord), '[]'::jsonb)
                     from unnest(v_ids[1:v_limit]) with ordinality as u(i, ord)),
    'total_candidates', cardinality(v_ids));
end;
$$;

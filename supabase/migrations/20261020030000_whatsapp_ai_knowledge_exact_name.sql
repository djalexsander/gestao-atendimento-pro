-- BASE DE CONHECIMENTO — ajuste da busca (somente a lookup): o nome do produto INTEIRO presente na pergunta ganha bônus forte.
-- Motivo (homologação real do suggest): "espeto de carne" misturado a outras palavras da pergunta podia trazer também produtos que só
-- compartilham "espeto" (ex.: Espeto de costela). Agora o produto cujo nome inteiro (sem palavras vazias) está na pergunta passa à frente.
-- Mesmo contrato de entrada/saída, mesma ACL (create or replace preserva os grants), nenhuma outra função alterada.

create or replace function public.whatsapp_ai_lookup_knowledge(
  p_conversation_id uuid,
  p_query text,
  p_limit integer default 8
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_conv public.whatsapp_conversations;
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
begin
  v_conv := public.whatsapp_load_conversation(p_conversation_id);
  v_company := v_conv.company_id;

  select * into v_s from public.company_whatsapp_ai_settings where company_id = v_company;
  if not found or not v_s.knowledge_enabled then
    return jsonb_build_object('enabled', false);
  end if;
  v_mode := v_s.ai_availability_mode;

  v_terms := public.whatsapp_ai_knowledge_query_terms(p_query);
  select coalesce(array_agg(x), '{}'::text[]) into v_req from jsonb_array_elements_text(v_terms -> 'required') x;
  select coalesce(array_agg(x), '{}'::text[]) into v_bonus from jsonb_array_elements_text(v_terms -> 'bonus') x;
  -- só contam os termos que existem no catálogo da empresa ("está", "R$ 10"... não viram exigência)
  select coalesce(array_agg(distinct x), '{}'::text[]) into v_vocab
    from (
      select unnest(public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_norm_text(p.name))
                    || public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_norm_text(c.name))
                    || public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_norm_text(coalesce(p.description, '')))) as x
        from public.products p
        join public.product_categories c on c.id = p.category_id and c.company_id = p.company_id
       where p.company_id = v_company and p.is_active and c.is_active
    ) t;
  select coalesce(array_agg(r), '{}'::text[]) into v_req from unnest(v_req) r where r = any (v_vocab);
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
       and v_req <@ public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_norm_text(c.name));
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
               public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_norm_text(p.name)) as nt,
               public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_norm_text(c.name)) as ct,
               public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_norm_text(coalesce(p.description, ''))) as dt
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
             count(*)::int, max(k.score), count(*) filter (where k.score = (select max(score) from picked))
        into v_products, v_total, v_top, v_top_n
        from picked k;
      v_ambiguous := v_total > 1 and v_top_n > 1;
    end if;
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
    'products', v_products,
    'categories', v_categories,
    'profile', case when v_profile.company_id is null then null else jsonb_build_object(
        'address', v_profile.address_text, 'timezone', v_profile.timezone, 'hours', v_profile.weekly_hours,
        'closed_dates', v_profile.closed_dates, 'payment_methods', to_jsonb(v_profile.payment_methods),
        'pix_instructions', v_profile.pix_instructions, 'notes', v_profile.public_notes) end,
    'delivery', v_delivery);
end;
$$;


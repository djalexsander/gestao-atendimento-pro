-- BASE DE CONHECIMENTO — Etapa 2: consulta de fatos estruturados para a SUGESTÃO por IA (somente suggest; o automático não muda).
--
--  * whatsapp_ai_lookup_knowledge(conversation_id, query, limit): devolve fatos compactos e saneados (produtos relevantes,
--    categorias, perfil comercial, entrega) da empresa DA CONVERSA. company_id nunca vem do cliente nem do modelo. Só devolve
--    algo quando company_whatsapp_ai_settings.knowledge_enabled = true (hoje false em todas as empresas): senão {"enabled":false}
--    e o suggest continua exatamente como antes.
--  * Busca determinística/textual (sem embeddings): normaliza (minúsculas, sem acento, singular/plural simples), remove palavras
--    vazias, aplica poucos apelidos em código (coquinha, espetinho, marcas) e pontua nome > categoria > descrição.
--  * Nada de estoque bruto, mínimo, code, barcode, setor, ids ou dados de outra empresa. Disponibilidade só como rótulo:
--      catalog => 'in_menu' (faz parte do cardápio; sem garantia de estoque);
--      live    => 'available' | 'unavailable' (ativo + categoria ativa + available_for_sale + (sem controle OU saldo > 0)).
--  * whatsapp_ai_knowledge_usage + whatsapp_ai_record_knowledge_usage: rastreabilidade SEM conteúdo (knowledge_used, quantidade
--    de produtos, tipos de fato, nº de consultas, código de bloqueio de segurança). Tabela nova: whatsapp_ai_usage/finalize_usage
--    (usados também pelo automático) NÃO são alterados.
-- Migration aditiva; não toca prepare_auto/prepare_suggestion/worker/dispatch.

-- ---------------------------------------------------------------------------
-- 1) Normalização e termos de busca (internos)
-- ---------------------------------------------------------------------------
create function public.whatsapp_ai_norm_text(p_text text)
returns text
language sql
immutable
set search_path = public
as $$
  select btrim(regexp_replace(
           regexp_replace(
             regexp_replace(
               translate(lower(coalesce(p_text, '')), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn'),
               '(\d)([a-z])', '\1 \2', 'g'),
             '([a-z])(\d)', '\1 \2', 'g'),
           '[^a-z0-9]+', ' ', 'g'));
$$;

-- Palavras da frase normalizada, sem palavras vazias, em singular simples (espetos -> espeto, porcoes -> porcao), sem repetição.
create function public.whatsapp_ai_knowledge_tokens(p_norm text)
returns text[]
language sql
immutable
set search_path = public
as $$
  select coalesce(array_agg(distinct s.t), '{}'::text[])
    from (
      select case
               when w ~ '.{2,}oes$' then regexp_replace(w, 'oes$', 'ao')
               when w ~ '.{2,}aes$' then regexp_replace(w, 'aes$', 'ao')
               when char_length(w) > 3 and w ~ '[^s]s$' then regexp_replace(w, 's$', '')
               else w
             end as t
        from unnest(string_to_array(coalesce(p_norm, ''), ' ')) as w
       where w <> ''
         and w <> all (array['de', 'do', 'da', 'dos', 'das', 'e', 'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'que', 'qual',
                             'quais', 'quanto', 'quanta', 'quantos', 'custa', 'custam', 'valor', 'valores', 'preco', 'precos',
                             'tem', 'tens', 'ter', 'temos', 'voce', 'voces', 'vc', 'vcs', 'ai', 'ae', 'por', 'pra', 'para', 'pro',
                             'favor', 'queria', 'quero', 'gostaria', 'saber', 'me', 'ver', 'mostra', 'mostrar', 'cardapio', 'menu',
                             'hoje', 'ja', 'ainda', 'no', 'na', 'nos', 'nas', 'em', 'com', 'ola', 'oi', 'bom', 'boa', 'dia',
                             'tarde', 'noite', 'obrigado', 'obrigada', 'tudo', 'bem', 'eh', 'sao', 'ha', 'vai', 'tao', 'so', 'mais',
                             'esse', 'essa', 'isso', 'aquele', 'aquela', 'meu', 'minha', 'seu', 'sua', 'pode', 'poderia', 'estao'])
    ) s
   where char_length(s.t) >= 2;
$$;

-- Apelidos determinísticos (em código, sem tabela). required = termos que substituem o apelido; bonus = termos extras que só
-- melhoram a ordem (nunca exigidos). Marcas já casam pelo nome do produto; o bônus prefere a apresentação mais comum.
create function public.whatsapp_ai_knowledge_query_terms(p_query text)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  v text := ' ' || public.whatsapp_ai_norm_text(left(coalesce(p_query, ''), 500)) || ' ';
  v_bonus text := '';
begin
  v := regexp_replace(v, '\mespetinhos?\M', ' espeto ', 'g');
  v := regexp_replace(v, '\mcoquinha\M', ' coca ', 'g');
  v := regexp_replace(v, '\mcocacola\M', ' coca cola ', 'g');
  v := regexp_replace(v, '\mlongneck\M', ' long neck ', 'g');
  v := regexp_replace(v, '\mcervejinha\M', ' cerveja ', 'g');
  if v ~ '\mcoca\M' then v_bonus := v_bonus || ' cola'; end if;
  if v ~ '\mheineken\M' then v_bonus := v_bonus || ' long neck 330'; end if;
  if v ~ '\mbrahma\M' then v_bonus := v_bonus || ' chopp lata 350'; end if;
  if v ~ '\moriginal\M' then v_bonus := v_bonus || ' 600'; end if;
  if v ~ '\mred bull\M' then v_bonus := v_bonus || ' 250'; end if;
  return jsonb_build_object(
    'required', to_jsonb(public.whatsapp_ai_knowledge_tokens(btrim(v))),
    'bonus', to_jsonb(public.whatsapp_ai_knowledge_tokens(btrim(v_bonus))));
end;
$$;

revoke execute on function public.whatsapp_ai_norm_text(text) from public, anon, authenticated, service_role;
revoke execute on function public.whatsapp_ai_knowledge_tokens(text) from public, anon, authenticated, service_role;
revoke execute on function public.whatsapp_ai_knowledge_query_terms(text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) Consulta de conhecimento
-- ---------------------------------------------------------------------------
create function public.whatsapp_ai_lookup_knowledge(
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
        select s.*, (4 * s.n_name + 2 * s.n_cat + s.n_desc + s.n_bonus)::numeric as score from scored s where s.n_cov > 0
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

revoke execute on function public.whatsapp_ai_lookup_knowledge(uuid, text, integer) from public, anon, service_role;
grant execute on function public.whatsapp_ai_lookup_knowledge(uuid, text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Rastreabilidade sem conteúdo
-- ---------------------------------------------------------------------------
create table public.whatsapp_ai_knowledge_usage (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  usage_id uuid not null references public.whatsapp_ai_usage (id) on delete cascade,
  knowledge_used boolean not null,
  product_count integer not null default 0 check (product_count between 0 and 50),
  knowledge_kinds text[] not null default '{}'
    check (knowledge_kinds <@ array['products', 'categories', 'profile', 'delivery', 'payment', 'hours', 'notes']::text[]),
  lookup_count integer not null default 1 check (lookup_count between 0 and 5),
  safety_reason_code text check (safety_reason_code is null or safety_reason_code in ('unsupported_commercial_claim', 'action_required')),
  created_at timestamptz not null default now(),
  constraint whatsapp_ai_knowledge_usage_usage_key unique (usage_id)
);
create index whatsapp_ai_knowledge_usage_company_idx on public.whatsapp_ai_knowledge_usage (company_id, created_at desc);
alter table public.whatsapp_ai_knowledge_usage enable row level security;
revoke all on public.whatsapp_ai_knowledge_usage from public, anon, authenticated;
grant select, insert on public.whatsapp_ai_knowledge_usage to service_role;
comment on table public.whatsapp_ai_knowledge_usage is
  'Rastreio sem conteúdo do uso da base de conhecimento na sugestão (sem prompt, sem resposta bloqueada, sem texto do cliente).';

create function public.whatsapp_ai_record_knowledge_usage(
  p_usage_id uuid,
  p_knowledge_used boolean,
  p_product_count integer,
  p_kinds text[],
  p_lookup_count integer,
  p_safety_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_u public.whatsapp_ai_usage;
begin
  select * into v_u from public.whatsapp_ai_usage where id = p_usage_id and reservation_id is null and status = 'reserved' and kind = 'suggest';
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if p_safety_reason is not null and p_safety_reason not in ('unsupported_commercial_claim', 'action_required') then
    return jsonb_build_object('result', 'invalid');
  end if;
  insert into public.whatsapp_ai_knowledge_usage (company_id, usage_id, knowledge_used, product_count, knowledge_kinds, lookup_count, safety_reason_code)
  values (v_u.company_id, v_u.id, coalesce(p_knowledge_used, false), least(greatest(coalesce(p_product_count, 0), 0), 50),
          coalesce(p_kinds, '{}'::text[]), least(greatest(coalesce(p_lookup_count, 1), 0), 5), p_safety_reason)
  on conflict (usage_id) do nothing;
  return jsonb_build_object('result', 'ok');
exception
  when check_violation then
    return jsonb_build_object('result', 'invalid');
end;
$$;
revoke execute on function public.whatsapp_ai_record_knowledge_usage(uuid, boolean, integer, text[], integer, text) from public, anon, authenticated;
grant execute on function public.whatsapp_ai_record_knowledge_usage(uuid, boolean, integer, text[], integer, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4) Etapa 1: salvar o perfil NÃO pode ligar/desligar a base de conhecimento
-- ---------------------------------------------------------------------------
-- Antes (20261020010000) a RPC regravava knowledge_enabled = false a cada salvamento. Agora que existe consumo (só no suggest), isso
-- desligaria a base em silêncio. A RPC continua recusando p_knowledge_enabled = true vindo do cliente (a ativação é decisão
-- operacional, não do formulário) e agora PRESERVA o valor armazenado. Única mudança: o upsert de company_whatsapp_ai_settings.
create or replace function public.whatsapp_ai_update_business_profile(
  p_company_id uuid,
  p_address_text text,
  p_timezone text,
  p_weekly_hours jsonb,
  p_closed_dates jsonb,
  p_payment_methods text[],
  p_pix_instructions text,
  p_public_notes text,
  p_ai_availability_mode text default 'catalog',
  p_knowledge_enabled boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_addr text := nullif(btrim(coalesce(p_address_text, '')), '');
  v_pix text := nullif(btrim(coalesce(p_pix_instructions, '')), '');
  v_notes text := nullif(btrim(coalesce(p_public_notes, '')), '');
  v_tz text := nullif(btrim(coalesce(p_timezone, '')), '');
  v_methods text[];
  v_hours jsonb := p_weekly_hours;
  v_closed jsonb := p_closed_dates;
begin
  v_role := public.whatsapp_assert_reader(p_company_id);
  if v_role not in ('owner', 'admin') then
    raise exception 'Somente donos(as) e administradores(as) configuram o conhecimento da empresa.' using errcode = 'PT403';
  end if;

  if v_tz is null or not exists (select 1 from pg_timezone_names z where z.name = v_tz) then
    raise exception 'Fuso horário inválido.' using errcode = 'PT400';
  end if;
  if v_addr is not null and char_length(v_addr) > 300 then
    raise exception 'O endereço pode ter no máximo 300 caracteres.' using errcode = 'PT400';
  end if;
  if v_pix is not null and char_length(v_pix) > 300 then
    raise exception 'O texto do Pix pode ter no máximo 300 caracteres.' using errcode = 'PT400';
  end if;
  if v_notes is not null and char_length(v_notes) > 1000 then
    raise exception 'As observações podem ter no máximo 1000 caracteres.' using errcode = 'PT400';
  end if;
  v_methods := coalesce(p_payment_methods, '{}'::text[]);
  if not (v_methods <@ array['cash', 'pix', 'debit_card', 'credit_card', 'other']::text[]) then
    raise exception 'Forma de pagamento inválida.' using errcode = 'PT400';
  end if;
  select coalesce(array_agg(distinct m order by m), '{}'::text[]) into v_methods from unnest(v_methods) m;

  -- horário vazio ({"days":{}}) vira "não informado"; o fuso do horário acompanha o do perfil
  if v_hours is not null and jsonb_typeof(v_hours) = 'object' and coalesce(v_hours -> 'days', '{}'::jsonb) = '{}'::jsonb then
    v_hours := null;
  end if;
  if v_hours is not null and jsonb_typeof(v_hours) = 'object' and (v_hours ->> 'timezone') is null then
    v_hours := jsonb_set(v_hours, '{timezone}', to_jsonb(v_tz));
  end if;
  if not public.company_hours_valid(v_hours) then
    raise exception 'Horários inválidos: use HH:MM, início antes do fim e períodos sem sobreposição.' using errcode = 'PT400';
  end if;
  if v_hours is not null and (v_hours ->> 'timezone') <> v_tz then
    raise exception 'O fuso dos horários precisa ser o mesmo do perfil.' using errcode = 'PT400';
  end if;
  if v_closed is not null and jsonb_typeof(v_closed) = 'array' and jsonb_array_length(v_closed) = 0 then
    v_closed := null;
  end if;
  if not public.company_closed_dates_valid(v_closed) then
    raise exception 'Datas fechadas inválidas.' using errcode = 'PT400';
  end if;

  if p_ai_availability_mode is null or p_ai_availability_mode not in ('catalog', 'live') then
    raise exception 'Modo de disponibilidade inválido.' using errcode = 'PT400';
  end if;
  if p_knowledge_enabled is distinct from false then
    raise exception 'A base de conhecimento ainda está em preparação: a IA ainda não a utiliza.' using errcode = 'PT409';
  end if;

  insert into public.company_business_profile (
    company_id, address_text, timezone, weekly_hours, closed_dates, payment_methods, pix_instructions, public_notes, updated_by)
  values (p_company_id, v_addr, v_tz, v_hours, v_closed, v_methods, v_pix, v_notes, auth.uid())
  on conflict (company_id) do update
     set address_text = excluded.address_text,
         timezone = excluded.timezone,
         weekly_hours = excluded.weekly_hours,
         closed_dates = excluded.closed_dates,
         payment_methods = excluded.payment_methods,
         pix_instructions = excluded.pix_instructions,
         public_notes = excluded.public_notes,
         updated_by = excluded.updated_by;

  -- só o modo de disponibilidade é gravado; knowledge_enabled NUNCA é alterado por esta RPC (o valor armazenado é preservado:
  -- salvar o perfil não pode desligar nem ligar a base de conhecimento). Linha nova nasce com o default false.
  insert into public.company_whatsapp_ai_settings (company_id, ai_availability_mode)
  values (p_company_id, p_ai_availability_mode)
  on conflict (company_id) do update
     set ai_availability_mode = excluded.ai_availability_mode;

  return public.whatsapp_ai_get_business_profile(p_company_id);
end;
$$;


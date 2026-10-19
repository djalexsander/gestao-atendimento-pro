-- BASE DE CONHECIMENTO — ETAPA 1: perfil comercial da empresa (FONTE de dados; NADA o consome ainda).
--
-- Esta migration só CRIA a fonte. Ela NÃO altera whatsapp_ai_prepare_auto/suggest, prompt, checkReplySafety, worker, Edge,
-- dispatch ou webhook: as respostas atuais da IA (inclusive o piloto da Djalexeventos em 'auto') ficam EXATAMENTE como antes.
--
--  * company_business_profile (1:1 por empresa): endereço, fuso, horários (weekly_hours), datas fechadas, formas de
--    pagamento aceitas (códigos de service_payments), texto público de Pix e observações públicas.
--    NÃO duplica: nome/telefone/WhatsApp/e-mail (companies), entrega/retirada/taxa/zonas (company_delivery_settings,
--    delivery_zones), produtos/preços/estoque (products...).
--  * weekly_hours usa o MESMO formato de company_whatsapp_ai_settings.business_schedule (validado por
--    whatsapp_ai_schedule_valid): {"timezone":"America/Sao_Paulo","days":{"mon":[["11:00","14:00"],["18:00","23:00"]],...}}.
--    Dia ausente (ou []) = FECHADO. Aqui vale a regra a mais de períodos NÃO sobrepostos. Compatível com a futura unificação.
--  * closed_dates (opcional): [{"date":"2026-12-25","label":"Natal"}] = dia inteiro fechado (exceção/feriado). Exceções com
--    horário parcial ficam para uma migration futura.
--  * company_whatsapp_ai_settings ganha knowledge_enabled (nasce FALSE para todas as empresas e NÃO pode ser ligado nesta
--    etapa) e ai_availability_mode ('catalog' padrão | 'live'). Só guardam a escolha; a IA ainda não os lê.
--  * RPCs (owner/admin da empresa, módulo WhatsApp): whatsapp_ai_get_business_profile (perfil + resumos SOMENTE LEITURA de
--    catálogo, contato e entrega) e whatsapp_ai_update_business_profile. A tabela não tem acesso direto para clientes.

-- ---------------------------------------------------------------------------
-- 1) Validadores (internos)
-- ---------------------------------------------------------------------------
-- Horário válido (formato do business_schedule) E sem períodos sobrepostos no mesmo dia (encostar é permitido).
create function public.company_hours_valid(p_hours jsonb)
returns boolean
language plpgsql
stable
set search_path = public
as $$
declare
  v_k text;
  v_prev_end text;
  v_iv jsonb;
begin
  if p_hours is null then
    return true;
  end if;
  if not public.whatsapp_ai_schedule_valid(p_hours) then
    return false;
  end if;
  for v_k in select jsonb_object_keys(p_hours -> 'days') loop
    v_prev_end := null;
    for v_iv in select e from jsonb_array_elements(p_hours -> 'days' -> v_k) e order by e ->> 0 loop
      if v_prev_end is not null and (v_iv ->> 0) < v_prev_end then
        return false;
      end if;
      v_prev_end := v_iv ->> 1;
    end loop;
  end loop;
  return true;
end;
$$;

-- Datas fechadas: array (até 120) de { date: 'YYYY-MM-DD' real e única, label: texto <= 60 opcional }.
create function public.company_closed_dates_valid(p_dates jsonb)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  v_e jsonb;
  v_seen text[] := '{}';
  v_d text;
begin
  if p_dates is null then
    return true;
  end if;
  if jsonb_typeof(p_dates) <> 'array' or jsonb_array_length(p_dates) > 120 then
    return false;
  end if;
  for v_e in select e from jsonb_array_elements(p_dates) e loop
    if jsonb_typeof(v_e) <> 'object' or exists (select 1 from jsonb_object_keys(v_e) k where k not in ('date', 'label')) then
      return false;
    end if;
    if jsonb_typeof(v_e -> 'date') is distinct from 'string' or (v_e ->> 'date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      return false;
    end if;
    v_d := v_e ->> 'date';
    begin
      if to_char((v_d)::date, 'YYYY-MM-DD') <> v_d then
        return false;
      end if;
    exception when others then
      return false;
    end;
    if v_d = any (v_seen) then
      return false;
    end if;
    v_seen := v_seen || v_d;
    if v_e ? 'label' and (jsonb_typeof(v_e -> 'label') <> 'string' or char_length(v_e ->> 'label') > 60) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

revoke execute on function public.company_hours_valid(jsonb) from public, anon, authenticated, service_role;
revoke execute on function public.company_closed_dates_valid(jsonb) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) Tabela
-- ---------------------------------------------------------------------------
create table public.company_business_profile (
  company_id uuid primary key references public.companies(id) on delete cascade,
  address_text text
    constraint company_business_profile_address_length check (address_text is null or char_length(address_text) between 1 and 300),
  -- O produto inteiro usa America/Sao_Paulo (cobrança, delivery, relatórios) e não há fonte melhor por empresa: é o
  -- padrão VISÍVEL e editável (a tela mostra o fuso). weekly_hours.timezone tem de ser igual a esta coluna.
  timezone text not null default 'America/Sao_Paulo',
  weekly_hours jsonb
    constraint company_business_profile_hours_shape check (
      weekly_hours is null or (jsonb_typeof(weekly_hours) = 'object' and char_length(weekly_hours::text) <= 2000)),
  closed_dates jsonb
    constraint company_business_profile_closed_shape check (
      closed_dates is null or (jsonb_typeof(closed_dates) = 'array' and char_length(closed_dates::text) <= 6000)),
  -- mesmos códigos de service_payments.payment_method
  payment_methods text[] not null default '{}'
    constraint company_business_profile_payment_methods_check check (
      payment_methods <@ array['cash', 'pix', 'debit_card', 'credit_card', 'other']::text[]),
  -- texto comercial PÚBLICO ("Pix disponível no atendimento"); nunca segredo
  pix_instructions text
    constraint company_business_profile_pix_length check (pix_instructions is null or char_length(pix_instructions) between 1 and 300),
  public_notes text
    constraint company_business_profile_notes_length check (public_notes is null or char_length(public_notes) between 1 and 1000),
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.company_business_profile is
  'Perfil comercial da empresa para a base de conhecimento da IA (Etapa 1: só a fonte). Sem acesso direto: leitura/escrita pelas RPCs whatsapp_ai_get/update_business_profile.';

-- Validação no BANCO (vale também para escrita direta de operador): fuso real, horário no formato do business_schedule sem
-- sobreposição, fuso do horário igual ao da coluna, datas fechadas válidas.
create function public.company_business_profile_validate()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (select 1 from pg_timezone_names z where z.name = new.timezone) then
    raise exception 'Fuso horário inválido.' using errcode = 'PT400';
  end if;
  if not public.company_hours_valid(new.weekly_hours) then
    raise exception 'Horários inválidos: use HH:MM, início antes do fim e períodos sem sobreposição.' using errcode = 'PT400';
  end if;
  if new.weekly_hours is not null and new.weekly_hours ->> 'timezone' is distinct from new.timezone then
    raise exception 'O fuso dos horários precisa ser o mesmo do perfil.' using errcode = 'PT400';
  end if;
  if not public.company_closed_dates_valid(new.closed_dates) then
    raise exception 'Datas fechadas inválidas.' using errcode = 'PT400';
  end if;
  if cardinality(new.payment_methods) <> (select count(distinct m) from unnest(new.payment_methods) m) then
    raise exception 'Forma de pagamento repetida.' using errcode = 'PT400';
  end if;
  return new;
end;
$$;
revoke execute on function public.company_business_profile_validate() from public, anon, authenticated, service_role;

create trigger company_business_profile_validate
  before insert or update on public.company_business_profile
  for each row execute function public.company_business_profile_validate();

create trigger company_business_profile_set_updated_at
  before update on public.company_business_profile
  for each row execute function public.set_updated_at();

alter table public.company_business_profile enable row level security;
revoke all on public.company_business_profile from public, anon, authenticated;
grant all on public.company_business_profile to service_role;

-- ---------------------------------------------------------------------------
-- 3) Flags da IA (só guardam a escolha; nada as consome ainda)
-- ---------------------------------------------------------------------------
alter table public.company_whatsapp_ai_settings
  add column knowledge_enabled boolean not null default false,
  add column ai_availability_mode text not null default 'catalog'
    constraint whatsapp_ai_settings_availability_mode_check check (ai_availability_mode in ('catalog', 'live'));

comment on column public.company_whatsapp_ai_settings.knowledge_enabled is
  'Base de conhecimento (futuro). Nasce FALSE e NÃO pode ser ligado enquanto a IA não consumir a base (Etapa 2).';
comment on column public.company_whatsapp_ai_settings.ai_availability_mode is
  'catalog = produto ativo faz parte do cardápio, sem afirmar disponibilidade agora; live = considera disponibilidade de venda e estoque (sem revelar quantidade). Ainda não lido pela IA.';

-- ---------------------------------------------------------------------------
-- 4) Leitura (perfil + resumos SOMENTE LEITURA das fontes existentes)
-- ---------------------------------------------------------------------------
create function public.whatsapp_ai_get_business_profile(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_p public.company_business_profile;
  v_has boolean;
  v_s public.company_whatsapp_ai_settings;
  v_c public.companies;
  v_d public.company_delivery_settings;
  v_dhas boolean;
begin
  v_role := public.whatsapp_assert_reader(p_company_id);
  if v_role not in ('owner', 'admin') then
    raise exception 'Somente donos(as) e administradores(as) configuram o conhecimento da empresa.' using errcode = 'PT403';
  end if;

  select * into v_p from public.company_business_profile where company_id = p_company_id;
  v_has := found;
  select * into v_s from public.company_whatsapp_ai_settings where company_id = p_company_id;
  select * into v_c from public.companies where id = p_company_id;
  select * into v_d from public.company_delivery_settings where company_id = p_company_id;
  v_dhas := found;

  return jsonb_build_object(
    'company_id', p_company_id,
    'configured', v_has,
    'address_text', case when v_has then v_p.address_text end,
    'timezone', case when v_has then v_p.timezone else 'America/Sao_Paulo' end,
    'weekly_hours', case when v_has then v_p.weekly_hours end,
    'closed_dates', case when v_has then v_p.closed_dates end,
    'payment_methods', to_jsonb(case when v_has then v_p.payment_methods else '{}'::text[] end),
    'pix_instructions', case when v_has then v_p.pix_instructions end,
    'public_notes', case when v_has then v_p.public_notes end,
    'updated_at', case when v_has then v_p.updated_at end,
    'knowledge_enabled', coalesce(v_s.knowledge_enabled, false),
    'ai_availability_mode', coalesce(v_s.ai_availability_mode, 'catalog'),
    'summary', jsonb_build_object(
      'catalog', jsonb_build_object(
        'products_active', (select count(*) from public.products pr
                              join public.product_categories k on k.company_id = pr.company_id and k.id = pr.category_id
                             where pr.company_id = p_company_id and pr.is_active and k.is_active),
        'categories_active', (select count(*) from public.product_categories k where k.company_id = p_company_id and k.is_active)),
      'contact', jsonb_build_object('name', v_c.name, 'phone', v_c.phone, 'whatsapp', v_c.whatsapp, 'email', v_c.email),
      'delivery', jsonb_build_object(
        'configured', v_dhas,
        'delivery_enabled', case when v_dhas then v_d.delivery_enabled end,
        'pickup_enabled', case when v_dhas then v_d.pickup_enabled end,
        'delivery_minutes', case when v_dhas then v_d.delivery_minutes end,
        'pickup_minutes', case when v_dhas then v_d.pickup_minutes end,
        'default_fee', case when v_dhas then v_d.default_fee end,
        'zones_active', (select count(*) from public.delivery_zones z where z.company_id = p_company_id and z.is_active))));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Escrita (owner/admin)
-- ---------------------------------------------------------------------------
create function public.whatsapp_ai_update_business_profile(
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

  -- só as duas colunas de preparação; as demais configurações da IA não são tocadas
  insert into public.company_whatsapp_ai_settings (company_id, ai_availability_mode, knowledge_enabled)
  values (p_company_id, p_ai_availability_mode, false)
  on conflict (company_id) do update
     set ai_availability_mode = excluded.ai_availability_mode,
         knowledge_enabled = false;

  return public.whatsapp_ai_get_business_profile(p_company_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) ACL
-- ---------------------------------------------------------------------------
revoke execute on function public.whatsapp_ai_get_business_profile(uuid) from public, anon, service_role;
grant execute on function public.whatsapp_ai_get_business_profile(uuid) to authenticated;
revoke execute on function public.whatsapp_ai_update_business_profile(uuid, text, text, jsonb, jsonb, text[], text, text, text, boolean) from public, anon, service_role;
grant execute on function public.whatsapp_ai_update_business_profile(uuid, text, text, jsonb, jsonb, text[], text, text, text, boolean) to authenticated;

-- CORTESIAS COMERCIAIS (Etapa 1: modelo de dados + RPCs do Master). ADITIVA: só cria objetos novos.
--
-- O QUE É: concessão comercial, com prazo, de um ITEM a uma empresa sem cobrança: o PLANO BASE (scope = 'plan') ou UM MÓDULO
-- (scope = 'module', inclusive módulos inativos/explicit_only como whatsapp e ia). Plano base e cada módulo são independentes.
--
-- O QUE ESTA ETAPA NÃO FAZ (de propósito; etapas posteriores, cada uma com autorização):
--   * NÃO altera company_entitlement / company_has_module / assert_company_module: a cortesia ainda NÃO concede acesso;
--   * NÃO altera faturamento (generate_subscription_invoice, subscription_extras_at, run_billing_cycle), Asaas, cron nem frontend;
--   * NÃO toca em subscriptions, subscription_modules, invoices, company_trials nem company_module_overrides (existentes seguem iguais);
--   * "converter em contratação" apenas REGISTRA a intenção (conversion_requested_*): nenhuma cobrança nasce, nenhum acesso muda,
--     e o estado 'converted' existe no modelo mas nenhuma RPC desta etapa o atribui.
--
-- ESTADOS (company_courtesies.status): active | expired_pending_decision | ended | converted.
--   * active -> expired_pending_decision: quando ends_at passa. A leitura SEMPRE deriva o estado em tempo real
--     (courtesy_effective_state), então atraso/falha de qualquer agendador nunca esconde um vencimento; master_reconcile_courtesies()
--     apenas MATERIALIZA o estado + evento (idempotente). Nenhum cron é criado aqui.
--   * vencida NÃO retira nada: segue aguardando decisão manual (prorrogar / encerrar / registrar intenção de conversão).
--   * ended e converted são TERMINAIS (trigger no banco). Nada é apagado: DELETE é bloqueado.
--
-- INTEGRIDADE: no máximo UMA cortesia ABERTA (active ou expired_pending_decision) por empresa e item (índice único parcial sobre
-- item_key). O preço de referência (plano ou módulo no momento da concessão) é CONGELADO em reference_price_cents e nunca
-- altera o catálogo nem contratos existentes.
--
-- ORDEM DE TRAVAS: as RPCs de escrita travam apenas EMPRESA (for no key update, como master_start_trial) -> CORTESIA (for update).
-- Nenhuma trava assinatura/fatura é tomada aqui; nenhum caminho existente trava cortesia. Quando etapas futuras integrarem a
-- cortesia ao faturamento, a regra permanece "assinatura -> fatura -> cortesia" (cortesia SEMPRE por último), compatível com 095000.

-- ---------------------------------------------------------------------------
-- 1) Tabelas
-- ---------------------------------------------------------------------------
create table public.company_courtesies (
  id uuid primary key default gen_random_uuid(),
  -- RESTRICT: como subscriptions, o histórico comercial não some junto com a empresa.
  company_id uuid not null references public.companies(id) on delete restrict,
  scope text not null check (scope in ('plan', 'module')),
  plan_id uuid references public.plans(id) on delete restrict,
  module_code text references public.modules(code) on update cascade on delete restrict,
  -- Chave do item dentro da empresa: 'plan' ou 'module:<code>'.
  item_key text generated always as (case when scope = 'plan' then 'plan' else 'module:' || module_code end) stored,
  status text not null default 'active'
    check (status in ('active', 'expired_pending_decision', 'ended', 'converted')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  -- Preço mensal de referência (catálogo) no momento da concessão: só informativo/relatório.
  reference_price_cents integer not null check (reference_price_cents >= 0),
  reason text not null check (char_length(btrim(reason)) between 3 and 200),
  -- Responsável pela concessão (some com o usuário sem perder o histórico).
  created_by uuid references auth.users(id) on delete set null,
  -- Chave de idempotência da concessão (opcional, global).
  request_id uuid,
  -- Intenção de conversão em contratação (apenas registro; sem efeito financeiro nesta etapa).
  conversion_requested_at timestamptz,
  conversion_requested_by uuid references auth.users(id) on delete set null,
  conversion_note text check (conversion_note is null or char_length(btrim(conversion_note)) between 3 and 500),
  -- Decisão que encerrou a cortesia (ended/converted).
  closed_at timestamptz,
  closed_by uuid references auth.users(id) on delete set null,
  close_note text check (close_note is null or char_length(btrim(close_note)) between 3 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint company_courtesies_scope_item check (
    (scope = 'plan' and plan_id is not null and module_code is null)
    or (scope = 'module' and module_code is not null and plan_id is null)),
  constraint company_courtesies_period check (ends_at > starts_at),
  constraint company_courtesies_closed check ((status in ('ended', 'converted')) = (closed_at is not null)),
  constraint company_courtesies_conversion check ((conversion_requested_at is null) = (conversion_note is null))
);

comment on table public.company_courtesies is
  'Cortesia comercial (plano base ou módulo) por empresa, com prazo. Etapa 1: só registro; NÃO concede acesso nem altera cobrança.';

-- Uma cortesia ABERTA por empresa e item.
create unique index company_courtesies_one_open
  on public.company_courtesies (company_id, item_key) where status in ('active', 'expired_pending_decision');
create unique index company_courtesies_request_uniq
  on public.company_courtesies (request_id) where request_id is not null;
create index company_courtesies_company_idx on public.company_courtesies (company_id, created_at desc);
create index company_courtesies_open_ends_idx on public.company_courtesies (ends_at) where status in ('active', 'expired_pending_decision');

create trigger company_courtesies_set_updated_at
  before update on public.company_courtesies
  for each row execute function public.set_updated_at();

create table public.company_courtesy_events (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  courtesy_id uuid not null references public.company_courtesies(id) on delete restrict,
  event_type text not null check (event_type in ('granted', 'extended', 'ended', 'expired', 'conversion_requested')),
  payload jsonb not null default '{}'::jsonb,
  actor_id uuid references auth.users(id) on delete set null,
  -- Chave de idempotência da operação (opcional; única por cortesia).
  request_id uuid,
  created_at timestamptz not null default now()
);
create index company_courtesy_events_courtesy_idx on public.company_courtesy_events (courtesy_id, seq);
create unique index company_courtesy_events_request_uniq
  on public.company_courtesy_events (courtesy_id, request_id) where request_id is not null;

-- ---------------------------------------------------------------------------
-- 2) Integridade no banco (não só nas RPCs)
-- ---------------------------------------------------------------------------
create function public.guard_company_courtesy_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'cortesia não pode ser apagada (histórico comercial)';
  end if;

  if new.company_id is distinct from old.company_id or new.scope is distinct from old.scope
     or new.plan_id is distinct from old.plan_id or new.module_code is distinct from old.module_code
     or new.starts_at is distinct from old.starts_at or new.reference_price_cents is distinct from old.reference_price_cents
     or new.reason is distinct from old.reason or new.created_by is distinct from old.created_by
     or new.request_id is distinct from old.request_id or new.created_at is distinct from old.created_at then
    raise exception 'cortesia: dados da concessão são imutáveis';
  end if;

  if old.status in ('ended', 'converted') then
    raise exception 'cortesia encerrada/convertida é definitiva e não pode ser alterada';
  end if;

  if new.status = 'expired_pending_decision' then
    if new.ends_at is distinct from old.ends_at or new.ends_at > public.business_now() then
      raise exception 'cortesia só passa a aguardar decisão depois de vencida';
    end if;
  elsif new.status = 'active' then
    if new.ends_at < old.ends_at or (old.status = 'expired_pending_decision' and
        (new.ends_at <= old.ends_at or new.ends_at <= public.business_now())) then
      raise exception 'cortesia só pode ser prorrogada para uma data futura e posterior à atual';
    end if;
  end if;
  return new;
end;
$$;

create trigger company_courtesies_guard
  before update or delete on public.company_courtesies
  for each row execute function public.guard_company_courtesy_change();

create function public.prevent_company_courtesy_event_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'company_courtesy_events é append-only';
end;
$$;

create trigger company_courtesy_events_no_change
  before update or delete on public.company_courtesy_events
  for each row execute function public.prevent_company_courtesy_event_change();

-- RLS restritiva: ninguém além de service_role/funções DEFINER acessa; o Master usa só as RPCs.
alter table public.company_courtesies enable row level security;
alter table public.company_courtesy_events enable row level security;
revoke all on public.company_courtesies from public, anon, authenticated;
revoke all on public.company_courtesy_events from public, anon, authenticated;
grant all on public.company_courtesies to service_role;
grant all on public.company_courtesy_events to service_role;
create policy company_courtesies_deny_clients on public.company_courtesies
  as restrictive for all to anon, authenticated using (false) with check (false);
create policy company_courtesy_events_deny_clients on public.company_courtesy_events
  as restrictive for all to anon, authenticated using (false) with check (false);

-- ---------------------------------------------------------------------------
-- 3) Helpers internos (ACL fechada)
-- ---------------------------------------------------------------------------
-- Estado em tempo real: 'active' vencida já é 'expired_pending_decision' (independe do agendador).
create function public.courtesy_effective_state(p_status text, p_ends_at timestamptz)
returns text
language sql
stable
set search_path = public
as $$
  select case when p_status = 'active' and p_ends_at <= public.business_now() then 'expired_pending_decision' else p_status end;
$$;

create function public.courtesy_json(p_c public.company_courtesies)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'id', p_c.id, 'company_id', p_c.company_id, 'scope', p_c.scope, 'plan_id', p_c.plan_id, 'module_code', p_c.module_code,
    'item_key', p_c.item_key, 'status', p_c.status,
    'effective_state', public.courtesy_effective_state(p_c.status, p_c.ends_at),
    'starts_at', p_c.starts_at, 'ends_at', p_c.ends_at,
    'days_remaining', case when p_c.status in ('ended', 'converted') then null
                           else ceil(extract(epoch from (p_c.ends_at - public.business_now())) / 86400.0)::integer end,
    'reference_price_cents', p_c.reference_price_cents, 'reason', p_c.reason,
    'created_by', p_c.created_by, 'created_at', p_c.created_at,
    'conversion_requested_at', p_c.conversion_requested_at, 'conversion_requested_by', p_c.conversion_requested_by,
    'conversion_note', p_c.conversion_note,
    'closed_at', p_c.closed_at, 'closed_by', p_c.closed_by, 'close_note', p_c.close_note);
$$;

create function public.courtesy_record_event(p_courtesy_id uuid, p_type text, p_payload jsonb, p_request_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.company_courtesy_events (courtesy_id, event_type, payload, actor_id, request_id)
  values (p_courtesy_id, p_type, coalesce(p_payload, '{}'::jsonb), auth.uid(), p_request_id);
$$;

-- Data final a partir de UMA das duas formas: p_days (30/60/90, a partir de p_from) ou p_end_date (data personalizada, vale até o
-- fim desse dia em America/Sao_Paulo). Limite: até 1095 dias à frente.
create function public.courtesy_resolve_end(p_days integer, p_end_date date, p_from timestamptz)
returns timestamptz
language plpgsql
stable
set search_path = public
as $$
declare
  v_end timestamptz;
begin
  if (p_days is null) = (p_end_date is null) then
    raise exception 'informe o prazo: 30, 60 ou 90 dias OU uma data personalizada (apenas um dos dois)';
  end if;
  if p_days is not null then
    if p_days not in (30, 60, 90) then
      raise exception 'prazo em dias deve ser 30, 60 ou 90 (ou informe uma data personalizada)';
    end if;
    v_end := p_from + make_interval(days => p_days);
  else
    v_end := ((p_end_date + 1)::timestamp) at time zone 'America/Sao_Paulo';
  end if;
  if v_end <= public.business_now() then
    raise exception 'a data final da cortesia deve ser futura';
  end if;
  if v_end > public.business_now() + interval '1095 days' then
    raise exception 'a cortesia pode durar no máximo 1095 dias a partir de hoje';
  end if;
  return v_end;
end;
$$;

create function public.courtesy_check_reason(p_reason text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v text := btrim(coalesce(p_reason, ''));
begin
  if char_length(v) < 3 or char_length(v) > 200 then
    raise exception 'informe o motivo (3 a 200 caracteres)';
  end if;
  return v;
end;
$$;

-- Materializa o vencimento de UMA cortesia (idempotente). Chamador já detém a trava da cortesia.
create function public.courtesy_expire_if_due(p_courtesy_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c public.company_courtesies;
begin
  select * into v_c from public.company_courtesies where id = p_courtesy_id for update;
  if not found or v_c.status <> 'active' or v_c.ends_at > public.business_now() then
    return false;
  end if;
  update public.company_courtesies set status = 'expired_pending_decision' where id = v_c.id;
  perform public.courtesy_record_event(v_c.id, 'expired', jsonb_build_object('ends_at', v_c.ends_at), null);
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) RPCs do Master
-- ---------------------------------------------------------------------------
-- Conceder. Idempotente: mesma request_id devolve a mesma cortesia; já existindo cortesia ABERTA do mesmo item, devolve a
-- existente (created=false) sem alterar nada. Para mudar o prazo use master_extend_courtesy.
create function public.master_grant_courtesy(
  p_company_id uuid,
  p_scope text,
  p_reason text,
  p_module_code text default null,
  p_plan_id uuid default null,
  p_days integer default null,
  p_end_date date default null,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text;
  v_item text;
  v_c public.company_courtesies;
  v_plan public.plans;
  v_mod public.modules;
  v_price integer;
  v_end timestamptz;
  v_warn jsonb := '[]'::jsonb;
begin
  perform public.assert_master_admin();

  if p_scope is null or p_scope not in ('plan', 'module') then
    raise exception 'escopo inválido: use plan ou module';
  end if;
  if p_scope = 'plan' and (p_plan_id is null or p_module_code is not null) then
    raise exception 'cortesia de plano base exige plan_id (e não module_code)';
  end if;
  if p_scope = 'module' and (p_module_code is null or p_plan_id is not null) then
    raise exception 'cortesia de módulo exige module_code (e não plan_id)';
  end if;
  v_reason := public.courtesy_check_reason(p_reason);
  v_item := case when p_scope = 'plan' then 'plan' else 'module:' || p_module_code end;

  -- ORDEM DE TRAVAS: empresa -> cortesia.
  perform 1 from public.companies where id = p_company_id for no key update;
  if not found then
    raise exception 'empresa não encontrada';
  end if;

  if p_request_id is not null then
    select * into v_c from public.company_courtesies where request_id = p_request_id;
    if found then
      if v_c.company_id <> p_company_id or v_c.item_key <> v_item then
        raise exception 'request_id já utilizado em outra operação';
      end if;
      return jsonb_build_object('courtesy', public.courtesy_json(v_c), 'created', false, 'replayed', true, 'warnings', '[]'::jsonb);
    end if;
  end if;

  select * into v_c from public.company_courtesies
   where company_id = p_company_id and item_key = v_item and status in ('active', 'expired_pending_decision') for update;
  if found then
    return jsonb_build_object('courtesy', public.courtesy_json(v_c), 'created', false, 'replayed', false, 'warnings', '[]'::jsonb);
  end if;

  if p_scope = 'plan' then
    select * into v_plan from public.plans where id = p_plan_id;
    if not found then raise exception 'plano não encontrado'; end if;
    if v_plan.code = public.trial_reserved_plan_code() then
      raise exception 'o registro reservado do período grátis não pode receber cortesia';
    end if;
    v_price := v_plan.monthly_price_cents;
  else
    select * into v_mod from public.modules where code = p_module_code;
    if not found then raise exception 'módulo não encontrado'; end if;
    v_price := v_mod.monthly_price_cents;
  end if;

  v_end := public.courtesy_resolve_end(p_days, p_end_date, public.business_now());

  insert into public.company_courtesies (company_id, scope, plan_id, module_code, starts_at, ends_at, reference_price_cents, reason, created_by, request_id)
  values (p_company_id, p_scope, case when p_scope = 'plan' then p_plan_id end, case when p_scope = 'module' then p_module_code end,
          public.business_now(), v_end, v_price, v_reason, auth.uid(), p_request_id)
  returning * into v_c;

  -- Avisos informativos (leitura sem trava; nada é alterado): o que a empresa já tem hoje.
  if exists (select 1 from public.subscriptions s where s.company_id = p_company_id and s.status <> 'canceled') then
    v_warn := v_warn || to_jsonb('company_has_active_subscription'::text);
    if p_scope = 'module' and exists (
         select 1 from public.subscriptions s join public.subscription_modules sm on sm.subscription_id = s.id
           join public.modules m on m.id = sm.module_id
          where s.company_id = p_company_id and s.status <> 'canceled' and sm.removed_at is null and m.code = p_module_code) then
      v_warn := v_warn || to_jsonb('module_already_in_subscription'::text);
    end if;
    if p_scope = 'plan' and exists (
         select 1 from public.subscriptions s where s.company_id = p_company_id and s.status <> 'canceled' and s.plan_id = p_plan_id) then
      v_warn := v_warn || to_jsonb('plan_already_in_subscription'::text);
    end if;
  end if;
  if p_scope = 'module' and exists (
       select 1 from public.company_module_overrides o
        where o.company_id = p_company_id and o.module_code = p_module_code and (o.expires_at is null or o.expires_at > public.business_now())) then
    v_warn := v_warn || to_jsonb('module_override_active'::text);
  end if;

  perform public.courtesy_record_event(v_c.id, 'granted', jsonb_build_object(
    'scope', p_scope, 'plan_id', v_c.plan_id, 'module_code', v_c.module_code, 'starts_at', v_c.starts_at, 'ends_at', v_c.ends_at,
    'days', p_days, 'end_date', p_end_date, 'reference_price_cents', v_price, 'reason', v_reason, 'warnings', v_warn), p_request_id);

  return jsonb_build_object('courtesy', public.courtesy_json(v_c), 'created', true, 'replayed', false, 'warnings', v_warn);
end;
$$;

-- Prorrogar. p_days (30/60/90) soma a partir do MAIOR entre o vencimento atual e agora; p_end_date define a nova data final
-- (idempotente por natureza: a mesma data repetida não faz nada). Cortesia vencida prorrogada volta a 'active'.
create function public.master_extend_courtesy(
  p_courtesy_id uuid,
  p_reason text,
  p_days integer default null,
  p_end_date date default null,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_c public.company_courtesies;
  v_reason text;
  v_end timestamptz;
  v_prev_status text;
  v_old_end timestamptz;
begin
  perform public.assert_master_admin();
  v_reason := public.courtesy_check_reason(p_reason);

  select company_id into v_company from public.company_courtesies where id = p_courtesy_id;   -- imutável: leitura sem trava
  if not found then
    raise exception 'cortesia não encontrada';
  end if;
  perform 1 from public.companies where id = v_company for no key update;
  select * into v_c from public.company_courtesies where id = p_courtesy_id for update;

  if p_request_id is not null and exists (
       select 1 from public.company_courtesy_events e where e.courtesy_id = p_courtesy_id and e.request_id = p_request_id) then
    return jsonb_build_object('courtesy', public.courtesy_json(v_c), 'changed', false, 'replayed', true);
  end if;

  if v_c.status in ('ended', 'converted') then
    raise exception 'cortesia encerrada/convertida não pode ser prorrogada';
  end if;

  v_end := public.courtesy_resolve_end(p_days, p_end_date, greatest(v_c.ends_at, public.business_now()));
  if v_end = v_c.ends_at then
    return jsonb_build_object('courtesy', public.courtesy_json(v_c), 'changed', false, 'replayed', false);
  end if;
  if v_end < v_c.ends_at then
    raise exception 'a nova data deve ser posterior ao vencimento atual (%)', v_c.ends_at;
  end if;

  v_prev_status := public.courtesy_effective_state(v_c.status, v_c.ends_at);
  v_old_end := v_c.ends_at;
  update public.company_courtesies
     set status = 'active', ends_at = v_end,
         conversion_requested_at = null, conversion_requested_by = null, conversion_note = null
   where id = v_c.id returning * into v_c;

  perform public.courtesy_record_event(v_c.id, 'extended', jsonb_build_object(
    'from_ends_at', v_old_end,
    'to_ends_at', v_end, 'days', p_days, 'end_date', p_end_date, 'previous_state', v_prev_status, 'reason', v_reason), p_request_id);

  return jsonb_build_object('courtesy', public.courtesy_json(v_c), 'changed', true, 'replayed', false);
end;
$$;

-- Encerrar (terminal). Idempotente: encerrar o que já está encerrado não faz nada. Nesta etapa NÃO retira acesso (a cortesia
-- ainda não concede acesso); nas etapas seguintes o encerramento passa a cessar a concessão.
create function public.master_end_courtesy(p_courtesy_id uuid, p_reason text, p_request_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_c public.company_courtesies;
  v_note text;
  v_prev text;
  v_replay boolean;
begin
  perform public.assert_master_admin();
  v_note := public.courtesy_check_reason(p_reason);

  select company_id into v_company from public.company_courtesies where id = p_courtesy_id;
  if not found then
    raise exception 'cortesia não encontrada';
  end if;
  perform 1 from public.companies where id = v_company for no key update;
  select * into v_c from public.company_courtesies where id = p_courtesy_id for update;

  v_replay := p_request_id is not null and exists (
    select 1 from public.company_courtesy_events e where e.courtesy_id = p_courtesy_id and e.request_id = p_request_id);
  if v_replay or v_c.status = 'ended' then
    return jsonb_build_object('courtesy', public.courtesy_json(v_c), 'changed', false, 'replayed', v_replay);
  end if;
  if v_c.status = 'converted' then
    raise exception 'cortesia já convertida não pode ser encerrada';
  end if;

  v_prev := public.courtesy_effective_state(v_c.status, v_c.ends_at);
  update public.company_courtesies
     set status = 'ended', closed_at = public.business_now(), closed_by = auth.uid(), close_note = v_note
   where id = v_c.id returning * into v_c;

  perform public.courtesy_record_event(v_c.id, 'ended', jsonb_build_object(
    'previous_state', v_prev, 'ends_at', v_c.ends_at, 'had_conversion_request', v_c.conversion_requested_at is not null, 'reason', v_note), p_request_id);

  return jsonb_build_object('courtesy', public.courtesy_json(v_c), 'changed', true, 'replayed', false);
end;
$$;

-- Registrar a INTENÇÃO de converter em contratação. Não cria fatura, não ativa cobrança, não muda estado nem acesso.
-- Idempotente: repetir não duplica (a primeira intenção permanece).
create function public.master_request_courtesy_conversion(p_courtesy_id uuid, p_note text, p_request_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_c public.company_courtesies;
  v_note text;
begin
  perform public.assert_master_admin();
  v_note := public.courtesy_check_reason(p_note);

  select company_id into v_company from public.company_courtesies where id = p_courtesy_id;
  if not found then
    raise exception 'cortesia não encontrada';
  end if;
  perform 1 from public.companies where id = v_company for no key update;
  select * into v_c from public.company_courtesies where id = p_courtesy_id for update;

  if v_c.status in ('ended', 'converted') then
    raise exception 'cortesia encerrada/convertida não aceita decisão de conversão';
  end if;
  if v_c.conversion_requested_at is not null
     or (p_request_id is not null and exists (
           select 1 from public.company_courtesy_events e where e.courtesy_id = p_courtesy_id and e.request_id = p_request_id)) then
    return jsonb_build_object('courtesy', public.courtesy_json(v_c), 'changed', false, 'replayed', p_request_id is not null);
  end if;

  update public.company_courtesies
     set conversion_requested_at = public.business_now(), conversion_requested_by = auth.uid(), conversion_note = v_note
   where id = v_c.id returning * into v_c;

  perform public.courtesy_record_event(v_c.id, 'conversion_requested', jsonb_build_object(
    'state', public.courtesy_effective_state(v_c.status, v_c.ends_at), 'note', v_note, 'effect', 'none_in_stage_1'), p_request_id);

  return jsonb_build_object('courtesy', public.courtesy_json(v_c), 'changed', true, 'replayed', false);
end;
$$;

-- Consulta de UMA cortesia, com a empresa, quem concedeu e os eventos.
create function public.master_get_courtesy(p_courtesy_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_c public.company_courtesies;
begin
  perform public.assert_master_admin();
  select * into v_c from public.company_courtesies where id = p_courtesy_id;
  if not found then
    raise exception 'cortesia não encontrada';
  end if;
  return jsonb_build_object(
    'courtesy', public.courtesy_json(v_c),
    'company', (select jsonb_build_object('id', c.id, 'name', c.name) from public.companies c where c.id = v_c.company_id),
    'created_by_email', (select p.email from public.profiles p where p.user_id = v_c.created_by),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'seq', e.seq, 'event_type', e.event_type, 'payload', e.payload,
                                          'actor_email', pr.email, 'created_at', e.created_at) order by e.seq)
        from public.company_courtesy_events e left join public.profiles pr on pr.user_id = e.actor_id
       where e.courtesy_id = v_c.id), '[]'::jsonb));
end;
$$;

-- Cortesias de UMA empresa (abertas por padrão; p_include_closed traz o histórico completo).
create function public.master_list_company_courtesies(p_company_id uuid, p_include_closed boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_master_admin();
  if not exists (select 1 from public.companies where id = p_company_id) then
    raise exception 'empresa não encontrada';
  end if;
  return coalesce((
    select jsonb_agg(public.courtesy_json(c) order by c.created_at desc, c.id)
      from public.company_courtesies c
     where c.company_id = p_company_id and (p_include_closed or c.status in ('active', 'expired_pending_decision'))), '[]'::jsonb);
end;
$$;

-- Alertas para o Master: vencidas aguardando decisão e a vencer em até p_within_days (padrão 7). Derivado em tempo real.
create function public.master_get_courtesy_alerts(p_within_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_within integer := least(greatest(coalesce(p_within_days, 7), 1), 90);
  v_items jsonb;
begin
  perform public.assert_master_admin();

  select coalesce(jsonb_agg(t.item order by t.sort_ends, t.cid), '[]'::jsonb) into v_items
  from (
    select c.id as cid, c.ends_at as sort_ends,
           public.courtesy_json(c) || jsonb_build_object(
             'alert_kind', case when c.ends_at <= public.business_now() then 'expired_pending_decision' else 'expiring_soon' end,
             'company_name', co.name,
             'days_overdue', case when c.ends_at <= public.business_now()
                                  then floor(extract(epoch from (public.business_now() - c.ends_at)) / 86400.0)::integer end,
             'conversion_requested', c.conversion_requested_at is not null) as item
      from public.company_courtesies c join public.companies co on co.id = c.company_id
     where c.status in ('active', 'expired_pending_decision')
       and c.ends_at <= public.business_now() + make_interval(days => v_within)
  ) t;

  return jsonb_build_object(
    'generated_at', public.business_now(),
    'within_days', v_within,
    'expired_count', (select count(*) from jsonb_array_elements(v_items) i where i ->> 'alert_kind' = 'expired_pending_decision'),
    'expiring_soon_count', (select count(*) from jsonb_array_elements(v_items) i where i ->> 'alert_kind' = 'expiring_soon'),
    'items', v_items);
end;
$$;

-- Materializa o vencimento de todas as cortesias vencidas (idempotente). NÃO é agendada aqui; a leitura já deriva o estado.
create function public.master_reconcile_courtesies()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_n integer := 0;
begin
  perform public.assert_master_admin();
  for v_row in
    select c.id, c.company_id from public.company_courtesies c
     where c.status = 'active' and c.ends_at <= public.business_now() order by c.company_id, c.id
  loop
    perform 1 from public.companies where id = v_row.company_id for no key update;
    if public.courtesy_expire_if_due(v_row.id) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) ACL explícita
-- ---------------------------------------------------------------------------
revoke execute on function public.guard_company_courtesy_change() from public, anon, authenticated;
revoke execute on function public.prevent_company_courtesy_event_change() from public, anon, authenticated;
revoke execute on function public.courtesy_effective_state(text, timestamptz) from public, anon, authenticated;
revoke execute on function public.courtesy_json(public.company_courtesies) from public, anon, authenticated;
revoke execute on function public.courtesy_record_event(uuid, text, jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.courtesy_resolve_end(integer, date, timestamptz) from public, anon, authenticated;
revoke execute on function public.courtesy_check_reason(text) from public, anon, authenticated;
revoke execute on function public.courtesy_expire_if_due(uuid) from public, anon, authenticated;

revoke execute on function public.master_grant_courtesy(uuid, text, text, text, uuid, integer, date, uuid) from public, anon;
revoke execute on function public.master_extend_courtesy(uuid, text, integer, date, uuid) from public, anon;
revoke execute on function public.master_end_courtesy(uuid, text, uuid) from public, anon;
revoke execute on function public.master_request_courtesy_conversion(uuid, text, uuid) from public, anon;
revoke execute on function public.master_get_courtesy(uuid) from public, anon;
revoke execute on function public.master_list_company_courtesies(uuid, boolean) from public, anon;
revoke execute on function public.master_get_courtesy_alerts(integer) from public, anon;
revoke execute on function public.master_reconcile_courtesies() from public, anon;

grant execute on function public.master_grant_courtesy(uuid, text, text, text, uuid, integer, date, uuid) to authenticated;
grant execute on function public.master_extend_courtesy(uuid, text, integer, date, uuid) to authenticated;
grant execute on function public.master_end_courtesy(uuid, text, uuid) to authenticated;
grant execute on function public.master_request_courtesy_conversion(uuid, text, uuid) to authenticated;
grant execute on function public.master_get_courtesy(uuid) to authenticated;
grant execute on function public.master_list_company_courtesies(uuid, boolean) to authenticated;
grant execute on function public.master_get_courtesy_alerts(integer) to authenticated;
grant execute on function public.master_reconcile_courtesies() to authenticated;

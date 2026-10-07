-- ISOLAMENTO DO ASAAS POR AMBIENTE (sandbox x production). Decisão: a conta Asaas de produção é COMPARTILHADA com outros sistemas;
-- o Gestão Atendimento Pro se isola por API key, webhook, token e externalReference próprios, e agora também por AMBIENTE EXPLÍCITO
-- em tudo que guarda ids do gateway. Antes desta migration nada identificava o ambiente: o customer e as cobranças do Sandbox
-- da Djalexeventos seriam reutilizados como se fossem de produção.
--
--   * company_asaas_customers (company_id, environment): o customer Asaas de cada empresa POR AMBIENTE (uma empresa pode ter um
--     customer Sandbox e outro Production). company_billing_profiles continua só com os dados comerciais; as colunas antigas
--     asaas_customer_id/customer_lock_* ficam como LEGADO congelado (nada é apagado) e não são mais lidas.
--   * environment ('sandbox'|'production') em asaas_charges, asaas_webhook_events e billing_anomalies; histórico existente = sandbox.
--   * unicidades por ambiente: (environment, asaas_customer_id), (environment, asaas_payment_id), (environment, event_id),
--     uma cobrança ativa por (fatura, ambiente).
--   * billing_gateway_settings: ambiente ATIVO do gateway no banco (fonte única para as telas do cliente e para as RPCs). Toda RPC
--     de serviço recebe o ambiente da Edge e RECUSA se divergir do ativo (Edge production com banco sandbox, ou o contrário,
--     falha fechada). A virada é um passo deliberado: billing_set_active_environment('production') (apenas dono do banco).
--   * pagamento ESTRANGEIRO (externalReference que não é gestao-atendimento-pro|invoice|...) é ignorado: sem anomalia, sem baixa,
--     sem job, sem alterar fatura. Só o que tem o NOSSO prefixo é validado com rigor (fatura inexistente => anomalia).

-- ---------------------------------------------------------------------------
-- 1) Ambiente ativo do gateway
-- ---------------------------------------------------------------------------
create table public.billing_gateway_settings (
  singleton boolean primary key default true check (singleton),
  environment text not null default 'sandbox' check (environment in ('sandbox', 'production')),
  updated_at timestamptz not null default now()
);
insert into public.billing_gateway_settings (singleton, environment) values (true, 'sandbox');
alter table public.billing_gateway_settings enable row level security;
revoke all on public.billing_gateway_settings from public, anon, authenticated, service_role;

create function public.billing_active_environment()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select environment from public.billing_gateway_settings where singleton;
$$;

create function public.billing_assert_environment(p_environment text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_active text := public.billing_active_environment();
begin
  if p_environment is null or p_environment not in ('sandbox', 'production') then
    raise exception 'Ambiente Asaas inválido.' using errcode = 'PT400';
  end if;
  if p_environment <> v_active then
    raise exception 'Ambiente Asaas (%) diverge do ambiente ativo do banco (%).', p_environment, v_active using errcode = 'PT409';
  end if;
end;
$$;

-- Virada controlada (somente quem tem o banco, via CLI/SQL administrativo; nenhum papel de API executa).
create function public.billing_set_active_environment(p_environment text)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_environment is null or p_environment not in ('sandbox', 'production') then
    raise exception 'Ambiente Asaas inválido.' using errcode = 'PT400';
  end if;
  update public.billing_gateway_settings set environment = p_environment, updated_at = now() where singleton;
  return p_environment;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) Customer Asaas por empresa e ambiente (histórico existente = sandbox)
-- ---------------------------------------------------------------------------
create table public.company_asaas_customers (
  company_id uuid not null references public.companies(id) on delete cascade,
  environment text not null check (environment in ('sandbox', 'production')),
  asaas_customer_id text,
  lock_token uuid,
  lock_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (company_id, environment)
);
create unique index company_asaas_customers_customer_uniq
  on public.company_asaas_customers (environment, asaas_customer_id) where asaas_customer_id is not null;
create trigger company_asaas_customers_set_updated_at
  before update on public.company_asaas_customers
  for each row execute function public.set_updated_at();
alter table public.company_asaas_customers enable row level security;
revoke all on public.company_asaas_customers from public, anon, authenticated;

insert into public.company_asaas_customers (company_id, environment, asaas_customer_id)
select company_id, 'sandbox', asaas_customer_id from public.company_billing_profiles where asaas_customer_id is not null;

comment on column public.company_billing_profiles.asaas_customer_id is
  'LEGADO (somente histórico Sandbox, congelado): o customer Asaas por ambiente vive em company_asaas_customers.';

-- ---------------------------------------------------------------------------
-- 3) environment nas cobranças, eventos de webhook e anomalias (backfill = sandbox) e unicidades por ambiente
-- ---------------------------------------------------------------------------
alter table public.asaas_charges add column environment text not null default 'sandbox'
  check (environment in ('sandbox', 'production'));
alter table public.asaas_charges alter column environment drop default;
alter table public.asaas_webhook_events add column environment text not null default 'sandbox'
  check (environment in ('sandbox', 'production'));
alter table public.asaas_webhook_events alter column environment drop default;
alter table public.billing_anomalies add column environment text not null default 'sandbox'
  check (environment in ('sandbox', 'production'));
alter table public.billing_anomalies alter column environment drop default;

do $$
declare
  r record;
begin
  for r in
    select con.conname, con.conrelid::regclass::text as tbl
      from pg_constraint con
     where con.contype = 'u'
       and ((con.conrelid = 'public.asaas_charges'::regclass and con.conkey = array[(select attnum from pg_attribute where attrelid = 'public.asaas_charges'::regclass and attname = 'asaas_payment_id')])
         or (con.conrelid = 'public.asaas_webhook_events'::regclass and con.conkey = array[(select attnum from pg_attribute where attrelid = 'public.asaas_webhook_events'::regclass and attname = 'event_id')]))
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end
$$;
create unique index asaas_charges_payment_env_uniq on public.asaas_charges (environment, asaas_payment_id);
create unique index asaas_webhook_events_env_event_uniq on public.asaas_webhook_events (environment, event_id);

drop index public.asaas_charges_one_active_per_invoice;
create unique index asaas_charges_one_active_per_invoice
  on public.asaas_charges (invoice_id, environment) where status not in ('deleted', 'refunded');
drop index public.billing_anomalies_event_kind_uniq;
create unique index billing_anomalies_event_kind_uniq
  on public.billing_anomalies (environment, event_id, kind) where event_id is not null;

-- ---------------------------------------------------------------------------
-- 4) RPCs de customer (por ambiente)
-- ---------------------------------------------------------------------------
drop function public.billing_claim_customer(uuid);
drop function public.billing_set_customer(uuid, uuid, text);
drop function public.billing_release_customer(uuid, uuid);

create function public.billing_claim_customer(p_company_id uuid, p_environment text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_snap jsonb;
  v_p public.company_billing_profiles;
  v_c public.company_asaas_customers;
  v_token uuid := gen_random_uuid();
begin
  perform public.billing_assert_environment(p_environment);
  perform pg_advisory_xact_lock(hashtextextended('billing-customer:' || p_company_id::text || ':' || p_environment, 0));

  v_snap := public.billing_profile_snapshot(p_company_id);
  if v_snap ->> 'problem' is not null then
    return jsonb_build_object('state', 'invalid_profile', 'problem', v_snap ->> 'problem');
  end if;

  insert into public.company_billing_profiles (company_id, document, name, email, phone)
  values (p_company_id, v_snap ->> 'document', v_snap ->> 'name', v_snap ->> 'email', v_snap ->> 'phone')
  on conflict (company_id) do update
    set document = excluded.document, name = excluded.name, email = excluded.email, phone = excluded.phone
  returning * into v_p;

  insert into public.company_asaas_customers (company_id, environment) values (p_company_id, p_environment)
  on conflict (company_id, environment) do nothing;
  select * into v_c from public.company_asaas_customers where company_id = p_company_id and environment = p_environment for update;

  if v_c.asaas_customer_id is not null then
    return jsonb_build_object('state', 'ready', 'customer_id', v_c.asaas_customer_id);
  end if;
  if v_c.lock_until is not null and v_c.lock_until > now() then
    return jsonb_build_object('state', 'busy');
  end if;

  update public.company_asaas_customers
     set lock_token = v_token, lock_until = now() + interval '60 seconds'
   where company_id = p_company_id and environment = p_environment;

  return jsonb_build_object('state', 'claimed', 'token', v_token,
    'external_reference', public.billing_customer_external_ref(p_company_id),
    'profile', jsonb_build_object('name', v_p.name, 'document', v_p.document, 'email', v_p.email, 'phone', v_p.phone));
end;
$$;

create function public.billing_set_customer(p_company_id uuid, p_token uuid, p_customer_id text, p_environment text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.billing_assert_environment(p_environment);
  perform pg_advisory_xact_lock(hashtextextended('billing-customer:' || p_company_id::text || ':' || p_environment, 0));
  if nullif(btrim(coalesce(p_customer_id, '')), '') is null then
    return jsonb_build_object('ok', false, 'reason', 'customer_id_required');
  end if;
  update public.company_asaas_customers
     set asaas_customer_id = p_customer_id, lock_token = null, lock_until = null
   where company_id = p_company_id and environment = p_environment and lock_token = p_token and asaas_customer_id is null;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'lease_lost');
  end if;
  return jsonb_build_object('ok', true);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'reason', 'customer_id_taken');
end;
$$;

create function public.billing_release_customer(p_company_id uuid, p_token uuid, p_environment text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.billing_assert_environment(p_environment);
  update public.company_asaas_customers
     set lock_token = null, lock_until = null
   where company_id = p_company_id and environment = p_environment and lock_token = p_token;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Cobrança: claim, cancelamento e reconciliação por ambiente
-- ---------------------------------------------------------------------------
drop function public.billing_claim_charge(uuid);
drop function public.billing_claim_cancel(uuid);
drop function public.billing_claim_reconcile(integer);

create function public.billing_claim_charge(p_invoice_id uuid, p_environment text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv public.invoices;
  v_ch public.asaas_charges;
  v_due date;
  v_token uuid := gen_random_uuid();
  v_desc text;
begin
  perform public.billing_assert_environment(p_environment);
  select * into v_inv from public.invoices where id = p_invoice_id;
  if not found then
    return jsonb_build_object('state', 'ineligible', 'reason', 'invoice_not_found');
  end if;
  if v_inv.status not in ('open', 'overdue') then
    return jsonb_build_object('state', 'ineligible', 'reason', 'invoice_' || v_inv.status);
  end if;
  if v_inv.amount_cents <= 0 then
    return jsonb_build_object('state', 'ineligible', 'reason', 'zero_amount');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('billing-charge:' || p_invoice_id::text, 0));

  -- o Asaas não aceita dueDate no passado: fatura já vencida antes da cobrança nascer envia HOJE só ao gateway
  -- (gateway_due_date). invoices.due_date, competência e carência NÃO mudam.
  v_due := greatest(v_inv.due_date, public.business_date());
  v_desc := case v_inv.kind when 'initial' then 'Gestão Atendimento Pro - Contratação'
            when 'module_addition' then 'Gestão Atendimento Pro - Módulos adicionais (proporcional)'
            else 'Gestão Atendimento Pro - Mensalidade ' || to_char(v_inv.competence, 'MM/YYYY') end;

  select * into v_ch from public.asaas_charges
   where invoice_id = p_invoice_id and environment = p_environment and status not in ('deleted', 'refunded') for update;

  if not found then
    insert into public.asaas_charges (company_id, invoice_id, environment, external_reference, status, gateway_due_date, amount_cents,
                                      lease_token, lease_until, attempts)
    values (v_inv.company_id, v_inv.id, p_environment, public.billing_asaas_external_ref(v_inv.id), 'creating', v_due,
            v_inv.amount_cents, v_token, now() + interval '120 seconds', 1)
    returning * into v_ch;
    return jsonb_build_object('state', 'claimed', 'token', v_token, 'company_id', v_inv.company_id,
      'description', v_desc, 'charge', jsonb_build_object('id', v_ch.id, 'asaas_payment_id', null,
      'external_reference', v_ch.external_reference, 'gateway_due_date', v_ch.gateway_due_date, 'amount_cents', v_ch.amount_cents,
      'status', v_ch.status));
  end if;

  if v_ch.status in ('received', 'confirmed') then
    return jsonb_build_object('state', 'ineligible', 'reason', 'charge_already_paid');
  end if;
  if v_ch.status = 'anomaly' then
    return jsonb_build_object('state', 'ineligible', 'reason', 'charge_anomaly');
  end if;
  if v_ch.status in ('pending', 'overdue') and v_ch.pix_payload is not null then
    return jsonb_build_object('state', 'ready', 'company_id', v_inv.company_id,
                              'charge', public.billing_charge_public(v_ch));
  end if;
  if v_ch.status = 'creating' and v_ch.lease_until is not null and v_ch.lease_until > now() then
    return jsonb_build_object('state', 'busy');
  end if;

  -- pending sem Pix, failed ou creating com lease vencido: retoma sob um lease NOVO
  update public.asaas_charges
     set status = 'creating', lease_token = v_token, lease_until = now() + interval '120 seconds',
         attempts = attempts + 1,
         gateway_due_date = case when asaas_payment_id is null then v_due else gateway_due_date end,
         amount_cents = case when asaas_payment_id is null then v_inv.amount_cents else amount_cents end
   where id = v_ch.id returning * into v_ch;
  return jsonb_build_object('state', 'claimed', 'token', v_token, 'company_id', v_inv.company_id,
    'description', v_desc, 'charge', jsonb_build_object('id', v_ch.id, 'asaas_payment_id', v_ch.asaas_payment_id,
    'external_reference', v_ch.external_reference, 'gateway_due_date', v_ch.gateway_due_date, 'amount_cents', v_ch.amount_cents,
    'status', v_ch.status));
end;
$$;

create function public.billing_claim_cancel(p_invoice_id uuid, p_environment text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ch public.asaas_charges;
begin
  perform public.billing_assert_environment(p_environment);
  perform pg_advisory_xact_lock(hashtextextended('billing-charge:' || p_invoice_id::text, 0));
  select * into v_ch from public.asaas_charges
   where invoice_id = p_invoice_id and environment = p_environment and status in ('creating', 'pending', 'overdue', 'failed') for update;
  if not found then
    return jsonb_build_object('state', 'nothing');
  end if;
  if v_ch.status = 'creating' and v_ch.asaas_payment_id is null and v_ch.lease_until is not null and v_ch.lease_until > now() then
    return jsonb_build_object('state', 'busy');
  end if;
  return jsonb_build_object('state', 'cancel', 'charge_id', v_ch.id, 'asaas_payment_id', v_ch.asaas_payment_id,
                            'external_reference', v_ch.external_reference);
end;
$$;

create function public.billing_claim_reconcile(p_environment text, p_limit integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
begin
  perform public.billing_assert_environment(p_environment);
  with c as (
    select id from public.asaas_charges
     where environment = p_environment and status in ('pending', 'overdue') and asaas_payment_id is not null
       and coalesce(reconciled_at, created_at) < now() - interval '6 hours'
     order by coalesce(reconciled_at, created_at)
     limit greatest(1, least(coalesce(p_limit, 10), 50))
       for update skip locked
  ), u as (
    update public.asaas_charges a set reconciled_at = now() from c where a.id = c.id
    returning a.id, a.asaas_payment_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('charge_id', id, 'asaas_payment_id', asaas_payment_id)), '[]'::jsonb)
    into v_rows from u;
  return v_rows;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Eventos de webhook e anomalias por ambiente; pagamento estrangeiro é ignorado (sem anomalia)
-- ---------------------------------------------------------------------------
drop function public.billing_record_anomaly(text, jsonb, uuid, uuid, uuid, text, text);
drop function public.billing_event_begin(text, text, text, jsonb);
drop function public.billing_event_finish(text, text, text, text);
drop function public.billing_event_apply(text, text, jsonb);

create function public.billing_record_anomaly(
  p_kind text, p_detail jsonb, p_company_id uuid default null, p_invoice_id uuid default null,
  p_charge_id uuid default null, p_payment_id text default null, p_event_id text default null,
  p_environment text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_env text := coalesce(p_environment, public.billing_active_environment());
begin
  perform public.billing_assert_environment(v_env);
  insert into public.billing_anomalies (company_id, invoice_id, charge_id, asaas_payment_id, event_id, kind, detail, environment)
  values (p_company_id, p_invoice_id, p_charge_id, p_payment_id, p_event_id, p_kind, coalesce(p_detail, '{}'::jsonb), v_env)
  on conflict (environment, event_id, kind) where event_id is not null do nothing;
end;
$$;

create function public.billing_event_begin(p_event_id text, p_event text, p_payment_id text, p_payload jsonb, p_environment text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ev public.asaas_webhook_events;
begin
  perform public.billing_assert_environment(p_environment);
  if nullif(btrim(coalesce(p_event_id, '')), '') is null then
    raise exception 'event_id obrigatório';
  end if;
  insert into public.asaas_webhook_events (event_id, event, payment_id, payload, environment)
  values (p_event_id, coalesce(nullif(btrim(p_event), ''), 'UNKNOWN'), p_payment_id, coalesce(p_payload, '{}'::jsonb), p_environment)
  on conflict (environment, event_id) do nothing;
  select * into v_ev from public.asaas_webhook_events where environment = p_environment and event_id = p_event_id;
  return jsonb_build_object('duplicate', v_ev.processed_at is not null);
end;
$$;

create function public.billing_event_finish(
  p_event_id text, p_status text, p_result text, p_error text, p_environment text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.billing_assert_environment(p_environment);
  update public.asaas_webhook_events
     set status = p_status, result = p_result, error = left(p_error, 500),
         processed_at = case when p_status = 'failed' then null else now() end
   where environment = p_environment and event_id = p_event_id and processed_at is null;
end;
$$;


create function public.billing_event_apply(p_event_id text, p_event text, p_payment jsonb, p_environment text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ev public.asaas_webhook_events;
  v_pid text := p_payment ->> 'id';
  v_status text := upper(coalesce(p_payment ->> 'status', ''));
  v_event text := upper(coalesce(p_event, ''));
  v_ref text := p_payment ->> 'external_reference';
  v_value integer := nullif(p_payment ->> 'value_cents', '')::integer;
  v_charge public.asaas_charges;
  v_inv public.invoices;
  v_inv_id uuid;
  v_paid_at timestamptz;
  v_pdate date := nullif(p_payment ->> 'payment_date', '')::date;
  v_detail jsonb;
  v_result text;
  v_ev_status text := 'processed';
  v_open boolean;
begin
  perform public.billing_assert_environment(p_environment);
  select * into v_ev from public.asaas_webhook_events where environment = p_environment and event_id = p_event_id for update;
  if not found then
    raise exception 'evento não registrado';
  end if;
  if v_ev.processed_at is not null then
    return jsonb_build_object('result', 'duplicate');
  end if;

  v_detail := jsonb_build_object('event', v_event, 'asaas_status', v_status, 'value_cents', v_value, 'external_reference', v_ref);

  -- 1) localizar a cobrança (sem travar ainda)
  select * into v_charge from public.asaas_charges where environment = p_environment and asaas_payment_id = v_pid;
  if not found then
    -- conta Asaas COMPARTILHADA: pagamento de outro sistema (referência que não é nossa) é ignorado, sem anomalia nem efeito
    if v_ref is null or v_ref not like 'gestao-atendimento-pro|invoice|%' then
      perform public.billing_event_finish(p_event_id, 'ignored', 'ignored_foreign_payment', null, p_environment);
      return jsonb_build_object('result', 'ignored_foreign_payment');
    end if;
    v_inv_id := public.billing_invoice_id_from_ref(v_ref);
    if v_inv_id is null then
      -- tem o NOSSO prefixo mas a referência é inválida: isso sim é anomalia
      perform public.billing_record_anomaly('unexpected_payment', v_detail || '{"why":"malformed_our_reference"}', null, null, null, v_pid, p_event_id, p_environment);
      perform public.billing_event_finish(p_event_id, 'anomaly', 'unexpected_payment', null, p_environment);
      return jsonb_build_object('result', 'anomaly', 'kind', 'unexpected_payment');
    end if;
    select * into v_inv from public.invoices where id = v_inv_id;
    if not found then
      perform public.billing_record_anomaly('invoice_not_found', v_detail, null, null, null, v_pid, p_event_id, p_environment);
      perform public.billing_event_finish(p_event_id, 'anomaly', 'invoice_not_found', null, p_environment);
      return jsonb_build_object('result', 'anomaly', 'kind', 'invoice_not_found');
    end if;
    select * into v_charge from public.asaas_charges where invoice_id = v_inv_id and environment = p_environment and status not in ('deleted', 'refunded');
    if not found then
      perform public.billing_record_anomaly('unexpected_payment', v_detail || '{"why":"no_active_charge_for_invoice"}',
        v_inv.company_id, v_inv.id, null, v_pid, p_event_id, p_environment);
      perform public.billing_event_finish(p_event_id, 'anomaly', 'unexpected_payment', null, p_environment);
      return jsonb_build_object('result', 'anomaly', 'kind', 'unexpected_payment');
    end if;
    if v_charge.asaas_payment_id is not null and v_charge.asaas_payment_id <> v_pid then
      -- a fatura já tem OUTRA cobrança Asaas: este pagamento é uma duplicata/órfã
      perform public.billing_record_anomaly('duplicate_payment', v_detail || jsonb_build_object('charge_payment_id', v_charge.asaas_payment_id),
        v_inv.company_id, v_inv.id, v_charge.id, v_pid, p_event_id, p_environment);
      perform public.billing_event_finish(p_event_id, 'anomaly', 'duplicate_payment', null, p_environment);
      return jsonb_build_object('result', 'anomaly', 'kind', 'duplicate_payment');
    end if;
  end if;

  -- 2) ordem única de travas: assinatura -> cobrança -> fatura
  select * into v_inv from public.invoices where id = v_charge.invoice_id;
  perform 1 from public.subscriptions where id = v_inv.subscription_id for update;
  select * into v_charge from public.asaas_charges where id = v_charge.id for update;
  select * into v_inv from public.invoices where id = v_charge.invoice_id for update;

  -- cobrança criada na Edge mas ainda sem id gravado (timeout): o evento a adota
  if v_charge.asaas_payment_id is null then
    update public.asaas_charges set asaas_payment_id = v_pid where id = v_charge.id returning * into v_charge;
  end if;

  v_detail := v_detail || jsonb_build_object('charge_amount_cents', v_charge.amount_cents, 'invoice_status', v_inv.status);

  -- 3) validações (toda decisão exige coerência com a fatura/empresa locais)
  if v_inv.company_id <> v_charge.company_id then
    perform public.billing_record_anomaly('company_mismatch', v_detail, v_charge.company_id, v_inv.id, v_charge.id, v_pid, p_event_id, p_environment);
    perform public.billing_event_finish(p_event_id, 'anomaly', 'company_mismatch', null, p_environment);
    return jsonb_build_object('result', 'anomaly', 'kind', 'company_mismatch');
  end if;
  if v_ref is distinct from v_charge.external_reference then
    if v_charge.status in ('creating', 'pending', 'overdue', 'failed') then
      update public.asaas_charges set status = 'anomaly' where id = v_charge.id;
    end if;
    perform public.billing_record_anomaly('reference_mismatch', v_detail, v_charge.company_id, v_inv.id, v_charge.id, v_pid, p_event_id, p_environment);
    perform public.billing_event_finish(p_event_id, 'anomaly', 'reference_mismatch', null, p_environment);
    return jsonb_build_object('result', 'anomaly', 'kind', 'reference_mismatch');
  end if;
  if v_value is distinct from v_charge.amount_cents then
    if v_charge.status in ('creating', 'pending', 'overdue', 'failed') then
      update public.asaas_charges set status = 'anomaly' where id = v_charge.id;
    end if;
    perform public.billing_record_anomaly('value_mismatch', v_detail, v_charge.company_id, v_inv.id, v_charge.id, v_pid, p_event_id, p_environment);
    perform public.billing_event_finish(p_event_id, 'anomaly', 'value_mismatch', null, p_environment);
    return jsonb_build_object('result', 'anomaly', 'kind', 'value_mismatch');
  end if;

  v_open := v_inv.status in ('open', 'overdue');

  -- 4) decisão
  if v_event = 'PAYMENT_DELETED' then
    -- o status consultado NÃO muda numa exclusão: vale o evento (salvo deleted=false explícito)
    if (p_payment ->> 'deleted') = 'false' then
      v_result := 'deletion_not_confirmed'; v_ev_status := 'ignored';
    elsif v_charge.status in ('creating', 'pending', 'overdue', 'failed') then
      update public.asaas_charges set status = 'deleted', lease_token = null, lease_until = null where id = v_charge.id;
      v_result := 'charge_deleted';
      -- fatura ainda cobrável: nova cobrança (job idempotente por fatura)
      if v_open then perform public.billing_enqueue_job(v_inv.id, 'create_charge'); end if;
    else
      v_result := 'deletion_ignored'; v_ev_status := 'ignored';   -- paga/estornada/anomalia: nunca regride
    end if;

  elsif v_event = 'PAYMENT_RESTORED' then
    perform public.billing_record_anomaly('payment_restored', v_detail, v_charge.company_id, v_inv.id, v_charge.id, v_pid, p_event_id, p_environment);
    v_result := 'restored_recorded'; v_ev_status := 'anomaly';

  elsif v_status in ('RECEIVED', 'CONFIRMED') then
    if v_charge.status in ('received', 'confirmed') and v_inv.status = 'paid' then
      -- reentrega / CONFIRMED depois de RECEIVED: só promove, nunca rebaixa
      if v_status = 'RECEIVED' and v_charge.status = 'confirmed' then
        update public.asaas_charges set status = 'received' where id = v_charge.id;
      end if;
      v_result := 'already_settled';
    elsif v_inv.status = 'void' then
      if v_charge.status in ('creating', 'pending', 'overdue', 'failed') then
        update public.asaas_charges set status = 'anomaly' where id = v_charge.id;
      end if;
      perform public.billing_record_anomaly('paid_void_invoice', v_detail, v_charge.company_id, v_inv.id, v_charge.id, v_pid, p_event_id, p_environment);
      v_result := 'paid_void_invoice'; v_ev_status := 'anomaly';
    elsif v_inv.status = 'paid' then
      -- fatura já quitada por OUTRO caminho (baixa manual/outra cobrança): dinheiro em duplicidade, nada avança
      if v_charge.status in ('creating', 'pending', 'overdue', 'failed') then
        update public.asaas_charges set status = 'anomaly' where id = v_charge.id;
      end if;
      perform public.billing_record_anomaly('duplicate_payment', v_detail, v_charge.company_id, v_inv.id, v_charge.id, v_pid, p_event_id, p_environment);
      v_result := 'duplicate_payment'; v_ev_status := 'anomaly';
    else
      -- marca a cobrança ANTES da baixa (o trigger de cancelamento da fatura não a enxerga como aberta)
      -- cobrança já encerrada (excluída/estornada) que recebeu mesmo assim: o dinheiro chegou, a fatura quita.
      -- Só reativa a linha se NÃO houver outra cobrança ativa (índice único); se houver, ela é cancelada pelo
      -- trigger da baixa e esta linha fica como está.
      if v_charge.status not in ('deleted', 'refunded')
         or not exists (select 1 from public.asaas_charges o
                         where o.invoice_id = v_charge.invoice_id and o.environment = v_charge.environment and o.id <> v_charge.id
                           and o.status not in ('deleted', 'refunded')) then
        update public.asaas_charges
           set status = case when v_status = 'RECEIVED' then 'received' else 'confirmed' end,
               lease_token = null, lease_until = null, last_error = null
         where id = v_charge.id;
      end if;
      v_paid_at := case when v_pdate is null then null
                        else least(now(), ((v_pdate::timestamp + interval '23 hours 59 minutes') at time zone 'America/Sao_Paulo')) end;
      perform public.billing_settle_invoice_gateway(v_inv.id, v_paid_at,
        jsonb_build_object('charge_id', v_charge.id, 'asaas_status', v_status));
      v_result := 'settled';
    end if;

  elsif v_status = 'OVERDUE' then
    -- INFORMATIVO: nada em invoices/subscriptions (a regra oficial é invoices.due_date)
    if v_charge.status = 'pending' then
      update public.asaas_charges set status = 'overdue' where id = v_charge.id;
    end if;
    v_result := 'overdue_noted';

  elsif v_status in ('REFUNDED', 'REFUND_REQUESTED', 'REFUND_IN_PROGRESS') or v_event in ('PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED', 'PAYMENT_REFUND_IN_PROGRESS') then
    -- NUNCA desfaz fatura/assinatura sozinho: devolução é decisão humana
    if v_status = 'REFUNDED' and v_inv.status <> 'paid' then
      update public.asaas_charges set status = 'refunded', lease_token = null, lease_until = null where id = v_charge.id;
    end if;
    perform public.billing_record_anomaly('refund', v_detail, v_charge.company_id, v_inv.id, v_charge.id, v_pid, p_event_id, p_environment);
    v_result := 'refund_recorded'; v_ev_status := 'anomaly';

  elsif v_status in ('CHARGEBACK_REQUESTED', 'CHARGEBACK_DISPUTE', 'AWAITING_CHARGEBACK_REVERSAL')
        or v_event in ('PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_CHARGEBACK_DISPUTE', 'PAYMENT_AWAITING_CHARGEBACK_REVERSAL') then
    if v_charge.status in ('creating', 'pending', 'overdue', 'failed') then
      update public.asaas_charges set status = 'anomaly' where id = v_charge.id;
    end if;
    perform public.billing_record_anomaly('chargeback', v_detail, v_charge.company_id, v_inv.id, v_charge.id, v_pid, p_event_id, p_environment);
    v_result := 'chargeback_recorded'; v_ev_status := 'anomaly';

  elsif v_status in ('DUNNING_REQUESTED', 'DUNNING_RECEIVED') or v_event in ('PAYMENT_DUNNING_REQUESTED', 'PAYMENT_DUNNING_RECEIVED') then
    perform public.billing_record_anomaly('dunning', v_detail, v_charge.company_id, v_inv.id, v_charge.id, v_pid, p_event_id, p_environment);
    v_result := 'dunning_recorded'; v_ev_status := 'anomaly';

  else
    -- PAYMENT_CREATED / PAYMENT_UPDATED / demais: só atualiza dados de exibição
    if v_charge.status in ('pending', 'overdue') then
      update public.asaas_charges set invoice_url = coalesce(nullif(p_payment ->> 'invoice_url', ''), invoice_url) where id = v_charge.id;
    end if;
    v_result := 'noted'; v_ev_status := 'ignored';
  end if;

  perform public.billing_event_finish(p_event_id, v_ev_status, v_result, null, p_environment);
  return jsonb_build_object('result', v_result, 'charge_id', v_charge.id, 'invoice_id', v_inv.id);
end;
$$;

create or replace function public.tenant_get_invoice_payment(p_invoice_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_inv public.invoices;
  v_ch public.asaas_charges;
begin
  select * into v_inv from public.invoices where id = p_invoice_id;
  if not found then
    raise exception 'Fatura não encontrada.' using errcode = 'PT404';
  end if;
  perform public.billing_assert_owner(v_inv.company_id);

  select * into v_ch from public.asaas_charges
   where invoice_id = v_inv.id and environment = public.billing_active_environment() and status not in ('deleted', 'refunded');
  return jsonb_build_object(
    'invoice', jsonb_build_object('id', v_inv.id, 'kind', v_inv.kind, 'due_date', v_inv.due_date,
                                  'amount_cents', v_inv.amount_cents, 'status', v_inv.status),
    'payment', case
      when v_inv.status not in ('open', 'overdue') then null
      when v_ch.id is null then jsonb_build_object('state', 'not_created')
      when v_ch.status in ('pending', 'overdue') and v_ch.pix_payload is not null then
        jsonb_build_object('state', 'ready') || public.billing_charge_public(v_ch)
      when v_ch.status in ('received', 'confirmed') then jsonb_build_object('state', 'paid_awaiting_settlement')
      when v_ch.status = 'anomaly' then jsonb_build_object('state', 'under_review')
      else jsonb_build_object('state', 'creating') end);
end;
$$;

create or replace function public.tenant_list_invoices(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.billing_assert_owner_or_admin(p_company_id);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', i.id, 'kind', i.kind, 'competence', i.competence, 'due_date', i.due_date,
      'amount_cents', i.amount_cents, 'status', i.status, 'paid_at', i.paid_at,
      'items', coalesce((select jsonb_agg(jsonb_build_object('kind', it.kind, 'description', it.description,
                  'amount_cents', it.amount_cents) order by it.created_at, it.id)
                  from public.invoice_items it where it.invoice_id = i.id), '[]'::jsonb),
      'payment_status', (select c.status from public.asaas_charges c
                          where c.invoice_id = i.id and c.environment = public.billing_active_environment() and c.status not in ('deleted', 'refunded')),
      'pix_ready', exists (select 1 from public.asaas_charges c
                            where c.invoice_id = i.id and c.environment = public.billing_active_environment() and c.status in ('pending', 'overdue') and c.pix_payload is not null))
      order by i.due_date desc, i.created_at desc)
    from public.invoices i where i.company_id = p_company_id), '[]'::jsonb);
end;
$$;

create or replace function public.master_list_invoice_gateway(p_invoice_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_master_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'invoice_id', i.id,
      'gateway', case when c.id is null then null else 'asaas' end,
      'environment', c.environment,
      'charge_status', c.status,
      'invoice_url', c.invoice_url,
      'gateway_due_date', c.gateway_due_date,
      'attempts', c.attempts,
      'last_error', left(c.last_error, 200),
      'open_anomalies', (select count(*) from public.billing_anomalies a where a.invoice_id = i.id and a.resolved_at is null))
      order by i.created_at desc)
    from public.invoices i
    left join public.asaas_charges c on c.invoice_id = i.id and c.environment = public.billing_active_environment() and c.status not in ('deleted', 'refunded')
    where p_invoice_id is null or i.id = p_invoice_id), '[]'::jsonb);
end;
$$;

create or replace function public.master_list_billing_anomalies(p_only_open boolean default true)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_master_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'kind', a.kind, 'environment', a.environment, 'company_id', a.company_id, 'company_name', c.name, 'invoice_id', a.invoice_id,
      'charge_id', a.charge_id, 'asaas_payment_id', a.asaas_payment_id, 'detail', a.detail,
      'created_at', a.created_at, 'resolved_at', a.resolved_at, 'resolution_note', a.resolution_note)
      order by a.created_at desc)
    from public.billing_anomalies a left join public.companies c on c.id = a.company_id
    where (not coalesce(p_only_open, true)) or a.resolved_at is null), '[]'::jsonb);
end;
$$;

create or replace function public.invoices_enqueue_cancel()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status in ('open', 'overdue') and new.status in ('paid', 'void')
     and exists (select 1 from public.asaas_charges c
                  where c.invoice_id = new.id and c.environment = public.billing_active_environment()
                    and c.status in ('creating', 'pending', 'overdue', 'failed')) then
    perform public.billing_enqueue_job(new.id, 'cancel_charge');
  end if;
  return new;
end;
$$;

create or replace function public.billing_dispatch_jobs()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_secret text;
begin
  if not exists (select 1 from public.billing_jobs
                  where (status = 'pending' and next_run_at <= now()) or (status = 'running' and locked_until < now()))
     and not exists (select 1 from public.asaas_charges
                      where environment = public.billing_active_environment() and status in ('pending', 'overdue') and asaas_payment_id is not null
                        and coalesce(reconciled_at, created_at) < now() - interval '6 hours') then
    return;
  end if;

  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'BILLING_WORKER_URL' limit 1;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'BILLING_WORKER_SECRET' limit 1;
  if nullif(btrim(coalesce(v_url, '')), '') is null or nullif(btrim(coalesce(v_secret, '')), '') is null then
    return;
  end if;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', v_secret),
    body := '{}'::jsonb
  );
exception when others then
  raise warning 'billing_dispatch_jobs falhou: %', sqlerrm;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6b) COMPATIBILIDADE TRANSITÓRIA com as Edge Functions JÁ PUBLICADAS (código anterior, que chama as assinaturas sem ambiente).
--     Elas continuam funcionando enquanto o redeploy não acontece e SEMPRE operam como 'sandbox' (o ambiente ativo atual); se o
--     banco for virado para production elas passam a ser recusadas pela guarda de ambiente. Fechadas a todos, exceto service_role
--     como antes. REMOVER numa migration posterior, logo após o redeploy das Edge Functions novas.
-- ---------------------------------------------------------------------------
create function public.billing_claim_customer(p_company_id uuid)
returns jsonb language sql security definer set search_path = public as $$ select public.billing_claim_customer(p_company_id, 'sandbox'); $$;
create function public.billing_set_customer(p_company_id uuid, p_token uuid, p_customer_id text)
returns jsonb language sql security definer set search_path = public as $$ select public.billing_set_customer(p_company_id, p_token, p_customer_id, 'sandbox'); $$;
create function public.billing_release_customer(p_company_id uuid, p_token uuid)
returns void language sql security definer set search_path = public as $$ select public.billing_release_customer(p_company_id, p_token, 'sandbox'); $$;
create function public.billing_claim_charge(p_invoice_id uuid)
returns jsonb language sql security definer set search_path = public as $$ select public.billing_claim_charge(p_invoice_id, 'sandbox'); $$;
create function public.billing_claim_cancel(p_invoice_id uuid)
returns jsonb language sql security definer set search_path = public as $$ select public.billing_claim_cancel(p_invoice_id, 'sandbox'); $$;
create function public.billing_claim_reconcile(p_limit integer default 10)
returns jsonb language sql security definer set search_path = public as $$ select public.billing_claim_reconcile('sandbox', p_limit); $$;
create function public.billing_event_begin(p_event_id text, p_event text, p_payment_id text, p_payload jsonb)
returns jsonb language sql security definer set search_path = public as $$ select public.billing_event_begin(p_event_id, p_event, p_payment_id, p_payload, 'sandbox'); $$;
create function public.billing_event_finish(p_event_id text, p_status text, p_result text default null, p_error text default null)
returns void language sql security definer set search_path = public as $$ select public.billing_event_finish(p_event_id, p_status, p_result, p_error, 'sandbox'); $$;
create function public.billing_event_apply(p_event_id text, p_event text, p_payment jsonb)
returns jsonb language sql security definer set search_path = public as $$ select public.billing_event_apply(p_event_id, p_event, p_payment, 'sandbox'); $$;


-- ---------------------------------------------------------------------------
-- 7) ACL: o que a Edge usa (service_role); o resto fechado
-- ---------------------------------------------------------------------------
revoke execute on function public.billing_active_environment() from public, anon, authenticated, service_role;
revoke execute on function public.billing_assert_environment(text) from public, anon, authenticated, service_role;
revoke execute on function public.billing_set_active_environment(text) from public, anon, authenticated, service_role;
revoke execute on function public.billing_claim_customer(uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.billing_set_customer(uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke execute on function public.billing_release_customer(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.billing_claim_charge(uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.billing_claim_cancel(uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.billing_claim_reconcile(text, integer) from public, anon, authenticated, service_role;
revoke execute on function public.billing_record_anomaly(text, jsonb, uuid, uuid, uuid, text, text, text) from public, anon, authenticated, service_role;
revoke execute on function public.billing_event_begin(text, text, text, jsonb, text) from public, anon, authenticated, service_role;
revoke execute on function public.billing_event_finish(text, text, text, text, text) from public, anon, authenticated, service_role;
revoke execute on function public.billing_event_apply(text, text, jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.billing_claim_customer(uuid, text) to service_role;
grant execute on function public.billing_set_customer(uuid, uuid, text, text) to service_role;
grant execute on function public.billing_release_customer(uuid, uuid, text) to service_role;
grant execute on function public.billing_claim_charge(uuid, text) to service_role;
grant execute on function public.billing_claim_cancel(uuid, text) to service_role;
grant execute on function public.billing_claim_reconcile(text, integer) to service_role;
grant execute on function public.billing_record_anomaly(text, jsonb, uuid, uuid, uuid, text, text, text) to service_role;
grant execute on function public.billing_event_begin(text, text, text, jsonb, text) to service_role;
grant execute on function public.billing_event_finish(text, text, text, text, text) to service_role;
grant execute on function public.billing_event_apply(text, text, jsonb, text) to service_role;
revoke execute on function public.billing_claim_customer(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.billing_set_customer(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.billing_release_customer(uuid, uuid) from public, anon, authenticated, service_role;
revoke execute on function public.billing_claim_charge(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.billing_claim_cancel(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.billing_claim_reconcile(integer) from public, anon, authenticated, service_role;
revoke execute on function public.billing_event_begin(text, text, text, jsonb) from public, anon, authenticated, service_role;
revoke execute on function public.billing_event_finish(text, text, text, text) from public, anon, authenticated, service_role;
revoke execute on function public.billing_event_apply(text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.billing_claim_customer(uuid) to service_role;
grant execute on function public.billing_set_customer(uuid, uuid, text) to service_role;
grant execute on function public.billing_release_customer(uuid, uuid) to service_role;
grant execute on function public.billing_claim_charge(uuid) to service_role;
grant execute on function public.billing_claim_cancel(uuid) to service_role;
grant execute on function public.billing_claim_reconcile(integer) to service_role;
grant execute on function public.billing_event_begin(text, text, text, jsonb) to service_role;
grant execute on function public.billing_event_finish(text, text, text, text) to service_role;
grant execute on function public.billing_event_apply(text, text, jsonb) to service_role;

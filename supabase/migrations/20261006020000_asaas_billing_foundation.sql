-- ASAAS — FUNDAÇÃO DE COBRANÇA (Sandbox) + ENFORCEMENT COMERCIAL (somente leitura) + RPCs do OWNER.
--
-- DECISÕES (auditoria Gestão Pro x Atendimento Pro, 2026-10-06):
--   * cobrança AVULSA Pix por fatura local; NÃO assinatura Asaas, NÃO Checkout, NÃO Pix Automático, NÃO cartão;
--   * invoices continuam sendo a FONTE DE VERDADE (competência, vencimento, valor, carência, bloqueio);
--     o Asaas só cobra e avisa. O OVERDUE do Asaas é informativo: grace/restricted vêm de invoices.due_date;
--   * no máximo UMA cobrança Asaas ATIVA por fatura (índice único parcial);
--   * pending_payment = SOMENTE LEITURA; só o OWNER contrata; CPF/CNPJ do customer vem de companies.document;
--   * a cobrança nasce junto com a fatura, mas SEM HTTP dentro do banco: trigger -> outbox (billing_jobs) -> cron
--     (pg_net) -> Edge billing-worker -> Asaas. A transação do banco nunca espera a API.
--
-- CORREÇÕES DO GESTÃO PRO (que fazia POST e só depois gravava o id):
--   * RESERVA ANTES DO POST: billing_claim_charge trava (advisory + linha) e reserva asaas_charges com um lease
--     (lease_token/lease_until). Dois cliques/jobs simultâneos: só UM recebe 'claimed'; o outro recebe 'busy'.
--     Toda gravação posterior exige o lease_token (lease perdido = gravação recusada).
--   * Antes de recriar após timeout: a Edge consulta o Asaas por externalReference (filtro documentado em
--     GET /payments e GET /customers) e confere o valor retornado item a item (filtro ignorado nunca adota
--     cobrança alheia). Validação em Sandbox real pendente (sem chave nesta rodada).
--   * customer: lease por empresa (company_billing_profiles), localizar por externalReference/documento antes de criar.
--   * divergência (valor, referência, fatura inexistente, pagamento inesperado, fatura void paga) vira ANOMALIA
--     auditável e o webhook responde 2xx; 5xx só em falha transitória real (Asaas fora do ar, banco).
--
-- ENFORCEMENT: company_access_state() deriva o estado comercial (tempo real) e guard_company_writable() barra
-- INSERT/UPDATE/DELETE nas tabelas operacionais quando a empresa está em somente leitura. Estado sem NENHUM
-- registro comercial ("unmanaged": nunca teve trial nem assinatura) segue liberado — empresas legadas/de teste não
-- são bloqueadas por esta migration; o bloqueio só nasce de um registro comercial (trial expirado, pending_payment,
-- restricted, suspended, canceled).
--
-- ACESSO: tabelas novas com RLS ligado, SEM policy e SEM grant para anon/authenticated; só service_role (Edge/cron)
-- e RPCs SECURITY DEFINER. Nada comercial é exposto diretamente ao tenant.

-- ---------------------------------------------------------------------------
-- 0) pg_net (idempotente; mesmo padrão do push) e referências determinísticas
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    create extension if not exists pg_net;
  end if;
end
$$;

create function public.billing_asaas_external_ref(p_invoice_id uuid)
returns text language sql immutable set search_path = public as $$
  select 'gestao-atendimento-pro|invoice|' || p_invoice_id::text;
$$;

create function public.billing_customer_external_ref(p_company_id uuid)
returns text language sql immutable set search_path = public as $$
  select 'company:' || p_company_id::text;
$$;

create function public.billing_invoice_id_from_ref(p_ref text)
returns uuid language sql immutable set search_path = public as $$
  select case when p_ref ~ '^gestao-atendimento-pro\|invoice\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then substr(p_ref, length('gestao-atendimento-pro|invoice|') + 1)::uuid end;
$$;

-- ---------------------------------------------------------------------------
-- 1) company_billing_profiles: snapshot de cobrança + id do customer Asaas (NÃO substitui companies)
-- ---------------------------------------------------------------------------
create table public.company_billing_profiles (
  company_id uuid primary key references public.companies(id) on delete cascade,
  asaas_customer_id text unique,
  document text not null check (document ~ '^([0-9]{11}|[0-9]{14})$'),
  name text not null check (length(btrim(name)) > 0),
  email text not null check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  phone text check (phone is null or phone ~ '^[0-9]{8,13}$'),
  -- lease da criação do customer (a chamada HTTP acontece FORA da transação do banco)
  customer_lock_token uuid,
  customer_lock_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger company_billing_profiles_set_updated_at
  before update on public.company_billing_profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2) asaas_charges: UMA cobrança ativa por fatura (centavos inteiros)
--    Estados locais (NÃO se misturam com invoices.status):
--      creating  reservada/em criação no Asaas (lease)         pending   criada, aguardando pagamento
--      overdue   vencida no Asaas (informativo)                confirmed PAYMENT_CONFIRMED (Pix: dinheiro confirmado)
--      received  PAYMENT_RECEIVED                              deleted   excluída/cancelada (encerrada)
--      refunded  estornada (encerrada)                         failed    última tentativa de criar falhou (retenta)
--      anomaly   divergência: precisa de análise humana
-- ---------------------------------------------------------------------------
alter table public.invoices
  add constraint invoices_id_company_uniq unique (id, company_id);

create table public.asaas_charges (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  invoice_id uuid not null,
  asaas_payment_id text unique,
  external_reference text not null,
  status text not null default 'creating'
    check (status in ('creating', 'pending', 'confirmed', 'received', 'overdue', 'deleted', 'refunded', 'failed', 'anomaly')),
  billing_type text not null default 'PIX' check (billing_type = 'PIX'),
  invoice_url text,
  pix_payload text,
  pix_qr text,
  -- vencimento ENVIADO ao gateway (dueDate do Asaas) — NÃO é o vencimento comercial. = greatest(invoices.due_date, hoje):
  -- só difere quando a fatura já venceu antes de a cobrança nascer (o Asaas não aceita dueDate no passado). O vencimento
  -- comercial, a competência e a carência continuam EXCLUSIVAMENTE em invoices; nada aqui os altera.
  gateway_due_date date not null,
  amount_cents integer not null check (amount_cents > 0),
  lease_token uuid,
  lease_until timestamptz,
  attempts integer not null default 0,
  reconciled_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint asaas_charges_invoice_company_fk foreign key (invoice_id, company_id)
    references public.invoices (id, company_id) on delete restrict,
  constraint asaas_charges_ref_check check (external_reference = public.billing_asaas_external_ref(invoice_id))
);
create unique index asaas_charges_one_active_per_invoice
  on public.asaas_charges (invoice_id) where status not in ('deleted', 'refunded');
create index asaas_charges_company_idx on public.asaas_charges (company_id, created_at desc);
create index asaas_charges_reconcile_idx on public.asaas_charges (status, reconciled_at) where status in ('pending', 'overdue');
create trigger asaas_charges_set_updated_at
  before update on public.asaas_charges
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3) asaas_webhook_events: idempotência por event_id (id do evento Asaas; sem id -> hash determinístico na Edge)
--    payload MÍNIMO e auditável (a Edge nunca grava dados do cliente).
-- ---------------------------------------------------------------------------
create table public.asaas_webhook_events (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique,
  event text not null,
  payment_id text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'received' check (status in ('received', 'processed', 'ignored', 'anomaly', 'failed')),
  result text,
  error text,
  payload jsonb not null default '{}'::jsonb
);
create index asaas_webhook_events_payment_idx on public.asaas_webhook_events (payment_id);

-- ---------------------------------------------------------------------------
-- 4) billing_anomalies: o que NÃO pode ser resolvido automaticamente
-- ---------------------------------------------------------------------------
create table public.billing_anomalies (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete set null,
  invoice_id uuid references public.invoices(id) on delete set null,
  charge_id uuid references public.asaas_charges(id) on delete set null,
  asaas_payment_id text,
  event_id text,
  kind text not null check (kind in (
    'value_mismatch', 'reference_mismatch', 'invoice_not_found', 'unexpected_payment', 'company_mismatch',
    'paid_void_invoice', 'duplicate_payment', 'payment_not_found_in_asaas', 'payment_restored',
    'refund', 'chargeback', 'dunning', 'charge_job_failed')),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_note text
);
create unique index billing_anomalies_event_kind_uniq on public.billing_anomalies (event_id, kind) where event_id is not null;
create index billing_anomalies_open_idx on public.billing_anomalies (created_at desc) where resolved_at is null;

-- ---------------------------------------------------------------------------
-- 5) billing_jobs: outbox (invoice criada -> job -> Edge cria a cobrança -> retry seguro)
-- ---------------------------------------------------------------------------
create table public.billing_jobs (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  kind text not null check (kind in ('create_charge', 'cancel_charge')),
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  attempts integer not null default 0,
  next_run_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  done_at timestamptz
);
-- idempotência SEMPRE pela fatura: no máximo um job aberto por (fatura, tipo)
create unique index billing_jobs_one_open on public.billing_jobs (invoice_id, kind) where status in ('pending', 'running');
create index billing_jobs_due_idx on public.billing_jobs (next_run_at) where status in ('pending', 'running');
create trigger billing_jobs_set_updated_at
  before update on public.billing_jobs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 6) ACL das tabelas: RLS ligado, nenhuma policy, nenhum grant para anon/authenticated
-- ---------------------------------------------------------------------------
alter table public.company_billing_profiles enable row level security;
alter table public.asaas_charges enable row level security;
alter table public.asaas_webhook_events enable row level security;
alter table public.billing_anomalies enable row level security;
alter table public.billing_jobs enable row level security;

revoke all on public.company_billing_profiles, public.asaas_charges, public.asaas_webhook_events,
  public.billing_anomalies, public.billing_jobs from public, anon, authenticated;
grant select, insert, update, delete on public.company_billing_profiles, public.asaas_charges,
  public.asaas_webhook_events, public.billing_anomalies, public.billing_jobs to service_role;

-- ---------------------------------------------------------------------------
-- 7) Perfil de cobrança (snapshot de companies; CPF/CNPJ de companies.document)
-- ---------------------------------------------------------------------------
create function public.billing_profile_snapshot(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_c public.companies;
  v_doc text;
  v_email text;
  v_phone text;
  v_problem text;
begin
  select * into v_c from public.companies where id = p_company_id;
  if not found then
    return jsonb_build_object('problem', 'company_not_found');
  end if;

  v_doc := nullif(regexp_replace(coalesce(v_c.document, ''), '\D', '', 'g'), '');
  if v_doc is null then
    v_problem := 'document_required';
  elsif not public.customers_valid_document(v_doc) then
    v_problem := 'document_invalid';
  end if;

  v_email := nullif(lower(btrim(coalesce(v_c.email, ''))), '');
  if v_email is null then
    select nullif(lower(btrim(p.email)), '') into v_email
      from public.company_users cu join public.profiles p on p.user_id = cu.user_id
     where cu.company_id = p_company_id and cu.role = 'owner' and cu.status = 'active'
     order by cu.created_at limit 1;
  end if;
  if v_email is null or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    v_problem := coalesce(v_problem, 'email_required');
  end if;

  v_phone := nullif(regexp_replace(coalesce(v_c.phone, v_c.whatsapp, ''), '\D', '', 'g'), '');
  if v_phone is not null and char_length(v_phone) not between 8 and 13 then
    v_phone := null;
  end if;

  return jsonb_build_object('problem', v_problem, 'name', btrim(v_c.name), 'document', v_doc,
                            'email', v_email, 'phone', v_phone);
end;
$$;

-- Reivindica a criação do customer (lease). A chamada HTTP acontece FORA do banco; só quem tem o token grava.
create function public.billing_claim_customer(p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_snap jsonb;
  v_p public.company_billing_profiles;
  v_token uuid := gen_random_uuid();
begin
  perform pg_advisory_xact_lock(hashtextextended('billing-customer:' || p_company_id::text, 0));

  v_snap := public.billing_profile_snapshot(p_company_id);
  if v_snap ->> 'problem' is not null then
    return jsonb_build_object('state', 'invalid_profile', 'problem', v_snap ->> 'problem');
  end if;

  insert into public.company_billing_profiles (company_id, document, name, email, phone)
  values (p_company_id, v_snap ->> 'document', v_snap ->> 'name', v_snap ->> 'email', v_snap ->> 'phone')
  on conflict (company_id) do update
    set document = excluded.document, name = excluded.name, email = excluded.email, phone = excluded.phone
  returning * into v_p;

  if v_p.asaas_customer_id is not null then
    return jsonb_build_object('state', 'ready', 'customer_id', v_p.asaas_customer_id);
  end if;
  if v_p.customer_lock_until is not null and v_p.customer_lock_until > now() then
    return jsonb_build_object('state', 'busy');
  end if;

  update public.company_billing_profiles
     set customer_lock_token = v_token, customer_lock_until = now() + interval '60 seconds'
   where company_id = p_company_id;

  return jsonb_build_object('state', 'claimed', 'token', v_token,
    'external_reference', public.billing_customer_external_ref(p_company_id),
    'profile', jsonb_build_object('name', v_p.name, 'document', v_p.document, 'email', v_p.email, 'phone', v_p.phone));
end;
$$;

create function public.billing_set_customer(p_company_id uuid, p_token uuid, p_customer_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('billing-customer:' || p_company_id::text, 0));
  if nullif(btrim(coalesce(p_customer_id, '')), '') is null then
    return jsonb_build_object('ok', false, 'reason', 'customer_id_required');
  end if;
  update public.company_billing_profiles
     set asaas_customer_id = p_customer_id, customer_lock_token = null, customer_lock_until = null
   where company_id = p_company_id and customer_lock_token = p_token and asaas_customer_id is null;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'lease_lost');
  end if;
  return jsonb_build_object('ok', true);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'reason', 'customer_id_taken');
end;
$$;

create function public.billing_release_customer(p_company_id uuid, p_token uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.company_billing_profiles
     set customer_lock_token = null, customer_lock_until = null
   where company_id = p_company_id and customer_lock_token = p_token;
$$;

-- ---------------------------------------------------------------------------
-- 8) Cobrança: reserva ANTES do POST, gravações com lease
-- ---------------------------------------------------------------------------
create function public.billing_charge_public(p_c public.asaas_charges)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select jsonb_build_object('status', p_c.status, 'invoice_url', p_c.invoice_url, 'pix_payload', p_c.pix_payload,
                            'pix_qr', p_c.pix_qr, 'gateway_due_date', p_c.gateway_due_date, 'amount_cents', p_c.amount_cents);
$$;

create function public.billing_claim_charge(p_invoice_id uuid)
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
            else 'Gestão Atendimento Pro - Mensalidade ' || to_char(v_inv.competence, 'MM/YYYY') end;

  select * into v_ch from public.asaas_charges
   where invoice_id = p_invoice_id and status not in ('deleted', 'refunded') for update;

  if not found then
    insert into public.asaas_charges (company_id, invoice_id, external_reference, status, gateway_due_date, amount_cents,
                                      lease_token, lease_until, attempts)
    values (v_inv.company_id, v_inv.id, public.billing_asaas_external_ref(v_inv.id), 'creating', v_due,
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

create function public.billing_charge_record_payment(
  p_charge_id uuid, p_token uuid, p_payment_id text, p_invoice_url text, p_asaas_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ch public.asaas_charges;
  v_inv_status text;
begin
  select * into v_ch from public.asaas_charges where id = p_charge_id for update;
  if not found or v_ch.lease_token is distinct from p_token or v_ch.status <> 'creating' then
    return jsonb_build_object('ok', false, 'reason', 'lease_lost');
  end if;
  update public.asaas_charges
     set asaas_payment_id = p_payment_id, invoice_url = coalesce(p_invoice_url, invoice_url)
   where id = p_charge_id;
  select status into v_inv_status from public.invoices where id = v_ch.invoice_id;
  return jsonb_build_object('ok', true, 'invoice_status', v_inv_status);
end;
$$;

create function public.billing_charge_record_pix(
  p_charge_id uuid, p_token uuid, p_pix_payload text, p_pix_qr text, p_invoice_url text, p_asaas_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ch public.asaas_charges;
begin
  select * into v_ch from public.asaas_charges where id = p_charge_id for update;
  if not found or v_ch.lease_token is distinct from p_token or v_ch.status <> 'creating' then
    return jsonb_build_object('ok', false, 'reason', 'lease_lost');
  end if;
  if nullif(btrim(coalesce(p_pix_payload, '')), '') is null or nullif(btrim(coalesce(p_pix_qr, '')), '') is null then
    return jsonb_build_object('ok', false, 'reason', 'pix_incomplete');
  end if;
  update public.asaas_charges
     set pix_payload = p_pix_payload, pix_qr = p_pix_qr, invoice_url = coalesce(p_invoice_url, invoice_url),
         status = case when upper(coalesce(p_asaas_status, '')) = 'OVERDUE' then 'overdue' else 'pending' end,
         lease_token = null, lease_until = null, last_error = null
   where id = p_charge_id returning * into v_ch;
  return jsonb_build_object('ok', true, 'charge', public.billing_charge_public(v_ch));
end;
$$;

create function public.billing_charge_fail(p_charge_id uuid, p_token uuid, p_error text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.asaas_charges
     set status = 'failed', lease_token = null, lease_until = null, last_error = left(coalesce(p_error, 'erro'), 500)
   where id = p_charge_id and lease_token = p_token and status = 'creating';
  return jsonb_build_object('ok', found);
end;
$$;

-- Comando de cancelamento da cobrança Asaas aberta (fatura paga por outro caminho ou anulada)
create function public.billing_claim_cancel(p_invoice_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ch public.asaas_charges;
begin
  perform pg_advisory_xact_lock(hashtextextended('billing-charge:' || p_invoice_id::text, 0));
  select * into v_ch from public.asaas_charges
   where invoice_id = p_invoice_id and status in ('creating', 'pending', 'overdue', 'failed') for update;
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

create function public.billing_charge_mark_deleted(p_charge_id uuid, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.asaas_charges
     set status = 'deleted', lease_token = null, lease_until = null, last_error = nullif(left(coalesce(p_reason, ''), 500), '')
   where id = p_charge_id and status in ('creating', 'pending', 'overdue', 'failed');
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9) Baixa por gateway (service_role): MESMA lógica e MESMA ordem de travas de master_mark_invoice_paid
--    (assinatura -> fatura), sem assert_master_admin. Idempotente.
-- ---------------------------------------------------------------------------
create function public.billing_settle_invoice_gateway(
  p_invoice_id uuid, p_paid_at timestamptz default null, p_source jsonb default '{}'::jsonb
)
returns public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv public.invoices;
  v_sub_id uuid;
  v_paid timestamptz;
  v_from text;
begin
  select i.subscription_id into v_sub_id from public.invoices i where i.id = p_invoice_id;
  if not found then
    raise exception 'fatura não encontrada';
  end if;
  perform 1 from public.subscriptions where id = v_sub_id for update;

  select * into v_inv from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'fatura não encontrada';
  end if;
  if v_inv.status = 'paid' then
    return v_inv;
  end if;
  if v_inv.status = 'void' then
    raise exception 'fatura anulada não pode ser paga';
  end if;

  v_paid := least(coalesce(p_paid_at, now()), now());
  v_from := v_inv.status;
  update public.invoices set status = 'paid', paid_at = v_paid
   where id = v_inv.id returning * into v_inv;

  perform public.record_invoice_event(v_inv.id, 'paid', jsonb_build_object(
    'from_status', v_from, 'paid_at', v_paid, 'amount_cents', v_inv.amount_cents, 'source', 'asaas')
    || coalesce(p_source, '{}'::jsonb));

  perform public.reconcile_subscription_billing_state(v_inv.subscription_id);
  return v_inv;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10) Webhook: begin (idempotência) -> [Edge reconsulta o Asaas] -> apply (tudo numa transação)
-- ---------------------------------------------------------------------------
create function public.billing_record_anomaly(
  p_kind text, p_detail jsonb, p_company_id uuid default null, p_invoice_id uuid default null,
  p_charge_id uuid default null, p_payment_id text default null, p_event_id text default null
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.billing_anomalies (company_id, invoice_id, charge_id, asaas_payment_id, event_id, kind, detail)
  values (p_company_id, p_invoice_id, p_charge_id, p_payment_id, p_event_id, p_kind, coalesce(p_detail, '{}'::jsonb))
  on conflict (event_id, kind) where event_id is not null do nothing;
$$;

create function public.billing_event_begin(p_event_id text, p_event text, p_payment_id text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ev public.asaas_webhook_events;
begin
  if nullif(btrim(coalesce(p_event_id, '')), '') is null then
    raise exception 'event_id obrigatório';
  end if;
  insert into public.asaas_webhook_events (event_id, event, payment_id, payload)
  values (p_event_id, coalesce(nullif(btrim(p_event), ''), 'UNKNOWN'), p_payment_id, coalesce(p_payload, '{}'::jsonb))
  on conflict (event_id) do nothing;
  select * into v_ev from public.asaas_webhook_events where event_id = p_event_id;
  return jsonb_build_object('duplicate', v_ev.processed_at is not null);
end;
$$;

create function public.billing_event_finish(p_event_id text, p_status text, p_result text default null, p_error text default null)
returns void
language sql
security definer
set search_path = public
as $$
  update public.asaas_webhook_events
     set status = p_status, result = p_result, error = left(p_error, 500),
         processed_at = case when p_status = 'failed' then null else now() end
   where event_id = p_event_id and processed_at is null;
$$;

-- p_payment (JÁ reconsultado no Asaas pela Edge): {id, status, value_cents, external_reference, billing_type,
--   due_date, payment_date, deleted, invoice_url}. Toda a decisão é do banco, numa transação, sob as mesmas travas
-- (assinatura -> fatura) do resto do motor comercial.
create function public.billing_event_apply(p_event_id text, p_event text, p_payment jsonb)
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
  select * into v_ev from public.asaas_webhook_events where event_id = p_event_id for update;
  if not found then
    raise exception 'evento não registrado';
  end if;
  if v_ev.processed_at is not null then
    return jsonb_build_object('result', 'duplicate');
  end if;

  v_detail := jsonb_build_object('event', v_event, 'asaas_status', v_status, 'value_cents', v_value, 'external_reference', v_ref);

  -- 1) localizar a cobrança (sem travar ainda)
  select * into v_charge from public.asaas_charges where asaas_payment_id = v_pid;
  if not found then
    v_inv_id := public.billing_invoice_id_from_ref(v_ref);
    if v_inv_id is null then
      perform public.billing_record_anomaly('unexpected_payment', v_detail || '{"why":"external_reference_not_ours"}', null, null, null, v_pid, p_event_id);
      perform public.billing_event_finish(p_event_id, 'anomaly', 'unexpected_payment');
      return jsonb_build_object('result', 'anomaly', 'kind', 'unexpected_payment');
    end if;
    select * into v_inv from public.invoices where id = v_inv_id;
    if not found then
      perform public.billing_record_anomaly('invoice_not_found', v_detail, null, null, null, v_pid, p_event_id);
      perform public.billing_event_finish(p_event_id, 'anomaly', 'invoice_not_found');
      return jsonb_build_object('result', 'anomaly', 'kind', 'invoice_not_found');
    end if;
    select * into v_charge from public.asaas_charges where invoice_id = v_inv_id and status not in ('deleted', 'refunded');
    if not found then
      perform public.billing_record_anomaly('unexpected_payment', v_detail || '{"why":"no_active_charge_for_invoice"}',
        v_inv.company_id, v_inv.id, null, v_pid, p_event_id);
      perform public.billing_event_finish(p_event_id, 'anomaly', 'unexpected_payment');
      return jsonb_build_object('result', 'anomaly', 'kind', 'unexpected_payment');
    end if;
    if v_charge.asaas_payment_id is not null and v_charge.asaas_payment_id <> v_pid then
      -- a fatura já tem OUTRA cobrança Asaas: este pagamento é uma duplicata/órfã
      perform public.billing_record_anomaly('duplicate_payment', v_detail || jsonb_build_object('charge_payment_id', v_charge.asaas_payment_id),
        v_inv.company_id, v_inv.id, v_charge.id, v_pid, p_event_id);
      perform public.billing_event_finish(p_event_id, 'anomaly', 'duplicate_payment');
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
    perform public.billing_record_anomaly('company_mismatch', v_detail, v_charge.company_id, v_inv.id, v_charge.id, v_pid, p_event_id);
    perform public.billing_event_finish(p_event_id, 'anomaly', 'company_mismatch');
    return jsonb_build_object('result', 'anomaly', 'kind', 'company_mismatch');
  end if;
  if v_ref is distinct from v_charge.external_reference then
    if v_charge.status in ('creating', 'pending', 'overdue', 'failed') then
      update public.asaas_charges set status = 'anomaly' where id = v_charge.id;
    end if;
    perform public.billing_record_anomaly('reference_mismatch', v_detail, v_charge.company_id, v_inv.id, v_charge.id, v_pid, p_event_id);
    perform public.billing_event_finish(p_event_id, 'anomaly', 'reference_mismatch');
    return jsonb_build_object('result', 'anomaly', 'kind', 'reference_mismatch');
  end if;
  if v_value is distinct from v_charge.amount_cents then
    if v_charge.status in ('creating', 'pending', 'overdue', 'failed') then
      update public.asaas_charges set status = 'anomaly' where id = v_charge.id;
    end if;
    perform public.billing_record_anomaly('value_mismatch', v_detail, v_charge.company_id, v_inv.id, v_charge.id, v_pid, p_event_id);
    perform public.billing_event_finish(p_event_id, 'anomaly', 'value_mismatch');
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
    perform public.billing_record_anomaly('payment_restored', v_detail, v_charge.company_id, v_inv.id, v_charge.id, v_pid, p_event_id);
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
      perform public.billing_record_anomaly('paid_void_invoice', v_detail, v_charge.company_id, v_inv.id, v_charge.id, v_pid, p_event_id);
      v_result := 'paid_void_invoice'; v_ev_status := 'anomaly';
    elsif v_inv.status = 'paid' then
      -- fatura já quitada por OUTRO caminho (baixa manual/outra cobrança): dinheiro em duplicidade, nada avança
      if v_charge.status in ('creating', 'pending', 'overdue', 'failed') then
        update public.asaas_charges set status = 'anomaly' where id = v_charge.id;
      end if;
      perform public.billing_record_anomaly('duplicate_payment', v_detail, v_charge.company_id, v_inv.id, v_charge.id, v_pid, p_event_id);
      v_result := 'duplicate_payment'; v_ev_status := 'anomaly';
    else
      -- marca a cobrança ANTES da baixa (o trigger de cancelamento da fatura não a enxerga como aberta)
      -- cobrança já encerrada (excluída/estornada) que recebeu mesmo assim: o dinheiro chegou, a fatura quita.
      -- Só reativa a linha se NÃO houver outra cobrança ativa (índice único); se houver, ela é cancelada pelo
      -- trigger da baixa e esta linha fica como está.
      if v_charge.status not in ('deleted', 'refunded')
         or not exists (select 1 from public.asaas_charges o
                         where o.invoice_id = v_charge.invoice_id and o.id <> v_charge.id
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
    perform public.billing_record_anomaly('refund', v_detail, v_charge.company_id, v_inv.id, v_charge.id, v_pid, p_event_id);
    v_result := 'refund_recorded'; v_ev_status := 'anomaly';

  elsif v_status in ('CHARGEBACK_REQUESTED', 'CHARGEBACK_DISPUTE', 'AWAITING_CHARGEBACK_REVERSAL')
        or v_event in ('PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_CHARGEBACK_DISPUTE', 'PAYMENT_AWAITING_CHARGEBACK_REVERSAL') then
    if v_charge.status in ('creating', 'pending', 'overdue', 'failed') then
      update public.asaas_charges set status = 'anomaly' where id = v_charge.id;
    end if;
    perform public.billing_record_anomaly('chargeback', v_detail, v_charge.company_id, v_inv.id, v_charge.id, v_pid, p_event_id);
    v_result := 'chargeback_recorded'; v_ev_status := 'anomaly';

  elsif v_status in ('DUNNING_REQUESTED', 'DUNNING_RECEIVED') or v_event in ('PAYMENT_DUNNING_REQUESTED', 'PAYMENT_DUNNING_RECEIVED') then
    perform public.billing_record_anomaly('dunning', v_detail, v_charge.company_id, v_inv.id, v_charge.id, v_pid, p_event_id);
    v_result := 'dunning_recorded'; v_ev_status := 'anomaly';

  else
    -- PAYMENT_CREATED / PAYMENT_UPDATED / demais: só atualiza dados de exibição
    if v_charge.status in ('pending', 'overdue') then
      update public.asaas_charges set invoice_url = coalesce(nullif(p_payment ->> 'invoice_url', ''), invoice_url) where id = v_charge.id;
    end if;
    v_result := 'noted'; v_ev_status := 'ignored';
  end if;

  perform public.billing_event_finish(p_event_id, v_ev_status, v_result);
  return jsonb_build_object('result', v_result, 'charge_id', v_charge.id, 'invoice_id', v_inv.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 11) Outbox: enfileirar (trigger, sem HTTP), reivindicar, concluir, despachar
-- ---------------------------------------------------------------------------
create function public.billing_enqueue_job(p_invoice_id uuid, p_kind text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.billing_jobs (invoice_id, kind) values (p_invoice_id, p_kind)
  on conflict (invoice_id, kind) where status in ('pending', 'running') do nothing;
$$;

create function public.invoices_enqueue_charge()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('open', 'overdue') and new.amount_cents > 0 then
    perform public.billing_enqueue_job(new.id, 'create_charge');
  end if;
  return new;
end;
$$;
create trigger invoices_enqueue_charge after insert on public.invoices
  for each row execute function public.invoices_enqueue_charge();

create function public.invoices_enqueue_cancel()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status in ('open', 'overdue') and new.status in ('paid', 'void')
     and exists (select 1 from public.asaas_charges c
                  where c.invoice_id = new.id and c.status in ('creating', 'pending', 'overdue', 'failed')) then
    perform public.billing_enqueue_job(new.id, 'cancel_charge');
  end if;
  return new;
end;
$$;
create trigger invoices_enqueue_cancel after update of status on public.invoices
  for each row when (old.status is distinct from new.status) execute function public.invoices_enqueue_cancel();

create function public.billing_claim_jobs(p_limit integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
begin
  with c as (
    select id from public.billing_jobs
     where (status = 'pending' and next_run_at <= now()) or (status = 'running' and locked_until < now())
     order by next_run_at, created_at
     limit greatest(1, least(coalesce(p_limit, 10), 50))
       for update skip locked
  ), u as (
    update public.billing_jobs j
       set status = 'running', attempts = j.attempts + 1, locked_until = now() + interval '5 minutes'
      from c where j.id = c.id
    returning j.id, j.invoice_id, j.kind, j.attempts
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'invoice_id', invoice_id, 'kind', kind, 'attempts', attempts)), '[]'::jsonb)
    into v_rows from u;
  return v_rows;
end;
$$;

-- p_outcome: 'done' | 'retry' (backoff exponencial, teto 1h) | 'failed' (definitivo)
create function public.billing_complete_job(p_job_id uuid, p_outcome text, p_error text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_j public.billing_jobs;
  v_inv public.invoices;
begin
  select * into v_j from public.billing_jobs where id = p_job_id for update;
  if not found then
    return jsonb_build_object('ok', false);
  end if;
  if p_outcome = 'retry' and v_j.attempts >= 8 then
    p_outcome := 'failed';
  end if;
  if p_outcome = 'done' then
    update public.billing_jobs set status = 'done', done_at = now(), locked_until = null, last_error = null where id = v_j.id;
  elsif p_outcome = 'retry' then
    update public.billing_jobs
       set status = 'pending', locked_until = null, last_error = left(p_error, 500),
           next_run_at = now() + least(interval '1 hour', interval '30 seconds' * power(2, v_j.attempts))
     where id = v_j.id;
  else
    update public.billing_jobs set status = 'failed', locked_until = null, last_error = left(p_error, 500) where id = v_j.id;
    select * into v_inv from public.invoices where id = v_j.invoice_id;
    perform public.billing_record_anomaly('charge_job_failed',
      jsonb_build_object('job_kind', v_j.kind, 'attempts', v_j.attempts, 'error', left(p_error, 300)),
      v_inv.company_id, v_inv.id, null, null, 'job:' || v_j.id::text);
  end if;
  return jsonb_build_object('ok', true, 'outcome', p_outcome);
end;
$$;

-- Reconciliação leve (cura webhook perdido): cobranças abertas sem conferência há 6h. Não é polling agressivo.
create function public.billing_claim_reconcile(p_limit integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
begin
  with c as (
    select id from public.asaas_charges
     where status in ('pending', 'overdue') and asaas_payment_id is not null
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

-- Cron -> Edge billing-worker (pg_net). Sem segredos no vault OU sem trabalho: não faz nada.
create function public.billing_dispatch_jobs()
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
                      where status in ('pending', 'overdue') and asaas_payment_id is not null
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

-- Agendamento (só onde pg_cron existe; no remoto já existe). A cada 5 min; a função não faz nada sem trabalho.
do $$
begin
  if to_regnamespace('cron') is not null then
    execute $q$select cron.unschedule(jobid) from cron.job where jobname = 'gap-billing-asaas-dispatch'$q$;
    execute $q$select cron.schedule('gap-billing-asaas-dispatch', '*/5 * * * *', $job$select public.billing_dispatch_jobs()$job$)$q$;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 12) ENFORCEMENT: estado comercial em tempo real + barreira de escrita
-- ---------------------------------------------------------------------------
-- Estados: active | grace | past_due | pending_payment | restricted | suspended   (assinatura vigente)
--          trial | trial_expired | trial_canceled | canceled                       (sem assinatura vigente)
--          unmanaged = nunca teve trial nem assinatura (legado/teste): liberado.
create function public.company_access_state(p_company_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_status text;
  v_trial text;
begin
  select s.status into v_status from public.subscriptions s
   where s.company_id = p_company_id and s.status <> 'canceled' limit 1;
  if found then
    return case v_status when 'trialing' then 'active' else v_status end;
  end if;

  select public.trial_effective_state(t.status, t.trial_ends_at) into v_trial
    from public.company_trials t where t.company_id = p_company_id;
  if v_trial = 'trialing' then
    return 'trial';
  end if;
  if exists (select 1 from public.subscriptions s where s.company_id = p_company_id) then
    return 'canceled';
  end if;
  if v_trial = 'expired' then return 'trial_expired'; end if;
  if v_trial = 'canceled' then return 'trial_canceled'; end if;
  return 'unmanaged';
end;
$$;

create function public.company_write_blocked(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.company_access_state(p_company_id) in
    ('pending_payment', 'restricted', 'suspended', 'trial_expired', 'trial_canceled', 'canceled');
$$;

create function public.guard_company_writable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid := case when tg_op = 'DELETE' then old.company_id else new.company_id end;
begin
  if public.company_write_blocked(v_company) then
    raise exception 'Empresa em modo somente leitura (%). Regularize a contratação/pagamento para voltar a registrar alterações.',
      public.company_access_state(v_company) using errcode = 'PT402';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'company_operational_settings', 'service_points', 'service_sessions', 'production_sectors', 'product_categories',
    'products', 'product_stock_movements', 'product_modifier_groups', 'product_modifier_options',
    'product_modifier_group_products', 'service_orders', 'service_order_items', 'service_order_item_modifiers',
    'service_order_item_cancellations', 'service_payments', 'service_refunds', 'cash_movements',
    'accounts_receivable', 'accounts_payable', 'customers']
  loop
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = v_table and column_name = 'company_id') then
      raise exception 'tabela % sem company_id: não pode receber a barreira de somente leitura', v_table;
    end if;
    execute format('create trigger guard_company_writable before insert or update or delete on public.%I
                    for each row execute function public.guard_company_writable()', v_table);
  end loop;
end
$$;

-- EXCEÇÃO ÚNICA: FECHAR um caixa que já estava aberto. Em somente leitura (restricted, pending_payment, suspended, trial
-- expirado, cancelada) o caixa aberto antes do bloqueio pode ser fechado — deixá-lo aberto indefinidamente seria pior —,
-- mas NADA além disso: não abre caixa, não apaga, não edita caixa fechado, não reabre e não troca outros campos.
-- A exceção é do BANCO (trigger), nunca só do frontend. Vendas, pagamentos, sangria e suprimento (outras tabelas)
-- seguem barrados pela barreira geral.
create function public.guard_cash_session_writable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid := case when tg_op = 'DELETE' then old.company_id else new.company_id end;
  c_closing constant text[] := array['status', 'closed_at', 'closed_by', 'closing_notes', 'closing_cash_amount', 'cash_difference'];
begin
  if not public.company_write_blocked(v_company) then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.status = 'open' and new.status = 'closed'
     and new.company_id = old.company_id
     and (to_jsonb(new) - c_closing) = (to_jsonb(old) - c_closing) then
    return new;
  end if;

  raise exception 'Empresa em modo somente leitura (%). Regularize a contratação/pagamento para voltar a registrar alterações.',
    public.company_access_state(v_company) using errcode = 'PT402';
end;
$$;
create trigger guard_company_writable before insert or update or delete on public.cash_sessions
  for each row execute function public.guard_cash_session_writable();

-- ---------------------------------------------------------------------------
-- 13) Contratação pelo OWNER (cópia da lógica de master_subscribe_company, SEM assert_master_admin)
--     A original NÃO é alterada (validada por testes de mutação); aqui o chamador é sempre tenant_subscribe.
-- ---------------------------------------------------------------------------
create function public.billing_subscribe_company(
  p_company_id uuid, p_plan_id uuid, p_extra_module_ids uuid[], p_via text
)
returns public.subscriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan public.plans;
  v_sub public.subscriptions;
  v_mod public.modules;
  v_trial public.company_trials;
  v_now timestamptz := public.business_now();
  v_start date := public.competence_of(public.business_now());
  v_day integer := extract(day from (public.business_now() at time zone 'America/Sao_Paulo'))::integer;
  v_ids uuid[];
  v_id uuid;
  v_initial jsonb;
  v_from_trial jsonb := null;
begin
  perform 1 from public.companies where id = p_company_id for no key update;
  if not found then
    raise exception 'empresa não encontrada';
  end if;

  select * into v_plan from public.plans where id = p_plan_id;
  if not found then
    raise exception 'plano não encontrado';
  end if;
  if not v_plan.is_active then
    raise exception 'plano inativo não pode ser contratado';
  end if;

  if exists (select 1 from public.subscriptions where company_id = p_company_id and status <> 'canceled') then
    raise exception 'a empresa já possui uma assinatura vigente';
  end if;

  v_ids := coalesce(array(select distinct unnest(coalesce(p_extra_module_ids, '{}'::uuid[]))), '{}'::uuid[]);
  foreach v_id in array v_ids loop
    select * into v_mod from public.modules where id = v_id;
    if not found then raise exception 'módulo inexistente na lista'; end if;
    if not v_mod.is_active then raise exception 'módulo inativo "%" não pode ser contratado', v_mod.name; end if;
    if exists (select 1 from public.plan_modules where plan_id = v_plan.id and module_id = v_id) then
      raise exception 'o módulo "%" já está incluído no plano', v_mod.name;
    end if;
  end loop;

  perform public.reconcile_company_trial(p_company_id);
  select * into v_trial from public.company_trials where company_id = p_company_id for update;
  if v_trial.id is not null and v_trial.status in ('trialing', 'expired') then
    v_from_trial := jsonb_build_object(
      'trial_id', v_trial.id,
      'trial_started_at', v_trial.trial_started_at,
      'trial_ends_at', v_trial.trial_ends_at,
      'converted_during_trial', v_trial.status = 'trialing');
  end if;

  insert into public.subscriptions (
    company_id, plan_id, plan_price_cents_snapshot, status, billing_day, started_at,
    current_period_start, current_period_end
  ) values (
    p_company_id, v_plan.id, v_plan.monthly_price_cents, 'pending_payment',
    v_day, v_now, v_start, (v_start + interval '1 month - 1 day')::date
  ) returning * into v_sub;

  insert into public.subscription_modules (subscription_id, module_id, source, plan_id, price_cents_snapshot)
  select v_sub.id, pm.module_id, 'plan', v_plan.id, 0
  from public.plan_modules pm where pm.plan_id = v_plan.id;

  foreach v_id in array v_ids loop
    select * into v_mod from public.modules where id = v_id;
    insert into public.subscription_modules (subscription_id, module_id, source, price_cents_snapshot)
    values (v_sub.id, v_id, 'extra', v_mod.monthly_price_cents);
    perform public.record_subscription_event(v_sub.id, 'module_added', jsonb_build_object(
      'module_id', v_id, 'module_code', v_mod.code, 'price_cents', v_mod.monthly_price_cents));
  end loop;

  perform public.record_subscription_event(v_sub.id, 'subscribed', jsonb_build_object(
    'plan_id', v_plan.id, 'plan_code', v_plan.code,
    'plan_price_cents', v_plan.monthly_price_cents,
    'billing_day', v_day, 'status', v_sub.status, 'via', p_via,
    'included_modules', coalesce((
      select jsonb_agg(jsonb_build_object('module_id', m.id, 'code', m.code) order by m.code)
      from public.subscription_modules sm join public.modules m on m.id = sm.module_id
      where sm.subscription_id = v_sub.id and sm.source = 'plan'
    ), '[]'::jsonb)
  ) || case when v_from_trial is null then '{}'::jsonb
            else jsonb_build_object('from_trial', v_from_trial) end);

  v_initial := public.generate_initial_invoice(v_sub.id);

  if v_from_trial is not null then
    update public.company_trials
    set status = 'converted',
        converted_at = v_now,
        converted_subscription_id = v_sub.id,
        converted_by = auth.uid(),
        converted_via = p_via
    where id = v_trial.id;

    perform public.record_company_trial_event(v_trial.id, 'converted', jsonb_build_object(
      'flow', p_via,
      'converted_during_trial', v_trial.status = 'trialing',
      'trial_started_at', v_trial.trial_started_at,
      'trial_ends_at', v_trial.trial_ends_at,
      'converted_at', v_now,
      'subscription_id', v_sub.id,
      'plan_id', v_plan.id, 'plan_code', v_plan.code,
      'plan_price_cents', v_plan.monthly_price_cents,
      'billing_day', v_day,
      'initial_invoice_id', v_initial ->> 'invoice_id',
      'actor_id', auth.uid()));
  end if;

  select * into v_sub from public.subscriptions where id = v_sub.id;
  return v_sub;
end;
$$;

-- ---------------------------------------------------------------------------
-- 14) RPCs do OWNER (tenant). Nada financeiro vem do frontend; ids Asaas nunca saem daqui.
-- ---------------------------------------------------------------------------
create function public.billing_assert_owner(p_company_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Faça login para continuar.' using errcode = 'PT401';
  end if;
  if p_company_id is null or public.user_role_in_company(p_company_id) is distinct from 'owner' then
    raise exception 'Apenas o proprietário da empresa pode acessar a contratação e a cobrança.' using errcode = 'PT403';
  end if;
end;
$$;

-- Leitura comercial (plano, módulos, estado, faturas): owner e ADMIN. Contratar, alterar, cotar e pagar seguem só do owner.
create function public.billing_assert_owner_or_admin(p_company_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Faça login para continuar.' using errcode = 'PT401';
  end if;
  if p_company_id is null or coalesce(public.user_role_in_company(p_company_id)::text, '') not in ('owner', 'admin') then
    raise exception 'Apenas o proprietário ou o administrador da empresa podem consultar o plano e as faturas.' using errcode = 'PT403';
  end if;
end;
$$;

-- Qualquer membro ATIVO lê só o estado de acesso (para o aviso de somente leitura); sem valores.
create function public.tenant_get_access_state(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_state text;
  v_trial_ends timestamptz;
  v_grace_until date;
  v_restriction_from date;
begin
  if auth.uid() is null then
    raise exception 'Faça login para continuar.' using errcode = 'PT401';
  end if;
  if p_company_id is null or not exists (select 1 from public.user_company_ids() u where u = p_company_id) then
    raise exception 'Empresa não encontrada.' using errcode = 'PT403';
  end if;
  v_state := public.company_access_state(p_company_id);

  -- só datas para o aviso (nunca valores): fim do trial, fim da carência e início da restrição
  select t.trial_ends_at into v_trial_ends from public.company_trials t
   where t.company_id = p_company_id and v_state = 'trial';
  select d.grace_until, d.restriction_from into v_grace_until, v_restriction_from
    from public.subscriptions s cross join lateral public.billing_debt_of(s.id) d
   where s.company_id = p_company_id and s.status <> 'canceled' and d.state in ('grace', 'restricted');

  return jsonb_build_object('state', v_state, 'write_blocked', public.company_write_blocked(p_company_id),
    'is_owner', public.user_role_in_company(p_company_id) = 'owner',
    'trial_ends_at', v_trial_ends, 'grace_until', v_grace_until, 'restriction_from', v_restriction_from);
end;
$$;

create function public.tenant_get_catalog(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.billing_assert_owner_or_admin(p_company_id);
  return jsonb_build_object(
    'plans', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'code', p.code, 'name', p.name, 'description', p.description,
        'monthly_price_cents', p.monthly_price_cents,
        'included_module_codes', coalesce((select jsonb_agg(m.code order by m.code)
            from public.plan_modules pm join public.modules m on m.id = pm.module_id where pm.plan_id = p.id), '[]'::jsonb))
        order by p.monthly_price_cents, p.code)
      from public.plans p where p.is_active and p.code <> public.trial_reserved_plan_code()), '[]'::jsonb),
    'modules', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'code', m.code, 'name', m.name, 'description', m.description,
        'monthly_price_cents', m.monthly_price_cents) order by m.code)
      from public.modules m where m.is_active), '[]'::jsonb));
end;
$$;

create function public.tenant_subscribe(p_company_id uuid, p_plan_id uuid, p_extra_module_ids uuid[] default '{}'::uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_snap jsonb;
  v_sub public.subscriptions;
  v_inv public.invoices;
begin
  perform public.billing_assert_owner(p_company_id);

  -- falha cedo: sem CPF/CNPJ válido (companies.document) não há cobrança possível; nada é criado
  v_snap := public.billing_profile_snapshot(p_company_id);
  if v_snap ->> 'problem' = 'document_required' then
    raise exception 'Cadastre o CNPJ/CPF da empresa nas configurações antes de contratar.' using errcode = 'PT400';
  elsif v_snap ->> 'problem' = 'document_invalid' then
    raise exception 'O CNPJ/CPF cadastrado é inválido. Corrija nas configurações antes de contratar.' using errcode = 'PT400';
  elsif v_snap ->> 'problem' is not null then
    raise exception 'Complete os dados de contato da empresa antes de contratar.' using errcode = 'PT400';
  end if;

  begin
    v_sub := public.billing_subscribe_company(p_company_id, p_plan_id, p_extra_module_ids, 'tenant_subscribe');
  exception when others then
    if sqlerrm like 'a empresa já possui uma assinatura vigente' then
      raise exception 'Esta empresa já possui uma assinatura vigente.' using errcode = 'PT409';
    end if;
    raise;
  end;

  select * into v_inv from public.invoices where subscription_id = v_sub.id and kind = 'initial';
  return jsonb_build_object('subscription_id', v_sub.id, 'status', v_sub.status,
    'invoice_id', v_inv.id, 'amount_cents', v_inv.amount_cents, 'due_date', v_inv.due_date);
end;
$$;

-- Cotação: o SERVIDOR recalcula o total (preços do catálogo) para qualquer seleção. O frontend só exibe. Não grava nada.
create function public.tenant_quote_subscription(p_company_id uuid, p_plan_id uuid, p_extra_module_ids uuid[] default '{}'::uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_plan public.plans;
  v_ids uuid[] := coalesce(array(select distinct unnest(coalesce(p_extra_module_ids, '{}'::uuid[]))), '{}'::uuid[]);
  v_mod public.modules;
  v_id uuid;
  v_items jsonb;
  v_total bigint;
begin
  perform public.billing_assert_owner(p_company_id);
  select * into v_plan from public.plans where id = p_plan_id and is_active and code <> public.trial_reserved_plan_code();
  if not found then
    raise exception 'Plano não encontrado.' using errcode = 'PT404';
  end if;
  foreach v_id in array v_ids loop
    select * into v_mod from public.modules where id = v_id and is_active;
    if not found then
      raise exception 'Módulo indisponível.' using errcode = 'PT400';
    end if;
    if exists (select 1 from public.plan_modules pm where pm.plan_id = v_plan.id and pm.module_id = v_id) then
      raise exception 'O módulo "%" já está incluído no plano.', v_mod.name using errcode = 'PT400';
    end if;
  end loop;

  select jsonb_agg(x.item order by x.ord, x.name), v_plan.monthly_price_cents + coalesce(sum(x.cents), 0)
    into v_items, v_total
    from (select 1 as ord, m.name, m.monthly_price_cents as cents,
                 jsonb_build_object('kind', 'module', 'id', m.id, 'name', m.name, 'monthly_price_cents', m.monthly_price_cents) as item
            from public.modules m where m.id = any(v_ids)) x;
  return jsonb_build_object(
    'monthly_cents', coalesce(v_total, v_plan.monthly_price_cents),
    'plan', jsonb_build_object('id', v_plan.id, 'name', v_plan.name, 'monthly_price_cents', v_plan.monthly_price_cents),
    'modules', coalesce(v_items, '[]'::jsonb));
end;
$$;

create function public.tenant_get_billing_state(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sub public.subscriptions;
  v_plan public.plans;
  v_debt record;
  v_state text;
begin
  perform public.billing_assert_owner_or_admin(p_company_id);
  v_state := public.company_access_state(p_company_id);

  select * into v_sub from public.subscriptions where company_id = p_company_id and status <> 'canceled';
  if found then
    select * into v_plan from public.plans where id = v_sub.plan_id;
    select * into v_debt from public.billing_debt_of(v_sub.id);
  end if;

  return jsonb_build_object(
    'access_state', v_state,
    'write_blocked', public.company_write_blocked(p_company_id),
    'trial', (select jsonb_build_object('state', t.state, 'trial_ends_at', t.trial_ends_at, 'trial_days', t.trial_days)
                from public.company_trial_state(p_company_id) t),
    'subscription', case when v_sub.id is null then null else jsonb_build_object(
      'status', v_sub.status, 'plan_id', v_plan.id, 'plan_name', v_plan.name, 'plan_code', v_plan.code,
      'billing_day', v_sub.billing_day, 'grace_until', v_sub.grace_until,
      'monthly_cents', v_sub.plan_price_cents_snapshot + coalesce((select sum(sm.price_cents_snapshot)
          from public.subscription_modules sm where sm.subscription_id = v_sub.id and sm.removed_at is null), 0),
      'modules', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'code', m.code, 'name', m.name, 'monthly_price_cents', m.monthly_price_cents, 'source', sm.source) order by m.code)
          from public.subscription_modules sm join public.modules m on m.id = sm.module_id
         where sm.subscription_id = v_sub.id and sm.removed_at is null), '[]'::jsonb),
      'next_due_date', (select min(i.due_date) from public.invoices i
                         where i.subscription_id = v_sub.id and i.status in ('open', 'overdue'))) end,
    'debt', case when v_sub.id is null then null else jsonb_build_object(
      'state', v_debt.state, 'due_date', v_debt.due_date, 'days_overdue', v_debt.days_overdue,
      'grace_until', v_debt.grace_until, 'restriction_from', v_debt.restriction_from) end,
    'pending_change', case when v_sub.id is null then null else public.billing_pending_change_json(v_sub.id) end,
    'open_invoices', (select count(*) from public.invoices i
                       where i.company_id = p_company_id and i.status in ('open', 'overdue')));
end;
$$;

create function public.tenant_list_invoices(p_company_id uuid)
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
                          where c.invoice_id = i.id and c.status not in ('deleted', 'refunded')),
      'pix_ready', exists (select 1 from public.asaas_charges c
                            where c.invoice_id = i.id and c.status in ('pending', 'overdue') and c.pix_payload is not null))
      order by i.due_date desc, i.created_at desc)
    from public.invoices i where i.company_id = p_company_id), '[]'::jsonb);
end;
$$;

create function public.tenant_get_invoice_payment(p_invoice_id uuid)
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

  select * into v_ch from public.asaas_charges where invoice_id = v_inv.id and status not in ('deleted', 'refunded');
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

-- Autorização da Edge billing-charge (chamada com o JWT do usuário): owner + fatura da empresa + elegível.
create function public.tenant_prepare_invoice_charge(p_invoice_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_inv public.invoices;
begin
  select * into v_inv from public.invoices where id = p_invoice_id;
  if not found then
    raise exception 'Fatura não encontrada.' using errcode = 'PT404';
  end if;
  perform public.billing_assert_owner(v_inv.company_id);
  if v_inv.status not in ('open', 'overdue') then
    raise exception 'Esta fatura não está em aberto.' using errcode = 'PT409';
  end if;
  return jsonb_build_object('invoice_id', v_inv.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 14b) EMPRESA NOVA entra em período grátis (7 dias): nunca nasce "unmanaged".
--      Empresas ANTIGAS (sem trial/assinatura) NÃO são tocadas: seguem unmanaged (compatibilidade).
--      O gancho é create_company (o fluxo normal do onboarding); inserções diretas em companies (SQL/testes) continuam
--      sem registro comercial de propósito.
-- ---------------------------------------------------------------------------
create function public.billing_start_trial_internal(p_company_id uuid, p_flow text)
returns public.company_trials
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := public.business_now();
  v_trial public.company_trials;
begin
  insert into public.company_trials (company_id, trial_started_at, trial_days, started_by)
  values (p_company_id, v_now, public.trial_duration_days(), auth.uid())
  returning * into v_trial;

  perform public.record_company_trial_event(v_trial.id, 'started', jsonb_build_object(
    'flow', p_flow,
    'trial_started_at', v_trial.trial_started_at,
    'trial_ends_at', v_trial.trial_ends_at,
    'trial_days', v_trial.trial_days,
    'business_date', (v_now at time zone 'America/Sao_Paulo')::date,
    'actor_id', auth.uid()));
  return v_trial;
end;
$$;

-- Mesmo corpo e mesmas mensagens de 20260925030000; a ÚNICA diferença é iniciar o período grátis da empresa criada.
-- (create or replace preserva o ACL: revogado de PUBLIC/anon e liberado só a authenticated.)
create or replace function public.create_company(
  p_name text,
  p_slug text,
  p_access_code text,
  p_document text default null
)
returns public.companies
language plpgsql
security definer
set search_path = public
as $$
declare
  c_invalid_code constant text :=
    'Código da empresa inválido. Use de 3 a 32 caracteres, apenas letras minúsculas, números e hífen simples entre os termos.';
  c_code_in_use constant text := 'Este código de empresa já está em uso.';
  v_company public.companies;
  v_access_code text;
  v_constraint text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  v_access_code := lower(btrim(p_access_code));
  if v_access_code is null then
    raise exception '%', c_invalid_code;
  end if;

  begin
    insert into public.companies (name, slug, access_code, document)
    values (p_name, p_slug, v_access_code, p_document)
    returning * into v_company;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'companies_access_code_key' then
        raise exception '%', c_code_in_use;
      end if;
      raise;
    when check_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'companies_access_code_format' then
        raise exception '%', c_invalid_code;
      end if;
      raise;
  end;

  insert into public.company_users (company_id, user_id, role)
  values (v_company.id, auth.uid(), 'owner');

  perform public.billing_start_trial_internal(v_company.id, 'create_company');

  return v_company;
end;
$$;

-- ---------------------------------------------------------------------------
-- 14c) ALTERAÇÃO DE MÓDULOS PELO OWNER (agendada, sem pró-rata)
--
-- REGRA COMERCIAL: o owner altera só os módulos EXTRAS (o Plano Base é obrigatório e não muda). A alteração NÃO mexe na
-- mensalidade nem nos módulos do ciclo vigente: entra em vigor no PRÓXIMO CICLO — a data de vencimento da próxima
-- competência ainda não faturada (mesma âncora billing_day, mesmo clamp 29/30/31 de invoice_due_date, mesma regra
-- change_effective_competence das demais alterações contratuais; nada de cálculo paralelo). Vale para adicionar e remover.
--
-- SEPARAÇÃO "próxima fatura" x "entitlement":
--   A) a próxima fatura recorrente já conhece a nova composição (subscription_extras_at consulta a alteração AGENDADA para
--      as competências >= effective_competence), então a fatura emitida 10 dias antes já sai com o valor certo;
--   B) os módulos efetivamente ATIVOS (subscription_modules) só mudam em effective_at, aplicados pelo ciclo diário
--      (run_billing_cycle -> billing_apply_module_change). Pagamento não condiciona a efetivação (grace/restricted valem
--      normalmente depois, pela fatura; não há regra especial para módulos).
--
-- FATURA JÁ EMITIDA: se a fatura do próximo ciclo já existe, a alteração passa para o ciclo SEGUINTE (a fatura/cobrança
-- emitida nunca é editada). Uma alteração agendada cuja fatura já foi emitida fica TRAVADA: não pode ser substituída nem
-- cancelada (a fatura emitida já a contém); o owner agenda outra depois que ela entrar em vigor.
-- UMA alteração agendada por assinatura (índice único parcial). Substituir marca a anterior como 'replaced'.
-- Só assinaturas active/grace/past_due: não em pending_payment (pagar a inicial antes), restricted (regularize antes),
-- suspended nem cancelada. Asaas: nada aqui o chama; a cobrança da fatura futura nasce pelo outbox com o valor novo.
-- ---------------------------------------------------------------------------
alter table public.subscription_events drop constraint subscription_events_event_type_check;
alter table public.subscription_events add constraint subscription_events_event_type_check
  check (event_type in (
    'subscribed', 'plan_changed', 'module_added', 'module_removed', 'status_changed', 'billing_day_changed',
    'modules_change_scheduled', 'modules_change_updated', 'modules_change_canceled', 'modules_change_applied'));

create table public.subscription_pending_changes (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null,
  company_id uuid not null,
  kind text not null default 'modules' check (kind = 'modules'),
  status text not null default 'scheduled' check (status in ('scheduled', 'applied', 'canceled', 'replaced')),
  -- competência (dia 1) da primeira fatura com a nova composição e a data (vencimento dessa competência) em que ela entra em vigor
  effective_competence date not null check (extract(day from effective_competence) = 1),
  effective_at date not null,
  -- snapshots calculados NO SERVIDOR: [{ "module_id", "code", "name", "price_cents" }] (só extras)
  previous_modules jsonb not null,
  new_modules jsonb not null,
  previous_monthly_cents integer not null check (previous_monthly_cents >= 0),
  new_monthly_cents integer not null check (new_monthly_cents >= 0),
  requested_by uuid,
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscription_pending_changes_sub_company_fk foreign key (subscription_id, company_id)
    references public.subscriptions (id, company_id) on delete restrict,
  constraint subscription_pending_changes_decided_check check ((status = 'scheduled') = (decided_at is null))
);
create unique index subscription_pending_changes_one_scheduled
  on public.subscription_pending_changes (subscription_id) where status = 'scheduled';
create index subscription_pending_changes_due_idx
  on public.subscription_pending_changes (effective_at) where status = 'scheduled';
create trigger subscription_pending_changes_set_updated_at
  before update on public.subscription_pending_changes
  for each row execute function public.set_updated_at();
alter table public.subscription_pending_changes enable row level security;
revoke all on public.subscription_pending_changes from public, anon, authenticated;
grant select, insert, update, delete on public.subscription_pending_changes to service_role;

-- A) a próxima fatura conhece a composição agendada: extras vigentes em p_competence = os da alteração AGENDADA quando
-- p_competence >= effective_competence; senão, os de subscription_modules (como antes).
create or replace function public.subscription_extras_at(p_subscription_id uuid, p_competence date)
returns table (module_id uuid, module_name text, price_cents integer)
language sql
stable
set search_path = public
as $$
  with pend as (
    select pc.new_modules
      from public.subscription_pending_changes pc
     where pc.subscription_id = p_subscription_id and pc.status = 'scheduled'
       and pc.effective_competence <= p_competence
  )
  select (m ->> 'module_id')::uuid, m ->> 'name', (m ->> 'price_cents')::integer
    from pend, jsonb_array_elements(pend.new_modules) m
  union all
  select sm.module_id, sm.module_name_snapshot, sm.price_cents_snapshot
    from public.subscription_modules sm
   where not exists (select 1 from pend)
     and sm.subscription_id = p_subscription_id
     and sm.source = 'extra'
     and sm.effective_from_competence <= p_competence
     and (sm.effective_to_competence is null or p_competence < sm.effective_to_competence)
  order by 2, 1;
$$;

-- B) ao APLICAR a alteração, a vigência (competência) gravada nas linhas é a da própria alteração (via GUC local à
-- transação), não "último faturado + 1": a fatura dessa competência já pode ter sido emitida com a nova composição.
create or replace function public.set_subscription_module_effective()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_override date := nullif(current_setting('app.module_change_competence', true), '')::date;
begin
  if tg_op = 'INSERT' then
    new.module_name_snapshot := (select m.name from public.modules m where m.id = new.module_id);
    new.effective_from_competence :=
      coalesce(v_override, public.change_effective_competence(new.subscription_id, public.business_now()));
    new.effective_to_competence :=
      case when new.removed_at is not null then new.effective_from_competence end;
  else
    new.module_name_snapshot := old.module_name_snapshot;
    new.effective_from_competence := old.effective_from_competence;
    if old.removed_at is null and new.removed_at is not null then
      new.effective_to_competence := greatest(
        coalesce(v_override, public.change_effective_competence(new.subscription_id, public.business_now())),
        old.effective_from_competence);
    else
      new.effective_to_competence := old.effective_to_competence;
    end if;
  end if;
  return new;
end;
$$;

-- Plano da alteração (cálculo ÚNICO, compartilhado pela cotação e pelo agendamento; o frontend nunca envia preço/total/data).
create function public.billing_plan_module_change(p_company_id uuid, p_module_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sub public.subscriptions;
  v_ids uuid[] := coalesce(array(select distinct unnest(coalesce(p_module_ids, '{}'::uuid[]))), '{}'::uuid[]);
  v_id uuid;
  v_mod public.modules;
  v_cur_row record;
  v_cur jsonb := '[]'::jsonb;
  v_new jsonb := '[]'::jsonb;
  v_cur_ids uuid[] := '{}';
  v_prev_total integer;
  v_new_total integer;
  v_today date := public.business_date();
  v_month date := public.competence_of(public.business_now());
  v_natural date;
  v_comp date;
  v_c date;
  v_eff date;
  v_pend public.subscription_pending_changes;
  v_locked boolean := false;
  v_added jsonb;
  v_removed jsonb;
  i integer;
begin
  select * into v_sub from public.subscriptions where company_id = p_company_id and status <> 'canceled';
  if not found then
    raise exception 'Esta empresa não possui assinatura vigente para alterar módulos.' using errcode = 'PT409';
  end if;
  if v_sub.status = 'pending_payment' then
    raise exception 'Pague a cobrança inicial para ativar a assinatura antes de alterar os módulos.' using errcode = 'PT409';
  elsif v_sub.status = 'restricted' then
    raise exception 'Regularize a mensalidade em atraso antes de alterar os módulos.' using errcode = 'PT409';
  elsif v_sub.status = 'suspended' then
    raise exception 'A assinatura está suspensa e não aceita alteração de módulos. Fale com o suporte.' using errcode = 'PT409';
  elsif v_sub.status not in ('active', 'grace', 'past_due') then
    raise exception 'A assinatura não aceita alteração de módulos no estado atual.' using errcode = 'PT409';
  end if;

  -- módulos extras VIGENTES hoje (com o preço contratado, que não muda por reajuste de catálogo)
  for v_cur_row in
    select sm.module_id, m.code, sm.module_name_snapshot as name, sm.price_cents_snapshot as price_cents
      from public.subscription_modules sm join public.modules m on m.id = sm.module_id
     where sm.subscription_id = v_sub.id and sm.source = 'extra' and sm.removed_at is null
     order by sm.module_name_snapshot, sm.module_id
  loop
    v_cur := v_cur || jsonb_build_object('module_id', v_cur_row.module_id, 'code', v_cur_row.code, 'name', v_cur_row.name, 'price_cents', v_cur_row.price_cents);
    v_cur_ids := v_cur_ids || v_cur_row.module_id;
  end loop;

  foreach v_id in array v_ids loop
    select * into v_mod from public.modules where id = v_id and is_active;
    if not found then
      raise exception 'Módulo indisponível.' using errcode = 'PT400';
    end if;
    if exists (select 1 from public.plan_modules pm where pm.plan_id = v_sub.plan_id and pm.module_id = v_id) then
      raise exception 'O módulo "%" já está incluído no plano.', v_mod.name using errcode = 'PT400';
    end if;
  end loop;

  -- nova composição: quem já é contratado mantém o preço contratado; quem entra usa o preço do catálogo de hoje
  select coalesce(jsonb_agg(x.item order by x.name, x.id), '[]'::jsonb) into v_new
    from (select m.id, m.name,
                 jsonb_build_object('module_id', m.id, 'code', m.code, 'name', m.name,
                   'price_cents', coalesce((select (c ->> 'price_cents')::integer from jsonb_array_elements(v_cur) c
                                             where (c ->> 'module_id')::uuid = m.id), m.monthly_price_cents)) as item
            from public.modules m where m.id = any(v_ids)) x;

  select v_sub.plan_price_cents_snapshot + coalesce(sum((c ->> 'price_cents')::integer), 0) into v_prev_total from jsonb_array_elements(v_cur) c;
  select v_sub.plan_price_cents_snapshot + coalesce(sum((c ->> 'price_cents')::integer), 0) into v_new_total from jsonb_array_elements(v_new) c;

  -- PRÓXIMO CICLO: primeira competência cujo vencimento ainda não passou...
  v_c := v_month;
  for i in 0..2 loop
    v_natural := (v_month + make_interval(months => i))::date;
    exit when public.invoice_due_date(v_natural, (public.subscription_terms_at(v_sub.id, v_natural)).billing_day) > v_today;
  end loop;
  -- ...e que ainda NÃO foi faturada (mesma regra das demais alterações contratuais). Fatura já emitida => ciclo seguinte.
  v_comp := greatest(public.change_effective_competence(v_sub.id, public.business_now()), v_natural);
  v_eff := public.invoice_due_date(v_comp, (public.subscription_terms_at(v_sub.id, v_comp)).billing_day);

  select coalesce(jsonb_agg(n), '[]'::jsonb) into v_added from jsonb_array_elements(v_new) n
   where not ((n ->> 'module_id')::uuid = any(v_cur_ids));
  select coalesce(jsonb_agg(c), '[]'::jsonb) into v_removed from jsonb_array_elements(v_cur) c
   where not ((c ->> 'module_id')::uuid = any(v_ids));

  select * into v_pend from public.subscription_pending_changes where subscription_id = v_sub.id and status = 'scheduled';
  if found then
    v_locked := exists (select 1 from public.invoices i where i.subscription_id = v_sub.id and i.competence >= v_pend.effective_competence);
  end if;

  return jsonb_build_object(
    'subscription_id', v_sub.id,
    'plan', jsonb_build_object('name', (select p.name from public.plans p where p.id = v_sub.plan_id), 'monthly_price_cents', v_sub.plan_price_cents_snapshot),
    'current_modules', v_cur, 'new_modules', v_new, 'added', v_added, 'removed', v_removed,
    'identical', jsonb_array_length(v_added) = 0 and jsonb_array_length(v_removed) = 0,
    'previous_monthly_cents', v_prev_total, 'new_monthly_cents', v_new_total,
    'effective_competence', v_comp, 'effective_at', v_eff,
    -- a próxima mensalidade já foi emitida: a alteração vale a partir do ciclo seguinte
    'deferred_to_following_cycle', v_comp > v_natural,
    'pending_id', v_pend.id, 'pending_locked', v_locked,
    'pending_same', v_pend.id is not null and (
      select coalesce(array_agg((n ->> 'module_id')::uuid order by (n ->> 'module_id')::uuid), '{}') from jsonb_array_elements(v_pend.new_modules) n)
      = (select coalesce(array_agg(x order by x), '{}') from unnest(v_ids) x));
end;
$$;

-- JSON do que está agendado (owner/admin leem; sem ids de assinatura/empresa)
create function public.billing_pending_change_json(p_subscription_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_p public.subscription_pending_changes;
begin
  select * into v_p from public.subscription_pending_changes where subscription_id = p_subscription_id and status = 'scheduled';
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'id', v_p.id, 'effective_at', v_p.effective_at, 'effective_competence', v_p.effective_competence,
    'previous_monthly_cents', v_p.previous_monthly_cents, 'new_monthly_cents', v_p.new_monthly_cents,
    'new_modules', v_p.new_modules, 'previous_modules', v_p.previous_modules,
    'added', coalesce((select jsonb_agg(n) from jsonb_array_elements(v_p.new_modules) n
                        where not exists (select 1 from jsonb_array_elements(v_p.previous_modules) c where c ->> 'module_id' = n ->> 'module_id')), '[]'::jsonb),
    'removed', coalesce((select jsonb_agg(c) from jsonb_array_elements(v_p.previous_modules) c
                          where not exists (select 1 from jsonb_array_elements(v_p.new_modules) n where c ->> 'module_id' = n ->> 'module_id')), '[]'::jsonb),
    'requested_at', v_p.requested_at,
    'locked', exists (select 1 from public.invoices i where i.subscription_id = v_p.subscription_id and i.competence >= v_p.effective_competence));
end;
$$;

create function public.tenant_quote_module_change(p_company_id uuid, p_module_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.billing_assert_owner(p_company_id);
  return public.billing_plan_module_change(p_company_id, p_module_ids) - 'subscription_id';
end;
$$;

create function public.tenant_schedule_module_change(p_company_id uuid, p_module_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub_id uuid;
  v_plan jsonb;
  v_pend public.subscription_pending_changes;
  v_new public.subscription_pending_changes;
  v_replaced boolean := false;
begin
  perform public.billing_assert_owner(p_company_id);

  -- a assinatura é travada PRIMEIRO (mesma ordem de travas do motor): a geração de fatura e a aplicação esperam esta decisão
  select s.id into v_sub_id from public.subscriptions s where s.company_id = p_company_id and s.status <> 'canceled';
  if v_sub_id is null then
    raise exception 'Esta empresa não possui assinatura vigente para alterar módulos.' using errcode = 'PT409';
  end if;
  perform 1 from public.subscriptions where id = v_sub_id for update;

  v_plan := public.billing_plan_module_change(p_company_id, p_module_ids);

  select * into v_pend from public.subscription_pending_changes where subscription_id = v_sub_id and status = 'scheduled' for update;
  if found then
    -- mesma solicitação repetida (retry/duplo clique): devolve a alteração já agendada, sem novo evento
    if (v_plan ->> 'pending_same')::boolean then
      return jsonb_build_object('scheduled', true, 'idempotent', true, 'replaced', false,
        'effective_at', v_pend.effective_at, 'effective_competence', v_pend.effective_competence,
        'new_monthly_cents', v_pend.new_monthly_cents, 'previous_monthly_cents', v_pend.previous_monthly_cents,
        'deferred_to_following_cycle', false);
    end if;
    if (v_plan ->> 'pending_locked')::boolean then
      raise exception 'A mensalidade de %/% já foi gerada com a alteração agendada; ela não pode mais ser trocada. Depois que entrar em vigor, você poderá fazer outra alteração.',
        to_char(v_pend.effective_competence, 'MM'), to_char(v_pend.effective_competence, 'YYYY') using errcode = 'PT409';
    end if;
  end if;

  if (v_plan ->> 'identical')::boolean then
    if v_pend.id is not null then
      raise exception 'A composição escolhida é igual à atual. Para desfazer a alteração agendada, use "Cancelar alteração".' using errcode = 'PT409';
    end if;
    raise exception 'A composição escolhida é igual à atual: nada a alterar.' using errcode = 'PT409';
  end if;

  if v_pend.id is not null then
    update public.subscription_pending_changes
       set status = 'replaced', decided_at = now(), decided_by = auth.uid() where id = v_pend.id;
    v_replaced := true;
  end if;

  insert into public.subscription_pending_changes (
    subscription_id, company_id, effective_competence, effective_at, previous_modules, new_modules,
    previous_monthly_cents, new_monthly_cents, requested_by)
  values (v_sub_id, p_company_id, (v_plan ->> 'effective_competence')::date, (v_plan ->> 'effective_at')::date,
          v_plan -> 'current_modules', v_plan -> 'new_modules',
          (v_plan ->> 'previous_monthly_cents')::integer, (v_plan ->> 'new_monthly_cents')::integer, auth.uid())
  returning * into v_new;

  perform public.record_subscription_event(v_sub_id,
    case when v_replaced then 'modules_change_updated' else 'modules_change_scheduled' end,
    jsonb_build_object('pending_id', v_new.id, 'requested_by', auth.uid(), 'effective_at', v_new.effective_at,
      'previous', v_plan -> 'current_modules', 'new', v_plan -> 'new_modules',
      'previous_monthly_cents', v_new.previous_monthly_cents, 'new_monthly_cents', v_new.new_monthly_cents,
      'replaced_id', case when v_replaced then v_pend.id end));

  return jsonb_build_object('scheduled', true, 'idempotent', false, 'replaced', v_replaced,
    'effective_at', v_new.effective_at, 'effective_competence', v_new.effective_competence,
    'new_monthly_cents', v_new.new_monthly_cents, 'previous_monthly_cents', v_new.previous_monthly_cents,
    'deferred_to_following_cycle', (v_plan ->> 'deferred_to_following_cycle')::boolean,
    'added', v_plan -> 'added', 'removed', v_plan -> 'removed');
end;
$$;

create function public.tenant_cancel_module_change(p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub_id uuid;
  v_p public.subscription_pending_changes;
begin
  perform public.billing_assert_owner(p_company_id);
  select s.id into v_sub_id from public.subscriptions s where s.company_id = p_company_id and s.status <> 'canceled';
  if v_sub_id is null then
    return jsonb_build_object('ok', true, 'canceled', false);
  end if;
  perform 1 from public.subscriptions where id = v_sub_id for update;

  select * into v_p from public.subscription_pending_changes where subscription_id = v_sub_id and status = 'scheduled' for update;
  if not found then
    return jsonb_build_object('ok', true, 'canceled', false);
  end if;
  if exists (select 1 from public.invoices i where i.subscription_id = v_sub_id and i.competence >= v_p.effective_competence) then
    raise exception 'A mensalidade desta alteração já foi gerada; ela não pode mais ser cancelada.' using errcode = 'PT409';
  end if;

  update public.subscription_pending_changes set status = 'canceled', decided_at = now(), decided_by = auth.uid() where id = v_p.id;
  perform public.record_subscription_event(v_sub_id, 'modules_change_canceled',
    jsonb_build_object('pending_id', v_p.id, 'requested_by', auth.uid(), 'effective_at', v_p.effective_at,
      'previous', v_p.previous_modules, 'new', v_p.new_modules,
      'previous_monthly_cents', v_p.previous_monthly_cents, 'new_monthly_cents', v_p.new_monthly_cents));
  return jsonb_build_object('ok', true, 'canceled', true);
end;
$$;

-- B) entitlement: aplica a alteração vencida (ciclo diário). Idempotente (status 'applied'); não depende de pagamento.
create function public.billing_apply_module_change(p_subscription_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub public.subscriptions;
  v_p public.subscription_pending_changes;
  v_new_ids uuid[];
begin
  select * into v_sub from public.subscriptions where id = p_subscription_id for update;
  if not found then
    return false;
  end if;
  select * into v_p from public.subscription_pending_changes where subscription_id = p_subscription_id and status = 'scheduled' for update;
  if not found then
    return false;
  end if;

  if v_sub.status = 'canceled' then
    update public.subscription_pending_changes
       set status = 'canceled', decided_at = now(), note = 'subscription_canceled' where id = v_p.id;
    perform public.record_subscription_event(p_subscription_id, 'modules_change_canceled',
      jsonb_build_object('pending_id', v_p.id, 'reason', 'subscription_canceled', 'effective_at', v_p.effective_at));
    return true;
  end if;
  if public.business_date() < v_p.effective_at then
    return false;
  end if;

  select coalesce(array_agg((n ->> 'module_id')::uuid), '{}') into v_new_ids from jsonb_array_elements(v_p.new_modules) n;

  perform set_config('app.module_change_competence', v_p.effective_competence::text, true);
  update public.subscription_modules
     set removed_at = now()
   where subscription_id = p_subscription_id and source = 'extra' and removed_at is null
     and not (module_id = any(v_new_ids));
  insert into public.subscription_modules (subscription_id, module_id, source, price_cents_snapshot)
  select p_subscription_id, (n ->> 'module_id')::uuid, 'extra', (n ->> 'price_cents')::integer
    from jsonb_array_elements(v_p.new_modules) n
   where not exists (select 1 from public.subscription_modules sm
                      where sm.subscription_id = p_subscription_id and sm.module_id = (n ->> 'module_id')::uuid and sm.removed_at is null);
  perform set_config('app.module_change_competence', '', true);

  update public.subscription_pending_changes set status = 'applied', decided_at = now() where id = v_p.id;
  perform public.record_subscription_event(p_subscription_id, 'modules_change_applied',
    jsonb_build_object('pending_id', v_p.id, 'requested_by', v_p.requested_by, 'effective_at', v_p.effective_at,
      'previous', v_p.previous_modules, 'new', v_p.new_modules,
      'previous_monthly_cents', v_p.previous_monthly_cents, 'new_monthly_cents', v_p.new_monthly_cents));
  return true;
end;
$$;

-- Ciclo diário: idêntico ao de 20260924090000 + aplicação das alterações de módulos vencidas (antes de gerar/reconciliar).
create or replace function public.run_billing_cycle()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub record;
  v_generated integer := 0;
  v_overdue integer := 0;
  v_changes integer := 0;
  v_trials integer := 0;
  v_errors integer := 0;
  v_module_changes integer := 0;
  v_r jsonb;
begin
  for v_sub in select id from public.subscriptions order by created_at, id loop
    begin
      if public.billing_apply_module_change(v_sub.id) then
        v_module_changes := v_module_changes + 1;
      end if;
      v_generated := v_generated + public.auto_generate_subscription_invoices(v_sub.id);
      v_r := public.reconcile_subscription_billing_state(v_sub.id);
      v_overdue := v_overdue + coalesce((v_r ->> 'invoices_marked_overdue')::integer, 0);
      if v_r ->> 'status_from' is distinct from v_r ->> 'status_to' then
        v_changes := v_changes + 1;
      end if;
    exception when others then
      v_errors := v_errors + 1;
      raise warning 'run_billing_cycle: assinatura % falhou: %', v_sub.id, sqlerrm;
    end;
  end loop;

  begin
    v_trials := public.reconcile_expired_trials();
  exception when others then
    v_errors := v_errors + 1;
    raise warning 'run_billing_cycle: expiração de períodos grátis falhou: %', sqlerrm;
  end;

  return jsonb_build_object(
    'business_date', public.business_date(),
    'invoices_generated', v_generated,
    'invoices_marked_overdue', v_overdue,
    'status_changes', v_changes,
    'trials_expired', v_trials,
    'module_changes_applied', v_module_changes,
    'errors', v_errors);
end;
$$;

-- Master: visualiza a alteração pendente (valor atual x próximo, data de início). Sem edição nova: o Master já altera módulos
-- pelas RPCs master_* existentes.
create function public.master_get_pending_module_change(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sub public.subscriptions;
begin
  perform public.assert_master_admin();
  select * into v_sub from public.subscriptions where company_id = p_company_id and status <> 'canceled';
  if not found then
    return null;
  end if;
  return public.billing_pending_change_json(v_sub.id)
    || jsonb_build_object('current_monthly_cents', v_sub.plan_price_cents_snapshot + coalesce((
         select sum(sm.price_cents_snapshot) from public.subscription_modules sm
          where sm.subscription_id = v_sub.id and sm.removed_at is null), 0));
end;
$$;

-- ---------------------------------------------------------------------------
-- 15) Master: anomalias de cobrança (leitura e resolução) + estado comercial/gateway para as telas
--     Nenhum segredo, id Asaas, QR ou payload sai daqui.
-- ---------------------------------------------------------------------------
create function public.master_list_company_access_states()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_master_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object('company_id', c.id, 'access_state', public.company_access_state(c.id),
                                        'write_blocked', public.company_write_blocked(c.id)))
    from public.companies c), '[]'::jsonb);
end;
$$;

create function public.master_list_invoice_gateway(p_invoice_id uuid default null)
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
      'charge_status', c.status,
      'invoice_url', c.invoice_url,
      'gateway_due_date', c.gateway_due_date,
      'attempts', c.attempts,
      'last_error', left(c.last_error, 200),
      'open_anomalies', (select count(*) from public.billing_anomalies a where a.invoice_id = i.id and a.resolved_at is null))
      order by i.created_at desc)
    from public.invoices i
    left join public.asaas_charges c on c.invoice_id = i.id and c.status not in ('deleted', 'refunded')
    where p_invoice_id is null or i.id = p_invoice_id), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 15b) Master: lista de anomalias (leitura e resolução)
-- ---------------------------------------------------------------------------
create function public.master_list_billing_anomalies(p_only_open boolean default true)
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
      'id', a.id, 'kind', a.kind, 'company_id', a.company_id, 'company_name', c.name, 'invoice_id', a.invoice_id,
      'charge_id', a.charge_id, 'asaas_payment_id', a.asaas_payment_id, 'detail', a.detail,
      'created_at', a.created_at, 'resolved_at', a.resolved_at, 'resolution_note', a.resolution_note)
      order by a.created_at desc)
    from public.billing_anomalies a left join public.companies c on c.id = a.company_id
    where (not coalesce(p_only_open, true)) or a.resolved_at is null), '[]'::jsonb);
end;
$$;

create function public.master_resolve_billing_anomaly(p_anomaly_id uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_master_admin();
  if nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'Informe a observação da resolução.' using errcode = 'PT400';
  end if;
  update public.billing_anomalies
     set resolved_at = now(), resolved_by = auth.uid(), resolution_note = btrim(p_note)
   where id = p_anomaly_id and resolved_at is null;
  if not found then
    raise exception 'Anomalia não encontrada ou já resolvida.' using errcode = 'PT404';
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 16) ACL explícita (pior caso de default privileges: só os revoke/grant daqui valem)
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  -- somente as funções DESTA migration (as helpers billing_* de 20260924090000 mantêm o ACL que já tinham)
  for r in
    select p.oid::regprocedure::text as sig
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in (
         'billing_asaas_external_ref', 'billing_customer_external_ref', 'billing_invoice_id_from_ref',
         'billing_profile_snapshot', 'billing_claim_customer', 'billing_set_customer', 'billing_release_customer',
         'billing_charge_public', 'billing_claim_charge', 'billing_charge_record_payment', 'billing_charge_record_pix',
         'billing_charge_fail', 'billing_claim_cancel', 'billing_charge_mark_deleted', 'billing_settle_invoice_gateway',
         'billing_record_anomaly', 'billing_event_begin', 'billing_event_finish', 'billing_event_apply',
         'billing_enqueue_job', 'billing_claim_jobs', 'billing_complete_job', 'billing_claim_reconcile',
         'billing_dispatch_jobs', 'billing_subscribe_company', 'billing_assert_owner', 'billing_assert_owner_or_admin',
         'tenant_quote_subscription', 'billing_plan_module_change', 'billing_pending_change_json', 'billing_apply_module_change',
         'tenant_quote_module_change', 'tenant_schedule_module_change', 'tenant_cancel_module_change', 'master_get_pending_module_change',
         'company_access_state', 'company_write_blocked', 'guard_company_writable',
         'invoices_enqueue_charge', 'invoices_enqueue_cancel',
         'tenant_get_access_state', 'tenant_get_catalog', 'tenant_subscribe', 'tenant_get_billing_state',
         'tenant_list_invoices', 'tenant_get_invoice_payment', 'tenant_prepare_invoice_charge',
         'billing_start_trial_internal', 'guard_cash_session_writable',
         'master_list_billing_anomalies', 'master_resolve_billing_anomaly',
         'master_list_company_access_states', 'master_list_invoice_gateway')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated, service_role', r.sig);
  end loop;
end
$$;

-- service_role (Edge/cron): somente o que a Edge chama
grant execute on function public.billing_claim_customer(uuid) to service_role;
grant execute on function public.billing_set_customer(uuid, uuid, text) to service_role;
grant execute on function public.billing_release_customer(uuid, uuid) to service_role;
grant execute on function public.billing_claim_charge(uuid) to service_role;
grant execute on function public.billing_charge_record_payment(uuid, uuid, text, text, text) to service_role;
grant execute on function public.billing_charge_record_pix(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.billing_charge_fail(uuid, uuid, text) to service_role;
grant execute on function public.billing_claim_cancel(uuid) to service_role;
grant execute on function public.billing_charge_mark_deleted(uuid, text) to service_role;
grant execute on function public.billing_event_begin(text, text, text, jsonb) to service_role;
grant execute on function public.billing_event_finish(text, text, text, text) to service_role;
grant execute on function public.billing_event_apply(text, text, jsonb) to service_role;
grant execute on function public.billing_record_anomaly(text, jsonb, uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.billing_claim_jobs(integer) to service_role;
grant execute on function public.billing_complete_job(uuid, text, text) to service_role;
grant execute on function public.billing_claim_reconcile(integer) to service_role;
grant execute on function public.billing_settle_invoice_gateway(uuid, timestamptz, jsonb) to service_role;
grant execute on function public.billing_asaas_external_ref(uuid) to service_role;
grant execute on function public.billing_customer_external_ref(uuid) to service_role;
grant execute on function public.billing_invoice_id_from_ref(text) to service_role;
-- billing_dispatch_jobs: só o dono (pg_cron); helpers/triggers/enforcement: fechados a todos os papéis.

-- authenticated (OWNER ou membro, conforme a RPC; cada uma reautentica por dentro)
grant execute on function public.tenant_get_access_state(uuid) to authenticated;
grant execute on function public.tenant_get_catalog(uuid) to authenticated;
grant execute on function public.tenant_quote_subscription(uuid, uuid, uuid[]) to authenticated;
grant execute on function public.tenant_quote_module_change(uuid, uuid[]) to authenticated;
grant execute on function public.tenant_schedule_module_change(uuid, uuid[]) to authenticated;
grant execute on function public.tenant_cancel_module_change(uuid) to authenticated;
grant execute on function public.master_get_pending_module_change(uuid) to authenticated;
grant execute on function public.tenant_subscribe(uuid, uuid, uuid[]) to authenticated;
grant execute on function public.tenant_get_billing_state(uuid) to authenticated;
grant execute on function public.tenant_list_invoices(uuid) to authenticated;
grant execute on function public.tenant_get_invoice_payment(uuid) to authenticated;
grant execute on function public.tenant_prepare_invoice_charge(uuid) to authenticated;
grant execute on function public.master_list_billing_anomalies(boolean) to authenticated;
grant execute on function public.master_resolve_billing_anomaly(uuid, text) to authenticated;
grant execute on function public.master_list_company_access_states() to authenticated;
grant execute on function public.master_list_invoice_gateway(uuid) to authenticated;

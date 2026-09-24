-- Fase 3 da estrutura comercial: FATURAS e COMPETÊNCIA MENSAL.
--
-- Modelo financeiro determinístico da mensalidade: uma fatura por
-- (assinatura, competência), vencimento calculado por billing_day 1–31,
-- itens como SNAPSHOT financeiro, geração idempotente e baixa MANUAL pelo
-- Master. Nenhuma IA e nenhum valor vindo do frontend participam do cálculo:
-- o total é montado no banco a partir dos snapshots da assinatura.
--
-- Fora do escopo (fases futuras): pg_cron/geração automática, gateway/PIX/
-- webhook, inadimplência/carência automáticas, bloqueio/entitlements no /app,
-- prorrata, juros/multa, desconto, impostos, acesso do tenant às faturas.
--
-- ===========================================================================
-- REGRAS DE NEGÓCIO (fonte única; as funções abaixo as implementam)
--
-- 1. COMPETÊNCIA = DATE sempre no primeiro dia do mês (set/2026 = 2026-09-01).
--    Independente do dia de vencimento. É a FONTE DE VERDADE financeira.
--
-- 2. VENCIMENTO (invoice_due_date): billing_day 1–31 da VERSÃO CONTRATUAL VIGENTE
--    NA COMPETÊNCIA (subscription_terms); se o dia não existe no mês, vale o último dia do mês.
--    Tudo em DATE, sem fuso: 31/fev-2027 -> 28/02/2027; 31/fev-2028 ->
--    29/02/2028; 31/abr -> 30/04; 30/fev -> último dia de fevereiro.
--
-- 3. SNAPSHOT: a fatura congela (a) o plano, o preço do plano (snapshot) e o
--    billing_day da VERSÃO CONTRATUAL VIGENTE NA COMPETÊNCIA e (b) cada módulo
--    EXTRA vigente na competência com seu price_cents_snapshot. Módulos
--    source='plan' NÃO geram item (já estão no preço do plano). amount_cents =
--    soma dos itens (garantido por constraint trigger). Nada vem do catálogo
--    vivo nem do estado atual da assinatura. Fatura gerada é IMUTÁVEL. Sem
--    prorrata, sem crédito/débito retroativo.
--
-- 3b. VIGÊNCIA (ver o bloco "VIGÊNCIA CONTRATUAL POR COMPETÊNCIA" abaixo):
--    toda alteração contratual vale para a primeira competência ainda não
--    faturada a partir do mês da alteração. Gerar uma competência passada
--    depois de uma troca de plano/módulos/billing_day usa o contrato que valia
--    NAQUELA competência, reconstruído do histórico relacional.
--
-- 4. JANELA DE GERAÇÃO (a regra temporal, sem ambiguidade). Fuso fixo
--    America/Sao_Paulo; "mês de X" = primeiro dia do mês de X nesse fuso.
--      mínimo : mês de started_at da assinatura;
--      máximo : assinatura VIGENTE  -> mês atual + 1 (no máximo 1 mês à frente,
--                                      para não congelar estado muito cedo);
--               assinatura CANCELADA -> mês de canceled_at.
--    Logo, cancelar em 15/10/2026 ainda permite a competência 2026-10-01
--    (mês cheio, sem prorrata) e NEGA 2026-11-01 em diante. Faturas já geradas
--    nunca desaparecem. Se a fatura da competência já existe, a geração
--    devolve a existente (idempotente) mesmo depois do cancelamento.
--
-- 5. UNICIDADE: UNIQUE(subscription_id, competence). Uma fatura ANULADA
--    continua ocupando a competência (reemissão fica para fase futura).
--
-- 6. ESTADOS: open, paid, overdue, void. Transições permitidas:
--      open    -> paid | overdue | void
--      overdue -> paid | void
--      paid, void -> nenhuma (terminais; nada mais pode ser alterado)
--    'overdue' existe no modelo mas NENHUMA automação o aplica nesta fase.
--    Só open/overdue podem virar void; fatura paga não é anulável.
--
-- 7. HISTÓRICO FINANCEIRO NÃO É APAGADO: DELETE bloqueado por trigger em
--    invoices, invoice_items e invoice_events (e nenhuma RPC apaga). Itens são
--    imutáveis; eventos são append-only.
--
-- 8. current_period_start/end da assinatura NÃO são fonte de verdade
--    financeira e NADA aqui os lê ou os avança. A competência da fatura é a
--    fonte de verdade; os campos ficam apenas como informação da competência
--    de contratação (ver COMMENT ON COLUMN ao final).
-- ===========================================================================

-- Chave composta para o banco garantir que invoices.company_id é a empresa
-- da assinatura (sem depender de trigger).
alter table public.subscriptions
  add constraint subscriptions_id_company_uniq unique (id, company_id);

-- ===========================================================================
-- VIGÊNCIA CONTRATUAL POR COMPETÊNCIA
--
-- Problema: subscriptions guarda só o estado ATUAL (plano, preço, billing_day)
-- e as mudanças anteriores existiam apenas em payloads jsonb de eventos. Isso
-- não permite responder, sem parsing frágil, "o que valia para 2026-10-01?".
-- Gerar uma competência passada com o estado atual produziria histórico
-- financeiro errado.
--
-- Modelo relacional escolhido:
--  * subscription_terms: uma linha por VERSÃO do contrato (plano, snapshot de
--    preço, nome do plano e billing_day), com effective_from_competence. Uma
--    versão vale da sua competência até a véspera da próxima. Append-only.
--  * subscription_modules ganha effective_from_competence /
--    effective_to_competence (fim EXCLUSIVO): o extra é cobrado nas competências
--    C com from <= C < to (to nulo = ainda vigente).
--
-- Regra de vigência de qualquer alteração (troca de plano, billing_day, extra
-- adicionado ou removido) — change_effective_competence:
--     vigência = MAIOR entre (mês da alteração) e (última competência já
--                faturada da assinatura + 1 mês)
-- ou seja: vale para a primeira competência AINDA NÃO FATURADA, a partir do mês
-- da alteração. Competência inteira, sem prorrata. Consequências:
--  * alteração no mês M com M ainda não faturada: vale desde M (ex.: contratar e
--    logo acrescentar um módulo);
--  * alteração no mês M com M já faturada: vale desde M+1; a fatura de M, já
--    gerada, permanece intacta;
--  * se M+1 (ou mais) já foi gerada adiantado, vale depois dela — nenhuma
--    fatura existente contradiz o contrato registrado;
--  * competências ainda não geradas ANTES da vigência continuam usando o
--    contrato antigo, mesmo se geradas depois (retroativo correto).
-- A vigência é gravada no momento da alteração (por trigger, para valer até
-- para alterações feitas fora das RPCs) e nunca é recalculada.
-- ===========================================================================

-- Primeiro dia do mês de um instante, no fuso fixo do negócio.
create function public.competence_of(p_ts timestamptz)
returns date
language sql
stable
set search_path = public
as $$
  select make_date(
    extract(year from (p_ts at time zone 'America/Sao_Paulo'))::integer,
    extract(month from (p_ts at time zone 'America/Sao_Paulo'))::integer,
    1);
$$;

-- Único ponto de relógio das regras de vigência e da janela de geração.
-- Em produção é exatamente now(); existe para que testes de banco descartáveis
-- simulem datas substituindo esta função no banco de teste (nunca há GUC ou
-- parâmetro que altere o relógio em produção).
create function public.business_now()
returns timestamptz
language sql
stable
set search_path = public
as $$
  select now();
$$;

create table public.subscription_terms (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  effective_from_competence date not null check (extract(day from effective_from_competence) = 1),
  plan_id uuid not null references public.plans(id) on delete restrict,
  plan_name_snapshot text not null,
  plan_price_cents_snapshot integer not null check (plan_price_cents_snapshot >= 0),
  billing_day smallint not null check (billing_day between 1 and 31),
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index subscription_terms_lookup_idx
  on public.subscription_terms (subscription_id, effective_from_competence desc, seq desc);

create function public.prevent_subscription_terms_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'subscription_terms é append-only';
end;
$$;

create trigger subscription_terms_no_update
  before update on public.subscription_terms
  for each row execute function public.prevent_subscription_terms_update();

alter table public.subscription_terms enable row level security;
revoke all on public.subscription_terms from anon, authenticated;

-- Assinaturas que já existirem ganham UMA versão com o estado atual (não há
-- como reconstruir mudanças passadas sem parsing de eventos; a versão única
-- vale desde a competência de início). Em bancos sem assinaturas, é vazio.
insert into public.subscription_terms (
  subscription_id, effective_from_competence, plan_id, plan_name_snapshot,
  plan_price_cents_snapshot, billing_day
)
select s.id, public.competence_of(s.started_at), s.plan_id, p.name,
       s.plan_price_cents_snapshot, s.billing_day
from public.subscriptions s
join public.plans p on p.id = s.plan_id;

-- Vigência dos módulos (backfill a partir de added_at/removed_at existentes).
alter table public.subscription_modules
  add column effective_from_competence date,
  add column effective_to_competence date,
  add column module_name_snapshot text;

alter table public.subscription_modules disable trigger subscription_modules_canceled_immutable;
update public.subscription_modules
set effective_from_competence = public.competence_of(added_at),
    effective_to_competence = case
      when removed_at is not null then public.competence_of(removed_at) end,
    module_name_snapshot = (select m.name from public.modules m where m.id = subscription_modules.module_id);
alter table public.subscription_modules enable trigger subscription_modules_canceled_immutable;

alter table public.subscription_modules
  alter column effective_from_competence set not null,
  alter column module_name_snapshot set not null,
  add constraint subscription_modules_effective_check check (
    extract(day from effective_from_competence) = 1
    and (effective_to_competence is null
         or (extract(day from effective_to_competence) = 1
             and effective_to_competence >= effective_from_competence))
    and ((removed_at is null) = (effective_to_competence is null))
  );

-- Competência de vigência de uma alteração feita em p_at (ver regra acima).
create function public.change_effective_competence(p_subscription_id uuid, p_at timestamptz)
returns date
language plpgsql
stable
set search_path = public
as $$
declare
  v_month date := public.competence_of(p_at);
  v_after_invoiced date;
begin
  select (max(i.competence) + interval '1 month')::date into v_after_invoiced
  from public.invoices i where i.subscription_id = p_subscription_id;
  return greatest(v_month, coalesce(v_after_invoiced, v_month));
end;
$$;

-- Versões do contrato: uma na contratação e uma a cada mudança de plano,
-- preço do plano ou billing_day (sempre por trigger, cobre qualquer caminho).
create function public.record_subscription_terms()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from date;
begin
  if tg_op = 'INSERT' then
    v_from := public.competence_of(new.started_at);
  else
    v_from := public.change_effective_competence(new.id, public.business_now());
  end if;

  insert into public.subscription_terms (
    subscription_id, effective_from_competence, plan_id, plan_name_snapshot,
    plan_price_cents_snapshot, billing_day, actor_id
  )
  select new.id, v_from, new.plan_id, p.name, new.plan_price_cents_snapshot,
         new.billing_day, auth.uid()
  from public.plans p where p.id = new.plan_id;

  return null;
end;
$$;

create trigger subscriptions_record_terms_ins
  after insert on public.subscriptions
  for each row execute function public.record_subscription_terms();

create trigger subscriptions_record_terms_upd
  after update on public.subscriptions
  for each row
  when (old.plan_id is distinct from new.plan_id
        or old.plan_price_cents_snapshot is distinct from new.plan_price_cents_snapshot
        or old.billing_day is distinct from new.billing_day)
  execute function public.record_subscription_terms();

-- Vigência dos módulos: preenchida no INSERT e no fechamento (removed_at);
-- depois disso é imutável.
create function public.set_subscription_module_effective()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.module_name_snapshot := (select m.name from public.modules m where m.id = new.module_id);
    new.effective_from_competence :=
      public.change_effective_competence(new.subscription_id, public.business_now());
    new.effective_to_competence :=
      case when new.removed_at is not null then new.effective_from_competence end;
  else
    new.module_name_snapshot := old.module_name_snapshot;
    new.effective_from_competence := old.effective_from_competence;
    if old.removed_at is null and new.removed_at is not null then
      new.effective_to_competence := greatest(
        public.change_effective_competence(new.subscription_id, public.business_now()),
        old.effective_from_competence);
    else
      new.effective_to_competence := old.effective_to_competence;
    end if;
  end if;
  return new;
end;
$$;

create trigger subscription_modules_set_effective
  before insert or update on public.subscription_modules
  for each row execute function public.set_subscription_module_effective();

-- Reconstrução determinística: contrato vigente em uma competência.
create function public.subscription_terms_at(p_subscription_id uuid, p_competence date)
returns public.subscription_terms
language sql
stable
set search_path = public
as $$
  select t.*
  from public.subscription_terms t
  where t.subscription_id = p_subscription_id
    and t.effective_from_competence <= p_competence
  order by t.effective_from_competence desc, t.seq desc
  limit 1;
$$;

-- Extras (cobráveis) vigentes em uma competência.
create function public.subscription_extras_at(p_subscription_id uuid, p_competence date)
returns table (module_id uuid, module_name text, price_cents integer)
language sql
stable
set search_path = public
as $$
  select sm.module_id, sm.module_name_snapshot, sm.price_cents_snapshot
  from public.subscription_modules sm
  where sm.subscription_id = p_subscription_id
    and sm.source = 'extra'
    and sm.effective_from_competence <= p_competence
    and (sm.effective_to_competence is null or p_competence < sm.effective_to_competence)
  order by sm.module_name_snapshot, sm.id;
$$;

revoke execute on function public.competence_of(timestamptz) from public, anon, authenticated;
revoke execute on function public.business_now() from public, anon, authenticated;
revoke execute on function public.prevent_subscription_terms_update() from public, anon, authenticated;
revoke execute on function public.change_effective_competence(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.record_subscription_terms() from public, anon, authenticated;
revoke execute on function public.set_subscription_module_effective() from public, anon, authenticated;
revoke execute on function public.subscription_terms_at(uuid, date) from public, anon, authenticated;
revoke execute on function public.subscription_extras_at(uuid, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- invoices
-- ---------------------------------------------------------------------------
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null,
  company_id uuid not null,
  competence date not null check (extract(day from competence) = 1),
  due_date date not null,
  amount_cents integer not null check (amount_cents >= 0),
  status text not null default 'open' check (status in ('open', 'paid', 'overdue', 'void')),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint invoices_paid_consistency check ((status = 'paid') = (paid_at is not null)),
  constraint invoices_subscription_competence_uniq unique (subscription_id, competence),
  -- RESTRICT: assinatura/empresa com faturas não podem ser apagadas.
  constraint invoices_subscription_company_fk foreign key (subscription_id, company_id)
    references public.subscriptions (id, company_id) on delete restrict
);

create index invoices_company_id_idx on public.invoices(company_id, competence desc);
create index invoices_status_due_idx on public.invoices(status, due_date);
create index invoices_competence_idx on public.invoices(competence);

create trigger invoices_set_updated_at
  before update on public.invoices
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- invoice_items: SNAPSHOT financeiro. ref_id não tem FK de propósito: é só
-- referência informativa (plano/módulo); o valor e a descrição já estão aqui.
-- 'adjustment' fica preparado (único kind que aceita valor negativo), mas
-- nenhum fluxo o cria nesta fase.
-- ---------------------------------------------------------------------------
create table public.invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  kind text not null check (kind in ('plan', 'module', 'adjustment')),
  ref_id uuid,
  description text not null check (length(btrim(description)) > 0),
  amount_cents integer not null,
  created_at timestamptz not null default now(),
  check (kind = 'adjustment' or amount_cents >= 0)
);

create index invoice_items_invoice_id_idx on public.invoice_items(invoice_id);

-- ---------------------------------------------------------------------------
-- invoice_events: auditoria financeira própria (append-only). Separada de
-- subscription_events por serem domínios distintos e por ciclos de vida
-- diferentes (evento de fatura nunca some com a assinatura).
-- ---------------------------------------------------------------------------
create table public.invoice_events (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  event_type text not null check (event_type in ('generated', 'paid', 'voided')),
  payload jsonb not null default '{}'::jsonb,
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index invoice_events_invoice_idx on public.invoice_events(invoice_id, created_at);

-- ---------------------------------------------------------------------------
-- Proteções de integridade financeira (no banco, não só nas RPCs)
-- ---------------------------------------------------------------------------
create function public.guard_invoice_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status in ('paid', 'void') then
    raise exception 'fatura % é definitiva e não pode ser alterada', old.status;
  end if;

  if new.subscription_id is distinct from old.subscription_id
     or new.company_id is distinct from old.company_id
     or new.competence is distinct from old.competence
     or new.due_date is distinct from old.due_date
     or new.amount_cents is distinct from old.amount_cents then
    raise exception 'dados financeiros da fatura são imutáveis';
  end if;

  if new.status <> old.status and not (
       (old.status = 'open' and new.status in ('overdue', 'paid', 'void'))
    or (old.status = 'overdue' and new.status in ('paid', 'void'))
  ) then
    raise exception 'transição de status inválida: % -> %', old.status, new.status;
  end if;

  return new;
end;
$$;

create trigger invoices_guard_update
  before update on public.invoices
  for each row execute function public.guard_invoice_update();

create function public.guard_invoice_item_write()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if not exists (
      select 1 from public.invoices i where i.id = new.invoice_id and i.status = 'open'
    ) then
      raise exception 'itens só podem ser criados em fatura aberta';
    end if;
    return new;
  end if;
  raise exception 'invoice_items é imutável (snapshot financeiro)';
end;
$$;

create trigger invoice_items_guard_write
  before insert or update on public.invoice_items
  for each row execute function public.guard_invoice_item_write();

create function public.prevent_invoice_history_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception '% não pode ser apagada (histórico financeiro)', tg_table_name;
  end if;
  raise exception '% é append-only', tg_table_name;
end;
$$;

create trigger invoices_no_delete
  before delete on public.invoices
  for each row execute function public.prevent_invoice_history_change();
create trigger invoice_items_no_delete
  before delete on public.invoice_items
  for each row execute function public.prevent_invoice_history_change();
create trigger invoice_events_no_change
  before update or delete on public.invoice_events
  for each row execute function public.prevent_invoice_history_change();

-- Total da fatura = soma dos itens, verificado no COMMIT (deferido, pois fatura
-- e itens são inseridos no mesmo statement block da geração).
create function public.check_invoice_total()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := case when tg_table_name = 'invoices'
    then (to_jsonb(new) ->> 'id')::uuid else (to_jsonb(new) ->> 'invoice_id')::uuid end;
  v_amount integer;
  v_sum bigint;
begin
  select amount_cents into v_amount from public.invoices where id = v_id;
  select coalesce(sum(amount_cents), 0) into v_sum from public.invoice_items where invoice_id = v_id;
  if v_amount is distinct from v_sum then
    raise exception 'total da fatura (%) difere da soma dos itens (%)', v_amount, v_sum;
  end if;
  return null;
end;
$$;

create constraint trigger invoices_total_matches_items
  after insert on public.invoices
  deferrable initially deferred
  for each row execute function public.check_invoice_total();
create constraint trigger invoice_items_total_matches_items
  after insert on public.invoice_items
  deferrable initially deferred
  for each row execute function public.check_invoice_total();

revoke execute on function public.guard_invoice_update() from public, anon, authenticated;
revoke execute on function public.guard_invoice_item_write() from public, anon, authenticated;
revoke execute on function public.prevent_invoice_history_change() from public, anon, authenticated;
revoke execute on function public.check_invoice_total() from public, anon, authenticated;

-- RLS ativo, sem policies, sem grants para clientes.
alter table public.invoices enable row level security;
alter table public.invoice_items enable row level security;
alter table public.invoice_events enable row level security;

revoke all on public.invoices from anon, authenticated;
revoke all on public.invoice_items from anon, authenticated;
revoke all on public.invoice_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Funções puras / internas (nenhuma exposta a roles de cliente)
-- ---------------------------------------------------------------------------

-- Vencimento determinístico (regra 2). Só DATE, sem fuso.
create function public.invoice_due_date(p_competence date, p_billing_day integer)
returns date
language plpgsql
immutable
set search_path = public
as $$
declare
  v_last_day integer;
begin
  if p_competence is null or extract(day from p_competence) <> 1 then
    raise exception 'competência deve ser o primeiro dia do mês';
  end if;
  if p_billing_day is null or p_billing_day not between 1 and 31 then
    raise exception 'billing_day deve estar entre 1 e 31';
  end if;
  v_last_day := extract(day from (p_competence + interval '1 month' - interval '1 day'))::integer;
  return p_competence + (least(p_billing_day, v_last_day) - 1);
end;
$$;

create function public.record_invoice_event(
  p_invoice_id uuid,
  p_event_type text,
  p_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.invoice_events (invoice_id, event_type, payload, actor_id)
  values (p_invoice_id, p_event_type, coalesce(p_payload, '{}'::jsonb), auth.uid());
end;
$$;

-- Geração idempotente (regras 3, 4 e 5). Serializa pelo lock da linha da
-- assinatura — o mesmo lock que as RPCs de plano/módulos/billing_day/status
-- usam —, então o snapshot lido é consistente e duas gerações concorrentes da
-- mesma competência nunca duplicam (a segunda espera e encontra a existente;
-- o UNIQUE + ON CONFLICT é a rede de segurança final).
create function public.generate_subscription_invoice(
  p_subscription_id uuid,
  p_competence date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub public.subscriptions;
  v_terms public.subscription_terms;
  v_inv public.invoices;
  v_start date;
  v_max date;
  v_total bigint;
  v_items jsonb;
begin
  if p_competence is null or extract(day from p_competence) <> 1 then
    raise exception 'competência deve ser o primeiro dia do mês (ex.: 2026-09-01)';
  end if;

  select * into v_sub from public.subscriptions where id = p_subscription_id for update;
  if not found then
    raise exception 'assinatura não encontrada';
  end if;

  select * into v_inv from public.invoices
  where subscription_id = p_subscription_id and competence = p_competence;
  if found then
    return jsonb_build_object('invoice_id', v_inv.id, 'created', false);
  end if;

  v_start := public.competence_of(v_sub.started_at);
  if p_competence < v_start then
    raise exception 'competência anterior ao início da assinatura (%)', v_start;
  end if;

  if v_sub.status = 'canceled' then
    v_max := public.competence_of(v_sub.canceled_at);
    if p_competence > v_max then
      raise exception 'assinatura cancelada: última competência faturável é %', v_max;
    end if;
  else
    v_max := (public.competence_of(public.business_now()) + interval '1 month')::date;
    if p_competence > v_max then
      raise exception 'competência muito à frente: máximo permitido é %', v_max;
    end if;
  end if;

  -- Estado contratual que VALIA para a competência (nunca o estado atual da
  -- assinatura): plano/preço/billing_day da versão vigente em p_competence e
  -- os extras cuja vigência cobre p_competence.
  v_terms := public.subscription_terms_at(p_subscription_id, p_competence);
  if v_terms.id is null then
    raise exception 'sem vigência contratual registrada para a competência %', p_competence;
  end if;

  -- Total montado no banco: plano (snapshot da vigência) + extras vigentes.
  select v_terms.plan_price_cents_snapshot + coalesce(sum(e.price_cents), 0)
  into v_total
  from public.subscription_extras_at(p_subscription_id, p_competence) e;

  insert into public.invoices (subscription_id, company_id, competence, due_date, amount_cents)
  values (v_sub.id, v_sub.company_id, p_competence,
          public.invoice_due_date(p_competence, v_terms.billing_day), v_total)
  on conflict (subscription_id, competence) do nothing
  returning * into v_inv;

  if not found then
    select * into v_inv from public.invoices
    where subscription_id = p_subscription_id and competence = p_competence;
    return jsonb_build_object('invoice_id', v_inv.id, 'created', false);
  end if;

  insert into public.invoice_items (invoice_id, kind, ref_id, description, amount_cents)
  values (v_inv.id, 'plan', v_terms.plan_id, 'Plano ' || v_terms.plan_name_snapshot,
          v_terms.plan_price_cents_snapshot);

  -- Só EXTRAS vigentes geram item; source='plan' já está no preço do plano.
  insert into public.invoice_items (invoice_id, kind, ref_id, description, amount_cents)
  select v_inv.id, 'module', e.module_id, 'Módulo ' || e.module_name, e.price_cents
  from public.subscription_extras_at(p_subscription_id, p_competence) e;

  select jsonb_agg(jsonb_build_object(
           'kind', it.kind, 'ref_id', it.ref_id,
           'description', it.description, 'amount_cents', it.amount_cents)
         order by case it.kind when 'plan' then 0 else 1 end, it.description, it.id)
  into v_items from public.invoice_items it where it.invoice_id = v_inv.id;

  perform public.record_invoice_event(v_inv.id, 'generated', jsonb_build_object(
    'subscription_id', v_sub.id,
    'competence', p_competence,
    'due_date', v_inv.due_date,
    'billing_day', v_terms.billing_day,
    'terms_effective_from', v_terms.effective_from_competence,
    'plan_id', v_terms.plan_id,
    'amount_cents', v_inv.amount_cents,
    'items', v_items
  ));

  return jsonb_build_object('invoice_id', v_inv.id, 'created', true);
end;
$$;

revoke execute on function public.invoice_due_date(date, integer) from public, anon, authenticated;
revoke execute on function public.record_invoice_event(uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public.generate_subscription_invoice(uuid, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RPCs do Master (únicas portas de acesso; nenhum valor financeiro vem do
-- frontend)
-- ---------------------------------------------------------------------------
create function public.master_list_invoices(
  p_company_id uuid default null,
  p_status text default null,
  p_competence date default null
)
returns table (
  id uuid,
  subscription_id uuid,
  company_id uuid,
  company_name text,
  plan_description text,
  competence date,
  due_date date,
  amount_cents integer,
  status text,
  paid_at timestamptz,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_master_admin();

  if p_status is not null and p_status not in ('open', 'paid', 'overdue', 'void') then
    raise exception 'status inválido';
  end if;

  return query
  select
    i.id, i.subscription_id, i.company_id, c.name,
    (select it.description from public.invoice_items it
      where it.invoice_id = i.id and it.kind = 'plan' order by it.created_at limit 1),
    i.competence, i.due_date, i.amount_cents, i.status, i.paid_at, i.created_at
  from public.invoices i
  join public.companies c on c.id = i.company_id
  where (p_company_id is null or i.company_id = p_company_id)
    and (p_status is null or i.status = p_status)
    and (p_competence is null or i.competence = p_competence)
  order by i.competence desc, i.due_date desc, c.name
  limit 500;
end;
$$;

create function public.master_get_invoice(p_invoice_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_inv public.invoices;
  v_result jsonb;
begin
  perform public.assert_master_admin();

  select * into v_inv from public.invoices where id = p_invoice_id;
  if not found then
    raise exception 'fatura não encontrada';
  end if;

  select jsonb_build_object(
    'invoice', to_jsonb(v_inv),
    'company', (select jsonb_build_object('id', c.id, 'name', c.name)
                from public.companies c where c.id = v_inv.company_id),
    'subscription', (select jsonb_build_object(
                       'id', s.id, 'status', s.status, 'billing_day', s.billing_day,
                       'plan_id', s.plan_id)
                     from public.subscriptions s where s.id = v_inv.subscription_id),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', it.id, 'kind', it.kind, 'ref_id', it.ref_id,
        'description', it.description, 'amount_cents', it.amount_cents
      ) order by case it.kind when 'plan' then 0 when 'module' then 1 else 2 end,
                 it.description, it.id)
      from public.invoice_items it where it.invoice_id = v_inv.id
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'event_type', e.event_type, 'payload', e.payload,
        'created_at', e.created_at, 'actor_email', pr.email
      ) order by e.created_at, e.id)
      from public.invoice_events e
      left join public.profiles pr on pr.user_id = e.actor_id
      where e.invoice_id = v_inv.id
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

create function public.master_generate_invoice(p_subscription_id uuid, p_competence date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_master_admin();
  return public.generate_subscription_invoice(p_subscription_id, p_competence);
end;
$$;

-- Baixa manual. Idempotente: repetir a baixa de uma fatura já paga devolve a
-- fatura sem novo evento (paid_at omitido ou igual); paid_at diferente numa
-- fatura já paga é recusado para não reescrever a data de pagamento.
create function public.master_mark_invoice_paid(
  p_invoice_id uuid,
  p_paid_at timestamptz default null
)
returns public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv public.invoices;
  v_paid timestamptz;
  v_from text;
begin
  perform public.assert_master_admin();

  select * into v_inv from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'fatura não encontrada';
  end if;

  if v_inv.status = 'paid' then
    if p_paid_at is null or p_paid_at = v_inv.paid_at then
      return v_inv;
    end if;
    raise exception 'fatura já paga em %', v_inv.paid_at;
  end if;
  if v_inv.status = 'void' then
    raise exception 'fatura anulada não pode ser paga';
  end if;

  v_paid := coalesce(p_paid_at, now());
  if v_paid > now() + interval '5 minutes' then
    raise exception 'data de pagamento não pode ser futura';
  end if;

  v_from := v_inv.status;
  update public.invoices set status = 'paid', paid_at = v_paid
  where id = v_inv.id returning * into v_inv;

  perform public.record_invoice_event(v_inv.id, 'paid', jsonb_build_object(
    'from_status', v_from, 'paid_at', v_paid, 'amount_cents', v_inv.amount_cents));

  return v_inv;
end;
$$;

-- Anulação: só open/overdue. Preserva fatura, itens e eventos. Repetir em
-- fatura já anulada devolve a fatura sem novo evento.
create function public.master_void_invoice(p_invoice_id uuid, p_reason text default null)
returns public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv public.invoices;
  v_from text;
begin
  perform public.assert_master_admin();

  select * into v_inv from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'fatura não encontrada';
  end if;

  if v_inv.status = 'void' then
    return v_inv;
  end if;
  if v_inv.status = 'paid' then
    raise exception 'fatura paga não pode ser anulada';
  end if;

  v_from := v_inv.status;
  update public.invoices set status = 'void' where id = v_inv.id returning * into v_inv;

  perform public.record_invoice_event(v_inv.id, 'voided', jsonb_build_object(
    'from_status', v_from, 'reason', nullif(btrim(coalesce(p_reason, '')), '')));

  return v_inv;
end;
$$;

-- Histórico de vigência de UMA assinatura (versões do contrato e extras com
-- suas competências de vigência) — para o Master ver a partir de quando cada
-- alteração vale. Só leitura.
create function public.master_get_subscription_history(p_subscription_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_master_admin();

  if not exists (select 1 from public.subscriptions where id = p_subscription_id) then
    raise exception 'assinatura não encontrada';
  end if;

  return jsonb_build_object(
    'terms', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'effective_from_competence', t.effective_from_competence,
        'plan_id', t.plan_id, 'plan_name', t.plan_name_snapshot,
        'plan_price_cents', t.plan_price_cents_snapshot, 'billing_day', t.billing_day,
        'created_at', t.created_at, 'actor_email', pr.email
      ) order by t.effective_from_competence desc, t.seq desc)
      from public.subscription_terms t
      left join public.profiles pr on pr.user_id = t.actor_id
      where t.subscription_id = p_subscription_id
    ), '[]'::jsonb),
    'extras', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', sm.id, 'module_id', sm.module_id, 'name', sm.module_name_snapshot,
        'price_cents', sm.price_cents_snapshot,
        'effective_from_competence', sm.effective_from_competence,
        'effective_to_competence', sm.effective_to_competence,
        'added_at', sm.added_at, 'removed_at', sm.removed_at
      ) order by sm.effective_from_competence desc, sm.added_at desc, sm.id)
      from public.subscription_modules sm
      where sm.subscription_id = p_subscription_id and sm.source = 'extra'
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.master_get_subscription_history(uuid) from public, anon;
grant execute on function public.master_get_subscription_history(uuid) to authenticated;

revoke execute on function public.master_list_invoices(uuid, text, date) from public, anon;
revoke execute on function public.master_get_invoice(uuid) from public, anon;
revoke execute on function public.master_generate_invoice(uuid, date) from public, anon;
revoke execute on function public.master_mark_invoice_paid(uuid, timestamptz) from public, anon;
revoke execute on function public.master_void_invoice(uuid, text) from public, anon;

grant execute on function public.master_list_invoices(uuid, text, date) to authenticated;
grant execute on function public.master_get_invoice(uuid) to authenticated;
grant execute on function public.master_generate_invoice(uuid, date) to authenticated;
grant execute on function public.master_mark_invoice_paid(uuid, timestamptz) to authenticated;
grant execute on function public.master_void_invoice(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Semântica dos campos de período da assinatura (regra 8)
-- ---------------------------------------------------------------------------
comment on column public.subscriptions.current_period_start is
  'Informativo: competência (mês calendário) em que a assinatura foi contratada. NÃO é fonte de verdade financeira e nada o avança; a competência de invoices é a fonte de verdade.';
comment on column public.subscriptions.current_period_end is
  'Informativo: fim do mês da competência de contratação. NÃO é fonte de verdade financeira; ver invoices.competence.';

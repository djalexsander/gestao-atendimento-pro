-- NOVA REGRA COMERCIAL: módulo ADICIONAL contratado numa assinatura ativa gera cobrança PROPORCIONAL imediata (Pix), fica
-- PENDENTE até o pagamento e é liberado na hora da baixa. A regra anterior ("agendado, sem cobrança, entra no próximo ciclo")
-- deixa de valer para ADIÇÃO e continua valendo, igual, para REMOÇÃO (sem estorno, sai no próximo vencimento).
--
--   ADIÇÃO   : cobrança proporcional agora, Pix imediato, módulo só ativa após o pagamento, vencimento principal NÃO muda e a
--              próxima mensalidade já traz Plano Base + todos os módulos ativos pelo valor cheio.
--   REMOÇÃO  : sem estorno nem proporcional; o módulo segue ativo até o fim do ciclo pago (subscription_pending_changes).
--   < R$ 5,00: o Asaas não aceita Pix menor que R$ 5,00. Proporcional abaixo disso NÃO gera cobrança: a adição fica agendada
--              para o próximo ciclo (mecanismo agendado existente, sem cobrança imediata) e o valor cheio vem na mensalidade.
--
-- FÓRMULA (sempre no servidor, sem calendário paralelo): ciclo = [vencimento da competência anterior à próxima ainda não
-- faturada, vencimento dessa próxima competência) — as MESMAS invoice_due_date + billing_day dos termos (clamp 29/30/31);
--   cycle_days = cycle_end - cycle_start;  remaining_days = cycle_end - hoje;
--   prorated = round_half_up(preço_mensal * remaining_days / cycle_days)  (inteiro, determinístico: (2·p·r + c) div 2c).
-- Vários módulos de uma vez: UMA fatura (kind 'module_addition') com um item por módulo; cada módulo é arredondado e somado.
--
-- FATURA 'module_addition': due_date = hoje, competência = a do último ciclo faturado (não consome competência futura nem
-- desloca vigências), amount = soma dos itens. Não conta como dívida (billing_debt_of só olha 'recurring'), não entra em
-- "próximo vencimento" nem em open_invoices. Entra no fluxo Asaas EXISTENTE sem lógica nova (invoice -> billing_job ->
-- asaas_charge -> Pix; webhook/idempotência/QR/retry/reconciliação iguais).
--
-- ATIVAÇÃO: trigger na baixa (paga pelo gateway OU pelo Master): grava subscription_modules (vigência = próxima competência
-- não faturada, a mesma da próxima mensalidade) e evento module_added. Idempotente.
--
-- UMA solicitação aberta por assinatura (índice único parcial). Repetir a mesma seleção devolve a mesma fatura; outra
-- alteração enquanto há cobrança de módulos pendente é BLOQUEADA. A solicitação é anulada (cancelando a cobrança no Asaas pelo
-- job existente): pelo owner, ao expirar (2 dias) ou quando a próxima mensalidade é gerada (o ciclo mudou).

alter table public.invoices drop constraint invoices_kind_check;
alter table public.invoices add constraint invoices_kind_check check (kind in ('initial', 'recurring', 'module_addition'));
-- uma fatura por competência vale para o ciclo (inicial/recorrente); a de adição de módulos não ocupa competência
alter table public.invoices drop constraint invoices_subscription_competence_uniq;
create unique index invoices_subscription_competence_uniq on public.invoices (subscription_id, competence) where kind <> 'module_addition';
create unique index invoices_one_open_module_addition on public.invoices (subscription_id)
  where kind = 'module_addition' and status in ('open', 'overdue');

alter table public.subscription_events drop constraint subscription_events_event_type_check;
alter table public.subscription_events add constraint subscription_events_event_type_check
  check (event_type in (
    'subscribed', 'plan_changed', 'module_added', 'module_removed', 'status_changed', 'billing_day_changed',
    'modules_change_scheduled', 'modules_change_updated', 'modules_change_canceled', 'modules_change_applied',
    'module_addition_requested', 'module_addition_canceled'));

create table public.subscription_module_additions (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null,
  company_id uuid not null,
  invoice_id uuid not null unique references public.invoices(id) on delete restrict,
  status text not null default 'pending_payment' check (status in ('pending_payment', 'activated', 'canceled')),
  -- snapshot calculado NO SERVIDOR: [{ module_id, code, name, monthly_price_cents, prorated_cents }]
  modules jsonb not null,
  cycle_start date not null,
  cycle_end date not null,
  cycle_days integer not null check (cycle_days > 0),
  remaining_days integer not null check (remaining_days > 0),
  amount_cents integer not null check (amount_cents > 0),
  previous_monthly_cents integer not null check (previous_monthly_cents >= 0),
  new_monthly_cents integer not null check (new_monthly_cents >= 0),
  requested_by uuid,
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscription_module_additions_sub_company_fk foreign key (subscription_id, company_id)
    references public.subscriptions (id, company_id) on delete restrict,
  constraint subscription_module_additions_decided_check check ((status = 'pending_payment') = (decided_at is null))
);
create unique index subscription_module_additions_one_pending on public.subscription_module_additions (subscription_id) where status = 'pending_payment';
create trigger subscription_module_additions_set_updated_at
  before update on public.subscription_module_additions
  for each row execute function public.set_updated_at();
alter table public.subscription_module_additions enable row level security;
revoke all on public.subscription_module_additions from public, anon, authenticated;
grant select, insert, update, delete on public.subscription_module_additions to service_role;

-- próximo vencimento: só faturas do ciclo (a de adição de módulos não faz parte)
create or replace function public.billing_next_due_date(p_subscription_id uuid)
returns date
language sql
stable
security definer
set search_path = public
as $$
  with s as (select id, started_at from public.subscriptions where id = p_subscription_id),
  nxt as (
    select coalesce((max(i.competence) + interval '1 month')::date, public.competence_of(s.started_at)) as c
      from s left join public.invoices i on i.subscription_id = s.id and i.kind <> 'module_addition'
     group by s.started_at
  )
  select public.invoice_due_date(nxt.c, (public.subscription_terms_at(p_subscription_id, nxt.c)).billing_day) from nxt;
$$;

-- ---------------------------------------------------------------------------
-- Helpers de cálculo (internos)
-- ---------------------------------------------------------------------------
create function public.billing_min_charge_cents()
returns integer language sql immutable set search_path = public as $$ select 500 $$;

create function public.billing_prorated_cents(p_price_cents integer, p_remaining_days integer, p_cycle_days integer)
returns integer
language sql
immutable
set search_path = public
as $$
  select case when p_cycle_days is null or p_cycle_days <= 0 or p_remaining_days is null or p_remaining_days <= 0
                   or p_price_cents is null or p_price_cents <= 0 then 0
         else ((2::bigint * p_price_cents * p_remaining_days + p_cycle_days) / (2::bigint * p_cycle_days))::integer end;
$$;

create function public.billing_money_text(p_cents integer)
returns text language sql immutable set search_path = public as
$$ select 'R$ ' || (p_cents / 100)::text || ',' || lpad((p_cents % 100)::text, 2, '0') $$;

-- Ciclo vigente da assinatura (mesma âncora/clamp das mensalidades): da data de vencimento da competência anterior à próxima
-- competência ainda não faturada até a data de vencimento dela.
create function public.billing_module_cycle(p_subscription_id uuid)
returns table (cycle_start date, cycle_end date, cycle_days integer, remaining_days integer, next_competence date)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sub public.subscriptions;
  v_next date;
  v_prev date;
  v_start date;
  v_end date;
begin
  select * into v_sub from public.subscriptions where id = p_subscription_id;
  select coalesce((max(i.competence) + interval '1 month')::date, public.competence_of(v_sub.started_at)) into v_next
    from public.invoices i where i.subscription_id = p_subscription_id and i.kind <> 'module_addition';
  v_end := public.invoice_due_date(v_next, (public.subscription_terms_at(p_subscription_id, v_next)).billing_day);
  v_prev := (v_next - interval '1 month')::date;
  v_start := case when v_prev < public.competence_of(v_sub.started_at)
                  then (v_sub.started_at at time zone 'America/Sao_Paulo')::date
                  else public.invoice_due_date(v_prev, (public.subscription_terms_at(p_subscription_id, v_prev)).billing_day) end;
  return query select v_start, v_end, v_end - v_start, v_end - public.business_date(), v_next;
end;
$$;

-- Plano ÚNICO da alteração de módulos (cotação e confirmação): decide o MODO e calcula tudo no servidor.
--   identical | mixed | remove_next_cycle | add_now | add_deferred
create function public.billing_module_change_plan(p_company_id uuid, p_module_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_plan jsonb := public.billing_plan_module_change(p_company_id, p_module_ids);
  v_sub_id uuid := (v_plan ->> 'subscription_id')::uuid;
  v_added jsonb := v_plan -> 'added';
  v_removed jsonb := v_plan -> 'removed';
  v_order public.subscription_module_additions;
  v_pend public.subscription_pending_changes;
  v_cyc record;
  v_cs date;
  v_ce date;
  v_cd integer;
  v_rd integer;
  v_lines jsonb := '[]'::jsonb;
  v_total integer := 0;
  v_pr integer;
  v_item jsonb;
  v_mode text;
  v_blocked text;
  v_same boolean := false;
  v_added_ids uuid[];
begin
  select * into v_order from public.subscription_module_additions where subscription_id = v_sub_id and status = 'pending_payment';
  select * into v_pend from public.subscription_pending_changes where subscription_id = v_sub_id and status = 'scheduled';
  select coalesce(array_agg((n ->> 'module_id')::uuid order by (n ->> 'module_id')::uuid), '{}') into v_added_ids from jsonb_array_elements(v_added) n;

  if v_order.id is not null then
    v_same := jsonb_array_length(v_added) > 0 and jsonb_array_length(v_removed) = 0 and v_added_ids =
      (select coalesce(array_agg((m ->> 'module_id')::uuid order by (m ->> 'module_id')::uuid), '{}') from jsonb_array_elements(v_order.modules) m);
  end if;

  if (v_plan ->> 'identical')::boolean then
    v_mode := 'identical';
  elsif jsonb_array_length(v_added) > 0 and jsonb_array_length(v_removed) > 0 then
    v_mode := 'mixed';
    v_blocked := 'Faça uma alteração por vez: adicione módulos (cobrança proporcional agora) ou remova módulos (no próximo ciclo), não os dois ao mesmo tempo.';
  elsif jsonb_array_length(v_removed) > 0 then
    v_mode := 'remove_next_cycle';
  else
    select * into v_cyc from public.billing_module_cycle(v_sub_id);
    v_cs := v_cyc.cycle_start; v_ce := v_cyc.cycle_end; v_cd := v_cyc.cycle_days; v_rd := v_cyc.remaining_days;
    for v_item in select value from jsonb_array_elements(v_added) loop
      v_pr := public.billing_prorated_cents((v_item ->> 'price_cents')::integer, v_rd, v_cd);
      v_lines := v_lines || jsonb_build_object('module_id', v_item ->> 'module_id', 'code', v_item ->> 'code', 'name', v_item ->> 'name',
                   'monthly_price_cents', (v_item ->> 'price_cents')::integer, 'prorated_cents', v_pr);
      v_total := v_total + v_pr;
    end loop;
    v_mode := case when v_rd > 0 and v_total >= public.billing_min_charge_cents() then 'add_now' else 'add_deferred' end;
  end if;

  if v_order.id is not null and not v_same and v_mode <> 'identical' then
    v_blocked := 'Existe uma alteração de módulos aguardando pagamento. Pague ou cancele a solicitação antes de fazer outra alteração.';
  elsif v_mode = 'add_now' and v_pend.id is not null then
    v_blocked := 'Há uma alteração agendada para o próximo ciclo. Cancele-a antes de adicionar módulos com cobrança imediata.';
  end if;

  return v_plan || jsonb_build_object(
    'mode', v_mode,
    'blocked_reason', v_blocked,
    'lines', v_lines,
    'prorated_total_cents', v_total,
    'charge_today_cents', case when v_mode = 'add_now' then v_total else 0 end,
    'min_charge_cents', public.billing_min_charge_cents(),
    'cycle_start', v_cs, 'cycle_end', v_ce, 'cycle_days', v_cd, 'remaining_days', v_rd,
    'next_due_date', v_ce,
    'order_id', v_order.id, 'order_invoice_id', v_order.invoice_id, 'order_same', v_same);
end;
$$;

create or replace function public.tenant_quote_module_change(p_company_id uuid, p_module_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.billing_assert_owner(p_company_id);
  return public.billing_module_change_plan(p_company_id, p_module_ids) - 'subscription_id';
end;
$$;

-- Agendamento sem cobrança imediata (REMOÇÃO e adição abaixo do mínimo do Pix): corpo da RPC anterior, inalterado
create function public.billing_schedule_module_change_internal(p_company_id uuid, p_module_ids uuid[])
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

-- Entrada única do owner para confirmar a alteração de módulos.
create or replace function public.tenant_schedule_module_change(p_company_id uuid, p_module_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub_id uuid;
  v_plan jsonb;
  v_mode text;
  v_order public.subscription_module_additions;
  v_inv public.invoices;
  v_comp date;
  v_line jsonb;
  v_items jsonb;
  v_res jsonb;
  v_prev_total integer;
  v_period text;
begin
  perform public.billing_assert_owner(p_company_id);

  -- a assinatura é travada PRIMEIRO (mesma ordem de travas do motor)
  select s.id into v_sub_id from public.subscriptions s where s.company_id = p_company_id and s.status <> 'canceled';
  if v_sub_id is null then
    raise exception 'Esta empresa não possui assinatura vigente para alterar módulos.' using errcode = 'PT409';
  end if;
  perform 1 from public.subscriptions where id = v_sub_id for update;

  v_plan := public.billing_module_change_plan(p_company_id, p_module_ids);
  v_mode := v_plan ->> 'mode';

  -- retry/duplo clique da MESMA adição: devolve a solicitação aberta (uma única fatura)
  if (v_plan ->> 'order_same')::boolean then
    select * into v_order from public.subscription_module_additions where id = (v_plan ->> 'order_id')::uuid;
    return jsonb_build_object('mode', 'add_now', 'idempotent', true, 'invoice_id', v_order.invoice_id,
      'amount_cents', v_order.amount_cents, 'due_date', (select due_date from public.invoices where id = v_order.invoice_id),
      'cycle_end', v_order.cycle_end, 'new_monthly_cents', v_order.new_monthly_cents, 'modules', v_order.modules);
  end if;
  if v_plan ->> 'blocked_reason' is not null then
    raise exception '%', v_plan ->> 'blocked_reason' using errcode = 'PT409';
  end if;

  if v_mode <> 'add_now' then
    v_res := public.billing_schedule_module_change_internal(p_company_id, p_module_ids);
    return v_res || jsonb_build_object('mode', case when v_mode = 'add_deferred' then 'add_deferred' else 'remove_next_cycle' end,
                                       'below_minimum', v_mode = 'add_deferred');
  end if;

  -- ADIÇÃO COM COBRANÇA IMEDIATA: uma fatura, um item por módulo
  select max(i.competence) into v_comp from public.invoices i where i.subscription_id = v_sub_id and i.kind <> 'module_addition';
  insert into public.invoices (subscription_id, company_id, competence, due_date, amount_cents, kind)
  values (v_sub_id, p_company_id, v_comp, public.business_date(), (v_plan ->> 'charge_today_cents')::integer, 'module_addition')
  returning * into v_inv;

  for v_line in select value from jsonb_array_elements(v_plan -> 'lines') loop
    insert into public.invoice_items (invoice_id, kind, ref_id, description, amount_cents)
    values (v_inv.id, 'module', (v_line ->> 'module_id')::uuid,
            'Módulo ' || (v_line ->> 'name') || ' — proporcional de ' || to_char(public.business_date(), 'DD/MM/YYYY') || ' a '
              || to_char((v_plan ->> 'cycle_end')::date, 'DD/MM/YYYY') || ' (' || (v_plan ->> 'remaining_days') || '/' || (v_plan ->> 'cycle_days')
              || ' de ' || public.billing_money_text((v_line ->> 'monthly_price_cents')::integer) || '/mês)',
            (v_line ->> 'prorated_cents')::integer);
  end loop;

  insert into public.subscription_module_additions (
    subscription_id, company_id, invoice_id, modules, cycle_start, cycle_end, cycle_days, remaining_days, amount_cents,
    previous_monthly_cents, new_monthly_cents, requested_by)
  values (v_sub_id, p_company_id, v_inv.id, v_plan -> 'lines', (v_plan ->> 'cycle_start')::date, (v_plan ->> 'cycle_end')::date,
          (v_plan ->> 'cycle_days')::integer, (v_plan ->> 'remaining_days')::integer, v_inv.amount_cents,
          (v_plan ->> 'previous_monthly_cents')::integer, (v_plan ->> 'new_monthly_cents')::integer, auth.uid())
  returning * into v_order;

  select jsonb_agg(jsonb_build_object('kind', it.kind, 'ref_id', it.ref_id, 'description', it.description, 'amount_cents', it.amount_cents)
                   order by it.description, it.id)
    into v_items from public.invoice_items it where it.invoice_id = v_inv.id;
  perform public.record_invoice_event(v_inv.id, 'generated', jsonb_build_object(
    'invoice_kind', 'module_addition', 'subscription_id', v_sub_id, 'competence', v_comp, 'due_date', v_inv.due_date,
    'amount_cents', v_inv.amount_cents, 'cycle_start', v_order.cycle_start, 'cycle_end', v_order.cycle_end,
    'cycle_days', v_order.cycle_days, 'remaining_days', v_order.remaining_days, 'items', v_items));
  perform public.record_subscription_event(v_sub_id, 'module_addition_requested', jsonb_build_object(
    'order_id', v_order.id, 'invoice_id', v_inv.id, 'requested_by', auth.uid(), 'modules', v_plan -> 'lines',
    'amount_cents', v_inv.amount_cents, 'cycle_end', v_order.cycle_end,
    'previous_monthly_cents', v_order.previous_monthly_cents, 'new_monthly_cents', v_order.new_monthly_cents));

  return jsonb_build_object('mode', 'add_now', 'idempotent', false, 'invoice_id', v_inv.id, 'amount_cents', v_inv.amount_cents,
    'due_date', v_inv.due_date, 'cycle_end', v_order.cycle_end, 'new_monthly_cents', v_order.new_monthly_cents,
    'modules', v_order.modules);
end;
$$;

-- ---------------------------------------------------------------------------
-- Anulação, expiração e ativação
-- ---------------------------------------------------------------------------
create function public.billing_void_module_addition(p_invoice_id uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform set_config('app.module_addition_note', coalesce(p_reason, ''), true);
  update public.invoices set status = 'void'
   where id = p_invoice_id and kind = 'module_addition' and status in ('open', 'overdue');
  if not found then
    perform set_config('app.module_addition_note', '', true);
    return false;
  end if;
  perform public.record_invoice_event(p_invoice_id, 'voided', jsonb_build_object('reason', p_reason, 'source', 'module_addition'));
  perform set_config('app.module_addition_note', '', true);
  return true;
end;
$$;

-- pagamento já recebido no gateway, ainda sem baixa: nunca anular (a baixa vai ativar os módulos)
create function public.billing_invoice_payment_in_flight(p_invoice_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.asaas_charges c where c.invoice_id = p_invoice_id and c.status in ('received', 'confirmed'));
$$;

create function public.tenant_cancel_module_addition(p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub_id uuid;
  v_order public.subscription_module_additions;
begin
  perform public.billing_assert_owner(p_company_id);
  select s.id into v_sub_id from public.subscriptions s where s.company_id = p_company_id and s.status <> 'canceled';
  if v_sub_id is null then
    return jsonb_build_object('ok', true, 'canceled', false);
  end if;
  perform 1 from public.subscriptions where id = v_sub_id for update;
  select * into v_order from public.subscription_module_additions where subscription_id = v_sub_id and status = 'pending_payment' for update;
  if not found then
    return jsonb_build_object('ok', true, 'canceled', false);
  end if;
  if public.billing_invoice_payment_in_flight(v_order.invoice_id) then
    raise exception 'O pagamento desta solicitação já foi recebido e está sendo confirmado. Aguarde alguns instantes.' using errcode = 'PT409';
  end if;
  perform public.billing_void_module_addition(v_order.invoice_id, 'canceled_by_owner');
  return jsonb_build_object('ok', true, 'canceled', true);
end;
$$;

create function public.billing_expire_module_additions()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_n integer := 0;
begin
  for r in
    select i.id, i.subscription_id from public.invoices i
     where i.kind = 'module_addition' and i.status in ('open', 'overdue')
       and public.business_date() >= i.due_date + 2
       and not public.billing_invoice_payment_in_flight(i.id)
     order by i.created_at, i.id
  loop
    perform 1 from public.subscriptions where id = r.subscription_id for update;
    if public.billing_void_module_addition(r.id, 'expired') then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- a mensalidade seguinte foi gerada: o ciclo da solicitação aberta mudou -> anula (o cliente solicita de novo)
create function public.invoices_void_stale_module_additions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in
    select i.id from public.invoices i
     where i.subscription_id = new.subscription_id and i.kind = 'module_addition' and i.status in ('open', 'overdue')
       and not public.billing_invoice_payment_in_flight(i.id)
  loop
    perform public.billing_void_module_addition(r.id, 'next_invoice_generated');
  end loop;
  return null;
end;
$$;
create trigger invoices_void_stale_module_additions after insert on public.invoices
  for each row when (new.kind = 'recurring') execute function public.invoices_void_stale_module_additions();

-- anulada por qualquer caminho (owner, expiração, Master): a solicitação é encerrada
create function public.invoices_module_addition_voided()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.subscription_module_additions;
begin
  update public.subscription_module_additions
     set status = 'canceled', decided_at = now(),
         note = coalesce(nullif(current_setting('app.module_addition_note', true), ''), 'invoice_void')
   where invoice_id = new.id and status = 'pending_payment'
   returning * into v_order;
  if found then
    perform public.record_subscription_event(v_order.subscription_id, 'module_addition_canceled', jsonb_build_object(
      'order_id', v_order.id, 'invoice_id', new.id, 'reason', v_order.note, 'modules', v_order.modules, 'amount_cents', v_order.amount_cents));
  end if;
  return null;
end;
$$;
create trigger invoices_module_addition_voided after update of status on public.invoices
  for each row when (new.kind = 'module_addition' and new.status = 'void' and old.status is distinct from 'void')
  execute function public.invoices_module_addition_voided();

-- ATIVAÇÃO: a baixa da fatura (gateway ou Master) libera os módulos. Roda na MESMA transação da baixa (assinatura já travada).
create function public.invoices_module_addition_paid()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.subscription_module_additions;
  v_sub public.subscriptions;
  v_m jsonb;
  v_activated jsonb := '[]'::jsonb;
begin
  select * into v_order from public.subscription_module_additions where invoice_id = new.id for update;
  if not found or v_order.status <> 'pending_payment' then
    return null;
  end if;
  select * into v_sub from public.subscriptions where id = v_order.subscription_id;

  if v_sub.status = 'canceled' then
    update public.subscription_module_additions set status = 'canceled', decided_at = now(), note = 'subscription_canceled' where id = v_order.id;
    perform public.billing_record_anomaly('unexpected_payment',
      jsonb_build_object('reason', 'module_addition_paid_on_canceled_subscription', 'amount_cents', new.amount_cents),
      new.company_id, new.id, null, null, 'module-addition:' || new.id::text);
    return null;
  end if;

  for v_m in select value from jsonb_array_elements(v_order.modules) loop
    if not exists (select 1 from public.subscription_modules sm
                    where sm.subscription_id = v_order.subscription_id and sm.module_id = (v_m ->> 'module_id')::uuid and sm.removed_at is null) then
      insert into public.subscription_modules (subscription_id, module_id, source, price_cents_snapshot)
      values (v_order.subscription_id, (v_m ->> 'module_id')::uuid, 'extra', (v_m ->> 'monthly_price_cents')::integer);
      v_activated := v_activated || v_m;
    end if;
  end loop;

  update public.subscription_module_additions set status = 'activated', decided_at = now() where id = v_order.id;
  perform public.record_subscription_event(v_order.subscription_id, 'module_added', jsonb_build_object(
    'via', 'module_addition', 'order_id', v_order.id, 'invoice_id', new.id, 'modules', v_activated,
    'prorated_cents', new.amount_cents, 'paid_at', new.paid_at));
  return null;
end;
$$;
create trigger invoices_module_addition_paid after update of status on public.invoices
  for each row when (new.kind = 'module_addition' and new.status = 'paid' and old.status is distinct from 'paid')
  execute function public.invoices_module_addition_paid();

-- ---------------------------------------------------------------------------
-- Substituições (copiadas das versões vigentes, com o ajuste mínimo para 'module_addition')
-- ---------------------------------------------------------------------------
-- descrição da cobrança no Asaas para a fatura de adição de módulos
create or replace function public.billing_claim_charge(p_invoice_id uuid)
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
            when 'module_addition' then 'Gestão Atendimento Pro - Módulos adicionais (proporcional)'
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

-- geração de mensalidade: ignora a fatura de adição de módulos ao procurar a competência
create or replace function public.generate_subscription_invoice(
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
  where subscription_id = p_subscription_id and competence = p_competence and kind <> 'module_addition';
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
  on conflict (subscription_id, competence) where kind <> 'module_addition' do nothing
  returning * into v_inv;

  if not found then
    select * into v_inv from public.invoices
    where subscription_id = p_subscription_id and competence = p_competence and kind <> 'module_addition';
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

-- Estado comercial do tenant: adição pendente + contagens só do ciclo
create or replace function public.tenant_get_billing_state(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sub public.subscriptions;
  v_plan public.plans;
  -- situação da dívida como JSON (NULL sem assinatura): nunca referenciar um RECORD que pode não ter sido atribuído
  v_debt jsonb := null;
  v_state text;
begin
  perform public.billing_assert_owner_or_admin(p_company_id);
  v_state := public.company_access_state(p_company_id);

  select * into v_sub from public.subscriptions where company_id = p_company_id and status <> 'canceled';
  if found then
    select * into v_plan from public.plans where id = v_sub.plan_id;
    select jsonb_build_object('state', d.state, 'due_date', d.due_date, 'days_overdue', d.days_overdue,
                              'grace_until', d.grace_until, 'restriction_from', d.restriction_from)
      into v_debt from public.billing_debt_of(v_sub.id) d;
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
      -- fatura em aberto/vencida manda (a mais antiga); sem pendência, a data vem do MOTOR da assinatura (próxima competência
      -- ainda não faturada, mesma âncora e clamp), sem depender de a próxima fatura já ter sido gerada
      'next_due_date', coalesce(
        (select min(i.due_date) from public.invoices i
          where i.subscription_id = v_sub.id and i.status in ('open', 'overdue') and i.kind <> 'module_addition'),
        public.billing_next_due_date(v_sub.id))) end,
    'debt', v_debt,
    'pending_change', case when v_sub.id is null then null else public.billing_pending_change_json(v_sub.id) end,
    'open_invoices', (select count(*) from public.invoices i
                       where i.company_id = p_company_id and i.status in ('open', 'overdue') and i.kind <> 'module_addition'),
    -- adição de módulos aguardando pagamento (cobrança proporcional em aberto): os módulos ainda NÃO estão ativos
    'pending_module_addition', case when v_sub.id is null then null else (
      select jsonb_build_object('id', a.id, 'invoice_id', a.invoice_id, 'amount_cents', a.amount_cents,
               'due_date', i.due_date, 'invoice_status', i.status, 'cycle_start', a.cycle_start, 'cycle_end', a.cycle_end,
               'cycle_days', a.cycle_days, 'remaining_days', a.remaining_days, 'modules', a.modules,
               'previous_monthly_cents', a.previous_monthly_cents, 'new_monthly_cents', a.new_monthly_cents,
               'requested_at', a.requested_at)
        from public.subscription_module_additions a join public.invoices i on i.id = a.invoice_id
       where a.subscription_id = v_sub.id and a.status = 'pending_payment') end);
end;
$$;

-- Ciclo diário: idêntico ao vigente + expiração das solicitações de módulos não pagas
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
  v_expired integer := 0;
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

  begin
    v_expired := public.billing_expire_module_additions();
  exception when others then
    v_errors := v_errors + 1;
    raise warning 'run_billing_cycle: expiração de adições de módulos falhou: %', sqlerrm;
  end;

  return jsonb_build_object(
    'business_date', public.business_date(),
    'module_additions_expired', v_expired,
    'invoices_generated', v_generated,
    'invoices_marked_overdue', v_overdue,
    'status_changes', v_changes,
    'trials_expired', v_trials,
    'module_changes_applied', v_module_changes,
    'errors', v_errors);
end;
$$;

-- ---------------------------------------------------------------------------
-- ACL: internos fechados a todos os papéis; RPCs do owner só para authenticated (cada uma reautentica por dentro)
-- ---------------------------------------------------------------------------
revoke execute on function public.billing_next_due_date(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.billing_min_charge_cents() from public, anon, authenticated, service_role;
revoke execute on function public.billing_prorated_cents(integer, integer, integer) from public, anon, authenticated, service_role;
revoke execute on function public.billing_money_text(integer) from public, anon, authenticated, service_role;
revoke execute on function public.billing_module_cycle(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.billing_module_change_plan(uuid, uuid[]) from public, anon, authenticated, service_role;
revoke execute on function public.billing_schedule_module_change_internal(uuid, uuid[]) from public, anon, authenticated, service_role;
revoke execute on function public.billing_void_module_addition(uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.billing_invoice_payment_in_flight(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.billing_expire_module_additions() from public, anon, authenticated, service_role;
revoke execute on function public.invoices_void_stale_module_additions() from public, anon, authenticated, service_role;
revoke execute on function public.invoices_module_addition_voided() from public, anon, authenticated, service_role;
revoke execute on function public.invoices_module_addition_paid() from public, anon, authenticated, service_role;
revoke execute on function public.tenant_cancel_module_addition(uuid) from public, anon, service_role;
grant execute on function public.tenant_cancel_module_addition(uuid) to authenticated;

-- Fase 4 — ORDEM ÚNICA DE TRAVAS: assinatura -> fatura (elimina o deadlock por ordem invertida).
--
-- ACHADO (validação no Postgres REAL, sessões independentes alinhadas no relógio do
-- servidor): três caminhos travavam FATURA -> ASSINATURA — master_mark_invoice_paid e
-- master_void_invoice (travam a fatura e só depois reconciliam a assinatura) e o
-- cancelamento (travava a cobrança inicial antes da assinatura) — enquanto o ciclo
-- diário (reconcile_subscription_billing_state), a geração de faturas e as demais RPCs
-- travam ASSINATURA -> FATURA. Duas transações opostas sobre a MESMA assinatura/fatura
-- (baixa × ciclo, baixa × anulação, cancelamento × ciclo) podem se esperar em círculo:
-- o Postgres detecta (40P01) e aborta uma delas após deadlock_timeout, mas isso não é
-- aceitável como desenho.
--
-- CORREÇÃO ESTRUTURAL: uma regra só, em TODO o código —
--   1. a ASSINATURA é sempre travada primeiro;
--   2. só depois, as FATURAS da assinatura.
-- master_mark_invoice_paid e master_void_invoice leem a assinatura da fatura SEM trava
-- (invoices.subscription_id é imutável), travam a assinatura, travam a fatura e a
-- revalidam já sob trava (READ COMMITTED enxerga o estado final de quem passou antes).
-- master_set_subscription_status deixa de pré-travar a inicial: trava a assinatura e o
-- trigger de cancelamento (regra 5g) trava a inicial DEPOIS. Pagar, anular e cancelar a
-- mesma inicial passam a se serializar todos pela trava da assinatura.
--
-- SÓ MUDA A ORDEM DAS TRAVAS: regras de negócio, mensagens, eventos e resultados são
-- idênticos aos da 090000 (mesmos testes). create or replace mantém dono, search_path,
-- SECURITY DEFINER e as permissões (nada é concedido nem revogado aqui). Esta migration
-- substitui a nota "o cancelamento trava a inicial antes da assinatura" da regra 5g da
-- 090000.

create or replace function public.master_mark_invoice_paid(
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
  v_sub_id uuid;
  v_paid timestamptz;
  v_from text;
begin
  perform public.assert_master_admin();

  -- ORDEM ÚNICA DE TRAVAS (assinatura -> fatura): a assinatura da fatura é lida sem
  -- trava (invoices.subscription_id é imutável), a ASSINATURA é travada primeiro e só
  -- então a fatura, que é relida já sob trava (READ COMMITTED enxerga o estado final
  -- de quem passou antes). Mesma ordem do ciclo diário, da geração e do cancelamento.
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

  -- a dívida pode ter acabado: reconcilia a assinatura na mesma transação
  perform public.reconcile_subscription_billing_state(v_inv.subscription_id);

  return v_inv;
end;
$$;

create or replace function public.master_void_invoice(p_invoice_id uuid, p_reason text default null)
returns public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv public.invoices;
  v_sub_id uuid;
  v_from text;
begin
  perform public.assert_master_admin();

  -- ORDEM ÚNICA DE TRAVAS (assinatura -> fatura): ver master_mark_invoice_paid.
  select i.subscription_id into v_sub_id from public.invoices i where i.id = p_invoice_id;
  if not found then
    raise exception 'fatura não encontrada';
  end if;
  perform 1 from public.subscriptions where id = v_sub_id for update;

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

  -- anular uma fatura vencida também encerra a dívida
  perform public.reconcile_subscription_billing_state(v_inv.subscription_id);

  return v_inv;
end;
$$;

create or replace function public.master_set_subscription_status(
  p_subscription_id uuid,
  p_status text,
  p_grace_until date
)
returns public.subscriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub public.subscriptions;
  v_old_status text;
  v_old_grace date;
  v_released boolean;
  v_void_initial uuid;
begin
  perform public.assert_master_admin();

  -- ORDEM ÚNICA DE TRAVAS (assinatura -> fatura): a assinatura é travada PRIMEIRO. Se a
  -- inicial for anulada (regra 5g), quem a trava é o trigger, DEPOIS — e pagar, anular
  -- e cancelar a mesma inicial se serializam todos pela trava da assinatura.
  select * into v_sub from public.subscriptions where id = p_subscription_id for update;
  if not found then raise exception 'assinatura não encontrada'; end if;
  if v_sub.status = 'canceled' then
    raise exception 'assinatura cancelada é definitiva; contrate novamente se necessário';
  end if;
  if p_status is null or p_status not in
     ('pending_payment','trialing','active','past_due','grace','restricted','suspended','canceled') then
    raise exception 'status inválido';
  end if;
  if p_grace_until is not null and p_status <> 'grace' then
    raise exception 'grace_until só se aplica ao status grace';
  end if;

  v_old_status := v_sub.status;
  v_old_grace := v_sub.grace_until;
  if v_old_status = p_status and v_old_grace is not distinct from p_grace_until then
    return v_sub;
  end if;

  if p_status = 'pending_payment' then
    raise exception 'aguardando pagamento é o estado da contratação e não pode ser definido manualmente';
  end if;
  if p_status = 'trialing' then
    raise exception 'o período grátis não é um status de assinatura: use o fluxo de período grátis da empresa';
  end if;
  if p_status in ('active', 'past_due', 'grace', 'restricted') then
    v_released := case when v_old_status = 'pending_payment'
                       then public.subscription_initial_charge_paid(v_sub.id)
                       else public.subscription_initial_charge_settled(v_sub.id) end;
    if not v_released then
      raise exception 'a cobrança inicial desta assinatura não está paga: ela só é ativada pelo pagamento da fatura inicial';
    end if;
  end if;

  -- Cancelamento ANTES da ativação (regra 5g): a inicial em aberto/vencida é anulada
  -- pelo trigger, na mesma transação; aqui só se sabe qual (mesmo critério do trigger).
  if p_status = 'canceled' then
    v_void_initial := public.initial_invoice_to_void_on_cancel(v_sub.id, v_old_status);
  end if;

  update public.subscriptions
  set status = p_status,
      grace_until = case when p_status = 'grace' then p_grace_until else null end,
      canceled_at = case when p_status = 'canceled' then now() else null end,
      status_source = 'manual'
  where id = v_sub.id
  returning * into v_sub;

  perform public.record_subscription_event(v_sub.id, 'status_changed', jsonb_build_object(
    'from', v_old_status, 'to', p_status, 'grace_until', v_sub.grace_until, 'source', 'manual'
  ) || case when v_void_initial is null then '{}'::jsonb
            else jsonb_build_object(
              'reason', 'canceled_before_activation',
              'initial_invoice_voided', true,
              'initial_invoice_id', v_void_initial) end);

  if p_status <> 'canceled' then
    perform public.reconcile_subscription_billing_state(v_sub.id);
    select * into v_sub from public.subscriptions where id = v_sub.id;
  end if;

  return v_sub;
end;
$$;

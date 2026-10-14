-- Módulo Delivery — totais na IMPRESSÃO. A pré-conta somava só os itens (25,00) enquanto o Caixa cobra itens + taxa (30,00);
-- o comprovante mostrava o total certo, mas sem a linha da taxa. Aqui as duas funções passam a enxergar delivery_orders.
--
--   enqueue_customer_bill     delivery: 'total' = itens + taxa; payload ganha fulfillment, subtotal e delivery_fee.
--   enqueue_payment_receipt   delivery: payload ganha fulfillment, subtotal (= total_amount - taxa) e delivery_fee.
--   Comanda/mesa: payload IDÊNTICO ao anterior (nenhuma chave nova). Retirada: fulfillment='pickup', delivery_fee 0,
--   total = subtotal (o Print Agent não mostra linha de taxa).
--   Delivery cancelado: a taxa conta 0 (mesmo critério do fechamento).
-- Só CREATE OR REPLACE (mesma assinatura e ACL) sobre o corpo vigente de cada função. Nada de regra financeira muda.

create or replace function public.enqueue_customer_bill(p_service_session_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.service_sessions;
  v_role public.company_role;
  v_items jsonb;
  v_total numeric(12, 2);
  v_fee numeric(12, 2);
  v_ful text;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_session from public.service_sessions where id = p_service_session_id;
  if not found then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  v_role := public.user_role_in_company(v_session.company_id);
  if v_role is null then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier', 'attendant') then
    raise exception 'Você não tem permissão para imprimir a conta.' using errcode = 'PT403';
  end if;

  -- Mesma base do fechamento: quantidade cobrável (quantity - cancelled_quantity) de pedidos enviados.
  select
    jsonb_agg(jsonb_build_object(
      'product_name', i.product_name_snapshot,
      'quantity', i.quantity - i.cancelled_quantity,
      'unit_price', i.unit_price,
      'base_unit_price', i.unit_price - i.modifiers_unit_total,
      'modifiers', public.item_modifiers_json(i.company_id, i.id, true),
      'total', (i.quantity - i.cancelled_quantity) * i.unit_price,
      'notes', i.notes
    ) order by i.created_at, i.product_name_snapshot, i.id),
    coalesce(sum((i.quantity - i.cancelled_quantity) * i.unit_price), 0)::numeric(12, 2)
    into v_items, v_total
  from public.service_orders o
  join public.service_order_items i on i.company_id = o.company_id and i.order_id = o.id
  where o.company_id = v_session.company_id
    and o.service_session_id = v_session.id
    and o.status = 'submitted'
    and i.quantity - i.cancelled_quantity > 0;

  if v_items is null then
    raise exception 'Esta conta ainda não tem itens.' using errcode = 'PT409';
  end if;

  -- DELIVERY: a taxa entra no total da pré-conta (o mesmo cálculo do fechamento). Comanda/mesa: nada muda.
  select d.fulfillment, case when d.delivery_status = 'canceled' then 0 else d.delivery_fee end
    into v_ful, v_fee
  from public.delivery_orders d
  where d.company_id = v_session.company_id and d.service_session_id = v_session.id;

  return public.enqueue_document_jobs(
    'customer_bill', v_session.company_id,
    public.print_session_header(v_session) || jsonb_build_object(
      'title', 'CONTA / PRÉ-CONTA',
      'items', v_items,
      'total', v_total + coalesce(v_fee, 0),
      'printed_at', now(),
      'requested_by', jsonb_build_object('name', public.print_actor_name(v_session.company_id, auth.uid())),
      'footer', 'Documento não fiscal'
    ) || case when v_ful is null then '{}'::jsonb
      else jsonb_build_object('fulfillment', v_ful, 'subtotal', v_total, 'delivery_fee', coalesce(v_fee, 0)) end,
    v_session.id, null
  );
end;
$$;

create or replace function public.enqueue_payment_receipt(p_service_session_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.service_sessions;
  v_role public.company_role;
  v_payments jsonb;
  v_refunds jsonb;
  v_paid numeric(12, 2);
  v_refunded numeric(12, 2);
  v_fee numeric(12, 2);
  v_ful text;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_session from public.service_sessions where id = p_service_session_id;
  if not found then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  v_role := public.user_role_in_company(v_session.company_id);
  if v_role is null then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier') then
    raise exception 'Você não tem permissão para imprimir o comprovante.' using errcode = 'PT403';
  end if;
  if v_session.status <> 'closed' then
    raise exception 'A conta ainda está aberta. O comprovante só pode ser impresso depois do pagamento.' using errcode = 'PT409';
  end if;

  -- Uma linha por pagamento (pagamento dividido mostra todas as formas); dinheiro leva entregue e troco.
  select jsonb_agg(jsonb_build_object(
           'method', p.payment_method,
           'label', case p.payment_method
                      when 'cash' then 'Dinheiro' when 'pix' then 'Pix' when 'debit_card' then 'Débito'
                      when 'credit_card' then 'Crédito' else 'Outros' end,
           'amount', p.amount,
           'amount_received', p.amount_received,
           'change_amount', p.change_amount
         ) order by array_position(array['cash', 'pix', 'debit_card', 'credit_card', 'other'], p.payment_method), p.created_at, p.id),
         coalesce(sum(p.amount), 0)::numeric(12, 2)
    into v_payments, v_paid
  from public.service_payments p
  where p.company_id = v_session.company_id and p.service_session_id = v_session.id;

  select jsonb_agg(jsonb_build_object(
           'amount', r.amount,
           'method', p.payment_method,
           'created_at', r.created_at
         ) order by r.created_at, r.id),
         coalesce(sum(r.amount), 0)::numeric(12, 2)
    into v_refunds, v_refunded
  from public.service_refunds r
  join public.service_payments p on p.company_id = r.company_id and p.id = r.service_payment_id
  where r.company_id = v_session.company_id and r.service_session_id = v_session.id;

  -- DELIVERY: total_amount já inclui a taxa; o comprovante a mostra à parte (subtotal + taxa = total).
  select d.fulfillment, case when d.delivery_status = 'canceled' then 0 else d.delivery_fee end
    into v_ful, v_fee
  from public.delivery_orders d
  where d.company_id = v_session.company_id and d.service_session_id = v_session.id;

  return public.enqueue_document_jobs(
    'payment_receipt', v_session.company_id,
    public.print_session_header(v_session) || jsonb_build_object(
      'title', 'COMPROVANTE DE PAGAMENTO',
      'total', v_session.total_amount,
      'payments', coalesce(v_payments, '[]'::jsonb),
      'paid_total', v_paid,
      'refunds', coalesce(v_refunds, '[]'::jsonb),
      'refunded_total', v_refunded,
      'net_total', v_paid - v_refunded,
      'printed_at', now(),
      'requested_by', jsonb_build_object('name', public.print_actor_name(v_session.company_id, auth.uid())),
      'footer', 'Documento não fiscal'
    ) || case when v_ful is null then '{}'::jsonb
      else jsonb_build_object('fulfillment', v_ful, 'delivery_fee', coalesce(v_fee, 0),
                              'subtotal', v_session.total_amount - coalesce(v_fee, 0)) end,
    v_session.id, null
  );
end;
$$;

-- FASE 4A — Delivery / Retirada DENTRO DO CAIXA: visibilidade das contas a receber + recebimento idempotente.
--
-- Princípio: NÃO existe financeiro paralelo. O recebimento continua sendo close_service_session (service_sessions kind='delivery',
-- service_payments, cash_movements, caixa aberto do operador, troco do servidor). Esta migration só:
--   1) deriva o STATUS FINANCEIRO (nada é gravado em delivery_orders): pending | paid | refunded | no_charge;
--   2) lista as contas de delivery/retirada para o Caixa, de QUALQUER data (pendentes) + as pagas recentes;
--   3) expõe financial_status/paid_amount em list_delivery_orders (corrige o rótulo "Pago" baseado só em payment_timing);
--   4) receive_delivery_order(): recebimento IDEMPOTENTE por client_request_id, que delega a close_service_session e grava o
--      evento de auditoria 'payment_received' (forma esperada x real, operador, horário) em delivery_order_events.
--
-- Status financeiro (derivado do estado oficial):
--   pending    sessão ABERTA, total > 0, pedido não cancelado (vale também antes da entrega: recebimento antecipado)
--   paid       sessão fechada com pagamento registrado, líquido > 0
--   refunded   estornos >= pagamentos (estorno total)
--   no_charge  cancelado, ou total zero (sessão aberta sem valor, ou fechada sem pagamento)
-- Estorno PARCIAL continua 'paid' (paid_amount traz o bruto; refunded_amount o estornado).
--
-- Fora daqui (de propósito): fiado/contas a receber, acerto do entregador, Pix/Meta/Asaas automáticos, estorno automático.

-- ---------------------------------------------------------------------------
-- 1) Auditoria: novo tipo de evento + no máximo UM recebimento por pedido
-- ---------------------------------------------------------------------------
alter table public.delivery_order_events drop constraint delivery_order_events_type_check;
alter table public.delivery_order_events add constraint delivery_order_events_type_check
  check (event_type in ('created', 'status_changed', 'courier_assigned', 'fee_overridden', 'canceled', 'payment_received'));

create unique index delivery_order_events_one_receipt_idx
  on public.delivery_order_events (company_id, delivery_order_id) where event_type = 'payment_received';

-- pendências de qualquer data: sessões de delivery ainda abertas
create index service_sessions_open_delivery_idx
  on public.service_sessions (company_id, opened_at) where kind = 'delivery' and status = 'open';

-- ---------------------------------------------------------------------------
-- 2) Status financeiro derivado (interna)
-- ---------------------------------------------------------------------------
create function public.delivery_financial_status(
  p_company_id uuid, p_session_id uuid, p_delivery_status text, p_session_status text, p_total numeric)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_delivery_status = 'canceled' then 'no_charge'
    when p_session_status = 'open' then case when coalesce(p_total, 0) > 0 then 'pending' else 'no_charge' end
    else (
      select case
        when s.paid = 0 then 'no_charge'
        when s.refunded >= s.paid then 'refunded'
        else 'paid'
      end
      from (
        select coalesce((select sum(p.amount) from public.service_payments p where p.company_id = p_company_id and p.service_session_id = p_session_id), 0) as paid,
               coalesce((select sum(r.amount) from public.service_refunds r where r.company_id = p_company_id and r.service_session_id = p_session_id), 0) as refunded
      ) s
    )
  end;
$$;
revoke execute on function public.delivery_financial_status(uuid, uuid, text, text, numeric) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) Contas de delivery/retirada para o Caixa
-- ---------------------------------------------------------------------------
-- Pendentes (qualquer data) + pagos/estornados nas últimas p_paid_hours horas. owner/admin/cashier (quem recebe).
create function public.list_delivery_receivables(p_company_id uuid, p_paid_hours integer default 24)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_hours integer := least(greatest(coalesce(p_paid_hours, 24), 0), 168);
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier') then
    raise exception 'Você não tem permissão para ver as contas de delivery e retirada.' using errcode = 'PT403';
  end if;
  perform public.assert_company_module(p_company_id, 'delivery');

  select coalesce(jsonb_agg(x.j order by x.sort_group, x.sort_at, x.id), '[]'::jsonb) into v_result
  from (
    select q.id, q.sort_group, q.sort_at,
      jsonb_build_object(
        'delivery_order_id', q.id,
        'service_session_id', q.service_session_id,
        'short_code', upper(left(replace(q.id::text, '-', ''), 6)),
        'fulfillment', q.fulfillment,
        'delivery_status', q.delivery_status,
        'customer_name', q.customer_name,
        'customer_phone', q.customer_phone,
        'items_subtotal', q.subtotal,
        'delivery_fee', case when q.delivery_status = 'canceled' then 0 else q.delivery_fee end,
        'total', q.total,
        'payment_timing', q.payment_timing,
        'expected_method', q.expected_method,
        'cash_change_for', q.cash_change_for,
        'financial_status', q.fin,
        'paid_amount', q.paid,
        'refunded_amount', q.refunded,
        'session_status', q.session_status,
        'created_at', q.created_at,
        'delivered_at', q.delivered_at,
        'picked_up_at', q.picked_up_at,
        'closed_at', q.closed_at
      ) as j
    from (
      select d.id, d.service_session_id, d.fulfillment, d.delivery_status, d.customer_name, d.customer_phone, d.delivery_fee,
             d.payment_timing, d.expected_method, d.cash_change_for, d.created_at, d.delivered_at, d.picked_up_at,
             ss.status as session_status, ss.closed_at, a.subtotal,
             case when d.delivery_status = 'canceled' then 0 else a.subtotal + d.delivery_fee end as total,
             public.delivery_financial_status(d.company_id, d.service_session_id, d.delivery_status, ss.status,
               case when d.delivery_status = 'canceled' then 0 else a.subtotal + d.delivery_fee end) as fin,
             coalesce((select sum(p.amount) from public.service_payments p where p.company_id = d.company_id and p.service_session_id = d.service_session_id), 0) as paid,
             coalesce((select sum(r.amount) from public.service_refunds r where r.company_id = d.company_id and r.service_session_id = d.service_session_id), 0) as refunded,
             -- pendentes: já entregues/retirados primeiro, depois os mais antigos; pagos: mais recentes primeiro
             case when ss.status = 'open' then (case when d.delivery_status in ('delivered', 'picked_up') then 0 else 1 end) else 2 end as sort_group,
             case when ss.status = 'open' then extract(epoch from d.created_at) else -extract(epoch from ss.closed_at) end as sort_at
      from public.delivery_orders d
      join public.service_sessions ss on ss.company_id = d.company_id and ss.id = d.service_session_id
      cross join lateral (
        select coalesce(sum((i.quantity - i.cancelled_quantity) * i.unit_price), 0)::numeric(12, 2) as subtotal
        from public.service_order_items i
        where i.company_id = d.company_id and i.order_id = d.service_order_id
      ) a
      where d.company_id = p_company_id
        and ss.kind = 'delivery'
        and d.delivery_status <> 'canceled'
        and (ss.status = 'open' or ss.closed_at >= now() - make_interval(hours => v_hours))
    ) q
    where q.fin in ('pending', 'paid', 'refunded')
    limit 300
  ) x;

  return v_result;
end;
$$;
revoke execute on function public.list_delivery_receivables(uuid, integer) from public, anon;
grant execute on function public.list_delivery_receivables(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) list_delivery_orders: + financial_status / paid_amount (corpo vigente de 20261014080000 + 2 chaves)
-- ---------------------------------------------------------------------------
create or replace function public.list_delivery_orders(
  p_company_id uuid,
  p_from date default null,
  p_to date default null,
  p_fulfillment text default null,
  p_status text default null,
  p_courier_user_id uuid default null,
  p_customer_id uuid default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_from date := coalesce(p_from, (now() at time zone 'America/Sao_Paulo')::date);
  v_to date := coalesce(p_to, coalesce(p_from, (now() at time zone 'America/Sao_Paulo')::date));
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_result jsonb;
begin
  v_role := public.delivery_assert_actor(p_company_id);
  if v_to < v_from then
    raise exception 'Período inválido.' using errcode = 'PT400';
  end if;
  if v_to - v_from > 62 then
    raise exception 'O período pode ter no máximo 63 dias.' using errcode = 'PT400';
  end if;
  if p_fulfillment is not null and p_fulfillment not in ('delivery', 'pickup') then
    raise exception 'Tipo inválido.' using errcode = 'PT400';
  end if;
  if p_status is not null and p_status not in ('confirmed', 'out_for_delivery', 'delivered', 'picked_up', 'canceled') then
    raise exception 'Estado inválido.' using errcode = 'PT400';
  end if;

  select coalesce(jsonb_agg(x.j order by x.created_at desc, x.id), '[]'::jsonb) into v_result
  from (
    select d.id, d.created_at,
      jsonb_build_object(
        'id', d.id,
        'service_session_id', d.service_session_id,
        'service_order_id', d.service_order_id,
        'fulfillment', d.fulfillment,
        'delivery_status', d.delivery_status,
        'production', case
            when a.active = 0 then null
            when a.ready = a.active then 'ready'
            when a.preparing > 0 or a.ready > 0 then 'preparing'
            else 'pending' end,
        'items_active', a.active,
        'items_ready', a.ready,
        'customer_id', d.customer_id,
        'customer_name', d.customer_name,
        'customer_phone', d.customer_phone,
        'address', case when d.fulfillment = 'delivery' then jsonb_build_object(
            'street', d.addr_street, 'number', d.addr_number, 'complement', d.addr_complement,
            'neighborhood', d.addr_neighborhood, 'city', d.addr_city, 'state', d.addr_state,
            'cep', d.addr_cep, 'reference', d.addr_reference) end,
        'delivery_fee', d.delivery_fee,
        'fee_source', d.fee_source,
        'items_subtotal', a.subtotal,
        'total', case when d.delivery_status = 'canceled' then 0 else a.subtotal + d.delivery_fee end,
        'estimated_ready_at', d.estimated_ready_at,
        'estimated_delivery_at', d.estimated_delivery_at,
        'payment_timing', d.payment_timing,
        'expected_method', d.expected_method,
        'cash_change_for', d.cash_change_for,
        'courier_user_id', d.courier_user_id,
        'courier_name', pr.full_name,
        'out_for_delivery_at', d.out_for_delivery_at,
        'delivered_at', d.delivered_at,
        'picked_up_at', d.picked_up_at,
        'canceled_at', d.canceled_at,
        'cancel_reason', d.cancel_reason,
        'notes', d.notes,
        'session_status', ss.status,
        -- financeiro DERIVADO do estado oficial da sessão/pagamentos (nada é gravado no pedido)
        'financial_status', public.delivery_financial_status(d.company_id, d.service_session_id, d.delivery_status, ss.status,
            case when d.delivery_status = 'canceled' then 0 else a.subtotal + d.delivery_fee end),
        'paid_amount', coalesce((select sum(p.amount) from public.service_payments p where p.company_id = d.company_id and p.service_session_id = d.service_session_id), 0),
        'created_at', d.created_at
      ) as j
    from public.delivery_orders d
    join public.service_sessions ss on ss.company_id = d.company_id and ss.id = d.service_session_id
    left join public.profiles pr on pr.user_id = d.courier_user_id
    cross join lateral (
      select count(*) filter (where i.quantity > i.cancelled_quantity)::integer as active,
             count(*) filter (where i.quantity > i.cancelled_quantity and i.production_status = 'ready')::integer as ready,
             count(*) filter (where i.quantity > i.cancelled_quantity and i.production_status = 'preparing')::integer as preparing,
             coalesce(sum((i.quantity - i.cancelled_quantity) * i.unit_price), 0)::numeric(12, 2) as subtotal
      from public.service_order_items i
      where i.company_id = d.company_id and i.order_id = d.service_order_id
    ) a
    where d.company_id = p_company_id
      and d.created_at >= (v_from::timestamp at time zone 'America/Sao_Paulo')
      and d.created_at < ((v_to + 1)::timestamp at time zone 'America/Sao_Paulo')
      and (v_role <> 'courier' or d.courier_user_id = auth.uid())
      and (p_fulfillment is null or d.fulfillment = p_fulfillment)
      and (p_status is null or d.delivery_status = p_status)
      and (p_courier_user_id is null or d.courier_user_id = p_courier_user_id)
      and (p_customer_id is null or d.customer_id = p_customer_id)
    order by d.created_at desc, d.id
    limit v_limit offset v_offset
  ) x;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Recebimento IDEMPOTENTE do delivery/retirada (delega a close_service_session)
-- ---------------------------------------------------------------------------
-- p_payments: o MESMO formato de close_service_session ([{method, amount, amount_received?}]). Troco, total, caixa aberto (PT412),
-- soma dos pagamentos e permissões são do núcleo oficial; aqui só entram: idempotência por client_request_id, recusa de pedido
-- cancelado e o evento de auditoria. Mesmo pedido + mesmo client_request_id => devolve o resultado já confirmado (replayed=true).
-- Outro client_request_id para um pedido já recebido => PT409 (nunca um segundo recebimento).
create function public.receive_delivery_order(p_delivery_order_id uuid, p_payments jsonb, p_client_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_do public.delivery_orders;
  v_role public.company_role;
  v_session public.service_sessions;
  v_ev public.delivery_order_events;
  v_paid jsonb;
  v_amount numeric(12, 2);
  v_change numeric(12, 2);
  v_cash uuid;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if p_client_request_id is null then
    raise exception 'Pedido de recebimento inválido.' using errcode = 'PT400';
  end if;
  select * into v_do from public.delivery_orders where id = p_delivery_order_id;
  if not found then
    raise exception 'Pedido de delivery não encontrado.' using errcode = 'PT404';
  end if;
  v_role := public.user_role_in_company(v_do.company_id);
  if v_role is null then
    raise exception 'Pedido de delivery não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier') then
    raise exception 'Você não tem permissão para receber contas.' using errcode = 'PT403';
  end if;
  perform public.assert_company_module(v_do.company_id, 'delivery');

  -- mesma ordem de locks do fechamento e do cancelamento: atendimento primeiro, pedido depois
  select * into v_session from public.service_sessions where company_id = v_do.company_id and id = v_do.service_session_id for update;
  select * into v_do from public.delivery_orders where id = p_delivery_order_id for update;

  select * into v_ev from public.delivery_order_events
   where company_id = v_do.company_id and delivery_order_id = v_do.id and event_type = 'payment_received';
  if found then
    if (v_ev.new_value ->> 'client_request_id')::uuid = p_client_request_id then
      return jsonb_build_object(
        'delivery_order_id', v_do.id, 'service_session_id', v_do.service_session_id, 'replayed', true,
        'financial_status', public.delivery_financial_status(v_do.company_id, v_do.service_session_id, v_do.delivery_status, v_session.status,
                                                              coalesce((v_ev.new_value ->> 'total')::numeric, 1)),
        'total', (v_ev.new_value ->> 'total')::numeric, 'paid_amount', (v_ev.new_value ->> 'paid_amount')::numeric,
        'change_amount', (v_ev.new_value ->> 'change_amount')::numeric, 'received_at', v_ev.created_at);
    end if;
    raise exception 'Este pedido já foi recebido.' using errcode = 'PT409';
  end if;
  if v_do.delivery_status = 'canceled' then
    raise exception 'Este pedido foi cancelado.' using errcode = 'PT409';
  end if;
  if v_session.status <> 'open' then
    raise exception 'Este atendimento já foi fechado.' using errcode = 'PT409';
  end if;

  -- núcleo OFICIAL: total, caixa aberto, troco, pagamentos, movimentos e fechamento (erro = tudo desfeito, sem evento)
  perform public.close_service_session(v_do.service_session_id, p_payments);

  select coalesce(jsonb_agg(jsonb_build_object('method', p.payment_method, 'amount', p.amount, 'amount_received', p.amount_received, 'change_amount', p.change_amount) order by p.created_at, p.id), '[]'::jsonb),
         coalesce(sum(p.amount), 0), coalesce(sum(p.change_amount), 0), min(p.cash_session_id::text)::uuid
    into v_paid, v_amount, v_change, v_cash
    from public.service_payments p where p.company_id = v_do.company_id and p.service_session_id = v_do.service_session_id;

  insert into public.delivery_order_events (company_id, delivery_order_id, event_type, actor_user_id, old_value, new_value)
  values (v_do.company_id, v_do.id, 'payment_received', auth.uid(),
          jsonb_build_object('expected_method', v_do.expected_method, 'payment_timing', v_do.payment_timing, 'cash_change_for', v_do.cash_change_for),
          jsonb_build_object('client_request_id', p_client_request_id, 'total', v_amount, 'paid_amount', v_amount, 'change_amount', v_change,
                             'payments', v_paid, 'cash_session_id', v_cash));

  return jsonb_build_object(
    'delivery_order_id', v_do.id, 'service_session_id', v_do.service_session_id, 'replayed', false,
    'financial_status', 'paid', 'total', v_amount, 'paid_amount', v_amount, 'change_amount', v_change, 'received_at', now());
end;
$$;
revoke execute on function public.receive_delivery_order(uuid, jsonb, uuid) from public, anon;
grant execute on function public.receive_delivery_order(uuid, jsonb, uuid) to authenticated;

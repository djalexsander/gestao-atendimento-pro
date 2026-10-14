-- Módulo Delivery, Fase 1 — M10: Realtime, Push, privacidade do entregador e relatório por origem.
-- Depende de 20261014070000/080000. Nenhuma migration anterior é alterada.
--
--   1. delivery_orders entra na publication supabase_realtime (a RLS da tabela vale no Realtime: o courier só
--      recebe os próprios pedidos). service_orders/itens/sessões já estavam publicados (produção, fechamento).
--   2. push_events aceita new_delivery_order, delivery_out_for_delivery e delivery_delivered (todos os tipos
--      anteriores preservados). Destinatários (push_role_receives, regra única do Web Push e do Desktop):
--        new_delivery_order          owner/admin/cashier/attendant, EXCETO quem criou (target_user_id = criador).
--                                    Produção NÃO recebe: já recebe new_order do mesmo pedido (sem duplicar).
--        delivery_out_for_delivery / delivery_delivered   só o CRIADOR do pedido (e só quando outra pessoa mudou o
--                                    estado: não notifica a própria ação). Sem spam para a equipe.
--      Disparo por trigger em delivery_orders (INSERT = novo; UPDATE de estado = em rota/entregue), com dedupe.
--   3. get_delivery_order: para o courier não devolve preço de item nem de modificador (só nomes, quantidades,
--      observações, status, troco e valor a receber do resumo).
--   4. report_period: sales ganha delivery_fee e product_revenue (gross NÃO muda: já inclui a taxa; product_revenue
--      = gross - delivery_fee, nunca se soma a taxa duas vezes) e o relatório ganha "origins" (point/delivery/pickup).


-- ---------------------------------------------------------------------------
-- 1) Realtime
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'delivery_orders'
  ) then
    alter publication supabase_realtime add table public.delivery_orders;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2) Push: tipos e destinatários
-- ---------------------------------------------------------------------------
alter table public.push_events drop constraint push_events_type_check;
alter table public.push_events add constraint push_events_type_check check (event_type in (
  'new_order', 'order_ready', 'order_cancelled_in_production', 'receivables_daily', 'payables_daily',
  'new_delivery_order', 'delivery_out_for_delivery', 'delivery_delivered'));

create or replace function public.push_role_receives(p_event_type text, p_role public.company_role, p_user_id uuid, p_target_user_id uuid)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case
    when p_event_type in ('new_order', 'order_cancelled_in_production') then p_role = 'production'
    when p_event_type = 'order_ready' then p_role = 'attendant' and p_user_id is not distinct from p_target_user_id
    when p_event_type in ('receivables_daily', 'payables_daily') then p_role in ('owner', 'admin')
    -- delivery: a equipe operacional, menos quem criou o pedido (target = criador)
    when p_event_type = 'new_delivery_order' then
      p_role in ('owner', 'admin', 'cashier', 'attendant') and p_user_id is distinct from p_target_user_id
    -- em rota / entregue: só o criador do pedido
    when p_event_type in ('delivery_out_for_delivery', 'delivery_delivered') then
      p_role in ('owner', 'admin', 'cashier', 'attendant') and p_user_id is not distinct from p_target_user_id
    else false
  end;
$$;

create function public.push_trg_delivery_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total numeric(12, 2);
begin
  select coalesce(sum((i.quantity - i.cancelled_quantity) * i.unit_price), 0)::numeric(12, 2) + new.delivery_fee into v_total
  from public.service_order_items i
  where i.company_id = new.company_id and i.order_id = new.service_order_id;

  perform public.push_enqueue_event(
    new.company_id, 'new_delivery_order', 'new-delivery:' || new.id,
    case when new.fulfillment = 'delivery' then 'Novo delivery' else 'Nova retirada' end,
    left(new.customer_name || ' · ' || coalesce(new.addr_neighborhood, 'Retirada') || ' · ' || public.push_format_brl(v_total), 300),
    '/operacional/delivery', new.service_order_id, new.service_session_id, null, new.created_by);
  return null;
exception when others then
  raise warning 'push_trg_delivery_created falhou para %: %', new.id, sqlerrm;
  return null;
end;
$$;

create function public.push_trg_delivery_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.delivery_status is not distinct from old.delivery_status
     or new.delivery_status not in ('out_for_delivery', 'delivered')
     or new.created_by is null
     or new.created_by is not distinct from auth.uid() then
    return null;
  end if;

  perform public.push_enqueue_event(
    new.company_id,
    case new.delivery_status when 'out_for_delivery' then 'delivery_out_for_delivery' else 'delivery_delivered' end,
    case new.delivery_status when 'out_for_delivery' then 'delivery-out:' else 'delivery-delivered:' end || new.id,
    case new.delivery_status when 'out_for_delivery' then 'Saiu para entrega' else 'Pedido entregue' end,
    left(new.customer_name || ' · ' || coalesce(new.addr_neighborhood, ''), 300),
    '/operacional/delivery', new.service_order_id, new.service_session_id, null, new.created_by);
  return null;
exception when others then
  raise warning 'push_trg_delivery_status falhou para %: %', new.id, sqlerrm;
  return null;
end;
$$;

revoke execute on function public.push_trg_delivery_created() from public, anon, authenticated;
revoke execute on function public.push_trg_delivery_status() from public, anon, authenticated;

create trigger push_delivery_created
  after insert on public.delivery_orders
  for each row execute function public.push_trg_delivery_created();

create trigger push_delivery_status
  after update of delivery_status on public.delivery_orders
  for each row execute function public.push_trg_delivery_status();

-- ---------------------------------------------------------------------------
-- 3) get_delivery_order sem preços para o entregador
-- ---------------------------------------------------------------------------
create or replace function public.get_delivery_order(p_delivery_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_do public.delivery_orders;
  v_role public.company_role;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_do from public.delivery_orders where id = p_delivery_order_id;
  if not found then
    raise exception 'Pedido de delivery não encontrado.' using errcode = 'PT404';
  end if;
  v_role := public.delivery_assert_actor(v_do.company_id);
  if v_role = 'courier' and v_do.courier_user_id is distinct from auth.uid() then
    raise exception 'Pedido de delivery não encontrado.' using errcode = 'PT404';
  end if;

  return jsonb_build_object(
    'order', to_jsonb(v_do) - 'client_request_id' - 'created_by',
    'summary', public.delivery_order_summary(v_do.id, false),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', i.id, 'name', i.product_name_snapshot, 'quantity', i.quantity, 'cancelled_quantity', i.cancelled_quantity,
          'unit_price', case when v_role = 'courier' then null else i.unit_price end, 'production_status', i.production_status, 'notes', i.notes,
          'modifiers', public.item_modifiers_json(i.company_id, i.id, v_role <> 'courier')) order by i.created_at, i.id)
      from public.service_order_items i
      where i.company_id = v_do.company_id and i.order_id = v_do.service_order_id), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
          'event_type', e.event_type, 'old_value', e.old_value, 'new_value', e.new_value, 'note', e.note,
          'created_at', e.created_at) order by e.created_at, e.id)
      from public.delivery_order_events e
      where e.company_id = v_do.company_id and e.delivery_order_id = v_do.id), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Entregadores ativos (para atribuir): operadores precisam do NOME, e company_users/profiles não são legíveis por eles
-- ---------------------------------------------------------------------------
create function public.list_delivery_couriers(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.delivery_assert_operator(p_company_id);
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', cu.user_id, 'name', coalesce(pr.full_name, 'Entregador'))
                     order by pr.full_name nulls last, cu.user_id)
    from public.company_users cu
    left join public.profiles pr on pr.user_id = cu.user_id
    where cu.company_id = p_company_id and cu.role = 'courier' and cu.status = 'active'
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.list_delivery_couriers(uuid) from public, anon;
grant execute on function public.list_delivery_couriers(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3b) Fila de produção: badge DELIVERY / RETIRADA (session_kind e fulfillment por item)
-- ---------------------------------------------------------------------------
create or replace function public.production_queue_base(
  p_company_id uuid,
  p_sector_id uuid default null,
  p_ready_limit integer default 15
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_limit integer := least(greatest(coalesce(p_ready_limit, 15), 0), 500);
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_start timestamptz := (v_today::timestamp) at time zone 'America/Sao_Paulo';
  v_active jsonb;
  v_ready jsonb;
  v_cancel jsonb;
  v_ready_total integer;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'production') then
    raise exception 'Você não tem permissão para ver a produção.' using errcode = 'PT403';
  end if;

  -- Pendentes e em preparo: todos (de qualquer dia), mais antigos primeiro.
  select coalesce(jsonb_agg(q.item order by q.submitted_at, q.item_created_at), '[]'::jsonb)
    into v_active
  from (
    select
      o.submitted_at,
      i.created_at as item_created_at,
      jsonb_build_object(
        'id', i.id,
        'order_id', i.order_id,
        'quantity', i.quantity - i.cancelled_quantity,
        'cancelled_quantity', i.cancelled_quantity,
        'name', i.product_name_snapshot,
        'notes', i.notes,
        'sector_id', i.production_sector_id,
        'sector_name', s.name,
        'status', i.production_status,
        'started_at', i.production_started_at,
        'ready_at', i.production_ready_at,
        'submitted_at', o.submitted_at,
        'submitted_date', (o.submitted_at at time zone 'America/Sao_Paulo')::date,
        'point_type', sp.type,
        'point_code', sp.code,
        'point_name', sp.display_name,
        'session_kind', ss.kind,
        'fulfillment', (select d.fulfillment from public.delivery_orders d where d.company_id = ss.company_id and d.service_session_id = ss.id),
        'customer_name', ss.customer_name,
        'sent_by_name', pr.full_name
      ) as item
    from public.service_order_items i
    join public.service_orders o on o.company_id = i.company_id and o.id = i.order_id
    join public.service_sessions ss on ss.company_id = o.company_id and ss.id = o.service_session_id
    left join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
    left join public.production_sectors s on s.company_id = i.company_id and s.id = i.production_sector_id
    left join public.profiles pr on pr.user_id = o.created_by
    where i.company_id = p_company_id
      and o.status = 'submitted'
      and i.quantity > i.cancelled_quantity
      and i.production_status <> 'ready'
      and (p_sector_id is null or i.production_sector_id = p_sector_id)
    order by o.submitted_at, i.created_at
    limit 500
  ) q;

  -- Prontos de HOJE: total do dia + os v_limit mais recentes.
  select count(*)::integer into v_ready_total
  from public.service_order_items i
  join public.service_orders o on o.company_id = i.company_id and o.id = i.order_id
  where i.company_id = p_company_id
    and o.status = 'submitted'
      and i.quantity > i.cancelled_quantity
    and i.production_status = 'ready'
    and i.production_ready_at >= v_start
    and (p_sector_id is null or i.production_sector_id = p_sector_id);

  select coalesce(jsonb_agg(q.item order by q.ready_at desc), '[]'::jsonb)
    into v_ready
  from (
    select
      i.production_ready_at as ready_at,
      jsonb_build_object(
        'id', i.id,
        'order_id', i.order_id,
        'quantity', i.quantity - i.cancelled_quantity,
        'cancelled_quantity', i.cancelled_quantity,
        'name', i.product_name_snapshot,
        'notes', i.notes,
        'sector_id', i.production_sector_id,
        'sector_name', s.name,
        'status', i.production_status,
        'started_at', i.production_started_at,
        'ready_at', i.production_ready_at,
        'submitted_at', o.submitted_at,
        'submitted_date', (o.submitted_at at time zone 'America/Sao_Paulo')::date,
        'point_type', sp.type,
        'point_code', sp.code,
        'point_name', sp.display_name,
        'session_kind', ss.kind,
        'fulfillment', (select d.fulfillment from public.delivery_orders d where d.company_id = ss.company_id and d.service_session_id = ss.id),
        'customer_name', ss.customer_name,
        'sent_by_name', pr.full_name
      ) as item
    from public.service_order_items i
    join public.service_orders o on o.company_id = i.company_id and o.id = i.order_id
    join public.service_sessions ss on ss.company_id = o.company_id and ss.id = o.service_session_id
    left join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
    left join public.production_sectors s on s.company_id = i.company_id and s.id = i.production_sector_id
    left join public.profiles pr on pr.user_id = o.created_by
    where i.company_id = p_company_id
      and o.status = 'submitted'
      and i.quantity > i.cancelled_quantity
      and i.production_status = 'ready'
      and i.production_ready_at >= v_start
      and (p_sector_id is null or i.production_sector_id = p_sector_id)
    order by i.production_ready_at desc
    limit v_limit
  ) q;

  -- Cancelamentos recentes (15 min) dos itens do filtro: o KDS avisa a cozinha (o item zerado some da
  -- fila, então o aviso vem do evento, não da lista).
  select coalesce(jsonb_agg(c.e order by c.created_at desc), '[]'::jsonb)
    into v_cancel
  from (
    select
      x.created_at,
      jsonb_build_object(
        'id', x.id,
        'quantity', x.quantity,
        'name', i.product_name_snapshot,
        'point_type', sp.type,
        'point_code', sp.code,
        'session_kind', ss.kind,
        'reason', x.reason,
        'created_at', x.created_at
      ) as e
    from public.service_order_item_cancellations x
    join public.service_order_items i on i.company_id = x.company_id and i.id = x.service_order_item_id
    join public.service_orders o on o.company_id = i.company_id and o.id = i.order_id
    join public.service_sessions ss on ss.company_id = o.company_id and ss.id = o.service_session_id
    left join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
    where x.company_id = p_company_id
      and x.created_at >= now() - interval '15 minutes'
      and (p_sector_id is null or i.production_sector_id = p_sector_id)
    order by x.created_at desc
    limit 20
  ) c;

  return jsonb_build_object(
    'cancellations', v_cancel,
    'today', v_today,
    'ready_total', v_ready_total,
    'items', v_active || v_ready
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) report_period: origem e taxa separada
-- ---------------------------------------------------------------------------
create or replace function public.report_period(
  p_company_id uuid,
  p_from date,
  p_to date,
  p_category_id uuid default null,
  p_sector_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_start timestamptz;
  v_end timestamptz;
  v_gross numeric(12, 2);
  v_sessions integer;
  v_refunded numeric(12, 2);
  v_items_sold bigint;
  v_methods jsonb;
  v_products jsonb;
  v_cancel jsonb;
  v_refunds jsonb;
  v_cash jsonb;
  v_production jsonb;
  v_fee numeric(12, 2);
  v_origins jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Você não tem permissão para ver relatórios.' using errcode = 'PT403';
  end if;

  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Informe um período válido (data inicial até a final).' using errcode = 'PT400';
  end if;
  if p_from < date '2000-01-01' or p_to > date '2100-01-01' or p_to - p_from > 365 then
    raise exception 'O período pode ter no máximo 366 dias.' using errcode = 'PT400';
  end if;

  v_start := (p_from::timestamp) at time zone 'America/Sao_Paulo';
  v_end := ((p_to + 1)::timestamp) at time zone 'America/Sao_Paulo';

  -- ---- vendas -----------------------------------------------------------------------------
  select coalesce(sum(total_amount), 0)::numeric(12, 2), count(*)::integer
    into v_gross, v_sessions
  from public.service_sessions
  where company_id = p_company_id and status = 'closed' and closed_at >= v_start and closed_at < v_end;

  -- Taxa de entrega das contas de delivery/retirada fechadas no período (não cancelados). Já está DENTRO de v_gross
  -- (total_amount = itens + taxa): aqui só se separa, nunca se soma de novo.
  select coalesce(sum(d.delivery_fee), 0)::numeric(12, 2) into v_fee
  from public.delivery_orders d
  join public.service_sessions ss on ss.company_id = d.company_id and ss.id = d.service_session_id
  where d.company_id = p_company_id and d.delivery_status <> 'canceled'
    and ss.status = 'closed' and ss.closed_at >= v_start and ss.closed_at < v_end;

  -- Vendas por ORIGEM (as 3 sempre presentes): point = comanda/mesa; delivery = entrega; pickup = retirada.
  select jsonb_agg(jsonb_build_object(
           'origin', o.origin,
           'sessions', coalesce(x.sessions, 0),
           'gross', coalesce(x.gross, 0),
           'delivery_fee', coalesce(x.fee, 0),
           'product_revenue', coalesce(x.gross, 0) - coalesce(x.fee, 0)
         ) order by o.ord)
    into v_origins
  from (values ('point', 1), ('delivery', 2), ('pickup', 3)) as o(origin, ord)
  left join (
    select case when ss.kind = 'point' then 'point' when d.fulfillment = 'pickup' then 'pickup' else 'delivery' end as origin,
           count(*)::integer as sessions,
           sum(ss.total_amount)::numeric(12, 2) as gross,
           sum(case when d.delivery_status is distinct from 'canceled' then coalesce(d.delivery_fee, 0) else 0 end)::numeric(12, 2) as fee
    from public.service_sessions ss
    left join public.delivery_orders d on d.company_id = ss.company_id and d.service_session_id = ss.id
    where ss.company_id = p_company_id and ss.status = 'closed' and ss.closed_at >= v_start and ss.closed_at < v_end
    group by 1
  ) x on x.origin = o.origin;

  select coalesce(sum(amount), 0)::numeric(12, 2) into v_refunded
  from public.service_refunds
  where company_id = p_company_id and created_at >= v_start and created_at < v_end;

  select coalesce(sum(i.quantity - i.cancelled_quantity), 0) into v_items_sold
  from public.service_order_items i
  join public.service_orders o on o.company_id = i.company_id and o.id = i.order_id
  join public.service_sessions ss on ss.company_id = o.company_id and ss.id = o.service_session_id
  where i.company_id = p_company_id and ss.status = 'closed' and ss.closed_at >= v_start and ss.closed_at < v_end;

  -- ---- formas de pagamento (todas as 5, mesmo zeradas) -------------------------------------
  select jsonb_agg(jsonb_build_object(
           'method', m.method,
           'paid', coalesce(p.paid, 0),
           'refunded', coalesce(r.refunded, 0),
           'net', coalesce(p.paid, 0) - coalesce(r.refunded, 0)
         ) order by m.ord)
    into v_methods
  from (values ('cash', 1), ('pix', 2), ('debit_card', 3), ('credit_card', 4), ('other', 5)) as m(method, ord)
  left join (
    select payment_method, sum(amount)::numeric(12, 2) as paid
    from public.service_payments
    where company_id = p_company_id and created_at >= v_start and created_at < v_end
    group by payment_method
  ) p on p.payment_method = m.method
  left join (
    select pay.payment_method, sum(rf.amount)::numeric(12, 2) as refunded
    from public.service_refunds rf
    join public.service_payments pay on pay.company_id = rf.company_id and pay.id = rf.service_payment_id
    where rf.company_id = p_company_id and rf.created_at >= v_start and rf.created_at < v_end
    group by pay.payment_method
  ) r on r.payment_method = m.method;

  -- ---- produtos vendidos (contas fechadas no período) --------------------------------------
  select coalesce(jsonb_agg(to_jsonb(x) order by x.value_net desc, x.name), '[]'::jsonb) into v_products
  from (
    select
      i.product_id,
      max(i.product_name_snapshot) as name,
      max(c.name) as category,
      sum(i.quantity - i.cancelled_quantity)::integer as quantity_valid,
      sum(i.quantity * i.unit_price)::numeric(12, 2) as value_gross,
      sum(i.cancelled_quantity)::integer as cancelled_quantity,
      sum(i.cancelled_quantity * i.unit_price)::numeric(12, 2) as cancelled_value,
      sum((i.quantity - i.cancelled_quantity) * i.unit_price)::numeric(12, 2) as value_net
    from public.service_order_items i
    join public.service_orders o on o.company_id = i.company_id and o.id = i.order_id
    join public.service_sessions ss on ss.company_id = o.company_id and ss.id = o.service_session_id
    left join public.products p on p.company_id = i.company_id and p.id = i.product_id
    left join public.product_categories c on c.company_id = p.company_id and c.id = p.category_id
    where i.company_id = p_company_id
      and ss.status = 'closed' and ss.closed_at >= v_start and ss.closed_at < v_end
      and (p_category_id is null or p.category_id = p_category_id)
      and (p_sector_id is null or i.production_sector_id = p_sector_id)
    group by i.product_id
    order by value_net desc
    limit 500
  ) x;

  -- ---- cancelamentos (eventos do período) --------------------------------------------------
  with cx as (
    select
      x.id,
      x.created_at,
      i.product_name_snapshot as product,
      x.quantity,
      (x.quantity * i.unit_price)::numeric(12, 2) as value,
      x.reason,
      pr.full_name as cancelled_by_name,
      sp.code as point_code,
      sp.type as point_type
    from public.service_order_item_cancellations x
    join public.service_order_items i on i.company_id = x.company_id and i.id = x.service_order_item_id
    join public.service_orders o on o.company_id = i.company_id and o.id = i.order_id
    join public.service_sessions ss on ss.company_id = o.company_id and ss.id = o.service_session_id
    left join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
    left join public.profiles pr on pr.user_id = x.cancelled_by
    where x.company_id = p_company_id and x.created_at >= v_start and x.created_at < v_end
  )
  select jsonb_build_object(
           'events', (select count(*) from cx),
           'quantity', (select coalesce(sum(quantity), 0) from cx),
           'value', (select coalesce(sum(value), 0)::numeric(12, 2) from cx),
           'list', (select coalesce(jsonb_agg(to_jsonb(l) order by l.created_at desc), '[]'::jsonb)
                    from (select * from cx order by created_at desc limit 500) l)
         )
    into v_cancel;

  -- ---- estornos (do período) ---------------------------------------------------------------
  with rx as (
    select
      rf.id,
      rf.created_at,
      pay.payment_method as method,
      rf.amount,
      rf.reason,
      pr.full_name as refunded_by_name,
      sp.code as point_code,
      sp.type as point_type
    from public.service_refunds rf
    join public.service_payments pay on pay.company_id = rf.company_id and pay.id = rf.service_payment_id
    join public.service_sessions ss on ss.company_id = rf.company_id and ss.id = rf.service_session_id
    left join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
    left join public.profiles pr on pr.user_id = rf.created_by
    where rf.company_id = p_company_id and rf.created_at >= v_start and rf.created_at < v_end
  )
  select jsonb_build_object(
           'count', (select count(*) from rx),
           'total', (select coalesce(sum(amount), 0)::numeric(12, 2) from rx),
           'list', (select coalesce(jsonb_agg(to_jsonb(l) order by l.created_at desc), '[]'::jsonb)
                    from (select * from rx order by created_at desc limit 500) l)
         )
    into v_refunds;

  -- ---- caixas (abertos no período; cada caixa à parte, nunca somados como uma gaveta só) ---
  with mv as (
    select
      cash_session_id,
      coalesce(sum(amount) filter (where movement_type = 'sale'), 0) as sales,
      coalesce(sum(amount) filter (where movement_type = 'supply'), 0) as supply,
      coalesce(sum(amount) filter (where movement_type = 'withdrawal'), 0) as withdrawal,
      coalesce(sum(amount) filter (where movement_type = 'refund'), 0) as refund
    from public.cash_movements
    where company_id = p_company_id
    group by cash_session_id
  ),
  cs as (
    select
      c.id,
      pr.full_name as operator_name,
      c.opened_at,
      c.closed_at,
      c.status,
      c.opening_amount,
      coalesce(mv.sales, 0)::numeric(12, 2) as sales,
      coalesce(mv.supply, 0)::numeric(12, 2) as supply,
      coalesce(mv.withdrawal, 0)::numeric(12, 2) as withdrawal,
      coalesce(mv.refund, 0)::numeric(12, 2) as refund,
      c.closing_cash_amount,
      c.cash_difference
    from public.cash_sessions c
    left join mv on mv.cash_session_id = c.id
    left join public.profiles pr on pr.user_id = c.opened_by
    where c.company_id = p_company_id and c.opened_at >= v_start and c.opened_at < v_end
  )
  select jsonb_build_object(
           'open_count', (select count(*) from cs where status = 'open'),
           'closed_count', (select count(*) from cs where status = 'closed'),
           'opening_total', (select coalesce(sum(opening_amount), 0)::numeric(12, 2) from cs),
           'sales_total', (select coalesce(sum(sales), 0)::numeric(12, 2) from cs),
           'supply_total', (select coalesce(sum(supply), 0)::numeric(12, 2) from cs),
           'withdrawal_total', (select coalesce(sum(withdrawal), 0)::numeric(12, 2) from cs),
           'refund_total', (select coalesce(sum(refund), 0)::numeric(12, 2) from cs),
           'shortage_total', (select coalesce(-sum(cash_difference) filter (where cash_difference < 0), 0)::numeric(12, 2) from cs),
           'surplus_total', (select coalesce(sum(cash_difference) filter (where cash_difference > 0), 0)::numeric(12, 2) from cs),
           'list', (select coalesce(jsonb_agg(to_jsonb(l) order by l.opened_at desc), '[]'::jsonb)
                    from (select * from cs order by opened_at desc limit 200) l)
         )
    into v_cash;

  -- ---- produção (itens prontos no período) -------------------------------------------------
  with px as (
    select
      i.product_name_snapshot as name,
      coalesce(s.name, 'Sem setor') as sector,
      (i.quantity - i.cancelled_quantity) as qty,
      -- Duração REAL de produção: início do preparo -> pronto. Item que foi direto de pending para ready
      -- (sem production_started_at) continua contando como produzido, mas NÃO entra na média (não se
      -- inventa duração; nunca usa o horário do pedido como fallback).
      case
        when i.production_started_at is not null and i.production_ready_at >= i.production_started_at
        then extract(epoch from (i.production_ready_at - i.production_started_at)) / 60.0
      end as minutes
    from public.service_order_items i
    join public.service_orders o on o.company_id = i.company_id and o.id = i.order_id
    left join public.products p on p.company_id = i.company_id and p.id = i.product_id
    left join public.production_sectors s on s.company_id = i.company_id and s.id = i.production_sector_id
    where i.company_id = p_company_id
      and o.status = 'submitted'
      and i.quantity > i.cancelled_quantity
      and i.production_status = 'ready'
      and i.production_ready_at >= v_start and i.production_ready_at < v_end
      and (p_category_id is null or p.category_id = p_category_id)
      and (p_sector_id is null or i.production_sector_id = p_sector_id)
  )
  select jsonb_build_object(
           'items', (select coalesce(sum(qty), 0) from px),
           'avg_minutes', (select round(avg(minutes))::integer from px),
           'by_product', (select coalesce(jsonb_agg(to_jsonb(b) order by b.quantity desc, b.name), '[]'::jsonb)
                          from (select name, sum(qty)::integer as quantity from px group by name order by sum(qty) desc limit 100) b),
           'by_sector', (select coalesce(jsonb_agg(to_jsonb(b) order by b.quantity desc, b.sector), '[]'::jsonb)
                         from (select sector, sum(qty)::integer as quantity from px group by sector) b),
           -- cancelamentos de itens que JÁ estavam em produção (preparing/ready) no período
           'cancelled_in_production', (
             select coalesce(sum(x.quantity), 0)
             from public.service_order_item_cancellations x
             join public.service_order_items i on i.company_id = x.company_id and i.id = x.service_order_item_id
             where x.company_id = p_company_id and x.created_at >= v_start and x.created_at < v_end
               and i.production_status <> 'pending'
               and (p_sector_id is null or i.production_sector_id = p_sector_id)
           )
         )
    into v_production;

  return jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'sales', jsonb_build_object(
      'gross', v_gross,
      'refunded', v_refunded,
      'net', v_gross - v_refunded,
      'sessions', v_sessions,
      'ticket', case when v_sessions > 0 then round(v_gross / v_sessions, 2) else null end,
      'items_sold', v_items_sold,
      'delivery_fee', v_fee,
      'product_revenue', v_gross - v_fee
    ),
    'origins', v_origins,
    'methods', coalesce(v_methods, '[]'::jsonb),
    'products', v_products,
    'cancellations', v_cancel,
    'refunds', v_refunds,
    'cash', v_cash,
    'production', v_production
  );
end;
$$;

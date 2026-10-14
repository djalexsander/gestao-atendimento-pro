-- Módulo Delivery, bloco estrutural (continuação de 20261014020000): service_sessions.service_point_id
-- passou a aceitar NULL (kind = 'delivery'), então TODO caminho que fazia INNER JOIN com service_points
-- eliminaria silenciosamente a sessão de delivery (fila de produção, histórico, relatórios, impressão,
-- push, rótulos do caixa/estorno). Aqui cada um passa a LEFT JOIN, com rótulo 'Delivery' quando não há
-- ponto. Para as sessões de comanda/mesa (kind = 'point') o resultado é EXATAMENTE o mesmo de antes.
--
-- Só CREATE OR REPLACE com a MESMA assinatura (e, portanto, a mesma ACL) da última definição de cada
-- função; nenhum outro trecho do corpo foi alterado:
--   production_queue_base      3 joins -> left join; cada item da fila ganha 'session_kind'
--   production_history_base    1 join  -> left join
--   report_period              3 joins -> left join (itens, cancelamentos, estornos)
--   enqueue_order_print_jobs / enqueue_cancellation_print_jobs   join -> left join; label 'Delivery'
--   record_print_enqueue_failure, print_session_header, push_session_label   idem
--   close_service_session / refund_service_payment   rótulo do movimento ('Venda - Delivery'); o
--      fechamento NÃO exigia ponto (o total soma pedidos da sessão), só o rótulo dependia dele.
-- Fora do escopo desta migration (de propósito): taxa/total do delivery, payload de delivery na
-- impressão, badge visual e filtros de origem.

-- production_queue (base: 20260930070000_order_cancellation_refunds.sql:482)
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

-- production_history (base: 20260930100000_report_metrics_fix.sql:306)
create or replace function public.production_history_base(
  p_company_id uuid,
  p_date date default null,
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
  v_day date := coalesce(p_date, (now() at time zone 'America/Sao_Paulo')::date);
  v_start timestamptz;
  v_end timestamptz;
  v_result jsonb;
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

  if v_day < date '2000-01-01' or v_day > date '2100-01-01' then
    raise exception 'Data inválida.' using errcode = 'PT400';
  end if;

  v_start := (v_day::timestamp) at time zone 'America/Sao_Paulo';
  v_end := ((v_day + 1)::timestamp) at time zone 'America/Sao_Paulo';

  with base as (
    select
      i.id,
      i.order_id,
      i.quantity - i.cancelled_quantity as quantity,
      i.product_name_snapshot as name,
      i.notes,
      i.production_sector_id as sector_id,
      s.name as sector_name,
      i.production_started_at as started_at,
      i.production_ready_at as ready_at,
      o.submitted_at,
      sp.type as point_type,
      sp.code as point_code,
      sp.display_name as point_name,
      ss.customer_name,
      pr.full_name as sent_by_name,
      -- Duração REAL de preparo: início -> pronto (exata, em minutos). Item direto de pending para ready
      -- (sem production_started_at) fica com NULL: continua no histórico e nas contagens, mas não tem
      -- duração nem entra na média. Nunca usa o horário do pedido como fallback.
      case
        when i.production_started_at is not null and i.production_ready_at >= i.production_started_at
        then extract(epoch from (i.production_ready_at - i.production_started_at)) / 60.0
      end as minutes_exact
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
      and i.production_ready_at < v_end
      and (p_sector_id is null or i.production_sector_id = p_sector_id)
  )
  select jsonb_build_object(
    'date', v_day,
    'items', (
      select coalesce(jsonb_agg((to_jsonb(x) - 'minutes_exact') || jsonb_build_object('minutes', round(x.minutes_exact)::integer) order by x.ready_at desc), '[]'::jsonb)
      from (select * from base order by ready_at desc limit 500) x
    ),
    'summary', jsonb_build_object(
      'items', (select count(*) from base),
      'orders', (select count(distinct order_id) from base),
      'avg_minutes', (select round(avg(minutes_exact))::integer from base),
      'by_sector', (
        select coalesce(jsonb_agg(b order by b.items desc, b.name), '[]'::jsonb)
        from (
          select sector_id, coalesce(sector_name, 'Sem setor') as name, count(*)::integer as items
          from base
          group by sector_id, sector_name
        ) b
      )
    )
  ) into v_result;

  return v_result;
end;
$$;

-- report_period (base: 20260930100000_report_metrics_fix.sql:20)
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
      'items_sold', v_items_sold
    ),
    'methods', coalesce(v_methods, '[]'::jsonb),
    'products', v_products,
    'cancellations', v_cancel,
    'refunds', v_refunds,
    'cash', v_cash,
    'production', v_production
  );
end;
$$;

-- enqueue_order_print_jobs (base: 20261002010000_product_modifiers.sql:640)
create or replace function public.enqueue_order_print_jobs(p_order_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.service_orders;
  v_point_type text;
  v_point_code text;
  v_point_name text;
  v_customer text;
  v_operator text;
  v_device public.print_devices;
  v_full boolean;
  v_items jsonb;
  v_job_id uuid;
  v_created integer := 0;
begin
  select * into v_order from public.service_orders where id = p_order_id;
  if not found then
    return 0;
  end if;

  select sp.type, sp.code, sp.display_name, ss.customer_name
    into v_point_type, v_point_code, v_point_name, v_customer
  from public.service_sessions ss
  left join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
  where ss.company_id = v_order.company_id and ss.id = v_order.service_session_id;

  v_operator := public.print_actor_name(v_order.company_id, v_order.created_by);

  -- FOR SHARE: arquivar/editar rotas (FOR UPDATE) não corre junto de um pedido sendo roteado.
  for v_device in
    select * from public.print_devices
    where company_id = v_order.company_id and is_ready
    order by id
    for share
  loop
    select exists (
      select 1 from public.print_device_routes r where r.print_device_id = v_device.id and r.route_type = 'full_order'
    ) into v_full;

    select jsonb_agg(
             jsonb_build_object(
               'service_order_item_id', i.id,
               'product_name', i.product_name_snapshot,
               'quantity', i.quantity - i.cancelled_quantity,
               'notes', i.notes,
               'modifiers', public.item_modifiers_json(i.company_id, i.id, false),
               'sector', case when s.id is null then null else jsonb_build_object('id', s.id, 'name', s.name) end
             ) order by i.created_at, i.id)
      into v_items
    from public.service_order_items i
    left join public.production_sectors s on s.company_id = i.company_id and s.id = i.production_sector_id
    where i.company_id = v_order.company_id
      and i.order_id = v_order.id
      and i.quantity - i.cancelled_quantity > 0
      and (
        v_full
        or (i.production_sector_id is not null and exists (
          select 1 from public.print_device_routes r
          where r.print_device_id = v_device.id
            and r.route_type = 'production_sector'
            and r.production_sector_id = i.production_sector_id
        ))
      );

    if v_items is null then
      continue;
    end if;

    v_job_id := null;
    insert into public.print_jobs (company_id, print_device_id, job_type, service_order_id, payload, created_by)
    values (
      v_order.company_id, v_device.id, 'production_order', v_order.id,
      public.print_base_payload('production_order', v_device) || jsonb_build_object(
        'order', jsonb_build_object('id', v_order.id, 'origin', v_order.origin),
        'service_point', jsonb_build_object(
          'type', v_point_type, 'code', v_point_code, 'display_name', v_point_name,
          'label', case when v_point_type is null then 'Delivery' when v_point_type = 'table' then 'Mesa ' || v_point_code else 'Comanda ' || v_point_code end
        ),
        'customer_name', v_customer,
        'operator', jsonb_build_object('name', v_operator),
        'sent_at', v_order.submitted_at,
        'scope', case when v_full then 'full_order' else 'production_sector' end,
        'items', v_items
      ),
      v_order.created_by
    )
    on conflict (print_device_id, service_order_id)
      where job_type = 'production_order' and reprint_of_id is null
      do nothing
    returning id into v_job_id;

    if v_job_id is null then
      continue;
    end if;

    insert into public.print_job_items (company_id, print_job_id, service_order_item_id, quantity)
    select v_order.company_id, v_job_id, (e ->> 'service_order_item_id')::uuid, (e ->> 'quantity')::integer
    from jsonb_array_elements(v_items) e;

    v_created := v_created + 1;
  end loop;

  return v_created;
end;
$$;

-- enqueue_cancellation_print_jobs (base: 20261002010000_product_modifiers.sql:750)
create or replace function public.enqueue_cancellation_print_jobs(p_cancellation_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c public.service_order_item_cancellations;
  v_item public.service_order_items;
  v_order public.service_orders;
  v_point_type text;
  v_point_code text;
  v_point_name text;
  v_customer text;
  v_sector jsonb;
  v_device public.print_devices;
  v_job_id uuid;
  v_by text;
  v_created integer := 0;
begin
  select * into v_c from public.service_order_item_cancellations where id = p_cancellation_id;
  if not found then
    return 0;
  end if;

  select * into v_item from public.service_order_items where company_id = v_c.company_id and id = v_c.service_order_item_id;
  select * into v_order from public.service_orders where company_id = v_item.company_id and id = v_item.order_id;

  select sp.type, sp.code, sp.display_name, ss.customer_name
    into v_point_type, v_point_code, v_point_name, v_customer
  from public.service_sessions ss
  left join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
  where ss.company_id = v_order.company_id and ss.id = v_order.service_session_id;

  select jsonb_build_object('id', s.id, 'name', s.name) into v_sector
  from public.production_sectors s
  where s.company_id = v_item.company_id and s.id = v_item.production_sector_id;

  v_by := public.print_actor_name(v_c.company_id, v_c.cancelled_by);

  for v_device in
    select d.* from public.print_devices d
    where d.company_id = v_c.company_id
      and d.is_ready
      and d.id in (
        select pj.print_device_id
        from public.print_job_items pji
        join public.print_jobs pj on pj.company_id = pji.company_id and pj.id = pji.print_job_id
        where pji.company_id = v_c.company_id
          and pji.service_order_item_id = v_c.service_order_item_id
          and pj.job_type = 'production_order'
          and pj.reprint_of_id is null
      )
    order by d.id
    for share
  loop
    v_job_id := null;
    insert into public.print_jobs (company_id, print_device_id, job_type, service_order_id, cancellation_id, payload, created_by)
    values (
      v_c.company_id, v_device.id, 'production_cancellation', v_order.id, v_c.id,
      public.print_base_payload('production_cancellation', v_device) || jsonb_build_object(
        'order', jsonb_build_object('id', v_order.id, 'origin', v_order.origin),
        'service_point', jsonb_build_object(
          'type', v_point_type, 'code', v_point_code, 'display_name', v_point_name,
          'label', case when v_point_type is null then 'Delivery' when v_point_type = 'table' then 'Mesa ' || v_point_code else 'Comanda ' || v_point_code end
        ),
        'customer_name', v_customer,
        'sent_at', v_order.submitted_at,
        'reason', v_c.reason,
        'cancelled_by', jsonb_build_object('name', v_by),
        'cancelled_at', v_c.created_at,
        'items', jsonb_build_array(jsonb_build_object(
          'service_order_item_id', v_item.id,
          'product_name', v_item.product_name_snapshot,
          'quantity', v_c.quantity,
          'notes', v_item.notes,
          'modifiers', public.item_modifiers_json(v_item.company_id, v_item.id, false),
          'sector', v_sector
        ))
      ),
      v_c.cancelled_by
    )
    on conflict (print_device_id, cancellation_id)
      where job_type = 'production_cancellation' and reprint_of_id is null
      do nothing
    returning id into v_job_id;

    if v_job_id is null then
      continue;
    end if;

    insert into public.print_job_items (company_id, print_job_id, service_order_item_id, quantity)
    values (v_c.company_id, v_job_id, v_item.id, v_c.quantity);

    v_created := v_created + 1;
  end loop;

  return v_created;
end;
$$;

-- record_print_enqueue_failure (base: 20261001010000_printing_foundation.sql:964)
create or replace function public.record_print_enqueue_failure(
  p_company_id uuid,
  p_event_type text,
  p_service_order_id uuid,
  p_cancellation_id uuid,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_label text;
begin
  begin
    select case when sp.id is null then 'Delivery' when sp.type = 'table' then 'Mesa ' || sp.code else 'Comanda ' || sp.code end into v_label
    from public.service_orders o
    join public.service_sessions ss on ss.company_id = o.company_id and ss.id = o.service_session_id
    left join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
    where o.company_id = p_company_id and o.id = p_service_order_id;

    insert into public.print_enqueue_failures (
      company_id, event_type, service_order_id, cancellation_id, summary, error_message
    ) values (
      p_company_id, p_event_type, p_service_order_id, p_cancellation_id,
      (case when p_event_type = 'production_order' then 'Pedido' else 'Cancelamento de item' end)
        || coalesce(' da ' || v_label, ''),
      left(p_error, 500)
    );
  exception when others then
    raise warning 'Falha ao registrar print_enqueue_failures: %', sqlerrm;
  end;
end;
$$;

-- print_session_header (base: 20261001010000_printing_foundation.sql:1104)
create or replace function public.print_session_header(p_session public.service_sessions)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'service_point', jsonb_build_object(
      'type', sp.type, 'code', sp.code, 'display_name', sp.display_name,
      'label', case when sp.id is null then 'Delivery' when sp.type = 'table' then 'Mesa ' || sp.code else 'Comanda ' || sp.code end
    ),
    'customer_name', p_session.customer_name,
    'session', jsonb_build_object('id', p_session.id, 'status', p_session.status,
                                  'opened_at', p_session.opened_at, 'closed_at', p_session.closed_at)
  )
  from (select 1) one
  left join public.service_points sp
    on sp.company_id = p_session.company_id and sp.id = p_session.service_point_id;
$$;

-- push_session_label (base: 20261004040000_push_events_dispatch.sql:152)
create or replace function public.push_session_label(p_company_id uuid, p_session_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when sp.id is null then 'Delivery' when sp.type = 'table' then 'Mesa ' || sp.code else 'Comanda ' || sp.code end
  from public.service_sessions ss
  left join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
  where ss.company_id = p_company_id and ss.id = p_session_id;
$$;

-- close_service_session (base: 20260930070000_order_cancellation_refunds.sql:252)
create or replace function public.close_service_session(p_service_session_id uuid, p_payments jsonb default '[]'::jsonb)
returns public.service_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.service_sessions;
  v_point public.service_points;
  v_role public.company_role;
  v_cash public.cash_sessions;
  v_total numeric(12, 2);
  v_paid numeric := 0;
  v_p jsonb;
  v_method text;
  v_amount numeric;
  v_received numeric;
  v_change numeric;
  v_payment public.service_payments;
  v_label text;
  v_fmt text;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  -- Trava o atendimento: cliques repetidos/concorrentes esperam aqui e enxergam 'closed'.
  select * into v_session from public.service_sessions where id = p_service_session_id for update;
  if not found then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;

  v_role := public.user_role_in_company(v_session.company_id);
  if v_role is null then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier') then
    raise exception 'Você não tem permissão para fechar contas.' using errcode = 'PT403';
  end if;

  if v_session.status <> 'open' then
    raise exception 'Este atendimento já foi fechado.' using errcode = 'PT409';
  end if;

  -- Total REAL, pelos snapshots persistidos (nunca do cliente), sobre a quantidade COBRÁVEL
  -- (quantity - cancelled_quantity): item cancelado não entra na conta.
  select coalesce(sum((i.quantity - i.cancelled_quantity) * i.unit_price), 0)::numeric(12, 2) into v_total
  from public.service_orders o
  join public.service_order_items i on i.company_id = o.company_id and i.order_id = o.id
  where o.company_id = v_session.company_id
    and o.service_session_id = v_session.id
    and o.status = 'submitted';

  v_fmt := 'R$ ' || replace(to_char(v_total, 'FM9999999990.00'), '.', ',');

  if p_payments is null or jsonb_typeof(p_payments) <> 'array' then
    raise exception 'Informe os pagamentos.' using errcode = 'PT400';
  end if;
  if jsonb_array_length(p_payments) > 20 then
    raise exception 'Informe no máximo 20 pagamentos.' using errcode = 'PT400';
  end if;

  if v_total = 0 then
    if jsonb_array_length(p_payments) > 0 then
      raise exception 'Esta conta não tem valor a receber (total %).', v_fmt using errcode = 'PT400';
    end if;
  else
    if jsonb_array_length(p_payments) = 0 then
      raise exception 'Informe o pagamento. Total da conta: %.', v_fmt using errcode = 'PT400';
    end if;

    -- Caixa ABERTO do próprio operador (travado contra o fechamento do caixa em paralelo).
    select * into v_cash
    from public.cash_sessions
    where company_id = v_session.company_id and opened_by = auth.uid() and status = 'open'
    for share;
    if not found then
      raise exception 'Abra o caixa antes de receber esta conta.' using errcode = 'PT412';
    end if;
  end if;

  select * into v_point from public.service_points
  where id = v_session.service_point_id and company_id = v_session.company_id;
  v_label := case when v_point.id is null then 'Delivery' when v_point.type = 'table' then 'Mesa ' || coalesce(v_point.code, '') else 'Comanda ' || coalesce(v_point.code, '') end;

  -- Valida TODOS os pagamentos antes de gravar qualquer coisa.
  for v_p in select * from jsonb_array_elements(p_payments) loop
    if jsonb_typeof(v_p) <> 'object' then
      raise exception 'Pagamento inválido.' using errcode = 'PT400';
    end if;
    v_method := v_p ->> 'method';
    if v_method is null or v_method not in ('cash', 'pix', 'debit_card', 'credit_card', 'other') then
      raise exception 'Forma de pagamento inválida.' using errcode = 'PT400';
    end if;
    if jsonb_typeof(v_p -> 'amount') is distinct from 'number' then
      raise exception 'Valor do pagamento inválido.' using errcode = 'PT400';
    end if;
    v_amount := (v_p ->> 'amount')::numeric;
    if v_amount <= 0 or v_amount >= 10000000000 or v_amount <> round(v_amount, 2) then
      raise exception 'O valor de cada pagamento deve ser maior que zero, com até 2 casas decimais.' using errcode = 'PT400';
    end if;
    if v_p ? 'amount_received' and jsonb_typeof(v_p -> 'amount_received') not in ('number', 'null') then
      raise exception 'Valor recebido inválido.' using errcode = 'PT400';
    end if;
    if jsonb_typeof(v_p -> 'amount_received') = 'number' then
      v_received := (v_p ->> 'amount_received')::numeric;
      if v_method <> 'cash' then
        raise exception 'Só o pagamento em dinheiro tem valor recebido e troco.' using errcode = 'PT400';
      end if;
      if v_received < v_amount or v_received >= 10000000000 or v_received <> round(v_received, 2) then
        raise exception 'O valor recebido em dinheiro deve ser igual ou maior que o valor aplicado.' using errcode = 'PT400';
      end if;
    end if;
    v_paid := v_paid + v_amount;
  end loop;

  if v_paid < v_total then
    raise exception 'Pagamento insuficiente. Total da conta: %.', v_fmt using errcode = 'PT400';
  end if;
  if v_paid > v_total then
    raise exception 'Os pagamentos ultrapassam o total da conta (%).', v_fmt using errcode = 'PT400';
  end if;

  -- Grava pagamentos + movimentos (um por forma de pagamento).
  for v_p in select * from jsonb_array_elements(p_payments) loop
    v_method := v_p ->> 'method';
    v_amount := (v_p ->> 'amount')::numeric;
    if v_method = 'cash' then
      v_received := coalesce((v_p ->> 'amount_received')::numeric, v_amount);
      v_change := v_received - v_amount;
    else
      v_received := null;
      v_change := 0;
    end if;

    insert into public.service_payments (
      company_id, service_session_id, cash_session_id, payment_method, amount, amount_received, change_amount, created_by
    ) values (
      v_session.company_id, v_session.id, v_cash.id, v_method, v_amount, v_received, v_change, auth.uid()
    ) returning * into v_payment;

    insert into public.cash_movements (
      company_id, cash_session_id, service_session_id, service_payment_id,
      movement_type, payment_method, amount, description, created_by
    ) values (
      v_session.company_id, v_cash.id, v_session.id, v_payment.id,
      'sale', v_method, v_amount, 'Venda - ' || v_label, auth.uid()
    );
  end loop;

  update public.service_sessions
     set status = 'closed', closed_at = now(), closed_by = auth.uid(), total_amount = v_total
   where id = v_session.id
  returning * into v_session;

  return v_session;
end;
$$;

-- refund_service_payment (base: 20260930070000_order_cancellation_refunds.sql:945)
create or replace function public.refund_service_payment(
  p_service_payment_id uuid,
  p_amount numeric,
  p_reason text
)
returns public.service_refunds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pay public.service_payments;
  v_status text;
  v_role public.company_role;
  v_cash public.cash_sessions;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_refunded numeric(12, 2);
  v_available numeric(12, 2);
  v_point public.service_points;
  v_label text;
  v_refund public.service_refunds;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_pay from public.service_payments where id = p_service_payment_id for update;
  if not found then
    raise exception 'Pagamento não encontrado.' using errcode = 'PT404';
  end if;

  v_role := public.user_role_in_company(v_pay.company_id);
  if v_role is null then
    raise exception 'Pagamento não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Somente o dono ou um administrador pode estornar pagamentos.' using errcode = 'PT403';
  end if;

  select ss.status into v_status
  from public.service_sessions ss
  where ss.company_id = v_pay.company_id and ss.id = v_pay.service_session_id;
  if v_status is distinct from 'closed' then
    raise exception 'Só é possível estornar pagamentos de contas fechadas.' using errcode = 'PT409';
  end if;
  select sp.* into v_point
  from public.service_sessions ss
  left join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
  where ss.company_id = v_pay.company_id and ss.id = v_pay.service_session_id;
  v_label := case when v_point.id is null then 'Delivery' when v_point.type = 'table' then 'Mesa ' || coalesce(v_point.code, '') else 'Comanda ' || coalesce(v_point.code, '') end;

  if p_amount is null or p_amount <= 0 or p_amount >= 10000000000 or p_amount <> round(p_amount, 2) then
    raise exception 'Informe um valor maior que zero, com até 2 casas decimais.' using errcode = 'PT400';
  end if;
  if v_reason is null then
    raise exception 'Informe o motivo do estorno.' using errcode = 'PT400';
  end if;
  if char_length(v_reason) > 200 then
    raise exception 'O motivo pode ter no máximo 200 caracteres.' using errcode = 'PT400';
  end if;

  select * into v_cash
  from public.cash_sessions
  where company_id = v_pay.company_id and opened_by = auth.uid() and status = 'open'
  for update;
  if not found then
    raise exception 'Abra seu caixa antes de realizar o estorno.' using errcode = 'PT412';
  end if;

  select coalesce(sum(amount), 0) into v_refunded
  from public.service_refunds
  where company_id = v_pay.company_id and service_payment_id = v_pay.id;

  v_available := v_pay.amount - v_refunded;
  if p_amount > v_available then
    raise exception 'Valor do estorno maior que o disponível para estorno (R$ %).',
      replace(to_char(v_available, 'FM9999999990.00'), '.', ',') using errcode = 'PT400';
  end if;

  if v_pay.payment_method = 'cash' and p_amount > public.cash_session_physical_cash(v_cash.id) then
    raise exception 'Dinheiro insuficiente no caixa para este estorno. Faça um suprimento antes.' using errcode = 'PT400';
  end if;

  insert into public.service_refunds (
    company_id, service_session_id, service_payment_id, cash_session_id, amount, reason, created_by
  ) values (
    v_pay.company_id, v_pay.service_session_id, v_pay.id, v_cash.id, p_amount, v_reason, auth.uid()
  ) returning * into v_refund;

  insert into public.cash_movements (
    company_id, cash_session_id, service_session_id, service_payment_id, service_refund_id,
    movement_type, payment_method, amount, description, created_by
  ) values (
    v_pay.company_id, v_cash.id, v_pay.service_session_id, v_pay.id, v_refund.id,
    'refund', v_pay.payment_method, p_amount, 'Estorno - ' || v_label, auth.uid()
  );

  return v_refund;
end;
$$;

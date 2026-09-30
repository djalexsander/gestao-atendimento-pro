-- Correção do TEMPO MÉDIO DE PRODUÇÃO em report_period.
--
-- Antes (20260930080000): production_ready_at - service_orders.submitted_at, ou seja, contava o tempo
-- em que o pedido ficou pendente antes de alguém clicar "Em preparo" (podia dar valores como 1019 min).
-- Agora: production_ready_at - production_started_at (tempo REAL de produção), só para itens com
-- production_started_at preenchido e ready >= started. Item direto de pending -> ready continua
-- contando em "itens produzidos", por produto e por setor, mas não entra na média; se nenhum item
-- tiver duração medida, avg_minutes = NULL (nunca 0). A média é feita sobre a duração exata em
-- minutos e arredondada só no final (inteiro).
--
-- O mesmo vale para production_history (aba Histórico da Produção): item.minutes e summary.avg_minutes
-- passam a usar início -> pronto (minutes = NULL quando o preparo não foi iniciado explicitamente; a média
-- ignora esses itens e é NULL se nenhum tiver duração). Contagens, pedidos, por setor, filtros, limite,
-- ordenação e ACL ficam idênticos. Uma média por ITEM de pedido (a quantity não é peso).
--
-- CREATE OR REPLACE com a MESMA assinatura, retorno JSON, SECURITY DEFINER, STABLE, search_path e ACL:
-- nada mais muda (vendas, pagamentos, produtos, caixas, cancelamentos, estornos, by_product,
-- by_sector, cancelled_in_production e os filtros ficam idênticos).

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
    join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
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
    join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
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

revoke execute on function public.report_period(uuid, date, date, uuid, uuid) from public, anon;
grant execute on function public.report_period(uuid, date, date, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- production_history: tempo real de preparo (mesma assinatura, retorno, SECURITY DEFINER, search_path e ACL)
-- ---------------------------------------------------------------------------
create or replace function public.production_history(
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
    join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
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

comment on function public.production_history(uuid, date, uuid) is
  'Histórico da produção de UM dia (America/Sao_Paulo): itens concluídos naquela data (máx. 500, mais recentes primeiro) + resumo (itens, pedidos, tempo médio real de preparo início->pronto — itens sem início ficam fora da média —, por setor). owner/admin/production. Somente leitura; nunca varre meses.';

revoke execute on function public.production_history(uuid, date, uuid) from public, anon;
grant execute on function public.production_history(uuid, date, uuid) to authenticated;

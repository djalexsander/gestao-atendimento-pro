-- =============================================================================
-- PAGAMENTOS PARCIAIS — ETAPA E9.1: LEITURA FINANCEIRA NO BANCO (módulo-chave por empresa, visão geral das contas abertas, relatório)
-- =============================================================================
-- Aditiva. NADA é gravado em dados existentes. Escopo exato (pagamentos-parciais-e9-plano.md, E9.1):
--   1) módulo 'partial_payments' (INATIVO, sem preço): a chave por EMPRESA do recurso novo. Desligado para todos por padrão; só o operador liga
--      uma empresa (company_module_overrides, com motivo e expiração opcional). Nenhuma empresa é liberada por esta migration.
--   2) list_session_payment_overview(empresa): visão em lote das comandas/mesas ABERTAS. owner/admin/cashier: valores (total, recebido,
--      saldo, excedente, divisão, não distribuído, partes pendentes). attendant: SÓ status (nunca valor). Exige o módulo ligado (PT403).
--   3) report_period: com o módulo LIGADO, (a) devoluções passam a excluir o estorno que recompõe saldo (E6 = correção de pagamento,
--      campo corrections à parte), (b) as formas de pagamento mostram só vendas FECHADAS no período e (c) o recebido em contas ainda abertas
--      sai em open_accounts, nunca misturado com venda fechada. DESLIGADO: corpo e resultado idênticos ao anterior (nenhuma chave nova).
--   4) cash_session_totals: coluna nova no FIM (correction_refund_total); colunas atuais inalteradas.
-- NÃO altera nenhuma RPC das etapas E2–E8, nem close_service_session, nem o front. Rollback: supabase/rollbacks/partial-payments-read-model/rollback.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Módulo-chave (inativo, sem preço, fora do catálogo)
-- ---------------------------------------------------------------------------
insert into public.modules (code, name, description, monthly_price_cents, is_active) values
  ('partial_payments', 'Pagamentos parciais',
   'Pagamentos parciais, divisão de conta e encerramento de conta quitada em comandas e mesas (liberação controlada por empresa).', 0, false)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- 2) Estorno que recompõe saldo? (auxiliar da view; DEFINER para não depender do RLS de service_refunds, só owner/admin)
-- ---------------------------------------------------------------------------
create function public.partial_payments_refund_restores(p_company_id uuid, p_refund_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select r.restores_balance
    from public.service_refunds r
    where r.company_id = p_company_id and r.id = p_refund_id
      and p_company_id in (select public.user_company_ids())
  ), false);
$$;

revoke execute on function public.partial_payments_refund_restores(uuid, uuid) from public, anon;
grant execute on function public.partial_payments_refund_restores(uuid, uuid) to authenticated;

create or replace view public.cash_session_totals
with (security_invoker = true)
as
select
  cash_session_id,
  company_id,
  coalesce(sum(amount) filter (where movement_type = 'sale' and payment_method = 'cash'), 0)::numeric(12, 2) as cash_total,
  coalesce(sum(amount) filter (where movement_type = 'sale' and payment_method = 'pix'), 0)::numeric(12, 2) as pix_total,
  coalesce(sum(amount) filter (where movement_type = 'sale' and payment_method = 'debit_card'), 0)::numeric(12, 2) as debit_total,
  coalesce(sum(amount) filter (where movement_type = 'sale' and payment_method = 'credit_card'), 0)::numeric(12, 2) as credit_total,
  coalesce(sum(amount) filter (where movement_type = 'sale' and payment_method = 'other'), 0)::numeric(12, 2) as other_total,
  coalesce(sum(amount) filter (where movement_type = 'sale'), 0)::numeric(12, 2) as total_sold,
  coalesce(sum(amount) filter (where movement_type = 'supply'), 0)::numeric(12, 2) as supply_total,
  coalesce(sum(amount) filter (where movement_type = 'withdrawal'), 0)::numeric(12, 2) as withdrawal_total,
  coalesce(sum(amount) filter (where movement_type = 'refund'), 0)::numeric(12, 2) as refund_total,
  coalesce(sum(amount) filter (where movement_type = 'courier_change_advance'), 0)::numeric(12, 2) as courier_advance_total,
  coalesce(sum(amount) filter (where movement_type = 'courier_change_return'), 0)::numeric(12, 2) as courier_return_total,
  coalesce(sum(amount) filter (where movement_type = 'courier_settlement_shortfall'), 0)::numeric(12, 2) as courier_shortfall_total,
  coalesce(sum(amount) filter (where movement_type = 'refund' and service_refund_id is not null
                                 and public.partial_payments_refund_restores(company_id, service_refund_id)), 0)::numeric(12, 2) as correction_refund_total
from public.cash_movements
group by cash_session_id, company_id;
revoke all on public.cash_session_totals from public, anon, authenticated;
grant select on public.cash_session_totals to authenticated;
grant all on public.cash_session_totals to service_role;

-- ---------------------------------------------------------------------------
-- 3) Visão em lote das contas abertas
-- ---------------------------------------------------------------------------
create function public.list_session_payment_overview(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_full boolean;
  v_rows jsonb;
  v_total integer;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier', 'attendant') then
    raise exception 'Você não tem permissão para ver o estado das contas.' using errcode = 'PT403';
  end if;
  if not public.company_has_module(p_company_id, 'partial_payments') then
    raise exception 'Este recurso não está habilitado para a empresa.' using errcode = 'PT403';
  end if;
  v_full := v_role in ('owner', 'admin', 'cashier');

  select count(*)::integer into v_total
  from public.service_sessions ss
  where ss.company_id = p_company_id and ss.status = 'open' and ss.kind = 'point';

  select coalesce(jsonb_agg(x.item order by x.opened_at, x.id), '[]'::jsonb) into v_rows
  from (
    select ss.id, ss.opened_at,
           case when v_full then
             jsonb_build_object(
               'service_session_id', ss.id,
               'service_point_id', ss.service_point_id,
               'session_status', ss.status,
               'payment_status', f.c ->> 'payment_status',
               'total', f.c -> 'total',
               'settled_paid', f.c -> 'settled_paid',
               'balance_due', f.c -> 'balance_due',
               'overpaid', f.c -> 'overpaid',
               'payments_count', f.c -> 'payments_count',
               'has_split', jsonb_typeof(f.c -> 'split') = 'object',
               'undistributed', f.c -> 'undistributed',
               'over_distributed', f.c -> 'over_distributed',
               'parts_pending', (select count(*) from jsonb_array_elements(coalesce(f.c -> 'parts', '[]'::jsonb)) pt where (pt ->> 'pending')::numeric > 0))
           else
             jsonb_build_object(
               'service_session_id', ss.id,
               'service_point_id', ss.service_point_id,
               'session_status', ss.status,
               'payment_status', f.c ->> 'payment_status')
           end as item
    from public.service_sessions ss
    cross join lateral (select public.service_session_financial_core(ss.company_id, ss.id) as c) f
    where ss.company_id = p_company_id and ss.status = 'open' and ss.kind = 'point'
    order by ss.opened_at, ss.id
    limit 500
  ) x;

  return jsonb_build_object('sessions', v_rows, 'total_open', v_total, 'truncated', v_total > 500);
end;
$$;

revoke execute on function public.list_session_payment_overview(uuid) from public, anon;
grant execute on function public.list_session_payment_overview(uuid) to authenticated;

comment on function public.list_session_payment_overview(uuid) is
  'E9.1: visão em lote das comandas/mesas abertas (estado de pagamento). owner/admin/cashier recebem valores; attendant só status. Exige o módulo partial_payments ligado para a empresa.';

-- ---------------------------------------------------------------------------
-- 4) report_period (corpo vigente de 20261014090000 + o ramo do módulo ligado)
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
  v_partial boolean;
  v_corr numeric(12, 2) := 0;
  v_open jsonb;
  v_result jsonb;
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

  -- E9.1: recurso de pagamentos parciais LIGADO para esta empresa (módulo inativo concedido por company_module_overrides). Desligado
  -- (padrão), todo o cálculo abaixo é exatamente o anterior e nenhuma chave nova aparece no resultado.
  v_partial := public.company_has_module(p_company_id, 'partial_payments');

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

  -- Devoluções de venda. Ligado: o estorno que RECOMPÕE saldo de conta aberta (E6) é correção de pagamento, não devolução, e fica à parte.
  select coalesce(sum(amount), 0)::numeric(12, 2) into v_refunded
  from public.service_refunds
  where company_id = p_company_id and created_at >= v_start and created_at < v_end
    and (not v_partial or not restores_balance);

  if v_partial then
    select coalesce(sum(amount), 0)::numeric(12, 2) into v_corr
    from public.service_refunds
    where company_id = p_company_id and created_at >= v_start and created_at < v_end and restores_balance;
  end if;

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

  if v_partial then
    -- Formas de pagamento das vendas FECHADAS no período (paid = pagamentos das contas encerradas no período; corrections = estornos que
    -- recompuseram saldo dessas contas antes do encerramento; refunded = devoluções do período). O recebido de contas ainda ABERTAS
    -- não entra aqui: vai em open_accounts, nunca misturado com venda fechada.
    select jsonb_agg(jsonb_build_object(
             'method', m.method,
             'paid', coalesce(p.paid, 0),
             'refunded', coalesce(r.refunded, 0),
             'corrections', coalesce(c.corr, 0),
             'net', coalesce(p.paid, 0) - coalesce(c.corr, 0) - coalesce(r.refunded, 0)
           ) order by m.ord)
      into v_methods
    from (values ('cash', 1), ('pix', 2), ('debit_card', 3), ('credit_card', 4), ('other', 5)) as m(method, ord)
    left join (
      select pay.payment_method, sum(pay.amount)::numeric(12, 2) as paid
      from public.service_payments pay
      join public.service_sessions ss on ss.company_id = pay.company_id and ss.id = pay.service_session_id
      where pay.company_id = p_company_id and ss.status = 'closed' and ss.closed_at >= v_start and ss.closed_at < v_end
      group by pay.payment_method
    ) p on p.payment_method = m.method
    left join (
      select pay.payment_method, sum(rf.amount)::numeric(12, 2) as refunded
      from public.service_refunds rf
      join public.service_payments pay on pay.company_id = rf.company_id and pay.id = rf.service_payment_id
      where rf.company_id = p_company_id and rf.created_at >= v_start and rf.created_at < v_end and not rf.restores_balance
      group by pay.payment_method
    ) r on r.payment_method = m.method
    left join (
      select pay.payment_method, sum(rf.amount)::numeric(12, 2) as corr
      from public.service_refunds rf
      join public.service_payments pay on pay.company_id = rf.company_id and pay.id = rf.service_payment_id
      join public.service_sessions ss on ss.company_id = pay.company_id and ss.id = pay.service_session_id
      where rf.company_id = p_company_id and rf.restores_balance
        and ss.status = 'closed' and ss.closed_at >= v_start and ss.closed_at < v_end
      group by pay.payment_method
    ) c on c.payment_method = m.method;

    -- Recebido no período em contas que NÃO estavam encerradas até o fim do período (ainda abertas ou encerradas depois).
    select jsonb_build_object(
             'accounts', count(distinct x.sid),
             'received', coalesce(sum(x.paid), 0)::numeric(12, 2),
             'corrections', coalesce(sum(x.corr), 0)::numeric(12, 2),
             'net', (coalesce(sum(x.paid), 0) - coalesce(sum(x.corr), 0))::numeric(12, 2)
           )
      into v_open
    from (
      select pay.service_session_id as sid, pay.amount as paid, 0::numeric as corr
      from public.service_payments pay
      join public.service_sessions ss on ss.company_id = pay.company_id and ss.id = pay.service_session_id
      where pay.company_id = p_company_id and pay.created_at >= v_start and pay.created_at < v_end
        and (ss.status = 'open' or ss.closed_at >= v_end)
      union all
      select rf.service_session_id, 0::numeric, rf.amount
      from public.service_refunds rf
      join public.service_sessions ss on ss.company_id = rf.company_id and ss.id = rf.service_session_id
      where rf.company_id = p_company_id and rf.restores_balance and rf.created_at >= v_start and rf.created_at < v_end
        and (ss.status = 'open' or ss.closed_at >= v_end)
    ) x;
  end if;

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
      and (not v_partial or not rf.restores_balance)
  )
  select jsonb_build_object(
           'count', (select count(*) from rx),
           'total', (select coalesce(sum(amount), 0)::numeric(12, 2) from rx),
           'list', (select coalesce(jsonb_agg(to_jsonb(l) order by l.created_at desc), '[]'::jsonb)
                    from (select * from rx order by created_at desc limit 500) l)
         )
    into v_refunds;

  if v_partial then
    v_refunds := v_refunds || (
      select jsonb_build_object('corrections', jsonb_build_object('count', count(*), 'total', coalesce(sum(rf.amount), 0)::numeric(12, 2)))
      from public.service_refunds rf
      where rf.company_id = p_company_id and rf.created_at >= v_start and rf.created_at < v_end and rf.restores_balance
    );
  end if;

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

  if v_partial then
    -- estornos em caixa que foram CORREÇÃO de pagamento (parte de refund_total, que segue sendo o total físico estornado)
    v_cash := v_cash || (
      select jsonb_build_object('correction_refund_total', coalesce(sum(m.amount), 0)::numeric(12, 2))
      from public.cash_movements m
      join public.service_refunds rf on rf.company_id = m.company_id and rf.id = m.service_refund_id
      where m.company_id = p_company_id and m.movement_type = 'refund' and rf.restores_balance
        and m.cash_session_id in (select c.id from public.cash_sessions c where c.company_id = p_company_id and c.opened_at >= v_start and c.opened_at < v_end)
    );
  end if;

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

  v_result := jsonb_build_object(
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

  if v_partial then
    v_result := jsonb_set(v_result, '{sales}', (v_result -> 'sales') || jsonb_build_object('corrections', v_corr))
                || jsonb_build_object('open_accounts', v_open);
  end if;
  return v_result;
end;
$$;

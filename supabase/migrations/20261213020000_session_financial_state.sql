-- =============================================================================
-- PAGAMENTOS PARCIAIS — ETAPA E2: CONSULTA SEGURA DO ESTADO FINANCEIRO DA CONTA (somente leitura)
-- =============================================================================
-- Cria APENAS funções de leitura. Nada é gravado; nenhuma RPC existente é alterada (close_service_session,
-- refund_service_payment, cancel_service_order_item, submit_service_order, receive_delivery_order, caixa...). O registro de pagamento
-- parcial (E3) e o resto continuam FORA desta etapa.
--
--   get_session_financial_state(sessão)  owner | admin | cashier  -> estado agregado completo (SEM listar transações)
--   get_session_payment_status(sessão)   owner | admin | cashier | attendant -> SÓ o status (sem valor nenhum)
--   service_session_total(...)           interna: total vigente da conta (mesma regra do fechamento)
--   service_session_financial_core(...)  interna: o cálculo único (uma só consulta = um só instantâneo)
--
-- REGRAS
--   * NADA é gravado: o saldo é sempre calculado na hora, a partir dos pedidos (itens não cancelados + taxa de entrega
--     não cancelada), dos pagamentos, dos estornos e das alocações. Nenhum campo "saldo" existe no banco.
--   * total: conta ABERTA = soma dos itens cobráveis (quantidade - cancelada) dos pedidos submitted (+ taxa de delivery
--     não cancelado) — a MESMA regra de close_service_session; conta FECHADA = total_amount gravado no fechamento.
--   * settled_paid (aplicado à conta) = pagamentos - estornos que RECOMPÕEM saldo (restores_balance). Estorno de conta
--     FECHADA (histórico) nunca mexe no saldo: a conta segue encerrada.
--   * net_paid (dinheiro líquido) = pagamentos - TODOS os estornos.
--   * balance_due: conta aberta = max(total - settled_paid, 0); conta fechada = 0. overpaid = o que passa do total
--     (só existe se o consumo caiu depois de pagar; E7 impede cancelar abaixo do pago).
--   * payment_status: closed | no_charge (total 0) | unpaid | partial | paid (quitada, pronta para fechar).
--   * divisão: só a divisão ATIVA aparece em parts, com previsto/pago/pendente por parte. undistributed = total -
--     (previsto das partes ativas + líquido pago nas partes de divisões substituídas + pagamentos sem parte): é o valor que
--     ainda não está em nenhuma parte (>= 0) e over_distributed o excesso de previsto (> 0 se as partes passam do total).
--     Sem divisão ativa, undistributed/over_distributed = null.
--   * ISOLAMENTO: a RPC valida empresa e papel no SERVIDOR. Outra empresa, id inexistente e usuário sem vínculo recebem o
--     MESMO erro (PT404 "Atendimento não encontrado"), sem confirmar a existência. production e courier recebem PT403.
--   * O cashier consulta o agregado mesmo com pagamentos de OUTROS caixas, SEM ampliar o RLS: service_payments continua
--     visível só pelo caixa dono (a função é SECURITY DEFINER e devolve apenas somas, nunca linhas de pagamento).
--   * O attendant NÃO recebe valor algum: só session_status e payment_status.
-- ROLLBACK: supabase/rollbacks/session-financial-state/rollback.sql (só remove estas funções; nenhum dado a restaurar).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Total vigente da conta (interna)
-- ---------------------------------------------------------------------------
create function public.service_session_total(p_company_id uuid, p_service_session_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select (
    coalesce((
      select sum((i.quantity - i.cancelled_quantity) * i.unit_price)
      from public.service_orders o
      join public.service_order_items i on i.company_id = o.company_id and i.order_id = o.id
      where o.company_id = p_company_id and o.service_session_id = p_service_session_id and o.status = 'submitted'
    ), 0)
    + case
        when exists (
          select 1 from public.service_sessions ss
          where ss.company_id = p_company_id and ss.id = p_service_session_id and ss.kind = 'delivery'
        )
        then coalesce((
          select d.delivery_fee from public.delivery_orders d
          where d.company_id = p_company_id and d.service_session_id = p_service_session_id and d.delivery_status <> 'canceled'
        ), 0)
        else 0
      end
  )::numeric(12, 2);
$$;

-- ---------------------------------------------------------------------------
-- 2) O cálculo único (interna): uma só consulta, portanto um só instantâneo dos dados
-- ---------------------------------------------------------------------------
create function public.service_session_financial_core(p_company_id uuid, p_service_session_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with s as (
    select ss.id, ss.status, ss.kind, ss.total_amount
    from public.service_sessions ss
    where ss.company_id = p_company_id and ss.id = p_service_session_id
  ),
  t as (
    select s.id, s.status, s.kind,
           (case when s.status = 'closed' and s.total_amount is not null
                 then s.total_amount
                 else public.service_session_total(p_company_id, p_service_session_id) end)::numeric(12, 2) as total
    from s
  ),
  pay as (
    select coalesce(sum(amount), 0)::numeric(12, 2) as gross, count(*)::int as n
    from public.service_payments where company_id = p_company_id and service_session_id = p_service_session_id
  ),
  rf as (
    select coalesce(sum(amount), 0)::numeric(12, 2) as all_refunded,
           coalesce(sum(amount) filter (where restores_balance), 0)::numeric(12, 2) as restoring,
           count(*)::int as n
    from public.service_refunds where company_id = p_company_id and service_session_id = p_service_session_id
  ),
  alloc as (
    select
      coalesce((select sum(a.amount) from public.service_payment_allocations a
                where a.company_id = p_company_id and a.service_session_id = p_service_session_id), 0)::numeric(12, 2) as paid_alloc,
      coalesce((select sum(a.amount) from public.service_refund_allocations a
                where a.company_id = p_company_id and a.service_session_id = p_service_session_id), 0)::numeric(12, 2) as ref_alloc
  ),
  sp as (
    select id, mode, version from public.service_session_splits
    where company_id = p_company_id and service_session_id = p_service_session_id and status = 'active'
  ),
  parts as (
    select p.id, p.split_id, p.position, p.label, p.planned_amount,
           (coalesce((select sum(a.amount) from public.service_payment_allocations a where a.company_id = p.company_id and a.part_id = p.id), 0)
            - coalesce((select sum(a.amount) from public.service_refund_allocations a where a.company_id = p.company_id and a.part_id = p.id), 0))::numeric(12, 2) as net_paid
    from public.service_session_parts p
    where p.company_id = p_company_id and p.service_session_id = p_service_session_id
  ),
  agg as (
    select coalesce(sum(planned_amount) filter (where split_id in (select id from sp)), 0)::numeric(12, 2) as active_planned,
           coalesce(sum(net_paid) filter (where split_id not in (select id from sp)), 0)::numeric(12, 2) as superseded_paid
    from parts
  ),
  calc as (
    select t.total, t.status, t.kind,
           pay.gross, pay.n as pay_n, rf.all_refunded, rf.restoring, rf.n as rf_n,
           (pay.gross - rf.restoring)::numeric(12, 2) as settled,
           (pay.gross - rf.all_refunded)::numeric(12, 2) as net_paid,
           ((pay.gross - alloc.paid_alloc) - (rf.restoring - alloc.ref_alloc))::numeric(12, 2) as unalloc_pay,
           agg.active_planned, agg.superseded_paid
    from t, pay, rf, alloc, agg
  )
  select jsonb_build_object(
    'service_session_id', p_service_session_id,
    'session_status', c.status,
    'kind', c.kind,
    'total', c.total,
    'paid', c.gross,
    'refunded', c.all_refunded,
    'net_paid', c.net_paid,
    'settled_paid', c.settled,
    'balance_due', case when c.status = 'open' then greatest(c.total - c.settled, 0) else 0 end,
    'overpaid', case when c.status = 'open' then greatest(c.settled - c.total, 0) else 0 end,
    'payment_status', case
        when c.status = 'closed' then 'closed'
        when c.total = 0 and c.settled <= 0 then 'no_charge'
        when c.settled <= 0 then 'unpaid'
        when c.settled < c.total then 'partial'
        else 'paid' end,
    'payments_count', c.pay_n,
    'refunds_count', c.rf_n,
    'split', (select jsonb_build_object('id', sp.id, 'mode', sp.mode, 'version', sp.version) from sp),
    'parts', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'part_id', p.id, 'position', p.position, 'label', p.label,
                 'planned', p.planned_amount,
                 'paid', greatest(p.net_paid, 0),
                 'pending', greatest(p.planned_amount - p.net_paid, 0),
                 'status', case when p.net_paid >= p.planned_amount then 'paid' when p.net_paid > 0 then 'partial' else 'pending' end
               ) order by p.position)
        from parts p where p.split_id in (select id from sp)
      ), '[]'::jsonb),
    'undistributed', case when exists (select 1 from sp)
        then greatest(c.total - (c.active_planned + c.superseded_paid + c.unalloc_pay), 0) end,
    'over_distributed', case when exists (select 1 from sp)
        then greatest((c.active_planned + c.superseded_paid + c.unalloc_pay) - c.total, 0) end
  )
  from calc c;
$$;

-- ---------------------------------------------------------------------------
-- 3) RPC completa: owner | admin | cashier (qualquer caixa); agregados, nunca linhas de pagamento
-- ---------------------------------------------------------------------------
create function public.get_session_financial_state(p_service_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_role public.company_role;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select company_id into v_company from public.service_sessions where id = p_service_session_id;
  -- id inexistente, outra empresa e usuário sem vínculo ativo: a MESMA resposta (não confirma a existência)
  if v_company is null then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  v_role := public.user_role_in_company(v_company);
  if v_role is null then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier') then
    raise exception 'Você não tem permissão para ver o estado financeiro da conta.' using errcode = 'PT403';
  end if;

  return public.service_session_financial_core(v_company, p_service_session_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) RPC mínima para o Balcão: SÓ o status (sem valores, sem partes, sem contagens)
-- ---------------------------------------------------------------------------
create function public.get_session_payment_status(p_service_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_role public.company_role;
  v_core jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select company_id into v_company from public.service_sessions where id = p_service_session_id;
  if v_company is null then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  v_role := public.user_role_in_company(v_company);
  if v_role is null then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier', 'attendant') then
    raise exception 'Você não tem permissão para ver o status de pagamento da conta.' using errcode = 'PT403';
  end if;

  v_core := public.service_session_financial_core(v_company, p_service_session_id);
  return jsonb_build_object(
    'service_session_id', p_service_session_id,
    'session_status', v_core ->> 'session_status',
    'payment_status', v_core ->> 'payment_status'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Permissões: RPCs só para usuários autenticados; internas fechadas
-- ---------------------------------------------------------------------------
revoke execute on function public.service_session_total(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.service_session_financial_core(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.get_session_financial_state(uuid) from public, anon;
revoke execute on function public.get_session_payment_status(uuid) from public, anon;
grant execute on function public.get_session_financial_state(uuid) to authenticated;
grant execute on function public.get_session_payment_status(uuid) to authenticated;

comment on function public.get_session_financial_state(uuid) is
  'E2: estado financeiro agregado da conta (total, pago, estornos, saldo, partes, não distribuído). owner/admin/cashier. Só leitura; nunca devolve linhas de pagamento.';
comment on function public.get_session_payment_status(uuid) is
  'E2: SÓ o status de pagamento da conta para o Balcão (attendant incluído). Sem valores.';

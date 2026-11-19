-- =============================================================================
-- PAGAMENTOS PARCIAIS — ETAPA E6: refund_open_session_payment (estorno de pagamento em conta ABERTA, integral ou parcial)
-- =============================================================================
-- Regras (E6-R1..) e auditoria em docs/pagamentos-parciais-e6-regras.md — escritas antes desta implementação.
-- Esta migration SÓ cria funções NOVAS. Nenhuma RPC existente é alterada: refund_service_payment (contas FECHADAS) segue byte a byte
-- como está; o estorno de conta aberta é uma via separada e o gatilho provisório do fechamento legado (E3/E5) continua como está.
-- Depende de E1 (service_refunds.client_request_id/restores_balance, service_refund_allocations, eventos), E2 (saldo) e E3.
--
--   refund_open_session_payment(pagamento, valor, motivo, client_request_id)   owner | admin; UM estorno por chamada
--   service_refund_allocation_plan(...)   interna: reversão proporcional, em centavos, nas partes que receberam o pagamento
--   service_refund_result(estorno, replay)   interna: monta a resposta (estorno + reversões + estado agregado)
--
-- Travas (mesma ordem de todas as RPCs): service_sessions FOR UPDATE -> service_payments FOR UPDATE -> cash_sessions FOR UPDATE.
-- ROLLBACK: supabase/rollbacks/refund-open-session-payment/rollback.sql (recusa se já existir estorno gravado por esta RPC).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Reversão proporcional, em centavos (interna)
-- ---------------------------------------------------------------------------
-- Pesos = o que cada parte ainda tem líquido DAQUELE pagamento (alocado - já estornado). Cota inteira = piso(R x peso / soma);
-- as sobras de centavos vão, uma a uma, às partes com MAIOR resto (empate: versão da divisão e posição). Nunca passa do peso da parte.
-- Pagamento sem alocações (anterior à divisão): nenhuma linha (o valor recomposto aparece como "não distribuído" no estado).
create function public.service_refund_allocation_plan(
  p_company_id uuid,
  p_payment_id uuid,
  p_refund_cents numeric,
  p_available_cents numeric
)
returns table (part_id uuid, amount_cents numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sum numeric;
begin
  select coalesce(sum(w.net), 0) into v_sum
  from (
    select round(a.amount * 100)
           - coalesce((select round(sum(ra.amount) * 100) from public.service_refund_allocations ra
                       join public.service_refunds r on r.company_id = ra.company_id and r.id = ra.service_refund_id
                       where ra.company_id = a.company_id and ra.part_id = a.part_id and r.service_payment_id = a.service_payment_id), 0) as net
    from public.service_payment_allocations a
    where a.company_id = p_company_id and a.service_payment_id = p_payment_id
  ) w;

  if v_sum = 0 then
    return;
  end if;
  if v_sum <> p_available_cents then
    raise exception 'Alocações do pagamento inconsistentes com o saldo estornável; estorno recusado.' using errcode = 'PT409';
  end if;

  return query
  with w as (
    select a.part_id,
           (round(a.amount * 100)
            - coalesce((select round(sum(ra.amount) * 100) from public.service_refund_allocations ra
                        join public.service_refunds r on r.company_id = ra.company_id and r.id = ra.service_refund_id
                        where ra.company_id = a.company_id and ra.part_id = a.part_id and r.service_payment_id = a.service_payment_id), 0)) as net,
           sp.version, pt.position
    from public.service_payment_allocations a
    join public.service_session_parts pt on pt.company_id = a.company_id and pt.id = a.part_id
    join public.service_session_splits sp on sp.company_id = pt.company_id and sp.id = pt.split_id
    where a.company_id = p_company_id and a.service_payment_id = p_payment_id
  ),
  base as (
    select w.part_id, w.version, w.position,
           trunc(p_refund_cents * w.net / v_sum) as floor_cents,
           mod(p_refund_cents * w.net, v_sum) as rem
    from w where w.net > 0
  ),
  ranked as (
    select b.*, row_number() over (order by b.rem desc, b.version, b.position) as rk,
           p_refund_cents - sum(b.floor_cents) over () as leftover
    from base b
  )
  select r.part_id, r.floor_cents + case when r.rk <= r.leftover then 1 else 0 end
  from ranked r
  where r.floor_cents + case when r.rk <= r.leftover then 1 else 0 end > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) Resposta do estorno (interna)
-- ---------------------------------------------------------------------------
create function public.service_refund_result(p_refund_id uuid, p_replay boolean)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'refund_id', r.id,
    'service_session_id', r.service_session_id,
    'service_payment_id', r.service_payment_id,
    'payment_method', p.payment_method,
    'amount', r.amount,
    'reason', r.reason,
    'original_cash_session_id', p.cash_session_id,
    'refunding_cash_session_id', r.cash_session_id,
    'client_request_id', r.client_request_id,
    'created_at', r.created_at,
    'replay', p_replay,
    'allocations', coalesce((
      select jsonb_agg(jsonb_build_object('part_id', a.part_id, 'amount', a.amount) order by a.created_at, a.id)
      from public.service_refund_allocations a where a.company_id = r.company_id and a.service_refund_id = r.id
    ), '[]'::jsonb),
    'state', public.service_session_financial_core(r.company_id, r.service_session_id)
  )
  from public.service_refunds r
  join public.service_payments p on p.company_id = r.company_id and p.id = r.service_payment_id
  where r.id = p_refund_id;
$$;

-- ---------------------------------------------------------------------------
-- 3) RPC
-- ---------------------------------------------------------------------------
create function public.refund_open_session_payment(
  p_service_payment_id uuid,
  p_amount numeric,
  p_reason text,
  p_client_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_session_id uuid;
  v_role public.company_role;
  v_session public.service_sessions;
  v_pay public.service_payments;
  v_existing public.service_refunds;
  v_cash public.cash_sessions;
  v_point public.service_points;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_refunded numeric(12, 2);
  v_available numeric(12, 2);
  v_before jsonb;
  v_after jsonb;
  v_refund public.service_refunds;
  v_label text;
  v_plan record;
  v_alloc_detail jsonb;
begin
  -- sessão e identificador
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if p_client_request_id is null then
    raise exception 'Informe o identificador da requisição (client_request_id).' using errcode = 'PT400';
  end if;

  -- leitura sem trava só para achar empresa e conta; tudo é revalidado depois das travas
  select company_id, service_session_id into v_company, v_session_id
  from public.service_payments where id = p_service_payment_id;
  if v_company is null then
    raise exception 'Pagamento não encontrado.' using errcode = 'PT404';
  end if;
  v_role := public.user_role_in_company(v_company);
  if v_role is null then
    raise exception 'Pagamento não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Somente o dono ou um administrador pode estornar pagamentos.' using errcode = 'PT403';
  end if;

  -- 1ª trava: a conta
  select * into v_session from public.service_sessions where company_id = v_company and id = v_session_id for update;
  if not found then
    raise exception 'Pagamento não encontrado.' using errcode = 'PT404';
  end if;

  -- idempotência (antes das regras de estado: a réplica vale mesmo com a conta já fechada)
  select * into v_existing from public.service_refunds where company_id = v_company and client_request_id = p_client_request_id;
  if found then
    if v_existing.service_payment_id = p_service_payment_id
       and v_existing.amount = p_amount
       and v_existing.reason = v_reason
       and v_existing.created_by = auth.uid() then
      return public.service_refund_result(v_existing.id, true);
    end if;
    raise exception 'Este identificador de requisição já foi usado em outro estorno.' using errcode = 'PT409';
  end if;

  -- conta aberta de comanda/mesa (conta fechada: refund_service_payment; delivery/retirada: fora desta etapa)
  if v_session.kind <> 'point' then
    raise exception 'Delivery e retirada não têm estorno parcial nesta etapa.' using errcode = 'PT409';
  end if;
  if v_session.status <> 'open' then
    raise exception 'Esta conta já foi fechada; use o estorno de conta fechada.' using errcode = 'PT409';
  end if;

  -- valores
  if p_amount is null or p_amount <= 0 or p_amount >= 10000000000 or p_amount <> round(p_amount, 2) then
    raise exception 'Informe um valor maior que zero, com até 2 casas decimais.' using errcode = 'PT400';
  end if;
  if v_reason is null then
    raise exception 'Informe o motivo do estorno.' using errcode = 'PT400';
  end if;
  if char_length(v_reason) > 200 then
    raise exception 'O motivo pode ter no máximo 200 caracteres.' using errcode = 'PT400';
  end if;

  -- 2ª trava: o pagamento; 3ª: o caixa aberto de quem estorna (devolve o dinheiro)
  select * into v_pay from public.service_payments where company_id = v_company and id = p_service_payment_id for update;
  if not found or v_pay.service_session_id <> v_session.id then
    raise exception 'Pagamento não encontrado.' using errcode = 'PT404';
  end if;
  select * into v_cash from public.cash_sessions
  where company_id = v_company and opened_by = auth.uid() and status = 'open'
  for update;
  if not found then
    raise exception 'Abra seu caixa antes de realizar o estorno.' using errcode = 'PT412';
  end if;

  select coalesce(sum(amount), 0) into v_refunded
  from public.service_refunds where company_id = v_company and service_payment_id = v_pay.id;
  v_available := v_pay.amount - v_refunded;
  if p_amount > v_available then
    raise exception 'Valor do estorno maior que o disponível para estorno (R$ %).',
      replace(to_char(v_available, 'FM9999999990.00'), '.', ',') using errcode = 'PT400';
  end if;
  if v_pay.payment_method = 'cash' and p_amount > public.cash_session_physical_cash(v_cash.id) then
    raise exception 'Dinheiro insuficiente no caixa para este estorno. Faça um suprimento antes.' using errcode = 'PT400';
  end if;

  v_before := public.service_session_financial_core(v_company, v_session.id);

  select * into v_point from public.service_points where id = v_session.service_point_id and company_id = v_session.company_id;
  v_label := case when v_point.type = 'table' then 'Mesa ' || coalesce(v_point.code, '') else 'Comanda ' || coalesce(v_point.code, '') end;

  -- grava: estorno (original intocado), saída no caixa que devolve, reversão nas partes, evento
  begin
    insert into public.service_refunds (
      company_id, service_session_id, service_payment_id, cash_session_id, amount, reason, created_by, client_request_id, restores_balance
    ) values (
      v_company, v_session.id, v_pay.id, v_cash.id, p_amount, v_reason, auth.uid(), p_client_request_id, true
    ) returning * into v_refund;
  exception when unique_violation then
    raise exception 'Este identificador de requisição já foi usado em outro estorno.' using errcode = 'PT409';
  end;

  insert into public.cash_movements (
    company_id, cash_session_id, service_session_id, service_payment_id, service_refund_id,
    movement_type, payment_method, amount, description, created_by
  ) values (
    v_company, v_cash.id, v_session.id, v_pay.id, v_refund.id, 'refund', v_pay.payment_method, p_amount, 'Estorno - ' || v_label, auth.uid()
  );

  for v_plan in
    select * from public.service_refund_allocation_plan(v_company, v_pay.id, round(p_amount * 100), round(v_available * 100))
  loop
    insert into public.service_refund_allocations (company_id, service_refund_id, part_id, service_session_id, amount)
    values (v_company, v_refund.id, v_plan.part_id, v_session.id, v_plan.amount_cents / 100);
  end loop;

  v_after := public.service_session_financial_core(v_company, v_session.id);

  select coalesce(jsonb_agg(jsonb_build_object(
           'part_id', ra.part_id, 'label', pt.label, 'split_version', sp.version, 'split_status', sp.status, 'amount', ra.amount
         ) order by sp.version, pt.position), '[]'::jsonb)
    into v_alloc_detail
  from public.service_refund_allocations ra
  join public.service_session_parts pt on pt.company_id = ra.company_id and pt.id = ra.part_id
  join public.service_session_splits sp on sp.company_id = pt.company_id and sp.id = pt.split_id
  where ra.company_id = v_company and ra.service_refund_id = v_refund.id;

  insert into public.service_session_events (company_id, service_session_id, event_type, actor_id, request_id, payload)
  values (
    v_company, v_session.id, 'payment_refunded', auth.uid(), p_client_request_id,
    jsonb_build_object(
      'payment_id', v_pay.id,
      'refund_id', v_refund.id,
      'method', v_pay.payment_method,
      'amount', p_amount,
      'reason', v_reason,
      'original_cash_session_id', v_pay.cash_session_id,
      'refunding_cash_session_id', v_cash.id,
      'available_before', v_available,
      'allocations_reversed', v_alloc_detail,
      'balance_before', (v_before ->> 'balance_due')::numeric,
      'balance_after', (v_after ->> 'balance_due')::numeric,
      'undistributed_before', v_before -> 'undistributed',
      'undistributed_after', v_after -> 'undistributed'
    )
  );

  return public.service_refund_result(v_refund.id, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Permissões
-- ---------------------------------------------------------------------------
revoke execute on function public.service_refund_allocation_plan(uuid, uuid, numeric, numeric) from public, anon, authenticated;
revoke execute on function public.service_refund_result(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.refund_open_session_payment(uuid, numeric, text, uuid) from public, anon;
grant execute on function public.refund_open_session_payment(uuid, numeric, text, uuid) to authenticated;

comment on function public.refund_open_session_payment(uuid, numeric, text, uuid) is
  'E6: estorno integral ou parcial de pagamento registrado em conta ABERTA de comanda/mesa. Só owner/admin, motivo obrigatório, idempotente por client_request_id; não altera o pagamento original; saída no caixa que devolve; reverte as partes proporcionalmente em centavos. Regras: docs/pagamentos-parciais-e6-regras.md.';

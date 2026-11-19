-- =============================================================================
-- PAGAMENTOS PARCIAIS — ETAPA E3: register_service_payment (registro de pagamento em conta ABERTA, sem encerrá-la)
-- =============================================================================
-- Regras (R-1..R-18) em docs/pagamentos-parciais-e3-regras.md — escritas e testadas antes desta implementação.
-- Esta migration SÓ cria funções NOVAS. Nenhuma RPC existente é alterada (close_service_session, refund_service_payment,
-- cancel_service_order_item, submit_service_order, receive_delivery_order, caixa...): o fechamento e o recebimento atuais seguem como estão.
-- Depende da E1 (tabelas/colunas/gatilhos) e da E2 (cálculo do saldo).
--
--   register_service_payment(...)        owner | admin | cashier; grava UM pagamento (+ movimento de caixa, alocações, evento)
--   service_payment_result(pagamento, replay)   interna: monta a resposta (pagamento + alocações + estado agregado)
--
-- Travas (mesma ordem do fechamento): service_sessions FOR UPDATE -> cash_sessions do operador FOR SHARE. Tudo que muda a conta
-- (pedido novo, cancelar item, fechar, estorno) trava a MESMA linha da sessão antes; por isso nunca há pagamento acima do saldo.
-- ROLLBACK: supabase/rollbacks/register-service-payment/rollback.sql (recusa se já existir pagamento gravado por esta RPC).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Resposta do pagamento (interna)
-- ---------------------------------------------------------------------------
create function public.service_payment_result(p_payment_id uuid, p_replay boolean)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'payment_id', p.id,
    'service_session_id', p.service_session_id,
    'payment_method', p.payment_method,
    'amount', p.amount,
    'amount_received', p.amount_received,
    'change_amount', p.change_amount,
    'cash_session_id', p.cash_session_id,
    'client_request_id', p.client_request_id,
    'created_at', p.created_at,
    'replay', p_replay,
    'allocations', coalesce((
      select jsonb_agg(jsonb_build_object('part_id', a.part_id, 'amount', a.amount) order by a.created_at, a.id)
      from public.service_payment_allocations a where a.company_id = p.company_id and a.service_payment_id = p.id
    ), '[]'::jsonb),
    'state', public.service_session_financial_core(p.company_id, p.service_session_id)
  )
  from public.service_payments p
  where p.id = p_payment_id;
$$;

-- ---------------------------------------------------------------------------
-- 2) RPC
-- ---------------------------------------------------------------------------
create function public.register_service_payment(
  p_service_session_id uuid,
  p_method text,
  p_amount numeric,
  p_amount_received numeric,
  p_client_request_id uuid,
  p_expected_balance numeric default null,
  p_part_id uuid default null,
  p_allocations jsonb default null,
  p_confirm_allocation boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_role public.company_role;
  v_session public.service_sessions;
  v_existing public.service_payments;
  v_cash public.cash_sessions;
  v_point public.service_points;
  v_core jsonb;
  v_balance numeric(12, 2);
  v_has_split boolean;
  v_alloc jsonb := '[]'::jsonb;
  v_el jsonb;
  v_pid uuid;
  v_amt numeric;
  v_sum numeric := 0;
  v_seen uuid[] := '{}';
  v_pending numeric;
  v_part jsonb;
  v_received numeric;
  v_change numeric := 0;
  v_payment public.service_payments;
  v_label text;
  v_fmt text;
begin
  -- R-1: sessão
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if p_client_request_id is null then
    raise exception 'Informe o identificador da requisição (client_request_id).' using errcode = 'PT400';
  end if;

  -- Leitura sem trava só para achar a empresa; tudo é revalidado depois da trava.
  select company_id into v_company from public.service_sessions where id = p_service_session_id;
  if v_company is null then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  v_role := public.user_role_in_company(v_company);
  if v_role is null then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier') then
    raise exception 'Você não tem permissão para receber pagamentos.' using errcode = 'PT403';
  end if;

  -- R-9: trava a conta (mesma ordem do fechamento)
  select * into v_session from public.service_sessions where id = p_service_session_id for update;
  if not found then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;

  -- R-2: idempotência (antes de qualquer outra regra de estado: a réplica vale mesmo com a conta já fechada)
  select * into v_existing from public.service_payments
  where company_id = v_company and client_request_id = p_client_request_id;
  if found then
    if v_existing.service_session_id = v_session.id
       and v_existing.payment_method = p_method
       and v_existing.amount = p_amount
       and v_existing.created_by = auth.uid()
       and v_existing.amount_received is not distinct from p_amount_received then
      return public.service_payment_result(v_existing.id, true);
    end if;
    raise exception 'Este identificador de requisição já foi usado em outro pagamento.' using errcode = 'PT409';
  end if;

  -- R-3: conta aberta, de comanda/mesa
  if v_session.status <> 'open' then
    raise exception 'Este atendimento já foi fechado.' using errcode = 'PT409';
  end if;
  if v_session.kind <> 'point' then
    raise exception 'Delivery e retirada não aceitam pagamento parcial; use o recebimento do delivery.' using errcode = 'PT409';
  end if;

  -- R-5/R-6: valores (nada é preenchido pelo banco)
  if p_method is null or p_method not in ('cash', 'pix', 'debit_card', 'credit_card', 'other') then
    raise exception 'Forma de pagamento inválida.' using errcode = 'PT400';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount >= 10000000000 or p_amount <> round(p_amount, 2) then
    raise exception 'O valor do pagamento deve ser maior que zero, com até 2 casas decimais.' using errcode = 'PT400';
  end if;
  if p_method = 'cash' then
    if p_amount_received is null then
      raise exception 'Informe o valor entregue em dinheiro.' using errcode = 'PT400';
    end if;
    if p_amount_received < p_amount or p_amount_received >= 10000000000 or p_amount_received <> round(p_amount_received, 2) then
      raise exception 'O valor entregue em dinheiro deve ser igual ou maior que o valor aplicado, com até 2 casas decimais.' using errcode = 'PT400';
    end if;
    v_received := p_amount_received;
    v_change := p_amount_received - p_amount;
  else
    if p_amount_received is not null then
      raise exception 'Só o pagamento em dinheiro tem valor entregue e troco.' using errcode = 'PT400';
    end if;
    v_received := null;
  end if;

  -- R-4: caixa aberto do próprio operador (travado contra o fechamento do caixa em paralelo)
  select * into v_cash from public.cash_sessions
  where company_id = v_company and opened_by = auth.uid() and status = 'open'
  for share;
  if not found then
    raise exception 'Abra o caixa antes de receber esta conta.' using errcode = 'PT412';
  end if;

  -- R-7/R-8: saldo calculado AGORA, com a conta travada
  v_core := public.service_session_financial_core(v_company, v_session.id);
  v_balance := (v_core ->> 'balance_due')::numeric;
  v_fmt := 'R$ ' || replace(to_char(v_balance, 'FM9999999990.00'), '.', ',');
  if v_balance <= 0 then
    raise exception 'Esta conta não tem saldo a receber.' using errcode = 'PT409';
  end if;
  if p_expected_balance is not null and p_expected_balance <> v_balance then
    raise exception 'O saldo da conta mudou (agora %). Atualize a tela e confirme novamente.', v_fmt using errcode = 'PT409';
  end if;
  if p_amount > v_balance then
    raise exception 'O valor ultrapassa o saldo pendente da conta (%).', v_fmt using errcode = 'PT400';
  end if;

  -- R-12..R-18: divisão
  v_has_split := jsonb_typeof(v_core -> 'split') = 'object';
  if not v_has_split then
    if p_part_id is not null or p_allocations is not null then
      raise exception 'Esta conta não tem divisão ativa; não informe parte nem alocações.' using errcode = 'PT400';
    end if;
  else
    if p_part_id is not null and p_allocations is not null then
      raise exception 'Informe a parte OU as alocações, não os dois.' using errcode = 'PT400';
    end if;
    if p_part_id is null and p_allocations is null then
      raise exception 'Esta conta está dividida: escolha a parte que receberá o pagamento (ou informe a alocação confirmada).' using errcode = 'PT400';
    end if;

    if p_part_id is not null then
      select pt into v_part from jsonb_array_elements(v_core -> 'parts') pt where (pt ->> 'part_id')::uuid = p_part_id;
      if v_part is null then
        raise exception 'Parte inexistente na divisão ativa desta conta.' using errcode = 'PT409';
      end if;
      v_pending := (v_part ->> 'pending')::numeric;
      if v_pending <= 0 then
        raise exception 'Esta parte já está quitada.' using errcode = 'PT409';
      end if;
      if p_amount > v_pending then
        raise exception 'O valor passa do pendente da parte (R$ %). Para distribuir o excedente informe as alocações com confirmação expressa.',
          replace(to_char(v_pending, 'FM9999999990.00'), '.', ',') using errcode = 'PT409';
      end if;
      v_alloc := jsonb_build_array(jsonb_build_object('part_id', p_part_id, 'amount', p_amount));
    else
      -- alocações explícitas e confirmadas
      if jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 or jsonb_array_length(p_allocations) > 50 then
        raise exception 'Informe de 1 a 50 alocações.' using errcode = 'PT400';
      end if;
      if p_confirm_allocation is not true then
        raise exception 'A confirmação expressa da alocação é obrigatória.' using errcode = 'PT400';
      end if;
      for v_el in select * from jsonb_array_elements(p_allocations) loop
        if jsonb_typeof(v_el) <> 'object'
           or jsonb_typeof(v_el -> 'part_id') <> 'string'
           or (v_el ->> 'part_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           or jsonb_typeof(v_el -> 'amount') <> 'number' then
          raise exception 'Alocação inválida.' using errcode = 'PT400';
        end if;
        v_pid := (v_el ->> 'part_id')::uuid;
        v_amt := (v_el ->> 'amount')::numeric;
        if v_amt <= 0 or v_amt >= 10000000000 or v_amt <> round(v_amt, 2) then
          raise exception 'O valor de cada alocação deve ser maior que zero, com até 2 casas decimais.' using errcode = 'PT400';
        end if;
        if v_pid = any (v_seen) then
          raise exception 'A mesma parte aparece duas vezes nas alocações.' using errcode = 'PT400';
        end if;
        v_seen := v_seen || v_pid;
        select pt into v_part from jsonb_array_elements(v_core -> 'parts') pt where (pt ->> 'part_id')::uuid = v_pid;
        if v_part is null then
          raise exception 'Parte inexistente na divisão ativa desta conta.' using errcode = 'PT409';
        end if;
        v_pending := (v_part ->> 'pending')::numeric;
        if v_pending <= 0 then
          raise exception 'Uma das partes já está quitada.' using errcode = 'PT409';
        end if;
        if v_amt > v_pending then
          raise exception 'A alocação passa do pendente da parte (R$ %).',
            replace(to_char(v_pending, 'FM9999999990.00'), '.', ',') using errcode = 'PT409';
        end if;
        v_sum := v_sum + v_amt;
      end loop;
      if v_sum <> p_amount then
        raise exception 'As alocações (R$ %) não somam o valor do pagamento (R$ %).',
          replace(to_char(v_sum, 'FM9999999990.00'), '.', ','), replace(to_char(p_amount, 'FM9999999990.00'), '.', ',') using errcode = 'PT400';
      end if;
      v_alloc := p_allocations;
    end if;
  end if;

  -- grava (R-10): pagamento, movimento de caixa, alocações, evento
  select * into v_point from public.service_points where id = v_session.service_point_id and company_id = v_session.company_id;
  v_label := case when v_point.type = 'table' then 'Mesa ' || coalesce(v_point.code, '') else 'Comanda ' || coalesce(v_point.code, '') end;

  begin
    insert into public.service_payments (
      company_id, service_session_id, cash_session_id, payment_method, amount, amount_received, change_amount, created_by, client_request_id
    ) values (
      v_company, v_session.id, v_cash.id, p_method, p_amount, v_received, v_change, auth.uid(), p_client_request_id
    ) returning * into v_payment;
  exception when unique_violation then
    raise exception 'Este identificador de requisição já foi usado em outro pagamento.' using errcode = 'PT409';
  end;

  insert into public.cash_movements (
    company_id, cash_session_id, service_session_id, service_payment_id,
    movement_type, payment_method, amount, description, created_by
  ) values (
    v_company, v_cash.id, v_session.id, v_payment.id, 'sale', p_method, p_amount, 'Venda - ' || v_label, auth.uid()
  );

  if v_has_split then
    for v_el in select * from jsonb_array_elements(v_alloc) loop
      insert into public.service_payment_allocations (company_id, service_payment_id, part_id, service_session_id, amount)
      values (v_company, v_payment.id, (v_el ->> 'part_id')::uuid, v_session.id, (v_el ->> 'amount')::numeric);
    end loop;
  end if;

  insert into public.service_session_events (company_id, service_session_id, event_type, actor_id, request_id, payload)
  values (
    v_company, v_session.id, 'payment_registered', auth.uid(), p_client_request_id,
    jsonb_build_object(
      'payment_id', v_payment.id,
      'method', p_method,
      'amount', p_amount,
      'amount_received', v_received,
      'change_amount', v_change,
      'cash_session_id', v_cash.id,
      'balance_before', v_balance,
      'expected_balance', p_expected_balance,
      'allocations', case when v_has_split then v_alloc else '[]'::jsonb end,
      'allocation_confirmed', case when p_allocations is not null then true else false end
    )
  );

  return public.service_payment_result(v_payment.id, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Bloqueio PROVISÓRIO do fechamento legado (até a E8): sem exceção, nem com saldo zero
-- ---------------------------------------------------------------------------
-- close_service_session (inalterada nesta etapa) não conhece pagamentos parciais: ela insere os pagamentos que recebe e fecha. Numa
-- conta que JÁ recebeu pagamento por register_service_payment isso pagaria duas vezes. Este gatilho NEGA, sem exceção baseada em
-- saldo, qualquer passagem de aberta para fechada de uma conta de comanda/mesa que tenha pelo menos 1 pagamento registrado pela E3
-- (identificado por service_payments.client_request_id, coluna criada na E1 e que NENHUM fluxo antigo preenche). O erro (PT409)
-- aborta o comando inteiro: como a RPC antiga insere pagamentos e movimentos ANTES do UPDATE que dispara o gatilho, a exceção
-- desfaz tudo (pagamentos, movimentos de caixa e estado da conta). Contas sem pagamento da E3 (todo o fluxo atual, histórico,
-- delivery e retirada) não são afetadas. A E8 troca este bloqueio pelo encerramento correto (saldo zerado) e remove o gatilho.
create function public.partial_payments_guard_close()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status = 'open' and new.status = 'closed' and new.kind = 'point'
     and exists (
       select 1 from public.service_payments p
       where p.company_id = new.company_id and p.service_session_id = new.id and p.client_request_id is not null
     ) then
    raise exception 'Esta comanda já recebeu pagamento parcial e não pode ser encerrada por este caminho (o encerramento correto chega na etapa seguinte).'
      using errcode = 'PT409';
  end if;
  return new;
end;
$$;

create trigger service_sessions_guard_partial_close
  before update on public.service_sessions
  for each row execute function public.partial_payments_guard_close();

revoke execute on function public.partial_payments_guard_close() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4) Permissões
-- ---------------------------------------------------------------------------
revoke execute on function public.service_payment_result(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.register_service_payment(uuid, text, numeric, numeric, uuid, numeric, uuid, jsonb, boolean) from public, anon;
grant execute on function public.register_service_payment(uuid, text, numeric, numeric, uuid, numeric, uuid, jsonb, boolean) to authenticated;

comment on function public.register_service_payment(uuid, text, numeric, numeric, uuid, numeric, uuid, jsonb, boolean) is
  'E3: registra UM pagamento em conta aberta de comanda/mesa sem encerrá-la. Idempotente por client_request_id; valida empresa, papel, caixa aberto, saldo e (com divisão ativa) parte/alocações explícitas e confirmadas. Regras: docs/pagamentos-parciais-e3-regras.md.';

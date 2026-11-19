-- Reverte 20261215020000_partial_payments_write_gate.sql (E9.1A): restaura o corpo EXATO anterior das 4 RPCs de escrita (E3/E5/E7, E4, E6, E8)
-- e remove a função da chave. Sem dados a restaurar; idempotente; vale a partir da próxima chamada. Transação única.
-- Depois do rollback as 4 RPCs voltam a NÃO depender da chave por empresa (o módulo/E9.1 continua existindo).
begin;

create or replace function public.register_service_payment(
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
  v_alloc_hash text;
  v_ev_hash text;
  v_detail jsonb := '[]'::jsonb;
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

  -- E5-3: identificador da alocação pedida (parte, alocações e confirmação) para a idempotência
  v_alloc_hash := md5(coalesce(p_part_id::text, '') || '|' || coalesce(p_allocations::text, '') || '|' || coalesce(p_confirm_allocation::text, 'false'));

  -- R-2: idempotência (antes de qualquer outra regra de estado: a réplica vale mesmo com a conta já fechada)
  select * into v_existing from public.service_payments
  where company_id = v_company and client_request_id = p_client_request_id;
  if found then
    if v_existing.service_session_id = v_session.id
       and v_existing.payment_method = p_method
       and v_existing.amount = p_amount
       and v_existing.created_by = auth.uid()
       and v_existing.amount_received is not distinct from p_amount_received then
      -- E5-3: a réplica só vale se a parte/alocações/confirmação forem as MESMAS do pedido original
      select e.payload ->> 'alloc_hash' into v_ev_hash from public.service_session_events e
      where e.company_id = v_company and e.event_type = 'payment_registered' and e.request_id = p_client_request_id;
      if v_ev_hash is not null and v_ev_hash <> v_alloc_hash then
        raise exception 'Este identificador de requisição já foi usado com outra parte/alocação.' using errcode = 'PT409';
      end if;
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
    -- E7: o consumo caiu abaixo do previsto das partes (over_distributed): não se recebe pelas partes desatualizadas; refaça a divisão
    if (v_core ->> 'over_distributed')::numeric > 0 then
      raise exception 'As partes da divisão passam do total da conta (o consumo mudou). Substitua a divisão antes de receber pelas partes.' using errcode = 'PT409';
    end if;
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

  -- E5-1: detalhe auditável por parte (rótulo, pendente antes/depois) e versão da divisão
  if v_has_split then
    for v_el in select * from jsonb_array_elements(v_alloc) loop
      select pt into v_part from jsonb_array_elements(v_core -> 'parts') pt where (pt ->> 'part_id')::uuid = (v_el ->> 'part_id')::uuid;
      v_detail := v_detail || jsonb_build_array(jsonb_build_object(
        'part_id', v_el ->> 'part_id', 'label', v_part ->> 'label', 'amount', (v_el ->> 'amount')::numeric,
        'pending_before', (v_part ->> 'pending')::numeric, 'pending_after', (v_part ->> 'pending')::numeric - (v_el ->> 'amount')::numeric));
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
      'allocation_confirmed', case when p_allocations is not null then true else false end,
      'alloc_hash', v_alloc_hash,
      'allocations_detail', v_detail,
      'split_version', case when v_has_split then (v_core -> 'split' ->> 'version')::integer end,
      'parts_touched', jsonb_array_length(v_detail),
      'excess_to_other_parts', jsonb_array_length(v_detail) > 1,
      'balance_after', v_balance - p_amount
    )
  );

  return public.service_payment_result(v_payment.id, false);
end;
$$;

create or replace function public.replace_session_split(
  p_service_session_id uuid,
  p_mode text,
  p_parts jsonb,
  p_expected_version integer,
  p_client_request_id uuid
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
  v_ev public.service_session_events;
  v_hash text;
  v_cur public.service_session_splits;
  v_cur_version integer := 0;
  v_core jsonb;
  v_bal bigint;
  v_n integer;
  v_i integer;
  v_el jsonb;
  v_it jsonb;
  v_label text;
  v_labels text[] := '{}';
  v_cents bigint[] := '{}';
  v_sum bigint := 0;
  v_base bigint;
  v_rem bigint;
  v_amt numeric;
  v_new uuid;
  v_part uuid;
  v_pool record;
  v_item uuid;
  v_qty integer;
  v_assigned jsonb := '{}'::jsonb;
  v_have integer;
  v_pool_value bigint := 0;
  v_unit bigint;
  v_part_cents bigint;
  v_part_ids uuid[] := '{}';
  v_summary jsonb := '[]'::jsonb;
  v_event_type text;
begin
  -- S-1: sessão e entradas
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if p_client_request_id is null then
    raise exception 'Informe o identificador da requisição (client_request_id).' using errcode = 'PT400';
  end if;
  if p_expected_version is null or p_expected_version < 0 then
    raise exception 'Informe a versão da divisão que você está vendo (0 se ainda não há divisão).' using errcode = 'PT400';
  end if;
  if p_mode is null or p_mode not in ('equal', 'values', 'products') then
    raise exception 'Modo de divisão inválido.' using errcode = 'PT400';
  end if;
  if p_parts is null or jsonb_typeof(p_parts) <> 'array' then
    raise exception 'Informe as partes da divisão.' using errcode = 'PT400';
  end if;
  v_n := jsonb_array_length(p_parts);
  if v_n < 2 or v_n > 50 then
    raise exception 'Uma divisão precisa de 2 a 50 partes.' using errcode = 'PT400';
  end if;

  select company_id into v_company from public.service_sessions where id = p_service_session_id;
  if v_company is null then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  v_role := public.user_role_in_company(v_company);
  if v_role is null then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier') then
    raise exception 'Você não tem permissão para dividir a conta.' using errcode = 'PT403';
  end if;

  -- S-6: trava a conta (mesma trava de pagamento, pedido, cancelamento e fechamento)
  select * into v_session from public.service_sessions where id = p_service_session_id for update;
  if not found then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;

  -- S-7: idempotência (antes das regras de estado: a réplica vale mesmo se já existe versão mais nova)
  v_hash := md5(p_mode || ':' || p_expected_version::text || ':' || p_parts::text);
  select * into v_ev from public.service_session_events
  where company_id = v_company and event_type in ('split_created', 'split_replaced') and request_id = p_client_request_id
  limit 1;
  if found then
    if v_ev.service_session_id = v_session.id and v_ev.payload ->> 'request_hash' = v_hash then
      return public.service_split_result((v_ev.payload ->> 'split_id')::uuid, true);
    end if;
    raise exception 'Este identificador de requisição já foi usado em outra divisão.' using errcode = 'PT409';
  end if;

  -- S-2
  if v_session.status <> 'open' then
    raise exception 'Este atendimento já foi fechado.' using errcode = 'PT409';
  end if;
  if v_session.kind <> 'point' then
    raise exception 'Delivery e retirada não têm divisão de conta.' using errcode = 'PT409';
  end if;

  -- S-6: versão
  select * into v_cur from public.service_session_splits
  where company_id = v_company and service_session_id = v_session.id and status = 'active';
  if found then v_cur_version := v_cur.version; end if;
  if p_expected_version <> v_cur_version then
    raise exception 'A divisão foi alterada por outra pessoa (versão atual %). Atualize a tela e refaça.', v_cur_version using errcode = 'PT409';
  end if;

  -- S-3: o saldo pendente é o que as partes novas precisam cobrir
  v_core := public.service_session_financial_core(v_company, v_session.id);
  v_bal := round((v_core ->> 'balance_due')::numeric * 100)::bigint;
  if v_bal <= 0 then
    raise exception 'Não há saldo pendente para dividir.' using errcode = 'PT409';
  end if;

  -- rótulos (comuns aos três modos) e valores por parte, em CENTAVOS
  for v_i in 1..v_n loop
    v_el := p_parts -> (v_i - 1);
    if jsonb_typeof(v_el) <> 'object' then
      raise exception 'Parte % inválida.', v_i using errcode = 'PT400';
    end if;
    if v_el ? 'label' and jsonb_typeof(v_el -> 'label') not in ('string', 'null') then
      raise exception 'O rótulo da parte % deve ser texto.', v_i using errcode = 'PT400';
    end if;
    v_label := nullif(btrim(coalesce(v_el ->> 'label', '')), '');
    if v_label is null then v_label := 'Pessoa ' || v_i; end if;
    if char_length(v_label) > 40 then
      raise exception 'O rótulo da parte % passa de 40 caracteres.', v_i using errcode = 'PT400';
    end if;
    if lower(v_label) = any (v_labels) then
      raise exception 'O rótulo "%" aparece mais de uma vez.', v_label using errcode = 'PT400';
    end if;
    v_labels := v_labels || lower(v_label);
    v_summary := v_summary || jsonb_build_array(jsonb_build_object('label', v_label));
  end loop;
  -- (v_labels guarda minúsculas só para a checagem; os rótulos reais são relidos abaixo)

  if p_mode = 'equal' then
    -- S-5: piso + centavos extras para as primeiras partes
    v_base := v_bal / v_n;
    v_rem := v_bal % v_n;
    if v_base < 1 then
      raise exception 'O saldo (% centavos) é menor que o número de partes.', v_bal using errcode = 'PT400';
    end if;
    for v_i in 1..v_n loop
      v_cents := v_cents || (v_base + case when v_i <= v_rem then 1 else 0 end);
    end loop;

  elsif p_mode = 'values' then
    for v_i in 1..v_n loop
      v_el := p_parts -> (v_i - 1);
      if jsonb_typeof(v_el -> 'amount') is distinct from 'number' then
        raise exception 'Informe o valor da parte %.', v_i using errcode = 'PT400';
      end if;
      v_amt := (v_el ->> 'amount')::numeric;
      if v_amt <= 0 or v_amt >= 10000000000 or v_amt <> round(v_amt, 2) then
        raise exception 'O valor de cada parte deve ser maior que zero, com até 2 casas decimais.' using errcode = 'PT400';
      end if;
      v_cents := v_cents || (v_amt * 100)::bigint;
      v_sum := v_sum + (v_amt * 100)::bigint;
    end loop;
    if v_sum <> v_bal then
      raise exception 'As partes (R$ %) precisam somar exatamente o saldo pendente (R$ %).',
        replace(to_char(v_sum / 100.0, 'FM9999999990.00'), '.', ','), replace(to_char(v_bal / 100.0, 'FM9999999990.00'), '.', ',') using errcode = 'PT400';
    end if;

  else
    -- products: S-8/S-9
    select coalesce(sum(available * unit_cents), 0) into v_pool_value
    from public.service_session_split_item_pool(v_company, v_session.id);
    if v_pool_value <> v_bal then
      raise exception 'O dinheiro já pago não corresponde a itens quitados (itens disponíveis R$ %, saldo R$ %). Divida o saldo em partes iguais ou por valores.',
        replace(to_char(v_pool_value / 100.0, 'FM9999999990.00'), '.', ','), replace(to_char(v_bal / 100.0, 'FM9999999990.00'), '.', ',') using errcode = 'PT409';
    end if;
    for v_i in 1..v_n loop
      v_el := p_parts -> (v_i - 1);
      v_it := v_el -> 'items';
      if jsonb_typeof(v_it) is distinct from 'array' or jsonb_array_length(v_it) = 0 then
        raise exception 'A parte % precisa ter pelo menos um item.', v_i using errcode = 'PT400';
      end if;
      v_part_cents := 0;
      for v_qty in 0..jsonb_array_length(v_it) - 1 loop
        if jsonb_typeof(v_it -> v_qty) <> 'object'
           or jsonb_typeof(v_it -> v_qty -> 'item_id') <> 'string'
           or (v_it -> v_qty ->> 'item_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           or jsonb_typeof(v_it -> v_qty -> 'quantity') <> 'number'
           or (v_it -> v_qty ->> 'quantity') !~ '^[0-9]+$' then
          raise exception 'Item inválido na parte %.', v_i using errcode = 'PT400';
        end if;
        v_item := (v_it -> v_qty ->> 'item_id')::uuid;
        v_have := (v_it -> v_qty ->> 'quantity')::integer;
        if v_have < 1 then
          raise exception 'A quantidade de cada item deve ser maior que zero.' using errcode = 'PT400';
        end if;
        select * into v_pool from public.service_session_split_item_pool(v_company, v_session.id) where item_id = v_item;
        if not found then
          raise exception 'Item não pertence a esta conta (ou o pedido foi cancelado).' using errcode = 'PT409';
        end if;
        v_assigned := jsonb_set(v_assigned, array[v_item::text], to_jsonb(coalesce((v_assigned ->> v_item::text)::integer, 0) + v_have));
        if (v_assigned ->> v_item::text)::integer > v_pool.available then
          raise exception 'O item "%" já foi atribuído ou pago (disponível: % unidade(s)); a mesma unidade não pode ser cobrada de duas pessoas.', v_pool.item_name, v_pool.available using errcode = 'PT409';
        end if;
        v_part_cents := v_part_cents + v_have * v_pool.unit_cents;
      end loop;
      v_cents := v_cents || v_part_cents;
      v_sum := v_sum + v_part_cents;
    end loop;
    for v_pool in select * from public.service_session_split_item_pool(v_company, v_session.id) where available > 0 loop
      if coalesce((v_assigned ->> v_pool.item_id::text)::integer, 0) < v_pool.available then
        raise exception 'Há unidades do item "%" sem pessoa responsável; atribua todas as unidades.', v_pool.item_name using errcode = 'PT409';
      end if;
    end loop;
    if v_sum <> v_bal then
      raise exception 'As partes por produto não somam o saldo pendente.' using errcode = 'PT400';
    end if;
  end if;

  -- grava: a versão ativa vira substituída (nada é apagado) e nasce a seguinte com as partes novas
  if v_cur_version > 0 then
    update public.service_session_splits set status = 'superseded', superseded_at = now() where id = v_cur.id;
  end if;
  insert into public.service_session_splits (company_id, service_session_id, mode, version, created_by)
  values (v_company, v_session.id, p_mode, v_cur_version + 1, auth.uid())
  returning id into v_new;

  v_summary := '[]'::jsonb;
  for v_i in 1..v_n loop
    v_el := p_parts -> (v_i - 1);
    v_label := coalesce(nullif(btrim(coalesce(v_el ->> 'label', '')), ''), 'Pessoa ' || v_i);
    insert into public.service_session_parts (company_id, split_id, service_session_id, position, label, planned_amount)
    values (v_company, v_new, v_session.id, v_i, v_label, v_cents[v_i]::numeric / 100)
    returning id into v_part;
    v_part_ids := v_part_ids || v_part;
    v_summary := v_summary || jsonb_build_array(jsonb_build_object('label', v_label, 'planned_cents', v_cents[v_i]));
    if p_mode = 'products' then
      for v_qty in 0..jsonb_array_length(v_el -> 'items') - 1 loop
        insert into public.service_session_part_items (company_id, part_id, service_session_id, service_order_item_id, quantity)
        values (v_company, v_part, v_session.id, (v_el -> 'items' -> v_qty ->> 'item_id')::uuid, (v_el -> 'items' -> v_qty ->> 'quantity')::integer);
      end loop;
    end if;
  end loop;

  v_event_type := case when v_cur_version = 0 then 'split_created' else 'split_replaced' end;
  begin
    insert into public.service_session_events (company_id, service_session_id, event_type, actor_id, request_id, payload)
    values (
      v_company, v_session.id, v_event_type, auth.uid(), p_client_request_id,
      jsonb_build_object(
        'split_id', v_new, 'mode', p_mode, 'version_from', v_cur_version, 'version_to', v_cur_version + 1,
        'replaced_split_id', case when v_cur_version > 0 then v_cur.id end,
        'balance_cents', v_bal, 'parts', v_summary, 'request_hash', v_hash
      )
    );
  exception when unique_violation then
    raise exception 'Este identificador de requisição já foi usado em outra divisão.' using errcode = 'PT409';
  end;

  return public.service_split_result(v_new, false);
end;
$$;

create or replace function public.refund_open_session_payment(
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

create or replace function public.close_settled_service_session(p_service_session_id uuid, p_client_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_role public.company_role;
  v_session public.service_sessions;
  v_ev public.service_session_events;
  v_core jsonb;
  v_total numeric(12, 2);
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if p_client_request_id is null then
    raise exception 'Informe o identificador da requisição (client_request_id).' using errcode = 'PT400';
  end if;

  select company_id into v_company from public.service_sessions where id = p_service_session_id;
  if v_company is null then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  v_role := public.user_role_in_company(v_company);
  if v_role is null then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier') then
    raise exception 'Você não tem permissão para encerrar contas.' using errcode = 'PT403';
  end if;

  -- trava a CONTA (única trava desta RPC); pedidos, pagamentos, estornos, divisões e cancelamentos concorrentes esperam aqui
  select * into v_session from public.service_sessions where id = p_service_session_id for update;
  if not found then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;

  -- idempotência (antes de qualquer regra de estado: a réplica vale com a conta já fechada)
  select * into v_ev from public.service_session_events
  where company_id = v_company and event_type = 'session_closed' and request_id = p_client_request_id;
  if found then
    if v_ev.service_session_id = v_session.id and v_ev.actor_id = auth.uid() then
      return jsonb_build_object(
        'service_session_id', v_session.id,
        'session_status', v_session.status,
        'closed_at', v_session.closed_at,
        'total_amount', v_session.total_amount,
        'replayed', true);
    end if;
    raise exception 'Este identificador de requisição já foi usado em outro encerramento.' using errcode = 'PT409';
  end if;

  if v_session.status <> 'open' then
    raise exception 'Este atendimento já foi fechado.' using errcode = 'PT409';
  end if;
  if v_session.kind <> 'point' then
    raise exception 'Delivery e retirada são encerrados pelo módulo Delivery.' using errcode = 'PT409';
  end if;

  v_core := public.service_session_financial_core(v_company, v_session.id);
  if (v_core ->> 'balance_due')::numeric > 0 then
    raise exception 'Ainda há saldo a receber nesta conta.' using errcode = 'PT409';
  end if;
  if (v_core ->> 'overpaid')::numeric > 0 then
    raise exception 'A conta recebeu mais do que o total. Estorne o excedente antes de encerrar.' using errcode = 'PT409';
  end if;
  if coalesce((v_core ->> 'over_distributed')::numeric, 0) > 0 then
    raise exception 'As partes da divisão passam do total da conta. Refaça a divisão antes de encerrar.' using errcode = 'PT409';
  end if;
  if coalesce((v_core ->> 'undistributed')::numeric, 0) > 0 then
    raise exception 'Há valor da conta fora das partes da divisão. Refaça a divisão antes de encerrar.' using errcode = 'PT409';
  end if;
  if exists (
       select 1 from jsonb_array_elements(coalesce(v_core -> 'parts', '[]'::jsonb)) pt
       where (pt ->> 'pending')::numeric > 0
     ) then
    raise exception 'Há parte da divisão ainda não quitada.' using errcode = 'PT409';
  end if;
  v_total := (v_core ->> 'total')::numeric(12, 2);

  -- o evento vem ANTES do UPDATE: é a autorização que o gatilho procura (mesma transação)
  insert into public.service_session_events (company_id, service_session_id, event_type, actor_id, request_id, payload)
  values (v_company, v_session.id, 'session_closed', auth.uid(), p_client_request_id,
          jsonb_build_object(
            'total', v_total,
            'paid', v_core -> 'paid',
            'refunded', v_core -> 'refunded',
            'net_paid', v_core -> 'net_paid',
            'settled_paid', v_core -> 'settled_paid',
            'payments_count', v_core -> 'payments_count',
            'refunds_count', v_core -> 'refunds_count',
            'split', v_core -> 'split',
            'parts_count', jsonb_array_length(coalesce(v_core -> 'parts', '[]'::jsonb)),
            'closed_via', 'close_settled_service_session'));

  update public.service_sessions
     set status = 'closed', closed_at = now(), closed_by = auth.uid(), total_amount = v_total
   where id = v_session.id
  returning * into v_session;

  return jsonb_build_object(
    'service_session_id', v_session.id,
    'session_status', v_session.status,
    'closed_at', v_session.closed_at,
    'total_amount', v_session.total_amount,
    'replayed', false);
end;
$$;

drop function if exists public.partial_payments_assert_enabled(uuid);

commit;

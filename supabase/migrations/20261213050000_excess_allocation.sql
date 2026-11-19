-- =============================================================================
-- PAGAMENTOS PARCIAIS — ETAPA E5: excedente e alocação entre partes (auditoria completa, histórico das partes, idempotência com alocações)
-- =============================================================================
-- Auditoria prévia E3/E4 e regras em docs/pagamentos-parciais-e5-regras.md. NÃO cria uma segunda via de pagamento: existe UMA via
-- (register_service_payment) e ela é ESTENDIDA no lugar (create or replace, MESMA assinatura; os testes de E3/E4 seguem valendo).
-- As regras de excedente (E3 R-12..R-18: parte explícita, alocações que somam o valor, confirmação expressa, nunca distribuir sozinho,
-- teto = saldo da conta, parte quitada recusada) NÃO mudam. Muda só:
--   E5-1  o evento payment_registered guarda o detalhe por parte (rótulo, pendente antes/depois), a versão da divisão, partes tocadas,
--         excesso para outras partes, saldo depois e o hash da alocação (campos antigos intactos);
--   E5-2  get_session_split_history (nova, só leitura): TODAS as versões da divisão com partes quitadas visíveis;
--   E5-3  idempotência: a réplica só vale com a MESMA parte/alocações/confirmação (senão PT409);
--   E5-4  BLOQUEIO PROVISÓRIO do fechamento antigo ESTENDIDO (decisão do usuário, opção B): além das contas com pagamento da E3, nega o
--         fechamento antigo de comanda/mesa com DIVISÃO ATIVA, mesmo sem nenhum pagamento. Provisório: a E8 o substitui pelo encerramento correto.
-- Nenhuma tabela/coluna/índice/gatilho novo; nenhuma outra RPC alterada. ROLLBACK: supabase/rollbacks/excess-allocation/rollback.sql
-- (restaura o corpo da E3 e remove a RPC de histórico; recusa se já existir pagamento com o detalhe da E5).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) register_service_payment (mesma assinatura da E3, estendida)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 2) Histórico das divisões (somente leitura): partes quitadas continuam visíveis
-- ---------------------------------------------------------------------------
create function public.get_session_split_history(p_service_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_role public.company_role;
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select company_id, status into v_company, v_status from public.service_sessions where id = p_service_session_id;
  if v_company is null then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  v_role := public.user_role_in_company(v_company);
  if v_role is null then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier') then
    raise exception 'Você não tem permissão para ver o histórico da divisão.' using errcode = 'PT403';
  end if;

  return (
    select jsonb_build_object(
      'service_session_id', p_service_session_id,
      'session_status', v_status,
      'active_version', (select s.version from public.service_session_splits s where s.company_id = v_company and s.service_session_id = p_service_session_id and s.status = 'active'),
      'splits', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'split_id', s.id, 'mode', s.mode, 'version', s.version, 'status', s.status,
                 'created_at', s.created_at, 'superseded_at', s.superseded_at,
                 'planned_total', coalesce((select sum(p.planned_amount) from public.service_session_parts p where p.company_id = s.company_id and p.split_id = s.id), 0),
                 'paid_total', coalesce((select sum(greatest(x.net_paid, 0)) from (
                     select (coalesce((select sum(a.amount) from public.service_payment_allocations a where a.company_id = p.company_id and a.part_id = p.id), 0)
                           - coalesce((select sum(a.amount) from public.service_refund_allocations a where a.company_id = p.company_id and a.part_id = p.id), 0)) as net_paid
                     from public.service_session_parts p where p.company_id = s.company_id and p.split_id = s.id) x), 0),
                 'parts', coalesce((
                   select jsonb_agg(jsonb_build_object(
                            'part_id', q.id, 'position', q.position, 'label', q.label, 'planned', q.planned_amount,
                            'paid', greatest(q.net_paid, 0),
                            'pending', greatest(q.planned_amount - q.net_paid, 0),
                            'status', case when q.net_paid >= q.planned_amount then 'paid' when q.net_paid > 0 then 'partial' else 'pending' end,
                            'items', coalesce((
                              select jsonb_agg(jsonb_build_object('item_id', pi.service_order_item_id, 'quantity', pi.quantity) order by pi.service_order_item_id)
                              from public.service_session_part_items pi where pi.company_id = q.company_id and pi.part_id = q.id
                            ), '[]'::jsonb)
                          ) order by q.position)
                   from (
                     select p.*, (coalesce((select sum(a.amount) from public.service_payment_allocations a where a.company_id = p.company_id and a.part_id = p.id), 0)
                                - coalesce((select sum(a.amount) from public.service_refund_allocations a where a.company_id = p.company_id and a.part_id = p.id), 0)) as net_paid
                     from public.service_session_parts p where p.company_id = s.company_id and p.split_id = s.id
                   ) q
                 ), '[]'::jsonb)
               ) order by s.version)
        from public.service_session_splits s
        where s.company_id = v_company and s.service_session_id = p_service_session_id
      ), '[]'::jsonb)
    )
  );
end;
$$;

revoke execute on function public.get_session_split_history(uuid) from public, anon;
grant execute on function public.get_session_split_history(uuid) to authenticated;

comment on function public.get_session_split_history(uuid) is
  'E5: histórico de TODAS as versões da divisão da conta (partes quitadas incluídas), com previsto/pago/pendente por parte. owner/admin/cashier. Só leitura.';

-- ---------------------------------------------------------------------------
-- 3) E5-4: bloqueio PROVISÓRIO do fechamento antigo, ampliado (substitui o corpo da E3; o gatilho service_sessions_guard_partial_close é o mesmo)
-- ---------------------------------------------------------------------------
-- close_service_session (inalterada) insere os pagamentos que recebe e fecha; ela NÃO conhece partes. Duas situações em que isso é errado:
--  (1) a conta JÁ recebeu pagamento por register_service_payment (pagaria em dobro) — bloqueio da E3, mantido, sem exceção por saldo nem
--      por versão da divisão;
--  (2) a conta tem DIVISÃO ATIVA (mesmo sem nenhum pagamento): o fechamento antigo pagaria a conta FORA das partes e deixaria as partes
--      "pendentes" no histórico de uma conta paga. Quem divide a conta paga pelas partes (register_service_payment).
-- O gatilho roda no UPDATE que fecha a conta, DENTRO da mesma transação da RPC antiga: o erro PT409 desfaz TUDO (pagamentos e movimentos
-- de caixa que a RPC inseriu antes, e o estado da conta). Não interfere em: contas sem divisão ativa e sem pagamento da E3 (todo o
-- fechamento tradicional), delivery/retirada (kind <> 'point') e contas já fechadas.
-- PROVISÓRIO: a E8 troca este bloqueio por close_service_session ciente de saldo e partes e remove o gatilho. Consequência até lá: uma
-- conta dividida só se encerra depois da E8.
create or replace function public.partial_payments_guard_close()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status = 'open' and new.status = 'closed' and new.kind = 'point' then
    if exists (
         select 1 from public.service_payments p
         where p.company_id = new.company_id and p.service_session_id = new.id and p.client_request_id is not null
       ) then
      raise exception 'Esta comanda já recebeu pagamento parcial e não pode ser encerrada por este caminho (o encerramento correto chega na etapa seguinte).'
        using errcode = 'PT409';
    end if;
    if exists (
         select 1 from public.service_session_splits s
         where s.company_id = new.company_id and s.service_session_id = new.id and s.status = 'active'
       ) then
      raise exception 'Esta comanda tem divisão ativa e não pode ser encerrada por este caminho (pague pelas partes; o encerramento correto chega na etapa seguinte).'
        using errcode = 'PT409';
    end if;
  end if;
  return new;
end;
$$;

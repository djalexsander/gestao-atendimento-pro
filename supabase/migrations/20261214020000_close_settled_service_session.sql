-- =============================================================================
-- PAGAMENTOS PARCIAIS — ETAPA E8: ENCERRAMENTO DE COMANDAS/MESAS JÁ QUITADAS (sem movimentar dinheiro)
-- =============================================================================
-- Cria:
--   close_settled_service_session(p_service_session_id, p_client_request_id) -> jsonb   (owner | admin | cashier)
-- Substitui o CORPO do gatilho partial_payments_guard_close() (mesmo nome, mesma assinatura, mesmo gatilho service_sessions_guard_partial_close).
-- NÃO altera close_service_session, receive_delivery_order, register_service_payment, refund_*, replace_session_split, motor de pedidos,
-- cancelamentos, caixa, pagamentos, estornos, alocações nem versões de divisão. Nenhuma tabela nova, nenhuma coluna nova.
--
-- REGRAS (ver docs/pagamentos-parciais-e8-plano.md e docs/pagamentos-parciais-e8-regras.md)
--  * Só conta ABERTA de comanda/mesa (delivery/retirada: PT409), EXATAMENTE quitada e financeiramente consistente:
--      balance_due = 0, overpaid = 0 e, havendo divisão ativa, undistributed = 0, over_distributed = 0 e TODAS as partes quitadas.
--    Total 0 (tudo cancelado/estornado) fecha sem pagamento. Nenhuma conta é "autocorrigida": a recusa diz o que fazer, sem valores.
--  * NÃO cria pagamento, estorno nem movimento de caixa; NÃO exige caixa aberto (nenhum dinheiro se move). Grava só: status, closed_at,
--    closed_by, total_amount (= total vigente) e UM evento append-only session_closed (operador, request_id e foto financeira).
--  * Idempotente por client_request_id (obrigatório): repetir devolve o mesmo resultado (replayed) sem novo evento; mesmo id em outra
--    conta/operador: PT409. Conta já fechada por outro pedido: PT409.
--  * Ordem de travas: a CONTA (FOR UPDATE) primeiro e só ela (a RPC não toca pagamento, produto nem caixa).
--  * Papéis: owner/admin/cashier; attendant/production/courier: PT403; sem vínculo, outra empresa ou id inexistente: PT404 (mesma resposta).
--
-- FECHAMENTO LEGADO (close_service_session, inalterada): continua impedido, SEM exceção, em conta de comanda/mesa com pagamento da E3
-- (client_request_id preenchido) ou divisão ativa, MESMO QUITADA. A liberação não depende de variável de sessão nem de dado do cliente:
-- o gatilho só deixa passar o UPDATE se, na própria transação, já existe o evento session_closed da conta (só esta RPC o grava; o cliente
-- só tem SELECT em service_session_events) E as invariantes acima valem de novo (defesa em profundidade). Contas sem pagamento da E3 e sem
-- divisão ativa fecham pelo caminho tradicional exatamente como antes.
-- ROLLBACK: supabase/rollbacks/close-settled-service-session/rollback.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Gatilho: corpo novo (substitui o da E5)
-- ---------------------------------------------------------------------------
create or replace function public.partial_payments_guard_close()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_has_pay boolean;
  v_has_split boolean;
  v_core jsonb;
begin
  if old.status = 'open' and new.status = 'closed' and new.kind = 'point' then
    v_has_pay := exists (
      select 1 from public.service_payments p
      where p.company_id = new.company_id and p.service_session_id = new.id and p.client_request_id is not null
    );
    v_has_split := exists (
      select 1 from public.service_session_splits s
      where s.company_id = new.company_id and s.service_session_id = new.id and s.status = 'active'
    );
    if v_has_pay or v_has_split then
      -- única porta de saída: close_settled_service_session (grava o evento session_closed ANTES deste UPDATE, na mesma transação)
      if not exists (
           select 1 from public.service_session_events e
           where e.company_id = new.company_id and e.service_session_id = new.id and e.event_type = 'session_closed'
         ) then
        if v_has_pay then
          raise exception 'Esta comanda já recebeu pagamento parcial e não pode ser encerrada por este caminho. Use o encerramento de conta quitada.'
            using errcode = 'PT409';
        end if;
        raise exception 'Esta comanda tem divisão ativa e não pode ser encerrada por este caminho. Pague pelas partes e use o encerramento de conta quitada.'
          using errcode = 'PT409';
      end if;
      -- defesa em profundidade: mesmo com o evento, a conta precisa estar exatamente quitada e consistente
      v_core := public.service_session_financial_core(new.company_id, new.id);
      if (v_core ->> 'balance_due')::numeric > 0
         or (v_core ->> 'overpaid')::numeric > 0
         or coalesce((v_core ->> 'undistributed')::numeric, 0) > 0
         or coalesce((v_core ->> 'over_distributed')::numeric, 0) > 0
         or exists (
              select 1 from jsonb_array_elements(coalesce(v_core -> 'parts', '[]'::jsonb)) pt
              where (pt ->> 'pending')::numeric > 0
            ) then
        raise exception 'A conta não está exatamente quitada e não pode ser encerrada.' using errcode = 'PT409';
      end if;
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.partial_payments_guard_close() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) RPC: close_settled_service_session
-- ---------------------------------------------------------------------------
create function public.close_settled_service_session(p_service_session_id uuid, p_client_request_id uuid)
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

revoke execute on function public.close_settled_service_session(uuid, uuid) from public, anon;
grant execute on function public.close_settled_service_session(uuid, uuid) to authenticated;

comment on function public.close_settled_service_session(uuid, uuid) is
  'E8: encerra conta ABERTA de comanda/mesa exatamente quitada (saldo 0, sem excedente, partes quitadas). Não cria pagamento, estorno nem movimento de caixa. Idempotente por client_request_id. Grava o evento session_closed.';

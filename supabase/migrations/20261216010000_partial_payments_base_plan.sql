-- =============================================================================
-- CAIXA COMPLETO NO PLANO BASE — pagamentos parciais / divisão de conta deixam de ser módulo contratado
-- =============================================================================
-- Decisão do proprietário: o Caixa (recebimento tradicional e parcial, divisão igual/por valores/por produtos, várias formas, troco, estornos
-- conforme o papel, abertura/movimentação/fechamento de caixa) pertence ao PLANO BASE. Não há módulo Caixa nem cobrança à parte.
-- O recurso é lido em três pontos do banco, todos via company_has_module(empresa, 'partial_payments'):
--   partial_payments_assert_enabled (as 4 RPCs de escrita E3–E8), list_session_payment_overview e report_period (modo "ligado").
-- Esta migration muda SÓ a resposta dessa pergunta para o código 'partial_payments': passa a valer a regra REAL de acesso operacional já
-- existente (company_write_blocked, a mesma que alimenta guard_company_writable e o modo somente leitura), em vez do override comercial.
--   • empresa ativa / em trial / período de graça / inadimplente em atraso / cortesia de plano / não gerenciada (legado) → LIBERADO
--   • pending_payment, restricted, suspended, trial_expired, trial_canceled, canceled (somente leitura) → BLOQUEADO (como antes: PT403 nas RPCs
--     de escrita e na visão em lote; relatório volta ao cálculo anterior). As tabelas financeiras já têm guard_company_writable (PT402).
--   • empresa inexistente / nula → BLOQUEADO.
-- Para todos os OUTROS módulos company_has_module é exatamente o que era. Nenhuma RPC, ACL, papel, trava, idempotência, auditoria ou
-- isolamento muda; nenhum dado é tocado; o módulo 'partial_payments' (inativo, sem preço) e eventuais overrides ficam como estão (sem efeito).
-- Rollback: supabase/rollbacks/partial-payments-base-plan/rollback.sql
-- =============================================================================

create function public.partial_payments_enabled(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_company_id is not null
         and exists (select 1 from public.companies c where c.id = p_company_id)
         and not public.company_write_blocked(p_company_id);
$$;

revoke execute on function public.partial_payments_enabled(uuid) from public, anon, authenticated, service_role;

create or replace function public.company_has_module(p_company_id uuid, p_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
           when p_code = 'partial_payments' then public.partial_payments_enabled(p_company_id)
           else coalesce((public.company_entitlement(p_company_id) -> 'modules') ? p_code, false)
         end;
$$;

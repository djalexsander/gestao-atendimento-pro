-- Reverte 20261214020000_close_settled_service_session.sql (E8): remove a RPC close_settled_service_session e restaura o corpo EXATO do gatilho
-- partial_payments_guard_close() da E5 (bloqueio provisório sem exceção). Sem dados a restaurar: o fechamento é registro normal da conta;
-- contas já encerradas pela RPC nova permanecem fechadas (e seus eventos session_closed ficam como histórico). Idempotente. Transação única.
-- Depois do rollback, comanda/mesa com pagamento parcial ou divisão ativa volta a NÃO poder ser encerrada por nenhum caminho.
begin;

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

revoke execute on function public.partial_payments_guard_close() from public, anon, authenticated;

drop function if exists public.close_settled_service_session(uuid, uuid);

commit;

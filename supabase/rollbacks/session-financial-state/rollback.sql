-- Reverte 20261213020000_session_financial_state.sql (E2): remove SOMENTE as 4 funções de leitura criadas.
-- Elas não gravam dado nenhum e nenhuma outra função/view do banco as referencia (a E3 em diante, quando existir, as usará: reverta
-- aquelas etapas ANTES). Não há dado a restaurar. Tudo numa transação; recusa se alguma função fora das 4 as referenciar.
begin;

do $rb$
declare
  v_dep integer;
begin
  if to_regprocedure('public.get_session_financial_state(uuid)') is null then
    raise exception 'rollback: get_session_financial_state não existe (já revertida?)';
  end if;
  select count(*) into v_dep from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname not in ('get_session_financial_state', 'get_session_payment_status', 'service_session_financial_core', 'service_session_total')
     and (p.prosrc like '%service_session_financial_core%' or p.prosrc like '%service_session_total%'
          or p.prosrc like '%get_session_financial_state%' or p.prosrc like '%get_session_payment_status%');
  if v_dep > 0 then
    raise exception 'rollback: % função(ões) ainda referenciam as funções da E2; nada foi removido', v_dep;
  end if;
end
$rb$;

drop function public.get_session_payment_status(uuid);
drop function public.get_session_financial_state(uuid);
drop function public.service_session_financial_core(uuid, uuid);
drop function public.service_session_total(uuid, uuid);

commit;

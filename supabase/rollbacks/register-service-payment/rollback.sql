-- Reverte 20261213030000_register_service_payment.sql (E3): remove SOMENTE as 2 funções novas.
-- Remove também o gatilho de segurança de encerramento (service_sessions_guard_partial_close) e sua função.
-- SEGURO: recusa se já existir pagamento gravado por esta RPC (service_payments com client_request_id) ou evento payment_registered —
-- remover a função não apaga esses registros, mas eles passariam a existir sem a RPC que os criou; decida o destino antes.
-- Não altera nada das etapas anteriores (E1/E2) nem das RPCs antigas. Transação única.
begin;

do $rb$
declare
  v_n bigint;
begin
  if to_regprocedure('public.register_service_payment(uuid, text, numeric, numeric, uuid, numeric, uuid, jsonb, boolean)') is null then
    raise exception 'rollback: register_service_payment não existe (já revertida?)';
  end if;
  select count(*) into v_n from public.service_payments where client_request_id is not null;
  if v_n > 0 then
    raise exception 'rollback: % pagamento(s) já registrado(s) por esta RPC; nada foi removido', v_n;
  end if;
  select count(*) into v_n from public.service_session_events where event_type = 'payment_registered';
  if v_n > 0 then
    raise exception 'rollback: % evento(s) payment_registered; nada foi removido', v_n;
  end if;
  select count(*) into v_n from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname not in ('register_service_payment', 'service_payment_result')
     and (p.prosrc like '%register_service_payment%' or p.prosrc like '%service_payment_result%');
  if v_n > 0 then
    raise exception 'rollback: % função(ões) ainda referenciam a E3; nada foi removido', v_n;
  end if;
end
$rb$;

drop trigger service_sessions_guard_partial_close on public.service_sessions;
drop function public.partial_payments_guard_close();
drop function public.register_service_payment(uuid, text, numeric, numeric, uuid, numeric, uuid, jsonb, boolean);
drop function public.service_payment_result(uuid, boolean);

commit;

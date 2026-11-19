-- Reverte 20261213060000_refund_open_session_payment.sql (E6): remove SOMENTE as 3 funções novas.
-- SEGURO: recusa se já existir estorno gravado por esta RPC (service_refunds com client_request_id / restores_balance) ou evento payment_refunded:
-- remover a função não apaga esses registros, mas eles passariam a existir sem a RPC que os criou; decida o destino antes.
-- Não altera E1..E5 nem as RPCs antigas. Transação única.
begin;

do $rb$
declare
  v_n bigint;
begin
  if to_regprocedure('public.refund_open_session_payment(uuid, numeric, text, uuid)') is null then
    raise exception 'rollback: refund_open_session_payment não existe (já revertida?)';
  end if;
  select count(*) into v_n from public.service_refunds where client_request_id is not null or restores_balance;
  if v_n > 0 then
    raise exception 'rollback: % estorno(s) já registrado(s) por esta RPC; nada foi removido', v_n;
  end if;
  select count(*) into v_n from public.service_session_events where event_type = 'payment_refunded';
  if v_n > 0 then
    raise exception 'rollback: % evento(s) payment_refunded; nada foi removido', v_n;
  end if;
  select count(*) into v_n from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname not in ('refund_open_session_payment', 'service_refund_allocation_plan', 'service_refund_result')
     and (p.prosrc like '%refund_open_session_payment%' or p.prosrc like '%service_refund_allocation_plan%' or p.prosrc like '%service_refund_result%');
  if v_n > 0 then
    raise exception 'rollback: % função(ões) ainda referenciam a E6; nada foi removido', v_n;
  end if;
end
$rb$;

drop function public.refund_open_session_payment(uuid, numeric, text, uuid);
drop function public.service_refund_result(uuid, boolean);
drop function public.service_refund_allocation_plan(uuid, uuid, numeric, numeric);

commit;

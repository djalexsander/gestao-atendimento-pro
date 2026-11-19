-- Reverte 20261213040000_replace_session_split.sql (E4): remove SOMENTE as 3 funções novas.
-- SEGURO: recusa se já existir divisão criada por esta RPC (eventos split_created/split_replaced ou qualquer divisão/parte), porque as
-- funções são a única forma de manter/substituir essas divisões; remover a função não apaga os registros, mas eles ficariam sem a RPC.
-- Não toca E1/E2/E3 nem as RPCs antigas. Transação única.
begin;

do $rb$
declare
  v_n bigint;
begin
  if to_regprocedure('public.replace_session_split(uuid, text, jsonb, integer, uuid)') is null then
    raise exception 'rollback: replace_session_split não existe (já revertida?)';
  end if;
  select count(*) into v_n from public.service_session_events where event_type in ('split_created', 'split_replaced');
  if v_n > 0 then
    raise exception 'rollback: % evento(s) de divisão; nada foi removido', v_n;
  end if;
  select (select count(*) from public.service_session_splits) + (select count(*) from public.service_session_parts) into v_n;
  if v_n > 0 then
    raise exception 'rollback: % divisão(ões)/parte(s) já existem; nada foi removido', v_n;
  end if;
  select count(*) into v_n from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname not in ('replace_session_split', 'service_split_result', 'service_session_split_item_pool')
     and (p.prosrc like '%replace_session_split%' or p.prosrc like '%service_split_result%' or p.prosrc like '%service_session_split_item_pool%');
  if v_n > 0 then
    raise exception 'rollback: % função(ões) ainda referenciam a E4; nada foi removido', v_n;
  end if;
end
$rb$;

drop function public.replace_session_split(uuid, text, jsonb, integer, uuid);
drop function public.service_split_result(uuid, boolean);
drop function public.service_session_split_item_pool(uuid, uuid);

commit;

-- Reverte 20261213010000_partial_payments_foundation.sql (E1: esquema aditivo de pagamentos parciais / divisão de contas).
--
-- SEGURO POR CONSTRUÇÃO: recusa TUDO se já existir dado que só o recurso novo cria (divisão, partes, alocações, eventos,
-- pagamento/estorno com client_request_id, estorno que recompõe saldo). Nesse caso a reversão apagaria registro
-- financeiro de verdade — por isso aborta, sem remover nada. A migration não backfillou nada, então, ANTES de o recurso
-- ser usado (E3+), este rollback devolve o banco exatamente ao estado anterior.
-- Tudo roda numa transação: se qualquer passo falhar, nada fica pela metade.
-- NUNCA executar com o recurso já em uso sem antes decidir o destino desses dados (exportar/estornar à parte).
begin;

do $rb$
declare
  v_n bigint;
begin
  if to_regclass('public.service_session_splits') is null then
    raise exception 'rollback: service_session_splits não existe (já revertida?)';
  end if;
  select (select count(*) from public.service_session_splits)
       + (select count(*) from public.service_session_parts)
       + (select count(*) from public.service_session_part_items)
       + (select count(*) from public.service_payment_allocations)
       + (select count(*) from public.service_refund_allocations)
       + (select count(*) from public.service_session_events)
    into v_n;
  if v_n > 0 then
    raise exception 'rollback: % registro(s) já existem nas tabelas novas (divisão/alocações/eventos); nada foi removido', v_n;
  end if;
  select count(*) into v_n from public.service_payments where client_request_id is not null;
  if v_n > 0 then
    raise exception 'rollback: % pagamento(s) com client_request_id; nada foi removido', v_n;
  end if;
  select count(*) into v_n from public.service_refunds where client_request_id is not null or restores_balance;
  if v_n > 0 then
    raise exception 'rollback: % estorno(s) novos (client_request_id/restores_balance); nada foi removido', v_n;
  end if;
end
$rb$;

-- gatilhos (primeiro os que dependem das funções)
drop trigger service_refunds_guard_partial_insert on public.service_refunds;
drop trigger service_session_events_immutable on public.service_session_events;

-- tabelas (filhas antes das mães; os gatilhos caem junto)
drop table public.service_session_events;
drop table public.service_refund_allocations;
drop table public.service_payment_allocations;
drop table public.service_session_part_items;
drop table public.service_session_parts;
drop table public.service_session_splits;

-- funções de guarda
drop function public.partial_payments_guard_refund_insert();
drop function public.partial_payments_check_refund_alloc_total();
drop function public.partial_payments_guard_refund_alloc_insert();
drop function public.partial_payments_check_payment_alloc_totals();
drop function public.partial_payments_guard_payment_alloc_insert();
drop function public.partial_payments_check_part_item_total();
drop function public.partial_payments_guard_part_item_insert();
drop function public.partial_payments_guard_part_insert();
drop function public.partial_payments_guard_split_insert();
drop function public.partial_payments_guard_split_update();
drop function public.partial_payments_guard_immutable();

-- colunas e índices nos pagamentos/estornos existentes (as RPCs atuais nunca as usaram)
drop index public.service_refunds_request_key;
drop index public.service_payments_request_key;
alter table public.service_refunds drop column restores_balance, drop column client_request_id;
alter table public.service_payments drop column client_request_id;

commit;

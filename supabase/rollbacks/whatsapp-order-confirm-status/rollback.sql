-- Reverte 20261211010000: remove os campos acrescentados ao retorno 'created' de whatsapp_order_confirm.
do $rb$
declare
  v_def text;
  v_new text := $f$,
                            'order_number', (select o.order_number from public.delivery_orders o
                                              where o.company_id = v_company and o.id = (v_res ->> 'delivery_order_id')::uuid),
                            'order_label', public.delivery_session_label(v_company, (select o.service_session_id from public.delivery_orders o
                                              where o.company_id = v_company and o.id = (v_res ->> 'delivery_order_id')::uuid)),
                            'delivery_status', (select o.delivery_status from public.delivery_orders o
                                              where o.company_id = v_company and o.id = (v_res ->> 'delivery_order_id')::uuid),
                            'production_items', (select count(*) from public.service_order_items i
                                              where i.company_id = v_company and i.order_id = (v_res ->> 'service_order_id')::uuid),
                            'production_queue_items', (select count(*) from public.service_order_items i
                                              where i.company_id = v_company and i.order_id = (v_res ->> 'service_order_id')::uuid
                                                and i.production_status = 'pending' and i.quantity - i.cancelled_quantity > 0)$f$;
begin
  select pg_get_functiondef('public.whatsapp_order_confirm(uuid, uuid)'::regprocedure) into v_def;
  if array_length(string_to_array(v_def, v_new), 1) <> 2 then
    raise exception 'rollback: bloco não encontrado exatamente 1 vez';
  end if;
  execute replace(v_def, v_new, '');
end
$rb$;
revoke execute on function public.whatsapp_order_confirm(uuid, uuid) from public, anon, authenticated;
grant execute on function public.whatsapp_order_confirm(uuid, uuid) to service_role;

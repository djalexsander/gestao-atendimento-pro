-- whatsapp_order_confirm passa a devolver o NÚMERO e o STATUS REAIS do pedido oficial criado (para a IA confirmar ao cliente
-- sem prometer nada que o sistema não tenha confirmado). Só acrescenta campos ao jsonb de retorno 'created'; nada mais muda.
--   order_number / order_label : número sequencial da empresa ("Delivery #0001" / "Retirada #0002")
--   delivery_status            : status gravado pelo motor oficial (nasce 'confirmed')
--   production_items / production_queue_items : itens do pedido e quantos estão realmente na fila de produção (production_status 'pending'; item sem setor entra na fila de todos os setores);
--                                               a IA só diz "enviado para a produção" quando production_queue_items > 0.
do $migration$
declare
  v_def text;
  v_old text := $f$'service_order_id', (v_res ->> 'service_order_id')::uuid, 'total', v_res -> 'total',
                            'fulfillment', v_d.fulfillment);$f$;
  v_new text := $f$'service_order_id', (v_res ->> 'service_order_id')::uuid, 'total', v_res -> 'total',
                            'fulfillment', v_d.fulfillment,
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
                                                and i.production_status = 'pending' and i.quantity - i.cancelled_quantity > 0));$f$;
begin
  select pg_get_functiondef('public.whatsapp_order_confirm(uuid, uuid)'::regprocedure) into v_def;
  if array_length(string_to_array(v_def, v_old), 1) <> 2 then
    raise exception 'whatsapp_order_confirm: âncora do retorno não encontrada exatamente 1 vez';
  end if;
  execute replace(v_def, v_old, v_new);
end
$migration$;

revoke execute on function public.whatsapp_order_confirm(uuid, uuid) from public, anon, authenticated;
grant execute on function public.whatsapp_order_confirm(uuid, uuid) to service_role;

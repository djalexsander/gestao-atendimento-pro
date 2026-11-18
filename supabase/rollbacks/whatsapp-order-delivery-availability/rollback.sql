-- Reverte 20261211020000: as funções do pedido da IA voltam a ler delivery_settings_effective; o helper é removido.
do $rb$
declare
  v_sig text;
  v_def text;
  v_sigs text[] := array[
    'public.whatsapp_order_apply_ops(uuid, jsonb, uuid, integer)',
    'public.whatsapp_order_confirm(uuid, uuid)',
    'public.whatsapp_order_recalc(uuid)',
    'public.whatsapp_order_set_address(uuid, jsonb, uuid, integer)',
    'public.whatsapp_order_state(uuid)'];
begin
  foreach v_sig in array v_sigs loop
    select pg_get_functiondef(v_sig::regprocedure) into v_def;
    if array_length(string_to_array(v_def, 'public.whatsapp_order_delivery_settings('), 1) - 1 <> 1 then
      raise exception 'rollback: % sem exatamente 1 chamada ao helper', v_sig;
    end if;
    execute replace(v_def, 'public.whatsapp_order_delivery_settings(', 'public.delivery_settings_effective(');
  end loop;
end
$rb$;
drop function public.whatsapp_order_delivery_settings(uuid);

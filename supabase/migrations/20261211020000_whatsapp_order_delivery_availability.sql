-- Oferta de modalidades do pedido pela IA: delivery só é oferecido quando a empresa tem delivery OPERACIONAL para o caminho da IA,
-- isto é, delivery_enabled E ao menos uma zona de entrega ATIVA (o pedido da IA exige zona para calcular a taxa; sem zona todo endereço
-- seria recusado). Sem zona ativa, a IA oferece somente retirada. NÃO altera a configuração comercial (company_delivery_settings),
-- nem o fluxo humano / motor oficial (que continuam usando delivery_settings_effective), nem outras empresas (quem tem zona ativa não muda).
create function public.whatsapp_order_delivery_settings(p_company_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select s || jsonb_build_object(
    'delivery_enabled',
    coalesce((s ->> 'delivery_enabled')::boolean, false)
      and exists (select 1 from public.delivery_zones z where z.company_id = p_company_id and z.is_active))
  from (select public.delivery_settings_effective(p_company_id) as s) x;
$$;
revoke execute on function public.whatsapp_order_delivery_settings(uuid) from public, anon, authenticated;
grant execute on function public.whatsapp_order_delivery_settings(uuid) to service_role;

-- as funções do pedido da IA passam a ler a disponibilidade pelo helper (substituição exata; aborta se algo não bater)
do $migration$
declare
  v_sig text;
  v_def text;
  v_n_plain integer;
  v_n_qual integer;
  v_sigs text[] := array[
    'public.whatsapp_order_apply_ops(uuid, jsonb, uuid, integer)',
    'public.whatsapp_order_confirm(uuid, uuid)',
    'public.whatsapp_order_recalc(uuid)',
    'public.whatsapp_order_set_address(uuid, jsonb, uuid, integer)',
    'public.whatsapp_order_state(uuid)'];
begin
  foreach v_sig in array v_sigs loop
    select pg_get_functiondef(v_sig::regprocedure) into v_def;
    v_n_plain := array_length(string_to_array(v_def, 'delivery_settings_effective('), 1) - 1;
    v_n_qual := array_length(string_to_array(v_def, 'public.delivery_settings_effective('), 1) - 1;
    if v_n_plain <> 1 or v_n_qual <> 1 then
      raise exception '% : esperado exatamente 1 chamada a delivery_settings_effective (achou % / %)', v_sig, v_n_plain, v_n_qual;
    end if;
    execute replace(v_def, 'public.delivery_settings_effective(', 'public.whatsapp_order_delivery_settings(');
  end loop;
end
$migration$;
-- CREATE OR REPLACE preserva as permissões (ACL) de cada função: nada é alterado nelas.

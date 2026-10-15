-- WhatsApp, Fase 2A-1 — parte 1: módulo (inativo) e CANAL do pedido de delivery.
--
-- 1) modules: código 'whatsapp', is_active = false, preço 0. O módulo existe para o entitlement (company_module_overrides,
--    com expiração, é como uma empresa de teste o recebe) mas NÃO é produto comercial: inativo, sem preço e fora do
--    catálogo do Master. Nada muda para nenhuma empresa.
-- 2) delivery_orders.channel: de onde veio o pedido (counter | phone | whatsapp | other), SEPARADO de
--    service_orders.origin (quem criou: attendant/cashier/whatsapp/delivery), que continua com a semântica atual.
--    Default 'counter'; todo pedido existente vira 'counter'. Nenhuma RPC grava outro valor nesta fase; o campo
--    é imutável depois da criação (guard).

-- ---------------------------------------------------------------------------
-- 1) Módulo (inativo, sem preço)
-- ---------------------------------------------------------------------------
insert into public.modules (code, name, description, monthly_price_cents, is_active) values
  ('whatsapp', 'WhatsApp',
   'Atendimento por WhatsApp (API oficial) integrado ao cadastro de clientes e ao Delivery.', 0, false)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- 2) delivery_orders.channel
-- ---------------------------------------------------------------------------
alter table public.delivery_orders
  add column channel text not null default 'counter'
    constraint delivery_orders_channel_check check (channel in ('counter', 'phone', 'whatsapp', 'other'));

comment on column public.delivery_orders.channel is
  'Canal de origem do pedido: counter (balcão/sistema), phone, whatsapp ou other. Conceito separado de service_orders.origin.';

-- O guard passa a proteger também o canal (corpo vigente de 20261014070000 + channel).
create or replace function public.guard_delivery_order_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is distinct from old.company_id
     or new.service_session_id is distinct from old.service_session_id
     or new.service_order_id is distinct from old.service_order_id
     or new.client_request_id is distinct from old.client_request_id
     or new.fulfillment is distinct from old.fulfillment
     or new.channel is distinct from old.channel
     or new.customer_id is distinct from old.customer_id
     or new.customer_name is distinct from old.customer_name
     or new.customer_phone is distinct from old.customer_phone
     or new.source_address_id is distinct from old.source_address_id
     or new.addr_street is distinct from old.addr_street
     or new.addr_number is distinct from old.addr_number
     or new.addr_complement is distinct from old.addr_complement
     or new.addr_neighborhood is distinct from old.addr_neighborhood
     or new.addr_city is distinct from old.addr_city
     or new.addr_state is distinct from old.addr_state
     or new.addr_cep is distinct from old.addr_cep
     or new.addr_reference is distinct from old.addr_reference
     or new.delivery_fee is distinct from old.delivery_fee
     or new.fee_source is distinct from old.fee_source
     or new.zone_id is distinct from old.zone_id
     or new.estimated_ready_at is distinct from old.estimated_ready_at
     or new.estimated_delivery_at is distinct from old.estimated_delivery_at
     or new.payment_timing is distinct from old.payment_timing
     or new.expected_method is distinct from old.expected_method
     or new.cash_change_for is distinct from old.cash_change_for
     or new.notes is distinct from old.notes
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Os dados de um pedido de delivery não podem ser alterados.' using errcode = 'PT409';
  end if;

  if new.delivery_status is distinct from old.delivery_status then
    if not (
      (old.delivery_status = 'confirmed' and new.delivery_status in ('out_for_delivery', 'picked_up', 'canceled'))
      or (old.delivery_status = 'out_for_delivery' and new.delivery_status in ('delivered', 'canceled'))
    ) then
      raise exception 'Transição de estado inválida: % -> %.', old.delivery_status, new.delivery_status using errcode = 'PT409';
    end if;
  elsif old.delivery_status in ('delivered', 'picked_up', 'canceled')
        and (new.courier_user_id is distinct from old.courier_user_id
             or new.out_for_delivery_at is distinct from old.out_for_delivery_at
             or new.delivered_at is distinct from old.delivered_at
             or new.picked_up_at is distinct from old.picked_up_at
             or new.canceled_at is distinct from old.canceled_at
             or new.cancel_reason is distinct from old.cancel_reason) then
    raise exception 'Este pedido já foi concluído e não pode mais ser alterado.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_delivery_order_change() from public, anon, authenticated;

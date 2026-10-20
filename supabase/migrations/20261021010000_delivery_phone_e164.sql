-- WhatsApp pedido conversacional — passo 0: telefone do pedido de delivery no padrão E.164 (até 15 dígitos).
--
-- Antes: delivery_orders.customer_phone aceitava só 8 a 13 dígitos (limite herdado do cadastro brasileiro). Contatos
-- internacionais do WhatsApp (whatsapp_conversations.contact_phone aceita 10 a 15 dígitos) ficavam fora do snapshot do
-- pedido. Agora: 8 a 15 dígitos. Padrão do projeto = SÓ DÍGITOS, sem "+" (o "+" é apenas apresentação; delivery_digits()
-- já descarta qualquer não-dígito).
--
-- Migration ADITIVA: só alarga um CHECK (nenhuma linha existente deixa de ser válida). Não toca em customers, companies,
-- cobrança nem em nenhuma função (a validação equivalente dentro de create_delivery_order é alargada na migration do
-- motor, 20261021030000, que já recria essa função).

alter table public.delivery_orders drop constraint delivery_orders_customer_phone_check;
alter table public.delivery_orders
  add constraint delivery_orders_customer_phone_check check (customer_phone is null or customer_phone ~ '^[0-9]{8,15}$');

comment on column public.delivery_orders.customer_phone is
  'Snapshot do telefone do cliente: só dígitos, 8 a 15 (E.164 sem o "+"). Imutável (guard_delivery_order_change).';

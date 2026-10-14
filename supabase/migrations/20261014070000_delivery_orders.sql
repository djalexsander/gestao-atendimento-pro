-- Módulo Delivery, Fase 1 — M8: PEDIDOS DE DELIVERY (delivery_orders) e EVENTOS (delivery_order_events).
-- Só ESTRUTURA, guardas e leitura (RLS). As operações (criar, status, entregador, cancelar, listar) e a
-- integração com submit/fechamento/impressão estão em 20261014080000_delivery_operations.sql.
--
-- MODELO: um pedido de delivery é uma service_session kind='delivery' (sem ponto) + um service_order
-- origin='delivery' (itens, preço, estoque, KDS, modificadores: TODO o motor atual) + UMA linha aqui, com o que é
-- próprio de logística: cliente/endereço (SNAPSHOT), taxa, previsão, pagamento esperado, entregador e estado
-- logístico. A PRODUÇÃO não é duplicada: delivery_status NÃO tem preparing/ready — "em produção"/"pronto" são
-- derivados de service_order_items.production_status (ver list_delivery_orders).
--
-- delivery_status:  confirmed | out_for_delivery | delivered | picked_up | canceled
--   entrega:  confirmed -> out_for_delivery -> delivered ;  confirmed|out_for_delivery -> canceled
--   retirada: confirmed -> picked_up                     ;  confirmed -> canceled
--   terminais (delivered, picked_up, canceled) não voltam. Vale também para escrita direta (trigger).
--
-- Escrita: SÓ pelas RPCs (SECURITY DEFINER). Leitura (RLS): owner/admin/cashier/attendant da empresa com o módulo;
-- courier só os pedidos ATRIBUÍDOS a ele; production não lê aqui (usa o KDS). Para o courier, o acesso às tabelas
-- do núcleo (sessões, pedidos, itens, modificadores, cancelamentos) também é restrito aos seus deliveries.

-- ---------------------------------------------------------------------------
-- 0) Barreira que também aceita courier (leitura/status do próprio pedido)
-- ---------------------------------------------------------------------------
create function public.delivery_assert_actor(p_company_id uuid)
returns public.company_role
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier', 'attendant', 'courier') then
    raise exception 'Você não tem permissão para usar o Delivery.' using errcode = 'PT403';
  end if;
  perform public.assert_company_module(p_company_id, 'delivery');
  return v_role;
end;
$$;

revoke execute on function public.delivery_assert_actor(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1) delivery_orders
-- ---------------------------------------------------------------------------
create table public.delivery_orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  service_session_id uuid not null,
  service_order_id uuid not null,
  -- idempotência da criação (duplo clique / retry): único por empresa
  client_request_id uuid not null,
  fulfillment text not null
    constraint delivery_orders_fulfillment_check check (fulfillment in ('delivery', 'pickup')),
  delivery_status text not null default 'confirmed'
    constraint delivery_orders_status_check check (delivery_status in ('confirmed', 'out_for_delivery', 'delivered', 'picked_up', 'canceled')),

  -- SNAPSHOT do cliente (o cadastro pode mudar depois; o pedido não)
  customer_id uuid,
  customer_name text not null
    constraint delivery_orders_customer_name_length check (char_length(customer_name) between 1 and 80),
  customer_phone text
    constraint delivery_orders_customer_phone_check check (customer_phone is null or customer_phone ~ '^[0-9]{8,13}$'),

  -- SNAPSHOT do endereço (só entrega). source_address_id é só referência informativa.
  source_address_id uuid,
  addr_street text, addr_number text, addr_complement text, addr_neighborhood text,
  addr_city text, addr_state text, addr_cep text, addr_reference text,

  -- taxa (reais; entra no total do fechamento e continua identificável separada dos produtos)
  delivery_fee numeric(12, 2) not null default 0
    constraint delivery_orders_fee_check check (delivery_fee >= 0 and delivery_fee <> 'NaN'::numeric),
  fee_source text not null default 'none'
    constraint delivery_orders_fee_source_check check (fee_source in ('zone', 'default', 'manual', 'none')),
  zone_id uuid,

  -- previsão (calculada no servidor)
  estimated_ready_at timestamptz,
  estimated_delivery_at timestamptz,

  -- pagamento ESPERADO (informação operacional; o recebimento real é no Caixa)
  payment_timing text not null
    constraint delivery_orders_payment_timing_check check (payment_timing in ('on_order', 'on_delivery', 'on_pickup')),
  expected_method text
    constraint delivery_orders_expected_method_check check (expected_method is null or expected_method in ('cash', 'pix', 'debit_card', 'credit_card', 'other')),
  cash_change_for numeric(12, 2)
    constraint delivery_orders_cash_change_check check (cash_change_for is null or (cash_change_for > 0 and cash_change_for <> 'NaN'::numeric)),

  courier_user_id uuid references auth.users(id) on delete set null,

  out_for_delivery_at timestamptz,
  delivered_at timestamptz,
  picked_up_at timestamptz,
  canceled_at timestamptz,
  cancel_reason text
    constraint delivery_orders_cancel_reason_length check (cancel_reason is null or char_length(cancel_reason) between 1 and 200),
  notes text
    constraint delivery_orders_notes_length check (notes is null or char_length(notes) between 1 and 300),

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- vínculos SEMPRE compostos: nada aponta para outra empresa
  constraint delivery_orders_session_fkey foreign key (company_id, service_session_id) references public.service_sessions (company_id, id),
  constraint delivery_orders_order_fkey foreign key (company_id, service_order_id) references public.service_orders (company_id, id),
  constraint delivery_orders_customer_fkey foreign key (company_id, customer_id) references public.customers (company_id, id),
  constraint delivery_orders_address_fkey foreign key (company_id, source_address_id) references public.customer_addresses (company_id, id),
  constraint delivery_orders_zone_fkey foreign key (company_id, zone_id) references public.delivery_zones (company_id, id),
  constraint delivery_orders_session_key unique (company_id, service_session_id),
  constraint delivery_orders_order_key unique (company_id, service_order_id),
  constraint delivery_orders_request_key unique (company_id, client_request_id),
  constraint delivery_orders_company_id_id_key unique (company_id, id),

  -- ENTREGA: endereço completo, status picked_up proibido, pagamento no pedido ou na entrega
  constraint delivery_orders_delivery_shape check (
    fulfillment <> 'delivery' or (
      addr_street is not null and addr_neighborhood is not null and addr_city is not null and addr_state is not null
      and delivery_status <> 'picked_up'
      and payment_timing in ('on_order', 'on_delivery')
      and estimated_delivery_at is not null
    )
  ),
  -- RETIRADA: sem endereço, sem taxa, sem entregador, sem rota; pagamento no pedido ou na retirada
  constraint delivery_orders_pickup_shape check (
    fulfillment <> 'pickup' or (
      addr_street is null and addr_number is null and addr_complement is null and addr_neighborhood is null
      and addr_city is null and addr_state is null and addr_cep is null and addr_reference is null
      and source_address_id is null
      and delivery_fee = 0 and fee_source = 'none' and zone_id is null
      and courier_user_id is null
      and delivery_status not in ('out_for_delivery', 'delivered')
      and payment_timing in ('on_order', 'on_pickup')
    )
  ),
  constraint delivery_orders_change_for_check check (cash_change_for is null or expected_method = 'cash'),
  -- carimbos coerentes com o estado
  constraint delivery_orders_stamps_check check (
    (delivery_status = 'confirmed' and out_for_delivery_at is null and delivered_at is null and picked_up_at is null and canceled_at is null)
    or (delivery_status = 'out_for_delivery' and out_for_delivery_at is not null and delivered_at is null and picked_up_at is null and canceled_at is null)
    or (delivery_status = 'delivered' and out_for_delivery_at is not null and delivered_at is not null and picked_up_at is null and canceled_at is null)
    or (delivery_status = 'picked_up' and picked_up_at is not null and out_for_delivery_at is null and delivered_at is null and canceled_at is null)
    or (delivery_status = 'canceled' and canceled_at is not null and cancel_reason is not null and delivered_at is null and picked_up_at is null)
  )
);

create index delivery_orders_company_created_idx on public.delivery_orders (company_id, created_at desc);
create index delivery_orders_company_status_idx on public.delivery_orders (company_id, delivery_status, created_at desc);
create index delivery_orders_courier_idx on public.delivery_orders (courier_user_id, created_at desc) where courier_user_id is not null;
create index delivery_orders_customer_idx on public.delivery_orders (company_id, customer_id) where customer_id is not null;

comment on table public.delivery_orders is
  'Pedido de delivery/retirada: 1 por service_session kind=delivery. Snapshot de cliente e endereço, taxa, previsão, pagamento esperado, entregador e estado LOGÍSTICO. Produção é derivada dos itens (não duplicada aqui). Escrita só por RPC.';
comment on column public.delivery_orders.delivery_fee is
  'Taxa de entrega (reais). Somada ao total do fechamento (close_service_session) e mantida separada da receita de produtos.';

create trigger delivery_orders_set_updated_at
  before update on public.delivery_orders
  for each row execute function public.set_updated_at();

-- Identidade/snapshot imutáveis; estado só avança pelas transições permitidas (vale até para escrita direta).
create function public.guard_delivery_order_change()
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

create trigger delivery_orders_guard_change
  before update on public.delivery_orders
  for each row execute function public.guard_delivery_order_change();

-- ---------------------------------------------------------------------------
-- 2) Eventos (append-only)
-- ---------------------------------------------------------------------------
create table public.delivery_order_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  delivery_order_id uuid not null,
  event_type text not null
    constraint delivery_order_events_type_check check (event_type in ('created', 'status_changed', 'courier_assigned', 'fee_overridden', 'canceled')),
  actor_user_id uuid references auth.users(id) on delete set null,
  old_value jsonb,
  new_value jsonb,
  note text
    constraint delivery_order_events_note_length check (note is null or char_length(note) between 1 and 300),
  created_at timestamptz not null default now(),
  constraint delivery_order_events_order_fkey foreign key (company_id, delivery_order_id) references public.delivery_orders (company_id, id)
);

create index delivery_order_events_order_idx on public.delivery_order_events (company_id, delivery_order_id, created_at);

comment on table public.delivery_order_events is
  'Trilha append-only do pedido de delivery (criação, status, entregador, ajuste de taxa, cancelamento). Sem UPDATE/DELETE.';

-- Append-only: UPDATE nunca; DELETE só como cascata da exclusão da EMPRESA (profundidade de trigger > 1).
create function public.guard_delivery_event_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'Eventos do delivery são imutáveis.' using errcode = 'PT409';
end;
$$;

revoke execute on function public.guard_delivery_event_immutable() from public, anon, authenticated;

create trigger delivery_order_events_immutable
  before update or delete on public.delivery_order_events
  for each row execute function public.guard_delivery_event_immutable();

-- ---------------------------------------------------------------------------
-- 3) Helpers de RLS do courier (boolean sobre os PRÓPRIOS deliveries; não revelam nada além disso)
-- ---------------------------------------------------------------------------
create function public.delivery_courier_owns_session(p_company_id uuid, p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.delivery_orders d
    where d.company_id = p_company_id and d.service_session_id = p_session_id and d.courier_user_id = auth.uid()
  );
$$;

create function public.delivery_courier_owns_order(p_company_id uuid, p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.delivery_orders d
    where d.company_id = p_company_id and d.service_order_id = p_order_id and d.courier_user_id = auth.uid()
  );
$$;

create function public.delivery_courier_owns_item(p_company_id uuid, p_item_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.service_order_items i
    join public.delivery_orders d on d.company_id = i.company_id and d.service_order_id = i.order_id
    where i.company_id = p_company_id and i.id = p_item_id and d.courier_user_id = auth.uid()
  );
$$;

revoke execute on function public.delivery_courier_owns_session(uuid, uuid) from public, anon;
revoke execute on function public.delivery_courier_owns_order(uuid, uuid) from public, anon;
revoke execute on function public.delivery_courier_owns_item(uuid, uuid) from public, anon;
grant execute on function public.delivery_courier_owns_session(uuid, uuid) to authenticated;
grant execute on function public.delivery_courier_owns_order(uuid, uuid) to authenticated;
grant execute on function public.delivery_courier_owns_item(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) RLS / GRANTs
-- ---------------------------------------------------------------------------
alter table public.delivery_orders enable row level security;
alter table public.delivery_order_events enable row level security;

create policy delivery_orders_select on public.delivery_orders
  for select to authenticated
  using (
    public.company_has_module_rls(company_id, 'delivery')
    and (
      public.user_role_in_company(company_id) in ('owner', 'admin', 'cashier', 'attendant')
      or (public.user_role_in_company(company_id) = 'courier' and courier_user_id = auth.uid())
    )
  );

create policy delivery_order_events_select on public.delivery_order_events
  for select to authenticated
  using (
    public.company_has_module_rls(company_id, 'delivery')
    and (
      public.user_role_in_company(company_id) in ('owner', 'admin', 'cashier', 'attendant')
      or (public.user_role_in_company(company_id) = 'courier'
          and exists (select 1 from public.delivery_orders d
                      where d.company_id = delivery_order_events.company_id and d.id = delivery_order_events.delivery_order_id
                        and d.courier_user_id = auth.uid()))
    )
  );

revoke all on public.delivery_orders from public, anon, authenticated;
revoke all on public.delivery_order_events from public, anon, authenticated;
grant select on public.delivery_orders to authenticated;
grant select on public.delivery_order_events to authenticated;
grant all on public.delivery_orders to service_role;
grant select, insert on public.delivery_order_events to service_role;

-- Courier: no núcleo, só enxerga o que é dos SEUS deliveries (as políticas permissivas atuais deixavam qualquer
-- vínculo ativo da empresa ler todos os pedidos). RESTRICTIVE: soma-se às existentes, nunca as afrouxa.
create policy service_sessions_courier_scope on public.service_sessions as restrictive for select to authenticated
  using (public.user_role_in_company(company_id) is distinct from 'courier' or public.delivery_courier_owns_session(company_id, id));
create policy service_orders_courier_scope on public.service_orders as restrictive for select to authenticated
  using (public.user_role_in_company(company_id) is distinct from 'courier' or public.delivery_courier_owns_session(company_id, service_session_id));
create policy service_order_items_courier_scope on public.service_order_items as restrictive for select to authenticated
  using (public.user_role_in_company(company_id) is distinct from 'courier' or public.delivery_courier_owns_order(company_id, order_id));
create policy service_order_item_modifiers_courier_scope on public.service_order_item_modifiers as restrictive for select to authenticated
  using (public.user_role_in_company(company_id) is distinct from 'courier' or public.delivery_courier_owns_item(company_id, service_order_item_id));
create policy service_order_item_cancellations_courier_scope on public.service_order_item_cancellations as restrictive for select to authenticated
  using (public.user_role_in_company(company_id) is distinct from 'courier' or public.delivery_courier_owns_item(company_id, service_order_item_id));

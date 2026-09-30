-- ESTOQUE SIMPLES POR PRODUTO + DISPONIBILIDADE MANUAL + RELATÓRIOS POR PERÍODO.
--
-- Dois tipos de produto:
--   * PREPARADO (espeto, X-salada, porção...): stock_control = 'none' (PADRÃO). Não tem saldo,
--     nunca baixa estoque e nunca é bloqueado por quantidade. Segue entrando em pedidos, produção e
--     relatórios normalmente.
--   * CONTROLADO (Coca-Cola lata, cerveja, água...): stock_control = 'quantity'. O próprio produto
--     vendido é a unidade estocável: stock_quantity (inteiro, nunca negativo) e
--     minimum_stock_quantity. Sem ficha técnica / insumos nesta etapa.
-- Disponibilidade manual (available_for_sale): independente de estoque e de is_active
-- (is_active = cadastro ativo; available_for_sale = "pode ser lançado em pedido agora").
-- Produto indisponível continua cadastrado e no histórico, mas não entra em pedido novo.
--
--   1. products: stock_control, stock_quantity, minimum_stock_quantity, available_for_sale.
--      Sem grant de escrita nessas colunas: só as RPCs abaixo.
--   2. product_stock_movements: ledger append-only (quantidade sempre POSITIVA; o tipo define
--      entrada/saída) com saldo após cada movimento e a origem (item do pedido / cancelamento).
--   3. submit_service_order: produto indisponível é recusado; produto controlado é travado (em ordem
--      de id), conferido e baixado NA MESMA transação do pedido (saldo insuficiente = rollback de
--      todo o pedido, sem pedido pela metade); produto 'none' não participa.
--   4. cancel_service_order_item: item ainda 'pending' de produto controlado devolve o estoque
--      (proporcional ao EVENTO, nunca mais do que foi vendido); 'preparing'/'ready' NÃO devolve
--      (owner/admin faz uma entrada se o produto voltou fisicamente); produto 'none': nada.
--   5. RPCs: set_product_stock_control, add_stock_movement, set_product_availability.
--   6. Relatórios (owner/admin): report_period(empresa, de, até, categoria, setor) agrega no
--      servidor vendas, formas de pagamento, produtos vendidos, cancelamentos, estornos, caixas e
--      produção. Período = dias civis em America/Sao_Paulo (máx. 366 dias).
--
-- Idempotência: unique parcial (uma baixa por item de pedido; uma reversão por cancelamento).
-- Quem pode o quê:
--   controle de estoque, entrada, ajuste   owner/admin
--   disponível/indisponível                owner/admin e production (só esse toggle)
--   relatórios                             owner/admin

-- ---------------------------------------------------------------------------
-- 1) products
-- ---------------------------------------------------------------------------
alter table public.products
  add column stock_control text not null default 'none'
    constraint products_stock_control_check check (stock_control in ('none', 'quantity')),
  add column stock_quantity integer not null default 0
    constraint products_stock_quantity_check check (stock_quantity >= 0),
  add column minimum_stock_quantity integer not null default 0
    constraint products_minimum_stock_quantity_check check (minimum_stock_quantity >= 0),
  add column available_for_sale boolean not null default true;

alter table public.products
  add constraint products_stock_none_zero_check check (stock_control = 'quantity' or stock_quantity = 0);

comment on column public.products.stock_control is
  'none (padrão): sem controle de quantidade; quantity: saldo em stock_quantity, baixa na venda, bloqueia quando acaba. Só set_product_stock_control() muda.';
comment on column public.products.stock_quantity is
  'Saldo físico do produto controlado. Só muda por RPC/pedido/cancelamento, junto de um product_stock_movements. Nunca negativo.';
comment on column public.products.available_for_sale is
  'Disponibilidade operacional manual: false = não pode ser lançado em pedido novo (continua cadastrado e no histórico). Independe de is_active e de estoque.';

-- ---------------------------------------------------------------------------
-- 2) Ledger de estoque do produto (append-only)
-- ---------------------------------------------------------------------------
alter table public.service_order_item_cancellations
  add constraint service_order_item_cancellations_company_id_id_key unique (company_id, id);

create table public.product_stock_movements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  product_id uuid not null,
  movement_type text not null
    constraint product_stock_movements_type_check check (movement_type in (
      'opening', 'entry', 'adjustment_in', 'adjustment_out', 'sale', 'cancellation_reversal'
    )),
  quantity integer not null
    constraint product_stock_movements_quantity_check check (quantity > 0),
  reason text not null
    constraint product_stock_movements_reason_length check (char_length(reason) between 1 and 200),
  balance_after integer not null
    constraint product_stock_movements_balance_check check (balance_after >= 0),
  service_order_item_id uuid,
  cancellation_id uuid,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint product_stock_movements_product_fkey
    foreign key (company_id, product_id) references public.products (company_id, id),
  constraint product_stock_movements_order_item_fkey
    foreign key (company_id, service_order_item_id) references public.service_order_items (company_id, id),
  constraint product_stock_movements_cancellation_fkey
    foreign key (company_id, cancellation_id) references public.service_order_item_cancellations (company_id, id),
  constraint product_stock_movements_origin_check check (
    (movement_type = 'sale' and service_order_item_id is not null and cancellation_id is null)
    or (movement_type = 'cancellation_reversal' and service_order_item_id is not null and cancellation_id is not null)
    or (movement_type in ('opening', 'entry', 'adjustment_in', 'adjustment_out')
        and service_order_item_id is null and cancellation_id is null)
  )
);

-- Idempotência: uma baixa por item de pedido; uma reversão por evento de cancelamento.
create unique index product_stock_movements_sale_once
  on public.product_stock_movements (service_order_item_id) where movement_type = 'sale';
create unique index product_stock_movements_reversal_once
  on public.product_stock_movements (cancellation_id) where movement_type = 'cancellation_reversal';

create index product_stock_movements_product_idx
  on public.product_stock_movements (company_id, product_id, created_at desc);
create index product_stock_movements_created_by_idx on public.product_stock_movements (created_by);

comment on table public.product_stock_movements is
  'Ledger de estoque do produto controlado, append-only (sem UPDATE/DELETE pelo cliente). quantity sempre positiva; o tipo define entrada/saída; balance_after = saldo logo após.';

alter table public.product_stock_movements enable row level security;

create policy product_stock_movements_select on public.product_stock_movements
  for select to authenticated
  using (public.user_role_in_company(company_id) in ('owner', 'admin'));

revoke all on public.product_stock_movements from anon, authenticated;
grant select on public.product_stock_movements to authenticated;
grant all on public.product_stock_movements to service_role;

-- ---------------------------------------------------------------------------
-- 5a) RPC: ligar/desligar o controle de estoque (e ajustar o mínimo)
-- ---------------------------------------------------------------------------
-- none -> quantity: começa com saldo 0 (use "Entrada" para o saldo inicial). quantity -> none: o saldo
-- restante sai por um ajuste de saída ("Controle de estoque desativado") e fica 0; o histórico fica.
-- Com modo 'quantity' já ativo, serve para mudar o estoque mínimo.
create function public.set_product_stock_control(
  p_product_id uuid,
  p_mode text,
  p_minimum integer default 0
)
returns public.products
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.products;
  v_role public.company_role;
  v_minimum integer := coalesce(p_minimum, 0);
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_product from public.products where id = p_product_id for update;
  if not found then
    raise exception 'Produto não encontrado.' using errcode = 'PT404';
  end if;

  v_role := public.user_role_in_company(v_product.company_id);
  if v_role is null then
    raise exception 'Produto não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Você não tem permissão para alterar o controle de estoque.' using errcode = 'PT403';
  end if;

  if p_mode is null or p_mode not in ('none', 'quantity') then
    raise exception 'Modo de controle inválido.' using errcode = 'PT400';
  end if;
  if v_minimum < 0 or v_minimum > 1000000000 then
    raise exception 'O estoque mínimo deve ser zero ou mais.' using errcode = 'PT400';
  end if;

  if p_mode = 'none' then
    if v_product.stock_control = 'quantity' and v_product.stock_quantity > 0 then
      insert into public.product_stock_movements (company_id, product_id, movement_type, quantity, reason, balance_after, created_by)
      values (v_product.company_id, v_product.id, 'adjustment_out', v_product.stock_quantity, 'Controle de estoque desativado', 0, auth.uid());
    end if;
    update public.products
       set stock_control = 'none', stock_quantity = 0, minimum_stock_quantity = 0
     where id = v_product.id
    returning * into v_product;
  else
    update public.products
       set stock_control = 'quantity', minimum_stock_quantity = v_minimum
     where id = v_product.id
    returning * into v_product;
  end if;

  return v_product;
end;
$$;

revoke execute on function public.set_product_stock_control(uuid, text, integer) from public, anon;
grant execute on function public.set_product_stock_control(uuid, text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 5b) RPC: entrada / ajuste manual (só produto CONTROLADO)
-- ---------------------------------------------------------------------------
create function public.add_stock_movement(
  p_product_id uuid,
  p_movement_type text,
  p_quantity integer,
  p_reason text
)
returns public.product_stock_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.products;
  v_role public.company_role;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_balance integer;
  v_movement public.product_stock_movements;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_product from public.products where id = p_product_id for update;
  if not found then
    raise exception 'Produto não encontrado.' using errcode = 'PT404';
  end if;

  v_role := public.user_role_in_company(v_product.company_id);
  if v_role is null then
    raise exception 'Produto não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Você não tem permissão para movimentar o estoque.' using errcode = 'PT403';
  end if;

  if v_product.stock_control <> 'quantity' then
    raise exception 'Este produto não controla estoque.' using errcode = 'PT409';
  end if;
  if p_movement_type is null or p_movement_type not in ('entry', 'adjustment_in', 'adjustment_out') then
    raise exception 'Tipo de movimento inválido.' using errcode = 'PT400';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > 1000000 then
    raise exception 'Informe uma quantidade inteira maior que zero.' using errcode = 'PT400';
  end if;
  -- Ajustes exigem motivo; a entrada aceita "Reposição" como padrão.
  if v_reason is null and p_movement_type = 'entry' then
    v_reason := 'Reposição';
  end if;
  if v_reason is null then
    raise exception 'Informe o motivo do ajuste.' using errcode = 'PT400';
  end if;
  if char_length(v_reason) > 200 then
    raise exception 'O motivo pode ter no máximo 200 caracteres.' using errcode = 'PT400';
  end if;

  if p_movement_type = 'adjustment_out' then
    if p_quantity > v_product.stock_quantity then
      raise exception 'A saída deixaria o estoque negativo (saldo atual: %).', v_product.stock_quantity using errcode = 'PT400';
    end if;
    v_balance := v_product.stock_quantity - p_quantity;
  else
    v_balance := v_product.stock_quantity + p_quantity;
  end if;

  update public.products set stock_quantity = v_balance where id = v_product.id;

  insert into public.product_stock_movements (
    company_id, product_id, movement_type, quantity, reason, balance_after, created_by
  ) values (
    v_product.company_id, v_product.id, p_movement_type, p_quantity, v_reason, v_balance, auth.uid()
  ) returning * into v_movement;

  return v_movement;
end;
$$;

revoke execute on function public.add_stock_movement(uuid, text, integer, text) from public, anon;
grant execute on function public.add_stock_movement(uuid, text, integer, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5c) RPC: disponível / indisponível para venda (owner, admin e production)
-- ---------------------------------------------------------------------------
create function public.set_product_availability(p_product_id uuid, p_available boolean)
returns public.products
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.products;
  v_role public.company_role;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if p_available is null then
    raise exception 'Informe a disponibilidade.' using errcode = 'PT400';
  end if;

  select * into v_product from public.products where id = p_product_id for update;
  if not found then
    raise exception 'Produto não encontrado.' using errcode = 'PT404';
  end if;

  v_role := public.user_role_in_company(v_product.company_id);
  if v_role is null then
    raise exception 'Produto não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'production') then
    raise exception 'Você não tem permissão para alterar a disponibilidade.' using errcode = 'PT403';
  end if;

  update public.products set available_for_sale = p_available where id = v_product.id returning * into v_product;
  return v_product;
end;
$$;

revoke execute on function public.set_product_availability(uuid, boolean) from public, anon;
grant execute on function public.set_product_availability(uuid, boolean) to authenticated;


-- ---------------------------------------------------------------------------
-- 3) submit_service_order: disponibilidade + baixa atômica (mesma assinatura e ACL da 20260928020000)
-- ---------------------------------------------------------------------------
create or replace function public.submit_service_order(
  p_service_session_id uuid,
  p_items jsonb
)
returns public.service_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.service_sessions;
  v_role public.company_role;
  v_origin text;
  v_order public.service_orders;
  v_item jsonb;
  v_product public.products;
  v_category public.product_categories;
  v_quantity numeric;
  v_notes text;
  v_sector_id uuid;
  v_item_id uuid;
  v_balance integer;
  v_label text;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_session from public.service_sessions where id = p_service_session_id;
  if not found then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;

  v_role := public.user_role_in_company(v_session.company_id);
  if v_role is null then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier', 'attendant') then
    raise exception 'Você não tem permissão para lançar pedidos.' using errcode = 'PT403';
  end if;

  if v_session.status <> 'open' then
    raise exception 'Este atendimento não está aberto.' using errcode = 'PT409';
  end if;

  -- Origem decidida pelo papel de quem chama (nunca por um valor enviado no payload): só
  -- attendant tem área operacional própria hoje; os demais papéis autorizados operam como Caixa.
  v_origin := case when v_role = 'attendant' then 'attendant' else 'cashier' end;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Informe ao menos um item.' using errcode = 'PT400';
  end if;
  if jsonb_array_length(p_items) > 100 then
    raise exception 'Envie no máximo 100 itens por pedido.' using errcode = 'PT400';
  end if;

  -- ESTOQUE: trava, em ORDEM DE id (sem deadlock entre vendas simultâneas), os produtos CONTROLADOS
  -- do pedido antes de gravar qualquer coisa. Produtos sem controle não participam.
  perform 1
  from public.products p
  where p.company_id = v_session.company_id
    and p.stock_control = 'quantity'
    and p.id in (
      select (e ->> 'product_id')::uuid from jsonb_array_elements(p_items) e where e ->> 'product_id' is not null
    )
  order by p.id
  for update;

  select (case when sp.type = 'table' then 'Mesa ' else 'Comanda ' end) || sp.code into v_label
  from public.service_points sp
  where sp.company_id = v_session.company_id and sp.id = v_session.service_point_id;

  insert into public.service_orders (company_id, service_session_id, origin, status, created_by)
  values (v_session.company_id, v_session.id, v_origin, 'submitted', auth.uid())
  returning * into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    if v_item ->> 'product_id' is null then
      raise exception 'Cada item precisa de um produto.' using errcode = 'PT400';
    end if;

    if jsonb_typeof(v_item -> 'quantity') is distinct from 'number' then
      raise exception 'Quantidade inválida.' using errcode = 'PT400';
    end if;
    v_quantity := (v_item ->> 'quantity')::numeric;
    if v_quantity is null or v_quantity <= 0 or v_quantity <> trunc(v_quantity) then
      raise exception 'A quantidade precisa ser um número inteiro maior que zero.' using errcode = 'PT400';
    end if;

    v_notes := nullif(btrim(v_item ->> 'notes'), '');
    if v_notes is not null and char_length(v_notes) > 200 then
      raise exception 'A observação pode ter no máximo 200 caracteres.' using errcode = 'PT400';
    end if;

    -- company_id no WHERE garante, sozinho, "produto de outra empresa é recusado" (not found).
    select * into v_product
    from public.products
    where id = (v_item ->> 'product_id')::uuid
      and company_id = v_session.company_id;
    if not found then
      raise exception 'Produto não encontrado.' using errcode = 'PT404';
    end if;
    if not v_product.is_active then
      raise exception 'Produto inativo.' using errcode = 'PT409';
    end if;
    if not v_product.available_for_sale then
      raise exception 'Este produto está indisponível para venda: %.', v_product.name using errcode = 'PT409';
    end if;

    select * into v_category
    from public.product_categories
    where id = v_product.category_id
      and company_id = v_session.company_id;
    if not found or not v_category.is_active then
      raise exception 'Categoria do produto inativa.' using errcode = 'PT409';
    end if;

    -- Setor EFETIVO no momento do envio (mesma regra de products_with_effective_sector, 040000).
    v_sector_id := coalesce(v_product.production_sector_id, v_category.default_production_sector_id);

    insert into public.service_order_items (
      company_id, order_id, product_id, product_name_snapshot, quantity, unit_price, production_sector_id, notes
    ) values (
      v_session.company_id, v_order.id, v_product.id, v_product.name, v_quantity::integer, v_product.sale_price, v_sector_id, v_notes
    ) returning id into v_item_id;

    -- BAIXA (só produto controlado; o produto já está travado acima). Várias linhas do mesmo
    -- produto baixam em sequência, então o saldo é conferido de forma agregada.
    if v_product.stock_control = 'quantity' then
      update public.products
         set stock_quantity = stock_quantity - v_quantity::integer
       where id = v_product.id and stock_quantity >= v_quantity::integer
      returning stock_quantity into v_balance;
      if not found then
        raise exception 'Estoque insuficiente para %. Disponível: %, solicitado: %.',
          v_product.name,
          (select stock_quantity from public.products where id = v_product.id),
          v_quantity::integer using errcode = 'PT409';
      end if;

      insert into public.product_stock_movements (
        company_id, product_id, movement_type, quantity, reason, balance_after, service_order_item_id, created_by
      ) values (
        v_session.company_id, v_product.id, 'sale', v_quantity::integer,
        left('Pedido ' || coalesce(v_label, ''), 200), v_balance, v_item_id, auth.uid()
      );
    end if;
  end loop;

  return v_order;
end;
$$;

revoke execute on function public.submit_service_order(uuid, jsonb) from public, anon;
grant execute on function public.submit_service_order(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) cancel_service_order_item: devolve estoque só de item 'pending' (mesma assinatura e ACL da 20260930070000)
-- ---------------------------------------------------------------------------
create or replace function public.cancel_service_order_item(
  p_item_id uuid,
  p_quantity integer,
  p_reason text
)
returns public.service_order_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.service_order_items;
  v_order_status text;
  v_session public.service_sessions;
  v_role public.company_role;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_active integer;
  v_event_id uuid;
  v_product public.products;
  v_sold integer;
  v_reversed integer;
  v_back integer;
  v_balance integer;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  -- Leitura sem trava só para achar o atendimento; tudo é revalidado depois das travas.
  select * into v_item from public.service_order_items where id = p_item_id;
  if not found then
    raise exception 'Item não encontrado.' using errcode = 'PT404';
  end if;

  select ss.* into v_session
  from public.service_orders o
  join public.service_sessions ss on ss.company_id = o.company_id and ss.id = o.service_session_id
  where o.company_id = v_item.company_id and o.id = v_item.order_id
  for update of ss;
  if not found then
    raise exception 'Item não encontrado.' using errcode = 'PT404';
  end if;

  v_role := public.user_role_in_company(v_session.company_id);
  if v_role is null then
    raise exception 'Item não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier', 'attendant') then
    raise exception 'Você não tem permissão para cancelar itens.' using errcode = 'PT403';
  end if;

  if v_session.status <> 'open' then
    raise exception 'Esta conta já foi fechada. Utilize um estorno.' using errcode = 'PT409';
  end if;

  select * into v_item from public.service_order_items where id = p_item_id for update;

  select status into v_order_status
  from public.service_orders
  where company_id = v_item.company_id and id = v_item.order_id;
  if v_order_status is distinct from 'submitted' then
    raise exception 'Este pedido já foi cancelado.' using errcode = 'PT409';
  end if;

  v_active := v_item.quantity - v_item.cancelled_quantity;
  if v_active <= 0 then
    raise exception 'Este item já foi totalmente cancelado.' using errcode = 'PT409';
  end if;

  if v_role in ('cashier', 'attendant') and v_item.production_status <> 'pending' then
    raise exception 'Este item já entrou em produção. Solicite o cancelamento a um administrador.' using errcode = 'PT403';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Informe a quantidade a cancelar (número inteiro maior que zero).' using errcode = 'PT400';
  end if;
  if p_quantity > v_active then
    raise exception 'A quantidade a cancelar é maior que a disponível (%).', v_active using errcode = 'PT400';
  end if;
  if v_reason is null then
    raise exception 'Informe o motivo do cancelamento.' using errcode = 'PT400';
  end if;
  if char_length(v_reason) > 200 then
    raise exception 'O motivo pode ter no máximo 200 caracteres.' using errcode = 'PT400';
  end if;

  update public.service_order_items
     set cancelled_quantity = cancelled_quantity + p_quantity
   where id = v_item.id
  returning * into v_item;

  insert into public.service_order_item_cancellations (company_id, service_order_item_id, quantity, reason, cancelled_by)
  values (v_item.company_id, v_item.id, p_quantity, v_reason, auth.uid())
  returning id into v_event_id;

  -- ESTOQUE (só produto controlado): item ainda 'pending' devolve a quantidade deste evento, nunca
  -- mais do que foi vendido. Em 'preparing'/'ready' NÃO devolve automaticamente (owner/admin faz uma
  -- entrada se o produto voltou fisicamente). Produto sem controle: nenhuma movimentação.
  if v_item.production_status = 'pending' then
    select * into v_product from public.products
    where company_id = v_item.company_id and id = v_item.product_id for update;

    if found and v_product.stock_control = 'quantity' then
      select coalesce(sum(quantity), 0) into v_sold
      from public.product_stock_movements
      where service_order_item_id = v_item.id and movement_type = 'sale';

      select coalesce(sum(quantity), 0) into v_reversed
      from public.product_stock_movements
      where service_order_item_id = v_item.id and movement_type = 'cancellation_reversal';

      v_back := least(p_quantity, v_sold - v_reversed);
      if v_back > 0 then
        update public.products set stock_quantity = stock_quantity + v_back
         where id = v_product.id
        returning stock_quantity into v_balance;

        insert into public.product_stock_movements (
          company_id, product_id, movement_type, quantity, reason, balance_after,
          service_order_item_id, cancellation_id, created_by
        ) values (
          v_item.company_id, v_product.id, 'cancellation_reversal', v_back,
          left('Cancelamento: ' || v_reason, 200), v_balance, v_item.id, v_event_id, auth.uid()
        );
      end if;
    end if;
  end if;

  -- Pedido sem nenhuma unidade cobrável: cancelado por inteiro.
  if not exists (
    select 1 from public.service_order_items i
    where i.company_id = v_item.company_id and i.order_id = v_item.order_id
      and i.cancelled_quantity < i.quantity
  ) then
    update public.service_orders
       set status = 'cancelled', cancelled_at = now()
     where company_id = v_item.company_id and id = v_item.order_id;
  end if;

  return v_item;
end;
$$;

revoke execute on function public.cancel_service_order_item(uuid, integer, text) from public, anon;
grant execute on function public.cancel_service_order_item(uuid, integer, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6) Relatórios por período (owner/admin) — agregação NO SERVIDOR
-- ---------------------------------------------------------------------------
-- p_from/p_to: dias civis INCLUSIVOS em America/Sao_Paulo (máx. 366 dias). Critérios de data:
--   vendas/contas fechadas e produtos vendidos -> service_sessions.closed_at (só conta FECHADA = paga);
--   formas de pagamento -> service_payments.created_at;  estornos -> service_refunds.created_at
--   (estorno do período pode ser de uma venda anterior: líquido = bruto - estornos do período);
--   cancelamentos -> evento (created_at);  caixas -> cash_sessions.opened_at;  produção -> production_ready_at.
-- Categoria/setor filtram produtos vendidos e produção (o setor é o do ITEM, snapshot do pedido).
-- Os índices novos abaixo evitam varrer o histórico inteiro para um período curto.

create index service_sessions_closed_at_idx
  on public.service_sessions (company_id, closed_at) where status = 'closed';
create index service_payments_created_at_idx
  on public.service_payments (company_id, created_at);
create index service_refunds_created_at_idx
  on public.service_refunds (company_id, created_at);

create function public.report_period(
  p_company_id uuid,
  p_from date,
  p_to date,
  p_category_id uuid default null,
  p_sector_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_start timestamptz;
  v_end timestamptz;
  v_gross numeric(12, 2);
  v_sessions integer;
  v_refunded numeric(12, 2);
  v_items_sold bigint;
  v_methods jsonb;
  v_products jsonb;
  v_cancel jsonb;
  v_refunds jsonb;
  v_cash jsonb;
  v_production jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Você não tem permissão para ver relatórios.' using errcode = 'PT403';
  end if;

  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Informe um período válido (data inicial até a final).' using errcode = 'PT400';
  end if;
  if p_from < date '2000-01-01' or p_to > date '2100-01-01' or p_to - p_from > 365 then
    raise exception 'O período pode ter no máximo 366 dias.' using errcode = 'PT400';
  end if;

  v_start := (p_from::timestamp) at time zone 'America/Sao_Paulo';
  v_end := ((p_to + 1)::timestamp) at time zone 'America/Sao_Paulo';

  -- ---- vendas -----------------------------------------------------------------------------
  select coalesce(sum(total_amount), 0)::numeric(12, 2), count(*)::integer
    into v_gross, v_sessions
  from public.service_sessions
  where company_id = p_company_id and status = 'closed' and closed_at >= v_start and closed_at < v_end;

  select coalesce(sum(amount), 0)::numeric(12, 2) into v_refunded
  from public.service_refunds
  where company_id = p_company_id and created_at >= v_start and created_at < v_end;

  select coalesce(sum(i.quantity - i.cancelled_quantity), 0) into v_items_sold
  from public.service_order_items i
  join public.service_orders o on o.company_id = i.company_id and o.id = i.order_id
  join public.service_sessions ss on ss.company_id = o.company_id and ss.id = o.service_session_id
  where i.company_id = p_company_id and ss.status = 'closed' and ss.closed_at >= v_start and ss.closed_at < v_end;

  -- ---- formas de pagamento (todas as 5, mesmo zeradas) -------------------------------------
  select jsonb_agg(jsonb_build_object(
           'method', m.method,
           'paid', coalesce(p.paid, 0),
           'refunded', coalesce(r.refunded, 0),
           'net', coalesce(p.paid, 0) - coalesce(r.refunded, 0)
         ) order by m.ord)
    into v_methods
  from (values ('cash', 1), ('pix', 2), ('debit_card', 3), ('credit_card', 4), ('other', 5)) as m(method, ord)
  left join (
    select payment_method, sum(amount)::numeric(12, 2) as paid
    from public.service_payments
    where company_id = p_company_id and created_at >= v_start and created_at < v_end
    group by payment_method
  ) p on p.payment_method = m.method
  left join (
    select pay.payment_method, sum(rf.amount)::numeric(12, 2) as refunded
    from public.service_refunds rf
    join public.service_payments pay on pay.company_id = rf.company_id and pay.id = rf.service_payment_id
    where rf.company_id = p_company_id and rf.created_at >= v_start and rf.created_at < v_end
    group by pay.payment_method
  ) r on r.payment_method = m.method;

  -- ---- produtos vendidos (contas fechadas no período) --------------------------------------
  select coalesce(jsonb_agg(to_jsonb(x) order by x.value_net desc, x.name), '[]'::jsonb) into v_products
  from (
    select
      i.product_id,
      max(i.product_name_snapshot) as name,
      max(c.name) as category,
      sum(i.quantity - i.cancelled_quantity)::integer as quantity_valid,
      sum(i.quantity * i.unit_price)::numeric(12, 2) as value_gross,
      sum(i.cancelled_quantity)::integer as cancelled_quantity,
      sum(i.cancelled_quantity * i.unit_price)::numeric(12, 2) as cancelled_value,
      sum((i.quantity - i.cancelled_quantity) * i.unit_price)::numeric(12, 2) as value_net
    from public.service_order_items i
    join public.service_orders o on o.company_id = i.company_id and o.id = i.order_id
    join public.service_sessions ss on ss.company_id = o.company_id and ss.id = o.service_session_id
    left join public.products p on p.company_id = i.company_id and p.id = i.product_id
    left join public.product_categories c on c.company_id = p.company_id and c.id = p.category_id
    where i.company_id = p_company_id
      and ss.status = 'closed' and ss.closed_at >= v_start and ss.closed_at < v_end
      and (p_category_id is null or p.category_id = p_category_id)
      and (p_sector_id is null or i.production_sector_id = p_sector_id)
    group by i.product_id
    order by value_net desc
    limit 500
  ) x;

  -- ---- cancelamentos (eventos do período) --------------------------------------------------
  with cx as (
    select
      x.id,
      x.created_at,
      i.product_name_snapshot as product,
      x.quantity,
      (x.quantity * i.unit_price)::numeric(12, 2) as value,
      x.reason,
      pr.full_name as cancelled_by_name,
      sp.code as point_code,
      sp.type as point_type
    from public.service_order_item_cancellations x
    join public.service_order_items i on i.company_id = x.company_id and i.id = x.service_order_item_id
    join public.service_orders o on o.company_id = i.company_id and o.id = i.order_id
    join public.service_sessions ss on ss.company_id = o.company_id and ss.id = o.service_session_id
    join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
    left join public.profiles pr on pr.user_id = x.cancelled_by
    where x.company_id = p_company_id and x.created_at >= v_start and x.created_at < v_end
  )
  select jsonb_build_object(
           'events', (select count(*) from cx),
           'quantity', (select coalesce(sum(quantity), 0) from cx),
           'value', (select coalesce(sum(value), 0)::numeric(12, 2) from cx),
           'list', (select coalesce(jsonb_agg(to_jsonb(l) order by l.created_at desc), '[]'::jsonb)
                    from (select * from cx order by created_at desc limit 500) l)
         )
    into v_cancel;

  -- ---- estornos (do período) ---------------------------------------------------------------
  with rx as (
    select
      rf.id,
      rf.created_at,
      pay.payment_method as method,
      rf.amount,
      rf.reason,
      pr.full_name as refunded_by_name,
      sp.code as point_code,
      sp.type as point_type
    from public.service_refunds rf
    join public.service_payments pay on pay.company_id = rf.company_id and pay.id = rf.service_payment_id
    join public.service_sessions ss on ss.company_id = rf.company_id and ss.id = rf.service_session_id
    join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
    left join public.profiles pr on pr.user_id = rf.created_by
    where rf.company_id = p_company_id and rf.created_at >= v_start and rf.created_at < v_end
  )
  select jsonb_build_object(
           'count', (select count(*) from rx),
           'total', (select coalesce(sum(amount), 0)::numeric(12, 2) from rx),
           'list', (select coalesce(jsonb_agg(to_jsonb(l) order by l.created_at desc), '[]'::jsonb)
                    from (select * from rx order by created_at desc limit 500) l)
         )
    into v_refunds;

  -- ---- caixas (abertos no período; cada caixa à parte, nunca somados como uma gaveta só) ---
  with mv as (
    select
      cash_session_id,
      coalesce(sum(amount) filter (where movement_type = 'sale'), 0) as sales,
      coalesce(sum(amount) filter (where movement_type = 'supply'), 0) as supply,
      coalesce(sum(amount) filter (where movement_type = 'withdrawal'), 0) as withdrawal,
      coalesce(sum(amount) filter (where movement_type = 'refund'), 0) as refund
    from public.cash_movements
    where company_id = p_company_id
    group by cash_session_id
  ),
  cs as (
    select
      c.id,
      pr.full_name as operator_name,
      c.opened_at,
      c.closed_at,
      c.status,
      c.opening_amount,
      coalesce(mv.sales, 0)::numeric(12, 2) as sales,
      coalesce(mv.supply, 0)::numeric(12, 2) as supply,
      coalesce(mv.withdrawal, 0)::numeric(12, 2) as withdrawal,
      coalesce(mv.refund, 0)::numeric(12, 2) as refund,
      c.closing_cash_amount,
      c.cash_difference
    from public.cash_sessions c
    left join mv on mv.cash_session_id = c.id
    left join public.profiles pr on pr.user_id = c.opened_by
    where c.company_id = p_company_id and c.opened_at >= v_start and c.opened_at < v_end
  )
  select jsonb_build_object(
           'open_count', (select count(*) from cs where status = 'open'),
           'closed_count', (select count(*) from cs where status = 'closed'),
           'opening_total', (select coalesce(sum(opening_amount), 0)::numeric(12, 2) from cs),
           'sales_total', (select coalesce(sum(sales), 0)::numeric(12, 2) from cs),
           'supply_total', (select coalesce(sum(supply), 0)::numeric(12, 2) from cs),
           'withdrawal_total', (select coalesce(sum(withdrawal), 0)::numeric(12, 2) from cs),
           'refund_total', (select coalesce(sum(refund), 0)::numeric(12, 2) from cs),
           'shortage_total', (select coalesce(-sum(cash_difference) filter (where cash_difference < 0), 0)::numeric(12, 2) from cs),
           'surplus_total', (select coalesce(sum(cash_difference) filter (where cash_difference > 0), 0)::numeric(12, 2) from cs),
           'list', (select coalesce(jsonb_agg(to_jsonb(l) order by l.opened_at desc), '[]'::jsonb)
                    from (select * from cs order by opened_at desc limit 200) l)
         )
    into v_cash;

  -- ---- produção (itens prontos no período) -------------------------------------------------
  with px as (
    select
      i.product_name_snapshot as name,
      coalesce(s.name, 'Sem setor') as sector,
      (i.quantity - i.cancelled_quantity) as qty,
      round(extract(epoch from (i.production_ready_at - o.submitted_at)) / 60)::integer as minutes
    from public.service_order_items i
    join public.service_orders o on o.company_id = i.company_id and o.id = i.order_id
    left join public.products p on p.company_id = i.company_id and p.id = i.product_id
    left join public.production_sectors s on s.company_id = i.company_id and s.id = i.production_sector_id
    where i.company_id = p_company_id
      and o.status = 'submitted'
      and i.quantity > i.cancelled_quantity
      and i.production_status = 'ready'
      and i.production_ready_at >= v_start and i.production_ready_at < v_end
      and (p_category_id is null or p.category_id = p_category_id)
      and (p_sector_id is null or i.production_sector_id = p_sector_id)
  )
  select jsonb_build_object(
           'items', (select coalesce(sum(qty), 0) from px),
           'avg_minutes', (select round(avg(minutes)) from px),
           'by_product', (select coalesce(jsonb_agg(to_jsonb(b) order by b.quantity desc, b.name), '[]'::jsonb)
                          from (select name, sum(qty)::integer as quantity from px group by name order by sum(qty) desc limit 100) b),
           'by_sector', (select coalesce(jsonb_agg(to_jsonb(b) order by b.quantity desc, b.sector), '[]'::jsonb)
                         from (select sector, sum(qty)::integer as quantity from px group by sector) b),
           -- cancelamentos de itens que JÁ estavam em produção (preparing/ready) no período
           'cancelled_in_production', (
             select coalesce(sum(x.quantity), 0)
             from public.service_order_item_cancellations x
             join public.service_order_items i on i.company_id = x.company_id and i.id = x.service_order_item_id
             where x.company_id = p_company_id and x.created_at >= v_start and x.created_at < v_end
               and i.production_status <> 'pending'
               and (p_sector_id is null or i.production_sector_id = p_sector_id)
           )
         )
    into v_production;

  return jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'sales', jsonb_build_object(
      'gross', v_gross,
      'refunded', v_refunded,
      'net', v_gross - v_refunded,
      'sessions', v_sessions,
      'ticket', case when v_sessions > 0 then round(v_gross / v_sessions, 2) else null end,
      'items_sold', v_items_sold
    ),
    'methods', coalesce(v_methods, '[]'::jsonb),
    'products', v_products,
    'cancellations', v_cancel,
    'refunds', v_refunds,
    'cash', v_cash,
    'production', v_production
  );
end;
$$;

comment on function public.report_period(uuid, date, date, uuid, uuid) is
  'Relatório do período (owner/admin), agregado no servidor: vendas, formas de pagamento, produtos vendidos, cancelamentos, estornos, caixas (um a um) e produção. Dias civis em America/Sao_Paulo, máx. 366 dias. Somente leitura.';

revoke execute on function public.report_period(uuid, date, date, uuid, uuid) from public, anon;
grant execute on function public.report_period(uuid, date, date, uuid, uuid) to authenticated;

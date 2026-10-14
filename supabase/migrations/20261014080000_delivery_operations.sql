-- Módulo Delivery, Fase 1 — M9: OPERAÇÕES do pedido de delivery (criar, estado logístico, entregador, cancelar,
-- listar) e a integração com o motor existente. Depende de 20261014070000 (delivery_orders / eventos).
--
--   1. submit_service_order_core: o motor único de pedido (preço, modificadores, estoque, setor, snapshots, locks)
--      ganha p_origin e p_enqueue_print; submit_service_order (assinatura PÚBLICA inalterada) vira invólucro.
--   2. close_service_session: total do delivery = itens + taxa (point idêntico).
--   3. enqueue_order_print_jobs: bloco "delivery" no payload (o Print Agent não muda nesta etapa).
--   4. create_delivery_order (atômica, idempotente por client_request_id), set_delivery_status,
--      assign_delivery_courier, cancel_delivery_order, list_delivery_orders, get_delivery_order.
--
-- Pagamento: nada novo. payment_timing/expected_method/cash_change_for são INFORMAÇÃO operacional; o recebimento
-- real é close_service_session (owner/admin/cashier, caixa aberto), e o estorno é refund_service_payment.
-- Receita da taxa: delivery_orders.delivery_fee (separada dos itens) + total_amount da sessão (itens + taxa).
-- Fora desta migration (de propósito): Realtime/push do delivery (M10), Print Agent, telas, WhatsApp.


-- ---------------------------------------------------------------------------
-- 1) Motor ÚNICO de pedido: submit_service_order_core
-- ---------------------------------------------------------------------------
-- Corpo VIGENTE de submit_service_order (20261002010000) com 2 parâmetros novos: p_origin (NULL = decidido pelo papel,
-- como sempre) e p_enqueue_print (o delivery imprime depois de gravar delivery_orders). Atendimento kind=delivery só
-- aceita origin=delivery, e origin=delivery só em atendimento delivery. Sem EXECUTE para o cliente.

create or replace function public.submit_service_order_core(
  p_service_session_id uuid,
  p_items jsonb,
  p_origin text default null,
  p_enqueue_print boolean default true
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
  v_raw jsonb;
  v_opt_ids uuid[];
  v_delta numeric(12, 2);
  v_group public.product_modifier_groups;
  v_cnt integer;
  v_active integer;
  v_min integer;
  v_max integer;
  v_bad text;
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
  v_origin := coalesce(p_origin, case when v_role = 'attendant' then 'attendant' else 'cashier' end);
  -- atendimento de delivery só recebe pedido pelo módulo Delivery (origin 'delivery'); delivery nunca em comanda/mesa
  if (v_session.kind = 'delivery') is distinct from (v_origin = 'delivery') then
    raise exception 'Pedido de delivery só pode ser lançado pelo módulo Delivery.' using errcode = 'PT409';
  end if;

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
  if v_session.kind = 'delivery' then
    v_label := 'Delivery';
  end if;

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

    -- MODIFICADORES: só os ids das opções vêm do cliente. Nome, tipo e acréscimo são lidos aqui.
    v_opt_ids := array[]::uuid[];
    v_delta := 0;
    v_raw := v_item -> 'modifier_option_ids';
    if v_raw is not null and jsonb_typeof(v_raw) <> 'null' then
      if jsonb_typeof(v_raw) <> 'array' then
        raise exception 'Opções inválidas.' using errcode = 'PT400';
      end if;
      if jsonb_array_length(v_raw) > 30 then
        raise exception 'Opções demais em um item.' using errcode = 'PT400';
      end if;
      if exists (
        select 1 from jsonb_array_elements(v_raw) e
        where jsonb_typeof(e) <> 'string'
           or (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ) then
        raise exception 'Opções inválidas.' using errcode = 'PT400';
      end if;
      select coalesce(array_agg((e #>> '{}')::uuid), array[]::uuid[]) into v_opt_ids from jsonb_array_elements(v_raw) e;
      if (select count(distinct x) from unnest(v_opt_ids) x) <> cardinality(v_opt_ids) then
        raise exception 'Opção repetida no mesmo item.' using errcode = 'PT400';
      end if;
    end if;

    if cardinality(v_opt_ids) > 0 then
      -- empresa no WHERE: opção de outra empresa é "não encontrada"
      if (select count(*) from public.product_modifier_options o
          where o.company_id = v_session.company_id and o.id = any (v_opt_ids)) <> cardinality(v_opt_ids) then
        raise exception 'Opção não encontrada.' using errcode = 'PT404';
      end if;
      -- ativa, de grupo ativo e de grupo VINCULADO a este produto
      select o.name into v_bad
      from public.product_modifier_options o
      join public.product_modifier_groups g on g.company_id = o.company_id and g.id = o.group_id
      where o.company_id = v_session.company_id
        and o.id = any (v_opt_ids)
        and (
          not o.is_active or not g.is_active
          or not exists (
            select 1 from public.product_modifier_group_products l
            where l.company_id = o.company_id and l.group_id = o.group_id and l.product_id = v_product.id
          )
        )
      limit 1;
      if v_bad is not null then
        raise exception 'A opção "%" não está disponível para %.', v_bad, v_product.name using errcode = 'PT409';
      end if;
    end if;

    -- min/max de cada grupo ativo vinculado ao produto (mesmo sem opção escolhida: grupo obrigatório).
    for v_group in
      select g.*
      from public.product_modifier_groups g
      join public.product_modifier_group_products l on l.company_id = g.company_id and l.group_id = g.id
      where l.company_id = v_session.company_id and l.product_id = v_product.id and g.is_active
      order by g.sort_order, g.name, g.id
    loop
      select count(*) into v_active
      from public.product_modifier_options o
      where o.company_id = v_group.company_id and o.group_id = v_group.id and o.is_active;
      select count(*) into v_cnt
      from public.product_modifier_options o
      where o.company_id = v_group.company_id and o.group_id = v_group.id and o.id = any (v_opt_ids);
      -- grupo sem opção ativa nunca trava a venda
      v_min := least(v_group.min_selection, v_active);
      v_max := case when v_group.selection_type = 'single' then 1 else v_group.max_selection end;
      if v_cnt < v_min then
        raise exception 'Escolha pelo menos % % em "%".', v_min, case when v_min = 1 then 'opção' else 'opções' end, v_group.name
          using errcode = 'PT400';
      end if;
      if v_max is not null and v_cnt > v_max then
        raise exception 'Escolha no máximo % % em "%".', v_max, case when v_max = 1 then 'opção' else 'opções' end, v_group.name
          using errcode = 'PT400';
      end if;
    end loop;

    if cardinality(v_opt_ids) > 0 then
      select coalesce(sum(o.price_delta), 0)::numeric(12, 2) into v_delta
      from public.product_modifier_options o
      where o.company_id = v_session.company_id and o.id = any (v_opt_ids);
    end if;

    insert into public.service_order_items (
      company_id, order_id, product_id, product_name_snapshot, quantity, unit_price, modifiers_unit_total, production_sector_id, notes
    ) values (
      v_session.company_id, v_order.id, v_product.id, v_product.name, v_quantity::integer,
      v_product.sale_price + v_delta, v_delta, v_sector_id, v_notes
    ) returning id into v_item_id;

    if cardinality(v_opt_ids) > 0 then
      insert into public.service_order_item_modifiers (
        company_id, service_order_item_id, modifier_option_id, group_id, group_name, option_name, modifier_type, price_delta, position
      )
      select v_session.company_id, v_item_id, o.id, g.id, g.name, o.name, o.modifier_type, o.price_delta,
             (row_number() over (order by g.sort_order, g.name, o.sort_order, o.name, o.id))::integer
      from public.product_modifier_options o
      join public.product_modifier_groups g on g.company_id = o.company_id and g.id = o.group_id
      where o.company_id = v_session.company_id and o.id = any (v_opt_ids);
    end if;

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

  -- Impressão é complementar: um erro aqui nunca derruba o pedido (savepoint próprio; fica registrado em print_enqueue_failures).
  if p_enqueue_print then
  begin
    perform public.enqueue_order_print_jobs(v_order.id);
  exception when others then
    raise warning 'Falha ao enfileirar impressão (enqueue_order_print_jobs) %: %', v_order.id, sqlerrm;
    perform public.record_print_enqueue_failure(v_order.company_id, 'production_order', v_order.id, null, sqlerrm);
  end;
  end if;

  return v_order;
end;
$$;

revoke execute on function public.submit_service_order_core(uuid, jsonb, text, boolean) from public, anon, authenticated;


-- A assinatura pública NÃO muda: submit_service_order vira um invólucro do núcleo (mesma ACL, preservada pelo REPLACE).

create or replace function public.submit_service_order(
  p_service_session_id uuid,
  p_items jsonb
)
returns public.service_orders
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.submit_service_order_core(p_service_session_id, p_items, null, true);
end;
$$;


-- ---------------------------------------------------------------------------
-- 2) close_service_session: total do delivery = itens + taxa
-- ---------------------------------------------------------------------------
-- Corpo vigente (20261014030000) + UM bloco: para kind=delivery soma delivery_orders.delivery_fee (não cancelado).
-- kind=point: cálculo idêntico ao anterior.

create or replace function public.close_service_session(p_service_session_id uuid, p_payments jsonb default '[]'::jsonb)
returns public.service_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.service_sessions;
  v_point public.service_points;
  v_role public.company_role;
  v_cash public.cash_sessions;
  v_total numeric(12, 2);
  v_paid numeric := 0;
  v_p jsonb;
  v_method text;
  v_amount numeric;
  v_received numeric;
  v_change numeric;
  v_payment public.service_payments;
  v_label text;
  v_fmt text;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  -- Trava o atendimento: cliques repetidos/concorrentes esperam aqui e enxergam 'closed'.
  select * into v_session from public.service_sessions where id = p_service_session_id for update;
  if not found then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;

  v_role := public.user_role_in_company(v_session.company_id);
  if v_role is null then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier') then
    raise exception 'Você não tem permissão para fechar contas.' using errcode = 'PT403';
  end if;

  if v_session.status <> 'open' then
    raise exception 'Este atendimento já foi fechado.' using errcode = 'PT409';
  end if;

  -- Total REAL, pelos snapshots persistidos (nunca do cliente), sobre a quantidade COBRÁVEL
  -- (quantity - cancelled_quantity): item cancelado não entra na conta.
  select coalesce(sum((i.quantity - i.cancelled_quantity) * i.unit_price), 0)::numeric(12, 2) into v_total
  from public.service_orders o
  join public.service_order_items i on i.company_id = o.company_id and i.order_id = o.id
  where o.company_id = v_session.company_id
    and o.service_session_id = v_session.id
    and o.status = 'submitted';

  -- DELIVERY: a taxa entra no total (some quando o pedido é cancelado). point: nada muda.
  if v_session.kind = 'delivery' then
    v_total := v_total + coalesce((
      select d.delivery_fee from public.delivery_orders d
      where d.company_id = v_session.company_id and d.service_session_id = v_session.id and d.delivery_status <> 'canceled'
    ), 0);
  end if;

  v_fmt := 'R$ ' || replace(to_char(v_total, 'FM9999999990.00'), '.', ',');

  if p_payments is null or jsonb_typeof(p_payments) <> 'array' then
    raise exception 'Informe os pagamentos.' using errcode = 'PT400';
  end if;
  if jsonb_array_length(p_payments) > 20 then
    raise exception 'Informe no máximo 20 pagamentos.' using errcode = 'PT400';
  end if;

  if v_total = 0 then
    if jsonb_array_length(p_payments) > 0 then
      raise exception 'Esta conta não tem valor a receber (total %).', v_fmt using errcode = 'PT400';
    end if;
  else
    if jsonb_array_length(p_payments) = 0 then
      raise exception 'Informe o pagamento. Total da conta: %.', v_fmt using errcode = 'PT400';
    end if;

    -- Caixa ABERTO do próprio operador (travado contra o fechamento do caixa em paralelo).
    select * into v_cash
    from public.cash_sessions
    where company_id = v_session.company_id and opened_by = auth.uid() and status = 'open'
    for share;
    if not found then
      raise exception 'Abra o caixa antes de receber esta conta.' using errcode = 'PT412';
    end if;
  end if;

  select * into v_point from public.service_points
  where id = v_session.service_point_id and company_id = v_session.company_id;
  v_label := case when v_point.id is null then 'Delivery' when v_point.type = 'table' then 'Mesa ' || coalesce(v_point.code, '') else 'Comanda ' || coalesce(v_point.code, '') end;

  -- Valida TODOS os pagamentos antes de gravar qualquer coisa.
  for v_p in select * from jsonb_array_elements(p_payments) loop
    if jsonb_typeof(v_p) <> 'object' then
      raise exception 'Pagamento inválido.' using errcode = 'PT400';
    end if;
    v_method := v_p ->> 'method';
    if v_method is null or v_method not in ('cash', 'pix', 'debit_card', 'credit_card', 'other') then
      raise exception 'Forma de pagamento inválida.' using errcode = 'PT400';
    end if;
    if jsonb_typeof(v_p -> 'amount') is distinct from 'number' then
      raise exception 'Valor do pagamento inválido.' using errcode = 'PT400';
    end if;
    v_amount := (v_p ->> 'amount')::numeric;
    if v_amount <= 0 or v_amount >= 10000000000 or v_amount <> round(v_amount, 2) then
      raise exception 'O valor de cada pagamento deve ser maior que zero, com até 2 casas decimais.' using errcode = 'PT400';
    end if;
    if v_p ? 'amount_received' and jsonb_typeof(v_p -> 'amount_received') not in ('number', 'null') then
      raise exception 'Valor recebido inválido.' using errcode = 'PT400';
    end if;
    if jsonb_typeof(v_p -> 'amount_received') = 'number' then
      v_received := (v_p ->> 'amount_received')::numeric;
      if v_method <> 'cash' then
        raise exception 'Só o pagamento em dinheiro tem valor recebido e troco.' using errcode = 'PT400';
      end if;
      if v_received < v_amount or v_received >= 10000000000 or v_received <> round(v_received, 2) then
        raise exception 'O valor recebido em dinheiro deve ser igual ou maior que o valor aplicado.' using errcode = 'PT400';
      end if;
    end if;
    v_paid := v_paid + v_amount;
  end loop;

  if v_paid < v_total then
    raise exception 'Pagamento insuficiente. Total da conta: %.', v_fmt using errcode = 'PT400';
  end if;
  if v_paid > v_total then
    raise exception 'Os pagamentos ultrapassam o total da conta (%).', v_fmt using errcode = 'PT400';
  end if;

  -- Grava pagamentos + movimentos (um por forma de pagamento).
  for v_p in select * from jsonb_array_elements(p_payments) loop
    v_method := v_p ->> 'method';
    v_amount := (v_p ->> 'amount')::numeric;
    if v_method = 'cash' then
      v_received := coalesce((v_p ->> 'amount_received')::numeric, v_amount);
      v_change := v_received - v_amount;
    else
      v_received := null;
      v_change := 0;
    end if;

    insert into public.service_payments (
      company_id, service_session_id, cash_session_id, payment_method, amount, amount_received, change_amount, created_by
    ) values (
      v_session.company_id, v_session.id, v_cash.id, v_method, v_amount, v_received, v_change, auth.uid()
    ) returning * into v_payment;

    insert into public.cash_movements (
      company_id, cash_session_id, service_session_id, service_payment_id,
      movement_type, payment_method, amount, description, created_by
    ) values (
      v_session.company_id, v_cash.id, v_session.id, v_payment.id,
      'sale', v_method, v_amount, 'Venda - ' || v_label, auth.uid()
    );
  end loop;

  update public.service_sessions
     set status = 'closed', closed_at = now(), closed_by = auth.uid(), total_amount = v_total
   where id = v_session.id
  returning * into v_session;

  return v_session;
end;
$$;


-- ---------------------------------------------------------------------------
-- 3) enqueue_order_print_jobs: bloco "delivery" no payload
-- ---------------------------------------------------------------------------
-- Corpo vigente (20261014030000) + a chave "delivery" (cliente, telefone, endereço, taxa, pagamento, troco, previsão,
-- entregador, observação) anexada ao payload SÓ quando o atendimento é de delivery. Payload de ponto: idêntico.

create or replace function public.enqueue_order_print_jobs(p_order_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.service_orders;
  v_point_type text;
  v_point_code text;
  v_point_name text;
  v_customer text;
  v_operator text;
  v_device public.print_devices;
  v_full boolean;
  v_items jsonb;
  v_job_id uuid;
  v_created integer := 0;
begin
  select * into v_order from public.service_orders where id = p_order_id;
  if not found then
    return 0;
  end if;

  select sp.type, sp.code, sp.display_name, ss.customer_name
    into v_point_type, v_point_code, v_point_name, v_customer
  from public.service_sessions ss
  left join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
  where ss.company_id = v_order.company_id and ss.id = v_order.service_session_id;

  v_operator := public.print_actor_name(v_order.company_id, v_order.created_by);

  -- FOR SHARE: arquivar/editar rotas (FOR UPDATE) não corre junto de um pedido sendo roteado.
  for v_device in
    select * from public.print_devices
    where company_id = v_order.company_id and is_ready
    order by id
    for share
  loop
    select exists (
      select 1 from public.print_device_routes r where r.print_device_id = v_device.id and r.route_type = 'full_order'
    ) into v_full;

    select jsonb_agg(
             jsonb_build_object(
               'service_order_item_id', i.id,
               'product_name', i.product_name_snapshot,
               'quantity', i.quantity - i.cancelled_quantity,
               'notes', i.notes,
               'modifiers', public.item_modifiers_json(i.company_id, i.id, false),
               'sector', case when s.id is null then null else jsonb_build_object('id', s.id, 'name', s.name) end
             ) order by i.created_at, i.id)
      into v_items
    from public.service_order_items i
    left join public.production_sectors s on s.company_id = i.company_id and s.id = i.production_sector_id
    where i.company_id = v_order.company_id
      and i.order_id = v_order.id
      and i.quantity - i.cancelled_quantity > 0
      and (
        v_full
        or (i.production_sector_id is not null and exists (
          select 1 from public.print_device_routes r
          where r.print_device_id = v_device.id
            and r.route_type = 'production_sector'
            and r.production_sector_id = i.production_sector_id
        ))
      );

    if v_items is null then
      continue;
    end if;

    v_job_id := null;
    insert into public.print_jobs (company_id, print_device_id, job_type, service_order_id, payload, created_by)
    values (
      v_order.company_id, v_device.id, 'production_order', v_order.id,
      public.print_base_payload('production_order', v_device) || jsonb_build_object(
        'order', jsonb_build_object('id', v_order.id, 'origin', v_order.origin),
        'service_point', jsonb_build_object(
          'type', v_point_type, 'code', v_point_code, 'display_name', v_point_name,
          'label', case when v_point_type is null then 'Delivery' when v_point_type = 'table' then 'Mesa ' || v_point_code else 'Comanda ' || v_point_code end
        ),
        'customer_name', v_customer,
        'operator', jsonb_build_object('name', v_operator),
        'sent_at', v_order.submitted_at,
        'scope', case when v_full then 'full_order' else 'production_sector' end,
        'items', v_items
      ) || coalesce(public.delivery_print_block(v_order.company_id, v_order.service_session_id), '{}'::jsonb),
      v_order.created_by
    )
    on conflict (print_device_id, service_order_id)
      where job_type = 'production_order' and reprint_of_id is null
      do nothing
    returning id into v_job_id;

    if v_job_id is null then
      continue;
    end if;

    insert into public.print_job_items (company_id, print_job_id, service_order_item_id, quantity)
    select v_order.company_id, v_job_id, (e ->> 'service_order_item_id')::uuid, (e ->> 'quantity')::integer
    from jsonb_array_elements(v_items) e;

    v_created := v_created + 1;
  end loop;

  return v_created;
end;
$$;


-- ---------------------------------------------------------------------------
-- 4) Helpers internos do delivery
-- ---------------------------------------------------------------------------
-- Bloco "delivery" do payload de impressão (NULL quando a sessão não é de delivery).
create function public.delivery_print_block(p_company_id uuid, p_session_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('delivery', jsonb_build_object(
    'fulfillment', d.fulfillment,
    'status', d.delivery_status,
    'customer_name', d.customer_name,
    'customer_phone', d.customer_phone,
    'address', case when d.fulfillment = 'delivery' then jsonb_build_object(
        'street', d.addr_street, 'number', d.addr_number, 'complement', d.addr_complement,
        'neighborhood', d.addr_neighborhood, 'city', d.addr_city, 'state', d.addr_state,
        'cep', d.addr_cep, 'reference', d.addr_reference) end,
    'delivery_fee', d.delivery_fee,
    'payment_timing', d.payment_timing,
    'expected_method', d.expected_method,
    'cash_change_for', d.cash_change_for,
    'estimated_ready_at', d.estimated_ready_at,
    'estimated_delivery_at', d.estimated_delivery_at,
    'courier', case when d.courier_user_id is not null
                    then jsonb_build_object('name', public.print_actor_name(d.company_id, d.courier_user_id)) end,
    'notes', d.notes))
  from public.delivery_orders d
  where d.company_id = p_company_id and d.service_session_id = p_session_id;
$$;

revoke execute on function public.delivery_print_block(uuid, uuid) from public, anon, authenticated;

-- Resumo devolvido pelas RPCs (subtotal dos itens cobráveis + taxa = total do fechamento).
create function public.delivery_order_summary(p_delivery_order_id uuid, p_replayed boolean default false)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'delivery_order_id', d.id,
    'service_session_id', d.service_session_id,
    'service_order_id', d.service_order_id,
    'fulfillment', d.fulfillment,
    'delivery_status', d.delivery_status,
    'delivery_fee', d.delivery_fee,
    'fee_source', d.fee_source,
    'items_subtotal', a.subtotal,
    'total', case when d.delivery_status = 'canceled' then 0 else a.subtotal + d.delivery_fee end,
    'estimated_ready_at', d.estimated_ready_at,
    'estimated_delivery_at', d.estimated_delivery_at,
    'payment_timing', d.payment_timing,
    'expected_method', d.expected_method,
    'cash_change_for', d.cash_change_for,
    'replayed', p_replayed)
  from public.delivery_orders d
  cross join lateral (
    select coalesce(sum((i.quantity - i.cancelled_quantity) * i.unit_price), 0)::numeric(12, 2) as subtotal
    from public.service_order_items i
    where i.company_id = d.company_id and i.order_id = d.service_order_id
  ) a
  where d.id = p_delivery_order_id;
$$;

revoke execute on function public.delivery_order_summary(uuid, boolean) from public, anon, authenticated;

create function public.delivery_digits(p_text text)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(regexp_replace(coalesce(p_text, ''), '\D', '', 'g'), '');
$$;

revoke execute on function public.delivery_digits(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5) RPC: criar pedido de delivery/retirada (tudo em UMA transação)
-- ---------------------------------------------------------------------------
-- Taxa (resolvida AQUI, nunca pelo cliente):
--   zona ativa (cidade+bairro do endereço)  -> zone.fee            'zone'
--   senão default_fee configurada           -> default_fee         'default'
--   senão p_manual_fee + allow_manual_fee   -> manual              'manual'
--   senão                                   -> recusa
--   p_manual_fee SOBRE zona/default (sobrescrita): só owner/admin e só com allow_manual_fee. cashier/attendant só
--   informam taxa manual quando NÃO há zona nem padrão. Sobrescrita/manual gera evento fee_overridden.
--   Retirada: taxa 0, fee_source 'none'.
-- Idempotência: p_client_request_id (único por empresa); advisory lock por requisição serializa duplo clique/retry
--   concorrentes; a repetição devolve o MESMO pedido (replayed=true) sem criar sessão, pedido nem baixa de estoque.
-- Erros: PT401, PT404 (empresa/cliente/endereço), PT403 (papel/módulo/taxa), PT400 (dados), PT409 (estado/estoque).
create function public.create_delivery_order(
  p_company_id uuid,
  p_client_request_id uuid,
  p_fulfillment text,
  p_items jsonb,
  p_customer_id uuid default null,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_address_id uuid default null,
  p_manual_fee numeric default null,
  p_payment_timing text default null,
  p_expected_method text default null,
  p_cash_change_for numeric default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_existing public.delivery_orders;
  v_settings jsonb;
  v_customer public.customers;
  v_addr public.customer_addresses;
  v_zone public.delivery_zones;
  v_zone_found boolean := false;
  v_name text;
  v_phone text;
  v_fee numeric(12, 2) := 0;
  v_source text := 'none';
  v_old_fee jsonb := null;
  v_override boolean := false;
  v_minutes integer;
  v_timing text;
  v_method text := nullif(btrim(coalesce(p_expected_method, '')), '');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_session public.service_sessions;
  v_order public.service_orders;
  v_subtotal numeric(12, 2);
  v_total numeric(12, 2);
  v_ready timestamptz;
  v_deliv timestamptz;
  v_do public.delivery_orders;
begin
  v_role := public.delivery_assert_operator(p_company_id);

  if p_client_request_id is null then
    raise exception 'Identificador da requisição ausente.' using errcode = 'PT400';
  end if;
  if p_fulfillment is null or p_fulfillment not in ('delivery', 'pickup') then
    raise exception 'Informe entrega ou retirada.' using errcode = 'PT400';
  end if;

  -- Idempotência: serializa requisições iguais e devolve o pedido já criado.
  perform pg_advisory_xact_lock(hashtextextended('delivery:' || p_company_id::text || ':' || p_client_request_id::text, 0));
  select * into v_existing from public.delivery_orders
  where company_id = p_company_id and client_request_id = p_client_request_id;
  if found then
    return public.delivery_order_summary(v_existing.id, true);
  end if;

  -- records inicializados (campos nulos): o pickup nunca os preenche e o INSERT os referencia
  select * into v_addr from public.customer_addresses where false;
  select * into v_zone from public.delivery_zones where false;

  v_settings := public.delivery_settings_effective(p_company_id);
  if p_fulfillment = 'delivery' and not (v_settings ->> 'delivery_enabled')::boolean then
    raise exception 'A entrega está desativada nas configurações do Delivery.' using errcode = 'PT409';
  end if;
  if p_fulfillment = 'pickup' and not (v_settings ->> 'pickup_enabled')::boolean then
    raise exception 'A retirada está desativada nas configurações do Delivery.' using errcode = 'PT409';
  end if;

  if v_notes is not null and char_length(v_notes) > 300 then
    raise exception 'A observação pode ter no máximo 300 caracteres.' using errcode = 'PT400';
  end if;

  -- Cliente (snapshot de nome e telefone)
  if p_customer_id is not null then
    select * into v_customer from public.customers where id = p_customer_id and company_id = p_company_id;
    if not found then
      raise exception 'Cliente não encontrado.' using errcode = 'PT404';
    end if;
    if not v_customer.is_active then
      raise exception 'Este cliente está inativo.' using errcode = 'PT409';
    end if;
    v_name := v_customer.name;
    v_phone := coalesce(public.delivery_digits(p_customer_phone), v_customer.phone, v_customer.whatsapp);
  else
    if p_fulfillment = 'delivery' then
      raise exception 'Informe o cliente cadastrado para a entrega.' using errcode = 'PT400';
    end if;
    v_name := nullif(btrim(regexp_replace(coalesce(p_customer_name, ''), '\s+', ' ', 'g')), '');
    if v_name is null then
      raise exception 'Informe o cliente.' using errcode = 'PT400';
    end if;
    if char_length(v_name) > 80 then
      raise exception 'O nome do cliente pode ter no máximo 80 caracteres.' using errcode = 'PT400';
    end if;
    v_phone := public.delivery_digits(p_customer_phone);
  end if;
  if v_phone is not null and char_length(v_phone) not between 8 and 13 then
    raise exception 'Telefone inválido. Informe o DDD e o número.' using errcode = 'PT400';
  end if;

  -- Pagamento esperado (informação; o recebimento real é no Caixa)
  v_timing := coalesce(nullif(btrim(coalesce(p_payment_timing, '')), ''),
                       case p_fulfillment when 'delivery' then 'on_delivery' else 'on_pickup' end);
  if (p_fulfillment = 'delivery' and v_timing not in ('on_order', 'on_delivery'))
     or (p_fulfillment = 'pickup' and v_timing not in ('on_order', 'on_pickup')) then
    raise exception 'Momento do pagamento inválido para este tipo de pedido.' using errcode = 'PT400';
  end if;
  if v_method is not null and v_method not in ('cash', 'pix', 'debit_card', 'credit_card', 'other') then
    raise exception 'Forma de pagamento inválida.' using errcode = 'PT400';
  end if;
  if p_cash_change_for is not null then
    if v_method is distinct from 'cash' then
      raise exception 'Troco só se aplica a pagamento em dinheiro.' using errcode = 'PT400';
    end if;
    if p_cash_change_for <= 0 or p_cash_change_for >= 100000000 or p_cash_change_for <> round(p_cash_change_for, 2) then
      raise exception 'Valor do troco inválido.' using errcode = 'PT400';
    end if;
  end if;

  -- Endereço (entrega): SÓ de customer_addresses, ativo, da mesma empresa e do mesmo cliente
  if p_fulfillment = 'delivery' then
    if p_address_id is null then
      raise exception 'Informe o endereço de entrega.' using errcode = 'PT400';
    end if;
    select * into v_addr from public.customer_addresses where id = p_address_id and company_id = p_company_id;
    if not found then
      raise exception 'Endereço não encontrado.' using errcode = 'PT404';
    end if;
    if not v_addr.is_active then
      raise exception 'Este endereço está desativado.' using errcode = 'PT409';
    end if;
    if v_addr.customer_id <> p_customer_id then
      raise exception 'O endereço não pertence a este cliente.' using errcode = 'PT400';
    end if;
  elsif p_address_id is not null then
    raise exception 'Retirada não usa endereço de entrega.' using errcode = 'PT400';
  end if;

  -- Taxa e previsão (servidor)
  if p_manual_fee is not null and (p_manual_fee < 0 or p_manual_fee >= 100000 or p_manual_fee <> round(p_manual_fee, 2)) then
    raise exception 'A taxa manual deve ser zero ou mais, com até 2 casas decimais.' using errcode = 'PT400';
  end if;

  if p_fulfillment = 'pickup' then
    if p_manual_fee is not null then
      raise exception 'Retirada não tem taxa de entrega.' using errcode = 'PT400';
    end if;
    v_ready := now() + make_interval(mins => (v_settings ->> 'pickup_minutes')::integer);
  else
    select * into v_zone
    from public.delivery_zones z
    where z.company_id = p_company_id and z.is_active
      and z.city_key = public.delivery_norm_text(v_addr.city)
      and z.neighborhood_key = public.delivery_norm_text(v_addr.neighborhood);
    v_zone_found := found;

    if v_zone_found then
      v_fee := v_zone.fee; v_source := 'zone';
    elsif (v_settings ->> 'default_fee') is not null then
      v_fee := (v_settings ->> 'default_fee')::numeric; v_source := 'default';
    end if;

    if p_manual_fee is not null then
      if not (v_settings ->> 'allow_manual_fee')::boolean then
        raise exception 'O ajuste manual da taxa está desativado nas configurações do Delivery.' using errcode = 'PT403';
      end if;
      if v_source <> 'none' then
        if v_role not in ('owner', 'admin') then
          raise exception 'Já existe taxa cadastrada para este bairro. Só owner ou admin podem alterá-la.' using errcode = 'PT403';
        end if;
        v_old_fee := jsonb_build_object('fee', v_fee, 'source', v_source);
      end if;
      v_fee := p_manual_fee; v_source := 'manual'; v_override := true;
    elsif v_source = 'none' then
      raise exception 'Não há taxa cadastrada para este bairro. Cadastre a zona ou informe a taxa manual.' using errcode = 'PT409';
    end if;

    v_minutes := coalesce(case when v_zone_found then v_zone.estimated_minutes end, (v_settings ->> 'delivery_minutes')::integer);
    v_deliv := now() + make_interval(mins => v_minutes);
  end if;

  -- Atendimento delivery (sem ponto) + pedido pelo MOTOR ÚNICO (preço, modificadores, estoque, setor, snapshots)
  insert into public.service_sessions (company_id, kind, customer_name, customer_id, status, opened_by)
  values (p_company_id, 'delivery', v_name, p_customer_id, 'open', auth.uid())
  returning * into v_session;

  v_order := public.submit_service_order_core(v_session.id, p_items, 'delivery', false);

  select coalesce(sum(i.quantity * i.unit_price), 0)::numeric(12, 2) into v_subtotal
  from public.service_order_items i where i.company_id = p_company_id and i.order_id = v_order.id;
  v_total := v_subtotal + v_fee;

  if p_cash_change_for is not null and p_cash_change_for < v_total then
    raise exception 'O troco deve ser para um valor igual ou maior que o total (R$ %).',
      replace(to_char(v_total, 'FM9999999990.00'), '.', ',') using errcode = 'PT400';
  end if;

  insert into public.delivery_orders (
    company_id, service_session_id, service_order_id, client_request_id, fulfillment, delivery_status,
    customer_id, customer_name, customer_phone, source_address_id,
    addr_street, addr_number, addr_complement, addr_neighborhood, addr_city, addr_state, addr_cep, addr_reference,
    delivery_fee, fee_source, zone_id, estimated_ready_at, estimated_delivery_at,
    payment_timing, expected_method, cash_change_for, notes, created_by
  ) values (
    p_company_id, v_session.id, v_order.id, p_client_request_id, p_fulfillment, 'confirmed',
    p_customer_id, v_name, v_phone, case when p_fulfillment = 'delivery' then v_addr.id end,
    case when p_fulfillment = 'delivery' then v_addr.street end, case when p_fulfillment = 'delivery' then v_addr.number end,
    case when p_fulfillment = 'delivery' then v_addr.complement end, case when p_fulfillment = 'delivery' then v_addr.neighborhood end,
    case when p_fulfillment = 'delivery' then v_addr.city end, case when p_fulfillment = 'delivery' then v_addr.state end,
    case when p_fulfillment = 'delivery' then v_addr.cep end, case when p_fulfillment = 'delivery' then v_addr.reference end,
    v_fee, v_source, case when v_source = 'zone' then v_zone.id end, v_ready, v_deliv,
    v_timing, v_method, p_cash_change_for, v_notes, auth.uid()
  ) returning * into v_do;

  insert into public.delivery_order_events (company_id, delivery_order_id, event_type, actor_user_id, new_value)
  values (p_company_id, v_do.id, 'created', auth.uid(),
          jsonb_build_object('fulfillment', p_fulfillment, 'delivery_fee', v_fee, 'fee_source', v_source, 'total', v_total));
  if v_override then
    insert into public.delivery_order_events (company_id, delivery_order_id, event_type, actor_user_id, old_value, new_value)
    values (p_company_id, v_do.id, 'fee_overridden', auth.uid(), v_old_fee,
            jsonb_build_object('fee', v_fee, 'source', 'manual'));
  end if;

  -- Impressão é complementar (mesmo padrão de submit_service_order): erro aqui nunca derruba o pedido.
  begin
    perform public.enqueue_order_print_jobs(v_order.id);
  exception when others then
    raise warning 'Falha ao enfileirar impressão (delivery) %: %', v_order.id, sqlerrm;
    perform public.record_print_enqueue_failure(p_company_id, 'production_order', v_order.id, null, sqlerrm);
  end;

  return public.delivery_order_summary(v_do.id, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) RPC: estado logístico
-- ---------------------------------------------------------------------------
-- entrega: confirmed -> out_for_delivery (exige itens ativos TODOS prontos) -> delivered
-- retirada: confirmed -> picked_up (exige itens ativos todos prontos)
-- Cancelar NÃO passa por aqui (cancel_delivery_order). Pronto: toda linha ativa passa pelo KDS (inclusive sem setor),
-- então "pronto" = production_status='ready' em todos os itens com quantity > cancelled_quantity.
-- courier: só o pedido atribuído a ele e só out_for_delivery / delivered.
create function public.set_delivery_status(p_delivery_order_id uuid, p_status text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_do public.delivery_orders;
  v_role public.company_role;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_active integer;
  v_pending integer;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_do from public.delivery_orders where id = p_delivery_order_id;
  if not found then
    raise exception 'Pedido de delivery não encontrado.' using errcode = 'PT404';
  end if;
  v_role := public.delivery_assert_actor(v_do.company_id);

  if v_role = 'courier' and v_do.courier_user_id is distinct from auth.uid() then
    raise exception 'Pedido de delivery não encontrado.' using errcode = 'PT404';
  end if;
  if v_role = 'courier' and p_status not in ('out_for_delivery', 'delivered') then
    raise exception 'O entregador só pode marcar saída para entrega e entregue.' using errcode = 'PT403';
  end if;
  if p_status is null or p_status not in ('out_for_delivery', 'delivered', 'picked_up') then
    raise exception 'Estado inválido. Para cancelar use o cancelamento do pedido.' using errcode = 'PT400';
  end if;
  if v_note is not null and char_length(v_note) > 300 then
    raise exception 'A observação pode ter no máximo 300 caracteres.' using errcode = 'PT400';
  end if;

  select * into v_do from public.delivery_orders where id = p_delivery_order_id for update;

  if (v_do.fulfillment = 'delivery' and p_status = 'picked_up') or (v_do.fulfillment = 'pickup' and p_status <> 'picked_up') then
    raise exception 'Estado inválido para este tipo de pedido.' using errcode = 'PT400';
  end if;
  if not (
    (v_do.delivery_status = 'confirmed' and p_status in ('out_for_delivery', 'picked_up'))
    or (v_do.delivery_status = 'out_for_delivery' and p_status = 'delivered')
  ) then
    raise exception 'Não é possível mudar de % para %.', v_do.delivery_status, p_status using errcode = 'PT409';
  end if;

  if p_status in ('out_for_delivery', 'picked_up') then
    select count(*) filter (where i.quantity > i.cancelled_quantity),
           count(*) filter (where i.quantity > i.cancelled_quantity and i.production_status <> 'ready')
      into v_active, v_pending
    from public.service_order_items i
    where i.company_id = v_do.company_id and i.order_id = v_do.service_order_id;
    if v_active = 0 then
      raise exception 'Este pedido não tem itens ativos.' using errcode = 'PT409';
    end if;
    if v_pending > 0 then
      raise exception 'O pedido ainda não está pronto: % item(ns) em produção.', v_pending using errcode = 'PT409';
    end if;
  end if;

  update public.delivery_orders
     set delivery_status = p_status,
         out_for_delivery_at = case when p_status = 'out_for_delivery' then now() else out_for_delivery_at end,
         delivered_at = case when p_status = 'delivered' then now() else delivered_at end,
         picked_up_at = case when p_status = 'picked_up' then now() else picked_up_at end
   where id = v_do.id;

  insert into public.delivery_order_events (company_id, delivery_order_id, event_type, actor_user_id, old_value, new_value, note)
  values (v_do.company_id, v_do.id, 'status_changed', auth.uid(),
          jsonb_build_object('status', v_do.delivery_status), jsonb_build_object('status', p_status), v_note);

  return public.delivery_order_summary(v_do.id, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) RPC: entregador (NULL remove)
-- ---------------------------------------------------------------------------
create function public.assign_delivery_courier(p_delivery_order_id uuid, p_courier_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_do public.delivery_orders;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_do from public.delivery_orders where id = p_delivery_order_id;
  if not found then
    raise exception 'Pedido de delivery não encontrado.' using errcode = 'PT404';
  end if;
  perform public.delivery_assert_operator(v_do.company_id);

  select * into v_do from public.delivery_orders where id = p_delivery_order_id for update;
  if v_do.fulfillment <> 'delivery' then
    raise exception 'Retirada não tem entregador.' using errcode = 'PT409';
  end if;
  if v_do.delivery_status not in ('confirmed', 'out_for_delivery') then
    raise exception 'Este pedido já foi concluído.' using errcode = 'PT409';
  end if;

  if p_courier_user_id is not null and not exists (
    select 1 from public.company_users cu
    where cu.company_id = v_do.company_id and cu.user_id = p_courier_user_id
      and cu.role = 'courier' and cu.status = 'active'
  ) then
    raise exception 'Entregador não encontrado ou inativo nesta empresa.' using errcode = 'PT404';
  end if;

  if p_courier_user_id is distinct from v_do.courier_user_id then
    update public.delivery_orders set courier_user_id = p_courier_user_id where id = v_do.id;
    insert into public.delivery_order_events (company_id, delivery_order_id, event_type, actor_user_id, old_value, new_value)
    values (v_do.company_id, v_do.id, 'courier_assigned', auth.uid(),
            jsonb_build_object('courier_user_id', v_do.courier_user_id), jsonb_build_object('courier_user_id', p_courier_user_id));
  end if;

  return public.delivery_order_summary(v_do.id, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8) RPC: cancelar o delivery INTEIRO
-- ---------------------------------------------------------------------------
-- Conta ABERTA: cancela cada item ainda ativo pela rotina OFICIAL (estoque revertido, evento por item, impressão de
--   cancelamento, regra de papel: cashier/attendant só itens ainda pending; owner/admin qualquer) e fecha a conta
--   com total 0 (a taxa deixa de contar: delivery_status canceled).
-- Conta FECHADA (já paga): só depois de TODO o pagamento estornado pelo fluxo oficial (refund_service_payment); aí o
--   pedido é marcado cancelado sem mexer em itens/estoque (o estorno de conta fechada nunca moveu estoque).
-- Em rota (out_for_delivery): só owner/admin. Concluídos (delivered/picked_up/canceled): não cancelam.
-- Cancelar item isolado (cancel_service_order_item) NUNCA altera a taxa.
create function public.cancel_delivery_order(p_delivery_order_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_do public.delivery_orders;
  v_role public.company_role;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_session public.service_sessions;
  v_item record;
  v_paid numeric;
  v_refunded numeric;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_do from public.delivery_orders where id = p_delivery_order_id;
  if not found then
    raise exception 'Pedido de delivery não encontrado.' using errcode = 'PT404';
  end if;
  v_role := public.delivery_assert_operator(v_do.company_id);

  if v_reason is null then
    raise exception 'Informe o motivo do cancelamento.' using errcode = 'PT400';
  end if;
  if char_length(v_reason) > 200 then
    raise exception 'O motivo pode ter no máximo 200 caracteres.' using errcode = 'PT400';
  end if;

  -- mesma ordem de locks do fechamento: atendimento primeiro
  select * into v_session from public.service_sessions
  where company_id = v_do.company_id and id = v_do.service_session_id for update;
  select * into v_do from public.delivery_orders where id = p_delivery_order_id for update;

  if v_do.delivery_status = 'canceled' then
    raise exception 'Este pedido já foi cancelado.' using errcode = 'PT409';
  end if;
  if v_do.delivery_status in ('delivered', 'picked_up') then
    raise exception 'Este pedido já foi concluído e não pode ser cancelado.' using errcode = 'PT409';
  end if;
  if v_do.delivery_status = 'out_for_delivery' and v_role not in ('owner', 'admin') then
    raise exception 'Pedido em rota: só owner ou admin podem cancelar.' using errcode = 'PT403';
  end if;

  if v_session.status = 'open' then
    for v_item in
      select i.id, i.quantity - i.cancelled_quantity as active
      from public.service_order_items i
      where i.company_id = v_do.company_id and i.order_id = v_do.service_order_id
        and i.quantity > i.cancelled_quantity
      order by i.created_at, i.id
    loop
      perform public.cancel_service_order_item(v_item.id, v_item.active, v_reason);
    end loop;

    update public.service_sessions
       set status = 'closed', closed_at = now(), closed_by = auth.uid(), total_amount = 0
     where id = v_session.id;
  else
    select coalesce(sum(p.amount), 0) into v_paid
    from public.service_payments p where p.company_id = v_do.company_id and p.service_session_id = v_do.service_session_id;
    select coalesce(sum(r.amount), 0) into v_refunded
    from public.service_refunds r where r.company_id = v_do.company_id and r.service_session_id = v_do.service_session_id;
    if v_paid > 0 and v_refunded < v_paid then
      raise exception 'Este pedido já foi pago. Estorne o pagamento no Caixa antes de cancelar.' using errcode = 'PT409';
    end if;
  end if;

  update public.delivery_orders
     set delivery_status = 'canceled', canceled_at = now(), cancel_reason = v_reason
   where id = v_do.id;

  insert into public.delivery_order_events (company_id, delivery_order_id, event_type, actor_user_id, old_value, new_value, note)
  values (v_do.company_id, v_do.id, 'canceled', auth.uid(),
          jsonb_build_object('status', v_do.delivery_status, 'delivery_fee', v_do.delivery_fee),
          jsonb_build_object('status', 'canceled'), v_reason);

  return public.delivery_order_summary(v_do.id, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9) Leitura: lista (1 consulta, sem N+1) e detalhe
-- ---------------------------------------------------------------------------
-- "production" é DERIVADO dos itens ativos: null (sem itens ativos) | pending | preparing | ready.
-- courier: sempre filtrado pelos próprios pedidos, independentemente dos filtros.
create function public.list_delivery_orders(
  p_company_id uuid,
  p_from date default null,
  p_to date default null,
  p_fulfillment text default null,
  p_status text default null,
  p_courier_user_id uuid default null,
  p_customer_id uuid default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_from date := coalesce(p_from, (now() at time zone 'America/Sao_Paulo')::date);
  v_to date := coalesce(p_to, coalesce(p_from, (now() at time zone 'America/Sao_Paulo')::date));
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_result jsonb;
begin
  v_role := public.delivery_assert_actor(p_company_id);
  if v_to < v_from then
    raise exception 'Período inválido.' using errcode = 'PT400';
  end if;
  if v_to - v_from > 62 then
    raise exception 'O período pode ter no máximo 63 dias.' using errcode = 'PT400';
  end if;
  if p_fulfillment is not null and p_fulfillment not in ('delivery', 'pickup') then
    raise exception 'Tipo inválido.' using errcode = 'PT400';
  end if;
  if p_status is not null and p_status not in ('confirmed', 'out_for_delivery', 'delivered', 'picked_up', 'canceled') then
    raise exception 'Estado inválido.' using errcode = 'PT400';
  end if;

  select coalesce(jsonb_agg(x.j order by x.created_at desc, x.id), '[]'::jsonb) into v_result
  from (
    select d.id, d.created_at,
      jsonb_build_object(
        'id', d.id,
        'service_session_id', d.service_session_id,
        'service_order_id', d.service_order_id,
        'fulfillment', d.fulfillment,
        'delivery_status', d.delivery_status,
        'production', case
            when a.active = 0 then null
            when a.ready = a.active then 'ready'
            when a.preparing > 0 or a.ready > 0 then 'preparing'
            else 'pending' end,
        'items_active', a.active,
        'items_ready', a.ready,
        'customer_id', d.customer_id,
        'customer_name', d.customer_name,
        'customer_phone', d.customer_phone,
        'address', case when d.fulfillment = 'delivery' then jsonb_build_object(
            'street', d.addr_street, 'number', d.addr_number, 'complement', d.addr_complement,
            'neighborhood', d.addr_neighborhood, 'city', d.addr_city, 'state', d.addr_state,
            'cep', d.addr_cep, 'reference', d.addr_reference) end,
        'delivery_fee', d.delivery_fee,
        'fee_source', d.fee_source,
        'items_subtotal', a.subtotal,
        'total', case when d.delivery_status = 'canceled' then 0 else a.subtotal + d.delivery_fee end,
        'estimated_ready_at', d.estimated_ready_at,
        'estimated_delivery_at', d.estimated_delivery_at,
        'payment_timing', d.payment_timing,
        'expected_method', d.expected_method,
        'cash_change_for', d.cash_change_for,
        'courier_user_id', d.courier_user_id,
        'courier_name', pr.full_name,
        'out_for_delivery_at', d.out_for_delivery_at,
        'delivered_at', d.delivered_at,
        'picked_up_at', d.picked_up_at,
        'canceled_at', d.canceled_at,
        'cancel_reason', d.cancel_reason,
        'notes', d.notes,
        'session_status', ss.status,
        'created_at', d.created_at
      ) as j
    from public.delivery_orders d
    join public.service_sessions ss on ss.company_id = d.company_id and ss.id = d.service_session_id
    left join public.profiles pr on pr.user_id = d.courier_user_id
    cross join lateral (
      select count(*) filter (where i.quantity > i.cancelled_quantity)::integer as active,
             count(*) filter (where i.quantity > i.cancelled_quantity and i.production_status = 'ready')::integer as ready,
             count(*) filter (where i.quantity > i.cancelled_quantity and i.production_status = 'preparing')::integer as preparing,
             coalesce(sum((i.quantity - i.cancelled_quantity) * i.unit_price), 0)::numeric(12, 2) as subtotal
      from public.service_order_items i
      where i.company_id = d.company_id and i.order_id = d.service_order_id
    ) a
    where d.company_id = p_company_id
      and d.created_at >= (v_from::timestamp at time zone 'America/Sao_Paulo')
      and d.created_at < ((v_to + 1)::timestamp at time zone 'America/Sao_Paulo')
      and (v_role <> 'courier' or d.courier_user_id = auth.uid())
      and (p_fulfillment is null or d.fulfillment = p_fulfillment)
      and (p_status is null or d.delivery_status = p_status)
      and (p_courier_user_id is null or d.courier_user_id = p_courier_user_id)
      and (p_customer_id is null or d.customer_id = p_customer_id)
    order by d.created_at desc, d.id
    limit v_limit offset v_offset
  ) x;

  return v_result;
end;
$$;

create function public.get_delivery_order(p_delivery_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_do public.delivery_orders;
  v_role public.company_role;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_do from public.delivery_orders where id = p_delivery_order_id;
  if not found then
    raise exception 'Pedido de delivery não encontrado.' using errcode = 'PT404';
  end if;
  v_role := public.delivery_assert_actor(v_do.company_id);
  if v_role = 'courier' and v_do.courier_user_id is distinct from auth.uid() then
    raise exception 'Pedido de delivery não encontrado.' using errcode = 'PT404';
  end if;

  return jsonb_build_object(
    'order', to_jsonb(v_do) - 'client_request_id' - 'created_by',
    'summary', public.delivery_order_summary(v_do.id, false),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', i.id, 'name', i.product_name_snapshot, 'quantity', i.quantity, 'cancelled_quantity', i.cancelled_quantity,
          'unit_price', i.unit_price, 'production_status', i.production_status, 'notes', i.notes,
          'modifiers', public.item_modifiers_json(i.company_id, i.id, true)) order by i.created_at, i.id)
      from public.service_order_items i
      where i.company_id = v_do.company_id and i.order_id = v_do.service_order_id), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
          'event_type', e.event_type, 'old_value', e.old_value, 'new_value', e.new_value, 'note', e.note,
          'created_at', e.created_at) order by e.created_at, e.id)
      from public.delivery_order_events e
      where e.company_id = v_do.company_id and e.delivery_order_id = v_do.id), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 10) ACL
-- ---------------------------------------------------------------------------
revoke execute on function public.create_delivery_order(uuid, uuid, text, jsonb, uuid, text, text, uuid, numeric, text, text, numeric, text) from public, anon;
revoke execute on function public.set_delivery_status(uuid, text, text) from public, anon;
revoke execute on function public.assign_delivery_courier(uuid, uuid) from public, anon;
revoke execute on function public.cancel_delivery_order(uuid, text) from public, anon;
revoke execute on function public.list_delivery_orders(uuid, date, date, text, text, uuid, uuid, integer, integer) from public, anon;
revoke execute on function public.get_delivery_order(uuid) from public, anon;
grant execute on function public.create_delivery_order(uuid, uuid, text, jsonb, uuid, text, text, uuid, numeric, text, text, numeric, text) to authenticated;
grant execute on function public.set_delivery_status(uuid, text, text) to authenticated;
grant execute on function public.assign_delivery_courier(uuid, uuid) to authenticated;
grant execute on function public.cancel_delivery_order(uuid, text) to authenticated;
grant execute on function public.list_delivery_orders(uuid, date, date, text, text, uuid, uuid, integer, integer) to authenticated;
grant execute on function public.get_delivery_order(uuid) to authenticated;

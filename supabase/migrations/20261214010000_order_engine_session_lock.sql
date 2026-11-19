-- E7.1 — Elimina o deadlock entre PEDIDO NOVO e CANCELAMENTO DE ITEM com estoque controlado (ordem de travas).
-- Causa: pedido novo travava produto -> conta; cancelamento travava conta -> produto. Correção mínima: o motor de pedidos lê a conta
-- com FOR SHARE antes de travar os produtos. Corpo = o VIGENTE (20261021030000_order_engine_actor.sql) com UMA mudança (+ comentário).
-- Assinatura, ACL, retorno e regras de negócio inalterados. Rollback: supabase/rollbacks/order-engine-session-lock/rollback.sql.

create or replace function public.submit_service_order_engine(
  p_service_session_id uuid,
  p_items jsonb,
  p_origin text,
  p_enqueue_print boolean,
  p_actor_user_id uuid,
  p_actor_via text
)
returns public.service_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.service_sessions;
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
  -- ator coerente: humano <=> usuário informado; whatsapp_ai <=> sem usuário (mesma regra dos CHECKs de autoria)
  if p_actor_via is null or p_actor_via not in ('user', 'whatsapp_ai')
     or (p_actor_via = 'user') <> (p_actor_user_id is not null) then
    raise exception 'Ator do pedido inválido.' using errcode = 'PT400';
  end if;
  if p_origin is null or p_origin not in ('attendant', 'cashier', 'whatsapp', 'delivery') then
    raise exception 'Origem do pedido inválida.' using errcode = 'PT400';
  end if;

  -- E7.1: a CONTA é travada (FOR SHARE) ANTES dos produtos de estoque controlado. Ordem única do sistema: conta -> item -> produto.
  -- O cancelamento de item já trava a conta (FOR UPDATE) antes do produto; com a ordem oposta aqui havia deadlock (40P01).
  -- FOR SHARE = o mesmo modo que o gatilho service_orders_session_open toma depois; pedidos simultâneos na mesma conta seguem em paralelo.
  select * into v_session from public.service_sessions where id = p_service_session_id
  for share;
  if not found then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;

  if v_session.status <> 'open' then
    raise exception 'Este atendimento não está aberto.' using errcode = 'PT409';
  end if;

  -- Origem decidida por quem chama o motor (a função pública decide pelo papel; nunca por valor do payload).
  -- atendimento de delivery só recebe pedido pelo módulo Delivery (origin 'delivery'); delivery nunca em comanda/mesa
  v_origin := p_origin;
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

  insert into public.service_orders (company_id, service_session_id, origin, status, created_by, created_via)
  values (v_session.company_id, v_session.id, v_origin, 'submitted', p_actor_user_id, p_actor_via)
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
        company_id, product_id, movement_type, quantity, reason, balance_after, service_order_item_id, created_by, created_via
      ) values (
        v_session.company_id, v_product.id, 'sale', v_quantity::integer,
        left('Pedido ' || coalesce(v_label, ''), 200), v_balance, v_item_id, p_actor_user_id, p_actor_via
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

revoke execute on function public.submit_service_order_engine(uuid, jsonb, text, boolean, uuid, text)
  from public, anon, authenticated, service_role;

comment on function public.submit_service_order_engine(uuid, jsonb, text, boolean, uuid, text) is
  'Motor único de pedido com ATOR EXPLÍCITO (humano ou whatsapp_ai). Sem EXECUTE para nenhum papel: só funções SECURITY DEFINER da base o chamam.';

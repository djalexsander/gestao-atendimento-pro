-- WhatsApp pedido conversacional — passo 2 (D1/D2/D10/P1/P3): MOTOR DE PEDIDO COM ATOR EXPLÍCITO.
--
-- Problema (auditado): submit_service_order_core e create_delivery_order dependem de auth.uid() e do papel do usuário. O
-- worker da IA roda com service_role (sem auth.uid()). Além disso create_delivery_order exige cliente cadastrado e endereço
-- de customer_addresses na entrega.
--
-- Solução MÍNIMA e isolada (nenhuma regra de negócio é duplicada ou reescrita):
--   1. submit_service_order_engine(...)  = o corpo VIGENTE de submit_service_order_core (20261014080000) a partir da
--      verificação de status do atendimento, com o ator recebido por parâmetro (p_actor_user_id, p_actor_via) no lugar de
--      auth.uid(). Mesmo preço, mesmos modificadores, mesmo estoque, mesmo setor, mesmos erros e mesma ordem de checagem.
--   2. submit_service_order_core(...)    = continua com a MESMA assinatura/ACL; faz as checagens de usuário/papel que sempre
--      fez (PT401, PT404, PT403, origem pelo papel) e delega ao motor com o ator humano. Comportamento idêntico.
--   3. create_delivery_order_engine(...) = o corpo VIGENTE de create_delivery_order, com o ator por parâmetro e dois
--      caminhos que SÓ o ator whatsapp_ai usa: (a) cliente nulo também na entrega (snapshot de nome/telefone do contato);
--      (b) endereço em snapshot (p_address, limpo por delivery_clean_address) em vez de customer_addresses; e zona
--      OBRIGATÓRIA (sem taxa padrão e sem taxa manual — P1). Telefone do snapshot: 8 a 15 dígitos (P3).
--   4. create_delivery_order(...)        = continua com a MESMA assinatura/ACL; faz delivery_assert_operator e delega ao
--      motor com o ator humano. O caminho humano permanece exatamente como era (cliente e endereço cadastrados, taxa por
--      zona > padrão > manual), exceto o limite do telefone (13 -> 15 dígitos).
--
-- SEGURANÇA: os dois motores têm EXECUTE revogado de TODOS os papéis, inclusive service_role (só funções SECURITY DEFINER da
-- própria base os chamam). Quem os usar com ator whatsapp_ai (a futura RPC de confirmação do rascunho) é que garante
-- contexto/idempotência/confirmação; aqui o motor só recusa combinações inconsistentes de ator, canal e vínculo.

-- ---------------------------------------------------------------------------
-- 1) Motor de pedido: submit_service_order_engine
-- ---------------------------------------------------------------------------
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

  select * into v_session from public.service_sessions where id = p_service_session_id;
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

-- ---------------------------------------------------------------------------
-- 2) submit_service_order_core: mesma assinatura e ACL; checagens de usuário/papel e delegação ao motor
-- ---------------------------------------------------------------------------
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

  -- (o status do atendimento e a regra origem x tipo são checados, nesta ordem, pelo motor)
  -- Origem decidida pelo papel de quem chama (nunca por um valor enviado no payload): só
  -- attendant tem área operacional própria hoje; os demais papéis autorizados operam como Caixa.
  return public.submit_service_order_engine(
    p_service_session_id,
    p_items,
    coalesce(p_origin, case when v_role = 'attendant' then 'attendant' else 'cashier' end),
    p_enqueue_print,
    auth.uid(),
    'user'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Motor do pedido de delivery/retirada: create_delivery_order_engine
-- ---------------------------------------------------------------------------
create function public.create_delivery_order_engine(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_actor_via text,
  p_actor_role public.company_role,
  p_client_request_id uuid,
  p_fulfillment text,
  p_items jsonb,
  p_customer_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_address_id uuid,
  p_address jsonb,
  p_manual_fee numeric,
  p_payment_timing text,
  p_expected_method text,
  p_cash_change_for numeric,
  p_notes text,
  p_channel text,
  p_whatsapp_conversation_id uuid,
  p_whatsapp_order_draft_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ai boolean := (p_actor_via = 'whatsapp_ai');
  v_role public.company_role := p_actor_role;
  v_existing public.delivery_orders;
  v_settings jsonb;
  v_customer public.customers;
  v_addr public.customer_addresses;
  v_clean jsonb;
  v_a_source_id uuid;
  v_a_street text;
  v_a_number text;
  v_a_complement text;
  v_a_neigh text;
  v_a_city text;
  v_a_state text;
  v_a_cep text;
  v_a_ref text;
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
  -- Ator, canal e vínculo coerentes (as mesmas regras dos CHECKs de autoria, com erro legível).
  if p_actor_via is null or p_actor_via not in ('user', 'whatsapp_ai')
     or (p_actor_via = 'user') <> (p_actor_user_id is not null) then
    raise exception 'Ator do pedido inválido.' using errcode = 'PT400';
  end if;
  if p_channel is null or p_channel not in ('counter', 'phone', 'whatsapp', 'other') then
    raise exception 'Canal do pedido inválido.' using errcode = 'PT400';
  end if;
  if v_ai then
    if p_actor_role is not null or p_channel <> 'whatsapp'
       or p_whatsapp_conversation_id is null or p_whatsapp_order_draft_id is null then
      raise exception 'Pedido do WhatsApp sem a origem completa (conversa e rascunho).' using errcode = 'PT400';
    end if;
    -- a IA nunca usa taxa manual, endereço cadastrado nem cliente inexistente na empresa
    if p_manual_fee is not null or p_address_id is not null then
      raise exception 'Pedido do WhatsApp não aceita taxa manual nem endereço cadastrado.' using errcode = 'PT400';
    end if;
    perform public.assert_company_module(p_company_id, 'delivery');
    perform public.assert_company_module(p_company_id, 'whatsapp');
  else
    if p_whatsapp_conversation_id is not null or p_whatsapp_order_draft_id is not null or p_address is not null then
      raise exception 'Dados de origem do WhatsApp só valem para o pedido da IA.' using errcode = 'PT400';
    end if;
  end if;

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
    -- sem cliente cadastrado: só a retirada pelo caminho humano; o pedido da IA aceita também a entrega (snapshot do contato)
    if p_fulfillment = 'delivery' and not v_ai then
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
    if v_ai and v_phone is null then
      raise exception 'Informe o telefone do contato.' using errcode = 'PT400';
    end if;
  end if;
  -- E.164 sem o "+": 8 a 15 dígitos (mesmo limite do CHECK de delivery_orders.customer_phone)
  if v_phone is not null and char_length(v_phone) not between 8 and 15 then
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

  -- Endereço (entrega). Humano: SÓ de customer_addresses, ativo, da mesma empresa e do mesmo cliente.
  -- IA: snapshot (p_address) validado e normalizado por delivery_clean_address; nada é gravado em customer_addresses.
  if p_fulfillment = 'delivery' then
    if not v_ai then
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
      v_a_source_id := v_addr.id; v_a_street := v_addr.street; v_a_number := v_addr.number; v_a_complement := v_addr.complement;
      v_a_neigh := v_addr.neighborhood; v_a_city := v_addr.city; v_a_state := v_addr.state; v_a_cep := v_addr.cep;
      v_a_ref := v_addr.reference;
    else
      if p_address is null or jsonb_typeof(p_address) <> 'object' then
        raise exception 'Informe o endereço de entrega.' using errcode = 'PT400';
      end if;
      v_clean := public.delivery_clean_address(
        null, p_address ->> 'cep', p_address ->> 'street', p_address ->> 'number', p_address ->> 'complement',
        p_address ->> 'neighborhood', p_address ->> 'city', p_address ->> 'state', p_address ->> 'reference', null, null);
      v_a_source_id := null; v_a_street := v_clean ->> 'street'; v_a_number := v_clean ->> 'number';
      v_a_complement := v_clean ->> 'complement'; v_a_neigh := v_clean ->> 'neighborhood'; v_a_city := v_clean ->> 'city';
      v_a_state := v_clean ->> 'state'; v_a_cep := v_clean ->> 'cep'; v_a_ref := v_clean ->> 'reference';
    end if;
  elsif p_address_id is not null or p_address is not null then
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
      and z.city_key = public.delivery_norm_text(v_a_city)
      and z.neighborhood_key = public.delivery_norm_text(v_a_neigh);
    v_zone_found := found;

    if v_ai then
      -- P1: a IA só entrega em ZONA ATIVA cadastrada. Nunca usa a taxa padrão nem taxa manual.
      if not v_zone_found then
        raise exception 'Este endereço está fora das zonas de entrega atendidas.' using errcode = 'PT409';
      end if;
      v_fee := v_zone.fee; v_source := 'zone';
    else
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
    end if;

    v_minutes := coalesce(case when v_zone_found then v_zone.estimated_minutes end, (v_settings ->> 'delivery_minutes')::integer);
    v_deliv := now() + make_interval(mins => v_minutes);
  end if;

  -- Atendimento delivery (sem ponto) + pedido pelo MOTOR ÚNICO (preço, modificadores, estoque, setor, snapshots)
  insert into public.service_sessions (company_id, kind, customer_name, customer_id, status, opened_by, created_via)
  values (p_company_id, 'delivery', v_name, p_customer_id, 'open', p_actor_user_id, p_actor_via)
  returning * into v_session;

  v_order := public.submit_service_order_engine(v_session.id, p_items, 'delivery', false, p_actor_user_id, p_actor_via);

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
    payment_timing, expected_method, cash_change_for, notes, created_by,
    channel, created_via, whatsapp_conversation_id, whatsapp_order_draft_id
  ) values (
    p_company_id, v_session.id, v_order.id, p_client_request_id, p_fulfillment, 'confirmed',
    p_customer_id, v_name, v_phone, case when p_fulfillment = 'delivery' then v_a_source_id end,
    case when p_fulfillment = 'delivery' then v_a_street end, case when p_fulfillment = 'delivery' then v_a_number end,
    case when p_fulfillment = 'delivery' then v_a_complement end, case when p_fulfillment = 'delivery' then v_a_neigh end,
    case when p_fulfillment = 'delivery' then v_a_city end, case when p_fulfillment = 'delivery' then v_a_state end,
    case when p_fulfillment = 'delivery' then v_a_cep end, case when p_fulfillment = 'delivery' then v_a_ref end,
    v_fee, v_source, case when v_source = 'zone' then v_zone.id end, v_ready, v_deliv,
    v_timing, v_method, p_cash_change_for, v_notes, p_actor_user_id,
    p_channel, p_actor_via, p_whatsapp_conversation_id, p_whatsapp_order_draft_id
  ) returning * into v_do;

  insert into public.delivery_order_events (company_id, delivery_order_id, event_type, actor_user_id, new_value)
  values (p_company_id, v_do.id, 'created', p_actor_user_id,
          jsonb_build_object('fulfillment', p_fulfillment, 'delivery_fee', v_fee, 'fee_source', v_source, 'total', v_total)
          || case when v_ai then jsonb_build_object(
               'created_via', 'whatsapp_ai',
               'whatsapp_conversation_id', p_whatsapp_conversation_id,
               'whatsapp_order_draft_id', p_whatsapp_order_draft_id) else '{}'::jsonb end);
  if v_override then
    insert into public.delivery_order_events (company_id, delivery_order_id, event_type, actor_user_id, old_value, new_value)
    values (p_company_id, v_do.id, 'fee_overridden', p_actor_user_id, v_old_fee,
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

revoke execute on function public.create_delivery_order_engine(
  uuid, uuid, text, public.company_role, uuid, text, jsonb, uuid, text, text, uuid, jsonb, numeric, text, text, numeric, text, text, uuid, uuid)
  from public, anon, authenticated, service_role;

comment on function public.create_delivery_order_engine(
  uuid, uuid, text, public.company_role, uuid, text, jsonb, uuid, text, text, uuid, jsonb, numeric, text, text, numeric, text, text, uuid, uuid) is
  'Motor do pedido de delivery/retirada com ATOR EXPLÍCITO (humano ou whatsapp_ai). Sem EXECUTE para nenhum papel. O ator whatsapp_ai: cliente opcional, endereço em snapshot, zona ativa obrigatória (sem taxa padrão/manual), vínculo de conversa e rascunho obrigatório.';

-- ---------------------------------------------------------------------------
-- 4) create_delivery_order: mesma assinatura e ACL; checagem de operador/módulo e delegação ao motor
-- ---------------------------------------------------------------------------
create or replace function public.create_delivery_order(
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
begin
  v_role := public.delivery_assert_operator(p_company_id);

  return public.create_delivery_order_engine(
    p_company_id, auth.uid(), 'user', v_role,
    p_client_request_id, p_fulfillment, p_items,
    p_customer_id, p_customer_name, p_customer_phone,
    p_address_id, null,
    p_manual_fee, p_payment_timing, p_expected_method, p_cash_change_for, p_notes,
    'counter', null, null
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Impressão do pedido: o job herda a autoria do pedido (created_by + created_via)
-- ---------------------------------------------------------------------------
-- Corpo VIGENTE de enqueue_order_print_jobs (20261014080000) com UMA mudança: o job grava created_via do pedido. Sem isso,
-- o job de um pedido da IA (created_by nulo) violaria print_jobs_actor_check e nunca seria impresso.
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
    insert into public.print_jobs (company_id, print_device_id, job_type, service_order_id, payload, created_by, created_via)
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
      v_order.created_by, v_order.created_via
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

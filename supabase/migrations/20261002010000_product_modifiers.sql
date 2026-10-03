-- Adicionais / modificadores de produto (ex.: Coca "Limão e gelo"; X-Salada "sem cebola", "+ Bacon R$ 5").
-- Só personalização do item: NÃO é ingrediente, ficha técnica nem baixa de estoque. Não altera nenhuma
-- migration aplicada: tabelas novas, uma coluna nova em service_order_items e CREATE OR REPLACE (mesma
-- assinatura e mesmo ACL) das funções que precisam enxergar os modificadores.
--
--   1. product_modifier_groups          grupos (Como servir / Adicionais), single|multiple, min/max, ordem.
--   2. product_modifier_options         opções do grupo: add|remove, price_delta >= 0 (remove = 0).
--   3. product_modifier_group_products  quais produtos usam cada grupo (um grupo serve vários produtos).
--   4. service_order_item_modifiers     SNAPSHOT do que foi escolhido em cada item (nome do grupo, nome da
--                                       opção e acréscimo congelados; renomear/desativar depois não muda o pedido).
--   5. service_order_items.modifiers_unit_total + unit_price
--        unit_price continua sendo o preço UNITÁRIO COBRADO do item e agora já INCLUI os adicionais
--        (preço base + soma dos price_delta). Por isso nada que soma quantity * unit_price (fechamento,
--        cancelamento parcial, estorno, relatórios, conta) precisa mudar: adicionais entram no valor
--        pago/cancelado/estornado e no "valor vendido" do produto principal. modifiers_unit_total guarda
--        só a parte dos adicionais (preço base = unit_price - modifiers_unit_total).
--   6. submit_service_order: aceita "modifier_option_ids" por item; o SERVIDOR valida (empresa, vínculo com
--      o produto, ativo, min/max) e calcula o acréscimo — nunca confia em preço vindo do cliente.
--   7. Impressão de produção/cancelamento/conta e fila de produção passam a trazer os modificadores
--      (a produção/ticket da cozinha NÃO leva preço; a conta leva).
--
-- Quem pode o quê: owner/admin cadastram (escrita direta com RLS + GRANT por coluna, mesmo padrão do catálogo);
-- cashier/attendant só LEEM (inclusive inativos, para o Realtime; a tela filtra as ativas); lançar pedido segue a regra atual de submit_service_order.

-- ---------------------------------------------------------------------------
-- 1) Grupos
-- ---------------------------------------------------------------------------
create table public.product_modifier_groups (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null
    constraint product_modifier_groups_name_length check (char_length(name) between 1 and 60),
  selection_type text not null default 'multiple'
    constraint product_modifier_groups_type_check check (selection_type in ('single', 'multiple')),
  min_selection integer not null default 0
    constraint product_modifier_groups_min_check check (min_selection between 0 and 20),
  -- NULL = sem limite (só em 'multiple'); single é sempre 1.
  max_selection integer
    constraint product_modifier_groups_max_check check (max_selection is null or max_selection between 1 and 20),
  is_required boolean not null default false,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_modifier_groups_company_id_id_key unique (company_id, id),
  constraint product_modifier_groups_single_check check (selection_type = 'multiple' or (max_selection = 1 and min_selection <= 1)),
  constraint product_modifier_groups_range_check check (max_selection is null or max_selection >= min_selection),
  constraint product_modifier_groups_required_check check (is_required = (min_selection >= 1))
);

comment on table public.product_modifier_groups is
  'Grupos de adicionais/opções reutilizáveis por vários produtos (Como servir, Adicionais, Retirar ingredientes). single = escolhe 1; multiple = escolhe vários (até max_selection, se houver). is_required deriva de min_selection >= 1.';

create function public.prepare_product_modifier_group()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.name := btrim(new.name);
  if tg_op = 'UPDATE' and new.company_id is distinct from old.company_id then
    raise exception 'A empresa de um grupo não pode ser alterada.' using errcode = 'PT409';
  end if;
  if new.selection_type = 'single' then
    new.max_selection := 1;
    new.min_selection := least(new.min_selection, 1);
  end if;
  new.is_required := new.min_selection >= 1;
  return new;
end;
$$;

create trigger product_modifier_groups_prepare
  before insert or update on public.product_modifier_groups
  for each row execute function public.prepare_product_modifier_group();
create trigger product_modifier_groups_set_updated_at
  before update on public.product_modifier_groups
  for each row execute function public.set_updated_at();
revoke execute on function public.prepare_product_modifier_group() from public, anon, authenticated;

alter table public.product_modifier_groups enable row level security;

-- Leitura: QUALQUER vínculo ativo da empresa lê TAMBÉM as linhas inativas (a tela só EXIBE as ativas). Sem isso, a
-- desativação (active -> inactive) some da visão de attendant/cashier e o Realtime não entrega o UPDATE a eles.
-- Ler o nome de uma opção inativa não concede ação nenhuma: escrita segue só owner/admin e o servidor recusa inativas.
create policy product_modifier_groups_select on public.product_modifier_groups
  for select to authenticated
  using (company_id in (select public.user_company_ids()));
create policy product_modifier_groups_insert on public.product_modifier_groups
  for insert to authenticated
  with check (public.user_role_in_company(company_id) in ('owner', 'admin'));
create policy product_modifier_groups_update on public.product_modifier_groups
  for update to authenticated
  using (public.user_role_in_company(company_id) in ('owner', 'admin'))
  with check (public.user_role_in_company(company_id) in ('owner', 'admin'));

revoke all on public.product_modifier_groups from anon, authenticated;
grant select on public.product_modifier_groups to authenticated;
grant insert (company_id, name, selection_type, min_selection, max_selection, sort_order, is_active)
  on public.product_modifier_groups to authenticated;
grant update (name, selection_type, min_selection, max_selection, sort_order, is_active)
  on public.product_modifier_groups to authenticated;
grant all on public.product_modifier_groups to service_role;

-- ---------------------------------------------------------------------------
-- 2) Opções
-- ---------------------------------------------------------------------------
create table public.product_modifier_options (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  group_id uuid not null,
  name text not null
    constraint product_modifier_options_name_length check (char_length(name) between 1 and 60),
  modifier_type text not null default 'add'
    constraint product_modifier_options_type_check check (modifier_type in ('add', 'remove')),
  -- Acréscimo por UNIDADE do produto. Sem preço negativo nesta versão; remove nunca cobra.
  price_delta numeric(12, 2) not null default 0
    constraint product_modifier_options_price_check check (price_delta >= 0 and price_delta <= 9999.99 and price_delta <> 'NaN'::numeric),
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_modifier_options_company_id_id_key unique (company_id, id),
  constraint product_modifier_options_remove_free check (modifier_type = 'add' or price_delta = 0),
  constraint product_modifier_options_group_fkey
    foreign key (company_id, group_id) references public.product_modifier_groups (company_id, id)
);
create index product_modifier_options_group_idx on public.product_modifier_options (company_id, group_id);

comment on table public.product_modifier_options is
  'Opções de um grupo. add pode ter acréscimo (price_delta >= 0); remove ("Sem cebola") é sempre R$ 0. Não mexe em estoque.';

create function public.prepare_product_modifier_option()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.name := btrim(new.name);
  if tg_op = 'UPDATE' and (new.company_id is distinct from old.company_id or new.group_id is distinct from old.group_id) then
    raise exception 'O grupo de uma opção não pode ser alterado.' using errcode = 'PT409';
  end if;
  if new.modifier_type = 'remove' then
    new.price_delta := 0;
  end if;
  return new;
end;
$$;

create trigger product_modifier_options_prepare
  before insert or update on public.product_modifier_options
  for each row execute function public.prepare_product_modifier_option();
create trigger product_modifier_options_set_updated_at
  before update on public.product_modifier_options
  for each row execute function public.set_updated_at();
revoke execute on function public.prepare_product_modifier_option() from public, anon, authenticated;

alter table public.product_modifier_options enable row level security;

-- Leitura: QUALQUER vínculo ativo da empresa lê TAMBÉM as linhas inativas (a tela só EXIBE as ativas). Sem isso, a
-- desativação (active -> inactive) some da visão de attendant/cashier e o Realtime não entrega o UPDATE a eles.
-- Ler o nome de uma opção inativa não concede ação nenhuma: escrita segue só owner/admin e o servidor recusa inativas.
create policy product_modifier_options_select on public.product_modifier_options
  for select to authenticated
  using (company_id in (select public.user_company_ids()));
create policy product_modifier_options_insert on public.product_modifier_options
  for insert to authenticated
  with check (public.user_role_in_company(company_id) in ('owner', 'admin'));
create policy product_modifier_options_update on public.product_modifier_options
  for update to authenticated
  using (public.user_role_in_company(company_id) in ('owner', 'admin'))
  with check (public.user_role_in_company(company_id) in ('owner', 'admin'));

revoke all on public.product_modifier_options from anon, authenticated;
grant select on public.product_modifier_options to authenticated;
grant insert (company_id, group_id, name, modifier_type, price_delta, sort_order, is_active)
  on public.product_modifier_options to authenticated;
grant update (name, modifier_type, price_delta, sort_order, is_active)
  on public.product_modifier_options to authenticated;
grant all on public.product_modifier_options to service_role;

-- ---------------------------------------------------------------------------
-- 3) Vínculo grupo <-> produto
-- ---------------------------------------------------------------------------
create table public.product_modifier_group_products (
  company_id uuid not null references public.companies(id) on delete cascade,
  group_id uuid not null,
  product_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (group_id, product_id),
  constraint product_modifier_group_products_group_fkey
    foreign key (company_id, group_id) references public.product_modifier_groups (company_id, id),
  constraint product_modifier_group_products_product_fkey
    foreign key (company_id, product_id) references public.products (company_id, id)
);
create index product_modifier_group_products_product_idx on public.product_modifier_group_products (company_id, product_id);

alter table public.product_modifier_group_products enable row level security;

create policy product_modifier_group_products_select on public.product_modifier_group_products
  for select to authenticated
  using (company_id in (select public.user_company_ids()));
create policy product_modifier_group_products_insert on public.product_modifier_group_products
  for insert to authenticated
  with check (public.user_role_in_company(company_id) in ('owner', 'admin'));
create policy product_modifier_group_products_delete on public.product_modifier_group_products
  for delete to authenticated
  using (public.user_role_in_company(company_id) in ('owner', 'admin'));

revoke all on public.product_modifier_group_products from anon, authenticated;
grant select on public.product_modifier_group_products to authenticated;
grant insert (company_id, group_id, product_id) on public.product_modifier_group_products to authenticated;
grant delete on public.product_modifier_group_products to authenticated;
grant all on public.product_modifier_group_products to service_role;

-- ---------------------------------------------------------------------------
-- 4) Snapshot por item do pedido
-- ---------------------------------------------------------------------------
alter table public.service_order_items
  add column modifiers_unit_total numeric(12, 2) not null default 0
    constraint service_order_items_modifiers_total_check check (modifiers_unit_total >= 0 and modifiers_unit_total <= unit_price);

comment on column public.service_order_items.modifiers_unit_total is
  'Parte do unit_price que veio de adicionais (soma dos price_delta escolhidos, por unidade). unit_price já INCLUI isso; preço base = unit_price - modifiers_unit_total.';

create table public.service_order_item_modifiers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  service_order_item_id uuid not null,
  -- Referências "vivas" só para relatório futuro; o histórico é o snapshot abaixo.
  modifier_option_id uuid,
  group_id uuid,
  group_name text not null check (char_length(group_name) between 1 and 60),
  option_name text not null check (char_length(option_name) between 1 and 60),
  modifier_type text not null check (modifier_type in ('add', 'remove')),
  price_delta numeric(12, 2) not null check (price_delta >= 0),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  constraint service_order_item_modifiers_item_fkey
    foreign key (company_id, service_order_item_id) references public.service_order_items (company_id, id),
  constraint service_order_item_modifiers_option_fkey
    foreign key (company_id, modifier_option_id) references public.product_modifier_options (company_id, id),
  constraint service_order_item_modifiers_group_fkey
    foreign key (company_id, group_id) references public.product_modifier_groups (company_id, id)
);
create index service_order_item_modifiers_item_idx on public.service_order_item_modifiers (company_id, service_order_item_id);
create index service_order_item_modifiers_option_idx on public.service_order_item_modifiers (company_id, modifier_option_id)
  where modifier_option_id is not null;

comment on table public.service_order_item_modifiers is
  'SNAPSHOT dos modificadores escolhidos em um item (gravado só por submit_service_order): group_name, option_name e price_delta congelados.';

alter table public.service_order_item_modifiers enable row level security;
create policy service_order_item_modifiers_select on public.service_order_item_modifiers
  for select to authenticated
  using (company_id in (select public.user_company_ids()));
revoke all on public.service_order_item_modifiers from anon, authenticated;
grant select on public.service_order_item_modifiers to authenticated;
grant all on public.service_order_item_modifiers to service_role;

-- ---------------------------------------------------------------------------
-- 5) Helper: modificadores de um item em JSON (ordem de exibição). Sem preço para produção/cozinha.
-- ---------------------------------------------------------------------------
create function public.item_modifiers_json(p_company_id uuid, p_item_id uuid, p_with_prices boolean)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(
    case when p_with_prices
      then jsonb_build_object('group', m.group_name, 'name', m.option_name, 'type', m.modifier_type, 'price_delta', m.price_delta)
      else jsonb_build_object('group', m.group_name, 'name', m.option_name, 'type', m.modifier_type)
    end order by m.position, m.id
  ), '[]'::jsonb)
  from public.service_order_item_modifiers m
  where m.company_id = p_company_id and m.service_order_item_id = p_item_id;
$$;
revoke execute on function public.item_modifiers_json(uuid, uuid, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6) Fila/histórico de produção: embrulham as versões atuais e acrescentam "modifiers" a cada item
--
--    POR QUE WRAPPER (e não copiar as ~170 linhas): production_queue (20260930070000) e
--    production_history (20260930100000) concentram timezone, filtros, ordem, limites e checagem de papel.
--    O wrapper NÃO reimplementa nada disso: chama a função original (renomeada para *_base, EXECUTE fechado
--    para clientes) PRIMEIRO — qualquer PT401/PT403/PT404 sai de lá antes de o wrapper fazer algo — e só
--    acrescenta a chave "modifiers" em cada item do resultado (mesma ordem, via WITH ORDINALITY; mesmos ids,
--    portanto mesma empresa). Mesma assinatura, SECURITY DEFINER, search_path = public, STABLE, e EXECUTE só
--    para authenticated (igual às originais).
--    DEPENDÊNCIA: o comportamento de produção vive em *_base. Uma migration futura que mude fila/histórico
--    deve fazer CREATE OR REPLACE de production_queue_base/production_history_base (não do wrapper). Se
--    alguém redefinir o nome público inteiro, os modificadores somem da produção — o teste
--    .claude/db-tests/modifiers.mjs ("wrapper = base + modifiers") falha nesse caso.
-- ---------------------------------------------------------------------------
alter function public.production_queue(uuid, uuid, integer) rename to production_queue_base;
revoke execute on function public.production_queue_base(uuid, uuid, integer) from public, anon, authenticated;

create function public.production_queue(p_company_id uuid, p_sector_id uuid default null, p_ready_limit integer default 15)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb := public.production_queue_base(p_company_id, p_sector_id, p_ready_limit);
begin
  return jsonb_set(v, '{items}', coalesce((
    select jsonb_agg(t.it || jsonb_build_object('modifiers', public.item_modifiers_json(p_company_id, (t.it ->> 'id')::uuid, false)) order by t.ord)
    from jsonb_array_elements(v -> 'items') with ordinality as t(it, ord)
  ), '[]'::jsonb));
end;
$$;
revoke execute on function public.production_queue(uuid, uuid, integer) from public, anon;
grant execute on function public.production_queue(uuid, uuid, integer) to authenticated;

alter function public.production_history(uuid, date, uuid) rename to production_history_base;
revoke execute on function public.production_history_base(uuid, date, uuid) from public, anon, authenticated;

create function public.production_history(p_company_id uuid, p_date date default null, p_sector_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb := public.production_history_base(p_company_id, p_date, p_sector_id);
begin
  return jsonb_set(v, '{items}', coalesce((
    select jsonb_agg(t.it || jsonb_build_object('modifiers', public.item_modifiers_json(p_company_id, (t.it ->> 'id')::uuid, false)) order by t.ord)
    from jsonb_array_elements(v -> 'items') with ordinality as t(it, ord)
  ), '[]'::jsonb));
end;
$$;
revoke execute on function public.production_history(uuid, date, uuid) from public, anon;
grant execute on function public.production_history(uuid, date, uuid) to authenticated;

comment on function public.production_queue(uuid, uuid, integer) is
  'Wrapper: chama production_queue_base (regras originais) e acrescenta modifiers (sem preço) a cada item. Mudanças de comportamento vão em production_queue_base.';
comment on function public.production_history(uuid, date, uuid) is
  'Wrapper: chama production_history_base (regras originais) e acrescenta modifiers (sem preço) a cada item. Mudanças de comportamento vão em production_history_base.';

-- ---------------------------------------------------------------------------
-- 6b) Realtime dos CADASTROS de modificadores (grupos, opções, vínculos), para o catálogo aberto do garçom
--     recarregar sozinho. NÃO publica o snapshot (service_order_item_modifiers) e não remove nada da publication.
--     A policy de leitura NÃO filtra por is_active (Realtime respeita RLS): o garçom recebe também a transição
--     active -> inactive e o catálogo aberto recarrega na hora.
--     REPLICA IDENTITY FULL no vínculo: o DELETE (remover vínculo) só carrega a chave primária por padrão, e o
--     filtro company_id=eq.<empresa> do Realtime precisa de company_id no registro antigo.
-- ---------------------------------------------------------------------------
alter table public.product_modifier_group_products replica identity full;

do $$
declare
  t text;
begin
  foreach t in array array['product_modifier_groups', 'product_modifier_options', 'product_modifier_group_products'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;


-- ---------------------------------------------------------------------------
-- 7) submit_service_order (aceita modifier_option_ids), impressão de pedido/cancelamento/conta
--    (mesmas assinaturas e ACL das funções atuais; só ganham os modificadores)
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
  begin
    perform public.enqueue_order_print_jobs(v_order.id);
  exception when others then
    raise warning 'Falha ao enfileirar impressão (enqueue_order_print_jobs) %: %', v_order.id, sqlerrm;
    perform public.record_print_enqueue_failure(v_order.company_id, 'production_order', v_order.id, null, sqlerrm);
  end;

  return v_order;
end;
$$;

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
  join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
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
          'label', (case when v_point_type = 'table' then 'Mesa ' else 'Comanda ' end) || v_point_code
        ),
        'customer_name', v_customer,
        'operator', jsonb_build_object('name', v_operator),
        'sent_at', v_order.submitted_at,
        'scope', case when v_full then 'full_order' else 'production_sector' end,
        'items', v_items
      ),
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

create or replace function public.enqueue_cancellation_print_jobs(p_cancellation_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c public.service_order_item_cancellations;
  v_item public.service_order_items;
  v_order public.service_orders;
  v_point_type text;
  v_point_code text;
  v_point_name text;
  v_customer text;
  v_sector jsonb;
  v_device public.print_devices;
  v_job_id uuid;
  v_by text;
  v_created integer := 0;
begin
  select * into v_c from public.service_order_item_cancellations where id = p_cancellation_id;
  if not found then
    return 0;
  end if;

  select * into v_item from public.service_order_items where company_id = v_c.company_id and id = v_c.service_order_item_id;
  select * into v_order from public.service_orders where company_id = v_item.company_id and id = v_item.order_id;

  select sp.type, sp.code, sp.display_name, ss.customer_name
    into v_point_type, v_point_code, v_point_name, v_customer
  from public.service_sessions ss
  join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
  where ss.company_id = v_order.company_id and ss.id = v_order.service_session_id;

  select jsonb_build_object('id', s.id, 'name', s.name) into v_sector
  from public.production_sectors s
  where s.company_id = v_item.company_id and s.id = v_item.production_sector_id;

  v_by := public.print_actor_name(v_c.company_id, v_c.cancelled_by);

  for v_device in
    select d.* from public.print_devices d
    where d.company_id = v_c.company_id
      and d.is_ready
      and d.id in (
        select pj.print_device_id
        from public.print_job_items pji
        join public.print_jobs pj on pj.company_id = pji.company_id and pj.id = pji.print_job_id
        where pji.company_id = v_c.company_id
          and pji.service_order_item_id = v_c.service_order_item_id
          and pj.job_type = 'production_order'
          and pj.reprint_of_id is null
      )
    order by d.id
    for share
  loop
    v_job_id := null;
    insert into public.print_jobs (company_id, print_device_id, job_type, service_order_id, cancellation_id, payload, created_by)
    values (
      v_c.company_id, v_device.id, 'production_cancellation', v_order.id, v_c.id,
      public.print_base_payload('production_cancellation', v_device) || jsonb_build_object(
        'order', jsonb_build_object('id', v_order.id, 'origin', v_order.origin),
        'service_point', jsonb_build_object(
          'type', v_point_type, 'code', v_point_code, 'display_name', v_point_name,
          'label', (case when v_point_type = 'table' then 'Mesa ' else 'Comanda ' end) || v_point_code
        ),
        'customer_name', v_customer,
        'sent_at', v_order.submitted_at,
        'reason', v_c.reason,
        'cancelled_by', jsonb_build_object('name', v_by),
        'cancelled_at', v_c.created_at,
        'items', jsonb_build_array(jsonb_build_object(
          'service_order_item_id', v_item.id,
          'product_name', v_item.product_name_snapshot,
          'quantity', v_c.quantity,
          'notes', v_item.notes,
          'modifiers', public.item_modifiers_json(v_item.company_id, v_item.id, false),
          'sector', v_sector
        ))
      ),
      v_c.cancelled_by
    )
    on conflict (print_device_id, cancellation_id)
      where job_type = 'production_cancellation' and reprint_of_id is null
      do nothing
    returning id into v_job_id;

    if v_job_id is null then
      continue;
    end if;

    insert into public.print_job_items (company_id, print_job_id, service_order_item_id, quantity)
    values (v_c.company_id, v_job_id, v_item.id, v_c.quantity);

    v_created := v_created + 1;
  end loop;

  return v_created;
end;
$$;

create or replace function public.enqueue_customer_bill(p_service_session_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.service_sessions;
  v_role public.company_role;
  v_items jsonb;
  v_total numeric(12, 2);
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
    raise exception 'Você não tem permissão para imprimir a conta.' using errcode = 'PT403';
  end if;

  -- Mesma base do fechamento: quantidade cobrável (quantity - cancelled_quantity) de pedidos enviados.
  select
    jsonb_agg(jsonb_build_object(
      'product_name', i.product_name_snapshot,
      'quantity', i.quantity - i.cancelled_quantity,
      'unit_price', i.unit_price,
      'base_unit_price', i.unit_price - i.modifiers_unit_total,
      'modifiers', public.item_modifiers_json(i.company_id, i.id, true),
      'total', (i.quantity - i.cancelled_quantity) * i.unit_price,
      'notes', i.notes
    ) order by i.created_at, i.product_name_snapshot, i.id),
    coalesce(sum((i.quantity - i.cancelled_quantity) * i.unit_price), 0)::numeric(12, 2)
    into v_items, v_total
  from public.service_orders o
  join public.service_order_items i on i.company_id = o.company_id and i.order_id = o.id
  where o.company_id = v_session.company_id
    and o.service_session_id = v_session.id
    and o.status = 'submitted'
    and i.quantity - i.cancelled_quantity > 0;

  if v_items is null then
    raise exception 'Esta conta ainda não tem itens.' using errcode = 'PT409';
  end if;

  return public.enqueue_document_jobs(
    'customer_bill', v_session.company_id,
    public.print_session_header(v_session) || jsonb_build_object(
      'title', 'CONTA / PRÉ-CONTA',
      'items', v_items,
      'total', v_total,
      'printed_at', now(),
      'requested_by', jsonb_build_object('name', public.print_actor_name(v_session.company_id, auth.uid())),
      'footer', 'Documento não fiscal'
    ),
    v_session.id, null
  );
end;
$$;

-- Módulo operacional — fundação de PEDIDOS: produtos lançados dentro de um atendimento
-- (service_session) aberto. Só a ESTRUTURA de backend. Fora daqui, de propósito: catálogo
-- visual, cesta no frontend, tela de lançar pedido, impressão, KDS/status de produção,
-- cancelamento de item, transferência de comanda, fechamento, pagamento, desconto, adicional,
-- meio a meio, estoque e WhatsApp. Não altera nenhuma migration já aplicada: soma uma coluna
-- composta nova a service_sessions (ALTER TABLE) e um CREATE OR REPLACE que preserva assinatura
-- e ACL de company_user_has_activity (080000/020000).
--
--   1. service_sessions ganha unique (company_id, id): alvo da chave composta de service_orders
--      (o mesmo papel que products_company_id_id_key e service_points_company_id_id_key já
--      tinham para as tabelas que os referenciam; service_sessions ainda não precisava até agora).
--   2. service_orders: o pedido (o "envio" de um conjunto de itens dentro de um atendimento).
--   3. service_order_items: os itens do pedido, com NOME, PREÇO e SETOR EFETIVO congelados no
--      momento do envio (snapshot) — um pedido antigo nunca muda se o produto mudar depois.
--   4. submit_service_order(): RPC — cria o pedido E todos os itens em UMA transação (function
--      PL/pgSQL sem EXCEPTION interno: qualquer erro no meio desfaz tudo, igual a
--      create_service_points_batch). O preço, o nome e o setor NUNCA vêm do payload: o servidor
--      busca products/product_categories na hora do envio.
--   5. company_user_has_activity() passa a enxergar quem já enviou pedido (service_orders.created_by).
--
-- Multiempresa: toda linha tem company_id e as FKs de service_orders/service_order_items são
-- SEMPRE compostas (company_id, id), então nem uma escrita fora da RPC (service_role, SQL
-- direto) consegue ligar um pedido a atendimento, produto ou categoria de OUTRA empresa.
--
-- Quem pode o quê:
--   ler pedidos e itens da própria empresa   owner, admin, cashier, attendant (ativos) — mesma
--     regra simples de service_points/service_sessions: qualquer vínculo ativo lê tudo da
--     empresa; nenhuma distinção fina por papel nesta etapa.
--   enviar pedido (RPC)                      owner, admin, cashier, attendant (ativos)
--   escrever direto em pedidos/itens          ninguém pelo cliente: só a RPC (SECURITY DEFINER)
--   cancelar pedido                          FORA desta migration (etapa futura)
-- Sem DELETE físico em lugar nenhum: pedido enviado fica. Cancelamento (mudar status) é etapa futura.
--
-- Pedido (service_orders):
--   * origin: preparado para 'attendant' | 'cashier' | 'whatsapp', mas a RPC desta etapa só
--     produz 'attendant' ou 'cashier' — decidido pelo PAPEL de quem chama (nunca por um valor
--     enviado no payload). attendant chama -> 'attendant'; qualquer outro papel autorizado
--     (cashier, admin, owner) chama -> 'cashier' (solução simples e coerente: só attendant tem
--     área operacional própria hoje — Atendimento; os demais operam como o Caixa). 'whatsapp'
--     fica pronto para uma integração futura que não passa por esta RPC.
--   * status: só 'submitted' | 'cancelled' nesta etapa. Não existe 'draft' no banco: a cesta é
--     responsabilidade do frontend até o atendente confirmar "Enviar pedido"; o pedido só nasce
--     no banco já enviado. A RPC sempre grava 'submitted'; 'cancelled' fica pronto para a etapa
--     futura de cancelamento (cancelled_at consistente, sem RPC ainda para produzi-lo).
--   * created_by = auth.users(id) de quem enviou, com RESTRICT: o histórico não some com a
--     exclusão do usuário do Auth — por isso company_user_has_activity() passa a enxergar quem
--     já enviou pedido (não pode ser excluído fisicamente, só desativado).
--
-- Item do pedido (service_order_items):
--   * product_name_snapshot, unit_price e production_sector_id são SNAPSHOT: copiados de
--     products/product_categories no momento do envio, pela própria RPC (nunca pelo payload do
--     cliente) e nunca recalculados depois. Se o produto mudar de nome, preço ou setor amanhã,
--     o item já gravado permanece exatamente como foi vendido.
--   * production_sector_id = o SETOR EFETIVO do produto naquele instante (mesma regra do view
--     products_with_effective_sector, migration 040000): products.production_sector_id, senão
--     product_categories.default_production_sector_id, senão NULL. Guardado como snapshot (não
--     como FK "viva" cujo sentido mudaria se o setor padrão da categoria for trocado depois) —
--     por isso é nullable e não tem CHECK de "tem de bater com o efetivo atual": é histórico.
--     Uso futuro: roteamento Bar/Cozinha/Churrasqueira/Balcão, impressão e KDS.
--   * quantity: inteiro > 0 nesta primeira versão (sem fração, sem zero/negativo).
--   * unit_price numeric(12,2): mesmo formato de products.sale_price (reais com centavos).
--   * notes: observação opcional e curta do item ("Sem cebola", "Bem passado"), até 200
--     caracteres (mesmo limite de products.description).
--
-- Segurança do preço (CRÍTICO): a RPC NUNCA confia em unit_price/product_name_snapshot/
-- production_sector_id vindos do cliente — o payload aceito é só product_id, quantity e notes.
-- Preço, nome e setor são sempre lidos de products/product_categories DENTRO da RPC, com
-- SECURITY DEFINER, no momento do envio. Um payload manipulado não muda o que é cobrado.

-- ---------------------------------------------------------------------------
-- 1) service_sessions ganha o alvo de chave composta que service_orders vai usar.
-- ---------------------------------------------------------------------------
alter table public.service_sessions
  add constraint service_sessions_company_id_id_key unique (company_id, id);

-- ---------------------------------------------------------------------------
-- 2) Pedidos
-- ---------------------------------------------------------------------------
create table public.service_orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  service_session_id uuid not null,
  origin text not null
    constraint service_orders_origin_check check (origin in ('attendant', 'cashier', 'whatsapp')),
  status text not null default 'submitted'
    constraint service_orders_status_check check (status in ('submitted', 'cancelled')),
  -- Quem enviou. RESTRICT: o histórico não some com a exclusão do usuário do Auth.
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  submitted_at timestamptz not null default now(),
  cancelled_at timestamptz,
  constraint service_orders_cancelled_consistency check (
    (status = 'submitted' and cancelled_at is null) or (status = 'cancelled' and cancelled_at is not null)
  ),
  -- O atendimento tem de ser da MESMA empresa. NO ACTION (o padrão), e não RESTRICT, para que
  -- excluir uma empresa continue possível (a checagem roda depois que a cascata levou
  -- atendimentos e pedidos juntos).
  constraint service_orders_session_fkey
    foreign key (company_id, service_session_id)
    references public.service_sessions (company_id, id),
  -- alvo da chave composta de service_order_items
  constraint service_orders_company_id_id_key unique (company_id, id)
);

create index service_orders_session_idx on public.service_orders (company_id, service_session_id);
create index service_orders_created_by_idx on public.service_orders (created_by);

comment on table public.service_orders is
  'Pedido enviado dentro de um atendimento (service_session): o "confirmar Enviar pedido" do futuro fluxo do atendente. Sem draft no banco — nasce sempre submitted; a cesta é do frontend até a confirmação.';
comment on column public.service_orders.origin is
  'Quem originou o pedido: attendant, cashier (também usado por owner/admin) ou whatsapp (preparado para integração futura, não produzido por submit_service_order). Decidido pelo papel de quem chama a RPC, nunca pelo payload.';
comment on column public.service_orders.created_by is
  'auth.users.id de quem enviou o pedido. RESTRICT: quem já enviou não é excluído, só desativado (ver company_user_has_activity).';

-- Nascimento/identidade não mudam. Cancelamento (mudar status) é etapa futura: por ora nenhuma
-- policy/grant de UPDATE existe, então esta guarda só protege uma futura escrita interna.
create function public.guard_service_order_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is distinct from old.company_id
     or new.service_session_id is distinct from old.service_session_id
     or new.origin is distinct from old.origin
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.submitted_at is distinct from old.submitted_at then
    raise exception 'Os dados de origem de um pedido não podem ser alterados.'
      using errcode = 'PT409';
  end if;
  return new;
end;
$$;

create trigger service_orders_guard_change
  before update on public.service_orders
  for each row execute function public.guard_service_order_change();

revoke execute on function public.guard_service_order_change() from public, anon, authenticated;

alter table public.service_orders enable row level security;

create policy service_orders_select on public.service_orders
  for select to authenticated
  using (company_id in (select public.user_company_ids()));

-- Nenhuma policy nem grant de escrita: só a RPC abaixo cria pedidos.
revoke all on public.service_orders from anon, authenticated;
grant select on public.service_orders to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Itens do pedido
-- ---------------------------------------------------------------------------
create table public.service_order_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  order_id uuid not null,
  product_id uuid not null,
  -- Snapshot: nome do produto no momento do envio (não muda se o produto for renomeado depois).
  product_name_snapshot text not null
    constraint service_order_items_name_snapshot_length check (char_length(product_name_snapshot) between 1 and 120),
  quantity integer not null
    constraint service_order_items_quantity_check check (quantity > 0),
  -- Snapshot: preço no momento do envio, em reais com centavos (mesmo formato de products.sale_price).
  unit_price numeric(12, 2) not null
    constraint service_order_items_unit_price_check check (unit_price >= 0 and unit_price <> 'NaN'::numeric),
  -- Snapshot do setor EFETIVO no momento do envio (ver comentário do topo). NULL = produto sem
  -- setor efetivo naquele instante (nem próprio, nem herdado da categoria).
  production_sector_id uuid,
  notes text
    constraint service_order_items_notes_length check (notes is null or char_length(notes) between 1 and 200),
  created_at timestamptz not null default now(),
  -- O pedido tem de ser da MESMA empresa.
  constraint service_order_items_order_fkey
    foreign key (company_id, order_id)
    references public.service_orders (company_id, id),
  -- O produto tem de ser da MESMA empresa (não é possível um item apontar para produto de outra
  -- empresa mesmo por escrita direta fora da RPC).
  constraint service_order_items_product_fkey
    foreign key (company_id, product_id)
    references public.products (company_id, id),
  -- O setor (quando não nulo) tem de ser da MESMA empresa.
  constraint service_order_items_sector_fkey
    foreign key (company_id, production_sector_id)
    references public.production_sectors (company_id, id)
);

create index service_order_items_order_idx on public.service_order_items (company_id, order_id);
create index service_order_items_product_idx on public.service_order_items (company_id, product_id);
create index service_order_items_sector_idx
  on public.service_order_items (company_id, production_sector_id)
  where production_sector_id is not null;

comment on table public.service_order_items is
  'Itens de um service_order. product_name_snapshot, unit_price e production_sector_id são SNAPSHOT gravado por submit_service_order() no momento do envio — nunca recalculados depois, nunca vindos do payload do cliente.';
comment on column public.service_order_items.unit_price is
  'Preço no momento do envio (snapshot de products.sale_price). Sempre lido no servidor pela RPC; o cliente nunca envia preço.';
comment on column public.service_order_items.production_sector_id is
  'Setor efetivo do produto no momento do envio (snapshot: products.production_sector_id, senão product_categories.default_production_sector_id, senão NULL). Histórico: não é recalculado se o setor padrão da categoria mudar depois. Uso futuro: roteamento de produção/impressão/KDS.';

alter table public.service_order_items enable row level security;

create policy service_order_items_select on public.service_order_items
  for select to authenticated
  using (company_id in (select public.user_company_ids()));

-- Nenhuma policy nem grant de escrita: só a RPC abaixo cria itens.
revoke all on public.service_order_items from anon, authenticated;
grant select on public.service_order_items to authenticated;

-- ---------------------------------------------------------------------------
-- 4) RPC: enviar pedido (cria o pedido + todos os itens em UMA transação)
-- ---------------------------------------------------------------------------
-- p_items (jsonb, array): [{ "product_id": uuid, "quantity": inteiro > 0, "notes": texto? }, ...]
-- Só isso é aceito do cliente. Preço, nome e setor efetivo são sempre lidos de
-- products/product_categories aqui dentro, nunca do payload.
--
-- Erros: PT401 sem sessão, PT404 atendimento/produto não encontrado (também para quem não é
-- membro ativo da empresa do atendimento, ou produto de outra empresa — mesma ambiguidade
-- proposital de open_service_session/generate_service_point_ean13), PT403 sem permissão
-- (cashier/attendant/owner/admin inativos, ou papel sem acesso operacional), PT400 payload
-- inválido (sem itens, item sem produto, quantidade não inteira/positiva, observação longa
-- demais), PT409 atendimento não está aberto, produto inativo ou categoria do produto inativa.
--
-- Atomicidade: função PL/pgSQL sem bloco EXCEPTION interno — qualquer erro em QUALQUER item
-- propaga e desfaz a transação inteira (o pedido e todos os itens já inseridos nesta chamada),
-- igual a create_service_points_batch (060000). Nenhum pedido parcial fica salvo.
create function public.submit_service_order(
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
    );
  end loop;

  return v_order;
end;
$$;

comment on function public.submit_service_order(uuid, jsonb) is
  'RPC transacional: cria o pedido e todos os itens de UMA vez. Preço, nome e setor efetivo são sempre lidos de products/product_categories aqui dentro (nunca do payload). p_items aceita só product_id, quantity e notes.';

revoke execute on function public.submit_service_order(uuid, jsonb) from public, anon;
grant execute on function public.submit_service_order(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) Quem já enviou pedido não é excluído (só desativado)
-- ---------------------------------------------------------------------------
-- Mesma assinatura e mesmo ACL de 080000/020000 (CREATE OR REPLACE): soma a checagem de
-- service_orders à de service_sessions já existente.
create or replace function public.company_user_has_activity(p_company_id uuid, p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.service_sessions ss
    where ss.company_id = p_company_id and ss.opened_by = p_user_id
  ) then
    return true;
  end if;

  if exists (
    select 1 from public.service_orders so
    where so.company_id = p_company_id and so.created_by = p_user_id
  ) then
    return true;
  end if;

  -- FUTURO: caixa, pagamentos... (cada tabela operacional acrescenta a sua checagem AQUI e
  -- guarda a referência histórica do funcionário, sem apagar em cascata).
  return false;
end;
$$;

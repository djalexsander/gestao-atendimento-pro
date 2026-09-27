-- Módulo operacional — etapa 4: fundação do catálogo (setores de produção, categorias,
-- produtos e foto do produto).
--
-- Só a ESTRUTURA do banco. Fora daqui, de propósito: pedidos e itens de pedido, histórico
-- de preço, estoque, custo/ficha técnica, adicionais, variações, combos, impressoras,
-- cozinha/KDS, pagamento, tela do catálogo e o upload da foto no frontend.
--
--   1. production_sectors: setores de produção (BAR, COZINHA, CHURRASQUEIRA, BALCAO...).
--   2. product_categories: categorias (Bebidas, Porções, Espetos...), com setor padrão.
--   3. products: produtos, com setor próprio opcional e foto opcional (só o caminho).
--   4. products_with_effective_sector: view com o SETOR EFETIVO do produto.
--   5. Storage: bucket privado product-images e as policies por empresa.
--
-- Multiempresa: toda linha tem company_id e toda leitura passa por user_company_ids(),
-- que só devolve vínculos ATIVOS (funcionário inativo não vê nada). Os vínculos entre as
-- tabelas são compostos (company_id, id), então nem uma escrita fora das policies
-- (service_role, SQL direto) consegue ligar uma categoria, um produto ou um setor a
-- registros de OUTRA empresa.
--
-- Quem pode o quê:
--   ler setores, categorias e produtos
--       owner e admin: tudo da própria empresa, inclusive inativos;
--       cashier e attendant: só o catálogo OPERACIONAL, isto é, setores ativos, categorias
--       ativas e produtos ativos DE CATEGORIA ATIVA (desativar uma categoria tira os
--       produtos dela da venda, em qualquer consulta);
--   criar, editar e desativar   owner e admin (policies); cashier e attendant NUNCA
--   apagar                      ninguém: não há grant nem policy de DELETE (desativa-se)
--   fotos (Storage)
--       ver     qualquer membro ATIVO da empresa dona da pasta;
--       enviar, substituir e remover   owner e admin da empresa dona da pasta.
--
-- Comportamento comum às três tabelas:
--   * code: único na empresa, guardado em MAIÚSCULAS e sem espaços nas pontas pelo próprio
--     banco (bar = BAR); formato [A-Z0-9][A-Z0-9_-] até 32 caracteres, ASCII (BALCAO, não
--     BALCÃO: o nome com acento fica em name). Pode ser corrigido depois; ninguém referencia
--     o code, só o id.
--   * name: obrigatório, sem espaços nas pontas.
--   * company_id nunca muda.
--   * Nenhuma linha some: is_active = false tira do uso e preserva o histórico.
--
-- Setor EFETIVO do produto (regra do view products_with_effective_sector):
--   1. products.production_sector_id, se existir;
--   2. senão product_categories.default_production_sector_id;
--   3. senão NULL.
--   Ex.: categoria Bebidas → BAR; o produto Coca-Cola, sem setor próprio, herda BAR; um
--   produto especial com setor COZINHA sobrescreve. Só o id é resolvido (o setor pode
--   estar inativo; quem for rotear pedidos decide o que fazer com isso).
--
-- Preço: products.sale_price é o preço ATUAL. Não há histórico de preço nesta etapa. Quando
-- os pedidos existirem, o item do pedido COPIA o preço (e o setor efetivo) no momento do
-- lançamento; assim um pedido antigo não muda quando o preço do produto muda. Por isso o
-- catálogo não é apagado (só desativado) e products tem unique (company_id, id), alvo da
-- chave composta que o item de pedido vai usar.
--
-- Foto: o banco guarda SOMENTE products.image_path, nunca base64, blob ou URL assinada
-- (que expira). O arquivo mora no bucket privado product-images:
--     <company_id>/<product_id>/main.webp
-- A CHECK de image_path exige exatamente esse caminho, então nenhum produto aponta para
-- pasta de outra empresa. Ao lado do main.webp cabem outros arquivos da mesma pasta (ex.:
-- thumb.webp, a miniatura de ~300–400 px do catálogo): a policy aceita qualquer nome
-- simples dentro de <company_id>/<product_id>/. O bucket é privado, limita o arquivo a
-- 2 MiB e só aceita image/webp, o que segura imagem gigante; nada aqui impede o resto
-- do plano (compressão e miniatura no envio, lazy loading, cache do navegador/PWA,
-- placeholder quando image_path é NULL).
-- Arquivos do Storage só devem ser apagados pela API do Storage (apagar a linha de
-- storage.objects por SQL deixaria o arquivo órfão).

-- ---------------------------------------------------------------------------
-- 1) Setores de produção
-- ---------------------------------------------------------------------------
create table public.production_sectors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null
    constraint production_sectors_name_length check (char_length(name) between 1 and 60),
  code text not null
    constraint production_sectors_code_format check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint production_sectors_company_code_key unique (company_id, code),
  -- alvo das chaves compostas de product_categories e products
  constraint production_sectors_company_id_id_key unique (company_id, id)
);

comment on table public.production_sectors is
  'Setores de produção da empresa (BAR, COZINHA, CHURRASQUEIRA, BALCAO...). Para onde um item vai ser preparado; impressoras e KDS vêm depois.';

create function public.prepare_production_sector()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.code := upper(btrim(new.code));
  new.name := btrim(new.name);

  if tg_op = 'UPDATE' then
    if new.company_id is distinct from old.company_id then
      raise exception 'A empresa de um setor de produção não pode ser alterada.'
        using errcode = 'PT409';
    end if;

    -- Só recusa a desativação por vínculo ATIVO: categoria/produto inativo, ou nenhum uso, libera.
    if old.is_active and not new.is_active and (
      exists (
        select 1 from public.product_categories c
        where c.company_id = new.company_id
          and c.default_production_sector_id = new.id
          and c.is_active
      )
      or exists (
        select 1 from public.products p
        where p.company_id = new.company_id
          and p.production_sector_id = new.id
          and p.is_active
      )
    ) then
      raise exception 'Este setor está sendo usado por categorias ou produtos ativos. Remova ou altere esses vínculos antes de desativá-lo.'
        using errcode = 'PT409';
    end if;
  end if;

  return new;
end;
$$;

create trigger production_sectors_prepare
  before insert or update on public.production_sectors
  for each row execute function public.prepare_production_sector();

create trigger production_sectors_set_updated_at
  before update on public.production_sectors
  for each row execute function public.set_updated_at();

revoke execute on function public.prepare_production_sector() from public, anon, authenticated;

alter table public.production_sectors enable row level security;

-- Ler: owner e admin veem tudo da empresa; cashier e attendant, só os setores ativos.
create policy production_sectors_select on public.production_sectors
  for select to authenticated
  using (
    public.user_role_in_company(company_id) in ('owner', 'admin')
    or (company_id in (select public.user_company_ids()) and is_active)
  );

-- Criar e editar (o que inclui desativar): só owner e admin. Sem DELETE.
create policy production_sectors_insert on public.production_sectors
  for insert to authenticated
  with check (public.user_role_in_company(company_id) in ('owner', 'admin'));

create policy production_sectors_update on public.production_sectors
  for update to authenticated
  using (public.user_role_in_company(company_id) in ('owner', 'admin'))
  with check (public.user_role_in_company(company_id) in ('owner', 'admin'));

-- Colunas liberadas: id e timestamps ficam por conta dos defaults; company_id só entra na criação.
revoke all on public.production_sectors from anon, authenticated;
grant select on public.production_sectors to authenticated;
grant insert (company_id, name, code, is_active) on public.production_sectors to authenticated;
grant update (name, code, is_active) on public.production_sectors to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Categorias
-- ---------------------------------------------------------------------------
create table public.product_categories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null
    constraint product_categories_name_length check (char_length(name) between 1 and 60),
  code text not null
    constraint product_categories_code_format check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  -- Setor padrão dos produtos da categoria (Bebidas → BAR). NULL = a categoria não define.
  default_production_sector_id uuid,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_categories_company_code_key unique (company_id, code),
  -- alvo da chave composta de products
  constraint product_categories_company_id_id_key unique (company_id, id),
  -- O setor tem de ser da MESMA empresa. NO ACTION (o padrão), e não RESTRICT, para que
  -- excluir uma empresa continue possível: a checagem roda depois que a cascata levou
  -- setores, categorias e produtos juntos.
  constraint product_categories_default_sector_fkey
    foreign key (company_id, default_production_sector_id)
    references public.production_sectors (company_id, id)
);

create index product_categories_default_sector_idx
  on public.product_categories (company_id, default_production_sector_id)
  where default_production_sector_id is not null;

comment on table public.product_categories is
  'Categorias do catálogo (Bebidas, Porções, Espetos, Lanches...). Podem definir o setor de produção padrão dos seus produtos.';
comment on column public.product_categories.sort_order is
  'Ordem de exibição no catálogo (menor primeiro); empate desempata pelo nome na tela.';

create function public.prepare_product_category()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.code := upper(btrim(new.code));
  new.name := btrim(new.name);

  if tg_op = 'UPDATE' and new.company_id is distinct from old.company_id then
    raise exception 'A empresa de uma categoria não pode ser alterada.'
      using errcode = 'PT409';
  end if;

  return new;
end;
$$;

create trigger product_categories_prepare
  before insert or update on public.product_categories
  for each row execute function public.prepare_product_category();

create trigger product_categories_set_updated_at
  before update on public.product_categories
  for each row execute function public.set_updated_at();

revoke execute on function public.prepare_product_category() from public, anon, authenticated;

alter table public.product_categories enable row level security;

create policy product_categories_select on public.product_categories
  for select to authenticated
  using (
    public.user_role_in_company(company_id) in ('owner', 'admin')
    or (company_id in (select public.user_company_ids()) and is_active)
  );

create policy product_categories_insert on public.product_categories
  for insert to authenticated
  with check (public.user_role_in_company(company_id) in ('owner', 'admin'));

create policy product_categories_update on public.product_categories
  for update to authenticated
  using (public.user_role_in_company(company_id) in ('owner', 'admin'))
  with check (public.user_role_in_company(company_id) in ('owner', 'admin'));

revoke all on public.product_categories from anon, authenticated;
grant select on public.product_categories to authenticated;
grant insert (company_id, name, code, default_production_sector_id, sort_order, is_active)
  on public.product_categories to authenticated;
grant update (name, code, default_production_sector_id, sort_order, is_active)
  on public.product_categories to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Produtos
-- ---------------------------------------------------------------------------
create table public.products (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  category_id uuid not null,
  name text not null
    constraint products_name_length check (char_length(name) between 1 and 120),
  -- Descrição CURTA, a linha que aparece no card do catálogo. Vazio vira NULL.
  description text
    constraint products_description_length check (description is null or char_length(description) between 1 and 200),
  code text not null
    constraint products_code_format check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  barcode text
    constraint products_barcode_format check (barcode is null or barcode ~ '^[^[:space:]]{1,64}$'),
  -- Reais com centavos (18,00). NaN passaria em ">= 0" (para o numeric ele é maior que
  -- qualquer número), por isso é recusado à parte.
  sale_price numeric(12, 2) not null
    constraint products_sale_price_check check (sale_price >= 0 and sale_price <> 'NaN'::numeric),
  -- Setor próprio do produto; NULL = herda o padrão da categoria (setor efetivo, mais abaixo).
  production_sector_id uuid,
  -- Só o caminho no bucket product-images, nunca base64, blob nem URL assinada. NULL = sem foto.
  image_path text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_company_code_key unique (company_id, code),
  -- alvo da futura chave composta do item de pedido
  constraint products_company_id_id_key unique (company_id, id),
  -- Categoria e setor têm de ser da MESMA empresa (NO ACTION: ver product_categories).
  constraint products_category_fkey
    foreign key (company_id, category_id)
    references public.product_categories (company_id, id),
  constraint products_production_sector_fkey
    foreign key (company_id, production_sector_id)
    references public.production_sectors (company_id, id),
  -- A foto de um produto mora SEMPRE na pasta dele, dentro da pasta da empresa dele.
  constraint products_image_path_shape
    check (image_path is null or image_path = company_id::text || '/' || id::text || '/main.webp')
);

-- Barcode único na empresa, só quando preenchido (produtos sem barcode convivem).
create unique index products_company_barcode_key
  on public.products (company_id, barcode)
  where barcode is not null;

create index products_company_category_idx
  on public.products (company_id, category_id);

create index products_company_sector_idx
  on public.products (company_id, production_sector_id)
  where production_sector_id is not null;

comment on table public.products is
  'Produtos do catálogo. sale_price é o preço ATUAL: o item de pedido (futuro) copia o preço no lançamento.';
comment on column public.products.sale_price is
  'Preço de venda atual, em reais com centavos (o faturamento da plataforma usa centavos; aqui vale o formato 18,00).';
comment on column public.products.production_sector_id is
  'Setor de produção próprio do produto. NULL = herda default_production_sector_id da categoria (ver products_with_effective_sector).';
comment on column public.products.image_path is
  'Caminho da foto no bucket privado product-images: <company_id>/<product_id>/main.webp. Só o caminho, nunca base64, blob ou URL assinada. NULL = sem foto (a tela mostra um placeholder).';

-- Normaliza a entrada (code em maiúsculas, textos sem espaços nas pontas, descrição e barcode
-- vazios = NULL) e trava company_id. Roda ANTES das constraints, que enxergam o valor já
-- normalizado. (image_path é validado pela CHECK products_image_path_shape.)
create function public.prepare_product()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.code := upper(btrim(new.code));
  new.name := btrim(new.name);
  new.description := nullif(btrim(new.description), '');
  new.barcode := nullif(btrim(new.barcode), '');

  if tg_op = 'UPDATE' and new.company_id is distinct from old.company_id then
    raise exception 'A empresa de um produto não pode ser alterada.'
      using errcode = 'PT409';
  end if;

  return new;
end;
$$;

create trigger products_prepare
  before insert or update on public.products
  for each row execute function public.prepare_product();

create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

revoke execute on function public.prepare_product() from public, anon, authenticated;

alter table public.products enable row level security;

-- Ler: owner e admin veem tudo da empresa; cashier e attendant, só produtos ativos DE
-- CATEGORIA ATIVA (desativar a categoria tira os produtos dela da venda).
create policy products_select on public.products
  for select to authenticated
  using (
    public.user_role_in_company(company_id) in ('owner', 'admin')
    or (
      company_id in (select public.user_company_ids())
      and is_active
      and exists (
        select 1
        from public.product_categories c
        where c.company_id = products.company_id
          and c.id = products.category_id
          and c.is_active
      )
    )
  );

create policy products_insert on public.products
  for insert to authenticated
  with check (public.user_role_in_company(company_id) in ('owner', 'admin'));

create policy products_update on public.products
  for update to authenticated
  using (public.user_role_in_company(company_id) in ('owner', 'admin'))
  with check (public.user_role_in_company(company_id) in ('owner', 'admin'));

-- image_path fica fora do INSERT: o caminho carrega o id do produto, que só existe depois de
-- criado. Vai por UPDATE, depois do envio do arquivo.
revoke all on public.products from anon, authenticated;
grant select on public.products to authenticated;
grant insert (company_id, category_id, name, description, code, barcode, sale_price, production_sector_id, is_active)
  on public.products to authenticated;
grant update (category_id, name, description, code, barcode, sale_price, production_sector_id, image_path, is_active)
  on public.products to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Setor efetivo do produto
-- ---------------------------------------------------------------------------
-- Todas as colunas do produto + effective_production_sector_id
-- (= o setor do produto, senão o padrão da categoria, senão NULL). SECURITY INVOKER: quem vê
-- o quê continua sendo o RLS de quem consulta (attendant e cashier só recebem produtos ativos
-- de categoria ativa, da própria empresa).
create view public.products_with_effective_sector
  with (security_invoker = true)
as
select
  p.*,
  coalesce(p.production_sector_id, c.default_production_sector_id) as effective_production_sector_id
from public.products p
join public.product_categories c
  on c.company_id = p.company_id and c.id = p.category_id;

comment on view public.products_with_effective_sector is
  'Produtos + effective_production_sector_id: setor do produto, senão o padrão da categoria, senão NULL.';

revoke all on public.products_with_effective_sector from anon, authenticated;
grant select on public.products_with_effective_sector to authenticated;

-- ---------------------------------------------------------------------------
-- 5) Foto do produto: bucket e policies do Storage
-- ---------------------------------------------------------------------------
-- Bucket PRIVADO (nada de URL pública), 2 MiB por arquivo, só WebP. O ON CONFLICT reafirma
-- essas três configurações caso o bucket já exista.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', false, 2097152, array['image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- A empresa dona do arquivo, lida da PRIMEIRA pasta do caminho, ou NULL se o caminho não
-- tem o formato <company_id>/<product_id>/<arquivo> (dois UUIDs minúsculos e um nome simples
-- de arquivo). O cast só acontece depois de a regex garantir que é um UUID, então um caminho
-- estranho vira NULL (as policies negam) em vez de estourar erro. Só as policies abaixo usam,
-- mas o EXECUTE precisa ficar aberto a authenticated: a policy roda com os privilégios dele.
create function public.product_image_company_id(p_object_name text)
returns uuid
language sql
immutable
set search_path = public
as $$
  select case
    when p_object_name ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
      then split_part(p_object_name, '/', 1)::uuid
  end;
$$;

revoke execute on function public.product_image_company_id(text) from public, anon;
grant execute on function public.product_image_company_id(text) to authenticated;

-- Ver: qualquer membro ATIVO da empresa dona da pasta (user_company_ids() só devolve
-- vínculos ativos). Empresa A nunca enxerga a pasta da empresa B.
create policy product_images_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'product-images'
    and public.product_image_company_id(name) in (select public.user_company_ids())
  );

-- Enviar, substituir e remover: só owner e admin da empresa dona da pasta. Um caminho
-- fora do formato não tem empresa, então user_role_in_company() dá NULL e a policy nega.
create policy product_images_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'product-images'
    and public.user_role_in_company(public.product_image_company_id(name)) in ('owner', 'admin')
  );

create policy product_images_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'product-images'
    and public.user_role_in_company(public.product_image_company_id(name)) in ('owner', 'admin')
  )
  with check (
    bucket_id = 'product-images'
    and public.user_role_in_company(public.product_image_company_id(name)) in ('owner', 'admin')
  );

create policy product_images_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'product-images'
    and public.user_role_in_company(public.product_image_company_id(name)) in ('owner', 'admin')
  );

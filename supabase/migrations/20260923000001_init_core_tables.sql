-- Fundação: empresas (tenants), vínculo usuário/empresa, perfis, e infraestrutura de RLS.
-- Nenhuma outra tabela é criada aqui de propósito: catálogo, clientes, conversas e
-- orçamentos entram em migrations das etapas seguintes do roadmap.

-- ---------------------------------------------------------------------------
-- Utilitário compartilhado: mantém updated_at em dia em qualquer tabela que o use.
-- ---------------------------------------------------------------------------
create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- companies (tenant)
-- ---------------------------------------------------------------------------
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  document text,
  logo_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger companies_set_updated_at
  before update on public.companies
  for each row execute function public.set_updated_at();

alter table public.companies enable row level security;

-- ---------------------------------------------------------------------------
-- company_users (vínculo usuário <-> empresa, com papel)
-- ---------------------------------------------------------------------------
create type public.company_role as enum ('owner', 'admin', 'agent');

create table public.company_users (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.company_role not null default 'agent',
  created_at timestamptz not null default now(),
  unique (company_id, user_id)
);

create index company_users_user_id_idx on public.company_users(user_id);
create index company_users_company_id_idx on public.company_users(company_id);

alter table public.company_users enable row level security;

-- ---------------------------------------------------------------------------
-- profiles (dados extra do usuário, 1:1 com auth.users, não escopado por empresa)
-- ---------------------------------------------------------------------------
create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;

-- cria automaticamente um profile quando um usuário se cadastra no Supabase Auth
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Helper de RLS: empresas às quais o usuário autenticado pertence.
-- SECURITY DEFINER + search_path fixo evitam recursão de RLS e injeção de path.
-- ---------------------------------------------------------------------------
create function public.user_company_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select company_id
  from public.company_users
  where user_id = auth.uid();
$$;

create function public.user_role_in_company(p_company_id uuid)
returns public.company_role
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.company_users
  where company_id = p_company_id
    and user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- RPC de bootstrap: cria a empresa e o vínculo owner de forma atômica.
-- Roda como o dono da function (postgres), por isso não depende de grants de
-- INSERT em companies/company_users para o role authenticated.
-- ---------------------------------------------------------------------------
create function public.create_company(p_name text, p_slug text, p_document text default null)
returns public.companies
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company public.companies;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  insert into public.companies (name, slug, document)
  values (p_name, p_slug, p_document)
  returning * into v_company;

  insert into public.company_users (company_id, user_id, role)
  values (v_company.id, auth.uid(), 'owner');

  return v_company;
end;
$$;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------

-- companies: visível/editável só por quem pertence a ela; criação só via RPC acima.
create policy companies_select on public.companies
  for select to authenticated
  using (id in (select public.user_company_ids()));

create policy companies_update on public.companies
  for update to authenticated
  using (public.user_role_in_company(id) in ('owner', 'admin'))
  with check (public.user_role_in_company(id) in ('owner', 'admin'));

create policy companies_delete on public.companies
  for delete to authenticated
  using (public.user_role_in_company(id) = 'owner');

-- company_users: cada usuário vê os membros das empresas às quais pertence;
-- só owner/admin gerencia membros.
create policy company_users_select on public.company_users
  for select to authenticated
  using (company_id in (select public.user_company_ids()));

-- admin só pode adicionar novos membros como 'agent' (não pode criar outro
-- admin/owner); owner pode adicionar com qualquer papel.
create policy company_users_insert on public.company_users
  for insert to authenticated
  with check (
    public.user_role_in_company(company_id) = 'owner'
    or (public.user_role_in_company(company_id) = 'admin' and role = 'agent')
  );

-- admin só gerencia linhas de 'agent' (using = role atual da linha antes do update);
-- não pode tocar em linhas de 'owner'/'admin' (inclusive a própria) nem promover
-- ninguém acima de 'agent' (with check = role da linha depois do update). owner
-- tem controle total, sem essa restrição.
create policy company_users_update on public.company_users
  for update to authenticated
  using (
    public.user_role_in_company(company_id) = 'owner'
    or (public.user_role_in_company(company_id) = 'admin' and role = 'agent')
  )
  with check (
    public.user_role_in_company(company_id) = 'owner'
    or (public.user_role_in_company(company_id) = 'admin' and role = 'agent')
  );

create policy company_users_delete on public.company_users
  for delete to authenticated
  using (
    public.user_role_in_company(company_id) = 'owner'
    or (public.user_role_in_company(company_id) = 'admin' and role = 'agent')
  );

-- profiles: cada usuário só enxerga/edita o próprio perfil.
create policy profiles_select on public.profiles
  for select to authenticated
  using (user_id = auth.uid());

create policy profiles_update on public.profiles
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- GRANTs explícitos (nunca implícitos).
--
-- O Supabase concede privilégios por padrão (via ALTER DEFAULT PRIVILEGES) a
-- anon/authenticated em toda tabela nova do schema public, e o Postgres concede
-- EXECUTE em toda function nova a PUBLIC por padrão. Os REVOKEs abaixo removem
-- esses privilégios implícitos antes de conceder exatamente o necessário —
-- anon não recebe nenhum grant nas tabelas internas.
-- ---------------------------------------------------------------------------
revoke all on public.companies from anon, authenticated;
revoke all on public.company_users from anon, authenticated;
revoke all on public.profiles from anon, authenticated;

revoke execute on function public.set_updated_at() from public;
revoke execute on function public.handle_new_user() from public;
revoke execute on function public.user_company_ids() from public;
revoke execute on function public.user_role_in_company(uuid) from public;
revoke execute on function public.create_company(text, text, text) from public;

grant select, update, delete on public.companies to authenticated;
grant select, insert, update, delete on public.company_users to authenticated;
grant select, update on public.profiles to authenticated;

grant execute on function public.create_company(text, text, text) to authenticated;
grant execute on function public.user_company_ids() to authenticated;
grant execute on function public.user_role_in_company(uuid) to authenticated;

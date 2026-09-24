-- Fase 1 da estrutura comercial: CATÁLOGO COMERCIAL DO SaaS (planos e módulos
-- vendidos pelo OrçaFácil às empresas). Não tem relação com o futuro catálogo
-- de produtos/serviços de cada empresa.
--
-- Escopo desta migration: plans, plan_limits, modules, plan_modules + RPCs
-- Master de CRUD. Sem assinaturas, faturas, entitlements ou pagamentos.
--
-- Segurança: são dados da PLATAFORMA. authenticated/anon não recebem NENHUM
-- grant nas tabelas (nem SELECT). Toda leitura/escrita passa por RPCs
-- SECURITY DEFINER que reautenticam master_admin via assert_master_admin().
-- Não existe policy: RLS ativo + zero grants = negação total para clientes.
-- Preços em centavos (integer). Sem valores fixos: tudo é dado.

-- ---------------------------------------------------------------------------
-- plans
-- ---------------------------------------------------------------------------
create table public.plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  description text check (description is null or char_length(description) <= 500),
  monthly_price_cents integer not null check (monthly_price_cents >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger plans_set_updated_at
  before update on public.plans
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- plan_limits: limites/recursos por plano. limit_value NULL = ilimitado.
-- ---------------------------------------------------------------------------
create table public.plan_limits (
  plan_id uuid not null references public.plans(id) on delete cascade,
  limit_key text not null check (limit_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  limit_value integer check (limit_value is null or limit_value >= 0),
  primary key (plan_id, limit_key)
);

-- ---------------------------------------------------------------------------
-- modules: módulos opcionais. `code` é a futura chave de permissão no /app,
-- por isso é imutável depois de criado (a RPC de update não o altera).
-- ---------------------------------------------------------------------------
create table public.modules (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  description text check (description is null or char_length(description) <= 500),
  monthly_price_cents integer not null check (monthly_price_cents >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger modules_set_updated_at
  before update on public.modules
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- plan_modules: módulos já incluídos em um plano.
-- ---------------------------------------------------------------------------
create table public.plan_modules (
  plan_id uuid not null references public.plans(id) on delete cascade,
  module_id uuid not null references public.modules(id) on delete restrict,
  primary key (plan_id, module_id)
);

create index plan_modules_module_id_idx on public.plan_modules(module_id);

-- RLS ativo, sem policies e sem grants para clientes (explícito, sem confiar
-- nos default privileges do Supabase).
alter table public.plans enable row level security;
alter table public.plan_limits enable row level security;
alter table public.modules enable row level security;
alter table public.plan_modules enable row level security;

revoke all on public.plans from anon, authenticated;
revoke all on public.plan_limits from anon, authenticated;
revoke all on public.modules from anon, authenticated;
revoke all on public.plan_modules from anon, authenticated;

-- ---------------------------------------------------------------------------
-- RPCs Master (todas: SECURITY DEFINER porque as tabelas não são acessíveis
-- ao cliente; assert_master_admin() primeiro; search_path fixo; ACL explícita)
-- ---------------------------------------------------------------------------

create function public.master_list_plans()
returns table (
  id uuid,
  code text,
  name text,
  description text,
  monthly_price_cents integer,
  is_active boolean,
  created_at timestamptz,
  updated_at timestamptz,
  limits jsonb,
  module_ids uuid[]
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_master_admin();

  return query
  select
    p.id, p.code, p.name, p.description, p.monthly_price_cents,
    p.is_active, p.created_at, p.updated_at,
    coalesce(
      (select jsonb_object_agg(l.limit_key, l.limit_value)
       from public.plan_limits l where l.plan_id = p.id),
      '{}'::jsonb
    ),
    coalesce(
      (select array_agg(pm.module_id order by pm.module_id)
       from public.plan_modules pm where pm.plan_id = p.id),
      '{}'::uuid[]
    )
  from public.plans p
  order by p.created_at;
end;
$$;

create function public.master_list_modules()
returns table (
  id uuid,
  code text,
  name text,
  description text,
  monthly_price_cents integer,
  is_active boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_master_admin();

  return query
  select m.id, m.code, m.name, m.description, m.monthly_price_cents,
         m.is_active, m.created_at, m.updated_at
  from public.modules m
  order by m.created_at;
end;
$$;

-- p_id NULL = cria (p_code obrigatório); p_id preenchido = atualiza e IGNORA
-- p_code (o código não muda depois de criado).
create function public.master_upsert_plan(
  p_id uuid,
  p_code text,
  p_name text,
  p_description text,
  p_monthly_price_cents integer,
  p_is_active boolean
)
returns public.plans
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan public.plans;
begin
  perform public.assert_master_admin();

  if p_id is null then
    insert into public.plans (code, name, description, monthly_price_cents, is_active)
    values (btrim(p_code), btrim(p_name), nullif(btrim(p_description), ''),
            p_monthly_price_cents, coalesce(p_is_active, true))
    returning * into v_plan;
  else
    update public.plans
    set name = btrim(p_name),
        description = nullif(btrim(p_description), ''),
        monthly_price_cents = p_monthly_price_cents,
        is_active = coalesce(p_is_active, is_active)
    where id = p_id
    returning * into v_plan;

    if not found then
      raise exception 'plano não encontrado';
    end if;
  end if;

  return v_plan;
end;
$$;

create function public.master_upsert_module(
  p_id uuid,
  p_code text,
  p_name text,
  p_description text,
  p_monthly_price_cents integer,
  p_is_active boolean
)
returns public.modules
language plpgsql
security definer
set search_path = public
as $$
declare
  v_module public.modules;
begin
  perform public.assert_master_admin();

  if p_id is null then
    insert into public.modules (code, name, description, monthly_price_cents, is_active)
    values (btrim(p_code), btrim(p_name), nullif(btrim(p_description), ''),
            p_monthly_price_cents, coalesce(p_is_active, true))
    returning * into v_module;
  else
    update public.modules
    set name = btrim(p_name),
        description = nullif(btrim(p_description), ''),
        monthly_price_cents = p_monthly_price_cents,
        is_active = coalesce(p_is_active, is_active)
    where id = p_id
    returning * into v_module;

    if not found then
      raise exception 'módulo não encontrado';
    end if;
  end if;

  return v_module;
end;
$$;

-- Substitui TODOS os limites do plano. p_limits: objeto JSON
-- {"chave": número_inteiro_>=0 | null(ilimitado)}.
create function public.master_set_plan_limits(p_plan_id uuid, p_limits jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
  v_val jsonb;
begin
  perform public.assert_master_admin();

  if not exists (select 1 from public.plans where id = p_plan_id) then
    raise exception 'plano não encontrado';
  end if;

  if p_limits is null or jsonb_typeof(p_limits) <> 'object' then
    raise exception 'limits deve ser um objeto JSON';
  end if;

  for v_key, v_val in select * from jsonb_each(p_limits) loop
    if jsonb_typeof(v_val) not in ('number', 'null') then
      raise exception 'limite "%" inválido: use inteiro >= 0 ou null (ilimitado)', v_key;
    end if;
    if jsonb_typeof(v_val) = 'number' and v_val::text !~ '^[0-9]+$' then
      raise exception 'limite "%" inválido: use inteiro >= 0 ou null (ilimitado)', v_key;
    end if;
  end loop;

  delete from public.plan_limits where plan_id = p_plan_id;

  insert into public.plan_limits (plan_id, limit_key, limit_value)
  select p_plan_id, e.key,
         case when jsonb_typeof(e.value) = 'null' then null else (e.value::text)::integer end
  from jsonb_each(p_limits) e;
end;
$$;

-- Substitui TODOS os módulos incluídos no plano.
create function public.master_set_plan_modules(p_plan_id uuid, p_module_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_master_admin();

  if not exists (select 1 from public.plans where id = p_plan_id) then
    raise exception 'plano não encontrado';
  end if;

  if exists (
    select 1 from unnest(coalesce(p_module_ids, '{}'::uuid[])) mid
    where not exists (select 1 from public.modules m where m.id = mid)
  ) then
    raise exception 'módulo inexistente na lista';
  end if;

  delete from public.plan_modules where plan_id = p_plan_id;

  insert into public.plan_modules (plan_id, module_id)
  select distinct p_plan_id, mid from unnest(coalesce(p_module_ids, '{}'::uuid[])) mid;
end;
$$;

-- ---------------------------------------------------------------------------
-- ACL explícita (nunca depender só de default privileges): fora PUBLIC/anon,
-- só authenticated executa (a checagem real de master_admin é interna).
-- ---------------------------------------------------------------------------
revoke execute on function public.master_list_plans() from public, anon;
revoke execute on function public.master_list_modules() from public, anon;
revoke execute on function public.master_upsert_plan(uuid, text, text, text, integer, boolean) from public, anon;
revoke execute on function public.master_upsert_module(uuid, text, text, text, integer, boolean) from public, anon;
revoke execute on function public.master_set_plan_limits(uuid, jsonb) from public, anon;
revoke execute on function public.master_set_plan_modules(uuid, uuid[]) from public, anon;

grant execute on function public.master_list_plans() to authenticated;
grant execute on function public.master_list_modules() to authenticated;
grant execute on function public.master_upsert_plan(uuid, text, text, text, integer, boolean) to authenticated;
grant execute on function public.master_upsert_module(uuid, text, text, text, integer, boolean) to authenticated;
grant execute on function public.master_set_plan_limits(uuid, jsonb) to authenticated;
grant execute on function public.master_set_plan_modules(uuid, uuid[]) to authenticated;

-- Fundação do Painel Master: privilégio administrativo GLOBAL da plataforma,
-- deliberadamente separado de company_users. company_users representa
-- autorização DENTRO de uma empresa (owner/admin/agent); master_admin
-- representa autorização GLOBAL do SaaS, independente de qualquer empresa.
--
-- Nenhuma linha desta migration concede a master_admin bypass de RLS dentro
-- do fluxo normal de /app: ALEXPROAPPS (e qualquer outra empresa) continua
-- sujeita exatamente às mesmas policies de companies/company_users/etc. já
-- existentes. O acesso administrativo global só existe através das RPCs
-- explícitas abaixo, cada uma reautenticando master_admin internamente.

-- ---------------------------------------------------------------------------
-- platform_admins: allowlist de contas com privilégio global.
-- ---------------------------------------------------------------------------
create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

alter table public.platform_admins enable row level security;

-- Nenhuma policy é criada de propósito: authenticated/anon não recebem
-- NENHUM grant nesta tabela (revogado abaixo). Toda leitura/escrita passa só
-- por functions SECURITY DEFINER com seu próprio controle de acesso.
revoke all on public.platform_admins from anon, authenticated;

-- ---------------------------------------------------------------------------
-- is_master_admin(): qualquer usuário autenticado pode chamar, mas só
-- recebe informação sobre SI MESMO (auth.uid()), nunca sobre outra conta.
-- É a única verificação que o frontend usa para decidir mostrar o botão
-- "Painel Master" e proteger /master no cliente — a autoridade real continua
-- sendo a checagem repetida dentro de cada RPC administrativa abaixo.
-- ---------------------------------------------------------------------------
create function public.is_master_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.platform_admins where user_id = auth.uid()
  );
$$;

revoke execute on function public.is_master_admin() from public, anon;
grant execute on function public.is_master_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- assert_master_admin(): helper interno reutilizado por toda RPC
-- administrativa, para manter a checagem idêntica e auditável em um só
-- lugar. Nunca é exposta a nenhuma role de cliente (nem authenticated) — só
-- é chamável de dentro de outra function SECURITY DEFINER.
-- ---------------------------------------------------------------------------
create function public.assert_master_admin()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_master_admin() then
    raise exception 'acesso restrito a administradores da plataforma';
  end if;
end;
$$;

revoke execute on function public.assert_master_admin() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- master_get_overview(): indicadores agregados, nenhum dado individual.
-- "Empresas ativas" = empresas com pelo menos 1 membro em company_users —
-- não existe conceito de status/plano/assinatura no schema ainda, e não
-- inventamos um aqui; esta é a única definição de "ativa" já real hoje.
-- ---------------------------------------------------------------------------
create function public.master_get_overview()
returns table (
  total_companies bigint,
  total_users bigint,
  active_companies bigint
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
    (select count(*) from public.companies)::bigint,
    (select count(*) from auth.users)::bigint,
    (select count(distinct company_id) from public.company_users)::bigint;
end;
$$;

revoke execute on function public.master_get_overview() from public, anon;
grant execute on function public.master_get_overview() to authenticated;

-- ---------------------------------------------------------------------------
-- master_list_companies(): lista administrativa básica — só campos que já
-- existem de fato no schema (nome, documento, criação, nº de membros), sem
-- inventar status/plano/assinatura.
-- ---------------------------------------------------------------------------
create function public.master_list_companies()
returns table (
  id uuid,
  name text,
  document text,
  created_at timestamptz,
  member_count bigint
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
    c.id,
    c.name,
    c.document,
    c.created_at,
    count(cu.id)::bigint as member_count
  from public.companies c
  left join public.company_users cu on cu.company_id = c.id
  group by c.id, c.name, c.document, c.created_at
  order by c.created_at desc;
end;
$$;

revoke execute on function public.master_list_companies() from public, anon;
grant execute on function public.master_list_companies() to authenticated;

-- ---------------------------------------------------------------------------
-- Bootstrap: cadastra o proprietário atual do projeto como o primeiro
-- master_admin. Só nesta migration a linha é inserida diretamente (a
-- function é executada como postgres, que já bypassa RLS por ownership) —
-- ainda não existe uma RPC para promover novos master_admins; isso fica
-- para quando o Painel Master precisar disso de verdade.
-- ---------------------------------------------------------------------------
insert into public.platform_admins (user_id)
select id from auth.users where email = 'alexsander.xaviervieira@gmail.com'
on conflict (user_id) do nothing;

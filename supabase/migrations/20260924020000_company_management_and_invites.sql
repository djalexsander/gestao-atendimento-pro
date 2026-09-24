-- Etapa 2 (parte 2): gestão de empresa, equipe e convites.
--
-- Reaproveita companies/company_users/profiles e as functions/policies já
-- existentes (user_company_ids, user_role_in_company). Nenhuma tabela é
-- duplicada. Três mudanças de schema, cada uma com uma razão específica:
--
-- 1) profiles.email — a tela de Equipe precisa mostrar o e-mail dos membros.
--    O schema `auth` não é exposto ao role `authenticated` (por design do
--    Supabase), então não dá para consultar auth.users diretamente do
--    cliente. A solução é manter uma cópia do e-mail em `profiles`,
--    preenchida pelo trigger que já existe (handle_new_user) e mantida em
--    dia por um novo trigger em auth.users quando o e-mail mudar.
--
-- 2) Grants de UPDATE restritos por coluna em companies/profiles — hoje
--    `authenticated` tem UPDATE liberado em todas as colunas da linha (a
--    RLS já restringe QUAIS linhas, mas não QUAIS colunas). Isso permitiria
--    alterar `slug`, `id`, `created_at` etc. Trocamos por GRANT UPDATE em
--    uma lista explícita de colunas — o mesmo princípio de least privilege
--    já aplicado a `anon`/`authenticated`/functions nas migrations
--    anteriores, agora na granularidade de coluna.
--
-- 3) company_invites — para adicionar alguém à equipe por e-mail sem usar
--    service_role/Admin API no frontend (e sem dar a um admin/owner o poder
--    de inserir diretamente uma linha em company_users para um user_id
--    arbitrário). O convite fica pendente até a própria pessoa, autenticada
--    com o e-mail convidado, aceitar via RPC — o único jeito de uma conta
--    "de fora" ganhar acesso a uma empresa que ainda não é dela.

-- ---------------------------------------------------------------------------
-- 1) profiles.email
-- ---------------------------------------------------------------------------
alter table public.profiles add column email text;

update public.profiles set email = u.email
from auth.users u
where u.id = profiles.user_id and profiles.email is null;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, full_name, email)
  values (new.id, new.raw_user_meta_data ->> 'full_name', new.email);
  return new;
end;
$$;

create function public.handle_user_email_updated()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles set email = new.email where user_id = new.id;
  return new;
end;
$$;

create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row execute function public.handle_user_email_updated();

revoke execute on function public.handle_user_email_updated() from public, anon, authenticated;

-- Teammates podem ver o profile (nome/e-mail) uns dos outros; continua sem
-- expor profile de quem não compartilha nenhuma empresa com o usuário.
create policy profiles_select_teammates on public.profiles
  for select to authenticated
  using (
    exists (
      select 1
      from public.company_users cu
      where cu.user_id = profiles.user_id
        and cu.company_id in (select public.user_company_ids())
    )
  );

-- ---------------------------------------------------------------------------
-- 2) Grants de UPDATE restritos por coluna
-- ---------------------------------------------------------------------------
revoke update on public.companies from authenticated;
grant update (name, document) on public.companies to authenticated;

revoke update on public.profiles from authenticated;
grant update (full_name, avatar_url) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- 3) company_invites
-- ---------------------------------------------------------------------------
create table public.company_invites (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  -- cópia do nome no momento do convite: quem recebe o convite ainda não é
  -- membro, então a RLS de `companies` bloquearia um embed/join para mostrar
  -- o nome via companies.id diretamente.
  company_name text not null,
  email text not null,
  role public.company_role not null default 'agent',
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  invited_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz
);

create index company_invites_company_id_idx on public.company_invites(company_id);
create index company_invites_email_idx on public.company_invites(lower(email));

-- só uma invitação pendente por (empresa, e-mail) por vez.
create unique index company_invites_pending_unique
  on public.company_invites(company_id, lower(email))
  where status = 'pending';

alter table public.company_invites enable row level security;

-- owner/admin veem os convites da própria empresa.
create policy company_invites_select_by_company on public.company_invites
  for select to authenticated
  using (public.user_role_in_company(company_id) in ('owner', 'admin'));

-- a pessoa convidada vê o próprio convite pendente, mesmo sem ser membro
-- ainda (é exatamente o que permite ela decidir aceitar ou não).
create policy company_invites_select_own on public.company_invites
  for select to authenticated
  using (status = 'pending' and lower(email) = lower(auth.email()));

-- mesma hierarquia de company_users: admin só convida para 'agent'.
create policy company_invites_insert on public.company_invites
  for insert to authenticated
  with check (
    public.user_role_in_company(company_id) = 'owner'
    or (public.user_role_in_company(company_id) = 'admin' and role = 'agent')
  );

-- revogar convite (nunca DELETE — mantém histórico); mesma hierarquia.
create policy company_invites_update_by_company on public.company_invites
  for update to authenticated
  using (
    public.user_role_in_company(company_id) = 'owner'
    or (public.user_role_in_company(company_id) = 'admin' and role = 'agent')
  )
  with check (
    public.user_role_in_company(company_id) = 'owner'
    or (public.user_role_in_company(company_id) = 'admin' and role = 'agent')
  );

revoke all on public.company_invites from anon, authenticated;
grant select, insert on public.company_invites to authenticated;
grant update (status) on public.company_invites to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: criar convite. Não é SECURITY DEFINER — roda com os privilégios de
-- quem chama, então a policy de INSERT acima já é a barreira de segurança
-- real; a function só adiciona validações de negócio com mensagens claras.
-- ---------------------------------------------------------------------------
create function public.create_company_invite(
  p_company_id uuid,
  p_email text,
  p_role public.company_role default 'agent'
)
returns public.company_invites
language plpgsql
set search_path = public
as $$
declare
  v_email text := lower(trim(p_email));
  v_company_name text;
  v_invite public.company_invites;
begin
  if v_email = '' or v_email is null then
    raise exception 'e-mail inválido';
  end if;

  select name into v_company_name from public.companies where id = p_company_id;
  if v_company_name is null then
    raise exception 'empresa não encontrada';
  end if;

  if exists (
    select 1
    from public.company_users cu
    join public.profiles p on p.user_id = cu.user_id
    where cu.company_id = p_company_id and lower(p.email) = v_email
  ) then
    raise exception 'esse e-mail já pertence a um membro desta empresa';
  end if;

  insert into public.company_invites (company_id, company_name, email, role, invited_by)
  values (p_company_id, v_company_name, v_email, p_role, auth.uid())
  returning * into v_invite;

  return v_invite;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: aceitar convite. Precisa ser SECURITY DEFINER: quem aceita ainda não
-- é membro da empresa, então a policy normal de INSERT em company_users
-- (que exige já ser owner/admin daquela empresa) nunca liberaria essa
-- inserção — este é o único ponto do sistema em que uma conta "de fora"
-- ganha acesso, e só acontece se o e-mail da sessão bater com o convite.
-- ---------------------------------------------------------------------------
create function public.accept_company_invite(p_invite_id uuid)
returns public.company_users
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.company_invites;
  v_membership public.company_users;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_invite
  from public.company_invites
  where id = p_invite_id
  for update;

  if not found then
    raise exception 'convite não encontrado';
  end if;

  if v_invite.status <> 'pending' then
    raise exception 'convite já foi usado ou revogado';
  end if;

  if v_invite.expires_at < now() then
    raise exception 'convite expirado';
  end if;

  if lower(v_invite.email) <> lower(auth.email()) then
    raise exception 'este convite não pertence ao usuário autenticado';
  end if;

  insert into public.company_users (company_id, user_id, role)
  values (v_invite.company_id, auth.uid(), v_invite.role)
  on conflict (company_id, user_id) do nothing
  returning * into v_membership;

  update public.company_invites
  set status = 'accepted', accepted_at = now()
  where id = v_invite.id;

  if v_membership.company_id is null then
    select * into v_membership
    from public.company_users
    where company_id = v_invite.company_id and user_id = auth.uid();
  end if;

  return v_membership;
end;
$$;

-- O default privilege endurecido em 20260924010000 cobre anon/authenticated
-- nomeados, mas nesta base a criação da function ainda resultou em EXECUTE
-- para PUBLIC (confirmado via aclexplode() + Security Advisor). Por isso,
-- daqui em diante, todo REVOKE de EXECUTE é explícito por function, sem
-- depender só do default privilege.
revoke execute on function public.create_company_invite(uuid, text, public.company_role) from public, anon;
revoke execute on function public.accept_company_invite(uuid) from public, anon;

grant execute on function public.create_company_invite(uuid, text, public.company_role) to authenticated;
grant execute on function public.accept_company_invite(uuid) to authenticated;

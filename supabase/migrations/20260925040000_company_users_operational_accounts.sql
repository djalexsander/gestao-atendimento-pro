-- Funcionários e acesso — etapa 4: company_users preparada para contas operacionais.
--
-- Conta operacional = funcionário que entra com login + senha (código da empresa
-- + login), em vez de e-mail próprio. Por baixo continua sendo um usuário do
-- Supabase Auth; o que a distingue de uma conta normal é company_users.login
-- preenchido. Esta migration só prepara a ESTRUTURA — nada no banco lê essas
-- colunas ainda.
--
-- Colunas novas em public.company_users:
--   login                 text NULL    NULL = conta normal (por e-mail)
--   status                text         'active' | 'inactive', default 'active'
--   must_change_password  boolean      default false
--   created_by            uuid NULL    auth.users(id), ON DELETE SET NULL
--   updated_at            timestamptz  default now(); mantido pelo trigger
--                                      public.set_updated_at() que o projeto já
--                                      usa em companies e profiles
--
-- login (quando não NULL):
--   * fica guardado em minúsculas, mas o banco NÃO converte nada: a CHECK recusa
--     maiúsculas e qualquer formato fora do padrão;
--   * 3 a 32 caracteres, somente a-z, 0-9, underscore, hífen e ponto (sem
--     espaços); o ponto só separa grupos — não fica no início, no fim nem
--     repetido —, para o login continuar válido como local-part do e-mail
--     sintético;
--   * único dentro da empresa: (company_id, login).
--
-- Uma conta operacional pertence a UMA só empresa: índice único parcial em
-- user_id onde login não é NULL. Conta normal (login NULL) continua podendo ter
-- vínculo com várias empresas.
--
-- O owner é sempre conta normal por e-mail: role = 'owner' exige login NULL.
--
-- Linhas existentes: ganham status 'active' e must_change_password false; login
-- e created_by ficam NULL (nada é preenchido artificialmente — o owner da
-- ALEXPROAPPS segue owner / login NULL / active / must_change_password false).
-- updated_at das linhas existentes recebe o momento desta migration (o DEFAULT
-- now() vale também para elas).
--
-- FORA desta migration, de propósito: policies, grants, user_company_ids(),
-- user_role_in_company(), create_company, profiles, company_invites e RPCs do
-- Master. Consequência a fechar na etapa de RLS/grants: company_users mantém os
-- grants de tabela de hoje, então, dentro das policies atuais, o cliente
-- autenticado consegue gravar também as colunas novas.

alter table public.company_users
  add column login text,
  add column status text not null default 'active',
  add column must_change_password boolean not null default false,
  add column created_by uuid references auth.users(id) on delete set null,
  add column updated_at timestamptz not null default now();

comment on column public.company_users.login is
  'Login da conta operacional (funcionário sem e-mail próprio). NULL = conta normal por e-mail. 3 a 32 caracteres de a-z, 0-9, underscore, hífen e ponto (ponto nunca no início, no fim nem repetido), único na empresa; uma conta operacional pertence a uma só empresa; nunca em role owner.';

alter table public.company_users
  add constraint company_users_status_check
  check (status in ('active', 'inactive'));

-- Login: NULL (conta normal) ou 3 a 32 caracteres formados por grupos de
-- [a-z0-9_-] separados por UM ponto, isto é [a-z0-9_-]+(\.[a-z0-9_-]+)*. Assim o
-- ponto não fica no início, no fim nem repetido, e o login continua válido como
-- local-part do e-mail sintético. Maiúsculas, espaços, acentos, quebra de linha
-- e qualquer outro caractere também são recusados. O tamanho é checado à parte
-- (char_length) para o padrão ficar legível.
alter table public.company_users
  add constraint company_users_login_format
  check (
    login is null
    or (
      char_length(login) between 3 and 32
      and login ~ '^[a-z0-9_-]+(\.[a-z0-9_-]+)*$'
    )
  );

-- Owner nunca é conta operacional.
alter table public.company_users
  add constraint company_users_owner_no_login
  check (role <> 'owner' or login is null);

-- Login único dentro da empresa. Como o formato só admite minúsculas, igualdade
-- do texto já é igualdade sem diferenciar caixa.
create unique index company_users_company_login_unique
  on public.company_users (company_id, login)
  where login is not null;

-- Conta operacional em uma única empresa.
create unique index company_users_operational_user_unique
  on public.company_users (user_id)
  where login is not null;

create trigger company_users_set_updated_at
  before update on public.company_users
  for each row execute function public.set_updated_at();

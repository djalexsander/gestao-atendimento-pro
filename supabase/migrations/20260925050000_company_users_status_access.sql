-- Funcionários e acesso — etapa 5: status 'inactive' corta o acesso à empresa
-- e o cliente deixa de escrever em company_users.
--
-- Efeito buscado: um vínculo company_users com status diferente de 'active'
-- (hoje só 'inactive') perde NA HORA o acesso aos dados da empresa, mesmo com
-- JWT/sessão ainda válidos. Nada precisa ser invalidado no Auth: os helpers
-- abaixo leem company_users a cada chamada, e são eles que as policies usam.
--
-- ATENÇÃO — o item 4 tira do cliente a escrita direta em company_users. A tela
-- Equipe atual (alterar papel e Remover, via updateMemberRole/removeMember em
-- features/company/api.ts) usa essa escrita e deixa de funcionar quando esta
-- migration for aplicada; o convite por RPC continua. A gestão passa ao backend
-- (employee-admin, com service_role), etapa futura. Também: para um membro
-- inativo, o embed companies(*) que o AuthProvider faz a partir de company_users
-- volta com company nulo, porque a empresa dele deixa de ser visível.
--
-- 1) user_company_ids() e user_role_in_company(): só consideram vínculos com
--    status = 'active'. É uma regra de "só active": qualquer outro valor,
--    inclusive um status futuro, fica sem empresa e sem role. Conta inativa não
--    recebe empresa nem role válida (a role vem NULL, e as policies que
--    comparam role tratam NULL como falso). O status é do VÍNCULO: quem também é
--    membro ativo de outra empresa continua com essa outra.
--    Tudo que depende dos helpers herda a regra sem mudar: companies,
--    company_users (equipe), company_invites e, pela empresa de quem consulta, os
--    perfis de colegas (profiles_select_teammates).
--
-- 2) Revisão das policies que leem company_users direto. Além das próprias
--    company_users_*, só profiles_select_teammates lê a tabela; ela restringe a
--    empresa de quem consulta por user_company_ids(), então já herda a regra e
--    não precisa de ajuste. Nenhuma policy atual libera acesso a empresa sem
--    passar pelos helpers.
--
-- 3) Leitura do próprio vínculo (qualquer status): company_users_select_own.
--    Serve para o frontend distinguir "usuário sem empresa" de "funcionário
--    desativado". Não devolve acesso aos dados da empresa: companies e o resto
--    continuam passando pelos helpers; só a linha do próprio usuário fica
--    visível. A company_users_select (equipe da empresa) segue como está e só
--    enxerga empresas ativas do usuário.
--
-- 4) Escrita direta: INSERT, UPDATE e DELETE saem do role authenticated, tanto
--    nos privilégios quanto nas policies (sem grant e sem policy: nega dos dois
--    lados, e um grant reposto por engano não reabre nada). SELECT é mantido
--    (equipe da própria empresa + o próprio vínculo). Continuam funcionando, por
--    serem SECURITY DEFINER: create_company (grava o owner) e accept_company_invite.
--    service_role não é tocado.
--
-- FORA desta migration, de propósito: company_invites, create_company, profiles,
-- RPCs do Master, proteção do último owner e permissões por área.

-- ---------------------------------------------------------------------------
-- 1) Helpers: só vínculos ativos. CREATE OR REPLACE mantém o OID (as policies
--    que os usam passam a valer imediatamente) e o ACL, que é reafirmado abaixo.
-- ---------------------------------------------------------------------------
create or replace function public.user_company_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select company_id
  from public.company_users
  where user_id = auth.uid()
    and status = 'active';
$$;

create or replace function public.user_role_in_company(p_company_id uuid)
returns public.company_role
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.company_users
  where company_id = p_company_id
    and user_id = auth.uid()
    and status = 'active';
$$;

revoke execute on function public.user_company_ids() from public, anon, authenticated;
revoke execute on function public.user_role_in_company(uuid) from public, anon, authenticated;
grant execute on function public.user_company_ids() to authenticated;
grant execute on function public.user_role_in_company(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Leitura do próprio vínculo, mesmo inativo.
-- ---------------------------------------------------------------------------
create policy company_users_select_own on public.company_users
  for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 4) Sem escrita direta do cliente em company_users.
-- ---------------------------------------------------------------------------
drop policy company_users_insert on public.company_users;
drop policy company_users_update on public.company_users;
drop policy company_users_delete on public.company_users;

revoke insert, update, delete on public.company_users from authenticated;

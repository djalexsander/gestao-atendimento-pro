-- Hardening de permissões das functions criadas em 20260923000001_init_core_tables.sql.
--
-- Achado (confirmado via aclexplode() no banco remoto e pelo Security Advisor do
-- Supabase): as 5 functions daquela migration receberam EXECUTE automático para
-- anon/authenticated/service_role, porque o schema public já tinha, antes da nossa
-- primeira migration, uma ALTER DEFAULT PRIVILEGES (definida pela própria plataforma
-- Supabase, para objetos criados pelo role `postgres`) concedendo EXECUTE em toda
-- function nova a anon/authenticated/service_role diretamente — um grant nomeado,
-- não o pseudo-role PUBLIC. Por isso o `revoke execute ... from public` daquela
-- migration não teve efeito nenhum sobre anon/authenticated: eles nunca tiveram o
-- privilégio via PUBLIC, e sim via essa default privilege nomeada.
--
-- Esta migration não cria, remove nem altera tabelas, policies ou triggers — só
-- ACLs de function e a configuração de search_path/default privileges.

-- ---------------------------------------------------------------------------
-- 1) search_path explícito e seguro.
--    Das 5 functions, só set_updated_at ficou sem SET search_path na migration
--    original (não precisava por não ser SECURITY DEFINER, mas fixamos por boa
--    prática e porque o Security Advisor sinalizou "function_search_path_mutable").
-- ---------------------------------------------------------------------------
alter function public.set_updated_at() set search_path = public;

-- ---------------------------------------------------------------------------
-- 2) Revoga EXECUTE de anon/authenticated (e de PUBLIC, por segurança/idempotência,
--    ainda que hoje elas não tenham grant via PUBLIC) nas 5 functions existentes.
--    service_role NÃO é tocado: é o role de uso interno do Supabase/Edge Functions
--    e precisa continuar com acesso.
-- ---------------------------------------------------------------------------
revoke execute on function public.create_company(text, text, text) from public, anon, authenticated;
revoke execute on function public.user_company_ids() from public, anon, authenticated;
revoke execute on function public.user_role_in_company(uuid) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) Concede de volta, de forma explícita, só o que cada role realmente precisa.
--
--    authenticated: chama create_company() como RPC, e user_company_ids()/
--    user_role_in_company() são usadas dentro das próprias policies de RLS quando
--    o cliente autenticado executa uma query normal nas tabelas.
--
--    handle_new_user() e set_updated_at() são disparadas somente via trigger
--    (auth.users e before-update das tabelas). A execução de uma trigger function
--    não depende da role que originou o evento ter EXECUTE nela — o Postgres a
--    invoca com os privilégios do dono da function/tabela — então nenhuma role de
--    cliente (anon/authenticated) recebe EXECUTE nelas.
-- ---------------------------------------------------------------------------
grant execute on function public.create_company(text, text, text) to authenticated;
grant execute on function public.user_company_ids() to authenticated;
grant execute on function public.user_role_in_company(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) DEFAULT PRIVILEGES: impede que FUTURAS functions criadas pelo nosso fluxo de
--    migrations (que sempre rodam como o role `postgres`) herdem automaticamente
--    EXECUTE para anon/authenticated — a mesma causa raiz do problema corrigido
--    acima. Escopo deliberadamente mínimo:
--      - só o role `postgres` (o único que cria objetos via nossas migrations);
--      - só o schema `public`;
--      - só o tipo FUNCTIONS (não mexe em tabelas/sequências aqui);
--      - não toca em service_role (mantém acesso interno do Supabase).
--    A partir de agora, toda function nova precisa de um GRANT EXECUTE explícito
--    na própria migration que a cria — já é a prática que vínhamos seguindo.
-- ---------------------------------------------------------------------------
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;

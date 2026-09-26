-- Funcionários e acesso — etapa 10: suporte ao login operacional (código da empresa +
-- login + PIN/senha).
--
-- 1) company_access_code_exists(): a tela 1 do login do funcionário precisa saber se o
--    código da empresa existe ANTES de qualquer login, então a RPC é pública (anon).
--    Responde só true/false: não devolve nome, id nem nenhum dado da empresa, e a
--    tabela companies continua sem leitura para anon. O código não é segredo (o login
--    ainda exige login + PIN/senha), mas a RPC permite descobrir se um código existe;
--    o limite de requisições do Supabase é a única contenção. Por isso o retorno é
--    mínimo e igual para qualquer entrada que não case (formato inválido = false).
--
-- 2) Conta de funcionário (conta gerenciada) nunca cria empresa. Um funcionário logado
--    é um usuário autenticado como qualquer outro e poderia chamar create_company pela
--    API; o trigger recusa o INSERT em companies quando quem chama é uma conta
--    gerenciada (vínculo com login preenchido ou app_metadata.managed = true). Fica num
--    trigger, e não dentro de create_company, para valer também para qualquer outro
--    caminho de INSERT feito por um usuário. service_role e SQL direto (sem auth.uid())
--    passam. A tela também esconde o onboarding dessas contas (accessRules.ts).

-- ---------------------------------------------------------------------------
-- 1) Código da empresa existe? (público, só sim/não)
-- ---------------------------------------------------------------------------
create function public.company_access_code_exists(p_access_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.companies c
    where c.access_code = lower(btrim(coalesce(p_access_code, '')))
  );
$$;

revoke execute on function public.company_access_code_exists(text) from public;
grant execute on function public.company_access_code_exists(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) Conta gerenciada não cria empresa
-- ---------------------------------------------------------------------------
create function public.prevent_managed_account_company_creation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and (
    exists (
      select 1 from public.company_users cu
      where cu.user_id = auth.uid() and cu.login is not null
    )
    or exists (
      select 1 from auth.users u
      where u.id = auth.uid() and coalesce(u.raw_app_meta_data ->> 'managed', '') = 'true'
    )
  ) then
    raise exception 'Contas de funcionário não podem criar empresas.' using errcode = 'PT403';
  end if;
  return new;
end;
$$;

create trigger companies_managed_account_guard
  before insert on public.companies
  for each row execute function public.prevent_managed_account_company_creation();

revoke execute on function public.prevent_managed_account_company_creation() from public, anon, authenticated;

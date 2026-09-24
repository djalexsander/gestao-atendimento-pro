-- Correção conceitual: "empresas ativas" não existe como conceito real ainda
-- (não há status comercial/assinatura no schema). O overview passa a retornar
-- somente total de empresas e total de usuários.
--
-- Mudar as colunas de retorno exige DROP + CREATE (CREATE OR REPLACE não
-- permite alterar o tipo de retorno), então as ACLs são refeitas de forma
-- explícita, sem depender de default privileges.

drop function public.master_get_overview();

create function public.master_get_overview()
returns table (
  total_companies bigint,
  total_users bigint
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
    (select count(*) from auth.users)::bigint;
end;
$$;

revoke execute on function public.master_get_overview() from public, anon;
grant execute on function public.master_get_overview() to authenticated;

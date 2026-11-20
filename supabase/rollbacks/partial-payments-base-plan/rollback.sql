-- Reverte 20261216010000_partial_payments_base_plan.sql: company_has_module volta a depender só do entitlement (override comercial).
create or replace function public.company_has_module(p_company_id uuid, p_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((public.company_entitlement(p_company_id) -> 'modules') ? p_code, false);
$$;
drop function public.partial_payments_enabled(uuid);

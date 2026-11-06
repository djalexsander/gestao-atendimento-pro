-- ORDEM DE USO (1116): Desfaça DEPOIS de 1117 e ANTES de 1115. Rode DENTRO de uma transação (begin; … commit;). Veja LEIAME.md desta pasta.
-- Rollback manual da migration 20261116010000 (cortesias, Etapa 2A): devolve company_entitlement e company_access_state ao corpo
-- anterior (20261028010000 / 20261006020000). Não altera dados. As tabelas de cortesia (1115) não são tocadas aqui.
-- ATENÇÃO: rodar apenas depois de desfazer 1117–1120 (eles dependem do invólucro company_entitlement). Cortesias abertas deixam de conceder acesso.
drop function if exists public.company_entitlement(uuid);
alter function public.company_entitlement_pre_courtesy(uuid) rename to company_entitlement;

create or replace function public.company_access_state(p_company_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_status text;
  v_trial text;
begin
  select s.status into v_status from public.subscriptions s
   where s.company_id = p_company_id and s.status <> 'canceled' limit 1;
  if found then
    return case v_status when 'trialing' then 'active' else v_status end;
  end if;

  select public.trial_effective_state(t.status, t.trial_ends_at) into v_trial
    from public.company_trials t where t.company_id = p_company_id;
  if v_trial = 'trialing' then
    return 'trial';
  end if;
  if exists (select 1 from public.subscriptions s where s.company_id = p_company_id) then
    return 'canceled';
  end if;
  if v_trial = 'expired' then return 'trial_expired'; end if;
  if v_trial = 'canceled' then return 'trial_canceled'; end if;
  return 'unmanaged';
end;
$$;

drop function if exists public.courtesy_open_plan(uuid);

-- ORDEM DE USO (1121): desfaça DEPOIS de 1122 e ANTES de 1120 (ordem inversa completa: 1122 → 1121 → 1120 → 1119 → 1118 → 1117 → 1116 → 1115). Rode DENTRO de uma transação (begin; … commit;). Veja LEIAME.md desta pasta.
-- Rollback manual da migration 20261121010000 (cortesias, F1 — preservação derivada em pending_payment). Restaura company_write_blocked e
-- company_entitlement ao corpo da 20261119010000 e remove os dois helpers. Não altera dados.
-- ATENÇÃO: empresas em pending_payment de OUTRO plano com cortesia de plano aberta voltam a ter a escrita bloqueada e a perder os módulos da cortesia imediatamente.
create or replace function public.company_write_blocked(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select s.state in ('pending_payment', 'restricted', 'suspended', 'trial_expired', 'trial_canceled', 'canceled')
         and not (s.state = 'pending_payment' and public.courtesy_bridge_active(p_company_id))
    from (select public.company_access_state(p_company_id) as state) s;
$$;

create or replace function public.company_entitlement(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_base jsonb;
  v_bridge jsonb;
  v_plan boolean;
  v_live boolean;
  v_mods text[];
  v_plan_mods text[] := '{}';
  v_over text[];
  v_keys text[];
  v_result jsonb;
begin
  v_base := public.company_entitlement_pre_courtesy(p_company_id);

  -- PONTE (conversão de cortesia de plano): pending_payment sem módulos vira "o que a empresa já tinha", SEM os extras ainda não pagos
  v_bridge := public.courtesy_bridge_info(p_company_id);
  if v_bridge is not null then
    select coalesce(array_agg(m.code order by m.code), '{}') into v_plan_mods
      from public.subscription_modules sm join public.modules m on m.id = sm.module_id
     where sm.subscription_id = (v_bridge ->> 'subscription_id')::uuid and sm.source = 'plan' and sm.removed_at is null and m.is_active;
    select coalesce(array_agg(c.module_code order by c.module_code), '{}') into v_mods
      from public.company_courtesies c
     where c.company_id = p_company_id and c.scope = 'module' and c.status in ('active', 'expired_pending_decision');
    select coalesce(array_agg(o.module_code order by o.module_code), '{}') into v_over
      from public.company_module_overrides o
     where o.company_id = p_company_id and (o.expires_at is null or o.expires_at > public.business_now());
    return jsonb_build_object(
      'mode', 'payment_bridge',
      'modules', (select coalesce(jsonb_agg(m order by m), '[]'::jsonb)
                    from (select distinct m from unnest(v_plan_mods || v_mods || v_over) as m) u),
      'bridge_until', v_bridge -> 'bridge_until',
      'courtesies', to_jsonb(coalesce(array(select 'module:' || x from unnest(v_mods) x), '{}'::text[])),
      'overrides', to_jsonb(v_over));
  end if;

  select coalesce(bool_or(c.scope = 'plan'), false),
         coalesce(array_agg(c.module_code order by c.module_code) filter (where c.scope = 'module'), '{}')
    into v_plan, v_mods
    from public.company_courtesies c
   where c.company_id = p_company_id and c.status in ('active', 'expired_pending_decision');

  v_live := exists (select 1 from public.subscriptions s where s.company_id = p_company_id and s.status <> 'canceled');
  v_plan := v_plan and not v_live;

  if not v_plan and cardinality(v_mods) = 0 then
    return v_base;
  end if;

  if public.company_write_blocked(p_company_id) then
    return v_base;
  end if;

  if v_plan then
    select coalesce(array_agg(distinct m.code order by m.code), '{}') into v_plan_mods
      from public.company_courtesies c
      join public.plan_modules pm on pm.plan_id = c.plan_id
      join public.modules m on m.id = pm.module_id
     where c.company_id = p_company_id and c.scope = 'plan' and c.status in ('active', 'expired_pending_decision') and m.is_active;
  end if;

  v_keys := case when v_plan then array['plan'] else '{}'::text[] end
            || coalesce(array(select 'module:' || x from unnest(v_mods) x), '{}');

  v_result := jsonb_set(
    v_base, '{modules}',
    (select coalesce(jsonb_agg(m order by m), '[]'::jsonb)
       from (select distinct m
               from unnest(array(select jsonb_array_elements_text(v_base -> 'modules')) || v_mods || v_plan_mods) as m) u))
    || jsonb_build_object('courtesies', to_jsonb(v_keys));

  if public.company_access_state(p_company_id) = 'courtesy' then
    v_result := v_result || jsonb_build_object('mode', 'courtesy');
  end if;
  return v_result;
end;
$$;

drop function if exists public.courtesy_preserved_active(uuid);
drop function if exists public.courtesy_preserved_info(uuid);

-- Cortesias — F1 (Etapa 5C-1): preservação DERIVADA dos direitos da cortesia de plano durante a contratação pendente de OUTRO plano.
--
-- PROBLEMA (auditoria 5B): com cortesia aberta do plano A, o Master contrata o plano B. A assinatura nasce em pending_payment e a empresa perde TUDO
-- (escrita bloqueada, sem os módulos da cortesia), por tempo indefinido, mesmo sem ter recebido nada do plano B.
--
-- REGRA (exceção ESTREITA; nada é gravado, tudo é derivado):
--   Vale quando, para a empresa, TODAS as condições abaixo são verdadeiras:
--     1. a assinatura vigente está em pending_payment (nunca restricted, suspended, past_due, grace, canceled, trial);
--     2. existe cortesia de PLANO aberta (active ou expired_pending_decision) de plano DIFERENTE do plano da assinatura;
--     3. não há ponte de acesso ativa (a ponte da 2C — conversão do MESMO plano — tem prioridade e segue intacta).
--   Efeito: company_write_blocked = false e company_entitlement = mode 'courtesy_pending_payment' com SÓ os direitos da cortesia:
--     módulos do plano em cortesia (plan_modules ativos) + cortesias de módulo abertas + overrides ativos (precedente da ponte 2C).
--   Nunca inclui módulos do plano novo nem extras ainda não pagos. company_access_state continua 'pending_payment'.
--
-- EXCEÇÃO À REGRA GERAL "pending_payment nunca recebe override" (20261014110000): vale SOMENTE dentro da janela acima, isto é, com cortesia de plano
-- aberta de outro plano. pending_payment comum (sem essa cortesia) continua SEM overrides e SEM cortesia de módulo (regra 4 da 20261116010000 intacta).
--
-- FIM DA JANELA (retorno às regras normais, sem escrita): pagamento da fatura inicial (vira active), cancelamento da assinatura pendente
-- (volta o estado 'courtesy' normal), encerramento manual da cortesia (ended) ou qualquer outro estado bloqueado (restricted/suspended).
-- Sem prazo adicional automático: dura enquanto a cortesia estiver aberta (inclui expired_pending_decision).
--
-- NÃO ALTERA: faturas, fatura inicial, cobrança, Pix, Asaas, webhook, ativação (pending_payment -> active exige a inicial paga), ponte, cron.
-- Aditiva e reversível: supabase/rollbacks/courtesies/20261121010000_courtesy_preserved_access.rollback.sql.

create function public.courtesy_preserved_info(p_company_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('courtesy_id', c.id, 'courtesy_plan_id', c.plan_id, 'subscription_id', s.id, 'subscription_plan_id', s.plan_id)
    from public.subscriptions s
    join public.company_courtesies c
      on c.company_id = s.company_id and c.scope = 'plan' and c.status in ('active', 'expired_pending_decision')
     and c.plan_id is distinct from s.plan_id
   where s.company_id = p_company_id
     and s.status = 'pending_payment'
     and not public.courtesy_bridge_active(p_company_id)
   limit 1;
$$;

create function public.courtesy_preserved_active(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.courtesy_preserved_info(p_company_id) is not null;
$$;

revoke execute on function public.courtesy_preserved_info(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.courtesy_preserved_active(uuid) from public, anon, authenticated, service_role;

-- Barreira de escrita: corpo vigente da 20261119010000 + a exceção F1
create or replace function public.company_write_blocked(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select s.state in ('pending_payment', 'restricted', 'suspended', 'trial_expired', 'trial_canceled', 'canceled')
         and not (s.state = 'pending_payment'
                  and (public.courtesy_bridge_active(p_company_id) or public.courtesy_preserved_active(p_company_id)))
    from (select public.company_access_state(p_company_id) as state) s;
$$;

-- Entitlement: corpo vigente da 20261119010000 + o ramo F1 (depois da ponte)
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
  v_pres jsonb;
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

  -- F1 (5C-1): contratação de OUTRO plano em pending_payment com cortesia de plano aberta. Preserva SOMENTE os direitos da cortesia
  -- (módulos do plano em cortesia + cortesias de módulo abertas + overrides ativos). NUNCA os módulos/extras da assinatura nova. A ponte tem prioridade.
  v_pres := public.courtesy_preserved_info(p_company_id);
  if v_pres is not null then
    select coalesce(array_agg(distinct m.code order by m.code), '{}') into v_plan_mods
      from public.plan_modules pm
      join public.modules m on m.id = pm.module_id
     where pm.plan_id = (v_pres ->> 'courtesy_plan_id')::uuid and m.is_active;
    select coalesce(array_agg(c.module_code order by c.module_code), '{}') into v_mods
      from public.company_courtesies c
     where c.company_id = p_company_id and c.scope = 'module' and c.status in ('active', 'expired_pending_decision');
    select coalesce(array_agg(o.module_code order by o.module_code), '{}') into v_over
      from public.company_module_overrides o
     where o.company_id = p_company_id and (o.expires_at is null or o.expires_at > public.business_now());
    return jsonb_build_object(
      'mode', 'courtesy_pending_payment',
      'modules', (select coalesce(jsonb_agg(m order by m), '[]'::jsonb)
                    from (select distinct m from unnest(v_plan_mods || v_mods || v_over) as m) u),
      'courtesies', to_jsonb(array['plan'] || coalesce(array(select 'module:' || x from unnest(v_mods) x), '{}'::text[])),
      'overrides', to_jsonb(v_over),
      'preserved_plan_id', v_pres -> 'courtesy_plan_id',
      'pending_plan_id', v_pres -> 'subscription_plan_id');
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

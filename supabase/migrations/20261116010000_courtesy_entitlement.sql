-- CORTESIAS COMERCIAIS — Etapa 2A: integração com o ENTITLEMENT e com o ESTADO DE ACESSO. ADITIVA e local.
--
-- NÃO altera: faturamento, invoices, Asaas, cron, frontend, company_write_blocked, guard_company_writable, company_module_overrides
-- nem nenhuma outra função. O corpo vigente de company_entitlement (assinatura/trial/legado/overrides, 20261028010000) é PRESERVADO
-- como company_entitlement_pre_courtesy (ALTER ... RENAME mantém dono, ACL e definição); company_entitlement vira um invólucro que
-- só ACRESCENTA o que a cortesia concede. Empresa sem cortesia aberta recebe EXATAMENTE o mesmo resultado de antes.
--
-- AUDITORIA que motivou o desenho (estado de acesso -> escrita; company_write_blocked é lista fixa de estados):
--   bloqueados para escrita: pending_payment, restricted, suspended, trial_expired, trial_canceled, canceled.
--   liberados: active, past_due, grace, trial, unmanaged.
--   guard_company_writable (triggers de ~20 tabelas) consulta company_write_blocked(company_access_state(...)). Logo um CLIENTE NOVO
--   (trial vencido/cancelado, ou sem assinatura vigente) com cortesia de plano continuaria SOMENTE LEITURA e sem módulos: o risco
--   tratado aqui. A correção é feita no ESTADO (company_access_state), único ponto lido pela barreira; company_write_blocked e
--   guard_company_writable ficam intactos.
--
-- REGRAS
--  1) Cortesia de MÓDULO (status active OU expired_pending_decision) concede o módulo, inclusive whatsapp/ia e módulos inativos
--     (como o override). A dependência de segurança da IA continua nos gates existentes: whatsapp_ai_allowed/whatsapp_assert_ai_reader
--     exigem whatsapp E ia; cortesia de 'ia' sozinha não executa nada.
--  2) Cortesia de PLANO BASE (aberta) concede os módulos ATIVOS incluídos no plano (plan_modules vigente do catálogo) e, quando a
--     empresa NÃO tem assinatura vigente e estaria bloqueada por fim/cancelamento de trial ou por assinatura cancelada, muda o ESTADO
--     para 'courtesy' (escrita liberada): acesso operacional sem Pix nem cartão.
--  3) Aberta = active ou expired_pending_decision: o vencimento NÃO retira acesso; só o encerramento manual (ended). ended e
--     converted não concedem nada.
--  4) Cortesia NUNCA reativa assinatura bloqueada: com pending_payment, restricted, suspended (e nos estados já bloqueados que não
--     sejam o "sem assinatura vigente" acima) a cortesia de módulo é ignorada e a de plano não muda o estado. Só trial_expired,
--     trial_canceled e canceled (nenhum contrato vivo para sobrescrever) viram 'courtesy' — e SÓ por cortesia de PLANO.
--  5) Estado 'courtesy' é novo para o frontend atual, que o trata como desconhecido (chip neutro, sem banner); tenant_get_access_state
--     devolve write_blocked=false. Ajuste visual fica para etapa de frontend.
--  6) Overrides existentes seguem soberanos e independentes (aplicados antes, dentro de company_entitlement_pre_courtesy).

-- ---------------------------------------------------------------------------
-- 1) Helper: a empresa tem cortesia de PLANO base aberta?
-- ---------------------------------------------------------------------------
create function public.courtesy_open_plan(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.company_courtesies c
     where c.company_id = p_company_id and c.scope = 'plan' and c.status in ('active', 'expired_pending_decision'));
$$;

revoke execute on function public.courtesy_open_plan(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) Estado de acesso: idêntico ao vigente + 'courtesy' (corpo original em 20261006020000)
-- ---------------------------------------------------------------------------
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
  v_none text;
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

  -- sem assinatura vigente e sem trial em andamento: qual seria o estado bloqueado?
  if exists (select 1 from public.subscriptions s where s.company_id = p_company_id) then
    v_none := 'canceled';
  elsif v_trial = 'expired' then
    v_none := 'trial_expired';
  elsif v_trial = 'canceled' then
    v_none := 'trial_canceled';
  else
    return 'unmanaged';
  end if;

  -- cortesia de PLANO aberta: acesso operacional sem contrato (nenhum contrato vivo é sobrescrito)
  if public.courtesy_open_plan(p_company_id) then
    return 'courtesy';
  end if;
  return v_none;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Entitlement: corpo vigente preservado + invólucro de cortesia
-- ---------------------------------------------------------------------------
alter function public.company_entitlement(uuid) rename to company_entitlement_pre_courtesy;

create function public.company_entitlement(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_base jsonb;
  v_plan boolean;
  v_mods text[];
  v_plan_mods text[] := '{}';
  v_keys text[];
  v_result jsonb;
begin
  v_base := public.company_entitlement_pre_courtesy(p_company_id);

  select coalesce(bool_or(c.scope = 'plan'), false),
         coalesce(array_agg(c.module_code order by c.module_code) filter (where c.scope = 'module'), '{}')
    into v_plan, v_mods
    from public.company_courtesies c
   where c.company_id = p_company_id and c.status in ('active', 'expired_pending_decision');

  if not v_plan and cardinality(v_mods) = 0 then
    return v_base;
  end if;

  -- Cortesia não reativa contrato bloqueado (pending_payment, restricted, suspended) nem libera módulo em estado de somente leitura.
  -- O estado 'courtesy' (só cortesia de plano, sem contrato vivo) NÃO é bloqueado.
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

-- Mesma ACL da original: só o dono (as demais funções DEFINER a chamam).
revoke execute on function public.company_entitlement(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.company_entitlement_pre_courtesy(uuid) from public, anon, authenticated, service_role;

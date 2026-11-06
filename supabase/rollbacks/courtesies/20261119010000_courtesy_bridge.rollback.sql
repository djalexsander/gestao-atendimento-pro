-- ORDEM DE USO (1119): Desfaça DEPOIS de 1120 e ANTES de 1118. Rode DENTRO de uma transação (begin; … commit;). Veja LEIAME.md desta pasta.
-- Rollback manual da migration 20261119010000 (cortesias, Etapa 2C - ponte de acesso). Restaura company_write_blocked, company_entitlement,
-- courtesy_finalize_conversion, master_convert_courtesy e a guarda da cortesia (1006/1118) e remove a ponte. Não altera faturas, assinaturas,
-- preços nem cortesias. ATENÇÃO: apaga o registro das pontes; assinaturas pending_payment voltam a bloquear a escrita imediatamente.
drop function if exists public.master_list_courtesy_bridges(boolean);
drop function if exists public.master_get_courtesy_bridge(uuid);
create or replace function public.company_write_blocked(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.company_access_state(p_company_id) in
    ('pending_payment', 'restricted', 'suspended', 'trial_expired', 'trial_canceled', 'canceled');
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
  v_plan boolean;
  v_live boolean;
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

  -- cortesia de plano só vale para a empresa SEM assinatura vigente (com assinatura, de qualquer plano, não amplia o entitlement)
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
create or replace function public.courtesy_finalize_conversion(p_company_id uuid, p_plan_id uuid, p_subscription_id uuid, p_start_competence date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c public.company_courtesies;
begin
  -- a assinatura (nova) já existe: ordem assinatura -> cortesia
  select * into v_c from public.company_courtesies c
   where c.company_id = p_company_id and c.scope = 'plan' and c.plan_id = p_plan_id
     and c.status in ('active', 'expired_pending_decision') and c.conversion_authorized_at is not null
   for update;
  if not found then
    return;
  end if;
  update public.company_courtesies
     set status = 'converted', closed_at = public.business_now(), closed_by = auth.uid(),
         close_note = 'contratação paga do plano (conversão autorizada)',
         billing_starts_competence = p_start_competence, converted_subscription_id = p_subscription_id
   where id = v_c.id;
  perform public.courtesy_record_event(v_c.id, 'converted', jsonb_build_object(
    'via', 'subscribe', 'subscription_id', p_subscription_id, 'billing_starts_competence', p_start_competence,
    'previous_state', public.courtesy_effective_state(v_c.status, v_c.ends_at)), null);
end;
$$;
drop function if exists public.master_convert_courtesy(uuid, text, date, uuid, integer);
create function public.master_convert_courtesy(
  p_courtesy_id uuid,
  p_note text,
  p_billing_starts date default null,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_c public.company_courtesies;
  v_note text;
  v_win jsonb;
  v_bs date;
  v_sm public.subscription_modules;
  v_prev text;
begin
  perform public.assert_master_admin();
  v_note := public.courtesy_check_reason(p_note);

  select company_id into v_company from public.company_courtesies where id = p_courtesy_id;
  if not found then
    raise exception 'cortesia não encontrada';
  end if;
  perform 1 from public.companies where id = v_company for no key update;
  select * into v_c from public.company_courtesies where id = p_courtesy_id for update;

  if p_request_id is not null and exists (
       select 1 from public.company_courtesy_events e where e.courtesy_id = p_courtesy_id and e.request_id = p_request_id) then
    return jsonb_build_object('courtesy', public.courtesy_json(v_c), 'changed', false, 'replayed', true);
  end if;
  if v_c.status = 'converted' then
    return jsonb_build_object('courtesy', public.courtesy_json(v_c), 'changed', false, 'replayed', false);
  end if;
  if v_c.status = 'ended' then
    raise exception 'cortesia encerrada não pode ser convertida';
  end if;

  v_win := public.courtesy_billing_window(v_c.company_id);
  v_prev := public.courtesy_effective_state(v_c.status, v_c.ends_at);

  if v_c.scope = 'plan' and v_win is null then
    -- SEM assinatura: apenas AUTORIZA. Não contrata, não fecha, não muda o acesso (a contratação é manual, pelo Master).
    if p_billing_starts is not null then
      raise exception 'sem assinatura vigente não há início de cobrança a definir: a conversão apenas autoriza a contratação paga do plano';
    end if;
    if v_c.conversion_authorized_at is not null then
      return jsonb_build_object('courtesy', public.courtesy_json(v_c), 'changed', false, 'replayed', false, 'converted', false, 'authorized', true);
    end if;
    update public.company_courtesies
       set conversion_authorized_at = public.business_now(), conversion_authorized_by = auth.uid()
     where id = v_c.id returning * into v_c;
    perform public.courtesy_record_event(v_c.id, 'conversion_authorized', jsonb_build_object(
      'state', v_prev, 'note', v_note, 'effect', 'access_preserved_until_master_contracts'), p_request_id);
    return jsonb_build_object('courtesy', public.courtesy_json(v_c), 'changed', true, 'replayed', false, 'converted', false, 'authorized', true,
                              'next_step', 'master_subscribe_company');
  end if;

  if v_win is null then
    raise exception 'a empresa não tem assinatura vigente: contrate o plano antes de converter o módulo (a conversão não cria contratação)';
  end if;

  if v_c.scope = 'plan' then
    if (v_win ->> 'plan_id')::uuid <> v_c.plan_id then
      raise exception 'a assinatura atual é de outro plano: esta cortesia não a isenta; encerre a cortesia';
    end if;
    if v_win ->> 'status' = 'pending_payment' then
      raise exception 'pague a cobrança inicial da assinatura antes de converter';
    end if;
    v_bs := public.courtesy_resolve_billing_start(v_win, p_billing_starts);
  else
    -- MÓDULO: não ativa módulo pago, não gera Pix. O extra tem de existir na assinatura (alterar módulos pelo Master).
    if v_win ->> 'status' not in ('active', 'grace', 'past_due') then
      raise exception 'a assinatura não está em estado que aceite a conversão do módulo';
    end if;
    select sm.* into v_sm from public.subscription_modules sm join public.modules m on m.id = sm.module_id
     where sm.subscription_id = (v_win ->> 'subscription_id')::uuid and m.code = v_c.module_code and sm.removed_at is null;
    if not found then
      raise exception 'adicione primeiro o módulo à assinatura (alterar módulos pelo Master); a conversão não ativa módulo pago nem gera cobrança';
    end if;
    if v_sm.source <> 'extra' then
      raise exception 'o módulo já está incluído no plano da assinatura: encerre a cortesia';
    end if;
    v_bs := public.courtesy_resolve_billing_start(v_win, p_billing_starts);
    if v_sm.effective_from_competence > v_bs then
      raise exception 'o módulo só passa a ser cobrado a partir de %: escolha um início igual ou posterior', v_sm.effective_from_competence;
    end if;
  end if;

  update public.company_courtesies
     set status = 'converted', closed_at = public.business_now(), closed_by = auth.uid(), close_note = v_note,
         billing_starts_competence = v_bs, converted_subscription_id = (v_win ->> 'subscription_id')::uuid
   where id = v_c.id returning * into v_c;

  perform public.courtesy_record_event(v_c.id, 'converted', jsonb_build_object(
    'previous_state', v_prev, 'billing_starts_competence', v_bs, 'subscription_id', v_win ->> 'subscription_id',
    'scope', v_c.scope, 'note', v_note), p_request_id);

  return jsonb_build_object('courtesy', public.courtesy_json(v_c), 'changed', true, 'replayed', false, 'converted', true,
                            'billing_starts_competence', v_bs);
end;
$$;
revoke execute on function public.master_convert_courtesy(uuid, text, date, uuid) from public, anon;
grant execute on function public.master_convert_courtesy(uuid, text, date, uuid) to authenticated;
create or replace function public.guard_company_courtesy_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'cortesia não pode ser apagada (histórico comercial)';
  end if;

  if new.company_id is distinct from old.company_id or new.scope is distinct from old.scope
     or new.plan_id is distinct from old.plan_id or new.module_code is distinct from old.module_code
     or new.starts_at is distinct from old.starts_at or new.reference_price_cents is distinct from old.reference_price_cents
     or new.reason is distinct from old.reason or new.created_by is distinct from old.created_by
     or new.request_id is distinct from old.request_id or new.created_at is distinct from old.created_at then
    raise exception 'cortesia: dados da concessão são imutáveis';
  end if;

  if old.status in ('ended', 'converted') then
    raise exception 'cortesia encerrada/convertida é definitiva e não pode ser alterada';
  end if;

  -- início da cobrança futura e vínculo com a assinatura convertida: só no ato de encerrar/converter
  if (new.billing_starts_competence is distinct from old.billing_starts_competence
      or new.converted_subscription_id is distinct from old.converted_subscription_id)
     and new.status not in ('ended', 'converted') then
    raise exception 'o início da cobrança só é definido no encerramento ou na conversão';
  end if;
  -- autorização de conversão: uma vez dada, é imutável
  if old.conversion_authorized_at is not null
     and (new.conversion_authorized_at is distinct from old.conversion_authorized_at
          or new.conversion_authorized_by is distinct from old.conversion_authorized_by) then
    raise exception 'a autorização de conversão é imutável';
  end if;

  if new.status = 'expired_pending_decision' then
    if new.ends_at is distinct from old.ends_at or new.ends_at > public.business_now() then
      raise exception 'cortesia só passa a aguardar decisão depois de vencida';
    end if;
  elsif new.status = 'active' then
    if new.ends_at < old.ends_at or (old.status = 'expired_pending_decision' and
        (new.ends_at <= old.ends_at or new.ends_at <= public.business_now())) then
      raise exception 'cortesia só pode ser prorrogada para uma data futura e posterior à atual';
    end if;
  end if;
  return new;
end;
$$;
drop function if exists public.courtesy_bridge_json(public.courtesy_access_bridges);
drop function if exists public.courtesy_bridge_active(uuid);
drop function if exists public.courtesy_bridge_info(uuid);
drop table if exists public.courtesy_access_bridges;
drop function if exists public.prevent_courtesy_access_bridge_change();
alter table public.company_courtesies drop column conversion_bridge_hours;

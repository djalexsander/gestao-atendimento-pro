-- ORDEM DE USO (1118): Desfaça DEPOIS de 1119 e ANTES de 1117. Rode DENTRO de uma transação (begin; … commit;). Veja LEIAME.md desta pasta.
-- Rollback manual da migration 20261118010000 (cortesias, Etapa 2B-2). Restaura as funções anteriores (1115/1116/1117), remove as colunas
-- novas e os helpers. Não altera faturas, preços, dívida nem contratos. ATENÇÃO: perde autorização de conversão, início de cobrança e vínculo
-- de conversão registrados; cortesias 'converted' voltam a valer pela regra antiga de closed_at.
do $rb$
declare
  v_def text;
  v_new text;
begin
  -- contratação: remove a barreira e o fechamento atômico
  for v_def in select pg_get_functiondef(p.oid) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('master_subscribe_company', 'billing_subscribe_company') loop
    v_new := regexp_replace(v_def, chr(10) || '  perform public[.]courtesy_contract_guard[(][^' || chr(10) || ']*[)];', '');
    v_new := regexp_replace(v_new, '  perform public[.]courtesy_finalize_conversion[(][^' || chr(10) || ']*[)];' || chr(10), '');
    execute v_new;
  end loop;
  -- adição de módulo: remove o bloqueio de cortesia
  select pg_get_functiondef(p.oid) into v_def from pg_proc p where p.proname = 'billing_module_change_plan' and p.pronamespace = 'public'::regnamespace;
  v_new := regexp_replace(v_def, '  if v_blocked is null and jsonb_array_length[(]v_added[)] > 0 then.*?  end if;' || chr(10) || chr(10) || '  return v_plan', '  return v_plan', 's');
  v_new := replace(v_new, '  v_cw text;' || chr(10), '');
  execute v_new;
  -- geração: remove o vínculo ao plano
  select pg_get_functiondef(p.oid) into v_def from pg_proc p where p.proname = 'generate_subscription_invoice' and p.pronamespace = 'public'::regnamespace;
  execute replace(v_def, 'c.scope = ''plan'' and c.plan_id = v_terms.plan_id and public.courtesy_covers', 'c.scope = ''plan'' and public.courtesy_covers');
end
$rb$;

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

drop function if exists public.master_convert_courtesy(uuid, text, date, uuid);
drop function if exists public.master_end_courtesy(uuid, text, uuid, date);
create function public.master_end_courtesy(p_courtesy_id uuid, p_reason text, p_request_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_c public.company_courtesies;
  v_note text;
  v_prev text;
  v_replay boolean;
begin
  perform public.assert_master_admin();
  v_note := public.courtesy_check_reason(p_reason);

  select company_id into v_company from public.company_courtesies where id = p_courtesy_id;
  if not found then
    raise exception 'cortesia não encontrada';
  end if;
  perform 1 from public.companies where id = v_company for no key update;
  select * into v_c from public.company_courtesies where id = p_courtesy_id for update;

  v_replay := p_request_id is not null and exists (
    select 1 from public.company_courtesy_events e where e.courtesy_id = p_courtesy_id and e.request_id = p_request_id);
  if v_replay or v_c.status = 'ended' then
    return jsonb_build_object('courtesy', public.courtesy_json(v_c), 'changed', false, 'replayed', v_replay);
  end if;
  if v_c.status = 'converted' then
    raise exception 'cortesia já convertida não pode ser encerrada';
  end if;

  v_prev := public.courtesy_effective_state(v_c.status, v_c.ends_at);
  update public.company_courtesies
     set status = 'ended', closed_at = public.business_now(), closed_by = auth.uid(), close_note = v_note
   where id = v_c.id returning * into v_c;

  perform public.courtesy_record_event(v_c.id, 'ended', jsonb_build_object(
    'previous_state', v_prev, 'ends_at', v_c.ends_at, 'had_conversion_request', v_c.conversion_requested_at is not null, 'reason', v_note), p_request_id);

  return jsonb_build_object('courtesy', public.courtesy_json(v_c), 'changed', true, 'replayed', false);
end;
$$;
revoke execute on function public.master_end_courtesy(uuid, text, uuid) from public, anon;
grant execute on function public.master_end_courtesy(uuid, text, uuid) to authenticated;

create or replace function public.courtesy_covers(p_c public.company_courtesies, p_competence date)
returns boolean
language sql
stable
set search_path = public
as $$
  select public.competence_of(p_c.starts_at) <= p_competence
     and (p_c.closed_at is null
          or p_c.closed_at >= ((p_competence + interval '1 month')::timestamp at time zone 'America/Sao_Paulo'));
$$;
create or replace function public.courtesy_json(p_c public.company_courtesies)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'id', p_c.id, 'company_id', p_c.company_id, 'scope', p_c.scope, 'plan_id', p_c.plan_id, 'module_code', p_c.module_code,
    'item_key', p_c.item_key, 'status', p_c.status,
    'effective_state', public.courtesy_effective_state(p_c.status, p_c.ends_at),
    'starts_at', p_c.starts_at, 'ends_at', p_c.ends_at,
    'days_remaining', case when p_c.status in ('ended', 'converted') then null
                           else ceil(extract(epoch from (p_c.ends_at - public.business_now())) / 86400.0)::integer end,
    'reference_price_cents', p_c.reference_price_cents, 'reason', p_c.reason,
    'created_by', p_c.created_by, 'created_at', p_c.created_at,
    'conversion_requested_at', p_c.conversion_requested_at, 'conversion_requested_by', p_c.conversion_requested_by,
    'conversion_note', p_c.conversion_note,
    'closed_at', p_c.closed_at, 'closed_by', p_c.closed_by, 'close_note', p_c.close_note);
$$;
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

drop function if exists public.courtesy_contract_guard(uuid, uuid, uuid[], boolean);
drop function if exists public.courtesy_finalize_conversion(uuid, uuid, uuid, date);
drop function if exists public.courtesy_resolve_billing_start(jsonb, date);
drop function if exists public.courtesy_billing_window(uuid);

alter table public.company_courtesy_events drop constraint company_courtesy_events_event_type_check;
alter table public.company_courtesy_events add constraint company_courtesy_events_event_type_check
  check (event_type in ('granted', 'extended', 'ended', 'expired', 'conversion_requested')) not valid;   -- eventos já gravados (append-only) permanecem
-- Se NÃO há eventos dos tipos novos (conversion_authorized/converted), valida a constraint e o schema volta idêntico; se há, ela fica NOT VALID de propósito (a tabela é append-only).
do $rb$
begin
  if not exists (select 1 from public.company_courtesy_events where event_type not in ('granted', 'extended', 'ended', 'expired', 'conversion_requested')) then
    alter table public.company_courtesy_events validate constraint company_courtesy_events_event_type_check;
  end if;
end
$rb$;
alter table public.company_courtesies
  drop column billing_starts_competence, drop column conversion_authorized_at, drop column conversion_authorized_by, drop column converted_subscription_id;

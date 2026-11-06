-- CORTESIAS COMERCIAIS — Etapa 2B-2 (Modelo B): vínculo ao plano, início explícito da cobrança futura, conversão controlada pelo Master e
-- bloqueio de contratação/adição paga sobre item em cortesia. ADITIVA e LOCAL. Não toca em frontend, cron, Edge Functions do Asaas,
-- faturas existentes, dívida, preços de referência nem em company_module_overrides.
--
-- MODELO B: a cortesia de plano NUNCA cria assinatura, fatura inicial, Pix ou pending_payment. Contratar (pago) o MESMO plano que está em
-- cortesia aberta exige conversão explícita do Master; outro plano segue o fluxo normal e a cortesia não o isenta.
--
-- REGRAS
--  1) Vínculo: a cortesia de plano só isenta mensalidade de assinatura do MESMO plan_id (versão contratual da competência). Sem
--     assinatura vigente concede os módulos do plano da cortesia; com assinatura (de qualquer plano) NÃO amplia o entitlement.
--  2) billing_starts_competence = primeira competência cobrável após a cortesia. Gravada no encerramento/conversão. Padrão:
--     max(primeira competência ainda não decidida, mês corrente + 1) -> nada retroativo, nenhuma cobrança surpresa na competência
--     corrente, competências já decididas e faturas emitidas intactas. O Master pode escolher data posterior; nunca anterior à
--     primeira competência ainda cobrável (max(cursor, mês corrente)). Sem assinatura vigente não há o que iniciar (fica nulo).
--  3) Conversão (master_convert_courtesy):
--       * PLANO sem assinatura: SÓ AUTORIZA (conversion_authorized_*). Não cria contratação, não fecha a cortesia: o acesso é mantido
--         até o Master contratar. A contratação paga do mesmo plano (master_subscribe_company) só é aceita com autorização e fecha a
--         cortesia (converted, vinculada à nova assinatura) NA MESMA TRANSAÇÃO; a contratação pelo próprio cliente (tenant_subscribe)
--         é sempre recusada enquanto a cortesia estiver aberta.
--       * PLANO com assinatura do mesmo plano: encerra como converted e a cobrança segue o contrato a partir de billing_starts.
--       * MÓDULO: não ativa módulo pago nem gera Pix. Exige que o Master já tenha adicionado o módulo como EXTRA da assinatura
--         (fluxo existente, sem cobrança proporcional); só então marca converted, com início de cobrança a partir da competência
--         em que o extra passa a valer. Enquanto a cortesia estiver aberta o extra é isento (2B). A conversão que exigisse Pix
--         proporcional ou novo fluxo NÃO foi implementada.
--  4) Adição paga de módulo (imediata ou agendada) pelo cliente é bloqueada se o módulo tem cortesia aberta (blocked_reason); os demais
--     módulos seguem normais. Na contratação, extras com cortesia aberta também são recusados.
--
-- LACUNAS DE ACESSO (auditoria): (a) encerrar cortesia de plano de empresa sem assinatura corta o acesso imediatamente -> devolve aviso
--   'access_ends_immediately_no_subscription'; o caminho sem corte é autorizar a conversão e contratar. (b) entre contratar o plano
--   convertido e pagar o Pix a empresa fica em pending_payment (somente leitura), regra já existente de ativação só por pagamento,
--   igual à de qualquer contratação: NÃO alterada aqui (proposta de ponte no relatório). (c) módulo convertido nunca perde acesso: já
--   era extra da assinatura.
--
-- ORDEM DE TRAVAS: empresa -> cortesia (FOR UPDATE) -> [leitura do cursor, depois da trava]; contratação: empresa -> assinatura (nova)
-- -> cortesia (FOR UPDATE, no final). Geração: assinatura -> cortesias (FOR SHARE). Nunca cortesia antes de assinatura/fatura.

-- ---------------------------------------------------------------------------
-- 1) Modelagem
-- ---------------------------------------------------------------------------
alter table public.company_courtesies
  add column billing_starts_competence date,
  add column conversion_authorized_at timestamptz,
  add column conversion_authorized_by uuid references auth.users(id) on delete set null,
  add column converted_subscription_id uuid references public.subscriptions(id) on delete restrict;

alter table public.company_courtesies
  add constraint company_courtesies_billing_start_day check (billing_starts_competence is null or extract(day from billing_starts_competence) = 1),
  add constraint company_courtesies_billing_start_closed check (billing_starts_competence is null or status in ('ended', 'converted')),
  add constraint company_courtesies_converted_sub check (converted_subscription_id is null or status = 'converted');

do $$
declare
  v_name text;
begin
  select c.conname into v_name from pg_constraint c
   where c.conrelid = 'public.company_courtesy_events'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%event_type%';
  execute format('alter table public.company_courtesy_events drop constraint %I', v_name);
end $$;
alter table public.company_courtesy_events
  add constraint company_courtesy_events_event_type_check
  check (event_type in ('granted', 'extended', 'ended', 'expired', 'conversion_requested', 'conversion_authorized', 'converted'));

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
    'conversion_authorized_at', p_c.conversion_authorized_at, 'conversion_authorized_by', p_c.conversion_authorized_by,
    'billing_starts_competence', p_c.billing_starts_competence, 'converted_subscription_id', p_c.converted_subscription_id,
    'closed_at', p_c.closed_at, 'closed_by', p_c.closed_by, 'close_note', p_c.close_note);
$$;

-- Cobertura de uma competência: com início de cobrança definido, vale "competência < billing_starts_competence". Sem ele (cortesia
-- aberta, ou encerrada sem assinatura vigente) mantém a regra anterior.
create or replace function public.courtesy_covers(p_c public.company_courtesies, p_competence date)
returns boolean
language sql
stable
set search_path = public
as $$
  select public.competence_of(p_c.starts_at) <= p_competence
     and case
           when p_c.billing_starts_competence is not null then p_competence < p_c.billing_starts_competence
           when p_c.closed_at is null then true
           else p_c.closed_at >= ((p_competence + interval '1 month')::timestamp at time zone 'America/Sao_Paulo')
         end;
$$;

-- ---------------------------------------------------------------------------
-- 2) Janela de cobrança da empresa (cursor), sem travas: o chamador lê DEPOIS de travar a cortesia
-- ---------------------------------------------------------------------------
create function public.courtesy_billing_window(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sub public.subscriptions;
  v_cursor date;
  v_cur date := public.competence_of(public.business_now());
begin
  select * into v_sub from public.subscriptions where company_id = p_company_id and status <> 'canceled' limit 1;
  if not found then
    return null;
  end if;
  select (greatest(max(i.competence), public.courtesy_waived_through(v_sub.id)) + interval '1 month')::date into v_cursor
    from public.invoices i where i.subscription_id = v_sub.id and i.kind <> 'module_addition';
  v_cursor := coalesce(v_cursor, public.competence_of(v_sub.started_at));
  return jsonb_build_object('subscription_id', v_sub.id, 'plan_id', v_sub.plan_id, 'status', v_sub.status, 'cursor', v_cursor,
    'min_allowed', greatest(v_cursor, v_cur), 'default', greatest(v_cursor, (v_cur + interval '1 month')::date));
end;
$$;

create function public.courtesy_resolve_billing_start(p_window jsonb, p_requested date)
returns date
language plpgsql
stable
set search_path = public
as $$
declare
  v_min date;
begin
  if p_window is null then
    if p_requested is not null then
      raise exception 'a empresa não tem assinatura vigente: não há cobrança a iniciar (omita a data)';
    end if;
    return null;
  end if;
  if p_requested is null then
    return (p_window ->> 'default')::date;
  end if;
  v_min := (p_window ->> 'min_allowed')::date;
  if extract(day from p_requested) <> 1 then
    raise exception 'o início da cobrança deve ser o primeiro dia de uma competência (ex.: 2030-05-01)';
  end if;
  if p_requested < v_min then
    raise exception 'o início da cobrança não pode ser anterior a % (competências já decididas ou passadas não são cobradas retroativamente)', v_min;
  end if;
  if p_requested > (v_min + interval '24 months')::date then
    raise exception 'o início da cobrança pode ser no máximo 24 meses à frente';
  end if;
  return p_requested;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Vínculo ao plano: fatura recorrente só isenta o plano da MESMA versão contratual (patch exato)
-- ---------------------------------------------------------------------------
create function pg_temp.patch_fn_cv(p_name text, p_from text, p_to text)
returns void
language plpgsql
as $$
declare
  v_oid oid;
  v_def text;
begin
  select p.oid into v_oid from pg_proc p where p.proname = p_name and p.pronamespace = 'public'::regnamespace;
  if v_oid is null then
    raise exception 'patch_fn_cv: função % não encontrada', p_name;
  end if;
  v_def := pg_get_functiondef(v_oid);
  if (length(v_def) - length(replace(v_def, p_from, ''))) / greatest(length(p_from), 1) <> 1 then
    raise exception 'patch_fn_cv: trecho esperado não ocorre exatamente 1 vez em %', p_name;
  end if;
  execute replace(v_def, p_from, p_to);
end;
$$;

select pg_temp.patch_fn_cv('generate_subscription_invoice',
  $f$c.scope = 'plan' and public.courtesy_covers(c, p_competence)$f$,
  $f$c.scope = 'plan' and c.plan_id = v_terms.plan_id and public.courtesy_covers(c, p_competence)$f$);

-- ---------------------------------------------------------------------------
-- 4) Entitlement (2A) + vínculo: a cortesia de plano só amplia o entitlement SEM assinatura vigente
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 5) Encerrar (agora com início da cobrança futura e avisos) e converter
-- ---------------------------------------------------------------------------
drop function public.master_end_courtesy(uuid, text, uuid);

create function public.master_end_courtesy(
  p_courtesy_id uuid,
  p_reason text,
  p_request_id uuid default null,
  p_billing_starts date default null
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
  v_prev text;
  v_replay boolean;
  v_win jsonb;
  v_bs date;
  v_warn jsonb := '[]'::jsonb;
begin
  perform public.assert_master_admin();
  v_note := public.courtesy_check_reason(p_reason);

  select company_id into v_company from public.company_courtesies where id = p_courtesy_id;
  if not found then
    raise exception 'cortesia não encontrada';
  end if;
  -- ORDEM DE TRAVAS: empresa -> cortesia; o cursor é lido DEPOIS da trava (vê o que a geração concorrente já decidiu)
  perform 1 from public.companies where id = v_company for no key update;
  select * into v_c from public.company_courtesies where id = p_courtesy_id for update;

  v_replay := p_request_id is not null and exists (
    select 1 from public.company_courtesy_events e where e.courtesy_id = p_courtesy_id and e.request_id = p_request_id);
  if v_replay or v_c.status = 'ended' then
    return jsonb_build_object('courtesy', public.courtesy_json(v_c), 'changed', false, 'replayed', v_replay,
                              'billing_starts_competence', v_c.billing_starts_competence, 'warnings', '[]'::jsonb);
  end if;
  if v_c.status = 'converted' then
    raise exception 'cortesia já convertida não pode ser encerrada';
  end if;

  v_win := public.courtesy_billing_window(v_c.company_id);
  v_bs := public.courtesy_resolve_billing_start(v_win, p_billing_starts);

  -- avisos de acesso (o encerramento é sempre explícito do Master)
  if v_c.scope = 'plan' and v_win is null then
    v_warn := v_warn || to_jsonb('access_ends_immediately_no_subscription'::text);
  elsif v_c.scope = 'plan' and (v_win ->> 'plan_id')::uuid <> v_c.plan_id then
    v_warn := v_warn || to_jsonb('courtesy_was_not_exempting_current_plan'::text);
  elsif v_c.scope = 'module' and not exists (
      select 1 from public.subscriptions s join public.subscription_modules sm on sm.subscription_id = s.id
        join public.modules m on m.id = sm.module_id
       where s.company_id = v_c.company_id and s.status <> 'canceled' and sm.removed_at is null and m.code = v_c.module_code)
     and not exists (select 1 from public.company_module_overrides o
                      where o.company_id = v_c.company_id and o.module_code = v_c.module_code and (o.expires_at is null or o.expires_at > public.business_now())) then
    v_warn := v_warn || to_jsonb('module_access_ends'::text);
  end if;

  v_prev := public.courtesy_effective_state(v_c.status, v_c.ends_at);
  update public.company_courtesies
     set status = 'ended', closed_at = public.business_now(), closed_by = auth.uid(), close_note = v_note,
         billing_starts_competence = v_bs
   where id = v_c.id returning * into v_c;

  perform public.courtesy_record_event(v_c.id, 'ended', jsonb_build_object(
    'previous_state', v_prev, 'ends_at', v_c.ends_at, 'had_conversion_request', v_c.conversion_requested_at is not null,
    'billing_starts_competence', v_bs, 'warnings', v_warn, 'reason', v_note), p_request_id);

  return jsonb_build_object('courtesy', public.courtesy_json(v_c), 'changed', true, 'replayed', false,
                            'billing_starts_competence', v_bs, 'warnings', v_warn);
end;
$$;

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

-- ---------------------------------------------------------------------------
-- 6) Contratação paga: barreira + fechamento atômico da conversão (patch exato nas duas funções gêmeas)
-- ---------------------------------------------------------------------------
create function public.courtesy_contract_guard(p_company_id uuid, p_plan_id uuid, p_extra_ids uuid[], p_is_master boolean)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_names text;
  v_c public.company_courtesies;
begin
  select string_agg(m.name, ', ' order by m.name) into v_names
    from public.modules m
   where m.id = any (coalesce(p_extra_ids, '{}'::uuid[]))
     and exists (select 1 from public.company_courtesies c
                  where c.company_id = p_company_id and c.scope = 'module' and c.module_code = m.code
                    and c.status in ('active', 'expired_pending_decision'));
  if v_names is not null then
    raise exception 'O módulo % está em cortesia. A contratação paga exige a conversão feita pelo Master.', v_names using errcode = 'PT409';
  end if;

  select * into v_c from public.company_courtesies c
   where c.company_id = p_company_id and c.scope = 'plan' and c.plan_id = p_plan_id and c.status in ('active', 'expired_pending_decision');
  if found then
    if not p_is_master then
      raise exception 'Este plano está em cortesia para a empresa. A contratação paga exige a conversão feita pelo Master.' using errcode = 'PT409';
    elsif v_c.conversion_authorized_at is null then
      raise exception 'Este plano está em cortesia: autorize a conversão (master_convert_courtesy) antes de contratar.' using errcode = 'PT409';
    end if;
  end if;
end;
$$;

create function public.courtesy_finalize_conversion(p_company_id uuid, p_plan_id uuid, p_subscription_id uuid, p_start_competence date)
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

select pg_temp.patch_fn_cv('master_subscribe_company',
  $f$    raise exception 'a empresa já possui uma assinatura vigente';
  end if;
$f$,
  $f$    raise exception 'a empresa já possui uma assinatura vigente';
  end if;
  perform public.courtesy_contract_guard(p_company_id, p_plan_id, p_extra_module_ids, true);
$f$);
select pg_temp.patch_fn_cv('master_subscribe_company',
  $f$  select * into v_sub from public.subscriptions where id = v_sub.id;
  return v_sub;
end;$f$,
  $f$  perform public.courtesy_finalize_conversion(p_company_id, v_plan.id, v_sub.id, v_start);
  select * into v_sub from public.subscriptions where id = v_sub.id;
  return v_sub;
end;$f$);
select pg_temp.patch_fn_cv('billing_subscribe_company',
  $f$    raise exception 'a empresa já possui uma assinatura vigente';
  end if;
$f$,
  $f$    raise exception 'a empresa já possui uma assinatura vigente';
  end if;
  perform public.courtesy_contract_guard(p_company_id, p_plan_id, p_extra_module_ids, false);
$f$);

-- ---------------------------------------------------------------------------
-- 7) Adição paga de módulo (imediata ou agendada) bloqueada para módulo com cortesia aberta (patch exato; tela atual já exibe blocked_reason)
-- ---------------------------------------------------------------------------
select pg_temp.patch_fn_cv('billing_module_change_plan',
  $f$  v_added_ids uuid[];
begin$f$,
  $f$  v_added_ids uuid[];
  v_cw text;
begin$f$);
select pg_temp.patch_fn_cv('billing_module_change_plan',
  $f$  return v_plan || jsonb_build_object(
    'mode', v_mode,$f$,
  $f$  if v_blocked is null and jsonb_array_length(v_added) > 0 then
    select string_agg(a ->> 'name', ', ' order by a ->> 'name') into v_cw
      from jsonb_array_elements(v_added) a
     where exists (select 1 from public.company_courtesies c
                    where c.company_id = p_company_id and c.scope = 'module' and c.module_code = a ->> 'code'
                      and c.status in ('active', 'expired_pending_decision'));
    if v_cw is not null then
      v_blocked := 'O módulo ' || v_cw || ' está em cortesia. A contratação paga exige a conversão feita pelo Master.';
    end if;
  end if;

  return v_plan || jsonb_build_object(
    'mode', v_mode,$f$);

-- ---------------------------------------------------------------------------
-- 8) ACL explícita
-- ---------------------------------------------------------------------------
revoke execute on function public.courtesy_billing_window(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.courtesy_resolve_billing_start(jsonb, date) from public, anon, authenticated, service_role;
revoke execute on function public.courtesy_contract_guard(uuid, uuid, uuid[], boolean) from public, anon, authenticated, service_role;
revoke execute on function public.courtesy_finalize_conversion(uuid, uuid, uuid, date) from public, anon, authenticated, service_role;
revoke execute on function public.master_end_courtesy(uuid, text, uuid, date) from public, anon;
revoke execute on function public.master_convert_courtesy(uuid, text, date, uuid) from public, anon;
grant execute on function public.master_end_courtesy(uuid, text, uuid, date) to authenticated;
grant execute on function public.master_convert_courtesy(uuid, text, date, uuid) to authenticated;
revoke execute on function public.company_entitlement(uuid) from public, anon, authenticated, service_role;

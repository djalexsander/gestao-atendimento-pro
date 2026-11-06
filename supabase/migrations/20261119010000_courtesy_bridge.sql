-- CORTESIAS COMERCIAIS — Etapa 2C: PONTE DE ACESSO na conversão de cortesia de plano em assinatura paga. ADITIVA e LOCAL.
-- Não toca em frontend, cron, Edge Functions do Asaas, webhook, reconciliação nem em dados existentes.
--
-- PROBLEMA: a conversão (master_subscribe_company -> courtesy_finalize_conversion) cria a assinatura em pending_payment e fecha a cortesia
-- na MESMA transação; dali até o Pix ser confirmado (cobrança criada de forma assíncrona pelo worker do Asaas, pagamento confirmado pelo
-- webhook) a empresa ficaria em somente leitura e sem módulos.
--
-- SOLUÇÃO: sobreposição de LEITURA, sem tocar nas invariantes de cobrança. Nenhum status, fatura, job, webhook, reconciliação ou guarda de
-- ativação muda. A ponte:
--   * só nasce em courtesy_finalize_conversion (conversão de cortesia de plano AUTORIZADA pelo Master, mesmo plano, na própria transação
--     da contratação). Contratação comum, outro plano, trial, restricted, suspended e inadimplência NUNCA ganham ponte;
--   * dura o prazo escolhido na autorização (padrão 72 h, faixa 24-168 h, imutável), contado da contratação; sem renovação (uma ponte
--     por assinatura, índice único) e sem duplicação;
--   * vale enquanto: assinatura == pending_payment, fatura INICIAL open/overdue e agora < until_at. Pagamento (a assinatura vira active
--     pelo fluxo normal), cancelamento, anulação da inicial ou vencimento do prazo encerram o efeito SOZINHOS, sem escrita e sem job;
--   * libera ESCRITA (company_write_blocked deixa de bloquear nesse caso) e devolve ao entitlement: módulos do plano contratado
--     (source='plan'), cortesias de módulo abertas e overrides ativos. NÃO libera os extras contratados e ainda não pagos;
--   * mantém company_access_state = 'pending_payment': o banner de pagamento e o botão de pagar do app continuam. Operações da plataforma que
--     exigem assinatura efetivamente ativa (alterar módulos/plano, dia de vencimento, status) continuam recusadas pelas guardas existentes.

-- ---------------------------------------------------------------------------
-- 1) Prazo escolhido na autorização
-- ---------------------------------------------------------------------------
alter table public.company_courtesies
  add column conversion_bridge_hours smallint;
alter table public.company_courtesies
  add constraint company_courtesies_bridge_hours check (
    conversion_bridge_hours is null or (conversion_authorized_at is not null and conversion_bridge_hours between 24 and 168));

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

  if (new.billing_starts_competence is distinct from old.billing_starts_competence
      or new.converted_subscription_id is distinct from old.converted_subscription_id)
     and new.status not in ('ended', 'converted') then
    raise exception 'o início da cobrança só é definido no encerramento ou na conversão';
  end if;
  -- autorização de conversão e prazo da ponte: uma vez dados, são imutáveis
  if old.conversion_authorized_at is not null
     and (new.conversion_authorized_at is distinct from old.conversion_authorized_at
          or new.conversion_authorized_by is distinct from old.conversion_authorized_by
          or new.conversion_bridge_hours is distinct from old.conversion_bridge_hours) then
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

-- ---------------------------------------------------------------------------
-- 2) Registro da ponte (auditoria): uma por assinatura, append-only
-- ---------------------------------------------------------------------------
create table public.courtesy_access_bridges (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  subscription_id uuid not null references public.subscriptions(id) on delete restrict,
  courtesy_id uuid not null references public.company_courtesies(id) on delete restrict,
  -- a fatura INICIAL da assinatura: a ponte só vale enquanto ela estiver open/overdue
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  starts_at timestamptz not null,
  until_at timestamptz not null,
  hours smallint not null check (hours between 24 and 168),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (until_at > starts_at)
);
-- UMA ponte por assinatura: sem renovação e sem duplicação (a repetição é no-op)
create unique index courtesy_access_bridges_one_per_subscription on public.courtesy_access_bridges (subscription_id);
create index courtesy_access_bridges_company_idx on public.courtesy_access_bridges (company_id, starts_at desc);
create index courtesy_access_bridges_until_idx on public.courtesy_access_bridges (until_at);

create function public.prevent_courtesy_access_bridge_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'courtesy_access_bridges é append-only (a ponte não é renovada nem alterada)';
end;
$$;
create trigger courtesy_access_bridges_no_change
  before update or delete on public.courtesy_access_bridges
  for each row execute function public.prevent_courtesy_access_bridge_change();

alter table public.courtesy_access_bridges enable row level security;
revoke all on public.courtesy_access_bridges from public, anon, authenticated;
grant all on public.courtesy_access_bridges to service_role;
create policy courtesy_access_bridges_deny_clients on public.courtesy_access_bridges
  as restrictive for all to anon, authenticated using (false) with check (false);

-- ---------------------------------------------------------------------------
-- 3) Leitura da ponte (derivada em tempo real; nenhuma escrita para encerrar)
-- ---------------------------------------------------------------------------
create function public.courtesy_bridge_info(p_company_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('bridge_id', b.id, 'subscription_id', b.subscription_id, 'courtesy_id', b.courtesy_id,
                            'invoice_id', b.invoice_id, 'starts_at', b.starts_at, 'bridge_until', b.until_at, 'hours', b.hours)
    from public.courtesy_access_bridges b
    join public.subscriptions s on s.id = b.subscription_id and s.company_id = b.company_id
    join public.invoices i on i.id = b.invoice_id and i.subscription_id = b.subscription_id and i.kind = 'initial'
    join public.company_courtesies c on c.id = b.courtesy_id and c.company_id = b.company_id
   where b.company_id = p_company_id
     and s.status = 'pending_payment'
     and i.status in ('open', 'overdue')
     and c.status = 'converted' and c.converted_subscription_id = b.subscription_id and c.scope = 'plan'
     and public.business_now() < b.until_at
   limit 1;
$$;

create function public.courtesy_bridge_active(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.courtesy_bridge_info(p_company_id) is not null;
$$;

revoke execute on function public.prevent_courtesy_access_bridge_change() from public, anon, authenticated;
revoke execute on function public.courtesy_bridge_info(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.courtesy_bridge_active(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4) Barreira de escrita: a ponte só afeta pending_payment (corpo vigente de 20261006020000 + exceção)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 5) Entitlement: corpo da 2B-2 + ramo da ponte
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

-- ---------------------------------------------------------------------------
-- 6) Conversão: prazo da ponte na AUTORIZAÇÃO (nova assinatura da função) e criação da ponte na contratação
-- ---------------------------------------------------------------------------
drop function public.master_convert_courtesy(uuid, text, date, uuid);

create function public.master_convert_courtesy(
  p_courtesy_id uuid,
  p_note text,
  p_billing_starts date default null,
  p_request_id uuid default null,
  p_bridge_hours integer default null
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
  v_hours integer;
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
  if p_bridge_hours is not null and (p_bridge_hours < 24 or p_bridge_hours > 168) then
    raise exception 'o prazo da ponte de acesso deve estar entre 24 e 168 horas';
  end if;

  v_win := public.courtesy_billing_window(v_c.company_id);
  v_prev := public.courtesy_effective_state(v_c.status, v_c.ends_at);

  if v_c.scope = 'plan' and v_win is null then
    -- SEM assinatura: apenas AUTORIZA e fixa o prazo da ponte. Não contrata, não fecha, não muda o acesso.
    if p_billing_starts is not null then
      raise exception 'sem assinatura vigente não há início de cobrança a definir: a conversão apenas autoriza a contratação paga do plano';
    end if;
    if v_c.conversion_authorized_at is not null then
      if p_bridge_hours is not null and p_bridge_hours <> v_c.conversion_bridge_hours then
        raise exception 'o prazo da ponte é imutável depois da autorização (% h)', v_c.conversion_bridge_hours;
      end if;
      return jsonb_build_object('courtesy', public.courtesy_json(v_c), 'changed', false, 'replayed', false, 'converted', false, 'authorized', true);
    end if;
    v_hours := coalesce(p_bridge_hours, 72);
    update public.company_courtesies
       set conversion_authorized_at = public.business_now(), conversion_authorized_by = auth.uid(), conversion_bridge_hours = v_hours
     where id = v_c.id returning * into v_c;
    perform public.courtesy_record_event(v_c.id, 'conversion_authorized', jsonb_build_object(
      'state', v_prev, 'note', v_note, 'bridge_hours', v_hours, 'effect', 'access_preserved_until_master_contracts'), p_request_id);
    return jsonb_build_object('courtesy', public.courtesy_json(v_c), 'changed', true, 'replayed', false, 'converted', false, 'authorized', true,
                              'bridge_hours', v_hours, 'next_step', 'master_subscribe_company');
  end if;

  if p_bridge_hours is not null then
    raise exception 'o prazo da ponte só se define na autorização da conversão de plano sem assinatura';
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

create or replace function public.courtesy_finalize_conversion(p_company_id uuid, p_plan_id uuid, p_subscription_id uuid, p_start_competence date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c public.company_courtesies;
  v_inv uuid;
  v_hours integer;
  v_until timestamptz;
begin
  -- a assinatura (nova) já existe: ordem assinatura -> cortesia -> ponte
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

  -- PONTE: só nasce aqui, na transação da contratação autorizada; uma por assinatura (no-op se repetir)
  select i.id into v_inv from public.invoices i where i.subscription_id = p_subscription_id and i.kind = 'initial';
  v_hours := coalesce(v_c.conversion_bridge_hours, 72);
  v_until := public.business_now() + make_interval(hours => v_hours);
  if v_inv is not null then
    insert into public.courtesy_access_bridges (company_id, subscription_id, courtesy_id, invoice_id, starts_at, until_at, hours, created_by)
    values (p_company_id, p_subscription_id, v_c.id, v_inv, public.business_now(), v_until, v_hours, auth.uid())
    on conflict (subscription_id) do nothing;
  end if;

  perform public.courtesy_record_event(v_c.id, 'converted', jsonb_build_object(
    'via', 'subscribe', 'subscription_id', p_subscription_id, 'billing_starts_competence', p_start_competence,
    'previous_state', public.courtesy_effective_state(v_c.status, v_c.ends_at),
    'bridge_hours', case when v_inv is not null then v_hours end, 'bridge_until', case when v_inv is not null then v_until end), null);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) Consultas do Master (estado derivado: active | expired | paid | canceled)
-- ---------------------------------------------------------------------------
create function public.courtesy_bridge_json(p_b public.courtesy_access_bridges)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'bridge_id', p_b.id, 'company_id', p_b.company_id, 'subscription_id', p_b.subscription_id, 'courtesy_id', p_b.courtesy_id,
    'invoice_id', p_b.invoice_id, 'starts_at', p_b.starts_at, 'until_at', p_b.until_at, 'hours', p_b.hours,
    'subscription_status', s.status, 'invoice_status', i.status,
    'state', case
               when s.status = 'pending_payment' and i.status in ('open', 'overdue') then
                 case when public.business_now() < p_b.until_at then 'active' else 'expired' end
               when i.status = 'paid' then 'paid'
               else 'canceled' end,
    'remaining_minutes', case when s.status = 'pending_payment' and i.status in ('open', 'overdue') and public.business_now() < p_b.until_at
                              then floor(extract(epoch from (p_b.until_at - public.business_now())) / 60)::integer end)
    from public.subscriptions s, public.invoices i
   where s.id = p_b.subscription_id and i.id = p_b.invoice_id;
$$;

create function public.master_get_courtesy_bridge(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_master_admin();
  if not exists (select 1 from public.companies where id = p_company_id) then
    raise exception 'empresa não encontrada';
  end if;
  return coalesce((select jsonb_agg(public.courtesy_bridge_json(b) order by b.starts_at desc, b.id)
                     from public.courtesy_access_bridges b where b.company_id = p_company_id), '[]'::jsonb);
end;
$$;

-- Pontes ativas (e as vencidas sem pagamento) para o Master acompanhar; p_only_active=false inclui o histórico.
create function public.master_list_courtesy_bridges(p_only_active boolean default true)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_master_admin();
  return coalesce((
    select jsonb_agg(j order by (j ->> 'until_at'))
      from (select public.courtesy_bridge_json(b) || jsonb_build_object('company_name', co.name) as j
              from public.courtesy_access_bridges b join public.companies co on co.id = b.company_id) t
     where not p_only_active or j ->> 'state' in ('active', 'expired')), '[]'::jsonb);
end;
$$;

revoke execute on function public.courtesy_bridge_json(public.courtesy_access_bridges) from public, anon, authenticated, service_role;
revoke execute on function public.master_get_courtesy_bridge(uuid) from public, anon;
revoke execute on function public.master_list_courtesy_bridges(boolean) from public, anon;
grant execute on function public.master_get_courtesy_bridge(uuid) to authenticated;
grant execute on function public.master_list_courtesy_bridges(boolean) to authenticated;
revoke execute on function public.master_convert_courtesy(uuid, text, date, uuid, integer) from public, anon;
grant execute on function public.master_convert_courtesy(uuid, text, date, uuid, integer) to authenticated;
revoke execute on function public.company_entitlement(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.courtesy_finalize_conversion(uuid, uuid, uuid, date) from public, anon, authenticated, service_role;

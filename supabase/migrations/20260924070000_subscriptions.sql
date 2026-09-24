-- Fase 2 da estrutura comercial: ASSINATURAS. Relaciona uma empresa a um plano
-- e a módulos adicionais do catálogo comercial já existente (plans, modules,
-- plan_modules), com vencimento mensal, estado e histórico de alterações.
--
-- Fora do escopo desta migration: faturas, competências, pg_cron, pagamentos,
-- entitlements no /app, automação de transições de status.
--
-- Segurança: dados comerciais são da PLATAFORMA. As 3 tabelas têm RLS ativo,
-- nenhuma policy e NENHUM grant para anon/authenticated (nem SELECT): a
-- empresa não enxerga nada comercial, e o Master acessa só pelas RPCs abaixo
-- (SECURITY DEFINER + assert_master_admin()). Ser master_admin não altera o
-- RLS normal das empresas.

-- ---------------------------------------------------------------------------
-- subscriptions
--
-- "Vigente" = status <> 'canceled'. Ou seja, trialing, active, past_due,
-- grace, restricted e suspended AINDA são contrato em aberto (a empresa é
-- cliente, mesmo inadimplente/restrita); só 'canceled' encerra e libera uma
-- nova assinatura, e as canceladas ficam como histórico.
-- ---------------------------------------------------------------------------
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  -- RESTRICT: o tenant (owner) não pode apagar a própria empresa para
  -- destruir o histórico comercial; a empresa só sai depois de tratada pela
  -- plataforma.
  company_id uuid not null references public.companies(id) on delete restrict,
  plan_id uuid not null references public.plans(id) on delete restrict,
  -- Snapshot do preço do plano no momento da contratação/troca: mudar
  -- plans.monthly_price_cents depois NÃO altera contratos existentes.
  plan_price_cents_snapshot integer not null check (plan_price_cents_snapshot >= 0),
  status text not null default 'active'
    check (status in ('trialing','active','past_due','grace','restricted','suspended','canceled')),
  -- 1..31; se o dia não existir no mês, o vencimento futuro usa o último dia
  -- válido daquele mês (regra aplicada na geração de faturas, fase futura).
  billing_day smallint not null check (billing_day between 1 and 31),
  started_at timestamptz not null default now(),
  -- Competência (mês calendário, independente do dia de vencimento) em que a
  -- assinatura foi CONTRATADA. Nesta fase é apenas INFORMATIVA: nada a lê nem
  -- a avança, e master_change_plan/master_set_billing_day NÃO a alteram (sem
  -- prorata, crédito ou débito). Quem passa a avançá-la, e a dar efeito
  -- financeiro às mudanças, é a fase de faturamento: cada fatura futura é
  -- gerada a partir do ESTADO da assinatura no momento da geração daquela
  -- competência (as mudanças valem, portanto, a partir da próxima competência
  -- ainda não faturada; competência já faturada é imutável).
  current_period_start date not null,
  current_period_end date not null,
  grace_until date,
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (current_period_end >= current_period_start),
  check ((status = 'canceled') = (canceled_at is not null)),
  check (grace_until is null or status = 'grace')
);

-- No máximo UMA assinatura vigente por empresa (garantido no banco).
create unique index subscriptions_one_current_per_company
  on public.subscriptions(company_id) where status <> 'canceled';

create index subscriptions_company_id_idx on public.subscriptions(company_id);
create index subscriptions_plan_id_idx on public.subscriptions(plan_id);

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- subscription_modules: COMPOSIÇÃO DE MÓDULOS CONTRATADA por assinatura, com
-- histórico. Uma única tabela, com a origem de cada linha em `source`:
--
--   source = 'plan'  -> módulo incluído no plano. É uma CÓPIA (snapshot) feita
--                       no momento da contratação/troca de plano; alterar
--                       plan_modules no catálogo depois NÃO muda esta linha.
--                       `plan_id` guarda qual plano concedeu o módulo e o
--                       preço é 0 (já está dentro do preço do plano).
--   source = 'extra' -> módulo adicional contratado à parte, com o preço do
--                       catálogo congelado em price_cents_snapshot.
--
-- Por que uma tabela só (e não uma para "incluídos" e outra para "extras"):
--  * o índice único parcial abaixo garante NO BANCO que o mesmo módulo nunca
--    está ativo duas vezes na assinatura — nem como incluído + extra ao mesmo
--    tempo (um extra que passa a ser incluído por troca de plano é encerrado);
--  * "módulos ativos da assinatura" (entitlement futuro) e "itens cobráveis"
--    (invoice_items futuro: extras com preço; incluídos com preço 0) saem de
--    UMA consulta: removed_at IS NULL.
--
-- Remover/encerrar = preencher removed_at; a linha nunca é apagada.
-- ---------------------------------------------------------------------------
create table public.subscription_modules (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  module_id uuid not null references public.modules(id) on delete restrict,
  source text not null check (source in ('plan', 'extra')),
  plan_id uuid references public.plans(id) on delete restrict,
  price_cents_snapshot integer not null check (price_cents_snapshot >= 0),
  added_at timestamptz not null default now(),
  removed_at timestamptz,
  check (removed_at is null or removed_at >= added_at),
  check ((source = 'plan') = (plan_id is not null)),
  check (source <> 'plan' or price_cents_snapshot = 0)
);

-- Um mesmo módulo não pode estar ATIVO duas vezes na mesma assinatura,
-- qualquer que seja a origem (recontratar depois de remover cria nova linha).
create unique index subscription_modules_one_active
  on public.subscription_modules(subscription_id, module_id) where removed_at is null;

create index subscription_modules_plan_id_idx
  on public.subscription_modules(plan_id) where plan_id is not null;

create index subscription_modules_module_id_idx on public.subscription_modules(module_id);

-- ---------------------------------------------------------------------------
-- subscription_events: auditoria comercial. Append-only (UPDATE bloqueado
-- por trigger; nenhuma RPC apaga).
-- ---------------------------------------------------------------------------
create table public.subscription_events (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  event_type text not null check (event_type in (
    'subscribed','plan_changed','module_added','module_removed',
    'status_changed','billing_day_changed'
  )),
  payload jsonb not null default '{}'::jsonb,
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index subscription_events_subscription_idx
  on public.subscription_events(subscription_id, created_at desc);

create function public.prevent_subscription_event_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'subscription_events é append-only';
end;
$$;

create trigger subscription_events_no_update
  before update on public.subscription_events
  for each row execute function public.prevent_subscription_event_update();

revoke execute on function public.prevent_subscription_event_update() from public, anon, authenticated;

-- Assinatura cancelada é DEFINITIVA e fica intacta como histórico: nem a
-- assinatura nem sua composição de módulos podem mais ser alteradas (o
-- bloqueio é do banco, não só das RPCs). Apagar continua possível apenas
-- via cascade administrativo fora do produto; nenhuma RPC apaga.
create function public.prevent_canceled_subscription_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_table_name = 'subscriptions' then
    if old.status = 'canceled' then
      raise exception 'assinatura cancelada é definitiva e não pode ser alterada';
    end if;
  elsif exists (
    select 1 from public.subscriptions s
    where s.id = new.subscription_id and s.status = 'canceled'
  ) then
    raise exception 'assinatura cancelada é definitiva e não pode ser alterada';
  end if;
  return new;
end;
$$;

create trigger subscriptions_canceled_immutable
  before update on public.subscriptions
  for each row execute function public.prevent_canceled_subscription_change();

create trigger subscription_modules_canceled_immutable
  before insert or update on public.subscription_modules
  for each row execute function public.prevent_canceled_subscription_change();

revoke execute on function public.prevent_canceled_subscription_change() from public, anon, authenticated;

-- RLS ativo, sem policies, sem grants para clientes (explícito, sem depender
-- de default privileges).
alter table public.subscriptions enable row level security;
alter table public.subscription_modules enable row level security;
alter table public.subscription_events enable row level security;

revoke all on public.subscriptions from anon, authenticated;
revoke all on public.subscription_modules from anon, authenticated;
revoke all on public.subscription_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helper interno: grava evento. Nunca exposto a roles de cliente.
-- ---------------------------------------------------------------------------
create function public.record_subscription_event(
  p_subscription_id uuid,
  p_event_type text,
  p_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.subscription_events (subscription_id, event_type, payload, actor_id)
  values (p_subscription_id, p_event_type, coalesce(p_payload, '{}'::jsonb), auth.uid());
end;
$$;

revoke execute on function public.record_subscription_event(uuid, text, jsonb)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- master_list_companies: substitui a versão anterior (DROP + CREATE, pois o
-- tipo de retorno muda) acrescentando a situação da assinatura vigente.
-- ---------------------------------------------------------------------------
drop function public.master_list_companies();

create function public.master_list_companies()
returns table (
  id uuid,
  name text,
  document text,
  created_at timestamptz,
  member_count bigint,
  subscription_id uuid,
  subscription_status text,
  plan_id uuid,
  plan_name text
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
    c.id, c.name, c.document, c.created_at,
    (select count(*) from public.company_users cu where cu.company_id = c.id)::bigint,
    s.id, s.status, p.id, p.name
  from public.companies c
  left join public.subscriptions s on s.company_id = c.id and s.status <> 'canceled'
  left join public.plans p on p.id = s.plan_id
  order by c.created_at desc;
end;
$$;

revoke execute on function public.master_list_companies() from public, anon;
grant execute on function public.master_list_companies() to authenticated;

-- ---------------------------------------------------------------------------
-- master_get_company: visão completa de UMA empresa para o Master (dados,
-- membros, assinatura vigente com plano/módulos/preços, histórico e eventos).
-- ---------------------------------------------------------------------------
create function public.master_get_company(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company public.companies;
  v_sub public.subscriptions;
  v_result jsonb;
  v_subscription jsonb := null;
begin
  perform public.assert_master_admin();

  select * into v_company from public.companies where id = p_company_id;
  if not found then
    raise exception 'empresa não encontrada';
  end if;

  select * into v_sub from public.subscriptions
  where company_id = p_company_id and status <> 'canceled';

  if found then
    v_subscription := jsonb_build_object(
      'id', v_sub.id,
      'status', v_sub.status,
      'billing_day', v_sub.billing_day,
      'started_at', v_sub.started_at,
      'current_period_start', v_sub.current_period_start,
      'current_period_end', v_sub.current_period_end,
      'grace_until', v_sub.grace_until,
      'plan', (
        select jsonb_build_object(
          'id', pl.id, 'code', pl.code, 'name', pl.name,
          'price_cents_snapshot', v_sub.plan_price_cents_snapshot,
          'catalog_price_cents', pl.monthly_price_cents,
          'is_active', pl.is_active,
          'limits', coalesce((select jsonb_object_agg(l.limit_key, l.limit_value)
                              from public.plan_limits l where l.plan_id = pl.id), '{}'::jsonb)
        ) from public.plans pl where pl.id = v_sub.plan_id
      ),
      -- Composição CONTRATADA (snapshot), nunca o plan_modules vivo do catálogo.
      'included_modules', coalesce((
        select jsonb_agg(jsonb_build_object('id', m.id, 'code', m.code, 'name', m.name) order by m.name)
        from public.subscription_modules sm join public.modules m on m.id = sm.module_id
        where sm.subscription_id = v_sub.id and sm.source = 'plan' and sm.removed_at is null
      ), '[]'::jsonb),
      'extra_modules', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', sm.id, 'module_id', m.id, 'code', m.code, 'name', m.name,
          'price_cents_snapshot', sm.price_cents_snapshot, 'added_at', sm.added_at
        ) order by sm.added_at)
        from public.subscription_modules sm join public.modules m on m.id = sm.module_id
        where sm.subscription_id = v_sub.id and sm.source = 'extra' and sm.removed_at is null
      ), '[]'::jsonb),
      'module_history', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', sm.id, 'code', m.code, 'name', m.name, 'source', sm.source,
          'plan_id', sm.plan_id, 'price_cents_snapshot', sm.price_cents_snapshot,
          'added_at', sm.added_at, 'removed_at', sm.removed_at
        ) order by sm.added_at, m.name)
        from public.subscription_modules sm join public.modules m on m.id = sm.module_id
        where sm.subscription_id = v_sub.id
      ), '[]'::jsonb),
      'events', coalesce((
        select jsonb_agg(e order by e.created_at desc) from (
          select ev.id, ev.event_type, ev.payload, ev.created_at, pr.email as actor_email
          from public.subscription_events ev
          left join public.profiles pr on pr.user_id = ev.actor_id
          where ev.subscription_id = v_sub.id
          order by ev.created_at desc limit 100
        ) e
      ), '[]'::jsonb)
    );
  end if;

  v_result := jsonb_build_object(
    'company', jsonb_build_object(
      'id', v_company.id, 'name', v_company.name, 'slug', v_company.slug,
      'document', v_company.document, 'created_at', v_company.created_at
    ),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', cu.user_id, 'email', pr.email, 'full_name', pr.full_name, 'role', cu.role
      ) order by cu.created_at)
      from public.company_users cu left join public.profiles pr on pr.user_id = cu.user_id
      where cu.company_id = p_company_id
    ), '[]'::jsonb),
    'subscription', v_subscription,
    'past_subscriptions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'plan_name', pl.name, 'price_cents_snapshot', s.plan_price_cents_snapshot,
        'started_at', s.started_at, 'canceled_at', s.canceled_at
      ) order by s.started_at desc)
      from public.subscriptions s join public.plans pl on pl.id = s.plan_id
      where s.company_id = p_company_id and s.status = 'canceled'
    ), '[]'::jsonb)
  );

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- master_subscribe_company: contrata um plano para a empresa (transacional:
-- assinatura + evento). Só trialing/active na contratação.
-- ---------------------------------------------------------------------------
create function public.master_subscribe_company(
  p_company_id uuid,
  p_plan_id uuid,
  p_billing_day integer,
  p_status text
)
returns public.subscriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan public.plans;
  v_sub public.subscriptions;
  v_start date := date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date;
begin
  perform public.assert_master_admin();

  if not exists (select 1 from public.companies where id = p_company_id) then
    raise exception 'empresa não encontrada';
  end if;

  select * into v_plan from public.plans where id = p_plan_id;
  if not found then
    raise exception 'plano não encontrado';
  end if;
  if not v_plan.is_active then
    raise exception 'plano inativo não pode ser contratado';
  end if;

  if p_billing_day is null or p_billing_day not between 1 and 31 then
    raise exception 'billing_day deve estar entre 1 e 31';
  end if;
  if coalesce(p_status, 'active') not in ('trialing', 'active') then
    raise exception 'na contratação o status inicial deve ser trialing ou active';
  end if;

  if exists (select 1 from public.subscriptions where company_id = p_company_id and status <> 'canceled') then
    raise exception 'a empresa já possui uma assinatura vigente';
  end if;

  insert into public.subscriptions (
    company_id, plan_id, plan_price_cents_snapshot, status, billing_day,
    current_period_start, current_period_end
  ) values (
    p_company_id, v_plan.id, v_plan.monthly_price_cents, coalesce(p_status, 'active'), p_billing_day,
    v_start, (v_start + interval '1 month - 1 day')::date
  ) returning * into v_sub;

  -- Snapshot da composição: copia os módulos incluídos no plano NESTE momento.
  insert into public.subscription_modules (subscription_id, module_id, source, plan_id, price_cents_snapshot)
  select v_sub.id, pm.module_id, 'plan', v_plan.id, 0
  from public.plan_modules pm where pm.plan_id = v_plan.id;

  perform public.record_subscription_event(v_sub.id, 'subscribed', jsonb_build_object(
    'plan_id', v_plan.id, 'plan_code', v_plan.code,
    'plan_price_cents', v_plan.monthly_price_cents,
    'billing_day', p_billing_day, 'status', v_sub.status,
    'included_modules', coalesce((
      select jsonb_agg(jsonb_build_object('module_id', m.id, 'code', m.code) order by m.code)
      from public.subscription_modules sm join public.modules m on m.id = sm.module_id
      where sm.subscription_id = v_sub.id and sm.source = 'plan'
    ), '[]'::jsonb)
  ));

  return v_sub;
end;
$$;

-- ---------------------------------------------------------------------------
-- master_change_plan: troca EXPLÍCITA de plano. Efeito, nesta fase:
--  * imediato e apenas sobre o CONTRATO: novo plano e novo snapshot de preço
--    (plan_price_cents_snapshot) e nova composição de módulos incluídos;
--  * a composição anterior (linhas source='plan' do plano antigo) é ENCERRADA
--    (removed_at) e permanece como histórico; a do novo plano é COPIADA do
--    catálogo neste momento (novo snapshot);
--  * extras ativos que o novo plano passa a incluir são encerrados (soft) — o
--    mesmo módulo nunca fica ativo como incluído e extra ao mesmo tempo (o
--    índice único parcial também garante isso);
--  * SEM prorata, crédito, débito ou cobrança: ainda não existem faturas.
--    current_period_start/end e billing_day NÃO são tocados.
-- Tudo em uma transação, com um evento plan_changed que permite reconstruir a
-- composição anterior e a nova.
-- ---------------------------------------------------------------------------
create function public.master_change_plan(p_subscription_id uuid, p_plan_id uuid)
returns public.subscriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub public.subscriptions;
  v_old public.plans;
  v_new public.plans;
  v_old_price integer;
  v_from_modules jsonb;
  v_absorbed jsonb;
  v_to_modules jsonb;
begin
  perform public.assert_master_admin();

  select * into v_sub from public.subscriptions where id = p_subscription_id for update;
  if not found then raise exception 'assinatura não encontrada'; end if;
  if v_sub.status = 'canceled' then raise exception 'assinatura cancelada não pode ser alterada'; end if;

  select * into v_new from public.plans where id = p_plan_id;
  if not found then raise exception 'plano não encontrado'; end if;
  if not v_new.is_active then raise exception 'plano inativo não pode ser contratado'; end if;
  if v_new.id = v_sub.plan_id then raise exception 'a assinatura já está neste plano'; end if;

  select * into v_old from public.plans where id = v_sub.plan_id;
  v_old_price := v_sub.plan_price_cents_snapshot;

  -- composição anterior contratada (para o evento)
  select coalesce(jsonb_agg(jsonb_build_object('module_id', m.id, 'code', m.code) order by m.code), '[]'::jsonb)
  into v_from_modules
  from public.subscription_modules sm join public.modules m on m.id = sm.module_id
  where sm.subscription_id = v_sub.id and sm.source = 'plan' and sm.removed_at is null;

  -- encerra a composição do plano antigo (histórico preservado)
  update public.subscription_modules
  set removed_at = now()
  where subscription_id = v_sub.id and source = 'plan' and removed_at is null;

  -- encerra extras que o novo plano passa a incluir
  with absorbed as (
    update public.subscription_modules sm
    set removed_at = now()
    where sm.subscription_id = v_sub.id and sm.source = 'extra' and sm.removed_at is null
      and exists (select 1 from public.plan_modules pm
                  where pm.plan_id = v_new.id and pm.module_id = sm.module_id)
    returning sm.module_id, sm.price_cents_snapshot
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'module_id', a.module_id, 'code', m.code, 'price_cents', a.price_cents_snapshot
         ) order by m.code), '[]'::jsonb)
  into v_absorbed
  from absorbed a join public.modules m on m.id = a.module_id;

  update public.subscriptions
  set plan_id = v_new.id, plan_price_cents_snapshot = v_new.monthly_price_cents
  where id = v_sub.id
  returning * into v_sub;

  -- novo snapshot da composição (cópia do catálogo neste momento)
  insert into public.subscription_modules (subscription_id, module_id, source, plan_id, price_cents_snapshot)
  select v_sub.id, pm.module_id, 'plan', v_new.id, 0
  from public.plan_modules pm where pm.plan_id = v_new.id;

  select coalesce(jsonb_agg(jsonb_build_object('module_id', m.id, 'code', m.code) order by m.code), '[]'::jsonb)
  into v_to_modules
  from public.subscription_modules sm join public.modules m on m.id = sm.module_id
  where sm.subscription_id = v_sub.id and sm.source = 'plan' and sm.removed_at is null;

  perform public.record_subscription_event(v_sub.id, 'plan_changed', jsonb_build_object(
    'from_plan_id', v_old.id, 'from_plan_code', v_old.code, 'from_price_cents', v_old_price,
    'from_included_modules', v_from_modules,
    'to_plan_id', v_new.id, 'to_plan_code', v_new.code, 'to_price_cents', v_new.monthly_price_cents,
    'to_included_modules', v_to_modules,
    'extras_absorbed_by_plan', v_absorbed
  ));

  -- Linha do tempo dos extras completa: cada extra absorvido também gera
  -- module_removed (com o motivo), como numa remoção manual.
  perform public.record_subscription_event(v_sub.id, 'module_removed', a.item || '{"reason":"included_in_new_plan"}'::jsonb)
  from jsonb_array_elements(v_absorbed) as a(item);

  return v_sub;
end;
$$;

-- ---------------------------------------------------------------------------
-- master_set_subscription_modules: define o CONJUNTO de módulos EXTRAS ativos
-- (source = 'extra'). Adiciona os novos (com snapshot de preço) e encerra
-- (soft) os ausentes. Os módulos incluídos no plano (source = 'plan') nunca
-- são tocados aqui, e um módulo já incluído na composição CONTRATADA não pode
-- ser extra (validado contra o snapshot, não contra o catálogo vivo).
-- ---------------------------------------------------------------------------
create function public.master_set_subscription_modules(p_subscription_id uuid, p_module_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub public.subscriptions;
  v_ids uuid[];
  v_id uuid;
  v_mod public.modules;
  v_row record;
begin
  perform public.assert_master_admin();

  select * into v_sub from public.subscriptions where id = p_subscription_id for update;
  if not found then raise exception 'assinatura não encontrada'; end if;
  if v_sub.status = 'canceled' then raise exception 'assinatura cancelada não pode ser alterada'; end if;

  v_ids := coalesce(array(select distinct unnest(coalesce(p_module_ids, '{}'::uuid[]))), '{}'::uuid[]);

  foreach v_id in array v_ids loop
    select * into v_mod from public.modules where id = v_id;
    if not found then raise exception 'módulo inexistente na lista'; end if;
    if exists (select 1 from public.subscription_modules
               where subscription_id = v_sub.id and module_id = v_id
                 and source = 'plan' and removed_at is null) then
      raise exception 'o módulo "%" já está incluído no plano contratado', v_mod.name;
    end if;
  end loop;

  for v_row in
    update public.subscription_modules sm
    set removed_at = now()
    where sm.subscription_id = v_sub.id and sm.source = 'extra' and sm.removed_at is null
      and not (sm.module_id = any (v_ids))
    returning sm.module_id
  loop
    perform public.record_subscription_event(v_sub.id, 'module_removed',
      jsonb_build_object('module_id', v_row.module_id));
  end loop;

  foreach v_id in array v_ids loop
    if not exists (select 1 from public.subscription_modules
                   where subscription_id = v_sub.id and module_id = v_id
                     and source = 'extra' and removed_at is null) then
      select * into v_mod from public.modules where id = v_id;
      if not v_mod.is_active then
        raise exception 'módulo inativo "%" não pode ser contratado', v_mod.name;
      end if;
      insert into public.subscription_modules (subscription_id, module_id, source, price_cents_snapshot)
      values (v_sub.id, v_id, 'extra', v_mod.monthly_price_cents);
      perform public.record_subscription_event(v_sub.id, 'module_added', jsonb_build_object(
        'module_id', v_id, 'module_code', v_mod.code, 'price_cents', v_mod.monthly_price_cents
      ));
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- master_set_subscription_status: mudança MANUAL de status (sem automação
-- nesta fase). canceled é terminal: para voltar, contrata-se de novo.
-- ---------------------------------------------------------------------------
create function public.master_set_subscription_status(
  p_subscription_id uuid,
  p_status text,
  p_grace_until date
)
returns public.subscriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub public.subscriptions;
  v_old_status text;
  v_old_grace date;
begin
  perform public.assert_master_admin();

  select * into v_sub from public.subscriptions where id = p_subscription_id for update;
  if not found then raise exception 'assinatura não encontrada'; end if;
  if v_sub.status = 'canceled' then
    raise exception 'assinatura cancelada é definitiva; contrate novamente se necessário';
  end if;
  if p_status is null or p_status not in
     ('trialing','active','past_due','grace','restricted','suspended','canceled') then
    raise exception 'status inválido';
  end if;
  if p_grace_until is not null and p_status <> 'grace' then
    raise exception 'grace_until só se aplica ao status grace';
  end if;

  v_old_status := v_sub.status;
  v_old_grace := v_sub.grace_until;
  if v_old_status = p_status and v_old_grace is not distinct from p_grace_until then
    return v_sub;
  end if;

  update public.subscriptions
  set status = p_status,
      grace_until = case when p_status = 'grace' then p_grace_until else null end,
      canceled_at = case when p_status = 'canceled' then now() else null end
  where id = v_sub.id
  returning * into v_sub;

  perform public.record_subscription_event(v_sub.id, 'status_changed', jsonb_build_object(
    'from', v_old_status, 'to', p_status, 'grace_until', v_sub.grace_until
  ));

  return v_sub;
end;
$$;

-- ---------------------------------------------------------------------------
-- master_set_billing_day: corrige o dia de vencimento mensal (1..31).
-- ---------------------------------------------------------------------------
create function public.master_set_billing_day(p_subscription_id uuid, p_billing_day integer)
returns public.subscriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub public.subscriptions;
  v_old smallint;
begin
  perform public.assert_master_admin();

  select * into v_sub from public.subscriptions where id = p_subscription_id for update;
  if not found then raise exception 'assinatura não encontrada'; end if;
  if v_sub.status = 'canceled' then raise exception 'assinatura cancelada não pode ser alterada'; end if;
  if p_billing_day is null or p_billing_day not between 1 and 31 then
    raise exception 'billing_day deve estar entre 1 e 31';
  end if;
  if p_billing_day = v_sub.billing_day then return v_sub; end if;

  v_old := v_sub.billing_day;
  update public.subscriptions set billing_day = p_billing_day where id = v_sub.id
  returning * into v_sub;

  perform public.record_subscription_event(v_sub.id, 'billing_day_changed',
    jsonb_build_object('from', v_old, 'to', p_billing_day));

  return v_sub;
end;
$$;

-- ---------------------------------------------------------------------------
-- ACL explícita das RPCs novas: fora PUBLIC/anon; só authenticated executa
-- (a checagem real de master_admin é interna a cada função).
-- ---------------------------------------------------------------------------
revoke execute on function public.master_get_company(uuid) from public, anon;
revoke execute on function public.master_subscribe_company(uuid, uuid, integer, text) from public, anon;
revoke execute on function public.master_change_plan(uuid, uuid) from public, anon;
revoke execute on function public.master_set_subscription_modules(uuid, uuid[]) from public, anon;
revoke execute on function public.master_set_subscription_status(uuid, text, date) from public, anon;
revoke execute on function public.master_set_billing_day(uuid, integer) from public, anon;

grant execute on function public.master_get_company(uuid) to authenticated;
grant execute on function public.master_subscribe_company(uuid, uuid, integer, text) to authenticated;
grant execute on function public.master_change_plan(uuid, uuid) to authenticated;
grant execute on function public.master_set_subscription_modules(uuid, uuid[]) to authenticated;
grant execute on function public.master_set_subscription_status(uuid, text, date) to authenticated;
grant execute on function public.master_set_billing_day(uuid, integer) to authenticated;

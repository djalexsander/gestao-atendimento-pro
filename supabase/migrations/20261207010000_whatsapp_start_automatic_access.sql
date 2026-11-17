-- Iniciar conversa — ACESSO AUTOMÁTICO pelo módulo WhatsApp (decisão comercial 2026-11-17).
--
-- ANTES: o recurso só funcionava depois de o Master "habilitar" cada empresa (company_whatsapp_start_settings.enabled, padrão false).
-- AGORA: faz parte do módulo WhatsApp já cobrado. Disponível sozinho para toda empresa com DIREITO EFETIVO ao módulo 'whatsapp'
-- (assinatura com o módulo, cortesia válida de plano ou de módulo, override do Master, trial vigente, empresa antiga sem gestão) — a mesma
-- fonte única que o resto do sistema usa: public.company_entitlement()/company_has_module(). Nada de cobrança nova, nada altera assinaturas.
--
-- REGRA (servidor):
--   disponível  = company_has_module(empresa, 'whatsapp')  E  NÃO bloqueada pelo Master
--   bloqueada   = existe linha em company_whatsapp_start_settings com enabled = false   (o BLOQUEIO EXPLÍCITO do Master tem PRECEDÊNCIA sobre tudo)
--   sem linha   = sem configuração = liberada, com limites padrão (50 por dia, 24 h por contato). Faltar configuração NUNCA bloqueia cliente elegível.
--   limites     = da linha, quando existe; senão 50 / 24. Configuráveis pelo Master (whatsapp_set_start_settings).
--   Módulo vencido/removido, assinatura restrita/suspensa, pending_payment sem cortesia: company_entitlement já não devolve 'whatsapp' => indisponível.
--   Empresa em modo somente leitura (restrita, suspensa, pagamento pendente sem cortesia): indisponível (reason 'read_only'); o servidor já recusava com PT402
--   em whatsapp_start_assert_starter e o portão passa a esconder o botão.
--
-- SEMÂNTICA DA COLUNA (compatível com o front já publicado): enabled = TRUE significa "liberada" (padrão), FALSE significa "BLOQUEADA pelo Master".
--   O padrão da coluna passa de false para true. As linhas existentes não mudam de valor: true continua liberada; false (o Master desligou) vira bloqueio.
--   whatsapp_set_start_settings continua com a MESMA assinatura (p_enabled = liberar/bloquear) e só o Master a executa.
--
-- O QUE MUDA (todas por substituição exata do corpo atual, falha fechada se o trecho não ocorrer exatamente 1 vez; CREATE OR REPLACE preserva ACL):
--   whatsapp_start_request_reserve     a exigência "linha com enabled" vira whatsapp_start_gate (limites padrão quando não há linha)
--   whatsapp_templates_sync_request    idem (o Master continua podendo sincronizar mesmo com bloqueio, como antes)
--   whatsapp_get_start_settings        'enabled' passa a ser o direito efetivo (+ blocked, reason, source); a tela da empresa não precisa mudar
-- O QUE É NOVO: whatsapp_start_gate (interna), trilha company_whatsapp_start_events (trigger), master_whatsapp_start_overview (só Master).
-- NÃO MEXE: envio, webhook, IA, Coexistence, despacho, opt-out, consentimento, limites do servidor, faturas, assinaturas, cortesias.

-- ---------------------------------------------------------------------------
-- 1) Padrão da coluna: liberada (sem linha também é liberada)
-- ---------------------------------------------------------------------------
alter table public.company_whatsapp_start_settings alter column enabled set default true;
comment on column public.company_whatsapp_start_settings.enabled is
  'TRUE = liberada (padrão; sem linha também é liberada). FALSE = BLOQUEIO explícito do Master (precedência sobre o módulo). Desde 20261207010000.';

-- ---------------------------------------------------------------------------
-- 2) Trilha de auditoria das decisões do Master (bloqueio, liberação, limites)
-- ---------------------------------------------------------------------------
create table public.company_whatsapp_start_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  actor_user_id uuid,
  action text not null
    constraint company_whatsapp_start_events_action_check check (action in ('created', 'blocked', 'unblocked', 'limits_changed')),
  old_value jsonb,
  new_value jsonb not null,
  created_at timestamptz not null default now()
);
create index company_whatsapp_start_events_company_idx on public.company_whatsapp_start_events (company_id, created_at desc);
alter table public.company_whatsapp_start_events enable row level security;
revoke all on public.company_whatsapp_start_events from public, anon, authenticated;
grant all on public.company_whatsapp_start_events to service_role;

create function public.company_whatsapp_start_settings_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_new jsonb := jsonb_build_object('enabled', new.enabled, 'daily_limit', new.daily_limit, 'min_interval_hours', new.min_interval_hours);
  v_action text;
begin
  if tg_op = 'INSERT' then
    v_action := case when new.enabled then 'created' else 'blocked' end;
  else
    v_old := jsonb_build_object('enabled', old.enabled, 'daily_limit', old.daily_limit, 'min_interval_hours', old.min_interval_hours);
    if old.enabled is distinct from new.enabled then
      v_action := case when new.enabled then 'unblocked' else 'blocked' end;
    elsif v_old is distinct from v_new then
      v_action := 'limits_changed';
    else
      return new;
    end if;
  end if;
  insert into public.company_whatsapp_start_events (company_id, actor_user_id, action, old_value, new_value)
  values (new.company_id, auth.uid(), v_action, v_old, v_new);
  return new;
end;
$$;
revoke execute on function public.company_whatsapp_start_settings_audit() from public, anon, authenticated, service_role;

create trigger company_whatsapp_start_settings_audit
  after insert or update on public.company_whatsapp_start_settings
  for each row execute function public.company_whatsapp_start_settings_audit();

-- ---------------------------------------------------------------------------
-- 3) Portão único (interno): direito efetivo + bloqueio do Master + limites
-- ---------------------------------------------------------------------------
create function public.whatsapp_start_gate(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_s public.company_whatsapp_start_settings;
  v_ent jsonb;
  v_mod boolean;
  v_blocked boolean;
  v_readonly boolean;
  v_courtesies jsonb;
  v_source text;
begin
  select * into v_s from public.company_whatsapp_start_settings where company_id = p_company_id;
  v_blocked := v_s.company_id is not null and v_s.enabled is not true;
  v_ent := public.company_entitlement(p_company_id);
  v_mod := coalesce((v_ent -> 'modules') ? 'whatsapp', false);
  v_readonly := coalesce(public.company_write_blocked(p_company_id), false);   -- restrita/suspensa/pending_payment sem cortesia: só leitura
  v_courtesies := coalesce(v_ent -> 'courtesies', '[]'::jsonb);
  v_source := case
    when not v_mod then 'none'
    when v_courtesies ? 'module:whatsapp' then 'courtesy'
    when coalesce(v_ent -> 'overrides', '[]'::jsonb) ? 'whatsapp' then 'override'
    when v_ent ->> 'mode' in ('courtesy', 'courtesy_pending_payment') then 'courtesy'
    when v_ent ->> 'mode' = 'trial' then 'trial'
    when v_ent ->> 'mode' = 'unmanaged' then 'unmanaged'
    else 'subscription'
  end;
  return jsonb_build_object(
    'module_active', v_mod,
    'blocked', v_blocked,
    'read_only', v_readonly,
    'available', v_mod and not v_blocked and not v_readonly,
    'reason', case when v_blocked then 'blocked' when not v_mod then 'no_module' when v_readonly then 'read_only' else 'available' end,
    'source', v_source,
    'mode', v_ent ->> 'mode',
    'daily_limit', coalesce(v_s.daily_limit, 50),
    'min_interval_hours', coalesce(v_s.min_interval_hours, 24));
end;
$$;
revoke execute on function public.whatsapp_start_gate(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4) Ajustes por substituição exata (falha fechada)
-- ---------------------------------------------------------------------------
create or replace function pg_temp.patch_start_fn(p_proc text, p_args text, p_from text, p_to text)
returns void
language plpgsql
as $$
declare
  v_oid oid;
  v_def text;
begin
  select p.oid into v_oid from pg_proc p
   where p.proname = p_proc and p.pronamespace = 'public'::regnamespace and pg_get_function_identity_arguments(p.oid) = p_args;
  if v_oid is null then
    raise exception 'patch_fn: função % não encontrada', p_proc;
  end if;
  v_def := replace(pg_get_functiondef(v_oid), chr(13), '');
  if (length(v_def) - length(replace(v_def, p_from, ''))) / greatest(length(p_from), 1) <> 1 then
    raise exception 'patch_fn: trecho esperado não ocorre exatamente 1 vez em %', p_proc;
  end if;
  execute replace(v_def, p_from, p_to);
end;
$$;

-- 4a) reserva do pedido: portão no lugar da linha obrigatória
select pg_temp.patch_start_fn(
  'whatsapp_start_request_reserve',
  'p_company_id uuid, p_connection_id uuid, p_client_request_id uuid, p_contact_kind text, p_contact_ref uuid, p_contact_key text, p_template_id uuid, p_consent_confirmed boolean',
  $f$  v_limit integer;
  v_interval integer;
begin
  perform public.whatsapp_start_assert_starter(p_company_id);$f$,
  $f$  v_limit integer;
  v_interval integer;
  v_gate jsonb;
begin
  perform public.whatsapp_start_assert_starter(p_company_id);$f$);

select pg_temp.patch_start_fn(
  'whatsapp_start_request_reserve',
  'p_company_id uuid, p_connection_id uuid, p_client_request_id uuid, p_contact_kind text, p_contact_ref uuid, p_contact_key text, p_template_id uuid, p_consent_confirmed boolean',
  $f$  select * into v_s from public.company_whatsapp_start_settings where company_id = p_company_id;
  if not found or not v_s.enabled then
    raise exception 'Iniciar conversas está desativado para esta empresa.' using errcode = 'PT409';
  end if;
  v_limit := v_s.daily_limit;
  v_interval := v_s.min_interval_hours;$f$,
  $f$  -- acesso automático pelo módulo WhatsApp (assert_starter já exigiu o módulo); só o bloqueio explícito do Master recusa. Sem linha = limites padrão.
  v_gate := public.whatsapp_start_gate(p_company_id);
  if (v_gate ->> 'blocked')::boolean then
    raise exception 'Iniciar conversas está bloqueado para esta empresa pelo administrador da plataforma.' using errcode = 'PT409';
  end if;
  v_limit := (v_gate ->> 'daily_limit')::integer;
  v_interval := (v_gate ->> 'min_interval_hours')::integer;$f$);

-- 4b) pedido de sincronização de templates (não-Master)
select pg_temp.patch_start_fn(
  'whatsapp_templates_sync_request',
  'p_company_id uuid',
  $f$    select * into v_s from public.company_whatsapp_start_settings where company_id = p_company_id;
    if not found or not v_s.enabled then
      raise exception 'Iniciar conversas está desativado para esta empresa.' using errcode = 'PT409';
    end if;$f$,
  $f$    -- acesso automático pelo módulo (whatsapp_assert_reader já exigiu o módulo); só o bloqueio explícito do Master recusa
    if (public.whatsapp_start_gate(p_company_id) ->> 'blocked')::boolean then
      raise exception 'Iniciar conversas está bloqueado para esta empresa pelo administrador da plataforma.' using errcode = 'PT409';
    end if;$f$);

-- ---------------------------------------------------------------------------
-- 5) Estado para a tela da empresa: 'enabled' = direito efetivo (mesmo formato; campos extras só informam)
-- ---------------------------------------------------------------------------
create or replace function public.whatsapp_get_start_settings(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_g jsonb;
begin
  v_role := public.whatsapp_assert_reader(p_company_id);
  v_g := public.whatsapp_start_gate(p_company_id);
  return jsonb_build_object(
    'enabled', (v_g ->> 'available')::boolean,
    'blocked', (v_g ->> 'blocked')::boolean,
    'reason', v_g ->> 'reason',
    'source', v_g ->> 'source',
    'daily_limit', (v_g ->> 'daily_limit')::integer,
    'min_interval_hours', (v_g ->> 'min_interval_hours')::integer,
    'used_today', public.whatsapp_start_used_today(p_company_id),
    'can_start', v_role in ('owner', 'admin', 'attendant'));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Visão do Master: direito efetivo por empresa (módulo/cortesia/bloqueio), limites e trilha
-- ---------------------------------------------------------------------------
create function public.master_whatsapp_start_overview(p_company_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
  v_events jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if not public.is_master_admin() then
    raise exception 'Somente o administrador da plataforma pode ver esta configuração.' using errcode = 'PT403';
  end if;
  if p_company_id is not null and not exists (select 1 from public.companies where id = p_company_id) then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;

  select coalesce(jsonb_agg(x order by x ->> 'name'), '[]'::jsonb) into v_rows
    from (
      select jsonb_build_object(
               'company_id', c.id,
               'name', c.name,
               'module_active', (g.v ->> 'module_active')::boolean,
               'blocked', (g.v ->> 'blocked')::boolean,
               'read_only', (g.v ->> 'read_only')::boolean,
               'available', (g.v ->> 'available')::boolean,
               'reason', g.v ->> 'reason',
               'source', g.v ->> 'source',
               'mode', g.v ->> 'mode',
               'daily_limit', (g.v ->> 'daily_limit')::integer,
               'min_interval_hours', (g.v ->> 'min_interval_hours')::integer,
               'used_today', public.whatsapp_start_used_today(c.id),
               'has_settings', s.company_id is not null,
               'updated_at', s.updated_at,
               'connection', (select jsonb_build_object('type', k.connection_type, 'status', k.status)
                                from public.company_whatsapp_connections k where k.company_id = c.id and k.status = 'active' limit 1)
             ) as x
        from public.companies c
        cross join lateral (select public.whatsapp_start_gate(c.id) as v) g
        left join public.company_whatsapp_start_settings s on s.company_id = c.id
       where p_company_id is null or c.id = p_company_id
    ) q;

  if p_company_id is not null then
    select coalesce(jsonb_agg(jsonb_build_object('action', e.action, 'at', e.created_at, 'actor_user_id', e.actor_user_id, 'old', e.old_value, 'new', e.new_value) order by e.created_at desc), '[]'::jsonb)
      into v_events
      from (select * from public.company_whatsapp_start_events where company_id = p_company_id order by created_at desc limit 20) e;
  end if;
  return jsonb_build_object('companies', v_rows, 'events', v_events);
end;
$$;
revoke execute on function public.master_whatsapp_start_overview(uuid) from public, anon, service_role;
grant execute on function public.master_whatsapp_start_overview(uuid) to authenticated;

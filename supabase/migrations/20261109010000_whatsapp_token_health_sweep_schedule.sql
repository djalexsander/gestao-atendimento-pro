-- WhatsApp — Etapa 9: varredura da saúde dos tokens com auditoria de execução, proteção contra concorrência e agendamento (pg_cron).
-- Aditiva. Substitui o corpo de whatsapp_token_health_sweep() (mesma assinatura e mesma ACL) e acrescenta:
--   * whatsapp_token_sweep_runs        : uma linha por execução (sucesso / falha / ignorada por concorrência), SEM credenciais;
--   * whatsapp_token_sweep_try_lock()  : trava consultiva de transação (única; a segunda execução simultânea é IGNORADA, não espera);
--   * whatsapp_token_health_sweep(text): a varredura de fato ('cron' | 'manual'); a versão sem argumento passa a chamá-la como 'manual';
--   * master_whatsapp_token_sweep_status(): última execução, última com sucesso, atraso e estado do job (Admin Master);
--   * o job pg_cron 'whatsapp-token-health-sweep' (a cada 6 horas, minuto 7), criado SÓ se ainda não existir e se o pg_cron existir.
-- A varredura NÃO chama a Meta, NÃO envia mensagem, NÃO lê nem apaga token/PIN do Vault e NÃO toca em conexões sem prazo conhecido
-- (token_expires_at nulo: Djalexeventos). Não depende da flag do Embedded Signup nem da allowlist.
-- Também fecha o caminho alternativo whatsapp_registration_resolve (service_role): uma tentativa de registro 'in_progress' iniciada há
-- menos de 30 min não pode ser resolvida por ele (antes só a RPC do Admin Master conferia isso).

-- ---------------------------------------------------------------------------
-- 1) Auditoria das execuções
-- ---------------------------------------------------------------------------
create table public.whatsapp_token_sweep_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null constraint whatsapp_token_sweep_runs_source check (source in ('cron', 'manual')),
  status text not null constraint whatsapp_token_sweep_runs_status check (status in ('success', 'failed', 'skipped_concurrent')),
  started_at timestamptz not null,
  finished_at timestamptz not null default clock_timestamp(),
  connections_checked integer not null default 0,
  connections_locked_skipped integer not null default 0,
  states_updated integer not null default 0,
  alerts_created integer not null default 0,
  alerts_refreshed integer not null default 0,
  error_code text,
  error_message text
);
create index whatsapp_token_sweep_runs_started_idx on public.whatsapp_token_sweep_runs (started_at desc);
create index whatsapp_token_sweep_runs_success_idx on public.whatsapp_token_sweep_runs (started_at desc) where status = 'success';
alter table public.whatsapp_token_sweep_runs enable row level security;
revoke all on public.whatsapp_token_sweep_runs from public, anon, authenticated;
grant all on public.whatsapp_token_sweep_runs to service_role;
comment on table public.whatsapp_token_sweep_runs is
  'Auditoria da varredura de saúde dos tokens (uma linha por execução). Sem credenciais. Retenção: 90 dias (limpa pela própria varredura). Complementa cron.job_run_details.';

-- ---------------------------------------------------------------------------
-- 2) Trava única (interna): a execução simultânea é ignorada
-- ---------------------------------------------------------------------------
create function public.whatsapp_token_sweep_try_lock()
returns boolean
language sql
volatile
security definer
set search_path = public
as $$
  select pg_try_advisory_xact_lock(hashtextextended('whatsapp_token_health_sweep', 0));
$$;
revoke execute on function public.whatsapp_token_sweep_try_lock() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) A varredura
-- ---------------------------------------------------------------------------
create function public.whatsapp_token_health_sweep(p_source text)
returns jsonb
language plpgsql
security definer
set search_path = public
set lock_timeout = '5s'
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_source text := case when p_source = 'cron' then 'cron' else 'manual' end;
  v_row public.company_whatsapp_connections;
  v_eff text;
  v_inserted boolean;
  v_candidates integer := 0;
  v_checked integer := 0;
  v_updated integer := 0;
  v_created integer := 0;
  v_refreshed integer := 0;
  v_expiring integer := 0;
  v_expired integer := 0;
  v_code text;
  v_msg text;
begin
  if not public.whatsapp_token_sweep_try_lock() then
    insert into public.whatsapp_token_sweep_runs (source, status, started_at) values (v_source, 'skipped_concurrent', v_started);
    return jsonb_build_object('ok', true, 'skipped', true, 'reason', 'concurrent');
  end if;

  begin
    select count(*) into v_candidates from public.company_whatsapp_connections
     where status = 'active' and token_expires_at is not null and token_status not in ('revoked');
    -- SKIP LOCKED: uma conexão em uso por um envio/relato nesse instante fica para a próxima execução (idempotente), sem esperar
    for v_row in
      select * from public.company_whatsapp_connections
       where status = 'active' and token_expires_at is not null and token_status not in ('revoked')
       order by id
       for update skip locked
    loop
      v_checked := v_checked + 1;
      v_eff := public.whatsapp_token_effective_status(v_row);
      if v_eff in ('expiring', 'expired') then
        if v_row.token_status is distinct from v_eff then
          update public.company_whatsapp_connections set token_status = v_eff where id = v_row.id;
          v_updated := v_updated + 1;
        end if;
        insert into public.whatsapp_token_alerts (company_id, connection_id, kind, token_secret_id)
        values (v_row.company_id, v_row.id, v_eff, v_row.token_secret_id)
        on conflict (connection_id, kind, coalesce(token_secret_id, '00000000-0000-0000-0000-000000000000'::uuid))
        do update set last_seen_at = now()
        returning (xmax = 0) into v_inserted;
        if v_inserted then v_created := v_created + 1; else v_refreshed := v_refreshed + 1; end if;
        if v_eff = 'expiring' then v_expiring := v_expiring + 1; else v_expired := v_expired + 1; end if;
      end if;
    end loop;
    delete from public.whatsapp_token_sweep_runs where started_at < now() - interval '90 days';
  exception when others then
    -- nada do que a varredura fez é mantido (o bloco é uma subtransação); só a auditoria da falha, SEM credenciais
    v_code := sqlstate;
    v_msg := left(regexp_replace(sqlerrm, '(EAA[A-Za-z0-9_-]{6,}|[A-Za-z0-9_-]{32,})', '[removido]', 'g'), 200);
    insert into public.whatsapp_token_sweep_runs (source, status, started_at, error_code, error_message)
    values (v_source, 'failed', v_started, v_code, v_msg);
    return jsonb_build_object('ok', false, 'error', v_code);
  end;

  insert into public.whatsapp_token_sweep_runs
    (source, status, started_at, connections_checked, connections_locked_skipped, states_updated, alerts_created, alerts_refreshed)
  values (v_source, 'success', v_started, v_checked, greatest(v_candidates - v_checked, 0), v_updated, v_created, v_refreshed);
  return jsonb_build_object('ok', true, 'expiring', v_expiring, 'expired', v_expired, 'checked', v_checked,
                            'locked_skipped', greatest(v_candidates - v_checked, 0), 'updated', v_updated,
                            'alerts_created', v_created, 'alerts_refreshed', v_refreshed);
end;
$$;
revoke execute on function public.whatsapp_token_health_sweep(text) from public, anon, authenticated, service_role;

-- versão sem argumento (ACL e chamadas existentes preservadas): execução manual
create or replace function public.whatsapp_token_health_sweep()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.whatsapp_token_health_sweep('manual');
$$;

-- ---------------------------------------------------------------------------
-- 4) Estado para o Admin Master (execução, atraso e job)
-- ---------------------------------------------------------------------------
create function public.master_whatsapp_token_sweep_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last public.whatsapp_token_sweep_runs;
  v_ok timestamptz;
  v_job jsonb := null;
  v_cron jsonb := null;
  v_cronrun public.whatsapp_token_sweep_runs;
  v_fail public.whatsapp_token_sweep_runs;
begin
  perform public.assert_master_admin();
  select * into v_last from public.whatsapp_token_sweep_runs order by started_at desc limit 1;
  select max(started_at) into v_ok from public.whatsapp_token_sweep_runs where status = 'success';
  if to_regclass('cron.job') is not null then
    execute $q$select jsonb_build_object('schedule', schedule, 'active', active) from cron.job where jobname = 'whatsapp-token-health-sweep'$q$ into v_job;
    if v_job is not null and to_regclass('cron.job_run_details') is not null then
      execute $q$select jsonb_build_object('status', d.status, 'start_time', d.start_time, 'end_time', d.end_time)
                   from cron.job_run_details d join cron.job j on j.jobid = d.jobid
                  where j.jobname = 'whatsapp-token-health-sweep' order by d.start_time desc limit 1$q$ into v_cron;
    end if;
  end if;
  select * into v_cronrun from public.whatsapp_token_sweep_runs where source = 'cron' order by started_at desc limit 1;
  select * into v_fail from public.whatsapp_token_sweep_runs where status = 'failed' order by started_at desc limit 1;
  return jsonb_build_object(
    -- RESULTADO REAL da varredura (não o do agendador): 'failing' quando a última execução registrou falha
    'health', case when v_last.id is null then 'never_run'
                   when v_last.status = 'failed' then 'failing'
                   when v_ok is null or v_ok < now() - interval '13 hours' then 'overdue'
                   else 'ok' end,
    'last_run', case when v_last.id is null then null else jsonb_build_object(
      'source', v_last.source, 'status', v_last.status, 'started_at', v_last.started_at, 'finished_at', v_last.finished_at,
      'checked', v_last.connections_checked, 'locked_skipped', v_last.connections_locked_skipped, 'updated', v_last.states_updated,
      'alerts_created', v_last.alerts_created, 'alerts_refreshed', v_last.alerts_refreshed, 'error_code', v_last.error_code) end,
    'last_failure', case when v_fail.id is null then null else jsonb_build_object(
      'source', v_fail.source, 'started_at', v_fail.started_at, 'error_code', v_fail.error_code, 'error_message', v_fail.error_message) end,
    'last_success_at', v_ok,
    'never_run', v_ok is null,
    'overdue', v_ok is not null and v_ok < now() - interval '13 hours',
    'job', v_job,
    -- o que o PG_CRON registrou (disparou/terminou) — pode ser 'succeeded' mesmo quando a varredura registrou 'failed'
    'last_cron_run', v_cron,
    'scheduler_ok_but_sweep_failed', coalesce(v_cron ->> 'status' = 'succeeded' and v_cronrun.status = 'failed', false),
    'failures_24h', (select count(*) from public.whatsapp_token_sweep_runs where status = 'failed' and started_at > now() - interval '24 hours'),
    'recent_failures', coalesce((select jsonb_agg(jsonb_build_object('source', f.source, 'started_at', f.started_at, 'error_code', f.error_code, 'error_message', f.error_message) order by f.started_at desc)
                                   from (select * from public.whatsapp_token_sweep_runs where status = 'failed' order by started_at desc limit 5) f), '[]'::jsonb));
end;
$$;
revoke execute on function public.master_whatsapp_token_sweep_status() from public, anon, service_role;
grant execute on function public.master_whatsapp_token_sweep_status() to authenticated;

-- ---------------------------------------------------------------------------
-- 5) Caminho alternativo do registro: tentativa em curso (< 30 min) não é resolvida nem pelo service_role
-- ---------------------------------------------------------------------------
create or replace function public.whatsapp_registration_resolve(p_registration_id uuid, p_outcome text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_r public.whatsapp_number_registrations;
  v_last timestamptz;
begin
  if p_outcome is null or p_outcome not in ('registered', 'failed') then
    raise exception 'Resultado inválido.' using errcode = 'PT400';
  end if;
  select * into v_r from public.whatsapp_number_registrations where id = p_registration_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'registration_not_found');
  end if;
  if v_r.state not in ('uncertain', 'in_progress') then
    return jsonb_build_object('ok', false, 'error', 'state_not_allowed', 'state', v_r.state);
  end if;
  if v_r.state = 'in_progress' then
    select max(started_at) into v_last from public.whatsapp_registration_attempts where registration_id = v_r.id;
    if v_last is null or v_last > now() - interval '30 minutes' then
      return jsonb_build_object('ok', false, 'error', 'operation_may_be_in_flight');
    end if;
  end if;
  insert into public.whatsapp_registration_attempts (registration_id, status, pin_source, meta_code, finished_at)
  values (v_r.id, case when p_outcome = 'registered' then 'manual_registered' else 'manual_failed' end, v_r.pin_source, 'manual', now());
  if p_outcome = 'registered' then
    update public.whatsapp_number_registrations set state = 'registered', registered_at = now(), blocked_until = null, last_error_code = null where id = v_r.id;
  else
    update public.whatsapp_number_registrations set state = 'failed' where id = v_r.id;
  end if;
  return jsonb_build_object('ok', true, 'state', p_outcome);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Agendamento (pg_cron): a cada 6 horas; não duplica nem sobrescreve; ignora ambientes sem pg_cron
--    Desativar:  select cron.alter_job((select jobid from cron.job where jobname = 'whatsapp-token-health-sweep'), active := false);
--    Remover:    select cron.unschedule('whatsapp-token-health-sweep');
--    (um job desativado/alterado à mão NÃO é recriado nem sobrescrito se esta migration rodar de novo)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') and to_regclass('cron.job') is not null then
    if not exists (select 1 from cron.job where jobname = 'whatsapp-token-health-sweep') then
      perform cron.schedule('whatsapp-token-health-sweep', '7 */6 * * *', $cmd$select public.whatsapp_token_health_sweep('cron')$cmd$);
    end if;
  end if;
end $$;

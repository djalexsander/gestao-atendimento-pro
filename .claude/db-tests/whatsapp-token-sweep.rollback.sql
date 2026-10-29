-- Rollback de 20261109010000_whatsapp_token_health_sweep_schedule.sql (GERADO por gen-token-sweep-rollback.mjs).

-- Remove o job pg_cron (se existir), restaura a varredura e a RPC antiga de registro como eram e apaga a auditoria de execuções.

-- Não toca em conexões, alertas, tokens, PINs, mensagens, allowlist nem na flag.

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') and to_regclass('cron.job') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname = 'whatsapp-token-health-sweep';
  end if;
end $$;

CREATE OR REPLACE FUNCTION public.whatsapp_token_health_sweep()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.company_whatsapp_connections;
  v_eff text;
  v_expiring integer := 0;
  v_expired integer := 0;
begin
  for v_row in
    select * from public.company_whatsapp_connections
     where status = 'active' and token_expires_at is not null and token_status not in ('revoked')
     for update
  loop
    v_eff := public.whatsapp_token_effective_status(v_row);
    if v_eff in ('expiring', 'expired') then
      if v_row.token_status is distinct from v_eff then
        update public.company_whatsapp_connections set token_status = v_eff where id = v_row.id;
      end if;
      insert into public.whatsapp_token_alerts (company_id, connection_id, kind, token_secret_id)
      values (v_row.company_id, v_row.id, v_eff, v_row.token_secret_id)
      on conflict (connection_id, kind, coalesce(token_secret_id, '00000000-0000-0000-0000-000000000000'::uuid))
      do update set last_seen_at = now();
      if v_eff = 'expiring' then v_expiring := v_expiring + 1; else v_expired := v_expired + 1; end if;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'expiring', v_expiring, 'expired', v_expired);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.whatsapp_registration_resolve(p_registration_id uuid, p_outcome text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_r public.whatsapp_number_registrations;
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
  insert into public.whatsapp_registration_attempts (registration_id, status, pin_source, meta_code, finished_at)
  values (v_r.id, case when p_outcome = 'registered' then 'manual_registered' else 'manual_failed' end, v_r.pin_source, 'manual', now());
  if p_outcome = 'registered' then
    update public.whatsapp_number_registrations set state = 'registered', registered_at = now(), blocked_until = null, last_error_code = null where id = v_r.id;
  else
    update public.whatsapp_number_registrations set state = 'failed' where id = v_r.id;
  end if;
  return jsonb_build_object('ok', true, 'state', p_outcome);
end;
$function$
;

drop function public.master_whatsapp_token_sweep_status();
drop function public.whatsapp_token_health_sweep(text);
drop function public.whatsapp_token_sweep_try_lock();
drop table public.whatsapp_token_sweep_runs;

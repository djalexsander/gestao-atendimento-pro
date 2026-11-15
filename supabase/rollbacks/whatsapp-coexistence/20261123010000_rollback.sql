-- Rollback da migration 20261123010000 (restaura whatsapp_signup_complete de 20261107010000). Conexões 'coexistence' já gravadas
-- NÃO são alteradas; antes de reverter, desconecte/ajuste-as manualmente se existirem.
create or replace function public.whatsapp_signup_complete(
  p_session_id uuid,
  p_waba_id text,
  p_phone_number_id text,
  p_display_phone_number text,
  p_business_name text,
  p_meta_business_id text,
  p_registered_at timestamptz,
  p_webhook_subscribed_at timestamptz,
  p_connection_type text default 'cloud_api'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.whatsapp_signup_sessions;
  v_conn public.company_whatsapp_connections;
  v_other public.company_whatsapp_connections;
  v_id uuid;
  v_old_secret uuid;
  v_display text := left(nullif(btrim(coalesce(p_display_phone_number, '')), ''), 40);
  v_name text := left(nullif(btrim(coalesce(p_business_name, '')), ''), 120);
begin
  if p_waba_id is null or p_waba_id !~ '^[0-9]{5,40}$'
     or p_phone_number_id is null or p_phone_number_id !~ '^[0-9]{5,40}$'
     or (p_meta_business_id is not null and p_meta_business_id !~ '^[0-9]{5,40}$') then
    raise exception 'Identificadores da Meta inválidos.' using errcode = 'PT400';
  end if;
  if p_connection_type is distinct from 'cloud_api' then
    raise exception 'Tipo de conexão ainda não suportado.' using errcode = 'PT400';
  end if;
  if p_registered_at is null or p_webhook_subscribed_at is null then
    raise exception 'Número não registrado ou webhook não assinado.' using errcode = 'PT400';
  end if;

  select * into v_s from public.whatsapp_signup_sessions where id = p_session_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'session_not_found');
  end if;

  -- repetição da mesma conclusão: devolve o mesmo resultado sem gravar de novo
  if v_s.status = 'completed' then
    select * into v_conn from public.company_whatsapp_connections where id = v_s.connection_id;
    if found and v_conn.phone_number_id = p_phone_number_id then
      return jsonb_build_object('ok', true, 'idempotent', true, 'connection_id', v_conn.id, 'status', v_conn.status, 'mode', v_conn.mode);
    end if;
    return jsonb_build_object('ok', false, 'error', 'already_used');
  end if;
  if v_s.status <> 'reserved' then
    return jsonb_build_object('ok', false, 'error', case when v_s.status = 'expired' then 'expired' else 'session_not_reserved' end);
  end if;
  if v_s.expires_at <= now() then
    perform public.whatsapp_signup_sweep(v_s.company_id);
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;
  if v_s.token_secret_id is null then
    return jsonb_build_object('ok', false, 'error', 'token_not_stored');
  end if;
  if not public.whatsapp_signup_pilot_allowed(v_s.company_id) then
    update public.whatsapp_signup_sessions set status = 'failed', error_code = 'company_not_authorized' where id = v_s.id;
    return jsonb_build_object('ok', false, 'error', 'company_not_authorized');
  end if;
  if not public.whatsapp_signup_user_can_manage(v_s.company_id, v_s.user_id) then
    update public.whatsapp_signup_sessions set status = 'failed', error_code = 'unauthorized' where id = v_s.id;
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('wa_conn:' || v_s.company_id::text, 0));

  -- número já pertence a OUTRA empresa: recusa, sem tocar na conexão dela
  if exists (select 1 from public.company_whatsapp_connections c
              where c.phone_number_id = p_phone_number_id and c.company_id <> v_s.company_id) then
    update public.whatsapp_signup_sessions set status = 'failed', error_code = 'phone_in_use' where id = v_s.id;
    return jsonb_build_object('ok', false, 'error', 'phone_in_use');
  end if;

  -- limite atual: uma conexão ativa por empresa. Não desconecta nada sozinho.
  select * into v_other from public.company_whatsapp_connections
   where company_id = v_s.company_id and status = 'active' and phone_number_id is distinct from p_phone_number_id
   limit 1;
  if found then
    update public.whatsapp_signup_sessions set status = 'failed', error_code = 'company_has_active_connection' where id = v_s.id;
    return jsonb_build_object('ok', false, 'error', 'company_has_active_connection');
  end if;

  select * into v_conn from public.company_whatsapp_connections
   where company_id = v_s.company_id and phone_number_id = p_phone_number_id for update;

  begin
    if found then
      -- reconexão do mesmo número na mesma empresa: reaproveita a linha (histórico e modo preservados), rotaciona o token
      v_old_secret := v_conn.token_secret_id;
      update public.company_whatsapp_connections
         set connection_source = 'embedded_signup', connection_type = 'cloud_api',
             waba_id = p_waba_id, meta_business_id = p_meta_business_id,
             display_phone_number = coalesce(v_display, display_phone_number),
             business_name = coalesce(v_name, business_name),
             token_secret_id = v_s.token_secret_id, token_expires_at = v_s.token_expires_at, token_status = 'valid',
             registered_at = p_registered_at, webhook_subscribed_at = p_webhook_subscribed_at, webhook_status = 'active',
             last_error_code = null, connected_at = now(), disconnected_at = null, status = 'active'
       where id = v_conn.id
       returning id into v_id;
      if v_old_secret is not null and v_old_secret is distinct from v_s.token_secret_id
         and not exists (select 1 from public.company_whatsapp_connections c where c.token_secret_id = v_old_secret) then
        delete from vault.secrets where id = v_old_secret;
      end if;
    else
      insert into public.company_whatsapp_connections
        (company_id, status, mode, waba_id, phone_number_id, display_phone_number, business_name, token_secret_id,
         webhook_status, connected_at, created_by, connection_source, connection_type, meta_business_id,
         token_expires_at, token_status, registered_at, webhook_subscribed_at)
      values
        (v_s.company_id, 'active', 'test', p_waba_id, p_phone_number_id, v_display, v_name, v_s.token_secret_id,
         'active', now(), v_s.user_id, 'embedded_signup', 'cloud_api', p_meta_business_id,
         v_s.token_expires_at, 'valid', p_registered_at, p_webhook_subscribed_at)
      returning id into v_id;
    end if;
  exception when unique_violation then
    -- corrida com outra empresa pelo mesmo número (índice único global)
    update public.whatsapp_signup_sessions set status = 'failed', error_code = 'phone_in_use' where id = v_s.id;
    return jsonb_build_object('ok', false, 'error', 'phone_in_use');
  end;

  update public.whatsapp_signup_sessions
     set status = 'completed', completed_at = now(), connection_id = v_id
   where id = v_s.id;
  return jsonb_build_object('ok', true, 'idempotent', false, 'connection_id', v_id,
                            'status', 'active', 'mode', (select mode from public.company_whatsapp_connections where id = v_id));
end;
$$;
revoke execute on function public.whatsapp_signup_complete(uuid, text, text, text, text, text, timestamptz, timestamptz, text) from public, anon, authenticated;
grant execute on function public.whatsapp_signup_complete(uuid, text, text, text, text, text, timestamptz, timestamptz, text) to service_role;

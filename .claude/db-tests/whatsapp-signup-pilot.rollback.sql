-- Rollback de 20261107010000_whatsapp_signup_pilot_allowlist.sql (GERADO por gen-pilot-rollback.mjs). Não toca em conexões, tokens, PINs ou mensagens.

create or replace function public.whatsapp_get_module_state(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_wa boolean;
  v_ia boolean;
  v_conn_active boolean;
  v_signup jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'attendant', 'cashier') then
    raise exception 'Você não tem permissão para usar o WhatsApp.' using errcode = 'PT403';
  end if;
  v_wa := public.company_has_module(p_company_id, 'whatsapp');
  v_ia := public.company_has_module(p_company_id, 'ia');
  select exists (select 1 from public.company_whatsapp_connections c where c.company_id = p_company_id and c.status = 'active')
    into v_conn_active;
  v_signup := public.whatsapp_signup_availability();
  return jsonb_build_object(
    'whatsapp', v_wa,
    'ia', v_ia,
    'ai_allowed', v_wa and v_ia,
    'connection_active', v_conn_active,
    'has_history', exists (select 1 from public.whatsapp_conversations c where c.company_id = p_company_id and c.deleted_at is null),
    'can_manage', v_role in ('owner', 'admin'),
    'role', v_role,
    'signup', v_signup);
end;
$$;

create or replace function public.whatsapp_signup_begin(p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_av jsonb;
  v_state text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_expires timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Somente o proprietário ou administrador pode conectar o WhatsApp.' using errcode = 'PT403';
  end if;
  perform public.assert_company_module(p_company_id, 'whatsapp');
  v_av := public.whatsapp_signup_availability();
  if not (v_av ->> 'available')::boolean then
    raise exception 'A conexão automática ainda depende da aprovação da Meta e não está disponível.' using errcode = 'PT409';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('wa_signup:' || p_company_id::text, 0));
  perform public.whatsapp_signup_sweep(p_company_id);
  if (select count(*) from public.whatsapp_signup_sessions
       where company_id = p_company_id and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'Muitas tentativas de conexão. Aguarde alguns minutos e tente novamente.' using errcode = 'PT429';
  end if;
  -- uma tentativa nova invalida as pendentes anteriores da mesma empresa
  update public.whatsapp_signup_sessions set status = 'cancelled'
   where company_id = p_company_id and status = 'pending';

  insert into public.whatsapp_signup_sessions (company_id, user_id, state_hash)
  values (p_company_id, auth.uid(), encode(sha256(convert_to(v_state, 'UTF8')), 'hex'))
  returning expires_at into v_expires;

  return jsonb_build_object('state', v_state, 'meta_app_id', v_av ->> 'meta_app_id', 'config_id', v_av ->> 'config_id',
                            'expires_at', v_expires);
end;
$$;

create or replace function public.whatsapp_signup_fail(p_session_id uuid, p_error_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.whatsapp_signup_sessions;
  v_code text := coalesce(nullif(btrim(p_error_code), ''), 'unknown');
  v_cleaned boolean := false;
begin
  if v_code !~ '^[A-Za-z0-9_.:-]{1,60}$' then
    v_code := 'invalid_code';
  end if;
  select * into v_s from public.whatsapp_signup_sessions where id = p_session_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'session_not_found');
  end if;
  if v_s.status not in ('pending', 'reserved', 'failed') then
    return jsonb_build_object('ok', true, 'status', v_s.status, 'changed', false);
  end if;
  if v_s.token_secret_id is not null
     and not exists (select 1 from public.company_whatsapp_connections c where c.token_secret_id = v_s.token_secret_id) then
    delete from vault.secrets where id = v_s.token_secret_id and starts_with(name, 'wa_token_signup_');
    v_cleaned := true;
  end if;
  if v_s.status in ('pending', 'reserved') then
    update public.whatsapp_signup_sessions
       set status = 'failed', error_code = v_code, token_secret_id = null, token_expires_at = null
     where id = v_s.id;
    return jsonb_build_object('ok', true, 'status', 'failed', 'changed', true);
  end if;
  if v_cleaned then
    update public.whatsapp_signup_sessions set token_secret_id = null, token_expires_at = null where id = v_s.id;
  end if;
  return jsonb_build_object('ok', true, 'status', 'failed', 'changed', v_cleaned);
end;
$$;

create or replace function public.whatsapp_signup_sweep(p_company_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secrets integer := 0;
  v_sessions integer := 0;
  v_pins jsonb;
  v_row record;
begin
  for v_row in
    select s.id, s.token_secret_id from public.whatsapp_signup_sessions s
     where s.status in ('pending', 'reserved') and s.expires_at <= now()
       and (p_company_id is null or s.company_id = p_company_id)
     for update
  loop
    if v_row.token_secret_id is not null
       and not exists (select 1 from public.company_whatsapp_connections c where c.token_secret_id = v_row.token_secret_id) then
      delete from vault.secrets where id = v_row.token_secret_id and starts_with(name, 'wa_token_signup_');
      v_secrets := v_secrets + 1;
    end if;
    v_sessions := v_sessions + 1;
    update public.whatsapp_signup_sessions
       set status = 'expired', token_secret_id = null, token_expires_at = null
     where id = v_row.id;
  end loop;

  for v_row in
    select s.id, s.token_secret_id from public.whatsapp_signup_sessions s
     where s.status = 'failed' and s.token_secret_id is not null
       and (p_company_id is null or s.company_id = p_company_id)
     for update
  loop
    if not exists (select 1 from public.company_whatsapp_connections c where c.token_secret_id = v_row.token_secret_id) then
      delete from vault.secrets where id = v_row.token_secret_id and starts_with(name, 'wa_token_signup_');
      v_secrets := v_secrets + 1;
    end if;
    update public.whatsapp_signup_sessions set token_secret_id = null, token_expires_at = null where id = v_row.id;
  end loop;

  v_pins := public.whatsapp_registration_sweep();
  return jsonb_build_object('ok', true, 'sessions_expired', v_sessions, 'secrets_removed', v_secrets,
                            'pins_removed', (v_pins ->> 'pins_removed')::integer);
end;
$$;

create or replace function public.whatsapp_signup_reserve(p_state text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash text;
  v_s public.whatsapp_signup_sessions;
begin
  if p_state is null or char_length(p_state) not between 32 and 128 then
    return jsonb_build_object('ok', false, 'error', 'invalid_state');
  end if;
  v_hash := encode(sha256(convert_to(p_state, 'UTF8')), 'hex');

  -- UPDATE único: de duas chamadas concorrentes, só uma muda pending -> reserved.
  update public.whatsapp_signup_sessions
     set status = 'reserved', reserved_at = now()
   where state_hash = v_hash and status = 'pending' and expires_at > now()
   returning * into v_s;

  if not found then
    select * into v_s from public.whatsapp_signup_sessions where state_hash = v_hash;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'invalid_state');
    end if;
    if v_s.status = 'pending' then -- pendente e vencida
      update public.whatsapp_signup_sessions set status = 'expired' where id = v_s.id;
      return jsonb_build_object('ok', false, 'error', 'expired');
    end if;
    if v_s.status = 'expired' or (v_s.status = 'reserved' and v_s.expires_at <= now()) then
      return jsonb_build_object('ok', false, 'error', 'expired');
    end if;
    if v_s.status = 'cancelled' then
      return jsonb_build_object('ok', false, 'error', 'cancelled');
    end if;
    return jsonb_build_object('ok', false, 'error', 'already_used');
  end if;

  -- a autorização é conferida de novo no consumo (o papel pode ter mudado desde a criação)
  if not public.whatsapp_signup_user_can_manage(v_s.company_id, v_s.user_id) then
    update public.whatsapp_signup_sessions set status = 'failed', error_code = 'unauthorized' where id = v_s.id;
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  return jsonb_build_object('ok', true, 'session_id', v_s.id, 'company_id', v_s.company_id, 'user_id', v_s.user_id,
                            'expires_at', v_s.expires_at);
end;
$$;

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

drop function public.master_whatsapp_pilot_events(uuid);
drop function public.master_whatsapp_pilot_list();
drop function public.master_whatsapp_pilot_set(uuid, boolean, text);
drop function public.whatsapp_signup_availability_for_company(uuid);
drop function public.whatsapp_signup_external_op_open(uuid);
drop function public.whatsapp_signup_pilot_allowed(uuid);
drop table public.whatsapp_signup_pilot_events;
drop table public.whatsapp_signup_pilot_companies;

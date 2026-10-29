-- WhatsApp Embedded Signup — liberação CONTROLADA por empresa (piloto). Aditiva: nenhuma conexão, token, PIN ou mensagem é tocado.
--
-- Camadas (todas precisam passar para uma empresa conectar):
--   1) flag global whatsapp_platform_settings.embedded_signup_enabled (trava do operador, inalterada)
--   2) a empresa está na allowlist whatsapp_signup_pilot_companies com authorized = true (esta migration)
--   3) usuário owner/admin ativo + módulo WhatsApp contratado (inalterado)
-- A allowlist é conferida no banco em: whatsapp_signup_begin (nova sessão), whatsapp_signup_reserve (consumo do state) e
-- whatsapp_signup_complete (conclusão), e de novo no backend (Edge). Ninguém é autorizado automaticamente: a tabela nasce VAZIA.
-- Só o Admin Master (assert_master_admin) autoriza/revoga. Cada mudança grava quem/quando em whatsapp_signup_pilot_events.
-- Revogar: impede novas sessões, falha as pendentes/reservadas (limpando só o segredo ainda não ligado a conexão E sem operação externa
-- em aberto: enquanto o registro do número na Meta estiver em curso ou incerto, o token e o PIN são PRESERVADOS) e NÃO toca em conexões
-- ativas, histórico, tokens ligados a conexões, PINs, mensagens, IA ou atendimento.

-- ---------------------------------------------------------------------------
-- 1) Tabelas (sem acesso do cliente; escrita só pelas RPCs abaixo)
-- ---------------------------------------------------------------------------
create table public.whatsapp_signup_pilot_companies (
  company_id uuid primary key references public.companies(id) on delete cascade,
  authorized boolean not null default false,
  authorized_by uuid references auth.users(id) on delete set null,
  authorized_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  note text constraint whatsapp_signup_pilot_note_len check (note is null or char_length(note) <= 500),
  updated_at timestamptz not null default now()
);
alter table public.whatsapp_signup_pilot_companies enable row level security;
revoke all on public.whatsapp_signup_pilot_companies from public, anon, authenticated;
grant all on public.whatsapp_signup_pilot_companies to service_role;
comment on table public.whatsapp_signup_pilot_companies is
  'Allowlist do piloto do Embedded Signup. Vazia por padrão; só o Admin Master altera (RPC master_whatsapp_pilot_set).';

create table public.whatsapp_signup_pilot_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  action text not null constraint whatsapp_signup_pilot_events_action check (action in ('authorized', 'revoked')),
  actor_user_id uuid references auth.users(id) on delete set null,
  note text,
  created_at timestamptz not null default now()
);
create index whatsapp_signup_pilot_events_company_idx on public.whatsapp_signup_pilot_events (company_id, created_at desc);
alter table public.whatsapp_signup_pilot_events enable row level security;
revoke all on public.whatsapp_signup_pilot_events from public, anon, authenticated;
grant all on public.whatsapp_signup_pilot_events to service_role;
comment on table public.whatsapp_signup_pilot_events is 'Trilha de auditoria (quem autorizou/revogou e quando). Só acréscimo.';

-- ---------------------------------------------------------------------------
-- 2) Helpers internos (sem EXECUTE para clientes)
-- ---------------------------------------------------------------------------
create function public.whatsapp_signup_pilot_allowed(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.whatsapp_signup_pilot_companies p where p.company_id = p_company_id and p.authorized);
$$;

-- Há operação externa (registro do número na Meta) em curso ou de resultado incerto ligada a esta sessão? Enquanto houver, o token
-- da sessão NÃO é apagado (necessário para conferir/recuperar o estado); a limpeza ocorre depois que o registro é resolvido.
create function public.whatsapp_signup_external_op_open(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.whatsapp_registration_attempts a
      join public.whatsapp_number_registrations r on r.id = a.registration_id
     where a.session_id = p_session_id and r.state in ('in_progress', 'uncertain'));
$$;

-- Disponibilidade para UMA empresa: a trava global e, depois, a allowlist. (A versão sem argumento segue sendo só a trava global.)
create function public.whatsapp_signup_availability_for_company(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_av jsonb := public.whatsapp_signup_availability();
begin
  if not (v_av ->> 'available')::boolean then
    return v_av;
  end if;
  if not public.whatsapp_signup_pilot_allowed(p_company_id) then
    return jsonb_build_object('available', false, 'reason', 'company_not_authorized');
  end if;
  return v_av;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2b) Falha e varredura de sessões: iguais às de 20261105010000/20261106010000 + token preservado com operação externa em aberto
-- ---------------------------------------------------------------------------
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
  v_keep boolean;
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
  v_keep := public.whatsapp_signup_external_op_open(v_s.id);
  if v_s.token_secret_id is not null and not v_keep
     and not exists (select 1 from public.company_whatsapp_connections c where c.token_secret_id = v_s.token_secret_id) then
    delete from vault.secrets where id = v_s.token_secret_id and starts_with(name, 'wa_token_signup_');
    v_cleaned := true;
  end if;
  if v_s.status in ('pending', 'reserved') then
    if v_keep then
      -- operação externa em aberto: a sessão encerra, mas o token fica até o registro ser resolvido
      update public.whatsapp_signup_sessions set status = 'failed', error_code = v_code where id = v_s.id;
    else
      update public.whatsapp_signup_sessions
         set status = 'failed', error_code = v_code, token_secret_id = null, token_expires_at = null
       where id = v_s.id;
    end if;
    return jsonb_build_object('ok', true, 'status', 'failed', 'changed', true, 'token_kept', v_keep and v_s.token_secret_id is not null);
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
  v_keep boolean;
begin
  for v_row in
    select s.id, s.token_secret_id from public.whatsapp_signup_sessions s
     where s.status in ('pending', 'reserved') and s.expires_at <= now()
       and (p_company_id is null or s.company_id = p_company_id)
     for update
  loop
    v_keep := public.whatsapp_signup_external_op_open(v_row.id);
    if v_row.token_secret_id is not null and not v_keep
       and not exists (select 1 from public.company_whatsapp_connections c where c.token_secret_id = v_row.token_secret_id) then
      delete from vault.secrets where id = v_row.token_secret_id and starts_with(name, 'wa_token_signup_');
      v_secrets := v_secrets + 1;
    end if;
    v_sessions := v_sessions + 1;
    if v_keep then
      update public.whatsapp_signup_sessions set status = 'expired' where id = v_row.id;
    else
      update public.whatsapp_signup_sessions
         set status = 'expired', token_secret_id = null, token_expires_at = null
       where id = v_row.id;
    end if;
  end loop;

  -- sessões já encerradas que ainda guardam a referência (falha dentro de complete, ou token preservado durante operação externa)
  for v_row in
    select s.id, s.token_secret_id from public.whatsapp_signup_sessions s
     where s.status in ('failed', 'expired') and s.token_secret_id is not null
       and (p_company_id is null or s.company_id = p_company_id)
     for update
  loop
    if public.whatsapp_signup_external_op_open(v_row.id) then
      continue;
    end if;
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

-- ---------------------------------------------------------------------------
-- 3) Estado dos módulos para as telas: o bloco "signup" passa a considerar a empresa
-- ---------------------------------------------------------------------------
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
  v_signup := public.whatsapp_signup_availability_for_company(p_company_id);
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

-- ---------------------------------------------------------------------------
-- 4) Criar a sessão: igual à anterior + allowlist (depois da trava global)
-- ---------------------------------------------------------------------------
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
  v_av := public.whatsapp_signup_availability_for_company(p_company_id);
  if not (v_av ->> 'available')::boolean then
    if v_av ->> 'reason' = 'company_not_authorized' then
      raise exception 'Sua empresa ainda não foi liberada para a conexão automática do WhatsApp.' using errcode = 'PT409';
    end if;
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

-- ---------------------------------------------------------------------------
-- 5) Reservar (consumir) o state: igual ao anterior + allowlist conferida de novo no consumo
-- ---------------------------------------------------------------------------
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

  -- a autorização é conferida de novo no consumo (o papel ou a liberação do piloto podem ter mudado desde a criação)
  if not public.whatsapp_signup_pilot_allowed(v_s.company_id) then
    update public.whatsapp_signup_sessions set status = 'failed', error_code = 'company_not_authorized' where id = v_s.id;
    return jsonb_build_object('ok', false, 'error', 'company_not_authorized');
  end if;
  if not public.whatsapp_signup_user_can_manage(v_s.company_id, v_s.user_id) then
    update public.whatsapp_signup_sessions set status = 'failed', error_code = 'unauthorized' where id = v_s.id;
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  return jsonb_build_object('ok', true, 'session_id', v_s.id, 'company_id', v_s.company_id, 'user_id', v_s.user_id,
                            'expires_at', v_s.expires_at);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Concluir: igual ao anterior + allowlist (revogada no meio do caminho = não conclui)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 7) Admin Master: autorizar / revogar / consultar (SECURITY DEFINER, assert_master_admin primeiro)
-- ---------------------------------------------------------------------------
create function public.master_whatsapp_pilot_set(p_company_id uuid, p_authorized boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_note text := left(nullif(btrim(coalesce(p_note, '')), ''), 500);
  v_row public.whatsapp_signup_pilot_companies;
  v_closed integer := 0;
  v_sess record;
  v_changed boolean := false;
begin
  perform public.assert_master_admin();
  v_actor := auth.uid();
  if p_company_id is null or p_authorized is null then
    raise exception 'Parâmetros inválidos.' using errcode = 'PT400';
  end if;
  if not exists (select 1 from public.companies where id = p_company_id) then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('wa_signup:' || p_company_id::text, 0));
  select * into v_row from public.whatsapp_signup_pilot_companies where company_id = p_company_id for update;

  if p_authorized then
    if not found then
      insert into public.whatsapp_signup_pilot_companies (company_id, authorized, authorized_by, authorized_at, note)
      values (p_company_id, true, v_actor, now(), v_note);
      v_changed := true;
    elsif not v_row.authorized then
      update public.whatsapp_signup_pilot_companies
         set authorized = true, authorized_by = v_actor, authorized_at = now(), revoked_by = null, revoked_at = null,
             note = coalesce(v_note, note), updated_at = now()
       where company_id = p_company_id;
      v_changed := true;
    end if;
    if v_changed then
      insert into public.whatsapp_signup_pilot_events (company_id, action, actor_user_id, note) values (p_company_id, 'authorized', v_actor, v_note);
    end if;
  else
    if found and v_row.authorized then
      update public.whatsapp_signup_pilot_companies
         set authorized = false, revoked_by = v_actor, revoked_at = now(), updated_at = now()
       where company_id = p_company_id;
      insert into public.whatsapp_signup_pilot_events (company_id, action, actor_user_id, note) values (p_company_id, 'revoked', v_actor, v_note);
      v_changed := true;
      -- sessões em andamento não podem mais concluir; whatsapp_signup_fail só apaga o segredo ainda NÃO ligado a conexão
      for v_sess in
        select id from public.whatsapp_signup_sessions where company_id = p_company_id and status in ('pending', 'reserved')
      loop
        perform public.whatsapp_signup_fail(v_sess.id, 'pilot_revoked');
        v_closed := v_closed + 1;
      end loop;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'changed', v_changed, 'authorized', p_authorized, 'sessions_closed', v_closed);
end;
$$;

create function public.master_whatsapp_pilot_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_master_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'company_id', p.company_id, 'company_name', c.name, 'authorized', p.authorized,
             'authorized_by', p.authorized_by, 'authorized_at', p.authorized_at,
             'revoked_by', p.revoked_by, 'revoked_at', p.revoked_at, 'note', p.note,
             'connection_active', exists (select 1 from public.company_whatsapp_connections k where k.company_id = p.company_id and k.status = 'active'))
           order by p.updated_at desc)
      from public.whatsapp_signup_pilot_companies p
      join public.companies c on c.id = p.company_id), '[]'::jsonb);
end;
$$;

create function public.master_whatsapp_pilot_events(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_master_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object('action', e.action, 'actor_user_id', e.actor_user_id, 'note', e.note, 'at', e.created_at)
                     order by e.created_at desc)
      from public.whatsapp_signup_pilot_events e where e.company_id = p_company_id), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8) ACL explícita
-- ---------------------------------------------------------------------------
revoke execute on function public.whatsapp_signup_pilot_allowed(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.whatsapp_signup_availability_for_company(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.whatsapp_signup_external_op_open(uuid) from public, anon, authenticated, service_role;

revoke execute on function public.master_whatsapp_pilot_set(uuid, boolean, text) from public, anon, service_role;
revoke execute on function public.master_whatsapp_pilot_list() from public, anon, service_role;
revoke execute on function public.master_whatsapp_pilot_events(uuid) from public, anon, service_role;
grant execute on function public.master_whatsapp_pilot_set(uuid, boolean, text) to authenticated;
grant execute on function public.master_whatsapp_pilot_list() to authenticated;
grant execute on function public.master_whatsapp_pilot_events(uuid) to authenticated;

-- as funções redefinidas mantêm a ACL anterior (create or replace preserva), reafirmada aqui por segurança
revoke execute on function public.whatsapp_get_module_state(uuid) from public, anon, service_role;
grant execute on function public.whatsapp_get_module_state(uuid) to authenticated;
revoke execute on function public.whatsapp_signup_begin(uuid) from public, anon, service_role;
grant execute on function public.whatsapp_signup_begin(uuid) to authenticated;
revoke execute on function public.whatsapp_signup_reserve(text) from public, anon, authenticated;
grant execute on function public.whatsapp_signup_reserve(text) to service_role;
revoke execute on function public.whatsapp_signup_fail(uuid, text) from public, anon, authenticated;
grant execute on function public.whatsapp_signup_fail(uuid, text) to service_role;
revoke execute on function public.whatsapp_signup_sweep(uuid) from public, anon, authenticated;
grant execute on function public.whatsapp_signup_sweep(uuid) to service_role;
revoke execute on function public.whatsapp_signup_complete(uuid, text, text, text, text, text, timestamptz, timestamptz, text) from public, anon, authenticated;
grant execute on function public.whatsapp_signup_complete(uuid, text, text, text, text, text, timestamptz, timestamptz, text) to service_role;

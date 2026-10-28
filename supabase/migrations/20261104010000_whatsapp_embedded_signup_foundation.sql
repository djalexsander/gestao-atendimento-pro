-- WhatsApp Embedded Signup v4 — ETAPA 1: estrutura multiempresa e segurança (SOMENTE BANCO).
--
-- Aditiva: nenhuma coluna, índice, constraint ou política existente é removida. Nada aqui liga o botão de conexão
-- (whatsapp_platform_settings.embedded_signup_enabled continua como está, desligado), muda o webhook, o envio, a IA, planos ou módulos.
--
-- 1) company_whatsapp_connections ganha metadados da origem/saúde da conexão. Conexões antigas (manuais) ficam com
--    connection_source='manual', connection_type='cloud_api', token_status='unknown' e o restante nulo.
-- 2) whatsapp_signup_sessions: sessão curta (10 min) de conexão, ligada a UMA empresa e UM usuário. O state é aleatório (64 hex) e só o
--    HASH SHA-256 é guardado. Ciclo: pending -> reserved (consumo atômico, anti-replay) -> completed | failed | expired | cancelled.
-- 3) RPCs. Criar sessão = authenticated (owner/admin + módulo whatsapp + plataforma liberada). As demais = SÓ service_role, chamadas
--    pelo backend (Edge) DEPOIS de validar tudo na Meta; nenhum identificador vindo do navegador é prova de propriedade do número.
--    O token da Meta é gravado no Vault pela RPC whatsapp_signup_store_token; a conexão só recebe a REFERÊNCIA (token_secret_id) lida da
--    própria sessão, nunca um id enviado na conclusão.
-- 4) A tabela whatsapp_signup_attempts (20261028010000) permanece intacta e sem uso; whatsapp_signup_begin passa a criar a sessão nova
--    com o mesmo formato de retorno (state, meta_app_id, config_id).
--
-- Mantém: uma conexão ATIVA por empresa (índice parcial existente). Sem múltiplos números e sem Coexistence nesta etapa.

-- ---------------------------------------------------------------------------
-- 1) Colunas novas (valores padrão compatíveis com as conexões existentes)
-- ---------------------------------------------------------------------------
alter table public.company_whatsapp_connections
  add column connection_source text not null default 'manual'
    constraint company_whatsapp_connections_source_check check (connection_source in ('manual', 'embedded_signup')),
  add column connection_type text not null default 'cloud_api'
    constraint company_whatsapp_connections_type_check check (connection_type in ('cloud_api', 'coexistence')),
  add column meta_business_id text
    constraint company_whatsapp_connections_meta_business_check check (meta_business_id is null or meta_business_id ~ '^[0-9]{5,40}$'),
  add column token_expires_at timestamptz,
  add column token_status text not null default 'unknown'
    constraint company_whatsapp_connections_token_status_check check (token_status in ('unknown', 'valid', 'expiring', 'expired', 'revoked', 'error')),
  add column registered_at timestamptz,
  add column webhook_subscribed_at timestamptz,
  add column last_error_code text
    constraint company_whatsapp_connections_error_code_check check (last_error_code is null or last_error_code ~ '^[A-Za-z0-9_.:-]{1,60}$');

comment on column public.company_whatsapp_connections.token_status is
  'Saúde do token no Vault: unknown (conexões antigas), valid, expiring, expired, revoked ou error. Não altera o status da conexão.';

-- ---------------------------------------------------------------------------
-- 2) Sessões de Embedded Signup
-- ---------------------------------------------------------------------------
create table public.whatsapp_signup_sessions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- SHA-256 (hex) do state entregue ao navegador. O state em claro nunca é gravado.
  state_hash text not null
    constraint whatsapp_signup_sessions_hash_check check (state_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending'
    constraint whatsapp_signup_sessions_status_check check (status in ('pending', 'reserved', 'completed', 'failed', 'expired', 'cancelled')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  reserved_at timestamptz,
  completed_at timestamptz,
  -- referência ao segredo no Vault gravado para esta sessão (NUNCA o token) e validade informada pela Meta.
  token_secret_id uuid,
  token_expires_at timestamptz,
  connection_id uuid references public.company_whatsapp_connections(id) on delete set null,
  error_code text
    constraint whatsapp_signup_sessions_error_code_check check (error_code is null or error_code ~ '^[A-Za-z0-9_.:-]{1,60}$'),
  updated_at timestamptz not null default now(),
  constraint whatsapp_signup_sessions_state_hash_key unique (state_hash),
  constraint whatsapp_signup_sessions_ttl_check check (expires_at > created_at and expires_at <= created_at + interval '30 minutes'),
  constraint whatsapp_signup_sessions_completed_check check ((status = 'completed') = (completed_at is not null)),
  constraint whatsapp_signup_sessions_reserved_check check (status not in ('reserved', 'completed') or reserved_at is not null)
);

create index whatsapp_signup_sessions_company_idx on public.whatsapp_signup_sessions (company_id, created_at desc);

create trigger whatsapp_signup_sessions_set_updated_at
  before update on public.whatsapp_signup_sessions
  for each row execute function public.set_updated_at();

alter table public.whatsapp_signup_sessions enable row level security;
revoke all on public.whatsapp_signup_sessions from public, anon, authenticated;
grant all on public.whatsapp_signup_sessions to service_role;

comment on table public.whatsapp_signup_sessions is
  'Sessões curtas de conexão por Embedded Signup. Sem acesso do cliente; escrita só por RPC. Guarda o hash do state, nunca o state, o code ou o token.';

-- ---------------------------------------------------------------------------
-- 3) Helper interno: o usuário (por id, sem auth.uid()) é owner/admin ativo da empresa COM o módulo whatsapp?
-- ---------------------------------------------------------------------------
create function public.whatsapp_signup_user_can_manage(p_company_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
           select 1 from public.company_users cu
            where cu.company_id = p_company_id and cu.user_id = p_user_id
              and cu.status = 'active' and cu.role in ('owner', 'admin'))
     and public.company_has_module(p_company_id, 'whatsapp');
$$;

-- ---------------------------------------------------------------------------
-- 4) Criar a sessão (substitui o corpo de whatsapp_signup_begin; mesmo formato de retorno)
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

-- ---------------------------------------------------------------------------
-- 5) Reservar (consumir) a sessão: atômico, uma única vez. Chamada pelo backend com o state recebido do navegador.
-- ---------------------------------------------------------------------------
create function public.whatsapp_signup_reserve(p_state text)
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

-- ---------------------------------------------------------------------------
-- 6) Guardar o token no Vault e ligá-lo à sessão. Devolve só a referência.
-- ---------------------------------------------------------------------------
create function public.whatsapp_signup_store_token(p_session_id uuid, p_token text, p_expires_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.whatsapp_signup_sessions;
  v_secret uuid;
begin
  if p_token is null or char_length(btrim(p_token)) < 20 or char_length(p_token) > 4000 then
    raise exception 'Token inválido.' using errcode = 'PT400';
  end if;
  select * into v_s from public.whatsapp_signup_sessions where id = p_session_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'session_not_found');
  end if;
  if v_s.status <> 'reserved' or v_s.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'session_not_reserved');
  end if;
  if v_s.token_secret_id is not null then
    return jsonb_build_object('ok', false, 'error', 'token_already_stored');
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'token_already_expired');
  end if;

  v_secret := vault.create_secret(p_token, 'wa_token_signup_' || v_s.id::text, 'WhatsApp Embedded Signup');
  update public.whatsapp_signup_sessions
     set token_secret_id = v_secret, token_expires_at = p_expires_at
   where id = v_s.id;
  -- a referência NÃO sai do banco: a conclusão a lê da própria sessão
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) Falha da sessão (idempotente). Remove o segredo que ainda não foi ligado a nenhuma conexão.
-- ---------------------------------------------------------------------------
create function public.whatsapp_signup_fail(p_session_id uuid, p_error_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.whatsapp_signup_sessions;
  v_code text := coalesce(nullif(btrim(p_error_code), ''), 'unknown');
begin
  if v_code !~ '^[A-Za-z0-9_.:-]{1,60}$' then
    v_code := 'invalid_code';
  end if;
  select * into v_s from public.whatsapp_signup_sessions where id = p_session_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'session_not_found');
  end if;
  if v_s.status not in ('pending', 'reserved') then
    return jsonb_build_object('ok', true, 'status', v_s.status, 'changed', false);
  end if;
  if v_s.token_secret_id is not null
     and not exists (select 1 from public.company_whatsapp_connections c where c.token_secret_id = v_s.token_secret_id) then
    delete from vault.secrets where id = v_s.token_secret_id;
  end if;
  update public.whatsapp_signup_sessions
     set status = 'failed', error_code = v_code, token_secret_id = null, token_expires_at = null
   where id = v_s.id;
  return jsonb_build_object('ok', true, 'status', 'failed', 'changed', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7b) Varredura: vence as sessões atrasadas e apaga segredos que ficaram órfãos (backend caiu entre store_token e complete).
--     Usada por whatsapp_signup_begin e disponível ao backend/cron (service_role). Segredo ligado a uma conexão nunca é apagado.
-- ---------------------------------------------------------------------------
create function public.whatsapp_signup_sweep(p_company_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secrets integer := 0;
  v_sessions integer := 0;
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
      delete from vault.secrets where id = v_row.token_secret_id;
      v_secrets := v_secrets + 1;
    end if;
    v_sessions := v_sessions + 1;
    update public.whatsapp_signup_sessions
       set status = 'expired', token_secret_id = null, token_expires_at = null
     where id = v_row.id;
  end loop;
  return jsonb_build_object('ok', true, 'sessions_expired', v_sessions, 'secrets_removed', v_secrets);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8) Concluir: registra/atualiza a conexão com dados JÁ VALIDADOS pelo backend na Meta.
-- ---------------------------------------------------------------------------
create function public.whatsapp_signup_complete(
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

-- ---------------------------------------------------------------------------
-- 9) Saúde do token / último erro da conexão (não altera o status da conexão nem desliga o recebimento)
-- ---------------------------------------------------------------------------
create function public.whatsapp_connection_set_health(
  p_connection_id uuid,
  p_token_status text,
  p_error_code text default null,
  p_token_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := nullif(btrim(coalesce(p_error_code, '')), '');
begin
  if p_token_status is null or p_token_status not in ('valid', 'expiring', 'expired', 'revoked', 'error') then
    raise exception 'Status do token inválido.' using errcode = 'PT400';
  end if;
  if v_code is not null and v_code !~ '^[A-Za-z0-9_.:-]{1,60}$' then
    raise exception 'Código de erro inválido.' using errcode = 'PT400';
  end if;
  update public.company_whatsapp_connections
     set token_status = p_token_status,
         last_error_code = v_code,
         token_expires_at = coalesce(p_token_expires_at, token_expires_at)
   where id = p_connection_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'connection_not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 10) ACL explícita
-- ---------------------------------------------------------------------------
revoke execute on function public.whatsapp_signup_user_can_manage(uuid, uuid) from public, anon, authenticated, service_role;
revoke execute on function public.whatsapp_signup_begin(uuid) from public, anon, service_role;
grant execute on function public.whatsapp_signup_begin(uuid) to authenticated;

revoke execute on function public.whatsapp_signup_reserve(text) from public, anon, authenticated;
revoke execute on function public.whatsapp_signup_store_token(uuid, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.whatsapp_signup_fail(uuid, text) from public, anon, authenticated;
revoke execute on function public.whatsapp_signup_sweep(uuid) from public, anon, authenticated;
revoke execute on function public.whatsapp_signup_complete(uuid, text, text, text, text, text, timestamptz, timestamptz, text) from public, anon, authenticated;
revoke execute on function public.whatsapp_connection_set_health(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.whatsapp_signup_reserve(text) to service_role;
grant execute on function public.whatsapp_signup_store_token(uuid, text, timestamptz) to service_role;
grant execute on function public.whatsapp_signup_fail(uuid, text) to service_role;
grant execute on function public.whatsapp_signup_sweep(uuid) to service_role;
grant execute on function public.whatsapp_signup_complete(uuid, text, text, text, text, text, timestamptz, timestamptz, text) to service_role;
grant execute on function public.whatsapp_connection_set_health(uuid, text, text, timestamptz) to service_role;

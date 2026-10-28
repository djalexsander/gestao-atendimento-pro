-- WhatsApp Embedded Signup v4 — ETAPA 3: PIN INDIVIDUAL de verificação em duas etapas, no Vault, por número.
--
-- Substitui o PIN derivado por HMAC (que nunca foi para produção: o secret WHATSAPP_REGISTRATION_PIN_SECRET não existe) por:
--   * um PIN aleatório de 6 dígitos POR NÚMERO, gerado no backend com CSPRNG e guardado no Supabase Vault;
--   * o PIN já existente do cliente, quando o número já tem verificação em duas etapas (nunca sobrescrito automaticamente);
--   * rastreio do estado do registro na Meta por número e auditoria de cada tentativa (sem PIN);
--   * recuperação administrativa em DUAS etapas: autorização por usuário (owner/admin, módulo, autenticação recente, limite de
--     consultas) e consumo único só pelo backend (service_role). Nenhuma RPC acessível ao cliente devolve o PIN.
--
-- Aditiva: nada existente é removido nem alterado (whatsapp_signup_sweep é redefinida só para também varrer PINs abandonados).
-- Funções que devolvem PIN (só service_role): whatsapp_registration_begin_attempt (PIN da tentativa) e whatsapp_pin_reveal_consume
-- (ticket autorizado). Não há leitura avulsa de PIN.
-- Fatos da Meta usados (documentação oficial): PIN de 6 dígitos; número com verificação em duas etapas exige o PIN existente no
-- registro; erros 133005 (PIN incorreto), 133008/133009 (excesso/pressa de tentativas), 133016 (limite de 10 registros em 72 h por
-- número), 133015, 133006, 133010. NÃO confirmados e portanto NÃO usados: campo de status de registro e endpoint de troca de PIN.

-- ---------------------------------------------------------------------------
-- 1) Registro por número (PIN + estado). Uma linha por phone_number_id, da empresa que o conectou.
-- ---------------------------------------------------------------------------
create table public.whatsapp_number_registrations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  phone_number_id text not null
    constraint whatsapp_number_registrations_pnid_check check (phone_number_id ~ '^[0-9]{5,40}$'),
  waba_id text
    constraint whatsapp_number_registrations_waba_check check (waba_id is null or waba_id ~ '^[0-9]{5,40}$'),
  -- pending: ainda sem tentativa | in_progress: chamada à Meta em curso | registered: concluído | uncertain: resultado desconhecido
  -- (NUNCA retenta sozinho) | failed: falha definitiva, pode tentar de novo | pin_required: o número já tem PIN e o cliente precisa
  -- informá-lo | blocked: limite/ excesso de tentativas até blocked_until
  state text not null default 'pending'
    constraint whatsapp_number_registrations_state_check check (state in ('pending', 'in_progress', 'registered', 'uncertain', 'failed', 'pin_required', 'blocked')),
  -- referência ao segredo no Vault (wa_pin_*). NUNCA o PIN.
  pin_secret_id uuid,
  pin_source text
    constraint whatsapp_number_registrations_source_check check (pin_source is null or pin_source in ('generated', 'customer')),
  registered_at timestamptz,
  blocked_until timestamptz,
  last_error_code text
    constraint whatsapp_number_registrations_error_check check (last_error_code is null or last_error_code ~ '^[A-Za-z0-9_.:-]{1,60}$'),
  connection_id uuid references public.company_whatsapp_connections(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_number_registrations_phone_key unique (phone_number_id),
  constraint whatsapp_number_registrations_pin_pair check ((pin_secret_id is null) = (pin_source is null)),
  constraint whatsapp_number_registrations_registered_check check (state <> 'registered' or registered_at is not null),
  constraint whatsapp_number_registrations_blocked_check check (state <> 'blocked' or blocked_until is not null)
);
create index whatsapp_number_registrations_company_idx on public.whatsapp_number_registrations (company_id);
create trigger whatsapp_number_registrations_set_updated_at
  before update on public.whatsapp_number_registrations
  for each row execute function public.set_updated_at();
alter table public.whatsapp_number_registrations enable row level security;
revoke all on public.whatsapp_number_registrations from public, anon, authenticated;
grant all on public.whatsapp_number_registrations to service_role;

-- Auditoria de cada chamada de registro (sem PIN)
create table public.whatsapp_registration_attempts (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references public.whatsapp_number_registrations(id) on delete cascade,
  session_id uuid references public.whatsapp_signup_sessions(id) on delete set null,
  status text not null default 'started'
    constraint whatsapp_registration_attempts_status_check check (status in ('started', 'success', 'pin_incorrect', 'rate_limited', 'too_many_guesses', 'failed', 'uncertain', 'manual_registered', 'manual_failed')),
  pin_source text
    constraint whatsapp_registration_attempts_source_check check (pin_source is null or pin_source in ('generated', 'customer')),
  meta_code text
    constraint whatsapp_registration_attempts_code_check check (meta_code is null or meta_code ~ '^[A-Za-z0-9_.:-]{1,60}$'),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index whatsapp_registration_attempts_reg_idx on public.whatsapp_registration_attempts (registration_id, started_at desc);
alter table public.whatsapp_registration_attempts enable row level security;
revoke all on public.whatsapp_registration_attempts from public, anon, authenticated;
grant all on public.whatsapp_registration_attempts to service_role;

-- Solicitações de revelação do PIN (auditoria + ticket de uso único). Sem o PIN.
create table public.whatsapp_pin_reveal_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  registration_id uuid not null references public.whatsapp_number_registrations(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete cascade,
  reason text not null
    constraint whatsapp_pin_reveal_requests_reason_check check (char_length(btrim(reason)) between 5 and 200),
  status text not null default 'authorized'
    constraint whatsapp_pin_reveal_requests_status_check check (status in ('authorized', 'consumed', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '2 minutes',
  consumed_at timestamptz,
  constraint whatsapp_pin_reveal_requests_consumed_check check ((status = 'consumed') = (consumed_at is not null))
);
create index whatsapp_pin_reveal_requests_company_idx on public.whatsapp_pin_reveal_requests (company_id, created_at desc);
create index whatsapp_pin_reveal_requests_user_idx on public.whatsapp_pin_reveal_requests (requested_by, created_at desc);
alter table public.whatsapp_pin_reveal_requests enable row level security;
revoke all on public.whatsapp_pin_reveal_requests from public, anon, authenticated;
grant all on public.whatsapp_pin_reveal_requests to service_role;

-- Empresa/registro apagados levam junto o segredo do PIN no Vault (nunca o de outro registro).
create function public.whatsapp_registration_drop_secret()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.pin_secret_id is not null then
    delete from vault.secrets where id = old.pin_secret_id and starts_with(name, 'wa_pin_');
  end if;
  return old;
end;
$$;
create trigger whatsapp_number_registrations_drop_secret
  after delete on public.whatsapp_number_registrations
  for each row execute function public.whatsapp_registration_drop_secret();

-- Sessão e registro precisam ser da mesma empresa; a sessão precisa estar reservada e dentro do prazo.
create function public.whatsapp_registration_check_session(p_session_id uuid, p_registration_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_s public.whatsapp_signup_sessions;
  v_r public.whatsapp_number_registrations;
begin
  select * into v_s from public.whatsapp_signup_sessions where id = p_session_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'session_not_found');
  end if;
  if v_s.status <> 'reserved' or v_s.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'session_not_reserved');
  end if;
  select * into v_r from public.whatsapp_number_registrations where id = p_registration_id;
  if not found or v_r.company_id <> v_s.company_id then
    return jsonb_build_object('ok', false, 'error', 'registration_not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) Preparar o registro do número (decide o que o backend deve fazer; não devolve PIN)
-- ---------------------------------------------------------------------------
create function public.whatsapp_registration_prepare(p_session_id uuid, p_phone_number_id text, p_waba_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.whatsapp_signup_sessions;
  v_r public.whatsapp_number_registrations;
  v_action text;
begin
  if p_phone_number_id is null or p_phone_number_id !~ '^[0-9]{5,40}$' or (p_waba_id is not null and p_waba_id !~ '^[0-9]{5,40}$') then
    raise exception 'Identificadores da Meta inválidos.' using errcode = 'PT400';
  end if;
  select * into v_s from public.whatsapp_signup_sessions where id = p_session_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'session_not_found');
  end if;
  if v_s.status <> 'reserved' or v_s.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'session_not_reserved');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('wa_reg:' || p_phone_number_id, 0));
  select * into v_r from public.whatsapp_number_registrations where phone_number_id = p_phone_number_id for update;
  if not found then
    insert into public.whatsapp_number_registrations (company_id, phone_number_id, waba_id)
    values (v_s.company_id, p_phone_number_id, p_waba_id)
    returning * into v_r;
  elsif v_r.company_id <> v_s.company_id then
    return jsonb_build_object('ok', false, 'error', 'phone_in_use');
  elsif p_waba_id is not null and v_r.waba_id is distinct from p_waba_id then
    update public.whatsapp_number_registrations set waba_id = p_waba_id where id = v_r.id returning * into v_r;
  end if;

  -- chamada que ficou em andamento sem resposta: resultado desconhecido (nunca retenta sozinho)
  if v_r.state = 'in_progress' and v_r.updated_at < now() - interval '2 minutes' then
    update public.whatsapp_number_registrations set state = 'uncertain' where id = v_r.id returning * into v_r;
  end if;
  -- bloqueio vencido: sem PIN guardado (o usado estava errado) volta a exigir o PIN do cliente; com PIN, pode tentar de novo
  if v_r.state = 'blocked' and v_r.blocked_until <= now() then
    update public.whatsapp_number_registrations
       set state = case when pin_secret_id is null then 'pin_required' else 'failed' end, blocked_until = null
     where id = v_r.id returning * into v_r;
  end if;

  if v_r.state = 'registered' then
    v_action := 'skip';
  elsif v_r.state = 'pin_required' then
    v_action := 'need_customer_pin';
  elsif v_r.state in ('pending', 'failed') then
    v_action := 'register';
  elsif v_r.state = 'blocked' then
    return jsonb_build_object('ok', false, 'error', 'registration_blocked', 'blocked_until', v_r.blocked_until);
  elsif v_r.state = 'in_progress' then
    return jsonb_build_object('ok', false, 'error', 'registration_in_progress');
  else
    return jsonb_build_object('ok', false, 'error', 'registration_uncertain');
  end if;

  return jsonb_build_object('ok', true, 'registration_id', v_r.id, 'action', v_action, 'state', v_r.state,
                            'has_stored_pin', v_r.pin_secret_id is not null, 'registered_at', v_r.registered_at);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Guardar o PIN (gerado pelo backend ou informado pelo cliente) no Vault. Nunca sobrescreve um PIN já registrado na Meta.
-- ---------------------------------------------------------------------------
create function public.whatsapp_registration_store_pin(p_session_id uuid, p_registration_id uuid, p_pin text, p_source text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chk jsonb;
  v_r public.whatsapp_number_registrations;
  v_secret uuid;
  v_old uuid;
begin
  if p_pin is null or p_pin !~ '^[0-9]{6}$' or p_source is null or p_source not in ('generated', 'customer') then
    raise exception 'PIN inválido.' using errcode = 'PT400';
  end if;
  v_chk := public.whatsapp_registration_check_session(p_session_id, p_registration_id);
  if (v_chk ->> 'ok')::boolean is not true then
    return v_chk;
  end if;
  select * into v_r from public.whatsapp_number_registrations where id = p_registration_id for update;
  if v_r.state not in ('pending', 'failed', 'pin_required') then
    return jsonb_build_object('ok', false, 'error', 'state_not_allowed', 'state', v_r.state);
  end if;
  if p_source = 'generated' and v_r.pin_secret_id is not null then
    -- outra sessão já guardou um PIN para este número: o gerado agora seria perdido; o backend usa o que está no Vault
    return jsonb_build_object('ok', false, 'error', 'pin_already_stored');
  end if;
  v_old := v_r.pin_secret_id;
  v_secret := vault.create_secret(p_pin, 'wa_pin_' || v_r.id::text || '_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8), 'WhatsApp registration PIN');
  update public.whatsapp_number_registrations
     set pin_secret_id = v_secret, pin_source = p_source,
         state = case when state = 'pin_required' then 'pending' else state end
   where id = v_r.id;
  if v_old is not null then
    delete from vault.secrets where id = v_old and starts_with(name, 'wa_pin_');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Tentativa de registro: limite próprio (3 por número em 72 h, abaixo dos 10 da Meta), uma por vez, auditada.
--    Devolve ao backend (service_role) o PIN do Vault para usar NESTA chamada à Meta; nada disso chega ao cliente.
-- ---------------------------------------------------------------------------
create function public.whatsapp_registration_begin_attempt(p_session_id uuid, p_registration_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chk jsonb;
  v_r public.whatsapp_number_registrations;
  v_recent integer;
  v_oldest timestamptz;
  v_attempt uuid;
  v_pin text;
begin
  v_chk := public.whatsapp_registration_check_session(p_session_id, p_registration_id);
  if (v_chk ->> 'ok')::boolean is not true then
    return v_chk;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('wa_regattempt:' || p_registration_id::text, 0));
  select * into v_r from public.whatsapp_number_registrations where id = p_registration_id for update;
  if v_r.state = 'registered' then
    return jsonb_build_object('ok', false, 'error', 'already_registered');
  elsif v_r.state = 'in_progress' then
    return jsonb_build_object('ok', false, 'error', 'registration_in_progress');
  elsif v_r.state = 'uncertain' then
    return jsonb_build_object('ok', false, 'error', 'registration_uncertain');
  elsif v_r.state = 'blocked' then
    return jsonb_build_object('ok', false, 'error', 'registration_blocked', 'blocked_until', v_r.blocked_until);
  elsif v_r.state = 'pin_required' or v_r.pin_secret_id is null then
    return jsonb_build_object('ok', false, 'error', 'pin_required');
  end if;
  select count(*), min(started_at) into v_recent, v_oldest
    from public.whatsapp_registration_attempts
   where registration_id = v_r.id and started_at > now() - interval '72 hours';
  if v_recent >= 3 then
    return jsonb_build_object('ok', false, 'error', 'attempts_exhausted', 'retry_after', v_oldest + interval '72 hours');
  end if;
  -- o PIN é lido AQUI, sob o lock do registro: é exatamente o que está no Vault no instante em que a tentativa começa
  select decrypted_secret into v_pin from vault.decrypted_secrets where id = v_r.pin_secret_id;
  if v_pin is null or v_pin !~ '^[0-9]{6}$' then
    return jsonb_build_object('ok', false, 'error', 'pin_not_available');
  end if;
  insert into public.whatsapp_registration_attempts (registration_id, session_id, pin_source)
  values (v_r.id, p_session_id, v_r.pin_source)
  returning id into v_attempt;
  update public.whatsapp_number_registrations set state = 'in_progress' where id = v_r.id;
  return jsonb_build_object('ok', true, 'attempt_id', v_attempt, 'pin', v_pin, 'pin_source', v_r.pin_source);
end;
$$;

-- Resultado da tentativa. Idempotente: uma tentativa só é finalizada uma vez.
create function public.whatsapp_registration_finish_attempt(p_attempt_id uuid, p_outcome text, p_meta_code text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_a public.whatsapp_registration_attempts;
  v_r public.whatsapp_number_registrations;
  v_code text := nullif(btrim(coalesce(p_meta_code, '')), '');
begin
  if p_outcome is null or p_outcome not in ('success', 'pin_incorrect', 'rate_limited', 'too_many_guesses', 'failed', 'uncertain') then
    raise exception 'Resultado inválido.' using errcode = 'PT400';
  end if;
  if v_code is not null and v_code !~ '^[A-Za-z0-9_.:-]{1,60}$' then
    v_code := 'invalid_code';
  end if;
  select * into v_a from public.whatsapp_registration_attempts where id = p_attempt_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'attempt_not_found');
  end if;
  select * into v_r from public.whatsapp_number_registrations where id = v_a.registration_id for update;
  if v_a.status <> 'started' then
    return jsonb_build_object('ok', true, 'state', v_r.state, 'idempotent', true);
  end if;
  update public.whatsapp_registration_attempts set status = p_outcome, meta_code = v_code, finished_at = now() where id = v_a.id;

  if p_outcome = 'success' then
    update public.whatsapp_number_registrations
       set state = 'registered', registered_at = now(), blocked_until = null, last_error_code = null where id = v_r.id;
  elsif p_outcome = 'pin_incorrect' then
    -- o PIN usado não é o do número: descarta o segredo e passa a exigir o PIN do cliente (nunca sobrescreve o da Meta)
    if v_r.pin_secret_id is not null then
      delete from vault.secrets where id = v_r.pin_secret_id and starts_with(name, 'wa_pin_');
    end if;
    update public.whatsapp_number_registrations
       set state = 'pin_required', pin_secret_id = null, pin_source = null, last_error_code = v_code where id = v_r.id;
  elsif p_outcome = 'rate_limited' then
    update public.whatsapp_number_registrations
       set state = 'blocked', blocked_until = now() + interval '72 hours', last_error_code = v_code where id = v_r.id;
  elsif p_outcome = 'too_many_guesses' then
    -- política própria (a duração real vem nos detalhes do erro da Meta): 1 h; o PIN usado estava errado e é descartado
    if v_r.pin_secret_id is not null then
      delete from vault.secrets where id = v_r.pin_secret_id and starts_with(name, 'wa_pin_');
    end if;
    update public.whatsapp_number_registrations
       set state = 'blocked', blocked_until = now() + interval '1 hour', pin_secret_id = null, pin_source = null, last_error_code = v_code where id = v_r.id;
  elsif p_outcome = 'failed' then
    update public.whatsapp_number_registrations set state = 'failed', last_error_code = v_code where id = v_r.id;
  else
    update public.whatsapp_number_registrations set state = 'uncertain', last_error_code = v_code where id = v_r.id;
  end if;
  return jsonb_build_object('ok', true, 'state', (select state from public.whatsapp_number_registrations where id = v_r.id), 'idempotent', false);
end;
$$;

-- Recuperação operacional de um registro 'uncertain'/'in_progress' depois de conferência humana (service_role).
create function public.whatsapp_registration_resolve(p_registration_id uuid, p_outcome text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
$$;

-- Associa o registro à conexão criada pela sessão concluída (mesma empresa e mesmo número).
create function public.whatsapp_registration_link(p_session_id uuid, p_registration_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.whatsapp_signup_sessions;
  v_r public.whatsapp_number_registrations;
  v_c public.company_whatsapp_connections;
begin
  select * into v_s from public.whatsapp_signup_sessions where id = p_session_id;
  select * into v_r from public.whatsapp_number_registrations where id = p_registration_id for update;
  if v_s.id is null or v_r.id is null or v_s.status <> 'completed' or v_s.connection_id is null or v_r.company_id <> v_s.company_id then
    return jsonb_build_object('ok', false, 'error', 'cannot_link');
  end if;
  select * into v_c from public.company_whatsapp_connections where id = v_s.connection_id;
  if not found or v_c.company_id <> v_r.company_id or v_c.phone_number_id is distinct from v_r.phone_number_id then
    return jsonb_build_object('ok', false, 'error', 'cannot_link');
  end if;
  update public.whatsapp_number_registrations set connection_id = v_c.id where id = v_r.id;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Revelação do PIN: autorização (usuário) + consumo único (backend). Nada devolve o PIN ao cliente.
-- ---------------------------------------------------------------------------
create function public.whatsapp_pin_reveal_authorize(p_connection_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conn public.company_whatsapp_connections;
  v_r public.whatsapp_number_registrations;
  v_role public.company_role;
  v_claims jsonb;
  v_recent boolean := false;
  v_id uuid;
  v_expires timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_conn from public.company_whatsapp_connections where id = p_connection_id;
  if not found then
    raise exception 'Conexão não encontrada.' using errcode = 'PT404';
  end if;
  v_role := public.user_role_in_company(v_conn.company_id);
  if v_role is null then
    raise exception 'Conexão não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Somente o proprietário ou administrador pode consultar o PIN.' using errcode = 'PT403';
  end if;
  perform public.assert_company_module(v_conn.company_id, 'whatsapp');
  if p_reason is null or char_length(btrim(p_reason)) not between 5 and 200 then
    raise exception 'Informe o motivo da consulta (5 a 200 caracteres).' using errcode = 'PT400';
  end if;

  -- autenticação RECENTE: o JWT precisa trazer um login (amr) feito nos últimos 5 minutos
  begin
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then
    v_claims := null;
  end;
  if v_claims is not null and jsonb_typeof(v_claims -> 'amr') = 'array' then
    select exists (
             select 1 from jsonb_array_elements(v_claims -> 'amr') e
              where jsonb_typeof(e -> 'timestamp') = 'number' and (e ->> 'timestamp')::numeric >= extract(epoch from now()) - 300)
      into v_recent;
  end if;
  if not v_recent then
    raise exception 'Confirme sua senha novamente para consultar o PIN.' using errcode = 'PT401';
  end if;

  select * into v_r from public.whatsapp_number_registrations
   where company_id = v_conn.company_id and phone_number_id = v_conn.phone_number_id;
  if not found or v_r.pin_secret_id is null then
    raise exception 'Não há PIN guardado para este número.' using errcode = 'PT404';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('wa_reveal:' || v_conn.company_id::text, 0));
  if (select count(*) from public.whatsapp_pin_reveal_requests where company_id = v_conn.company_id and created_at > now() - interval '1 hour') >= 3
     or (select count(*) from public.whatsapp_pin_reveal_requests where requested_by = auth.uid() and created_at > now() - interval '1 day') >= 10 then
    raise exception 'Limite de consultas do PIN atingido. Tente mais tarde.' using errcode = 'PT429';
  end if;
  update public.whatsapp_pin_reveal_requests set status = 'expired'
   where company_id = v_conn.company_id and status = 'authorized';

  insert into public.whatsapp_pin_reveal_requests (company_id, registration_id, requested_by, reason)
  values (v_conn.company_id, v_r.id, auth.uid(), btrim(p_reason))
  returning id, expires_at into v_id, v_expires;
  return jsonb_build_object('grant_id', v_id, 'expires_at', v_expires);
end;
$$;

-- Consumo único (service_role): o backend troca o ticket pelo PIN para exibi-lo UMA vez ao mesmo usuário.
create function public.whatsapp_pin_reveal_consume(p_grant_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_g public.whatsapp_pin_reveal_requests;
  v_r public.whatsapp_number_registrations;
  v_pin text;
begin
  select * into v_g from public.whatsapp_pin_reveal_requests where id = p_grant_id for update;
  if not found or v_g.requested_by is distinct from p_user_id then
    return jsonb_build_object('ok', false, 'error', 'grant_not_found');
  end if;
  if v_g.status <> 'authorized' then
    return jsonb_build_object('ok', false, 'error', 'grant_used');
  end if;
  if v_g.expires_at <= now() then
    update public.whatsapp_pin_reveal_requests set status = 'expired' where id = v_g.id;
    return jsonb_build_object('ok', false, 'error', 'grant_expired');
  end if;
  if not public.whatsapp_signup_user_can_manage(v_g.company_id, p_user_id) then
    update public.whatsapp_pin_reveal_requests set status = 'expired' where id = v_g.id;
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  select * into v_r from public.whatsapp_number_registrations where id = v_g.registration_id;
  if not found or v_r.company_id <> v_g.company_id or v_r.pin_secret_id is null then
    return jsonb_build_object('ok', false, 'error', 'pin_not_available');
  end if;
  select decrypted_secret into v_pin from vault.decrypted_secrets where id = v_r.pin_secret_id;
  if v_pin is null then
    return jsonb_build_object('ok', false, 'error', 'pin_not_available');
  end if;
  update public.whatsapp_pin_reveal_requests set status = 'consumed', consumed_at = now() where id = v_g.id;
  return jsonb_build_object('ok', true, 'pin', v_pin);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Limpeza de PINs abandonados + whatsapp_signup_sweep passa a chamá-la
-- ---------------------------------------------------------------------------
-- Só PIN de registro NUNCA concluído e parado há mais de 7 dias, sem conexão. Nunca: registered, uncertain, in_progress, blocked
-- (o PIN pode ter sido aceito pela Meta) nem qualquer registro ligado a conexão.
create function public.whatsapp_registration_sweep()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_removed integer := 0;
  v_row record;
begin
  for v_row in
    select r.id, r.pin_secret_id from public.whatsapp_number_registrations r
     where r.pin_secret_id is not null and r.state in ('pending', 'failed', 'pin_required')
       and r.connection_id is null and r.updated_at < now() - interval '7 days'
       and not exists (select 1 from public.company_whatsapp_connections c where c.company_id = r.company_id and c.phone_number_id = r.phone_number_id)
     for update
  loop
    delete from vault.secrets where id = v_row.pin_secret_id and starts_with(name, 'wa_pin_');
    update public.whatsapp_number_registrations set pin_secret_id = null, pin_source = null where id = v_row.id;
    v_removed := v_removed + 1;
  end loop;
  update public.whatsapp_pin_reveal_requests set status = 'expired' where status = 'authorized' and expires_at <= now();
  return jsonb_build_object('ok', true, 'pins_removed', v_removed);
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

-- ---------------------------------------------------------------------------
-- 7) ACL explícita
-- ---------------------------------------------------------------------------
revoke execute on function public.whatsapp_registration_drop_secret() from public, anon, authenticated, service_role;
revoke execute on function public.whatsapp_registration_check_session(uuid, uuid) from public, anon, authenticated, service_role;
revoke execute on function public.whatsapp_registration_prepare(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.whatsapp_registration_store_pin(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.whatsapp_registration_begin_attempt(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.whatsapp_registration_finish_attempt(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.whatsapp_registration_resolve(uuid, text) from public, anon, authenticated;
revoke execute on function public.whatsapp_registration_link(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.whatsapp_pin_reveal_consume(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.whatsapp_registration_sweep() from public, anon, authenticated;
revoke execute on function public.whatsapp_pin_reveal_authorize(uuid, text) from public, anon, service_role;
grant execute on function public.whatsapp_registration_prepare(uuid, text, text) to service_role;
grant execute on function public.whatsapp_registration_store_pin(uuid, uuid, text, text) to service_role;
grant execute on function public.whatsapp_registration_begin_attempt(uuid, uuid) to service_role;
grant execute on function public.whatsapp_registration_finish_attempt(uuid, text, text) to service_role;
grant execute on function public.whatsapp_registration_resolve(uuid, text) to service_role;
grant execute on function public.whatsapp_registration_link(uuid, uuid) to service_role;
grant execute on function public.whatsapp_pin_reveal_consume(uuid, uuid) to service_role;
grant execute on function public.whatsapp_registration_sweep() to service_role;
grant execute on function public.whatsapp_pin_reveal_authorize(uuid, text) to authenticated;

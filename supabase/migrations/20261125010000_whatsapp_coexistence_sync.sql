-- Coexistence, Etapa 4 (LOCAL, NÃO aplicada): controle da sincronização inicial de contatos e histórico (POST /{phone}/smb_app_data).
--
-- Contrato oficial (docs/whatsapp-coexistence-contrato-meta.md): depois do onboarding o parceiro tem 24 HORAS para pedir, NESTA ORDEM,
-- (1) sync_type = smb_app_state_sync (contatos) e (2) sync_type = history; cada pedido só pode ser feito UMA vez (repetir exige offboarding e
-- novo Embedded Signup). Esta migration NÃO pede nada à Meta e NÃO importa conversas: só guarda e protege o estado.
--   * whatsapp_coexistence_sync: uma linha por conexão em Coexistence (criada pelo próprio onboarding), com o prazo de 24 h, o ciclo
--     (novo Embedded Signup = novo ciclo, pedidos zerados) e o estado de cada tipo.
--   * whatsapp_coexistence_sync_attempts: auditoria de cada tentativa (status, código e request_id da Meta; nenhum conteúdo, telefone ou token).
--     Um índice único PARCIAL impede, no banco, um segundo pedido do mesmo tipo no mesmo ciclo (em andamento/aceito/incerto).
--   * RPCs (service_role, usadas pela Edge whatsapp-coexistence-sync): prepare (todas as travas + reserva atômica + token do Vault),
--     finish (resultado). RPC de leitura para owner/admin (sem request_id nem token).
--   * Trava mestra: whatsapp_platform_settings.coexistence_sync_enabled (default false): nada é pedido enquanto o operador não ligar.
--   * Os webhooks smb_app_state_sync/history (Etapa 3) passam a atualizar o estado (synced / receiving / completed / declined).
-- Resultado incerto (timeout/rede/5xx/corpo inesperado) NUNCA é repetido sozinho: a Meta pode ter aceito e o pedido só vale uma vez.

-- ---------------------------------------------------------------------------
-- 1) Trava mestra
-- ---------------------------------------------------------------------------
alter table public.whatsapp_platform_settings
  add column coexistence_sync_enabled boolean not null default false;
comment on column public.whatsapp_platform_settings.coexistence_sync_enabled is
  'Trava do operador: só com true a Edge whatsapp-coexistence-sync pode pedir contatos/histórico à Meta. Default false.';

-- ---------------------------------------------------------------------------
-- 2) Estado por conexão
-- ---------------------------------------------------------------------------
create table public.whatsapp_coexistence_sync (
  connection_id uuid primary key references public.company_whatsapp_connections(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  cycle integer not null default 1 constraint whatsapp_coexistence_sync_cycle_check check (cycle >= 1),
  onboarded_at timestamptz not null,
  deadline_at timestamptz not null,
  contacts_status text not null default 'not_requested'
    constraint whatsapp_coexistence_sync_contacts_status_check check (contacts_status in
      ('not_requested', 'in_progress', 'requested', 'failed', 'uncertain', 'expired', 'synced')),
  history_status text not null default 'not_requested'
    constraint whatsapp_coexistence_sync_history_status_check check (history_status in
      ('not_requested', 'in_progress', 'requested', 'failed', 'uncertain', 'expired', 'receiving', 'completed', 'declined')),
  contacts_requested_at timestamptz,
  contacts_synced_at timestamptz,
  history_requested_at timestamptz,
  history_progress integer constraint whatsapp_coexistence_sync_progress_check check (history_progress is null or history_progress between 0 and 100),
  history_completed_at timestamptz,
  history_declined_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint whatsapp_coexistence_sync_window_check check (deadline_at = onboarded_at + interval '24 hours')
);
create index whatsapp_coexistence_sync_company_idx on public.whatsapp_coexistence_sync (company_id);
alter table public.whatsapp_coexistence_sync enable row level security;
revoke all on public.whatsapp_coexistence_sync from public, anon, authenticated;
grant select, insert, update on public.whatsapp_coexistence_sync to service_role;

create table public.whatsapp_coexistence_sync_attempts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  connection_id uuid not null references public.company_whatsapp_connections(id) on delete cascade,
  cycle integer not null,
  sync_type text not null constraint whatsapp_coexistence_sync_attempts_type_check check (sync_type in ('contacts', 'history')),
  status text not null default 'in_progress'
    constraint whatsapp_coexistence_sync_attempts_status_check check (status in ('in_progress', 'accepted', 'rejected', 'uncertain')),
  requested_by uuid references auth.users(id) on delete set null,
  meta_code text constraint whatsapp_coexistence_sync_attempts_code_check check (meta_code is null or meta_code ~ '^[0-9]{1,10}$'),
  request_id text constraint whatsapp_coexistence_sync_attempts_request_check check (request_id is null or request_id ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
-- UM pedido por tipo e por ciclo (em andamento, aceito ou incerto bloqueiam um segundo); só 'rejected' (a Meta recusou) libera nova tentativa
create unique index whatsapp_coexistence_sync_attempts_once
  on public.whatsapp_coexistence_sync_attempts (connection_id, cycle, sync_type)
  where status in ('in_progress', 'accepted', 'uncertain');
create index whatsapp_coexistence_sync_attempts_conn_idx on public.whatsapp_coexistence_sync_attempts (connection_id, cycle, sync_type, created_at);
alter table public.whatsapp_coexistence_sync_attempts enable row level security;
revoke all on public.whatsapp_coexistence_sync_attempts from public, anon, authenticated;
grant select, insert, update on public.whatsapp_coexistence_sync_attempts to service_role;
comment on table public.whatsapp_coexistence_sync_attempts is
  'Auditoria das tentativas de smb_app_data. Nunca guarda mensagens, contatos, telefones ou token.';

-- ---------------------------------------------------------------------------
-- 3) O onboarding abre (ou reinicia) o ciclo e o prazo de 24 h
-- ---------------------------------------------------------------------------
create function public.whatsapp_coexistence_sync_seed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.whatsapp_coexistence_sync (connection_id, company_id, cycle, onboarded_at, deadline_at)
  values (new.id, new.company_id, 1, new.connected_at, new.connected_at + interval '24 hours')
  on conflict (connection_id) do update
     set cycle = public.whatsapp_coexistence_sync.cycle + 1,
         onboarded_at = excluded.onboarded_at, deadline_at = excluded.deadline_at,
         contacts_status = 'not_requested', history_status = 'not_requested',
         contacts_requested_at = null, contacts_synced_at = null, history_requested_at = null,
         history_progress = null, history_completed_at = null, history_declined_at = null, updated_at = now();
  return new;
end;
$$;
revoke execute on function public.whatsapp_coexistence_sync_seed() from public, anon, authenticated, service_role;

create trigger company_whatsapp_connections_sync_seed_ins
  after insert on public.company_whatsapp_connections
  for each row when (new.connection_type = 'coexistence' and new.connection_source = 'embedded_signup' and new.connected_at is not null)
  execute function public.whatsapp_coexistence_sync_seed();
create trigger company_whatsapp_connections_sync_seed_upd
  after update of connected_at, connection_type on public.company_whatsapp_connections
  for each row when (new.connection_type = 'coexistence' and new.connection_source = 'embedded_signup' and new.connected_at is not null
                     and (old.connected_at is distinct from new.connected_at or old.connection_type is distinct from new.connection_type))
  execute function public.whatsapp_coexistence_sync_seed();

-- ---------------------------------------------------------------------------
-- 4) Preparar o pedido (todas as travas, reserva atômica, token do Vault)
-- ---------------------------------------------------------------------------
create function public.whatsapp_coexistence_sync_prepare(p_user_id uuid, p_company_id uuid, p_type text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enabled boolean;
  v_conn public.company_whatsapp_connections;
  v_sync public.whatsapp_coexistence_sync;
  v_cur text;
  v_eff text;
  v_token text;
  v_attempt public.whatsapp_coexistence_sync_attempts;
  v_rejected integer;
  v_stale uuid;
begin
  if p_type is null or p_type not in ('contacts', 'history') or p_user_id is null or p_company_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  select s.coexistence_sync_enabled into v_enabled from public.whatsapp_platform_settings s;
  if v_enabled is distinct from true then
    return jsonb_build_object('ok', false, 'error', 'sync_disabled');
  end if;
  if not public.whatsapp_signup_user_can_manage(p_company_id, p_user_id) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;
  if not public.whatsapp_signup_pilot_allowed(p_company_id) then
    return jsonb_build_object('ok', false, 'error', 'company_not_authorized');
  end if;

  -- só a conexão em Coexistence do Embedded Signup, ativa e sem pausa de ciclo de vida (Cloud API tradicional nunca)
  select * into v_conn from public.company_whatsapp_connections c
   where c.company_id = p_company_id and c.status = 'active' and c.connection_type = 'coexistence'
     and c.connection_source = 'embedded_signup' and c.lifecycle_state = 'normal' and c.phone_number_id is not null
   order by c.created_at desc limit 1
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'connection_not_eligible');
  end if;
  v_eff := public.whatsapp_token_effective_status(v_conn);
  if v_eff in ('expired', 'revoked') or v_conn.token_secret_id is null then
    return jsonb_build_object('ok', false, 'error', 'token_unavailable');
  end if;

  select * into v_sync from public.whatsapp_coexistence_sync where connection_id = v_conn.id for update;
  if not found then
    -- conexão anterior à Etapa 4: usa o horário do onboarding registrado na própria conexão
    insert into public.whatsapp_coexistence_sync (connection_id, company_id, cycle, onboarded_at, deadline_at)
    values (v_conn.id, v_conn.company_id, 1, v_conn.connected_at, v_conn.connected_at + interval '24 hours')
    returning * into v_sync;
  end if;

  -- pedido "em andamento" abandonado (Edge caiu): vira incerto e NÃO é repetido sozinho
  select a.id into v_stale from public.whatsapp_coexistence_sync_attempts a
   where a.connection_id = v_conn.id and a.cycle = v_sync.cycle and a.sync_type = p_type
     and a.status = 'in_progress' and a.created_at < now() - interval '5 minutes' limit 1;
  if v_stale is not null then
    update public.whatsapp_coexistence_sync_attempts set status = 'uncertain', finished_at = now() where id = v_stale;
    update public.whatsapp_coexistence_sync
       set contacts_status = case when p_type = 'contacts' then 'uncertain' else contacts_status end,
           history_status = case when p_type = 'history' then 'uncertain' else history_status end, updated_at = now()
     where connection_id = v_conn.id;
    return jsonb_build_object('ok', false, 'error', 'uncertain_manual');
  end if;

  v_cur := case when p_type = 'contacts' then v_sync.contacts_status else v_sync.history_status end;
  if v_cur = 'in_progress' then
    return jsonb_build_object('ok', false, 'error', 'in_progress');
  elsif v_cur in ('uncertain') then
    return jsonb_build_object('ok', false, 'error', 'uncertain_manual');
  elsif v_cur in ('requested', 'synced', 'receiving', 'completed', 'declined') then
    return jsonb_build_object('ok', false, 'error', 'already_requested');
  end if;

  -- janela de 24 h desde o onboarding
  if now() > v_sync.deadline_at then
    update public.whatsapp_coexistence_sync
       set contacts_status = case when contacts_status in ('not_requested', 'failed') then 'expired' else contacts_status end,
           history_status = case when history_status in ('not_requested', 'failed') then 'expired' else history_status end, updated_at = now()
     where connection_id = v_conn.id;
    return jsonb_build_object('ok', false, 'error', 'window_expired');
  end if;
  if v_cur = 'expired' then
    return jsonb_build_object('ok', false, 'error', 'window_expired');
  end if;

  -- ordem oficial: contatos primeiro; o histórico só depois que o pedido de contatos foi ACEITO
  if p_type = 'history' and v_sync.contacts_status not in ('requested', 'synced') then
    return jsonb_build_object('ok', false, 'error', 'contacts_first');
  end if;

  -- recusas da Meta liberam nova tentativa, no máximo 3 por tipo e ciclo
  select count(*) into v_rejected from public.whatsapp_coexistence_sync_attempts a
   where a.connection_id = v_conn.id and a.cycle = v_sync.cycle and a.sync_type = p_type and a.status = 'rejected';
  if v_rejected >= 3 then
    return jsonb_build_object('ok', false, 'error', 'attempts_exhausted');
  end if;

  select decrypted_secret into v_token from vault.decrypted_secrets where id = v_conn.token_secret_id;
  if v_token is null or v_token = '' then
    return jsonb_build_object('ok', false, 'error', 'token_unavailable');
  end if;

  begin
    insert into public.whatsapp_coexistence_sync_attempts (company_id, connection_id, cycle, sync_type, requested_by)
    values (v_conn.company_id, v_conn.id, v_sync.cycle, p_type, p_user_id)
    returning * into v_attempt;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'in_progress');
  end;
  update public.whatsapp_coexistence_sync
     set contacts_status = case when p_type = 'contacts' then 'in_progress' else contacts_status end,
         history_status = case when p_type = 'history' then 'in_progress' else history_status end, updated_at = now()
   where connection_id = v_conn.id;

  return jsonb_build_object('ok', true, 'attempt_id', v_attempt.id, 'connection_id', v_conn.id, 'phone_number_id', v_conn.phone_number_id,
                            'cycle', v_sync.cycle, 'attempt_number', v_rejected + 1, 'access_token', v_token);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Resultado do pedido
-- ---------------------------------------------------------------------------
create function public.whatsapp_coexistence_sync_finish(p_attempt_id uuid, p_outcome text, p_request_id text, p_meta_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_a public.whatsapp_coexistence_sync_attempts;
  v_rid text := nullif(btrim(coalesce(p_request_id, '')), '');
  v_code text := nullif(regexp_replace(coalesce(p_meta_code, ''), '[^0-9]', '', 'g'), '');
  v_status text;
begin
  if p_outcome is null or p_outcome not in ('accepted', 'rejected', 'uncertain') then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  select * into v_a from public.whatsapp_coexistence_sync_attempts where id = p_attempt_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_a.status <> 'in_progress' then
    return jsonb_build_object('ok', true, 'idempotent', true, 'status', v_a.status);
  end if;
  if v_rid is not null and v_rid !~ '^[A-Za-z0-9_.:-]{1,100}$' then v_rid := null; end if;
  if v_code is not null and char_length(v_code) > 10 then v_code := left(v_code, 10); end if;

  v_status := case p_outcome when 'accepted' then 'accepted' when 'rejected' then 'rejected' else 'uncertain' end;
  update public.whatsapp_coexistence_sync_attempts
     set status = v_status, request_id = case when v_status = 'accepted' then v_rid else null end, meta_code = v_code, finished_at = now()
   where id = v_a.id;

  update public.whatsapp_coexistence_sync s
     set contacts_status = case when v_a.sync_type = 'contacts' and s.contacts_status = 'in_progress'
                                then case v_status when 'accepted' then 'requested' when 'rejected' then 'failed' else 'uncertain' end
                                else s.contacts_status end,
         contacts_requested_at = case when v_a.sync_type = 'contacts' and v_status = 'accepted' then now() else s.contacts_requested_at end,
         history_status = case when v_a.sync_type = 'history' and s.history_status = 'in_progress'
                               then case v_status when 'accepted' then 'requested' when 'rejected' then 'failed' else 'uncertain' end
                               else s.history_status end,
         history_requested_at = case when v_a.sync_type = 'history' and v_status = 'accepted' then now() else s.history_requested_at end,
         updated_at = now()
   where s.connection_id = v_a.connection_id and s.cycle = v_a.cycle;
  return jsonb_build_object('ok', true, 'idempotent', false, 'status', v_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Estado para owner/admin (sem request_id, token ou conteúdo)
-- ---------------------------------------------------------------------------
create function public.whatsapp_coexistence_sync_status(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_s public.whatsapp_coexistence_sync;
  v_enabled boolean;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null or v_role not in ('owner', 'admin') or not public.company_has_module(p_company_id, 'whatsapp') then
    raise exception 'Acesso negado.' using errcode = 'PT403';
  end if;
  select s.coexistence_sync_enabled into v_enabled from public.whatsapp_platform_settings s;
  select s.* into v_s from public.whatsapp_coexistence_sync s
    join public.company_whatsapp_connections c on c.id = s.connection_id
   where s.company_id = p_company_id and c.status = 'active' order by s.updated_at desc limit 1;
  if not found then
    return jsonb_build_object('has_sync', false, 'enabled', coalesce(v_enabled, false));
  end if;
  return jsonb_build_object(
    'has_sync', true, 'enabled', coalesce(v_enabled, false), 'cycle', v_s.cycle, 'deadline_at', v_s.deadline_at, 'window_open', now() <= v_s.deadline_at,
    'contacts', jsonb_build_object('status', v_s.contacts_status, 'requested_at', v_s.contacts_requested_at, 'synced_at', v_s.contacts_synced_at),
    'history', jsonb_build_object('status', v_s.history_status, 'requested_at', v_s.history_requested_at, 'progress', v_s.history_progress,
                                  'completed_at', v_s.history_completed_at, 'declined_at', v_s.history_declined_at));
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) Webhooks (Etapa 3) passam a atualizar o estado da sincronização
-- ---------------------------------------------------------------------------
create or replace function public.whatsapp_coexistence_record(
  p_phone_number_id text,
  p_kind text,
  p_event_name text,
  p_event_key text,
  p_detail jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conn public.company_whatsapp_connections;
  v_key text := left(nullif(btrim(coalesce(p_event_key, '')), ''), 300);
  v_detail jsonb := '{}'::jsonb;
  v_k text;
  v_id uuid;
begin
  if p_kind is null or p_kind not in ('contact_sync', 'history_chunk', 'history_declined', 'echo_revoke', 'echo_edit') or v_key is null then
    return jsonb_build_object('result', 'invalid');
  end if;
  select * into v_conn from public.company_whatsapp_connections where phone_number_id = p_phone_number_id;
  if not found then
    return jsonb_build_object('result', 'unknown_connection');
  end if;
  if v_conn.connection_type <> 'coexistence' then
    return jsonb_build_object('result', 'not_coexistence');
  end if;
  -- só números inteiros pequenos de uma lista fixa de chaves (nada de texto livre vindo do payload)
  if jsonb_typeof(coalesce(p_detail, '{}'::jsonb)) = 'object' then
    foreach v_k in array array['added', 'removed', 'threads', 'messages', 'phase', 'chunk_order', 'progress', 'error_code'] loop
      if p_detail ? v_k and jsonb_typeof(p_detail -> v_k) = 'number'
         and (p_detail ->> v_k) ~ '^[0-9]{1,9}$' then
        v_detail := v_detail || jsonb_build_object(v_k, (p_detail ->> v_k)::bigint);
      end if;
    end loop;
  end if;
  insert into public.whatsapp_coexistence_events (company_id, connection_id, kind, event_name, detail, provider_event_key)
  values (v_conn.company_id, v_conn.id, p_kind, left(regexp_replace(coalesce(p_event_name, ''), '[^A-Za-z0-9_]', '', 'g'), 60), v_detail, v_key)
  on conflict (provider_event_key) do nothing
  returning id into v_id;
  if v_id is null then
    return jsonb_build_object('result', 'duplicate');
  end if;

  -- estado da sincronização inicial (Etapa 4): o webhook PROVA que a Meta aceitou o pedido, mesmo quando o resultado ficou incerto
  if p_kind = 'contact_sync' then
    update public.whatsapp_coexistence_sync
       set contacts_status = 'synced', contacts_synced_at = coalesce(contacts_synced_at, now()), updated_at = now()
     where connection_id = v_conn.id and contacts_status in ('requested', 'uncertain', 'in_progress');
  elsif p_kind = 'history_chunk' then
    update public.whatsapp_coexistence_sync
       set history_status = case when coalesce((v_detail ->> 'progress')::integer, 0) >= 100 then 'completed' else 'receiving' end,
           history_progress = greatest(coalesce(history_progress, 0), least(coalesce((v_detail ->> 'progress')::integer, 0), 100)),
           history_completed_at = case when coalesce((v_detail ->> 'progress')::integer, 0) >= 100 then coalesce(history_completed_at, now()) else history_completed_at end,
           updated_at = now()
     where connection_id = v_conn.id and history_status in ('requested', 'uncertain', 'in_progress', 'receiving');
  elsif p_kind = 'history_declined' then
    update public.whatsapp_coexistence_sync
       set history_status = 'declined', history_declined_at = coalesce(history_declined_at, now()), updated_at = now()
     where connection_id = v_conn.id and history_status in ('requested', 'uncertain', 'in_progress', 'receiving');
  end if;
  return jsonb_build_object('result', 'recorded');
end;
$$;

-- ---------------------------------------------------------------------------
-- 8) ACL
-- ---------------------------------------------------------------------------
revoke execute on function public.whatsapp_coexistence_sync_prepare(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.whatsapp_coexistence_sync_finish(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.whatsapp_coexistence_sync_status(uuid) from public, anon, service_role;
grant execute on function public.whatsapp_coexistence_sync_prepare(uuid, uuid, text) to service_role;
grant execute on function public.whatsapp_coexistence_sync_finish(uuid, text, text, text) to service_role;
grant execute on function public.whatsapp_coexistence_sync_status(uuid) to authenticated;

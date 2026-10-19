-- WhatsApp + IA, Fase 2: resposta AUTOMÁTICA (mode='auto'), com fila/debounce, idempotência e revalidação final.
--
-- Migration ADITIVA posterior à 080000 (nenhuma migration aplicada é editada). Resumo:
--  * whatsapp_ai_jobs: fila com UM job ativo por conversa (debounce de 8 s por reagendamento), lease, outcome fechado.
--  * whatsapp_conversations.ai_control (inherit|human) + ai_handoff_reason; whatsapp_messages.origin (human|ai_auto|system)
--    + ai_job_id (no máximo UMA saída automática por job). Envio manual com a empresa em 'auto' pausa a IA (persistente).
--  * Configuração: remove o bloqueio do 'auto'; exige ciência LGPD + ciência do automático + instruções + conexão ativa.
--    business_schedule estruturado (opcional) e after_hours_policy (default ai_continues). Sem schedule, nada muda.
--  * whatsapp_ai_usage: kind (suggest|auto), job_id, trigger_message_id; cotas de sugestão e de automático INDEPENDENTES.
--  * Gatilho AFTER INSERT em whatsapp_messages (só direction='inbound') enfileira/reagenda. whatsapp_ingest_message NÃO muda.
--    Falha ao enfileirar nunca impede a gravação do inbound (exceção engolida com warning).
--  * RPCs do worker (service_role): claim, prepare, reserve_auto_usage, commit_send (revalidação final sob lock, grava a
--    mensagem 'queued' com client_request_id = job_id), complete_job. O ENVIO em si continua sendo o fluxo oficial
--    (get_send_context -> Graph -> mark_sent/failed), reaproveitado pela Edge via _shared/whatsapp-dispatch.ts.
--  * dispatch_due + agendamento pg_cron de 10 s (só onde pg_cron existe; sem URL/segredo no Vault não faz nada).
--
-- Nunca grava prompt, texto da conversa, resposta, telefone ou chave em jobs/usage.

-- ---------------------------------------------------------------------------
-- 1) Conversa e mensagem
-- ---------------------------------------------------------------------------
alter table public.whatsapp_conversations
  add column ai_control text not null default 'inherit'
    constraint whatsapp_conversations_ai_control_check check (ai_control in ('inherit', 'human')),
  add column ai_control_changed_at timestamptz,
  add column ai_control_changed_by uuid references auth.users(id) on delete set null,
  add column ai_handoff_reason text
    constraint whatsapp_conversations_ai_handoff_reason_check check (ai_handoff_reason is null or ai_handoff_reason ~ '^[a-z0-9_]{1,60}$');

alter table public.whatsapp_conversation_events drop constraint whatsapp_conversation_events_type_check;
alter table public.whatsapp_conversation_events add constraint whatsapp_conversation_events_type_check check (event_type in (
  'created', 'assigned', 'unassigned', 'status_changed', 'customer_linked', 'customer_unlinked', 'closed', 'reopened', 'order_linked',
  'ai_paused', 'ai_resumed', 'ai_handoff'));

-- ---------------------------------------------------------------------------
-- 2) Fila de jobs
-- ---------------------------------------------------------------------------
create table public.whatsapp_ai_jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  conversation_id uuid not null,
  first_message_id uuid not null,
  latest_message_id uuid not null,
  status text not null default 'pending'
    constraint whatsapp_ai_jobs_status_check check (status in ('pending', 'processing', 'done', 'cancelled')),
  run_after timestamptz not null,
  attempts integer not null default 0 constraint whatsapp_ai_jobs_attempts_check check (attempts >= 0),
  regen_count integer not null default 0 constraint whatsapp_ai_jobs_regen_check check (regen_count >= 0),
  locked_until timestamptz,
  outcome text
    constraint whatsapp_ai_jobs_outcome_check check (outcome is null or outcome in (
      'replied', 'handoff', 'ignored', 'aborted_stale', 'aborted_human', 'aborted_mode', 'aborted_closed', 'out_of_hours',
      'window_closed', 'blocked_quota', 'provider_error', 'timeout', 'invalid_output', 'rate_limited', 'failed_send')),
  reason_code text
    constraint whatsapp_ai_jobs_reason_check check (reason_code is null or reason_code ~ '^[a-z0-9_]{1,60}$'),
  usage_id uuid,
  outbound_message_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_ai_jobs_conversation_fkey
    foreign key (conversation_id, company_id) references public.whatsapp_conversations (id, company_id) on delete cascade,
  constraint whatsapp_ai_jobs_first_message_fkey
    foreign key (first_message_id, company_id) references public.whatsapp_messages (id, company_id) on delete cascade,
  constraint whatsapp_ai_jobs_latest_message_fkey
    foreign key (latest_message_id, company_id) references public.whatsapp_messages (id, company_id) on delete cascade,
  -- ativo = sem desfecho; encerrado = com desfecho
  constraint whatsapp_ai_jobs_outcome_state check ((status in ('done', 'cancelled')) = (outcome is not null))
);

-- UM job ativo por conversa: é o que torna o debounce (reagendar em vez de criar outro) e a idempotência possíveis.
create unique index whatsapp_ai_jobs_one_active on public.whatsapp_ai_jobs (conversation_id) where status in ('pending', 'processing');
create index whatsapp_ai_jobs_due_idx on public.whatsapp_ai_jobs (run_after) where status = 'pending';
create index whatsapp_ai_jobs_lease_idx on public.whatsapp_ai_jobs (locked_until) where status = 'processing';
create index whatsapp_ai_jobs_company_idx on public.whatsapp_ai_jobs (company_id, created_at desc);

create trigger whatsapp_ai_jobs_set_updated_at
  before update on public.whatsapp_ai_jobs
  for each row execute function public.set_updated_at();

alter table public.whatsapp_ai_jobs enable row level security;
revoke all on public.whatsapp_ai_jobs from public, anon, authenticated;
grant select on public.whatsapp_ai_jobs to service_role;

alter table public.whatsapp_messages
  add column origin text not null default 'human'
    constraint whatsapp_messages_origin_check check (origin in ('human', 'ai_auto', 'system')),
  add column ai_job_id uuid references public.whatsapp_ai_jobs(id) on delete set null;
-- saída automática: sempre outbound e sem usuário (o job pode sumir numa limpeza futura: ON DELETE SET NULL);
-- as demais origens nunca carregam job. O commit SEMPRE grava ai_job_id.
alter table public.whatsapp_messages add constraint whatsapp_messages_origin_shape check (
  (origin = 'ai_auto' and direction = 'outbound' and sent_by_user_id is null)
  or (origin <> 'ai_auto' and ai_job_id is null));
-- no máximo UMA saída automática por job (idempotência forte, além do client_request_id = job_id)
create unique index whatsapp_messages_ai_job_uniq on public.whatsapp_messages (ai_job_id) where ai_job_id is not null;

-- ---------------------------------------------------------------------------
-- 3) Configuração
-- ---------------------------------------------------------------------------
alter table public.company_whatsapp_ai_settings drop constraint whatsapp_ai_settings_auto_blocked;
alter table public.company_whatsapp_ai_settings
  add column auto_acknowledged_at timestamptz,
  add column auto_acknowledged_by uuid references auth.users(id) on delete set null,
  add column after_hours_policy text not null default 'ai_continues'
    constraint whatsapp_ai_settings_after_hours_policy_check check (after_hours_policy in ('ai_continues', 'silent', 'message')),
  add column after_hours_message text
    constraint whatsapp_ai_settings_after_hours_message_length check (after_hours_message is null or char_length(after_hours_message) <= 500),
  add column business_schedule jsonb
    constraint whatsapp_ai_settings_schedule_shape check (
      business_schedule is null or (jsonb_typeof(business_schedule) = 'object' and char_length(business_schedule::text) <= 2000));

-- auto só com TODOS os requisitos (a RPC dá a mensagem amigável; esta constraint é a rede de segurança)
alter table public.company_whatsapp_ai_settings add constraint whatsapp_ai_settings_auto_requirements check (
  mode <> 'auto'
  or (enabled
      and ai_data_processing_acknowledged_at is not null
      and auto_acknowledged_at is not null
      and nullif(btrim(coalesce(custom_instructions, '')), '') is not null));

comment on column public.company_whatsapp_ai_settings.business_schedule is
  'Opcional. {"timezone":"America/Sao_Paulo","days":{"mon":[["09:00","18:00"]],"tue":[...]}}. NULL = sem restrição de horário.';

-- Modo efetivo com 4 argumentos: 'auto' só com ciência LGPD E ciência do automático. A versão de 3 argumentos (Fase 1)
-- permanece e continua tratando 'auto' como 'off' (fail-closed para quem ainda a usa).
create function public.whatsapp_ai_effective_mode(p_enabled boolean, p_mode text, p_ack timestamptz, p_auto_ack timestamptz)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_enabled and p_ack is not null and p_mode = 'suggest' then 'suggest'
    when p_enabled and p_ack is not null and p_auto_ack is not null and p_mode = 'auto' then 'auto'
    else 'off' end
$$;
revoke execute on function public.whatsapp_ai_effective_mode(boolean, text, timestamptz, timestamptz) from public, anon, authenticated, service_role;

-- Valida o formato do horário estruturado.
create function public.whatsapp_ai_schedule_valid(p_schedule jsonb)
returns boolean
language plpgsql
stable
set search_path = public
as $$
declare
  v_k text;
  v_arr jsonb;
  v_iv jsonb;
begin
  if p_schedule is null then
    return true;
  end if;
  if jsonb_typeof(p_schedule) <> 'object' or char_length(p_schedule::text) > 2000 then
    return false;
  end if;
  if exists (select 1 from jsonb_object_keys(p_schedule) k where k not in ('timezone', 'days')) then
    return false;
  end if;
  if jsonb_typeof(p_schedule -> 'timezone') is distinct from 'string'
     or not exists (select 1 from pg_timezone_names z where z.name = p_schedule ->> 'timezone') then
    return false;
  end if;
  if jsonb_typeof(p_schedule -> 'days') is distinct from 'object' then
    return false;
  end if;
  for v_k in select jsonb_object_keys(p_schedule -> 'days') loop
    if v_k not in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun') then
      return false;
    end if;
    v_arr := p_schedule -> 'days' -> v_k;
    if jsonb_typeof(v_arr) <> 'array' or jsonb_array_length(v_arr) > 4 then
      return false;
    end if;
    for v_iv in select * from jsonb_array_elements(v_arr) loop
      if jsonb_typeof(v_iv) <> 'array' or jsonb_array_length(v_iv) <> 2
         or jsonb_typeof(v_iv -> 0) <> 'string' or jsonb_typeof(v_iv -> 1) <> 'string'
         or (v_iv ->> 0) !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         or (v_iv ->> 1) !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         or (v_iv ->> 0) >= (v_iv ->> 1) then
        return false;
      end if;
    end loop;
  end loop;
  return true;
end;
$$;

-- Dentro do expediente? schedule NULL = sempre (preserva o comportamento atual).
create function public.whatsapp_ai_in_hours(p_schedule jsonb, p_now timestamptz default now())
returns boolean
language plpgsql
stable
set search_path = public
as $$
declare
  v_local timestamp;
  v_key text;
  v_time text;
  v_iv jsonb;
begin
  if p_schedule is null then
    return true;
  end if;
  if not public.whatsapp_ai_schedule_valid(p_schedule) then
    return true; -- schedule corrompido nunca silencia o atendimento
  end if;
  v_local := p_now at time zone (p_schedule ->> 'timezone');
  v_key := (array['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])[extract(isodow from v_local)::integer];
  v_time := to_char(v_local, 'HH24:MI');
  for v_iv in select * from jsonb_array_elements(coalesce(p_schedule -> 'days' -> v_key, '[]'::jsonb)) loop
    if v_time >= (v_iv ->> 0) and v_time < (v_iv ->> 1) then
      return true;
    end if;
  end loop;
  return false;
end;
$$;
revoke execute on function public.whatsapp_ai_schedule_valid(jsonb) from public, anon, authenticated, service_role;
revoke execute on function public.whatsapp_ai_in_hours(jsonb, timestamptz) from public, anon, authenticated, service_role;

-- get_settings: 'effective_mode' agora pode ser 'auto'; owner/admin recebem os campos novos.
create or replace function public.whatsapp_ai_get_settings(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_s public.company_whatsapp_ai_settings;
  v_eff text;
  v_out jsonb;
  v_has boolean;
begin
  v_role := public.whatsapp_assert_reader(p_company_id);
  select * into v_s from public.company_whatsapp_ai_settings where company_id = p_company_id;
  v_has := found;

  if not v_has then
    v_eff := 'off';
  else
    v_eff := public.whatsapp_ai_effective_mode(v_s.enabled, v_s.mode, v_s.ai_data_processing_acknowledged_at, v_s.auto_acknowledged_at);
  end if;
  v_out := jsonb_build_object('effective_mode', v_eff);

  if v_role in ('owner', 'admin') then
    if v_has then
      v_out := v_out || jsonb_build_object(
        'enabled', v_s.enabled,
        'mode', v_s.mode,
        'business_name', v_s.business_name,
        'tone', v_s.tone,
        'custom_instructions', v_s.custom_instructions,
        'business_hours', v_s.business_hours,
        'fallback_to_human', v_s.fallback_to_human,
        'max_context_messages', v_s.max_context_messages,
        'acknowledged_at', v_s.ai_data_processing_acknowledged_at,
        'auto_acknowledged_at', v_s.auto_acknowledged_at,
        'after_hours_policy', v_s.after_hours_policy,
        'after_hours_message', v_s.after_hours_message,
        'business_schedule', v_s.business_schedule);
    else
      v_out := v_out || jsonb_build_object(
        'enabled', false, 'mode', 'off', 'business_name', null, 'tone', null, 'custom_instructions', null,
        'business_hours', null, 'fallback_to_human', true, 'max_context_messages', 12, 'acknowledged_at', null,
        'auto_acknowledged_at', null, 'after_hours_policy', 'ai_continues', 'after_hours_message', null, 'business_schedule', null);
    end if;
  end if;
  return v_out;
end;
$$;

-- update_settings: assinatura ESTENDIDA (4 parâmetros novos com default no fim). A de 10 parâmetros sai (substituída).
drop function public.whatsapp_ai_update_settings(uuid, boolean, text, text, text, text, jsonb, boolean, integer, boolean);

create function public.whatsapp_ai_update_settings(
  p_company_id uuid,
  p_enabled boolean,
  p_mode text,
  p_business_name text,
  p_tone text,
  p_custom_instructions text,
  p_business_hours jsonb,
  p_fallback_to_human boolean,
  p_max_context_messages integer,
  p_acknowledge boolean default false,
  p_acknowledge_auto boolean default false,
  p_after_hours_policy text default null,
  p_after_hours_message text default null,
  p_business_schedule jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_old public.company_whatsapp_ai_settings;
  v_ack timestamptz;
  v_ack_by uuid;
  v_auto_ack timestamptz;
  v_auto_ack_by uuid;
  v_name text := nullif(btrim(coalesce(p_business_name, '')), '');
  v_tone text := nullif(btrim(coalesce(p_tone, '')), '');
  v_instr text := nullif(btrim(coalesce(p_custom_instructions, '')), '');
  v_hours jsonb := p_business_hours;
  v_policy text;
  v_ah_msg text := nullif(btrim(coalesce(p_after_hours_message, '')), '');
begin
  v_role := public.whatsapp_assert_reader(p_company_id);
  if v_role not in ('owner', 'admin') then
    raise exception 'Somente donos(as) e administradores(as) configuram a IA do WhatsApp.' using errcode = 'PT403';
  end if;

  if p_enabled is null or p_fallback_to_human is null or p_max_context_messages is null then
    raise exception 'Configuração inválida.' using errcode = 'PT400';
  end if;
  if p_mode is null or p_mode not in ('off', 'suggest', 'auto') then
    raise exception 'Modo da IA inválido.' using errcode = 'PT400';
  end if;
  if p_max_context_messages < 1 or p_max_context_messages > 30 then
    raise exception 'O contexto deve ter entre 1 e 30 mensagens.' using errcode = 'PT400';
  end if;
  if v_name is not null and char_length(v_name) > 120 then
    raise exception 'O nome do estabelecimento pode ter no máximo 120 caracteres.' using errcode = 'PT400';
  end if;
  if v_tone is not null and char_length(v_tone) > 80 then
    raise exception 'O tom de voz pode ter no máximo 80 caracteres.' using errcode = 'PT400';
  end if;
  if v_instr is not null and char_length(v_instr) > 2000 then
    raise exception 'As instruções podem ter no máximo 2000 caracteres.' using errcode = 'PT400';
  end if;
  if v_hours is not null and (jsonb_typeof(v_hours) <> 'object' or char_length(v_hours::text) > 600) then
    raise exception 'Horário de atendimento inválido.' using errcode = 'PT400';
  end if;
  if not public.whatsapp_ai_schedule_valid(p_business_schedule) then
    raise exception 'Horário de funcionamento inválido. Use fuso horário válido e faixas HH:MM com início antes do fim.' using errcode = 'PT400';
  end if;
  if p_after_hours_policy is not null and p_after_hours_policy not in ('ai_continues', 'silent', 'message') then
    raise exception 'Política fora do expediente inválida.' using errcode = 'PT400';
  end if;
  if v_ah_msg is not null and char_length(v_ah_msg) > 500 then
    raise exception 'A mensagem fora do expediente pode ter no máximo 500 caracteres.' using errcode = 'PT400';
  end if;

  select * into v_old from public.company_whatsapp_ai_settings where company_id = p_company_id for update;
  v_policy := coalesce(p_after_hours_policy, v_old.after_hours_policy, 'ai_continues');
  if v_policy = 'message' and v_ah_msg is null then
    raise exception 'Informe a mensagem para enviar fora do expediente.' using errcode = 'PT400';
  end if;

  v_ack := v_old.ai_data_processing_acknowledged_at;
  v_ack_by := v_old.ai_data_processing_acknowledged_by;
  if p_acknowledge and v_ack is null then
    v_ack := now();
    v_ack_by := auth.uid();
  end if;
  if p_enabled and v_ack is null then
    raise exception 'Confirme a ciência sobre o tratamento dos dados pelo provedor de IA para ativar.' using errcode = 'PT400';
  end if;

  v_auto_ack := v_old.auto_acknowledged_at;
  v_auto_ack_by := v_old.auto_acknowledged_by;
  if p_acknowledge_auto and v_auto_ack is null then
    v_auto_ack := now();
    v_auto_ack_by := auth.uid();
  end if;

  if p_mode = 'auto' then
    if not p_enabled then
      raise exception 'Ative a IA para usar o modo automático.' using errcode = 'PT409';
    end if;
    if v_auto_ack is null then
      raise exception 'Confirme que a IA poderá responder seus clientes automaticamente para ativar o modo automático.' using errcode = 'PT409';
    end if;
    if v_instr is null then
      raise exception 'Preencha as instruções da IA (produtos, preços e regras) antes de ativar o modo automático.' using errcode = 'PT409';
    end if;
    if not exists (
      select 1 from public.company_whatsapp_connections c where c.company_id = p_company_id and c.status = 'active'
    ) then
      raise exception 'Conecte o WhatsApp da empresa antes de ativar o modo automático.' using errcode = 'PT409';
    end if;
  end if;

  insert into public.company_whatsapp_ai_settings (
    company_id, enabled, mode, business_name, tone, custom_instructions, business_hours, fallback_to_human,
    max_context_messages, ai_data_processing_acknowledged_at, ai_data_processing_acknowledged_by, updated_by,
    auto_acknowledged_at, auto_acknowledged_by, after_hours_policy, after_hours_message, business_schedule)
  values (
    p_company_id, p_enabled, p_mode, v_name, v_tone, v_instr, v_hours, p_fallback_to_human,
    p_max_context_messages, v_ack, v_ack_by, auth.uid(),
    v_auto_ack, v_auto_ack_by, v_policy, v_ah_msg, p_business_schedule)
  on conflict (company_id) do update
     set enabled = excluded.enabled,
         mode = excluded.mode,
         business_name = excluded.business_name,
         tone = excluded.tone,
         custom_instructions = excluded.custom_instructions,
         business_hours = excluded.business_hours,
         fallback_to_human = excluded.fallback_to_human,
         max_context_messages = excluded.max_context_messages,
         ai_data_processing_acknowledged_at = excluded.ai_data_processing_acknowledged_at,
         ai_data_processing_acknowledged_by = excluded.ai_data_processing_acknowledged_by,
         updated_by = excluded.updated_by,
         auto_acknowledged_at = excluded.auto_acknowledged_at,
         auto_acknowledged_by = excluded.auto_acknowledged_by,
         after_hours_policy = excluded.after_hours_policy,
         after_hours_message = excluded.after_hours_message,
         business_schedule = excluded.business_schedule;

  return public.whatsapp_ai_get_settings(p_company_id);
end;
$$;

-- Saiu de 'auto' (ou desligou): jobs pendentes são cancelados; um job em processamento falha na revalidação final.
create function public.whatsapp_ai_settings_cancel_jobs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.whatsapp_ai_effective_mode(new.enabled, new.mode, new.ai_data_processing_acknowledged_at, new.auto_acknowledged_at) <> 'auto' then
    update public.whatsapp_ai_jobs
       set status = 'cancelled', outcome = 'aborted_mode', reason_code = 'mode_changed', locked_until = null
     where company_id = new.company_id and status = 'pending';
  end if;
  return new;
end;
$$;
revoke execute on function public.whatsapp_ai_settings_cancel_jobs() from public, anon, authenticated, service_role;

create trigger company_whatsapp_ai_settings_cancel_jobs
  after update on public.company_whatsapp_ai_settings
  for each row execute function public.whatsapp_ai_settings_cancel_jobs();

-- ---------------------------------------------------------------------------
-- 4) Uso: kind / job_id / trigger_message_id; cotas independentes
-- ---------------------------------------------------------------------------
alter table public.whatsapp_ai_usage
  add column kind text not null default 'suggest'
    constraint whatsapp_ai_usage_kind_check check (kind in ('suggest', 'auto')),
  add column job_id uuid,
  add column trigger_message_id uuid;

alter table public.whatsapp_ai_usage drop constraint whatsapp_ai_usage_block_reason_check;
alter table public.whatsapp_ai_usage add constraint whatsapp_ai_usage_block_reason_check check (
  block_reason is null or block_reason in (
    'user_minute', 'company_day', 'auto_minute', 'auto_hour', 'auto_day', 'auto_month', 'auto_conversation'));

create index whatsapp_ai_usage_kind_idx on public.whatsapp_ai_usage (company_id, kind, created_at desc);
create index whatsapp_ai_usage_conv_idx on public.whatsapp_ai_usage (conversation_id, created_at desc) where kind = 'auto';

-- A reserva de SUGESTÃO passa a contar só kind='suggest' (o automático não consome a cota manual). Corpo idêntico ao da 080000.
create or replace function public.whatsapp_ai_reserve_usage(
  p_company_id uuid,
  p_conversation_id uuid,
  p_user_id uuid,
  p_provider text,
  p_model text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_count integer;
  v_company_count integer;
  v_reason text;
  v_id uuid;
  v_provider text := left(coalesce(nullif(btrim(p_provider), ''), 'unknown'), 60);
  v_model text := left(coalesce(nullif(btrim(p_model), ''), 'unknown'), 120);
begin
  if p_company_id is null or p_conversation_id is null or p_user_id is null then
    return jsonb_build_object('result', 'invalid');
  end if;
  if not exists (
    select 1 from public.whatsapp_conversations where id = p_conversation_id and company_id = p_company_id
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('whatsapp_ai_quota:' || p_company_id::text, 0));

  select count(*) into v_user_count
    from public.whatsapp_ai_usage
   where company_id = p_company_id and user_id = p_user_id and kind = 'suggest'
     and reservation_id is null and status <> 'blocked'
     and created_at > now() - interval '1 minute';
  select count(*) into v_company_count
    from public.whatsapp_ai_usage
   where company_id = p_company_id and kind = 'suggest'
     and reservation_id is null and status <> 'blocked'
     and created_at > now() - interval '24 hours';

  if v_user_count >= 10 then
    v_reason := 'user_minute';
  elsif v_company_count >= 300 then
    v_reason := 'company_day';
  end if;

  if v_reason is not null then
    if not exists (
      select 1 from public.whatsapp_ai_usage
       where company_id = p_company_id and user_id = p_user_id and status = 'blocked' and kind = 'suggest'
         and created_at > now() - interval '1 minute'
    ) then
      insert into public.whatsapp_ai_usage (company_id, conversation_id, user_id, provider, model, status, block_reason)
      values (p_company_id, p_conversation_id, p_user_id, v_provider, v_model, 'blocked', v_reason);
    end if;
    return jsonb_build_object('result', 'blocked', 'reason', v_reason);
  end if;

  insert into public.whatsapp_ai_usage (company_id, conversation_id, user_id, provider, model, status)
  values (p_company_id, p_conversation_id, p_user_id, v_provider, v_model, 'reserved')
  returning id into v_id;

  return jsonb_build_object('result', 'reserved', 'usage_id', v_id);
end;
$$;

-- A finalização passa a herdar kind/job_id/trigger_message_id da reserva.
create or replace function public.whatsapp_ai_finalize_usage(
  p_usage_id uuid,
  p_status text,
  p_input_tokens integer,
  p_output_tokens integer,
  p_latency_ms integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res public.whatsapp_ai_usage;
begin
  if p_status is null or p_status not in ('ok', 'timeout', 'provider_error', 'rate_limited', 'invalid_output') then
    return jsonb_build_object('result', 'invalid');
  end if;
  select * into v_res from public.whatsapp_ai_usage where id = p_usage_id and status = 'reserved' and reservation_id is null;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if exists (select 1 from public.whatsapp_ai_usage where reservation_id = p_usage_id) then
    return jsonb_build_object('result', 'already_finalized');
  end if;

  insert into public.whatsapp_ai_usage (
    company_id, conversation_id, user_id, provider, model, status, input_tokens, output_tokens, latency_ms, reservation_id,
    kind, job_id, trigger_message_id)
  values (
    v_res.company_id, v_res.conversation_id, v_res.user_id, v_res.provider, v_res.model, p_status,
    case when p_input_tokens >= 0 then p_input_tokens end,
    case when p_output_tokens >= 0 then p_output_tokens end,
    case when p_latency_ms >= 0 then p_latency_ms end,
    p_usage_id, v_res.kind, v_res.job_id, v_res.trigger_message_id);
  return jsonb_build_object('result', 'ok');
exception
  when unique_violation then
    return jsonb_build_object('result', 'already_finalized');
end;
$$;

-- Sugestão manual também com a empresa em 'auto' (conversa assumida por humano etc.). Só o modo efetivo muda; o resto é igual.
create or replace function public.whatsapp_ai_prepare_suggestion(p_conversation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conv public.whatsapp_conversations;
  v_s public.company_whatsapp_ai_settings;
  v_win jsonb;
  v_eff text;
  v_customer_first text;
  v_messages jsonb;
begin
  v_conv := public.whatsapp_load_conversation(p_conversation_id);

  select * into v_s from public.company_whatsapp_ai_settings where company_id = v_conv.company_id;
  if found then
    v_eff := public.whatsapp_ai_effective_mode(v_s.enabled, v_s.mode, v_s.ai_data_processing_acknowledged_at, v_s.auto_acknowledged_at);
  end if;
  if not found or v_eff not in ('suggest', 'auto') then
    raise exception 'A sugestão por IA não está ativada para esta empresa.' using errcode = 'PT409';
  end if;

  if v_conv.status = 'closed' then
    raise exception 'Reabra a conversa para gerar uma sugestão.' using errcode = 'PT409';
  end if;
  v_win := public.whatsapp_can_send_freeform(v_conv.last_inbound_at);
  if not (v_win ->> 'can_send')::boolean then
    raise exception 'Fora da janela de atendimento de 24 horas.' using errcode = 'PT409';
  end if;

  if v_conv.customer_id is not null then
    select split_part(btrim(c.name), ' ', 1) into v_customer_first
      from public.customers c
     where c.company_id = v_conv.company_id and c.id = v_conv.customer_id;
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object('direction', t.direction, 'at', t.at, 'text', t.txt) order by t.at, t.id), '[]'::jsonb)
    into v_messages
    from (
      select m.id, m.direction, coalesce(m.provider_timestamp, m.created_at) as at,
             case m.type
               when 'text' then public.whatsapp_ai_redact(m.body)
               else btrim(
                      case m.type
                        when 'image' then '[imagem]'
                        when 'audio' then '[áudio]'
                        when 'document' then '[documento]'
                        when 'location' then '[localização]'
                        when 'interactive' then '[mensagem interativa]'
                        when 'template' then '[mensagem modelo]'
                        else '[mensagem não suportada]'
                      end || ' ' || public.whatsapp_ai_redact(m.body))
             end as txt
        from public.whatsapp_messages m
       where m.company_id = v_conv.company_id
         and m.conversation_id = v_conv.id
         and m.status <> 'failed'
       order by coalesce(m.provider_timestamp, m.created_at) desc, m.id desc
       limit v_s.max_context_messages
    ) t;

  if jsonb_array_length(v_messages) = 0 then
    raise exception 'Não há mensagens para gerar uma sugestão.' using errcode = 'PT409';
  end if;

  return jsonb_build_object(
    'company_id', v_conv.company_id,
    'conversation_id', v_conv.id,
    'user_id', auth.uid(),
    'mode', v_eff,
    'business_name', v_s.business_name,
    'tone', v_s.tone,
    'custom_instructions', v_s.custom_instructions,
    'business_hours', v_s.business_hours,
    'fallback_to_human', v_s.fallback_to_human,
    'customer_first_name', nullif(v_customer_first, ''),
    'messages', v_messages);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Pausa da IA por conversa
-- ---------------------------------------------------------------------------
-- Assumir (human) / Devolver (inherit). Devolver também LIBERA a atribuição: com assigned_user_id preenchido a IA não
-- responde, então manter a atribuição criaria o estado contraditório "IA ativa" com a IA bloqueada.
create function public.whatsapp_set_conversation_ai_control(p_conversation_id uuid, p_control text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conv public.whatsapp_conversations;
  v_prev_assigned uuid;
begin
  v_conv := public.whatsapp_load_conversation(p_conversation_id);
  if p_control is null or p_control not in ('human', 'inherit') then
    raise exception 'Controle da IA inválido.' using errcode = 'PT400';
  end if;

  select * into v_conv from public.whatsapp_conversations where id = v_conv.id for update;
  v_prev_assigned := v_conv.assigned_user_id;

  if p_control = 'human' then
    if v_conv.ai_control = 'human' then
      return jsonb_build_object('ai_control', 'human', 'assigned_user_id', v_conv.assigned_user_id, 'changed', false);
    end if;
    update public.whatsapp_conversations
       set ai_control = 'human', ai_control_changed_at = now(), ai_control_changed_by = auth.uid(), ai_handoff_reason = null
     where id = v_conv.id;
    insert into public.whatsapp_conversation_events (company_id, conversation_id, event_type, actor_user_id, old_value, new_value)
    values (v_conv.company_id, v_conv.id, 'ai_paused', auth.uid(), jsonb_build_object('ai_control', v_conv.ai_control), jsonb_build_object('ai_control', 'human'));
    -- jobs pendentes não fazem mais sentido
    update public.whatsapp_ai_jobs
       set status = 'cancelled', outcome = 'aborted_human', reason_code = 'human_took_over', locked_until = null
     where conversation_id = v_conv.id and status = 'pending';
    return jsonb_build_object('ai_control', 'human', 'assigned_user_id', v_conv.assigned_user_id, 'changed', true);
  end if;

  -- inherit
  if v_conv.ai_control = 'inherit' and v_conv.assigned_user_id is null then
    return jsonb_build_object('ai_control', 'inherit', 'assigned_user_id', null, 'changed', false);
  end if;
  update public.whatsapp_conversations
     set ai_control = 'inherit', ai_control_changed_at = now(), ai_control_changed_by = auth.uid(),
         ai_handoff_reason = null, assigned_user_id = null
   where id = v_conv.id;
  if v_prev_assigned is not null then
    insert into public.whatsapp_conversation_events (company_id, conversation_id, event_type, actor_user_id, old_value, new_value)
    values (v_conv.company_id, v_conv.id, 'unassigned', auth.uid(), jsonb_build_object('assigned_user_id', v_prev_assigned), jsonb_build_object('assigned_user_id', null));
  end if;
  insert into public.whatsapp_conversation_events (company_id, conversation_id, event_type, actor_user_id, old_value, new_value)
  values (v_conv.company_id, v_conv.id, 'ai_resumed', auth.uid(), jsonb_build_object('ai_control', v_conv.ai_control), jsonb_build_object('ai_control', 'inherit'));
  return jsonb_build_object('ai_control', 'inherit', 'assigned_user_id', null, 'changed', true);
end;
$$;

-- Envio MANUAL (origin='human') com a empresa em 'auto' pausa a IA naquela conversa, de forma persistente.
-- Mensagens ai_auto/system nunca pausam. Falha aqui nunca derruba o envio (exceção engolida).
create function public.whatsapp_ai_pause_on_human_outbound()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.company_whatsapp_ai_settings;
  v_changed integer;
begin
  begin
    select * into v_s from public.company_whatsapp_ai_settings where company_id = new.company_id;
    if not found
       or public.whatsapp_ai_effective_mode(v_s.enabled, v_s.mode, v_s.ai_data_processing_acknowledged_at, v_s.auto_acknowledged_at) <> 'auto' then
      return new;
    end if;
    update public.whatsapp_conversations
       set ai_control = 'human', ai_control_changed_at = now(), ai_control_changed_by = new.sent_by_user_id, ai_handoff_reason = null
     where id = new.conversation_id and company_id = new.company_id and ai_control = 'inherit';
    get diagnostics v_changed = row_count;
    if v_changed > 0 then
      insert into public.whatsapp_conversation_events (company_id, conversation_id, event_type, actor_user_id, old_value, new_value)
      values (new.company_id, new.conversation_id, 'ai_paused', new.sent_by_user_id, jsonb_build_object('ai_control', 'inherit'), jsonb_build_object('ai_control', 'human', 'reason', 'manual_send'));
      update public.whatsapp_ai_jobs
         set status = 'cancelled', outcome = 'aborted_human', reason_code = 'manual_send', locked_until = null
       where conversation_id = new.conversation_id and status = 'pending';
    end if;
  exception when others then
    raise warning 'whatsapp_ai_pause_on_human_outbound falhou: %', sqlstate;
  end;
  return new;
end;
$$;
revoke execute on function public.whatsapp_ai_pause_on_human_outbound() from public, anon, authenticated, service_role;

create trigger whatsapp_messages_ai_pause
  after insert on public.whatsapp_messages
  for each row when (new.direction = 'outbound' and new.origin = 'human')
  execute function public.whatsapp_ai_pause_on_human_outbound();

-- ---------------------------------------------------------------------------
-- 6a) Falhas de enfileiramento RASTREÁVEIS (sem conteúdo, sem telefone)
-- ---------------------------------------------------------------------------
-- Se o gatilho de enfileiramento falhar, o inbound continua sendo gravado (nunca quebra o webhook), mas a mensagem é
-- registrada aqui: "esta inbound foi persistida e NÃO entrou na fila". O reconciliador (6c) a recupera dentro de uma janela.
create table public.whatsapp_ai_enqueue_failures (
  message_id uuid primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  conversation_id uuid not null,
  sqlstate text not null constraint whatsapp_ai_enqueue_failures_sqlstate_len check (char_length(sqlstate) between 1 and 5),
  status text not null default 'open'
    constraint whatsapp_ai_enqueue_failures_status_check check (status in ('open', 'recovered', 'ineligible', 'expired')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint whatsapp_ai_enqueue_failures_conversation_fkey
    foreign key (conversation_id, company_id) references public.whatsapp_conversations (id, company_id) on delete cascade,
  constraint whatsapp_ai_enqueue_failures_message_fkey
    foreign key (message_id, company_id) references public.whatsapp_messages (id, company_id) on delete cascade
);
create index whatsapp_ai_enqueue_failures_open_idx on public.whatsapp_ai_enqueue_failures (created_at) where status = 'open';
create index whatsapp_ai_enqueue_failures_company_idx on public.whatsapp_ai_enqueue_failures (company_id, created_at desc);
alter table public.whatsapp_ai_enqueue_failures enable row level security;
revoke all on public.whatsapp_ai_enqueue_failures from public, anon, authenticated;
grant select on public.whatsapp_ai_enqueue_failures to service_role;

-- busca do reconciliador (só inbound recente)
create index whatsapp_messages_inbound_recent_idx on public.whatsapp_messages (created_at desc) where direction = 'inbound';

-- ---------------------------------------------------------------------------
-- 6) Enfileiramento / debounce (gatilho no INSERT do inbound)
-- ---------------------------------------------------------------------------
-- Só direction='inbound'. Já existe job ativo na conversa? Reagenda (latest_message_id = a nova, run_after = agora + 8 s,
-- com teto de 45 s desde a criação para uma sequência interminável não adiar para sempre). Senão cria. Sem job para
-- empresa fora de 'auto', conversa pausada ou atribuída.
create function public.whatsapp_ai_enqueue_inbound()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.company_whatsapp_ai_settings;
  v_conv public.whatsapp_conversations;
begin
  begin
    select * into v_s from public.company_whatsapp_ai_settings where company_id = new.company_id;
    if not found
       or public.whatsapp_ai_effective_mode(v_s.enabled, v_s.mode, v_s.ai_data_processing_acknowledged_at, v_s.auto_acknowledged_at) <> 'auto' then
      return new;
    end if;
    select * into v_conv from public.whatsapp_conversations where id = new.conversation_id and company_id = new.company_id;
    if not found or v_conv.ai_control <> 'inherit' or v_conv.assigned_user_id is not null then
      return new;
    end if;
    insert into public.whatsapp_ai_jobs (company_id, conversation_id, first_message_id, latest_message_id, run_after)
    values (new.company_id, new.conversation_id, new.id, new.id, now() + interval '8 seconds')
    on conflict (conversation_id) where status in ('pending', 'processing') do update
       set latest_message_id = excluded.latest_message_id,
           run_after = least(excluded.run_after, public.whatsapp_ai_jobs.created_at + interval '45 seconds');
  exception when others then
    -- rastreável: registra a mensagem que NÃO entrou na fila (só IDs + SQLSTATE). Se nem isto der, só o warning resta e o
    -- reconciliador ainda encontra a inbound elegível sem job.
    begin
      insert into public.whatsapp_ai_enqueue_failures (message_id, company_id, conversation_id, sqlstate)
      values (new.id, new.company_id, new.conversation_id, left(sqlstate, 5))
      on conflict (message_id) do nothing;
    exception when others then
      raise warning 'whatsapp_ai_enqueue_inbound: falha nao registrada: %', sqlstate;
    end;
    raise warning 'whatsapp_ai_enqueue_inbound falhou: %', sqlstate;
  end;
  return new;
end;
$$;
revoke execute on function public.whatsapp_ai_enqueue_inbound() from public, anon, authenticated, service_role;

create trigger whatsapp_messages_ai_enqueue
  after insert on public.whatsapp_messages
  for each row when (new.direction = 'inbound')
  execute function public.whatsapp_ai_enqueue_inbound();

-- ---------------------------------------------------------------------------
-- 6c) Reconciliador: inbound elegível SEM job (idempotente, multi-tenant, janela curta)
-- ---------------------------------------------------------------------------
-- Considera só a ÚLTIMA inbound de cada conversa, com idade entre 30 s e a janela (padrão 10 min, no máximo 60), em empresa
-- com o modo 'auto' efetivo, desde ANTES da última edição da configuração (nunca responde mensagem anterior à ativação),
-- conversa sem pausa/atribuição, sem saída posterior e sem NENHUM job (de qualquer status) que já cubra essa mensagem.
-- Cria no máximo um job por conversa (índice de job ativo). Falhas registradas viram recovered/ineligible/expired.
create function public.whatsapp_ai_reconcile_inbound(p_window interval default interval '10 minutes')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_win interval := least(greatest(coalesce(p_window, interval '10 minutes'), interval '1 minute'), interval '60 minutes');
  v_s public.company_whatsapp_ai_settings;
  v_conv public.whatsapp_conversations;
  v_recovered integer := 0;
  v_expired integer := 0;
begin
  update public.whatsapp_ai_enqueue_failures
     set status = 'expired', resolved_at = now()
   where status = 'open' and created_at < now() - v_win;
  get diagnostics v_expired = row_count;

  for r in
    select distinct on (m.conversation_id) m.id, m.company_id, m.conversation_id, m.created_at
      from public.whatsapp_messages m
     where m.direction = 'inbound'
       and m.created_at > now() - v_win
       and m.created_at <= now() - interval '30 seconds'
     order by m.conversation_id, m.created_at desc, m.id desc
  loop
    -- não é a inbound mais nova da conversa (chegou outra há menos de 30 s): fica para a próxima rodada
    if exists (
      select 1 from public.whatsapp_messages n
       where n.conversation_id = r.conversation_id and n.company_id = r.company_id and n.direction = 'inbound'
         and (n.created_at > r.created_at or (n.created_at = r.created_at and n.id > r.id))
    ) then
      continue;
    end if;
    select * into v_s from public.company_whatsapp_ai_settings where company_id = r.company_id;
    if not found
       or public.whatsapp_ai_effective_mode(v_s.enabled, v_s.mode, v_s.ai_data_processing_acknowledged_at, v_s.auto_acknowledged_at) <> 'auto'
       or v_s.updated_at > r.created_at then
      continue;
    end if;
    select * into v_conv from public.whatsapp_conversations where id = r.conversation_id and company_id = r.company_id;
    if not found or v_conv.ai_control <> 'inherit' or v_conv.assigned_user_id is not null then
      continue;
    end if;
    -- já respondida (qualquer saída depois dela)?
    if exists (
      select 1 from public.whatsapp_messages o
       where o.conversation_id = r.conversation_id and o.company_id = r.company_id and o.direction = 'outbound'
         and o.created_at > r.created_at
    ) then
      continue;
    end if;
    -- já coberta por algum job (o job já olhou para esta mensagem ou para uma mais nova)?
    if exists (
      select 1 from public.whatsapp_ai_jobs j
        join public.whatsapp_messages lm on lm.id = j.latest_message_id and lm.company_id = j.company_id
       where j.conversation_id = r.conversation_id and j.company_id = r.company_id and lm.created_at >= r.created_at
    ) then
      continue;
    end if;

    insert into public.whatsapp_ai_jobs (company_id, conversation_id, first_message_id, latest_message_id, run_after)
    values (r.company_id, r.conversation_id, r.id, r.id, now())
    on conflict (conversation_id) where status in ('pending', 'processing') do update
       set latest_message_id = excluded.latest_message_id;
    v_recovered := v_recovered + 1;
  end loop;

  -- falhas registradas: cobertas por um job agora => recovered; conversa/empresa não elegível => ineligible
  update public.whatsapp_ai_enqueue_failures f
     set status = 'recovered', resolved_at = now()
   where f.status = 'open'
     and exists (
       select 1 from public.whatsapp_ai_jobs j
         join public.whatsapp_messages lm on lm.id = j.latest_message_id and lm.company_id = j.company_id
         join public.whatsapp_messages fm on fm.id = f.message_id and fm.company_id = f.company_id
        where j.conversation_id = f.conversation_id and j.company_id = f.company_id and lm.created_at >= fm.created_at);
  update public.whatsapp_ai_enqueue_failures f
     set status = 'ineligible', resolved_at = now()
   where f.status = 'open'
     and (
       not exists (
         select 1 from public.company_whatsapp_ai_settings s
          where s.company_id = f.company_id
            and public.whatsapp_ai_effective_mode(s.enabled, s.mode, s.ai_data_processing_acknowledged_at, s.auto_acknowledged_at) = 'auto')
       or exists (
         select 1 from public.whatsapp_conversations c
          where c.id = f.conversation_id and c.company_id = f.company_id and (c.ai_control <> 'inherit' or c.assigned_user_id is not null)));

  return jsonb_build_object('recovered', v_recovered, 'expired', v_expired);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) Worker: claim
-- ---------------------------------------------------------------------------
-- Pega até p_limit jobs vencidos (pending com run_after <= now, ou processing com lease expirado) com SKIP LOCKED:
-- dois workers nunca recebem o mesmo job. Antes disso: pendentes velhos (>15 min, ex.: kill switch desligado) são
-- encerrados como 'ignored' (nunca responder mensagem antiga) e jobs que estouraram 3 tentativas são encerrados.
create function public.whatsapp_ai_claim_jobs(p_limit integer default 5, p_lease_seconds integer default 120)
returns setof public.whatsapp_ai_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
begin
  update public.whatsapp_ai_jobs
     set status = 'done', outcome = 'ignored', reason_code = 'job_expired', locked_until = null
   where status = 'pending' and run_after < now() - interval '15 minutes';

  with ex as (
    update public.whatsapp_ai_jobs
       set status = 'done', outcome = 'provider_error', reason_code = 'attempts_exhausted', locked_until = null
     where status = 'processing' and locked_until < now() and attempts >= 3
    returning id)
  select coalesce(array_agg(id), '{}'::uuid[]) into v_ids from ex;
  -- uma saída que ficou 'queued' (worker morreu no envio) NUNCA fica para sempre "enviando": falha explícita, sem reenvio
  if cardinality(v_ids) > 0 then
    with f as (
      update public.whatsapp_messages
         set status = 'failed', error_code = 'send_interrupted'
       where ai_job_id = any(v_ids) and status = 'queued'
      returning id, company_id)
    insert into public.whatsapp_message_events (company_id, message_id, status, error_code)
    select company_id, id, 'failed', 'send_interrupted' from f
    on conflict do nothing;
  end if;

  return query
  with due as (
    select j.id
      from public.whatsapp_ai_jobs j
     where (j.status = 'pending' and j.run_after <= now())
        or (j.status = 'processing' and j.locked_until < now() and j.attempts < 3)
     order by j.run_after
     limit greatest(1, least(coalesce(p_limit, 5), 20))
       for update skip locked
  )
  update public.whatsapp_ai_jobs j
     set status = 'processing',
         attempts = j.attempts + 1,
         locked_until = now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 120), 600)))
    from due
   where j.id = due.id
  returning j.*;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8) Worker: preparar (barreiras determinísticas + contexto mínimo)
-- ---------------------------------------------------------------------------
-- Devolve { proceed:false, outcome, reason } (a Edge encerra o job sem custo) ou { proceed:true, ...contexto }.
create function public.whatsapp_ai_prepare_auto(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.whatsapp_ai_jobs;
  v_conv public.whatsapp_conversations;
  v_conn public.company_whatsapp_connections;
  v_s public.company_whatsapp_ai_settings;
  v_win jsonb;
  v_hours_ok boolean;
  v_customer_first text;
  v_messages jsonb;
  v_ah_sent boolean;
  v_out public.whatsapp_messages;
begin
  select * into v_job from public.whatsapp_ai_jobs where id = p_job_id;
  if not found or v_job.status <> 'processing' then
    return jsonb_build_object('proceed', false, 'outcome', null, 'reason', 'not_active');
  end if;

  -- RETOMADA (lease expirado depois do commit): o job já tem saída. Nunca gera/envia outra; a Edge só resolve o estado dela.
  select * into v_out from public.whatsapp_messages where ai_job_id = v_job.id;
  if found then
    return jsonb_build_object('proceed', false, 'resume', true, 'message_id', v_out.id, 'status', v_out.status,
      'after_hours', exists (
        select 1 from public.company_whatsapp_ai_settings s
         where s.company_id = v_job.company_id and s.after_hours_policy = 'message' and s.after_hours_message = v_out.body
           and not public.whatsapp_ai_in_hours(s.business_schedule)));
  end if;

  select * into v_conv from public.whatsapp_conversations where id = v_job.conversation_id and company_id = v_job.company_id;
  select * into v_s from public.company_whatsapp_ai_settings where company_id = v_job.company_id;
  if not found
     or public.whatsapp_ai_effective_mode(v_s.enabled, v_s.mode, v_s.ai_data_processing_acknowledged_at, v_s.auto_acknowledged_at) <> 'auto' then
    return jsonb_build_object('proceed', false, 'outcome', 'aborted_mode', 'reason', 'mode_not_auto');
  end if;
  if not public.company_has_module(v_job.company_id, 'whatsapp') then
    return jsonb_build_object('proceed', false, 'outcome', 'aborted_mode', 'reason', 'module_inactive');
  end if;
  if v_conv.ai_control <> 'inherit' or v_conv.assigned_user_id is not null then
    return jsonb_build_object('proceed', false, 'outcome', 'aborted_human', 'reason', case when v_conv.assigned_user_id is not null then 'assigned' else 'ai_paused' end);
  end if;
  if v_conv.status = 'closed' then
    return jsonb_build_object('proceed', false, 'outcome', 'aborted_closed', 'reason', 'conversation_closed');
  end if;
  select * into v_conn from public.company_whatsapp_connections where id = v_conv.connection_id;
  if not found or v_conn.status <> 'active' then
    return jsonb_build_object('proceed', false, 'outcome', 'failed_send', 'reason', 'connection_inactive');
  end if;
  if v_conn.mode = 'test' and not exists (
    select 1 from public.whatsapp_test_recipients r
     where r.connection_id = v_conn.id and r.phone_e164 = v_conv.contact_phone and r.is_active
  ) then
    return jsonb_build_object('proceed', false, 'outcome', 'failed_send', 'reason', 'test_recipient_blocked');
  end if;
  v_win := public.whatsapp_can_send_freeform(v_conv.last_inbound_at);
  if not (v_win ->> 'can_send')::boolean then
    return jsonb_build_object('proceed', false, 'outcome', 'window_closed', 'reason', 'window_closed');
  end if;
  -- já há resposta humana depois do primeiro inbound do bloco?
  if exists (
    select 1 from public.whatsapp_messages o
     where o.conversation_id = v_conv.id and o.company_id = v_conv.company_id
       and o.direction = 'outbound' and o.origin = 'human' and o.status <> 'failed'
       and o.created_at > (select f.created_at from public.whatsapp_messages f where f.id = v_job.first_message_id)
  ) then
    return jsonb_build_object('proceed', false, 'outcome', 'aborted_human', 'reason', 'human_replied');
  end if;

  v_hours_ok := public.whatsapp_ai_in_hours(v_s.business_schedule);
  if not v_hours_ok and v_s.after_hours_policy = 'silent' then
    return jsonb_build_object('proceed', false, 'outcome', 'out_of_hours', 'reason', 'after_hours_silent');
  end if;
  if not v_hours_ok and v_s.after_hours_policy = 'message' then
    -- mensagem fixa, no máximo 1 a cada 12 h por conversa; sem mensagem configurada = silêncio
    select exists (
      select 1 from public.whatsapp_ai_jobs j
       where j.conversation_id = v_conv.id and j.outcome = 'out_of_hours' and j.reason_code = 'after_hours_message_sent'
         and j.created_at > now() - interval '12 hours'
    ) into v_ah_sent;
    if v_ah_sent or nullif(btrim(coalesce(v_s.after_hours_message, '')), '') is null then
      return jsonb_build_object('proceed', false, 'outcome', 'out_of_hours', 'reason', 'after_hours_silent');
    end if;
    return jsonb_build_object('proceed', true, 'after_hours_message', v_s.after_hours_message, 'latest_message_id', v_job.latest_message_id,
                              'company_id', v_job.company_id, 'conversation_id', v_job.conversation_id);
  end if;

  if v_conv.customer_id is not null then
    select split_part(btrim(c.name), ' ', 1) into v_customer_first
      from public.customers c
     where c.company_id = v_conv.company_id and c.id = v_conv.customer_id;
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object('direction', t.direction, 'at', t.at, 'type', t.type, 'text', t.txt) order by t.at, t.id), '[]'::jsonb)
    into v_messages
    from (
      select m.id, m.direction, m.type, coalesce(m.provider_timestamp, m.created_at) as at,
             case m.type
               when 'text' then public.whatsapp_ai_redact(m.body)
               else btrim(
                      case m.type
                        when 'image' then '[imagem]'
                        when 'audio' then '[áudio]'
                        when 'document' then '[documento]'
                        when 'location' then '[localização]'
                        when 'interactive' then '[mensagem interativa]'
                        when 'template' then '[mensagem modelo]'
                        else '[mensagem não suportada]'
                      end || ' ' || public.whatsapp_ai_redact(m.body))
             end as txt
        from public.whatsapp_messages m
       where m.company_id = v_conv.company_id
         and m.conversation_id = v_conv.id
         and m.status <> 'failed'
       order by coalesce(m.provider_timestamp, m.created_at) desc, m.id desc
       limit v_s.max_context_messages
    ) t;

  return jsonb_build_object(
    'proceed', true,
    'company_id', v_job.company_id,
    'conversation_id', v_job.conversation_id,
    'latest_message_id', v_job.latest_message_id,
    'business_name', v_s.business_name,
    'tone', v_s.tone,
    'custom_instructions', v_s.custom_instructions,
    'business_hours', v_s.business_hours,
    'fallback_to_human', v_s.fallback_to_human,
    'outside_hours', not v_hours_ok,
    'customer_first_name', nullif(v_customer_first, ''),
    'messages', v_messages);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9) Worker: cota do automático (reserva ANTES do provedor)
-- ---------------------------------------------------------------------------
-- Limites técnicos de proteção (não são plano): por conversa 6/h; empresa 10/min, 120/h, 1.000/dia, 20.000/mês.
-- Conta TENTATIVAS (reservas), inclusive as que terminam em handoff/erro. Independente da cota de sugestão.
create function public.whatsapp_ai_reserve_auto_usage(p_job_id uuid, p_provider text, p_model text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.whatsapp_ai_jobs;
  v_provider text := left(coalesce(nullif(btrim(p_provider), ''), 'unknown'), 60);
  v_model text := left(coalesce(nullif(btrim(p_model), ''), 'unknown'), 120);
  v_reason text;
  v_id uuid;
  v_min integer;
  v_hour integer;
  v_day integer;
  v_month integer;
  v_conv integer;
begin
  select * into v_job from public.whatsapp_ai_jobs where id = p_job_id and status = 'processing';
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('whatsapp_ai_auto_quota:' || v_job.company_id::text, 0));

  select count(*) filter (where created_at > now() - interval '1 minute'),
         count(*) filter (where created_at > now() - interval '1 hour'),
         count(*) filter (where created_at > now() - interval '24 hours'),
         count(*),
         count(*) filter (where conversation_id = v_job.conversation_id and created_at > now() - interval '1 hour')
    into v_min, v_hour, v_day, v_month, v_conv
    from public.whatsapp_ai_usage
   where company_id = v_job.company_id and kind = 'auto' and reservation_id is null and status <> 'blocked'
     and created_at > now() - interval '30 days';

  if v_conv >= 6 then v_reason := 'auto_conversation';
  elsif v_min >= 10 then v_reason := 'auto_minute';
  elsif v_hour >= 120 then v_reason := 'auto_hour';
  elsif v_day >= 1000 then v_reason := 'auto_day';
  elsif v_month >= 20000 then v_reason := 'auto_month';
  end if;

  if v_reason is not null then
    if not exists (
      select 1 from public.whatsapp_ai_usage
       where company_id = v_job.company_id and kind = 'auto' and status = 'blocked' and block_reason = v_reason
         and created_at > now() - interval '1 minute'
    ) then
      insert into public.whatsapp_ai_usage (company_id, conversation_id, user_id, provider, model, status, block_reason, kind, job_id, trigger_message_id)
      values (v_job.company_id, v_job.conversation_id, null, v_provider, v_model, 'blocked', v_reason, 'auto', v_job.id, v_job.latest_message_id);
    end if;
    return jsonb_build_object('result', 'blocked', 'reason', v_reason);
  end if;

  insert into public.whatsapp_ai_usage (company_id, conversation_id, user_id, provider, model, status, kind, job_id, trigger_message_id)
  values (v_job.company_id, v_job.conversation_id, null, v_provider, v_model, 'reserved', 'auto', v_job.id, v_job.latest_message_id)
  returning id into v_id;
  return jsonb_build_object('result', 'reserved', 'usage_id', v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 10) Worker: REVALIDAÇÃO FINAL + criação da mensagem 'queued'
-- ---------------------------------------------------------------------------
-- Tudo sob lock (job e conversa FOR UPDATE) imediatamente antes de criar o outbound. Resultados:
--   queued      -> mensagem criada (origin='ai_auto', sent_by_user_id NULL, client_request_id = job_id)
--   existing    -> o job já tem saída (retry do worker): nunca cria outra
--   rescheduled -> entrou inbound novo; a resposta antiga NÃO é enviada; job volta a 'pending' (máx. 2 regenerações)
--   abort       -> {outcome, reason}: não enviar
--   not_active  -> job não está mais 'processing' sob este lease
create function public.whatsapp_ai_auto_commit_send(p_job_id uuid, p_context_latest_message_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.whatsapp_ai_jobs;
  v_conv public.whatsapp_conversations;
  v_conn public.company_whatsapp_connections;
  v_s public.company_whatsapp_ai_settings;
  v_msg public.whatsapp_messages;
  v_body text := btrim(coalesce(p_body, ''));
  v_win jsonb;
  v_ctx_at timestamptz;
begin
  -- ORDEM DE LOCKS FIXA em todo o módulo: conversa -> job (o mesmo de assumir/devolver e do gatilho de pausa), sem deadlock
  perform 1 from public.whatsapp_conversations c
   where c.id = (select j.conversation_id from public.whatsapp_ai_jobs j where j.id = p_job_id) for update;
  select * into v_job from public.whatsapp_ai_jobs where id = p_job_id for update;
  if not found or v_job.status <> 'processing' then
    return jsonb_build_object('result', 'not_active');
  end if;

  -- retry do worker: o job já gerou saída
  select * into v_msg from public.whatsapp_messages where ai_job_id = v_job.id;
  if found then
    return jsonb_build_object('result', 'existing', 'message_id', v_msg.id, 'status', v_msg.status,
                              'age_seconds', floor(extract(epoch from (now() - v_msg.created_at)))::integer);
  end if;

  if char_length(v_body) = 0 or char_length(v_body) > 4096 then
    return jsonb_build_object('result', 'abort', 'outcome', 'invalid_output', 'reason', 'invalid_body');
  end if;

  select * into v_conv from public.whatsapp_conversations where id = v_job.conversation_id and company_id = v_job.company_id for update;
  if not found then
    return jsonb_build_object('result', 'abort', 'outcome', 'aborted_closed', 'reason', 'conversation_missing');
  end if;
  select * into v_s from public.company_whatsapp_ai_settings where company_id = v_job.company_id;
  if not found
     or public.whatsapp_ai_effective_mode(v_s.enabled, v_s.mode, v_s.ai_data_processing_acknowledged_at, v_s.auto_acknowledged_at) <> 'auto' then
    return jsonb_build_object('result', 'abort', 'outcome', 'aborted_mode', 'reason', 'mode_not_auto');
  end if;
  if not public.company_has_module(v_job.company_id, 'whatsapp') then
    return jsonb_build_object('result', 'abort', 'outcome', 'aborted_mode', 'reason', 'module_inactive');
  end if;
  if v_conv.ai_control <> 'inherit' or v_conv.assigned_user_id is not null then
    return jsonb_build_object('result', 'abort', 'outcome', 'aborted_human', 'reason', case when v_conv.assigned_user_id is not null then 'assigned' else 'ai_paused' end);
  end if;
  if v_conv.status = 'closed' then
    return jsonb_build_object('result', 'abort', 'outcome', 'aborted_closed', 'reason', 'conversation_closed');
  end if;
  select * into v_conn from public.company_whatsapp_connections where id = v_conv.connection_id;
  if not found or v_conn.status <> 'active' then
    return jsonb_build_object('result', 'abort', 'outcome', 'failed_send', 'reason', 'connection_inactive');
  end if;
  v_win := public.whatsapp_can_send_freeform(v_conv.last_inbound_at);
  if not (v_win ->> 'can_send')::boolean then
    return jsonb_build_object('result', 'abort', 'outcome', 'window_closed', 'reason', 'window_closed');
  end if;
  if v_conn.mode = 'test' and not exists (
    select 1 from public.whatsapp_test_recipients r
     where r.connection_id = v_conn.id and r.phone_e164 = v_conv.contact_phone and r.is_active
  ) then
    return jsonb_build_object('result', 'abort', 'outcome', 'failed_send', 'reason', 'test_recipient_blocked');
  end if;

  -- um humano respondeu depois do início do bloco
  if exists (
    select 1 from public.whatsapp_messages o
     where o.conversation_id = v_conv.id and o.company_id = v_conv.company_id
       and o.direction = 'outbound' and o.origin = 'human'
       and o.created_at > (select f.created_at from public.whatsapp_messages f where f.id = v_job.first_message_id)
  ) then
    return jsonb_build_object('result', 'abort', 'outcome', 'aborted_human', 'reason', 'human_replied');
  end if;

  -- entrou inbound mais novo que o contexto usado: NÃO enviar a resposta antiga
  select created_at into v_ctx_at from public.whatsapp_messages where id = p_context_latest_message_id and company_id = v_job.company_id;
  if v_ctx_at is null
     or v_job.latest_message_id is distinct from p_context_latest_message_id
     or exists (
       select 1 from public.whatsapp_messages i
        where i.conversation_id = v_conv.id and i.company_id = v_conv.company_id and i.direction = 'inbound'
          and (i.created_at > v_ctx_at or (i.created_at = v_ctx_at and i.id <> p_context_latest_message_id))
     ) then
    if v_job.regen_count < 2 then
      update public.whatsapp_ai_jobs
         set status = 'pending', regen_count = regen_count + 1, locked_until = null, attempts = 0,
             run_after = now() + interval '8 seconds'
       where id = v_job.id;
      return jsonb_build_object('result', 'rescheduled', 'regen_count', v_job.regen_count + 1);
    end if;
    return jsonb_build_object('result', 'abort', 'outcome', 'handoff', 'reason', 'too_many_changes');
  end if;

  insert into public.whatsapp_messages (company_id, connection_id, conversation_id, provider_message_id, direction, type, body,
                                        status, sent_by_user_id, client_request_id, origin, ai_job_id)
  values (v_conv.company_id, v_conv.connection_id, v_conv.id, null, 'outbound', 'text', v_body, 'queued', null, v_job.id, 'ai_auto', v_job.id)
  returning * into v_msg;

  insert into public.whatsapp_message_events (company_id, message_id, status) values (v_conv.company_id, v_msg.id, 'queued');

  update public.whatsapp_conversations
     set last_outbound_at = now(),
         last_message_at = greatest(coalesce(last_message_at, '-infinity'::timestamptz), now()),
         last_message_preview = left(v_body, 120)
   where id = v_conv.id;

  update public.whatsapp_ai_jobs set outbound_message_id = v_msg.id where id = v_job.id;

  return jsonb_build_object('result', 'queued', 'message_id', v_msg.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 11) Worker: encerrar o job
-- ---------------------------------------------------------------------------
-- p_handoff = true: passa a conversa para o humano (ai_control='human' + motivo). Se, enquanto o job rodava, entrou
-- inbound novo (latest_message_id mudou) e a conversa continua com a IA, nasce um job NOVO (o job encerrado nunca é reaberto).
create function public.whatsapp_ai_complete_job(
  p_job_id uuid,
  p_outcome text,
  p_reason_code text,
  p_usage_id uuid default null,
  p_handled_latest_message_id uuid default null,
  p_handoff boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.whatsapp_ai_jobs;
  v_reason text := nullif(left(regexp_replace(coalesce(p_reason_code, ''), '[^a-z0-9_]', '', 'g'), 60), '');
  v_status text;
  v_spawned boolean := false;
  v_conv public.whatsapp_conversations;
begin
  if p_outcome is null or p_outcome not in (
    'replied', 'handoff', 'ignored', 'aborted_stale', 'aborted_human', 'aborted_mode', 'aborted_closed', 'out_of_hours',
    'window_closed', 'blocked_quota', 'provider_error', 'timeout', 'invalid_output', 'rate_limited', 'failed_send') then
    return jsonb_build_object('result', 'invalid');
  end if;
  -- mesma ordem de locks do commit_send: conversa -> job
  perform 1 from public.whatsapp_conversations c
   where c.id = (select j.conversation_id from public.whatsapp_ai_jobs j where j.id = p_job_id) for update;
  select * into v_job from public.whatsapp_ai_jobs where id = p_job_id for update;
  if not found or v_job.status <> 'processing' then
    return jsonb_build_object('result', 'not_active');
  end if;
  v_status := case when p_outcome like 'aborted\_%' then 'cancelled' else 'done' end;

  update public.whatsapp_ai_jobs
     set status = v_status, outcome = p_outcome, reason_code = v_reason, locked_until = null,
         usage_id = coalesce(
           (select u.id from public.whatsapp_ai_usage u where u.id = p_usage_id and u.job_id = v_job.id and u.company_id = v_job.company_id),
           usage_id)
   where id = v_job.id;

  if p_handoff or p_outcome = 'handoff' then
    update public.whatsapp_conversations
       set ai_control = 'human', ai_control_changed_at = now(), ai_control_changed_by = null,
           ai_handoff_reason = coalesce(v_reason, 'other')
     where id = v_job.conversation_id and company_id = v_job.company_id and ai_control = 'inherit';
    insert into public.whatsapp_conversation_events (company_id, conversation_id, event_type, old_value, new_value)
    values (v_job.company_id, v_job.conversation_id, 'ai_handoff', jsonb_build_object('ai_control', 'inherit'),
            jsonb_build_object('ai_control', 'human', 'reason', coalesce(v_reason, 'other')));
  elsif p_outcome in ('replied', 'ignored', 'out_of_hours')
        and p_handled_latest_message_id is not null
        and v_job.latest_message_id is distinct from p_handled_latest_message_id then
    select * into v_conv from public.whatsapp_conversations where id = v_job.conversation_id;
    if v_conv.ai_control = 'inherit' and v_conv.assigned_user_id is null then
      insert into public.whatsapp_ai_jobs (company_id, conversation_id, first_message_id, latest_message_id, run_after)
      values (v_job.company_id, v_job.conversation_id, v_job.latest_message_id, v_job.latest_message_id, now() + interval '8 seconds');
      v_spawned := true;
    end if;
  end if;

  return jsonb_build_object('result', 'ok', 'status', v_status, 'followup_job', v_spawned);
end;
$$;

-- ---------------------------------------------------------------------------
-- 12) Despacho periódico (pg_cron -> pg_net -> Edge whatsapp-ai-auto)
-- ---------------------------------------------------------------------------
-- Só chama a Edge se existir job vencido/lease expirado e os segredos WHATSAPP_AI_AUTO_URL / WHATSAPP_AI_AUTO_SECRET existirem
-- no Vault (cadastro manual depois do deploy). Sem eles não faz nada: o job simplesmente espera (e expira em 15 min).
create function public.whatsapp_ai_dispatch_due()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_secret text;
begin
  if not exists (
    select 1 from public.whatsapp_ai_jobs j
     where (j.status = 'pending' and j.run_after <= now()) or (j.status = 'processing' and j.locked_until < now())
  ) then
    return;
  end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'WHATSAPP_AI_AUTO_URL' limit 1;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'WHATSAPP_AI_AUTO_SECRET' limit 1;
  if nullif(btrim(coalesce(v_url, '')), '') is null or nullif(btrim(coalesce(v_secret, '')), '') is null then
    return;
  end if;
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', v_secret),
    body := jsonb_build_object('source', 'cron')
  );
exception when others then
  raise warning 'whatsapp_ai_dispatch_due falhou: %', sqlstate;
end;
$$;

-- Agendamento de 10 s: só onde o pg_cron existe (no PGlite de teste não há schema cron).
do $$
begin
  if to_regnamespace('cron') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname in ('gap-whatsapp-ai-auto', 'gap-whatsapp-ai-reconcile');
    perform cron.schedule('gap-whatsapp-ai-auto', '10 seconds', 'select public.whatsapp_ai_dispatch_due()');
    perform cron.schedule('gap-whatsapp-ai-reconcile', '* * * * *', 'select public.whatsapp_ai_reconcile_inbound()');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 13) ACL
-- ---------------------------------------------------------------------------
revoke execute on function public.whatsapp_ai_get_settings(uuid) from public, anon, service_role;
grant execute on function public.whatsapp_ai_get_settings(uuid) to authenticated;
revoke execute on function public.whatsapp_ai_update_settings(uuid, boolean, text, text, text, text, jsonb, boolean, integer, boolean, boolean, text, text, jsonb) from public, anon, service_role;
grant execute on function public.whatsapp_ai_update_settings(uuid, boolean, text, text, text, text, jsonb, boolean, integer, boolean, boolean, text, text, jsonb) to authenticated;
revoke execute on function public.whatsapp_ai_prepare_suggestion(uuid) from public, anon, service_role;
grant execute on function public.whatsapp_ai_prepare_suggestion(uuid) to authenticated;
revoke execute on function public.whatsapp_ai_reserve_usage(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.whatsapp_ai_reserve_usage(uuid, uuid, uuid, text, text) to service_role;
revoke execute on function public.whatsapp_ai_finalize_usage(uuid, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.whatsapp_ai_finalize_usage(uuid, text, integer, integer, integer) to service_role;

revoke execute on function public.whatsapp_set_conversation_ai_control(uuid, text) from public, anon, service_role;
grant execute on function public.whatsapp_set_conversation_ai_control(uuid, text) to authenticated;

revoke execute on function public.whatsapp_ai_claim_jobs(integer, integer) from public, anon, authenticated;
revoke execute on function public.whatsapp_ai_prepare_auto(uuid) from public, anon, authenticated;
revoke execute on function public.whatsapp_ai_reserve_auto_usage(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.whatsapp_ai_auto_commit_send(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.whatsapp_ai_complete_job(uuid, text, text, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.whatsapp_ai_claim_jobs(integer, integer) to service_role;
grant execute on function public.whatsapp_ai_prepare_auto(uuid) to service_role;
grant execute on function public.whatsapp_ai_reserve_auto_usage(uuid, text, text) to service_role;
grant execute on function public.whatsapp_ai_auto_commit_send(uuid, uuid, text) to service_role;
grant execute on function public.whatsapp_ai_complete_job(uuid, text, text, uuid, uuid, boolean) to service_role;

revoke execute on function public.whatsapp_ai_reconcile_inbound(interval) from public, anon, authenticated;
grant execute on function public.whatsapp_ai_reconcile_inbound(interval) to service_role;

-- só o pg_cron (postgres) chama o despacho
revoke execute on function public.whatsapp_ai_dispatch_due() from public, anon, authenticated, service_role;

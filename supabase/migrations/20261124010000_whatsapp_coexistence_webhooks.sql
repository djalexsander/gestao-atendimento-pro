-- Coexistence, Etapa 3 (LOCAL, NÃO aplicada): webhooks smb_message_echoes / smb_app_state_sync / history / account_update,
-- pausa da IA por atendimento humano no app WhatsApp Business e bloqueio de envio em desconexão.
--
-- Contrato oficial usado: docs/whatsapp-coexistence-contrato-meta.md. Resumo do desenho:
--   * ECO (mensagem enviada pelo app/aparelho acompanhante) vira mensagem 'outbound', origin='human', sent_via='business_app',
--     sent_by_user_id nulo. Assim TODA a proteção que a IA já tem contra resposta humana (gatilho de pausa, revalidação em
--     whatsapp_ai_prepare_auto / whatsapp_ai_auto_commit_send, "já há resposta humana depois do primeiro inbound") passa a valer sem
--     tocar no pipeline da IA. A conversa vai para ai_control='human' e os jobs pendentes são cancelados.
--   * Eco só vale em conexão connection_type='coexistence' (empresas Cloud API tradicionais nunca são afetadas).
--   * Deduplicação: (a) chave do evento (webhook_events), (b) wamid já existente na conexão, (c) mensagem enviada PELA NOSSA API
--     ainda em voo (queued, mesmo texto, poucos minutos) = é o nosso próprio envio, não é humano: não pausa a IA.
--   * Sincronização (contatos/histórico) e account_update: SÓ registro seguro (contagens e nomes de evento), sem conteúdo,
--     sem telefone, sem nome. Nenhum histórico é importado nesta etapa.
--   * Desconexão: PARTNER_REMOVED => status 'disconnected' (conexões de Embedded Signup); ACCOUNT_OFFBOARDED => status 'error'
--     reversível (lifecycle_state='offboarded'); ACCOUNT_RECONNECTED só reativa o que o OFFBOARDED pausou, e NUNCA quando a empresa já
--     tem outra conexão ativa, quando há duas pausadas (ambíguo) ou quando o evento é mais antigo que o estado da conexão (entry.time). Todos os caminhos de envio já
--     exigem status='active' (get_send_context, prepare_outbound, IA, avisos), então o bloqueio vale para todos.
-- Não altera dados existentes, flags, webhooks da Meta, tokens nem conexões. Não importa histórico.

-- ---------------------------------------------------------------------------
-- 1) Dedupe/auditoria do webhook: novos tipos
-- ---------------------------------------------------------------------------
alter table public.whatsapp_webhook_events drop constraint whatsapp_webhook_events_type_check;
alter table public.whatsapp_webhook_events add constraint whatsapp_webhook_events_type_check
  check (event_type in ('message', 'status', 'echo'));

-- ---------------------------------------------------------------------------
-- 2) Mensagens: canal de origem
-- ---------------------------------------------------------------------------
alter table public.whatsapp_messages
  add column sent_via text not null default 'cloud_api'
    constraint whatsapp_messages_sent_via_check check (sent_via in ('cloud_api', 'business_app'));
alter table public.whatsapp_messages add constraint whatsapp_messages_sent_via_shape check (
  sent_via = 'cloud_api' or (direction = 'outbound' and origin = 'human' and sent_by_user_id is null));
comment on column public.whatsapp_messages.sent_via is
  'cloud_api = enviada/recebida pela API; business_app = enviada por uma pessoa pelo app WhatsApp Business (Coexistence), vista pelo eco.';

-- ---------------------------------------------------------------------------
-- 3) Conexão: ciclo de vida da Coexistence
-- ---------------------------------------------------------------------------
alter table public.company_whatsapp_connections
  add column lifecycle_state text not null default 'normal'
    constraint company_whatsapp_connections_lifecycle_check check (lifecycle_state in ('normal', 'offboarded', 'removed')),
  add column lifecycle_changed_at timestamptz,
  -- horário (da Meta) do último evento de ciclo de vida aplicado: eventos mais antigos que ele (ou que o onboarding) são descartados
  add column lifecycle_event_at timestamptz,
  add column lifecycle_reason text
    constraint company_whatsapp_connections_lifecycle_reason_check check (lifecycle_reason is null or lifecycle_reason ~ '^[A-Z0-9_]{1,60}$');

-- voltar a 'active' (reconexão pelo Embedded Signup, RECONNECTED, ajuste manual) limpa o estado de ciclo de vida
create function public.whatsapp_connection_lifecycle_reset()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'active' and old.status is distinct from 'active' then
    new.lifecycle_state := 'normal';
    new.lifecycle_reason := null;
    new.lifecycle_changed_at := now();
  end if;
  return new;
end;
$$;
revoke execute on function public.whatsapp_connection_lifecycle_reset() from public, anon, authenticated, service_role;
create trigger company_whatsapp_connections_lifecycle_reset
  before update of status on public.company_whatsapp_connections
  for each row execute function public.whatsapp_connection_lifecycle_reset();

-- ---------------------------------------------------------------------------
-- 4) Registro seguro de eventos de sincronização / ciclo de vida (SEM conteúdo, telefone ou nome)
-- ---------------------------------------------------------------------------
create table public.whatsapp_coexistence_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade,
  connection_id uuid references public.company_whatsapp_connections(id) on delete set null,
  waba_id text constraint whatsapp_coexistence_events_waba_check check (waba_id is null or waba_id ~ '^[0-9]{5,40}$'),
  kind text not null
    constraint whatsapp_coexistence_events_kind_check check (kind in (
      'contact_sync', 'history_chunk', 'history_declined', 'echo_revoke', 'echo_edit', 'account_update', 'echo_unmapped', 'echo_api_match')),
  event_name text constraint whatsapp_coexistence_events_name_check check (event_name is null or event_name ~ '^[A-Za-z0-9_]{1,60}$'),
  detail jsonb not null default '{}'::jsonb
    constraint whatsapp_coexistence_events_detail_size check (pg_column_size(detail) <= 600),
  provider_event_key text not null
    constraint whatsapp_coexistence_events_key_length check (char_length(provider_event_key) between 1 and 300),
  created_at timestamptz not null default now(),
  constraint whatsapp_coexistence_events_key_unique unique (provider_event_key)
);
create index whatsapp_coexistence_events_company_idx on public.whatsapp_coexistence_events (company_id, created_at desc);
alter table public.whatsapp_coexistence_events enable row level security;
revoke all on public.whatsapp_coexistence_events from public, anon, authenticated;
grant select, insert on public.whatsapp_coexistence_events to service_role;
comment on table public.whatsapp_coexistence_events is
  'Trilha mínima da Coexistence: contagens de sincronização e eventos de conta. Nunca guarda mensagens, telefones, nomes, payload bruto ou tokens.';

-- ---------------------------------------------------------------------------
-- 5) Eco: mensagem enviada pelo app WhatsApp Business
-- ---------------------------------------------------------------------------
create function public.whatsapp_ingest_echo(
  p_phone_number_id text,
  p_provider_message_id text,
  p_to text,
  p_type text,
  p_body text,
  p_provider_timestamp timestamptz,
  p_event_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conn public.company_whatsapp_connections;
  v_phone text;
  v_type text;
  v_body text;
  v_wamid text := left(nullif(btrim(coalesce(p_provider_message_id, '')), ''), 200);
  v_key text := left(nullif(btrim(coalesce(p_event_key, '')), ''), 300);
  v_event_id uuid;
  v_conv public.whatsapp_conversations;
  v_conv_new boolean := false;
  v_msg_id uuid;
  v_ts timestamptz := coalesce(p_provider_timestamp, now());
  v_preview text;
  v_paused integer;
  v_cancelled integer := 0;
begin
  select * into v_conn from public.company_whatsapp_connections where phone_number_id = p_phone_number_id;
  if not found then
    return jsonb_build_object('result', 'unknown_connection');
  end if;
  if v_conn.status <> 'active' then
    return jsonb_build_object('result', 'inactive_connection');
  end if;
  -- só números em Coexistence geram eco legítimo: Cloud API tradicional nunca é afetada por este caminho
  if v_conn.connection_type <> 'coexistence' then
    return jsonb_build_object('result', 'not_coexistence');
  end if;
  if v_wamid is null or v_key is null then
    return jsonb_build_object('result', 'invalid');
  end if;

  insert into public.whatsapp_webhook_events (connection_id, company_id, provider_event_key, event_type, provider_timestamp)
  values (v_conn.id, v_conn.company_id, v_key, 'echo', p_provider_timestamp)
  on conflict (provider_event_key) do nothing
  returning id into v_event_id;
  if v_event_id is null then
    return jsonb_build_object('result', 'duplicate');
  end if;

  -- o mesmo wamid já existe nesta conexão (mensagem nossa, enviada pela API, ou eco já gravado)
  if exists (select 1 from public.whatsapp_messages m where m.connection_id = v_conn.id and m.provider_message_id = v_wamid) then
    update public.whatsapp_webhook_events set processed = true, processing_error = 'duplicate_message' where id = v_event_id;
    return jsonb_build_object('result', 'duplicate');
  end if;

  v_phone := public.whatsapp_normalize_phone(p_to);
  if v_phone is null then
    -- sem telefone do destinatário (só BSUID) não dá para localizar a conversa: registra e não pausa nada
    update public.whatsapp_webhook_events set processed = true, processing_error = 'unmapped' where id = v_event_id;
    insert into public.whatsapp_coexistence_events (company_id, connection_id, kind, provider_event_key)
    values (v_conn.company_id, v_conn.id, 'echo_unmapped', 'unmapped:' || v_key)
    on conflict (provider_event_key) do nothing;
    return jsonb_build_object('result', 'unmapped');
  end if;

  v_type := case when p_type in ('text', 'image', 'audio', 'document', 'location', 'interactive') then p_type else 'unknown' end;
  v_body := left(nullif(btrim(coalesce(p_body, '')), ''), 4096);

  -- conversa do contato (ativa, tolerando a variação do nono dígito brasileiro)
  select * into v_conv from public.whatsapp_conversations c
   where c.connection_id = v_conn.id and c.deleted_at is null and public.whatsapp_br_phone_equivalent(c.contact_phone, v_phone)
   order by c.last_message_at desc nulls last
   limit 1
   for update;

  -- nosso próprio envio ainda em voo: o eco que chegou antes de gravarmos o wamid NÃO é atendimento humano
  if found and exists (
    select 1 from public.whatsapp_messages o
     where o.conversation_id = v_conv.id and o.company_id = v_conn.company_id and o.direction = 'outbound'
       and o.sent_via = 'cloud_api' and o.status = 'queued' and o.provider_message_id is null
       and o.created_at > now() - interval '10 minutes'
       and (v_type <> 'text' or o.body is not distinct from v_body)
  ) then
    update public.whatsapp_webhook_events set processed = true, processing_error = 'api_match' where id = v_event_id;
    insert into public.whatsapp_coexistence_events (company_id, connection_id, kind, provider_event_key)
    values (v_conn.company_id, v_conn.id, 'echo_api_match', 'apimatch:' || v_key)
    on conflict (provider_event_key) do nothing;
    return jsonb_build_object('result', 'api_match');
  end if;

  if not found then
    -- a pessoa escreveu primeiro, pelo celular: cria a conversa já com a IA pausada
    insert into public.whatsapp_conversations (company_id, connection_id, contact_phone, status, ai_control, ai_control_changed_at)
    values (v_conn.company_id, v_conn.id, v_phone, 'open', 'human', now())
    on conflict (connection_id, contact_phone) where deleted_at is null do update set updated_at = now()
    returning * into v_conv;
    v_conv_new := true;
  end if;

  -- 1) pausa a IA ANTES de gravar a mensagem (assim o gatilho de pausa por envio manual vira no-op e o motivo fica correto)
  update public.whatsapp_conversations
     set ai_control = 'human', ai_control_changed_at = now(), ai_control_changed_by = null, ai_handoff_reason = null
   where id = v_conv.id and ai_control = 'inherit';
  get diagnostics v_paused = row_count;
  if v_paused > 0 then
    insert into public.whatsapp_conversation_events (company_id, conversation_id, event_type, old_value, new_value)
    values (v_conn.company_id, v_conv.id, 'ai_paused', jsonb_build_object('ai_control', 'inherit'),
            jsonb_build_object('ai_control', 'human', 'reason', 'business_app_message'));
  end if;
  update public.whatsapp_ai_jobs
     set status = 'cancelled', outcome = 'aborted_human', reason_code = 'business_app_message', locked_until = null
   where conversation_id = v_conv.id and status = 'pending';
  get diagnostics v_cancelled = row_count;

  -- 2) grava a mensagem (saída humana pelo app)
  insert into public.whatsapp_messages (company_id, connection_id, conversation_id, provider_message_id, direction, type, body,
                                        status, sent_by_user_id, origin, sent_via, provider_timestamp)
  values (v_conn.company_id, v_conn.id, v_conv.id, v_wamid, 'outbound', v_type, v_body, 'sent', null, 'human', 'business_app', p_provider_timestamp)
  on conflict (connection_id, provider_message_id) do nothing
  returning id into v_msg_id;
  if v_msg_id is null then
    update public.whatsapp_webhook_events set processed = true, processing_error = 'duplicate_message' where id = v_event_id;
    return jsonb_build_object('result', 'duplicate');
  end if;
  insert into public.whatsapp_message_events (company_id, message_id, status, provider_timestamp)
  values (v_conn.company_id, v_msg_id, 'sent', p_provider_timestamp);

  v_preview := left(case v_type
    when 'text' then coalesce(v_body, 'Mensagem enviada')
    when 'image' then 'Imagem enviada'
    when 'audio' then 'Áudio enviado'
    when 'document' then 'Documento enviado'
    when 'location' then 'Localização enviada'
    else 'Mensagem enviada'
  end, 120);
  -- o eco NÃO abre nem estende a janela de 24 h (last_inbound_at fica como está)
  update public.whatsapp_conversations c
     set last_outbound_at = greatest(coalesce(c.last_outbound_at, '-infinity'::timestamptz), v_ts),
         last_message_preview = case when c.last_message_at is null or v_ts >= c.last_message_at then v_preview else c.last_message_preview end,
         last_message_at = greatest(coalesce(c.last_message_at, '-infinity'::timestamptz), v_ts)
   where c.id = v_conv.id;

  if v_conv_new then
    insert into public.whatsapp_conversation_events (company_id, conversation_id, event_type)
    values (v_conn.company_id, v_conv.id, 'created');
  end if;

  update public.whatsapp_webhook_events set processed = true where id = v_event_id;
  return jsonb_build_object('result', 'stored', 'conversation_id', v_conv.id, 'message_id', v_msg_id,
                            'ai_paused', v_paused > 0, 'cancelled_jobs', v_cancelled, 'new_conversation', v_conv_new);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Registro de sincronização (contatos / histórico) e revoke/edit: só contagens
-- ---------------------------------------------------------------------------
create function public.whatsapp_coexistence_record(
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
  return jsonb_build_object('result', 'recorded');
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) account_update: ciclo de vida da conexão
-- ---------------------------------------------------------------------------
create function public.whatsapp_coexistence_account_update(
  p_waba_id text,
  p_event text,
  p_reason text,
  p_event_key text,
  p_event_time bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event text := left(regexp_replace(coalesce(p_event, ''), '[^A-Za-z0-9_]', '', 'g'), 60);
  v_reason text := nullif(left(regexp_replace(coalesce(p_reason, ''), '[^A-Za-z0-9_]', '', 'g'), 60), '');
  v_key text := left(nullif(btrim(coalesce(p_event_key, '')), ''), 300);
  -- horário do evento na Meta (entry.time, segundos Unix): é a ÚNICA forma de ordenar eventos atrasados/fora de ordem
  v_when timestamptz := case when p_event_time between 1000000000 and 4102444800 and to_timestamp(p_event_time) <= now() + interval '1 day'
                             then to_timestamp(p_event_time) else null end;
  v_id uuid;
  v_company uuid;
  v_row record;
  v_base timestamptz;
  v_changed integer := 0;
  v_skipped integer := 0;
  v_stale integer := 0;
  v_before integer;
begin
  if p_waba_id is null or p_waba_id !~ '^[0-9]{5,40}$' or v_key is null or v_event = '' then
    return jsonb_build_object('result', 'invalid');
  end if;
  v_reason := upper(v_reason);

  insert into public.whatsapp_coexistence_events (waba_id, kind, event_name, detail, provider_event_key)
  values (p_waba_id, 'account_update', v_event, '{}'::jsonb, v_key)
  on conflict (provider_event_key) do nothing
  returning id into v_id;
  if v_id is null then
    return jsonb_build_object('result', 'duplicate');
  end if;

  -- sem horário confiável (ausente, fora de faixa ou no futuro) não há como saber se o evento é atual: só registra (nenhuma conexão é alterada)
  if v_when is null then
    update public.whatsapp_coexistence_events set detail = jsonb_build_object('changed', 0, 'skipped', 'no_event_time') where id = v_id;
    return jsonb_build_object('result', 'ignored', 'changed', 0, 'reason', 'no_event_time');
  end if;

  -- MESMA ordem de travas da conclusão do Embedded Signup (advisory por empresa -> linha), para não haver deadlock nem corrida
  -- com uma conexão nova sendo ativada ao mesmo tempo
  for v_company in
    select distinct c.company_id from public.company_whatsapp_connections c
     where c.waba_id = p_waba_id and c.connection_source = 'embedded_signup' order by c.company_id
  loop
    perform pg_advisory_xact_lock(hashtextextended('wa_conn:' || v_company::text, 0));
  end loop;

  -- só conexões criadas pelo Embedded Signup nesta WABA: conexões manuais (ex.: empresas já em produção) nunca são alteradas
  for v_row in
    select c.id, c.company_id, c.status, c.lifecycle_state, c.connection_type, c.connected_at, c.lifecycle_event_at
      from public.company_whatsapp_connections c
     where c.waba_id = p_waba_id and c.connection_source = 'embedded_signup'
     order by c.id
       for update
  loop
    v_before := v_changed;

    -- evento ANTERIOR ao onboarding desta conexão ou a um evento de ciclo de vida já aplicado nela: é atrasado/fora de ordem
    v_base := greatest(date_trunc('second', coalesce(v_row.connected_at, '-infinity'::timestamptz)),
                       coalesce(v_row.lifecycle_event_at, '-infinity'::timestamptz));
    if v_when < v_base then
      v_stale := v_stale + 1;
      continue;
    end if;

    if v_event = 'PARTNER_REMOVED' then
      if v_row.status <> 'disconnected' or v_row.lifecycle_state <> 'removed' then
        update public.company_whatsapp_connections
           set status = 'disconnected', disconnected_at = coalesce(disconnected_at, now()),
               lifecycle_state = 'removed', lifecycle_reason = coalesce(v_reason, 'PARTNER_REMOVED'), lifecycle_changed_at = now()
         where id = v_row.id;
        v_changed := v_changed + 1;
      end if;
    elsif v_event = 'ACCOUNT_OFFBOARDED' and v_row.connection_type = 'coexistence' then
      if v_row.status = 'active' and v_row.lifecycle_state = 'normal' then
        update public.company_whatsapp_connections
           set status = 'error', lifecycle_state = 'offboarded', lifecycle_reason = 'ACCOUNT_OFFBOARDED', lifecycle_changed_at = now()
         where id = v_row.id;
        v_changed := v_changed + 1;
      end if;
    elsif v_event = 'ACCOUNT_RECONNECTED' and v_row.connection_type = 'coexistence' then
      -- candidata = só a conexão que o OFFBOARDED pausou (uma removida/desconectada pelo cliente nunca volta sozinha)
      if v_row.status = 'error' and v_row.lifecycle_state = 'offboarded' then
        if exists (select 1 from public.company_whatsapp_connections o
                    where o.company_id = v_row.company_id and o.status = 'active' and o.id <> v_row.id) then
          -- a empresa já tem OUTRA conexão ativa (conectou outro número depois): a antiga NUNCA é reativada; a atual fica intacta
          v_skipped := v_skipped + 1;
        elsif exists (select 1 from public.company_whatsapp_connections o
                       where o.company_id = v_row.company_id and o.id <> v_row.id and o.status = 'error' and o.lifecycle_state = 'offboarded') then
          -- duas conexões da mesma empresa pausadas: o evento não diz qual voltou => não reativa nenhuma por palpite
          v_skipped := v_skipped + 1;
        else
          begin
            update public.company_whatsapp_connections set status = 'active' where id = v_row.id;
            v_changed := v_changed + 1;
          exception when unique_violation then
            -- última barreira (índice de uma conexão ativa por empresa): trata como ignorado, nunca como erro do webhook
            v_skipped := v_skipped + 1;
          end;
        end if;
      end if;
    end if;
    -- marca d'água: um OFFBOARDED atrasado (anterior a um RECONNECTED já visto) não pode mais pausar a conexão, mesmo que o RECONNECTED
    -- tenha chegado antes e não tenha mudado nada
    if v_event = 'PARTNER_REMOVED' or (v_event in ('ACCOUNT_OFFBOARDED', 'ACCOUNT_RECONNECTED') and v_row.connection_type = 'coexistence') then
      update public.company_whatsapp_connections set lifecycle_event_at = v_when
       where id = v_row.id and (lifecycle_event_at is null or lifecycle_event_at < v_when);
    end if;
    if v_changed > v_before and v_event <> 'ACCOUNT_RECONNECTED' then
      -- envio em voo dessa conexão deixa de existir como pendente de IA
      update public.whatsapp_ai_jobs j
         set status = 'cancelled', outcome = 'aborted_mode', reason_code = 'connection_unavailable', locked_until = null
       where j.company_id = v_row.company_id and j.status = 'pending'
         and exists (select 1 from public.whatsapp_conversations c where c.id = j.conversation_id and c.connection_id = v_row.id);
    end if;
  end loop;

  update public.whatsapp_coexistence_events
     set company_id = (select c.company_id from public.company_whatsapp_connections c where c.waba_id = p_waba_id and c.connection_source = 'embedded_signup' order by c.id limit 1),
         connection_id = (select c.id from public.company_whatsapp_connections c where c.waba_id = p_waba_id and c.connection_source = 'embedded_signup' order by c.id limit 1),
         detail = jsonb_build_object('changed', v_changed, 'skipped', v_skipped, 'stale', v_stale)
   where id = v_id;
  return jsonb_build_object('result', case when v_changed = 0 and (v_skipped > 0 or v_stale > 0) then 'ignored' else 'recorded' end,
                            'changed', v_changed, 'skipped', v_skipped, 'stale', v_stale);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8) O envio da API que chega depois do eco com o mesmo wamid não pode falhar
-- ---------------------------------------------------------------------------
-- (igual a 20261015040000 + tratamento de unique_violation). Se um eco foi gravado por engano com o wamid de um envio nosso ainda
-- 'queued', o eco é descartado e o envio é registrado normalmente.
create or replace function public.whatsapp_mark_message_sent(p_message_id uuid, p_provider_message_id text, p_provider_timestamp timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_msg public.whatsapp_messages;
  v_wamid text := left(p_provider_message_id, 200);
  v_dropped integer;
begin
  if nullif(btrim(coalesce(p_provider_message_id, '')), '') is null then
    return jsonb_build_object('result', 'invalid');
  end if;
  select * into v_msg from public.whatsapp_messages where id = p_message_id and direction = 'outbound' for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_msg.status <> 'queued' then
    return jsonb_build_object('result', 'ignored', 'status', v_msg.status);
  end if;
  begin
    update public.whatsapp_messages
       set status = 'sent', provider_message_id = v_wamid, provider_timestamp = coalesce(p_provider_timestamp, now())
     where id = v_msg.id;
  exception when unique_violation then
    delete from public.whatsapp_messages
     where connection_id = v_msg.connection_id and provider_message_id = v_wamid and id <> v_msg.id and sent_via = 'business_app';
    get diagnostics v_dropped = row_count;
    if v_dropped = 0 then
      raise;
    end if;
    update public.whatsapp_messages
       set status = 'sent', provider_message_id = v_wamid, provider_timestamp = coalesce(p_provider_timestamp, now())
     where id = v_msg.id;
  end;
  insert into public.whatsapp_message_events (company_id, message_id, status, provider_timestamp)
  values (v_msg.company_id, v_msg.id, 'sent', coalesce(p_provider_timestamp, now()))
  on conflict do nothing;
  return jsonb_build_object('result', 'sent', 'message_id', v_msg.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9) ACL: só service_role (Edge do webhook)
-- ---------------------------------------------------------------------------
revoke execute on function public.whatsapp_ingest_echo(text, text, text, text, text, timestamptz, text) from public, anon, authenticated;
revoke execute on function public.whatsapp_coexistence_record(text, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.whatsapp_coexistence_account_update(text, text, text, text, bigint) from public, anon, authenticated;
grant execute on function public.whatsapp_ingest_echo(text, text, text, text, text, timestamptz, text) to service_role;
grant execute on function public.whatsapp_coexistence_record(text, text, text, text, jsonb) to service_role;
grant execute on function public.whatsapp_coexistence_account_update(text, text, text, text, bigint) to service_role;

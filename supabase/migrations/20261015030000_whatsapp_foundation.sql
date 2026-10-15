-- WhatsApp (API oficial Meta Cloud), FASE 2A-1: fundação de conexão, conversas e mensagens RECEBIDAS. Inbox somente leitura.
--
-- Não há envio, templates, mídia, automações nem integração com o Delivery nesta fase.
--
-- MODELO (tudo isolado por company_id; escrita só por funções SECURITY DEFINER):
--   company_whatsapp_connections   1 conexão ATIVA por empresa; phone_number_id único no sistema. O TOKEN da Meta nunca
--                                   está aqui: só token_secret_id (referência ao Supabase Vault, nome wa_token_<id>).
--                                   Sem GRANT de leitura para o cliente (status sai por whatsapp_get_connection_summary).
--   company_whatsapp_settings       retenção de conteúdo (default 90 dias, configurável; apenas modelo — sem purga).
--   whatsapp_test_recipients        destinatários permitidos no mode='test' (falha fechada no envio futuro).
--   whatsapp_conversations          1 por (conexão, telefone E.164 só dígitos); cliente NUNCA criado/associado sozinho.
--   whatsapp_messages               texto necessário + tipo; sem JSON bruto da Meta; mídia só como tipo (sem download).
--   whatsapp_message_events         append-only: histórico de status por mensagem (a coluna status é monotônica).
--   whatsapp_conversation_events    append-only: criada, (reservado) atribuída, fechada, reaberta, cliente/pedido vinculado.
--   whatsapp_webhook_events         dedupe e auditoria mínima do webhook (chave do evento; sem payload bruto).
--
-- Acesso do cliente: owner/admin/attendant/cashier da empresa COM o módulo 'whatsapp' (production e courier: nada).
-- O webhook (service_role) chama whatsapp_ingest_message / whatsapp_ingest_status: idempotentes e transacionais.

-- ---------------------------------------------------------------------------
-- 1) Tabelas
-- ---------------------------------------------------------------------------
create table public.company_whatsapp_connections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  provider text not null default 'meta_cloud'
    constraint company_whatsapp_connections_provider_check check (provider = 'meta_cloud'),
  status text not null default 'pending'
    constraint company_whatsapp_connections_status_check check (status in ('pending', 'active', 'disconnected', 'error')),
  -- 'test' por padrão: o envio futuro só vai para whatsapp_test_recipients.
  mode text not null default 'test'
    constraint company_whatsapp_connections_mode_check check (mode in ('test', 'live')),
  waba_id text,
  phone_number_id text
    constraint company_whatsapp_connections_pnid_check check (phone_number_id is null or phone_number_id ~ '^[0-9]{5,40}$'),
  display_phone_number text,
  business_name text,
  -- referência ao segredo no Supabase Vault (wa_token_<id>). NUNCA o token.
  token_secret_id uuid,
  webhook_status text,
  connected_at timestamptz,
  disconnected_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint company_whatsapp_connections_company_id_id_key unique (company_id, id),
  constraint company_whatsapp_connections_id_company_key unique (id, company_id)
);

create unique index company_whatsapp_connections_phone_number_id_uniq
  on public.company_whatsapp_connections (phone_number_id) where phone_number_id is not null;
create unique index company_whatsapp_connections_one_active
  on public.company_whatsapp_connections (company_id) where status = 'active';

create trigger company_whatsapp_connections_set_updated_at
  before update on public.company_whatsapp_connections
  for each row execute function public.set_updated_at();

create table public.company_whatsapp_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  retention_days integer not null default 90
    constraint company_whatsapp_settings_retention_check check (retention_days between 1 and 3650),
  auto_mark_read boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.company_whatsapp_settings.retention_days is
  'Retenção do CONTEÚDO das mensagens, em dias (default operacional 90, configurável). Só o modelo: nenhuma purga automática nesta fase.';

create trigger company_whatsapp_settings_set_updated_at
  before update on public.company_whatsapp_settings
  for each row execute function public.set_updated_at();

create table public.whatsapp_test_recipients (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  connection_id uuid not null,
  phone_e164 text not null
    constraint whatsapp_test_recipients_phone_check check (phone_e164 ~ '^[0-9]{10,15}$'),
  label text
    constraint whatsapp_test_recipients_label_length check (label is null or char_length(label) between 1 and 60),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint whatsapp_test_recipients_connection_fkey
    foreign key (connection_id, company_id) references public.company_whatsapp_connections (id, company_id) on delete cascade,
  constraint whatsapp_test_recipients_unique unique (connection_id, phone_e164)
);

create table public.whatsapp_conversations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  connection_id uuid not null,
  -- E.164 só com dígitos (ex.: 5544999999999). Sem máscara no banco.
  contact_phone text not null
    constraint whatsapp_conversations_phone_check check (contact_phone ~ '^[0-9]{10,15}$'),
  contact_display_name text
    constraint whatsapp_conversations_name_length check (contact_display_name is null or char_length(contact_display_name) between 1 and 80),
  customer_id uuid,
  status text not null default 'open'
    constraint whatsapp_conversations_status_check check (status in ('open', 'waiting', 'closed')),
  assigned_user_id uuid references auth.users(id) on delete set null,
  unread_count integer not null default 0
    constraint whatsapp_conversations_unread_check check (unread_count >= 0),
  -- prévia curta da última mensagem (a lista não consulta o histórico); some junto com a retenção futura
  last_message_preview text
    constraint whatsapp_conversations_preview_length check (last_message_preview is null or char_length(last_message_preview) <= 120),
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_conversations_connection_fkey
    foreign key (connection_id, company_id) references public.company_whatsapp_connections (id, company_id) on delete cascade,
  constraint whatsapp_conversations_customer_fkey
    foreign key (company_id, customer_id) references public.customers (company_id, id),
  constraint whatsapp_conversations_phone_unique unique (connection_id, contact_phone),
  constraint whatsapp_conversations_id_company_key unique (id, company_id),
  constraint whatsapp_conversations_id_connection_key unique (id, connection_id)
);

create index whatsapp_conversations_list_idx
  on public.whatsapp_conversations (company_id, status, last_message_at desc);

create trigger whatsapp_conversations_set_updated_at
  before update on public.whatsapp_conversations
  for each row execute function public.set_updated_at();

create table public.whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  connection_id uuid not null,
  conversation_id uuid not null,
  provider_message_id text not null
    constraint whatsapp_messages_provider_id_length check (char_length(provider_message_id) between 1 and 200),
  direction text not null
    constraint whatsapp_messages_direction_check check (direction in ('inbound', 'outbound')),
  type text not null
    constraint whatsapp_messages_type_check check (type in ('text', 'image', 'audio', 'document', 'location', 'interactive', 'template', 'unknown')),
  body text
    constraint whatsapp_messages_body_length check (body is null or char_length(body) <= 4096),
  status text not null
    constraint whatsapp_messages_status_check check (status in ('received', 'queued', 'sent', 'delivered', 'read', 'failed')),
  error_code text
    constraint whatsapp_messages_error_code_length check (error_code is null or char_length(error_code) <= 64),
  sent_by_user_id uuid references auth.users(id) on delete set null,
  provider_timestamp timestamptz,
  created_at timestamptz not null default now(),
  constraint whatsapp_messages_conversation_fkey
    foreign key (conversation_id, company_id) references public.whatsapp_conversations (id, company_id) on delete cascade,
  constraint whatsapp_messages_conversation_connection_fkey
    foreign key (conversation_id, connection_id) references public.whatsapp_conversations (id, connection_id) on delete cascade,
  constraint whatsapp_messages_provider_unique unique (connection_id, provider_message_id),
  constraint whatsapp_messages_id_company_key unique (id, company_id)
);

create index whatsapp_messages_conversation_idx
  on public.whatsapp_messages (company_id, conversation_id, provider_timestamp, created_at);

create table public.whatsapp_message_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  message_id uuid not null,
  status text not null
    constraint whatsapp_message_events_status_check check (status in ('received', 'queued', 'sent', 'delivered', 'read', 'failed')),
  provider_timestamp timestamptz,
  error_code text
    constraint whatsapp_message_events_error_code_length check (error_code is null or char_length(error_code) <= 64),
  created_at timestamptz not null default now(),
  constraint whatsapp_message_events_message_fkey
    foreign key (message_id, company_id) references public.whatsapp_messages (id, company_id) on delete cascade
);

-- dedupe lógico do mesmo status da mesma mensagem (timestamp ausente conta como um valor único)
create unique index whatsapp_message_events_dedupe
  on public.whatsapp_message_events (message_id, status, coalesce(provider_timestamp, 'epoch'::timestamptz));

create table public.whatsapp_conversation_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  conversation_id uuid not null,
  event_type text not null
    constraint whatsapp_conversation_events_type_check check (event_type in (
      'created', 'assigned', 'unassigned', 'customer_linked', 'customer_unlinked', 'closed', 'reopened', 'order_linked')),
  actor_user_id uuid references auth.users(id) on delete set null,
  old_value jsonb,
  new_value jsonb,
  created_at timestamptz not null default now(),
  constraint whatsapp_conversation_events_conversation_fkey
    foreign key (conversation_id, company_id) references public.whatsapp_conversations (id, company_id) on delete cascade
);

create index whatsapp_conversation_events_idx
  on public.whatsapp_conversation_events (company_id, conversation_id, created_at);

create table public.whatsapp_webhook_events (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid references public.company_whatsapp_connections(id) on delete set null,
  company_id uuid references public.companies(id) on delete set null,
  -- chave derivada do id da Meta (mensagem: wamid; status: wamid + status + timestamp). Reentregas caem aqui.
  provider_event_key text not null
    constraint whatsapp_webhook_events_key_length check (char_length(provider_event_key) between 1 and 300),
  event_type text not null
    constraint whatsapp_webhook_events_type_check check (event_type in ('message', 'status')),
  provider_timestamp timestamptz,
  processed boolean not null default false,
  processing_error text
    constraint whatsapp_webhook_events_error_length check (processing_error is null or char_length(processing_error) <= 200),
  created_at timestamptz not null default now(),
  constraint whatsapp_webhook_events_key_unique unique (provider_event_key)
);

comment on table public.whatsapp_webhook_events is
  'Dedupe e auditoria mínima do webhook da Meta. Sem payload bruto, sem conteúdo de mensagem, sem token.';

-- ---------------------------------------------------------------------------
-- 2) Append-only (UPDATE nunca; DELETE só como cascata da exclusão da empresa)
-- ---------------------------------------------------------------------------
create function public.whatsapp_guard_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'Eventos do WhatsApp são imutáveis.' using errcode = 'PT409';
end;
$$;

revoke execute on function public.whatsapp_guard_append_only() from public, anon, authenticated;

create trigger whatsapp_message_events_immutable
  before update or delete on public.whatsapp_message_events
  for each row execute function public.whatsapp_guard_append_only();
create trigger whatsapp_conversation_events_immutable
  before update or delete on public.whatsapp_conversation_events
  for each row execute function public.whatsapp_guard_append_only();

-- ---------------------------------------------------------------------------
-- 3) RLS e GRANTs (cliente só LÊ; connections e webhook_events sem acesso direto)
-- ---------------------------------------------------------------------------
alter table public.company_whatsapp_connections enable row level security;
alter table public.company_whatsapp_settings enable row level security;
alter table public.whatsapp_test_recipients enable row level security;
alter table public.whatsapp_conversations enable row level security;
alter table public.whatsapp_messages enable row level security;
alter table public.whatsapp_message_events enable row level security;
alter table public.whatsapp_conversation_events enable row level security;
alter table public.whatsapp_webhook_events enable row level security;

create policy whatsapp_conversations_select on public.whatsapp_conversations
  for select to authenticated
  using (
    public.company_has_module_rls(company_id, 'whatsapp')
    and public.user_role_in_company(company_id) in ('owner', 'admin', 'attendant', 'cashier')
  );
create policy whatsapp_messages_select on public.whatsapp_messages
  for select to authenticated
  using (
    public.company_has_module_rls(company_id, 'whatsapp')
    and public.user_role_in_company(company_id) in ('owner', 'admin', 'attendant', 'cashier')
  );
create policy whatsapp_message_events_select on public.whatsapp_message_events
  for select to authenticated
  using (
    public.company_has_module_rls(company_id, 'whatsapp')
    and public.user_role_in_company(company_id) in ('owner', 'admin', 'attendant', 'cashier')
  );
create policy whatsapp_conversation_events_select on public.whatsapp_conversation_events
  for select to authenticated
  using (
    public.company_has_module_rls(company_id, 'whatsapp')
    and public.user_role_in_company(company_id) in ('owner', 'admin', 'attendant', 'cashier')
  );
create policy company_whatsapp_settings_select on public.company_whatsapp_settings
  for select to authenticated
  using (
    public.company_has_module_rls(company_id, 'whatsapp')
    and public.user_role_in_company(company_id) in ('owner', 'admin')
  );
create policy whatsapp_test_recipients_select on public.whatsapp_test_recipients
  for select to authenticated
  using (
    public.company_has_module_rls(company_id, 'whatsapp')
    and public.user_role_in_company(company_id) in ('owner', 'admin')
  );

revoke all on public.company_whatsapp_connections from public, anon, authenticated;
revoke all on public.company_whatsapp_settings from public, anon, authenticated;
revoke all on public.whatsapp_test_recipients from public, anon, authenticated;
revoke all on public.whatsapp_conversations from public, anon, authenticated;
revoke all on public.whatsapp_messages from public, anon, authenticated;
revoke all on public.whatsapp_message_events from public, anon, authenticated;
revoke all on public.whatsapp_conversation_events from public, anon, authenticated;
revoke all on public.whatsapp_webhook_events from public, anon, authenticated;

grant select on public.company_whatsapp_settings to authenticated;
grant select on public.whatsapp_test_recipients to authenticated;
grant select on public.whatsapp_conversations to authenticated;
grant select on public.whatsapp_messages to authenticated;
grant select on public.whatsapp_message_events to authenticated;
grant select on public.whatsapp_conversation_events to authenticated;

grant all on public.company_whatsapp_connections to service_role;
grant all on public.company_whatsapp_settings to service_role;
grant all on public.whatsapp_test_recipients to service_role;
grant all on public.whatsapp_conversations to service_role;
grant all on public.whatsapp_messages to service_role;
grant select, insert on public.whatsapp_message_events to service_role;
grant select, insert on public.whatsapp_conversation_events to service_role;
grant all on public.whatsapp_webhook_events to service_role;

-- ---------------------------------------------------------------------------
-- 4) Realtime (a RLS vale no Realtime)
-- ---------------------------------------------------------------------------
do $$
declare
  v_table text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach v_table in array array['whatsapp_conversations', 'whatsapp_messages'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = v_table
      ) then
        execute format('alter publication supabase_realtime add table public.%I', v_table);
      end if;
    end loop;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5) Helpers internos
-- ---------------------------------------------------------------------------
-- Telefone E.164 só com dígitos (10 a 15). NULL quando não for utilizável.
create function public.whatsapp_normalize_phone(p_text text)
returns text
language sql
immutable
set search_path = public
as $$
  select case when char_length(d) between 10 and 15 then d else null end
  from (select regexp_replace(coalesce(p_text, ''), '\D', '', 'g') as d) s
$$;

-- "Núcleo" do telefone para comparar o do WhatsApp (com DDI 55) com o do cadastro (geralmente sem DDI e, às vezes, sem o
-- nono dígito): tira o 55 e, em celular com 11 dígitos (DDD + 9 + 8), remove o nono dígito.
create function public.whatsapp_phone_core(p_text text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when char_length(d) = 11 and substr(d, 3, 1) = '9' then substr(d, 1, 2) || substr(d, 4)
    else d
  end
  from (
    select case
      when char_length(r) in (12, 13) and left(r, 2) = '55' then substr(r, 3)
      else r
    end as d
    from (select regexp_replace(coalesce(p_text, ''), '\D', '', 'g') as r) a
  ) b
$$;

-- Barreira do leitor: sessão, papel (owner/admin/attendant/cashier) e módulo contratado.
create function public.whatsapp_assert_reader(p_company_id uuid)
returns public.company_role
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
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
  perform public.assert_company_module(p_company_id, 'whatsapp');
  return v_role;
end;
$$;

revoke execute on function public.whatsapp_normalize_phone(text) from public, anon, authenticated;
revoke execute on function public.whatsapp_phone_core(text) from public, anon, authenticated;
revoke execute on function public.whatsapp_assert_reader(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6) Ingestão (chamada SÓ pelo webhook, com service_role). Idempotente e transacional.
-- ---------------------------------------------------------------------------
create function public.whatsapp_ingest_message(
  p_phone_number_id text,
  p_provider_message_id text,
  p_from text,
  p_contact_name text,
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
  v_name text;
  v_event_id uuid;
  v_conv_id uuid;
  v_conv_new boolean;
  v_msg_id uuid;
  v_ts timestamptz;
  v_preview text;
  v_was_closed boolean;
begin
  select * into v_conn from public.company_whatsapp_connections where phone_number_id = p_phone_number_id;
  if not found then
    return jsonb_build_object('result', 'unknown_connection');
  end if;
  if v_conn.status <> 'active' then
    return jsonb_build_object('result', 'inactive_connection');
  end if;

  v_phone := public.whatsapp_normalize_phone(p_from);
  if v_phone is null
     or nullif(btrim(coalesce(p_provider_message_id, '')), '') is null
     or nullif(btrim(coalesce(p_event_key, '')), '') is null then
    return jsonb_build_object('result', 'invalid');
  end if;

  v_type := case when p_type in ('text', 'image', 'audio', 'document', 'location', 'interactive') then p_type else 'unknown' end;
  v_body := left(nullif(btrim(coalesce(p_body, '')), ''), 4096);
  v_name := left(nullif(btrim(coalesce(p_contact_name, '')), ''), 80);
  v_ts := coalesce(p_provider_timestamp, now());

  insert into public.whatsapp_webhook_events (connection_id, company_id, provider_event_key, event_type, provider_timestamp)
  values (v_conn.id, v_conn.company_id, left(p_event_key, 300), 'message', p_provider_timestamp)
  on conflict (provider_event_key) do nothing
  returning id into v_event_id;
  if v_event_id is null then
    return jsonb_build_object('result', 'duplicate');
  end if;

  insert into public.whatsapp_conversations (company_id, connection_id, contact_phone, contact_display_name, status)
  values (v_conn.company_id, v_conn.id, v_phone, v_name, 'open')
  on conflict (connection_id, contact_phone) do update
    set contact_display_name = coalesce(excluded.contact_display_name, public.whatsapp_conversations.contact_display_name)
  returning id, (xmax = 0) into v_conv_id, v_conv_new;

  insert into public.whatsapp_messages (company_id, connection_id, conversation_id, provider_message_id, direction, type, body, status, provider_timestamp)
  values (v_conn.company_id, v_conn.id, v_conv_id, left(p_provider_message_id, 200), 'inbound', v_type, v_body, 'received', p_provider_timestamp)
  on conflict (connection_id, provider_message_id) do nothing
  returning id into v_msg_id;

  if v_msg_id is null then
    update public.whatsapp_webhook_events set processed = true, processing_error = 'duplicate_message' where id = v_event_id;
    return jsonb_build_object('result', 'duplicate');
  end if;

  v_preview := left(case v_type
    when 'text' then coalesce(v_body, 'Mensagem recebida')
    when 'image' then 'Imagem recebida'
    when 'audio' then 'Áudio recebido'
    when 'document' then 'Documento recebido'
    when 'location' then 'Localização recebida'
    when 'interactive' then coalesce(v_body, 'Resposta recebida')
    else 'Mensagem recebida'
  end, 120);

  select (status = 'closed') into v_was_closed from public.whatsapp_conversations where id = v_conv_id;

  update public.whatsapp_conversations c
     set unread_count = c.unread_count + 1,
         last_inbound_at = greatest(coalesce(c.last_inbound_at, '-infinity'::timestamptz), v_ts),
         last_message_preview = case when c.last_message_at is null or v_ts >= c.last_message_at then v_preview else c.last_message_preview end,
         last_message_at = greatest(coalesce(c.last_message_at, '-infinity'::timestamptz), v_ts),
         status = case when c.status = 'closed' then 'open' else c.status end
   where c.id = v_conv_id;

  insert into public.whatsapp_message_events (company_id, message_id, status, provider_timestamp)
  values (v_conn.company_id, v_msg_id, 'received', p_provider_timestamp);

  if v_conv_new then
    insert into public.whatsapp_conversation_events (company_id, conversation_id, event_type)
    values (v_conn.company_id, v_conv_id, 'created');
  elsif v_was_closed then
    insert into public.whatsapp_conversation_events (company_id, conversation_id, event_type, old_value, new_value)
    values (v_conn.company_id, v_conv_id, 'reopened', jsonb_build_object('status', 'closed'), jsonb_build_object('status', 'open'));
  end if;

  update public.whatsapp_webhook_events set processed = true where id = v_event_id;

  return jsonb_build_object('result', 'stored', 'conversation_id', v_conv_id, 'message_id', v_msg_id, 'new_conversation', v_conv_new);
end;
$$;

-- Status de mensagem (sent/delivered/read/failed). A coluna status é MONOTÔNICA: nunca regride; failed vale só sobre
-- queued/sent e depois dele nenhum status de progresso reabre a mensagem. Cada status chega ao histórico uma vez.
create function public.whatsapp_ingest_status(
  p_phone_number_id text,
  p_provider_message_id text,
  p_status text,
  p_provider_timestamp timestamptz,
  p_error_code text,
  p_event_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conn public.company_whatsapp_connections;
  v_event_id uuid;
  v_msg public.whatsapp_messages;
  v_err text;
  v_cur integer;
  v_new integer;
  v_inserted uuid;
  v_applied boolean := false;
begin
  select * into v_conn from public.company_whatsapp_connections where phone_number_id = p_phone_number_id;
  if not found then
    return jsonb_build_object('result', 'unknown_connection');
  end if;
  if v_conn.status <> 'active' then
    return jsonb_build_object('result', 'inactive_connection');
  end if;
  if p_status not in ('sent', 'delivered', 'read', 'failed')
     or nullif(btrim(coalesce(p_provider_message_id, '')), '') is null
     or nullif(btrim(coalesce(p_event_key, '')), '') is null then
    return jsonb_build_object('result', 'invalid');
  end if;

  insert into public.whatsapp_webhook_events (connection_id, company_id, provider_event_key, event_type, provider_timestamp)
  values (v_conn.id, v_conn.company_id, left(p_event_key, 300), 'status', p_provider_timestamp)
  on conflict (provider_event_key) do nothing
  returning id into v_event_id;
  if v_event_id is null then
    return jsonb_build_object('result', 'duplicate');
  end if;

  select * into v_msg from public.whatsapp_messages
   where connection_id = v_conn.id and provider_message_id = p_provider_message_id
   for update;
  if not found then
    update public.whatsapp_webhook_events set processed = true, processing_error = 'message_not_found' where id = v_event_id;
    return jsonb_build_object('result', 'message_not_found');
  end if;
  if v_msg.direction <> 'outbound' then
    update public.whatsapp_webhook_events set processed = true, processing_error = 'not_outbound' where id = v_event_id;
    return jsonb_build_object('result', 'ignored');
  end if;

  v_err := left(nullif(regexp_replace(coalesce(p_error_code, ''), '[^A-Za-z0-9_.:-]', '', 'g'), ''), 64);

  insert into public.whatsapp_message_events (company_id, message_id, status, provider_timestamp, error_code)
  values (v_conn.company_id, v_msg.id, p_status, p_provider_timestamp, case when p_status = 'failed' then v_err end)
  on conflict do nothing
  returning id into v_inserted;

  v_cur := case v_msg.status when 'received' then 0 when 'queued' then 1 when 'sent' then 2 when 'delivered' then 3 when 'read' then 4 else null end;
  v_new := case p_status when 'sent' then 2 when 'delivered' then 3 when 'read' then 4 else null end;

  if v_msg.status <> 'failed' then
    if p_status = 'failed' then
      if v_cur in (1, 2) then
        update public.whatsapp_messages set status = 'failed', error_code = v_err where id = v_msg.id;
        v_applied := true;
      end if;
    elsif v_new > v_cur then
      update public.whatsapp_messages set status = p_status where id = v_msg.id;
      v_applied := true;
    end if;
  end if;

  update public.whatsapp_webhook_events set processed = true where id = v_event_id;
  return jsonb_build_object('result', 'stored', 'applied', v_applied, 'message_id', v_msg.id);
end;
$$;

revoke execute on function public.whatsapp_ingest_message(text, text, text, text, text, text, timestamptz, text) from public, anon, authenticated;
revoke execute on function public.whatsapp_ingest_status(text, text, text, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.whatsapp_ingest_message(text, text, text, text, text, text, timestamptz, text) to service_role;
grant execute on function public.whatsapp_ingest_status(text, text, text, timestamptz, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 7) Leitura para o app (RPCs; sem token, sem referência ao Vault)
-- ---------------------------------------------------------------------------
create function public.whatsapp_get_connection_summary(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_c public.company_whatsapp_connections;
begin
  perform public.whatsapp_assert_reader(p_company_id);
  select * into v_c from public.company_whatsapp_connections
   where company_id = p_company_id
   order by (status = 'active') desc, created_at desc
   limit 1;
  if not found then
    return jsonb_build_object('configured', false);
  end if;
  return jsonb_build_object(
    'configured', true,
    'status', v_c.status,
    'mode', v_c.mode,
    'display_phone_number', v_c.display_phone_number,
    'business_name', v_c.business_name
  );
end;
$$;

-- Cliente já vinculado + sugestões pelo telefone da conversa. NUNCA vincula sozinho; devolve o mínimo (id, nome e os
-- 4 últimos dígitos). Compara o "núcleo" do telefone (ver whatsapp_phone_core).
create function public.whatsapp_suggest_customers(p_conversation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_conv public.whatsapp_conversations;
  v_core text;
  v_linked jsonb := null;
  v_sugg jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_conv from public.whatsapp_conversations where id = p_conversation_id;
  if not found or public.user_role_in_company(v_conv.company_id) is null then
    raise exception 'Conversa não encontrada.' using errcode = 'PT404';
  end if;
  perform public.whatsapp_assert_reader(v_conv.company_id);

  if v_conv.customer_id is not null then
    select jsonb_build_object('id', c.id, 'name', c.name, 'phone_last4', right(coalesce(c.whatsapp, c.phone, ''), 4))
      into v_linked
      from public.customers c
     where c.company_id = v_conv.company_id and c.id = v_conv.customer_id;
  end if;

  v_core := public.whatsapp_phone_core(v_conv.contact_phone);
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'phone_last4', right(coalesce(t.whatsapp, t.phone, ''), 4)) order by t.lname, t.id), '[]'::jsonb)
    into v_sugg
    from (
      select c.id, c.name, c.phone, c.whatsapp, lower(c.name) as lname
        from public.customers c
       where c.company_id = v_conv.company_id
         and c.is_active
         and (v_conv.customer_id is null or c.id <> v_conv.customer_id)
         and v_core is not null
         and (public.whatsapp_phone_core(c.whatsapp) = v_core or public.whatsapp_phone_core(c.phone) = v_core)
       order by lower(c.name), c.id
       limit 5
    ) t;

  return jsonb_build_object('linked', v_linked, 'suggestions', v_sugg);
end;
$$;

-- Zera as não lidas ao abrir a conversa (única escrita do cliente nesta fase).
create function public.mark_whatsapp_conversation_read(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select company_id into v_company from public.whatsapp_conversations where id = p_conversation_id;
  if v_company is null or public.user_role_in_company(v_company) is null then
    raise exception 'Conversa não encontrada.' using errcode = 'PT404';
  end if;
  perform public.whatsapp_assert_reader(v_company);
  update public.whatsapp_conversations set unread_count = 0 where id = p_conversation_id and unread_count <> 0;
end;
$$;

revoke execute on function public.whatsapp_get_connection_summary(uuid) from public, anon, service_role;
revoke execute on function public.whatsapp_suggest_customers(uuid) from public, anon, service_role;
revoke execute on function public.mark_whatsapp_conversation_read(uuid) from public, anon, service_role;
grant execute on function public.whatsapp_get_connection_summary(uuid) to authenticated;
grant execute on function public.whatsapp_suggest_customers(uuid) to authenticated;
grant execute on function public.mark_whatsapp_conversation_read(uuid) to authenticated;

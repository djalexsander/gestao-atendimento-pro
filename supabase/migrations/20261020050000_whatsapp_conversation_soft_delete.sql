-- EXCLUIR CONVERSA (soft delete) do módulo WhatsApp.
--
-- POR QUE SOFT DELETE e não DELETE físico: todas as FKs a partir de whatsapp_conversations são ON DELETE CASCADE (mensagens, eventos,
-- jobs da IA, uso da IA, falhas de enfileiramento). Um DELETE físico apagaria em cascata TODO o histórico técnico: os eventos da Meta e
-- os eventos da conversa (append-only por desenho), o ledger de uso da IA (base das cotas, custos e métricas) e o rastreio de
-- conhecimento. Soft delete mantém integridade referencial, auditoria e métricas; a conversa só deixa de existir para a operação.
--
--  * whatsapp_conversations.deleted_at / deleted_by. Conversa excluída SOME de tudo que o cliente enxerga (RLS de conversas, mensagens e
--    eventos) e de todas as RPCs que carregam a conversa (whatsapp_load_conversation: assumir/devolver, fechar, enviar, sugerir,
--    conhecimento, IA...). Nada "ressuscita" a conversa: status/eventos antigos da Meta só atualizam a mensagem.
--  * unicidade do contato passa a valer só entre conversas NÃO excluídas (índice parcial): a PRÓXIMA mensagem do mesmo cliente cria uma
--    conversa NOVA e limpa (aberta, sem atribuição, IA no estado inicial). O histórico antigo fica separado, só como auditoria.
--  * whatsapp_delete_conversation(conversation_id): só owner/admin da empresa da conversa; FALHA FECHADA se há envio em andamento
--    (mensagem 'queued') ou job da IA em processamento; cancela jobs pendentes e deixa a IA pausada (ai_control='human'), o que
--    também derruba qualquer commit de resposta automática (revalidação final já existente).
-- Aditiva. Não altera cotas, prepare_auto/commit/claim do auto, nem a Meta.

alter table public.whatsapp_conversations
  add column deleted_at timestamptz,
  add column deleted_by uuid references auth.users (id) on delete set null;
comment on column public.whatsapp_conversations.deleted_at is 'Soft delete: conversa excluída pelo owner/admin. Some da operação; o histórico técnico permanece.';

-- unicidade do contato só entre conversas ativas (nova mensagem depois da exclusão cria conversa nova)
alter table public.whatsapp_conversations drop constraint whatsapp_conversations_phone_unique;
create unique index whatsapp_conversations_phone_active_uniq
  on public.whatsapp_conversations (connection_id, contact_phone) where deleted_at is null;
create index whatsapp_conversations_deleted_idx on public.whatsapp_conversations (company_id, deleted_at) where deleted_at is not null;

-- evento de auditoria
alter table public.whatsapp_conversation_events drop constraint whatsapp_conversation_events_type_check;
alter table public.whatsapp_conversation_events add constraint whatsapp_conversation_events_type_check check (event_type in (
  'created', 'assigned', 'unassigned', 'status_changed', 'customer_linked', 'customer_unlinked', 'closed', 'reopened', 'order_linked',
  'ai_paused', 'ai_resumed', 'ai_handoff', 'deleted'));

-- o que o cliente enxerga: conversa excluída (e suas mensagens/eventos) some
drop policy whatsapp_conversations_select on public.whatsapp_conversations;
create policy whatsapp_conversations_select on public.whatsapp_conversations
  for select to authenticated
  using (
    deleted_at is null
    and public.company_has_module_rls(company_id, 'whatsapp')
    and public.user_role_in_company(company_id) in ('owner', 'admin', 'attendant', 'cashier')
  );
drop policy whatsapp_messages_select on public.whatsapp_messages;
create policy whatsapp_messages_select on public.whatsapp_messages
  for select to authenticated
  using (
    public.company_has_module_rls(company_id, 'whatsapp')
    and public.user_role_in_company(company_id) in ('owner', 'admin', 'attendant', 'cashier')
    and exists (select 1 from public.whatsapp_conversations c where c.id = conversation_id and c.deleted_at is null)
  );
drop policy whatsapp_conversation_events_select on public.whatsapp_conversation_events;
create policy whatsapp_conversation_events_select on public.whatsapp_conversation_events
  for select to authenticated
  using (
    public.company_has_module_rls(company_id, 'whatsapp')
    and public.user_role_in_company(company_id) in ('owner', 'admin', 'attendant', 'cashier')
    and exists (select 1 from public.whatsapp_conversations c where c.id = conversation_id and c.deleted_at is null)
  );

-- ---------------------------------------------------------------------------
-- Funções que carregam/encontram a conversa passam a ignorar as excluídas
-- ---------------------------------------------------------------------------
-- (create or replace preserva os grants existentes)
create or replace function public.whatsapp_load_conversation(p_conversation_id uuid)
returns public.whatsapp_conversations
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_conv public.whatsapp_conversations;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_conv from public.whatsapp_conversations where id = p_conversation_id and deleted_at is null;
  if not found or public.user_role_in_company(v_conv.company_id) is null then
    raise exception 'Conversa não encontrada.' using errcode = 'PT404';
  end if;
  perform public.whatsapp_assert_reader(v_conv.company_id);
  return v_conv;
end;
$$;

create or replace function public.whatsapp_suggest_customers(p_conversation_id uuid)
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
  select * into v_conv from public.whatsapp_conversations where id = p_conversation_id and deleted_at is null;
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

create or replace function public.mark_whatsapp_conversation_read(p_conversation_id uuid)
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
  select company_id into v_company from public.whatsapp_conversations where id = p_conversation_id and deleted_at is null;
  if v_company is null or public.user_role_in_company(v_company) is null then
    raise exception 'Conversa não encontrada.' using errcode = 'PT404';
  end if;
  perform public.whatsapp_assert_reader(v_company);
  update public.whatsapp_conversations set unread_count = 0 where id = p_conversation_id and unread_count <> 0;
end;
$$;


-- webhook: a conversa do contato é a ATIVA (índice parcial); depois de uma exclusão a próxima mensagem cria uma conversa nova
create or replace function public.whatsapp_ingest_message(
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
  on conflict (connection_id, contact_phone) where deleted_at is null do update
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


-- ---------------------------------------------------------------------------
-- Excluir conversa
-- ---------------------------------------------------------------------------
create function public.whatsapp_delete_conversation(p_conversation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conv public.whatsapp_conversations;
  v_role public.company_role;
  v_cancelled integer := 0;
begin
  v_conv := public.whatsapp_load_conversation(p_conversation_id); -- sessão, empresa da conversa (nunca do cliente), módulo e conversa não excluída
  v_role := public.user_role_in_company(v_conv.company_id);
  if v_role is null or v_role not in ('owner', 'admin') then
    raise exception 'Somente donos(as) e administradores(as) podem excluir conversas.' using errcode = 'PT403';
  end if;

  select * into v_conv from public.whatsapp_conversations where id = v_conv.id and deleted_at is null for update;
  if not found then
    raise exception 'Conversa não encontrada.' using errcode = 'PT404';
  end if;

  -- falha fechada: envio em andamento ou IA gerando resposta
  if exists (select 1 from public.whatsapp_messages m where m.conversation_id = v_conv.id and m.direction = 'outbound' and m.status = 'queued') then
    raise exception 'Há uma mensagem sendo enviada nesta conversa. Aguarde um instante e tente novamente.' using errcode = 'PT409';
  end if;
  if exists (select 1 from public.whatsapp_ai_jobs j where j.conversation_id = v_conv.id and j.status = 'processing') then
    raise exception 'A IA está processando esta conversa. Tente novamente em instantes.' using errcode = 'PT409';
  end if;

  -- jobs pendentes da IA deixam de existir para esta conversa
  update public.whatsapp_ai_jobs
     set status = 'cancelled', outcome = 'aborted_human', reason_code = 'conversation_deleted', locked_until = null
   where conversation_id = v_conv.id and status = 'pending';
  get diagnostics v_cancelled = row_count;

  -- IA pausada (derruba qualquer commit automático pela revalidação final) e conversa marcada como excluída
  update public.whatsapp_conversations
     set deleted_at = now(), deleted_by = auth.uid(),
         ai_control = 'human', ai_control_changed_at = now(), ai_control_changed_by = auth.uid()
   where id = v_conv.id;

  insert into public.whatsapp_conversation_events (company_id, conversation_id, event_type, actor_user_id, old_value, new_value)
  values (v_conv.company_id, v_conv.id, 'deleted', auth.uid(), jsonb_build_object('status', v_conv.status), jsonb_build_object('deleted', true));

  return jsonb_build_object('deleted', true, 'conversation_id', v_conv.id, 'cancelled_jobs', v_cancelled);
end;
$$;
revoke execute on function public.whatsapp_delete_conversation(uuid) from public, anon, service_role;
grant execute on function public.whatsapp_delete_conversation(uuid) to authenticated;

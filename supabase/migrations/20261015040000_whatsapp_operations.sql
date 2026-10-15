-- WhatsApp, FASE 2A-2: operação de conversas e ENVIO manual (texto). Ainda sem templates, automações, Delivery ou IA.
--
-- 1) Operação da conversa (RPCs do cliente, owner/admin/attendant/cashier com o módulo):
--      assign_whatsapp_conversation        atribui/desatribui (só quem pode atender: owner/admin/attendant/cashier ATIVOS)
--      set_whatsapp_conversation_status    open<->waiting, open|waiting->closed, closed->open
--      link_whatsapp_conversation_customer vincula/desvincula cliente ATIVO da mesma empresa (nunca cria cliente)
--      whatsapp_list_agents                quem pode ser atribuído (id, nome, papel)
--    Cada mudança grava um evento append-only; repetir o mesmo valor é no-op (sem evento).
--
-- 2) Envio em DUAS etapas, para a mensagem existir ANTES da chamada externa:
--      A) whatsapp_prepare_outbound_message   (JWT do USUÁRIO) valida papel, módulo, conexão ativa, janela de 24 h e, no
--         modo 'test', a lista de destinatários; grava a mensagem outbound com status 'queued' (idempotente por
--         client_request_id). NUNCA devolve token nem referência de segredo.
--      B) a Edge (service_role) chama whatsapp_get_send_context(message_id) — única função que lê o token do Vault —,
--         fala com a Graph API e finaliza com whatsapp_mark_message_sent / whatsapp_mark_message_failed.
--    Escolha de segurança: a referência do segredo e o token só existem em funções com EXECUTE exclusivo do service_role.
--    O cliente autenticado não alcança nenhuma delas, e o corpo da resposta de A não contém dado de conexão.
--
-- 3) Janela de atendimento: texto livre só até 24 h depois da última mensagem RECEBIDA (whatsapp_can_send_freeform).
--    Fora dela: bloqueado no servidor (template é fase posterior).
--
-- Para o webhook: a mensagem outbound agora existe antes do envio, mas só ganha provider_message_id quando a Graph API
-- responde; um status que chegasse antes disso não acharia a linha (janela mínima, tratada como message_not_found).

-- ---------------------------------------------------------------------------
-- 1) Ajustes estruturais
-- ---------------------------------------------------------------------------
-- A mensagem outbound nasce 'queued' sem id da Meta (o id vem na resposta do envio).
alter table public.whatsapp_messages alter column provider_message_id drop not null;
alter table public.whatsapp_messages
  add constraint whatsapp_messages_inbound_provider_id_check check (direction = 'outbound' or provider_message_id is not null);
alter table public.whatsapp_messages add column client_request_id uuid;
create unique index whatsapp_messages_client_request_uniq
  on public.whatsapp_messages (company_id, conversation_id, client_request_id) where client_request_id is not null;

alter table public.whatsapp_conversation_events drop constraint whatsapp_conversation_events_type_check;
alter table public.whatsapp_conversation_events add constraint whatsapp_conversation_events_type_check check (event_type in (
  'created', 'assigned', 'unassigned', 'status_changed', 'customer_linked', 'customer_unlinked', 'closed', 'reopened', 'order_linked'));

-- ---------------------------------------------------------------------------
-- 2) Janela de 24 h (regra única, no servidor)
-- ---------------------------------------------------------------------------
create function public.whatsapp_can_send_freeform(p_last_inbound_at timestamptz, p_now timestamptz default now())
returns jsonb
language sql
stable
set search_path = public
as $$
  select case
    when p_last_inbound_at is null then
      jsonb_build_object('can_send', false, 'window_expires_at', null, 'reason', 'no_inbound')
    when p_now <= p_last_inbound_at + interval '24 hours' then
      jsonb_build_object('can_send', true, 'window_expires_at', p_last_inbound_at + interval '24 hours', 'reason', null)
    else
      jsonb_build_object('can_send', false, 'window_expires_at', p_last_inbound_at + interval '24 hours', 'reason', 'window_closed')
  end
$$;

revoke execute on function public.whatsapp_can_send_freeform(timestamptz, timestamptz) from public, anon, authenticated;

-- Conversa + barreira do leitor numa chamada (PT404 sem revelar existência em outra empresa).
create function public.whatsapp_load_conversation(p_conversation_id uuid)
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
  select * into v_conv from public.whatsapp_conversations where id = p_conversation_id;
  if not found or public.user_role_in_company(v_conv.company_id) is null then
    raise exception 'Conversa não encontrada.' using errcode = 'PT404';
  end if;
  perform public.whatsapp_assert_reader(v_conv.company_id);
  return v_conv;
end;
$$;

revoke execute on function public.whatsapp_load_conversation(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) Operação da conversa
-- ---------------------------------------------------------------------------
create function public.assign_whatsapp_conversation(p_conversation_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conv public.whatsapp_conversations;
  v_role public.company_role;
begin
  v_conv := public.whatsapp_load_conversation(p_conversation_id);

  if p_user_id is not null then
    select cu.role into v_role
      from public.company_users cu
     where cu.company_id = v_conv.company_id and cu.user_id = p_user_id and cu.status = 'active';
    if v_role is null or v_role not in ('owner', 'admin', 'attendant', 'cashier') then
      raise exception 'Este usuário não pode receber conversas do WhatsApp.' using errcode = 'PT400';
    end if;
  end if;

  if v_conv.assigned_user_id is not distinct from p_user_id then
    return jsonb_build_object('assigned_user_id', v_conv.assigned_user_id, 'changed', false);
  end if;

  update public.whatsapp_conversations set assigned_user_id = p_user_id where id = v_conv.id;
  insert into public.whatsapp_conversation_events (company_id, conversation_id, event_type, actor_user_id, old_value, new_value)
  values (v_conv.company_id, v_conv.id, case when p_user_id is null then 'unassigned' else 'assigned' end, auth.uid(),
          jsonb_build_object('assigned_user_id', v_conv.assigned_user_id), jsonb_build_object('assigned_user_id', p_user_id));

  return jsonb_build_object('assigned_user_id', p_user_id, 'changed', true);
end;
$$;

create function public.set_whatsapp_conversation_status(p_conversation_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conv public.whatsapp_conversations;
  v_event text;
begin
  v_conv := public.whatsapp_load_conversation(p_conversation_id);
  if p_status is null or p_status not in ('open', 'waiting', 'closed') then
    raise exception 'Situação inválida.' using errcode = 'PT400';
  end if;
  if v_conv.status = p_status then
    return jsonb_build_object('status', v_conv.status, 'changed', false);
  end if;
  if not (
    (v_conv.status = 'open' and p_status in ('waiting', 'closed'))
    or (v_conv.status = 'waiting' and p_status in ('open', 'closed'))
    or (v_conv.status = 'closed' and p_status = 'open')
  ) then
    raise exception 'Não é possível mudar a conversa de % para %.', v_conv.status, p_status using errcode = 'PT409';
  end if;

  v_event := case when p_status = 'closed' then 'closed' when v_conv.status = 'closed' then 'reopened' else 'status_changed' end;
  update public.whatsapp_conversations set status = p_status where id = v_conv.id;
  insert into public.whatsapp_conversation_events (company_id, conversation_id, event_type, actor_user_id, old_value, new_value)
  values (v_conv.company_id, v_conv.id, v_event, auth.uid(), jsonb_build_object('status', v_conv.status), jsonb_build_object('status', p_status));

  return jsonb_build_object('status', p_status, 'changed', true);
end;
$$;

create function public.link_whatsapp_conversation_customer(p_conversation_id uuid, p_customer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conv public.whatsapp_conversations;
  v_cust public.customers;
begin
  v_conv := public.whatsapp_load_conversation(p_conversation_id);

  if p_customer_id is not null then
    select * into v_cust from public.customers where company_id = v_conv.company_id and id = p_customer_id;
    if not found then
      raise exception 'Cliente não encontrado.' using errcode = 'PT404';
    end if;
    if not v_cust.is_active then
      raise exception 'Este cliente está inativo.' using errcode = 'PT409';
    end if;
  end if;

  if v_conv.customer_id is not distinct from p_customer_id then
    return jsonb_build_object('customer_id', v_conv.customer_id, 'changed', false);
  end if;

  update public.whatsapp_conversations set customer_id = p_customer_id where id = v_conv.id;
  insert into public.whatsapp_conversation_events (company_id, conversation_id, event_type, actor_user_id, old_value, new_value)
  values (v_conv.company_id, v_conv.id, case when p_customer_id is null then 'customer_unlinked' else 'customer_linked' end, auth.uid(),
          jsonb_build_object('customer_id', v_conv.customer_id), jsonb_build_object('customer_id', p_customer_id));

  return jsonb_build_object('customer_id', p_customer_id, 'changed', true);
end;
$$;

create function public.whatsapp_list_agents(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.whatsapp_assert_reader(p_company_id);
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', cu.user_id, 'name', coalesce(nullif(btrim(p.full_name), ''), 'Usuário'), 'role', cu.role)
                     order by lower(coalesce(nullif(btrim(p.full_name), ''), 'Usuário')), cu.user_id)
      from public.company_users cu
      left join public.profiles p on p.user_id = cu.user_id
     where cu.company_id = p_company_id and cu.status = 'active' and cu.role in ('owner', 'admin', 'attendant', 'cashier')
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Envio: etapa A (JWT do usuário) — valida e grava 'queued'
-- ---------------------------------------------------------------------------
create function public.whatsapp_prepare_outbound_message(p_conversation_id uuid, p_client_request_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conv public.whatsapp_conversations;
  v_conn public.company_whatsapp_connections;
  v_msg public.whatsapp_messages;
  v_body text;
  v_win jsonb;
begin
  v_conv := public.whatsapp_load_conversation(p_conversation_id);
  if p_client_request_id is null then
    raise exception 'Pedido de envio inválido.' using errcode = 'PT400';
  end if;

  -- reenvio do MESMO pedido (duplo clique/retry): devolve a mesma mensagem, sem criar outra nem revalidar a janela
  select * into v_msg from public.whatsapp_messages
   where company_id = v_conv.company_id and conversation_id = v_conv.id and client_request_id = p_client_request_id;
  if found then
    return jsonb_build_object(
      'message_id', v_msg.id, 'status', v_msg.status, 'idempotent', true,
      'queued_age_seconds', floor(extract(epoch from (now() - v_msg.created_at)))::integer);
  end if;

  v_body := btrim(coalesce(p_body, ''));
  if char_length(v_body) = 0 then
    raise exception 'Digite uma mensagem.' using errcode = 'PT400';
  end if;
  if char_length(v_body) > 4096 then
    raise exception 'A mensagem pode ter no máximo 4096 caracteres.' using errcode = 'PT400';
  end if;

  select * into v_conn from public.company_whatsapp_connections where id = v_conv.connection_id;
  if not found or v_conn.status <> 'active' then
    raise exception 'O WhatsApp desta empresa não está conectado.' using errcode = 'PT409';
  end if;
  if v_conv.status = 'closed' then
    raise exception 'Reabra a conversa para responder.' using errcode = 'PT409';
  end if;

  v_win := public.whatsapp_can_send_freeform(v_conv.last_inbound_at);
  if not (v_win ->> 'can_send')::boolean then
    raise exception 'Fora da janela de atendimento de 24 horas. Será necessário usar um template aprovado.' using errcode = 'PT409';
  end if;

  -- modo de TESTE: falha fechada, antes de qualquer chamada externa
  if v_conn.mode = 'test' and not exists (
    select 1 from public.whatsapp_test_recipients r
     where r.connection_id = v_conn.id and r.phone_e164 = v_conv.contact_phone and r.is_active
  ) then
    raise exception 'Destinatário não autorizado no modo de teste.' using errcode = 'PT403';
  end if;

  insert into public.whatsapp_messages (company_id, connection_id, conversation_id, provider_message_id, direction, type, body,
                                        status, sent_by_user_id, client_request_id)
  values (v_conv.company_id, v_conv.connection_id, v_conv.id, null, 'outbound', 'text', v_body, 'queued', auth.uid(), p_client_request_id)
  returning * into v_msg;

  insert into public.whatsapp_message_events (company_id, message_id, status) values (v_conv.company_id, v_msg.id, 'queued');

  update public.whatsapp_conversations
     set last_outbound_at = now(),
         last_message_at = greatest(coalesce(last_message_at, '-infinity'::timestamptz), now()),
         last_message_preview = left(v_body, 120)
   where id = v_conv.id;

  return jsonb_build_object(
    'message_id', v_msg.id, 'status', 'queued', 'idempotent', false, 'queued_age_seconds', 0,
    'window_expires_at', v_win -> 'window_expires_at');
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Envio: etapa B (SÓ service_role / Edge)
-- ---------------------------------------------------------------------------
-- Contexto do envio, incluindo o TOKEN lido do Vault. Revalida conexão e destinatário (defesa em profundidade).
create function public.whatsapp_get_send_context(p_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_msg public.whatsapp_messages;
  v_conn public.company_whatsapp_connections;
  v_conv public.whatsapp_conversations;
  v_token text;
begin
  select * into v_msg from public.whatsapp_messages where id = p_message_id and direction = 'outbound';
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_msg.status <> 'queued' then
    return jsonb_build_object('ok', false, 'error', 'not_queued', 'status', v_msg.status);
  end if;
  select * into v_conv from public.whatsapp_conversations where id = v_msg.conversation_id;
  select * into v_conn from public.company_whatsapp_connections where id = v_msg.connection_id;
  if not found or v_conn.status <> 'active' or v_conn.phone_number_id is null then
    return jsonb_build_object('ok', false, 'error', 'connection_inactive');
  end if;
  if v_conn.mode = 'test' and not exists (
    select 1 from public.whatsapp_test_recipients r
     where r.connection_id = v_conn.id and r.phone_e164 = v_conv.contact_phone and r.is_active
  ) then
    return jsonb_build_object('ok', false, 'error', 'test_recipient_blocked');
  end if;
  if v_conn.token_secret_id is null then
    return jsonb_build_object('ok', false, 'error', 'token_unavailable');
  end if;
  select decrypted_secret into v_token from vault.decrypted_secrets where id = v_conn.token_secret_id;
  if v_token is null or v_token = '' then
    return jsonb_build_object('ok', false, 'error', 'token_unavailable');
  end if;

  return jsonb_build_object(
    'ok', true,
    'message_id', v_msg.id,
    'phone_number_id', v_conn.phone_number_id,
    'recipient_phone', v_conv.contact_phone,
    'body', v_msg.body,
    'access_token', v_token);
end;
$$;

create function public.whatsapp_mark_message_sent(p_message_id uuid, p_provider_message_id text, p_provider_timestamp timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_msg public.whatsapp_messages;
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
  update public.whatsapp_messages
     set status = 'sent', provider_message_id = left(p_provider_message_id, 200),
         provider_timestamp = coalesce(p_provider_timestamp, now())
   where id = v_msg.id;
  insert into public.whatsapp_message_events (company_id, message_id, status, provider_timestamp)
  values (v_msg.company_id, v_msg.id, 'sent', coalesce(p_provider_timestamp, now()))
  on conflict do nothing;
  return jsonb_build_object('result', 'sent', 'message_id', v_msg.id);
end;
$$;

create function public.whatsapp_mark_message_failed(p_message_id uuid, p_error_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_msg public.whatsapp_messages;
  v_err text;
begin
  select * into v_msg from public.whatsapp_messages where id = p_message_id and direction = 'outbound' for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_msg.status <> 'queued' then
    return jsonb_build_object('result', 'ignored', 'status', v_msg.status);
  end if;
  v_err := coalesce(left(nullif(regexp_replace(coalesce(p_error_code, ''), '[^A-Za-z0-9_.:-]', '', 'g'), ''), 64), 'send_failed');
  update public.whatsapp_messages set status = 'failed', error_code = v_err where id = v_msg.id;
  insert into public.whatsapp_message_events (company_id, message_id, status, error_code)
  values (v_msg.company_id, v_msg.id, 'failed', v_err)
  on conflict do nothing;
  return jsonb_build_object('result', 'failed', 'message_id', v_msg.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) ACL
-- ---------------------------------------------------------------------------
revoke execute on function public.assign_whatsapp_conversation(uuid, uuid) from public, anon, service_role;
revoke execute on function public.set_whatsapp_conversation_status(uuid, text) from public, anon, service_role;
revoke execute on function public.link_whatsapp_conversation_customer(uuid, uuid) from public, anon, service_role;
revoke execute on function public.whatsapp_list_agents(uuid) from public, anon, service_role;
revoke execute on function public.whatsapp_prepare_outbound_message(uuid, uuid, text) from public, anon, service_role;
grant execute on function public.assign_whatsapp_conversation(uuid, uuid) to authenticated;
grant execute on function public.set_whatsapp_conversation_status(uuid, text) to authenticated;
grant execute on function public.link_whatsapp_conversation_customer(uuid, uuid) to authenticated;
grant execute on function public.whatsapp_list_agents(uuid) to authenticated;
grant execute on function public.whatsapp_prepare_outbound_message(uuid, uuid, text) to authenticated;

revoke execute on function public.whatsapp_get_send_context(uuid) from public, anon, authenticated;
revoke execute on function public.whatsapp_mark_message_sent(uuid, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.whatsapp_mark_message_failed(uuid, text) from public, anon, authenticated;
grant execute on function public.whatsapp_get_send_context(uuid) to service_role;
grant execute on function public.whatsapp_mark_message_sent(uuid, text, timestamptz) to service_role;
grant execute on function public.whatsapp_mark_message_failed(uuid, text) to service_role;

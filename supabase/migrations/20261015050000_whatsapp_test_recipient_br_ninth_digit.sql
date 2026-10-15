-- WhatsApp: autorização do modo TESTE tolerante ao nono dígito brasileiro.
--
-- Causa: o Meta entrega o wa_id de celulares brasileiros antigos SEM o nono dígito (554498807633), enquanto o destinatário
-- de teste foi cadastrado COM ele (5544998807633). A comparação por igualdade estrita bloqueava o envio.
--
-- Correção (apenas lógica; sem alterar tabelas, dados, conexão, token ou Vault): helper de equivalência estrita, usado
-- pelas duas barreiras (whatsapp_prepare_outbound_message e whatsapp_get_send_context). A lista de destinatários
-- ativos continua OBRIGATÓRIA e a checagem segue no servidor, falhando fechada.
--
-- Regra: iguais, OU ambos DDI 55 com DDD válido (11-99), mesmo DDD e mesmos 8 dígitos finais, onde um tem 13 dígitos
-- (55 DD 9 NNNNNNNN) e o outro 12 (55 DD NNNNNNNN) e o número NNNNNNNN começa em 6-9 (celular). Nada de LIKE/sufixo.
-- Os ACLs das funções existentes são preservados (create or replace).

create function public.whatsapp_br_phone_equivalent(p_a text, p_b text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case
    when p_a is null or p_b is null then false
    when p_a !~ '^[0-9]+$' or p_b !~ '^[0-9]+$' then false
    when p_a = p_b then true
    when p_a ~ '^55[1-9][1-9]9[6-9][0-9]{7}$' and p_b ~ '^55[1-9][1-9][6-9][0-9]{7}$'
      then substr(p_a, 1, 4) = substr(p_b, 1, 4) and substr(p_a, 6) = substr(p_b, 5)
    when p_b ~ '^55[1-9][1-9]9[6-9][0-9]{7}$' and p_a ~ '^55[1-9][1-9][6-9][0-9]{7}$'
      then substr(p_b, 1, 4) = substr(p_a, 1, 4) and substr(p_b, 6) = substr(p_a, 5)
    else false
  end
$$;

revoke execute on function public.whatsapp_br_phone_equivalent(text, text) from public, anon, authenticated, service_role;

create or replace function public.whatsapp_prepare_outbound_message(p_conversation_id uuid, p_client_request_id uuid, p_body text)
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
     where r.connection_id = v_conn.id and public.whatsapp_br_phone_equivalent(r.phone_e164, v_conv.contact_phone) and r.is_active
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

create or replace function public.whatsapp_get_send_context(p_message_id uuid)
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
     where r.connection_id = v_conn.id and public.whatsapp_br_phone_equivalent(r.phone_e164, v_conv.contact_phone) and r.is_active
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

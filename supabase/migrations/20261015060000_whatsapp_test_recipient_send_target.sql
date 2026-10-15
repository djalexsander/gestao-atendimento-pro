-- WhatsApp: no modo TESTE, a Graph API deve receber o destinatário EXATAMENTE como autorizado na allowed list da Meta.
--
-- Causa: o wa_id da conversa (554498807633, sem o nono dígito) é equivalente ao destinatário autorizado (5544998807633),
-- e a nossa barreira já aceita isso (20261015050000), mas o envio ainda usava o contact_phone; a Meta só aceita a forma
-- cadastrada na lista "To" e respondia 131030.
--
-- Correção (apenas lógica; sem alterar tabelas, dados, conversa, token, Vault ou conexão):
--  * mode = test: whatsapp_get_send_context devolve como recipient_phone o phone_e164 do destinatário ATIVO da mesma
--    conexão que seja igual ou equivalente (whatsapp_br_phone_equivalent) ao contact_phone. Mais de um candidato
--    distinto = falha fechada (test_recipient_blocked), nunca escolha arbitrária.
--  * mode = live: continua contact_phone, sem consultar whatsapp_test_recipients.
-- ACL preservada (create or replace): só service_role.

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
  v_recipient text;
  v_matches integer;
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

  v_recipient := v_conv.contact_phone;
  if v_conn.mode = 'test' then
    select count(distinct r.phone_e164), min(r.phone_e164)
      into v_matches, v_recipient
      from public.whatsapp_test_recipients r
     where r.connection_id = v_conn.id
       and r.company_id = v_conn.company_id
       and r.is_active
       and public.whatsapp_br_phone_equivalent(r.phone_e164, v_conv.contact_phone);
    -- nenhum autorizado ou ambíguo: falha fechada
    if v_matches <> 1 then
      return jsonb_build_object('ok', false, 'error', 'test_recipient_blocked');
    end if;
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
    'recipient_phone', v_recipient,
    'body', v_msg.body,
    'access_token', v_token);
end;
$$;

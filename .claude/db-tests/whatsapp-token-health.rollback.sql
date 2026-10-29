-- Rollback de 20261108010000_whatsapp_token_health_and_registration_recovery.sql (GERADO por gen-token-health-rollback.mjs).

-- Não toca em conexões, mensagens, segredos, PINs nem na allowlist.

CREATE OR REPLACE FUNCTION public.whatsapp_get_send_context(p_message_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if not public.company_has_module(v_msg.company_id, 'whatsapp') then
    return jsonb_build_object('ok', false, 'error', 'module_inactive');
  end if;
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
$function$
;

CREATE OR REPLACE FUNCTION public.whatsapp_get_module_state(p_company_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role public.company_role;
  v_wa boolean;
  v_ia boolean;
  v_conn_active boolean;
  v_signup jsonb;
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
  v_wa := public.company_has_module(p_company_id, 'whatsapp');
  v_ia := public.company_has_module(p_company_id, 'ia');
  select exists (select 1 from public.company_whatsapp_connections c where c.company_id = p_company_id and c.status = 'active')
    into v_conn_active;
  v_signup := public.whatsapp_signup_availability_for_company(p_company_id);
  return jsonb_build_object(
    'whatsapp', v_wa,
    'ia', v_ia,
    'ai_allowed', v_wa and v_ia,
    'connection_active', v_conn_active,
    'has_history', exists (select 1 from public.whatsapp_conversations c where c.company_id = p_company_id and c.deleted_at is null),
    'can_manage', v_role in ('owner', 'admin'),
    'role', v_role,
    'signup', v_signup);
end;
$function$
;

drop function public.master_whatsapp_registration_resolve(uuid, text, text, text, text);
drop function public.master_whatsapp_registration_list(text[]);
drop function public.master_whatsapp_token_health();
drop function public.whatsapp_token_health_sweep();
drop function public.whatsapp_connection_report_send_ok(uuid);
drop function public.whatsapp_connection_report_token_failure(uuid, text, text, text);
drop function public.whatsapp_token_alert_for(uuid);
drop function public.whatsapp_token_effective_status(public.company_whatsapp_connections);
drop table public.whatsapp_registration_resolutions;
drop table public.whatsapp_token_alerts;
alter table public.company_whatsapp_connections drop column token_checked_at;

-- WhatsApp + IA automática: autorização do destinatário no modo TESTE com a MESMA resolução do envio manual (9º dígito BR).
--
-- Causa (confirmada no remoto): whatsapp_ai_prepare_auto e whatsapp_ai_auto_commit_send comparavam r.phone_e164 =
-- contact_phone (igualdade estrita). Na conversa real o wa_id é 554498807633 (sem o nono dígito) e o destinatário autorizado é
-- 5544998807633: o manual aceitava (whatsapp_br_phone_equivalent), o automático falharia fechado com test_recipient_blocked.
--
-- Correção MÍNIMA e aditiva (sem editar migrations aplicadas):
--  * whatsapp_test_recipient_for(conexão, empresa, telefone): devolve o ÚNICO destinatário ATIVO igual ou equivalente
--    (usa whatsapp_br_phone_equivalent, a mesma regra do manual); nenhum ou mais de um distinto => NULL (falha fechada),
--    exatamente como whatsapp_get_send_context. Nenhuma segunda implementação de equivalência.
--  * prepare_auto e commit_send passam a usar esse helper. O ENVIO continua pelo mesmo whatsapp_get_send_context (que devolve
--    como recipient_phone o destinatário autorizado) via dispatch compartilhado. Modo live não consulta a lista.
-- ACL preservada (create or replace): as RPCs seguem só service_role; o helper não é executável por ninguém.

create function public.whatsapp_test_recipient_for(p_connection_id uuid, p_company_id uuid, p_contact_phone text)
returns text
language sql
stable
set search_path = public
as $$
  select case when count(distinct r.phone_e164) = 1 then min(r.phone_e164) end
    from public.whatsapp_test_recipients r
   where r.connection_id = p_connection_id
     and r.company_id = p_company_id
     and r.is_active
     and public.whatsapp_br_phone_equivalent(r.phone_e164, p_contact_phone)
$$;
revoke execute on function public.whatsapp_test_recipient_for(uuid, uuid, text) from public, anon, authenticated, service_role;

create or replace function public.whatsapp_ai_prepare_auto(p_job_id uuid)
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
  -- MESMA resolução do envio manual (9º dígito BR): destinatário ativo igual ou equivalente, único; ambíguo/nenhum = falha fechada
  if v_conn.mode = 'test'
     and public.whatsapp_test_recipient_for(v_conn.id, v_conn.company_id, v_conv.contact_phone) is null then
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

create or replace function public.whatsapp_ai_auto_commit_send(p_job_id uuid, p_context_latest_message_id uuid, p_body text)
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
  -- MESMA resolução do envio manual (9º dígito BR): destinatário ativo igual ou equivalente, único; ambíguo/nenhum = falha fechada
  if v_conn.mode = 'test'
     and public.whatsapp_test_recipient_for(v_conn.id, v_conn.company_id, v_conv.contact_phone) is null then
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

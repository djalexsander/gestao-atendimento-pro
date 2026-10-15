-- WhatsApp + IA, Fase 1B: cota ESTRITA e atômica (reserva ANTES de chamar o provedor).
--
-- Problema da 070000: a cota era conferida antes da geração e o uso só era gravado depois; duas chamadas concorrentes
-- passavam juntas pelo limite. Correção (aditiva; a 070000 não é editada):
--
--  * whatsapp_ai_reserve_usage (service_role): sob advisory lock POR EMPRESA, conta as tentativas (10/min por usuário,
--    300/24 h por empresa) e, se couber, grava a reserva ('reserved') NA MESMA transação. Concorrentes são serializados:
--    o limite não estoura. Bloqueada por cota = nenhuma reserva (e o provedor NÃO é chamado).
--  * whatsapp_ai_finalize_usage (service_role): fecha a reserva com ok | timeout | provider_error | rate_limited |
--    invalid_output + tokens + latência. A tabela segue append-only: a finalização é uma LINHA NOVA que referencia a
--    reserva (reservation_id), nunca um UPDATE. Idempotente (uma finalização por reserva).
--  * Falha do provedor CONTA como tentativa (custo potencial); reserva sem finalização (Edge caiu) também conta.
--  * whatsapp_ai_prepare_suggestion deixa de checar cota (a reserva é a única autoridade) e as demais barreiras ficam iguais.
--  * whatsapp_ai_record_usage (soft) é removida: não deve existir caminho de uso sem reserva.
--
-- Contagem de tentativas = linhas com reservation_id IS NULL e status <> 'blocked' (reservas e uso legado); linhas de
-- finalização e de bloqueio não contam. Nenhum prompt, resposta, telefone ou conteúdo é gravado.

-- ---------------------------------------------------------------------------
-- 1) Estrutura
-- ---------------------------------------------------------------------------
alter table public.whatsapp_ai_usage drop constraint whatsapp_ai_usage_status_check;
alter table public.whatsapp_ai_usage add constraint whatsapp_ai_usage_status_check
  check (status in ('reserved', 'ok', 'timeout', 'provider_error', 'rate_limited', 'invalid_output', 'blocked'));

alter table public.whatsapp_ai_usage add column reservation_id uuid;
alter table public.whatsapp_ai_usage add column block_reason text
  constraint whatsapp_ai_usage_block_reason_check check (block_reason is null or block_reason in ('user_minute', 'company_day'));

-- uma única finalização por reserva
create unique index whatsapp_ai_usage_reservation_uniq
  on public.whatsapp_ai_usage (reservation_id) where reservation_id is not null;

-- ---------------------------------------------------------------------------
-- 2) Reserva atômica
-- ---------------------------------------------------------------------------
create function public.whatsapp_ai_reserve_usage(
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

  -- serializa as reservas da MESMA empresa (cobre o limite por usuário e o da empresa); liberado no fim da transação
  perform pg_advisory_xact_lock(hashtextextended('whatsapp_ai_quota:' || p_company_id::text, 0));

  select count(*) into v_user_count
    from public.whatsapp_ai_usage
   where company_id = p_company_id and user_id = p_user_id
     and reservation_id is null and status <> 'blocked'
     and created_at > now() - interval '1 minute';
  select count(*) into v_company_count
    from public.whatsapp_ai_usage
   where company_id = p_company_id
     and reservation_id is null and status <> 'blocked'
     and created_at > now() - interval '24 hours';

  if v_user_count >= 10 then
    v_reason := 'user_minute';
  elsif v_company_count >= 300 then
    v_reason := 'company_day';
  end if;

  if v_reason is not null then
    -- registro de auditoria da recusa, no máximo 1 por usuário/minuto (a tabela não cresce com spam)
    if not exists (
      select 1 from public.whatsapp_ai_usage
       where company_id = p_company_id and user_id = p_user_id and status = 'blocked'
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

-- ---------------------------------------------------------------------------
-- 3) Finalização (linha nova; append-only preservado)
-- ---------------------------------------------------------------------------
create function public.whatsapp_ai_finalize_usage(
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
    company_id, conversation_id, user_id, provider, model, status, input_tokens, output_tokens, latency_ms, reservation_id)
  values (
    v_res.company_id, v_res.conversation_id, v_res.user_id, v_res.provider, v_res.model, p_status,
    case when p_input_tokens >= 0 then p_input_tokens end,
    case when p_output_tokens >= 0 then p_output_tokens end,
    case when p_latency_ms >= 0 then p_latency_ms end,
    p_usage_id);
  return jsonb_build_object('result', 'ok');
exception
  when unique_violation then
    return jsonb_build_object('result', 'already_finalized');
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) A autoridade da cota passa a ser a reserva
-- ---------------------------------------------------------------------------
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
  v_customer_first text;
  v_messages jsonb;
begin
  -- papel + módulo + empresa: tudo do banco (PT401/PT403/PT404)
  v_conv := public.whatsapp_load_conversation(p_conversation_id);

  select * into v_s from public.company_whatsapp_ai_settings where company_id = v_conv.company_id;
  if not found
     or public.whatsapp_ai_effective_mode(v_s.enabled, v_s.mode, v_s.ai_data_processing_acknowledged_at) <> 'suggest' then
    raise exception 'A sugestão por IA não está ativada para esta empresa.' using errcode = 'PT409';
  end if;

  if v_conv.status = 'closed' then
    raise exception 'Reabra a conversa para gerar uma sugestão.' using errcode = 'PT409';
  end if;
  v_win := public.whatsapp_can_send_freeform(v_conv.last_inbound_at);
  if not (v_win ->> 'can_send')::boolean then
    raise exception 'Fora da janela de atendimento de 24 horas.' using errcode = 'PT409';
  end if;

  -- só o primeiro nome do cliente vinculado (nunca telefone, e-mail, documento ou outro cliente)
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
    'mode', public.whatsapp_ai_effective_mode(v_s.enabled, v_s.mode, v_s.ai_data_processing_acknowledged_at),
    'business_name', v_s.business_name,
    'tone', v_s.tone,
    'custom_instructions', v_s.custom_instructions,
    'business_hours', v_s.business_hours,
    'fallback_to_human', v_s.fallback_to_human,
    'customer_first_name', nullif(v_customer_first, ''),
    'messages', v_messages);
end;
$$;

drop function public.whatsapp_ai_record_usage(uuid, uuid, uuid, text, text, text, integer, integer, integer);

-- ---------------------------------------------------------------------------
-- 5) ACL: só service_role
-- ---------------------------------------------------------------------------
revoke execute on function public.whatsapp_ai_reserve_usage(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.whatsapp_ai_finalize_usage(uuid, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.whatsapp_ai_reserve_usage(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.whatsapp_ai_finalize_usage(uuid, text, integer, integer, integer) to service_role;

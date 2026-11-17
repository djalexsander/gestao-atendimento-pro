-- Etapa 7.11F (LOCAL, NÃO aplicada): INICIAR CONVERSA pelo WhatsApp — a RPC que une reserva (7.11B), conversa única por contato (7.11D),
-- enfileiramento do template (7.11E) e a consulta/resolução de envios incertos. ADITIVA: 1 RPC de início, 2 de acompanhamento, 2 auxiliares internas,
-- 5 colunas novas em whatsapp_start_requests. NÃO altera whatsapp_get_send_context, o envio de texto, ingest/eco da Coexistence, IA, webhooks nem Meta.
--
-- A chamada à Meta NÃO acontece aqui (nenhuma função de banco faz HTTP): a Edge `whatsapp-start-conversation` chama esta RPC com o JWT do usuário e, DEPOIS
-- do commit, despacha o template (7.11E). Tudo o que esta RPC faz é UMA transação: qualquer falha antes do despacho desfaz reserva, conversa e mensagem.
--
-- Garantias principais
--   * telefone resolvido SÓ no servidor, a partir do contato manual ou do cliente da MESMA empresa (o cliente nunca informa número);
--   * conversa reaproveitada pela equivalência do nono dígito, sob o MESMO lock do recebimento (wa_conv:<conexão>:<chave>);
--   * conversa iniciada/reaproveitada pela empresa fica com ai_control = 'human' (+ jobs pendentes da IA cancelados): a resposta do cliente NÃO aciona a IA;
--   * consentimento: confirmação explícita + ORIGEM + REFERÊNCIA do registro (sem telefone/8+ dígitos), gravadas no pedido;
--   * opt-out, limite diário e intervalo por contato vêm da reserva (7.11B/7.11D) e são conferidos de novo no enfileiramento e no envio (7.11E);
--   * idempotência por client_request_id: repetir devolve o mesmo pedido/conversa/mensagem; o despacho repetido NUNCA reenvia (claim da 7.11E);
--   * "aceito pela Meta" (request 'sent', mensagem 'sent') NÃO é "entregue": a entrega só vale quando o webhook de status atualizar a mensagem.

-- ---------------------------------------------------------------------------
-- 1) Colunas novas do pedido (consentimento com origem/referência; resolução manual)
-- ---------------------------------------------------------------------------
alter table public.whatsapp_start_requests
  add column consent_origin text
    constraint whatsapp_start_requests_consent_origin_check check (consent_origin is null or consent_origin in ('written_consent', 'customer_request', 'external_record', 'other_documented')),
  add column consent_ref text
    constraint whatsapp_start_requests_consent_ref_check check (consent_ref is null or (char_length(consent_ref) between 3 and 80 and regexp_replace(consent_ref, '[^0-9]', '', 'g') !~ '[0-9]{8,}')),
  add column resolved_by uuid references auth.users (id) on delete set null,
  add column resolved_at timestamptz,
  add column resolution text
    constraint whatsapp_start_requests_resolution_check check (resolution is null or resolution in ('confirmed_sent', 'confirmed_not_sent', 'cancelled_unsent'));

-- ---------------------------------------------------------------------------
-- 2) Estado do pedido (interno): o que o operador precisa saber
-- ---------------------------------------------------------------------------
--   pending_dispatch = 'queued' e ninguém chamou a Meta ainda (a Edge caiu antes; repetir o MESMO pedido despacha com segurança)
--   in_progress      = reivindicado há menos de 2 min (outra chamada está falando com a Meta)
--   unconfirmed      = a Meta pode ter aceitado (timeout/rede/5xx/sem id) ou o processo caiu depois do claim: NUNCA reenvia sozinho; o operador resolve
--   accepted         = a Meta ACEITOU o envio (não é "entregue")      failed = recusado/cancelado
create function public.whatsapp_start_request_state(p_status text, p_msg_error_code text, p_claimed_at timestamptz)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when p_status = 'sent' then 'accepted'
    when p_status = 'failed' then 'failed'
    when p_msg_error_code like 'unconfirmed\_%' then 'unconfirmed'
    when p_claimed_at is null then 'pending_dispatch'
    when p_claimed_at > now() - interval '2 minutes' then 'in_progress'
    else 'unconfirmed'
  end
$$;
revoke execute on function public.whatsapp_start_request_state(text, text, timestamptz) from public, anon, authenticated, service_role;

-- resposta padrão da RPC (interna)
create function public.whatsapp_start_request_result(p_request_id uuid, p_idempotent boolean, p_conversation_created boolean default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'request_id', r.id,
    'conversation_id', r.conversation_id,
    'message_id', r.message_id,
    'request_status', r.status,
    'state', public.whatsapp_start_request_state(r.status, m.error_code, t.claimed_at),
    'delivery_status', m.status,
    'error_code', coalesce(m.error_code, r.error_code),
    'idempotent', p_idempotent,
    'conversation_created', p_conversation_created,
    'dispatch_required', public.whatsapp_start_request_state(r.status, m.error_code, t.claimed_at) = 'pending_dispatch')
  from public.whatsapp_start_requests r
  left join public.whatsapp_messages m on m.id = r.message_id and m.company_id = r.company_id
  left join public.whatsapp_template_messages t on t.message_id = r.message_id
  where r.id = p_request_id
$$;
revoke execute on function public.whatsapp_start_request_result(uuid, boolean, boolean) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) whatsapp_start_conversation
-- ---------------------------------------------------------------------------
create function public.whatsapp_start_conversation(
  p_company_id uuid,
  p_client_request_id uuid,
  p_contact_kind text,
  p_contact_ref uuid,
  p_template_id uuid,
  p_params jsonb,
  p_consent_confirmed boolean,
  p_consent_origin text,
  p_consent_ref text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_conn public.company_whatsapp_connections;
  v_req public.whatsapp_start_requests;
  v_conv public.whatsapp_conversations;
  v_resv jsonb;
  v_enq jsonb;
  v_phone text;
  v_name text;
  v_customer uuid;
  v_key text;
  v_cphone text;
  v_ref text := nullif(btrim(coalesce(p_consent_ref, '')), '');
  v_created boolean := false;
  v_raw text;
  v_archived timestamptz;
  v_active boolean;
  v_matches integer;
begin
  v_role := public.whatsapp_start_assert_starter(p_company_id);          -- PT401/PT404/PT403/PT402 + módulo WhatsApp (PT403)

  if p_client_request_id is null or p_contact_ref is null or p_template_id is null
     or p_contact_kind is null or p_contact_kind not in ('manual', 'customer') then
    raise exception 'Pedido de início de conversa inválido.' using errcode = 'PT400';
  end if;
  if p_consent_confirmed is distinct from true then
    raise exception 'Confirme que o contato autorizou receber mensagens da empresa.' using errcode = 'PT400';
  end if;
  if p_consent_origin is null or p_consent_origin not in ('written_consent', 'customer_request', 'external_record', 'other_documented') then
    raise exception 'Informe a origem da autorização do contato.' using errcode = 'PT400';
  end if;
  if v_ref is null or char_length(v_ref) not between 3 and 80 then
    raise exception 'Informe a referência da autorização (de 3 a 80 caracteres).' using errcode = 'PT400';
  end if;
  if regexp_replace(v_ref, '[^0-9]', '', 'g') ~ '[0-9]{8,}' then
    raise exception 'A referência da autorização não pode conter telefone nem sequência de 8 ou mais dígitos.' using errcode = 'PT400';
  end if;

  -- repetição do MESMO pedido (duplo clique/retry/Edge que caiu): devolve o que já existe; quem despacha depois é protegido pelo claim da 7.11E
  select * into v_req from public.whatsapp_start_requests where company_id = p_company_id and client_request_id = p_client_request_id;
  if found then
    if v_req.contact_kind <> p_contact_kind or v_req.contact_ref <> p_contact_ref or v_req.template_id is distinct from p_template_id
       or v_req.requested_by is distinct from auth.uid() then
      raise exception 'Este identificador de pedido já foi usado por outro pedido.' using errcode = 'PT409';
    end if;
    return public.whatsapp_start_request_result(v_req.id, true);
  end if;

  select * into v_conn from public.company_whatsapp_connections where company_id = p_company_id and status = 'active';
  if not found then
    raise exception 'O WhatsApp desta empresa não está conectado.' using errcode = 'PT409';
  end if;

  -- telefone SÓ no servidor, do contato/cliente da MESMA empresa
  if p_contact_kind = 'manual' then
    select m.phone_e164, m.name, m.customer_id, m.archived_at into v_phone, v_name, v_customer, v_archived
      from public.whatsapp_contacts m where m.id = p_contact_ref and m.company_id = p_company_id;
    if not found then
      raise exception 'Contato não encontrado.' using errcode = 'PT404';
    end if;
    if v_archived is not null then
      raise exception 'Este contato está arquivado.' using errcode = 'PT409';
    end if;
  else
    select u.name, coalesce(nullif(u.whatsapp, ''), nullif(u.phone, '')), u.is_active, u.id into v_name, v_raw, v_active, v_customer
      from public.customers u where u.id = p_contact_ref and u.company_id = p_company_id;
    if not found then
      raise exception 'Contato não encontrado.' using errcode = 'PT404';
    end if;
    if v_active is not true then
      raise exception 'Este cliente está inativo.' using errcode = 'PT409';
    end if;
    v_phone := public.whatsapp_contact_normalize_phone(v_raw);
  end if;
  if v_phone is null then
    raise exception 'Contato não encontrado ou sem telefone válido.' using errcode = 'PT404';
  end if;
  v_key := public.whatsapp_optout_contact_key(p_company_id, p_contact_kind, p_contact_ref);

  -- conexão em modo teste: só destinatários autorizados (nada é criado para quem não pode receber)
  if v_conn.mode = 'test' then
    select count(distinct r.phone_e164) into v_matches
      from public.whatsapp_test_recipients r
     where r.connection_id = v_conn.id and r.company_id = v_conn.company_id and r.is_active
       and public.whatsapp_br_phone_equivalent(r.phone_e164, v_phone);
    if v_matches <> 1 then
      raise exception 'A conexão está em modo de teste e este contato não está autorizado.' using errcode = 'PT409';
    end if;
  end if;

  -- reserva: papel, consentimento, funcionalidade ativada, template aprovado, OPT-OUT, limite diário e intervalo por contato (lock por empresa)
  v_resv := public.whatsapp_start_request_reserve(p_company_id, v_conn.id, p_client_request_id, p_contact_kind, p_contact_ref, v_key, p_template_id, true);
  if (v_resv ->> 'idempotent')::boolean then
    return public.whatsapp_start_request_result((v_resv ->> 'request_id')::uuid, true);
  end if;

  -- conversa ÚNICA por contato: lock do recebimento + equivalência do nono dígito; só cria se não houver
  v_cphone := public.whatsapp_resolve_conversation_phone(v_conn.id, v_phone);
  select * into v_conv from public.whatsapp_conversations
   where connection_id = v_conn.id and company_id = p_company_id and contact_phone = v_cphone and deleted_at is null for update;
  if not found then
    begin
      insert into public.whatsapp_conversations (company_id, connection_id, contact_phone, contact_display_name, customer_id, status, ai_control, ai_control_changed_at, ai_control_changed_by)
      values (p_company_id, v_conn.id, v_cphone, left(nullif(btrim(coalesce(v_name, '')), ''), 80), case when p_contact_kind = 'customer' then v_customer else null end,
              'open', 'human', now(), auth.uid())
      returning * into v_conv;
      v_created := true;
    exception when unique_violation then
      -- outra gravação (ex.: eco da Coexistence, que não usa o lock) criou a mesma conversa entre o SELECT e o INSERT: usa a existente
      select * into v_conv from public.whatsapp_conversations
       where connection_id = v_conn.id and company_id = p_company_id and contact_phone = v_cphone and deleted_at is null for update;
      if not found then
        raise exception 'Não foi possível abrir a conversa agora. Tente novamente.' using errcode = 'PT409';
      end if;
    end;
  end if;

  if not v_created then
    -- conversa já existente: a IA não pode assumir a conversa que a empresa acabou de iniciar
    if v_conv.ai_control <> 'human' then
      update public.whatsapp_conversations
         set ai_control = 'human', ai_control_changed_at = now(), ai_control_changed_by = auth.uid(), ai_handoff_reason = null
       where id = v_conv.id;
      insert into public.whatsapp_conversation_events (company_id, conversation_id, event_type, actor_user_id, old_value, new_value)
      values (p_company_id, v_conv.id, 'ai_paused', auth.uid(), jsonb_build_object('ai_control', v_conv.ai_control),
              jsonb_build_object('ai_control', 'human', 'reason', 'conversation_started'));
    end if;
    update public.whatsapp_conversations
       set status = case when status = 'closed' then 'open' else status end,
           customer_id = coalesce(customer_id, case when p_contact_kind = 'customer' then v_customer else null end),
           contact_display_name = coalesce(contact_display_name, left(nullif(btrim(coalesce(v_name, '')), ''), 80))
     where id = v_conv.id;
  end if;
  update public.whatsapp_ai_jobs
     set status = 'cancelled', outcome = 'aborted_human', reason_code = 'conversation_started', locked_until = null
   where conversation_id = v_conv.id and status = 'pending';

  -- mensagem 'queued' (revalida template, variáveis e opt-out de novo) e vínculo do pedido
  v_enq := public.whatsapp_template_message_enqueue((v_resv ->> 'request_id')::uuid, v_conv.id, p_params);
  update public.whatsapp_start_requests
     set conversation_id = v_conv.id, message_id = (v_enq ->> 'message_id')::uuid, consent_origin = p_consent_origin, consent_ref = v_ref
   where id = (v_resv ->> 'request_id')::uuid;

  return public.whatsapp_start_request_result((v_resv ->> 'request_id')::uuid, false, v_created);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Acompanhar pedidos (para a tela futura): sem telefone e sem token
-- ---------------------------------------------------------------------------
-- owner/admin veem todos; atendente vê só os próprios. p_only_attention = só o que precisa de ação (pending_dispatch/unconfirmed).
create function public.whatsapp_list_start_requests(p_company_id uuid, p_only_attention boolean default false, p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  v_role := public.whatsapp_assert_reader(p_company_id);
  if v_role not in ('owner', 'admin', 'attendant') then
    raise exception 'Seu perfil não pode consultar os pedidos de início de conversa.' using errcode = 'PT403';
  end if;
  return coalesce((
    select jsonb_agg(x.j order by x.created_at desc)
      from (
        select r.created_at,
               jsonb_build_object(
                 'request_id', r.id, 'created_at', r.created_at, 'conversation_id', r.conversation_id, 'message_id', r.message_id,
                 'contact_kind', r.contact_kind, 'contact_ref', r.contact_ref,
                 'contact_name', case r.contact_kind
                                   when 'manual' then (select c.name from public.whatsapp_contacts c where c.id = r.contact_ref and c.company_id = r.company_id)
                                   else (select u.name from public.customers u where u.id = r.contact_ref and u.company_id = r.company_id) end,
                 'template_name', r.template_name, 'requested_by_me', r.requested_by is not distinct from auth.uid(),
                 'request_status', r.status,
                 'state', public.whatsapp_start_request_state(r.status, m.error_code, t.claimed_at),
                 'delivery_status', m.status, 'error_code', coalesce(m.error_code, r.error_code),
                 'resolution', r.resolution, 'resolved_at', r.resolved_at) as j
          from public.whatsapp_start_requests r
          left join public.whatsapp_messages m on m.id = r.message_id and m.company_id = r.company_id
          left join public.whatsapp_template_messages t on t.message_id = r.message_id
         where r.company_id = p_company_id
           and (v_role in ('owner', 'admin') or r.requested_by is not distinct from auth.uid())
           and (not coalesce(p_only_attention, false) or public.whatsapp_start_request_state(r.status, m.error_code, t.claimed_at) in ('pending_dispatch', 'unconfirmed'))
         order by r.created_at desc
         limit v_limit
      ) x
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Resolver pedido incerto/preso (NUNCA reenvia: encerra o pedido e libera/mantém a vaga conforme a atestação)
-- ---------------------------------------------------------------------------
--   confirmed_sent      (state unconfirmed)       o operador CONFIRMOU no WhatsApp/Meta que a mensagem saiu: mensagem 'sent' (id sintético manual:<id>), pedido 'sent'
--   confirmed_not_sent  (state unconfirmed)       o operador CONFIRMOU que NÃO saiu: mensagem e pedido 'failed' (libera a vaga e o intervalo; novo pedido = novo client_request_id)
--   cancelled_unsent    (state pending_dispatch)  desiste de um pedido que nunca chegou à Meta (o claim é tomado antes, então nenhum despacho tardio o envia)
create function public.whatsapp_start_request_resolve(p_request_id uuid, p_resolution text, p_attested boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_req public.whatsapp_start_requests;
  v_msg public.whatsapp_messages;
  v_tm public.whatsapp_template_messages;
  v_role public.company_role;
  v_state text;
  v_claimed uuid;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_req from public.whatsapp_start_requests where id = p_request_id for update;
  if not found or public.user_role_in_company(v_req.company_id) is null then
    raise exception 'Pedido não encontrado.' using errcode = 'PT404';
  end if;
  v_role := public.whatsapp_start_assert_starter(v_req.company_id);
  if v_role = 'attendant' and v_req.requested_by is distinct from auth.uid() then
    raise exception 'Você só pode resolver os seus próprios pedidos.' using errcode = 'PT403';
  end if;
  if p_resolution is null or p_resolution not in ('confirmed_sent', 'confirmed_not_sent', 'cancelled_unsent') then
    raise exception 'Resolução inválida.' using errcode = 'PT400';
  end if;
  if p_attested is distinct from true then
    raise exception 'Confirme que você verificou o envio antes de resolver o pedido.' using errcode = 'PT400';
  end if;
  if v_req.status <> 'queued' or v_req.message_id is null then
    raise exception 'Este pedido já foi encerrado.' using errcode = 'PT409';
  end if;
  select * into v_msg from public.whatsapp_messages where id = v_req.message_id and company_id = v_req.company_id for update;
  select * into v_tm from public.whatsapp_template_messages where message_id = v_req.message_id;
  if v_msg.id is null or v_tm.message_id is null or v_msg.status <> 'queued' then
    raise exception 'Este pedido já foi encerrado.' using errcode = 'PT409';
  end if;
  v_state := public.whatsapp_start_request_state(v_req.status, v_msg.error_code, v_tm.claimed_at);

  if v_state = 'in_progress' then
    raise exception 'O envio ainda está em andamento. Aguarde alguns minutos.' using errcode = 'PT409';
  end if;
  if p_resolution in ('confirmed_sent', 'confirmed_not_sent') and v_state <> 'unconfirmed' then
    raise exception 'Só um envio sem confirmação pode ser resolvido assim.' using errcode = 'PT409';
  end if;
  if p_resolution = 'cancelled_unsent' then
    if v_state <> 'pending_dispatch' then
      raise exception 'Só um pedido que ainda não foi enviado pode ser cancelado.' using errcode = 'PT409';
    end if;
    -- toma o claim: impede qualquer despacho concorrente/tardio
    update public.whatsapp_template_messages set claimed_at = now() where message_id = v_tm.message_id and claimed_at is null returning message_id into v_claimed;
    if v_claimed is null then
      raise exception 'O envio já foi iniciado e não pode ser cancelado.' using errcode = 'PT409';
    end if;
  end if;

  if p_resolution = 'confirmed_sent' then
    perform public.whatsapp_mark_message_sent(v_msg.id, 'manual:' || v_msg.id::text);
    perform public.whatsapp_start_request_finish(v_req.id, 'sent', v_req.conversation_id, v_msg.id, null);
  else
    perform public.whatsapp_mark_message_failed(v_msg.id, case p_resolution when 'confirmed_not_sent' then 'operator_confirmed_not_sent' else 'cancelled_by_operator' end);
    perform public.whatsapp_start_request_finish(v_req.id, 'failed', v_req.conversation_id, v_msg.id, case p_resolution when 'confirmed_not_sent' then 'operator_confirmed_not_sent' else 'cancelled_by_operator' end);
  end if;
  update public.whatsapp_start_requests set resolution = p_resolution, resolved_by = auth.uid(), resolved_at = now() where id = v_req.id;
  return public.whatsapp_start_request_result(v_req.id, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) ACL: só usuários autenticados; service_role/anon não chamam
-- ---------------------------------------------------------------------------
revoke execute on function public.whatsapp_start_conversation(uuid, uuid, text, uuid, uuid, jsonb, boolean, text, text) from public, anon, service_role;
revoke execute on function public.whatsapp_list_start_requests(uuid, boolean, integer) from public, anon, service_role;
revoke execute on function public.whatsapp_start_request_resolve(uuid, text, boolean) from public, anon, service_role;
grant execute on function public.whatsapp_start_conversation(uuid, uuid, text, uuid, uuid, jsonb, boolean, text, text) to authenticated;
grant execute on function public.whatsapp_list_start_requests(uuid, boolean, integer) to authenticated;
grant execute on function public.whatsapp_start_request_resolve(uuid, text, boolean) to authenticated;

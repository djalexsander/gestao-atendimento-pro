-- Etapa 7.11E (LOCAL, NÃO aplicada): DESPACHO de templates aprovados da Meta — lado do banco. Migration ADITIVA sobre a 7.11B/C/D: 1 tabela e 6 funções novas.
-- NÃO altera whatsapp_get_send_context, whatsapp_prepare_outbound_message, whatsapp_mark_message_*, o envio de texto, a IA, a Coexistence, o recebimento nem os
-- webhooks. NÃO envia nada (nenhuma função de banco faz HTTP), NÃO cria conversa (a RPC de iniciar conversa é a 7.11F) e NÃO ativa a funcionalidade.
--
-- Por que um contexto de envio PRÓPRIO (e não mexer em whatsapp_get_send_context, função crítica do envio de texto): o template tem regras que o texto não tem
-- (status/elegibilidade do template, variáveis, opt-out, claim anti-duplicidade). O contexto novo repete só as barreiras comuns (módulo, conexão ativa, modo
-- teste, saúde do token) e deixa o caminho de texto byte a byte como está.
--
-- Fluxo:
--   enqueue (INTERNA; a RPC da 7.11F a chamará na mesma transação do pedido de início)  -> mensagem outbound type='template' 'queued' + linha de metadados.
--   whatsapp_get_template_send_context(msg)  [service_role]  revalida TUDO no momento do envio (template APROVADO e elegível, nome/idioma iguais ao reservado,
--      variáveis, conexão, token, modo teste, OPT-OUT) e faz o CLAIM atômico: só quem ganha o claim chama a Meta, então um envio nunca é feito duas vezes.
--   Graph API (Edge, _shared/whatsapp-template-dispatch.ts)
--   whatsapp_template_message_finish(msg, 'sent'|'failed'|'uncertain', ...)  [service_role]  grava o resultado, fecha o pedido (libera a vaga só se FALHOU de forma
--      definitiva) e, no erro 131050 da Meta, registra o opt-out.
-- Resposta ambígua da Meta (timeout, rede, 5xx, resposta sem id): a mensagem fica 'queued' com error_code 'unconfirmed_*' e o pedido continua 'queued' (conta no
-- limite e no intervalo por contato); NUNCA é reenviada automaticamente (o claim já foi usado).

-- ---------------------------------------------------------------------------
-- 1) Metadados da mensagem de template (a tabela whatsapp_messages não muda)
-- ---------------------------------------------------------------------------
create table public.whatsapp_template_messages (
  message_id uuid primary key,
  company_id uuid not null references public.companies (id) on delete cascade,
  connection_id uuid not null,
  template_id uuid,
  template_name text not null
    constraint whatsapp_template_messages_name_check check (char_length(template_name) between 1 and 512),
  template_language text not null,
  -- valores das variáveis do corpo, na ordem {{1}}, {{2}}…; necessários para enviar (o corpo renderizado já fica na própria mensagem)
  body_parameters jsonb not null default '[]'::jsonb
    constraint whatsapp_template_messages_params_check check (jsonb_typeof(body_parameters) = 'array' and jsonb_array_length(body_parameters) <= 50),
  start_request_id uuid,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint whatsapp_template_messages_message_fkey
    foreign key (message_id, company_id) references public.whatsapp_messages (id, company_id) on delete cascade,
  constraint whatsapp_template_messages_connection_fkey
    foreign key (connection_id, company_id) references public.company_whatsapp_connections (id, company_id) on delete cascade,
  constraint whatsapp_template_messages_template_fkey
    foreign key (template_id, company_id) references public.whatsapp_message_templates (id, company_id) on delete set null (template_id),
  constraint whatsapp_template_messages_request_fkey
    foreign key (start_request_id, company_id) references public.whatsapp_start_requests (id, company_id) on delete set null (start_request_id)
);
create index whatsapp_template_messages_request_idx on public.whatsapp_template_messages (start_request_id) where start_request_id is not null;

-- imutável, exceto o claim (uma vez) e o "soltar" do Postgres (template/pedido apagados)
create function public.guard_whatsapp_template_message()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    return old;
  end if;
  if (to_jsonb(new) - 'claimed_at' - 'template_id' - 'start_request_id') <> (to_jsonb(old) - 'claimed_at' - 'template_id' - 'start_request_id') then
    raise exception 'Metadados da mensagem de template são imutáveis.' using errcode = 'PT409';
  end if;
  if old.claimed_at is not null and new.claimed_at is distinct from old.claimed_at then
    raise exception 'O envio desta mensagem já foi reivindicado.' using errcode = 'PT409';
  end if;
  if (new.template_id is not null and new.template_id is distinct from old.template_id)
     or (new.start_request_id is not null and new.start_request_id is distinct from old.start_request_id) then
    raise exception 'Metadados da mensagem de template são imutáveis.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_whatsapp_template_message() from public, anon, authenticated, service_role;
create trigger whatsapp_template_messages_guard
  before update on public.whatsapp_template_messages
  for each row execute function public.guard_whatsapp_template_message();

alter table public.whatsapp_template_messages enable row level security;
revoke all on public.whatsapp_template_messages from public, anon, authenticated;
grant all on public.whatsapp_template_messages to service_role;

-- ---------------------------------------------------------------------------
-- 2) Variáveis: validação no servidor e corpo renderizado
-- ---------------------------------------------------------------------------
-- A Meta recusa parâmetros de texto com quebra de linha, tabulação ou 4+ espaços seguidos, e limita o tamanho. Aqui: array de STRINGS, quantidade IGUAL à do
-- template, cada uma aparada, com 1 a 1024 caracteres e sem esses caracteres. Devolve o array normalizado.
create function public.whatsapp_template_params_normalize(p_params jsonb, p_expected integer)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  v_out jsonb := '[]'::jsonb;
  v_item jsonb;
  v_txt text;
begin
  if p_params is null or jsonb_typeof(p_params) <> 'array' then
    raise exception 'Variáveis do template inválidas.' using errcode = 'PT400';
  end if;
  if jsonb_array_length(p_params) <> coalesce(p_expected, 0) then
    raise exception 'O template exige % variável(is); foram informadas %.', coalesce(p_expected, 0), jsonb_array_length(p_params) using errcode = 'PT400';
  end if;
  for v_item in select * from jsonb_array_elements(p_params) loop
    if jsonb_typeof(v_item) <> 'string' then
      raise exception 'Cada variável do template precisa ser um texto.' using errcode = 'PT400';
    end if;
    v_txt := btrim(v_item #>> '{}');
    if char_length(v_txt) not between 1 and 1024 then
      raise exception 'Cada variável do template precisa ter de 1 a 1024 caracteres.' using errcode = 'PT400';
    end if;
    if v_txt ~ ('[' || chr(9) || chr(10) || chr(13) || ']') or v_txt like '%    %' then
      raise exception 'As variáveis do template não podem ter quebra de linha, tabulação nem 4 espaços seguidos.' using errcode = 'PT400';
    end if;
    v_out := v_out || to_jsonb(v_txt);
  end loop;
  return v_out;
end;
$$;
revoke execute on function public.whatsapp_template_params_normalize(jsonb, integer) from public, anon, authenticated, service_role;

-- Corpo do template com {{n}} substituídos (para mostrar na caixa de entrada)
create function public.whatsapp_template_render_body(p_components jsonb, p_params jsonb)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_text text;
  i integer;
begin
  select c ->> 'text' into v_text from jsonb_array_elements(coalesce(p_components, '[]'::jsonb)) c where upper(c ->> 'type') = 'BODY' limit 1;
  v_text := coalesce(v_text, '');
  for i in 1 .. coalesce(jsonb_array_length(p_params), 0) loop
    v_text := replace(v_text, '{{' || i || '}}', p_params ->> (i - 1));
  end loop;
  return left(v_text, 4096);
end;
$$;
revoke execute on function public.whatsapp_template_render_body(jsonb, jsonb) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) Enfileirar (INTERNA): mensagem 'queued' + metadados, idempotente
-- ---------------------------------------------------------------------------
create function public.whatsapp_template_message_enqueue(p_request_id uuid, p_conversation_id uuid, p_params jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_req public.whatsapp_start_requests;
  v_conv public.whatsapp_conversations;
  v_conn public.company_whatsapp_connections;
  v_tpl public.whatsapp_message_templates;
  v_msg public.whatsapp_messages;
  v_params jsonb;
  v_body text;
  v_reason text;
begin
  select * into v_req from public.whatsapp_start_requests where id = p_request_id for update;
  if not found then
    raise exception 'Pedido de início não encontrado.' using errcode = 'PT404';
  end if;
  select * into v_conv from public.whatsapp_conversations where id = p_conversation_id and company_id = v_req.company_id and deleted_at is null;
  if not found or v_conv.connection_id <> v_req.connection_id then
    raise exception 'Conversa não encontrada.' using errcode = 'PT404';
  end if;

  -- repetição do MESMO pedido: devolve a mesma mensagem (nunca cria outra)
  select * into v_msg from public.whatsapp_messages
   where company_id = v_req.company_id and conversation_id = v_conv.id and client_request_id = v_req.client_request_id;
  if found then
    return jsonb_build_object('message_id', v_msg.id, 'status', v_msg.status, 'idempotent', true);
  end if;
  if v_req.status <> 'queued' then
    raise exception 'Este pedido de início já foi encerrado.' using errcode = 'PT409';
  end if;

  select * into v_conn from public.company_whatsapp_connections where id = v_req.connection_id and company_id = v_req.company_id;
  if not found or v_conn.status <> 'active' then
    raise exception 'O WhatsApp desta empresa não está conectado.' using errcode = 'PT409';
  end if;

  select * into v_tpl from public.whatsapp_message_templates where id = v_req.template_id and company_id = v_req.company_id and connection_id = v_req.connection_id;
  if not found then
    raise exception 'Template não encontrado.' using errcode = 'PT404';
  end if;
  if v_tpl.status <> 'APPROVED' then
    raise exception 'Este template não está aprovado pela Meta.' using errcode = 'PT409';
  end if;
  v_reason := public.whatsapp_template_ineligible_reason(v_tpl.components);
  if v_reason is not null then
    raise exception 'Este template ainda não é compatível com o envio pelo aplicativo (%).', v_reason using errcode = 'PT409';
  end if;
  if v_tpl.name <> v_req.template_name or v_tpl.language <> v_req.template_language then
    raise exception 'O template mudou desde a reserva. Tente novamente.' using errcode = 'PT409';
  end if;

  v_params := public.whatsapp_template_params_normalize(p_params, v_tpl.body_variable_count);

  -- opt-out (de novo, depois da reserva): falha na verificação BLOQUEIA (falha fechada)
  begin
    if public.whatsapp_optout_is_blocked(v_req.company_id, public.whatsapp_contact_key(v_conv.contact_phone, false)) then
      raise exception 'Este contato pediu para não receber mensagens da empresa.' using errcode = 'PT409';
    end if;
  exception
    when sqlstate 'PT409' then raise;
    when others then
      raise exception 'Não foi possível verificar o bloqueio do contato. Tente novamente.' using errcode = 'PT409';
  end;

  v_body := public.whatsapp_template_render_body(v_tpl.components, v_params);
  insert into public.whatsapp_messages (company_id, connection_id, conversation_id, provider_message_id, direction, type, body, status, sent_by_user_id, client_request_id, origin)
  values (v_req.company_id, v_req.connection_id, v_conv.id, null, 'outbound', 'template', v_body, 'queued', v_req.requested_by, v_req.client_request_id, 'human')
  returning * into v_msg;
  insert into public.whatsapp_template_messages (message_id, company_id, connection_id, template_id, template_name, template_language, body_parameters, start_request_id)
  values (v_msg.id, v_req.company_id, v_req.connection_id, v_tpl.id, v_tpl.name, v_tpl.language, v_params, v_req.id);
  insert into public.whatsapp_message_events (company_id, message_id, status) values (v_req.company_id, v_msg.id, 'queued');
  update public.whatsapp_conversations
     set last_outbound_at = now(),
         last_message_at = greatest(coalesce(last_message_at, '-infinity'::timestamptz), now()),
         last_message_preview = left(v_body, 120)
   where id = v_conv.id;
  return jsonb_build_object('message_id', v_msg.id, 'status', 'queued', 'idempotent', false);
end;
$$;
revoke execute on function public.whatsapp_template_message_enqueue(uuid, uuid, jsonb) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4) Contexto do envio do template (service_role): revalida e faz o CLAIM
-- ---------------------------------------------------------------------------
create function public.whatsapp_get_template_send_context(p_message_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_msg public.whatsapp_messages;
  v_tm public.whatsapp_template_messages;
  v_conn public.company_whatsapp_connections;
  v_conv public.whatsapp_conversations;
  v_tpl public.whatsapp_message_templates;
  v_recipient text;
  v_matches integer;
  v_eff text;
  v_params jsonb;
  v_token text;
  v_claimed uuid;
begin
  select * into v_msg from public.whatsapp_messages where id = p_message_id and direction = 'outbound';
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  select * into v_tm from public.whatsapp_template_messages where message_id = v_msg.id;
  if not found or v_msg.type <> 'template' then
    return jsonb_build_object('ok', false, 'error', 'not_template');
  end if;
  if v_msg.status <> 'queued' then
    return jsonb_build_object('ok', false, 'error', 'not_queued', 'status', v_msg.status);
  end if;
  if v_msg.error_code is not null then
    return jsonb_build_object('ok', false, 'error', 'send_unconfirmed');          -- resultado ambíguo anterior: nunca reenvia sozinho
  end if;
  if v_tm.claimed_at is not null then
    return jsonb_build_object('ok', false, 'error', 'already_claimed');
  end if;
  select * into v_conv from public.whatsapp_conversations where id = v_msg.conversation_id and company_id = v_msg.company_id and deleted_at is null;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'conversation_unavailable');
  end if;
  if not public.company_has_module(v_msg.company_id, 'whatsapp') then
    return jsonb_build_object('ok', false, 'error', 'module_inactive');
  end if;
  select * into v_conn from public.company_whatsapp_connections where id = v_msg.connection_id and company_id = v_msg.company_id;
  if not found or v_conn.status <> 'active' or v_conn.phone_number_id is null then
    return jsonb_build_object('ok', false, 'error', 'connection_inactive');
  end if;

  -- destinatário (mesma regra do envio de texto): live = telefone da conversa; test = só o autorizado (equivalência do nono dígito), falha fechada
  v_recipient := v_conv.contact_phone;
  if v_conn.mode = 'test' then
    select count(distinct r.phone_e164), min(r.phone_e164) into v_matches, v_recipient
      from public.whatsapp_test_recipients r
     where r.connection_id = v_conn.id and r.company_id = v_conn.company_id and r.is_active
       and public.whatsapp_br_phone_equivalent(r.phone_e164, v_conv.contact_phone);
    if v_matches <> 1 then
      return jsonb_build_object('ok', false, 'error', 'test_recipient_blocked');
    end if;
  end if;

  -- saúde do token: só expired/revoked bloqueiam (sem sondagem automática para template)
  v_eff := public.whatsapp_token_effective_status(v_conn);
  if v_eff in ('expired', 'revoked') then
    return jsonb_build_object('ok', false, 'error', case when v_eff = 'expired' then 'token_expired' else 'token_revoked' end);
  end if;

  -- template: revalida no momento do envio (status, elegibilidade, nome/idioma e variáveis)
  select * into v_tpl from public.whatsapp_message_templates
   where id = v_tm.template_id and company_id = v_msg.company_id and connection_id = v_msg.connection_id;
  if not found or v_tpl.status <> 'APPROVED' or public.whatsapp_template_ineligible_reason(v_tpl.components) is not null then
    return jsonb_build_object('ok', false, 'error', 'template_unavailable');
  end if;
  if v_tpl.name <> v_tm.template_name or v_tpl.language <> v_tm.template_language then
    return jsonb_build_object('ok', false, 'error', 'template_changed');
  end if;
  begin
    v_params := public.whatsapp_template_params_normalize(v_tm.body_parameters, v_tpl.body_variable_count);
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'template_params_invalid');
  end;

  -- opt-out ATUAL (inclusive o que surgiu depois da reserva): falha na verificação BLOQUEIA preventivamente
  begin
    if public.whatsapp_optout_is_blocked(v_msg.company_id, public.whatsapp_contact_key(v_conv.contact_phone, false)) then
      return jsonb_build_object('ok', false, 'error', 'opted_out');
    end if;
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'optout_check_failed');
  end;

  if v_conn.token_secret_id is null then
    return jsonb_build_object('ok', false, 'error', 'token_unavailable');
  end if;
  select decrypted_secret into v_token from vault.decrypted_secrets where id = v_conn.token_secret_id;
  if v_token is null or v_token = '' then
    return jsonb_build_object('ok', false, 'error', 'token_unavailable');
  end if;

  -- CLAIM atômico: só uma chamada segue para a Meta
  update public.whatsapp_template_messages set claimed_at = now() where message_id = v_msg.id and claimed_at is null returning message_id into v_claimed;
  if v_claimed is null then
    return jsonb_build_object('ok', false, 'error', 'already_claimed');
  end if;

  return jsonb_build_object(
    'ok', true,
    'message_id', v_msg.id,
    'conversation_id', v_conv.id,
    'request_id', v_tm.start_request_id,
    'connection_id', v_conn.id,
    'phone_number_id', v_conn.phone_number_id,
    'recipient_phone', v_recipient,
    'template_name', v_tpl.name,
    'template_language', v_tpl.language,
    'parameters', v_params,
    'access_token', v_token);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Resultado do envio (service_role)
-- ---------------------------------------------------------------------------
create function public.whatsapp_template_message_finish(p_message_id uuid, p_outcome text, p_provider_message_id text default null, p_error_code text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_msg public.whatsapp_messages;
  v_tm public.whatsapp_template_messages;
  v_code text := left(nullif(btrim(coalesce(p_error_code, '')), ''), 64);
begin
  if p_outcome is null or p_outcome not in ('sent', 'failed', 'uncertain') then
    raise exception 'Resultado inválido.' using errcode = 'PT400';
  end if;
  select * into v_msg from public.whatsapp_messages where id = p_message_id and direction = 'outbound' for update;
  select * into v_tm from public.whatsapp_template_messages where message_id = p_message_id;
  if v_msg.id is null or v_tm.message_id is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_msg.status <> 'queued' then
    return jsonb_build_object('result', 'ignored', 'status', v_msg.status);            -- já encerrada: idempotente
  end if;

  if p_outcome = 'sent' then
    if nullif(btrim(coalesce(p_provider_message_id, '')), '') is null then
      raise exception 'Identificador da Meta ausente.' using errcode = 'PT400';
    end if;
    perform public.whatsapp_mark_message_sent(v_msg.id, p_provider_message_id);
    if v_tm.start_request_id is not null then
      perform public.whatsapp_start_request_finish(v_tm.start_request_id, 'sent', v_msg.conversation_id, v_msg.id, null);
    end if;
    return jsonb_build_object('result', 'sent');
  elsif p_outcome = 'failed' then
    perform public.whatsapp_mark_message_failed(v_msg.id, coalesce(v_code, 'send_failed'));
    if v_tm.start_request_id is not null then
      perform public.whatsapp_start_request_finish(v_tm.start_request_id, 'failed', v_msg.conversation_id, v_msg.id, coalesce(v_code, 'send_failed'));
    end if;
    -- a Meta informou que o usuário não quer receber (131050): registra o opt-out (só leitura de erro; nunca derruba o resultado)
    if public.whatsapp_optout_is_meta_error(v_code) then
      begin
        perform public.whatsapp_optout_from_meta_error(v_msg.id, v_code);
      exception when others then
        raise warning 'whatsapp_template_message_finish: opt-out da Meta não registrado: %', sqlstate;
      end;
    end if;
    return jsonb_build_object('result', 'failed');
  end if;

  -- 'uncertain': a Meta pode ter aceitado. A mensagem e o pedido continuam 'queued' (o pedido segue contando no limite e no intervalo); o claim já foi usado,
  -- então NADA reenvia sozinho. Só marca o motivo na mensagem.
  update public.whatsapp_messages set error_code = left('unconfirmed_' || coalesce(v_code, 'unknown'), 64) where id = v_msg.id;
  return jsonb_build_object('result', 'uncertain');
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) ACL
-- ---------------------------------------------------------------------------
revoke execute on function public.whatsapp_get_template_send_context(uuid) from public, anon, authenticated;
revoke execute on function public.whatsapp_template_message_finish(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.whatsapp_get_template_send_context(uuid) to service_role;
grant execute on function public.whatsapp_template_message_finish(uuid, text, text, text) to service_role;

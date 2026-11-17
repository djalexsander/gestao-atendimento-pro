-- Rollback da migration 20261203020000 (opt-out, Etapa 7.11D parte 2). Remove SOMENTE o que ela criou, sem CASCADE: o gatilho em whatsapp_messages, as funções
-- novas, as 2 tabelas, e RESTAURA a whatsapp_start_request_reserve exatamente como estava na 7.11B (sem a consulta de opt-out).
-- ATENÇÃO: apaga os dados de opt-out (estado e trilha). Se já houver contatos bloqueados, exporte whatsapp_contact_optouts e whatsapp_optout_events ANTES:
-- sem esta migration quem pediu para sair voltaria a poder ser procurado. O recebimento de mensagens não depende destas funções (o gatilho nunca falhava o recebimento).
-- Para poder reaplicar a migration depois:
--   node node_modules/supabase/dist/supabase.js migration repair --status reverted 20261203020000 --linked
begin;
drop trigger if exists whatsapp_messages_optout_detect on public.whatsapp_messages;
create or replace function public.whatsapp_start_request_reserve(
  p_company_id uuid,
  p_connection_id uuid,
  p_client_request_id uuid,
  p_contact_kind text,
  p_contact_ref uuid,
  p_contact_key text,
  p_template_id uuid,
  p_consent_confirmed boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_s public.company_whatsapp_start_settings;
  v_t public.whatsapp_message_templates;
  v_conn public.company_whatsapp_connections;
  v_req public.whatsapp_start_requests;
  v_hash text;
  v_limit integer;
  v_interval integer;
begin
  perform public.whatsapp_start_assert_starter(p_company_id);
  if p_client_request_id is null or p_contact_ref is null or nullif(btrim(coalesce(p_contact_key, '')), '') is null
     or p_contact_kind is null or p_contact_kind not in ('manual', 'customer') or p_template_id is null then
    raise exception 'Pedido de início de conversa inválido.' using errcode = 'PT400';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('wa_start:' || p_company_id::text, 0));

  -- repetição do MESMO pedido (duplo clique/retry): devolve o mesmo registro, sem criar outro e sem consumir vaga
  select * into v_req from public.whatsapp_start_requests where company_id = p_company_id and client_request_id = p_client_request_id;
  if found then
    return jsonb_build_object('request_id', v_req.id, 'status', v_req.status, 'idempotent', true,
                              'conversation_id', v_req.conversation_id, 'message_id', v_req.message_id);
  end if;

  if p_consent_confirmed is distinct from true then
    raise exception 'Confirme que o contato autorizou receber mensagens da empresa.' using errcode = 'PT400';
  end if;

  select * into v_s from public.company_whatsapp_start_settings where company_id = p_company_id;
  if not found or not v_s.enabled then
    raise exception 'Iniciar conversas está desativado para esta empresa.' using errcode = 'PT409';
  end if;
  v_limit := v_s.daily_limit;
  v_interval := v_s.min_interval_hours;

  select * into v_conn from public.company_whatsapp_connections where id = p_connection_id and company_id = p_company_id;
  if not found or v_conn.status <> 'active' then
    raise exception 'O WhatsApp desta empresa não está conectado.' using errcode = 'PT409';
  end if;

  select * into v_t from public.whatsapp_message_templates where id = p_template_id and company_id = p_company_id and connection_id = p_connection_id;
  if not found then
    raise exception 'Template não encontrado.' using errcode = 'PT404';
  end if;
  if v_t.status <> 'APPROVED' then
    raise exception 'Este template não está aprovado pela Meta.' using errcode = 'PT409';
  end if;

  if public.whatsapp_start_used_today(p_company_id) >= v_limit then
    raise exception 'Limite diário de % iniciações de conversa atingido. Tente amanhã.', v_limit using errcode = 'PT409';
  end if;

  v_hash := public.whatsapp_start_contact_hash(p_company_id, p_contact_key);
  if v_interval > 0 and exists (
    select 1 from public.whatsapp_start_requests r
     where r.company_id = p_company_id and r.contact_key_hash = v_hash and r.status in ('queued', 'sent')
       and r.created_at > now() - make_interval(hours => v_interval)
  ) then
    raise exception 'Este contato já recebeu uma iniciação de conversa nas últimas % horas.', v_interval using errcode = 'PT409';
  end if;

  insert into public.whatsapp_start_requests (company_id, connection_id, requested_by, client_request_id, contact_kind, contact_ref, contact_key_hash,
                                              template_id, template_name, template_language, consent_source, consent_confirmed_at)
  values (p_company_id, p_connection_id, auth.uid(), p_client_request_id, p_contact_kind, p_contact_ref, v_hash,
          v_t.id, v_t.name, v_t.language, 'operator_attestation', now())
  returning * into v_req;

  return jsonb_build_object('request_id', v_req.id, 'status', v_req.status, 'idempotent', false, 'conversation_id', null, 'message_id', null);
end;
$$;
drop function if exists public.whatsapp_reactivate_contact_optout(uuid, text, uuid, text, text, boolean);
drop function if exists public.whatsapp_set_contact_optout(uuid, text, uuid);
drop function if exists public.whatsapp_get_contact_optout(uuid, text, uuid);
drop function if exists public.whatsapp_optout_contact_key(uuid, text, uuid);
drop function if exists public.whatsapp_optout_from_meta_error(uuid, text);
drop function if exists public.whatsapp_optout_is_meta_error(text);
drop function if exists public.whatsapp_optout_detect_inbound();
drop function if exists public.whatsapp_optout_resume_from_contact(uuid, text, uuid, timestamptz);
drop function if exists public.whatsapp_optout_register(uuid, text, text, uuid, uuid, timestamptz);
drop function if exists public.whatsapp_optout_is_blocked(uuid, text);
drop function if exists public.whatsapp_optout_is_resume_message(text);
drop function if exists public.whatsapp_optout_is_stop_message(text);
drop function if exists public.whatsapp_optout_normalize_text(text);
drop table if exists public.whatsapp_optout_events;
drop function if exists public.guard_whatsapp_optout_event();
drop table if exists public.whatsapp_contact_optouts;
commit;

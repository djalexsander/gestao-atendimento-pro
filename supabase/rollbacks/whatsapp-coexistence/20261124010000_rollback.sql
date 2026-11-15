-- Rollback da migration 20261124010000 (Coexistence, Etapa 3). Reverte schema/funções; NÃO apaga mensagens de eco já gravadas além
-- do necessário para remover a coluna sent_via (as linhas de eco, sent_via='business_app', são REMOVIDAS antes: eram só espelho do app).
-- Rode somente se o webhook novo NÃO estiver mais implantado (ele chamaria funções removidas).
begin;
drop function if exists public.whatsapp_ingest_echo(text, text, text, text, text, timestamptz, text);
drop function if exists public.whatsapp_coexistence_record(text, text, text, text, jsonb);
drop function if exists public.whatsapp_coexistence_account_update(text, text, text, text, bigint);
drop trigger if exists company_whatsapp_connections_lifecycle_reset on public.company_whatsapp_connections;
drop function if exists public.whatsapp_connection_lifecycle_reset();
-- restaura whatsapp_mark_message_sent da migration 20261015040000
create or replace function public.whatsapp_mark_message_sent(p_message_id uuid, p_provider_message_id text, p_provider_timestamp timestamptz default null)
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
-- mensagens de eco (espelho do app) saem junto com a coluna
delete from public.whatsapp_messages where sent_via = 'business_app';
alter table public.whatsapp_messages drop constraint if exists whatsapp_messages_sent_via_shape;
alter table public.whatsapp_messages drop column if exists sent_via;
alter table public.company_whatsapp_connections
  drop column if exists lifecycle_reason, drop column if exists lifecycle_event_at, drop column if exists lifecycle_changed_at, drop column if exists lifecycle_state;
drop table if exists public.whatsapp_coexistence_events;
delete from public.whatsapp_webhook_events where event_type = 'echo';
alter table public.whatsapp_webhook_events drop constraint if exists whatsapp_webhook_events_type_check;
alter table public.whatsapp_webhook_events add constraint whatsapp_webhook_events_type_check check (event_type in ('message', 'status'));
commit;

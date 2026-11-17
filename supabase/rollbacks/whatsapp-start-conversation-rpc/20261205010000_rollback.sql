-- Rollback da Etapa 7.11F (iniciar conversa). Remove só o que a migration 20261205010000 criou. Conversas, mensagens e pedidos já gravados permanecem
-- (as 5 colunas novas de whatsapp_start_requests, com a origem/referência do consentimento e a resolução manual, são removidas junto).
begin;
drop function if exists public.whatsapp_start_request_resolve(uuid, text, boolean);
drop function if exists public.whatsapp_list_start_requests(uuid, boolean, integer);
drop function if exists public.whatsapp_start_conversation(uuid, uuid, text, uuid, uuid, jsonb, boolean, text, text);
drop function if exists public.whatsapp_start_request_result(uuid, boolean, boolean);
drop function if exists public.whatsapp_start_request_state(text, text, timestamptz);
alter table public.whatsapp_start_requests
  drop column if exists resolution,
  drop column if exists resolved_at,
  drop column if exists resolved_by,
  drop column if exists consent_ref,
  drop column if exists consent_origin;
commit;

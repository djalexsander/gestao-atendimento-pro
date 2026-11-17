-- Rollback da Etapa 7.11E (despacho de templates). Remove só o que a migration 20261204010000 criou. Mensagens 'template' já gravadas em whatsapp_messages
begin;
-- permanecem (a tabela de metadados é removida; o histórico da caixa de entrada não muda).
drop function if exists public.whatsapp_template_message_finish(uuid, text, text, text);
drop function if exists public.whatsapp_get_template_send_context(uuid);
drop function if exists public.whatsapp_template_message_enqueue(uuid, uuid, jsonb);
drop function if exists public.whatsapp_template_render_body(jsonb, jsonb);
drop function if exists public.whatsapp_template_params_normalize(jsonb, integer);
drop table if exists public.whatsapp_template_messages;
drop function if exists public.guard_whatsapp_template_message();
commit;

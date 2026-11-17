-- Rollback da migration 20261201010000 (fundamentos para iniciar conversas, Etapa 7.11B). Remove SOMENTE o que ela criou, sem CASCADE:
-- 8 funções (assinaturas explícitas) e as 3 tabelas, na ordem inversa das dependências (pedidos -> templates -> configurações).
-- ATENÇÃO: apaga os dados dessas tabelas (cache de templates, configurações e a TRILHA dos pedidos de início). Se a funcionalidade já tiver sido usada,
-- exporte whatsapp_start_requests antes. Triggers e políticas saem junto com as tabelas. Nada existente é tocado.
-- Para poder reaplicar a migration depois:
--   node node_modules/supabase/dist/supabase.js migration repair --status reverted 20261201010000 --linked
begin;
drop function if exists public.whatsapp_set_start_settings(uuid, boolean, integer, integer);
drop function if exists public.whatsapp_get_start_settings(uuid);
drop function if exists public.whatsapp_start_request_finish(uuid, text, uuid, uuid, text);
drop function if exists public.whatsapp_start_request_reserve(uuid, uuid, uuid, text, uuid, text, uuid, boolean);
drop function if exists public.whatsapp_start_used_today(uuid);
drop function if exists public.whatsapp_start_assert_starter(uuid);
drop function if exists public.whatsapp_start_contact_hash(uuid, text);
drop table if exists public.whatsapp_start_requests;
drop function if exists public.guard_whatsapp_start_request();
drop table if exists public.whatsapp_message_templates;
drop table if exists public.company_whatsapp_start_settings;
commit;

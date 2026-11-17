-- Rollback da migration 20261202010000 (sincronização de templates, Etapa 7.11C). Remove SOMENTE o que ela criou, sem CASCADE:
-- 6 funções, a tabela de estado da sincronização e a coluna sync_run_id. O CACHE de templates (whatsapp_message_templates, da 7.11B) e seus dados ficam.
-- Reverta antes/junto a Edge whatsapp-templates-sync (sem estas funções ela só devolve erro). Para poder reaplicar:
--   node node_modules/supabase/dist/supabase.js migration repair --status reverted 20261202010000 --linked
begin;
drop function if exists public.whatsapp_list_start_templates(uuid);
drop function if exists public.whatsapp_templates_sync_finish(uuid, uuid, boolean, boolean, text);
drop function if exists public.whatsapp_templates_sync_apply(uuid, uuid, jsonb);
drop function if exists public.whatsapp_templates_sync_context(uuid, uuid);
drop function if exists public.whatsapp_templates_sync_request(uuid);
drop function if exists public.whatsapp_template_ineligible_reason(jsonb);
drop table if exists public.whatsapp_template_sync_state;
alter table public.whatsapp_message_templates drop column if exists sync_run_id;
commit;

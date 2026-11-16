-- Rollback da migration 20261127010000 (contatos manuais do WhatsApp, Etapa 7.10B). Remove SOMENTE os objetos novos, sem CASCADE.
-- ATENÇÃO: apaga os contatos manuais e a trilha de auditoria que já existirem. Antes de reverter uma base com dados, exporte as duas tabelas:
--   \copy public.whatsapp_contacts to 'contatos.csv' csv header
--   \copy public.whatsapp_contact_events to 'eventos.csv' csv header
-- Ordem: se as RPCs (7.10C) ou a busca nova (7.10D) já estiverem aplicadas, reverta-as ANTES (elas dependem destas tabelas).
-- Depois, para poder reaplicar: node node_modules/supabase/dist/supabase.js migration repair --status reverted 20261127010000 --linked
begin;
drop table if exists public.whatsapp_contact_events;
drop table if exists public.whatsapp_contacts;
drop function if exists public.guard_whatsapp_contact_event();
drop function if exists public.guard_whatsapp_contact_change();
drop function if exists public.whatsapp_contact_normalize_phone(text);
commit;

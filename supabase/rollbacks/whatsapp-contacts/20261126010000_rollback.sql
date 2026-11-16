-- Rollback da migration 20261126010000 (Contatos do WhatsApp, Etapa 7.2: camada de leitura). Remove SOMENTE as 5 funções novas, sem CASCADE.
-- A migration não criou tabelas, colunas, índices, triggers nem políticas e não alterou dados: não há nada a restaurar.
-- Validado em PGlite (aplicar -> este rollback -> reaplicar): -5 funções, nada mais muda, a reaplicação volta ao mesmo estado.
-- Para poder reaplicar a migration depois, marque a versão como revertida:
--   node node_modules/supabase/dist/supabase.js migration repair --status reverted 20261126010000 --linked
begin;
drop function if exists public.search_whatsapp_contacts(uuid, text, integer, text, text);
drop function if exists public.list_whatsapp_contacts(uuid, integer, text, text);
drop function if exists public.whatsapp_contacts_query(uuid, text, integer, text, text);
drop function if exists public.whatsapp_contact_key(text, boolean);
drop function if exists public.whatsapp_contact_fold(text);
commit;

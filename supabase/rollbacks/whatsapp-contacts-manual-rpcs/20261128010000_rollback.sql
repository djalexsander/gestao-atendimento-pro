-- Rollback da migration 20261128010000 (RPCs dos contatos manuais, Etapa 7.10C). Remove SOMENTE as 9 funções novas, sem CASCADE.
-- NÃO apaga dados: as tabelas whatsapp_contacts e whatsapp_contact_events (migration 20261127010000) continuam intactas, e os contatos
-- cadastrados permanecem. Sem as RPCs ninguém consegue criar ou editar contatos (não há escrita direta nas tabelas).
-- Se a busca nova (7.10D) já estiver aplicada, reverta-a ANTES (ela lê estas tabelas, não estas funções, mas a ordem inversa é a mais segura).
-- Depois, para poder reaplicar: node node_modules/supabase/dist/supabase.js migration repair --status reverted 20261128010000 --linked
begin;
drop function if exists public.set_whatsapp_contact_customer(uuid, uuid);
drop function if exists public.restore_whatsapp_contact(uuid);
drop function if exists public.archive_whatsapp_contact(uuid);
drop function if exists public.get_whatsapp_contact(uuid);
drop function if exists public.update_whatsapp_contact(uuid, text, text, text);
drop function if exists public.create_whatsapp_contact(uuid, text, text, text);
drop function if exists public.whatsapp_contact_json(public.whatsapp_contacts);
drop function if exists public.whatsapp_contacts_load(uuid, boolean);
drop function if exists public.whatsapp_contacts_assert_writer(uuid, boolean);
commit;

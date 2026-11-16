-- Rollback da migration 20261129020000 (listagem de contatos manuais arquivados, Etapa 7.10F.1). Remove SOMENTE a função nova, sem CASCADE.
-- Nenhum dado é tocado: contatos arquivados continuam gravados e restauráveis pela RPC restore_whatsapp_contact (só deixam de poder ser listados).
-- A interface 7.10F.1 (aba Arquivados) deve ser revertida antes/junto, senão a aba mostrará erro. Para poder reaplicar a migration:
--   node node_modules/supabase/dist/supabase.js migration repair --status reverted 20261129020000 --linked
begin;
drop function if exists public.list_archived_whatsapp_contacts(uuid, text, integer, text, text);
commit;

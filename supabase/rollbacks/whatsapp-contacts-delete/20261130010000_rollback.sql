-- Rollback da migration 20261130010000 (exclusão definitiva de contatos manuais, Etapa 7.10I). Remove SOMENTE a função nova, sem CASCADE.
-- Nenhum dado é tocado. Contatos já excluídos NÃO voltam (a exclusão é definitiva); os eventos 'deleted' continuam na trilha.
-- Reverta antes/junto a interface (o botão "Excluir definitivamente" passaria a dar erro). Para poder reaplicar:
--   node node_modules/supabase/dist/supabase.js migration repair --status reverted 20261130010000 --linked
begin;
drop function if exists public.delete_whatsapp_contact(uuid, text);
commit;

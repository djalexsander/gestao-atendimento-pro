-- Rollback de 20261110010000_whatsapp_token_sweep_history.sql: remove só a RPC de histórico (nenhuma tabela, coluna ou dado é tocado).
drop function if exists public.master_whatsapp_token_sweep_history(text, text, integer, integer);

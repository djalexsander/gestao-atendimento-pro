-- ORDEM DE USO (1115): Desfaça POR ÚLTIMO (depois de 1116). Fora de ordem o banco recusa: as tabelas de cortesia têm dependentes. Rode DENTRO de uma transação (begin; … commit;). Veja LEIAME.md desta pasta.
-- Rollback manual da migration 20261115010000 (cortesias comerciais, Etapa 1). A migration é ADITIVA: só cria objetos novos, então
-- o rollback só remove esses objetos. Nenhuma tabela/dado existente (assinaturas, faturas, trials, overrides, catálogo) foi alterado.
-- ATENÇÃO: apaga o histórico de cortesias e seus eventos (rodar só se a migration não estiver em uso).
drop function if exists public.master_grant_courtesy(uuid, text, text, text, uuid, integer, date, uuid);
drop function if exists public.master_extend_courtesy(uuid, text, integer, date, uuid);
drop function if exists public.master_end_courtesy(uuid, text, uuid);
drop function if exists public.master_request_courtesy_conversion(uuid, text, uuid);
drop function if exists public.master_get_courtesy(uuid);
drop function if exists public.master_list_company_courtesies(uuid, boolean);
drop function if exists public.master_get_courtesy_alerts(integer);
drop function if exists public.master_reconcile_courtesies();
drop function if exists public.courtesy_json(public.company_courtesies);
drop table if exists public.company_courtesy_events;
drop table if exists public.company_courtesies;
drop function if exists public.courtesy_expire_if_due(uuid);
drop function if exists public.courtesy_record_event(uuid, text, jsonb, uuid);
drop function if exists public.courtesy_resolve_end(integer, date, timestamptz);
drop function if exists public.courtesy_check_reason(text);
drop function if exists public.courtesy_effective_state(text, timestamptz);
drop function if exists public.guard_company_courtesy_change();
drop function if exists public.prevent_company_courtesy_event_change();

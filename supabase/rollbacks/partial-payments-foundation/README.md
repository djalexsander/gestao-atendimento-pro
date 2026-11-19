# Rollback seguro — pagamentos parciais, E1 (fundação de esquema)

Migration: `supabase/migrations/20261213010000_partial_payments_foundation.sql`.
Reversão: `rollback.sql` (esta pasta).

## O que a migration cria (nada é alterado nem apagado)
- Colunas: `service_payments.client_request_id`, `service_refunds.client_request_id`, `service_refunds.restores_balance` (default `false`).
- Tabelas: `service_session_splits`, `service_session_parts`, `service_session_part_items`, `service_payment_allocations`, `service_refund_allocations`, `service_session_events`.
- Gatilhos de integridade (`partial_payments_*`) e RLS só de leitura.
- **Nenhuma RPC alterada ou criada.** Sem backfill e sem UPDATE em dado existente.

## Quando o rollback é seguro
Enquanto as RPCs do recurso (E3 em diante) ainda não gravaram nada: as tabelas novas estão vazias, nenhum pagamento/estorno tem
`client_request_id` e nenhum estorno tem `restores_balance = true`. Nesse estado o `rollback.sql` devolve o banco exatamente ao
estado anterior à migration.

## Quando ele se recusa
Se houver **qualquer** registro nas tabelas novas, pagamento/estorno com `client_request_id`, ou estorno com `restores_balance`, o
script levanta exceção e **não remove nada** (transação única). Apagar esses dados destruiria registro financeiro real. Antes de
reverter nesse caso é preciso decidir o destino deles (exportar; estornar/ajustar à parte; ou migrar para frente em vez de voltar).

## Como executar (somente com autorização, sempre após `db push --dry-run`)
1. Conferir que as RPCs das etapas seguintes **não** estão aplicadas (se estiverem, reverta-as antes: elas dependem destas tabelas).
2. `supabase db query --linked -f supabase/rollbacks/partial-payments-foundation/rollback.sql`
3. Remover a linha da migration do histórico de migrations somente se o projeto adotar essa prática (as migrations aplicadas são imutáveis: o caminho normal é uma migration "para frente").

## Teste do rollback
`.claude/db-tests/partial-payments-schema.mjs` aplica a migration em um banco descartável, roda o rollback com o banco vazio (volta
ao estado anterior, RPCs antigas intactas) e prova a recusa quando já há dado novo.

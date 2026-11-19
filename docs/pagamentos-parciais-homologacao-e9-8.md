# Homologação final E9.8 — pagamentos parciais (v1.0.20) — resultado local

Data: 2026-11-19. Tudo local; nada no remoto, sem push/tag/deploy; módulo não habilitado para nenhuma empresa.

## Regressão completa única (`run-all`, 183 suítes, 57 min)
10.312 checagens OK; 28 falhas (15 de checagens + 13 suítes "abortadas"); ACL `acl2` = AUDITORIA OK. Concorrência `partial-payments-register-race`: **C1–C53 = 53/53 PASS, 67 PASS, 0 FAIL, 0 deadlocks** (1.047 s). `order-engine-lock-order` 24/24 (prova determinística + sondas), `order-engine-rollback` 12/12, `order-engine-actor` 128/128, `order-race-smoke` 205/205.

### Classificação das falhas (nenhuma é falha real de pagamentos parciais)
| Grupo | Itens | Classe | Evidência |
|---|---|---|---|
| Preexistentes, idênticas nas migrations do `origin/main` | `upgrade` (1), `whatsapp-knowledge-lookup` (1), `whatsapp-knowledge-profile` (3), `whatsapp-signup-foundation` (2), `audit-remote-after` (1), `audit-remote-drift` (4) | teste obsoleto / dependente do snapshot do remoto (sem relação com pagamentos) | reexecutadas com `MIG_DIR` = migrations do `origin/main`: mesmas falhas |
| Testes obsoletos por causa de E1/E9.1 | `master` 1 e `delivery-activation` 1.3 (catálogo "exatamente 4 módulos": agora existe o módulo `partial_payments`, **inativo, preço 0**), `partial-payments-schema` 1 ("nenhuma RPC nova exposta nesta etapa" — era a regra só da E1) | teste obsoleto | em `origin/main` passam; a falha é a expectativa antiga |
| Infraestrutura | 13 "suítes abortadas": 11 scripts de mutação listados como suíte (`mutate-*`, resultado em outro formato; os de pagamentos parciais: read-model 35/35 mortos, write-gate 18 mortos), `whatsapp-echo-race-real` (formato `INFO`), `order-engine-upgrade` (harness legado sem a tabela `whatsapp_order_draft_events`; também falha no `origin/main`) | infra / formato | logs por suíte |
| Manutenção de teste (baixa) | `mutate-partial-payments-write-gate`: 1 mutante inválido ("register: perde a idempotência", trecho não único) | ajustar âncora | não é falha do produto |

## Front (alvos, sem repetir bateria completa)
Lógica/estático: 42, 24, 35, 21, 35, 14, 44, 25, 48 (visão financeira), 31 (dashboard), 82 (Balcão). Contratos com banco real: 41, 36, 33, 23, 40. `tsc` e build OK.

## Integridade financeira (conferido)
Idempotência (`client_request_id`), pagamento parcial, troco (não abate saldo), divisão, estorno (correção) e encerramento: suítes de banco e contratos do front. Relatórios: módulo desligado devolve o JSON legado idêntico; ligado separa contas abertas, correções e devoluções; líquido = soma dos líquidos por forma; sem dupla contagem. Isolamento por empresa e papéis: contratos (owner/admin/cashier/attendant/production/courier). Tradicional com módulo desligado: escritas recusadas pelo banco e telas/indicadores legados.

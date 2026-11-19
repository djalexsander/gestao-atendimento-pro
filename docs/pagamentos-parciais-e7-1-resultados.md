# E7.1 — Resultados (implementada localmente; nada aplicado ao remoto)

**Mudança:** `submit_service_order_engine` lê a conta com `FOR SHARE` antes de travar os produtos (ordem única: conta → item → produto).
Migration `supabase/migrations/20261214010000_order_engine_session_lock.sql`; rollback `supabase/rollbacks/order-engine-session-lock/rollback.sql`.
Diff do corpo: some 1 linha (leitura sem trava); entram `for share` e 3 linhas de comentário. Só essa função muda no catálogo (md5 de todas as demais idêntico); ACL/SECURITY DEFINER/search_path idênticos.

## Resultados
| Item | Resultado |
|---|---|
| Sonda 120 rodadas (3×) | 480/480 ok, 0 deadlocks nas 3 (antes: 293 e 306 deadlocks em 480) |
| Sonda 500 rodadas | 2000/2000 ok, 0 deadlocks |
| Prova determinística (`order-engine-lock-order.mjs` P1–P4) | 4/4: pedido esperando a conta não segura o produto; pedido e cancelamento esperam na mesma ordem; pedidos na mesma conta não se serializam |
| `stock-lock-order-proof.mjs` | 4/4 (agora fixada no estado anterior à E7.1, documenta a causa raiz) |
| 11 corridas novas N1–N11 (25 rodadas) | 0 violações, 0 deadlocks; no banco SEM a E7.1 a mesma suíte falha com `40P01` (N2, N4, N6, N8, N9, N10) |
| Estoque (E1–E5) | saldo = 100000 + movimentos; saldo = entradas − (vendido − cancelado); nunca negativo; 2 pedidos pelo último saldo: exatamente 1 passa (25 rodadas) |
| C1–C44 (25 rodadas) | 55 ok / 0 falhas |
| Rollback (`order-engine-rollback.mjs`) | 12/12: catálogo inteiro de funções idêntico ao pré-E7.1, ACL idêntica, idempotente, migration reaplicável |
| Mutantes | 18: 17 mortos; 1 equivalente (rollback sem `revoke`: `create or replace` preserva a ACL, teste 7 confirma) |
| `run-all` | 23 falhas e 11 suítes abortadas, as mesmas da linha de base (confirmadas também sem a E7.1); `acl2` AUDITORIA OK |

Ajustes de testes anteriores (estado pré-E7.1, sem mudar regras): `partial-payments-cancel.mjs` (boot sem a E7.1, pois compara md5 das funções da E7), `stock-lock-order-proof.mjs`.

## Riscos residuais
- Um `FOR UPDATE` pendente (pagamento, cancelamento, fechamento) passa a segurar pedidos novos da mesma conta por milissegundos (espera, não ciclo).
- A confirmação WhatsApp usa o mesmo motor sobre sessão recém-criada; coberta pelas corridas N8 (mesmo caminho `create_delivery_order_engine`) e pelas suítes e2e do WhatsApp na regressão; não foi exercitada `whatsapp_order_confirm` em corrida real.
- Outros ciclos fora desta família (impressão, caixa) não foram alterados.

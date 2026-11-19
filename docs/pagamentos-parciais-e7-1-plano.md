# E7.1 — Plano: deadlock preexistente entre pedido novo e cancelamento (estoque controlado × conta)

**Status: PLANEJAMENTO. Nada implementado.** Só depende de nova autorização. Não toca a E8, o remoto ou o PDV de produção.

## 1. Causa raiz (demonstrada)
Prova determinística em PostgreSQL 17 real: `.claude/db-tests/stock-lock-order-proof.mjs` (4 checks) e sonda estatística `stock-deadlock-probe.mjs`.
- **Pedido novo** (`submit_service_order_engine`, última versão em `20261021030000_order_engine_actor.sql`): lê a conta **sem trava**, trava os produtos de estoque controlado (`FOR UPDATE`, em ordem de id) e só depois insere o pedido, quando o gatilho `service_orders_session_open` pega a conta (`FOR SHARE`). Ordem efetiva: **produto → conta**. Sondagem NOWAIT: esperando a conta, ele já segura o produto.
- **Cancelamento de item** (`cancel_service_order_item`, `20261001010000_printing_foundation.sql`): trava a conta (`FOR UPDATE of ss`), depois o item e depois o produto (`FOR UPDATE`). Ordem: **conta → produto**. Sondagem: esperando o produto, já segura a conta.
- Ordens opostas sobre a mesma conta e o mesmo produto formam o ciclo. Duas transações explícitas reproduzem o `40P01` de forma determinística (check 2); com a conta travada antes do produto nas duas, não há erro (check 3).
- Sonda (120 rodadas × 4 operações simultâneas na mesma conta, produto com estoque controlado): **293 deadlocks em 480 operações no banco atual e 306 no banco sem a E7**. É anterior à E7 e a E7 não o agrava (o gatilho do cancelamento só lê).
- Alcance: só **a mesma conta** disputando o **mesmo produto controlado**. Contas diferentes não formam ciclo (cada uma trava a sua conta). Produtos sem controle de estoque não são travados.

## 2. Auditoria da ordem de travas (todas as operações envolvidas)
| Operação | Ordem atual (a → b) |
|---|---|
| `submit_service_order` → `_core` → `_engine` (balcão, mesa, comanda) | produtos FU (por id) → conta FS (gatilho no INSERT) |
| `create_delivery_order_engine` (delivery/retirada; WhatsApp via `whatsapp_order_confirm`) | rascunho/produtos (FU/FS, por id) → **sessão nova criada na mesma transação** → engine (sem concorrência possível sobre a sessão nova) |
| `cancel_service_order_item` | conta FU → item FU → produto FU → impressão (print_devices FS, por id) |
| `cancel_delivery_order` (chama o cancelamento item a item) | conta FU → delivery_order FU → itens → produto FU |
| `register_service_payment`, `refund_open_session_payment`, `replace_session_split`, `close_service_session`, `receive_delivery_order` | conta FU → (pagamento FU) → caixa (FS/FU). **Não tocam produtos** |
| `close_cash_session` | caixa FU. Não toca conta nem produto |
| Entrada/ajuste de estoque (`product_stock_*`) e edição de produto | só o produto FU |
| `update_production_item_status` | só o item FU (sem conta) |
Nenhum outro caminho trava conta e produto em ordem inversa. O ciclo existe só entre o motor de pedidos e o cancelamento.

## 3. Proposta
Alinhar tudo a uma hierarquia única: **rascunho/pedido de origem → CONTA → delivery_order → item → PRODUTO (por id) → dispositivos de impressão (por id) → caixa**.
Mudança: em `submit_service_order_engine`, trocar a leitura sem trava da conta por leitura com `FOR SHARE`, **antes** do bloco que trava os produtos. O resto do corpo fica idêntico.
```sql
-- hoje:    select * into v_session from public.service_sessions where id = p_service_session_id;
-- proposto:select * into v_session from public.service_sessions where id = p_service_session_id for share;
```
### FOR SHARE × FOR UPDATE (× FOR KEY SHARE)
- **FOR SHARE (recomendado):** é o mesmo modo que o gatilho `service_orders_session_open` já toma depois, então não cria relação de bloqueio nova, só antecipa a existente; conflita com os `FOR UPDATE` de pagamento, estorno, divisão, cancelamento e fechamento (a leitura do status passa a ser a mais atual); **vários pedidos na mesma mesa/comanda continuam concorrentes** entre si (dois garçons lançando juntos).
- **FOR UPDATE (rejeitado):** serializaria os pedidos da mesma conta durante toda a trava de estoque e a impressão, sem ganho (o motor nunca altera a linha da conta, então não há upgrade de trava).
- **FOR KEY SHARE (alternativa a medir):** o mínimo suficiente (conflita só com `FOR UPDATE`); deixa passar `UPDATE` não-chave da conta. A diferença prática é pequena; avaliar nos testes e manter FOR SHARE salvo ganho medido.
- Fila de travas do PostgreSQL: um `FOR UPDATE` que espera passa na frente de novos `FOR SHARE` — pode gerar espera, mas **não ciclo**.

## 4. Mudanças necessárias (nenhum código nesta etapa)
| Item | Arquivo |
|---|---|
| Nova migration: `create or replace function public.submit_service_order_engine(...)` com o corpo da `20261213`… atual e a única linha acima mudada (gerada por script a partir do texto da migration vigente, como na E7-4) | `supabase/migrations/2026121401xxxx_order_engine_session_lock.sql` |
| Rollback: recria o corpo exato anterior (md5 idêntico) | `supabase/rollbacks/order-engine-session-lock/rollback.sql` |
| Testes e documentação | `.claude/db-tests/order-engine-lock-order.mjs`, extensão de `partial-payments-register-race.mjs`, `mutate-order-engine-session-lock.mjs`, `docs/` |
Nenhuma outra função muda: `submit_service_order` e `submit_service_order_core` são invólucros; `create_delivery_order_engine` chama o motor; o cancelamento já respeita a hierarquia. Assinatura, permissões e retorno do motor ficam iguais.

## 5. Impacto
- **Balcão, mesas, comandas:** o pedido passa a esperar pagamento/divisão/estorno/cancelamento/fechamento **no início**, em vez de segurar o estoque enquanto espera (melhora também a contenção de estoque entre contas).
- **Cancelamento e reposição de estoque:** código inalterado; deixa de ser vítima do ciclo.
- **Delivery e retirada:** criação usa sessão recém-criada na mesma transação (a trava não espera); cancelamento do delivery inalterado.
- **WhatsApp/IA:** `whatsapp_order_confirm` trava rascunho e produtos antes de criar a sessão nova; como ninguém mais enxerga essa sessão, não há espera nem ciclo.
- **Pagamentos parciais e divisões:** sem mudança de regra; só o momento da espera.
- **Fechamento de caixa:** não usa conta nem produto; sem impacto.
- **Operadores simultâneos:** pedidos concorrentes na mesma conta continuam paralelos (SHARE); um `FOR UPDATE` pendente (pagamento/cancelamento) aguarda os pedidos em curso (milissegundos).

## 6. Riscos de regressão
1. Motor compartilhado (balcão, delivery, WhatsApp): mudança de uma linha, mas em função crítica ⇒ regressão completa obrigatória.
2. Leitura do status agora ocorre sob trava (mais atual): comportamento só muda em condição de corrida (a favor de quem fecha primeiro).
3. Fila de travas: um cancelamento/pagamento pendente pode atrasar pedidos novos por instantes (já ocorria no INSERT; agora antes do estoque).
4. Chamadores que já seguram a conta `FOR UPDATE` na mesma transação: `FOR SHARE` na linha já travada pela própria transação não espera.
5. Outros ciclos fora desta família (impressão, caixa) permanecem como estão; a sonda e as corridas servirão de rede.

## 7. Plano de testes
1. **Sonda 120 rodadas** (hoje 293/480): repetir 3× + 1 execução de 500 rodadas ⇒ 0 deadlocks.
2. **Prova determinística** (`stock-lock-order-proof.mjs`) invertida: 1a passa a mostrar que o pedido esperando a conta **não** segura o produto; 2 deixa de ocorrer com o motor real.
3. **Corridas novas:** pedido × pedido na mesma mesa (ambos passam, sem esperar um pelo outro); pedido × pagamento; pedido × refazer divisão; pedido × estorno; pedido × fechamento antigo; 2 produtos controlados (ordem por id) × cancelamentos cruzados; cancelamento de delivery × pedido em outra mesa com o mesmo produto; confirmação WhatsApp × cancelamento em outra conta com o mesmo produto; entrada de estoque × pedido; troca de status de produção × cancelamento; pagamento × fechamento de caixa. Todas com 25 rodadas e verificação de saldo de estoque (vendido − devolvido = movimentos).
4. **Regressão completa:** `run-all` (linha de base: 23 falhas e 11 suítes abortadas, todas anteriores), `acl2`, suítes de pedido, delivery, WhatsApp, estoque e impressão; comparação de md5 de **todas** as funções exceto o motor; diff do motor = exatamente 1 linha.
5. **Mutantes:** trava removida; trava depois dos produtos; FOR UPDATE no lugar de FOR SHARE (deve falhar o teste de concorrência de pedidos); rollback incompleto.

## 8. Critérios objetivos de "deadlock corrigido"
- Sonda de 120 rodadas: **0** deadlocks em 3 repetições e em 1 de 500 rodadas (hoje 61–64% das operações).
- C1–C44 e as novas corridas: 0 violações e 0 deadlocks em 25 rodadas.
- Prova determinística: o pedido esperando a conta não segura o produto.
- Pedidos concorrentes na mesma conta não se serializam (nenhum espera o outro por trava).
- Corpo do motor diferente do atual por exatamente a linha proposta; todas as demais funções com md5 idêntico.
- `run-all` igual à linha de base e `acl2` OK; mutantes 100% mortos; estoque consistente em todas as corridas.

## 9. Rollback
Migration só troca o corpo de uma função; sem dados. Rollback: `create or replace` com o corpo anterior (texto gerado do arquivo vigente, sem passagem por `replace` de string para não corromper `$$`), verificado por md5 idêntico; seguro em qualquer momento, inclusive com pedidos em curso (aplica na próxima chamada). Segunda execução é idempotente. Teste de rollback faz parte da suíte.

## 10. Alternativas descartadas
- Cancelamento travar produto antes da conta: exige descobrir o produto antes de validar a conta e altera 2 funções (cancelamento e cancelamento de delivery).
- Repetir a operação em caso de `40P01` na aplicação: mascara o problema e mantém a contenção.
- Trocar a trava do produto por `UPDATE ... WHERE estoque >= n` atômico: redesenho do estoque, fora de escopo.

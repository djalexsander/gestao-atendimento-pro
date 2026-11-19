# Pagamentos parciais — E6: estorno de pagamento em conta ABERTA (auditoria + regras)

Escopo: só banco local isolado; nada aplicado ao remoto; PDV de produção intocado; sem E7.

## 1. Auditoria do que já existe
| Peça | Fato |
|---|---|
| `refund_service_payment` (legado) | owner/admin; **só conta FECHADA** (PT409 se aberta); motivo ≤200; caixa aberto do operador `FOR UPDATE` (PT412); disponível = pago − estornos; em dinheiro exige `cash_session_physical_cash` ≥ valor; grava `service_refunds` (restores_balance=false) + `cash_movements` `refund` na forma ORIGINAL. **Não foi alterada.** |
| `service_refunds` | append-only; `cash_session_id` = caixa que DEVOLVE; caixa original = `service_payments.cash_session_id`; E1 acrescentou `client_request_id` (único por empresa) e `restores_balance` (gatilho: aberta ⇒ true, fechada ⇒ false) |
| `cash_movements` | `refund` exige `service_refund_id` e `service_payment_id`; `service_refund_id` único; `cash_session_physical_cash` já subtrai estornos em dinheiro (migration 20260930070000) |
| E1 | `service_refund_allocations` (imutável): por parte ≤ o que aquele pagamento destinou a ela; soma ≤ valor do estorno (gatilho deferido) |
| E2 | saldo = total − (pagamentos − estornos com `restores_balance`); `undistributed = total − (previsto ativo + pago líquido de partes substituídas + pagamentos sem alocação)` |
| E3/E5 | só `register_service_payment` grava pagamento em conta aberta; fechamento legado bloqueado (gatilho provisório) — mantido |

## 2. Conflitos encontrados e decisões
| # | Conflito | Decisão |
|---|---|---|
| C1 | Duas vias de estorno | Separadas por estado da conta: aberta ⇒ `refund_open_session_payment`; fechada ⇒ legado (PT409 se aberta). Nunca as duas na mesma conta |
| C2 | Ordem de travas | conta `FOR UPDATE` → pagamento `FOR UPDATE` → caixa de quem estorna `FOR UPDATE` (igual ao padrão das demais RPCs; o legado não trava a conta, mas só age em conta fechada) |
| C3 | Pagamento sem alocação (anterior à divisão) | Não gera linhas de reversão; o valor recomposto aparece como "não distribuído" (E2). Nunca redistribui sozinho |
| C4 | Parte de divisão SUBSTITUÍDA | A reversão é gravada na parte original (histórico preservado); como o E2 conta o pago líquido de partes substituídas, o valor recomposto vira "não distribuído" |
| C5 | Arredondamento | Em centavos, método do maior resto (piso + 1 centavo às maiores sobras; empate por versão e posição); nunca excede o líquido da parte |
| C6 | Alocação inconsistente (soma líquida ≠ disponível) | PT409, nada gravado (impossível pelas RPCs da E3, defesa extra) |
| C7 | Caixa original ≠ caixa que devolve | Saída no caixa de quem estorna (precisa estar aberto); o caixa original, mesmo fechado, não é tocado |
| C8 | Dinheiro | Estorno em dinheiro exige dinheiro físico suficiente NO caixa que devolve |
| C9 | Delivery/retirada | PT409 (sem estorno parcial nesta etapa) |
| C10 | Fechamento legado | Gatilho provisório mantido sem alteração |

## 3. Regras (E6-R)
1. **R1** Só owner/admin (PT403 outros; PT404 sem vínculo/outra empresa/inexistente). **R2** `client_request_id` obrigatório (PT400); motivo obrigatório (1..200 após trim); valor >0, ≤2 casas.
2. **R3** Idempotência: mesmo id + mesmo pagamento/valor/motivo/operador ⇒ devolve o mesmo estorno (`replay=true`); conteúdo diferente ⇒ PT409; vale mesmo com conta já fechada.
3. **R4** Conta precisa estar aberta de comanda/mesa (PT409). **R5** Valor ≤ disponível do pagamento (pago − estornos), PT400. **R6** Caixa aberto do operador (PT412).
4. **R7** O pagamento original nunca é alterado; o estorno guarda pagamento e forma originais; o movimento `refund` usa a forma original.
5. **R8** Reversão nas partes: proporcional ao líquido de cada parte naquele pagamento, em centavos. **R9** Estado/partes recompostos sem redistribuição automática. **R10** Evento `payment_refunded` com motivo, caixas, reversões (rótulo/versão da divisão) e saldo/não distribuído antes e depois.
6. **R11** Estornos de conta fechada: inalterados (RPC antiga não foi tocada).

## 4. Verificação técnica final: o mutante "sem FOR UPDATE do pagamento" (equivalente)
Prova executável: `.claude/db-tests/refund-lock-order-proof.mjs` (PostgreSQL 17 real, backends independentes; 11 checks).
- **Ordem efetiva** (um segurador externo trava uma linha e sondamos com `FOR UPDATE NOWAIT` o que o estorno já segura): conta travada por fora ⇒ o estorno espera nela sem ter pagamento nem caixa; pagamento travado ⇒ já tem a conta, ainda não o caixa; caixa travado ⇒ já tem conta e pagamento. Ordem real: **conta → pagamento → caixa**.
- **Quem também trava a conta:** `register_service_payment`, `replace_session_split`, `submit_service_order`, `cancel_service_order_item`, `close_service_session` (fechamento antigo) e o estorno novo — todas esperam quando só a conta está travada. Com só o PAGAMENTO travado, apenas o estorno novo espera.
- **Auditoria do catálogo:** só 4 funções gravam em `service_payments`/`service_refunds` (`close_service_session`, `register_service_payment`, `refund_open_session_payment`, `refund_service_payment`), todas só com INSERT (nenhum UPDATE/DELETE em nenhuma função); o cliente só tem SELECT nas tabelas; nenhuma função reabre conta fechada. Três travam a conta antes de gravar. A exceção é `refund_service_payment` (estorno ANTIGO), que não trava a conta mas só age em conta FECHADA.
- **Disputa pelo mesmo pagamento:** os únicos travadores da linha do pagamento são o estorno novo (conta ABERTA, depois de travar a conta) e o antigo (conta FECHADA). Os dois são mutuamente exclusivos pelo status da conta (que só vai de aberta a fechada); testado com os dois ao mesmo tempo: o novo grava, o antigo recebe PT409.
- **Conclusão:** como todo estorno novo já segura a conta, dois estornos do mesmo pagamento nunca chegam juntos à linha do pagamento; remover a trava do pagamento não produz diferença observável por nenhum caminho de código existente (só com um segurador artificial fora do sistema). O mutante é **equivalente no escopo atual**. A trava do pagamento fica como **defesa em profundidade**: protege contra um futuro caminho que toque o pagamento sem passar pela conta. Nada do SQL foi alterado.
- **Observação fora do escopo (não alterada):** o estorno antigo lê o status da conta sem travá-la; é comportamento anterior à E6 e continua seguro porque conta fechada nunca reabre.

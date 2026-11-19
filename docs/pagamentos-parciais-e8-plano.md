# E8 — Planejamento: fechamento de comandas e mesas com pagamentos parciais, divisões e estornos

**Status: PLANEJAMENTO. Nada implementado.** Depende de aprovação das regras, do impacto e do plano de testes. Só banco local; nada no remoto; PDV de produção intacto; sem push/tag/deploy.

## 1. Situação atual (auditada)
- `close_service_session(sessão, pagamentos)` (corpo vigente em `20261014080000`): trava a conta, calcula o total, **exige caixa aberto**, valida e **insere os pagamentos recebidos** (exatamente o total) e fecha (`closed_at`, `closed_by`, `total_amount = total`). Não conhece pagamentos parciais nem partes. É usada pelo PDV (`cashApi.ts`) e por `receive_delivery_order` (delivery/retirada).
- Bloqueio provisório (E3/E5-4): o gatilho `service_sessions_guard_partial_close` nega `open → closed` de comanda/mesa com pagamento da E3 (`client_request_id` preenchido) **ou** divisão ativa, sem exceção. Consequência hoje: **conta com pagamento parcial ou dividida não consegue ser encerrada** por nenhum caminho.
- Já existe e não muda: `service_session_financial_core` (total, `settled_paid`, `balance_due`, `overpaid`, `payment_status`, partes, `undistributed`, `over_distributed`), `register_service_payment` (E3/E5), `replace_session_split` (E4), `refund_open_session_payment` (E6, conta aberta, recompõe saldo), `refund_service_payment` (legado, **só conta fechada**, `restores_balance=false`), proteção de cancelamento (E7). O evento `session_closed` já é aceito por `service_session_events`.

## 2. Proposta (menor mudança, sem tocar o PDV)
**Nova RPC `close_settled_service_session(p_service_session_id uuid, p_client_request_id uuid)`**, owner/admin/cashier, que **não move dinheiro**: apenas encerra uma conta que já está integralmente quitada. O dinheiro continua entrando só por `register_service_payment`.
- `close_service_session` **não é alterada** (md5 idêntico): o PDV e o delivery continuam exatamente como hoje para contas sem pagamento parcial e sem divisão.
- **Gatilho de guarda substituído** (mesmo nome, mesma função `partial_payments_guard_close`): em vez de negar sempre, passa a negar `open → closed` de comanda/mesa com pagamento da E3 ou divisão ativa **a menos que a conta esteja exatamente quitada**. Regra baseada em invariantes, sem variável de sessão que possa ser forjada.

### Regras de fechamento (R8-x)
1. **Conta sem pagamento da E3 e sem divisão ativa**: fecha pelo caminho de sempre (`close_service_session`), inalterado. A RPC nova também aceita (total 0, ou já quitada).
2. **Quitação exata**: fecha só com `balance_due = 0` **e** `overpaid = 0` (nem falta nem sobra). Com saldo pendente: PT409 "Ainda há saldo a receber". Com `overpaid > 0`: PT409 (excedente deve ser estornado antes; a E7 já impede criar).
3. **Divisão ativa**: além do item 2, exige `over_distributed = 0`, `undistributed = 0` e **todas as partes quitadas** (`pending = 0`). Divisão com partes pendentes, desatualizada ou com sobra: PT409 com mensagem de ação ("refaça a divisão" / "receba as partes").
4. **Total zero** (tudo cancelado/estornado): fecha sem pagamento; sem caixa.
5. **Gatilho (defesa em profundidade)**: o gatilho aplica as mesmas regras 2–3 a **qualquer** `UPDATE` que feche comanda/mesa com pagamento da E3/divisão. O fechamento legado fica barrado de forma natural: ele insere pagamentos novos antes do `UPDATE`, então quem já recebeu parcial passa a ter `overpaid > 0` ou partes pendentes → PT409 e tudo é desfeito (mesma garantia de hoje). Caso limite: conta cujos pagamentos foram todos estornados (saldo recomposto, `settled_paid = 0`) volta a ser "sem parcial líquido" e fecha pelo legado sem dupla cobrança.
6. **total_amount** gravado = total vigente (consumo), igual ao legado; `closed_at`, `closed_by` = quem fecha.
7. **Caixa**: a RPC nova **não exige caixa aberto** (não há dinheiro a registrar). O caixa de cada pagamento já foi creditado na E3/E5; fechar o caixa de quem recebeu continua independente.
8. **Idempotência**: `p_client_request_id` + evento `session_closed` (índice de request_id já existe). Repetição devolve o mesmo resultado (`replayed`), sem novo evento nem erro; conta já fechada por outro pedido: PT409 "já foi fechado".
9. **Auditoria**: um evento `session_closed` com payload (total, pago líquido, nº de partes, versão da divisão). Sem valores em mensagens de erro.
10. **Delivery/retirada**: fora de escopo (E3 já exclui; gatilho só atua em `kind = 'point'`; `receive_delivery_order` continua usando o legado).
11. **Estornos depois do fechamento**: continua o legado `refund_service_payment` (histórico, `restores_balance=false`, não reabre a conta). Pergunta de decisão D3 abaixo.
12. **Estorno antes de fechar** (E6) recompõe saldo: a conta reaparece com saldo e só fecha depois de receber de novo ou de cancelar consumo (E7).
13. **Concorrência**: a RPC trava a conta (`FOR UPDATE`) primeiro (hierarquia: conta → pagamento → caixa); pagamento, estorno, divisão, cancelamento e pedido novo disputando com o fechamento terminam em um de dois estados consistentes: fechou **com** tudo quitado, ou não fechou. Nunca fecha com saldo, nunca recebe depois de fechada (já protegido por `register_service_payment`).

## 3. Impacto nas RPCs existentes
| RPC / objeto | Mudança |
|---|---|
| `close_service_session` | **nenhuma** (corpo idêntico; passa a falhar com PT409, como hoje, para contas parciais/divididas e não quitadas) |
| `receive_delivery_order` | nenhuma (delivery fora do gatilho) |
| `partial_payments_guard_close()` (gatilho) | corpo trocado: "negar sempre" → "negar salvo quitação exata e partes quitadas" |
| `register_service_payment`, `replace_session_split`, `refund_open_session_payment`, `cancel_service_order_item`, motor de pedidos | nenhuma |
| `refund_service_payment` | nenhuma (decisão D3) |
| `close_cash_session`, relatórios de caixa | nenhuma (pagamentos parciais já têm `cash_movements` `sale`); a validar em teste de regressão |
| Nova: `close_settled_service_session(uuid, uuid)` | owner/admin/cashier, `SECURITY DEFINER`, `search_path = public`, EXECUTE só `authenticated` |
| Frontend | **não alterado nesta etapa** (o PDV de produção segue chamando `close_service_session`); a tela de pagamentos parciais é etapa futura |

## 4. Decisões para você
- **D1 — RPC nova × estender o legado.** Recomendo RPC nova (acima): zero risco para o PDV. Alternativa: tornar `close_service_session` consciente do saldo (mexe no caminho de produção).
- **D2 — Caixa aberto no fechamento.** Recomendo **não exigir** (nenhum dinheiro se move). Alternativa: exigir caixa aberto do operador.
- **D3 — Estorno de pagamento por parte depois do fechamento.** O legado estorna sem alocar a parte (o histórico por parte não muda; o estorno fica ligado ao pagamento). Recomendo manter assim nesta etapa e tratar "estorno alocado em conta fechada" só se você quiser.
- **D4 — Conta com divisão "não distribuída"/sobra no fechamento.** Recomendo bloquear (regra 3) em vez de fechar automaticamente.

## 5. Plano de testes
1. **Unitário (PGlite)** `partial-payments-close.mjs`: quitada sem divisão; quitada com divisão (iguais, valores, produtos); parte pendente; `undistributed > 0`; `over_distributed > 0`; `overpaid > 0`; saldo pendente; total zero; após estorno (reabre o saldo) e após novo recebimento; conta já fechada; delivery recusado; papéis (owner/admin/cashier ok; attendant/production/courier PT403; outra empresa/inexistente PT404); idempotência e `request_id` reaproveitado; evento e `closed_by/closed_at/total_amount`; mensagens sem valores.
2. **Gatilho**: legado em conta parcial/dividida → PT409 e **nada gravado** (pagamentos e movimentos desfeitos); legado em conta sem parcial → fecha como hoje; caso "todos os pagamentos estornados" fecha pelo legado; UPDATE direto (RLS) negado.
3. **Corrida real (PostgreSQL 17)**: fechamento × pagamento da última parte; × estorno; × refazer divisão; × cancelamento; × pedido novo (com estoque controlado, 0 deadlock); fechamento × fechamento (2 e 4 simultâneos); fechamento × fechamento legado; fechamento × fechamento do caixa. 25 rodadas; invariantes: conta fechada ⇒ `balance_due = 0`, `overpaid = 0`, partes quitadas, um único evento `session_closed`.
4. **Regressão**: E1–E7.1 integrais, `run-all` contra a linha de base (23 falhas e 11 abortos preexistentes), `acl2`, md5 de todas as funções exceto a nova e o gatilho, `close_service_session` e `receive_delivery_order` idênticas, suítes de caixa/delivery/PDV.
5. **Mutantes**: regra de quitação (fronteiras `>=`/`>`), divisão ignorada, `overpaid` ignorado, gatilho desligado/estendido a delivery, falta de trava da conta, `search_path`, ACL aberta, mensagem com valores, rollback incompleto.
6. **Rollback**: restaura o corpo exato do gatilho da E5 e remove a RPC; catálogo idêntico ao anterior; idempotente.
7. **Critérios de aceite**: 0 violações e 0 deadlocks nas corridas, mutantes 100% mortos (equivalentes justificados), regressão igual à linha de base, PDV (`close_service_session`, `receive_delivery_order`) com md5 idêntico.

## 6. Riscos
- Gatilho mais permissivo que o atual: mitigado por basear-se só em invariantes financeiras (nunca em estado de sessão) e testado por mutantes e corrida contra o legado.
- Divisão com `undistributed > 0` impede fechamento até refazer a divisão (comportamento intencional; exige UI futura).
- Interface das etapas futuras (telas de parcial/divisão/fechamento) fica fora desta etapa.

## 7. Rollback
Migration única: `create or replace` do corpo do gatilho + criação da RPC. Rollback restaura o corpo exato da E5 e remove a RPC; sem dados a reverter (o fechamento é registro normal da conta; contas já fechadas pela RPC nova permanecem fechadas).

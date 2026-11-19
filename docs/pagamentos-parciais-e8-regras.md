# E8 — Regras: encerramento de comandas e mesas quitadas (pagamentos parciais, divisões e estornos)

Migration `supabase/migrations/20261214020000_close_settled_service_session.sql`. Rollback `supabase/rollbacks/close-settled-service-session/rollback.sql`.
Só banco local; nada no remoto; PDV de produção intacto (`close_service_session`, `receive_delivery_order`, frontend: nenhum byte alterado).

## 1. Decisões aprovadas
D1 RPC nova sem tocar `close_service_session`. D2 sem caixa aberto (nenhum dinheiro se move). D3 estorno legado de conta fechada preservado (pagamentos/alocações/divisão históricos intactos). D4 recusa com saldo, valor não distribuído, `over_distributed` ou parte ativa não quitada.

## 2. A RPC `close_settled_service_session(p_service_session_id, p_client_request_id) -> jsonb`
- **Quem:** owner, admin, cashier. attendant/production/courier: PT403. Sem vínculo, outra empresa e id inexistente: PT404 com a mesma mensagem. Sem login: PT401. `anon` sem EXECUTE.
- **Quando:** conta ABERTA de comanda/mesa (delivery/retirada: PT409) e financeiramente consistente: `balance_due = 0`, `overpaid = 0`, `over_distributed = 0`, `undistributed = 0` e nenhuma parte da divisão ativa pendente. Total 0 fecha sem pagamento.
- **O que grava:** `status`, `closed_at`, `closed_by`, `total_amount` (= consumo cobrável vigente) e UM evento `session_closed` (operador em `actor_id`, `request_id`, payload com total, pago, estornado, líquido, nº de pagamentos/estornos, divisão e nº de partes, `closed_via`). **Nada mais**: nenhum pagamento, estorno, alocação, movimento de caixa, divisão, parte ou pedido é criado, alterado ou apagado.
- **Idempotência:** `client_request_id` obrigatório (PT400 se nulo). Mesmo id + mesma conta + mesmo operador: devolve o mesmo resultado (`replayed = true`) sem novo evento. Mesmo id em outra conta ou outro operador: PT409. Conta já fechada com id novo: PT409 "já foi fechado". O índice único `(company_id, event_type, request_id)` é a rede de segurança.
- **Concorrência / trava:** trava a CONTA (`FOR UPDATE`) e só ela (não toca pagamento, produto nem caixa; compatível com a hierarquia conta → pagamento → caixa e com a E7.1). Pagamento, estorno, divisão, cancelamento, pedido novo e outro fechamento disputando a mesma conta terminam em um de dois estados: fechou **quitada** ou não fechou.
- **Mensagens:** só orientação, nunca valores monetários.

## 3. O gatilho `partial_payments_guard_close()` (corpo trocado)
Antes (E3/E5): negava SEMPRE o `open → closed` de comanda/mesa com pagamento da E3 (`client_request_id` preenchido) ou divisão ativa.
Agora, para essas mesmas contas, só deixa passar se **(a)** já existe, na conta, um evento `session_closed` (gravado só pela RPC nova, antes do UPDATE e na mesma transação; o cliente não tem INSERT em `service_session_events`) **e (b)** as invariantes valem de novo (saldo 0, sem excedente, sem valor fora das partes, nenhuma parte pendente). Sem variável de sessão, GUC nem dado enviado pelo cliente.
Contas sem pagamento da E3 e sem divisão ativa, delivery e retirada: gatilho não interfere (fechamento tradicional idêntico).

## 4. Exame de brechas do gatilho (pedido de auditoria antes de finalizar)
| Caminho | Resultado | Prova |
|---|---|---|
| `close_service_session` (legado) em conta com parcial/divisão, MESMO quitada | recusado (PT409), pagamentos e movimentos que ele inseriu são desfeitos | testes 8.1–8.6, C52 |
| UPDATE direto do cliente em `service_sessions` | sem permissão/RLS | 1.6 |
| INSERT do cliente de um evento `session_closed` | sem permissão | 1.6 |
| Evento de outro tipo autorizando | não autoriza | 8.9, 8.17, mutantes |
| Evento `session_closed` forjado por quem tem acesso total ao banco (service_role/dono) em conta NÃO quitada | o gatilho revalida e recusa | 8.10, 8.14–8.16 |
| Evento forjado em conta realmente quitada (dono do banco) | passa: a autorização é a invariante financeira, não um segredo; nenhum dinheiro é movido | 8.11 (documentado) |
| Outras funções que fecham `service_sessions` | auditoria de catálogo: só `close_service_session`, `close_settled_service_session` e `cancel_delivery_order` (sessão `delivery`, fora do gatilho) | 8.12 |
| Outras funções que gravam evento `session_closed` | somente a RPC nova | 8.18 |
| Conta fechada receber depois pagamento, divisão, pedido | recusado (já era) | 9.1, C47–C51 |
| Corridas contra fechamento (pagamento, estorno, cancelamento, substituição, pedido, legado, caixa, fechamento duplo) | sem violação e sem deadlock | C45–C53 + invariantes INV E8 |
**Brecha encontrada:** nenhuma que permita fechar conta com saldo, excedente ou partes pendentes por caminho acessível ao cliente. Risco residual conhecido e aceito: quem tem credencial de dono do banco/service_role pode forjar o evento, mas continua limitado pelas invariantes.
**Observação sobre o plano:** o plano previa que contas com todos os pagamentos estornados pudessem fechar pelo legado; a implementação manteve o bloqueio SEM exceção (mais estrito, requisito 7). Essas contas fecham pela RPC nova.

## 5. Impacto
`close_service_session`, `receive_delivery_order`, `register_service_payment`, `refund_open_session_payment`, `refund_service_payment`, `replace_session_split`, `cancel_service_order_item`, `submit_service_order_engine` e todo o frontend: inalterados (md5 idêntico). Mudam apenas: o gatilho `partial_payments_guard_close()` (corpo) e a nova RPC.
Mensagens do gatilho para o caminho legado foram atualizadas (contêm "já recebeu pagamento parcial" / "divisão ativa", como antes).

## 6. Rollback
Restaura o corpo exato do gatilho da E5 e remove a RPC. Sem dados a restaurar: contas já encerradas pela RPC permanecem fechadas (e seus eventos ficam como histórico). Depois do rollback, conta com parcial/divisão volta a não poder ser encerrada por nenhum caminho. Idempotente; catálogo de funções volta idêntico (md5).

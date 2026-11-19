# Pagamentos parciais — E3: regras da RPC `register_service_payment`

Escopo: registrar pagamento em conta ABERTA de comanda/mesa SEM encerrá-la. Só local/isolado; nada aplicado ao remoto.
Estas regras foram escritas ANTES do SQL e viram testes em `.claude/db-tests/partial-payments-register.mjs`
(cada regra tem um identificador `R-n`, citado nos testes).

## Assinatura
`register_service_payment(p_service_session_id, p_method, p_amount, p_amount_received, p_client_request_id, p_expected_balance default null, p_part_id default null, p_allocations default null, p_confirm_allocation default false) → jsonb`

## Regras gerais
- **R-1 Quem.** owner, admin e cashier da empresa. attendant/production/courier: PT403. Sem vínculo, outra empresa e id inexistente: o MESMO PT404 "Atendimento não encontrado". Sem sessão: PT401.
- **R-2 Idempotência.** `p_client_request_id` é obrigatório (PT400 se nulo). O mesmo identificador, com o mesmo conteúdo (conta, forma, valor, operador), devolve o pagamento JÁ criado (`replay = true`), sem novo pagamento, movimento, evento ou alocação — mesmo que a conta já tenha mudado de saldo ou fechado. Mesmo identificador com conteúdo diferente: PT409. Único por empresa (o mesmo UUID em outra empresa é outro pedido).
- **R-3 Comanda aberta.** Conta fechada: PT409. Delivery/retirada (`kind = delivery`): PT409 (fora do parcial; segue em `receive_delivery_order`).
- **R-4 Caixa.** O operador precisa de caixa ABERTO próprio (PT412). O pagamento fica no caixa que o recebeu (`cash_session_id`) e a forma é a escolhida; nada é trocado depois.
- **R-5 Valores.** `p_amount` = valor APLICADO à conta: > 0, ≤ 2 casas, < 1e10. Forma ∈ {cash, pix, debit_card, credit_card, other}. Nunca é preenchido nem confirmado pelo banco: vem sempre da chamada.
- **R-6 Dinheiro.** `p_amount_received` (entregue) é OBRIGATÓRIO em dinheiro, ≥ `p_amount`; troco = entregue − aplicado (gravado em `change_amount`; só o aplicado vira receita/movimento). Nas demais formas `p_amount_received` deve ser nulo.
- **R-7 Saldo.** Calculado no servidor com a conta travada (`service_session_financial_core`): `balance_due = total vigente − (pagamentos − estornos que recompõem saldo)`. Sem saldo: PT409. `p_amount > saldo`: PT400 (mostra o saldo). Pode ser parcial ou integral, em quantas formas forem necessárias (uma chamada por forma). A conta NÃO fecha: o fechamento é outra operação (E8) e só com saldo zero.
- **R-8 Saldo esperado (anti-corrida de tela).** Se `p_expected_balance` vier preenchido e diferir do saldo atual: PT409 com o saldo atual, sem gravar. É a proteção de "o saldo mudou entre a consulta e o pagamento" (outro caixa pagou, pedido novo, item cancelado).
- **R-9 Concorrência.** Ordem de travas igual à do fechamento: `service_sessions` (FOR UPDATE) → `cash_sessions` do operador (FOR SHARE). Tudo que muda a conta (pedido novo, cancelamento de item, fechamento, estorno futuro) trava a mesma linha da sessão primeiro; logo dois caixas nunca pagam acima do saldo e uma requisição repetida enxerga a primeira.
- **R-10 Auditoria.** Cada pagamento grava: `service_payments` (com `client_request_id`), `cash_movements` tipo `sale` (valor aplicado, na forma e no caixa), 1+ linhas de alocação quando há divisão, e 1 evento `payment_registered` (com request id, forma, valor, caixa, alocações, confirmação).
- **R-11 Imutável.** Pagamento confirmado nunca é alterado por esta RPC (só insere).

## Conta dividida (divisão ativa existente)
- **R-12 Parte explícita.** Com divisão ativa, é OBRIGATÓRIO dizer onde o pagamento entra: `p_part_id` (uma parte) OU `p_allocations` confirmadas. Sem nenhum dos dois: PT400. O banco NUNCA distribui valor entre pessoas sozinho.
- **R-13 Menor que a parte.** Com `p_part_id`, o valor pode ser menor que o pendente da parte (a parte fica parcial).
- **R-14 Excedente.** Com `p_part_id`, valor MAIOR que o pendente da parte é recusado (PT409) e a mensagem manda usar alocações. Excedente só com `p_allocations` + `p_confirm_allocation = true`: lista explícita `{part_id, amount}`, soma EXATA = `p_amount`, partes distintas da divisão ativa, cada alocação > 0 e ≤ pendente da própria parte (líquido). Sem confirmação: PT400.
- **R-15 Conta inteira com divisão.** É a mesma via de alocações: ação explícita, com confirmação, uma linha de alocação por parte (auditável em `service_payment_allocations` e no evento).
- **R-16 Misturas proibidas.** `p_part_id` e `p_allocations` juntos: PT400. Sem divisão ativa, `p_part_id`/`p_allocations` não existem: PT400.
- **R-17 Não distribuído.** Se o consumo cresceu depois da divisão (valor "não distribuído"), esse valor NÃO é cobrável por parte: só cabe pagar até o pendente das partes; o restante exige refazer a divisão (E4).
- **R-18 Parte paga / outra divisão.** Parte de divisão substituída, de outra conta ou de outra empresa: PT409. Parte já quitada (pendente 0): PT409.

## Proteção contra cobrança duplicada (até a E8)
- **R-19 Fechamento legado bloqueado, sem exceção.** Enquanto `close_service_session` não conhecer pagamentos parciais (E8), um gatilho
  (`service_sessions_guard_partial_close`) NEGA qualquer passagem de `open` para `closed` de uma conta de comanda/mesa que tenha ao menos
  1 pagamento registrado pela E3 — com saldo pendente, com saldo zero, com ou sem estorno. Não existe exceção por saldo.
- **R-20 Recusa integral.** O erro (PT409) aborta o comando: pagamentos e movimentos que a RPC antiga inseriu antes do UPDATE são desfeitos
  e a conta continua aberta, sem `closed_at`, `closed_by` nem `total_amount`.
- **R-21 Identificação.** "Pagamento da E3" = `service_payments.client_request_id IS NOT NULL`. Nenhum fluxo antigo preenche a coluna
  (histórico, fechamento legado e delivery gravam NULL); invariante testada: nº de pagamentos com `client_request_id` = nº de eventos
  `payment_registered`. Contas sem pagamento da E3 fecham como sempre.
- **R-22 Concorrência.** Pagamento (E3) e fechamento legado disputando a mesma conta terminam em exatamente um de dois estados:
  conta fechada pelo fluxo antigo SEM pagamento da E3, ou conta aberta COM pagamento da E3. Nunca fechada com pagamento da E3.
- A E8 substitui este bloqueio por `close_service_session` ciente de saldo e remove o gatilho.
- **R-23 (E5-4, opção B)** O bloqueio provisório R-19 foi ESTENDIDO na E5: também nega o fechamento antigo de comanda/mesa com DIVISÃO ATIVA, mesmo sem pagamento da E3 (ver `pagamentos-parciais-e5-regras.md`, seção 6). Continua provisório até a E8.

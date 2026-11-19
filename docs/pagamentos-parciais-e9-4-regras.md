# E9.4 — Diálogo financeiro da conta no Caixa (local; nada no remoto)

Código: `features/cash/accountFinanceController.ts` (regras, sem React), `AccountFinanceDialog.tsx` (desenho), botão "Pagamentos da conta" em `SessionOrderScreen.tsx`. Testes: `account-finance-controller.mjs` (35), `account-finance-contract.mjs` (36, RPCs reais), `account-finance-static.mjs` (21), mutação de 33 casos.

## Quando existe
- Só na variante **Caixa** (`canCheckout`: owner/admin/cashier), em comanda/mesa **aberta** (não delivery), com o módulo ligado. Balcão e Atendimento não têm o botão. Sem o módulo, a tela é a tradicional.

## Operações (todas pelos wrappers da E9.2)
- **Pagamento** (`register_service_payment`): forma única por vez; valor sugerido = saldo (ou pendente da parte); dinheiro com valor entregue e **troco** (entregue − aplicado, mostrado após registrar); conta dividida exige parte ou distribuição confirmada; envia o saldo esperado.
- **Estorno de conta aberta** (`refund_open_session_payment`): só owner/admin, com motivo e até o valor disponível; reabre o saldo (é correção, não devolução). A lista de pagamentos estornáveis só é lida por quem pode estornar.
- **Encerrar** (`close_settled_service_session`): só quando `validateClose` não aponta pendência.

## Regras do controlador
- Um `client_request_id` estável por tentativa; clique duplo não envia duas vezes (trava enquanto ocupado).
- **Resultado desconhecido** (rede/timeout): o formulário trava, o id é mantido e só se pode **reenviar o mesmo pedido** (o banco devolve a réplica se já gravou) ou "já conferi", que recarrega o servidor e informa se a operação aparece. Pendência tem prioridade sobre qualquer outra operação.
- Recusa definitiva ou sucesso liberam o id. **Saldo desatualizado** (PT409): recarrega o estado e avisa para conferir os valores. **Sem caixa** (PT412): oferece abrir o caixa e pede para registrar de novo. **Módulo desligado**: mensagem do recurso.
- Depois de cada operação o estado vem da resposta da RPC (ou nova leitura): nunca conta feita no cliente. Resposta de réplica diz que não cobrou de novo.
- Encerrar conta já fechada ou com pendência é recusado antes de chamar o banco.

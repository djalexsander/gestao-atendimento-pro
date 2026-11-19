# E9.7 — Contrato funcional do novo PDV (3 colunas) — local; produção intacta

Fonte única legível por máquina: `.claude/shell-preview/pdvContract.js` (dados + regras puras). Conferido por `.claude/frontend-tests/pdv-contract.mjs` (40 checagens contra o banco local real e os validadores reais do front) e por `mutate-pdv-contract.mjs` (27 mutantes mortos). Preview: `5181/pdv.html?role=<papel>&pp=<1|0>&surface=<caixa|balcao|atendimento>`. **Nada disto altera o PDV de produção, o banco ou o remoto.**

Layout aprovado: coluna 1 **Contas** (busca/leitura de código, filtros), coluna 2 **Conta** (conferência / dividir), coluna 3 **Receber** (situação, partes, formas, pagamentos, fechar).

## 1. Superfícies
| Superfície | Rota | Financeiro? |
|---|---|---|
| Caixa | `/operacional/caixa` (variante `cashier`) | **sim** — única que recebe, divide, estorna e encerra |
| Balcão | `/operacional/balcao` (variante `counter`) | não — lançar/consultar pedidos + status de pagamento |
| Atendimento | `/operacional/atendimento` (variante `attendant`) | não |

O Balcão continua separado do Caixa financeiro: `canCheckout` exige `variant === "cashier"`; as páginas do Balcão e o painel não importam o diálogo financeiro nem os wrappers de escrita (verificado em teste).

## 2. Operações, wrappers e RPCs
| Ação | Wrapper (`partialPaymentsApi`) | RPC | Papéis | Exige |
|---|---|---|---|---|
| Situação financeira (valores) | `getFinancialState` | `get_session_financial_state` | owner, admin, cashier | — |
| Só status | `getPaymentStatus` | `get_session_payment_status` | + attendant | — |
| Visão geral (chips) | `listPaymentOverview` | `list_session_payment_overview` | + attendant | módulo ligado |
| Histórico de divisões | `getSplitHistory` | `get_session_split_history` | owner, admin, cashier | — |
| Registrar pagamento | `registerPayment` | `register_service_payment` | owner, admin, cashier | módulo + caixa aberto |
| Dividir/refazer | `replaceSplit` | `replace_session_split` | owner, admin, cashier | módulo |
| Estornar (correção) | `refundOpenPayment` | `refund_open_session_payment` | owner, admin | módulo |
| Encerrar quitada | `closeSettled` | `close_settled_service_session` | owner, admin, cashier | módulo |
| Pagamentos estornáveis | `listSessionPayments` | leitura de `cash_movements` | owner, admin | — |

Production e courier não têm acesso a nenhuma. Os papéis acima foram **conferidos contra o banco** para todos os seis papéis (permitido/negado coincide com o contrato).

## 3. Estado financeiro → ações (conta aberta; Caixa; módulo ligado; caixa aberto)
Estado vem de `FinancialState` (`get_session_financial_state`): `paymentStatus` ∈ no_charge | unpaid | partial | paid (e `closed` = sessão encerrada).
| Situação | Receber | Dividir | Estornar (owner/admin) | Encerrar |
|---|---|---|---|---|
| unpaid (saldo > 0) | sim | sim | não (sem pagamento) | não (saldo) |
| partial (saldo > 0) | sim | sim | sim | não (saldo) |
| dividida com parte pendente | sim, **informando a parte** (ou distribuição confirmada) | sim (refaz o pendente) | sim | não (parte pendente) |
| paid (saldo 0, partes quitadas) | não (sem saldo) | não (sem saldo) | sim | **sim** |
| no_charge (total 0) | não | não | não | sim |
| excedente (`overpaid`) | não | — | sim (estornar o excedente) | não |
| partes acima do total / valor fora das partes | receber bloqueado se acima do total | refazer a divisão | sim | não |
| encerrada (`closed`) | não | não | não (use a devolução da venda fechada) | não |
Toda ação negada mostra o **motivo** (a tela não some em silêncio). `closeProblem` é idêntico a `validateClose` do front (teste com casos reais e sintéticos).

## 4. Comportamento
- **Pagamento parcial:** valor ≤ saldo pendente; em conta dividida escolhe-se **uma parte**; excedente sobre a parte só vai a outras partes com confirmação explícita. Várias formas = um `register_service_payment` por forma, em ordem, cada um com o saldo esperado (`planMultiPayment`).
- **Troco:** só dinheiro. Troco = entregue − aplicado; **não abate o saldo** (verificado no banco: 30 em dinheiro entregando 50 em conta de 67 deixa saldo 37). Outras formas não têm valor entregue.
- **Divisão:** cobre o saldo pendente, 2 a 50 partes, versão otimista; pagamentos já feitos nunca mudam; versão antiga vai ao histórico; por produtos só quando o valor pago corresponde a itens quitados. Refazer com valor já pago exige confirmação.
- **Estorno:** só owner/admin, motivo (3–200), até o disponível; é **correção** (reabre saldo da conta aberta) e não devolução de venda fechada.
- **Encerramento:** saldo 0, sem excedente, sem divisão inconsistente, sem parte pendente; idempotente. Conta com atividade parcial não oferece o fechamento tradicional.
- **Idempotência:** um `client_request_id` por tentativa; rede = "resultado desconhecido" (mesmo id, formulário travado, só reenviar o mesmo pedido); PT4xx/sucesso liberam o id; PT409 recarrega o estado; PT412 pede caixa aberto.
- **Módulo desligado:** nenhuma ação nova; o recebimento tradicional (um pagamento e Fechar conta, `close_service_session`) permanece. O banco recusa as escritas ("não está habilitado") — verificado.
- **Delivery/retirada:** seguem o fluxo próprio de recebimento (ações de escrita do PDV parcial negadas).
- **Atendente:** só status; nunca valores, histórico, receber, dividir, estornar ou encerrar.

## 5. Para a integração visual futura
1. Ler o estado por `getFinancialState` (ou só status para o atendente) e derivar as ações com a tabela da seção 3 (`PDV_CONTRACT.actions`).
2. Desabilitar com tooltip/nota o motivo de cada ação negada.
3. Reaproveitar o controlador `accountFinanceController` e `splitEditorController` (idempotência, desconhecido, desatualizado) — a tela do PDV só desenha.
4. Manter fora do Balcão qualquer botão financeiro; o chip de status (E9.3) é o único elemento financeiro permitido lá.
5. Fechamento do caixa, suprimento/sangria e abertura reaproveitam os diálogos atuais do Caixa (inalterados).

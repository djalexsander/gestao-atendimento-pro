# E9.2 — Camada de dados do front (local; nada no remoto)

Código: `apps/web/src/features/cash/partialPaymentsLogic.ts` (puro) e `partialPaymentsApi.ts` (wrappers das RPCs). Sem tela. Descreve só o que está implementado e testado (`partial-payments-logic.mjs`, `partial-payments-contract.mjs`).

## Chave do recurso e papéis
- Módulo `partial_payments` (por empresa, via entitlements): `isPartialPaymentsEnabled`. Desligado = nenhuma ação nova e a leitura de visão geral é recusada pelo banco (PT403 "não está habilitado").
- `canViewFinancialValues` / `canOperatePartialPayments` = owner, admin, cashier. `canRefundOpenPayment` = owner, admin. `canViewStatusOnly` = attendant. Production e courier não têm acesso.

## Wrappers (cada um = uma RPC; retorno `{ok:true,data}` ou `{ok:false,error,message}`, nunca lança)
| Wrapper | RPC |
|---|---|
| `getFinancialState` | `get_session_financial_state` |
| `getPaymentStatus` | `get_session_payment_status` |
| `listPaymentOverview` | `list_session_payment_overview` |
| `getSplitHistory` | `get_session_split_history` |
| `listSessionPayments` | leitura de `cash_movements` (estornáveis; só owner/admin usam) |
| `registerPayment` | `register_service_payment` |
| `replaceSplit` | `replace_session_split` |
| `refundOpenPayment` | `refund_open_session_payment` |
| `closeSettled` | `close_settled_service_session` |

Resposta que não tem a forma esperada vira erro genérico (nunca se inventa valor).

## Dinheiro e validação local (o banco revalida tudo)
- Valores em centavos inteiros; para o banco vão em reais (`centsToReais`).
- `validatePayment`: valor > 0; **dinheiro** exige entregue ≥ aplicado; outras formas não têm valor entregue; parte e alocações são excludentes; alocações (1 a 50, sem parte repetida, valores > 0, soma = valor) exigem confirmação; com estado: conta aberta, saldo > 0, valor ≤ saldo, conta dividida exige parte, conta sem divisão não aceita parte, partes acima do total bloqueiam, parte quitada não recebe.
- `changeCents`: troco só em dinheiro = entregue − aplicado.
- `planMultiPayment`: várias formas = um pagamento por forma, em ordem, cada um com o saldo esperado anterior; null se passar do saldo.
- `validateSplit`: 2 a 50 partes; rótulo até 40; por valores soma = saldo pendente; por produtos exige itens.
- `validateRefundOpen`: valor > 0, ≤ disponível do pagamento, motivo de 3 a 200 caracteres.
- `validateClose`: só aberta, saldo 0, sem excedente, sem partes acima do total, sem valor fora das partes, sem parte pendente.
- `suggestedPaymentCents`: saldo (ou o pendente da parte, limitado ao saldo).
- `hasPartialActivity`: conta com pagamento da camada nova ou dividida (o fechamento tradicional não serve).

## Idempotência e desfechos
- `createRequestKeys`: um `client_request_id` por tentativa (mesma chave = mesmo id) até liberar.
- `classifyOutcome`: `success`, `stale` (PT409 de saldo/divisão alterados: recarregar), `needs-cash` (PT412), `feature-off` (PT403 "não está habilitado"), `refused` (qualquer PT4xx definitivo), `unknown` (rede/timeout/resposta inválida: pode ter gravado; manter o MESMO id).
- Liberar o id: sucesso e recusa definitiva; manter: desconhecido.

## O que não faz
Nenhuma tela, nenhum cálculo de saldo no cliente (o servidor é a autoridade), nenhuma escrita direta em tabelas.

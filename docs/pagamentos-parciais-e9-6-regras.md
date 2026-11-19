# E9.6 — Indicadores financeiros no frontend (local; nada no remoto)

Escopo: mostrar na Visão financeira, no Dashboard e nos Relatórios (tela e PDF) os indicadores que o `report_period` (E9.1) já entrega, **sem migration, sem RPC nova e sem leitura nova**. Código: `features/financial/partialIndicatorsLogic.ts` (puro), integração em `financialOverviewLogic.ts`, `FinancialOverview.tsx`, `DashboardPage.tsx`, `ReportsPage.tsx`, `reportPdf.ts`.

## Quando aparece
- **Módulo `partial_payments` desligado** (padrão): o servidor devolve o JSON legado (sem `open_accounts`, sem `corrections`). O front trata a ausência de `open_accounts` como "desligado": nenhum bloco, nenhum rótulo e nenhuma conta mudam. Líquido recebido continua = recebido − estornos.
- **Ligado e papel owner/admin** (o mesmo conjunto que o servidor exige em `report_period`): aparecem os blocos abaixo. Cashier, attendant, production, courier e counter não chamam `report_period` e a tela também esconde (defesa em profundidade, `canViewPartialIndicators`).

## Os cinco indicadores (cada um em seu lugar, NUNCA somados entre si)
| Indicador | Origem | Onde aparece | O que é |
|---|---|---|---|
| Correções de pagamento (evento) | `sales.corrections`, `refunds.corrections` {count,total} | bloco "Contas abertas e correções"; cartão nos Relatórios | estorno que devolve o pagamento e **reabre o saldo de conta aberta** (E6). Visão por data do estorno. |
| Devoluções de vendas fechadas | `refunds.total/count` (o servidor já exclui as correções) | KPI "Devoluções" (rótulo legado "Estornos" quando desligado), bloco, aba Estornos | dinheiro devolvido de venda já fechada |
| Recebimentos de contas ainda abertas | `open_accounts` {accounts, received, corrections, net} | bloco (mostra o **líquido**, com nº de contas) | dinheiro que entrou em contas não encerradas até o fim do período. **Não é venda.** |
| Correções devolvidas pelo caixa | `cash.correction_refund_total` | linha no cartão Caixa | parte de `cash.refund_total` (estornos pagos pelo caixa) |
| Formas de pagamento (vendas fechadas) | `methods[]` {paid, corrections, refunded, net} | cartão "Formas de pagamento (vendas fechadas)", Relatórios, PDF | só pagamentos de contas **fechadas** no período |

## Regras de não dupla contagem
1. **Vendido** = `sales.gross` (contas fechadas). Recebimento em conta aberta nunca entra nele.
2. **Recebido** = soma de `methods[].paid` (contas fechadas). Conta aberta fica fora.
3. **Líquido recebido** (ligado) = soma de `methods[].net` = recebido − correções (contas fechadas) − devoluções. Desligado: recebido − estornos (legado). Comparativo: cada período usa a fórmula do seu próprio JSON.
4. **Correção por evento** (`sales.corrections`) **não** é soma de `methods[].corrections` + `open_accounts.corrections`: uma é por data do estorno, as outras por situação da conta. Por isso nenhuma tela as totaliza juntas.
5. **Devolução ≠ correção**: `refunds.list` e `refunds.total` só têm devoluções; correções ficam à parte.
6. **Caixa**: `cash.correction_refund_total` é parte de `refund_total` e **soma todas as formas** (o `cash_movements` registra estorno de Pix/cartão também). O saldo físico esperado continua usando **só** os estornos em dinheiro (`payment_method='cash'`). O rótulo diz "todas as formas" para não ser lido como dinheiro.
7. Contas a receber/pagar seguem separadas, sem "entradas − saídas" (regra do `dashboardLogic`).
8. Entrega/retirada: `delivery_fee` e origens não foram tocados.

## Coerência (aviso visível, nunca escondido)
`parsePartialIndicators` confere: líquido por forma = recebido − correções − devoluções; líquido de contas abertas = recebido − correções; correção do caixa ≤ total de estornos do caixa; campos obrigatórios presentes. Se algo não fechar, a tela mostra o aviso (`role="alert"`) listando o que falhou, sem esconder os números.

## O que NÃO mudou
`financialOverviewApi.ts` (mesmas leituras), `cashApi`, `CashAdmin`, RPCs, migrations, PDV, fluxos de Caixa/delivery/retirada/WhatsApp, as 6 alterações locais do Balcão.

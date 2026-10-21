# Fase 4A — Delivery / Retirada dentro do Caixa

Status: **implementado LOCALMENTE** (migration `20261024010000_delivery_cash_receivables.sql` NÃO aplicada; nada publicado).

## Princípio
Nenhum financeiro paralelo. Delivery/retirada já são `service_sessions kind='delivery'`; o recebimento continua sendo
`close_service_session` (pagamentos, movimentos, caixa aberto do operador, troco do servidor). Nada de `payment_status` em
`delivery_orders`: o status financeiro é **derivado**.

## Status financeiro derivado (`delivery_financial_status`)
| Status | Regra |
| --- | --- |
| `pending` | sessão aberta, total > 0, pedido não cancelado (vale também antes da entrega: recebimento antecipado) |
| `paid` | sessão fechada com pagamento registrado (estorno parcial continua `paid`) |
| `refunded` | estornos >= pagamentos |
| `no_charge` | cancelado, ou total zero (aberta sem valor / fechada sem pagamento) |

`entregue`/`retirado` **não** significam pago. "Pago" só aparece com pagamento real registrado (o rótulo antigo baseado em
`payment_timing='on_order'` foi removido).

## Banco
- `list_delivery_receivables(company, paid_hours=24)`: owner/admin/cashier. Pendentes de **qualquer data** + pagos/estornados recentes.
- `list_delivery_orders`: ganhou `financial_status` e `paid_amount` (demais chaves iguais).
- `receive_delivery_order(delivery_order, payments, client_request_id)`: **idempotente**; delega a `close_service_session`
  (mesmo total, troco, caixa aberto PT412, permissões). Mesmo request ⇒ devolve o recebimento confirmado (`replayed`); outro request
  para pedido já recebido ⇒ PT409. Grava o evento `payment_received` (forma esperada x real, operador, horário; sem dados pessoais).
- Índice único: no máximo 1 `payment_received` por pedido. Índice parcial para as sessões de delivery abertas.

## Frontend
- Caixa: filtros **Todos / Comandas-Mesas / Delivery-Retirada / A receber (n)**; cards `DELIVERY #E34007` / `RETIRADA #E34008`
  (cliente, situação operacional e financeira, total, forma pretendida, troco para). Busca por cliente, código curto, telefone, tipo e forma.
  Enter com um único resultado abre a conta (comanda/mesa e código de barras continuam com prioridade).
- Clicar abre a mesma tela de conta; "Receber / Fechar conta" pré-preenche forma pretendida e valor entregue ("troco para"), tudo editável;
  o servidor decide o troco. Um `client_request_id` por abertura do diálogo (retry/duplo clique nunca duplica).
- Delivery: selo financeiro derivado ("A receber"/"Pago"/"Estornado"/"Sem cobrança") no quadro e no detalhe.
- "Receber no Caixa" no detalhe do Delivery continua como atalho.

## Fora desta fase
Fiado/contas a receber, acerto do entregador, carteira do entregador, Pix/Meta/Asaas automáticos, estorno automático.

## Publicação (somente com autorização)
`db push` → harness `.claude/remote/delivery-receipt-race.mjs` (empresa sintética) → deploy do frontend. Os 5 pedidos reais pendentes de
20/10 passam a aparecer em "A receber" e **não** são alterados automaticamente.

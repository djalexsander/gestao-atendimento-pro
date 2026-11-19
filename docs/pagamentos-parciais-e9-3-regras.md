# E9.3 — Indicadores de status de pagamento (local; nada no remoto)

Código: `features/cash/paymentStatusView.ts` (puro), `usePaymentStatus.ts` (hooks), integração em `ServicePointsPanel.tsx` e `SessionOrderScreen.tsx` (patch parcial; as mudanças do Balcão ficaram de fora). Só EXIBIÇÃO: nenhuma ação financeira. Testes: `payment-status-view.mjs`, mutação de 30 casos.

## Quando aparece
- Só com o módulo `partial_payments` ligado para a empresa e papel owner, admin, cashier ou attendant (`paymentChipsEnabled`). Desligado ou outro papel: os hooks **não chamam o banco** e a tela fica como era.

## O que mostra
- Chip por conta: rótulo de `paymentStatusLabel` (closed, no_charge, unpaid, partial, paid) e tom (pendente/pago/neutro).
- **Linha de valores só para owner/admin/cashier**, e só quando o servidor devolveu os valores: parcial = "Recebido X · Saldo Y"; sem pagamento = "Saldo Y"; quitada = "Total X"; excedente = "Recebido a mais X"; dividida = "Dividida · N partes pendentes" / "Dividida · partes quitadas" / "Divisão desatualizada" (partes acima do total ou valor fora das partes).
- **Atendente vê só o status**, nunca valor (o banco já não envia; a view também não monta).

## Fontes de dados
- Painel de comandas/mesas: **uma** chamada em lote (`list_session_payment_overview`), só a resposta mais nova vale; falha de leitura mantém o que havia.
- Tela do pedido: owner/admin/cashier leem o estado completo (`get_session_financial_state`); atendente lê `get_session_payment_status`. Reatualiza a cada 30 s com a aba visível, ao voltar para a aba e quando os pedidos mudam.

## Regras de integração
- O botão tradicional de fechar conta some quando a conta já tem atividade parcial (`hasPartialActivity`); sem o módulo nada muda.
- Delivery/retirada não recebem chip nesta etapa (a visão geral é só de comanda/mesa).

# E9.1 — Leitura financeira no banco (local; nada no remoto)

Migration `supabase/migrations/20261215010000_partial_payments_read_model.sql`. Rollback `supabase/rollbacks/partial-payments-read-model/rollback.sql`.

## Chave por empresa (D1)
Módulo `partial_payments` criado INATIVO, sem preço e fora do catálogo. Nenhuma empresa é liberada pela migration. Só o operador liga uma empresa, com `company_module_overrides` (motivo obrigatório, expiração opcional; vencido, desliga sozinho). Mesmo mecanismo já usado por delivery/whatsapp.

## `list_session_payment_overview(empresa)` (leitura)
- Exige o módulo ligado (PT403 "não está habilitado"), vínculo (PT404 sem vínculo/outra empresa) e papel.
- owner/admin/cashier: valores (total, recebido líquido, saldo, excedente, divisão, não distribuído, partes pendentes). attendant: SÓ `service_session_id`, `service_point_id`, `session_status`, `payment_status` (D4). production/courier: PT403.
- Só comandas/mesas ABERTAS da empresa (sem fechadas, sem delivery); até 500, com `total_open` e `truncated`.

## `report_period` (D2/D3)
Módulo DESLIGADO: resultado idêntico ao anterior (comparado, JSON inteiro, com a versão anterior instalada ao lado). LIGADO:
- `sales.refunded` = só devoluções; o estorno que recompõe saldo (E6) vai em `sales.corrections`, `refunds.corrections` e `cash.correction_refund_total` (o `refund_total` físico segue igual).
- `methods`: pagamentos das vendas FECHADAS no período (`paid`), com `corrections` e `refunded`; `net` soma = venda líquida.
- `open_accounts`: recebido no período em contas ainda não encerradas (accounts, received, corrections, net) — nunca misturado com venda fechada.

## `cash_session_totals`
Coluna nova no fim (`correction_refund_total`); as 14 anteriores intactas. Auxiliar `partial_payments_refund_restores(empresa, estorno)` (DEFINER, só devolve true para membro da empresa).

## Fora do escopo (decidido)
RPCs de escrita das E3–E8 NÃO foram alteradas e continuam sem a chave por empresa; a trava de escrita por empresa é decisão da próxima etapa. Sem fiado. Frontend e PDV intocados.

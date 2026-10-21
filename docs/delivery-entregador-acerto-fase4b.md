# Fase 4B — Recebimento pelo entregador e acerto com o Caixa

Status: implementado **localmente** (migration `20261025010000_courier_settlement.sql` NÃO aplicada; nada publicado).

## Modelo

O entregador recebe na rua; o dinheiro **não entra no caixa** até o Caixa confirmar o acerto.

1. **Custódia** — `courier_register_payment`: grava um recibo em `delivery_courier_receipts` (status `held`). Não cria `service_payments`, não cria `cash_movements`, não fecha a sessão. O pedido continua "pendente" no financeiro oficial; a tela mostra "Com entregador · aguardando acerto".
2. **Acerto** — `settle_courier_receipts` (owner/admin/cashier, caixa aberto): para cada recibo chama o núcleo oficial `receive_delivery_order` (a mesma rotina do recebimento no Caixa: pagamento + movimento + fechamento da sessão). Tudo numa transação; falha em um recibo desfaz todos.
3. **Anulação antes do acerto** — `void_courier_receipt` (owner/admin, com motivo). Histórico preservado (`voided`). Depois do acerto vale o estorno oficial.

Financeiro continua DERIVADO (`pending → paid`); não existe tabela de pagamento paralela.

## Tabelas

- `delivery_courier_receipts`: um recibo VIVO (`held`/`settled`) por pedido (índice único parcial), `client_request_id` único por empresa, valor/forma/valor recebido/troco/obs, status `held|settled|voided`, vínculos com acerto. Sem DELETE; valor imutável.
- `delivery_courier_settlements`: idempotência e resultado do acerto (`client_request_id` único por empresa).
- Eventos de auditoria: `courier_payment_received`, `courier_payment_voided`, `courier_settlement_completed`.
- Trigger de custódia em `service_sessions`: enquanto há recibo `held`, a sessão NÃO fecha por fora (recebimento direto no Caixa dá PT409); só dentro do acerto (GUC local à transação `gap.courier_settlement`).

## RPCs

| RPC | Quem | Efeito |
|---|---|---|
| `courier_register_payment(delivery_order, method, amount_received, client_request_id, note)` | entregador atribuído | custódia (idempotente) |
| `list_courier_settlements(company)` | owner/admin/cashier | fila por entregador |
| `settle_courier_receipts(company, courier, receipt_ids, client_request_id)` | owner/admin/cashier | acerto oficial (idempotente) |
| `void_courier_receipt(receipt, reason)` | owner/admin | anula antes do acerto |
| `list_delivery_orders` / `list_delivery_receivables` | — | passam a trazer `courier_custody` |

Erros: PT403 papel, PT404 não encontrado, PT409 já pago/já acertado/duplicado, PT412 caixa fechado.

## Regras de segurança

- Entregador só registra em pedido **atribuído a ele**, em rota/entregue, tipo delivery; pedido já pago → "Pagamento já recebido".
- Entregador nunca abre caixa; attendant/production não confirmam nem veem acertos; RLS por empresa; ACL fechada (`anon` sem acesso, helpers internos sem EXECUTE).
- Relatórios e totais de caixa só mudam no acerto (só então existem pagamento e movimento).

## Interface

- **Entregador (celular, 390px)**: bloco "Receber do cliente" (forma, valor entregue, troco) → "Recebido por mim · aguardando acerto no Caixa". Pedido pago mostra "Pagamento já recebido".
- **Caixa**: aba "Acerto de entregadores" (cards por entregador, total e formas) → diálogo com recibos marcáveis, total selecionado, "Confirmar acerto"; owner/admin veem "Anular". Caixa fechado abre o diálogo de abertura. Cards em "A receber" mostram "Com entregador · aguardando acerto". Tela do pedido mostra aviso de custódia e esconde "Receber / Fechar conta".
- Clique duplo protegido (trava síncrona + id de requisição estável por tentativa).

## Testes

- DB: `delivery-courier-settlement.mjs` (105), `delivery-cash-receipts.mjs` (70, regressão 4A), mutação `mutate-courier-settlement.mjs` (27 mutantes: 27 mortos, 0 sobreviventes, 0 inválidos), `courier-settlement-race-smoke.mjs` (87, casos C1–C5 nas duas ordens de corredores).
- Regressão completa do banco (`run-all`): 5270 checks ok, 2 falhas, 1 suíte abortada (81 suítes). As falhas são baseline anterior à 4B e idênticas com e sem a migration da 4B: `module-entitlement` G2 e o aborto de `production.mjs` (`type public.whatsapp_conversations does not exist`). `acl2.mjs`: auditoria OK.
- Frontend/Edge (`run-all`): 2252 ok, 0 falhas (inclui `courier-settlement.mjs`, 44).
- Concorrência remota (`.claude/remote/courier-settlement-race*.mjs`): casos C1 (duplo clique do entregador), C2 (dois registros concorrentes), C3 (duplo clique do acerto), C4 (entregador registra enquanto o Caixa recebe), C5 (dois acertos concorrentes). "Pedido já pago antes do registro" é coberto sequencialmente no banco (D.*). Criada, **somente dry-run**; exige `COURIER_SETTLEMENT_RACE_AUTHORIZED=endbovcvhfvaynqjronl`. Nenhuma execução remota.

## Typecheck oficial do frontend

Usar **`npx tsc -p apps/web/tsconfig.app.json --noEmit`** (o mesmo que `tsc -b` do build). `tsc --noEmit -p .` em `apps/web` NÃO é válido: o `tsconfig.json` raiz é só de referências (`files: []`) e não checa nada.

## Fora do escopo

Fiado, Pix/Asaas automático, conciliação, maquininha, comissão/taxa/folha do entregador.

## Publicação futura (não feita)

`db push` da migration → deploy do front → harness de corrida remota → homologação. O release oficial seguirá a regra fixa: PWA/Web, Desktop Tauri e Agente de Impressão sobem juntos.

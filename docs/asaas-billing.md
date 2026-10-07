# Cobrança Asaas e controle comercial por módulos

Estado (v1.0.5): código, migrations (`20261006020000` … `20261007020000`) e Edge Functions (`billing-charge`, `billing-worker`,
`asaas-webhook`) **validados no Asaas SANDBOX**. O ambiente remoto está em `ASAAS_ENV=sandbox`.

> **PUBLICAÇÃO PARA USUÁRIOS REAIS BLOQUEADA ATÉ A TROCA CONTROLADA PARA ASAAS PRODUÇÃO.**
> O código só aceita `ASAAS_ENV=sandbox` e a URL do Sandbox está em `supabase/functions/_shared/asaas-core.ts` (`ASAAS_SANDBOX_BASE_URL`);
> uma chave com `_prod_` é recusada. A virada para produção exige alteração de código + secrets + novo webhook, feita de forma controlada.

## Decisões fechadas
- Cobrança **avulsa Pix por fatura local** (sem assinatura Asaas, sem Checkout, sem Pix Automático, sem cartão).
- `invoices` é a fonte de verdade (competência, vencimento, valor, carência, bloqueio). O `OVERDUE` do Asaas é **informativo**:
  `grace` (D+1..D+3) e `restricted` (D+4) vêm de `invoices.due_date` (`billing_debt_of`, só faturas `recurring`).
- No máximo **uma cobrança Asaas ativa por fatura** (`asaas_charges_one_active_per_invoice`); `externalReference` = `gestao-atendimento-pro|invoice|<id>`.
- `pending_payment`, `restricted`, `suspended`, trial expirado e assinatura cancelada = **somente leitura** (`company_access_state` /
  `guard_company_writable`, erro `PT402`). Login, leitura, Meus Planos, pagamento e faturas seguem liberados. Única escrita permitida:
  fechar o caixa que já estava aberto (`guard_cash_session_writable`).
- Só o **owner** contrata, paga e altera módulos. CPF/CNPJ do customer vem de `companies.document`. Customer e IDs são próprios deste projeto.
- Ciclo diário (`run_billing_cycle`, cron 00:05 São Paulo): aplica remoções vencidas → gera mensalidades (10 dias antes) → reconcilia estados.
  O estado comercial muda no ciclo, então há uma janela de até ~5 min após 00:00 em D+4.

## Fluxo de cobrança
```
tenant_subscribe (owner) ─► subscription pending_payment + invoice initial (vence hoje); o trial é CONVERTIDO na contratação
invoices INSERT ─► trigger ─► billing_jobs (outbox, sem HTTP no banco)
cron (5 min, só se há trabalho) ─► pg_net ─► Edge billing-worker ─► billing_claim_charge (reserva/lease)
   ─► customer (lease; localiza por externalReference/documento antes de criar) ─► POST /payments (PIX) ─► grava id ─► QR/Pix
frontend ─► Edge billing-charge {invoice_id}  (mesmo caminho, idempotente)
Asaas ─► Edge asaas-webhook (token) ─► reconsulta GET /payments/{id} ─► billing_event_apply
   RECEIVED/CONFIRMED ─► billing_settle_invoice_gateway ─► invoice paid ─► assinatura active (libera na hora)
```

## Secrets (somente servidor — nunca `VITE_`, nunca git)
| Secret | Uso |
|---|---|
| `ASAAS_ENV` | `sandbox` (qualquer outro valor é recusado) |
| `ASAAS_API_KEY` | chave do **Sandbox** deste projeto (chave com `_prod_` é recusada) |
| `ASAAS_WEBHOOK_TOKEN` | mesmo token do webhook no painel (header `asaas-access-token`, comparação em tempo constante) |
| `BILLING_WORKER_SECRET` | segredo interno cron→worker (≥ 32 caracteres, header `x-internal-secret`) |

Vault do banco (para o `pg_net` do cron): `BILLING_WORKER_URL` e `BILLING_WORKER_SECRET`. Webhook: `https://<ref>.supabase.co/functions/v1/asaas-webhook`,
eventos `PAYMENT_*`. O Sandbox só enviou `PAYMENT_RECEIVED`/`PAYMENT_CREATED` nos testes.

## Eventos e anomalias
`PAYMENT_RECEIVED`/`CONFIRMED` (baixa), `PAYMENT_OVERDUE` (informativo), `DELETED`/`RESTORED`, reembolso, chargeback e dunning (anomalias),
`CREATED`/`UPDATED` (só exibição). Idempotência por `event_id`. Anomalias (`billing_anomalies`, tela `/master/anomalias`): `value_mismatch`,
`reference_mismatch`, `invoice_not_found`, `unexpected_payment`, `company_mismatch`, `paid_void_invoice`, `duplicate_payment`,
`payment_not_found_in_asaas`, `payment_restored`, `refund`, `chargeback`, `dunning`, `charge_job_failed`.

## Meus Planos (frontend)
Plano, status, valor mensal, **próximo vencimento** (fatura aberta mais antiga; senão `billing_next_due_date`, calculado pelo motor: próxima competência
não faturada + `billing_day` + clamp 29/30/31), situação da mensalidade, módulos (Disponível / Aguardando pagamento / Contratado / Remoção agendada),
histórico, Pix. `CommercialProvider` consulta estado e entitlement ao entrar, ao voltar à aba, a cada minuto, a cada PT402 e após pagamento (sem logout).

## Módulos
- **ADIÇÃO** (assinatura ativa): fatura `module_addition` com cobrança proporcional imediata e Pix; o módulo fica "Aguardando pagamento" e só ativa na baixa
  (trigger `invoices_module_addition_paid`). Fórmula no servidor: `round_half_up(preço × dias_restantes / dias_do_ciclo)`, ciclo pelas mesmas
  `invoice_due_date`/`billing_day`. Abaixo de R$ 5,00 (mínimo do Pix): sem cobrança, agenda no próximo ciclo. Uma solicitação aberta por assinatura;
  anulada ao cancelar, expirar (due+2 dias) ou quando a próxima mensalidade é gerada. O `billing_day` nunca muda; a próxima mensalidade cobra tudo cheio.
- **REMOÇÃO**: agendada (`subscription_pending_changes`), sem estorno nem crédito; o módulo segue ativo até o fim do ciclo pago. Se a próxima mensalidade já
  foi emitida, vai para o ciclo seguinte e a emitida não é editada. Permitida em active/grace/past_due; bloqueada em restricted.
- **ENTITLEMENT** (`company_entitlement`, `tenant_get_entitlements`, `assert_company_module`): assinatura vigente → só `subscription_modules` ativos
  (o trial convertido nunca concede); sem assinatura e trial vigente → todos; `pending_payment`/trial expirado/convertido sem assinatura → nenhum extra;
  empresa antiga sem trial nem assinatura (`unmanaged`) → todos (compatibilidade). O Plano Base não concede extras.
  Backend: 27 RPCs exclusivas de módulo barram com `PT403` e há RLS restritiva nos históricos de estoque e financeiro. Frontend: `ModuleGate` nas rotas e
  "contratar" na sidebar. Dados nunca são apagados; ao contratar de novo, voltam.
- Mapa: **Financeiro** = visão financeira, contas a receber, contas a pagar; **Produção/KDS** = painel, fila, histórico, setores; **Estoque** = movimentações e
  controle; **Impressão Avançada** = etiquetas, impressoras de etiqueta, Print Agent. Relatórios fica fora do Financeiro por decisão de produto.
  Fora da barreira de propósito: pedido que consome estoque e ticket de pedido ao agente já pareado.

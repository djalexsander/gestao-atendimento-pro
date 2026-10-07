# Cobrança Asaas e controle comercial por módulos

Estado (v1.0.5): código, migrations (`20261006020000` … `20261007020000`) e Edge Functions (`billing-charge`, `billing-worker`,
`asaas-webhook`) **validados no Asaas SANDBOX**. O código suporta `ASAAS_ENV=sandbox` e `ASAAS_ENV=production`, mas o ambiente remoto
continua em `sandbox` até a troca controlada.

> **PUBLICAÇÃO PARA USUÁRIOS REAIS BLOQUEADA ATÉ A TROCA CONTROLADA PARA ASAAS PRODUÇÃO** (secrets + webhook de produção + redeploy).

## Ambientes (`ASAAS_ENV`)
| `ASAAS_ENV` | URL base da API | Chave | Webhook |
|---|---|---|---|
| `sandbox` | `https://api-sandbox.asaas.com/v3` | chave do Sandbox (marcador `_hmlg_`) | painel Sandbox + token próprio |
| `production` | `https://api.asaas.com/v3` | chave de produção (marcador `_prod_`) | painel de produção + token próprio |

- A URL é escolhida em **um único lugar**: `getAsaasBaseUrl()` em `supabase/functions/_shared/asaas-core.ts`, via `readAsaasConfig()`. `billing-charge`,
  `billing-worker` e `asaas-webhook` (reconsulta `GET /payments/{id}`) criam o cliente da MESMA configuração, então customer, payment, Pix e reconsulta
  nunca misturam ambientes.
- Falha fechada: `ASAAS_ENV` ausente, vazio ou diferente de `sandbox`/`production` (comparação exata, sem fallback) => 503 e nenhuma chamada ao Asaas.
  Chave de produção em `sandbox` e chave de homologação em `production` também são recusadas.
- A arquitetura é a mesma nos dois ambientes: as **invoices locais continuam a fonte da verdade**; o Asaas só cobra e avisa. Cada ambiente tem a sua
  própria API key, o seu customer e o seu webhook/token — dados de um ambiente não existem no outro (trocar de ambiente exige novo cadastro de
  customers e novo webhook; cobranças já criadas no Sandbox não são migradas).
- Os logs podem citar o ambiente (`sandbox`/`production`), nunca a chave, o token, o segredo do worker ou o payload Pix.

## Conta compartilhada e isolamento por ambiente
A conta Asaas de **produção** é compartilhada com outros sistemas (intencional). O Gestão Atendimento Pro se isola por API key, webhook e token próprios,
`externalReference` próprio (`company:<id>` no customer, `gestao-atendimento-pro|invoice|<id>` na cobrança), customer e payment próprios e **ambiente explícito**.
- `company_asaas_customers (company_id, environment)`: o customer de cada empresa por ambiente (uma empresa tem um customer Sandbox e outro Production).
  `company_billing_profiles` guarda só dados comerciais; a coluna antiga `asaas_customer_id` é LEGADO (histórico Sandbox congelado).
- `environment ('sandbox'|'production')`, NOT NULL e sem default, em `asaas_charges`, `asaas_webhook_events` e `billing_anomalies`. Histórico existente = `sandbox`.
- Unicidade por ambiente: `(environment, asaas_customer_id)`, `(environment, asaas_payment_id)`, `(environment, event_id)` e uma cobrança ativa por `(fatura, ambiente)`.
- `billing_gateway_settings` guarda o **ambiente ativo** do banco. Toda RPC `billing_*` de serviço recebe `p_environment` da Edge e **recusa** se divergir do ativo
  (Edge `production` com banco `sandbox`, ou o contrário, falha fechada). Telas do cliente e do Master leem só as cobranças do ambiente ativo.
  A virada é deliberada e só por quem tem o banco: `select billing_set_active_environment('production')`.
- Customer: busca **somente** por `externalReference = company:<id>`; nunca por CPF/CNPJ (não adota customer de outro sistema). Não achou => cria.
- Pagamento **estrangeiro** (payload ou pagamento verificado com `externalReference` que não começa com `gestao-atendimento-pro|invoice|`): registrado como evento
  `ignored` com resultado `ignored_foreign_payment`, HTTP 200, sem reconsulta quando o payload já mostra a referência alheia e **sem** anomalia, baixa, job ou
  alteração de fatura. Só o que tem o NOSSO prefixo é validado com rigor (fatura inexistente/ referência malformada => anomalia).
- Compatibilidade transitória: as assinaturas antigas (sem ambiente) existem como wrappers que operam como `sandbox`, só para a Edge já publicada continuar
  funcionando até o redeploy. Devem ser removidas em migration posterior, logo depois do redeploy das Edge Functions novas.

### Sequência da virada para produção (controlada)
1. Redeploy das 3 Edge Functions novas (ainda em `sandbox`) e migration que remove os wrappers transitórios.
2. Criar o webhook de produção (URL do projeto, eventos `PAYMENT_*`) com o token de produção.
3. `supabase secrets set ASAAS_ENV=production ASAAS_API_KEY=<chave de produção> ASAAS_WEBHOOK_TOKEN=<token de produção>`.
4. `select billing_set_active_environment('production')` (até este passo as Edge de produção são recusadas pelo banco).
5. Primeiro teste com valor mínimo (R$ 5,00) em empresa de teste; o customer de produção é criado na primeira cobrança.

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
| `ASAAS_ENV` | `sandbox` ou `production` (qualquer outro valor é recusado) |
| `ASAAS_API_KEY` | chave do ambiente escolhido (cada ambiente tem a sua; chave de outro ambiente é recusada) |
| `ASAAS_WEBHOOK_TOKEN` | mesmo token do webhook cadastrado no painel do ambiente (header `asaas-access-token`, tempo constante) |
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

# E9 — Plano: consumidores do novo estado financeiro (Balcão, Caixa, relatórios, PDV)

**Status: PLANEJAMENTO. Nada implementado.** Depende de aprovação. PDV de produção intacto; sem migration remota, push, tag ou deploy.
Base: E1–E8 aprovadas localmente (commits `30caa00` e `6eb7760`). Metodologia de testes: ver seção 9.

## 1. O que existe no banco (E1–E8) e que ninguém consome ainda
| RPC | Papéis | Uso |
|---|---|---|
| `get_session_financial_state(sessão)` | owner/admin/cashier | total, pago, estornado, saldo, excedente, partes, não distribuído |
| `get_session_payment_status(sessão)` | + attendant | só `session_status` e `payment_status` (sem valores) |
| `register_service_payment(...)` | owner/admin/cashier | pagamento parcial, com parte/alocações, idempotente |
| `replace_session_split` / `get_session_split_history` | owner/admin/cashier | divisão por pessoas, valores ou produtos |
| `refund_open_session_payment(...)` | owner/admin | estorno em conta aberta (recompõe saldo) |
| `close_settled_service_session(sessão, request)` | owner/admin/cashier | encerra conta quitada |
**Auditoria do frontend:** `apps/web/src` não chama NENHUMA dessas RPCs. O Caixa só conhece `close_service_session` (pagar tudo e fechar), `refund_service_payment` (conta fechada) e `receive_delivery_order`. Hoje uma conta que receba pagamento parcial (por SQL/teste) **não pode ser fechada pela UI** (o gatilho bloqueia o legado) e **some das somas de venda** até ser encerrada. Por isso a E9 precisa vir antes de qualquer uso real em produção; o recurso fica **desligado por padrão** (D1).

## 2. Consumidores auditados, achados e mudanças necessárias
### 2.1 Banco (leitura/relatório)
| Consumidor | Achado | Mudança proposta |
|---|---|---|
| `report_period` (última definição `20261014090000`) | **Vendas** = soma de `total_amount` das contas fechadas por `closed_at` (correto com a E8). **Formas de pagamento** = `service_payments` por `created_at`: pagamento parcial de conta ainda aberta (ou fechada em outro dia) aparece em "recebido" sem a venda correspondente. **Estornos** (`service_refunds` por `created_at`) incluem os estornos E6 que **recompõem saldo** (correção, não devolução de venda): a venda líquida (bruto − estornos) ficaria subestimada. | Excluir `restores_balance` do total "estornado" e expor à parte (`corrections`); separar "recebido em contas abertas" (pagamentos de contas ainda não encerradas) da conciliação por forma. Compatível: só campos novos no JSON. |
| view `cash_session_totals` | `total_sold` = soma de movimentos `sale` (cada pagamento parcial já é um movimento): **correto**. `refund_total` mistura estorno de conta fechada com estorno E6 (correção). | Acrescentar colunas no FIM da view (`adjustment_refund_total`); colunas atuais inalteradas. |
| `cash_session_physical_cash` / `close_cash_session` | Já considera movimentos de venda e estorno em dinheiro (E3/E6); fechamento de caixa não depende de contas abertas. | Sem mudança; teste de conferência (pagamento parcial em dinheiro entra no físico). |
| `service_points_panel` (painel de comandas/mesas) | Não traz valor nem estado de pagamento. | **Nova** RPC de leitura em lote `list_session_payment_overview(company)` (owner/admin/cashier: valores; attendant: só status), sem alterar a existente. |
| `delivery_financial_status`, `list_delivery_receivables`, liquidação de entregadores, `receive_delivery_order` | Delivery/retirada fora do escopo (E3 e E8 só valem para comanda/mesa); só somam `service_payments` de sessões `delivery`. | Nenhuma. Teste de regressão dirigido. |
| Contas a receber (fiado), clientes | Independentes (`receivables`); fechamento da E8 não cria fiado. | Nenhuma; decisão D5 (fiado com saldo) fica fora. |
| `company_user_has_activity` | Pagamento parcial já conta como atividade do operador. | Nenhuma. |
| WhatsApp/IA | Pedidos por WhatsApp são delivery/retirada ou mesa sem pagamento; não consomem `service_payments`. | Nenhuma; a IA não vê valores financeiros. |
### 2.2 Frontend (`apps/web/src`)
| Arquivo | Papel hoje | Mudança |
|---|---|---|
| `features/cash/cashApi.ts` / `cashLogic.ts` | RPC de caixa; lógica de centavos/troco | novos wrappers tipados (estado, pagamento parcial, divisão, estorno aberto, encerrar) e lógica pura (saldo, parte, idempotência) — sem mexer em `closeAccount` |
| `features/cash/CashDialogs.tsx` | diálogo de receber (tudo e fechar) e de estorno | **não alterado**; novo diálogo de conta (parcial/divisão) em arquivo novo |
| `features/operations/ServicePointsPanel.tsx`, `OpenAttendancesBoard.tsx`, `openSessions*.ts` | painel de comandas/mesas e atendimentos abertos | chip de status de pagamento (pago/parcial/quitada) e, só para caixa/admin, saldo; atenção: `ServicePointsPanel.tsx` tem alterações locais não commitadas (Balcão/Caixa etapas A–B) — resolver antes |
| `features/orders/SessionOrderScreen.tsx`, `Cart.tsx` | tela do atendente | só status (sem valores) |
| `features/dashboard/dashboardLogic.ts`, `features/financial/*` | indicadores e visão financeira (vendas por fechamento) | seguir o relatório corrigido; rótulo "recebido em contas abertas" e "correções de pagamento" |
| `.claude/shell-preview/pdv.html` (`localhost:5181/pdv.html`) | layout aprovado do PDV (stub, não produção) | contrato de integração e atualização do stub com os novos estados; **produção intocada** |
| `accessRules.ts` | guardas por papel | sem mudança de papéis; novas telas reaproveitam as rotas do Caixa |

## 3. Regras de interface (R9)
1. **Fluxo clássico preservado:** conta sem parcial e sem divisão continua com "Receber e fechar" (legado). O novo fluxo aparece só quando o recurso está ligado e o operador escolhe "Receber parcial" ou "Dividir".
2. **Estado sempre do servidor:** a tela mostra o que `get_session_financial_state` devolve; nunca recalcula saldo no cliente para decidir. Cada ação envia o saldo esperado (`p_expected_balance`) para detectar mudança por outro operador (PT409 → recarregar e orientar).
3. **Idempotência:** `client_request_id` gerado ao abrir a ação e **reutilizado em reenvio/timeout/duplo clique**; só um novo id após sucesso, cancelamento explícito ou erro definitivo; botão travado durante o envio.
4. **Múltiplas formas de pagamento:** cada forma é um pagamento separado (um `register_service_payment` por forma, cada um com seu id); dinheiro com valor entregue e troco; nunca somar formas em um único pagamento.
5. **Divisão:** por pessoas (iguais), valores ou produtos; mostrar "não distribuído" e "passa do total" como bloqueios com instrução ("refaça a divisão"); alterar a divisão cria nova versão (histórico preservado).
6. **Estorno:** só owner/admin; em conta aberta recompõe saldo (rótulo "correção de pagamento"); em conta fechada continua o estorno legado (histórico, não reabre).
7. **Encerrar:** botão habilitado só com `payment_status = paid` (ou `no_charge`); chama `close_settled_service_session`; erros do servidor mostrados como orientação (sem valores nas mensagens do banco; a UI mostra os valores do estado).
8. **Permissões:** attendant: apenas chip de status, sem valores; cashier: parcial/divisão/encerrar; admin/owner: tudo, inclusive estorno; production/courier: nada.
9. **Dinheiro/caixa:** pagamento exige caixa aberto do operador (já é regra do banco); o encerramento não exige.
10. **Aviso de conta com parcial:** o botão "Receber e fechar" legado fica oculto para essas contas (o banco já recusaria).

## 4. Riscos de duplicidade financeira (e mitigação)
| Risco | Mitigação |
|---|---|
| Duplo clique/reenvio gera 2 pagamentos | `client_request_id` estável por tentativa + travar botão; teste de lógica pura |
| Legado "pagar tudo" após parcial paga em dobro | gatilho E8 já recusa; UI oculta o botão |
| Estado desatualizado (outro operador pagou) | saldo esperado no envio; recarga em PT409 |
| Venda contada duas vezes nos relatórios (pagamento parcial + fechamento) | vendas só por fechamento (`total_amount`); recebido por forma separado; exclusão de `restores_balance` do estornado |
| Estorno E6 tratado como devolução de venda | separar "correções de pagamento" |
| Dashboard "vendas recebidas" + "contas recebidas" (delivery) | verificar `dashboardLogic` contra delivery e parcial antes de tocar |
| Fechamento de caixa com contas abertas parcialmente pagas | movimentos de venda já existem por pagamento; conferido por teste |

## 5. Plano de implementação em etapas pequenas
- **E9.1 — Leitura no banco (migration aditiva):** `list_session_payment_overview(company)` + correção de `report_period`/`cash_session_totals` (campos novos; atuais inalterados). Rollback próprio.
- **E9.2 — Camada de dados do front:** wrappers e lógica pura (centavos, parte, idempotência, textos de erro). Sem UI.
- **E9.3 — Chips de status:** painel de comandas/mesas e tela do atendente (só status/valores por papel).
- **E9.4 — Diálogo de conta no Caixa:** estado, pagamento parcial com múltiplas formas, estorno de conta aberta, encerrar.
- **E9.5 — Divisão:** pessoas, valores e produtos, histórico de versões.
- **E9.6 — Relatórios/indicadores:** rótulos e blocos novos (financeiro, dashboard).
- **E9.7 — Contrato do PDV (`5181/pdv.html`):** mapeamento estado → RPC e atualização do stub de preview; produção intacta.
- **E9.8 — Recurso ligado por empresa** (flag, D1) e homologação final com regressão completa.
Cada etapa: commit local de checkpoint só com sua aprovação.

## 6. Decisões para você
- **D1 Liberação:** recurso desligado por padrão com chave **por empresa** (recomendado) × ligado para todos.
- **D2 Relatório:** "recebido em contas abertas" como linha à parte (recomendado) × misturar às formas de pagamento.
- **D3 Estornos:** separar "correções de pagamento" (E6) de "devoluções" (conta fechada) nos relatórios (recomendado).
- **D4 Atendente:** só status, sem valores (recomendado, já é a regra do banco).
- **D5 Saldo para fiado:** fora do escopo da E9 (recomendado) × permitir "encerrar com fiado".
- **D6 Alterações locais do Balcão/Caixa (etapas A–B) pendentes no `git status`:** commitar/definir antes de E9.3 (recomendado) × tratar dentro da E9.

## 7. Impacto no PDV de produção
Nenhum arquivo de produção do PDV é alterado no planejamento. O fluxo clássico (`close_service_session`, `receive_delivery_order`) segue idêntico e é o único caminho do PDV até D1 liberar a empresa.

## 8. Segurança, isolamento e integridade (mantidos)
Todas as RPCs novas validam empresa e papel no servidor (PT404 para não vínculo/outra empresa); testes de isolamento por empresa, idempotência e conciliação financeira acompanham cada etapa que as toque.

## 9. Metodologia de testes (nova política)
- **Durante a etapa:** só testes ligados à alteração.
- **Fim da etapa:** testes da etapa + integrações impactadas.
- **Sem `run-all` por etapa**; reaproveitar resultados anteriores com código relacionado inalterado.
- **Concorrência:** só nos fluxos afetados (E9.1: leitura não grava; E9.4: pagamento parcial duplo clique × outro operador, já coberto por C1–C53 no banco; testar apenas a idempotência do cliente).
- **Mutantes:** só nas regras críticas novas (saldo esperado, idempotência do cliente, exclusão de `restores_balance` nos relatórios).
- **Testes por etapa:** E9.1 banco (relatório com parcial/divisão/estorno/fechamento, isolamento, rollback); E9.2–E9.5 lógica pura em `.claude/frontend-tests` + `tsc -b`/build + verificação no preview; E9.3–E9.5 verificação visual por papel.
- **Regressão completa:** somente na homologação final (E9.8), antes de qualquer publicação.

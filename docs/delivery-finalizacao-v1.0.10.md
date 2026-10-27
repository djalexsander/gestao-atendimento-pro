# Delivery — finalização (regras + indicadores) e checklist de homologação

Status: migration `20261029010000_delivery_rules.sql` **APLICADA no remoto em 2026-10-26** (dry-run listou só ela; 9 pedidos intactos; config inicial null/null/false). Front, commit e release **NÃO** feitos.

## Estado do remoto (verificado em leitura, 2026-10-26)
Projeto `endbovcvhfvaynqjronl` (ref do CLI = `supabase/.temp/project-ref`). `migration list --linked`: todas as migrations locais até
`20261028020000` estão aplicadas (local == remoto, sem lacunas nem ordem trocada), **incluindo 4A `20261024010000` e 4B `20261025010000`**.
RPCs existentes: `list_delivery_receivables`, `settle_courier_receipts`, `receive_delivery_order`, `courier_register_payment`,
`void_courier_receipt`, `list_courier_settlements`. Módulo `delivery` ativo no catálogo; 9 pedidos de delivery e 0 recibos de entregador.
A migration nova é a única pendente e vem DEPOIS da última remota (sem conflito de ordem).

## O que muda
| Regra | Onde | Observação |
|---|---|---|
| Pedido mínimo (entrega) | `company_delivery_settings.min_order_amount`; motor `create_delivery_order_engine` | Sobre o subtotal dos itens (sem taxa). Retirada não tem mínimo. PT409 com valores na mensagem; transação inteira desfeita (sem sessão/estoque órfãos). |
| Entrega grátis | `free_delivery_above`; `fee_source = 'free'` | Taxa de zona/padrão vira 0 ao alcançar o limite; taxa manual nunca é sobrescrita; zona preservada em `zone_id`; taxa original no evento `created` (`fee_waived_from`). Taxa gravada segue imutável (trigger existente). |
| Entregador obrigatório | `require_courier_for_dispatch` (padrão **desligado**) ; `set_delivery_status` | Só bloqueia `out_for_delivery`. |
| Troca de entregador | `assign_delivery_courier` | PT409 enquanto houver recibo `held`; `courier_register_payment` revalida o entregador depois da trava. |
| Entrega recusada | `refuse_delivery_order` (owner/admin, só em rota) | Reusa `cancel_delivery_order` (itens, estoque, impressão, fechamento oficiais) com motivo `Entrega recusada: …`; recusada se houver recibo do entregador ou pagamento não estornado (nada de estorno automático); idempotente. Item já pronto **não** devolve estoque (regra existente de `cancel_service_order_item`). |
| Indicadores | `delivery_courier_report` (owner/admin/cashier) | Entregues, em rota, aguardando, recusadas, canceladas, tempo médio, total entregue, taxas, valor em custódia. |

Configuração: RPC nova `update_delivery_rules` (owner/admin); `update_delivery_settings` **não mudou de assinatura**.
**Pedido da IA (WhatsApp) segue exatamente como antes** (mínimo/grátis só no fluxo humano) — integração Delivery×IA é a fase 2.

## Interface
- Configurações → Delivery: cartão "Regras do pedido".
- Novo pedido: mínimo bloqueia "Avançar" com a falta; mostra quanto falta para entrega grátis; taxa mostra "Entrega grátis"; **últimos pedidos do cliente** (60 dias) ao escolher o cliente.
- Detalhe: aviso e botão bloqueado quando falta entregador (se a regra estiver ligada); **ENTREGA RECUSADA** (owner/admin, em rota) com motivo; estado "Entrega recusada".
- Quadro: botão "Indicadores de entregadores" (7 dias padrão; hoje/30 dias).

## Adicionar produtos a pedido Delivery já criado — NÃO implementado (avaliação)
`delivery_orders` é 1:1 com **um** `service_order`; `delivery_order_summary`, `list_delivery_orders`, a trava "todos os itens prontos" para sair em rota,
`delivery_total` (4A/4B) e o acerto do entregador somam só os itens desse pedido. Um segundo pedido na mesma sessão faria o total do Caixa
(`close_service_session` soma a sessão) divergir do total do Delivery e deixaria itens novos fora da trava de "pronto". Exigiria mexer em ~6 funções
publicadas e no motor. Recomendação: manter "cancelar e refazer" (o cancelamento devolve estoque de item ainda pendente). Se virar requisito,
tratar como fase própria (novo `service_order` + total derivado da sessão).

## Testes executados (local)
- Banco (`run-all`): **5630 ok / 1 falha → corrigida** (`order-engine-upgrade` passou a listar a migration nova como dependente do motor, 24/24). `production.mjs` 81/81 e `module-entitlement` 31/31 (harness corrigido, ver abaixo). `acl2.mjs`: AUDITORIA OK.
- `delivery-rules.mjs`: **100 checks**; mutação `mutate-delivery-rules.mjs`: 25 mortos, 0 sobreviventes relevantes (equivalentes documentados no arquivo).
- Frontend/Edge (`run-all`): 2341 ok (+43 em `delivery-rules-logic.mjs`); ajuste de 1 asserção de `delivery-logic.mjs` (agora há 2 chamadas a `list_delivery_orders`: quadro e histórico do cliente).
- `tsc -p apps/web/tsconfig.app.json --noEmit` limpo; `npm run lint` exit 0 (67 avisos, baseline 66: +1 `set-state-in-effect` do histórico); `npm run build` OK.
- Navegador (preview PGlite com migrations reais): cartão de regras salva e recarrega 60,00/90,00; quadro e indicadores carregam via RPC real.

### Correção do harness (sem alterar regra de produção)
- `production.mjs` carregava migrations por lista de exclusão e passou a incluir migrations posteriores (WhatsApp) que dependem de tipos excluídos → abortava (`whatsapp_conversations`). Agora só carrega migrations `< 20261014` (estado que a suíte sempre validou). KDS de produção volta a rodar (81/81).
- `module-entitlement` G2 comparava `trial_ends_at > now()` (relógio real, 26/10) com o relógio de teste fixo em 07/10 → falso. Trocado por `business_now()`. A regra (trial convertido nunca concede) já passava.

## Pendências / limites honestos
1. **Concorrência real não executada**: PGlite é monoprocesso. A revalidação do entregador em `courier_register_payment` (corrida troca × registro) só se prova com 2 conexões: estender `.claude/remote/courier-settlement-race*.mjs` com o caso "registro × reatribuição" e rodar **somente com sua autorização** (dry-run existe, exige `COURIER_SETTLEMENT_RACE_AUTHORIZED`).
2. Histórico do cliente limitado a 60 dias (regra de período máximo de `list_delivery_orders`, 63 dias).
3. A recusa é identificada pelo prefixo do motivo (sem coluna nova, para não tocar a tabela publicada). Relatórios por motivo usam esse prefixo.
4. Nenhuma tela foi validada em PWA/Tauri reais nem com dados reais (a homologação abaixo cobre isso).

## Publicação (somente com sua autorização)
`db push` (só esta migration; dry-run antes) → harness de corrida remoto (opcional, empresa sintética) → deploy do front (Web/PWA + Desktop + Print Agent seguem juntos) → homologação abaixo.
O front novo é compatível com o banco antigo **só se a migration for aplicada antes** (as RPCs novas não existem no remoto hoje): publicar o banco primeiro.

## Checklist de homologação real
**Preparação (owner/admin):** em Configurações → Delivery definir pedido mínimo (ex.: R$ 40), entrega grátis (ex.: R$ 90) e ligar "exigir entregador"; ter 1 zona com taxa; 1 cliente com endereço; 1 entregador ativo.

**Atendente (computador)**
- [ ] Novo pedido de entrega com R$ 30 em produtos: "Avançar" bloqueado mostrando o mínimo; o texto mostra quanto falta para entrega grátis.
- [ ] Com R$ 90+: taxa aparece como "Entrega grátis"; total sem taxa; ao confirmar, o pedido mostra taxa R$ 0,00 (grátis).
- [ ] Mudar a taxa da zona depois: o pedido já criado **não muda**.
- [ ] Escolher o cliente: aparecem os últimos pedidos dele (ou "primeiro pedido").
- [ ] Retirada abaixo do mínimo é aceita.
- [ ] Sair para entrega sem entregador: botão bloqueado + aviso; atribuir entregador libera.
- [ ] Impressão do pedido: bloco Delivery com taxa correta (0 quando grátis).

**Cozinha/KDS**
- [ ] Item do delivery aparece na fila do setor; marcar pronto libera "Sair para entrega"; nenhuma baixa de estoque em dobro.

**Entregador (celular 390 px)**
- [ ] Vê só os pedidos atribuídos; marca "saiu para entrega" e "entregue".
- [ ] Registra recebimento (dinheiro com troco / Pix): aparece "aguardando acerto"; tentar trocar o entregador no Caixa/Delivery é **recusado**.

**Caixa**
- [ ] "A receber" mostra o pedido; acerto do entregador confirma e só então entra no caixa (uma vez).
- [ ] Recebimento duplo (Caixa + rua) impedido.
- [ ] Pedido pago antecipadamente: recusa da entrega exige estorno antes; nenhum estorno automático.

**Owner/admin**
- [ ] Pedido em rota sem valor recebido: "ENTREGA RECUSADA" com motivo → vira "Entrega recusada", conta fechada com total 0, estoque do item pronto **não** volta, caixa inalterado; repetir não duplica.
- [ ] Recusa com valor em custódia: recusada até anular o recebimento.
- [ ] Indicadores de entregadores: entregues, em rota, recusadas, tempo médio, custódia.
- [ ] Cancelar pedido comum continua funcionando (confirmado e em rota).

**Segurança**
- [ ] Attendant/cashier não veem "Entrega recusada" nem configuram regras; attendant/courier não veem indicadores.
- [ ] Usuário de outra empresa não acessa nada (RLS).
- [ ] Pedido do WhatsApp/IA continua sendo criado como antes (sem mínimo/grátis nesta etapa).

## Corrida remota (procedimento, NÃO executado)
Caso novo **C6** em `.claude/remote/courier-settlement-race-lib.mjs` (entregador registra recebimento × dono remove/troca o entregador). Smoke local OK nas duas ordens.
Executar só com autorização: `COURIER_SETTLEMENT_RACE_AUTHORIZED=endbovcvhfvaynqjronl node courier-settlement-race.mjs --execute-remote`. Cria empresa sintética (prefixo do harness) com pedidos/pagamentos
sintéticos no banco de produção e exige limpeza posterior em SQL (gerada para execução manual) — por isso não foi rodada. Alternativa mais segura: projeto Supabase de staging/branch descartável.

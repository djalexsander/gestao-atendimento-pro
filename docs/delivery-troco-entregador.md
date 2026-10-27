# Delivery — controle de troco do entregador (adiantamento, acerto bruto, diferenças)

Status: implementado **localmente**. Migration `20261030010000_courier_change_advances.sql` **NÃO aplicada** (nem commit/push/deploy). Base: v1.0.11.

## Regra operacional
Pedido R$ 52, cliente paga R$ 100 → o Caixa entrega R$ 48 de troco ao entregador **antes da saída** (confirmação explícita); o entregador cobra R$ 100,
dá R$ 48 de troco e **devolve R$ 100 ao Caixa** no acerto. Venda contabilizada: **R$ 52**. Resultado líquido no caixa: **R$ 52**.

## Livro do caixa (dinheiro FÍSICO efetivo, nunca valor fictício)
| Tipo (`cash_movements`) | Sinal | Quando |
|---|---|---|
| `courier_change_advance` | saída | Caixa entrega o troco (NÃO é sangria/despesa) |
| `courier_change_return` | entrada | devolução do adiantamento, sobra, regularização de diferença |
| `courier_settlement_shortfall` | saída | contado < parte em dinheiro da venda já lançada |

Exemplo: adiantamento −48; acerto: venda +52 (núcleo oficial `receive_delivery_order`) + devolução +48 ⇒ líquido +52 = físico (−48 + 100).
Devolução de só R$ 90: venda +52 + devolução +38 ⇒ +42 = físico (−48 + 90); **diferença R$ 10** registrada com motivo e **pendência rastreável**.
Esperado na devolução = parte em dinheiro da venda + adiantamento. `cash_session_physical_cash` (fonte única do "esperado" no fechamento, limite da sangria e do
estorno) passou a considerar os três tipos ⇒ o caixa fecha sem diferença falsa com o entregador na rua.

## Tabelas novas (RLS por empresa; escrita só por RPC; imutáveis)
- `delivery_courier_advances`: 1 vivo (aberto/acertado) por pedido; origem = caixa de quem entregou; status `open → settled | returned`.
- `delivery_courier_cash_lines`: valores brutos e líquidos (venda em dinheiro, adiantamento, esperado, contado, diferença, motivo, pendência, caixa que recebeu).
- `delivery_courier_cash_resolutions`: regularização (dinheiro recebido) ou baixa (owner/admin, motivo) de uma diferença.
- `cash_movements`: colunas `delivery_order_id`, `courier_advance_id`, `courier_line_id`, `courier_resolution_id` + índices únicos (1 saída por adiantamento, 1 movimento por linha/regularização).

## RPCs
| RPC | Quem | Efeito |
|---|---|---|
| `give_courier_change_advance` | owner/admin/cashier, caixa aberto próprio | só entrega, com entregador, pedido confirmado/em rota, conta aberta, sem recebimento do entregador; confere saldo físico; idempotente |
| `settle_courier_cash` | owner/admin/cashier, caixa aberto | acerto com dinheiro contado por recibo; venda pelo núcleo oficial + devolução + diferença (motivo obrigatório); idempotente |
| `return_courier_change_advance` | owner/admin/cashier | devolução sem venda (cancelada/recusada/não realizada); parcial exige motivo e abre pendência; nunca devolve duas vezes |
| `resolve_courier_difference` | cashier+ (receber) / owner,admin (baixa) | regulariza a pendência; idempotente |
| `get_courier_advance`, `list_courier_cash_pending` | leitura | tela do pedido / Caixa |
| `list_courier_settlements` | (mesma assinatura; chaves novas) | adiantamento, esperado e líquido por recibo |

Compatibilidade 1.0.11: `settle_courier_receipts` (4 args) continua para pedidos **sem** adiantamento e **recusa** os que têm (nunca assume valor devolvido).
`assign_delivery_courier` bloqueia troca/remoção com adiantamento aberto. Cancelar/recusar com adiantamento aberto é permitido; nada é estornado sozinho
e a pendência fica em "Pendências de troco".

## Telas
- Detalhe do pedido (Delivery): bloco "Troco do entregador" (valor sugerido = troco para − total, editável) → diálogo de confirmação → "Confirmar entrega do troco". Entregador só vê a informação.
- Caixa → Acerto de entregadores: cards com venda, troco adiantado e dinheiro esperado; diálogo com contado por pedido, motivo da diferença, venda líquida, bruto esperado, falta/sobra; botão **"Confirmar recebimento de R$ 100,00"**.
- Caixa → Pendências de troco: troco a devolver (cancelada/recusada/…) e diferenças em aberto (receber / dar baixa).

## Testes (locais)
- Banco: `delivery-courier-change.mjs` (151 checks: exemplo 52/100/48, devolução de 90, sobra, falta maior que a venda, Pix com adiantamento, vários pedidos, cancelamento/recusa com adiantamento, idempotência, ACL/RLS, imutabilidade, fechamento de caixa, integridade do livro) + `mutate-delivery-courier-change.mjs` (37 mutantes mortos, 0 sobreviventes; equivalentes documentados no arquivo).
- Regressão completa do banco: 5821 ok, 0 falhas, 0 suítes abortadas; `acl2.mjs` OK. Frontend/Edge: 2383 ok (+41 em `courier-change-logic.mjs`). `tsc`, `lint` (exit 0; 68 avisos, +1 `set-state-in-effect` do bloco de troco) e `build` OK.
- **Concorrência**: PGlite é monoprocesso. As corridas são cobertas nas duas ordens sequenciais (duplo clique do adiantamento, adiantamento × cancelamento/recebimento, acerto × devolução, regularização duplicada); a trava real (atendimento → pedido → caixa; recibos → adiantamentos) e os índices únicos garantem o resultado. **Prova com conexões reais** só com autorização (estender `.claude/remote/courier-settlement-race-lib.mjs` com: C7 dois adiantamentos simultâneos no mesmo pedido; C8 adiantamento × recebimento do entregador; C9 acerto × devolução avulsa; C10 duas regularizações da mesma diferença) em projeto de staging/branch descartável.

## Riscos / limites
1. Relatório impresso de fechamento de caixa (`printing_foundation`) ainda lista só suprimento/sangria/estorno: o **esperado** já considera o troco, mas as linhas "troco adiantado/devolvido" no cupom ficam para uma etapa própria.
2. Diferença não regularizada continua como pendência (não vira dívida automática nem desconto em folha); baixa é decisão de owner/admin, auditada.
3. Um adiantamento vivo por pedido (complemento de troco = devolver e entregar de novo).
4. A devolução entra no caixa de quem confirma; cada gaveta fica coerente com o seu dinheiro, mas o caixa de origem fechado com adiantamento aberto fecha "−48" até a devolução ser feita em outro caixa (sem compensação oculta; movimentos auditáveis em cada caixa).
5. Depois da publicação do banco, o app 1.0.11 instalado continua funcionando (acerto antigo), mas só o app novo entrega troco e acerta pedidos com adiantamento.

## Publicação futura (não feita)
`db push` (somente esta migration; dry-run antes) → deploy do front (Web/PWA + Desktop; Print Agent inalterado) → homologação: caixa abre → entrega troco → entregador cobra → acerto em outro caixa → fechamento do caixa sem diferença → devolução parcial → regularização.

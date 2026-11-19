# Pagamentos parciais — E7: proteção de cancelamentos e novos pedidos (auditoria + regras)

Escopo: só banco local isolado; nada aplicado ao remoto; PDV de produção intocado; sem E8; sem commit/push/tag/deploy.

## 1. Auditoria das RPCs existentes
| Peça | Fato (versão vigente) |
|---|---|
| `cancel_service_order_item` (printing_foundation) | **único** escritor de `service_order_items.cancelled_quantity`. Trava a conta (`FOR UPDATE of ss`) antes do item; owner/admin/cashier/attendant; attendant/cashier só item `pending`; conta fechada ⇒ PT409; devolve estoque; cancela o pedido quando não resta unidade cobrável. **Não valida nada financeiro.** |
| `submit_service_order` → `_core` → `_engine` | lê a conta **sem trava** e checa `status='open'`; só o `INSERT` em `service_orders` pega `KEY SHARE` (FK). Trava produtos controlados (ordem de id) antes. Serve comanda/mesa, WhatsApp e delivery (mesmo motor). |
| `register_service_payment` / `replace_session_split` / `refund_open_session_payment` / `close_service_session` | travam a conta `FOR UPDATE` primeiro. |
| Total vigente | `service_session_total` = Σ (quantidade − cancelada) × preço unitário dos pedidos `submitted` (+ taxa de delivery). Saldo = total − (pagamentos − estornos que recompõem). |
| Modo produtos (E1/E4) | `service_session_part_items` (item × quantidade por parte, imutável); `service_session_split_item_pool` considera "travadas" as unidades de partes QUITADAS e exige que o saldo seja igual ao valor das unidades livres. |
| E2 | já prevê `overpaid` e diz "E7 impede cancelar abaixo do pago"; `over_distributed` existe para partes que passam do total. |

## 2. Lacunas e conflitos de modelagem
| # | Conflito | Decisão |
|---|---|---|
| K1 | Cancelar pode derrubar o total abaixo do já recebido (crédito implícito / saldo negativo). Hoje nada impede. | Bloquear (E7-R1). |
| K2 | Em divisão por produtos, cancelar unidades atribuídas a uma parte deixa a parte (valor imutável) cobrando por item que não existe mais; e unidades de parte quitada são dinheiro já recebido. | Só se cancelam unidades **não atribuídas** a nenhuma parte ativa e não travadas por parte quitada (E7-R2). Para cancelar unidade atribuída: refazer a divisão (por valores/iguais) antes. |
| K3 | Cancelar em divisão por valores/iguais reduz o total, mas as partes (previsto imutável) podem passar a somar mais que o total (`over_distributed`). Bloquear tornaria o cancelamento impossível (refazer a divisão usa o saldo atual). | Permitir; E2 já mostra `over_distributed`; o pagamento continua limitado ao saldo da conta (E3 R-7); corrige-se refazendo a divisão. |
| K4 | (hipótese inicial: "pedido novo junto do fechamento entra em conta fechada"). **Refutada na auditoria do catálogo:** já existe o gatilho `service_orders_session_open` (20260929040000) que, em todo `INSERT` em `service_orders`, relê o status da conta sob `FOR SHARE` (espera o fechamento em curso) e recusa conta não aberta. | A E7 **não** cria gatilho de pedido; só testa (R5) e inclui a corrida pedido × fechamento. |
| K5 | A ordem de travas do motor (produtos → conta) é oposta à do cancelamento (conta → produto): possível deadlock **já existente** com produto de estoque controlado. | Fora do escopo (não alterar o motor compartilhado com delivery/WhatsApp); registrado como risco. |
| K6 | O attendant não vê valores. | Mensagens de recusa **sem valores em reais**. |

## 3. Regras (E7-R)
1. **R1 — nunca abaixo do recebido.** Em conta aberta de comanda/mesa, cancelar unidades só se o total depois do cancelamento ≥ valor aplicado (pagamentos − estornos que recompõem saldo). Senão PT409 e nada muda (o cancelamento inteiro, estoque inclusive, é desfeito). Para cancelar mais é preciso antes estornar (E6).
2. **R2 — unidades protegidas.** Unidades atribuídas a partes da divisão ATIVA, ou a partes QUITADAS de qualquer versão, não podem ser canceladas (PT409). Livres = cobrável − protegidas. Vale também para qualquer outro escritor (a regra está num gatilho do banco, não só na RPC).
3. **R3 — novos pedidos** continuam permitidos em conta aberta com pagamento parcial, divisão ativa ou substituída: o saldo sobe, nada é redistribuído, as unidades novas ficam sem parte (modo produtos) e o "não distribuído" sobe.
4. **R4 — preservação.** Pagamentos, estornos, alocações, partes, itens de parte e eventos nunca são alterados. A E7 não escreve em nenhuma dessas tabelas.
5. **R5 — pedido só em conta aberta**, decidido sob trava, nunca depois do fechamento: já garantido pelo gatilho existente `service_orders_session_open` (a E7 só o cobre com testes unitários e de corrida).
6. **R6 — escopo.** Delivery/retirada e contas fechadas: sem qualquer mudança. Contas sem pagamento e sem divisão: comportamento idêntico ao de hoje. As RPCs `cancel_service_order_item` e `submit_service_order*` não são alteradas (corpo idêntico); a proteção vive em UM gatilho (`service_order_items_guard_partial_cancel`) e uma função interna de leitura.
7. **R7 — fechamento legado** continua bloqueado (gatilho da E3/E5 intocado) até a E8.
8. **R8 — permissões** inalteradas: quem podia cancelar continua podendo, nas mesmas condições; as novas recusas valem para todos os papéis, owner/admin inclusive.

# WhatsApp — Acompanhamento automático do pedido (Fase 1, Bloco A)

Status: **implementado LOCALMENTE**. Migration NÃO aplicada no remoto, Edge Function NÃO publicada, flag NÃO ligada.

## O que faz
Quando um pedido **com vínculo oficial a uma conversa de WhatsApp** (`delivery_orders.whatsapp_conversation_id`) muda de estado,
o cliente recebe uma mensagem determinística (sem IA):

| Tipo | Quando | Texto | Validade |
| --- | --- | --- | --- |
| `ORDER_READY_PICKUP` | retirada: todos os itens ativos prontos | "Seu pedido está pronto! 🎉 Pode vir retirar quando quiser." | 2 h |
| `ORDER_READY_DELIVERY` | delivery: todos os itens ativos prontos | "Seu pedido está pronto e aguardando a saída para entrega." | 2 h |
| `OUT_FOR_DELIVERY` | delivery marcado "saiu para entrega" | "Seu pedido saiu para entrega. 🛵" | 1 h |

Não há aviso de "entregue" nem código/UUID do pedido na v1. Vencida a validade, o aviso vira `expired` e nunca é enviado.

## Elegibilidade
Fonte da verdade: `service_order → delivery_orders.whatsapp_conversation_id`. **Não** depende de `created_via`, nome, telefone ou
`customer_id`. Pedido sem vínculo (balcão, mesa, comanda, delivery manual) não gera nada. Conversa apagada (soft delete) → linha
`skipped`; vínculo divergente no envio → `skipped` (`link_invalid`). Nunca há contato por fallback.

## Arquitetura
- Migration `20261022010000_order_customer_notifications.sql` (aditiva).
- `order_is_fully_ready(company, order)`: **único** predicado de "pedido pronto", agora usado também por `push_check_order_ready`.
- Outbox `order_customer_notifications` com `UNIQUE(service_order_id, notification_type)`; triggers (exceções engolidas) só gravam
  a linha com `ON CONFLICT DO NOTHING`; lock advisory por pedido evita o "lost wakeup" entre dois usuários.
- OUT_FOR_DELIVERY antes do "pronto" ser enviado → `ORDER_READY_DELIVERY` vira `superseded`.
- Worker `whatsapp-order-notify` (Edge, `verify_jwt=false`, segredo interno): `order_notify_claim` (lease + SKIP LOCKED, expira o vencido)
  → `order_notify_prepare` (revalida flag, módulo, estado oficial, vínculo, conversa, conexão, janela de 24 h, destinatário de teste;
  mensagem `origin='system'` `queued`) → despacho oficial (`_shared/whatsapp-dispatch.ts`) → `order_notify_finish`.
- Retry: 30 s, 2 min, 10 min, 30 min, 2 h (máx. 5 tentativas; respeita a validade). `timeout`/`invalid_response` (entrega incerta)
  **não** são repetidos. Meta 131047/131026 e janela de 24 h fechada → `blocked_window` (sem retry, visível). Template Meta: fase futura.
- Funciona com `ai_control='human'` sem alterá-lo; não cria `ai_job`, não consome cota de IA, não atribui atendente.
- Falha da Meta nunca volta produção/delivery/pedido.
- Feature flag por empresa `company_whatsapp_ai_settings.order_status_notifications_enabled` (default **false**) + kill switch global
  `WHATSAPP_ORDER_NOTIFY_ENABLED="true"` (Edge Secret).
- UI: selo informativo no detalhe do delivery ("WhatsApp: ✓ Cliente avisado" / "⚠ Não foi possível avisar"); somente leitura via RLS.

## Para ligar (SOMENTE com autorização)
1. `db push` da migration. 2. Vault: `WHATSAPP_ORDER_NOTIFY_URL` e `WHATSAPP_ORDER_NOTIFY_SECRET`. 3. Deploy da função + secrets
`WHATSAPP_ORDER_NOTIFY_SECRET`, `WHATSAPP_ORDER_NOTIFY_ENABLED=true`. 4. `update company_whatsapp_ai_settings set
order_status_notifications_enabled = true where company_id = '<Djalexeventos>'`.
Desligar: flag da empresa em `false` (para de gerar) e/ou `WHATSAPP_ORDER_NOTIFY_ENABLED` diferente de `true` (para de enviar).

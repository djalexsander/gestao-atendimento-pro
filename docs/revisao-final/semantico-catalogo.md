## B. Diff semântico do catálogo (gerado por `catalog-snapshot.mjs` sobre o banco migrado)

Três fotos: **BASE** = migrations já existentes no repositório (HEAD), **M0-2** = BASE + 010000..030000, **M0-5** = BASE + 010000..060000 (estado atual).

### B.1 BASE → M0-2 (migrations 010000, 020000, 030000)

- funções NOVAS: **2** · funções EXISTENTES recriadas/alteradas: **8** · funções REMOVIDAS: **0**

**Existentes recriadas (assinatura mantida)** — o que mudou: corpo (hash), SECURITY DEFINER, search_path ou EXECUTE:

| função | corpo | definer | search_path | EXECUTE antes | EXECUTE depois |
|---|---|---|---|---|---|
| `create_delivery_order(uuid,uuid,text,jsonb,uuid,text,text,uuid,numeric,text,text,numeric,text)` | MUDOU | true→true | igual | anon=false auth=true svc=true | anon=false auth=true svc=true |
| `enqueue_order_print_jobs(uuid)` | MUDOU | true→true | igual | anon=false auth=false svc=true | anon=false auth=false svc=true |
| `guard_delivery_order_change()` | MUDOU | false→false | igual | anon=false auth=false svc=true | anon=false auth=false svc=true |
| `guard_print_job_change()` | MUDOU | false→false | igual | anon=false auth=false svc=true | anon=false auth=false svc=true |
| `guard_service_order_change()` | MUDOU | false→false | igual | anon=false auth=false svc=true | anon=false auth=false svc=true |
| `guard_service_session_change()` | MUDOU | false→false | igual | anon=false auth=false svc=true | anon=false auth=false svc=true |
| `print_actor_name(uuid,uuid)` | MUDOU | true→true | igual | anon=false auth=false svc=true | anon=false auth=false svc=true |
| `submit_service_order_core(uuid,jsonb,text,boolean)` | MUDOU | true→true | igual | anon=false auth=false svc=true | anon=false auth=false svc=true |

**Funções novas** (EXECUTE = anon / authenticated / service_role):

| função | DEFINER | EXECUTE |
|---|---|---|
| `create_delivery_order_engine(uuid,uuid,text,company_role,uuid,text,jsonb,uuid,text,text,uuid,jsonb,numeric,text,text,numeric,text,text,uuid,uuid)` | sim | anon=false auth=false svc=false |
| `submit_service_order_engine(uuid,jsonb,text,boolean,uuid,text)` | sim | anon=false auth=false svc=false |

### B.2 Objetos BASE → M0-2

- **Colunas**: +7 novos · 4 alterados · 0 removidos
  - ALTERADO `print_jobs.created_by`:
    - antes: `uuid NO `
    - depois: `uuid YES `
  - ALTERADO `service_sessions.opened_by`:
    - antes: `uuid NO `
    - depois: `uuid YES `
  - ALTERADO `service_orders.created_by`:
    - antes: `uuid NO `
    - depois: `uuid YES `
  - ALTERADO `product_stock_movements.created_by`:
    - antes: `uuid NO `
    - depois: `uuid YES `
  - novo `delivery_orders.created_via`
  - novo `delivery_orders.whatsapp_conversation_id`
  - novo `service_orders.created_via`
  - novo `service_sessions.created_via`
  - novo `print_jobs.created_via`
  - novo `delivery_orders.whatsapp_order_draft_id`
  - novo `product_stock_movements.created_via`
- **Constraints**: +18 novos · 1 alterados · 4 removidos
  - ALTERADO `delivery_orders.delivery_orders_customer_phone_check`:
    - antes: `CHECK (((customer_phone IS NULL) OR (customer_phone ~ '^[0-9]{8,13}$'::text)))`
    - depois: `CHECK (((customer_phone IS NULL) OR (customer_phone ~ '^[0-9]{8,15}$'::text)))`
  - REMOVIDO `print_jobs.print_jobs_created_by_not_null`
  - REMOVIDO `product_stock_movements.product_stock_movements_created_by_not_null`
  - REMOVIDO `service_orders.service_orders_created_by_not_null`
  - REMOVIDO `service_sessions.service_sessions_opened_by_not_null`
  - novo `delivery_orders.delivery_orders_created_via_check`
  - novo `delivery_orders.delivery_orders_created_via_not_null`
  - novo `delivery_orders.delivery_orders_whatsapp_ai_check`
  - novo `delivery_orders.delivery_orders_whatsapp_conversation_fkey`
  - novo `delivery_orders.delivery_orders_whatsapp_link_channel_check`
  - novo `delivery_orders.delivery_orders_whatsapp_link_pair_check`
  - novo `print_jobs.print_jobs_actor_check`
  - novo `print_jobs.print_jobs_created_via_check`
  - novo `print_jobs.print_jobs_created_via_not_null`
  - novo `product_stock_movements.product_stock_movements_actor_check`
  - novo `product_stock_movements.product_stock_movements_created_via_check`
  - novo `product_stock_movements.product_stock_movements_created_via_not_null`
  - novo `service_orders.service_orders_actor_check`
  - novo `service_orders.service_orders_created_via_check`
  - novo `service_orders.service_orders_created_via_not_null`
  - novo `service_sessions.service_sessions_actor_check`
  - novo `service_sessions.service_sessions_created_via_check`
  - novo `service_sessions.service_sessions_created_via_not_null`
- **Índices**: +2 novos · 0 alterados · 0 removidos
  - novos em: `public`
- **Triggers**: +0 novos · 0 alterados · 0 removidos
- **Policies RLS**: +0 novos · 0 alterados · 0 removidos
- **RLS ligado**: +0 novos · 0 alterados · 0 removidos
- **GRANTs de tabela**: +0 novos · 0 alterados · 0 removidos
- **Publicação realtime**: diferença = nenhuma

### B.3 M0-2 → M0-5 (migrations 040000, 050000, 060000)

- funções NOVAS: **21** · funções EXISTENTES recriadas/alteradas: **0** · funções REMOVIDAS: **0**

**Funções novas** (EXECUTE = anon / authenticated / service_role):

| função | DEFINER | EXECUTE |
|---|---|---|
| `guard_whatsapp_order_draft_change()` | não | anon=false auth=false svc=true |
| `guard_whatsapp_order_draft_child()` | não | anon=false auth=false svc=true |
| `whatsapp_order_apply_ops(uuid,jsonb,uuid,integer)` | sim | anon=false auth=false svc=true |
| `whatsapp_order_cancel(uuid,uuid)` | sim | anon=false auth=false svc=true |
| `whatsapp_order_check_options(uuid,uuid,uuid[])` | sim | anon=false auth=false svc=false |
| `whatsapp_order_confirm(uuid,uuid)` | sim | anon=false auth=false svc=true |
| `whatsapp_order_ctx(uuid,uuid)` | sim | anon=false auth=false svc=false |
| `whatsapp_order_draft_get(uuid)` | sim | anon=false auth=true svc=false |
| `whatsapp_order_event(uuid,uuid,text,jsonb)` | sim | anon=false auth=false svc=false |
| `whatsapp_order_expire_due()` | sim | anon=false auth=false svc=false |
| `whatsapp_order_get_state(uuid)` | sim | anon=false auth=false svc=true |
| `whatsapp_order_item_issues(uuid)` | sim | anon=false auth=false svc=false |
| `whatsapp_order_mark_summary_sent(uuid,uuid,integer,uuid)` | sim | anon=false auth=false svc=true |
| `whatsapp_order_open_draft(uuid,uuid)` | sim | anon=false auth=false svc=false |
| `whatsapp_order_product_json(uuid,uuid)` | sim | anon=false auth=false svc=false |
| `whatsapp_order_recalc(uuid)` | sim | anon=false auth=false svc=false |
| `whatsapp_order_resolve_item(uuid,text,integer)` | sim | anon=false auth=false svc=true |
| `whatsapp_order_resolve_option(uuid,uuid,text)` | sim | anon=false auth=false svc=true |
| `whatsapp_order_set_address(uuid,jsonb,uuid,integer)` | sim | anon=false auth=false svc=true |
| `whatsapp_order_set_payment(uuid,text,boolean,numeric,uuid,integer)` | sim | anon=false auth=false svc=true |
| `whatsapp_order_state(uuid)` | sim | anon=false auth=false svc=false |

### B.4 Objetos M0-2 → M0-5

- **Colunas**: +73 novos · 0 alterados · 0 removidos
  - novos em: `company_whatsapp_ai_settings`, `whatsapp_order_draft_events`, `whatsapp_order_draft_item_modifiers`, `whatsapp_order_draft_items`, `whatsapp_order_drafts`
- **Constraints**: +106 novos · 0 alterados · 0 removidos
  - novos em: `company_whatsapp_ai_settings`, `delivery_orders`, `whatsapp_order_draft_events`, `whatsapp_order_draft_item_modifiers`, `whatsapp_order_draft_items`, `whatsapp_order_drafts`
- **Índices**: +16 novos · 0 alterados · 0 removidos
  - novos em: `public`
- **Triggers**: +6 novos · 0 alterados · 0 removidos
  - novo `whatsapp_order_drafts.whatsapp_order_drafts_set_updated_at`
  - novo `whatsapp_order_draft_items.whatsapp_order_draft_items_set_updated_at`
  - novo `whatsapp_order_draft_events.whatsapp_order_draft_events_immutable`
  - novo `whatsapp_order_drafts.whatsapp_order_drafts_guard_change`
  - novo `whatsapp_order_draft_items.whatsapp_order_draft_items_guard`
  - novo `whatsapp_order_draft_item_modifiers.whatsapp_order_draft_item_modifiers_guard`
- **Policies RLS**: +4 novos · 0 alterados · 0 removidos
  - novos em: `whatsapp_order_draft_events`, `whatsapp_order_draft_item_modifiers`, `whatsapp_order_draft_items`, `whatsapp_order_drafts`
- **RLS ligado**: +4 novos · 0 alterados · 0 removidos
  - novos em: `whatsapp_order_draft_events`, `whatsapp_order_draft_item_modifiers`, `whatsapp_order_draft_items`, `whatsapp_order_drafts`
- **GRANTs de tabela**: +4 novos · 0 alterados · 0 removidos
  - novos em: `whatsapp_order_draft_events`, `whatsapp_order_draft_item_modifiers`, `whatsapp_order_draft_items`, `whatsapp_order_drafts`
- **Publicação realtime**: diferença = nenhuma

### B.5 Total BASE → M0-5 (as 6 migrations juntas)

- funções NOVAS: **23** · funções EXISTENTES recriadas/alteradas: **8** · funções REMOVIDAS: **0**

**Existentes recriadas (assinatura mantida)** — o que mudou: corpo (hash), SECURITY DEFINER, search_path ou EXECUTE:

| função | corpo | definer | search_path | EXECUTE antes | EXECUTE depois |
|---|---|---|---|---|---|
| `create_delivery_order(uuid,uuid,text,jsonb,uuid,text,text,uuid,numeric,text,text,numeric,text)` | MUDOU | true→true | igual | anon=false auth=true svc=true | anon=false auth=true svc=true |
| `enqueue_order_print_jobs(uuid)` | MUDOU | true→true | igual | anon=false auth=false svc=true | anon=false auth=false svc=true |
| `guard_delivery_order_change()` | MUDOU | false→false | igual | anon=false auth=false svc=true | anon=false auth=false svc=true |
| `guard_print_job_change()` | MUDOU | false→false | igual | anon=false auth=false svc=true | anon=false auth=false svc=true |
| `guard_service_order_change()` | MUDOU | false→false | igual | anon=false auth=false svc=true | anon=false auth=false svc=true |
| `guard_service_session_change()` | MUDOU | false→false | igual | anon=false auth=false svc=true | anon=false auth=false svc=true |
| `print_actor_name(uuid,uuid)` | MUDOU | true→true | igual | anon=false auth=false svc=true | anon=false auth=false svc=true |
| `submit_service_order_core(uuid,jsonb,text,boolean)` | MUDOU | true→true | igual | anon=false auth=false svc=true | anon=false auth=false svc=true |

**Funções novas** (EXECUTE = anon / authenticated / service_role):

| função | DEFINER | EXECUTE |
|---|---|---|
| `create_delivery_order_engine(uuid,uuid,text,company_role,uuid,text,jsonb,uuid,text,text,uuid,jsonb,numeric,text,text,numeric,text,text,uuid,uuid)` | sim | anon=false auth=false svc=false |
| `guard_whatsapp_order_draft_change()` | não | anon=false auth=false svc=true |
| `guard_whatsapp_order_draft_child()` | não | anon=false auth=false svc=true |
| `submit_service_order_engine(uuid,jsonb,text,boolean,uuid,text)` | sim | anon=false auth=false svc=false |
| `whatsapp_order_apply_ops(uuid,jsonb,uuid,integer)` | sim | anon=false auth=false svc=true |
| `whatsapp_order_cancel(uuid,uuid)` | sim | anon=false auth=false svc=true |
| `whatsapp_order_check_options(uuid,uuid,uuid[])` | sim | anon=false auth=false svc=false |
| `whatsapp_order_confirm(uuid,uuid)` | sim | anon=false auth=false svc=true |
| `whatsapp_order_ctx(uuid,uuid)` | sim | anon=false auth=false svc=false |
| `whatsapp_order_draft_get(uuid)` | sim | anon=false auth=true svc=false |
| `whatsapp_order_event(uuid,uuid,text,jsonb)` | sim | anon=false auth=false svc=false |
| `whatsapp_order_expire_due()` | sim | anon=false auth=false svc=false |
| `whatsapp_order_get_state(uuid)` | sim | anon=false auth=false svc=true |
| `whatsapp_order_item_issues(uuid)` | sim | anon=false auth=false svc=false |
| `whatsapp_order_mark_summary_sent(uuid,uuid,integer,uuid)` | sim | anon=false auth=false svc=true |
| `whatsapp_order_open_draft(uuid,uuid)` | sim | anon=false auth=false svc=false |
| `whatsapp_order_product_json(uuid,uuid)` | sim | anon=false auth=false svc=false |
| `whatsapp_order_recalc(uuid)` | sim | anon=false auth=false svc=false |
| `whatsapp_order_resolve_item(uuid,text,integer)` | sim | anon=false auth=false svc=true |
| `whatsapp_order_resolve_option(uuid,uuid,text)` | sim | anon=false auth=false svc=true |
| `whatsapp_order_set_address(uuid,jsonb,uuid,integer)` | sim | anon=false auth=false svc=true |
| `whatsapp_order_set_payment(uuid,text,boolean,numeric,uuid,integer)` | sim | anon=false auth=false svc=true |
| `whatsapp_order_state(uuid)` | sim | anon=false auth=false svc=false |

Resumo: **23 funções novas, 8 existentes recriadas, 0 removidas** no conjunto.

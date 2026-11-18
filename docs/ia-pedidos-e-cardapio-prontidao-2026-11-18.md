# IA: conclusão de pedidos e cardápio automático — relatório de prontidão (2026-11-18)

Estado: **tudo LOCAL**. Nada aplicado no remoto, nada publicado, nenhuma flag alterada, sem commit/push.

## 1. Arquivos
Alterados: `supabase/functions/whatsapp-ai-auto/handler.ts`, `supabase/functions/_shared/ai-order.ts`, `supabase/functions/_shared/ai-order-flow.ts`.
Novos: `supabase/functions/_shared/ai-catalog-menu.ts`; migrations `20261211010000_whatsapp_order_confirm_status.sql`, `20261211020000_whatsapp_order_delivery_availability.sql`, `20261212010000_whatsapp_ai_catalog_menu.sql`; rollbacks em `supabase/rollbacks/{whatsapp-order-confirm-status,whatsapp-order-delivery-availability,whatsapp-ai-catalog-menu}/rollback.sql`.
Testes (em `.claude/`, fora do deploy): novos `whatsapp-order-conclude-e2e`, `whatsapp-order-confirm-status`, `whatsapp-order-delivery-availability`, `whatsapp-catalog-menu-{rpc,e2e}` e `frontend-tests/whatsapp-catalog-menu-logic`; ajustados os carregadores/expectativas dos e2e de IA/pedido (ver §5).

## 2. Mudanças de comportamento
1. Confirmação do pedido mostra o número real ("Pedido Retirada #0001 confirmado…"); "enviado para a produção" só quando o banco confirma itens na fila (`production_queue_items > 0`), senão "registrado".
2. Sem zona de entrega ativa (ou delivery desligado) a IA oferece **somente retirada**; configuração comercial e fluxo humano não mudam.
3. Mesa/comanda → atendente, rascunho preservado (limitação desta versão: a IA não lança itens em mesa/comanda).
4. "Cardápio" = "catálogo": lista em texto do cadastro real (por categoria ou completo), sem IA/cota. PDF, quando ligado, tem prioridade. Nenhum link de cardápio digital existe no sistema (só `logo_url` e `menu_pdf_enabled`): nenhum link é criado.

## 3. Pré-voo remoto (somente leitura, 2026-11-18)
- Remoto tem 153 migrations; as 3 novas são as únicas locais ausentes (última remota: 20261210010000).
- `whatsapp_order_confirm`: âncora do retorno aparece 1 vez; as 5 funções `whatsapp_order_*` têm 1 chamada a `public.delivery_settings_effective(` cada; helper e função de cardápio ainda não existem; dependências (`delivery_session_label`, `delivery_settings_effective`, `whatsapp_ai_knowledge_tokens`, `whatsapp_ai_canon_text`) existem; colunas de produção existem.
- Sem rascunhos abertos, sem jobs de IA pendentes/processando.
- **Djalexeventos**: `order_drafts_enabled=true`, `menu_pdf_enabled=true`, modo `live`, 1 zona ativa, delivery habilitado, 11 pedidos da IA já criados. Efeito: PDF continua sendo enviado para "cardápio/menu/o que vocês têm"; delivery continua oferecido (tem zona); pedidos existentes não mudam; confirmações novas passam a trazer o número. Perguntas de categoria ("quais bebidas têm?") passam a ser respondidas por lista em texto.
- **ALEXPROAPPS**: `order_drafts_enabled=false`, `menu_pdf_enabled=false`, modo `catalog`, 0 zonas, sem linha em `company_delivery_settings`, 42 produtos à venda, 7 categorias. Efeito das migrations/Edge SEM ligar a flag: "cardápio" passa a listar em texto; pedido segue no `order_assist` (atendente). Com a flag ligada: só retirada (0 zonas), pedido completo pelo motor oficial.

## 4. Falhas de teste
Preexistentes (idênticas com e sem as 3 migrations): `upgrade` 1; `whatsapp-signup-foundation` 2; `whatsapp-knowledge-lookup` 1; `whatsapp-knowledge-profile` 3; `audit-remote-after` 1 (D.3: diverge `whatsapp_ai_knowledge_core`, `whatsapp_ai_update_settings`, `whatsapp_ingest_echo`); `audit-remote-drift` 4 (`whatsapp_get_send_context`, `whatsapp_ingest_message`, `whatsapp_mark_message_sent`, `whatsapp_signup_complete` — fixture "até 1122").
**17 falhas internas de `run-all.mjs` — NÃO classificadas.** `run-all` agrega suítes; as 12 acima explicam parte (upgrade 1 + signup 2 + lookup 1 + profile 3 + audits podem não estar todas no agregado), restando falhas não individualizadas. A regressão completa não foi reexecutada por decisão do usuário. Para classificar: rodar `run-all.mjs` uma vez com `MIG_DIR` sem as 3 migrations novas e comparar a lista de FAIL (custo ~30 min).

## 5. Testes aprovados (alvo)
catalog-menu-rpc 19, catalog-menu-e2e 26, catalog-menu-logic 52, order-conclude-e2e 16, order-delivery-availability 14, order-confirm-status 6, order-e2e 138, order-multi-e2e 59, order-rules-e2e 27, order-drafts 377, ai-auto-e2e 93, ai-auto-knowledge-e2e 43, ai-context-automatic-e2e 37, ai-interaction-e2e 50, ai-intro-e2e 27, menu-pdf-e2e 96, customer-flow-e2e 81, customer-flow-compat-e2e 9, ai-token-health-e2e 39; front `whatsapp-*` todos. Mutantes: 9/10 mortos (o 10º é equivalente).
Testes antigos ajustados por mudança intencional: texto da confirmação (número do pedido), frases "quais … têm"/"cardápio" que agora viram lista, escopo dos guardas de arquivos.

## 6. Riscos
- Lista em texto muda a resposta a "quais X têm?" (antes IA livre; agora lista fixa do cadastro). Mitigação: só dispara com categoria existente e frase curta; senão fluxo anterior.
- Confirmação com número afeta também a Djalexeventos (desejado).
- Migration 020000 faz `CREATE OR REPLACE` de 5 funções críticas por substituição exata (aborta se a âncora não bater; rollback testado).
- Concorrência real no remoto não foi testada (harness `order-race.mjs` exige empresa sintética e autorização); local = PGlite monoprocesso.
- Mesa/comanda: sem pedido pela IA.

## 7. Snapshots (antes de aplicar)
`.claude/remote/state-aa.mjs pre`, `acl-snapshot.mjs pre-1211`, `functions list` (whatsapp-ai-auto v26 hoje), dump das definições de `whatsapp_order_{apply_ops,confirm,recalc,set_address,state}` (`pg_get_functiondef`) e das flags (`company_whatsapp_ai_settings`) das 3 empresas.

## 8. Plano de publicação (aguarda autorização)
1. Snapshots (§7). 2. `db push` isolado das 3 migrations, na ordem 1211010000 → 1211020000 → 1212010000. 3. Pós-aplicação: `state-aa.mjs pos`, `acl-snapshot.mjs --diff` (só 2 funções novas; ACL das 5 inalteradas), checar `order_label` no retorno do confirm, helper e função de cardápio só `service_role`, Djalexeventos com delivery true. 4. Deploy `whatsapp-ai-auto` (jwt off, secret interno), conferir versão v27 e log. 5. Teste de leitura: "manda o cardápio" na ALEXPROAPPS (texto) e na Djalexeventos (PDF) — mensagens reais só com autorização. 6. Ativar `order_drafts_enabled=true` SOMENTE na ALEXPROAPPS (UPDATE com `where company_id` da ALEXPROAPPS) e teste real "2 coca zero" → retirada → Pix → Confirmar.

## 9. Rollback
- Flag: `update company_whatsapp_ai_settings set order_drafts_enabled=false where company_id=<ALEXPROAPPS>` (imediato; volta ao `order_assist`).
- Edge: redeploy da v26 anterior (a Edge nova tolera as funções novas ausentes; a antiga tolera os campos novos).
- Migrations (ordem inversa): `whatsapp-ai-catalog-menu` → `whatsapp-order-delivery-availability` → `whatsapp-order-confirm-status` (cada rollback falha fechado se a âncora/assinatura não bater; reverter a Edge antes).

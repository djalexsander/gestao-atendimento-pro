# Revisão final — pedido conversacional pelo WhatsApp (fase local, antes do remoto)

> Estado: **100% local**. Nada foi aplicado ao Supabase, nada publicado, `order_drafts_enabled` continua `false` em todas as empresas.
> Este documento **substitui** `docs/revisao-migrations-3-5.md` e os patches antigos de `docs/revisao-3-5/` (removidos); todos os diffs foram
> regenerados do working tree atual (hashes na seção 1). O diff semântico das migrations 0–2 (`docs/revisao-migrations-0-2-diff.md`)
> continua válido: o teste diferencial foi reexecutado com o mesmo resultado (109 de 112 passos idênticos; 3 diferenças intencionais, seção 9).
>
> Artefatos gerados: `docs/revisao-final/*.patch` (diff textual: 6 migrations, `ai-order.ts`, `ai-order-flow.ts`, e os diffs de `ai-auto.ts`+`ai-openai.ts` e de `handler.ts`) e
> `docs/revisao-final/semantico-catalogo.md` (diff semântico do catálogo do banco, gerado por `catalog-snapshot.mjs`).

## 1. Estado local congelado (somente arquivos desta fase)

Branch `main` @ `30a00be`. Arquivos relacionados ao pedido conversacional:

| tipo | arquivo | situação |
|---|---|---|
| migration | `supabase/migrations/20261021010000_delivery_phone_e164.sql` | novo |
| migration | `supabase/migrations/20261021020000_order_authorship_channel.sql` | novo |
| migration | `supabase/migrations/20261021030000_order_engine_actor.sql` | novo |
| migration | `supabase/migrations/20261021040000_whatsapp_order_drafts.sql` | novo |
| migration | `supabase/migrations/20261021050000_whatsapp_order_draft_rpcs.sql` | novo |
| migration | `supabase/migrations/20261021060000_whatsapp_order_confirm.sql` | novo |
| Edge (puro) | `supabase/functions/_shared/ai-order.ts` | novo |
| Edge (fluxo) | `supabase/functions/_shared/ai-order-flow.ts` | novo |
| Edge | `supabase/functions/_shared/ai-auto.ts` | alterado (+`schema?` e +`maxOutputTokens?` opcionais em `DecideRequest`) |
| Edge | `supabase/functions/_shared/ai-openai.ts` | alterado (usa `req.schema`/`req.maxOutputTokens` quando existem) |
| Edge | `supabase/functions/whatsapp-ai-auto/handler.ts` | alterado (desvio para o fluxo do pedido atrás da flag) |
| docs | `docs/whatsapp-pedido-conversacional-arquitetura.md`, `docs/revisao-migrations-0-2-diff.md`, `docs/revisao-final-pedido-conversacional.md`, `docs/revisao-final/*`, `docs/whatsapp-pedido-concorrencia-remota.md` | novos |

Testes e ferramentas (em `.claude/`, **ignorado pelo git** — não entram no commit): `.claude/db-tests/{whatsapp-order-drafts,whatsapp-order-e2e,order-engine-actor,order-engine-upgrade,order-engine-differential(-compare),mutate-order-drafts,mutate-order-engine,catalog-snapshot,order-race-smoke}.mjs`, `.claude/frontend-tests/whatsapp-order-logic.mjs`, `.claude/remote/order-race{,-lib}.mjs` (harness de concorrência, **não executado**).

Fora do escopo e NÃO incluídos no commit: `artifacts/`, `docs/catalogo-teste-djalexeventos-*`, `scripts/prepare_djalex_catalog_images.py`.

SHA-256 (16 primeiros) das migrations desta revisão: `010000` 6400fbcc5fca515d · `020000` 266d1adc518ddb16 · `030000` cc6000fd8d97ee85 · `040000` 1298fe054414eae3 · `050000` c4637458b1f2977e · `060000` 99c78e6dfef1807c.

## 2. Retenção / privacidade (regra final, verificada em código e teste)

| momento | o que **sai** do rascunho | o que **fica** |
|---|---|---|
| `cancelled`, `expired`, `failed`, `confirmed` (na própria transição, trigger `guard_whatsapp_order_draft_change`) | `addr_street`, `addr_number`, `addr_complement`, `addr_neighborhood`, `addr_city`, `addr_state`, `addr_cep`, `addr_reference` e `notes` (observação geral) | `contact_name`, `contact_phone`, `notes` de cada **item**, ids, produtos, quantidades, preços *snapshot*, totais, `status`, `failure_code`, `zone_id`/`delivery_fee` |
| `confirmed` | idem; o endereço sobrevive **somente** no snapshot oficial `delivery_orders`, criado pelo motor antes da limpeza, na mesma transação | idem |

- Eventos de auditoria (`whatsapp_order_draft_events`) nunca recebem texto/endereço (`detail` só com códigos e contagens); registros de uso de IA também não.
- Estados terminais são **100% imutáveis** (trigger): nem nome, telefone ou observação de item mudam depois do encerramento.
- Não há “scrub” posterior: a limpeza é atômica na transição; o cron `expire_due` só faz a transição.
- Testes: 1.20, 8.1, 9.6, 9.45, 9.52, 10.1, 11.21–11.24 e a nova **seção 14** (`14.1–14.6`) de `whatsapp-order-drafts.mjs`: quatro estados terminais × endereço/observação limpos × contato/observação de item preservados × imutabilidade.

## 3. Separação MODELO / BANCO / TEMPLATE (auditada)

| responsabilidade | quem | como é garantido |
|---|---|---|
| intenção, texto do produto, quantidade escrita pelo cliente, texto das opções, texto de endereço/pagamento, “confirmar/cancelar” | **modelo** (somente extração; schema JSON estrito, `additionalProperties:false`, todos os campos obrigatórios) | `ORDER_EXTRACT_SCHEMA` + `validateExtraction` (chave extra, id ou preço ⇒ recusado); o schema não tem campo de id/preço/taxa/total/estoque/status (teste) |
| `product_id`, `option_id`, preço, modificadores, taxa, zona, total, disponibilidade, estoque, validade, estado do rascunho, criação do pedido | **banco** | `resolve_item`/`resolve_option` (conservador: ambíguo ⇒ pergunta); `apply_ops` recebe só ids resolvidos; `recalc` e `confirm` revalidam |
| texto enviado ao cliente | **template** | `renderSummary`, `nextQuestion`, `renderCreated`, `renderPriceChanges`, `renderAmbiguous`, `MSG_*`; o fluxo nunca envia texto do modelo (auditoria estática) |
| a confirmação | **classificador determinístico** (não usa o modelo) | `classifyConfirmationText/Batch` |
| criar pedido | **somente** `whatsapp_order_confirm` → `create_delivery_order_engine` | o TypeScript não referencia `create_delivery_order`/`submit_service_order`/tabelas de pedido (auditoria estática) |

Conclusão: o modelo **não** é fonte de preço, total, taxa, ids, disponibilidade nem de criação de pedido.

## 4. Classificador de confirmação (conservador)

- **Confirmam** (após normalizar caixa, acento e pontuação; “sim” opcional na frente): `confirmar`, `confirmado`, `confirmo`, `pode confirmar`, `pode mandar`, `pode enviar`, `pode enviar o pedido`, `está correto`, `confirmar pedido`, `sim, pode confirmar`, `sim pode enviar`.
- **Não confirmam sozinhos** (resposta: “Responda CONFIRMAR para enviar o pedido.”): `ok`, `sim`, `beleza`, `blz`, `certo`, `isso`, `isso mesmo`, `pode ser`, `show`, `fechado`, `tudo certo`, `perfeito` e qualquer emoji isolado (👍, 👍🏽). *Correção desta rodada:* emoji isolado caía em “nenhuma intenção”; agora vira `ambiguous_ack` (pede CONFIRMAR).
- **Nunca confirmam**: pergunta (`?`), negação (“não confirmar”), alteração (“confirmar sem cebola”, “sim mas troca…”, “confirmar mais um”), incerteza (“acho que sim”, “talvez confirmar”).
- Lote de mensagens: a **última** tem de ser confirmação e as anteriores só “confirmar/ok”; uma alteração no meio invalida.
- O banco ainda exige: mensagem de confirmação = **última do job**, **posterior ao resumo ENVIADO**, e `summary_version` = versão atual do rascunho (`confirm_before_summary`, `summary_not_sent`, `stale_summary`, `not_latest_message`). Mensagens anteriores não são reaproveitadas.
- Testes: `whatsapp-order-logic` (tabela de frases), `whatsapp-order-drafts` 9.15–9.19 e o e2e.

## 5. `stale_context` e processamento idempotente

- `whatsapp_order_ctx(job, p_expected_latest)` devolve `stale_context` se `job.latest_message_id` mudou (chegou mensagem nova durante o processamento). Todas as RPCs de mutação recebem `p_expected_latest`; com contexto velho **nada é gravado** (13.2/13.3).
- `apply_ops`/`set_address`/`set_payment` gravam `last_ops_job_id` + `last_ops_tail_count` e `get_state` devolve `applied`: um job reagendado/repetido **pula** as mensagens já aplicadas (e2e 8.5: continua “2x carne”).
- Inbound novo durante o processamento: o worker termina com `ignored/stale_context` e o job seguinte processa o lote completo uma vez só (e2e 8.2).
- Confirmação com `summary_version` antiga: `stale_summary` (9.19) — nenhum pedido.

## 6. Idempotência da confirmação (6 camadas)

1. travas na ordem **conversa → job → rascunho → produtos (por id)**; 2. máquina de estados (`awaiting_confirmation` → `confirmed` uma única vez); 3. `confirmed_by_message_id` único; 4. `client_request_id` do pedido = id do rascunho (unicidade do motor); 5. índice único `delivery_orders(whatsapp_order_draft_id)`; 6. CHECKs.

Provado localmente: 1 rascunho ⇒ no máximo 1 pedido (9.11–9.14, 11.18–11.20, 14.10, 14.12); duas confirmações sequenciais ⇒ `already_confirmed` com o **mesmo** pedido; retry do worker ⇒ idem (9.12, 14.10); **webhook duplicado** ⇒ 1 mensagem/1 job (14.9) e nenhum job/pedido novo depois (14.11); `already_confirmed` **nunca** herda pedido de rascunho anterior — só vale para a mesma mensagem, ou uma das 3 anteriores em 10 min e **sem rascunho mais novo** (14.7).

## 7. Caminho completo: mensagem do cliente → pedido oficial

1. Webhook (`whatsapp_ingest_message`) grava a mensagem (dedupe por `wamid`) e agenda **1 job** por conversa (`whatsapp_ai_jobs`).
2. O worker `whatsapp-ai-auto` reivindica o job (lease); kill switch, cotas e pré-filtro de sempre. Handoff duro (humano, injeção, jurídico…) **não** entra no fluxo do pedido.
3. `runOrderFlow` chama `whatsapp_order_get_state(job)`; flag desligada ou RPC ausente ⇒ comportamento legado.
4. Cancelamento (`isCancelIntent`) ⇒ `whatsapp_order_cancel`. “confirmar” **sem** resumo pendente ⇒ `whatsapp_order_confirm` (o banco decide `already_confirmed`/`no_draft`).
5. Com resumo aguardando: classificador (`confirm`/`ambiguous_ack`/`none`). `confirm` ⇒ passo 8; ambíguo ⇒ “Responda CONFIRMAR…”; qualquer outra coisa ⇒ extrator.
6. Extrator (1 chamada, schema estrito, prompt sem valores de endereço) ⇒ operações; guarda D5 de quantidade; para cada item `resolve_item` (ambíguo/não encontrado ⇒ pergunta); `apply_ops`/`set_address`/`set_payment` com `p_expected_latest` e `p_tail_count`.
7. Estado pronto ⇒ resumo por template (preço/taxa/total do banco), enviado pelo `commit_send` oficial; **só depois do envio** `mark_summary_sent` (`awaiting_confirmation`, `summary_version`, `summary_message_id`). Falta algo ⇒ **uma** pergunta por template.
8. Cliente responde “confirmar”: `whatsapp_order_confirm(job, msg)` valida mensagem e resumo, trava o rascunho e os produtos (estoque `FOR UPDATE`, demais `FOR SHARE`, por id), **revalida** preço/taxa/zona/disponibilidade/estoque/opções/pagamento/troco ⇒ `price_changed`/`needs_changes` (volta a `collecting`, versão+1, novo resumo) **ou** chama `create_delivery_order_engine(actor NULL, created_via 'whatsapp_ai', client_request_id = id do rascunho, canal whatsapp)` → `submit_service_order_engine` (preço, modificadores, estoque, setor, produção, impressão: o fluxo de sempre), com defesa de `items_subtotal`/`delivery_fee` iguais aos confirmados.
9. Sucesso ⇒ rascunho `confirmed` (ids do pedido; endereço limpo do rascunho), eventos, e a resposta “Pedido confirmado e enviado para produção…” **somente** com `result='created'`. Erro do motor ⇒ rollback total + `failed` + handoff, nunca “confirmado”.
10. `enqueue_order_print_jobs` cria os jobs de impressão (`created_via='whatsapp_ai'`, operador “WhatsApp (IA)”); a produção assume o item normalmente.

## 8. Diff semântico e funções

O diff completo (colunas, constraints, índices, triggers, policies, GRANTs, realtime e funções, em três fotos BASE / M0-2 / M0-5) está em **`docs/revisao-final/semantico-catalogo.md`**. Resumo:

- **Funções NOVAS: 23** (2 motores + as RPCs do worker/UI/helpers/triggers das migrations 3–5).
- **Funções EXISTENTES recriadas (assinatura mantida): 8**, todas nas migrations 1–2 — `create_delivery_order`, `submit_service_order_core` (agora invólucros do motor, ACL idêntica), `enqueue_order_print_jobs`, `print_actor_name`, `guard_delivery_order_change`, `guard_print_job_change`, `guard_service_order_change`, `guard_service_session_change`. **Funções removidas: 0.**
- Migrations 3–5 **não recriam nenhuma função existente**; só adicionam 1 coluna (`company_whatsapp_ai_settings.order_drafts_enabled`) e 1 FK (`delivery_orders → whatsapp_order_drafts`).
- Mudança de esquema relevante das migrations 1–2: `created_by`/`opened_by` passam a aceitar NULL (4 tabelas) **somente** com `created_via='whatsapp_ai'` (CHECK `*_actor_check`); `created_via` com default `'user'`; telefone `delivery_orders.customer_phone` de 8–13 para 8–15 dígitos (E.164).

## 9. ACL / GRANT e diferenças do fluxo humano

- RPCs do worker (`whatsapp_order_get_state`, `resolve_item`, `resolve_option`, `apply_ops`, `set_address`, `set_payment`, `mark_summary_sent`, `cancel`, `whatsapp_order_confirm`): **somente `service_role`** (testes 1.3 e `acl2.mjs`). `whatsapp_order_expire_due()` não é executável por nenhum papel de API: roda só pelo `pg_cron` (job `gap-whatsapp-order-expire`, a cada 5 min).
- Helpers internos (`whatsapp_order_event/ctx/open_draft/item_issues/recalc/state/product_json/check_options`, triggers de guarda): **ninguém** executa (1.4).
- UI `whatsapp_order_draft_get(conversation)`: `authenticated`, owner/admin/atendente/caixa da empresa (10.6–10.9).
- Motores `submit_service_order_engine` e `create_delivery_order_engine`: EXECUTE revogado de **todos** (inclusive `service_role`); só os invólucros públicos (assinatura e ACL inalteradas) e `whatsapp_order_confirm` (DEFINER) os chamam (`acl-chain`).
- Tabelas novas: RLS ligada; `authenticated` só lê (owner/admin/atendente/caixa; eventos só owner/admin); nenhuma escrita direta do cliente.
- **Fluxo humano (diferencial banco antigo × novo):** 112 passos, 109 idênticos; as 3 diferenças são as aprovadas (telefone de 14 e 15 dígitos agora aceito; 3 chaves aditivas em `get_delivery_order`). Nenhum comportamento humano mudou.

## 10. Testes locais finais

| suíte | resultado |
|---|---|
| `whatsapp-order-logic` (lógica pura: classificador, D5, schema, templates, auditoria estática) | **47 ok / 0 falhas** |
| `whatsapp-order-drafts` (inclui a nova seção 14: retenção, sem herança, webhook duplicado) | **324 ok / 0 falhas** |
| `order-engine-actor` | **128 ok / 0 falhas** |
| `order-engine-upgrade` (migrations 1–6 sobre banco populado) | **19 ok / 0 falhas** |
| `order-engine-differential` + compare (fluxo humano antigo × novo) | **109 de 112 idênticos**; 3 diferenças aprovadas (E.164 ×2, chaves aditivas) |
| `whatsapp-order-e2e` (worker TS + banco real, provedor simulado) | **50 ok / 0 falhas** |
| `whatsapp-ai-auto-e2e` / `whatsapp-ai-auto-knowledge-e2e` | **93 ok / 0 falhas** · **43 ok / 0 falhas** |
| `whatsapp-knowledge-lookup` | **58 ok / 0 falhas** (uma execução anterior falhou só no teto de tempo de 5 s com a máquina ocupada; passa isolada) |
| `acl2` (auditoria de ACL/RLS) | **AUDITORIA OK** |
| frontend/Edge `run-all` (inclui `whatsapp-ai-auto-*`, `whatsapp-ai-suggest*`, `whatsapp-order-logic`) | **1975 ok / 0 falhas** (49 suítes) |
| `order-race-smoke` (harness de concorrência, sequencial, nas duas ordens) | **157 ok / 0 falhas** |
| `tsc --strict` (handler, `ai-order`, `ai-order-flow`, `ai-openai`, `ai-auto`) | sem erros |
| `npm run build` (web) | OK |
| auditoria de segredos nos arquivos do commit (chaves `sk-`, JWT, `sbp_`, Bearer, senhas, chaves privadas, e-mails/telefones reais) | nada encontrado; o código dos módulos do pedido só loga códigos (sem texto, endereço, nome ou corpo) |
| **mutação** `mutate-order-drafts` | **64 mortos, 0 sobreviveram, 0 inválidos** (1 âncora desatualizada corrigida) |
| **mutação** `mutate-order-engine` | **34 mortos, 0 sobreviveram, 0 inválidos** |
| DB `run-all` (70 suítes) | **4500 checagens ok** |

**Baseline conhecido (registrado separadamente, existe também nas migrations limpas, sem as novas):** `module-entitlement.mjs` (G2, depende do relógio) — 1 falha; `production.mjs` — aborta (tipo `whatsapp_conversations`). Nenhuma outra falha.

Não coberto por mutação automática: o TypeScript do classificador/fluxo (coberto por 47 + 50 testes e auditoria estática, sem mutantes).

## 11. Riscos residuais

- Concorrência **real** (sessões independentes) não é provável em PGlite; harness pronto e validado localmente, **não executado** (`docs/whatsapp-pedido-concorrencia-remota.md`).
- FKs do rascunho para produtos/opções/clientes/zonas/mensagens impedem *hard delete* desses cadastros enquanto houver rascunho; nada hard-deleta hoje (exclusão de empresa em cascata testada).
- Respostas das RPCs contêm endereço: o worker não as loga (auditoria estática: só códigos e contagens).
- Resumo enviado e processo morto antes de `mark_summary_sent`: o rascunho fica em `collecting`; o próximo “confirmar” reenvia o resumo (sem pedido).
- Os testes ficam em `.claude/` (ignorado pelo git): o commit leva código, migrations e docs, não a suíte.

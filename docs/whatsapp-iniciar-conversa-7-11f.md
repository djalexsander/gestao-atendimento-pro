# Iniciar conversa pelo WhatsApp — Etapa 7.11F (local, não aplicada)

Migration `supabase/migrations/20261205010000_whatsapp_start_conversation.sql` (3 RPCs, 2 auxiliares internas, 5 colunas em `whatsapp_start_requests`); rollback em `supabase/rollbacks/whatsapp-start-conversation-rpc/`.
Edge `supabase/functions/whatsapp-start-conversation/{handler,index}.ts` (entrada em `supabase/config.toml`, `verify_jwt = true`). Nada aplicado, publicado, ativado ou enviado.

## Fluxo
1. **Edge** (JWT do usuário) → RPC `whatsapp_start_conversation` — **uma transação**: papel (owner/admin/atendente), módulo, PT402, conexão ativa, consentimento (confirmação + **origem** + **referência**), telefone resolvido **só no servidor** (contato manual ou cliente da mesma empresa), modo teste, reserva (template aprovado, opt-out, limite diário, intervalo por contato), conversa **única** (mesmo lock e equivalência do nono dígito do recebimento), `ai_control='human'`, mensagem `queued`. Qualquer falha desfaz tudo (nenhuma conversa/mensagem/pedido/vaga).
2. **Depois do commit**, se `dispatch_required`, a Edge chama `dispatchQueuedTemplate` (7.11E): contexto revalidado + claim atômico + UMA tentativa à Meta, sem retry.
3. Resposta com `conversation_id` (a tela abre `?conversation=<id>`) e `status`: `accepted` (a Meta **aceitou**; não é "entregue" — a entrega vem do webhook de status e aparece em `delivery_status`), `unconfirmed` (202), `in_progress` (202) ou `failed`.

Corpo da Edge: `company_id, client_request_id, contact_kind(manual|customer), contact_ref, template_id, params[], consent_confirmed, consent_origin(written_consent|customer_request|external_record|other_documented), consent_ref(3–80 car., sem telefone/8+ dígitos)`. Nenhum telefone é aceito do cliente.

## Pontos pedidos
- **IA**: conversa nova nasce `human`; conversa existente é pausada (`ai_paused`, motivo `conversation_started`) e jobs pendentes da IA são cancelados. Teste com a IA em modo automático: a resposta do cliente não gera job.
- **Opt-out / limite / intervalo**: da reserva (7.11B/D), conferidos de novo no enfileiramento e no envio (7.11E). Falha definitiva libera a vaga; incerto mantém.
- **Idempotência**: mesmo `client_request_id` devolve o mesmo pedido (outro contato/template/usuário → 409); o despacho repetido não reenvia (claim). 5 chamadas simultâneas = 1 chamada à Graph.
- **Falha depois do despacho**: a conversa permanece com a mensagem `failed` (o operador a vê e pode tentar de novo). Só o que vem ANTES do despacho é totalmente desfeito.
- **Acompanhar/resolver incertos** (`whatsapp_list_start_requests`, `whatsapp_start_request_resolve`): estados `pending_dispatch` (Edge caiu antes; repetir o mesmo pedido despacha com segurança, ou cancelar), `in_progress` (<2 min), `unconfirmed` (timeout/rede/5xx/sem id, ou claim sem resultado há >2 min), `accepted`, `failed`. Resoluções: `confirmed_sent`, `confirmed_not_sent` (libera vaga/intervalo; novo envio = novo `client_request_id`), `cancelled_unsent` (toma o claim, nenhum despacho tardio envia). Exigem atestação; atendente só resolve os próprios; tudo auditado (quem/quando). Listas sem telefone/token.
- **Interface de Contatos (7.11G)**: usará `whatsapp_get_start_settings` (can_start, used_today), `whatsapp_list_start_templates`, `whatsapp_get_contact_optout`, a Edge acima e `whatsapp_list_start_requests/resolve`, e abre `?conversation=<id>`.

## 131050 — confirmado na documentação oficial
Página oficial de códigos de erro da Cloud API (<https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/>, lida nesta etapa): 131050 = "o destinatário optou por parar de receber **mensagens de marketing**"; ação: não reenviar, e assinar o webhook `user_preferences` para saber quando o usuário para/retoma marketing. A página **não afirma** que vale para templates de utilidade. **131049** é limite de "ecossistema saudável", não opt-out. Decisão: 131050 bloqueia **novas iniciações** ao contato (conservador, reversível por reativação com evidência); o código não depende de o template ser de marketing. Se o produto quiser bloquear só marketing, é uma regra futura (categoria do template já está em cache). Continua sem tratar o webhook `user_preferences` (fora de escopo).

## Risco residual — eco da Coexistence
`whatsapp_ingest_echo` não usa o lock de conversa nem a equivalência do nono dígito ao CRIAR conversa. Se um eco (mensagem enviada pelo app do celular) para um contato SEM conversa chegar ao mesmo tempo que esta RPC: (a) mesma forma de telefone → o índice único é tratado (a RPC reaproveita a conversa criada pelo eco); (b) forma diferente (com/sem 9) → podem nascer duas conversas do mesmo contato. Não alterado nesta etapa; a janela é de milissegundos e exige Coexistence ativa.

## Pendências
1. Reconciliação automática de incertos (o webhook de status só correlaciona por `wamid`, que não existe no caso ambíguo): hoje só o operador resolve.
2. Gancho para limpar claims órfãos em lote (hoje viram `unconfirmed` após 2 min e aparecem na lista).
3. Resolver `confirmed_sent` grava id sintético `manual:<mensagem>`; status posteriores da Meta não correlacionam.
4. Aplicar na ordem: 20261201010000 → 20261202010000 → 20261203010000 → 20261203020000 → 20261204010000 → 20261205010000, depois deploy manual de `whatsapp-templates-sync` e `whatsapp-start-conversation`.

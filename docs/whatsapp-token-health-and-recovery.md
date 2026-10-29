# Saúde dos tokens do WhatsApp e recuperação de registros incertos (Etapa 8)

Migration: `supabase/migrations/20261108010000_whatsapp_token_health_and_registration_recovery.sql` (**não aplicada em produção**).
Complementa `whatsapp-token-lifecycle-audit.md` (Etapa 7). Nada aqui ativa o Embedded Signup nem altera tokens existentes.

## 1. Onde o token do WhatsApp é usado (auditoria)
| Caminho | Como usa o token |
|---|---|
| Envio manual (`whatsapp-send`) | `whatsapp_prepare_outbound_message` (JWT do usuário) → `dispatchQueuedMessage` |
| Resposta automática da IA e cardápio em PDF (`whatsapp-ai-auto`) | `whatsapp_ai_auto_commit_send` → `dispatchQueuedMessage` (texto, upload e documento) |
| Aviso de status do pedido (`whatsapp-order-notify`) | `dispatchQueuedMessage` |
| `whatsapp-signup-complete` | recebe o token NOVO do code e o grava no Vault; não lê o antigo |
| Webhook de mensagens | **não usa o token** (recebimento independe da saúde do token) |

**Ponto único:** `_shared/whatsapp-dispatch.ts` → RPC `whatsapp_get_send_context` (a única leitura do token no Vault). O teste 7.3/7.4 da suíte
trava isso: nenhum outro código das Edges lê `decrypted_secrets`/o contexto de envio, e as três Edges usam o mesmo `dispatchQueuedMessage`.
A proteção foi colocada nesse ponto, então vale para manual, IA, cardápio e notificações ao mesmo tempo.

## 2. Estados do token
`whatsapp_token_effective_status(conexão)`:
| Estado | Quando | Envia? |
|---|---|---|
| `valid` | confirmado (conexão concluída pelo signup / envio bem-sucedido) ou prazo conhecido a mais de 10 dias | sim |
| `expiring` | prazo conhecido (`token_expires_at`) a até 10 dias | sim (+ aviso) |
| `expired` | prazo conhecido vencido, ou expiração confirmada | **não** |
| `revoked` | a Graph API **confirmou** token inválido (erro 190) | **não** (com sondagem, abaixo) |
| `error` | falha de autenticação não confirmada (190 com subcódigo de checkpoint 459/464) | sim |
| `unknown` | sem prazo conhecido e nunca confirmado (ex.: Djalexeventos) | sim, **nunca** é tratado como válido nem como inválido |

Regras: HTTP 401 sem o código 190, timeout, rede, 5xx e 429 **não** alteram a saúde. A conexão nunca é desativada sozinha, conversas e mensagens não são tocadas
e o webhook continua recebendo. A Meta documenta o 190 como "expirado, revogado ou inválido" (sem distinguir), por isso a Graph só confirma `revoked` ("revogado ou inválido").

**Sondagem:** token `revoked` bloqueia, mas a cada 30 min (`token_checked_at`, reivindicação atômica) uma tentativa é liberada. Se a Meta estava só instável e o envio passa,
o token volta a `valid`; se o 190 se repete, a janela de 30 min recomeça. Prazo vencido (informado pela Meta) é bloqueio firme, sem sondagem.

## 3. Avisos
- `whatsapp_get_module_state` devolve `connection_alert` **somente para owner/admin** (attendant/cashier recebem `null`): `{kind: expiring|expired|revoked, level, days_left, reconnect}`.
  Sem token, segredo, id de segredo ou PIN. Isolamento por empresa (RLS/papel; outra empresa recebe 404).
- A tela `/app/configuracoes/whatsapp` mostra o banner (atenção ≤10 dias; crítico quando expirado/revogado) e o botão **Reconectar meu WhatsApp**.
- Sem repetição por envio: o aviso é derivado do estado (um banner), e `whatsapp_token_alerts` guarda uma linha por (conexão, tipo, credencial) com contador de ocorrências
  — base para um canal futuro (push/e-mail) disparar só na primeira vez. **Nenhum canal de envio de aviso foi criado nesta etapa.**
- Admin Master: `master_whatsapp_token_health()` lista a saúde por empresa (sem credenciais).
- `whatsapp_token_health_sweep()` (service_role) sincroniza `expiring/expired` a partir de prazos **conhecidos** e registra o aviso uma vez; **ainda não está agendada** (cron fica para a publicação).
  Nunca toca em conexões sem prazo conhecido.

## 4. Renovação e reconexão
**Renovação programática: NÃO confirmada para o token do Embedded Signup — não implementada.**
- Meta (consultada em 2026-10-29): resposta do code traz `expires_in` "se o token expira"; BISU token "nunca expira" por padrão e pode expirar em 60 dias
  (`set_token_expires_in_60_days`); a renovação por `fb_exchange_token` está documentada para *system user tokens* (Business Management APIs) e **não** é citada para tokens do Embedded Signup;
  a API `/<CLIENT_BUSINESS_ID>/system_user_access_tokens` (gera/busca token do negócio-cliente) exige `business_management` e `appsecret_proof` e não está confirmada para este fluxo.
- Caminho suportado e testado: **reconectar pelo próprio Embedded Signup** (mesmo número):
  - o botão "Reconectar meu WhatsApp" aparece com conexão ativa quando há aviso (expirando/expirado/revogado) e a empresa está liberada (flag + allowlist);
  - `whatsapp_signup_begin` não exige desconectar; `whatsapp_signup_complete` reaproveita a MESMA linha/número, troca a credencial e põe `token_status='valid'`;
  - o registro do número **não é repetido** (registro concluído é reaproveitado) e o PIN é preservado;
  - **a credencial antiga só é apagada depois da nova ser confirmada**: se a tentativa falhar, a antiga e o histórico ficam intactos (teste 9.2/9.4).
- Se o token expirar **antes** da reconexão: o envio fica pausado (mensagens manuais, da IA e avisos de pedido falham com `token_expired`/`token_revoked`, sem chamar a Graph);
  conversas, histórico e recebimento seguem normais; as mensagens que falharam não são reenviadas sozinhas (o atendente reenvia após reconectar). Empresa liberada: owner/admin clica em
  "Reconectar". Empresa **fora** do piloto: a tela orienta a falar com a Alex Pro Apps, que reconecta o número (o histórico é mantido).
- Pendente de confirmação com a Meta/piloto: duração real do token do Configuration ID, se existe renovação oficial para o token do Embedded Signup e se há webhook de revogação pelo cliente.

## 5. Recuperação de registros incertos (`state = uncertain`)
A RPC antiga `whatsapp_registration_resolve` **não atende**: só `service_role`, sem identidade do responsável, sem motivo/evidência, sem proteção para tentativa em curso. Continua existindo como
primitivo interno e é chamada pela nova RPC. Novo caminho (somente **Admin Master**, `assert_master_admin`):
1. `master_whatsapp_registration_list()` — registros `uncertain`/`in_progress` com empresa, número, WABA, estado, código do erro, última tentativa, se há PIN guardado (booleano) e token retido. **Sem PIN nem token.**
2. Conferir **fora do sistema** (painel da Meta, consulta à Graph, suporte da Meta ou confirmação do cliente). Nenhuma nova chamada de registro é feita pelo sistema.
3. `master_whatsapp_registration_resolve(registro, 'registered'|'failed', tipo_de_evidência, motivo, evidência)` — motivo (10–500) e evidência (10–1000) obrigatórios;
   tipos: `meta_dashboard`, `graph_api_check`, `meta_support`, `customer_confirmation`.
   - `uncertain` pode ser resolvido; `in_progress` só se a tentativa estiver parada há mais de 30 min (`operation_may_be_in_flight` caso contrário);
   - grava em `whatsapp_registration_resolutions` quem, quando, motivo, evidência e o estado anterior;
   - **só depois da resolução** roda a limpeza: o token retido da sessão encerrada é removido; o PIN é **preservado** (registro concluído) ou segue a política de 7 dias (registro falho).
4. Antes da resolução, token e PIN permanecem (a varredura os respeita).

## 5b. Testes de ponta a ponta da IA (Etapa 8.1)
`whatsapp-ai-token-health-e2e.mjs`: worker `whatsapp-ai-auto` REAL + despacho REAL + banco real + Graph simulada, texto e cardápio em PDF (upload + documento):
token válido, sem validade conhecida (conexão antiga: linha da conexão idêntica), expirado pelo prazo, revogado (bloqueio, sondagem, restauração), erro temporário
(500/401 sem 190/429/timeout/rede não classificam o token), 190 no envio e no upload do documento, checkpoint 459, reconexão (credencial antiga só sai depois da nova confirmada),
sem mensagem duplicada, sem loop de retentativas, sem reenvio de mensagens antigas após reconectar e sem token/PIN em logs, mensagens, jobs, alertas ou na linha da conexão.
A sondagem usa apenas uma mensagem legítima do cliente que já estava na fila: **nunca cria mensagens de teste**.

## 6. Pendências antes da liberação comercial (continuam obrigatórias)
Identificação automática de expirados/revogados em produção (agendar a varredura), aviso por um canal ativo (push/e-mail) além do banner, e o procedimento de reconexão exercitado no piloto real.
Publicação exige: migration → Edges (`whatsapp-send`, `whatsapp-ai-auto`, `whatsapp-order-notify`, que compartilham o novo `whatsapp-dispatch.ts`) → frontend.

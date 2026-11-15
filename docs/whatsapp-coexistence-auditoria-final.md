# Coexistence — Auditoria final pré-publicação (GO / NO-GO)

Data: 2026-11-15 · Escopo: migrations `20261123010000`, `20261124010000`, `20261125010000`, Edges `whatsapp-signup-complete`, `whatsapp-webhook`, `whatsapp-coexistence-sync`, frontend do Embedded Signup.
Feito **sem alterar código funcional nem produção**. Verificações remotas **somente leitura** (lista de migrations, `db push --dry-run`, SELECTs, nomes de secrets, lista de funções). Nada foi aplicado, implantado, commitado ou ativado.

## Veredito
| Pergunta | Veredito |
|---|---|
| Publicar **no escuro** (3 migrations + deploys + frontend com **todas as flags desligadas**) | **GO** |
| Ligar a flag e fazer o **primeiro teste real** com a empresa-piloto | **NO-GO condicional** — resolver os itens P1–P5 abaixo antes |

Nenhum risco **crítico** foi encontrado. O que impede o teste real são decisões/confirmações com a Meta e um defeito de borda (A1), não segurança das migrations.

## 1. Evidências (tudo reproduzível localmente)
| Verificação | Resultado |
|---|---|
| `supabase db push --dry-run` (leitura) | pendentes **exatamente** as 3 migrations, na ordem; remoto termina em `20261122010000` |
| Drift das funções que as migrations substituem (`whatsapp_signup_complete`, `whatsapp_mark_message_sent`, `whatsapp_ingest_message`, `whatsapp_get_send_context`) | texto remoto **idêntico** ao esperado (md5 sem espaços) — `audit-remote-drift.mjs` 4/4 |
| Colunas/tabelas novas ainda não existem no remoto; allowlist **vazia**; `embedded_signup_enabled=false`; App ID e Config ID preenchidos | confirmado (leitura) |
| Tamanho dos dados que as migrations tocam | `whatsapp_messages` 262 linhas / 680 kB; `whatsapp_webhook_events` 995 / 480 kB ⇒ o `ADD CHECK`/`ADD COLUMN` varre poucas linhas (sem janela de bloqueio relevante) |
| Upgrade simulado sobre dados "de produção" (empresa tradicional com conexão manual, 5 conversas, mensagens, jobs da IA) | `coexistence-publication-audit.mjs` **26/26**: migrations aplicam, **nenhuma linha existente muda**, conexão Djalexeventos idêntica coluna a coluna, hashes de conteúdo iguais, só as 2 funções esperadas mudam |
| Rollback encadeado 1125→1124→1123 **com dados de Coexistence**, depois reaplicar | passa; funções voltam ao texto exato anterior; ACL preservada |
| Jornada integrada (signup + webhook + IA + sync, Coexistence e Cloud API lado a lado) | `coexistence-e2e.mjs` **21/21** |
| Compatibilidade entre versões (código HEAD × banco novo; código novo × banco antigo) | `coexistence-compat.mjs` **10/10** |
| Suítes das etapas 2–4 + regressão do WhatsApp (foundation, operations, IA auto/e2e, avisos, PDF, cliente, token, piloto, signup) | todas verdes (ver relatórios das etapas); `upgrade.mjs` e `order-engine-upgrade.mjs` já falham **sem** estas migrations (não relacionadas) |
| Mutantes (etapas 2/3/4) | 45/46, 33/34 e 36/36 detectados; sobreviventes são equivalentes |
| Secrets de Edge necessários existem | `WHATSAPP_APP_SECRET`, `WHATSAPP_GRAPH_API_VERSION`, `WHATSAPP_VERIFY_TOKEN` presentes (valores não lidos) |

## 2. Riscos por gravidade
**Crítico:** nenhum.

**Alto**
- **H1 — Automação de publicação:** `git push` em `main` com arquivos em `supabase/migrations/**` pode disparar `deploy-supabase.yml` (aplica migrations se os secrets existirem; hoje falha com 0 jobs, mas não confiar) e a Vercel publica o frontend automaticamente. *Mitigação:* aplicar as migrations **manualmente antes** do push (o workflow vira "up to date"), e fazer o push **por último**.
- **H2 — Janela de 24 h da Meta:** a documentação diz que, após o onboarding, há 24 h para sincronizar contatos/histórico "senão o cliente deve ser offboardado". **Não está claro** se a Coexistence funciona sem pedir a sincronização. Nossa trava mestra está desligada (de propósito: o pedido vale uma vez e ainda não importamos). *Decisão necessária antes do piloto:* pedir só os **contatos** (e/ou histórico) dentro das 24 h do teste, ou aceitar o risco de reonboarding. Confirmar com a Meta/teste.

**Médio**
- **M1 / A1 — CORRIGIDO localmente (2026-11-15)** — ver `whatsapp-coexistence-a1.md`. (Original: `ACCOUNT_RECONNECTED` com outra conexão ativa dava 500 e reentrega por 7 dias.)
- **M2 — Mensagens recebidas com a conexão pausada/desconectada:** o webhook responde 200 e **descarta** (a Meta não reentrega). Durante `OFFBOARDED`/`PARTNER_REMOVED` a Meta também suspende a entrega, então o impacto esperado é baixo, mas é perda irrecuperável se ocorrer.
- **M3 — Ordem de publicação do webhook:** assinar os 4 campos na Meta **antes** do webhook novo estar no ar faz o webhook antigo responder 200 e **descartar** ecos/histórico/account_update (provado em `coexistence-compat` A.3). *Mitigação:* assinar só depois do deploy.
- **M4 — Fluxo Cloud API tradicional pode "falhar fechado":** se a Meta omitir `is_on_biz_app` em números comuns, novas conexões tradicionais pelo Embedded Signup serão interrompidas com mensagem clara (nada é registrado). Não afeta clientes existentes nem o piloto de Coexistence (exige `true` explícito).
- **M5 — Tamanho do corpo do webhook (8 MiB):** o limite da plataforma de Edge Functions e o tamanho real dos pedaços de histórico **não foram confirmados**; um pedaço rejeitado só atrasa o estado da sincronização (nada é importado).
- **M6 — Eco = "humano":** a Meta não marca o eco como humano; tratamos todo eco de conexão em Coexistence como atendimento humano e deduplicamos contra envios nossos em fila. Se a Meta ecoar também mensagens da API, o casamento por texto cobre o caso comum, mas só o teste real confirma.

**Baixo**
- Eco só com BSUID (sem telefone) não é mapeável (registrado, IA não pausa); `edit`/`revoke` só registrados; sem alerta ativo ao dono em desconexão (banner apenas); sem UI da sincronização; limitações da Coexistence (grupos, 20 mps, inatividade de ~14 dias) não explicadas na tela; token do Embedded Signup sem duração conhecida; `whatsapp-token-sweep` 4.1 é instável por tempo (passa isolado); app Desktop bloqueado para o Embedded Signup.

## 3. Compatibilidade entre versões (matriz)
| Cenário | Resultado |
|---|---|
| Edge/webhook **antigos** + banco **novo** (migrations primeiro) | tradicional **funciona**; webhook antigo ignora com 200 os campos novos (ver M3); frontend novo + Edge antiga: campo extra ignorado; Coexistência sem `phone_number_id` → 400 limpo, nada registrado |
| Edge/webhook **novos** + banco **antigo** (ordem errada) | tradicional **funciona** (a RPC antiga aceita `cloud_api`); Coexistência **falha fechada** (nada registrado); eco/account_update → 500 transitório (nada gravado errado) |
| Conclusão: ordem segura = **migrations → Edge signup-complete → webhook → (só então) campos na Meta → frontend (push)** | |

## 4. Pré-requisitos no painel da Meta (não verificáveis daqui)
1. App em modo **Live**; permissões `whatsapp_business_management` e `whatsapp_business_messaging` aprovadas (confirmado por você); empresa verificada.
2. App Dashboard › WhatsApp › Configuration: **callback URL** da Edge `whatsapp-webhook` e **verify token** (já existentes) e campos assinados: `messages` (já), **`account_update`, `history`, `smb_app_state_sync`, `smb_message_echoes`** — assinar **depois** do deploy do webhook novo e **antes** do onboarding do piloto.
3. Facebook Login for Business: Config ID `1293818852874387` (v4, onboarding do app Business ligado, `app_only_install` desmarcado — como informado); *Allowed domains* e *Valid OAuth redirect URIs* com o domínio de produção; *Login with the JavaScript SDK* = Sim.
4. Número do piloto: WhatsApp **Business** app ≥ 2.24.17, número brasileiro (elegibilidade não confirmada na doc — validar na tela do Embedded Signup), sem Cloud API ativa, cliente com o app aberto regularmente.

## 5. Checklist de publicação (ordem)
Pré-voo: [ ] decisão sobre H2; [ ] decisão sobre A1 (corrigir antes?); [ ] anotar versões atuais das Edges (`whatsapp-signup-complete` v2, `whatsapp-webhook` v10) e o commit `dc54164`.
1. [ ] Commit local (sem push). 2. [ ] `supabase db push --dry-run` → deve listar só as 3 migrations. 3. [ ] `supabase db push` (aplica 1123, 1124, 1125). 4. [ ] Verificar (leitura): colunas/tabelas novas, ACL das RPCs (só service_role), `coexistence_sync_enabled=false`, `embedded_signup_enabled=false`, Djalexeventos inalterada (status/mode/type/token).
5. [ ] Deploy `whatsapp-signup-complete`. 6. [ ] Deploy `whatsapp-webhook` e testar o GET de verificação e um POST assinado de `messages` (Djalexeventos). 7. [ ] (opcional) deploy `whatsapp-coexistence-sync` (JWT; trava desligada).
8. [ ] `git push` (frontend via Vercel; o botão segue desabilitado: flag e allowlist). 9. [ ] Verificar a tela `/app/configuracoes/whatsapp` (botão desabilitado com a mensagem de "ainda não liberada").
10. [ ] Só então assinar os 4 campos no painel da Meta e conferir o envio de teste do painel.
Piloto (com autorização separada): [ ] `master_whatsapp_pilot_set('<alexproapps>', true, 'nota')` (ALEXPROAPPS: módulos WhatsApp+IA ativos, 0 conexões, 2 owners/admins, nunca a Djalexeventos); [ ] `embedded_signup_enabled=true` (global, mas só a empresa da allowlist passa); [ ] cadastrar destinatários de teste (a conexão nasce em modo `test`); [ ] ligar `coexistence_sync_enabled` apenas se a decisão H2 for pedir contatos; [ ] acompanhar logs/eventos durante o onboarding; [ ] ao final, desligar as flags e revogar a allowlist se não for continuar.

## 6. Plano de rollback (do menos para o mais invasivo)
1. **Flags (imediato, sem perda):** `embedded_signup_enabled=false`; `coexistence_sync_enabled=false`; `master_whatsapp_pilot_set(<empresa>, false, 'motivo')`. Conexões, tokens, PINs e mensagens não são tocados.
2. **Meta:** desassinar os 4 campos no painel; se o número piloto já conectou, desconectar no app (Configurações › Conta › Plataforma Business › Desconectar) e/ou `whatsapp_disconnect` no sistema.
3. **Edges:** reimplantar o código do commit `dc54164` para `whatsapp-signup-complete` e `whatsapp-webhook` (e remover/ignorar `whatsapp-coexistence-sync`).
4. **Frontend:** reverter o deploy na Vercel para o anterior.
5. **Banco (último recurso, na ordem inversa):** `supabase/rollbacks/whatsapp-coexistence/20261125010000_rollback.sql` → `…124…` → `…123…`. **Limitações com dados:**
   - **1125:** apaga `whatsapp_coexistence_sync(_attempts)`. Perde a memória de "já pedi contatos/histórico neste ciclo" — reaplicar depois pode permitir um segundo pedido (a Meta aceita só um). *Se houver tentativas registradas, prefira apenas desligar `coexistence_sync_enabled` e manter as tabelas.*
   - **1124:** apaga as mensagens de eco (`sent_via='business_app'`, espelho das respostas do celular), eventos `echo` da deduplicação, a trilha `whatsapp_coexistence_events` e as colunas de ciclo de vida. Conexões que o webhook pausou/desconectou (`status` `error`/`disconnected`) **não** voltam sozinhas: reativar manualmente depois de conferir na Meta. Conversas criadas por eco permanecem (com a IA pausada).
   - **1123:** reversível sem perda; conexões já gravadas como `coexistence` ficam, mas a RPC antiga recusará reconectá-las (`PT400`) — reconectar exige a migration ou desconexão manual.
   - Nenhum rollback altera mensagens/conexões da Cloud API tradicional (provado em teste).
   - Fazer **dump das tabelas afetadas** antes de qualquer rollback com dados de Coexistence.

## 7. Pendências antes do primeiro teste real
- **P1 (decisão):** política das 24 h (H2) — pedir contatos no piloto? histórico fica para quando houver importação.
- **P2:** ~~corrigir A1~~ — corrigido localmente; aplicar junto com a migration `20261124010000` (que foi editada, ainda não aplicada).
- **P3 (Meta):** assinar os 4 campos **depois** do deploy; conferir domínios/redirect URIs do Login for Business e o Config ID.
- **P4 (piloto):** escolher o número (app Business ≥ 2.24.17, BR) e os destinatários de teste; combinar quem observa os logs; plano de desligar tudo.
- **P5 (validar no teste):** `is_on_biz_app` real do número em Coexistence (`true`+`CLOUD_API`), payload real do `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`, se há eco de mensagens da API, comportamento do corpo de histórico grande.
- Desejáveis (não bloqueiam): aviso ao dono em desconexão, tela de estado da sincronização, texto de limitações da Coexistence na tela, limite real de corpo da Edge.

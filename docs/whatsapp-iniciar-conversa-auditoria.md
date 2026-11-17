# Iniciar conversa pelo WhatsApp a partir de Contatos — auditoria (Etapa 7.11A)

Somente auditoria. Nenhum código, banco, Meta ou conexão foi alterado; nenhuma mensagem foi enviada. Estado do remoto lido em 2026-11-17 (somente leitura, sem dados pessoais).

## 1. Como a plataforma funciona hoje

| Tema | Achado |
|---|---|
| Envio | Edge `whatsapp-send` (JWT) → RPC `whatsapp_prepare_outbound_message` (valida papel, módulo, conexão ativa, conversa aberta, janela de 24 h, modo teste; grava mensagem `queued`, idempotente por `client_request_id`) → `_shared/whatsapp-dispatch.ts` (service_role lê o token no Vault via `whatsapp_get_send_context`, chama a Graph API, marca `sent`/`failed`). O token nunca vai ao navegador. |
| Graph API | `_shared/whatsapp-graph.ts` só sabe `sendText`, upload de mídia e `sendDocument`. **Não existe envio de template.** Versão vem do secret `WHATSAPP_GRAPH_API_VERSION` (sem default). |
| Conexão por empresa | `company_whatsapp_connections`: uma ativa por empresa (índice único), `phone_number_id`, `waba_id`, token no Vault, `mode` (`test`/`live`), `connection_type` (`cloud_api`/`coexistence`), saúde do token. Remoto: 2 conexões ativas — uma `test`/`cloud_api` e uma `live`/`coexistence`. Todas têm WABA, token e webhook ativo. |
| Templates | **Nada.** Não há tabela, sincronização nem envio de template. Só existem o tipo `template` aceito em `whatsapp_messages.type` e o texto "Será necessário usar um template aprovado" (barreira que hoje bloqueia). 0 mensagens de template no remoto. |
| Janela de 24 h | `whatsapp_can_send_freeform(last_inbound_at)`: texto livre só até 24 h depois da última mensagem **recebida**. Sem mensagem recebida (`last_inbound_at` nulo) = bloqueado. Regra única no servidor. |
| Conversa | `whatsapp_conversations`: única por (conexão, telefone) entre as não excluídas (índice parcial). A conversa nasce hoje **só** quando chega mensagem (webhook `whatsapp_ingest_message`, `ON CONFLICT (connection_id, contact_phone)`) ou eco de Coexistence. Nenhum RPC cria conversa pela empresa. |
| Abrir na caixa | `?conversation=<id>` (7.5) já abre a conversa pelo id. |
| IA | `ai_control` por conversa (`inherit`/`human`). Envio manual `origin='human'` pausa a IA (gatilho `whatsapp_ai_pause_on_human_outbound`, só no modo auto). Eco do app Business também pausa. A IA só é acionada por mensagem **recebida**. |
| Coexistence | `whatsapp_ingest_echo` procura mensagem nossa `queued`/`cloud_api` sem wamid (últimos 10 min) para não tratar o eco como atendimento humano (`echo_api_match`). Isso exige que a conversa e a mensagem `queued` já existam antes da chamada à Meta. |
| Permissões | `whatsapp_assert_reader` (owner/admin/attendant/cashier + módulo). O envio manual atual não restringe mais que isso. |
| Consentimento | **Nenhuma infraestrutura** de opt-in/opt-out. |
| Telefone | Meta entrega `wa_id` brasileiro muitas vezes **sem o nono dígito** (ex.: conversa `554498807633`). A conversa é única por telefone **exato**; o webhook (`whatsapp_ingest_message`) não usa equivalência do nono dígito (o eco e a barreira do modo teste usam `whatsapp_br_phone_equivalent`). |
| Erros Meta | `dispatch` já classifica 190 (token), timeout/rede/HTTP, grava `error_code` sanitizado, e não repete envio em timeout ("confira antes de reenviar"). |

## 2. Conclusão central

Iniciar conversa com quem **nunca escreveu** é, para a Meta, uma conversa iniciada pela empresa: **só é possível com template aprovado**. Texto livre nunca vale (não há `last_inbound_at`). Portanto "Iniciar conversa" = "enviar template". O trabalho grande não é o botão: é (a) infraestrutura de templates, (b) criar a conversa de forma segura contra duplicidade, (c) consentimento.

## 3. Arquitetura recomendada

1. **Templates (cache por conexão)** — tabela `whatsapp_message_templates` (connection_id, nome, idioma, categoria, status, componentes sanitizados, nº de variáveis, `synced_at`). Edge `whatsapp-templates-sync` (JWT, owner/admin) lê `GET /{waba_id}/message_templates` com o token do Vault (o login do Embedded Signup já lista números da WABA, indício de escopo de gerenciamento; **confirmar o escopo** `whatsapp_business_management` na primeira chamada real). Sincroniza sob demanda com TTL (ex.: 15 min) em vez de depender do webhook de status de template (não mexer no webhook). A tela lista só `APPROVED`.
2. **Envio de template** — novo `sendTemplate` no adapter (`type: "template"`, `template: { name, language: { code }, components }`), sem alterar `sendText`/`sendDocument`. O despacho ganha um ramo para template; o ramo de texto continua idêntico (testado por diferencial, como na 7.10D).
3. **RPC `whatsapp_start_conversation(p_company_id, p_contact_id | p_customer_id, p_template_id, p_params, p_client_request_id, p_consent_confirmed)`** (JWT, DEFINER):
   - sessão, empresa, módulo, papel (owner/admin/attendant; caixa não), escrita não bloqueada (PT402), conexão ativa, token saudável;
   - **telefone resolvido no servidor** a partir do contato manual/cliente (nunca vindo do cliente), validado como E.164;
   - cliente ativo e da mesma empresa; contato manual ativo;
   - busca conversa ativa **equivalente** (`whatsapp_br_phone_equivalent`): se existir, **não cria outra** — devolve a existente (a mensagem usa a mesma, com a mesma validação de template);
   - senão cria a conversa com `contact_phone` na forma canônica da Meta (chave sem o nono dígito quando equivalente), `ai_control = 'human'`, vínculo ao cliente, `ON CONFLICT` no índice único (corrida com mensagem recebida → reaproveita);
   - grava a mensagem `queued` (`type='template'`, corpo renderizado para exibição, `origin='human'`, `sent_via='cloud_api'`, `client_request_id`) **antes** da chamada externa; idempotência por (empresa, `client_request_id`);
   - evento de auditoria (`created` da conversa + novo tipo `started_by_company`) com ids, sem texto da mensagem nem telefone.
4. **Edge `whatsapp-start-conversation`** (JWT; mesmo molde do `whatsapp-send`): chama a RPC, depois o despacho; devolve `{ conversation_id, message_id, status }`. Nunca devolve token nem telefone.
5. **Frontend**: botão **Iniciar conversa** só no cartão/detalhe de contato **sem conversa** (manual ou cliente), para quem pode enviar e quando houver conexão ativa e ≥ 1 template aprovado. Modal: escolher template/idioma, preencher variáveis (nome do contato pré-preenchido), pré-visualização, caixa de confirmação de consentimento, enviar. Após `ok`: navegar para `/operacional/whatsapp?conversation=<id>` (fluxo da 7.5, sem alterá-lo). Erro: mensagens claras; nunca criar cliente ou contato.
6. **Consentimento** — fase 1: confirmação explícita do operador no envio ("este contato autorizou receber mensagens da empresa"), gravada no evento (quem, quando, template). Fase 2: estado por contato (`opted_in`/`opted_out`/`unknown`) + respeitar pedido de saída ("PARAR") e bloquear envios para `opted_out`.
7. **Controles de abuso/custo** — flag por empresa (desligada por padrão; ligar primeiro na conexão de teste), teto diário de templates por empresa, intervalo mínimo entre templates para o mesmo contato.

## 4. Riscos e mitigação

| Risco | Gravidade | Mitigação |
|---|---|---|
| **Conversa duplicada** (9º dígito): criar com um formato e o webhook receber a resposta no outro | Alta | Criar sempre na forma canônica (a que a Meta usa); busca por equivalência antes de criar; etapa própria para endurecer `whatsapp_ingest_message` com equivalência (função quente; teste diferencial e mutantes) **antes** de liberar |
| Envio duplicado (clique duplo/retry/timeout) | Alta | mensagem `queued` antes da chamada; `client_request_id` único; timeout não repete ("confira antes de reenviar"); intervalo mínimo por contato |
| Spam/qualidade do número (bloqueios, limite de marketing 131049, banimento) | Alta | consentimento, só templates aprovados, teto diário, flag por empresa |
| Coexistence tratar nosso envio como atendimento humano | Média | conversa e mensagem `queued` existem antes da Graph; o eco `api_match` já cobre; testar com eco simulado |
| IA responder sozinha à resposta | Média | `ai_control='human'` na criação; retomar IA continua manual |
| Custo por template | Média | tela mostra categoria; teto diário; relatório futuro |
| Escopo/token sem permissão de templates | Média | validar no remoto antes de construir a tela; falha amigável |
| Template reprovado/pausado/excluído entre o cache e o envio | Média | revalidar status no servidor no envio; tratar 132001/132012/132015/132016 |
| Alterar função quente (`whatsapp_get_send_context`) | Alta | não alterar; novo contexto para template ou ramo isolado com diferencial |
| Vazamento entre empresas | Alta | tudo por RPC DEFINER com empresa do usuário; template e contato conferidos na mesma empresa; PT404 uniforme |

Erros da Meta a mapear (confirmar lista na documentação vigente na implementação): 131030 (fora da lista de teste), 131026 (não entregável), 131047 (fora da janela), 131048/131049 (limites de qualidade/marketing), 130429/131056 (taxa), 132000 (parâmetros), 132001 (template inexistente), 132005/132007/132012/132015/132016 (conteúdo/pausado/desabilitado), 190 (token).

## 5. Plano em etapas pequenas (cada uma com autorização própria)

1. **7.11B — Fundamentos de banco (local):** tabela de templates, colunas de metadados do template na mensagem, tipo de evento, flag/teto por empresa; migration + rollback + testes PGlite.
2. **7.11C — Sincronização de templates (local → remoto só leitura):** Edge `whatsapp-templates-sync` + adapter GET; testes com Graph simulada; validar escopo do token com uma leitura real na conexão de teste.
3. **7.11D — Endurecer o webhook:** `whatsapp_ingest_message` com equivalência do nono dígito, sem mudar o resultado atual (teste diferencial + mutantes). Pré-requisito da etapa F.
4. **7.11E — Despacho de template:** `sendTemplate` no adapter + ramo isolado no despacho, texto idêntico ao atual (diferencial); classificação de erros.
5. **7.11F — RPC e Edge de iniciar conversa:** `whatsapp_start_conversation`, idempotência, equivalência, consentimento fase 1, auditoria, Coexistence/IA; testes de concorrência.
6. **7.11G — Frontend:** botão, modal, pré-visualização, abertura via `?conversation=`; testes e homologação visual com dados simulados.
7. **7.11H — Publicação em duas pontas:** migrations → Edge (deploy manual) → frontend; **homologar primeiro na conexão `test` com destinatário autorizado**; só depois liberar a flag na conexão live/Coexistence.

## 6. Decisões necessárias do dono do produto

1. Quem pode iniciar conversa: owner/admin/attendant (recomendado) ou também o caixa?
2. Consentimento: aceitar a confirmação do operador na fase 1?
3. Teto diário de templates por empresa e intervalo mínimo por contato (sugestão: 50/dia e 24 h).
4. Templates: cada empresa cria no Gerenciador da Meta (recomendado) ou o app criará templates (fora do escopo inicial)?
5. Primeiro ambiente de homologação: conexão `test` com 1 destinatário autorizado (recomendado).

# WhatsApp Coexistence — contrato oficial da Meta (Etapa 1, somente documentação)

Data da consulta: 2026-11-15. Nenhum código funcional, banco, flag ou configuração da Meta foi alterado.
As páginas oficiais **não exibem data de atualização**; o que está aqui vale para a consulta acima e deve ser reconferido antes da implementação.
Legenda: **[C]** confirmado em página oficial · **[?]** não confirmado / inferência nossa.

## Fontes oficiais (developers.facebook.com)
- Coexistence ("Onboard WhatsApp Business app users"): `/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users` (a rota antiga `/docs/whatsapp/embedded-signup/custom-flows/onboarding-business-app-users` também respondeu)
- Reconexão após offboarding: `/documentation/business-messaging/whatsapp/embedded-signup/reconnect-offboarded-coexistence-clients`
- Implementação do Embedded Signup: `/documentation/business-messaging/whatsapp/embedded-signup/implementation`
- Onboarding como Tech Provider: `/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider`
- Webhooks: `/docs/whatsapp/cloud-api/webhooks/reference/{smb_message_echoes,smb_app_state_sync,history,account_update}`
- Throughput: `/documentation/business-messaging/whatsapp/throughput`
- Índice geral: `/documentation/business-messaging/whatsapp/llms.txt`
- Aviso nas páginas: Embedded Signup **v2 e v3 foram descontinuados em 15/10/2026**; v4 é a base atual e, na **v5**, o `featureType` deixa de ser necessário (Coexistence vem ligada por padrão).
- Nota de segurança: uma das páginas buscadas continha texto dirigido a agentes ("criar um documento"); foi ignorado.

## 1. `featureType`, `sessionInfoVersion` e eventos
- **[C]** Página de Coexistence: `extras = { setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" }`, junto de `config_id`, `response_type: "code"`, `override_default_response_type: true`. A página padrão do v4 mostra só `extras: { setup: {} }`.
- **[C]** v5: `featureType` desnecessário; para desligar a Coexistence usa-se `features: { name: "whatsapp_business_app_onboarding", enabled: false }`. Verificação sugerida pela Meta: a tela de seleção de conta mostra a opção de conectar uma conta WhatsApp Business existente.
- **[C]** Eventos `postMessage` (`type: "WA_EMBEDDED_SIGNUP"`, origem terminando em `facebook.com`):
  - Coexistence: `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`, `data = { waba_id }`.
  - Normal: `FINISH`, `data = { phone_number_id, waba_id, business_id, ... }`.
  - Outros: `FINISH_ONLY_WABA`, `FINISH_GRANT_ONLY_API_ACCESS`, `CANCEL` (`current_step`), `ERROR` (`error_message`, `error_code`, `session_id`, `timestamp`).
  - O `code` é devolvido ao callback do `FB.login` só quando o usuário clica em Concluir; vale **30 s**.
- **[?]** O payload de Coexistence cita apenas `waba_id`. **Não vem `phone_number_id` garantido**: o backend precisará descobrir o número consultando a WABA (`/{waba}/phone_numbers`), nunca confiando no navegador.
- **[?]** Qual combinação a conta realmente usa (v4 + `featureType` + `sessionInfoVersion 3`, como na configuração do Config ID) só se confirma no primeiro teste real.

## 2. `/register`
- **[C]** A página de Coexistence manda onboardar "como de costume, **mas pular o registro do número**, pois já está registrado". Portanto **não chamar `POST /{phone}/register`** (nem gerar/guardar PIN) na Coexistence.
- **[C]** A API de *deregister* não pode ser usada num número em uso simultâneo com o app.
- **[C]** Fluxo Cloud API normal: o `register` com PIN de 6 dígitos é o passo 3 da página de Tech Provider (o que fazemos hoje).

## 3. Webhooks
- **[C]** Assinar no App Dashboard > WhatsApp > Configuration, **antes** de onboardar (senão perde-se webhooks): `account_update`, `history`, `smb_app_state_sync`, `smb_message_echoes` (além de `messages`, já usado).
- **[C]** A assinatura do app na WABA do cliente continua sendo `POST /{waba}/subscribed_apps` com o token do cliente, **sem corpo**. **[?]** Se há `subscribed_fields`/`override_callback_uri` nesse corpo: não consta na página (há link para a doc de override, não lida).
- **[C]** `account_update` é exigido pelo Embedded Signup. **[?]** Nomes das permissões por webhook/endpoint: não constam nas páginas lidas (as aprovadas são `whatsapp_business_management` e `whatsapp_business_messaging`).
- Formatos (todos em `entry[].changes[].value`, `entry[].id` = WABA):
  - `smb_message_echoes`: `metadata.phone_number_id`, `message_echoes[]` {`from` = número do negócio, `to` (pode faltar), `to_user_id`, `id`, `timestamp`, `type`, objeto do tipo; também `revoke` e `edit`}.
  - `smb_app_state_sync`: `state_sync[]` {`type:"contact"`, `contact{full_name, first_name, phone_number?, user_id}`, `action: add|remove`, `metadata.timestamp`}.
  - `history`: `history[].metadata{phase 0|1|2, chunk_order, progress 0–100}`, `threads[]{context, messages[]}`; mensagem com `history_context.status`; recusa do cliente = erro **2593109**.
  - `account_update`: `PARTNER_ADDED`, `PARTNER_REMOVED` (+`disconnection_info{reason, initiated_by}`), `ACCOUNT_OFFBOARDED`, `ACCOUNT_RECONNECTED`.
- **[C]** A documentação recomenda identificar usuários por `user_id`/`to_user_id` (BSUID), não só por `wa_id`: `wa_id`/telefone pode faltar.

## 4. Detectar atendimento humano e evitar resposta dupla da IA
- **[C]** `smb_message_echoes` = mensagem enviada **pelo app Business ou aparelho acompanhante** (também edição e revogação).
- **[?]** Não há campo "é humano". Tratar todo eco como "envio humano pelo app" é **inferência nossa**; nossas mensagens enviadas pela API **não** aparecem como eco (a doc só diz que o eco é do app/companion), mas isso deve ser provado no teste real, deduplicando pelo `wamid` das mensagens já enviadas por nós.
- **[C]** Mensagens do app não criam nem estendem a janela de 24 h da Cloud API.
- Ajuste proposto: eco → gravar como mensagem de saída "humano/app" e **pausar a IA daquela conversa** por um período configurável.

## 5. Sincronização de contatos e histórico
- **[C]** `POST /{version}/{phone_number_id}/smb_app_data` (Bearer do cliente), corpo `{ "messaging_product":"whatsapp", "sync_type": ... }`:
  1. `smb_app_state_sync` (contatos) → webhooks `smb_app_state_sync`;
  2. `history` → webhooks `history`, ou erro 2593109 se o cliente recusou.
  Resposta de sucesso: `{messaging_product, request_id}` (guardar `request_id`; aceitar ≠ cliente ter compartilhado).
- **[C]** Prazo: **24 h após o onboarding**; senão o cliente precisa ser offboardado e refazer o fluxo. **Cada sincronização só pode ser pedida uma vez.**
- **[C]** Janela: até 180 dias (fases: 0 = dia 0–1, 1 = dia 1–90, 2 = dia 90–180). Chunks podem chegar fora de ordem (ordenar por `chunk_order`); `progress = 100` encerra. Fase sem histórico não gera webhook. Grupos excluídos. Mídia chega como `media_placeholder` e o id vem em webhook separado só para mídia recente (a doc fala "14 dias" e "duas semanas" — **[?]** inconsistente).
- **[C]** Um único webhook pode ter milhares de mensagens: gravar bruto primeiro e processar de forma assíncrona.
- **[?]** Sem a página de referência do `smb_app_data` (404), os únicos `sync_type` conhecidos são os dois acima.

## 6. Elegibilidade e limitações (número brasileiro)
- **[C]** App WhatsApp Business **2.24.17 ou superior**; parceiro Tech Provider/Solution Partner com session logging; número é o do **app Business** (WhatsApp pessoal não vale).
- **[C]** Não suportado na Coexistence: grupos, listas de transmissão (somem/ficam somente leitura), mensagens temporárias, visualização única, localização em tempo real, chamadas (via Cloud API), mensagens de marketing, mensagens de saudação/ausência/respostas rápidas/etiquetas via API, catálogo/perfil/status/canais.
- **[C]** **Vazão fixa de 20 mps** (entrada + saída), contra 80 mps padrão.
- **[C]** Desconexão: no app (Configurações > Conta > Plataforma Business > Desconectar) → `PARTNER_REMOVED` (`reason`: ACCOUNT_DISCONNECTED, BUSINESS_DOWNGRADE, CHANGE_NUMBER, COMPANION_INACTIVITY, PRIMARY_INACTIVITY, USER_RE_REGISTERED). Inatividade: **aparelho principal ~14 dias**, acompanhante ~30 dias. (A "regra de 13 dias" que circula **não** consta nas páginas.)
- **[C]** Troca de aparelho/reregistro: `ACCOUNT_OFFBOARDED` e depois `ACCOUNT_RECONNECTED`; durante a reconexão envio/recebimento pela Cloud API ficam suspensos → pausar envios pendentes.
- **[?] Brasil:** nenhuma página lista países suportados/bloqueados nem cita o Brasil; também não há exigência de idade mínima da conta. **Confirmar na própria conta-piloto** (a tela da Meta mostra se o número é elegível) e/ou com suporte da Meta (tópico "WABiz: Onboarding" › "Embedded Signup - Coexistence Onboarding").
- **[?]** Regras de nome de exibição e comportamento de *status* de entrega dos envios via API na Coexistence: não confirmados.

## 7. Identificar a Coexistence de forma confiável no backend
- **[C]** `GET /{phone_number_id}?fields=is_on_biz_app,platform_type` → Coexistence ativa = `is_on_biz_app: true` e `platform_type: "CLOUD_API"`. **Fonte da verdade proposta** (consultada pela Edge com o token do cliente).
- **[C]** Sinais auxiliares: evento `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` (navegador: só dica), chegada de `smb_message_echoes`/`history`/`smb_app_state_sync`.
- **Regra:** o navegador nunca define o modo. O backend decide por `is_on_biz_app` e grava `connection_type='coexistence'` (o CHECK já aceita o valor).
- **[?]** Eventos `account_update` de instalação (`PARTNER_APP_INSTALLED` etc.) existem, mas sem detalhe confirmado para este uso.

## 8. Token e subscrição (Tech Provider)
- **[C]** Troca: `GET /oauth/access_token?client_id&client_secret&code` → `{access_token, token_type:"bearer"}`, no servidor. `redirect_uri` não aparece na página (**[?]** nem "não precisa": hoje não enviamos). Validade do token: **[?]** não informada.

## Ajustes necessários no nosso código (pendentes de autorização)
| # | Onde | Ajuste |
|---|---|---|
| 1 | `whatsappSignupFlow.ts` | `extras` com `featureType` + `sessionInfoVersion:"3"` quando a sessão for Coexistence (decisão: sempre ou só no piloto) |
| 2 | `whatsappSignupLogic.ts` (`parseSignupMessage`) | aceitar `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` (só `waba_id` obrigatório; `phone_number_id` opcional) em vez de `unsupported` |
| 3 | Edge `whatsapp-signup-complete` | no ramo Coexistence: descobrir o número via `/{waba}/phone_numbers`, conferir `is_on_biz_app`, **não** gerar PIN nem chamar `/register`, gravar `connection_type='coexistence'`; manter allowlist, state e conflitos |
| 4 | `_shared/whatsapp-signup-graph.ts` | novos métodos: `getPhoneStatus` (`is_on_biz_app, platform_type`) e `requestSmbAppData(sync_type)` |
| 5 | `whatsapp-webhook` | tratar `smb_message_echoes`, `smb_app_state_sync`, `history`, `account_update` (gravação bruta + processamento assíncrono, `event_key` para idempotência, BSUID) |
| 6 | Banco (migration futura) | colunas/tabelas para ecos, estado da sincronização (24 h, único), pausa da IA por conversa, estado `offboarded/reconnecting` |
| 7 | IA/envio | pausar a IA após eco humano; pausar envios em `ACCOUNT_OFFBOARDED`; respeitar 20 mps |
| 8 | Tela | avisos das limitações (grupos, listas, chamadas, uso do app a cada ~14 dias) e do prazo de 24 h |
| 9 | Painel Meta (você) | assinar `account_update`, `history`, `smb_app_state_sync`, `smb_message_echoes` no App Dashboard **antes** do piloto |

## Pontos ainda incertos (resolver no teste/ com a Meta)
Brasil e idade da conta; payload real do `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` (presença de `phone_number_id`); `redirect_uri`; duração do token; permissões exatas por endpoint; `subscribed_fields`/override por WABA; status de entrega das mensagens via API na Coexistence; se o histórico de 24 h é viável de cumprir no piloto.

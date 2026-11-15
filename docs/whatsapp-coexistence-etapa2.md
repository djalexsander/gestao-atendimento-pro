# Coexistence — Etapa 2 (frontend + Edge, somente local)

Referência: `docs/whatsapp-coexistence-contrato-meta.md`. **Nada foi publicado, aplicado, ativado ou conectado.** Flag `embedded_signup_enabled`
continua `false` no remoto; webhook, sincronização de histórico/contatos e allowlist não foram tocados.

## O que mudou
| Camada | Arquivo | Mudança |
|---|---|---|
| Frontend | `whatsappSignupFlow.ts` | `FB.login` com `extras: { setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" }`; payload sem `phone_number_id` quando a Meta não o informa; `signup_event` (dica) |
| Frontend | `whatsappSignupLogic.ts` | `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` vira `finish` com `coexistence: true` (só `waba_id` obrigatório); `FINISH` normal inalterado; demais `FINISH_*` continuam `unsupported` |
| Graph client | `_shared/whatsapp-signup-graph.ts` | `getPhoneStatus` (`GET /{phone}?fields=is_on_biz_app,platform_type`) e `decideConnectionMode` |
| Edge | `whatsapp-signup-complete/handler.ts` | descoberta do número pela WABA, modo decidido pelo Graph, sem PIN/`/register` na Coexistence, `connection_type` gravado, resposta traz `connection_type` |
| Banco | `20261123010000_whatsapp_coexistence_connection_type.sql` (**LOCAL, não aplicada**) | `whatsapp_signup_complete` aceita `coexistence` |
| Rollback | `supabase/rollbacks/whatsapp-coexistence/20261123010000_rollback.sql` | restaura a função de `20261107010000` |

## Regras de segurança
- **O navegador nunca define o modo.** `signup_event` é só dica. A Edge consulta o Graph com o token do próprio cliente:
  `is_on_biz_app=true` + `platform_type=CLOUD_API` → `coexistence`; `is_on_biz_app=false` → `cloud_api`; qualquer outra combinação (campo ausente,
  `true` com outra plataforma) → **409 `connection_mode_unknown`, falha fechada** (nada é registrado nem gravado).
- Dica de Coexistence + Graph diz que não é → **409 `mode_mismatch`**. Dica normal + Graph diz Coexistence → **vale o Graph** (pula `/register`: seguro).
- Falha/timeout ao consultar o modo → 502/504 `mode_check_failed` (falha fechada, sessão encerrada, token apagado do Vault pela limpeza existente).
- Coexistence: **sem PIN** (nem do cliente), **sem `/register`**, sem linha em `whatsapp_number_registrations`, `registered_at` nulo (o banco exige isso).
- `phone_number_id` ausente só é aceito com o evento de Coexistence; o número é o **único** da WABA em Coexistence (0 ou ≥2 → 400 `phone_not_resolved`, máx. 5 números consultados).
- Mantidos: sessão/state de uso único, dono da sessão, allowlist (3 conferências), token no Vault antes de qualquer efeito, conflito entre empresas,
  uma conexão ativa por empresa, idempotência, assinatura e conferência do webhook, ausência de segredos em log/resposta.

## Limitações conhecidas / a validar no teste real
- **[?]** Se a Meta devolve `is_on_biz_app` também para números Cloud API comuns. Se omitir o campo, o fluxo tradicional passa a falhar fechado
  (`connection_mode_unknown`); se isso ocorrer, a decisão é permitir `null` + `platform_type` conhecido apenas no fluxo tradicional.
- **[?]** Payload real do `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` (presença de `phone_number_id`).
- A conexão nasce em modo `test`, como no fluxo tradicional. **Não há sincronização de contatos/histórico (janela de 24 h) nem webhooks `smb_*`** — Etapas seguintes.
  Até lá, mensagens enviadas pelo celular não aparecem no Inbox e a IA não é pausada por atendimento humano.
- `meta_business_id` segue nulo.

## Para aplicar (somente com autorização)
1. Migration `20261123010000` (CREATE OR REPLACE; ACL idêntica; sem dados). 2. Deploy da Edge `whatsapp-signup-complete`. 3. Publicar o frontend.
Ordem importante: **migration antes da Edge** (a Edge nova envia `coexistence`, que a RPC antiga recusa). A Edge antiga continua compatível com a RPC nova.

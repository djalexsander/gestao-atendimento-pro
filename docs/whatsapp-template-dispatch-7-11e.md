# Despacho de templates oficiais da Meta — Etapa 7.11E (local, não aplicada)

Migration: `supabase/migrations/20261204010000_whatsapp_template_dispatch.sql` (1 tabela, 6 funções). Rollback: `supabase/rollbacks/whatsapp-template-dispatch/20261204010000_rollback.sql`.
Código: `supabase/functions/_shared/whatsapp-template-send.ts` (adaptador Graph) e `supabase/functions/_shared/whatsapp-template-dispatch.ts` (despacho).
Nada foi aplicado, publicado, ativado ou enviado. Nenhuma Edge nova (a que chamará o despacho é a 7.11F).

## O que ficou intocado (conferido por teste e por `git diff`)
`whatsapp_get_send_context`, `whatsapp_prepare_outbound_message`, `whatsapp_mark_message_*`, `whatsapp_ingest_message`, `_shared/whatsapp-graph.ts`, `_shared/whatsapp-dispatch.ts`, `whatsapp-send/*`, webhooks, IA, Coexistence. A migration só ADICIONA (o teste compara com o banco sem ela: todas as outras funções, tabelas, políticas e triggers saem idênticos). **Não foi preciso alterar o envio de texto nem a função crítica**, então não houve motivo para parar e propor.

## Desenho
Um contexto de envio PRÓPRIO para template (`whatsapp_get_template_send_context`), em vez de ramificar `whatsapp_get_send_context`: o template tem regras que o texto não tem (status/elegibilidade, variáveis, opt-out, claim). Ele repete só as barreiras comuns (módulo, conexão ativa, modo teste, saúde do token).

| Passo | Quem | O que faz |
|---|---|---|
| reserva (7.11B) | RPC futura 7.11F | valida, limita, grava `whatsapp_start_requests` |
| `whatsapp_template_message_enqueue` (interna) | RPC futura 7.11F, mesma transação | revalida template (APPROVED, elegível, nome/idioma), normaliza variáveis, **checa opt-out**, cria a mensagem `outbound/template/queued` (corpo renderizado) + metadados; idempotente pelo `client_request_id` |
| `whatsapp_get_template_send_context` (service_role) | Edge (7.11F) | **revalida tudo de novo** (template, variáveis, conexão, token, modo teste, opt-out) e faz o **claim atômico**; só quem ganha o claim recebe o token |
| Graph (`createTemplateSender`) | Edge | UMA tentativa, sem retry |
| `whatsapp_template_message_finish` (service_role) | Edge | `sent` (grava o id da Meta), `failed` (definitiva, libera a vaga) ou `uncertain` |

### Variáveis (validadas no servidor)
Array de textos, quantidade IGUAL à do template, cada uma aparada, 1–1024 caracteres, sem quebra de linha, tabulação ou 4 espaços seguidos (restrições da Meta). Valem no enfileiramento e de novo no envio.

### Falhas — regra central: nunca reenviar o que pode ter sido aceito
| Resultado | Mensagem | Pedido/vaga | Reenvio automático |
|---|---|---|---|
| 200 com id | `sent` + id da Meta | `sent` | — |
| 4xx da Meta (recusa definitiva), barreira local | `failed` + código | `failed`, **vaga liberada** | não |
| timeout, rede, 5xx, 200 sem id, JSON quebrado | continua `queued`, `error_code = unconfirmed_*` | continua `queued` (**vaga ocupada**, conta no intervalo por contato) | **nunca** (o claim já foi usado; o contexto responde `send_unconfirmed`) |
| processo cai depois do claim | `queued` | `queued` | nunca (`already_claimed`) |

Token 190 → `whatsapp_connection_report_token_failure` (mesma saúde de token do texto). 403/200 (permissão) não marca o token como inválido. Antes do envio, token expirado/revogado bloqueia sem chamar a Meta. Logs: só código/status; nunca token, telefone, variáveis nem resposta bruta (teste 61).

### Opt-out
- Já na reserva (7.11D); **de novo no enfileiramento** e **de novo no envio** (cobre bloqueio que surge depois da reserva).
- Falha ao consultar o opt-out → **bloqueia** (falha fechada) no enfileiramento e no envio; o recebimento de mensagens não usa essa consulta e segue normal (teste 49).
- Erro **131050** da Meta → mensagem `failed` e `whatsapp_optout_from_meta_error` registra o opt-out (fonte `meta_signal`, auditado).

#### Semântica do 131050 — confirmada (7.11F)
A página oficial de códigos de erro da Cloud API (https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/) descreve 131050 como o destinatário ter optado por parar de receber **mensagens de marketing** da empresa (ação: não reenviar; assinar o webhook `user_preferences`). Não afirma que vale para templates de utilidade. Decisão: tratar como opt-out do contato para novas iniciações (conservador, reversível com evidência). 131049 é limite de frequência, não opt-out (teste 52).

## Testes (`.claude/db-tests/whatsapp-template-dispatch.mjs`, 73 verificações; Graph simulada, adapter e despacho REAIS)
Template aprovado/reprovado/pausado/removido/pendente/inelegível, e mudança DEPOIS da reserva (pausado, reprovado, removido, mídia, renomeado, idioma, mais variáveis, apagado); variáveis corretas/ausentes/excesso/inválidas; isolamento multiempresa (token, conexão, template, conversa); token inválido (190), permissão (403/200), 429, token expirado, segredo ausente, conexão inativa, módulo, modo teste; timeout (abort real), rede, 5xx, 200 sem id; **5 despachos simultâneos = 1 chamada**; idempotência do enfileiramento; opt-out antes da reserva, depois da reserva, depois do enfileiramento, falha na consulta, 131050, 131049; regressão do texto/janela de 24 h; ACL; ausência de token em tabelas e logs; rollback. Mutantes em `.claude/db-tests/mutate-whatsapp-template-dispatch.mjs`.
Suítes 7.11B/C/D re-executadas: 54 / 67 / 24 / 58 — todas verdes. `whatsapp-optout.mjs` passou a carregar só as migrations até a sua (para continuar comparando "com × sem" sem enxergar a 7.11E).

## Riscos e lacunas (para a 7.11F e a ativação)
1. **Reconciliação de resultado ambíguo**: mensagens `queued` com `unconfirmed_*` e pedidos `queued` presos **não são resolvidos sozinhos**. Quando o webhook de status da Meta (já existente para texto) trouxer o `wamid`, a mensagem só será atualizada se tiver `provider_message_id`; como no caso ambíguo não temos o id, **não há correlação automática**. Precisa de rotina/ação do operador ("conferir/encerrar") na 7.11F ou depois. Enquanto isso o pedido ocupa a vaga e o intervalo do contato (comportamento deliberado, conservador).
2. **Claim sem término**: se a Edge cair entre o claim e o `finish`, a mensagem fica `queued` para sempre (também sem reenvio). Mesmo tratamento de (1).
3. **Webhook `user_preferences`** (a Meta avisa quando o usuário pede para não receber marketing) NÃO é tratado — alterar webhook estava fora desta etapa. Hoje o opt-out vem só de palavra-chave, ação manual e erro 131050.
4. A Edge/RPC que chama `reserve` → `conversa` → `enqueue` → `dispatchQueuedTemplate` é a **7.11F** (inclusive criar a conversa, o equivalente do nono dígito e o lock). `enqueue` e a reserva continuam fechados a todos os papéis.
5. Só templates de **texto** (corpo com variáveis; cabeçalho de texto sem variável; botões de resposta rápida). Mídia/variáveis no cabeçalho, botões com URL/telefone e `language.policy` ficam fora (a elegibilidade os recusa).
6. O texto da mensagem renderizada é gravado na caixa de entrada (precisa para exibir); contém as variáveis informadas pelo operador (dado do cliente) — mesma sensibilidade das mensagens de texto.
7. 131050 tratado como opt-out geral (a doc fala em marketing): mais restritivo que o necessário, por escolha.
8. Antes de aplicar no remoto: aplicar na ordem 20261201010000 → 20261202010000 → 20261203010000 → 20261203020000 → 20261204010000 (as 4 anteriores também seguem locais).

# Coexistence — Etapa 3 (webhooks e proteção da IA) — somente local

Migration: `supabase/migrations/20261124010000_whatsapp_coexistence_webhooks.sql` (**NÃO aplicada**) · rollback: `supabase/rollbacks/whatsapp-coexistence/20261124010000_rollback.sql`.
Referência: `whatsapp-coexistence-contrato-meta.md`. Nada foi aplicado, publicado, ativado ou conectado; webhook da Meta, flags, tokens e números intactos.

## Auditoria do que já existia (base reaproveitada)
- Webhook (`whatsapp-webhook`): HMAC-SHA256 do corpo bruto, empresa SEMPRE por `metadata.phone_number_id`, dedupe em `whatsapp_webhook_events`, só tratava `field = messages`.
- IA automática: já tem `ai_control (inherit|human)`, jobs com debounce e **três travas contra resposta humana**: gatilho de pausa em saída `origin='human'`, `whatsapp_ai_prepare_auto` e `whatsapp_ai_auto_commit_send` ("já há resposta humana depois do primeiro inbound" → `aborted_human`).
- Todo caminho de envio exige `company_whatsapp_connections.status = 'active'` (get_send_context, prepare_outbound, IA, avisos).
→ Decisão: o **eco vira uma saída `origin='human'` com `sent_via='business_app'`**; assim as travas existentes passam a valer sem alterar o pipeline da IA. A desconexão usa o mesmo `status`.

## O que foi implementado
| Item | Como |
|---|---|
| `smb_message_echoes` | RPC `whatsapp_ingest_echo`: só em conexão `connection_type='coexistence'` e `active`; grava saída humana (sem usuário), **não** abre/estende a janela de 24 h; cria a conversa (já com IA pausada) se a pessoa escreveu primeiro pelo celular; tolera o nono dígito (`whatsapp_br_phone_equivalent`) |
| Diferenciar API x app | (1) chave do evento, (2) wamid já existente na conexão, (3) envio da API ainda em voo (`queued`, mesmo texto, ≤10 min) = **nosso** envio (não pausa a IA), (4) corrida eco x `mark_message_sent`: o eco enganoso é descartado e o envio da API é registrado normalmente |
| Pausa da IA | `ai_control='human'` + jobs pendentes cancelados (`aborted_human` / `business_app_message`) + evento `ai_paused`; job em processamento é derrubado pela revalidação do commit; "devolver para a IA" continua pela RPC existente |
| `smb_app_state_sync` / `history` | RPC `whatsapp_coexistence_record`: **só contagens** (adicionados/removidos; fase, ordem, progresso, nº de conversas/mensagens) e a recusa (código 2593109). Nenhum nome, telefone ou texto é lido/guardado; **nenhum histórico é importado**. O banco só aceita chaves numéricas conhecidas (defesa em profundidade) |
| `account_update` | RPC `whatsapp_coexistence_account_update`: `PARTNER_REMOVED` → `status='disconnected'` (só conexões do Embedded Signup nessa WABA; manuais nunca); `ACCOUNT_OFFBOARDED` → `status='error'` reversível (só Coexistence); `ACCOUNT_RECONNECTED` → reativa **só** o que o OFFBOARDED pausou; demais eventos só registrados | **(A1, corrigido: ver `whatsapp-coexistence-a1.md`)**
| Bloqueio de envio | via `status` (get_send_context recusa `connection_inactive`; envio manual recusado; jobs pendentes da IA da conexão cancelados) |
| Estado | colunas `lifecycle_state/_reason/_changed_at` em `company_whatsapp_connections`; gatilho limpa o estado quando a conexão volta a `active` (reconexão pelo Embedded Signup) |
| Idempotência | `provider_event_key` único (eco: wamid; sincronização/account_update: hash do conteúdo) |
| Limite de corpo | 8 MiB (era 1 MiB): pedaços de histórico podem ter milhares de mensagens; a assinatura continua sendo conferida sobre o corpo inteiro |
| `connection_type` | `company_whatsapp_connections.connection_type` (Etapa 2) é a trava: Cloud API tradicional (inclui Djalexeventos, `manual`) nunca é afetada por eco, sincronização nem `OFFBOARDED/RECONNECTED` |

## Item 9 — SUBSTITUÍDO na Etapa 4
A regra de inferência descrita aqui (campo ausente + `FINISH` ⇒ `cloud_api`) foi **removida**: ver `whatsapp-coexistence-etapa4.md` (evidência explícita `is_on_biz_app=false` + rechecagem antes do `/register`; sem evidência, a conexão é interrompida).

## Limitações / a validar no piloto real
- Eco sem telefone (só BSUID) não pode ser mapeado: registrado (`echo_unmapped`), sem pausar a IA.
- `edit`/`revoke` de eco são só registrados (a mensagem original não é alterada).
- Enquanto a conexão está pausada/desconectada, inbound é descartado (200) — a Meta também suspende nesse período.
- Não há tela/aviso para o dono sobre `OFFBOARDED`/`PARTNER_REMOVED` (o banner de conexão existente passa a mostrar "desconectado"); notificação ativa é etapa futura.
- Sincronização (`smb_app_data`, janela de 24 h) **não é disparada** aqui (etapa futura); sem ela o histórico não é importado.
- A semântica exata de "eco de mensagens da API" (se a Meta também ecoa) segue por confirmar; o casamento com envio em voo e o fallback do `mark_message_sent` cobrem os dois casos.

## Ordem para aplicar (SÓ com autorização)
1. migration `20261123010000`; 2. migration `20261124010000`; 3. deploy `whatsapp-signup-complete`; 4. deploy `whatsapp-webhook`; 5. publicar frontend. Antes de ligar a flag: assinar `account_update`, `history`, `smb_app_state_sync`, `smb_message_echoes` no App Dashboard.

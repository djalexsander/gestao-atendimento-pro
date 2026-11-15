# Coexistence — Etapa 4 (trava do `/register` e sincronização inicial) — somente local

Migration: `supabase/migrations/20261125010000_whatsapp_coexistence_sync.sql` (**NÃO aplicada**) · rollback: `supabase/rollbacks/whatsapp-coexistence/20261125010000_rollback.sql`.
Nova Edge: `supabase/functions/whatsapp-coexistence-sync` (**não implantada**). Nada foi aplicado, publicado, ativado ou conectado; Meta, flags, tokens, números e conexões intactos.

## 1) `/register` só com evidência explícita (itens 1 e 2)
A inferência da Etapa 3 ("campo ausente + dica FINISH ⇒ cloud_api") foi **removida**. Agora, para registrar um número:
1. A Meta precisa responder `is_on_biz_app = false` de forma **explícita** (qualquer outra coisa — ausente, `true`, plataforma estranha — interrompe com `connection_mode_unknown`, 409, "conexão interrompida, nada foi alterado no seu número").
2. **Rechecagem imediatamente antes do `/register`** (nova consulta ao Graph, depois do PIN guardado e da conferência da allowlist, **antes** de contar a tentativa de registro): precisa vir `false` de novo. Se vier `true`, ausente ou falhar → 409 `register_blocked_not_cloud_api` / 504 `register_guard_unavailable`, **sem registrar, sem gastar tentativa**, sessão encerrada, token limpo pelo caminho existente.
3. Coexistence e número já registrado por nós (`action = skip`) nunca passam pelo `/register` (nem pela rechecagem).
4. O código `decideConnectionModeWithHint` deixou de existir.
**Consequência a conhecer:** se a Meta omitir `is_on_biz_app` para números Cloud API comuns, o fluxo tradicional **não conecta** (falha fechada, com mensagem clara) até conseguirmos evidência adicional. É a troca deliberada de disponibilidade por segurança; o log da falha registra só `is_on_biz_app` e `platform_type` (sem segredos) para decidir o próximo passo no piloto.

## 2) Sincronização inicial por `POST /{phone}/smb_app_data` (itens 3–6)
Contrato (docs oficiais, ver `whatsapp-coexistence-contrato-meta.md`): em até **24 h** do onboarding, **1º** `sync_type=smb_app_state_sync` (contatos), **2º** `sync_type=history`; cada pedido **uma vez** (repetir exige offboarding + novo Embedded Signup).

| Peça | O que faz |
|---|---|
| Trava mestra | `whatsapp_platform_settings.coexistence_sync_enabled` (default **false**). Desligada, nada é pedido à Meta |
| `whatsapp_coexistence_sync` | uma linha por conexão em Coexistence (criada pelo gatilho do onboarding): `onboarded_at`, `deadline_at = onboarded_at + 24 h` (CHECK), **ciclo** (novo Embedded Signup = ciclo+1, pedidos zerados), estado de contatos e de histórico |
| `whatsapp_coexistence_sync_attempts` | auditoria: tipo, status (`in_progress/accepted/rejected/uncertain`), código da Meta, `request_id` (só suporte), quem pediu. **Índice único parcial** impede, no banco, 2º pedido do mesmo tipo/ciclo em andamento, aceito ou incerto |
| RPC `…_sync_prepare` (service_role) | todas as travas + reserva atômica + token do Vault: trava mestra, owner/admin ativo + módulo, piloto, conexão Coexistence do Embedded Signup ativa e sem pausa, token utilizável, janela de 24 h, **ordem**, não repetido, máx. 3 recusas |
| RPC `…_sync_finish` (service_role) | grava `accepted` / `rejected` / `uncertain` (idempotente) |
| RPC `…_sync_status` (owner/admin) | estado e prazo, sem `request_id`/token/telefone |
| Edge `whatsapp-coexistence-sync` | `{company_id, type}` + JWT → prepare → chamada à Meta (uma só) → finish. Nunca repete a Meta |

Resultados: **aceito** (2xx) → `requested`; **recusado** (4xx) → `failed`, nova tentativa permitida (máx. 3); **incerto** (timeout, rede, 5xx, corpo inesperado) → `uncertain`, **nunca repetido sozinho** (a Meta pode ter aceito); pedido "em andamento" abandonado há >5 min vira incerto. Janela vencida → `expired`. Histórico só depois dos contatos **aceitos**.
Webhooks da Etapa 3 agora atualizam o estado: `smb_app_state_sync` → contatos `synced` (também resolve um pedido incerto: o webhook prova que a Meta aceitou); `history` → `receiving` (progresso nunca regride) → `completed` (100); `2593109` → `declined`. Webhook sem pedido nosso **não** altera o estado.
**Nenhuma conversa, mensagem, contato ou cliente é importado**; as tabelas só guardam estado, contagens e códigos.

## Decisões e pontos em aberto
- **Não há chamada automática no onboarding**: pedir o histórico só faz sentido junto com a importação (o pedido vale uma vez e o Meta enviaria o histórico que hoje só é contado). Por isso o pedido é uma ação controlada (Edge + trava mestra), a ser disparada por tela/operador quando a importação existir.
- Ordem entre contatos e histórico: exigimos contatos **aceitos** (não esperamos o webhook, pois um número sem contatos pode nunca emitir `smb_app_state_sync`).
- Sem UI nesta etapa; a RPC de leitura está pronta para a tela futura. Permissões exatas do endpoint continuam **[?]** nas páginas oficiais.
- `smb_app_data` real nunca foi chamado (nem sequer com endpoint simulado fora dos testes).

## Ordem para aplicar (SÓ com autorização)
migrations `20261123010000`, `20261124010000`, `20261125010000` → deploy `whatsapp-signup-complete`, `whatsapp-webhook` e (opcional, desligado por padrão) `whatsapp-coexistence-sync` → frontend. `coexistence_sync_enabled` permanece **false** até decisão explícita.

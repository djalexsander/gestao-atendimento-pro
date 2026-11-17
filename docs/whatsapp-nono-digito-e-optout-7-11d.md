# Nono dígito no recebimento e opt-out — Etapa 7.11D (local, não aplicada)

Migrations: `20261203010000_whatsapp_ingest_equivalent_phone.sql` (parte 1) e `20261203020000_whatsapp_optout.sql` (parte 2); rollbacks em `supabase/rollbacks/whatsapp-ingest-equivalent-phone/` e `supabase/rollbacks/whatsapp-optout/`. Nada aplicado, publicado ou ativado.

## Parte 1 — conversa única por contato (nono dígito)

**Auditoria dos pontos que resolvem conversa por telefone**
| Ponto | Situação |
|---|---|
| `whatsapp_ingest_message` (recebimento) | Único por (conexão, telefone EXATO): `ON CONFLICT (connection_id, contact_phone)`. **Corrigido** nesta etapa. |
| `whatsapp_ingest_echo` (Coexistence) | Procura a conversa com `whatsapp_br_phone_equivalent`, mas cria com o telefone recebido e sem lock. **Não alterado** (Coexistence fora do escopo). Risco residual: eco e mensagem recebida simultâneos, de formatos diferentes, para um contato SEM conversa. |
| modo teste / contexto de envio | Já usam a equivalência. |
| iniciar conversa (7.11F) | Usará o mesmo auxiliar e o mesmo lock da parte 1. |

**Mudança (isolada)**: `whatsapp_resolve_conversation_phone(conexão, telefone)` (interna, com lock consultivo por conexão e chave do contato) devolve o telefone da conversa ATIVA equivalente, se houver; `whatsapp_ingest_message` ganhou UMA linha que troca `v_phone` por esse valor antes do upsert existente. Feita por **substituição exata sobre o corpo atual da função** (mesma técnica da migration do vínculo automático de cliente): o trecho esperado tem de ocorrer exatamente uma vez, senão a migration falha sem alterar nada, e todo o resto é preservado (incluindo o vínculo automático de cliente). O rollback remove só o bloco inserido.

Regras: só Brasil (55), mesmo DDD e mesmos 8 dígitos (celular antigo 6–9, com e sem o 9); outros países, fixos e celulares novos (9 seguido de 1–5) nunca são alterados; só a mesma conexão (portanto a mesma empresa); conversa excluída não é reaproveitada; **duplicatas já existentes não são mescladas** (a mensagem vai para a de telefone exato, senão a mais recente).

**Achado do teste diferencial**: a primeira versão da migration foi gerada a partir do texto da migration original e **removia o vínculo automático de cliente** (adicionado depois por substituição de texto). O teste detectou. Passou-se à substituição exata sobre o corpo vivo. Antes de aplicar no remoto, conferir novamente o trecho (verificação somente leitura feita em 2026-11-17: o trecho ocorre exatamente 1 vez e o vínculo automático está presente).

## Parte 2 — opt-out

- **Tabelas**: `whatsapp_contact_optouts` (estado por empresa + hash da chave do telefone) e `whatsapp_optout_events` (trilha só-acréscimo). Sem telefone, nome nem texto.
- **Entrada**: (1) mensagem recebida que seja, INTEIRA, uma frase de saída (`parar`, `sair`, `stop`, `parar de receber`, `parar mensagens`, `sair da lista`, `descadastrar`, `cancelar inscrição`, `não quero (mais) receber`, `não enviar mais`, `unsubscribe`); "cancelar" sozinho e frases que só CONTÊM as palavras não valem; mensagens com mais de 60 caracteres, mídia, mensagens enviadas pela empresa e mensagens com mais de 2 dias (histórico) não decidem; (2) bloqueio manual por owner/admin/attendant (ação protetora, vale mesmo em modo somente leitura); (3) erro 131050 da Meta pela função interna `whatsapp_optout_from_meta_error` (a ligar no despacho na 7.11E; **confirmar a lista de códigos na documentação vigente**).
- **Gatilho**: só lê a mensagem recebida, nunca a altera e nunca derruba o recebimento (erro engolido, como o gatilho de pausa da IA).
- **Efeito**: bloqueia SOMENTE novas iniciações por template (a reserva da 7.11B recusa com PT409, antes de consumir vaga). Receber mensagens, mostrar a conversa, responder dentro da janela de 24 h (humano ou IA) continuam normais.
- **Reativação** (novo consentimento verificável): (a) o próprio contato escreve inteira uma frase de retomada (`quero receber`, `quero voltar a receber`, `voltar a receber`, `reativar`, `ativar mensagens`) DEPOIS do opt-out; ou (b) owner/admin registra evidência (`written_consent` ou `external_record`) com referência do registro (3–80 caracteres, sem telefone ou 8+ dígitos) e atesta; empresa em modo somente leitura não reativa.

## Lacunas após a 7.11D (para a ativação)
1. G1–G4 do relatório da 7.11C ficam resolvidos **no banco**, mas o opt-out da Meta (G4) só passa a valer quando o despacho de template (7.11E) chamar a função interna.
2. O caminho de eco da Coexistence continua sem lock/equivalência na criação (risco residual acima); tratar em etapa própria, se a Coexistence for usada para iniciar conversas.
3. Opt-outs antigos (histórico importado) não são considerados; sem importação retroativa.
4. A lista de frases é fixa no banco (pt-BR/en); mudar exige migration.
5. A reserva usa a chave de telefone informada pelo chamador; a RPC da 7.11F deve calcular a chave sempre pela mesma função (`whatsapp_contact_key`).
6. Consentimento inicial (antes de qualquer opt-out) segue sendo declaração do operador (G5).

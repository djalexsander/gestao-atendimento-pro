# Correção A1 — `account_update` atrasado, duplicado, fora de ordem e concorrente (somente local)

Achado da auditoria final: `ACCOUNT_RECONNECTED` da conexão antiga (pausada por `ACCOUNT_OFFBOARDED`) chegando depois de a empresa conectar **outro** número fazia o `UPDATE` violar o índice "uma conexão ativa por empresa"; a RPC falhava, o evento não era gravado e o webhook devolvia 500 (a Meta reentregaria por até 7 dias).

Correção **somente** em `whatsapp_coexistence_account_update` (migration `20261124010000`, ainda **não aplicada**, editada no lugar) + o webhook repassa `entry.time`. Nada remoto foi tocado.

## Como o evento é atribuído à conexão exata
O payload de `account_update` traz só a **WABA** (`entry.id`), nunca o número. Por isso a atribuição é feita por **eligibilidade** dentro da WABA, sempre sob trava (advisory por empresa, na mesma ordem da conclusão do Embedded Signup, depois a linha):
- só conexões `connection_source='embedded_signup'` (as manuais nunca são tocadas);
- `RECONNECTED`: candidata = a conexão **Coexistence** `status='error'` + `lifecycle_state='offboarded'` (a que o OFFBOARDED pausou);
  - se a empresa **já tem outra conexão ativa** → a antiga **não** é reativada e a atual fica intacta (evento registrado, resposta 200 `ignored`);
  - se há **duas** pausadas na mesma empresa → ambíguo, nenhuma é reativada;
  - último recurso: se o índice único ainda assim reclamar, é tratado como "ignorado", nunca como erro do webhook.

## Ordem, atraso e duplicidade (usa `entry.time`, a hora do evento na Meta)
- Nova coluna `company_whatsapp_connections.lifecycle_event_at` (marca d'água). Um evento é **descartado como atrasado** se for anterior ao **onboarding** da conexão (`connected_at`, em segundos) ou ao último evento de ciclo de vida **visto** nela (mesmo quando não mudou o estado).
  - Ex.: `OFFBOARDED(t=10)` chegando depois de `RECONNECTED(t=20)` → ignorado; `PARTNER_REMOVED` antigo reentregue depois de reconectar pelo Embedded Signup → ignorado.
- Sem `entry.time` válido (ausente, fora de faixa ou **no futuro**, > agora+1 dia) o evento só é **registrado**; nenhuma conexão é alterada (um horário futuro não pode "envenenar" os eventos seguintes).
- Duplicata exata = chave do evento (`duplicate`); reenvios com outro horário após o estado já aplicado = sem efeito.
- Resposta: `recorded` quando algo foi processado/registrado; `ignored` quando o evento foi seguramente ignorado (atrasado/ignorado/sem horário). O webhook responde **200** em todos esses casos.

## O que NÃO mudou
Conexões manuais e Cloud API tradicionais; `PARTNER_REMOVED` atual continua desconectando; `OFFBOARDED` só pausa Coexistence ativa; tokens, PINs, mensagens e atendimento. Assinatura HMAC continua obrigatória (evento sem assinatura válida = 401, nada gravado).

## Arquivos
`supabase/migrations/20261124010000_whatsapp_coexistence_webhooks.sql` (função, coluna, grants) · `supabase/rollbacks/whatsapp-coexistence/20261124010000_rollback.sql` (assinatura de 5 argumentos e coluna) · `supabase/functions/whatsapp-webhook/handler.ts` (repasse de `entry.time`) · testes em `.claude/db-tests/`.

## Riscos residuais
- A atribuição é por WABA + estado; quando só a hora decide (dois eventos na **mesma** WABA para empresas diferentes) cada conexão é avaliada com a própria marca d'água.
- Relógio: a hora vem da Meta e `connected_at` do nosso servidor; uma diferença de segundos pode fazer um evento legítimo ocorrido **no mesmo segundo** do onboarding ser tratado como atrasado (rarissimamente).
- A trava advisory/`FOR UPDATE` só se prova de verdade em Postgres com conexões concorrentes (o ambiente de teste local é um único backend); a rede de segurança do índice único cobre a corrida.
- `lifecycle_event_at` também é atualizada na conexão ativa quando um RECONNECTED é visto (metadado de ordenação; não altera status, token nem atendimento).

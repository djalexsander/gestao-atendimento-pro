# Coexistence — risco residual do eco (nono dígito + lock): auditoria e plano

Status: **somente auditoria. Nada foi alterado** (migrations, webhook, eco). Evidência executável: `.claude/db-tests/_audit-echo-lock.mjs` (5 checks).

## 1. O que foi confirmado
`whatsapp_ingest_echo` (migration `20261124010000`, usada só quando `connection_type = 'coexistence'`):
- localiza a conversa por equivalência do nono dígito (`whatsapp_br_phone_equivalent`) com `FOR UPDATE`, **sem lock de contato**; só trava linhas que já existem.
- se não acha, cria com `INSERT … ON CONFLICT (connection_id, contact_phone) WHERE deleted_at IS NULL` — o índice único só vale para o telefone **exato**.
- `ingest_message` (7.11D) e `whatsapp_start_conversation` (7.11F) chamam `whatsapp_resolve_conversation_phone`, que toma `pg_advisory_xact_lock(hashtextextended('wa_conv:<conexão>:<chave do contato>', 0))` e devolve o telefone da conversa ativa equivalente. O eco **não**: provado por `pg_locks` (A2) e por inspeção do corpo (A3).
- Ordem de escolha entre equivalentes: o resolvedor prefere telefone exato e depois a atividade mais recente (`exato desc, last_message_at desc, created_at desc, id`); o eco usa só `last_message_at desc` (A4). Só difere se já existirem duplicatas históricas.

### Interleaving que gera duas conversas (contato SEM conversa, formas diferentes)
1. T1 (recebimento ou início) toma o lock, não vê conversa, insere `554498807633` (ainda não commitado).
2. T2 (eco, `to = 5544998807633`) não espera ninguém, seu SELECT não vê a linha não commitada, insere `5544998807633`.
3. Os índices únicos não colidem (telefones diferentes) → **2 conversas ativas do mesmo contato**.
Com a MESMA forma de telefone o índice único resolve (T2 espera T1 e cai no `DO UPDATE`): sem duplicata. Janela: milissegundos; exige Coexistence ativa e o contato sem conversa.

## 2. Correção proposta (migration futura `20261206010000_whatsapp_echo_equivalent_phone_lock.sql`, ainda NÃO escrita)
Mesma técnica da 7.11D (substituição exata do corpo atual lido do banco; falha fechada se o trecho não ocorrer exatamente 1 vez; `CREATE OR REPLACE` preserva ACL, `SECURITY DEFINER`, `search_path`; nada é recriado do zero).

Duas substituições em `public.whatsapp_ingest_echo(text,text,text,text,text,timestamptz,text)`:
1. **Antes** de `-- conversa do contato (ativa, tolerando a variação do nono dígito brasileiro)` inserir:
   `v_phone := public.whatsapp_resolve_conversation_phone(v_conn.id, v_phone);`
   (mesmo lock, mesma chave, mesma função; vem depois do `return 'unmapped'`, então sem telefone não trava; depois dos checks de duplicidade por `event_key`/`wamid`, que não dependem do lock.)
2. Trocar `order by c.last_message_at desc nulls last limit 1 for update` por
   `order by (c.contact_phone = v_phone) desc, c.last_message_at desc nulls last, c.created_at desc, c.id limit 1 for update`
   (igual ao resolvedor; como `v_phone` já é o da conversa escolhida, o eco e o recebimento sempre escolhem a MESMA conversa).

Por que basta: o lock é obtido num statement separado antes do SELECT; em READ COMMITTED o SELECT seguinte tira snapshot novo e vê a conversa que o concorrente acabou de commitar. O `ON CONFLICT` do INSERT continua como rede de segurança para a mesma forma.

### Garantias pedidas
- Preserva ecos, mensagens, vínculos de cliente e estados: nenhuma outra linha da função muda; só o `v_phone` usado na busca/criação passa a ser o da conversa equivalente (a mensagem do eco continua gravada em `conversation_id`, com `provider_message_id` e eventos idênticos).
- **Não une nem apaga** duplicatas históricas: só escolhe uma delas, de forma determinística.
- Isolamento: o resolvedor filtra `connection_id` (e a conexão pertence a uma empresa); a chave do lock inclui a conexão. Eco continua restrito a `connection_type='coexistence'` e `status='active'`.
- Ordem de travas: lock de contato → linha da conversa (mesma de recebimento e início). O `webhook_events` (chave única por evento) é inserido antes por todos, sem espera cruzada. `wa_conn:<empresa>` (sync) é outro espaço de chaves e não é tomado dentro do eco. Sem ciclo → sem deadlock.
- Rollback: reversa por substituição exata (restaura os dois trechos), em `supabase/rollbacks/whatsapp-echo-equivalent-phone/`.

## 3. Testes planejados
**Diferenciais (PGlite, banco sem × com a migration, como na 7.11D):** matriz idêntica antes/depois — sem conversa, forma exata, com/sem 9 nas duas direções, fixo/estrangeiro (inalterados), conversa excluída (não ressuscita), outra conexão e outra empresa, `api_match`, wamid/evento duplicado, pausa da IA e jobs cancelados — resultado igual, exceto o caso intencional (duplicatas históricas: agora exato primeiro). Conferir também que todas as outras funções/tabelas/políticas ficam byte a byte iguais (padrão da 7.11D) e que remover a linha nova devolve o texto anterior.
**Lock (PGlite):** `_audit-echo-lock.mjs` com A2 invertido (o eco passa a tomar a MESMA chave que o recebimento, para as duas formas do telefone).
**Ordens sequenciais:** recebimento→eco, eco→recebimento, início→eco, eco→início, cada uma com as duas formas do telefone: exatamente 1 conversa; mensagens e eventos preservados; `customer_id` (auto_link) e `ai_control` corretos; duplicatas históricas pré-existentes continuam 2 (não mescladas).
**Mutantes:** sem a chamada do resolvedor; sem a ordenação por telefone exato; chave de lock diferente (sem a conexão / sem normalização do 9); lock depois do SELECT.
**Concorrência real:** PGlite é monoprocesso e NÃO prova corrida. Seguir o padrão já usado (`.claude/remote/*race*.mjs`): N sessões independentes (eco + recebimento + início, formas alternadas) contra Postgres real, com empresa/conexão de teste e limpeza. Requer autorização expressa (Postgres remoto ou um Postgres local em Docker — o daemon do Docker Desktop está desligado e exigiria baixar a imagem). Critério: 1 conversa, 0 deadlocks, 0 erros.

## 4. Sequência de execução (após sua autorização)
1. Escrever a migration + rollback + `whatsapp-echo-equivalent-phone.mjs` + `mutate-…` (local).
2. Rodar diferenciais, lock, sequenciais, mutantes, `coexistence-compat`, `whatsapp-coexistence-webhook` e `coexistence-e2e`.
3. (Autorizado) aplicar no remoto na ordem após a 20261205010000 e rodar a corrida real; só então liberar a ativação live.

## 5. O que NÃO está no escopo
`user_preferences`, reconciliação de incertos, unir conversas duplicadas históricas, mudanças no handler TypeScript do webhook (a correção é só SQL).

---
## 6. Status 7.11H (2026-11-17) — implementado e testado LOCALMENTE; nada aplicado/publicado/commitado
- Migration `supabase/migrations/20261206010000_whatsapp_echo_equivalent_phone_lock.sql` (+ rollback em `supabase/rollbacks/whatsapp-echo-equivalent-phone/`).
- Testes: `.claude/db-tests/whatsapp-echo-equivalent-phone.mjs` (31 checks; roda em PGlite e em PostgreSQL 17.6 real com `HOMOLOG_REAL=1`), `mutate-whatsapp-echo-equivalent-phone.mjs` (10 mutantes), `whatsapp-echo-race-real.mjs` (corrida real, 6 sessões independentes; exige o container local `courtesy-homolog-pg` — ver `docs/cortesias-homologacao-pg-real-relatorio.md`).
- Resultado da corrida real (40 rodadas × 7 cenários): ANTERIOR duplicou conversa em 222 rodadas; NOVO 0 duplicatas, 0 erros, 0 deadlocks.

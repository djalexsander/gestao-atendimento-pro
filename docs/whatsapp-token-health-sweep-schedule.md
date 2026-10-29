# Monitoramento automático da saúde dos tokens do WhatsApp (Etapa 9)

Migration: `supabase/migrations/20261109010000_whatsapp_token_health_sweep_schedule.sql` (**preparada; NÃO aplicada em produção**).
Complementa `whatsapp-token-health-and-recovery.md` (Etapa 8). Não ativa o Embedded Signup, não autoriza empresas e não depende da flag nem da allowlist.

## 1. Como funciona
- Job `pg_cron` **`whatsapp-token-health-sweep`**, expressão `7 */6 * * *` (00:07, 06:07, 12:07 e 18:07 UTC), comando
  `select public.whatsapp_token_health_sweep('cron')`. Roda como dono do job (o usuário que aplicou a migration), sem URL, sem segredo, sem `service_role`.
- A varredura só olha conexões **ativas, com `token_expires_at` conhecido e não revogadas**. Para cada uma calcula o estado efetivo:
  - `expiring` / `expired` → grava o estado em `token_status` (só se mudou) e cria/renova o alerta (`whatsapp_token_alerts`, uma linha por conexão+tipo+credencial);
  - `valid` → não faz nada.
- **Não toca** em: conexões sem prazo (`unknown`, Djalexeventos), revogadas, desconectadas, tokens e PINs do Vault, mensagens, conversas, registros de número.
  **Não chama a Meta** nem envia mensagem. O bloqueio de envio continua no ponto único `whatsapp_get_send_context` (a varredura só antecipa o registro do estado).
- É **idempotente**: repetir não muda nada além de `last_seen_at` dos alertas.
- O recebimento (webhook) e os envios não esperam pela varredura (`FOR UPDATE SKIP LOCKED` + `lock_timeout` de 5 s).

## 2. Concorrência
1. `pg_try_advisory_xact_lock` (não bloqueante, de transação: nunca vaza). Se outra varredura está em andamento, esta **não espera**: grava `skipped_concurrent` e sai.
2. `FOR UPDATE SKIP LOCKED` nas conexões: uma conexão em uso por um envio/relato naquele instante fica para a próxima execução (contada em `connections_locked_skipped`).
3. O próprio `pg_cron` não sobrepõe execuções do mesmo job.
A corrida real só existe no Postgres de verdade (o ambiente de testes locais é um único backend): os testes provam a estrutura e o caminho "trava ocupada".

## 3. Auditoria das execuções
Tabela `whatsapp_token_sweep_runs` (sem acesso de cliente; RLS ligada), uma linha por execução:
`source` (`cron`/`manual`), `status` (`success` / `failed` / `skipped_concurrent`), `started_at`, `finished_at`, `connections_checked`, `connections_locked_skipped`,
`states_updated`, `alerts_created`, `alerts_refreshed`, `error_code` (SQLSTATE) e `error_message` (máx. 200 caracteres, trechos que parecem token trocados por `[removido]`).
Retenção de 90 dias (a própria varredura limpa). Em caso de falha, **nada** do que a execução fez é mantido (subtransação) e a função **não propaga o erro**:
por isso o `cron.job_run_details` mostrará `succeeded` mesmo com falha — a fonte da verdade da falha é `whatsapp_token_sweep_runs` (`status = 'failed'`).
O `cron.job_run_details` (nativo) continua útil para confirmar que o pg_cron disparou o job (início, fim, erro de disparo).

## 4. Como conferir (SQL Editor do Supabase, como `postgres`)
Última execução e se está atrasada (Admin Master também vê o mesmo pela RPC `master_whatsapp_token_sweep_status()`):
```sql
select source, status, started_at, finished_at, connections_checked, states_updated, alerts_created, alerts_refreshed, error_code, error_message
from public.whatsapp_token_sweep_runs order by started_at desc limit 10;

-- atraso: sem sucesso há mais de 13 h (2 ciclos + folga)
select max(started_at) filter (where status = 'success') as ultimo_sucesso,
       max(started_at) filter (where status = 'success') < now() - interval '13 hours' as atrasada
from public.whatsapp_token_sweep_runs;

-- falhas e execuções ignoradas
select * from public.whatsapp_token_sweep_runs where status <> 'success' order by started_at desc limit 20;

-- o job e o histórico nativo do pg_cron
select jobid, jobname, schedule, active from cron.job where jobname = 'whatsapp-token-health-sweep';
select status, start_time, end_time from cron.job_run_details d join cron.job j using (jobid)
 where j.jobname = 'whatsapp-token-health-sweep' order by start_time desc limit 10;

-- alertas abertos
select a.kind, a.first_seen_at, a.last_seen_at, c.company_id, c.token_status, c.token_expires_at
from public.whatsapp_token_alerts a join public.company_whatsapp_connections c on c.id = a.connection_id order by a.last_seen_at desc;
```
Logo após ativar, a primeira execução ocorre no próximo horário da grade (até 6 h). Enquanto `never_run = true` não é atraso.

### Painel do Admin Master (sem consultar tabelas internas)
`master_whatsapp_token_sweep_status()` (somente Admin Master) devolve:
- `health`: `ok` | `failing` (a última execução registrou falha) | `overdue` (sem sucesso há mais de 13 h) | `never_run`. Uma falha interna **nunca** aparece como sucesso;
- `last_run` (resultado real da varredura), `last_failure` e `recent_failures` (até 5, com código SQL e mensagem já sanitizada), `failures_24h`;
- `last_success_at`, `overdue` (calculado a partir da **última execução bem-sucedida**, não da última tentativa) e `never_run`;
- `job` e `last_cron_run`: o que o **agendador** registrou (pg_cron). Pode ser `succeeded` mesmo quando a varredura registrou `failed` (a função captura o erro, audita e retorna normalmente);
  nesse caso `scheduler_ok_but_sweep_failed = true`. Resumindo: `last_cron_run` diz se o pg_cron disparou; `last_run`/`health` dizem se a varredura deu certo.

## 5. Execução manual segura
```sql
select public.whatsapp_token_health_sweep();   -- origem 'manual'; mesmas regras, auditoria e trava
```
Não há risco de duplicar: a trava impede duas ao mesmo tempo e o efeito é idempotente.

## 6. Desativar / remover / recuperar
```sql
-- pausa (preserva o job; a migration NÃO o reativa se for aplicada de novo)
select cron.alter_job((select jobid from cron.job where jobname = 'whatsapp-token-health-sweep'), active := false);
-- reativa
select cron.alter_job((select jobid from cron.job where jobname = 'whatsapp-token-health-sweep'), active := true);
-- remove
select cron.unschedule('whatsapp-token-health-sweep');
```
- Desativar o cron **não** desliga a proteção de envio (que é calculada na hora pelo prazo) nem o webhook; só deixa de gravar o estado/alertas por varredura.
- Job removido por engano: reaplicar o bloco `do $$ … cron.schedule …` do fim da migration (só cria se não existir).
- Rollback completo (função antiga restaurada, tabela de auditoria e job removidos; não toca em conexões/alertas/tokens/PINs/mensagens): `.claude/db-tests/whatsapp-token-sweep.rollback.sql`
  (gerado e provado por `gen-token-sweep-rollback.mjs`).

## 7. Mudanças adicionais da migration
- `whatsapp_token_health_sweep()` (sem argumento, `service_role`) continua existindo, agora como execução `manual` da versão com origem. A versão com origem não é executável por `service_role`/clientes (só o dono/cron).
- `whatsapp_registration_resolve(uuid, text)` (RPC antiga, `service_role`): passou a recusar (`operation_may_be_in_flight`) uma tentativa `in_progress` iniciada há menos de 30 min ou sem tentativa registrada — antes só a RPC do Admin Master conferia isso. Nenhum código de Edge a usa.
- `master_whatsapp_token_sweep_status()` (Admin Master): última execução, último sucesso, `never_run`, `overdue`, falhas em 24 h e, se houver pg_cron, o job e a última execução nativa.

## 8. Plano de ativação segura (a executar só com autorização)
1. Conferir estado remoto (somente leitura): última migration `20261108010000`, flag desligada, allowlist vazia, Djalexeventos `active/test/unknown`, 9 segredos no Vault, `cron.job` sem `whatsapp-token-health-sweep`.
2. `supabase migration list --linked` e `db push --linked --dry-run` (deve listar só `20261109010000`); `db push --linked --yes`.
3. Verificar: tabela/RPCs/RLS/ACL; job criado (`7 */6 * * *`, ativo); Djalexeventos idêntica; Vault idêntico.
4. Executar UMA vez manualmente `select public.whatsapp_token_health_sweep();` e conferir a linha de auditoria (`checked = 0`, pois nenhuma conexão tem prazo; nada alterado).
5. Aguardar o primeiro disparo do cron e conferir `whatsapp_token_sweep_runs` + `cron.job_run_details`.
6. Nenhuma Edge Function muda nesta etapa (só banco).

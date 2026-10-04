-- PUSH NOTIFICATIONS — etapa C: agendamento (pg_cron).
--
-- Separado da lógica (20261004040000) de propósito, como o ciclo de cobrança (20260924100000): a lógica é
-- testável em qualquer Postgres; o agendamento só existe onde pg_cron existe. NÃO é ativado enquanto esta
-- migration não for aplicada no Supabase remoto.
--
-- Horários (pg_cron roda em UTC e o Brasil não tem horário de verão desde 2019):
--   * resumo financeiro diário: 08:00 America/Sao_Paulo = 11:00 UTC  ('0 11 * * *')
--   * retry de eventos pendentes/travados: a cada minuto            ('* * * * *')
--
-- Os dois jobs são idempotentes: o resumo tem dedupe por empresa+dia (reexecutar não duplica) e o retry usa
-- o claim atômico (nunca envia em duplicidade).

create extension if not exists pg_cron;

-- Reagendar sem duplicar: remove os jobs anteriores de mesmo nome, se houver.
select cron.unschedule(jobid) from cron.job where jobname in ('gap-push-daily-summaries', 'gap-push-retry');

select cron.schedule(
  'gap-push-daily-summaries',
  '0 11 * * *',
  $job$select public.push_enqueue_daily_summaries()$job$
);

select cron.schedule(
  'gap-push-retry',
  '* * * * *',
  $job$select public.push_retry_pending()$job$
);

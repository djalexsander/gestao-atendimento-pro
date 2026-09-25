-- Fase 4: agendamento do ciclo de cobrança (pg_cron).
--
-- Separado da migration de lógica (20260924090000) de propósito: a lógica é
-- testável em qualquer Postgres; o agendamento só existe onde pg_cron existe e
-- é validado no Supabase remoto.
--
-- Horário: 00:05 em America/Sao_Paulo = 03:05 UTC ('5 3 * * *'; pg_cron roda em
-- UTC e o Brasil não tem horário de verão desde 2019). Rodar logo após a
-- virada do dia comercial faz D+1 (overdue) e D+4 (restricted) valerem desde o
-- começo do dia. O job chama a MESMA função que o Master pode disparar
-- manualmente (master_run_billing_cycle) e é idempotente: reexecutar não
-- duplica faturas nem eventos.
--
-- run_billing_cycle() também expira os períodos grátis vencidos
-- (reconcile_expired_trials): é só a materialização do estado 'expired' e do
-- evento — não cria fatura nem cobrança. A vigência do teste NÃO depende deste
-- job: a autorização deve consultar trial_ends_at em tempo real
-- (company_trial_state / company_has_active_trial), então um atraso ou falha do
-- agendador nunca prolonga nem encurta o período grátis.

create extension if not exists pg_cron;

-- Reagendar sem duplicar: remove o job anterior de mesmo nome, se houver.
select cron.unschedule(jobid) from cron.job where jobname = 'orcafacil-billing-daily';

select cron.schedule(
  'orcafacil-billing-daily',
  '5 3 * * *',
  $job$select public.run_billing_cycle()$job$
);

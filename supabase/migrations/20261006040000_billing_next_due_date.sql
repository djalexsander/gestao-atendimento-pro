-- CORREÇÃO: "Próximo vencimento" aparecia vazio em Meus Planos depois do pagamento da fatura inicial.
--
-- CAUSA: tenant_get_billing_state calculava next_due_date como o MENOR vencimento entre as faturas em aberto/vencidas. Pago
-- o ciclo e enquanto a próxima fatura recorrente não existe (ela só é gerada 10 dias antes do vencimento), não há fatura em
-- aberto e o valor era NULL — embora a assinatura já conheça âncora, billing_day e competência.
--
-- CORREÇÃO: billing_next_due_date(assinatura) = vencimento da PRÓXIMA competência ainda não faturada (maior competência já
-- faturada + 1 mês; sem faturas, a do início), com a MESMA regra existente: invoice_due_date(competência, billing_day da versão
-- contratual vigente nela), logo com o mesmo clamp 29/30/31. Fatura em aberto/vencida continua mandando (a mais antiga).
-- Nada de cálculo paralelo; nenhuma regra comercial muda. Helper fechado a todos os papéis (só chamado por funções DEFINER).

create function public.billing_next_due_date(p_subscription_id uuid)
returns date
language sql
stable
security definer
set search_path = public
as $$
  with s as (select id, started_at from public.subscriptions where id = p_subscription_id),
  nxt as (
    select coalesce((max(i.competence) + interval '1 month')::date, public.competence_of(s.started_at)) as c
      from s left join public.invoices i on i.subscription_id = s.id
     group by s.started_at
  )
  select public.invoice_due_date(nxt.c, (public.subscription_terms_at(p_subscription_id, nxt.c)).billing_day) from nxt;
$$;

revoke execute on function public.billing_next_due_date(uuid) from public, anon, authenticated, service_role;

create or replace function public.tenant_get_billing_state(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sub public.subscriptions;
  v_plan public.plans;
  -- situação da dívida como JSON (NULL sem assinatura): nunca referenciar um RECORD que pode não ter sido atribuído
  v_debt jsonb := null;
  v_state text;
begin
  perform public.billing_assert_owner_or_admin(p_company_id);
  v_state := public.company_access_state(p_company_id);

  select * into v_sub from public.subscriptions where company_id = p_company_id and status <> 'canceled';
  if found then
    select * into v_plan from public.plans where id = v_sub.plan_id;
    select jsonb_build_object('state', d.state, 'due_date', d.due_date, 'days_overdue', d.days_overdue,
                              'grace_until', d.grace_until, 'restriction_from', d.restriction_from)
      into v_debt from public.billing_debt_of(v_sub.id) d;
  end if;

  return jsonb_build_object(
    'access_state', v_state,
    'write_blocked', public.company_write_blocked(p_company_id),
    'trial', (select jsonb_build_object('state', t.state, 'trial_ends_at', t.trial_ends_at, 'trial_days', t.trial_days)
                from public.company_trial_state(p_company_id) t),
    'subscription', case when v_sub.id is null then null else jsonb_build_object(
      'status', v_sub.status, 'plan_id', v_plan.id, 'plan_name', v_plan.name, 'plan_code', v_plan.code,
      'billing_day', v_sub.billing_day, 'grace_until', v_sub.grace_until,
      'monthly_cents', v_sub.plan_price_cents_snapshot + coalesce((select sum(sm.price_cents_snapshot)
          from public.subscription_modules sm where sm.subscription_id = v_sub.id and sm.removed_at is null), 0),
      'modules', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'code', m.code, 'name', m.name, 'monthly_price_cents', m.monthly_price_cents, 'source', sm.source) order by m.code)
          from public.subscription_modules sm join public.modules m on m.id = sm.module_id
         where sm.subscription_id = v_sub.id and sm.removed_at is null), '[]'::jsonb),
      -- fatura em aberto/vencida manda (a mais antiga); sem pendência, a data vem do MOTOR da assinatura (próxima competência
      -- ainda não faturada, mesma âncora e clamp), sem depender de a próxima fatura já ter sido gerada
      'next_due_date', coalesce(
        (select min(i.due_date) from public.invoices i
          where i.subscription_id = v_sub.id and i.status in ('open', 'overdue')),
        public.billing_next_due_date(v_sub.id))) end,
    'debt', v_debt,
    'pending_change', case when v_sub.id is null then null else public.billing_pending_change_json(v_sub.id) end,
    'open_invoices', (select count(*) from public.invoices i
                       where i.company_id = p_company_id and i.status in ('open', 'overdue')));
end;
$$;

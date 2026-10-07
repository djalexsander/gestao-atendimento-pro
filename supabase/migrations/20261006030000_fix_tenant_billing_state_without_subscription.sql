-- CORREÇÃO de tenant_get_billing_state (20261006020000, já aplicada e congelada).
--
-- BUG: a função declarava `v_debt record` e só o atribuía quando a empresa TEM assinatura vigente; o retorno referenciava
-- v_debt.<campo> dentro de um CASE. Para empresa em trial/sem assinatura (o caso de TODA empresa nova) o PL/pgSQL falha
-- com: record "v_debt" is not assigned yet — e Configurações → Meus Planos não abre.
--
-- CORREÇÃO MÍNIMA: a dívida passa a ser um jsonb inicializado em NULL e preenchido só com assinatura. Nenhuma regra
-- comercial muda: trial/sem assinatura => debt nulo; com assinatura => o mesmo objeto de antes. Assinatura da função,
-- SECURITY DEFINER, search_path e grants permanecem (create or replace preserva o ACL).

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
      'next_due_date', (select min(i.due_date) from public.invoices i
                         where i.subscription_id = v_sub.id and i.status in ('open', 'overdue'))) end,
    'debt', v_debt,
    'pending_change', case when v_sub.id is null then null else public.billing_pending_change_json(v_sub.id) end,
    'open_invoices', (select count(*) from public.invoices i
                       where i.company_id = p_company_id and i.status in ('open', 'overdue')));
end;
$$;

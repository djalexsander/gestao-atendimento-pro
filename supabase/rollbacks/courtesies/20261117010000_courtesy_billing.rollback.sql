-- ORDEM DE USO (1117): Desfaça DEPOIS de 1118 e ANTES de 1116. Rode DENTRO de uma transação (begin; … commit;). Veja LEIAME.md desta pasta.
-- Rollback manual da migration 20261117010000 (cortesias, Etapa 2B): restaura generate_subscription_invoice (20261007010000) e
-- desfaz os 5 patches de cursor. Não altera dados de faturamento. O registro courtesy_billing_records é APAGADO (histórico das
-- isenções): rodar só se a migration não estiver em uso. Faturas com itens 'adjustment' de cortesia permanecem como emitidas.
-- ATENÇÃO: perde courtesy_billing_records (histórico de isenções); competências que foram isentas voltam a ser cobradas no próximo ciclo.
create or replace function public.generate_subscription_invoice(
  p_subscription_id uuid,
  p_competence date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub public.subscriptions;
  v_terms public.subscription_terms;
  v_inv public.invoices;
  v_start date;
  v_max date;
  v_total bigint;
  v_items jsonb;
begin
  if p_competence is null or extract(day from p_competence) <> 1 then
    raise exception 'competência deve ser o primeiro dia do mês (ex.: 2026-09-01)';
  end if;

  select * into v_sub from public.subscriptions where id = p_subscription_id for update;
  if not found then
    raise exception 'assinatura não encontrada';
  end if;

  select * into v_inv from public.invoices
  where subscription_id = p_subscription_id and competence = p_competence and kind <> 'module_addition';
  if found then
    return jsonb_build_object('invoice_id', v_inv.id, 'created', false);
  end if;

  v_start := public.competence_of(v_sub.started_at);
  if p_competence < v_start then
    raise exception 'competência anterior ao início da assinatura (%)', v_start;
  end if;

  if v_sub.status = 'canceled' then
    v_max := public.competence_of(v_sub.canceled_at);
    if p_competence > v_max then
      raise exception 'assinatura cancelada: última competência faturável é %', v_max;
    end if;
  else
    v_max := (public.competence_of(public.business_now()) + interval '1 month')::date;
    if p_competence > v_max then
      raise exception 'competência muito à frente: máximo permitido é %', v_max;
    end if;
  end if;

  -- Estado contratual que VALIA para a competência (nunca o estado atual da
  -- assinatura): plano/preço/billing_day da versão vigente em p_competence e
  -- os extras cuja vigência cobre p_competence.
  v_terms := public.subscription_terms_at(p_subscription_id, p_competence);
  if v_terms.id is null then
    raise exception 'sem vigência contratual registrada para a competência %', p_competence;
  end if;

  -- Total montado no banco: plano (snapshot da vigência) + extras vigentes.
  select v_terms.plan_price_cents_snapshot + coalesce(sum(e.price_cents), 0)
  into v_total
  from public.subscription_extras_at(p_subscription_id, p_competence) e;

  insert into public.invoices (subscription_id, company_id, competence, due_date, amount_cents)
  values (v_sub.id, v_sub.company_id, p_competence,
          public.invoice_due_date(p_competence, v_terms.billing_day), v_total)
  on conflict (subscription_id, competence) where kind <> 'module_addition' do nothing
  returning * into v_inv;

  if not found then
    select * into v_inv from public.invoices
    where subscription_id = p_subscription_id and competence = p_competence and kind <> 'module_addition';
    return jsonb_build_object('invoice_id', v_inv.id, 'created', false);
  end if;

  insert into public.invoice_items (invoice_id, kind, ref_id, description, amount_cents)
  values (v_inv.id, 'plan', v_terms.plan_id, 'Plano ' || v_terms.plan_name_snapshot,
          v_terms.plan_price_cents_snapshot);

  -- Só EXTRAS vigentes geram item; source='plan' já está no preço do plano.
  insert into public.invoice_items (invoice_id, kind, ref_id, description, amount_cents)
  select v_inv.id, 'module', e.module_id, 'Módulo ' || e.module_name, e.price_cents
  from public.subscription_extras_at(p_subscription_id, p_competence) e;

  select jsonb_agg(jsonb_build_object(
           'kind', it.kind, 'ref_id', it.ref_id,
           'description', it.description, 'amount_cents', it.amount_cents)
         order by case it.kind when 'plan' then 0 else 1 end, it.description, it.id)
  into v_items from public.invoice_items it where it.invoice_id = v_inv.id;

  perform public.record_invoice_event(v_inv.id, 'generated', jsonb_build_object(
    'subscription_id', v_sub.id,
    'competence', p_competence,
    'due_date', v_inv.due_date,
    'billing_day', v_terms.billing_day,
    'terms_effective_from', v_terms.effective_from_competence,
    'plan_id', v_terms.plan_id,
    'amount_cents', v_inv.amount_cents,
    'items', v_items
  ));

  return jsonb_build_object('invoice_id', v_inv.id, 'created', true);
end;
$$;

do $rb$
declare
  v_name text;
  v_def text;
  v_new text;
begin
  foreach v_name in array array['change_effective_competence', 'billing_next_due_date', 'billing_module_cycle', 'master_set_billing_day', 'tenant_schedule_module_change'] loop
    select pg_get_functiondef(p.oid) into v_def from pg_proc p where p.proname = v_name and p.pronamespace = 'public'::regnamespace;
    v_new := regexp_replace(v_def, 'greatest[(]max[(]i[.]competence[)], public[.]courtesy_waived_through[(][a-z_.]+[)][)]', 'max(i.competence)');
    if v_new = v_def then
      raise exception 'rollback: patch não encontrado em %', v_name;
    end if;
    execute v_new;
  end loop;
end
$rb$;

drop function if exists public.master_list_courtesy_billing(uuid);
drop table if exists public.courtesy_billing_records;
drop function if exists public.courtesy_waived_through(uuid);
drop function if exists public.courtesy_covers(public.company_courtesies, date);
drop function if exists public.prevent_courtesy_billing_record_change();

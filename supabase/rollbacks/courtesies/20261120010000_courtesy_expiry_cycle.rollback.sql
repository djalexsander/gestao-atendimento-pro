-- ORDEM DE USO (1120): Desfaça DEPOIS de 1121 e ANTES de 1119. Rode DENTRO de uma transação (begin; … commit;). Veja LEIAME.md desta pasta.
-- Rollback manual da migration 20261120010000 (cortesias, Etapa 3). Restaura run_billing_cycle (20261007010000) e master_reconcile_courtesies
-- (20261115010000) e remove a reconciliação interna e as consultas/contadores. Não altera cortesias, faturas nem assinaturas; cortesias já
-- materializadas como expired_pending_decision permanecem (estado já efetivo).
-- ATENÇÃO: perde a reconciliação por ciclo; cortesias vencidas deixam de virar 'expired_pending_decision' sozinhas (o estado efetivo continua derivado).
drop function if exists public.master_list_courtesy_attention(text, integer, integer, integer);
drop function if exists public.master_get_courtesy_counters(integer);
create or replace function public.run_billing_cycle()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub record;
  v_generated integer := 0;
  v_overdue integer := 0;
  v_changes integer := 0;
  v_trials integer := 0;
  v_errors integer := 0;
  v_module_changes integer := 0;
  v_expired integer := 0;
  v_r jsonb;
begin
  for v_sub in select id from public.subscriptions order by created_at, id loop
    begin
      if public.billing_apply_module_change(v_sub.id) then
        v_module_changes := v_module_changes + 1;
      end if;
      v_generated := v_generated + public.auto_generate_subscription_invoices(v_sub.id);
      v_r := public.reconcile_subscription_billing_state(v_sub.id);
      v_overdue := v_overdue + coalesce((v_r ->> 'invoices_marked_overdue')::integer, 0);
      if v_r ->> 'status_from' is distinct from v_r ->> 'status_to' then
        v_changes := v_changes + 1;
      end if;
    exception when others then
      v_errors := v_errors + 1;
      raise warning 'run_billing_cycle: assinatura % falhou: %', v_sub.id, sqlerrm;
    end;
  end loop;

  begin
    v_trials := public.reconcile_expired_trials();
  exception when others then
    v_errors := v_errors + 1;
    raise warning 'run_billing_cycle: expiração de períodos grátis falhou: %', sqlerrm;
  end;

  begin
    v_expired := public.billing_expire_module_additions();
  exception when others then
    v_errors := v_errors + 1;
    raise warning 'run_billing_cycle: expiração de adições de módulos falhou: %', sqlerrm;
  end;

  return jsonb_build_object(
    'business_date', public.business_date(),
    'module_additions_expired', v_expired,
    'invoices_generated', v_generated,
    'invoices_marked_overdue', v_overdue,
    'status_changes', v_changes,
    'trials_expired', v_trials,
    'module_changes_applied', v_module_changes,
    'errors', v_errors);
end;
$$;
create or replace function public.master_reconcile_courtesies()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_n integer := 0;
begin
  perform public.assert_master_admin();
  for v_row in
    select c.id, c.company_id from public.company_courtesies c
     where c.status = 'active' and c.ends_at <= public.business_now() order by c.company_id, c.id
  loop
    perform 1 from public.companies where id = v_row.company_id for no key update;
    if public.courtesy_expire_if_due(v_row.id) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;
drop function if exists public.courtesy_reconcile_expired(text);

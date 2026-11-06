-- Cortesias — 5C-3: alertas da F1 no Painel Master e informações precisas de acesso temporário para o tenant. ADITIVA e somente de leitura.
--
-- 1) master_get_courtesy_counters: acrescenta preserved_pending_payment (empresas com assinatura de OUTRO plano em pending_payment e a cortesia original
--    preservada, conforme courtesy_preserved_info) e preserved_pending_oldest_days. Campos existentes inalterados.
-- 2) master_list_courtesy_attention: novo tipo preserved_pending_payment. Alerta TODA F1 efetivamente ativa, independentemente da data de vencimento da cortesia
--    e SEM teto. Uma linha por assinatura pendente (uma por empresa); ordenação por mais antiga primeiro; entra em 'all' entre as vencidas aguardando decisão e
--    as que vão vencer (as demais linhas e seus tipos NÃO mudam; só o grupo de ordenação de expiring_soon passa de 2 para 3, preservando a ordem relativa).
--    A mesma cortesia pode aparecer também como expiring_soon/expired_pending_decision (alertas de naturezas diferentes); cada tipo traz UMA linha por item.
-- 3) tenant_get_access_state: devolve explicitamente courtesy_preserved (boolean) e bridge_until (timestamptz ou null) — só da empresa do usuário.
--
-- NÃO ALTERA: entitlement, write_blocked, cobrança, fatura, Pix, Asaas, webhook, ativação, cron. Sem limite automático para a F1.
-- Rollback: supabase/rollbacks/courtesies/20261122010000_courtesy_alerts_tenant_access.rollback.sql

create or replace function public.master_get_courtesy_counters(p_within_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_within integer := least(greatest(coalesce(p_within_days, 7), 1), 90);
  v_now timestamptz := public.business_now();
begin
  perform public.assert_master_admin();
  return jsonb_build_object(
    'generated_at', v_now,
    'within_days', v_within,
    -- ainda vigentes, vencem em até N dias
    'expiring_soon', (select count(*) from public.company_courtesies c
                       where c.status = 'active' and c.ends_at > v_now and c.ends_at <= v_now + make_interval(days => v_within)),
    -- vencidas aguardando decisão (materializadas ou ainda não materializadas): acesso e isenção seguem
    'expired_pending_decision', (select count(*) from public.company_courtesies c
                                  where c.status = 'expired_pending_decision' or (c.status = 'active' and c.ends_at <= v_now)),
    'expired_with_conversion_request', (select count(*) from public.company_courtesies c
                                         where (c.status = 'expired_pending_decision' or (c.status = 'active' and c.ends_at <= v_now))
                                           and c.conversion_requested_at is not null),
    -- pontes de acesso (Pix): vencidas sem pagamento (aguardam o Master) e ativas
    'bridges_expired_unpaid', (select count(*) from public.courtesy_access_bridges b where public.courtesy_bridge_json(b) ->> 'state' = 'expired'),
    'bridges_active', (select count(*) from public.courtesy_access_bridges b where public.courtesy_bridge_json(b) ->> 'state' = 'active'),
    'bridges_ending_24h', (select count(*) from public.courtesy_access_bridges b
                            where public.courtesy_bridge_json(b) ->> 'state' = 'active' and b.until_at <= v_now + interval '24 hours'),
    -- F1: contratação de OUTRO plano pendente com a cortesia original preservada (derivado do helper do banco; sem teto, sem data de vencimento da cortesia)
    'preserved_pending_payment', (select count(*) from public.subscriptions s
                                   where s.status = 'pending_payment' and public.courtesy_preserved_active(s.company_id)),
    'preserved_pending_oldest_days', (select coalesce(max(greatest(0, floor(extract(epoch from (v_now - s.created_at)) / 86400.0)::integer)), 0)
                                        from public.subscriptions s
                                       where s.status = 'pending_payment' and public.courtesy_preserved_active(s.company_id)));
end;
$$;

-- Lista paginada do que exige atenção do Master. p_kind: all | expiring_soon | expired_pending_decision | bridge_expired | preserved_pending_payment.
-- Ordem: pontes vencidas, vencidas aguardando decisão (mais antigas primeiro), F1 pendente (mais antiga primeiro), as que vão vencer.
create or replace function public.master_list_courtesy_attention(
  p_kind text default 'all',
  p_within_days integer default 7,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_within integer := least(greatest(coalesce(p_within_days, 7), 1), 90);
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_now timestamptz := public.business_now();
  v_total bigint;
  v_items jsonb;
begin
  perform public.assert_master_admin();
  if p_kind is null or p_kind not in ('all', 'expiring_soon', 'expired_pending_decision', 'bridge_expired', 'preserved_pending_payment') then
    raise exception 'tipo inválido: use all, expiring_soon, expired_pending_decision, bridge_expired ou preserved_pending_payment';
  end if;

  with rows_ as (
    select 0 as grp, b.until_at as sort_ts, b.id as sort_id, 'bridge_expired'::text as kind,
           public.courtesy_bridge_json(b) || jsonb_build_object('kind', 'bridge_expired', 'company_name', co.name,
             'hours_overdue', floor(extract(epoch from (v_now - b.until_at)) / 3600.0)::integer) as item
      from public.courtesy_access_bridges b join public.companies co on co.id = b.company_id
     where public.courtesy_bridge_json(b) ->> 'state' = 'expired'
    union all
    select 1, c.ends_at, c.id, 'expired_pending_decision',
           public.courtesy_json(c) || jsonb_build_object('kind', 'expired_pending_decision', 'company_name', co.name,
             'days_overdue', floor(extract(epoch from (v_now - c.ends_at)) / 86400.0)::integer,
             'conversion_requested', c.conversion_requested_at is not null)
      from public.company_courtesies c join public.companies co on co.id = c.company_id
     where c.status = 'expired_pending_decision' or (c.status = 'active' and c.ends_at <= v_now)
    union all
    -- F1: UMA linha por assinatura pendente (uma por empresa) cuja cortesia original está preservada; sem depender da data de vencimento da cortesia
    select 2, s.created_at, s.id, 'preserved_pending_payment',
           public.courtesy_json(c) || jsonb_build_object('kind', 'preserved_pending_payment', 'company_name', co.name,
             'subscription_id', s.id, 'pending_plan_id', s.plan_id, 'pending_plan_name', pl.name,
             'pending_since', s.created_at,
             'days_pending', greatest(0, floor(extract(epoch from (v_now - s.created_at)) / 86400.0)::integer),
             'conversion_requested', c.conversion_requested_at is not null)
      from public.subscriptions s
      join public.companies co on co.id = s.company_id
      join public.plans pl on pl.id = s.plan_id
      cross join lateral (select public.courtesy_preserved_info(s.company_id) as i) p
      join public.company_courtesies c on c.id = (p.i ->> 'courtesy_id')::uuid
     where s.status = 'pending_payment' and p.i is not null
    union all
    select 3, c.ends_at, c.id, 'expiring_soon',
           public.courtesy_json(c) || jsonb_build_object('kind', 'expiring_soon', 'company_name', co.name,
             'conversion_requested', c.conversion_requested_at is not null)
      from public.company_courtesies c join public.companies co on co.id = c.company_id
     where c.status = 'active' and c.ends_at > v_now and c.ends_at <= v_now + make_interval(days => v_within)
  ), f as (
    select * from rows_ where p_kind = 'all' or kind = p_kind
  )
  select (select count(*) from f),
         coalesce((select jsonb_agg(t.item order by t.grp, t.sort_ts, t.sort_id)
                     from (select * from f order by grp, sort_ts, sort_id limit v_limit offset v_offset) t), '[]'::jsonb)
    into v_total, v_items;

  return jsonb_build_object('generated_at', v_now, 'kind', p_kind, 'within_days', v_within,
                            'limit', v_limit, 'offset', v_offset, 'total', v_total, 'items', v_items);
end;
$$;

create or replace function public.tenant_get_access_state(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_state text;
  v_trial_ends timestamptz;
  v_grace_until date;
  v_restriction_from date;
begin
  if auth.uid() is null then
    raise exception 'Faça login para continuar.' using errcode = 'PT401';
  end if;
  if p_company_id is null or not exists (select 1 from public.user_company_ids() u where u = p_company_id) then
    raise exception 'Empresa não encontrada.' using errcode = 'PT403';
  end if;
  v_state := public.company_access_state(p_company_id);

  -- só datas para o aviso (nunca valores): fim do trial, fim da carência e início da restrição
  select t.trial_ends_at into v_trial_ends from public.company_trials t
   where t.company_id = p_company_id and v_state = 'trial';
  select d.grace_until, d.restriction_from into v_grace_until, v_restriction_from
    from public.subscriptions s cross join lateral public.billing_debt_of(s.id) d
   where s.company_id = p_company_id and s.status <> 'canceled' and d.state in ('grace', 'restricted');

  return jsonb_build_object('state', v_state, 'write_blocked', public.company_write_blocked(p_company_id),
    'is_owner', public.user_role_in_company(p_company_id) = 'owner',
    'trial_ends_at', v_trial_ends, 'grace_until', v_grace_until, 'restriction_from', v_restriction_from,
    -- 5C-3: acesso temporário em pending_payment, SOMENTE da própria empresa (a checagem de pertencimento acima já barra as demais):
    --   courtesy_preserved = F1 ativa (cortesia original preservada; sem prazo); bridge_until = fim da ponte 2C ativa (null se não há ponte ativa).
    --   Nenhum id, valor, fatura ou dado administrativo.
    'courtesy_preserved', public.courtesy_preserved_active(p_company_id),
    'bridge_until', (public.courtesy_bridge_info(p_company_id) ->> 'bridge_until')::timestamptz);
end;
$$;

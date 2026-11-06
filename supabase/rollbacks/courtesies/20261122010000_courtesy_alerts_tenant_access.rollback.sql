-- ORDEM DE USO (1122): é o PRIMEIRO passo da ordem inversa (1122 → 1121 → 1120 → 1119 → 1118 → 1117 → 1116 → 1115); o próximo é o rollback da 1121. Rode DENTRO de uma transação (begin; … commit;). Veja LEIAME.md desta pasta.
-- Rollback manual da migration 20261122010000 (cortesias, 5C-3 — alertas F1 e acesso temporário no tenant). Restaura master_get_courtesy_counters e
-- master_list_courtesy_attention (20261120010000) e tenant_get_access_state (20261006020000). Não altera dados.
-- ATENÇÃO: o painel do Master deixa de listar/contar a F1 e o app do tenant deixa de receber courtesy_preserved e bridge_until (o front cai no texto genérico).
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
                            where public.courtesy_bridge_json(b) ->> 'state' = 'active' and b.until_at <= v_now + interval '24 hours'));
end;
$$;

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
  if p_kind is null or p_kind not in ('all', 'expiring_soon', 'expired_pending_decision', 'bridge_expired') then
    raise exception 'tipo inválido: use all, expiring_soon, expired_pending_decision ou bridge_expired';
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
    select 2, c.ends_at, c.id, 'expiring_soon',
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
    'trial_ends_at', v_trial_ends, 'grace_until', v_grace_until, 'restriction_from', v_restriction_from);
end;
$$;

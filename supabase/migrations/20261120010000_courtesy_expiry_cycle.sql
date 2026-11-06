-- CORTESIAS COMERCIAIS — Etapa 3: VENCIMENTOS NO CICLO DIÁRIO E CONTADORES/ALERTAS DO PAINEL MASTER. ADITIVA e LOCAL.
-- Não toca em frontend, Edge Functions do Asaas nem em dados; NÃO cria cron (usa o job existente 'orcafacil-billing-daily'); NÃO envia
-- notificação alguma (e-mail, push, funcionários): só grava estado/evento e expõe consultas ao Master.
--
-- AUDITORIA (por que a integração ao run_billing_cycle é segura)
--   * A reconciliação só troca company_courtesies.status 'active' -> 'expired_pending_decision' e grava o evento 'expired'. Esse estado já era
--     o EFETIVO em tempo real (courtesy_effective_state), então nada muda para acesso, isenção ou cobrança: o entitlement (2A) e a cobertura
--     (courtesy_covers) tratam 'active' e 'expired_pending_decision' do mesmo jeito e não olham o status materializado para vencidas.
--   * Ela não toca em assinaturas, faturas, jobs do Asaas nem em estado de acesso: não pode gerar cobrança nem bloqueio.
--   * LOCKS. O ciclo trava assinaturas (FOR UPDATE) e, ao gerar fatura, as cortesias da empresa (FOR SHARE), tudo mantido até o fim da transação.
--     A versão do Master (1115) travava EMPRESA -> cortesia: dentro do ciclo isso inverteria a ordem (cortesia já travada em SHARE pedindo
--     a trava da empresa) e, com master_subscribe_company/master_end_courtesy (empresa -> cortesia FOR UPDATE), poderia formar DEADLOCK; e
--     um laço de várias cortesias travando em ordem diferente da do ciclo também. Por isso a reconciliação NOVA:
--       - não pega trava de empresa;
--       - trava cada cortesia vencida com FOR UPDATE SKIP LOCKED, em ordem de id: NUNCA ESPERA ninguém. Linha ocupada fica para a próxima
--         execução (idempotente), sem bloquear o ciclo nem ser bloqueada por ele;
--       - roda por último no ciclo, dentro de bloco próprio com tratamento de erro: uma falha dela não derruba fatura, trial nem módulos
--         (conta em 'errors' e emite aviso).
--     master_reconcile_courtesies passa a usar a mesma rotina (mesmo risco eliminado para o Master).
--
-- Ordem de locks resultante: assinatura -> cortesias (SHARE/UPDATE sem espera) no ciclo; empresa -> cortesia nas RPCs do Master; nenhuma
-- trava de empresa dentro do ciclo.

-- ---------------------------------------------------------------------------
-- 1) Reconciliação de vencimentos (interna, sem espera, idempotente, auditada)
-- ---------------------------------------------------------------------------
create function public.courtesy_reconcile_expired(p_source text default 'billing_cycle')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_ends timestamptz;
  v_n integer := 0;
begin
  if p_source is null or p_source not in ('billing_cycle', 'master') then
    raise exception 'origem inválida para a reconciliação de cortesias';
  end if;

  for v_id in
    select c.id from public.company_courtesies c
     where c.status = 'active' and c.ends_at <= public.business_now()
     order by c.id
       for update skip locked
  loop
    update public.company_courtesies
       set status = 'expired_pending_decision'
     where id = v_id and status = 'active' and ends_at <= public.business_now()
    returning ends_at into v_ends;
    if found then
      perform public.courtesy_record_event(v_id, 'expired', jsonb_build_object('ends_at', v_ends, 'source', p_source), null);
      v_n := v_n + 1;
    end if;
  end loop;

  return jsonb_build_object('expired', v_n,
    'still_pending', (select count(*) from public.company_courtesies c where c.status = 'active' and c.ends_at <= public.business_now()));
end;
$$;

revoke execute on function public.courtesy_reconcile_expired(text) from public, anon, authenticated, service_role;

-- A rotina do Master passa a usar a mesma implementação (mesma assinatura e retorno inteiro de 20261115010000)
create or replace function public.master_reconcile_courtesies()
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_master_admin();
  return (public.courtesy_reconcile_expired('master') ->> 'expired')::integer;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) Ciclo diário: um passo a mais, no fim, isolado (patch exato com contagem conferida)
-- ---------------------------------------------------------------------------
create function pg_temp.patch_fn_c3(p_name text, p_from text, p_to text)
returns void
language plpgsql
as $$
declare
  v_oid oid;
  v_def text;
begin
  select p.oid into v_oid from pg_proc p where p.proname = p_name and p.pronamespace = 'public'::regnamespace;
  if v_oid is null then
    raise exception 'patch_fn_c3: função % não encontrada', p_name;
  end if;
  v_def := pg_get_functiondef(v_oid);
  if (length(v_def) - length(replace(v_def, p_from, ''))) / greatest(length(p_from), 1) <> 1 then
    raise exception 'patch_fn_c3: trecho esperado não ocorre exatamente 1 vez em %', p_name;
  end if;
  execute replace(v_def, p_from, p_to);
end;
$$;

select pg_temp.patch_fn_c3('run_billing_cycle',
  $f$  v_expired integer := 0;
  v_r jsonb;
begin$f$,
  $f$  v_expired integer := 0;
  v_courtesies integer := 0;
  v_r jsonb;
begin$f$);
select pg_temp.patch_fn_c3('run_billing_cycle',
  $f$  return jsonb_build_object(
    'business_date', public.business_date(),
    'module_additions_expired', v_expired,$f$,
  $f$  -- vencimento de cortesias: só materializa o estado e o evento (acesso e isenção seguem até a decisão do Master); sem espera por travas
  begin
    v_courtesies := (public.courtesy_reconcile_expired('billing_cycle') ->> 'expired')::integer;
  exception when others then
    v_errors := v_errors + 1;
    raise warning 'run_billing_cycle: vencimento de cortesias falhou: %', sqlerrm;
  end;

  return jsonb_build_object(
    'business_date', public.business_date(),
    'courtesies_expired', v_courtesies,
    'module_additions_expired', v_expired,$f$);

-- ---------------------------------------------------------------------------
-- 3) Contadores e listas para o Painel Master (somente leitura, derivados em tempo real)
-- ---------------------------------------------------------------------------
create function public.master_get_courtesy_counters(p_within_days integer default 7)
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

-- Lista paginada do que exige atenção do Master. p_kind: all | expiring_soon | expired_pending_decision | bridge_expired.
-- Ordem: pontes vencidas (mais urgentes), depois vencidas aguardando decisão (as mais antigas primeiro), depois as que vão vencer.
create function public.master_list_courtesy_attention(
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

revoke execute on function public.master_reconcile_courtesies() from public, anon;
grant execute on function public.master_reconcile_courtesies() to authenticated;
revoke execute on function public.master_get_courtesy_counters(integer) from public, anon;
revoke execute on function public.master_list_courtesy_attention(text, integer, integer, integer) from public, anon;
grant execute on function public.master_get_courtesy_counters(integer) to authenticated;
grant execute on function public.master_list_courtesy_attention(text, integer, integer, integer) to authenticated;

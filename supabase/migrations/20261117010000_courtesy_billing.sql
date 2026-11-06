-- CORTESIAS COMERCIAIS — Etapa 2B: FATURAMENTO RECORRENTE. Aditiva e local. Não toca em frontend, Asaas (funções/Edge), cron nem
-- nas migrations já existentes; só ACRESCENTA um desvio na geração da fatura recorrente quando há cortesia.
--
-- AUDITORIA (o que existe e como foi tratado)
--   * generate_subscription_invoice(sub, competência) é o ÚNICO ponto que cria fatura recorrente (cron via auto_generate_* e Master
--     via master_generate_invoice). Trava a assinatura (FOR UPDATE) primeiro; congela o contrato por competência via
--     subscription_terms_at / subscription_extras_at (snapshots de preço, que NÃO são tocados).
--   * invoices permite amount_cents >= 0, MAS invoices_enqueue_charge só cria cobrança Asaas se amount_cents > 0 e
--     billing_debt_of conta qualquer recorrente open/overdue: uma fatura zerada viraria inadimplência. Por isso total zero NÃO é
--     criado (abaixo) e nenhuma fatura existente é alterada.
--   * Vários cálculos usam "maior competência FATURADA + 1 mês" como cursor do ciclo (change_effective_competence,
--     billing_next_due_date, billing_module_cycle, master_set_billing_day, tenant_schedule_module_change). Competência isenta sem
--     fatura quebraria esse cursor; por isso courtesy_waived_through() entra nesses cinco pontos (patch exato, contagem conferida).
--
-- REGRAS
--  1) Cortesia de PLANO isenta 100% do valor do plano da competência; cortesia de MÓDULO isenta só o extra daquele módulo; os demais
--     itens seguem cobrados. Preços de referência, snapshots, subscription_terms/_modules e invoice_items originais ficam intactos.
--  2) Competência C é coberta pela cortesia se: ela começou até o mês de C (competence_of(starts_at) <= C) E (segue ABERTA —
--     active ou expired_pending_decision, mesmo vencida — OU foi encerrada só DEPOIS de C inteira). Logo: vencimento não cobra; o
--     encerramento manual para a isenção a partir da primeira competência não coberta; um mês em que a cortesia terminou NÃO é
--     isento (cobrança normal do contrato); nunca há cobrança retroativa de competência inteiramente coberta, mesmo gerada
--     depois do encerramento; competências ANTERIORES ao início da cortesia seguem a regra contratual.
--  3) A decisão é tomada na GERAÇÃO e é definitiva para aquela competência (como a própria fatura): o encerramento posterior não
--     reabre competência já isenta nem altera fatura emitida.
--  4) Total a cobrar > 0: a fatura nasce SÓ com o valor devido; os itens contratuais completos ficam e o desconto entra como itens
--     'adjustment' NEGATIVOS (soma dos itens == amount_cents). Total a cobrar == 0: NENHUMA fatura é criada; fica o registro em
--     courtesy_billing_records (invoice_id nulo). Em ambos os casos o desconto é registrado SEPARADAMENTE (courtesy_billing_records).
--  5) Só há desvio se algum item com valor > 0 é isento. Sem isso (inclusive fatura recorrente legítima de R$ 0) o comportamento é
--     exatamente o anterior.
--  6) Cliente novo sem assinatura: cortesia de plano dá acesso (2A) e NÃO cria assinatura, fatura inicial nem pending_payment.
--
-- ORDEM DE TRAVAS: assinatura (FOR UPDATE, já existente) -> cortesias da empresa (FOR SHARE, novo) -> inserções. master_end_courtesy
-- trava empresa -> cortesia (FOR UPDATE) e nunca assinatura: sem ciclo. O FOR SHARE serializa "gerar" x "encerrar": a geração vê a
-- cortesia aberta (e a decisão fica registrada) ou já encerrada.
--
-- NÃO RESOLVIDO (precisa decisão comercial; NADA foi alterado nestes fluxos): cobrança INICIAL de quem contrata com cortesia,
-- adição de módulo com Pix proporcional de módulo que está em cortesia, e plano da cortesia diferente do plano contratado (aqui a
-- cortesia de plano isenta o plano base contratado, seja qual for).

-- ---------------------------------------------------------------------------
-- 1) Registro separado das isenções
-- ---------------------------------------------------------------------------
create table public.courtesy_billing_records (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  subscription_id uuid not null references public.subscriptions(id) on delete restrict,
  competence date not null check (extract(day from competence) = 1),
  courtesy_id uuid not null references public.company_courtesies(id) on delete restrict,
  item_kind text not null check (item_kind in ('plan', 'module')),
  module_code text,
  ref_id uuid,
  description text not null check (length(btrim(description)) > 0),
  original_cents integer not null check (original_cents > 0),
  waived_cents integer not null check (waived_cents = original_cents),
  -- nulo = competência inteira isenta, sem fatura; preenchido = desconto dentro de uma fatura com valor devido > 0
  invoice_id uuid references public.invoices(id) on delete restrict,
  created_at timestamptz not null default now(),
  check ((item_kind = 'module') = (module_code is not null))
);

create unique index courtesy_billing_records_uniq
  on public.courtesy_billing_records (subscription_id, competence, courtesy_id, coalesce(module_code, ''));
create index courtesy_billing_records_company_idx on public.courtesy_billing_records (company_id, competence desc);
create index courtesy_billing_records_waived_idx on public.courtesy_billing_records (subscription_id, competence) where invoice_id is null;

create function public.prevent_courtesy_billing_record_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'courtesy_billing_records é append-only (histórico financeiro)';
end;
$$;
create trigger courtesy_billing_records_no_change
  before update or delete on public.courtesy_billing_records
  for each row execute function public.prevent_courtesy_billing_record_change();

alter table public.courtesy_billing_records enable row level security;
revoke all on public.courtesy_billing_records from public, anon, authenticated;
grant all on public.courtesy_billing_records to service_role;
create policy courtesy_billing_records_deny_clients on public.courtesy_billing_records
  as restrictive for all to anon, authenticated using (false) with check (false);

-- ---------------------------------------------------------------------------
-- 2) Helpers internos
-- ---------------------------------------------------------------------------
-- A cortesia cobre a competência? (regra 2)
create function public.courtesy_covers(p_c public.company_courtesies, p_competence date)
returns boolean
language sql
stable
set search_path = public
as $$
  select public.competence_of(p_c.starts_at) <= p_competence
     and (p_c.closed_at is null
          or p_c.closed_at >= ((p_competence + interval '1 month')::timestamp at time zone 'America/Sao_Paulo'));
$$;

-- Maior competência isenta SEM fatura da assinatura (cursor do ciclo junto com invoices).
create function public.courtesy_waived_through(p_subscription_id uuid)
returns date
language sql
stable
security definer
set search_path = public
as $$
  select max(r.competence) from public.courtesy_billing_records r
   where r.subscription_id = p_subscription_id and r.invoice_id is null;
$$;

revoke execute on function public.prevent_courtesy_billing_record_change() from public, anon, authenticated;
revoke execute on function public.courtesy_covers(public.company_courtesies, date) from public, anon, authenticated;
revoke execute on function public.courtesy_waived_through(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) Cursor do ciclo: competência isenta sem fatura conta como "já tratada" (patch exato, contagem conferida)
-- ---------------------------------------------------------------------------
create function pg_temp.patch_fn_courtesy(p_name text, p_from text, p_to text)
returns void
language plpgsql
as $$
declare
  v_oid oid;
  v_def text;
  v_new text;
begin
  select p.oid into v_oid from pg_proc p where p.proname = p_name and p.pronamespace = 'public'::regnamespace;
  if v_oid is null then
    raise exception 'patch_fn_courtesy: função % não encontrada', p_name;
  end if;
  v_def := pg_get_functiondef(v_oid);
  if (length(v_def) - length(replace(v_def, p_from, ''))) / greatest(length(p_from), 1) <> 1 then
    raise exception 'patch_fn_courtesy: trecho esperado não ocorre exatamente 1 vez em %', p_name;
  end if;
  v_new := replace(v_def, p_from, p_to);
  execute v_new;
end;
$$;

select pg_temp.patch_fn_courtesy('change_effective_competence', 'max(i.competence)',
  'greatest(max(i.competence), public.courtesy_waived_through(p_subscription_id))');
select pg_temp.patch_fn_courtesy('billing_next_due_date', 'max(i.competence)',
  'greatest(max(i.competence), public.courtesy_waived_through(p_subscription_id))');
select pg_temp.patch_fn_courtesy('billing_module_cycle', 'max(i.competence)',
  'greatest(max(i.competence), public.courtesy_waived_through(p_subscription_id))');
select pg_temp.patch_fn_courtesy('master_set_billing_day', 'max(i.competence)',
  'greatest(max(i.competence), public.courtesy_waived_through(v_sub.id))');
select pg_temp.patch_fn_courtesy('tenant_schedule_module_change', 'max(i.competence)',
  'greatest(max(i.competence), public.courtesy_waived_through(v_sub_id))');

-- ---------------------------------------------------------------------------
-- 4) Geração da fatura recorrente: corpo vigente (20261007010000) + isenção por cortesia
-- ---------------------------------------------------------------------------
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
  v_lines jsonb;
  v_line jsonb;
  v_exempt bigint := 0;
  v_due bigint;
  v_plan_cid uuid;
  v_discounts jsonb := '[]'::jsonb;
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

  -- competência já isenta por cortesia (sem fatura): decisão definitiva, idempotente
  if exists (select 1 from public.courtesy_billing_records r
              where r.subscription_id = p_subscription_id and r.competence = p_competence and r.invoice_id is null) then
    return jsonb_build_object('invoice_id', null, 'created', false, 'waived', true);
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

  -- ORDEM DE TRAVAS: assinatura (acima) -> cortesias da empresa. Serializa "gerar" x "encerrar cortesia".
  perform 1 from public.company_courtesies c where c.company_id = v_sub.company_id for share;

  -- Linhas da competência com a cortesia que cobre cada uma (se houver).
  select c.id into v_plan_cid from public.company_courtesies c
   where c.company_id = v_sub.company_id and c.scope = 'plan' and public.courtesy_covers(c, p_competence)
   order by c.starts_at, c.id limit 1;

  select jsonb_build_object('kind', 'plan', 'ref_id', v_terms.plan_id, 'description', 'Plano ' || v_terms.plan_name_snapshot,
                            'amount_cents', v_terms.plan_price_cents_snapshot, 'courtesy_id', v_plan_cid, 'module_code', null)
    || jsonb_build_object('ord', 0) into v_line;
  v_lines := jsonb_build_array(v_line);

  select v_lines || coalesce(jsonb_agg(jsonb_build_object(
           'kind', 'module', 'ref_id', e.module_id, 'description', 'Módulo ' || e.module_name, 'amount_cents', e.price_cents,
           'courtesy_id', (select c.id from public.company_courtesies c join public.modules m on m.code = c.module_code
                            where c.company_id = v_sub.company_id and c.scope = 'module' and m.id = e.module_id
                              and public.courtesy_covers(c, p_competence)
                            order by c.starts_at, c.id limit 1),
           'module_code', (select m.code from public.modules m where m.id = e.module_id),
           'ord', 1) order by e.module_name, e.module_id), '[]'::jsonb)
    into v_lines
    from public.subscription_extras_at(p_subscription_id, p_competence) e;

  select coalesce(sum((l ->> 'amount_cents')::bigint), 0),
         coalesce(sum((l ->> 'amount_cents')::bigint) filter (where l ->> 'courtesy_id' is not null and (l ->> 'amount_cents')::bigint > 0), 0)
    into v_total, v_exempt
    from jsonb_array_elements(v_lines) l;
  v_due := v_total - v_exempt;

  -- Sem isenção real (nenhum item com valor > 0 coberto): comportamento anterior, inclusive fatura recorrente de R$ 0 legítima.
  if v_exempt = 0 then
    insert into public.invoices (subscription_id, company_id, competence, due_date, amount_cents)
    values (v_sub.id, v_sub.company_id, p_competence,
            public.invoice_due_date(p_competence, v_terms.billing_day), v_total)
    on conflict (subscription_id, competence) where kind <> 'module_addition' do nothing
    returning * into v_inv;
  elsif v_due > 0 then
    insert into public.invoices (subscription_id, company_id, competence, due_date, amount_cents)
    values (v_sub.id, v_sub.company_id, p_competence,
            public.invoice_due_date(p_competence, v_terms.billing_day), v_due)
    on conflict (subscription_id, competence) where kind <> 'module_addition' do nothing
    returning * into v_inv;
  else
    -- TOTAL ZERO: nenhuma fatura (nada a cobrar, nada de dívida, nada para o Asaas). Registro separado, idempotente.
    for v_line in select value from jsonb_array_elements(v_lines) where value ->> 'courtesy_id' is not null and (value ->> 'amount_cents')::bigint > 0 loop
      insert into public.courtesy_billing_records (company_id, subscription_id, competence, courtesy_id, item_kind, module_code, ref_id,
                                                   description, original_cents, waived_cents, invoice_id)
      values (v_sub.company_id, v_sub.id, p_competence, (v_line ->> 'courtesy_id')::uuid, v_line ->> 'kind', v_line ->> 'module_code',
              (v_line ->> 'ref_id')::uuid, v_line ->> 'description', (v_line ->> 'amount_cents')::integer, (v_line ->> 'amount_cents')::integer, null)
      on conflict do nothing;
    end loop;
    return jsonb_build_object('invoice_id', null, 'created', false, 'waived', true, 'waived_cents', v_exempt);
  end if;

  if not found then
    select * into v_inv from public.invoices
    where subscription_id = p_subscription_id and competence = p_competence and kind <> 'module_addition';
    return jsonb_build_object('invoice_id', v_inv.id, 'created', false);
  end if;

  -- itens contratuais COMPLETOS (preços originais)
  for v_line in select value from jsonb_array_elements(v_lines) order by (value ->> 'ord')::integer loop
    insert into public.invoice_items (invoice_id, kind, ref_id, description, amount_cents)
    values (v_inv.id, v_line ->> 'kind', (v_line ->> 'ref_id')::uuid, v_line ->> 'description', (v_line ->> 'amount_cents')::integer);
  end loop;

  -- desconto de cortesia: itens 'adjustment' negativos + registro separado
  if v_exempt > 0 then
    for v_line in select value from jsonb_array_elements(v_lines) where value ->> 'courtesy_id' is not null and (value ->> 'amount_cents')::bigint > 0 loop
      insert into public.invoice_items (invoice_id, kind, ref_id, description, amount_cents)
      values (v_inv.id, 'adjustment', (v_line ->> 'courtesy_id')::uuid, 'Cortesia: ' || (v_line ->> 'description'),
              -(v_line ->> 'amount_cents')::integer);
      insert into public.courtesy_billing_records (company_id, subscription_id, competence, courtesy_id, item_kind, module_code, ref_id,
                                                   description, original_cents, waived_cents, invoice_id)
      values (v_sub.company_id, v_sub.id, p_competence, (v_line ->> 'courtesy_id')::uuid, v_line ->> 'kind', v_line ->> 'module_code',
              (v_line ->> 'ref_id')::uuid, v_line ->> 'description', (v_line ->> 'amount_cents')::integer, (v_line ->> 'amount_cents')::integer, v_inv.id);
      v_discounts := v_discounts || jsonb_build_object('courtesy_id', v_line ->> 'courtesy_id', 'item', v_line ->> 'description',
                                                       'waived_cents', (v_line ->> 'amount_cents')::integer);
    end loop;
  end if;

  select jsonb_agg(jsonb_build_object(
           'kind', it.kind, 'ref_id', it.ref_id,
           'description', it.description, 'amount_cents', it.amount_cents)
         order by case it.kind when 'plan' then 0 when 'module' then 1 else 2 end, it.description, it.id)
  into v_items from public.invoice_items it where it.invoice_id = v_inv.id;

  perform public.record_invoice_event(v_inv.id, 'generated', jsonb_build_object(
    'subscription_id', v_sub.id,
    'competence', p_competence,
    'due_date', v_inv.due_date,
    'billing_day', v_terms.billing_day,
    'terms_effective_from', v_terms.effective_from_competence,
    'plan_id', v_terms.plan_id,
    'amount_cents', v_inv.amount_cents,
    'items', v_items)
    || case when v_exempt > 0 then jsonb_build_object('courtesy_waived_cents', v_exempt, 'courtesy_discounts', v_discounts) else '{}'::jsonb end);

  return jsonb_build_object('invoice_id', v_inv.id, 'created', true)
    || case when v_exempt > 0 then jsonb_build_object('courtesy_waived_cents', v_exempt) else '{}'::jsonb end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Consulta do Master
-- ---------------------------------------------------------------------------
create function public.master_list_courtesy_billing(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_master_admin();
  if not exists (select 1 from public.companies where id = p_company_id) then
    raise exception 'empresa não encontrada';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id, 'competence', r.competence, 'courtesy_id', r.courtesy_id, 'item_kind', r.item_kind,
             'module_code', r.module_code, 'description', r.description, 'original_cents', r.original_cents,
             'waived_cents', r.waived_cents, 'invoice_id', r.invoice_id,
             'outcome', case when r.invoice_id is null then 'waived_no_invoice' else 'discounted_on_invoice' end,
             'created_at', r.created_at) order by r.competence desc, r.created_at, r.id)
      from public.courtesy_billing_records r where r.company_id = p_company_id), '[]'::jsonb);
end;
$$;

revoke execute on function public.master_list_courtesy_billing(uuid) from public, anon;
grant execute on function public.master_list_courtesy_billing(uuid) to authenticated;

-- Área Master: fechamento comercial.
-- Reaproveita plans/modules/subscriptions/invoices/company_trials existentes (NENHUMA tabela nova). Entrega:
--   1) catálogo oficial: Plano Base R$ 79,90 + 4 módulos opcionais (financeiro, producao, estoque, impressao);
--      núcleo (Atendimento, Comandas/Mesas, Pedidos, Caixa básico, Clientes, Dashboard, Configurações) NÃO é módulo pago;
--   2) master_get_commercial_overview(): KPIs da Visão geral (MRR = só assinaturas ativas pagas, sem trial);
--   3) master_list_companies_summary(): lista enriquecida (plano, status, vencimento, módulos, usuários, total mensal);
--   4) master_update_company(): Master edita nome/documento/telefone/WhatsApp/e-mail (nunca id/slug/access_code);
--   5) master_get_commercial_settings(): leitura das regras vigentes (trial, carência, valores) — as regras seguem fixas no backend.
-- Todas SECURITY DEFINER, assert_master_admin() primeiro, search_path fixo, ACL explícita (authenticated apenas).

-- ---------------------------------------------------------------------------
-- 1) Catálogo oficial (idempotente; NÃO sobrescreve preço/descrição já ajustados pelo Master)
-- ---------------------------------------------------------------------------
insert into public.modules (code, name, description, monthly_price_cents, is_active) values
  ('financeiro', 'Financeiro', 'Visão financeira, Contas a receber e Contas a pagar.', 2490, true),
  ('producao', 'Produção / KDS', 'Painel de produção, setores, fila, histórico e métricas de preparo.', 1990, true),
  ('estoque', 'Estoque', 'Controle de estoque, disponibilidade, movimentações e relatórios.', 1990, true),
  ('impressao', 'Impressão Avançada', 'Print Agent, impressão avançada e etiquetas de produto, livre e comanda/mesa.', 1490, true)
on conflict (code) do nothing;

-- Nenhum outro módulo comercial nesta versão: qualquer módulo antigo fora dos 4 fica inativo (sem apagar histórico).
update public.modules
   set is_active = false
 where code not in ('financeiro', 'producao', 'estoque', 'impressao') and is_active;

-- Plano Base: preço atual (R$ 79,90) é mantido; só nome/descrição passam a refletir o núcleo incluído.
update public.plans
   set name = 'PLANO BASE',
       description = 'Atendimento, Comandas/Mesas, Pedidos, Caixa básico, Clientes, Dashboard e Configurações.'
 where code = 'base'
   and (name is distinct from 'PLANO BASE' or description is distinct from 'Atendimento, Comandas/Mesas, Pedidos, Caixa básico, Clientes, Dashboard e Configurações.');

-- ---------------------------------------------------------------------------
-- 2) KPIs da Visão geral
-- ---------------------------------------------------------------------------
create function public.master_get_commercial_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  perform public.assert_master_admin();

  select jsonb_build_object(
    'total_companies', (select count(*) from public.companies),
    'total_users', (select count(distinct cu.user_id) from public.company_users cu),
    -- em trial = período grátis vigente (sem assinatura paga) + assinaturas em status trialing
    'trialing_companies', (
      select count(*) from public.companies c
      where exists (select 1 from public.company_trials ct
                    where ct.company_id = c.id
                      and public.trial_effective_state(ct.status, ct.trial_ends_at) = 'trialing')
         or exists (select 1 from public.subscriptions s where s.company_id = c.id and s.status = 'trialing')
    ),
    'active_subscriptions', (select count(*) from public.subscriptions s where s.status = 'active'),
    -- bloqueadas/inadimplentes: qualquer estado de cobrança vencida ou corte
    'blocked_subscriptions', (
      select count(*) from public.subscriptions s
      where s.status in ('past_due', 'grace', 'restricted', 'suspended', 'pending_payment')
    ),
    -- MRR estimado: SOMENTE assinaturas ativas pagas (plano + módulos extras contratados). Trial não entra.
    'mrr_cents', coalesce((
      select sum(
        s.plan_price_cents_snapshot + coalesce((
          select sum(sm.price_cents_snapshot) from public.subscription_modules sm
          where sm.subscription_id = s.id and sm.source = 'extra' and sm.removed_at is null
        ), 0))
      from public.subscriptions s where s.status = 'active'
    ), 0)
  ) into v_result;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Lista enriquecida de empresas (1 chamada, sem N+1)
-- ---------------------------------------------------------------------------
create function public.master_list_companies_summary()
returns table (
  id uuid,
  name text,
  document text,
  created_at timestamptz,
  member_count bigint,
  subscription_id uuid,
  subscription_status text,
  plan_name text,
  trial_state text,
  trial_ends_at timestamptz,
  next_due_date date,
  active_module_names text[],
  monthly_total_cents integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_master_admin();

  return query
  select
    c.id, c.name, c.document, c.created_at,
    (select count(*) from public.company_users cu where cu.company_id = c.id)::bigint,
    s.id, s.status, p.name,
    case when ct.id is null then null
         else public.trial_effective_state(ct.status, ct.trial_ends_at) end,
    ct.trial_ends_at,
    (select min(i.due_date) from public.invoices i
      where i.subscription_id = s.id and i.status in ('open', 'overdue')),
    coalesce((select array_agg(m.name order by m.name)
              from public.subscription_modules sm join public.modules m on m.id = sm.module_id
              where sm.subscription_id = s.id and sm.removed_at is null), '{}'::text[]),
    case when s.id is null then null
         else (s.plan_price_cents_snapshot + coalesce((
                 select sum(sm.price_cents_snapshot) from public.subscription_modules sm
                 where sm.subscription_id = s.id and sm.source = 'extra' and sm.removed_at is null), 0))::integer
    end
  from public.companies c
  left join public.subscriptions s on s.company_id = c.id and s.status <> 'canceled'
  left join public.plans p on p.id = s.plan_id
  left join public.company_trials ct on ct.company_id = c.id
  order by c.created_at desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Edição de dados cadastrais pelo Master (sem exclusão física; sem tocar dados operacionais)
-- ---------------------------------------------------------------------------
create function public.master_update_company(
  p_company_id uuid,
  p_name text,
  p_document text,
  p_phone text,
  p_whatsapp text,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c public.companies;
  v_name text := nullif(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), '');
  v_doc_in text := nullif(btrim(coalesce(p_document, '')), '');
  v_doc_digits text;
  v_doc text;
  v_phone text := nullif(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), '');
  v_wa text := nullif(regexp_replace(coalesce(p_whatsapp, ''), '\D', '', 'g'), '');
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
begin
  perform public.assert_master_admin();

  if v_name is null then raise exception 'Informe o nome da empresa.' using errcode = 'PT400'; end if;
  if char_length(v_name) > 120 then raise exception 'O nome da empresa pode ter no máximo 120 caracteres.' using errcode = 'PT400'; end if;

  select * into v_c from public.companies where id = p_company_id for update;
  if not found then raise exception 'Empresa não encontrada.' using errcode = 'PT404'; end if;

  -- Mesma regra do cadastro da empresa: só CPF/CNPJ válido; documento antigo inalterado é mantido como está.
  if v_doc_in is null then
    v_doc := null;
  else
    v_doc_digits := regexp_replace(v_doc_in, '\D', '', 'g');
    if v_c.document is not null and v_doc_digits = regexp_replace(v_c.document, '\D', '', 'g') and v_doc_digits <> '' then
      v_doc := v_c.document;
    elsif public.customers_valid_document(v_doc_digits) then
      v_doc := v_doc_digits;
    else
      raise exception 'CNPJ/CPF inválido. Confira os números.' using errcode = 'PT400';
    end if;
  end if;
  if v_phone is not null and char_length(v_phone) not between 8 and 13 then
    raise exception 'Telefone inválido. Informe o DDD e o número.' using errcode = 'PT400';
  end if;
  if v_wa is not null and char_length(v_wa) not between 8 and 13 then
    raise exception 'WhatsApp inválido. Informe o DDD e o número.' using errcode = 'PT400';
  end if;
  if v_email is not null and (char_length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    raise exception 'E-mail inválido.' using errcode = 'PT400';
  end if;

  update public.companies
     set name = v_name, document = v_doc, phone = v_phone, whatsapp = v_wa, email = v_email
   where id = p_company_id;

  return jsonb_build_object('id', p_company_id, 'name', v_name, 'document', v_doc,
                            'phone', v_phone, 'whatsapp', v_wa, 'email', v_email);
end;
$$;

-- Dados de contato para o detalhe (master_get_company não traz phone/whatsapp/email).
create function public.master_get_company_contact(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_c public.companies;
begin
  perform public.assert_master_admin();
  select * into v_c from public.companies where id = p_company_id;
  if not found then raise exception 'Empresa não encontrada.' using errcode = 'PT404'; end if;
  return jsonb_build_object('phone', v_c.phone, 'whatsapp', v_c.whatsapp, 'email', v_c.email);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Configurações comerciais (SOMENTE leitura; regras seguem fixas no backend)
-- ---------------------------------------------------------------------------
create function public.master_get_commercial_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_base integer;
  v_modules integer;
begin
  perform public.assert_master_admin();

  select p.monthly_price_cents into v_base from public.plans p where p.code = 'base';
  select coalesce(sum(m.monthly_price_cents), 0) into v_modules
    from public.modules m
   where m.is_active and m.code in ('financeiro', 'producao', 'estoque', 'impressao');

  return jsonb_build_object(
    'trial_days', public.trial_duration_days(),
    'grace_days', public.billing_grace_days(),
    'base_price_cents', coalesce(v_base, 0),
    'modules_total_cents', v_modules,
    'full_total_cents', coalesce(v_base, 0) + v_modules
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- ACL explícita
-- ---------------------------------------------------------------------------
revoke execute on function public.master_get_commercial_overview() from public, anon;
revoke execute on function public.master_list_companies_summary() from public, anon;
revoke execute on function public.master_update_company(uuid, text, text, text, text, text) from public, anon;
revoke execute on function public.master_get_company_contact(uuid) from public, anon;
revoke execute on function public.master_get_commercial_settings() from public, anon;
grant execute on function public.master_get_commercial_overview() to authenticated;
grant execute on function public.master_list_companies_summary() to authenticated;
grant execute on function public.master_update_company(uuid, text, text, text, text, text) to authenticated;
grant execute on function public.master_get_company_contact(uuid) to authenticated;
grant execute on function public.master_get_commercial_settings() to authenticated;

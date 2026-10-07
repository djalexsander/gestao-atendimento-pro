-- ENTITLEMENT REAL DE MÓDULOS (backend). Até aqui NADA no banco nem no app consultava módulo: qualquer empresa (trial, só Base,
-- unmanaged) alcançava Financeiro, Produção/KDS, Estoque e Impressão Avançada. Esta migration cria a fonte única de verdade e
-- barra as operações EXCLUSIVAS de cada módulo no backend (RPCs) e a leitura direta dos históricos exclusivos (RLS restritiva).
--
-- PRECEDÊNCIA (company_entitlement):
--   1) assinatura vigente (não cancelada) => o trial NUNCA mais concede módulo: só subscription_modules ativos (módulo pago).
--        pending_payment => nenhum extra (aguardando a baixa da inicial);
--   2) sem assinatura e trial REALMENTE vigente (status trialing e dentro da validade) => todos os módulos ativos do catálogo;
--   3) trial convertido/expirado/cancelado ou assinatura só cancelada => nenhum extra;
--   4) empresa antiga sem trial nem assinatura (unmanaged, compatibilidade) => todos (nada muda para elas).
-- Plano Base NÃO concede extras. Dados nunca são apagados: o bloqueio é só de acesso/operação; ao contratar, voltam.
--
-- MAPA MÓDULO -> RECURSO: Financeiro = Visão financeira, Contas a receber, Contas a pagar; Produção/KDS = painel, fila, histórico,
-- setores; Estoque = movimentações e controle de estoque; Impressão Avançada = etiquetas (produto/livre/comanda-mesa),
-- impressoras de etiqueta, Print Agent (pareamento) e impressoras do agente. NÃO guardados de propósito (fluxos do núcleo):
-- criação de pedido/consumo de estoque dentro do pedido e envio de ticket de pedido ao agente já pareado.

create function public.company_entitlement(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sub public.subscriptions;
  v_trial text;
  v_codes text[];
  v_all text[];
begin
  select coalesce(array_agg(m.code order by m.code), '{}') into v_all from public.modules m where m.is_active;

  select * into v_sub from public.subscriptions where company_id = p_company_id and status <> 'canceled' limit 1;
  if found then
    if v_sub.status = 'pending_payment' then
      return jsonb_build_object('mode', 'pending_payment', 'modules', '[]'::jsonb);
    end if;
    select coalesce(array_agg(m.code order by m.code), '{}') into v_codes
      from public.subscription_modules sm join public.modules m on m.id = sm.module_id
     where sm.subscription_id = v_sub.id and sm.removed_at is null and m.is_active;
    return jsonb_build_object('mode', 'subscription', 'modules', to_jsonb(v_codes));
  end if;

  select public.trial_effective_state(t.status, t.trial_ends_at) into v_trial from public.company_trials t where t.company_id = p_company_id;
  if v_trial = 'trialing' then
    return jsonb_build_object('mode', 'trial', 'modules', to_jsonb(v_all));
  end if;
  if v_trial is not null or exists (select 1 from public.subscriptions s where s.company_id = p_company_id) then
    return jsonb_build_object('mode', 'none', 'modules', '[]'::jsonb);
  end if;
  return jsonb_build_object('mode', 'unmanaged', 'modules', to_jsonb(v_all));
end;
$$;

create function public.company_has_module(p_company_id uuid, p_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((public.company_entitlement(p_company_id) -> 'modules') ? p_code, false);
$$;

-- Barreira das operações exclusivas de módulo. Empresa nula passa (a função chamadora falha adiante com o erro próprio dela).
create function public.assert_company_module(p_company_id uuid, p_code text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_company_id is null then
    return;
  end if;
  if not public.company_has_module(p_company_id, p_code) then
    raise exception 'O módulo "%" não está contratado. Contrate em Configurações → Meus Planos.',
      coalesce((select m.name from public.modules m where m.code = p_code), p_code) using errcode = 'PT403';
  end if;
end;
$$;

-- Entitlement para o app (qualquer membro ativo da empresa: o menu e as rotas do funcionário também dependem dele).
create function public.tenant_get_entitlements(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Faça login para continuar.' using errcode = 'PT401';
  end if;
  if p_company_id is null or not exists (select 1 from public.user_company_ids() u where u = p_company_id) then
    raise exception 'Empresa não encontrada.' using errcode = 'PT403';
  end if;
  return public.company_entitlement(p_company_id);
end;
$$;

-- Versão para as políticas RLS (executam com o papel do usuário, então precisam de EXECUTE para authenticated): só responde "sim"
-- para empresa da qual o usuário é membro; para qualquer outra devolve falso (não revela o plano de empresa alheia).
create function public.company_has_module_rls(p_company_id uuid, p_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.user_company_ids() u where u = p_company_id) and public.company_has_module(p_company_id, p_code);
$$;

-- Históricos exclusivos de módulo: sem o módulo, o cliente não os enxerga (os dados permanecem no banco).
create policy product_stock_movements_module on public.product_stock_movements as restrictive for select to authenticated
  using (public.company_has_module_rls(company_id, 'estoque'));
create policy accounts_receivable_module on public.accounts_receivable as restrictive for select to authenticated
  using (public.company_has_module_rls(company_id, 'financeiro'));
create policy accounts_receivable_events_module on public.accounts_receivable_events as restrictive for select to authenticated
  using (public.company_has_module_rls(company_id, 'financeiro'));
create policy accounts_payable_module on public.accounts_payable as restrictive for select to authenticated
  using (public.company_has_module_rls(company_id, 'financeiro'));
create policy accounts_payable_events_module on public.accounts_payable_events as restrictive for select to authenticated
  using (public.company_has_module_rls(company_id, 'financeiro'));

-- ---------------------------------------------------------------------------
-- RPCs exclusivas de módulo: versão vigente de cada uma + a barreira de entitlement logo no início (ACL inalterada).
-- ---------------------------------------------------------------------------
-- list_receivables [financeiro]
create or replace function public.list_receivables(
  p_company_id uuid,
  p_status text default 'all',
  p_date_field text default 'due',
  p_from date default null,
  p_to date default null,
  p_search text default null,
  p_sort text default 'due',
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
  v_today date := public.receivables_today();
  v_term text := nullif(btrim(coalesce(p_search, '')), '');
  v_pattern text;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total bigint;
  v_rows jsonb;
begin
  perform public.assert_company_module(p_company_id, 'financeiro');
  perform public.receivables_assert_manager(p_company_id);

  if p_status is null or p_status not in ('all', 'pending', 'due_today', 'overdue', 'paid', 'cancelled') then
    raise exception 'Filtro de status inválido.' using errcode = 'PT400';
  end if;
  if p_date_field is null or p_date_field not in ('due', 'paid') then
    raise exception 'Filtro de data inválido.' using errcode = 'PT400';
  end if;
  if p_sort is null or p_sort not in ('due', 'overdue', 'amount', 'recent') then
    raise exception 'Ordenação inválida.' using errcode = 'PT400';
  end if;
  if (p_from is not null and p_to is not null and p_from > p_to) then
    raise exception 'A data inicial não pode ser depois da final.' using errcode = 'PT400';
  end if;

  if v_term is not null then
    v_pattern := '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  with f as (
    select
      r.*,
      count(*) over () as total_count,
      row_number() over (
        order by
          case when p_sort = 'overdue' then case r.status when 'pending' then 0 when 'paid' then 1 else 2 end end asc nulls last,
          case when p_sort = 'amount' then r.amount end desc nulls last,
          case when p_sort = 'recent' then r.created_at end desc nulls last,
          r.due_date asc, r.created_at asc, r.id
      ) as ord
    from public.accounts_receivable r
    where r.company_id = p_company_id
      and (
        p_status = 'all'
        or (p_status = 'pending' and r.status = 'pending' and r.due_date >= v_today)
        or (p_status = 'due_today' and r.status = 'pending' and r.due_date = v_today)
        or (p_status = 'overdue' and r.status = 'pending' and r.due_date < v_today)
        or (p_status = 'paid' and r.status = 'paid')
        or (p_status = 'cancelled' and r.status = 'cancelled')
      )
      and (v_pattern is null
           or r.customer_name ilike v_pattern
           or r.description ilike v_pattern
           or coalesce(r.reference, '') ilike v_pattern)
      and (
        (p_from is null and p_to is null)
        or (p_date_field = 'due'
            and (p_from is null or r.due_date >= p_from)
            and (p_to is null or r.due_date <= p_to))
        or (p_date_field = 'paid'
            and exists (
              select 1 from public.accounts_receivable_events e
              where e.company_id = r.company_id and e.receivable_id = r.id and e.event_type = 'payment'
                and (p_from is null or e.paid_on >= p_from)
                and (p_to is null or e.paid_on <= p_to)))
      )
  )
  select
    coalesce(max(f.total_count), 0),
    coalesce(jsonb_agg(
      jsonb_build_object(
        'id', f.id,
        'customer_id', f.customer_id,
        'customer_name', f.customer_name,
        'description', f.description,
        'reference', f.reference,
        'notes', f.notes,
        'amount', f.amount,
        'paid_amount', f.paid_amount,
        'balance', f.amount - f.paid_amount,
        'due_date', f.due_date,
        'status', f.status,
        'display_status', case
          when f.status = 'pending' and f.due_date < v_today then 'overdue'
          when f.status = 'pending' and f.due_date = v_today then 'due_today'
          else f.status
        end,
        'payment_method', f.payment_method,
        'paid_at', f.paid_at,
        'cancelled_at', f.cancelled_at,
        'cancel_reason', f.cancel_reason,
        'created_at', f.created_at,
        'updated_at', f.updated_at,
        'created_by_name', pr.full_name
      ) order by f.ord
    ) filter (where f.ord > v_offset and f.ord <= v_offset + v_limit), '[]'::jsonb)
    into v_total, v_rows
  from f
  left join public.profiles pr on pr.user_id = f.created_by;

  return jsonb_build_object('total', v_total, 'today', v_today, 'rows', v_rows);
end;
$$;

-- receivables_summary [financeiro]
create or replace function public.receivables_summary(p_company_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_today date := public.receivables_today();
  v_open jsonb;
  v_received jsonb;
begin
  perform public.assert_company_module(p_company_id, 'financeiro');
  perform public.receivables_assert_manager(p_company_id);

  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Informe um período válido (data inicial até a final).' using errcode = 'PT400';
  end if;
  if p_from < date '2000-01-01' or p_to > date '2100-01-01' or p_to - p_from > 365 then
    raise exception 'O período pode ter no máximo 366 dias.' using errcode = 'PT400';
  end if;

  select jsonb_build_object(
           'open_balance', coalesce(sum(amount - paid_amount), 0)::numeric(12, 2),
           'open_count', count(*),
           'due_today_balance', coalesce(sum(amount - paid_amount) filter (where due_date = v_today), 0)::numeric(12, 2),
           'due_today_count', count(*) filter (where due_date = v_today),
           'overdue_balance', coalesce(sum(amount - paid_amount) filter (where due_date < v_today), 0)::numeric(12, 2),
           'overdue_count', count(*) filter (where due_date < v_today)
         )
    into v_open
  from public.accounts_receivable
  where company_id = p_company_id and status = 'pending';

  select jsonb_build_object(
           'received', coalesce(sum(amount), 0)::numeric(12, 2),
           'received_count', count(*)
         )
    into v_received
  from public.accounts_receivable_events
  where company_id = p_company_id and event_type = 'payment' and paid_on between p_from and p_to;

  return jsonb_build_object('today', v_today, 'period', jsonb_build_object('from', p_from, 'to', p_to)) || v_open || v_received;
end;
$$;

-- create_receivable [financeiro]
create or replace function public.create_receivable(
  p_company_id uuid,
  p_customer_name text,
  p_description text,
  p_amount numeric,
  p_due_date date,
  p_reference text default null,
  p_notes text default null,
  p_customer_id uuid default null
)
returns public.accounts_receivable
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer text := nullif(btrim(coalesce(p_customer_name, '')), '');
  v_desc text := nullif(btrim(coalesce(p_description, '')), '');
  v_ref text := nullif(btrim(coalesce(p_reference, '')), '');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_cust public.customers;
  v_row public.accounts_receivable;
begin
  perform public.assert_company_module(p_company_id, 'financeiro');
  perform public.receivables_assert_manager(p_company_id);

  if p_customer_id is not null then
    select * into v_cust from public.customers where id = p_customer_id and company_id = p_company_id;
    if not found then raise exception 'Cliente não encontrado.' using errcode = 'PT404'; end if;
    if not v_cust.is_active then raise exception 'Este cliente está inativo.' using errcode = 'PT409'; end if;
    v_customer := v_cust.name;
  end if;

  if v_customer is null then raise exception 'Informe o cliente.' using errcode = 'PT400'; end if;
  if char_length(v_customer) > 120 then raise exception 'O nome do cliente pode ter no máximo 120 caracteres.' using errcode = 'PT400'; end if;
  if v_desc is null then raise exception 'Informe a descrição.' using errcode = 'PT400'; end if;
  if char_length(v_desc) > 200 then raise exception 'A descrição pode ter no máximo 200 caracteres.' using errcode = 'PT400'; end if;
  if v_ref is not null and char_length(v_ref) > 60 then raise exception 'A referência pode ter no máximo 60 caracteres.' using errcode = 'PT400'; end if;
  if v_notes is not null and char_length(v_notes) > 500 then raise exception 'A observação pode ter no máximo 500 caracteres.' using errcode = 'PT400'; end if;
  if p_amount is null or p_amount <= 0 or p_amount >= 10000000000 or p_amount <> round(p_amount, 2) then
    raise exception 'Informe um valor maior que zero, com até 2 casas decimais.' using errcode = 'PT400';
  end if;
  if p_due_date is null or p_due_date < date '2000-01-01' or p_due_date > date '2100-01-01' then
    raise exception 'Informe um vencimento válido.' using errcode = 'PT400';
  end if;

  insert into public.accounts_receivable (company_id, customer_id, customer_name, description, reference, notes, amount, due_date, created_by)
  values (p_company_id, p_customer_id, v_customer, v_desc, v_ref, v_notes, p_amount, p_due_date, auth.uid())
  returning * into v_row;

  insert into public.accounts_receivable_events (company_id, receivable_id, event_type, amount, created_by)
  values (p_company_id, v_row.id, 'created', p_amount, auth.uid());

  return v_row;
end;
$$;

-- update_receivable [financeiro]
create or replace function public.update_receivable(
  p_receivable_id uuid,
  p_customer_name text,
  p_description text,
  p_amount numeric,
  p_due_date date,
  p_reference text default null,
  p_notes text default null,
  p_customer_id uuid default null
)
returns public.accounts_receivable
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.accounts_receivable;
  v_customer text := nullif(btrim(coalesce(p_customer_name, '')), '');
  v_desc text := nullif(btrim(coalesce(p_description, '')), '');
  v_ref text := nullif(btrim(coalesce(p_reference, '')), '');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_cust public.customers;
begin
  perform public.assert_company_module((select r.company_id from public.accounts_receivable r where r.id = p_receivable_id), 'financeiro');
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_row from public.accounts_receivable where id = p_receivable_id for update;
  if not found then
    raise exception 'Conta não encontrada.' using errcode = 'PT404';
  end if;
  perform public.receivables_assert_manager(v_row.company_id);

  if v_row.status <> 'pending' then
    raise exception 'Só é possível editar uma conta pendente.' using errcode = 'PT409';
  end if;

  if p_customer_id is not null then
    select * into v_cust from public.customers where id = p_customer_id and company_id = v_row.company_id;
    if not found then raise exception 'Cliente não encontrado.' using errcode = 'PT404'; end if;
    if p_customer_id is not distinct from v_row.customer_id then
      v_customer := v_row.customer_name;
    else
      if not v_cust.is_active then raise exception 'Este cliente está inativo.' using errcode = 'PT409'; end if;
      v_customer := v_cust.name;
    end if;
  end if;

  if v_customer is null then raise exception 'Informe o cliente.' using errcode = 'PT400'; end if;
  if char_length(v_customer) > 120 then raise exception 'O nome do cliente pode ter no máximo 120 caracteres.' using errcode = 'PT400'; end if;
  if v_desc is null then raise exception 'Informe a descrição.' using errcode = 'PT400'; end if;
  if char_length(v_desc) > 200 then raise exception 'A descrição pode ter no máximo 200 caracteres.' using errcode = 'PT400'; end if;
  if v_ref is not null and char_length(v_ref) > 60 then raise exception 'A referência pode ter no máximo 60 caracteres.' using errcode = 'PT400'; end if;
  if v_notes is not null and char_length(v_notes) > 500 then raise exception 'A observação pode ter no máximo 500 caracteres.' using errcode = 'PT400'; end if;
  if p_amount is null or p_amount <= 0 or p_amount >= 10000000000 or p_amount <> round(p_amount, 2) then
    raise exception 'Informe um valor maior que zero, com até 2 casas decimais.' using errcode = 'PT400';
  end if;
  if p_amount <= v_row.paid_amount then
    raise exception 'O valor deve ser maior que o já recebido (R$ %).', to_char(v_row.paid_amount, 'FM999999990.00') using errcode = 'PT400';
  end if;
  if p_due_date is null or p_due_date < date '2000-01-01' or p_due_date > date '2100-01-01' then
    raise exception 'Informe um vencimento válido.' using errcode = 'PT400';
  end if;

  update public.accounts_receivable
     set customer_id = p_customer_id, customer_name = v_customer, description = v_desc, reference = v_ref, notes = v_notes,
         amount = p_amount, due_date = p_due_date
   where id = v_row.id
   returning * into v_row;

  insert into public.accounts_receivable_events (company_id, receivable_id, event_type, created_by)
  values (v_row.company_id, v_row.id, 'updated', auth.uid());

  return v_row;
end;
$$;

-- cancel_receivable [financeiro]
create or replace function public.cancel_receivable(p_receivable_id uuid, p_reason text default null)
returns public.accounts_receivable
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.accounts_receivable;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform public.assert_company_module((select r.company_id from public.accounts_receivable r where r.id = p_receivable_id), 'financeiro');
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_row from public.accounts_receivable where id = p_receivable_id for update;
  if not found then
    raise exception 'Conta não encontrada.' using errcode = 'PT404';
  end if;
  perform public.receivables_assert_manager(v_row.company_id);

  if v_row.status = 'cancelled' then
    raise exception 'Esta conta já foi cancelada.' using errcode = 'PT409';
  end if;
  if v_row.status = 'paid' then
    raise exception 'Uma conta paga não pode ser cancelada.' using errcode = 'PT409';
  end if;
  if v_row.paid_amount > 0 then
    raise exception 'Esta conta já teve recebimento parcial e não pode ser cancelada.' using errcode = 'PT409';
  end if;
  if v_reason is not null and char_length(v_reason) > 200 then
    raise exception 'O motivo pode ter no máximo 200 caracteres.' using errcode = 'PT400';
  end if;

  update public.accounts_receivable
     set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = v_reason
   where id = v_row.id
   returning * into v_row;

  insert into public.accounts_receivable_events (company_id, receivable_id, event_type, note, created_by)
  values (v_row.company_id, v_row.id, 'cancelled', v_reason, auth.uid());

  return v_row;
end;
$$;

-- register_receivable_payment [financeiro]
create or replace function public.register_receivable_payment(
  p_receivable_id uuid,
  p_amount numeric,
  p_payment_method text,
  p_paid_on date,
  p_note text default null
)
returns public.accounts_receivable
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.accounts_receivable;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_balance numeric(12, 2);
  v_paid numeric(12, 2);
begin
  perform public.assert_company_module((select r.company_id from public.accounts_receivable r where r.id = p_receivable_id), 'financeiro');
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_row from public.accounts_receivable where id = p_receivable_id for update;
  if not found then
    raise exception 'Conta não encontrada.' using errcode = 'PT404';
  end if;
  perform public.receivables_assert_manager(v_row.company_id);

  if v_row.status = 'paid' then
    raise exception 'Esta conta já foi paga.' using errcode = 'PT409';
  end if;
  if v_row.status = 'cancelled' then
    raise exception 'Esta conta foi cancelada.' using errcode = 'PT409';
  end if;

  v_balance := v_row.amount - v_row.paid_amount;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'Informe um valor maior que zero, com até 2 casas decimais.' using errcode = 'PT400';
  end if;
  if p_amount > v_balance then
    raise exception 'O valor recebido não pode ser maior que o saldo da conta.' using errcode = 'PT400';
  end if;
  if p_payment_method is null or p_payment_method not in ('cash', 'pix', 'debit_card', 'credit_card', 'other') then
    raise exception 'Escolha a forma de pagamento.' using errcode = 'PT400';
  end if;
  if p_paid_on is null or p_paid_on < date '2000-01-01' or p_paid_on > public.receivables_today() then
    raise exception 'Informe uma data de recebimento válida (não pode ser futura).' using errcode = 'PT400';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'A observação pode ter no máximo 500 caracteres.' using errcode = 'PT400';
  end if;

  v_paid := v_row.paid_amount + p_amount;

  update public.accounts_receivable
     set paid_amount = v_paid,
         status = case when v_paid = v_row.amount then 'paid' else 'pending' end,
         paid_at = now(),
         payment_method = p_payment_method
   where id = v_row.id
   returning * into v_row;

  insert into public.accounts_receivable_events (company_id, receivable_id, event_type, amount, payment_method, paid_on, note, created_by)
  values (v_row.company_id, v_row.id, 'payment', p_amount, p_payment_method, p_paid_on, v_note, auth.uid());

  return v_row;
end;
$$;

-- list_payables [financeiro]
create or replace function public.list_payables(
  p_company_id uuid,
  p_status text default 'all',
  p_date_field text default 'due',
  p_from date default null,
  p_to date default null,
  p_search text default null,
  p_sort text default 'due',
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
  v_today date := public.payables_today();
  v_term text := nullif(btrim(coalesce(p_search, '')), '');
  v_pattern text;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total bigint;
  v_rows jsonb;
begin
  perform public.assert_company_module(p_company_id, 'financeiro');
  perform public.payables_assert_manager(p_company_id);

  if p_status is null or p_status not in ('all', 'pending', 'due_today', 'overdue', 'paid', 'cancelled') then
    raise exception 'Filtro de status inválido.' using errcode = 'PT400';
  end if;
  if p_date_field is null or p_date_field not in ('due', 'paid') then
    raise exception 'Filtro de data inválido.' using errcode = 'PT400';
  end if;
  if p_sort is null or p_sort not in ('due', 'overdue', 'amount', 'recent') then
    raise exception 'Ordenação inválida.' using errcode = 'PT400';
  end if;
  if (p_from is not null and p_to is not null and p_from > p_to) then
    raise exception 'A data inicial não pode ser depois da final.' using errcode = 'PT400';
  end if;

  if v_term is not null then
    v_pattern := '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  with f as (
    select
      r.*,
      count(*) over () as total_count,
      row_number() over (
        order by
          case when p_sort = 'overdue' then case r.status when 'pending' then 0 when 'paid' then 1 else 2 end end asc nulls last,
          case when p_sort = 'amount' then r.amount end desc nulls last,
          case when p_sort = 'recent' then r.created_at end desc nulls last,
          r.due_date asc, r.created_at asc, r.id
      ) as ord
    from public.accounts_payable r
    where r.company_id = p_company_id
      and (
        p_status = 'all'
        or (p_status = 'pending' and r.status = 'pending' and r.due_date >= v_today)
        or (p_status = 'due_today' and r.status = 'pending' and r.due_date = v_today)
        or (p_status = 'overdue' and r.status = 'pending' and r.due_date < v_today)
        or (p_status = 'paid' and r.status = 'paid')
        or (p_status = 'cancelled' and r.status = 'cancelled')
      )
      and (v_pattern is null
           or r.supplier_name ilike v_pattern
           or r.description ilike v_pattern
           or coalesce(r.reference, '') ilike v_pattern
           or coalesce(r.document_number, '') ilike v_pattern
           or public.payable_category_label(r.category) ilike v_pattern)
      and (
        (p_from is null and p_to is null)
        or (p_date_field = 'due'
            and (p_from is null or r.due_date >= p_from)
            and (p_to is null or r.due_date <= p_to))
        or (p_date_field = 'paid'
            and exists (
              select 1 from public.accounts_payable_events e
              where e.company_id = r.company_id and e.payable_id = r.id and e.event_type = 'payment'
                and (p_from is null or e.paid_on >= p_from)
                and (p_to is null or e.paid_on <= p_to)))
      )
  )
  select
    coalesce(max(f.total_count), 0),
    coalesce(jsonb_agg(
      jsonb_build_object(
        'id', f.id,
        'supplier_name', f.supplier_name,
        'description', f.description,
        'category', f.category,
        'reference', f.reference,
        'document_number', f.document_number,
        'notes', f.notes,
        'amount', f.amount,
        'paid_amount', f.paid_amount,
        'balance', f.amount - f.paid_amount,
        'due_date', f.due_date,
        'status', f.status,
        'display_status', case
          when f.status = 'pending' and f.due_date < v_today then 'overdue'
          when f.status = 'pending' and f.due_date = v_today then 'due_today'
          else f.status
        end,
        'last_paid_on', f.last_paid_on,
        'last_payment_method', f.last_payment_method,
        'cancelled_at', f.cancelled_at,
        'cancellation_reason', f.cancellation_reason,
        'created_at', f.created_at,
        'updated_at', f.updated_at,
        'created_by_name', pr.full_name
      ) order by f.ord
    ) filter (where f.ord > v_offset and f.ord <= v_offset + v_limit), '[]'::jsonb)
    into v_total, v_rows
  from f
  left join public.profiles pr on pr.user_id = f.created_by;

  return jsonb_build_object('total', v_total, 'today', v_today, 'rows', v_rows);
end;
$$;

-- payables_summary [financeiro]
create or replace function public.payables_summary(p_company_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_today date := public.payables_today();
  v_open jsonb;
  v_paid jsonb;
begin
  perform public.assert_company_module(p_company_id, 'financeiro');
  perform public.payables_assert_manager(p_company_id);

  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Informe um período válido (data inicial até a final).' using errcode = 'PT400';
  end if;
  if p_from < date '2000-01-01' or p_to > date '2100-01-01' or p_to - p_from > 365 then
    raise exception 'O período pode ter no máximo 366 dias.' using errcode = 'PT400';
  end if;

  select jsonb_build_object(
           'open_balance', coalesce(sum(amount - paid_amount), 0)::numeric(12, 2),
           'open_count', count(*),
           'due_today_balance', coalesce(sum(amount - paid_amount) filter (where due_date = v_today), 0)::numeric(12, 2),
           'due_today_count', count(*) filter (where due_date = v_today),
           'overdue_balance', coalesce(sum(amount - paid_amount) filter (where due_date < v_today), 0)::numeric(12, 2),
           'overdue_count', count(*) filter (where due_date < v_today)
         )
    into v_open
  from public.accounts_payable
  where company_id = p_company_id and status = 'pending';

  select jsonb_build_object(
           'paid', coalesce(sum(amount), 0)::numeric(12, 2),
           'paid_count', count(*)
         )
    into v_paid
  from public.accounts_payable_events
  where company_id = p_company_id and event_type = 'payment' and paid_on between p_from and p_to;

  return jsonb_build_object('today', v_today, 'period', jsonb_build_object('from', p_from, 'to', p_to)) || v_open || v_paid;
end;
$$;

-- create_payable [financeiro]
create or replace function public.create_payable(
  p_company_id uuid,
  p_supplier_name text,
  p_description text,
  p_category text,
  p_amount numeric,
  p_due_date date,
  p_reference text default null,
  p_document_number text default null,
  p_notes text default null
)
returns public.accounts_payable
language plpgsql
security definer
set search_path = public
as $$
declare
  v_supplier text := nullif(btrim(coalesce(p_supplier_name, '')), '');
  v_desc text := nullif(btrim(coalesce(p_description, '')), '');
  v_ref text := nullif(btrim(coalesce(p_reference, '')), '');
  v_doc text := nullif(btrim(coalesce(p_document_number, '')), '');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_row public.accounts_payable;
begin
  perform public.assert_company_module(p_company_id, 'financeiro');
  perform public.payables_assert_manager(p_company_id);

  if v_supplier is null then raise exception 'Informe o fornecedor.' using errcode = 'PT400'; end if;
  if char_length(v_supplier) > 120 then raise exception 'O nome do fornecedor pode ter no máximo 120 caracteres.' using errcode = 'PT400'; end if;
  if v_desc is null then raise exception 'Informe a descrição.' using errcode = 'PT400'; end if;
  if char_length(v_desc) > 200 then raise exception 'A descrição pode ter no máximo 200 caracteres.' using errcode = 'PT400'; end if;
  if p_category is null or p_category not in ('suppliers', 'rent', 'energy', 'water', 'internet_phone', 'payroll', 'taxes', 'maintenance', 'equipment', 'marketing', 'services', 'other') then
    raise exception 'Escolha a categoria da despesa.' using errcode = 'PT400';
  end if;
  if v_ref is not null and char_length(v_ref) > 60 then raise exception 'A referência pode ter no máximo 60 caracteres.' using errcode = 'PT400'; end if;
  if v_doc is not null and char_length(v_doc) > 60 then raise exception 'O número do documento pode ter no máximo 60 caracteres.' using errcode = 'PT400'; end if;
  if v_notes is not null and char_length(v_notes) > 500 then raise exception 'A observação pode ter no máximo 500 caracteres.' using errcode = 'PT400'; end if;
  if p_amount is null or p_amount <= 0 or p_amount >= 10000000000 or p_amount <> round(p_amount, 2) then
    raise exception 'Informe um valor maior que zero, com até 2 casas decimais.' using errcode = 'PT400';
  end if;
  if p_due_date is null or p_due_date < date '2000-01-01' or p_due_date > date '2100-01-01' then
    raise exception 'Informe um vencimento válido.' using errcode = 'PT400';
  end if;

  insert into public.accounts_payable (company_id, supplier_name, description, category, reference, document_number, notes, amount, due_date, created_by)
  values (p_company_id, v_supplier, v_desc, p_category, v_ref, v_doc, v_notes, p_amount, p_due_date, auth.uid())
  returning * into v_row;

  insert into public.accounts_payable_events (company_id, payable_id, event_type, amount, created_by)
  values (p_company_id, v_row.id, 'created', p_amount, auth.uid());

  return v_row;
end;
$$;

-- update_payable [financeiro]
create or replace function public.update_payable(
  p_payable_id uuid,
  p_supplier_name text,
  p_description text,
  p_category text,
  p_amount numeric,
  p_due_date date,
  p_reference text default null,
  p_document_number text default null,
  p_notes text default null
)
returns public.accounts_payable
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.accounts_payable;
  v_supplier text := nullif(btrim(coalesce(p_supplier_name, '')), '');
  v_desc text := nullif(btrim(coalesce(p_description, '')), '');
  v_ref text := nullif(btrim(coalesce(p_reference, '')), '');
  v_doc text := nullif(btrim(coalesce(p_document_number, '')), '');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
begin
  perform public.assert_company_module((select r.company_id from public.accounts_payable r where r.id = p_payable_id), 'financeiro');
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_row from public.accounts_payable where id = p_payable_id for update;
  if not found then
    raise exception 'Conta não encontrada.' using errcode = 'PT404';
  end if;
  perform public.payables_assert_manager(v_row.company_id);

  if v_row.status <> 'pending' then
    raise exception 'Só é possível editar uma conta pendente.' using errcode = 'PT409';
  end if;
  if v_row.paid_amount > 0 then
    raise exception 'Esta conta já teve pagamento parcial e não pode ser editada.' using errcode = 'PT409';
  end if;

  if v_supplier is null then raise exception 'Informe o fornecedor.' using errcode = 'PT400'; end if;
  if char_length(v_supplier) > 120 then raise exception 'O nome do fornecedor pode ter no máximo 120 caracteres.' using errcode = 'PT400'; end if;
  if v_desc is null then raise exception 'Informe a descrição.' using errcode = 'PT400'; end if;
  if char_length(v_desc) > 200 then raise exception 'A descrição pode ter no máximo 200 caracteres.' using errcode = 'PT400'; end if;
  if p_category is null or p_category not in ('suppliers', 'rent', 'energy', 'water', 'internet_phone', 'payroll', 'taxes', 'maintenance', 'equipment', 'marketing', 'services', 'other') then
    raise exception 'Escolha a categoria da despesa.' using errcode = 'PT400';
  end if;
  if v_ref is not null and char_length(v_ref) > 60 then raise exception 'A referência pode ter no máximo 60 caracteres.' using errcode = 'PT400'; end if;
  if v_doc is not null and char_length(v_doc) > 60 then raise exception 'O número do documento pode ter no máximo 60 caracteres.' using errcode = 'PT400'; end if;
  if v_notes is not null and char_length(v_notes) > 500 then raise exception 'A observação pode ter no máximo 500 caracteres.' using errcode = 'PT400'; end if;
  if p_amount is null or p_amount <= 0 or p_amount >= 10000000000 or p_amount <> round(p_amount, 2) then
    raise exception 'Informe um valor maior que zero, com até 2 casas decimais.' using errcode = 'PT400';
  end if;
  if p_due_date is null or p_due_date < date '2000-01-01' or p_due_date > date '2100-01-01' then
    raise exception 'Informe um vencimento válido.' using errcode = 'PT400';
  end if;

  update public.accounts_payable
     set supplier_name = v_supplier, description = v_desc, category = p_category, reference = v_ref,
         document_number = v_doc, notes = v_notes, amount = p_amount, due_date = p_due_date
   where id = v_row.id
   returning * into v_row;

  insert into public.accounts_payable_events (company_id, payable_id, event_type, created_by)
  values (v_row.company_id, v_row.id, 'updated', auth.uid());

  return v_row;
end;
$$;

-- cancel_payable [financeiro]
create or replace function public.cancel_payable(p_payable_id uuid, p_reason text default null)
returns public.accounts_payable
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.accounts_payable;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform public.assert_company_module((select r.company_id from public.accounts_payable r where r.id = p_payable_id), 'financeiro');
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_row from public.accounts_payable where id = p_payable_id for update;
  if not found then
    raise exception 'Conta não encontrada.' using errcode = 'PT404';
  end if;
  perform public.payables_assert_manager(v_row.company_id);

  if v_row.status = 'cancelled' then
    raise exception 'Esta conta já foi cancelada.' using errcode = 'PT409';
  end if;
  if v_row.status = 'paid' then
    raise exception 'Uma conta paga não pode ser cancelada.' using errcode = 'PT409';
  end if;
  if v_row.paid_amount > 0 then
    raise exception 'Esta conta já teve pagamento parcial e não pode ser cancelada.' using errcode = 'PT409';
  end if;
  if v_reason is not null and char_length(v_reason) > 200 then
    raise exception 'O motivo pode ter no máximo 200 caracteres.' using errcode = 'PT400';
  end if;

  update public.accounts_payable
     set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancellation_reason = v_reason
   where id = v_row.id
   returning * into v_row;

  insert into public.accounts_payable_events (company_id, payable_id, event_type, note, created_by)
  values (v_row.company_id, v_row.id, 'cancelled', v_reason, auth.uid());

  return v_row;
end;
$$;

-- register_payable_payment [financeiro]
create or replace function public.register_payable_payment(
  p_payable_id uuid,
  p_amount numeric,
  p_payment_method text,
  p_paid_on date,
  p_note text default null
)
returns public.accounts_payable
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.accounts_payable;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_balance numeric(12, 2);
  v_paid numeric(12, 2);
begin
  perform public.assert_company_module((select r.company_id from public.accounts_payable r where r.id = p_payable_id), 'financeiro');
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_row from public.accounts_payable where id = p_payable_id for update;
  if not found then
    raise exception 'Conta não encontrada.' using errcode = 'PT404';
  end if;
  perform public.payables_assert_manager(v_row.company_id);

  if v_row.status = 'paid' then
    raise exception 'Esta conta já foi paga.' using errcode = 'PT409';
  end if;
  if v_row.status = 'cancelled' then
    raise exception 'Esta conta foi cancelada.' using errcode = 'PT409';
  end if;

  v_balance := v_row.amount - v_row.paid_amount;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'Informe um valor maior que zero, com até 2 casas decimais.' using errcode = 'PT400';
  end if;
  if p_amount > v_balance then
    raise exception 'O valor pago não pode ser maior que o saldo da conta.' using errcode = 'PT400';
  end if;
  if p_payment_method is null or p_payment_method not in ('cash', 'pix', 'debit_card', 'credit_card', 'other') then
    raise exception 'Escolha a forma de pagamento.' using errcode = 'PT400';
  end if;
  if p_paid_on is null or p_paid_on < date '2000-01-01' or p_paid_on > public.payables_today() then
    raise exception 'Informe uma data de pagamento válida (não pode ser futura).' using errcode = 'PT400';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'A observação pode ter no máximo 500 caracteres.' using errcode = 'PT400';
  end if;

  v_paid := v_row.paid_amount + p_amount;

  update public.accounts_payable
     set paid_amount = v_paid,
         status = case when v_paid = v_row.amount then 'paid' else 'pending' end,
         last_paid_on = p_paid_on,
         last_payment_method = p_payment_method
   where id = v_row.id
   returning * into v_row;

  insert into public.accounts_payable_events (company_id, payable_id, event_type, amount, payment_method, paid_on, note, created_by)
  values (v_row.company_id, v_row.id, 'payment', p_amount, p_payment_method, p_paid_on, v_note, auth.uid());

  return v_row;
end;
$$;

-- add_stock_movement [estoque]
create or replace function public.add_stock_movement(
  p_product_id uuid,
  p_movement_type text,
  p_quantity integer,
  p_reason text
)
returns public.product_stock_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.products;
  v_role public.company_role;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_balance integer;
  v_movement public.product_stock_movements;
begin
  perform public.assert_company_module((select p.company_id from public.products p where p.id = p_product_id), 'estoque');
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_product from public.products where id = p_product_id for update;
  if not found then
    raise exception 'Produto não encontrado.' using errcode = 'PT404';
  end if;

  v_role := public.user_role_in_company(v_product.company_id);
  if v_role is null then
    raise exception 'Produto não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Você não tem permissão para movimentar o estoque.' using errcode = 'PT403';
  end if;

  if v_product.stock_control <> 'quantity' then
    raise exception 'Este produto não controla estoque.' using errcode = 'PT409';
  end if;
  if p_movement_type is null or p_movement_type not in ('entry', 'adjustment_in', 'adjustment_out') then
    raise exception 'Tipo de movimento inválido.' using errcode = 'PT400';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > 1000000 then
    raise exception 'Informe uma quantidade inteira maior que zero.' using errcode = 'PT400';
  end if;
  -- Ajustes exigem motivo; a entrada aceita "Reposição" como padrão.
  if v_reason is null and p_movement_type = 'entry' then
    v_reason := 'Reposição';
  end if;
  if v_reason is null then
    raise exception 'Informe o motivo do ajuste.' using errcode = 'PT400';
  end if;
  if char_length(v_reason) > 200 then
    raise exception 'O motivo pode ter no máximo 200 caracteres.' using errcode = 'PT400';
  end if;

  if p_movement_type = 'adjustment_out' then
    if p_quantity > v_product.stock_quantity then
      raise exception 'A saída deixaria o estoque negativo (saldo atual: %).', v_product.stock_quantity using errcode = 'PT400';
    end if;
    v_balance := v_product.stock_quantity - p_quantity;
  else
    v_balance := v_product.stock_quantity + p_quantity;
  end if;

  update public.products set stock_quantity = v_balance where id = v_product.id;

  insert into public.product_stock_movements (
    company_id, product_id, movement_type, quantity, reason, balance_after, created_by
  ) values (
    v_product.company_id, v_product.id, p_movement_type, p_quantity, v_reason, v_balance, auth.uid()
  ) returning * into v_movement;

  return v_movement;
end;
$$;

-- set_product_stock_control [estoque]
create or replace function public.set_product_stock_control(
  p_product_id uuid,
  p_mode text,
  p_minimum integer default 0
)
returns public.products
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.products;
  v_role public.company_role;
  v_minimum integer := coalesce(p_minimum, 0);
begin
  perform public.assert_company_module((select p.company_id from public.products p where p.id = p_product_id), 'estoque');
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_product from public.products where id = p_product_id for update;
  if not found then
    raise exception 'Produto não encontrado.' using errcode = 'PT404';
  end if;

  v_role := public.user_role_in_company(v_product.company_id);
  if v_role is null then
    raise exception 'Produto não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Você não tem permissão para alterar o controle de estoque.' using errcode = 'PT403';
  end if;

  if p_mode is null or p_mode not in ('none', 'quantity') then
    raise exception 'Modo de controle inválido.' using errcode = 'PT400';
  end if;
  if v_minimum < 0 or v_minimum > 1000000000 then
    raise exception 'O estoque mínimo deve ser zero ou mais.' using errcode = 'PT400';
  end if;

  if p_mode = 'none' then
    if v_product.stock_control = 'quantity' and v_product.stock_quantity > 0 then
      insert into public.product_stock_movements (company_id, product_id, movement_type, quantity, reason, balance_after, created_by)
      values (v_product.company_id, v_product.id, 'adjustment_out', v_product.stock_quantity, 'Controle de estoque desativado', 0, auth.uid());
    end if;
    update public.products
       set stock_control = 'none', stock_quantity = 0, minimum_stock_quantity = 0
     where id = v_product.id
    returning * into v_product;
  else
    update public.products
       set stock_control = 'quantity', minimum_stock_quantity = v_minimum
     where id = v_product.id
    returning * into v_product;
  end if;

  return v_product;
end;
$$;

-- production_queue [producao]
create or replace function public.production_queue(p_company_id uuid, p_sector_id uuid default null, p_ready_limit integer default 15)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb := public.production_queue_base(p_company_id, p_sector_id, p_ready_limit);
begin
  perform public.assert_company_module(p_company_id, 'producao');
  return jsonb_set(v, '{items}', coalesce((
    select jsonb_agg(t.it || jsonb_build_object('modifiers', public.item_modifiers_json(p_company_id, (t.it ->> 'id')::uuid, false)) order by t.ord)
    from jsonb_array_elements(v -> 'items') with ordinality as t(it, ord)
  ), '[]'::jsonb));
end;
$$;

-- production_history [producao]
create or replace function public.production_history(p_company_id uuid, p_date date default null, p_sector_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb := public.production_history_base(p_company_id, p_date, p_sector_id);
begin
  perform public.assert_company_module(p_company_id, 'producao');
  return jsonb_set(v, '{items}', coalesce((
    select jsonb_agg(t.it || jsonb_build_object('modifiers', public.item_modifiers_json(p_company_id, (t.it ->> 'id')::uuid, false)) order by t.ord)
    from jsonb_array_elements(v -> 'items') with ordinality as t(it, ord)
  ), '[]'::jsonb));
end;
$$;

-- update_production_item_status [producao]
create or replace function public.update_production_item_status(p_item_id uuid, p_status text)
returns public.service_order_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.service_order_items;
  v_role public.company_role;
  v_order_status text;
begin
  perform public.assert_company_module((select i.company_id from public.service_order_items i where i.id = p_item_id), 'producao');
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_item from public.service_order_items where id = p_item_id for update;
  if not found then
    raise exception 'Item não encontrado.' using errcode = 'PT404';
  end if;

  v_role := public.user_role_in_company(v_item.company_id);
  if v_role is null then
    raise exception 'Item não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'production') then
    raise exception 'Você não tem permissão para atualizar a produção.' using errcode = 'PT403';
  end if;

  if p_status is null or p_status not in ('preparing', 'ready') then
    raise exception 'Status de produção inválido.' using errcode = 'PT400';
  end if;

  if v_item.cancelled_quantity >= v_item.quantity then
    raise exception 'Este item foi cancelado.' using errcode = 'PT409';
  end if;

  select status into v_order_status
  from public.service_orders
  where company_id = v_item.company_id and id = v_item.order_id;
  if v_order_status is distinct from 'submitted' then
    raise exception 'Este pedido foi cancelado.' using errcode = 'PT409';
  end if;

  if v_item.production_status = p_status then
    return v_item; -- já está assim (outro aparelho chegou antes)
  end if;
  if v_item.production_status = 'ready' then
    raise exception 'Este item já está pronto.' using errcode = 'PT409';
  end if;

  update public.service_order_items
     set production_status = p_status,
         production_started_at = case when p_status = 'preparing' then now() else production_started_at end,
         production_ready_at = case when p_status = 'ready' then now() else null end,
         production_updated_by = auth.uid()
   where id = v_item.id
  returning * into v_item;

  return v_item;
end;
$$;

-- enqueue_free_labels [impressao]
create or replace function public.enqueue_free_labels(
  p_company_id uuid,
  p_device_id uuid,
  p_quantity integer,
  p_title text default null,
  p_line1 text default null,
  p_line2 text default null,
  p_line3 text default null,
  p_price_text text default null,
  p_barcode text default null,
  p_barcode_type text default 'auto',
  p_extra text default null,
  p_show_company boolean default false
)
returns public.print_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_device public.print_devices;
  v_title text := nullif(btrim(coalesce(p_title, '')), '');
  v_l1 text := nullif(btrim(coalesce(p_line1, '')), '');
  v_l2 text := nullif(btrim(coalesce(p_line2, '')), '');
  v_l3 text := nullif(btrim(coalesce(p_line3, '')), '');
  v_price text := nullif(btrim(coalesce(p_price_text, '')), '');
  v_code text := nullif(btrim(coalesce(p_barcode, '')), '');
  v_extra text := nullif(btrim(coalesce(p_extra, '')), '');
  v_sym text;
  v_label jsonb;
begin
  perform public.assert_company_module(p_company_id, 'impressao');
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier') then
    raise exception 'Você não tem permissão para imprimir etiquetas livres.' using errcode = 'PT403';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 500 then
    raise exception 'A quantidade de etiquetas deve ser de 1 a 500.' using errcode = 'PT400';
  end if;
  if char_length(coalesce(v_title, '')) > 60 or char_length(coalesce(v_l1, '')) > 60 or char_length(coalesce(v_l2, '')) > 60
     or char_length(coalesce(v_l3, '')) > 60 or char_length(coalesce(v_extra, '')) > 120 then
    raise exception 'Textos muito longos: título e linhas até 60 caracteres, texto adicional até 120.' using errcode = 'PT400';
  end if;
  if char_length(coalesce(v_price, '')) > 20 then
    raise exception 'O valor pode ter no máximo 20 caracteres.' using errcode = 'PT400';
  end if;
  if v_title is null and v_l1 is null and v_l2 is null and v_l3 is null and v_price is null and v_code is null and v_extra is null then
    raise exception 'Preencha pelo menos um campo da etiqueta.' using errcode = 'PT400';
  end if;

  if v_code is not null then
    if p_barcode_type is null or p_barcode_type not in ('auto', 'code128', 'ean13') then
      raise exception 'Tipo de código de barras inválido.' using errcode = 'PT400';
    end if;
    if v_code !~ '^[ -~]{1,40}$' then
      raise exception 'O código de barras aceita até 40 caracteres simples (letras, números e símbolos comuns).' using errcode = 'PT400';
    end if;
    if p_barcode_type = 'ean13' then
      if not public.label_is_ean13(v_code) then
        raise exception 'EAN-13 inválido: informe 13 dígitos com o dígito verificador correto.' using errcode = 'PT400';
      end if;
      v_sym := 'ean13';
    elsif p_barcode_type = 'code128' then
      v_sym := 'code128';
    else
      v_sym := case when public.label_is_ean13(v_code) then 'ean13' else 'code128' end;
    end if;
  end if;

  v_device := public.print_resolve_label_device(p_company_id, p_device_id);

  v_label := jsonb_strip_nulls(jsonb_build_object(
    'header', case when coalesce(p_show_company, false) then (select name from public.companies where id = p_company_id) end,
    'title', v_title,
    'lines', (select jsonb_agg(x) from unnest(array[v_l1, v_l2, v_l3]) x where x is not null),
    'price', v_price,
    'barcode', case when v_code is not null then jsonb_build_object('value', v_code, 'symbology', v_sym) end,
    'code_text', case when v_code is not null then v_code end,
    'footer', v_extra
  ));

  return public.print_label_job(v_device, 'label_free', p_quantity, v_label);
end;
$$;

-- enqueue_product_labels [impressao]
create or replace function public.enqueue_product_labels(
  p_company_id uuid,
  p_product_id uuid,
  p_device_id uuid,
  p_quantity integer,
  p_show_name boolean default true,
  p_show_price boolean default true,
  p_show_barcode boolean default true,
  p_show_code boolean default false,
  p_show_company boolean default false
)
returns public.print_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_product public.products;
  v_device public.print_devices;
  v_label jsonb;
begin
  perform public.assert_company_module(p_company_id, 'impressao');
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier') then
    raise exception 'Você não tem permissão para imprimir etiquetas de produtos.' using errcode = 'PT403';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 500 then
    raise exception 'A quantidade de etiquetas deve ser de 1 a 500.' using errcode = 'PT400';
  end if;
  if not (coalesce(p_show_name, false) or coalesce(p_show_price, false) or coalesce(p_show_barcode, false) or coalesce(p_show_code, false)) then
    raise exception 'Escolha pelo menos um item para aparecer na etiqueta.' using errcode = 'PT400';
  end if;

  select * into v_product from public.products where id = p_product_id and company_id = p_company_id;
  if not found then
    raise exception 'Produto não encontrado.' using errcode = 'PT404';
  end if;
  if not v_product.is_active then
    raise exception 'Este produto está inativo.' using errcode = 'PT409';
  end if;
  if coalesce(p_show_barcode, false) and v_product.barcode is null then
    raise exception 'Este produto não tem código de barras. Gere o código no cadastro do produto ou desmarque o código de barras.' using errcode = 'PT409';
  end if;

  v_device := public.print_resolve_label_device(p_company_id, p_device_id);

  v_label := jsonb_strip_nulls(jsonb_build_object(
    'header', case when coalesce(p_show_company, false) then (select name from public.companies where id = p_company_id) end,
    'title', case when coalesce(p_show_name, false) then v_product.name end,
    'price', case when coalesce(p_show_price, false) then public.label_price_text(v_product.sale_price) end,
    'barcode', case when coalesce(p_show_barcode, false) then jsonb_build_object(
        'value', v_product.barcode,
        'symbology', case when public.label_is_ean13(v_product.barcode) then 'ean13' else 'code128' end) end,
    'code_text', case when coalesce(p_show_code, false) then coalesce(v_product.barcode, v_product.code) end
  ));

  return public.print_label_job(v_device, 'label_product', p_quantity, v_label);
end;
$$;

-- enqueue_service_point_labels [impressao]
create or replace function public.enqueue_service_point_labels(
  p_company_id uuid,
  p_service_point_id uuid,
  p_device_id uuid,
  p_quantity integer default 1,
  p_show_barcode boolean default true,
  p_show_code boolean default true,
  p_show_company boolean default false
)
returns public.print_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_point public.service_points;
  v_device public.print_devices;
  v_value text;
  v_label jsonb;
begin
  perform public.assert_company_module(p_company_id, 'impressao');
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier', 'attendant') then
    raise exception 'Você não tem permissão para imprimir comandas e mesas.' using errcode = 'PT403';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 50 then
    raise exception 'A quantidade de etiquetas deve ser de 1 a 50.' using errcode = 'PT400';
  end if;

  select * into v_point from public.service_points where id = p_service_point_id and company_id = p_company_id;
  if not found then
    raise exception 'Comanda ou mesa não encontrada.' using errcode = 'PT404';
  end if;
  if not v_point.is_active then
    raise exception 'Esta comanda ou mesa está desativada.' using errcode = 'PT409';
  end if;

  v_device := public.print_resolve_label_device(p_company_id, p_device_id);
  v_value := coalesce(v_point.barcode, v_point.code);

  v_label := jsonb_strip_nulls(jsonb_build_object(
    'header', case when v_point.type = 'table' then 'MESA' else 'COMANDA' end,
    'title', regexp_replace(v_point.display_name, '^(comanda|mesa)[[:space:]]+', '', 'i'),
    'barcode', case when coalesce(p_show_barcode, true) then jsonb_build_object(
        'value', v_value,
        'symbology', case when public.label_is_ean13(v_value) then 'ean13' else 'code128' end,
        'source', case when v_point.barcode is not null then 'barcode' else 'code' end) end,
    'code_text', case when coalesce(p_show_code, true) then v_point.code end,
    'footer', case when coalesce(p_show_company, false) then (select name from public.companies where id = p_company_id) end,
    'big_title', true
  ));

  return public.print_label_job(v_device, 'label_service_point', p_quantity, v_label);
end;
$$;

-- create_label_printer [impressao]
create or replace function public.create_label_printer(
  p_company_id uuid,
  p_name text,
  p_width_mm numeric,
  p_height_mm numeric,
  p_gap_mm numeric default 3,
  p_columns integer default 1,
  p_margin_x_mm numeric default 1,
  p_margin_y_mm numeric default 1,
  p_is_default boolean default false
)
returns public.print_devices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_device public.print_devices;
  v_first boolean;
begin
  perform public.assert_company_module(p_company_id, 'impressao');
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if public.user_role_in_company(p_company_id) is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if public.user_role_in_company(p_company_id) not in ('owner', 'admin') then
    raise exception 'Você não tem permissão para configurar impressoras.' using errcode = 'PT403';
  end if;
  v_name := public.label_printer_validate(p_name, p_width_mm, p_height_mm, p_gap_mm, p_columns, p_margin_x_mm, p_margin_y_mm);

  -- A primeira impressora de etiquetas da empresa já nasce como padrão.
  select not exists (select 1 from public.print_devices where company_id = p_company_id and device_kind = 'label' and is_active)
    into v_first;
  if coalesce(p_is_default, false) or v_first then
    update public.print_devices set is_default = false
     where company_id = p_company_id and device_kind = 'label' and is_default;
  end if;

  begin
    insert into public.print_devices (
      company_id, name, device_kind, paper_width, label_width_mm, label_height_mm, label_gap_mm, label_columns,
      label_margin_x_mm, label_margin_y_mm, is_default, created_by
    ) values (
      p_company_id, v_name, 'label', null, p_width_mm, p_height_mm, p_gap_mm, p_columns,
      p_margin_x_mm, p_margin_y_mm, coalesce(p_is_default, false) or v_first, auth.uid()
    )
    returning * into v_device;
  exception when unique_violation then
    raise exception 'Já existe uma impressora com esse nome.' using errcode = 'PT409';
  end;
  return v_device;
end;
$$;

-- list_label_printers [impressao]
create or replace function public.list_label_printers(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
begin
  perform public.assert_company_module(p_company_id, 'impressao');
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier', 'attendant') then
    raise exception 'Você não tem permissão para imprimir etiquetas.' using errcode = 'PT403';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', d.id, 'name', d.name, 'width_mm', d.label_width_mm, 'height_mm', d.label_height_mm,
      'gap_mm', d.label_gap_mm, 'columns', d.label_columns,
      'margin_x_mm', d.label_margin_x_mm, 'margin_y_mm', d.label_margin_y_mm,
      'is_default', d.is_default, 'is_ready', d.is_ready
    ) order by d.is_default desc, d.created_at, d.id)
    from public.print_devices d
    where d.company_id = p_company_id and d.device_kind = 'label' and d.is_active
  ), '[]'::jsonb);
end;
$$;

-- update_label_printer [impressao]
create or replace function public.update_label_printer(
  p_device_id uuid,
  p_name text,
  p_width_mm numeric,
  p_height_mm numeric,
  p_gap_mm numeric default 3,
  p_columns integer default 1,
  p_margin_x_mm numeric default 1,
  p_margin_y_mm numeric default 1,
  p_is_default boolean default false
)
returns public.print_devices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_device public.print_devices;
begin
  perform public.assert_company_module((select d.company_id from public.print_devices d where d.id = p_device_id), 'impressao');
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_device from public.print_devices where id = p_device_id;
  if not found or public.user_role_in_company(v_device.company_id) is null then
    raise exception 'Impressora não encontrada.' using errcode = 'PT404';
  end if;
  if public.user_role_in_company(v_device.company_id) not in ('owner', 'admin') then
    raise exception 'Você não tem permissão para configurar impressoras.' using errcode = 'PT403';
  end if;
  if v_device.device_kind <> 'label' then
    raise exception 'Esta não é uma impressora de etiquetas.' using errcode = 'PT409';
  end if;
  v_name := public.label_printer_validate(p_name, p_width_mm, p_height_mm, p_gap_mm, p_columns, p_margin_x_mm, p_margin_y_mm);

  select * into v_device from public.print_devices where id = p_device_id for update;
  if not v_device.is_active then
    raise exception 'Esta impressora foi removida.' using errcode = 'PT409';
  end if;

  if coalesce(p_is_default, false) and not v_device.is_default then
    update public.print_devices set is_default = false
     where company_id = v_device.company_id and device_kind = 'label' and is_default;
  end if;

  begin
    update public.print_devices
       set name = v_name, label_width_mm = p_width_mm, label_height_mm = p_height_mm, label_gap_mm = p_gap_mm,
           label_columns = p_columns, label_margin_x_mm = p_margin_x_mm, label_margin_y_mm = p_margin_y_mm,
           is_default = coalesce(p_is_default, false) or (is_default and p_is_default is null)
     where id = p_device_id
     returning * into v_device;
  exception when unique_violation then
    raise exception 'Já existe uma impressora com esse nome.' using errcode = 'PT409';
  end;
  return v_device;
end;
$$;

-- set_default_label_printer [impressao]
create or replace function public.set_default_label_printer(p_device_id uuid)
returns public.print_devices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.print_devices;
begin
  perform public.assert_company_module((select d.company_id from public.print_devices d where d.id = p_device_id), 'impressao');
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_device from public.print_devices where id = p_device_id;
  if not found or public.user_role_in_company(v_device.company_id) is null then
    raise exception 'Impressora não encontrada.' using errcode = 'PT404';
  end if;
  if public.user_role_in_company(v_device.company_id) not in ('owner', 'admin') then
    raise exception 'Você não tem permissão para configurar impressoras.' using errcode = 'PT403';
  end if;
  if v_device.device_kind <> 'label' then
    raise exception 'Só impressoras de etiquetas têm impressora padrão.' using errcode = 'PT409';
  end if;
  select * into v_device from public.print_devices where id = p_device_id for update;
  if not v_device.is_active then
    raise exception 'Esta impressora foi removida.' using errcode = 'PT409';
  end if;
  update public.print_devices set is_default = false
   where company_id = v_device.company_id and device_kind = 'label' and is_default and id <> v_device.id;
  update public.print_devices set is_default = true where id = v_device.id returning * into v_device;
  return v_device;
end;
$$;

-- create_print_agent_pairing_code [impressao]
create or replace function public.create_print_agent_pairing_code(p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_code text;
  v_expires timestamptz := now() + interval '10 minutes';
  v_try integer := 0;
begin
  perform public.assert_company_module(p_company_id, 'impressao');
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Você não tem permissão para conectar computadores.' using errcode = 'PT403';
  end if;

  -- Um código por vez: os anteriores ainda válidos deixam de valer.
  update public.print_agent_pairing_codes
     set expires_at = now()
   where company_id = p_company_id and used_at is null and expires_at > now();

  loop
    v_try := v_try + 1;
    -- 8 dígitos a partir de bytes do CSPRNG (gen_random_uuid).
    v_code := lpad((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))::bit(48)::bigint % 100000000)::text, 8, '0');
    begin
      insert into public.print_agent_pairing_codes (company_id, code_hash, expires_at, created_by)
      values (p_company_id, public.print_token_hash(v_code), v_expires, auth.uid());
      exit;
    exception when unique_violation then
      if v_try >= 5 then
        raise exception 'Não foi possível gerar o código agora. Tente de novo.' using errcode = 'PT409';
      end if;
    end;
  end loop;

  return jsonb_build_object('code', v_code, 'expires_at', v_expires, 'ttl_seconds', 600);
end;
$$;

-- create_print_device [impressao]
create or replace function public.create_print_device(
  p_company_id uuid,
  p_name text,
  p_paper_width integer,
  p_full_order boolean default false,
  p_sector_ids uuid[] default '{}',
  p_documents text[] default '{}'
)
returns public.print_devices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_device public.print_devices;
begin
  perform public.assert_company_module(p_company_id, 'impressao');
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if public.user_role_in_company(p_company_id) is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if public.user_role_in_company(p_company_id) not in ('owner', 'admin') then
    raise exception 'Você não tem permissão para configurar impressoras.' using errcode = 'PT403';
  end if;
  if char_length(v_name) not between 1 and 80 then
    raise exception 'Informe o nome da impressora (até 80 caracteres).' using errcode = 'PT400';
  end if;
  if p_paper_width is null or p_paper_width not in (58, 80) then
    raise exception 'Largura do papel inválida (58 ou 80 mm).' using errcode = 'PT400';
  end if;

  begin
    insert into public.print_devices (company_id, name, paper_width, created_by)
    values (p_company_id, v_name, p_paper_width, auth.uid())
    returning * into v_device;
  exception when unique_violation then
    raise exception 'Já existe uma impressora com esse nome.' using errcode = 'PT409';
  end;

  perform public.apply_print_device_routes(v_device.id, p_full_order, p_sector_ids, p_documents);
  return v_device;
end;
$$;

-- update_print_device [impressao]
create or replace function public.update_print_device(
  p_device_id uuid,
  p_name text,
  p_paper_width integer,
  p_full_order boolean default false,
  p_sector_ids uuid[] default '{}',
  p_documents text[] default '{}'
)
returns public.print_devices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_device public.print_devices;
begin
  perform public.assert_company_module((select d.company_id from public.print_devices d where d.id = p_device_id), 'impressao');
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_device from public.print_devices where id = p_device_id;
  if not found or public.user_role_in_company(v_device.company_id) is null then
    raise exception 'Impressora não encontrada.' using errcode = 'PT404';
  end if;
  if public.user_role_in_company(v_device.company_id) not in ('owner', 'admin') then
    raise exception 'Você não tem permissão para configurar impressoras.' using errcode = 'PT403';
  end if;
  if char_length(v_name) not between 1 and 80 then
    raise exception 'Informe o nome da impressora (até 80 caracteres).' using errcode = 'PT400';
  end if;
  if p_paper_width is null or p_paper_width not in (58, 80) then
    raise exception 'Largura do papel inválida (58 ou 80 mm).' using errcode = 'PT400';
  end if;

  select * into v_device from public.print_devices where id = p_device_id for update;
  if not v_device.is_active then
    raise exception 'Esta impressora foi removida.' using errcode = 'PT409';
  end if;

  begin
    update public.print_devices set name = v_name, paper_width = p_paper_width
     where id = p_device_id returning * into v_device;
  exception when unique_violation then
    raise exception 'Já existe uma impressora com esse nome.' using errcode = 'PT409';
  end;

  perform public.apply_print_device_routes(p_device_id, p_full_order, p_sector_ids, p_documents);
  return v_device;
end;
$$;

-- ---------------------------------------------------------------------------
-- ACL
-- ---------------------------------------------------------------------------
revoke execute on function public.company_entitlement(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.company_has_module(uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.assert_company_module(uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.company_has_module_rls(uuid, text) from public, anon, service_role;
grant execute on function public.company_has_module_rls(uuid, text) to authenticated;
revoke execute on function public.tenant_get_entitlements(uuid) from public, anon, service_role;
grant execute on function public.tenant_get_entitlements(uuid) to authenticated;

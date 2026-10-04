-- CONTAS A RECEBER (Financeiro → Contas a receber).
--
-- Valores que a empresa ainda vai receber de um cliente (venda a prazo, cobrança manual, encomenda,
-- evento...). É um módulo SEPARADO das vendas pagas no Caixa: nada aqui cria venda, pagamento de conta
-- (service_payments), movimento de caixa (cash_movements) nem estorno. Registrar um recebimento NÃO mexe
-- no caixa físico (decisão de produto pendente: "Lançar no caixa").
--
-- Estrutura:
--   accounts_receivable         cabeçalho: cliente, descrição, referência, valor, vencimento, status,
--                               total recebido (paid_amount) e último recebimento.
--   accounts_receivable_events  trilha append-only: created / updated / payment / cancelled.
--
-- Status PERSISTIDO: pending | paid | cancelled. "Atrasada" e "Vencendo hoje" são DERIVADOS (status
-- pending + vencimento menor/igual ao dia de hoje em America/Sao_Paulo) — sem cron. Recebimento parcial é
-- suportado: pending com 0 < paid_amount < amount (a tela mostra "Parcial"); quando o total chega ao valor
-- a conta vira paid.
--
-- Escrita SOMENTE por RPC (SECURITY DEFINER): create_receivable, update_receivable,
-- register_receivable_payment, cancel_receivable. Leitura: owner/admin (list_receivables,
-- receivables_summary e SELECT direto sob RLS). cashier/attendant/production: sem acesso.
-- Erros: PT401 sem sessão, PT404 não encontrada/outra empresa, PT403 sem permissão, PT400 dados
-- inválidos, PT409 estado não permite a ação.
--
-- Fora desta migration (de propósito): Realtime (publication), integração com o Caixa, juros/multa,
-- recorrência, cobrança automática.

-- ---------------------------------------------------------------------------
-- 1) Tabelas
-- ---------------------------------------------------------------------------
create table public.accounts_receivable (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  customer_name text not null
    constraint accounts_receivable_customer_length check (char_length(customer_name) between 1 and 120),
  description text not null
    constraint accounts_receivable_description_length check (char_length(description) between 1 and 200),
  reference text
    constraint accounts_receivable_reference_length check (reference is null or char_length(reference) between 1 and 60),
  notes text
    constraint accounts_receivable_notes_length check (notes is null or char_length(notes) between 1 and 500),
  amount numeric(12, 2) not null
    constraint accounts_receivable_amount_check check (amount > 0 and amount <> 'NaN'::numeric),
  due_date date not null
    constraint accounts_receivable_due_range check (due_date between date '2000-01-01' and date '2100-01-01'),
  status text not null default 'pending'
    constraint accounts_receivable_status_check check (status in ('pending', 'paid', 'cancelled')),
  paid_amount numeric(12, 2) not null default 0
    constraint accounts_receivable_paid_check check (paid_amount >= 0 and paid_amount <= amount),
  -- Quando (instante) e com qual forma foi registrado o ÚLTIMO recebimento.
  paid_at timestamptz,
  payment_method text
    constraint accounts_receivable_method_check check (payment_method is null or payment_method in ('cash', 'pix', 'debit_card', 'credit_card', 'other')),
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete restrict,
  cancel_reason text
    constraint accounts_receivable_cancel_reason_length check (cancel_reason is null or char_length(cancel_reason) between 1 and 200),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounts_receivable_company_id_id_key unique (company_id, id),
  -- Coerência status x valores: paga = quitada; pendente = ainda com saldo; cancelada = nunca recebeu nada.
  constraint accounts_receivable_state_check check (
    (status = 'paid' and paid_amount = amount and paid_at is not null)
    or (status = 'pending' and paid_amount < amount)
    or (status = 'cancelled' and paid_amount = 0 and cancelled_at is not null)
  )
);

comment on table public.accounts_receivable is
  'Contas a receber manuais. Status persistido pending/paid/cancelled; atrasada/vencendo hoje são derivados do vencimento (America/Sao_Paulo). Escrita só por RPC. Não toca no Caixa.';
comment on column public.accounts_receivable.paid_amount is
  'Total já recebido (soma dos eventos payment). 0 <= paid_amount <= amount; paid_amount = amount <=> status paid.';

create table public.accounts_receivable_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  receivable_id uuid not null,
  event_type text not null
    constraint accounts_receivable_events_type_check check (event_type in ('created', 'updated', 'payment', 'cancelled')),
  amount numeric(12, 2)
    constraint accounts_receivable_events_amount_check check (amount is null or (amount > 0 and amount <> 'NaN'::numeric)),
  payment_method text
    constraint accounts_receivable_events_method_check check (payment_method is null or payment_method in ('cash', 'pix', 'debit_card', 'credit_card', 'other')),
  -- Data do recebimento informada pelo usuário (dia civil de America/Sao_Paulo).
  paid_on date,
  note text
    constraint accounts_receivable_events_note_length check (note is null or char_length(note) between 1 and 500),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint accounts_receivable_events_receivable_fkey
    foreign key (company_id, receivable_id) references public.accounts_receivable (company_id, id) on delete cascade,
  constraint accounts_receivable_events_payment_check check (
    event_type <> 'payment' or (amount is not null and payment_method is not null and paid_on is not null)
  )
);

comment on table public.accounts_receivable_events is
  'Trilha append-only das contas a receber (created/updated/payment/cancelled). Recebimentos (payment) têm valor, forma e data.';

create trigger accounts_receivable_set_updated_at
  before update on public.accounts_receivable
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2) Índices (só os que as consultas usam)
-- ---------------------------------------------------------------------------
-- listagem/filtro por vencimento (todos os status)
create index accounts_receivable_due_idx on public.accounts_receivable (company_id, due_date);
-- filtro por status + vencimento (pendentes/atrasadas/pagas), cards e Dashboard futuro
create index accounts_receivable_status_due_idx on public.accounts_receivable (company_id, status, due_date);
-- "Recebido no período" e filtro por data de recebimento
create index accounts_receivable_events_paid_idx on public.accounts_receivable_events (company_id, paid_on) where event_type = 'payment';
-- histórico de uma conta
create index accounts_receivable_events_receivable_idx on public.accounts_receivable_events (company_id, receivable_id, created_at);

-- ---------------------------------------------------------------------------
-- 3) RLS e GRANTs: leitura só owner/admin; nenhuma escrita direta
-- ---------------------------------------------------------------------------
alter table public.accounts_receivable enable row level security;
alter table public.accounts_receivable_events enable row level security;

create policy accounts_receivable_select on public.accounts_receivable
  for select to authenticated
  using (public.user_role_in_company(company_id) in ('owner', 'admin'));

create policy accounts_receivable_events_select on public.accounts_receivable_events
  for select to authenticated
  using (public.user_role_in_company(company_id) in ('owner', 'admin'));

revoke all on public.accounts_receivable from public, anon, authenticated;
grant select on public.accounts_receivable to authenticated;
grant all on public.accounts_receivable to service_role;

revoke all on public.accounts_receivable_events from public, anon, authenticated;
grant select on public.accounts_receivable_events to authenticated;
grant all on public.accounts_receivable_events to service_role;

-- ---------------------------------------------------------------------------
-- 4) Helper interno: hoje em America/Sao_Paulo
-- ---------------------------------------------------------------------------
create function public.receivables_today()
returns date
language sql
stable
set search_path = public
as $$
  select (now() at time zone 'America/Sao_Paulo')::date;
$$;

revoke execute on function public.receivables_today() from public, anon, authenticated;

-- Autorização comum: sessão válida, membro ativo da empresa, owner/admin.
create function public.receivables_assert_manager(p_company_id uuid)
returns public.company_role
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Você não tem permissão para contas a receber.' using errcode = 'PT403';
  end if;
  return v_role;
end;
$$;

revoke execute on function public.receivables_assert_manager(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5) RPCs de escrita
-- ---------------------------------------------------------------------------
create function public.create_receivable(
  p_company_id uuid,
  p_customer_name text,
  p_description text,
  p_amount numeric,
  p_due_date date,
  p_reference text default null,
  p_notes text default null
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
  v_row public.accounts_receivable;
begin
  perform public.receivables_assert_manager(p_company_id);

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

  insert into public.accounts_receivable (company_id, customer_name, description, reference, notes, amount, due_date, created_by)
  values (p_company_id, v_customer, v_desc, v_ref, v_notes, p_amount, p_due_date, auth.uid())
  returning * into v_row;

  insert into public.accounts_receivable_events (company_id, receivable_id, event_type, amount, created_by)
  values (p_company_id, v_row.id, 'created', p_amount, auth.uid());

  return v_row;
end;
$$;

-- Edita uma conta ainda PENDENTE (não paga, não cancelada). Com recebimento parcial, o novo valor
-- precisa continuar maior que o já recebido (para quitar, registre o recebimento).
create function public.update_receivable(
  p_receivable_id uuid,
  p_customer_name text,
  p_description text,
  p_amount numeric,
  p_due_date date,
  p_reference text default null,
  p_notes text default null
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
begin
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
     set customer_name = v_customer, description = v_desc, reference = v_ref, notes = v_notes,
         amount = p_amount, due_date = p_due_date
   where id = v_row.id
   returning * into v_row;

  insert into public.accounts_receivable_events (company_id, receivable_id, event_type, created_by)
  values (v_row.company_id, v_row.id, 'updated', auth.uid());

  return v_row;
end;
$$;

-- Registra um recebimento (total ou parcial) numa conta PENDENTE. Não mexe no Caixa.
create function public.register_receivable_payment(
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

-- Cancela uma conta PENDENTE sem nenhum recebimento (nunca apaga). Com recebimento parcial, não cancela.
create function public.cancel_receivable(p_receivable_id uuid, p_reason text default null)
returns public.accounts_receivable
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.accounts_receivable;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
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

-- ---------------------------------------------------------------------------
-- 6) Leitura: lista filtrada/ordenada/paginada e resumo (cards; reaproveitável pelo Dashboard)
-- ---------------------------------------------------------------------------
-- p_status: all | pending (a vencer, inclui hoje) | due_today | overdue | paid | cancelled
-- p_date_field: due (vencimento) | paid (data de recebimento, dos eventos payment); p_from/p_to inclusivos
-- p_sort: due (vencimento mais próximo) | overdue (pendentes primeiro, as mais antigas antes) | amount | recent
create function public.list_receivables(
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

-- Cards: a receber (saldo das pendentes), vencendo hoje, atrasado e recebido no período.
create function public.receivables_summary(p_company_id uuid, p_from date, p_to date)
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

-- ---------------------------------------------------------------------------
-- 7) ACL das funções (só usuário logado; cada uma valida o papel por dentro)
-- ---------------------------------------------------------------------------
revoke execute on function public.create_receivable(uuid, text, text, numeric, date, text, text) from public, anon;
grant execute on function public.create_receivable(uuid, text, text, numeric, date, text, text) to authenticated;
revoke execute on function public.update_receivable(uuid, text, text, numeric, date, text, text) from public, anon;
grant execute on function public.update_receivable(uuid, text, text, numeric, date, text, text) to authenticated;
revoke execute on function public.register_receivable_payment(uuid, numeric, text, date, text) from public, anon;
grant execute on function public.register_receivable_payment(uuid, numeric, text, date, text) to authenticated;
revoke execute on function public.cancel_receivable(uuid, text) from public, anon;
grant execute on function public.cancel_receivable(uuid, text) to authenticated;
revoke execute on function public.list_receivables(uuid, text, text, date, date, text, text, integer, integer) from public, anon;
grant execute on function public.list_receivables(uuid, text, text, date, date, text, text, integer, integer) to authenticated;
revoke execute on function public.receivables_summary(uuid, date, date) from public, anon;
grant execute on function public.receivables_summary(uuid, date, date) to authenticated;

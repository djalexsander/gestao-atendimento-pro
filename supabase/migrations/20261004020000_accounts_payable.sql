-- CONTAS A PAGAR (Financeiro → Contas a pagar).
--
-- Obrigações da empresa a pagar a um fornecedor (aluguel, energia, fornecedor, serviço, parcela...). É um
-- módulo SEPARADO do Caixa: nada aqui cria venda, sangria, suprimento, estorno, movimento de caixa
-- (cash_movements) nem pagamento de conta de atendimento (service_payments). Registrar um pagamento NÃO
-- movimenta o Caixa (decisão de produto pendente).
--
-- Estrutura (espelha Contas a receber, 20261004010000, com regras próprias de despesa):
--   accounts_payable         cabeçalho: fornecedor, descrição, categoria, referência, documento, valor,
--                            vencimento, status, total pago (paid_amount), data/forma do último pagamento.
--   accounts_payable_events  trilha append-only: created / updated / payment / cancelled.
--
-- Status PERSISTIDO: pending | paid | cancelled. "Atrasada" e "Vence hoje" são DERIVADOS (status pending +
-- vencimento menor/igual ao dia de hoje em America/Sao_Paulo) — sem cron. Pagamento parcial é suportado:
-- pending com 0 < paid_amount < amount (a tela mostra "Parcial"); quando o total chega ao valor vira paid.
--
-- Categoria: texto controlado (12 códigos, CHECK + validação nas RPCs). Não há tabela de categorias
-- financeiras no sistema; acrescentar uma categoria exige migration. Fornecedor é só texto livre.
--
-- Regras de mudança (todas no servidor):
--   editar    só conta pending SEM nenhum pagamento (com parcial, valor/vencimento ficam congelados);
--   pagar     só pending, valor <= saldo, data não futura, forma válida;
--   cancelar  só pending com paid_amount = 0 (nunca apaga; guarda motivo, data e autor).
--
-- Escrita SOMENTE por RPC (SECURITY DEFINER): create_payable, update_payable, register_payable_payment,
-- cancel_payable. Leitura: owner/admin (list_payables, payables_summary e SELECT direto sob RLS).
-- cashier/attendant/production: sem acesso.
-- Erros: PT401 sem sessão, PT404 não encontrada/outra empresa, PT403 sem permissão, PT400 dados inválidos,
-- PT409 estado não permite a ação.
--
-- Fora desta migration (de propósito): Realtime (publication), integração com o Caixa, recorrência,
-- juros/multa, anexos, fornecedor cadastrado, centro de custo.

-- ---------------------------------------------------------------------------
-- 1) Tabelas
-- ---------------------------------------------------------------------------
create table public.accounts_payable (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  supplier_name text not null
    constraint accounts_payable_supplier_length check (char_length(supplier_name) between 1 and 120),
  description text not null
    constraint accounts_payable_description_length check (char_length(description) between 1 and 200),
  category text not null default 'other'
    constraint accounts_payable_category_check check (category in (
      'suppliers', 'rent', 'energy', 'water', 'internet_phone', 'payroll', 'taxes',
      'maintenance', 'equipment', 'marketing', 'services', 'other')),
  reference text
    constraint accounts_payable_reference_length check (reference is null or char_length(reference) between 1 and 60),
  document_number text
    constraint accounts_payable_document_length check (document_number is null or char_length(document_number) between 1 and 60),
  notes text
    constraint accounts_payable_notes_length check (notes is null or char_length(notes) between 1 and 500),
  amount numeric(12, 2) not null
    constraint accounts_payable_amount_check check (amount > 0 and amount <> 'NaN'::numeric),
  due_date date not null
    constraint accounts_payable_due_range check (due_date between date '2000-01-01' and date '2100-01-01'),
  status text not null default 'pending'
    constraint accounts_payable_status_check check (status in ('pending', 'paid', 'cancelled')),
  paid_amount numeric(12, 2) not null default 0
    constraint accounts_payable_paid_check check (paid_amount >= 0 and paid_amount <= amount),
  -- Data (informada) e forma do ÚLTIMO pagamento registrado.
  last_paid_on date,
  last_payment_method text
    constraint accounts_payable_method_check check (last_payment_method is null or last_payment_method in ('cash', 'pix', 'debit_card', 'credit_card', 'other')),
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete restrict,
  cancellation_reason text
    constraint accounts_payable_cancellation_reason_length check (cancellation_reason is null or char_length(cancellation_reason) between 1 and 200),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounts_payable_company_id_id_key unique (company_id, id),
  -- Coerência status x valores: paga = quitada; pendente = ainda com saldo (e só tem data/forma se já pagou
  -- alguma parte); cancelada = nunca pagou nada.
  constraint accounts_payable_state_check check (
    (status = 'paid' and paid_amount = amount and last_paid_on is not null and last_payment_method is not null)
    or (status = 'pending' and paid_amount < amount and ((paid_amount = 0) = (last_paid_on is null)))
    or (status = 'cancelled' and paid_amount = 0 and cancelled_at is not null)
  )
);

comment on table public.accounts_payable is
  'Contas a pagar manuais. Status persistido pending/paid/cancelled; atrasada/vence hoje são derivados do vencimento (America/Sao_Paulo). Escrita só por RPC. Não toca no Caixa.';
comment on column public.accounts_payable.paid_amount is
  'Total já pago (soma dos eventos payment). 0 <= paid_amount <= amount; paid_amount = amount <=> status paid.';

create table public.accounts_payable_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  payable_id uuid not null,
  event_type text not null
    constraint accounts_payable_events_type_check check (event_type in ('created', 'updated', 'payment', 'cancelled')),
  amount numeric(12, 2)
    constraint accounts_payable_events_amount_check check (amount is null or (amount > 0 and amount <> 'NaN'::numeric)),
  payment_method text
    constraint accounts_payable_events_method_check check (payment_method is null or payment_method in ('cash', 'pix', 'debit_card', 'credit_card', 'other')),
  -- Data do pagamento informada pelo usuário (dia civil de America/Sao_Paulo).
  paid_on date,
  note text
    constraint accounts_payable_events_note_length check (note is null or char_length(note) between 1 and 500),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint accounts_payable_events_payable_fkey
    foreign key (company_id, payable_id) references public.accounts_payable (company_id, id) on delete cascade,
  constraint accounts_payable_events_payment_check check (
    event_type <> 'payment' or (amount is not null and payment_method is not null and paid_on is not null)
  )
);

comment on table public.accounts_payable_events is
  'Trilha append-only das contas a pagar (created/updated/payment/cancelled). Pagamentos (payment) têm valor, forma e data.';

create trigger accounts_payable_set_updated_at
  before update on public.accounts_payable
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2) Índices (só os que as consultas usam)
-- ---------------------------------------------------------------------------
-- listagem/filtro por vencimento (todos os status)
create index accounts_payable_due_idx on public.accounts_payable (company_id, due_date);
-- filtro por status + vencimento (pendentes/atrasadas/pagas), cards e Dashboard futuro
create index accounts_payable_status_due_idx on public.accounts_payable (company_id, status, due_date);
-- último pagamento (consultas por data de pagamento da conta)
create index accounts_payable_last_paid_idx on public.accounts_payable (company_id, last_paid_on) where last_paid_on is not null;
-- "Pago no período" e filtro por data de pagamento (por evento, cobre pagamentos parciais)
create index accounts_payable_events_paid_idx on public.accounts_payable_events (company_id, paid_on) where event_type = 'payment';
-- histórico de uma conta
create index accounts_payable_events_payable_idx on public.accounts_payable_events (payable_id, created_at);

-- ---------------------------------------------------------------------------
-- 3) RLS e GRANTs: leitura só owner/admin; nenhuma escrita direta
-- ---------------------------------------------------------------------------
alter table public.accounts_payable enable row level security;
alter table public.accounts_payable_events enable row level security;

create policy accounts_payable_select on public.accounts_payable
  for select to authenticated
  using (public.user_role_in_company(company_id) in ('owner', 'admin'));

create policy accounts_payable_events_select on public.accounts_payable_events
  for select to authenticated
  using (public.user_role_in_company(company_id) in ('owner', 'admin'));

revoke all on public.accounts_payable from public, anon, authenticated;
grant select on public.accounts_payable to authenticated;
grant all on public.accounts_payable to service_role;

revoke all on public.accounts_payable_events from public, anon, authenticated;
grant select on public.accounts_payable_events to authenticated;
grant all on public.accounts_payable_events to service_role;

-- ---------------------------------------------------------------------------
-- 4) Helpers internos (sem EXECUTE para clientes)
-- ---------------------------------------------------------------------------
create function public.payables_today()
returns date
language sql
stable
set search_path = public
as $$
  select (now() at time zone 'America/Sao_Paulo')::date;
$$;

-- Rótulo da categoria (para a busca por texto).
create function public.payable_category_label(p_category text)
returns text
language sql
immutable
set search_path = public
as $$
  select case p_category
    when 'suppliers' then 'Fornecedores'
    when 'rent' then 'Aluguel'
    when 'energy' then 'Energia'
    when 'water' then 'Água'
    when 'internet_phone' then 'Internet/Telefone'
    when 'payroll' then 'Funcionários'
    when 'taxes' then 'Impostos'
    when 'maintenance' then 'Manutenção'
    when 'equipment' then 'Equipamentos'
    when 'marketing' then 'Marketing'
    when 'services' then 'Serviços'
    else 'Outros'
  end;
$$;

-- Autorização comum: sessão válida, membro ativo da empresa, owner/admin.
create function public.payables_assert_manager(p_company_id uuid)
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
    raise exception 'Você não tem permissão para contas a pagar.' using errcode = 'PT403';
  end if;
  return v_role;
end;
$$;

revoke execute on function public.payables_today() from public, anon, authenticated;
revoke execute on function public.payable_category_label(text) from public, anon, authenticated;
revoke execute on function public.payables_assert_manager(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5) RPCs de escrita
-- ---------------------------------------------------------------------------
create function public.create_payable(
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

-- Edita uma conta PENDENTE e SEM nenhum pagamento. Com pagamento parcial, nada estrutural muda (nem valor,
-- nem vencimento, nem fornecedor): a conta já tem histórico financeiro.
create function public.update_payable(
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

-- Registra um pagamento (total ou parcial) numa conta PENDENTE. Não mexe no Caixa.
create function public.register_payable_payment(
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

-- Cancela uma conta PENDENTE sem nenhum pagamento (nunca apaga). Com pagamento parcial, não cancela.
create function public.cancel_payable(p_payable_id uuid, p_reason text default null)
returns public.accounts_payable
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.accounts_payable;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
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

-- ---------------------------------------------------------------------------
-- 6) Leitura: lista filtrada/ordenada/paginada e resumo (cards; reaproveitável pelo Dashboard)
-- ---------------------------------------------------------------------------
-- p_status: all | pending (a vencer, inclui hoje) | due_today | overdue | paid | cancelled
-- p_date_field: due (vencimento) | paid (data de pagamento, dos eventos payment); p_from/p_to inclusivos
-- p_sort: due (vencimento mais próximo) | overdue (pendentes primeiro, as mais antigas antes) | amount | recent
-- Busca: fornecedor, descrição, referência, documento e categoria (rótulo); % e _ valem como texto.
create function public.list_payables(
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

-- Cards: a pagar (saldo das pendentes), vencendo hoje, atrasado e pago no período.
create function public.payables_summary(p_company_id uuid, p_from date, p_to date)
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

-- ---------------------------------------------------------------------------
-- 7) ACL das funções (só usuário logado; cada uma valida o papel por dentro)
-- ---------------------------------------------------------------------------
revoke execute on function public.create_payable(uuid, text, text, text, numeric, date, text, text, text) from public, anon;
grant execute on function public.create_payable(uuid, text, text, text, numeric, date, text, text, text) to authenticated;
revoke execute on function public.update_payable(uuid, text, text, text, numeric, date, text, text, text) from public, anon;
grant execute on function public.update_payable(uuid, text, text, text, numeric, date, text, text, text) to authenticated;
revoke execute on function public.register_payable_payment(uuid, numeric, text, date, text) from public, anon;
grant execute on function public.register_payable_payment(uuid, numeric, text, date, text) to authenticated;
revoke execute on function public.cancel_payable(uuid, text) from public, anon;
grant execute on function public.cancel_payable(uuid, text) to authenticated;
revoke execute on function public.list_payables(uuid, text, text, date, date, text, text, integer, integer) from public, anon;
grant execute on function public.list_payables(uuid, text, text, date, date, text, text, integer, integer) to authenticated;
revoke execute on function public.payables_summary(uuid, date, date) from public, anon;
grant execute on function public.payables_summary(uuid, date, date) to authenticated;

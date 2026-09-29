-- Módulo operacional — CAIXA, FECHAMENTO DE CONTA, PAGAMENTOS e MOVIMENTO FINANCEIRO (fundação).
-- Fora daqui, de propósito: impressão, contas a pagar/receber, DRE, conciliação, taxas de cartão,
-- sangria/suprimento, conferência física do caixa por forma de pagamento, desconto/gorjeta,
-- cancelamento de pedido/estorno.
-- Não altera nenhuma migration aplicada: soma colunas a service_sessions (ALTER TABLE), um trigger
-- em service_orders e um CREATE OR REPLACE que preserva assinatura e ACL de
-- company_user_has_activity().
--
--   1. cash_sessions: o CAIXA de um operador (abertura, valor inicial, fechamento).
--   2. service_payments: cada forma de pagamento aplicada a uma conta (service_session).
--   3. cash_movements: o livro financeiro mínimo; um movimento por pagamento (SALE).
--   4. service_sessions ganha closed_by e total_amount (rastreabilidade do fechamento).
--   5. RPCs: open_cash_session, close_cash_session, close_service_session.
--   6. Trigger em service_orders: pedido não entra em atendimento fechado (corrida com o fechamento).
--
-- Quem pode o quê:
--   abrir caixa / fechar a conta (RPCs)     owner, admin, cashier (ativos). attendant NUNCA.
--   fechar caixa (RPC)                      dono do caixa (owner/admin/cashier) ou owner/admin qualquer um
--   ler caixas, pagamentos e movimentos     owner/admin da empresa: tudo; cashier: só o(s) SEU(S) caixa(s)
--                                           (attendant não lê nada de financeiro)
--   escrever direto nas tabelas             ninguém pelo cliente: só as RPCs (SECURITY DEFINER)
--
-- Dinheiro é numeric(12,2) em REAIS (mesmo formato de products.sale_price / unit_price).
--
-- Regras do fechamento (close_service_session):
--   * o TOTAL é sempre recalculado no servidor: soma quantity * unit_price (snapshots gravados) dos
--     itens dos pedidos 'submitted' do atendimento. O cliente nunca envia total nem preço.
--   * a soma dos pagamentos (amount = valor APLICADO na conta) tem de ser IGUAL ao total: nem menos,
--     nem mais. Só dinheiro aceita amount_received maior que amount; a diferença é o troco
--     (change_amount) e NUNCA vira receita: o movimento financeiro usa amount.
--   * exige caixa aberto do PRÓPRIO operador (quando há valor a receber).
--   * conta sem nada a cobrar (total 0) pode ser fechada sem pagamentos e sem caixa.
--   * na MESMA transação: pagamentos, movimentos, fechamento do atendimento (closed_at, closed_by,
--     total_amount). Fechar o atendimento libera a comanda/mesa (o ponto só fica "em atendimento"
--     enquanto existe service_session 'open' nele). Pedidos e atendimento NUNCA são apagados.
--   * clique duplo/concorrência: o atendimento é travado (FOR UPDATE); a segunda chamada espera,
--     enxerga 'closed' e recebe PT409 sem gravar nada.
--   Ordem de locks: atendimento -> caixa (o fechamento de caixa só trava o caixa): sem deadlock.

-- ---------------------------------------------------------------------------
-- 1) Caixas
-- ---------------------------------------------------------------------------
create table public.cash_sessions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  -- RESTRICT: o histórico não some com a exclusão do usuário do Auth.
  opened_by uuid not null references auth.users(id) on delete restrict,
  opening_amount numeric(12, 2) not null default 0
    constraint cash_sessions_opening_amount_check check (opening_amount >= 0 and opening_amount <> 'NaN'::numeric),
  status text not null default 'open'
    constraint cash_sessions_status_check check (status in ('open', 'closed')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid references auth.users(id) on delete restrict,
  closing_notes text
    constraint cash_sessions_closing_notes_length check (closing_notes is null or char_length(closing_notes) between 1 and 500),
  created_at timestamptz not null default now(),
  constraint cash_sessions_closed_consistency check (
    (status = 'open' and closed_at is null and closed_by is null and closing_notes is null)
    or (status = 'closed' and closed_at is not null and closed_by is not null)
  ),
  -- alvo das chaves compostas de service_payments e cash_movements
  constraint cash_sessions_company_id_id_key unique (company_id, id)
);

-- UM caixa aberto por operador por empresa.
create unique index cash_sessions_one_open_per_operator
  on public.cash_sessions (company_id, opened_by)
  where status = 'open';

create index cash_sessions_company_opened_idx on public.cash_sessions (company_id, opened_at desc);
create index cash_sessions_opened_by_idx on public.cash_sessions (opened_by);
create index cash_sessions_closed_by_idx on public.cash_sessions (closed_by) where closed_by is not null;

-- Empresa, operador, horário de abertura e valor inicial não mudam; caixa fechado não reabre.
create function public.guard_cash_session_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is distinct from old.company_id
     or new.opened_by is distinct from old.opened_by
     or new.opened_at is distinct from old.opened_at
     or new.opening_amount is distinct from old.opening_amount then
    raise exception 'Os dados de abertura de um caixa não podem ser alterados.' using errcode = 'PT409';
  end if;
  if old.status = 'closed' then
    raise exception 'Um caixa fechado não pode ser alterado.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

create trigger cash_sessions_guard_change
  before update on public.cash_sessions
  for each row execute function public.guard_cash_session_change();

revoke execute on function public.guard_cash_session_change() from public, anon, authenticated;

alter table public.cash_sessions enable row level security;

create policy cash_sessions_select on public.cash_sessions
  for select to authenticated
  using (
    company_id in (select public.user_company_ids())
    and (
      public.user_role_in_company(company_id) in ('owner', 'admin')
      or (public.user_role_in_company(company_id) = 'cashier' and opened_by = auth.uid())
    )
  );

revoke all on public.cash_sessions from anon, authenticated;
grant select on public.cash_sessions to authenticated;
grant all on public.cash_sessions to service_role;

-- ---------------------------------------------------------------------------
-- 2) Estrutura nova em service_sessions: quem fechou e o total cobrado
-- ---------------------------------------------------------------------------
alter table public.service_sessions
  add column closed_by uuid references auth.users(id) on delete restrict,
  add column total_amount numeric(12, 2)
    constraint service_sessions_total_amount_check check (total_amount is null or (total_amount >= 0 and total_amount <> 'NaN'::numeric));

alter table public.service_sessions
  add constraint service_sessions_open_has_no_close_data check (
    status = 'closed' or (closed_by is null and total_amount is null)
  );

create index service_sessions_closed_by_idx on public.service_sessions (closed_by) where closed_by is not null;

comment on column public.service_sessions.total_amount is
  'Total da conta no fechamento (soma dos snapshots dos pedidos submitted), calculado no servidor por close_service_session().';

-- guard_service_session_change (020000) já cobre empresa/abertura; fechado não volta a abrir.
create function public.guard_service_session_reopen()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status = 'closed' and (new.status is distinct from old.status or new.closed_at is distinct from old.closed_at
     or new.closed_by is distinct from old.closed_by or new.total_amount is distinct from old.total_amount) then
    raise exception 'Um atendimento fechado não pode ser reaberto nem alterado.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

create trigger service_sessions_guard_reopen
  before update on public.service_sessions
  for each row execute function public.guard_service_session_reopen();

revoke execute on function public.guard_service_session_reopen() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) Pagamentos da conta
-- ---------------------------------------------------------------------------
create table public.service_payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  service_session_id uuid not null,
  cash_session_id uuid not null,
  payment_method text not null
    constraint service_payments_method_check check (payment_method in ('cash', 'pix', 'debit_card', 'credit_card', 'other')),
  -- Valor efetivamente APLICADO na conta (é o que vira receita).
  amount numeric(12, 2) not null
    constraint service_payments_amount_check check (amount > 0 and amount <> 'NaN'::numeric),
  -- Só dinheiro: quanto o cliente entregou e o troco devolvido.
  amount_received numeric(12, 2),
  change_amount numeric(12, 2) not null default 0,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint service_payments_cash_received_check check (
    (payment_method = 'cash' and amount_received is not null and amount_received >= amount
       and change_amount = amount_received - amount)
    or (payment_method <> 'cash' and amount_received is null and change_amount = 0)
  ),
  constraint service_payments_session_fkey
    foreign key (company_id, service_session_id) references public.service_sessions (company_id, id),
  constraint service_payments_cash_session_fkey
    foreign key (company_id, cash_session_id) references public.cash_sessions (company_id, id),
  constraint service_payments_company_id_id_key unique (company_id, id)
);

create index service_payments_session_idx on public.service_payments (company_id, service_session_id);
create index service_payments_cash_session_idx on public.service_payments (company_id, cash_session_id);
create index service_payments_created_by_idx on public.service_payments (created_by);

comment on column public.service_payments.amount is
  'Valor aplicado na conta (receita). Para dinheiro, NÃO inclui o troco.';
comment on column public.service_payments.amount_received is
  'Dinheiro: quanto o cliente entregou (>= amount). Demais formas: NULL.';

alter table public.service_payments enable row level security;

create policy service_payments_select on public.service_payments
  for select to authenticated
  using (
    company_id in (select public.user_company_ids())
    and cash_session_id in (select id from public.cash_sessions)  -- aplica a RLS de cash_sessions
  );

revoke all on public.service_payments from anon, authenticated;
grant select on public.service_payments to authenticated;
grant all on public.service_payments to service_role;

-- ---------------------------------------------------------------------------
-- 4) Movimentos do caixa (livro financeiro mínimo)
-- ---------------------------------------------------------------------------
create table public.cash_movements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  cash_session_id uuid not null,
  service_session_id uuid,
  service_payment_id uuid,
  -- Só 'sale' nesta etapa (sangria/suprimento/estorno entram depois ampliando o check).
  movement_type text not null
    constraint cash_movements_type_check check (movement_type in ('sale')),
  payment_method text not null
    constraint cash_movements_method_check check (payment_method in ('cash', 'pix', 'debit_card', 'credit_card', 'other')),
  amount numeric(12, 2) not null
    constraint cash_movements_amount_check check (amount > 0 and amount <> 'NaN'::numeric),
  description text not null
    constraint cash_movements_description_length check (char_length(description) between 1 and 200),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint cash_movements_cash_session_fkey
    foreign key (company_id, cash_session_id) references public.cash_sessions (company_id, id),
  constraint cash_movements_session_fkey
    foreign key (company_id, service_session_id) references public.service_sessions (company_id, id),
  constraint cash_movements_payment_fkey
    foreign key (company_id, service_payment_id) references public.service_payments (company_id, id)
);

create index cash_movements_cash_session_idx on public.cash_movements (company_id, cash_session_id, created_at);
create index cash_movements_service_session_idx on public.cash_movements (company_id, service_session_id)
  where service_session_id is not null;
create index cash_movements_payment_idx on public.cash_movements (company_id, service_payment_id)
  where service_payment_id is not null;
create index cash_movements_created_by_idx on public.cash_movements (created_by);

comment on table public.cash_movements is
  'Livro financeiro do caixa. Uma venda paga em N formas gera N movimentos SALE. amount é o valor aplicado; troco e valor recebido em dinheiro NUNCA entram aqui.';

alter table public.cash_movements enable row level security;

create policy cash_movements_select on public.cash_movements
  for select to authenticated
  using (
    company_id in (select public.user_company_ids())
    and cash_session_id in (select id from public.cash_sessions)
  );

revoke all on public.cash_movements from anon, authenticated;
grant select on public.cash_movements to authenticated;
grant all on public.cash_movements to service_role;

-- ---------------------------------------------------------------------------
-- 5) Pedido não entra em atendimento fechado (corrida com o fechamento da conta)
-- ---------------------------------------------------------------------------
-- submit_service_order confere status='open' sem travar; se o fechamento commitar entre a
-- conferência e o INSERT, o pedido ficaria numa conta já cobrada. Este trigger trava o
-- atendimento (FOR SHARE, que espera o FOR UPDATE do fechamento) e revalida.
create function public.guard_service_order_session_open()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_status text;
begin
  select status into v_status
  from public.service_sessions
  where id = new.service_session_id
  for share;

  if v_status is distinct from 'open' then
    raise exception 'Este atendimento não está aberto.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

create trigger service_orders_session_open
  before insert on public.service_orders
  for each row execute function public.guard_service_order_session_open();

revoke execute on function public.guard_service_order_session_open() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6) RPC: abrir caixa
-- ---------------------------------------------------------------------------
-- A empresa vem do vínculo do chamador (p_company_id só escolhe ENTRE as suas; quem não é
-- membro ativo recebe PT404). Erros: PT401 sem sessão, PT404, PT403 (attendant), PT400 valor
-- inválido, PT409 já existe caixa aberto deste operador.
create function public.open_cash_session(p_company_id uuid, p_opening_amount numeric default 0)
returns public.cash_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_amount numeric := coalesce(p_opening_amount, 0);
  v_cash public.cash_sessions;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier') then
    raise exception 'Você não tem permissão para abrir o caixa.' using errcode = 'PT403';
  end if;

  if v_amount < 0 or v_amount >= 10000000000 or v_amount <> round(v_amount, 2) then
    raise exception 'Informe um valor inicial válido (zero ou mais, com até 2 casas decimais).' using errcode = 'PT400';
  end if;

  begin
    insert into public.cash_sessions (company_id, opened_by, opening_amount, status)
    values (p_company_id, auth.uid(), v_amount, 'open')
    returning * into v_cash;
  exception
    when unique_violation then
      raise exception 'Você já tem um caixa aberto.' using errcode = 'PT409';
  end;

  return v_cash;
end;
$$;

revoke execute on function public.open_cash_session(uuid, numeric) from public, anon;
grant execute on function public.open_cash_session(uuid, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- 7) RPC: fechar caixa (fechamento simples: sem conferência física ainda)
-- ---------------------------------------------------------------------------
-- O dono do caixa fecha o seu; owner/admin fecham qualquer um da empresa. Depois de fechado, o
-- caixa não recebe mais vendas (close_service_session só usa caixa 'open').
create function public.close_cash_session(p_cash_session_id uuid, p_notes text default null)
returns public.cash_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cash public.cash_sessions;
  v_role public.company_role;
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_cash from public.cash_sessions where id = p_cash_session_id for update;
  if not found then
    raise exception 'Caixa não encontrado.' using errcode = 'PT404';
  end if;

  v_role := public.user_role_in_company(v_cash.company_id);
  if v_role is null or (v_role = 'cashier' and v_cash.opened_by <> auth.uid()) then
    raise exception 'Caixa não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier') then
    raise exception 'Você não tem permissão para fechar o caixa.' using errcode = 'PT403';
  end if;

  if v_cash.status <> 'open' then
    raise exception 'Este caixa já está fechado.' using errcode = 'PT409';
  end if;
  if v_notes is not null and char_length(v_notes) > 500 then
    raise exception 'A observação pode ter no máximo 500 caracteres.' using errcode = 'PT400';
  end if;

  update public.cash_sessions
     set status = 'closed', closed_at = now(), closed_by = auth.uid(), closing_notes = v_notes
   where id = v_cash.id
  returning * into v_cash;

  return v_cash;
end;
$$;

revoke execute on function public.close_cash_session(uuid, text) from public, anon;
grant execute on function public.close_cash_session(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8) RPC: receber e fechar a conta (atômico)
-- ---------------------------------------------------------------------------
-- p_payments (jsonb array): [{ "method": "cash|pix|debit_card|credit_card|other",
--                              "amount": numeric > 0 (valor APLICADO),
--                              "amount_received": numeric >= amount (SÓ dinheiro; omitido = amount) }]
-- Erros: PT401, PT404 (atendimento inexistente ou de outra empresa), PT403 (papel sem permissão,
-- ex.: attendant), PT409 atendimento já fechado, PT412 sem caixa aberto, PT400 pagamentos
-- inválidos/insuficientes/excedentes (a mensagem traz o total real).
create function public.close_service_session(p_service_session_id uuid, p_payments jsonb default '[]'::jsonb)
returns public.service_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.service_sessions;
  v_point public.service_points;
  v_role public.company_role;
  v_cash public.cash_sessions;
  v_total numeric(12, 2);
  v_paid numeric := 0;
  v_p jsonb;
  v_method text;
  v_amount numeric;
  v_received numeric;
  v_change numeric;
  v_payment public.service_payments;
  v_label text;
  v_fmt text;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  -- Trava o atendimento: cliques repetidos/concorrentes esperam aqui e enxergam 'closed'.
  select * into v_session from public.service_sessions where id = p_service_session_id for update;
  if not found then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;

  v_role := public.user_role_in_company(v_session.company_id);
  if v_role is null then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier') then
    raise exception 'Você não tem permissão para fechar contas.' using errcode = 'PT403';
  end if;

  if v_session.status <> 'open' then
    raise exception 'Este atendimento já foi fechado.' using errcode = 'PT409';
  end if;

  -- Total REAL, pelos snapshots persistidos (nunca do cliente).
  select coalesce(sum(i.quantity * i.unit_price), 0)::numeric(12, 2) into v_total
  from public.service_orders o
  join public.service_order_items i on i.company_id = o.company_id and i.order_id = o.id
  where o.company_id = v_session.company_id
    and o.service_session_id = v_session.id
    and o.status = 'submitted';

  v_fmt := 'R$ ' || replace(to_char(v_total, 'FM9999999990.00'), '.', ',');

  if p_payments is null or jsonb_typeof(p_payments) <> 'array' then
    raise exception 'Informe os pagamentos.' using errcode = 'PT400';
  end if;
  if jsonb_array_length(p_payments) > 20 then
    raise exception 'Informe no máximo 20 pagamentos.' using errcode = 'PT400';
  end if;

  if v_total = 0 then
    if jsonb_array_length(p_payments) > 0 then
      raise exception 'Esta conta não tem valor a receber (total %).', v_fmt using errcode = 'PT400';
    end if;
  else
    if jsonb_array_length(p_payments) = 0 then
      raise exception 'Informe o pagamento. Total da conta: %.', v_fmt using errcode = 'PT400';
    end if;

    -- Caixa ABERTO do próprio operador (travado contra o fechamento do caixa em paralelo).
    select * into v_cash
    from public.cash_sessions
    where company_id = v_session.company_id and opened_by = auth.uid() and status = 'open'
    for share;
    if not found then
      raise exception 'Abra o caixa antes de receber esta conta.' using errcode = 'PT412';
    end if;
  end if;

  select * into v_point from public.service_points
  where id = v_session.service_point_id and company_id = v_session.company_id;
  v_label := case when v_point.type = 'table' then 'Mesa ' else 'Comanda ' end || coalesce(v_point.code, '');

  -- Valida TODOS os pagamentos antes de gravar qualquer coisa.
  for v_p in select * from jsonb_array_elements(p_payments) loop
    if jsonb_typeof(v_p) <> 'object' then
      raise exception 'Pagamento inválido.' using errcode = 'PT400';
    end if;
    v_method := v_p ->> 'method';
    if v_method is null or v_method not in ('cash', 'pix', 'debit_card', 'credit_card', 'other') then
      raise exception 'Forma de pagamento inválida.' using errcode = 'PT400';
    end if;
    if jsonb_typeof(v_p -> 'amount') is distinct from 'number' then
      raise exception 'Valor do pagamento inválido.' using errcode = 'PT400';
    end if;
    v_amount := (v_p ->> 'amount')::numeric;
    if v_amount <= 0 or v_amount >= 10000000000 or v_amount <> round(v_amount, 2) then
      raise exception 'O valor de cada pagamento deve ser maior que zero, com até 2 casas decimais.' using errcode = 'PT400';
    end if;
    if v_p ? 'amount_received' and jsonb_typeof(v_p -> 'amount_received') not in ('number', 'null') then
      raise exception 'Valor recebido inválido.' using errcode = 'PT400';
    end if;
    if jsonb_typeof(v_p -> 'amount_received') = 'number' then
      v_received := (v_p ->> 'amount_received')::numeric;
      if v_method <> 'cash' then
        raise exception 'Só o pagamento em dinheiro tem valor recebido e troco.' using errcode = 'PT400';
      end if;
      if v_received < v_amount or v_received >= 10000000000 or v_received <> round(v_received, 2) then
        raise exception 'O valor recebido em dinheiro deve ser igual ou maior que o valor aplicado.' using errcode = 'PT400';
      end if;
    end if;
    v_paid := v_paid + v_amount;
  end loop;

  if v_paid < v_total then
    raise exception 'Pagamento insuficiente. Total da conta: %.', v_fmt using errcode = 'PT400';
  end if;
  if v_paid > v_total then
    raise exception 'Os pagamentos ultrapassam o total da conta (%).', v_fmt using errcode = 'PT400';
  end if;

  -- Grava pagamentos + movimentos (um por forma de pagamento).
  for v_p in select * from jsonb_array_elements(p_payments) loop
    v_method := v_p ->> 'method';
    v_amount := (v_p ->> 'amount')::numeric;
    if v_method = 'cash' then
      v_received := coalesce((v_p ->> 'amount_received')::numeric, v_amount);
      v_change := v_received - v_amount;
    else
      v_received := null;
      v_change := 0;
    end if;

    insert into public.service_payments (
      company_id, service_session_id, cash_session_id, payment_method, amount, amount_received, change_amount, created_by
    ) values (
      v_session.company_id, v_session.id, v_cash.id, v_method, v_amount, v_received, v_change, auth.uid()
    ) returning * into v_payment;

    insert into public.cash_movements (
      company_id, cash_session_id, service_session_id, service_payment_id,
      movement_type, payment_method, amount, description, created_by
    ) values (
      v_session.company_id, v_cash.id, v_session.id, v_payment.id,
      'sale', v_method, v_amount, 'Venda - ' || v_label, auth.uid()
    );
  end loop;

  update public.service_sessions
     set status = 'closed', closed_at = now(), closed_by = auth.uid(), total_amount = v_total
   where id = v_session.id
  returning * into v_session;

  return v_session;
end;
$$;

comment on function public.close_service_session(uuid, jsonb) is
  'Recebe e fecha a conta numa transação: total recalculado dos snapshots, pagamentos (divididos) somando exatamente o total, troco só em dinheiro, movimentos SALE por forma de pagamento, atendimento fechado (libera a comanda/mesa). Exige caixa aberto do operador.';

revoke execute on function public.close_service_session(uuid, jsonb) from public, anon;
grant execute on function public.close_service_session(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 9) Quem já operou caixa/recebeu não é excluído (só desativado)
-- ---------------------------------------------------------------------------
-- Mesma assinatura e ACL de 080000/020000/020000(orders): soma caixa e pagamentos às checagens.
create or replace function public.company_user_has_activity(p_company_id uuid, p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.service_sessions ss
    where ss.company_id = p_company_id and (ss.opened_by = p_user_id or ss.closed_by = p_user_id)
  ) then
    return true;
  end if;

  if exists (
    select 1 from public.service_orders so
    where so.company_id = p_company_id and so.created_by = p_user_id
  ) then
    return true;
  end if;

  if exists (
    select 1 from public.cash_sessions cs
    where cs.company_id = p_company_id and (cs.opened_by = p_user_id or cs.closed_by = p_user_id)
  ) then
    return true;
  end if;

  if exists (
    select 1 from public.service_payments sp
    where sp.company_id = p_company_id and sp.created_by = p_user_id
  ) then
    return true;
  end if;

  if exists (
    select 1 from public.cash_movements cm
    where cm.company_id = p_company_id and cm.created_by = p_user_id
  ) then
    return true;
  end if;

  return false;
end;
$$;

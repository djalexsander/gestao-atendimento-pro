-- CANCELAMENTO de itens (conta ABERTA) e ESTORNO financeiro (conta FECHADA).
--
-- São dois conceitos separados:
--   * CANCELAMENTO: antes do pagamento, sobre a quantidade de um item. Nunca apaga nada: o item
--     mantém quantity/preço/nome/setor/observação originais e ganha cancelled_quantity; cada
--     cancelamento gera UM evento append-only (service_order_item_cancellations) com motivo,
--     autor e horário. Quantidade cobrável = quantity - cancelled_quantity.
--   * ESTORNO: depois de fechada. A conta NÃO reabre e o total fechado NÃO muda; o estorno é um
--     evento financeiro (service_refunds) ligado ao PAGAMENTO original, mais um movimento
--     'refund' no caixa de quem estornou. Nada é apagado nem reduzido silenciosamente.
--
-- Partes:
--   1. service_order_items.cancelled_quantity (0..quantity) + trigger de guarda ajustado
--      (cancelled_quantity só aumenta; snapshots seguem imutáveis).
--   2. service_order_item_cancellations (eventos) e service_refunds (estornos): tabelas novas com
--      GRANT explícito, RLS de leitura e escrita SOMENTE pelas RPCs.
--   3. cash_movements aceita 'refund' (amount positivo; o sinal vem do tipo) só via RPC.
--   4. cash_session_physical_cash: dinheiro físico = inicial + vendas em dinheiro + suprimentos
--      - sangrias - ESTORNOS EM DINHEIRO (Pix/cartão/outros estornados não mexem na gaveta).
--      close_cash_session (mesma assinatura) já usa essa função.
--   5. cash_session_totals ganha refund_total; total_sold continua VENDA BRUTA ORIGINAL.
--   6. close_service_session: o total passa a usar a quantidade cobrável (server-side, como antes).
--   7. Produção (production_queue/production_history/update_production_item_status): usam a
--      quantidade cobrável; item zerado sai da fila; a fila devolve os cancelamentos recentes para
--      o KDS avisar a cozinha (Realtime já cobre: service_order_items está na publication).
--   8. RPCs: cancel_service_order_item e refund_service_payment.
--
-- Quem pode o quê:
--   cancelar item (conta aberta)   owner/admin: qualquer item; attendant/cashier: só item ainda
--                                  'pending' (item em produção: peça a um administrador);
--                                  production: nunca (cancelamento é comercial).
--   estornar pagamento             SOMENTE owner/admin, com caixa aberto PRÓPRIO.
--   escrever nas tabelas           ninguém pelo cliente: só as RPCs (SECURITY DEFINER).

-- ---------------------------------------------------------------------------
-- 1) Quantidade cancelada por item
-- ---------------------------------------------------------------------------
alter table public.service_order_items
  add column cancelled_quantity integer not null default 0
    constraint service_order_items_cancelled_quantity_check check (cancelled_quantity >= 0 and cancelled_quantity <= quantity);

alter table public.service_order_items
  add constraint service_order_items_company_id_id_key unique (company_id, id);

comment on column public.service_order_items.cancelled_quantity is
  'Quantidade já CANCELADA (0..quantity). quantity é a original e nunca muda; cobrável = quantity - cancelled_quantity. Só cancel_service_order_item() altera; nunca diminui.';

-- Mesma guarda da 20260930050000 (snapshots imutáveis, produção só avança) + cancelled_quantity
-- só aumenta.
create or replace function public.guard_service_order_item_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.id is distinct from old.id
     or new.company_id is distinct from old.company_id
     or new.order_id is distinct from old.order_id
     or new.product_id is distinct from old.product_id
     or new.product_name_snapshot is distinct from old.product_name_snapshot
     or new.quantity is distinct from old.quantity
     or new.unit_price is distinct from old.unit_price
     or new.production_sector_id is distinct from old.production_sector_id
     or new.notes is distinct from old.notes
     or new.created_at is distinct from old.created_at then
    raise exception 'Os dados de um item de pedido não podem ser alterados.' using errcode = 'PT409';
  end if;

  if new.cancelled_quantity < old.cancelled_quantity then
    raise exception 'Um cancelamento não pode ser desfeito.' using errcode = 'PT409';
  end if;

  if new.production_status is distinct from old.production_status
     and not (
       (old.production_status = 'pending' and new.production_status in ('preparing', 'ready'))
       or (old.production_status = 'preparing' and new.production_status = 'ready')
     ) then
    raise exception 'Este item não pode voltar para uma etapa anterior da produção.' using errcode = 'PT409';
  end if;

  return new;
end;
$$;

revoke execute on function public.guard_service_order_item_change() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2a) Eventos de cancelamento (append-only)
-- ---------------------------------------------------------------------------
create table public.service_order_item_cancellations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  service_order_item_id uuid not null,
  quantity integer not null
    constraint service_order_item_cancellations_quantity_check check (quantity > 0),
  reason text not null
    constraint service_order_item_cancellations_reason_length check (char_length(reason) between 1 and 200),
  -- RESTRICT: o histórico não some com a exclusão do usuário do Auth.
  cancelled_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint service_order_item_cancellations_item_fkey
    foreign key (company_id, service_order_item_id) references public.service_order_items (company_id, id)
);

create index service_order_item_cancellations_item_idx
  on public.service_order_item_cancellations (company_id, service_order_item_id);
create index service_order_item_cancellations_recent_idx
  on public.service_order_item_cancellations (company_id, created_at desc);
create index service_order_item_cancellations_by_idx
  on public.service_order_item_cancellations (cancelled_by);

comment on table public.service_order_item_cancellations is
  'Um evento por cancelamento de item (quantidade, motivo, quem, quando). Append-only: sem UPDATE/DELETE pelo cliente; só cancel_service_order_item() insere.';

alter table public.service_order_item_cancellations enable row level security;

-- Quem lê os pedidos da empresa lê o histórico de cancelamento (mesma regra de service_order_items).
create policy service_order_item_cancellations_select on public.service_order_item_cancellations
  for select to authenticated
  using (company_id in (select public.user_company_ids()));

revoke all on public.service_order_item_cancellations from anon, authenticated;
grant select on public.service_order_item_cancellations to authenticated;
grant all on public.service_order_item_cancellations to service_role;

-- ---------------------------------------------------------------------------
-- 2b) Estornos (financeiro, ligados ao pagamento original)
-- ---------------------------------------------------------------------------
create table public.service_refunds (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  service_session_id uuid not null,
  service_payment_id uuid not null,
  -- O caixa (aberto) de quem realizou o estorno: onde o movimento 'refund' foi lançado.
  cash_session_id uuid not null,
  amount numeric(12, 2) not null
    constraint service_refunds_amount_check check (amount > 0 and amount <> 'NaN'::numeric),
  reason text not null
    constraint service_refunds_reason_length check (char_length(reason) between 1 and 200),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint service_refunds_session_fkey
    foreign key (company_id, service_session_id) references public.service_sessions (company_id, id),
  constraint service_refunds_payment_fkey
    foreign key (company_id, service_payment_id) references public.service_payments (company_id, id),
  constraint service_refunds_cash_session_fkey
    foreign key (company_id, cash_session_id) references public.cash_sessions (company_id, id),
  constraint service_refunds_company_id_id_key unique (company_id, id)
);

create index service_refunds_payment_idx on public.service_refunds (company_id, service_payment_id);
create index service_refunds_cash_session_idx on public.service_refunds (company_id, cash_session_id);
create index service_refunds_session_idx on public.service_refunds (company_id, service_session_id);
create index service_refunds_created_by_idx on public.service_refunds (created_by);

comment on table public.service_refunds is
  'Estornos de pagamentos de contas FECHADAS. Um pagamento pode ter vários estornos parciais; a soma nunca passa do valor pago (refund_service_payment). A conta continua closed e service_payments/total_amount não mudam. Append-only.';

alter table public.service_refunds enable row level security;

-- Financeiro sensível: só owner/admin da empresa leem estornos.
create policy service_refunds_select on public.service_refunds
  for select to authenticated
  using (public.user_role_in_company(company_id) in ('owner', 'admin'));

revoke all on public.service_refunds from anon, authenticated;
grant select on public.service_refunds to authenticated;
grant all on public.service_refunds to service_role;

-- ---------------------------------------------------------------------------
-- 3) cash_movements: movimento 'refund'
-- ---------------------------------------------------------------------------
alter table public.cash_movements drop constraint cash_movements_type_check;
alter table public.cash_movements
  add constraint cash_movements_type_check check (movement_type in ('sale', 'supply', 'withdrawal', 'refund'));

alter table public.cash_movements drop constraint cash_movements_manual_check;
alter table public.cash_movements
  add constraint cash_movements_manual_check check (
    movement_type in ('sale', 'refund')
    or (payment_method = 'cash' and service_session_id is null and service_payment_id is null)
  );

alter table public.cash_movements
  add column service_refund_id uuid,
  add constraint cash_movements_refund_fkey
    foreign key (company_id, service_refund_id) references public.service_refunds (company_id, id),
  add constraint cash_movements_refund_link_check check (
    (movement_type = 'refund' and service_refund_id is not null and service_payment_id is not null)
    or (movement_type <> 'refund' and service_refund_id is null)
  );

create unique index cash_movements_refund_unique on public.cash_movements (service_refund_id)
  where service_refund_id is not null;

comment on table public.cash_movements is
  'Livro financeiro do caixa. sale: uma venda paga em N formas gera N movimentos (amount = valor aplicado; troco nunca entra). supply/withdrawal: manuais em dinheiro (add_cash_movement). refund: estorno de um pagamento (refund_service_payment), amount POSITIVO na forma do pagamento original; o sinal é do tipo.';

-- ---------------------------------------------------------------------------
-- 4) Dinheiro físico: estornos em dinheiro saem da gaveta
-- ---------------------------------------------------------------------------
create or replace function public.cash_session_physical_cash(p_cash_session_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select cs.opening_amount + coalesce((
    select sum(case cm.movement_type when 'withdrawal' then -cm.amount when 'refund' then -cm.amount else cm.amount end)
    from public.cash_movements cm
    where cm.company_id = cs.company_id
      and cm.cash_session_id = cs.id
      and cm.payment_method = 'cash'
      and cm.movement_type in ('sale', 'supply', 'withdrawal', 'refund')
  ), 0)
  from public.cash_sessions cs
  where cs.id = p_cash_session_id;
$$;

revoke execute on function public.cash_session_physical_cash(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5) View de totais: refund_total à parte (total_sold segue bruto)
-- ---------------------------------------------------------------------------
create or replace view public.cash_session_totals
with (security_invoker = true)
as
select
  cash_session_id,
  company_id,
  coalesce(sum(amount) filter (where movement_type = 'sale' and payment_method = 'cash'), 0)::numeric(12, 2) as cash_total,
  coalesce(sum(amount) filter (where movement_type = 'sale' and payment_method = 'pix'), 0)::numeric(12, 2) as pix_total,
  coalesce(sum(amount) filter (where movement_type = 'sale' and payment_method = 'debit_card'), 0)::numeric(12, 2) as debit_total,
  coalesce(sum(amount) filter (where movement_type = 'sale' and payment_method = 'credit_card'), 0)::numeric(12, 2) as credit_total,
  coalesce(sum(amount) filter (where movement_type = 'sale' and payment_method = 'other'), 0)::numeric(12, 2) as other_total,
  coalesce(sum(amount) filter (where movement_type = 'sale'), 0)::numeric(12, 2) as total_sold,
  coalesce(sum(amount) filter (where movement_type = 'supply'), 0)::numeric(12, 2) as supply_total,
  coalesce(sum(amount) filter (where movement_type = 'withdrawal'), 0)::numeric(12, 2) as withdrawal_total,
  coalesce(sum(amount) filter (where movement_type = 'refund'), 0)::numeric(12, 2) as refund_total
from public.cash_movements
group by cash_session_id, company_id;

revoke all on public.cash_session_totals from public, anon, authenticated;
grant select on public.cash_session_totals to authenticated;
grant all on public.cash_session_totals to service_role;


-- ---------------------------------------------------------------------------
-- 6) Total da conta sobre a quantidade cobrável (mesma assinatura, ACL e regras da 20260929040000)
-- ---------------------------------------------------------------------------
create or replace function public.close_service_session(p_service_session_id uuid, p_payments jsonb default '[]'::jsonb)
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

  -- Total REAL, pelos snapshots persistidos (nunca do cliente), sobre a quantidade COBRÁVEL
  -- (quantity - cancelled_quantity): item cancelado não entra na conta.
  select coalesce(sum((i.quantity - i.cancelled_quantity) * i.unit_price), 0)::numeric(12, 2) into v_total
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

revoke execute on function public.close_service_session(uuid, jsonb) from public, anon;
grant execute on function public.close_service_session(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 7) Produção: quantidade cobrável, item zerado fora da fila, aviso de cancelamento
-- ---------------------------------------------------------------------------
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

revoke execute on function public.update_production_item_status(uuid, text) from public, anon;
grant execute on function public.update_production_item_status(uuid, text) to authenticated;

create or replace function public.production_queue(
  p_company_id uuid,
  p_sector_id uuid default null,
  p_ready_limit integer default 15
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_limit integer := least(greatest(coalesce(p_ready_limit, 15), 0), 500);
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_start timestamptz := (v_today::timestamp) at time zone 'America/Sao_Paulo';
  v_active jsonb;
  v_ready jsonb;
  v_cancel jsonb;
  v_ready_total integer;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'production') then
    raise exception 'Você não tem permissão para ver a produção.' using errcode = 'PT403';
  end if;

  -- Pendentes e em preparo: todos (de qualquer dia), mais antigos primeiro.
  select coalesce(jsonb_agg(q.item order by q.submitted_at, q.item_created_at), '[]'::jsonb)
    into v_active
  from (
    select
      o.submitted_at,
      i.created_at as item_created_at,
      jsonb_build_object(
        'id', i.id,
        'order_id', i.order_id,
        'quantity', i.quantity - i.cancelled_quantity,
        'cancelled_quantity', i.cancelled_quantity,
        'name', i.product_name_snapshot,
        'notes', i.notes,
        'sector_id', i.production_sector_id,
        'sector_name', s.name,
        'status', i.production_status,
        'started_at', i.production_started_at,
        'ready_at', i.production_ready_at,
        'submitted_at', o.submitted_at,
        'submitted_date', (o.submitted_at at time zone 'America/Sao_Paulo')::date,
        'point_type', sp.type,
        'point_code', sp.code,
        'point_name', sp.display_name,
        'customer_name', ss.customer_name,
        'sent_by_name', pr.full_name
      ) as item
    from public.service_order_items i
    join public.service_orders o on o.company_id = i.company_id and o.id = i.order_id
    join public.service_sessions ss on ss.company_id = o.company_id and ss.id = o.service_session_id
    join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
    left join public.production_sectors s on s.company_id = i.company_id and s.id = i.production_sector_id
    left join public.profiles pr on pr.user_id = o.created_by
    where i.company_id = p_company_id
      and o.status = 'submitted'
      and i.quantity > i.cancelled_quantity
      and i.production_status <> 'ready'
      and (p_sector_id is null or i.production_sector_id = p_sector_id)
    order by o.submitted_at, i.created_at
    limit 500
  ) q;

  -- Prontos de HOJE: total do dia + os v_limit mais recentes.
  select count(*)::integer into v_ready_total
  from public.service_order_items i
  join public.service_orders o on o.company_id = i.company_id and o.id = i.order_id
  where i.company_id = p_company_id
    and o.status = 'submitted'
      and i.quantity > i.cancelled_quantity
    and i.production_status = 'ready'
    and i.production_ready_at >= v_start
    and (p_sector_id is null or i.production_sector_id = p_sector_id);

  select coalesce(jsonb_agg(q.item order by q.ready_at desc), '[]'::jsonb)
    into v_ready
  from (
    select
      i.production_ready_at as ready_at,
      jsonb_build_object(
        'id', i.id,
        'order_id', i.order_id,
        'quantity', i.quantity - i.cancelled_quantity,
        'cancelled_quantity', i.cancelled_quantity,
        'name', i.product_name_snapshot,
        'notes', i.notes,
        'sector_id', i.production_sector_id,
        'sector_name', s.name,
        'status', i.production_status,
        'started_at', i.production_started_at,
        'ready_at', i.production_ready_at,
        'submitted_at', o.submitted_at,
        'submitted_date', (o.submitted_at at time zone 'America/Sao_Paulo')::date,
        'point_type', sp.type,
        'point_code', sp.code,
        'point_name', sp.display_name,
        'customer_name', ss.customer_name,
        'sent_by_name', pr.full_name
      ) as item
    from public.service_order_items i
    join public.service_orders o on o.company_id = i.company_id and o.id = i.order_id
    join public.service_sessions ss on ss.company_id = o.company_id and ss.id = o.service_session_id
    join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
    left join public.production_sectors s on s.company_id = i.company_id and s.id = i.production_sector_id
    left join public.profiles pr on pr.user_id = o.created_by
    where i.company_id = p_company_id
      and o.status = 'submitted'
      and i.quantity > i.cancelled_quantity
      and i.production_status = 'ready'
      and i.production_ready_at >= v_start
      and (p_sector_id is null or i.production_sector_id = p_sector_id)
    order by i.production_ready_at desc
    limit v_limit
  ) q;

  -- Cancelamentos recentes (15 min) dos itens do filtro: o KDS avisa a cozinha (o item zerado some da
  -- fila, então o aviso vem do evento, não da lista).
  select coalesce(jsonb_agg(c.e order by c.created_at desc), '[]'::jsonb)
    into v_cancel
  from (
    select
      x.created_at,
      jsonb_build_object(
        'id', x.id,
        'quantity', x.quantity,
        'name', i.product_name_snapshot,
        'point_type', sp.type,
        'point_code', sp.code,
        'reason', x.reason,
        'created_at', x.created_at
      ) as e
    from public.service_order_item_cancellations x
    join public.service_order_items i on i.company_id = x.company_id and i.id = x.service_order_item_id
    join public.service_orders o on o.company_id = i.company_id and o.id = i.order_id
    join public.service_sessions ss on ss.company_id = o.company_id and ss.id = o.service_session_id
    join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
    where x.company_id = p_company_id
      and x.created_at >= now() - interval '15 minutes'
      and (p_sector_id is null or i.production_sector_id = p_sector_id)
    order by x.created_at desc
    limit 20
  ) c;

  return jsonb_build_object(
    'cancellations', v_cancel,
    'today', v_today,
    'ready_total', v_ready_total,
    'items', v_active || v_ready
  );
end;
$$;

revoke execute on function public.production_queue(uuid, uuid, integer) from public, anon;
grant execute on function public.production_queue(uuid, uuid, integer) to authenticated;

create or replace function public.production_history(
  p_company_id uuid,
  p_date date default null,
  p_sector_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_day date := coalesce(p_date, (now() at time zone 'America/Sao_Paulo')::date);
  v_start timestamptz;
  v_end timestamptz;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'production') then
    raise exception 'Você não tem permissão para ver a produção.' using errcode = 'PT403';
  end if;

  if v_day < date '2000-01-01' or v_day > date '2100-01-01' then
    raise exception 'Data inválida.' using errcode = 'PT400';
  end if;

  v_start := (v_day::timestamp) at time zone 'America/Sao_Paulo';
  v_end := ((v_day + 1)::timestamp) at time zone 'America/Sao_Paulo';

  with base as (
    select
      i.id,
      i.order_id,
      i.quantity - i.cancelled_quantity as quantity,
      i.product_name_snapshot as name,
      i.notes,
      i.production_sector_id as sector_id,
      s.name as sector_name,
      i.production_started_at as started_at,
      i.production_ready_at as ready_at,
      o.submitted_at,
      sp.type as point_type,
      sp.code as point_code,
      sp.display_name as point_name,
      ss.customer_name,
      pr.full_name as sent_by_name,
      round(extract(epoch from (i.production_ready_at - o.submitted_at)) / 60)::integer as minutes
    from public.service_order_items i
    join public.service_orders o on o.company_id = i.company_id and o.id = i.order_id
    join public.service_sessions ss on ss.company_id = o.company_id and ss.id = o.service_session_id
    join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
    left join public.production_sectors s on s.company_id = i.company_id and s.id = i.production_sector_id
    left join public.profiles pr on pr.user_id = o.created_by
    where i.company_id = p_company_id
      and o.status = 'submitted'
      and i.quantity > i.cancelled_quantity
      and i.production_status = 'ready'
      and i.production_ready_at >= v_start
      and i.production_ready_at < v_end
      and (p_sector_id is null or i.production_sector_id = p_sector_id)
  )
  select jsonb_build_object(
    'date', v_day,
    'items', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.ready_at desc), '[]'::jsonb)
      from (select * from base order by ready_at desc limit 500) x
    ),
    'summary', jsonb_build_object(
      'items', (select count(*) from base),
      'orders', (select count(distinct order_id) from base),
      'avg_minutes', (select round(avg(minutes)) from base),
      'by_sector', (
        select coalesce(jsonb_agg(b order by b.items desc, b.name), '[]'::jsonb)
        from (
          select sector_id, coalesce(sector_name, 'Sem setor') as name, count(*)::integer as items
          from base
          group by sector_id, sector_name
        ) b
      )
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.production_history(uuid, date, uuid) from public, anon;
grant execute on function public.production_history(uuid, date, uuid) to authenticated;

-- Quem já cancelou item ou estornou não é excluído (só desativado).
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

  if exists (
    select 1 from public.service_order_items soi
    where soi.company_id = p_company_id and soi.production_updated_by = p_user_id
  ) then
    return true;
  end if;

  if exists (
    select 1 from public.service_order_item_cancellations c
    where c.company_id = p_company_id and c.cancelled_by = p_user_id
  ) then
    return true;
  end if;

  if exists (
    select 1 from public.service_refunds r
    where r.company_id = p_company_id and r.created_by = p_user_id
  ) then
    return true;
  end if;

  return false;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8a) RPC: cancelar item (conta ABERTA)
-- ---------------------------------------------------------------------------
-- Cancela p_quantity unidades do item (parcial ou o resto). Nunca apaga: soma em
-- cancelled_quantity e grava um evento com motivo/autor. Se TODOS os itens do pedido ficarem sem
-- quantidade cobrável, o pedido vira 'cancelled' (cancelled_at).
-- Locks (ordem: atendimento -> item, a mesma de close_service_session): duas chamadas simultâneas
-- serializam e a segunda enxerga a quantidade já reduzida, então cancelled_quantity nunca passa
-- de quantity.
-- Erros: PT401, PT404 (item inexistente/de outra empresa/sem vínculo ativo), PT403 (papel sem
-- acesso; attendant/cashier em item que já entrou em produção), PT409 (conta fechada: use estorno;
-- pedido/item já cancelado), PT400 (quantidade/motivo inválidos).
create function public.cancel_service_order_item(
  p_item_id uuid,
  p_quantity integer,
  p_reason text
)
returns public.service_order_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.service_order_items;
  v_order_status text;
  v_session public.service_sessions;
  v_role public.company_role;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_active integer;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  -- Leitura sem trava só para achar o atendimento; tudo é revalidado depois das travas.
  select * into v_item from public.service_order_items where id = p_item_id;
  if not found then
    raise exception 'Item não encontrado.' using errcode = 'PT404';
  end if;

  select ss.* into v_session
  from public.service_orders o
  join public.service_sessions ss on ss.company_id = o.company_id and ss.id = o.service_session_id
  where o.company_id = v_item.company_id and o.id = v_item.order_id
  for update of ss;
  if not found then
    raise exception 'Item não encontrado.' using errcode = 'PT404';
  end if;

  v_role := public.user_role_in_company(v_session.company_id);
  if v_role is null then
    raise exception 'Item não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier', 'attendant') then
    raise exception 'Você não tem permissão para cancelar itens.' using errcode = 'PT403';
  end if;

  if v_session.status <> 'open' then
    raise exception 'Esta conta já foi fechada. Utilize um estorno.' using errcode = 'PT409';
  end if;

  select * into v_item from public.service_order_items where id = p_item_id for update;

  select status into v_order_status
  from public.service_orders
  where company_id = v_item.company_id and id = v_item.order_id;
  if v_order_status is distinct from 'submitted' then
    raise exception 'Este pedido já foi cancelado.' using errcode = 'PT409';
  end if;

  v_active := v_item.quantity - v_item.cancelled_quantity;
  if v_active <= 0 then
    raise exception 'Este item já foi totalmente cancelado.' using errcode = 'PT409';
  end if;

  if v_role in ('cashier', 'attendant') and v_item.production_status <> 'pending' then
    raise exception 'Este item já entrou em produção. Solicite o cancelamento a um administrador.' using errcode = 'PT403';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Informe a quantidade a cancelar (número inteiro maior que zero).' using errcode = 'PT400';
  end if;
  if p_quantity > v_active then
    raise exception 'A quantidade a cancelar é maior que a disponível (%).', v_active using errcode = 'PT400';
  end if;
  if v_reason is null then
    raise exception 'Informe o motivo do cancelamento.' using errcode = 'PT400';
  end if;
  if char_length(v_reason) > 200 then
    raise exception 'O motivo pode ter no máximo 200 caracteres.' using errcode = 'PT400';
  end if;

  update public.service_order_items
     set cancelled_quantity = cancelled_quantity + p_quantity
   where id = v_item.id
  returning * into v_item;

  insert into public.service_order_item_cancellations (company_id, service_order_item_id, quantity, reason, cancelled_by)
  values (v_item.company_id, v_item.id, p_quantity, v_reason, auth.uid());

  -- Pedido sem nenhuma unidade cobrável: cancelado por inteiro.
  if not exists (
    select 1 from public.service_order_items i
    where i.company_id = v_item.company_id and i.order_id = v_item.order_id
      and i.cancelled_quantity < i.quantity
  ) then
    update public.service_orders
       set status = 'cancelled', cancelled_at = now()
     where company_id = v_item.company_id and id = v_item.order_id;
  end if;

  return v_item;
end;
$$;

comment on function public.cancel_service_order_item(uuid, integer, text) is
  'Cancela quantidade de um item de conta ABERTA (nunca apaga; evento auditável). owner/admin: qualquer item; attendant/cashier: só pending; production: nunca. Conta fechada: use estorno.';

revoke execute on function public.cancel_service_order_item(uuid, integer, text) from public, anon;
grant execute on function public.cancel_service_order_item(uuid, integer, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8b) RPC: estornar pagamento (conta FECHADA)
-- ---------------------------------------------------------------------------
-- Só owner/admin, com caixa aberto PRÓPRIO (o movimento 'refund' entra nesse caixa, na forma do
-- pagamento original). O pagamento é travado (FOR UPDATE): dois estornos simultâneos serializam e
-- a soma nunca passa do valor pago. Estorno em DINHEIRO também não pode passar do dinheiro
-- disponível na gaveta do caixa de quem estorna (senão o esperado ficaria negativo).
-- Erros: PT401, PT404, PT403 (papel), PT409 (conta não fechada), PT412 sem caixa aberto,
-- PT400 (valor/motivo inválidos, acima do estornável ou dinheiro insuficiente).
create function public.refund_service_payment(
  p_service_payment_id uuid,
  p_amount numeric,
  p_reason text
)
returns public.service_refunds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pay public.service_payments;
  v_status text;
  v_role public.company_role;
  v_cash public.cash_sessions;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_refunded numeric(12, 2);
  v_available numeric(12, 2);
  v_point public.service_points;
  v_label text;
  v_refund public.service_refunds;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_pay from public.service_payments where id = p_service_payment_id for update;
  if not found then
    raise exception 'Pagamento não encontrado.' using errcode = 'PT404';
  end if;

  v_role := public.user_role_in_company(v_pay.company_id);
  if v_role is null then
    raise exception 'Pagamento não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Somente o dono ou um administrador pode estornar pagamentos.' using errcode = 'PT403';
  end if;

  select ss.status into v_status
  from public.service_sessions ss
  where ss.company_id = v_pay.company_id and ss.id = v_pay.service_session_id;
  if v_status is distinct from 'closed' then
    raise exception 'Só é possível estornar pagamentos de contas fechadas.' using errcode = 'PT409';
  end if;
  select sp.* into v_point
  from public.service_sessions ss
  join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
  where ss.company_id = v_pay.company_id and ss.id = v_pay.service_session_id;
  v_label := case when v_point.type = 'table' then 'Mesa ' else 'Comanda ' end || coalesce(v_point.code, '');

  if p_amount is null or p_amount <= 0 or p_amount >= 10000000000 or p_amount <> round(p_amount, 2) then
    raise exception 'Informe um valor maior que zero, com até 2 casas decimais.' using errcode = 'PT400';
  end if;
  if v_reason is null then
    raise exception 'Informe o motivo do estorno.' using errcode = 'PT400';
  end if;
  if char_length(v_reason) > 200 then
    raise exception 'O motivo pode ter no máximo 200 caracteres.' using errcode = 'PT400';
  end if;

  select * into v_cash
  from public.cash_sessions
  where company_id = v_pay.company_id and opened_by = auth.uid() and status = 'open'
  for update;
  if not found then
    raise exception 'Abra seu caixa antes de realizar o estorno.' using errcode = 'PT412';
  end if;

  select coalesce(sum(amount), 0) into v_refunded
  from public.service_refunds
  where company_id = v_pay.company_id and service_payment_id = v_pay.id;

  v_available := v_pay.amount - v_refunded;
  if p_amount > v_available then
    raise exception 'Valor do estorno maior que o disponível para estorno (R$ %).',
      replace(to_char(v_available, 'FM9999999990.00'), '.', ',') using errcode = 'PT400';
  end if;

  if v_pay.payment_method = 'cash' and p_amount > public.cash_session_physical_cash(v_cash.id) then
    raise exception 'Dinheiro insuficiente no caixa para este estorno. Faça um suprimento antes.' using errcode = 'PT400';
  end if;

  insert into public.service_refunds (
    company_id, service_session_id, service_payment_id, cash_session_id, amount, reason, created_by
  ) values (
    v_pay.company_id, v_pay.service_session_id, v_pay.id, v_cash.id, p_amount, v_reason, auth.uid()
  ) returning * into v_refund;

  insert into public.cash_movements (
    company_id, cash_session_id, service_session_id, service_payment_id, service_refund_id,
    movement_type, payment_method, amount, description, created_by
  ) values (
    v_pay.company_id, v_cash.id, v_pay.service_session_id, v_pay.id, v_refund.id,
    'refund', v_pay.payment_method, p_amount, 'Estorno - ' || v_label, auth.uid()
  );

  return v_refund;
end;
$$;

comment on function public.refund_service_payment(uuid, numeric, text) is
  'Estorna (parcial ou total) um pagamento de conta FECHADA: evento em service_refunds + movimento refund no caixa aberto de quem estorna. Só owner/admin; a soma dos estornos nunca passa do valor pago; dinheiro sai da gaveta. A conta e o pagamento originais não mudam.';

revoke execute on function public.refund_service_payment(uuid, numeric, text) from public, anon;
grant execute on function public.refund_service_payment(uuid, numeric, text) to authenticated;

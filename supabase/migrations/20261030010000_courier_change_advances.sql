-- Delivery — CONTROLE DE TROCO DO ENTREGADOR (adiantamento de troco, acerto com dinheiro bruto, diferenças rastreáveis).
-- ADITIVA: nenhuma migration publicada é editada. Pedidos sem troco/adiantamento seguem exatamente como antes.
--
-- Regra operacional: pedido em dinheiro com troco (ex.: R$ 52, cliente paga R$ 100) => o Caixa adianta o troco (R$ 48) ao entregador
-- antes da saída; o entregador devolve ao Caixa o dinheiro BRUTO (R$ 100) no acerto; a venda contabilizada é a do pedido (R$ 52).
--
-- Livro do caixa (dinheiro FÍSICO efetivo; nunca valor fictício):
--   courier_change_advance        saída   adiantamento entregue ao entregador (NÃO é despesa/sangria)
--   courier_change_return         entrada dinheiro que voltou (devolução do adiantamento, sobra, regularização de diferença)
--   courier_settlement_shortfall  saída   quando o dinheiro contado é MENOR que a parte em dinheiro da venda já lançada
--   Exemplo: adiantamento -48; acerto: venda +52 (núcleo oficial) + devolução +48 => líquido +52 = físico (-48 + 100).
--   Devolução de só R$ 90: venda +52 + devolução +38 => líquido +42 = físico (-48 + 90). A falta de R$ 10 fica como PENDÊNCIA
--   rastreável (delivery_courier_cash_lines.shortfall_open) até ser regularizada (dinheiro recebido) ou baixada por owner/admin com motivo.
--
-- Esperado na devolução de um pedido = parte em dinheiro da venda (se o recebimento foi em dinheiro) + adiantamento em aberto.
-- Acerto com adiantamento só pelo RPC novo settle_courier_cash; o RPC antigo (4 argumentos, app 1.0.11) segue valendo para pedidos
-- SEM adiantamento e RECUSA os que têm (nunca assume um valor).
--
-- As funções vigentes são ajustadas por substituição EXATA de trecho (pg_get_functiondef), com contagem conferida.

-- ---------------------------------------------------------------------------
-- 1) Eventos de auditoria do pedido
-- ---------------------------------------------------------------------------
alter table public.delivery_order_events drop constraint delivery_order_events_type_check;
alter table public.delivery_order_events add constraint delivery_order_events_type_check
  check (event_type in ('created', 'status_changed', 'courier_assigned', 'fee_overridden', 'canceled', 'payment_received',
                        'courier_payment_received', 'courier_payment_voided', 'courier_settlement_completed',
                        'change_advance_given', 'change_advance_returned', 'change_difference_resolved'));

-- ---------------------------------------------------------------------------
-- 2) Adiantamentos de troco
-- ---------------------------------------------------------------------------
create table public.delivery_courier_advances (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  delivery_order_id uuid not null,
  courier_user_id uuid not null references auth.users(id) on delete restrict,
  -- caixa de ORIGEM (de onde o dinheiro saiu)
  cash_session_id uuid not null,
  amount numeric(12, 2) not null
    constraint delivery_courier_advances_amount_check check (amount > 0 and amount < 100000 and amount <> 'NaN'::numeric),
  status text not null default 'open'
    constraint delivery_courier_advances_status_check check (status in ('open', 'settled', 'returned')),
  client_request_id uuid not null,
  note text constraint delivery_courier_advances_note_length check (note is null or char_length(note) between 1 and 120),
  given_by uuid not null references auth.users(id) on delete restrict,
  given_at timestamptz not null default now(),
  -- como foi encerrado: linha de acerto/devolução (delivery_courier_cash_lines) e quando
  line_id uuid,
  closed_at timestamptz,
  return_request_id uuid,
  created_at timestamptz not null default now(),
  constraint delivery_courier_advances_state_check check (
    (status = 'open' and closed_at is null and line_id is null)
    or (status <> 'open' and closed_at is not null and line_id is not null)
  ),
  constraint delivery_courier_advances_order_fkey foreign key (company_id, delivery_order_id) references public.delivery_orders (company_id, id),
  constraint delivery_courier_advances_cash_fkey foreign key (company_id, cash_session_id) references public.cash_sessions (company_id, id),
  constraint delivery_courier_advances_request_key unique (company_id, client_request_id),
  constraint delivery_courier_advances_company_id_id_key unique (company_id, id)
);
-- no máximo UM adiantamento vivo (aberto ou já acertado) por pedido; devolvido (entrega não realizada) libera um novo
create unique index delivery_courier_advances_one_live_idx on public.delivery_courier_advances (company_id, delivery_order_id) where status in ('open', 'settled');
create index delivery_courier_advances_open_idx on public.delivery_courier_advances (company_id, courier_user_id) where status = 'open';
create index delivery_courier_advances_cash_idx on public.delivery_courier_advances (company_id, cash_session_id);

create function public.guard_courier_advance_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then
      return old;
    end if;
    raise exception 'Adiantamentos de troco não podem ser apagados.' using errcode = 'PT409';
  end if;
  if new.company_id is distinct from old.company_id or new.delivery_order_id is distinct from old.delivery_order_id
     or new.courier_user_id is distinct from old.courier_user_id or new.cash_session_id is distinct from old.cash_session_id
     or new.amount is distinct from old.amount or new.client_request_id is distinct from old.client_request_id
     or new.note is distinct from old.note or new.given_by is distinct from old.given_by
     or new.given_at is distinct from old.given_at or new.created_at is distinct from old.created_at then
    raise exception 'O adiantamento de troco não pode ser alterado.' using errcode = 'PT409';
  end if;
  if old.status <> 'open' and (new.status is distinct from old.status or new.line_id is distinct from old.line_id
                               or new.closed_at is distinct from old.closed_at or new.return_request_id is distinct from old.return_request_id) then
    raise exception 'Este adiantamento já foi encerrado (%).', old.status using errcode = 'PT409';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_courier_advance_change() from public, anon, authenticated, service_role;
create trigger delivery_courier_advances_guard before update or delete on public.delivery_courier_advances
  for each row execute function public.guard_courier_advance_change();

-- ---------------------------------------------------------------------------
-- 3) Linhas de dinheiro do acerto / devolução (valores brutos e líquidos separados; pendência de diferença)
-- ---------------------------------------------------------------------------
create table public.delivery_courier_cash_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  kind text not null
    constraint delivery_courier_cash_lines_kind_check check (kind in ('settlement', 'advance_return')),
  delivery_order_id uuid not null,
  courier_user_id uuid not null references auth.users(id) on delete restrict,
  advance_id uuid,
  receipt_id uuid,
  settlement_id uuid,
  -- caixa que RECEBEU o dinheiro (pode ser outro que o de origem do adiantamento)
  cash_session_id uuid not null,
  -- parte em dinheiro da venda (líquido do pedido), adiantamento, esperado = soma, contado e diferença = esperado - contado
  sale_cash numeric(12, 2) not null constraint delivery_courier_cash_lines_sale_check check (sale_cash >= 0),
  advance_amount numeric(12, 2) not null constraint delivery_courier_cash_lines_adv_check check (advance_amount >= 0),
  expected_amount numeric(12, 2) not null,
  counted_amount numeric(12, 2) not null constraint delivery_courier_cash_lines_counted_check check (counted_amount >= 0 and counted_amount < 100000000),
  difference numeric(12, 2) not null,
  reason text constraint delivery_courier_cash_lines_reason_length check (reason is null or char_length(reason) between 1 and 200),
  -- pendência: falta ainda não regularizada
  shortfall_open numeric(12, 2) not null default 0 constraint delivery_courier_cash_lines_open_check check (shortfall_open >= 0),
  shortfall_status text not null default 'none'
    constraint delivery_courier_cash_lines_status_check check (shortfall_status in ('none', 'open', 'resolved', 'written_off')),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint delivery_courier_cash_lines_math_check check (
    expected_amount = sale_cash + advance_amount and difference = expected_amount - counted_amount
  ),
  constraint delivery_courier_cash_lines_reason_check check (difference = 0 or reason is not null),
  constraint delivery_courier_cash_lines_shortfall_check check (
    (shortfall_status = 'none' and shortfall_open = 0 and difference <= 0)
    or (shortfall_status = 'open' and shortfall_open > 0 and shortfall_open <= difference)
    or (shortfall_status in ('resolved', 'written_off') and shortfall_open = 0 and difference > 0)
  ),
  constraint delivery_courier_cash_lines_kind_shape_check check (
    (kind = 'settlement' and receipt_id is not null)
    or (kind = 'advance_return' and advance_id is not null and receipt_id is null and settlement_id is null)
  ),
  constraint delivery_courier_cash_lines_order_fkey foreign key (company_id, delivery_order_id) references public.delivery_orders (company_id, id),
  constraint delivery_courier_cash_lines_advance_fkey foreign key (company_id, advance_id) references public.delivery_courier_advances (company_id, id),
  constraint delivery_courier_cash_lines_receipt_fkey foreign key (company_id, receipt_id) references public.delivery_courier_receipts (company_id, id),
  constraint delivery_courier_cash_lines_settlement_fkey foreign key (company_id, settlement_id) references public.delivery_courier_settlements (company_id, id),
  constraint delivery_courier_cash_lines_cash_fkey foreign key (company_id, cash_session_id) references public.cash_sessions (company_id, id),
  constraint delivery_courier_cash_lines_company_id_id_key unique (company_id, id)
);
create unique index delivery_courier_cash_lines_receipt_idx on public.delivery_courier_cash_lines (company_id, receipt_id) where receipt_id is not null;
create unique index delivery_courier_cash_lines_advance_idx on public.delivery_courier_cash_lines (company_id, advance_id) where advance_id is not null;
create index delivery_courier_cash_lines_open_idx on public.delivery_courier_cash_lines (company_id, courier_user_id) where shortfall_status = 'open';

create function public.guard_courier_cash_line_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then
      return old;
    end if;
    raise exception 'Linhas de acerto de troco não podem ser apagadas.' using errcode = 'PT409';
  end if;
  -- só a pendência evolui (open -> menor / resolved / written_off); nunca aumenta nem reabre
  if (to_jsonb(new) - 'shortfall_open' - 'shortfall_status' - 'settlement_id') is distinct from (to_jsonb(old) - 'shortfall_open' - 'shortfall_status' - 'settlement_id') then
    raise exception 'A linha de acerto de troco não pode ser alterada.' using errcode = 'PT409';
  end if;
  -- o acerto é vinculado UMA vez (a linha nasce antes do registro do acerto, na mesma transação)
  if old.settlement_id is not null and new.settlement_id is distinct from old.settlement_id then
    raise exception 'A linha de acerto de troco não pode ser alterada.' using errcode = 'PT409';
  end if;
  if old.shortfall_status <> 'open' and (new.shortfall_status is distinct from old.shortfall_status or new.shortfall_open is distinct from old.shortfall_open) then
    raise exception 'Esta diferença já foi encerrada (%).', old.shortfall_status using errcode = 'PT409';
  end if;
  if new.shortfall_open > old.shortfall_open then
    raise exception 'A pendência não pode aumentar.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_courier_cash_line_change() from public, anon, authenticated, service_role;
create trigger delivery_courier_cash_lines_guard before update or delete on public.delivery_courier_cash_lines
  for each row execute function public.guard_courier_cash_line_change();

-- ---------------------------------------------------------------------------
-- 4) Regularização de diferenças (dinheiro recebido ou baixa com motivo)
-- ---------------------------------------------------------------------------
create table public.delivery_courier_cash_resolutions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  line_id uuid not null,
  kind text not null constraint delivery_courier_cash_resolutions_kind_check check (kind in ('received', 'written_off')),
  amount numeric(12, 2) not null constraint delivery_courier_cash_resolutions_amount_check check (amount > 0),
  cash_session_id uuid,
  note text constraint delivery_courier_cash_resolutions_note_length check (note is null or char_length(note) between 1 and 200),
  client_request_id uuid not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint delivery_courier_cash_resolutions_shape_check check (
    (kind = 'received' and cash_session_id is not null) or (kind = 'written_off' and cash_session_id is null and note is not null)
  ),
  constraint delivery_courier_cash_resolutions_line_fkey foreign key (company_id, line_id) references public.delivery_courier_cash_lines (company_id, id),
  constraint delivery_courier_cash_resolutions_cash_fkey foreign key (company_id, cash_session_id) references public.cash_sessions (company_id, id),
  constraint delivery_courier_cash_resolutions_request_key unique (company_id, client_request_id),
  constraint delivery_courier_cash_resolutions_company_id_id_key unique (company_id, id)
);
create index delivery_courier_cash_resolutions_line_idx on public.delivery_courier_cash_resolutions (company_id, line_id);

create function public.guard_courier_cash_resolution_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'Regularizações de diferença são imutáveis.' using errcode = 'PT409';
end;
$$;
revoke execute on function public.guard_courier_cash_resolution_immutable() from public, anon, authenticated, service_role;
create trigger delivery_courier_cash_resolutions_guard before update or delete on public.delivery_courier_cash_resolutions
  for each row execute function public.guard_courier_cash_resolution_immutable();

-- ---------------------------------------------------------------------------
-- 5) RLS / GRANTs (leitura por RLS; toda escrita por RPC)
-- ---------------------------------------------------------------------------
alter table public.delivery_courier_advances enable row level security;
alter table public.delivery_courier_cash_lines enable row level security;
alter table public.delivery_courier_cash_resolutions enable row level security;

create policy delivery_courier_advances_select on public.delivery_courier_advances
  for select to authenticated
  using (
    public.company_has_module_rls(company_id, 'delivery')
    and (public.user_role_in_company(company_id) in ('owner', 'admin', 'cashier')
         or (public.user_role_in_company(company_id) = 'courier' and courier_user_id = auth.uid()))
  );
create policy delivery_courier_cash_lines_select on public.delivery_courier_cash_lines
  for select to authenticated
  using (public.company_has_module_rls(company_id, 'delivery') and public.user_role_in_company(company_id) in ('owner', 'admin', 'cashier'));
create policy delivery_courier_cash_resolutions_select on public.delivery_courier_cash_resolutions
  for select to authenticated
  using (public.company_has_module_rls(company_id, 'delivery') and public.user_role_in_company(company_id) in ('owner', 'admin', 'cashier'));

revoke all on public.delivery_courier_advances, public.delivery_courier_cash_lines, public.delivery_courier_cash_resolutions from public, anon, authenticated;
grant select on public.delivery_courier_advances, public.delivery_courier_cash_lines, public.delivery_courier_cash_resolutions to authenticated;
grant all on public.delivery_courier_advances, public.delivery_courier_cash_lines, public.delivery_courier_cash_resolutions to service_role;

-- Realtime: troco adiantado/devolvido atualiza a fila do Caixa nos outros aparelhos (a RLS da tabela vale no Realtime)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'delivery_courier_advances') then
    alter publication supabase_realtime add table public.delivery_courier_advances;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6) Livro do caixa: tipos novos + vínculos
-- ---------------------------------------------------------------------------
alter table public.cash_movements drop constraint cash_movements_type_check;
alter table public.cash_movements
  add constraint cash_movements_type_check check (movement_type in
    ('sale', 'supply', 'withdrawal', 'refund', 'courier_change_advance', 'courier_change_return', 'courier_settlement_shortfall'));

alter table public.cash_movements
  add column delivery_order_id uuid,
  add column courier_advance_id uuid,
  add column courier_line_id uuid,
  add column courier_resolution_id uuid,
  add constraint cash_movements_courier_order_fkey foreign key (company_id, delivery_order_id) references public.delivery_orders (company_id, id),
  add constraint cash_movements_courier_advance_fkey foreign key (company_id, courier_advance_id) references public.delivery_courier_advances (company_id, id),
  add constraint cash_movements_courier_line_fkey foreign key (company_id, courier_line_id) references public.delivery_courier_cash_lines (company_id, id),
  add constraint cash_movements_courier_resolution_fkey foreign key (company_id, courier_resolution_id) references public.delivery_courier_cash_resolutions (company_id, id),
  add constraint cash_movements_courier_shape_check check (
    (movement_type in ('courier_change_advance', 'courier_change_return', 'courier_settlement_shortfall')
       and payment_method = 'cash' and delivery_order_id is not null and service_payment_id is null)
    or (movement_type not in ('courier_change_advance', 'courier_change_return', 'courier_settlement_shortfall')
       and delivery_order_id is null and courier_advance_id is null and courier_line_id is null and courier_resolution_id is null)
  );
create index cash_movements_courier_order_idx on public.cash_movements (company_id, delivery_order_id) where delivery_order_id is not null;
-- no máximo 1 movimento de saída por adiantamento e 1 por linha / regularização (nunca em dobro)
create unique index cash_movements_courier_advance_out_idx on public.cash_movements (courier_advance_id) where movement_type = 'courier_change_advance';
create unique index cash_movements_courier_line_idx on public.cash_movements (courier_line_id) where courier_line_id is not null;
create unique index cash_movements_courier_resolution_idx on public.cash_movements (courier_resolution_id) where courier_resolution_id is not null;

-- Dinheiro FÍSICO esperado (fonte única do "disponível para sangria", estorno em dinheiro e do esperado no fechamento)
create or replace function public.cash_session_physical_cash(p_cash_session_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select cs.opening_amount + coalesce((
    select sum(case cm.movement_type
                 when 'withdrawal' then -cm.amount
                 when 'refund' then -cm.amount
                 when 'courier_change_advance' then -cm.amount
                 when 'courier_settlement_shortfall' then -cm.amount
                 else cm.amount end)
    from public.cash_movements cm
    where cm.company_id = cs.company_id
      and cm.cash_session_id = cs.id
      and cm.payment_method = 'cash'
      and cm.movement_type in ('sale', 'supply', 'withdrawal', 'refund',
                               'courier_change_advance', 'courier_change_return', 'courier_settlement_shortfall')
  ), 0)
  from public.cash_sessions cs
  where cs.id = p_cash_session_id;
$$;
revoke execute on function public.cash_session_physical_cash(uuid) from public, anon, authenticated;

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
  coalesce(sum(amount) filter (where movement_type = 'refund'), 0)::numeric(12, 2) as refund_total,
  coalesce(sum(amount) filter (where movement_type = 'courier_change_advance'), 0)::numeric(12, 2) as courier_advance_total,
  coalesce(sum(amount) filter (where movement_type = 'courier_change_return'), 0)::numeric(12, 2) as courier_return_total,
  coalesce(sum(amount) filter (where movement_type = 'courier_settlement_shortfall'), 0)::numeric(12, 2) as courier_shortfall_total
from public.cash_movements
group by cash_session_id, company_id;
revoke all on public.cash_session_totals from public, anon, authenticated;
grant select on public.cash_session_totals to authenticated;
grant all on public.cash_session_totals to service_role;

-- ---------------------------------------------------------------------------
-- 7) Entregar o troco (confirmação explícita do operador)
-- ---------------------------------------------------------------------------
create function public.give_courier_change_advance(
  p_delivery_order_id uuid,
  p_amount numeric,
  p_client_request_id uuid,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_do public.delivery_orders;
  v_role public.company_role;
  v_session public.service_sessions;
  v_cash public.cash_sessions;
  v_old public.delivery_courier_advances;
  v_adv public.delivery_courier_advances;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_code text;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if p_client_request_id is null then
    raise exception 'Identificador da requisição ausente.' using errcode = 'PT400';
  end if;
  select * into v_do from public.delivery_orders where id = p_delivery_order_id;
  if not found then
    raise exception 'Pedido de delivery não encontrado.' using errcode = 'PT404';
  end if;
  v_role := public.user_role_in_company(v_do.company_id);
  if v_role is null then
    raise exception 'Pedido de delivery não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier') then
    raise exception 'Você não tem permissão para entregar troco ao entregador.' using errcode = 'PT403';
  end if;
  perform public.assert_company_module(v_do.company_id, 'delivery');

  if p_amount is null or p_amount <= 0 or p_amount >= 100000 or p_amount <> round(p_amount, 2) then
    raise exception 'Informe o valor do troco: maior que zero, com até 2 casas decimais.' using errcode = 'PT400';
  end if;
  if v_note is not null and char_length(v_note) > 120 then
    raise exception 'A observação pode ter no máximo 120 caracteres.' using errcode = 'PT400';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('advance:' || v_do.company_id::text || ':' || p_client_request_id::text, 0));
  -- ordem de locks: atendimento -> pedido -> caixa
  select * into v_session from public.service_sessions where company_id = v_do.company_id and id = v_do.service_session_id for update;
  select * into v_do from public.delivery_orders where id = p_delivery_order_id for update;

  select * into v_old from public.delivery_courier_advances where company_id = v_do.company_id and client_request_id = p_client_request_id;
  if found then
    if v_old.delivery_order_id <> v_do.id then
      raise exception 'Pedido de adiantamento inválido.' using errcode = 'PT409';
    end if;
    return jsonb_build_object('advance_id', v_old.id, 'delivery_order_id', v_do.id, 'amount', v_old.amount, 'status', v_old.status, 'replayed', true);
  end if;

  if v_do.fulfillment <> 'delivery' then
    raise exception 'Retirada não tem entregador.' using errcode = 'PT409';
  end if;
  if v_do.courier_user_id is null then
    raise exception 'Atribua um entregador ao pedido antes de entregar o troco.' using errcode = 'PT409';
  end if;
  if v_do.delivery_status not in ('confirmed', 'out_for_delivery') then
    raise exception 'O troco só pode ser entregue antes da conclusão do pedido.' using errcode = 'PT409';
  end if;
  if v_session.status <> 'open' then
    raise exception 'Este pedido já foi pago/fechado.' using errcode = 'PT409';
  end if;
  if exists (select 1 from public.delivery_courier_receipts r where r.company_id = v_do.company_id and r.delivery_order_id = v_do.id and r.status in ('held', 'settled')) then
    raise exception 'O entregador já registrou o recebimento deste pedido.' using errcode = 'PT409';
  end if;
  if exists (select 1 from public.delivery_courier_advances a where a.company_id = v_do.company_id and a.delivery_order_id = v_do.id and a.status in ('open', 'settled')) then
    raise exception 'Já existe troco adiantado para este pedido.' using errcode = 'PT409';
  end if;

  -- caixa ABERTO do próprio operador (travado: duas saídas simultâneas serializam e a segunda vê o saldo já reduzido)
  select * into v_cash from public.cash_sessions
   where company_id = v_do.company_id and opened_by = auth.uid() and status = 'open' for update;
  if not found then
    raise exception 'Abra o caixa antes de entregar troco ao entregador.' using errcode = 'PT412';
  end if;
  if p_amount > public.cash_session_physical_cash(v_cash.id) then
    raise exception 'Valor maior que o dinheiro disponível no caixa.' using errcode = 'PT400';
  end if;

  insert into public.delivery_courier_advances (company_id, delivery_order_id, courier_user_id, cash_session_id, amount, client_request_id, note, given_by)
  values (v_do.company_id, v_do.id, v_do.courier_user_id, v_cash.id, p_amount, p_client_request_id, v_note, auth.uid())
  returning * into v_adv;

  v_code := upper(left(replace(v_do.id::text, '-', ''), 6));
  insert into public.cash_movements (company_id, cash_session_id, movement_type, payment_method, amount, description, created_by, delivery_order_id, courier_advance_id)
  values (v_do.company_id, v_cash.id, 'courier_change_advance', 'cash', p_amount, 'Troco adiantado ao entregador - pedido #' || v_code, auth.uid(), v_do.id, v_adv.id);

  insert into public.delivery_order_events (company_id, delivery_order_id, event_type, actor_user_id, new_value)
  values (v_do.company_id, v_do.id, 'change_advance_given', auth.uid(),
          jsonb_build_object('advance_id', v_adv.id, 'amount', p_amount, 'courier_user_id', v_do.courier_user_id, 'cash_session_id', v_cash.id));

  return jsonb_build_object('advance_id', v_adv.id, 'delivery_order_id', v_do.id, 'amount', p_amount, 'status', 'open', 'replayed', false);
end;
$$;
revoke execute on function public.give_courier_change_advance(uuid, numeric, uuid, text) from public, anon;
grant execute on function public.give_courier_change_advance(uuid, numeric, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8) Devolver o adiantamento sem acerto de venda (entrega cancelada/recusada/não realizada)
-- ---------------------------------------------------------------------------
create function public.return_courier_change_advance(
  p_advance_id uuid,
  p_counted_amount numeric,
  p_note text,
  p_client_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_adv public.delivery_courier_advances;
  v_role public.company_role;
  v_session_id uuid;
  v_cash public.cash_sessions;
  v_counted numeric(12, 2);
  v_diff numeric(12, 2);
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_line uuid;
  v_code text;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if p_client_request_id is null then
    raise exception 'Identificador da requisição ausente.' using errcode = 'PT400';
  end if;
  select * into v_adv from public.delivery_courier_advances where id = p_advance_id;
  if not found then
    raise exception 'Adiantamento não encontrado.' using errcode = 'PT404';
  end if;
  v_role := public.user_role_in_company(v_adv.company_id);
  if v_role is null then
    raise exception 'Adiantamento não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier') then
    raise exception 'Você não tem permissão para receber a devolução de troco.' using errcode = 'PT403';
  end if;
  perform public.assert_company_module(v_adv.company_id, 'delivery');

  perform pg_advisory_xact_lock(hashtextextended('advret:' || v_adv.company_id::text || ':' || p_advance_id::text, 0));
  select service_session_id into v_session_id from public.delivery_orders where company_id = v_adv.company_id and id = v_adv.delivery_order_id;
  perform 1 from public.service_sessions where company_id = v_adv.company_id and id = v_session_id for update;
  select * into v_adv from public.delivery_courier_advances where id = p_advance_id for update;

  if v_adv.status = 'returned' and v_adv.return_request_id = p_client_request_id then
    return jsonb_build_object('advance_id', v_adv.id, 'status', 'returned', 'replayed', true);
  end if;
  if v_adv.status <> 'open' then
    raise exception 'Este adiantamento já foi encerrado (%).', v_adv.status using errcode = 'PT409';
  end if;
  if exists (select 1 from public.delivery_courier_receipts r where r.company_id = v_adv.company_id and r.delivery_order_id = v_adv.delivery_order_id and r.status = 'held') then
    raise exception 'Este pedido tem recebimento do entregador aguardando acerto: o troco é devolvido junto no acerto.' using errcode = 'PT409';
  end if;

  v_counted := coalesce(p_counted_amount, v_adv.amount);
  if v_counted < 0 or v_counted > v_adv.amount or v_counted <> round(v_counted, 2) then
    raise exception 'O valor devolvido deve ficar entre zero e o troco adiantado, com até 2 casas decimais.' using errcode = 'PT400';
  end if;
  v_diff := v_adv.amount - v_counted;
  if v_diff <> 0 and v_note is null then
    raise exception 'Informe o motivo da diferença na devolução.' using errcode = 'PT400';
  end if;
  if v_note is not null and char_length(v_note) > 200 then
    raise exception 'O motivo pode ter no máximo 200 caracteres.' using errcode = 'PT400';
  end if;

  -- caixa que RECEBE (do operador logado; pode ser outro que o de origem)
  select * into v_cash from public.cash_sessions
   where company_id = v_adv.company_id and opened_by = auth.uid() and status = 'open' for share;
  if not found then
    raise exception 'Abra o caixa antes de receber a devolução do troco.' using errcode = 'PT412';
  end if;

  insert into public.delivery_courier_cash_lines (
    company_id, kind, delivery_order_id, courier_user_id, advance_id, cash_session_id,
    sale_cash, advance_amount, expected_amount, counted_amount, difference, reason, shortfall_open, shortfall_status, created_by
  ) values (
    v_adv.company_id, 'advance_return', v_adv.delivery_order_id, v_adv.courier_user_id, v_adv.id, v_cash.id,
    0, v_adv.amount, v_adv.amount, v_counted, v_diff, v_note, greatest(v_diff, 0), case when v_diff > 0 then 'open' else 'none' end, auth.uid()
  ) returning id into v_line;

  v_code := upper(left(replace(v_adv.delivery_order_id::text, '-', ''), 6));
  if v_counted > 0 then
    insert into public.cash_movements (company_id, cash_session_id, movement_type, payment_method, amount, description, created_by,
                                       delivery_order_id, courier_advance_id, courier_line_id)
    values (v_adv.company_id, v_cash.id, 'courier_change_return', 'cash', v_counted, 'Devolução de troco adiantado - pedido #' || v_code,
            auth.uid(), v_adv.delivery_order_id, v_adv.id, v_line);
  end if;

  update public.delivery_courier_advances
     set status = 'returned', closed_at = now(), line_id = v_line, return_request_id = p_client_request_id
   where id = v_adv.id;

  insert into public.delivery_order_events (company_id, delivery_order_id, event_type, actor_user_id, new_value, note)
  values (v_adv.company_id, v_adv.delivery_order_id, 'change_advance_returned', auth.uid(),
          jsonb_build_object('advance_id', v_adv.id, 'advance', v_adv.amount, 'counted', v_counted, 'difference', v_diff, 'line_id', v_line, 'cash_session_id', v_cash.id),
          v_note);

  return jsonb_build_object('advance_id', v_adv.id, 'status', 'returned', 'line_id', v_line, 'advance', v_adv.amount,
                            'counted', v_counted, 'difference', v_diff, 'shortfall_open', greatest(v_diff, 0), 'replayed', false);
end;
$$;
revoke execute on function public.return_courier_change_advance(uuid, numeric, text, uuid) from public, anon;
grant execute on function public.return_courier_change_advance(uuid, numeric, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 9) Acerto com dinheiro bruto: venda do pedido + devolução do adiantamento + diferença
-- ---------------------------------------------------------------------------
-- p_items: [{ "receipt_id": uuid, "counted_amount": numeric (opcional; padrão = esperado), "note": text (motivo; obrigatório se contado <> esperado) }]
create function public.settle_courier_cash(p_company_id uuid, p_courier_user_id uuid, p_items jsonb, p_client_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_item jsonb;
  v_id uuid;
  v_ids uuid[] := '{}';
  v_counted jsonb := '{}'::jsonb;
  v_notes jsonb := '{}'::jsonb;
  v_rows public.delivery_courier_receipts[];
  v_r public.delivery_courier_receipts;
  v_old public.delivery_courier_settlements;
  v_cash public.cash_sessions;
  v_adv public.delivery_courier_advances;
  v_have_adv boolean;
  v_sc numeric(12, 2);
  v_a numeric(12, 2);
  v_e numeric(12, 2);
  v_c numeric(12, 2);
  v_d numeric(12, 2);
  v_adj numeric(12, 2);
  v_note text;
  v_code text;
  v_line uuid;
  v_pay jsonb;
  v_set uuid;
  v_total numeric(12, 2) := 0;
  v_exp_total numeric(12, 2) := 0;
  v_cnt_total numeric(12, 2) := 0;
  v_diff_total numeric(12, 2) := 0;
  v_lines jsonb := '[]'::jsonb;
  v_orders jsonb := '[]'::jsonb;
  v_by jsonb;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if p_client_request_id is null or p_courier_user_id is null or p_company_id is null then
    raise exception 'Pedido de acerto inválido.' using errcode = 'PT400';
  end if;
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier') then
    raise exception 'Você não tem permissão para confirmar acertos de entregadores.' using errcode = 'PT403';
  end if;
  perform public.assert_company_module(p_company_id, 'delivery');

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Informe os recebimentos a acertar.' using errcode = 'PT400';
  end if;
  if jsonb_array_length(p_items) > 100 then
    raise exception 'Acerte no máximo 100 recebimentos por vez.' using errcode = 'PT400';
  end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object' or jsonb_typeof(v_item -> 'receipt_id') <> 'string' then
      raise exception 'Item de acerto inválido.' using errcode = 'PT400';
    end if;
    begin
      v_id := (v_item ->> 'receipt_id')::uuid;
    exception when invalid_text_representation then
      raise exception 'Item de acerto inválido.' using errcode = 'PT400';
    end;
    if v_id = any(v_ids) then
      raise exception 'Recebimento repetido no acerto.' using errcode = 'PT400';
    end if;
    v_ids := v_ids || v_id;
    if v_item ? 'counted_amount' and jsonb_typeof(v_item -> 'counted_amount') = 'number' then
      v_counted := v_counted || jsonb_build_object(v_id::text, v_item ->> 'counted_amount');
    elsif v_item ? 'counted_amount' and jsonb_typeof(v_item -> 'counted_amount') not in ('null', 'number') then
      raise exception 'Valor contado inválido.' using errcode = 'PT400';
    end if;
    if jsonb_typeof(v_item -> 'note') = 'string' then
      v_notes := v_notes || jsonb_build_object(v_id::text, v_item ->> 'note');
    end if;
  end loop;
  select array_agg(x order by x) into v_ids from unnest(v_ids) x;

  -- locks na ordem: atendimentos -> recibos -> adiantamentos
  perform 1 from public.service_sessions s
   where s.company_id = p_company_id and s.id in (select r.service_session_id from public.delivery_courier_receipts r where r.company_id = p_company_id and r.id = any(v_ids))
   order by s.id for update;
  perform 1 from public.delivery_courier_receipts r where r.company_id = p_company_id and r.id = any(v_ids) order by r.id for update;
  perform 1 from public.delivery_courier_advances a
   where a.company_id = p_company_id and a.status = 'open'
     and a.delivery_order_id in (select r.delivery_order_id from public.delivery_courier_receipts r where r.company_id = p_company_id and r.id = any(v_ids))
   order by a.id for update;
  select array_agg(r order by r.id) into v_rows from public.delivery_courier_receipts r where r.company_id = p_company_id and r.id = any(v_ids);

  -- réplica idempotente (depois das travas)
  select * into v_old from public.delivery_courier_settlements where company_id = p_company_id and client_request_id = p_client_request_id;
  if found then
    if v_old.courier_user_id <> p_courier_user_id then
      raise exception 'Pedido de acerto inválido.' using errcode = 'PT409';
    end if;
    return v_old.result || jsonb_build_object('replayed', true);
  end if;

  if coalesce(array_length(v_rows, 1), 0) <> array_length(v_ids, 1) then
    raise exception 'Algum recebimento não existe neste entregador. Atualize a tela.' using errcode = 'PT409';
  end if;
  foreach v_r in array v_rows loop
    if v_r.courier_user_id <> p_courier_user_id or v_r.status <> 'held' then
      raise exception 'Algum recebimento já foi acertado ou anulado. Atualize a tela.' using errcode = 'PT409';
    end if;
    v_total := v_total + v_r.amount;
  end loop;

  -- caixa que RECEBE o dinheiro (do operador logado)
  select * into v_cash from public.cash_sessions
   where company_id = p_company_id and opened_by = auth.uid() and status = 'open' for share;
  if not found then
    raise exception 'Abra o caixa antes de confirmar o acerto.' using errcode = 'PT412';
  end if;

  perform set_config('gap.courier_settlement', 'on', true);
  foreach v_r in array v_rows loop
    v_code := upper(left(replace(v_r.delivery_order_id::text, '-', ''), 6));
    v_sc := case when v_r.payment_method = 'cash' then v_r.amount else 0 end;
    select * into v_adv from public.delivery_courier_advances
     where company_id = p_company_id and delivery_order_id = v_r.delivery_order_id and status = 'open';
    v_have_adv := found;
    v_a := case when v_have_adv then v_adv.amount else 0 end;
    v_e := v_sc + v_a;

    if v_counted ? v_r.id::text then
      v_c := (v_counted ->> v_r.id::text)::numeric;
    else
      v_c := v_e;
    end if;
    if v_c < 0 or v_c >= 100000000 or v_c <> round(v_c, 2) then
      raise exception 'Valor contado inválido (pedido #%).', v_code using errcode = 'PT400';
    end if;
    v_d := v_e - v_c;
    v_note := nullif(btrim(coalesce(v_notes ->> v_r.id::text, '')), '');
    if v_d <> 0 and v_note is null then
      raise exception 'Informe o motivo da diferença (pedido #%).', v_code using errcode = 'PT400';
    end if;
    if v_note is not null and char_length(v_note) > 200 then
      raise exception 'O motivo pode ter no máximo 200 caracteres.' using errcode = 'PT400';
    end if;

    -- venda pelo núcleo oficial (pagamento + movimento 'sale' + fechamento); falha = tudo desfeito
    v_pay := case when v_r.payment_method = 'cash'
                  then jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', v_r.amount, 'amount_received', v_r.amount_received))
                  else jsonb_build_array(jsonb_build_object('method', v_r.payment_method, 'amount', v_r.amount)) end;
    perform public.receive_delivery_order(v_r.delivery_order_id, v_pay, md5(p_client_request_id::text || ':' || v_r.id::text)::uuid);

    if v_sc > 0 or v_a > 0 or v_c > 0 then
      insert into public.delivery_courier_cash_lines (
        company_id, kind, delivery_order_id, courier_user_id, advance_id, receipt_id, settlement_id, cash_session_id,
        sale_cash, advance_amount, expected_amount, counted_amount, difference, reason, shortfall_open, shortfall_status, created_by
      ) values (
        p_company_id, 'settlement', v_r.delivery_order_id, p_courier_user_id, case when v_have_adv then v_adv.id end, v_r.id, null, v_cash.id,
        v_sc, v_a, v_e, v_c, v_d, v_note, greatest(v_d, 0), case when v_d > 0 then 'open' else 'none' end, auth.uid()
      ) returning id into v_line;
    else
      v_line := null;
    end if;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'receipt_id', v_r.id, 'delivery_order_id', v_r.delivery_order_id, 'short_code', v_code, 'method', v_r.payment_method,
      'sale', v_r.amount, 'sale_cash', v_sc, 'advance', v_a, 'expected', v_e, 'counted', v_c, 'difference', v_d,
      'shortfall_open', greatest(v_d, 0), 'line_id', v_line));
    v_exp_total := v_exp_total + v_e;
    v_cnt_total := v_cnt_total + v_c;
    v_diff_total := v_diff_total + v_d;
    v_orders := v_orders || jsonb_build_array(jsonb_build_object('delivery_order_id', v_r.delivery_order_id, 'short_code', v_code, 'method', v_r.payment_method, 'amount', v_r.amount));

    -- dinheiro FÍSICO efetivo: a venda em dinheiro já entrou (+v_sc); ajusta para o que realmente voltou
    v_adj := v_c - v_sc;
    if v_adj <> 0 and v_line is not null then
      insert into public.cash_movements (company_id, cash_session_id, movement_type, payment_method, amount, description, created_by,
                                         delivery_order_id, courier_advance_id, courier_line_id)
      values (p_company_id, v_cash.id, case when v_adj > 0 then 'courier_change_return' else 'courier_settlement_shortfall' end, 'cash', abs(v_adj),
              case when v_adj > 0 then 'Devolução de troco adiantado - pedido #' || v_code else 'Falta no acerto do entregador - pedido #' || v_code end,
              auth.uid(), v_r.delivery_order_id, case when v_have_adv then v_adv.id end, v_line);
    end if;
    if v_have_adv then
      update public.delivery_courier_advances set status = 'settled', closed_at = now(), line_id = v_line where id = v_adv.id;
    end if;
    if v_line is not null then
      insert into public.delivery_order_events (company_id, delivery_order_id, event_type, actor_user_id, new_value, note)
      values (p_company_id, v_r.delivery_order_id, 'change_advance_returned', auth.uid(),
              jsonb_build_object('line_id', v_line, 'sale_cash', v_sc, 'advance', v_a, 'expected', v_e, 'counted', v_c, 'difference', v_d), v_note);
    end if;
  end loop;
  perform set_config('gap.courier_settlement', 'off', true);

  select jsonb_build_object('cash', coalesce(sum(x.amount) filter (where x.payment_method = 'cash'), 0), 'pix', coalesce(sum(x.amount) filter (where x.payment_method = 'pix'), 0),
                            'debit_card', coalesce(sum(x.amount) filter (where x.payment_method = 'debit_card'), 0),
                            'credit_card', coalesce(sum(x.amount) filter (where x.payment_method = 'credit_card'), 0),
                            'other', coalesce(sum(x.amount) filter (where x.payment_method = 'other'), 0))
    into v_by from unnest(v_rows) x;
  v_result := jsonb_build_object('courier_user_id', p_courier_user_id, 'receipt_count', array_length(v_ids, 1), 'total_amount', v_total,
                                 'by_method', v_by, 'orders', v_orders, 'lines', v_lines,
                                 'expected_total', v_exp_total, 'counted_total', v_cnt_total, 'difference_total', v_diff_total,
                                 'replayed', false);

  insert into public.delivery_courier_settlements (company_id, courier_user_id, client_request_id, settled_by, receipt_count, total_amount, result)
  values (p_company_id, p_courier_user_id, p_client_request_id, auth.uid(), array_length(v_ids, 1), v_total, v_result - 'replayed')
  returning id into v_set;
  update public.delivery_courier_cash_lines set settlement_id = v_set where company_id = p_company_id and receipt_id = any(v_ids);

  update public.delivery_courier_receipts set status = 'settled', settlement_id = v_set, settled_at = now() where company_id = p_company_id and id = any(v_ids);
  foreach v_r in array v_rows loop
    insert into public.delivery_order_events (company_id, delivery_order_id, event_type, actor_user_id, new_value)
    values (p_company_id, v_r.delivery_order_id, 'courier_settlement_completed', auth.uid(),
            jsonb_build_object('settlement_id', v_set, 'receipt_id', v_r.id, 'courier_user_id', p_courier_user_id, 'method', v_r.payment_method, 'amount', v_r.amount));
  end loop;

  return v_result || jsonb_build_object('settlement_id', v_set);
end;
$$;
revoke execute on function public.settle_courier_cash(uuid, uuid, jsonb, uuid) from public, anon;
grant execute on function public.settle_courier_cash(uuid, uuid, jsonb, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 10) Regularizar uma diferença (dinheiro recebido do entregador ou baixa com motivo)
-- ---------------------------------------------------------------------------
create function public.resolve_courier_difference(
  p_line_id uuid,
  p_action text,
  p_amount numeric,
  p_note text,
  p_client_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_line public.delivery_courier_cash_lines;
  v_role public.company_role;
  v_old public.delivery_courier_cash_resolutions;
  v_cash public.cash_sessions;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_res uuid;
  v_amount numeric(12, 2);
  v_left numeric(12, 2);
  v_code text;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if p_client_request_id is null then
    raise exception 'Identificador da requisição ausente.' using errcode = 'PT400';
  end if;
  if p_action is null or p_action not in ('received', 'written_off') then
    raise exception 'Ação inválida. Use recebimento ou baixa.' using errcode = 'PT400';
  end if;
  select * into v_line from public.delivery_courier_cash_lines where id = p_line_id;
  if not found then
    raise exception 'Diferença não encontrada.' using errcode = 'PT404';
  end if;
  v_role := public.user_role_in_company(v_line.company_id);
  if v_role is null then
    raise exception 'Diferença não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier') or (p_action = 'written_off' and v_role not in ('owner', 'admin')) then
    raise exception 'Você não tem permissão para esta ação.' using errcode = 'PT403';
  end if;
  perform public.assert_company_module(v_line.company_id, 'delivery');
  if v_note is not null and char_length(v_note) > 200 then
    raise exception 'A observação pode ter no máximo 200 caracteres.' using errcode = 'PT400';
  end if;
  if p_action = 'written_off' and v_note is null then
    raise exception 'Informe o motivo da baixa.' using errcode = 'PT400';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('cdiff:' || v_line.company_id::text || ':' || p_line_id::text, 0));
  select * into v_line from public.delivery_courier_cash_lines where id = p_line_id for update;

  select * into v_old from public.delivery_courier_cash_resolutions where company_id = v_line.company_id and client_request_id = p_client_request_id;
  if found then
    if v_old.line_id <> v_line.id then
      raise exception 'Pedido de regularização inválido.' using errcode = 'PT409';
    end if;
    return jsonb_build_object('resolution_id', v_old.id, 'line_id', v_line.id, 'kind', v_old.kind, 'amount', v_old.amount,
                              'shortfall_open', v_line.shortfall_open, 'status', v_line.shortfall_status, 'replayed', true);
  end if;

  if v_line.shortfall_status <> 'open' then
    raise exception 'Esta diferença não está em aberto (%).', v_line.shortfall_status using errcode = 'PT409';
  end if;

  if p_action = 'received' then
    v_amount := p_amount;
    if v_amount is null or v_amount <= 0 or v_amount <> round(v_amount, 2) or v_amount > v_line.shortfall_open then
      raise exception 'Informe um valor maior que zero e até a pendência (R$ %).', replace(to_char(v_line.shortfall_open, 'FM9999999990.00'), '.', ',') using errcode = 'PT400';
    end if;
    select * into v_cash from public.cash_sessions
     where company_id = v_line.company_id and opened_by = auth.uid() and status = 'open' for share;
    if not found then
      raise exception 'Abra o caixa antes de receber a regularização.' using errcode = 'PT412';
    end if;
    insert into public.delivery_courier_cash_resolutions (company_id, line_id, kind, amount, cash_session_id, note, client_request_id, created_by)
    values (v_line.company_id, v_line.id, 'received', v_amount, v_cash.id, v_note, p_client_request_id, auth.uid())
    returning id into v_res;
    v_code := upper(left(replace(v_line.delivery_order_id::text, '-', ''), 6));
    insert into public.cash_movements (company_id, cash_session_id, movement_type, payment_method, amount, description, created_by,
                                       delivery_order_id, courier_advance_id, courier_line_id, courier_resolution_id)
    values (v_line.company_id, v_cash.id, 'courier_change_return', 'cash', v_amount, 'Regularização de diferença do entregador - pedido #' || v_code,
            auth.uid(), v_line.delivery_order_id, v_line.advance_id, null, v_res);
    v_left := v_line.shortfall_open - v_amount;
    update public.delivery_courier_cash_lines
       set shortfall_open = v_left, shortfall_status = case when v_left = 0 then 'resolved' else 'open' end
     where id = v_line.id;
  else
    v_amount := v_line.shortfall_open;
    insert into public.delivery_courier_cash_resolutions (company_id, line_id, kind, amount, cash_session_id, note, client_request_id, created_by)
    values (v_line.company_id, v_line.id, 'written_off', v_amount, null, v_note, p_client_request_id, auth.uid())
    returning id into v_res;
    v_left := 0;
    update public.delivery_courier_cash_lines set shortfall_open = 0, shortfall_status = 'written_off' where id = v_line.id;
  end if;

  insert into public.delivery_order_events (company_id, delivery_order_id, event_type, actor_user_id, new_value, note)
  values (v_line.company_id, v_line.delivery_order_id, 'change_difference_resolved', auth.uid(),
          jsonb_build_object('line_id', v_line.id, 'resolution_id', v_res, 'kind', p_action, 'amount', v_amount, 'shortfall_open', v_left), v_note);

  return jsonb_build_object('resolution_id', v_res, 'line_id', v_line.id, 'kind', p_action, 'amount', v_amount,
                            'shortfall_open', v_left, 'status', case when v_left = 0 then (case when p_action = 'written_off' then 'written_off' else 'resolved' end) else 'open' end,
                            'replayed', false);
end;
$$;
revoke execute on function public.resolve_courier_difference(uuid, text, numeric, text, uuid) from public, anon;
grant execute on function public.resolve_courier_difference(uuid, text, numeric, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 11) Leituras
-- ---------------------------------------------------------------------------
-- Tela do pedido: adiantamento vigente, valor sugerido e se pode entregar troco agora
create function public.get_courier_advance(p_delivery_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_do public.delivery_orders;
  v_role public.company_role;
  v_adv public.delivery_courier_advances;
  v_total numeric(12, 2);
  v_blocked text;
  v_sess text;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_do from public.delivery_orders where id = p_delivery_order_id;
  if not found then
    raise exception 'Pedido de delivery não encontrado.' using errcode = 'PT404';
  end if;
  v_role := public.delivery_assert_actor(v_do.company_id);
  if v_role = 'courier' and v_do.courier_user_id is distinct from auth.uid() then
    raise exception 'Pedido de delivery não encontrado.' using errcode = 'PT404';
  end if;

  select * into v_adv from public.delivery_courier_advances
   where company_id = v_do.company_id and delivery_order_id = v_do.id
   order by (status in ('open', 'settled')) desc, created_at desc limit 1;
  v_total := public.delivery_total(v_do.company_id, v_do.id);
  select status into v_sess from public.service_sessions where company_id = v_do.company_id and id = v_do.service_session_id;

  v_blocked := case
    when v_role not in ('owner', 'admin', 'cashier') then 'Só o Caixa entrega o troco.'
    when v_do.fulfillment <> 'delivery' then 'Retirada não tem entregador.'
    when v_do.courier_user_id is null then 'Atribua um entregador ao pedido.'
    when v_do.delivery_status not in ('confirmed', 'out_for_delivery') then 'O pedido já foi concluído.'
    when v_sess <> 'open' then 'O pedido já foi pago/fechado.'
    when exists (select 1 from public.delivery_courier_receipts r where r.company_id = v_do.company_id and r.delivery_order_id = v_do.id and r.status in ('held', 'settled')) then 'O entregador já registrou o recebimento.'
    when v_adv.id is not null and v_adv.status in ('open', 'settled') then 'Troco já entregue.'
    else null end;

  return jsonb_build_object(
    'advance', case when v_adv.id is null then null else jsonb_build_object(
      'id', v_adv.id, 'amount', v_adv.amount, 'status', v_adv.status, 'given_at', v_adv.given_at,
      'given_by_name', (select p.full_name from public.profiles p where p.user_id = v_adv.given_by),
      'courier_user_id', v_adv.courier_user_id, 'note', v_adv.note) end,
    'order_total', v_total,
    'expected_method', v_do.expected_method,
    'cash_change_for', v_do.cash_change_for,
    'suggested', case when v_do.expected_method = 'cash' and v_do.cash_change_for is not null and v_total is not null
                      then greatest(v_do.cash_change_for - v_total, 0) else 0 end,
    'can_give', v_blocked is null,
    'blocked_reason', v_blocked);
end;
$$;
revoke execute on function public.get_courier_advance(uuid) from public, anon;
grant execute on function public.get_courier_advance(uuid) to authenticated;

-- Caixa: pendências financeiras (troco a devolver e diferenças em aberto)
create function public.list_courier_cash_pending(p_company_id uuid)
returns jsonb
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
  if v_role not in ('owner', 'admin', 'cashier') then
    raise exception 'Você não tem permissão para ver as pendências de entregadores.' using errcode = 'PT403';
  end if;
  perform public.assert_company_module(p_company_id, 'delivery');

  return jsonb_build_object(
    'pending_returns', coalesce((
      select jsonb_agg(jsonb_build_object(
        'advance_id', a.id, 'delivery_order_id', a.delivery_order_id,
        'short_code', upper(left(replace(a.delivery_order_id::text, '-', ''), 6)),
        'courier_user_id', a.courier_user_id, 'courier_name', coalesce(pr.full_name, 'Entregador'),
        'customer_name', d.customer_name, 'delivery_status', d.delivery_status, 'cancel_reason', d.cancel_reason,
        'amount', a.amount, 'given_at', a.given_at) order by a.given_at)
      from public.delivery_courier_advances a
      join public.delivery_orders d on d.company_id = a.company_id and d.id = a.delivery_order_id
      left join public.profiles pr on pr.user_id = a.courier_user_id
      where a.company_id = p_company_id and a.status = 'open'
        and not exists (select 1 from public.delivery_courier_receipts r where r.company_id = a.company_id and r.delivery_order_id = a.delivery_order_id and r.status = 'held')
    ), '[]'::jsonb),
    'open_differences', coalesce((
      select jsonb_agg(jsonb_build_object(
        'line_id', l.id, 'kind', l.kind, 'delivery_order_id', l.delivery_order_id,
        'short_code', upper(left(replace(l.delivery_order_id::text, '-', ''), 6)),
        'courier_user_id', l.courier_user_id, 'courier_name', coalesce(pr.full_name, 'Entregador'),
        'expected', l.expected_amount, 'counted', l.counted_amount, 'difference', l.difference,
        'shortfall_open', l.shortfall_open, 'reason', l.reason, 'created_at', l.created_at) order by l.created_at)
      from public.delivery_courier_cash_lines l
      left join public.profiles pr on pr.user_id = l.courier_user_id
      where l.company_id = p_company_id and l.shortfall_status = 'open'
    ), '[]'::jsonb));
end;
$$;
revoke execute on function public.list_courier_cash_pending(uuid) from public, anon;
grant execute on function public.list_courier_cash_pending(uuid) to authenticated;

-- Fila do acerto: mesmas chaves de antes + adiantamento / esperado / líquido por recibo (aditivo)
create or replace function public.list_courier_settlements(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier') then
    raise exception 'Você não tem permissão para ver os acertos de entregadores.' using errcode = 'PT403';
  end if;
  perform public.assert_company_module(p_company_id, 'delivery');

  select coalesce(jsonb_agg(c.j order by c.first_at), '[]'::jsonb) into v_result
  from (
    select min(r.received_at) as first_at,
      jsonb_build_object(
        'courier_user_id', r.courier_user_id,
        'courier_name', coalesce(max(pr.full_name), 'Entregador'),
        'receipts_count', count(*),
        'total', sum(r.amount),
        'advance_total', coalesce(sum(a.amount), 0),
        'expected_total', sum(case when r.payment_method = 'cash' then r.amount else 0 end) + coalesce(sum(a.amount), 0),
        'by_method', jsonb_build_object(
          'cash', coalesce(sum(r.amount) filter (where r.payment_method = 'cash'), 0),
          'pix', coalesce(sum(r.amount) filter (where r.payment_method = 'pix'), 0),
          'debit_card', coalesce(sum(r.amount) filter (where r.payment_method = 'debit_card'), 0),
          'credit_card', coalesce(sum(r.amount) filter (where r.payment_method = 'credit_card'), 0),
          'other', coalesce(sum(r.amount) filter (where r.payment_method = 'other'), 0)),
        'receipts', jsonb_agg(jsonb_build_object(
          'receipt_id', r.id, 'delivery_order_id', r.delivery_order_id, 'service_session_id', r.service_session_id,
          'short_code', upper(left(replace(r.delivery_order_id::text, '-', ''), 6)),
          'customer_name', d.customer_name, 'order_total', public.delivery_total(r.company_id, r.delivery_order_id),
          'expected_method', d.expected_method, 'method', r.payment_method, 'amount', r.amount,
          'amount_received', r.amount_received, 'change_amount', r.change_amount, 'note', r.note,
          'received_at', r.received_at, 'delivery_status', d.delivery_status,
          'advance_id', a.id, 'advance_amount', coalesce(a.amount, 0),
          'sale_cash', case when r.payment_method = 'cash' then r.amount else 0 end,
          'expected_return', (case when r.payment_method = 'cash' then r.amount else 0 end) + coalesce(a.amount, 0),
          'net_sale', r.amount) order by r.received_at, r.id)
      ) as j
    from public.delivery_courier_receipts r
    join public.delivery_orders d on d.company_id = r.company_id and d.id = r.delivery_order_id
    left join public.profiles pr on pr.user_id = r.courier_user_id
    left join public.delivery_courier_advances a on a.company_id = r.company_id and a.delivery_order_id = r.delivery_order_id and a.status = 'open'
    where r.company_id = p_company_id and r.status = 'held'
    group by r.courier_user_id
  ) c;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 12) Fluxos existentes (substituição exata de trecho)
-- ---------------------------------------------------------------------------
create function pg_temp.patch_courier_advance_fn(p_name text, p_from text, p_to text)
returns void
language plpgsql
as $$
declare
  v_oid oid;
  v_def text;
begin
  select p.oid into v_oid from pg_proc p where p.proname = p_name and p.pronamespace = 'public'::regnamespace;
  if v_oid is null then
    raise exception 'patch: função % não encontrada', p_name;
  end if;
  v_def := pg_get_functiondef(v_oid);
  if (length(v_def) - length(replace(v_def, p_from, ''))) / greatest(length(p_from), 1) <> 1 then
    raise exception 'patch: trecho esperado não ocorre exatamente 1 vez em %', p_name;
  end if;
  execute replace(v_def, p_from, p_to);
end;
$$;

-- Acerto ANTIGO (4 argumentos, app 1.0.11): recusa recebimento de pedido com troco adiantado (nunca assume o valor devolvido)
select pg_temp.patch_courier_advance_fn('settle_courier_receipts',
  $f$v_total := v_total + v_r.amount;$f$,
  $f$if exists (select 1 from public.delivery_courier_advances a
                 where a.company_id = p_company_id and a.delivery_order_id = v_r.delivery_order_id and a.status = 'open') then
      raise exception 'Este pedido tem troco adiantado ao entregador. Atualize o aplicativo para confirmar o acerto com o valor devolvido.' using errcode = 'PT409';
    end if;
    v_total := v_total + v_r.amount;$f$);

-- Troca/remoção do entregador com troco adiantado em aberto
select pg_temp.patch_courier_advance_fn('assign_delivery_courier',
  $f$if p_courier_user_id is not null and not exists ($f$,
  $f$if p_courier_user_id is distinct from v_do.courier_user_id and exists (
    select 1 from public.delivery_courier_advances a
    where a.company_id = v_do.company_id and a.delivery_order_id = v_do.id and a.status = 'open'
  ) then
    raise exception 'Este pedido tem troco adiantado ao entregador. Receba a devolução (ou faça o acerto) antes de trocar o entregador.' using errcode = 'PT409';
  end if;

  if p_courier_user_id is not null and not exists ($f$);

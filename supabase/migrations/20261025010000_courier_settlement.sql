-- FASE 4B — Recebimento pelo ENTREGADOR e ACERTO com o Caixa.
--
-- Cenário: cliente paga ao entregador na rua. "Recebido pelo entregador" NÃO é dinheiro do caixa: o valor fica em CUSTÓDIA do
-- entregador e só entra no financeiro oficial quando o Caixa faz o ACERTO. Nada aqui cria pagamento ou movimento de caixa na rua.
--
-- Modelo (sem financeiro paralelo, sem payment_status em delivery_orders):
--   delivery_courier_receipts     o que o entregador declarou ter recebido (1 vivo por pedido: held | settled; voided não conta)
--   delivery_courier_settlements  o acerto do Caixa (1 por client_request_id; guarda o resultado para réplica idempotente)
--   status financeiro OFICIAL continua derivado (delivery_financial_status): segue 'pending' enquanto o recibo está 'held';
--   vira 'paid' só depois do acerto, que reaproveita receive_delivery_order -> close_service_session (1 pagamento + 1 movimento).
--
-- Regras de custódia:
--   * courier registra SÓ o recebimento dos pedidos atribuídos a ele (courier_register_payment, idempotente por client_request_id);
--   * enquanto há recibo 'held', a sessão NÃO pode ser fechada por outro caminho (trigger) — nada de receber em dobro (Caixa + rua);
--     o acerto libera o fechamento por um sinalizador transacional que só a RPC de acerto liga;
--   * correção antes do acerto: owner/admin anulam o recibo (void_courier_receipt) com motivo; o histórico fica (status 'voided' + evento);
--     depois do acerto vale o estorno oficial (refund_service_payment);
--   * eventos de auditoria: courier_payment_received, courier_payment_voided, courier_settlement_completed.
-- Ordem de locks (sem deadlock): atendimento (service_sessions) -> recibo.
-- Fora desta fase: fiado, Pix automático, comissão/taxa do entregador, conciliação.

-- ---------------------------------------------------------------------------
-- 1) Eventos de auditoria
-- ---------------------------------------------------------------------------
alter table public.delivery_order_events drop constraint delivery_order_events_type_check;
alter table public.delivery_order_events add constraint delivery_order_events_type_check
  check (event_type in ('created', 'status_changed', 'courier_assigned', 'fee_overridden', 'canceled', 'payment_received',
                        'courier_payment_received', 'courier_payment_voided', 'courier_settlement_completed'));

-- ---------------------------------------------------------------------------
-- 2) Acertos e recibos
-- ---------------------------------------------------------------------------
create table public.delivery_courier_settlements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  courier_user_id uuid not null references auth.users(id) on delete restrict,
  client_request_id uuid not null,
  settled_by uuid not null references auth.users(id) on delete restrict,
  receipt_count integer not null constraint delivery_courier_settlements_count_check check (receipt_count between 1 and 100),
  total_amount numeric(12, 2) not null constraint delivery_courier_settlements_total_check check (total_amount > 0 and total_amount <> 'NaN'::numeric),
  result jsonb not null,
  created_at timestamptz not null default now(),
  constraint delivery_courier_settlements_request_key unique (company_id, client_request_id),
  constraint delivery_courier_settlements_company_id_id_key unique (company_id, id)
);

create table public.delivery_courier_receipts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  delivery_order_id uuid not null,
  service_session_id uuid not null,
  courier_user_id uuid not null references auth.users(id) on delete restrict,
  client_request_id uuid not null,
  payment_method text not null
    constraint delivery_courier_receipts_method_check check (payment_method in ('cash', 'pix', 'debit_card', 'credit_card', 'other')),
  -- valor APLICADO no pedido (é o que o Caixa vai lançar); dinheiro: sem o troco
  amount numeric(12, 2) not null constraint delivery_courier_receipts_amount_check check (amount > 0 and amount <> 'NaN'::numeric),
  amount_received numeric(12, 2),
  change_amount numeric(12, 2) not null default 0,
  note text constraint delivery_courier_receipts_note_length check (note is null or char_length(note) between 1 and 120),
  status text not null default 'held'
    constraint delivery_courier_receipts_status_check check (status in ('held', 'settled', 'voided')),
  received_at timestamptz not null default now(),
  settlement_id uuid,
  settled_at timestamptz,
  voided_at timestamptz,
  voided_by uuid references auth.users(id) on delete restrict,
  void_reason text constraint delivery_courier_receipts_void_reason_length check (void_reason is null or char_length(void_reason) between 1 and 200),
  created_at timestamptz not null default now(),
  constraint delivery_courier_receipts_cash_check check (
    (payment_method = 'cash' and amount_received is not null and amount_received >= amount and change_amount = amount_received - amount)
    or (payment_method <> 'cash' and amount_received is null and change_amount = 0)
  ),
  constraint delivery_courier_receipts_state_check check (
    (status = 'held' and settlement_id is null and settled_at is null and voided_at is null)
    or (status = 'settled' and settlement_id is not null and settled_at is not null and voided_at is null)
    or (status = 'voided' and voided_at is not null and void_reason is not null and settlement_id is null)
  ),
  constraint delivery_courier_receipts_order_fkey foreign key (company_id, delivery_order_id) references public.delivery_orders (company_id, id),
  constraint delivery_courier_receipts_session_fkey foreign key (company_id, service_session_id) references public.service_sessions (company_id, id),
  constraint delivery_courier_receipts_settlement_fkey foreign key (company_id, settlement_id) references public.delivery_courier_settlements (company_id, id),
  constraint delivery_courier_receipts_request_key unique (company_id, client_request_id),
  constraint delivery_courier_receipts_company_id_id_key unique (company_id, id)
);
-- no máximo UM recibo VIVO (held ou settled) por pedido; anulado não conta (o entregador pode registrar de novo)
create unique index delivery_courier_receipts_one_live_idx on public.delivery_courier_receipts (company_id, delivery_order_id) where status in ('held', 'settled');
create index delivery_courier_receipts_held_idx on public.delivery_courier_receipts (company_id, courier_user_id, received_at) where status = 'held';
create index delivery_courier_receipts_session_idx on public.delivery_courier_receipts (company_id, service_session_id);

-- imutabilidade: identidade/valores não mudam; só held -> settled | voided (nunca volta); sem DELETE (exceto cascata da empresa)
create function public.guard_courier_receipt_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then
      return old;
    end if;
    raise exception 'Recebimentos do entregador não podem ser apagados.' using errcode = 'PT409';
  end if;
  if new.company_id is distinct from old.company_id or new.delivery_order_id is distinct from old.delivery_order_id
     or new.service_session_id is distinct from old.service_session_id or new.courier_user_id is distinct from old.courier_user_id
     or new.client_request_id is distinct from old.client_request_id or new.payment_method is distinct from old.payment_method
     or new.amount is distinct from old.amount or new.amount_received is distinct from old.amount_received
     or new.change_amount is distinct from old.change_amount or new.note is distinct from old.note
     or new.received_at is distinct from old.received_at or new.created_at is distinct from old.created_at then
    raise exception 'O recebimento do entregador não pode ser alterado.' using errcode = 'PT409';
  end if;
  if old.status <> 'held' and new.status is distinct from old.status then
    raise exception 'Este recebimento já foi encerrado (%).', old.status using errcode = 'PT409';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_courier_receipt_change() from public, anon, authenticated, service_role;
create trigger delivery_courier_receipts_guard before update or delete on public.delivery_courier_receipts
  for each row execute function public.guard_courier_receipt_change();

create function public.guard_courier_settlement_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'Acertos de entregador são imutáveis.' using errcode = 'PT409';
end;
$$;
revoke execute on function public.guard_courier_settlement_immutable() from public, anon, authenticated, service_role;
create trigger delivery_courier_settlements_guard before update or delete on public.delivery_courier_settlements
  for each row execute function public.guard_courier_settlement_immutable();

-- RLS: leitura só; escrita exclusivamente pelas RPCs (SECURITY DEFINER)
alter table public.delivery_courier_receipts enable row level security;
alter table public.delivery_courier_settlements enable row level security;
revoke all on public.delivery_courier_receipts from public, anon, authenticated;
revoke all on public.delivery_courier_settlements from public, anon, authenticated;
grant select on public.delivery_courier_receipts to authenticated;
grant select on public.delivery_courier_settlements to authenticated;
grant all on public.delivery_courier_receipts to service_role;
grant all on public.delivery_courier_settlements to service_role;

create policy delivery_courier_receipts_select on public.delivery_courier_receipts
  for select to authenticated
  using (
    company_id in (select public.user_company_ids())
    and (
      public.user_role_in_company(company_id) in ('owner', 'admin', 'cashier')
      or (public.user_role_in_company(company_id) = 'courier' and courier_user_id = auth.uid())
    )
  );
create policy delivery_courier_settlements_select on public.delivery_courier_settlements
  for select to authenticated
  using (company_id in (select public.user_company_ids()) and public.user_role_in_company(company_id) in ('owner', 'admin', 'cashier'));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'delivery_courier_receipts') then
    alter publication supabase_realtime add table public.delivery_courier_receipts;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3) Guarda de custódia: sessão com recibo 'held' NÃO fecha por outro caminho (Caixa direto, cancelamento...)
-- ---------------------------------------------------------------------------
create function public.guard_custody_session_close()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status = 'open' and new.status = 'closed' and old.kind = 'delivery'
     and coalesce(current_setting('gap.courier_settlement', true), '') <> 'on'
     and exists (select 1 from public.delivery_courier_receipts r
                  where r.company_id = old.company_id and r.service_session_id = old.id and r.status = 'held') then
    raise exception 'Este pedido tem um recebimento do entregador aguardando acerto. Faça o acerto do entregador (ou peça a um administrador para anular o recebimento).' using errcode = 'PT409';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_custody_session_close() from public, anon, authenticated, service_role;
create trigger service_sessions_custody_guard before update of status on public.service_sessions
  for each row execute function public.guard_custody_session_close();

-- ---------------------------------------------------------------------------
-- 4) Helpers internos
-- ---------------------------------------------------------------------------
create function public.delivery_total(p_company_id uuid, p_delivery_order_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select case when d.delivery_status = 'canceled' then 0::numeric
              else coalesce((select sum((i.quantity - i.cancelled_quantity) * i.unit_price) from public.service_order_items i
                              where i.company_id = d.company_id and i.order_id = d.service_order_id), 0) + d.delivery_fee end
    from public.delivery_orders d where d.company_id = p_company_id and d.id = p_delivery_order_id;
$$;
revoke execute on function public.delivery_total(uuid, uuid) from public, anon, authenticated, service_role;

-- recibo 'held' do pedido, em JSON (ou null): usado pelas leituras do Delivery e do Caixa
create function public.delivery_custody_json(p_company_id uuid, p_delivery_order_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('receipt_id', r.id, 'courier_user_id', r.courier_user_id, 'courier_name', pr.full_name,
                            'method', r.payment_method, 'amount', r.amount, 'amount_received', r.amount_received,
                            'change_amount', r.change_amount, 'received_at', r.received_at)
    from public.delivery_courier_receipts r
    left join public.profiles pr on pr.user_id = r.courier_user_id
   where r.company_id = p_company_id and r.delivery_order_id = p_delivery_order_id and r.status = 'held';
$$;
revoke execute on function public.delivery_custody_json(uuid, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5) Entregador registra o recebimento (custódia; NADA entra no caixa)
-- ---------------------------------------------------------------------------
create function public.courier_register_payment(
  p_delivery_order_id uuid, p_method text, p_amount_received numeric, p_client_request_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_do public.delivery_orders;
  v_role public.company_role;
  v_session public.service_sessions;
  v_old public.delivery_courier_receipts;
  v_total numeric(12, 2);
  v_received numeric(12, 2);
  v_change numeric(12, 2) := 0;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_rec public.delivery_courier_receipts;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if p_client_request_id is null then
    raise exception 'Pedido de recebimento inválido.' using errcode = 'PT400';
  end if;
  select * into v_do from public.delivery_orders where id = p_delivery_order_id;
  if not found then
    raise exception 'Pedido de delivery não encontrado.' using errcode = 'PT404';
  end if;
  v_role := public.user_role_in_company(v_do.company_id);
  if v_role is null or v_do.courier_user_id is distinct from auth.uid() then
    -- mesmo erro para "não existe" e "é de outro entregador": nada vaza
    if v_role is not null and v_role <> 'courier' then
      raise exception 'Somente o entregador atribuído registra o recebimento na entrega.' using errcode = 'PT403';
    end if;
    raise exception 'Pedido de delivery não encontrado.' using errcode = 'PT404';
  end if;
  perform public.assert_company_module(v_do.company_id, 'delivery');

  -- atendimento primeiro (mesma ordem do fechamento, do acerto e do cancelamento)
  select * into v_session from public.service_sessions where company_id = v_do.company_id and id = v_do.service_session_id for update;
  select * into v_do from public.delivery_orders where id = p_delivery_order_id for update;

  -- réplica idempotente: mesmo request => o recebimento já registrado
  select * into v_old from public.delivery_courier_receipts where company_id = v_do.company_id and client_request_id = p_client_request_id;
  if found then
    if v_old.delivery_order_id <> v_do.id or v_old.courier_user_id <> auth.uid() then
      raise exception 'Pedido de recebimento inválido.' using errcode = 'PT409';
    end if;
    return jsonb_build_object('receipt_id', v_old.id, 'delivery_order_id', v_do.id, 'replayed', true, 'status', v_old.status,
                              'method', v_old.payment_method, 'amount', v_old.amount, 'amount_received', v_old.amount_received,
                              'change_amount', v_old.change_amount, 'received_at', v_old.received_at);
  end if;

  if v_do.fulfillment <> 'delivery' then
    raise exception 'Retirada não tem recebimento pelo entregador.' using errcode = 'PT409';
  end if;
  if v_do.delivery_status not in ('out_for_delivery', 'delivered') then
    raise exception 'O recebimento só pode ser registrado com o pedido em rota ou entregue.' using errcode = 'PT409';
  end if;
  if v_session.status <> 'open' then
    raise exception 'Pagamento já recebido: este pedido já foi pago no Caixa.' using errcode = 'PT409';
  end if;
  if exists (select 1 from public.delivery_courier_receipts r where r.company_id = v_do.company_id and r.delivery_order_id = v_do.id and r.status in ('held', 'settled')) then
    raise exception 'O recebimento deste pedido já foi registrado.' using errcode = 'PT409';
  end if;
  if p_method is null or p_method not in ('cash', 'pix', 'debit_card', 'credit_card', 'other') then
    raise exception 'Forma de pagamento inválida.' using errcode = 'PT400';
  end if;
  if v_note is not null and char_length(v_note) > 120 then
    raise exception 'A observação pode ter no máximo 120 caracteres.' using errcode = 'PT400';
  end if;

  v_total := public.delivery_total(v_do.company_id, v_do.id);
  if coalesce(v_total, 0) <= 0 then
    raise exception 'Este pedido não tem valor a receber.' using errcode = 'PT409';
  end if;
  if p_method = 'cash' then
    v_received := coalesce(p_amount_received, v_total);
    if v_received < v_total or v_received >= 10000000000 or v_received <> round(v_received, 2) then
      raise exception 'O valor recebido em dinheiro deve ser igual ou maior que o total do pedido (com até 2 casas decimais).' using errcode = 'PT400';
    end if;
    v_change := v_received - v_total;
  else
    if p_amount_received is not null then
      raise exception 'Só o pagamento em dinheiro tem valor recebido e troco.' using errcode = 'PT400';
    end if;
    v_received := null;
  end if;

  insert into public.delivery_courier_receipts (company_id, delivery_order_id, service_session_id, courier_user_id, client_request_id,
                                                payment_method, amount, amount_received, change_amount, note)
  values (v_do.company_id, v_do.id, v_do.service_session_id, auth.uid(), p_client_request_id, p_method, v_total, v_received, v_change, v_note)
  returning * into v_rec;

  insert into public.delivery_order_events (company_id, delivery_order_id, event_type, actor_user_id, old_value, new_value)
  values (v_do.company_id, v_do.id, 'courier_payment_received', auth.uid(),
          jsonb_build_object('expected_method', v_do.expected_method, 'cash_change_for', v_do.cash_change_for),
          jsonb_build_object('receipt_id', v_rec.id, 'method', p_method, 'amount', v_total, 'change_amount', v_change, 'client_request_id', p_client_request_id));

  return jsonb_build_object('receipt_id', v_rec.id, 'delivery_order_id', v_do.id, 'replayed', false, 'status', 'held',
                            'method', v_rec.payment_method, 'amount', v_rec.amount, 'amount_received', v_rec.amount_received,
                            'change_amount', v_rec.change_amount, 'received_at', v_rec.received_at);
end;
$$;
revoke execute on function public.courier_register_payment(uuid, text, numeric, uuid, text) from public, anon;
grant execute on function public.courier_register_payment(uuid, text, numeric, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6) Caixa: lista de acertos pendentes (por entregador)
-- ---------------------------------------------------------------------------
create function public.list_courier_settlements(p_company_id uuid)
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
          'received_at', r.received_at, 'delivery_status', d.delivery_status) order by r.received_at, r.id)
      ) as j
    from public.delivery_courier_receipts r
    join public.delivery_orders d on d.company_id = r.company_id and d.id = r.delivery_order_id
    left join public.profiles pr on pr.user_id = r.courier_user_id
    where r.company_id = p_company_id and r.status = 'held'
    group by r.courier_user_id
  ) c;
  return v_result;
end;
$$;
revoke execute on function public.list_courier_settlements(uuid) from public, anon;
grant execute on function public.list_courier_settlements(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7) Caixa confirma o acerto: cada recibo entra no núcleo oficial (receive_delivery_order -> close_service_session)
-- ---------------------------------------------------------------------------
create function public.settle_courier_receipts(p_company_id uuid, p_courier_user_id uuid, p_receipt_ids uuid[], p_client_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_ids uuid[];
  v_rows public.delivery_courier_receipts[];
  v_r public.delivery_courier_receipts;
  v_old public.delivery_courier_settlements;
  v_total numeric(12, 2) := 0;
  v_set uuid;
  v_orders jsonb := '[]'::jsonb;
  v_by jsonb;
  v_result jsonb;
  v_pay jsonb;
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

  if p_receipt_ids is null then
    select coalesce(array_agg(r.id order by r.id), '{}') into v_ids from public.delivery_courier_receipts r
     where r.company_id = p_company_id and r.courier_user_id = p_courier_user_id and r.status = 'held';
  else
    select coalesce(array_agg(distinct x order by x), '{}') into v_ids from unnest(p_receipt_ids) x;
  end if;
  if coalesce(array_length(v_ids, 1), 0) = 0 then
    -- sem nada a acertar: se for réplica de um acerto já feito, devolve; senão erro claro
    select * into v_old from public.delivery_courier_settlements where company_id = p_company_id and client_request_id = p_client_request_id;
    if found then
      return v_old.result || jsonb_build_object('replayed', true);
    end if;
    raise exception 'Não há recebimentos deste entregador aguardando acerto.' using errcode = 'PT409';
  end if;
  if array_length(v_ids, 1) > 100 then
    raise exception 'Acerte no máximo 100 recebimentos por vez.' using errcode = 'PT400';
  end if;

  -- locks na ordem: atendimentos -> recibos
  perform 1 from public.service_sessions s
   where s.company_id = p_company_id and s.id in (select r.service_session_id from public.delivery_courier_receipts r where r.company_id = p_company_id and r.id = any(v_ids))
   order by s.id for update;
  perform 1 from public.delivery_courier_receipts r where r.company_id = p_company_id and r.id = any(v_ids) order by r.id for update;
  select array_agg(r order by r.id) into v_rows from public.delivery_courier_receipts r where r.company_id = p_company_id and r.id = any(v_ids);

  -- réplica idempotente (conferida DEPOIS dos locks: um acerto concorrente igual já terminou)
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

  -- a partir daqui o fechamento das sessões é permitido (SÓ nesta transação)
  perform set_config('gap.courier_settlement', 'on', true);
  foreach v_r in array v_rows loop
    v_pay := case when v_r.payment_method = 'cash'
                  then jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', v_r.amount, 'amount_received', v_r.amount_received))
                  else jsonb_build_array(jsonb_build_object('method', v_r.payment_method, 'amount', v_r.amount)) end;
    -- núcleo oficial: total/caixa aberto (PT412)/troco/pagamento/movimento/fechamento; falha = tudo desfeito
    perform public.receive_delivery_order(v_r.delivery_order_id, v_pay, md5(p_client_request_id::text || ':' || v_r.id::text)::uuid);
  end loop;
  perform set_config('gap.courier_settlement', 'off', true);

  select jsonb_build_object('cash', coalesce(sum(x.amount) filter (where x.payment_method = 'cash'), 0), 'pix', coalesce(sum(x.amount) filter (where x.payment_method = 'pix'), 0),
                            'debit_card', coalesce(sum(x.amount) filter (where x.payment_method = 'debit_card'), 0),
                            'credit_card', coalesce(sum(x.amount) filter (where x.payment_method = 'credit_card'), 0),
                            'other', coalesce(sum(x.amount) filter (where x.payment_method = 'other'), 0))
    into v_by from unnest(v_rows) x;
  select jsonb_agg(jsonb_build_object('delivery_order_id', x.delivery_order_id, 'short_code', upper(left(replace(x.delivery_order_id::text, '-', ''), 6)),
                                      'method', x.payment_method, 'amount', x.amount) order by x.received_at, x.id)
    into v_orders from unnest(v_rows) x;
  v_result := jsonb_build_object('courier_user_id', p_courier_user_id, 'receipt_count', array_length(v_ids, 1), 'total_amount', v_total,
                                 'by_method', v_by, 'orders', v_orders, 'replayed', false);

  insert into public.delivery_courier_settlements (company_id, courier_user_id, client_request_id, settled_by, receipt_count, total_amount, result)
  values (p_company_id, p_courier_user_id, p_client_request_id, auth.uid(), array_length(v_ids, 1), v_total, v_result - 'replayed')
  returning id into v_set;

  update public.delivery_courier_receipts set status = 'settled', settlement_id = v_set, settled_at = now() where company_id = p_company_id and id = any(v_ids);
  foreach v_r in array v_rows loop
    insert into public.delivery_order_events (company_id, delivery_order_id, event_type, actor_user_id, new_value)
    values (p_company_id, v_r.delivery_order_id, 'courier_settlement_completed', auth.uid(),
            jsonb_build_object('settlement_id', v_set, 'receipt_id', v_r.id, 'courier_user_id', p_courier_user_id, 'method', v_r.payment_method, 'amount', v_r.amount));
  end loop;

  return v_result || jsonb_build_object('settlement_id', v_set);
end;
$$;
revoke execute on function public.settle_courier_receipts(uuid, uuid, uuid[], uuid) from public, anon;
grant execute on function public.settle_courier_receipts(uuid, uuid, uuid[], uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 8) Correção antes do acerto (owner/admin): anula o recibo, com motivo; o histórico fica
-- ---------------------------------------------------------------------------
create function public.void_courier_receipt(p_receipt_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_r public.delivery_courier_receipts;
  v_role public.company_role;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_r from public.delivery_courier_receipts where id = p_receipt_id;
  if not found then
    raise exception 'Recebimento não encontrado.' using errcode = 'PT404';
  end if;
  v_role := public.user_role_in_company(v_r.company_id);
  if v_role is null then
    raise exception 'Recebimento não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Somente donos(as) e administradores(as) anulam um recebimento do entregador.' using errcode = 'PT403';
  end if;
  perform public.assert_company_module(v_r.company_id, 'delivery');
  if v_reason is null or char_length(v_reason) > 200 then
    raise exception 'Informe o motivo (até 200 caracteres).' using errcode = 'PT400';
  end if;

  perform 1 from public.service_sessions where company_id = v_r.company_id and id = v_r.service_session_id for update;
  select * into v_r from public.delivery_courier_receipts where id = p_receipt_id for update;
  if v_r.status = 'voided' then
    return jsonb_build_object('receipt_id', v_r.id, 'status', 'voided', 'replayed', true);
  end if;
  if v_r.status = 'settled' then
    raise exception 'Este recebimento já foi acertado no Caixa. Para corrigir, use o estorno do pagamento.' using errcode = 'PT409';
  end if;

  update public.delivery_courier_receipts set status = 'voided', voided_at = now(), voided_by = auth.uid(), void_reason = v_reason where id = v_r.id;
  insert into public.delivery_order_events (company_id, delivery_order_id, event_type, actor_user_id, new_value, note)
  values (v_r.company_id, v_r.delivery_order_id, 'courier_payment_voided', auth.uid(),
          jsonb_build_object('receipt_id', v_r.id, 'courier_user_id', v_r.courier_user_id, 'method', v_r.payment_method, 'amount', v_r.amount), left(v_reason, 300));
  return jsonb_build_object('receipt_id', v_r.id, 'status', 'voided', 'replayed', false);
end;
$$;
revoke execute on function public.void_courier_receipt(uuid, text) from public, anon;
grant execute on function public.void_courier_receipt(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 9) Leituras: custódia do entregador em list_delivery_orders e list_delivery_receivables (corpos da 4A + 1 chave)
-- ---------------------------------------------------------------------------
create or replace function public.list_delivery_orders(
  p_company_id uuid,
  p_from date default null,
  p_to date default null,
  p_fulfillment text default null,
  p_status text default null,
  p_courier_user_id uuid default null,
  p_customer_id uuid default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_from date := coalesce(p_from, (now() at time zone 'America/Sao_Paulo')::date);
  v_to date := coalesce(p_to, coalesce(p_from, (now() at time zone 'America/Sao_Paulo')::date));
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_result jsonb;
begin
  v_role := public.delivery_assert_actor(p_company_id);
  if v_to < v_from then
    raise exception 'Período inválido.' using errcode = 'PT400';
  end if;
  if v_to - v_from > 62 then
    raise exception 'O período pode ter no máximo 63 dias.' using errcode = 'PT400';
  end if;
  if p_fulfillment is not null and p_fulfillment not in ('delivery', 'pickup') then
    raise exception 'Tipo inválido.' using errcode = 'PT400';
  end if;
  if p_status is not null and p_status not in ('confirmed', 'out_for_delivery', 'delivered', 'picked_up', 'canceled') then
    raise exception 'Estado inválido.' using errcode = 'PT400';
  end if;

  select coalesce(jsonb_agg(x.j order by x.created_at desc, x.id), '[]'::jsonb) into v_result
  from (
    select d.id, d.created_at,
      jsonb_build_object(
        'id', d.id,
        'service_session_id', d.service_session_id,
        'service_order_id', d.service_order_id,
        'fulfillment', d.fulfillment,
        'delivery_status', d.delivery_status,
        'production', case
            when a.active = 0 then null
            when a.ready = a.active then 'ready'
            when a.preparing > 0 or a.ready > 0 then 'preparing'
            else 'pending' end,
        'items_active', a.active,
        'items_ready', a.ready,
        'customer_id', d.customer_id,
        'customer_name', d.customer_name,
        'customer_phone', d.customer_phone,
        'address', case when d.fulfillment = 'delivery' then jsonb_build_object(
            'street', d.addr_street, 'number', d.addr_number, 'complement', d.addr_complement,
            'neighborhood', d.addr_neighborhood, 'city', d.addr_city, 'state', d.addr_state,
            'cep', d.addr_cep, 'reference', d.addr_reference) end,
        'delivery_fee', d.delivery_fee,
        'fee_source', d.fee_source,
        'items_subtotal', a.subtotal,
        'total', case when d.delivery_status = 'canceled' then 0 else a.subtotal + d.delivery_fee end,
        'estimated_ready_at', d.estimated_ready_at,
        'estimated_delivery_at', d.estimated_delivery_at,
        'payment_timing', d.payment_timing,
        'expected_method', d.expected_method,
        'cash_change_for', d.cash_change_for,
        'courier_user_id', d.courier_user_id,
        'courier_name', pr.full_name,
        'out_for_delivery_at', d.out_for_delivery_at,
        'delivered_at', d.delivered_at,
        'picked_up_at', d.picked_up_at,
        'canceled_at', d.canceled_at,
        'cancel_reason', d.cancel_reason,
        'notes', d.notes,
        'session_status', ss.status,
        -- financeiro DERIVADO do estado oficial da sessão/pagamentos (nada é gravado no pedido)
        'financial_status', public.delivery_financial_status(d.company_id, d.service_session_id, d.delivery_status, ss.status,
            case when d.delivery_status = 'canceled' then 0 else a.subtotal + d.delivery_fee end),
        'paid_amount', coalesce((select sum(p.amount) from public.service_payments p where p.company_id = d.company_id and p.service_session_id = d.service_session_id), 0),
        -- valor em CUSTÓDIA do entregador (recebido na rua, ainda NÃO acertado no Caixa); o financeiro oficial segue 'pending'
        'courier_custody', public.delivery_custody_json(d.company_id, d.id),
        'created_at', d.created_at
      ) as j
    from public.delivery_orders d
    join public.service_sessions ss on ss.company_id = d.company_id and ss.id = d.service_session_id
    left join public.profiles pr on pr.user_id = d.courier_user_id
    cross join lateral (
      select count(*) filter (where i.quantity > i.cancelled_quantity)::integer as active,
             count(*) filter (where i.quantity > i.cancelled_quantity and i.production_status = 'ready')::integer as ready,
             count(*) filter (where i.quantity > i.cancelled_quantity and i.production_status = 'preparing')::integer as preparing,
             coalesce(sum((i.quantity - i.cancelled_quantity) * i.unit_price), 0)::numeric(12, 2) as subtotal
      from public.service_order_items i
      where i.company_id = d.company_id and i.order_id = d.service_order_id
    ) a
    where d.company_id = p_company_id
      and d.created_at >= (v_from::timestamp at time zone 'America/Sao_Paulo')
      and d.created_at < ((v_to + 1)::timestamp at time zone 'America/Sao_Paulo')
      and (v_role <> 'courier' or d.courier_user_id = auth.uid())
      and (p_fulfillment is null or d.fulfillment = p_fulfillment)
      and (p_status is null or d.delivery_status = p_status)
      and (p_courier_user_id is null or d.courier_user_id = p_courier_user_id)
      and (p_customer_id is null or d.customer_id = p_customer_id)
    order by d.created_at desc, d.id
    limit v_limit offset v_offset
  ) x;

  return v_result;
end;
$$;


create or replace function public.list_delivery_receivables(p_company_id uuid, p_paid_hours integer default 24)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_hours integer := least(greatest(coalesce(p_paid_hours, 24), 0), 168);
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
    raise exception 'Você não tem permissão para ver as contas de delivery e retirada.' using errcode = 'PT403';
  end if;
  perform public.assert_company_module(p_company_id, 'delivery');

  select coalesce(jsonb_agg(x.j order by x.sort_group, x.sort_at, x.id), '[]'::jsonb) into v_result
  from (
    select q.id, q.sort_group, q.sort_at,
      jsonb_build_object(
        'delivery_order_id', q.id,
        'service_session_id', q.service_session_id,
        'short_code', upper(left(replace(q.id::text, '-', ''), 6)),
        'fulfillment', q.fulfillment,
        'delivery_status', q.delivery_status,
        'customer_name', q.customer_name,
        'customer_phone', q.customer_phone,
        'items_subtotal', q.subtotal,
        'delivery_fee', case when q.delivery_status = 'canceled' then 0 else q.delivery_fee end,
        'total', q.total,
        'payment_timing', q.payment_timing,
        'expected_method', q.expected_method,
        'cash_change_for', q.cash_change_for,
        'financial_status', q.fin,
        'paid_amount', q.paid,
        'refunded_amount', q.refunded,
        'session_status', q.session_status,
        'created_at', q.created_at,
        'delivered_at', q.delivered_at,
        'picked_up_at', q.picked_up_at,
        'closed_at', q.closed_at,
        'courier_custody', public.delivery_custody_json(p_company_id, q.id)
      ) as j
    from (
      select d.id, d.service_session_id, d.fulfillment, d.delivery_status, d.customer_name, d.customer_phone, d.delivery_fee,
             d.payment_timing, d.expected_method, d.cash_change_for, d.created_at, d.delivered_at, d.picked_up_at,
             ss.status as session_status, ss.closed_at, a.subtotal,
             case when d.delivery_status = 'canceled' then 0 else a.subtotal + d.delivery_fee end as total,
             public.delivery_financial_status(d.company_id, d.service_session_id, d.delivery_status, ss.status,
               case when d.delivery_status = 'canceled' then 0 else a.subtotal + d.delivery_fee end) as fin,
             coalesce((select sum(p.amount) from public.service_payments p where p.company_id = d.company_id and p.service_session_id = d.service_session_id), 0) as paid,
             coalesce((select sum(r.amount) from public.service_refunds r where r.company_id = d.company_id and r.service_session_id = d.service_session_id), 0) as refunded,
             -- pendentes: já entregues/retirados primeiro, depois os mais antigos; pagos: mais recentes primeiro
             case when ss.status = 'open' then (case when d.delivery_status in ('delivered', 'picked_up') then 0 else 1 end) else 2 end as sort_group,
             case when ss.status = 'open' then extract(epoch from d.created_at) else -extract(epoch from ss.closed_at) end as sort_at
      from public.delivery_orders d
      join public.service_sessions ss on ss.company_id = d.company_id and ss.id = d.service_session_id
      cross join lateral (
        select coalesce(sum((i.quantity - i.cancelled_quantity) * i.unit_price), 0)::numeric(12, 2) as subtotal
        from public.service_order_items i
        where i.company_id = d.company_id and i.order_id = d.service_order_id
      ) a
      where d.company_id = p_company_id
        and ss.kind = 'delivery'
        and d.delivery_status <> 'canceled'
        and (ss.status = 'open' or ss.closed_at >= now() - make_interval(hours => v_hours))
    ) q
    where q.fin in ('pending', 'paid', 'refunded')
    limit 300
  ) x;

  return v_result;
end;
$$;


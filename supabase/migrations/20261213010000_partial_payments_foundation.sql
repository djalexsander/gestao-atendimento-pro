-- =============================================================================
-- PAGAMENTOS PARCIAIS E DIVISÃO DE CONTAS — ETAPA E1: FUNDAÇÃO DE ESQUEMA (aditiva)
-- =============================================================================
-- SÓ ESQUEMA. Nenhuma RPC existente é alterada (close_service_session, refund_service_payment,
-- cancel_service_order_item, submit_service_order, receive_delivery_order ficam byte a byte como estão) e nenhuma RPC
-- nova é criada aqui: o comportamento financeiro do sistema NÃO muda com esta migration. As RPCs que usam estas
-- estruturas vêm nas etapas E2..E8 (cada uma com a sua autorização).
--
-- DECISÕES (aprovadas):
--   * estorno só por owner/admin (estrutura já existente em service_refunds); a forma de pagamento do estorno é a do
--     pagamento original (derivada de service_payment_id; nunca escolhida);
--   * delivery/retirada ficam FORA dos pagamentos parciais: a divisão e suas partes só existem em atendimento de
--     comanda/mesa (service_sessions.kind = 'point') — travado no banco por gatilho;
--   * o SALDO nunca é gravado: saldo = total vigente da conta - (pagamentos - estornos que recompõem saldo). O total
--     já é calculado na hora pelo servidor (itens não cancelados + taxa); novos pedidos e cancelamentos mexem no saldo
--     sozinhos (E7 cuida das travas de negócio);
--   * valores NÃO distribuídos na divisão ficam visíveis: planned_amount das partes é o PREVISTO; a diferença para o
--     total é calculada na leitura (E2), nunca escondida;
--   * a conta só encerra com saldo zero (E8, em close_service_session).
--
-- MODELO
--   service_payments.client_request_id        idempotência do pagamento (nulo nos pagamentos históricos)
--   service_refunds.client_request_id         idempotência do estorno (nulo nos históricos)
--   service_refunds.restores_balance          true = estorno de conta ABERTA (recompõe o saldo); false = estorno de conta
--                                             FECHADA (comportamento atual: a conta continua fechada). Todo estorno
--                                             histórico fica false (default) — o gatilho garante que combina com o status.
--   service_session_splits                    uma divisão da conta (igual | valores | produtos), versionada; uma ativa
--   service_session_parts                     as partes de uma divisão (imutáveis: refazer = nova versão)
--   service_session_part_items                só no modo produtos: item do pedido x quantidade de cada parte
--   service_payment_allocations               quanto de cada pagamento foi para cada parte (pagar menos que a parte =
--                                             alocação menor; excedente = alocações em outras partes)
--   service_refund_allocations                a reversão nas partes quando o estorno recompõe saldo
--   service_session_events                    trilha de auditoria append-only das operações financeiras da conta
--
-- ESTORNO x CAIXA (revisão): service_refunds.cash_session_id = caixa que DEVOLVE o dinheiro (o do operador que estorna,
-- como hoje); o caixa ORIGINAL é service_payments.cash_session_id (via service_payment_id). O movimento físico é o
-- cash_movements 'refund' lançado no caixa que devolve, na forma do pagamento original; um estorno em dinheiro só
-- pode sair da gaveta do caixa que devolve (cash_session_physical_cash). O caixa original, se já fechado, NÃO é
-- alterado (conferência e diferença ficam como foram contadas). Nada disso exigiu coluna nova.
--
-- COMPATIBILIDADE: tudo é aditivo (colunas nulas/default, tabelas novas, gatilhos que as RPCs atuais já respeitam).
-- Sem backfill, sem UPDATE em dado existente. Pagamentos e estornos históricos seguem válidos e sem alocações:
-- leem-se como "conta inteira".
-- ROLLBACK: supabase/rollbacks/partial-payments-foundation/rollback.sql (com trava: recusa se já houver dado novo).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Idempotência e semântica nos pagamentos/estornos existentes
-- ---------------------------------------------------------------------------
alter table public.service_payments add column client_request_id uuid;
create unique index service_payments_request_key
  on public.service_payments (company_id, client_request_id)
  where client_request_id is not null;
comment on column public.service_payments.client_request_id is
  'Idempotência do registro de pagamento parcial (E3): o mesmo identificador nunca vira dois pagamentos. NULL nos pagamentos de fechamento antigos.';

alter table public.service_refunds
  add column client_request_id uuid,
  add column restores_balance boolean not null default false;
create unique index service_refunds_request_key
  on public.service_refunds (company_id, client_request_id)
  where client_request_id is not null;
comment on column public.service_refunds.client_request_id is
  'Idempotência do estorno (E6). NULL nos estornos históricos.';
comment on column public.service_refunds.restores_balance is
  'true: estorno de conta ABERTA, devolve o valor ao saldo pendente. false: estorno de conta fechada (a conta segue fechada). Coerente com o status da conta por gatilho.';

-- ---------------------------------------------------------------------------
-- 2) Divisão da conta (versionada) e suas partes
-- ---------------------------------------------------------------------------
create table public.service_session_splits (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  service_session_id uuid not null,
  mode text not null
    constraint service_session_splits_mode_check check (mode in ('equal', 'values', 'products')),
  -- 1, 2, 3... sem buracos (gatilho): é também o controle de concorrência otimista das RPCs de divisão.
  version integer not null
    constraint service_session_splits_version_check check (version >= 1),
  status text not null default 'active'
    constraint service_session_splits_status_check check (status in ('active', 'superseded')),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  superseded_at timestamptz,
  constraint service_session_splits_superseded_check check (
    (status = 'active' and superseded_at is null) or (status = 'superseded' and superseded_at is not null)
  ),
  constraint service_session_splits_session_fkey
    foreign key (company_id, service_session_id) references public.service_sessions (company_id, id),
  constraint service_session_splits_company_id_id_key unique (company_id, id),
  constraint service_session_splits_company_id_id_session_key unique (company_id, id, service_session_id),
  constraint service_session_splits_version_key unique (company_id, service_session_id, version)
);
-- no máximo UMA divisão ativa por conta
create unique index service_session_splits_one_active_idx
  on public.service_session_splits (company_id, service_session_id) where status = 'active';
create index service_session_splits_created_by_idx on public.service_session_splits (created_by);

create table public.service_session_parts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  split_id uuid not null,
  service_session_id uuid not null,
  position integer not null
    constraint service_session_parts_position_check check (position between 1 and 50),
  label text not null
    constraint service_session_parts_label_check check (char_length(btrim(label)) between 1 and 40),
  -- Valor PREVISTO da parte (reais). Imutável: mudar a divisão = nova versão, com as partes pagas preservadas na antiga.
  planned_amount numeric(12, 2) not null
    constraint service_session_parts_amount_check check (planned_amount > 0 and planned_amount < 10000000000 and planned_amount <> 'NaN'::numeric),
  created_at timestamptz not null default now(),
  -- a parte é da MESMA conta e da MESMA empresa da divisão
  constraint service_session_parts_split_fkey
    foreign key (company_id, split_id, service_session_id)
    references public.service_session_splits (company_id, id, service_session_id),
  constraint service_session_parts_company_id_id_key unique (company_id, id),
  constraint service_session_parts_company_id_id_session_key unique (company_id, id, service_session_id),
  constraint service_session_parts_position_key unique (split_id, position)
);
create index service_session_parts_session_idx on public.service_session_parts (company_id, service_session_id);

create table public.service_session_part_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  part_id uuid not null,
  service_session_id uuid not null,
  service_order_item_id uuid not null,
  quantity integer not null
    constraint service_session_part_items_quantity_check check (quantity > 0),
  created_at timestamptz not null default now(),
  constraint service_session_part_items_part_fkey
    foreign key (company_id, part_id, service_session_id)
    references public.service_session_parts (company_id, id, service_session_id),
  constraint service_session_part_items_item_fkey
    foreign key (company_id, service_order_item_id) references public.service_order_items (company_id, id),
  constraint service_session_part_items_key unique (part_id, service_order_item_id)
);
create index service_session_part_items_item_idx on public.service_session_part_items (company_id, service_order_item_id);

-- ---------------------------------------------------------------------------
-- 3) Alocações: de que parte é cada pagamento / estorno
-- ---------------------------------------------------------------------------
create table public.service_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  service_payment_id uuid not null,
  part_id uuid not null,
  service_session_id uuid not null,
  amount numeric(12, 2) not null
    constraint service_payment_allocations_amount_check check (amount > 0 and amount < 10000000000 and amount <> 'NaN'::numeric),
  created_at timestamptz not null default now(),
  constraint service_payment_allocations_payment_fkey
    foreign key (company_id, service_payment_id) references public.service_payments (company_id, id),
  constraint service_payment_allocations_part_fkey
    foreign key (company_id, part_id, service_session_id)
    references public.service_session_parts (company_id, id, service_session_id),
  constraint service_payment_allocations_key unique (service_payment_id, part_id)
);
create index service_payment_allocations_part_idx on public.service_payment_allocations (company_id, part_id);

create table public.service_refund_allocations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  service_refund_id uuid not null,
  part_id uuid not null,
  service_session_id uuid not null,
  amount numeric(12, 2) not null
    constraint service_refund_allocations_amount_check check (amount > 0 and amount < 10000000000 and amount <> 'NaN'::numeric),
  created_at timestamptz not null default now(),
  constraint service_refund_allocations_refund_fkey
    foreign key (company_id, service_refund_id) references public.service_refunds (company_id, id),
  constraint service_refund_allocations_part_fkey
    foreign key (company_id, part_id, service_session_id)
    references public.service_session_parts (company_id, id, service_session_id),
  constraint service_refund_allocations_key unique (service_refund_id, part_id)
);
create index service_refund_allocations_part_idx on public.service_refund_allocations (company_id, part_id);

-- ---------------------------------------------------------------------------
-- 4) Auditoria financeira da conta (append-only)
-- ---------------------------------------------------------------------------
create table public.service_session_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  service_session_id uuid not null,
  event_type text not null
    constraint service_session_events_type_check check (event_type in (
      'split_created', 'split_replaced', 'payment_registered', 'payment_refunded', 'session_closed'
    )),
  actor_id uuid not null references auth.users(id) on delete restrict,
  request_id uuid,
  payload jsonb not null default '{}'::jsonb
    constraint service_session_events_payload_check check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  constraint service_session_events_session_fkey
    foreign key (company_id, service_session_id) references public.service_sessions (company_id, id)
);
create index service_session_events_session_idx on public.service_session_events (company_id, service_session_id, created_at);
create index service_session_events_actor_idx on public.service_session_events (actor_id);
-- o mesmo pedido (request_id) não gera o mesmo evento duas vezes
create unique index service_session_events_request_key
  on public.service_session_events (company_id, event_type, request_id) where request_id is not null;

-- ---------------------------------------------------------------------------
-- 5) Travas de integridade (gatilhos). SECURITY DEFINER só para LER as tabelas relacionadas sem depender do RLS de
--    quem escreve; EXECUTE fechado (só o gatilho roda).
-- ---------------------------------------------------------------------------

-- 5a) Imutável (append-only): partes, itens de parte, alocações, eventos.
create function public.partial_payments_guard_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'Registro financeiro imutável: não pode ser alterado nem apagado.' using errcode = 'PT409';
end;
$$;

-- 5b) Divisão: só a transição ativa -> substituída (e nada mais); nunca apagar.
create function public.partial_payments_guard_split_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Uma divisão de conta não pode ser apagada.' using errcode = 'PT409';
  end if;
  if old.status = 'active' and new.status = 'superseded' and new.superseded_at is not null
     and new.id = old.id and new.company_id = old.company_id and new.service_session_id = old.service_session_id
     and new.mode = old.mode and new.version = old.version and new.created_by = old.created_by
     and new.created_at = old.created_at then
    return new;
  end if;
  raise exception 'Uma divisão só pode passar de ativa para substituída.' using errcode = 'PT409';
end;
$$;

-- 5c) Nova divisão: conta aberta, de comanda/mesa (delivery fica fora) e versão = última + 1.
create function public.partial_payments_guard_split_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.service_sessions;
  v_last integer;
begin
  select * into v_session from public.service_sessions where company_id = new.company_id and id = new.service_session_id;
  if v_session.status is distinct from 'open' then
    raise exception 'A divisão só existe em conta aberta.' using errcode = 'PT409';
  end if;
  if v_session.kind is distinct from 'point' then
    raise exception 'Delivery e retirada não têm divisão de conta nem pagamento parcial.' using errcode = 'PT409';
  end if;
  select coalesce(max(version), 0) into v_last
  from public.service_session_splits where company_id = new.company_id and service_session_id = new.service_session_id;
  if new.version <> v_last + 1 then
    raise exception 'Versão da divisão inválida (esperada %).', v_last + 1 using errcode = 'PT409';
  end if;
  return new;
end;
$$;

-- 5d) Parte nova: só numa divisão ATIVA de conta aberta.
create function public.partial_payments_guard_part_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_split public.service_session_splits;
  v_status text;
begin
  select * into v_split from public.service_session_splits where company_id = new.company_id and id = new.split_id;
  if v_split.status is distinct from 'active' then
    raise exception 'Só é possível incluir partes numa divisão ativa.' using errcode = 'PT409';
  end if;
  select status into v_status from public.service_sessions where company_id = new.company_id and id = new.service_session_id;
  if v_status is distinct from 'open' then
    raise exception 'A divisão só existe em conta aberta.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

-- 5e) Item de parte: o item é DA MESMA conta, a parte está numa divisão ativa e a soma das partes não passa da quantidade.
create function public.partial_payments_guard_part_item_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item_session uuid;
  v_qty integer;
  v_split_status text;
begin
  select o.service_session_id, i.quantity into v_item_session, v_qty
  from public.service_order_items i
  join public.service_orders o on o.company_id = i.company_id and o.id = i.order_id
  where i.company_id = new.company_id and i.id = new.service_order_item_id;
  if v_item_session is distinct from new.service_session_id then
    raise exception 'O item não pertence a esta conta.' using errcode = 'PT409';
  end if;
  select s.status into v_split_status
  from public.service_session_parts p
  join public.service_session_splits s on s.company_id = p.company_id and s.id = p.split_id
  where p.company_id = new.company_id and p.id = new.part_id;
  if v_split_status is distinct from 'active' then
    raise exception 'Só é possível atribuir itens a partes de uma divisão ativa.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

-- 5f) Soma das quantidades de um item nas partes da divisão ativa <= quantidade do item (checado ao fim da transação).
create function public.partial_payments_check_part_item_total()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_qty integer;
  v_sum integer;
begin
  select quantity into v_qty from public.service_order_items where company_id = new.company_id and id = new.service_order_item_id;
  select coalesce(sum(pi.quantity), 0) into v_sum
  from public.service_session_part_items pi
  join public.service_session_parts p on p.company_id = pi.company_id and p.id = pi.part_id
  join public.service_session_splits s on s.company_id = p.company_id and s.id = p.split_id and s.status = 'active'
  where pi.company_id = new.company_id and pi.service_order_item_id = new.service_order_item_id;
  if v_sum > v_qty then
    raise exception 'A quantidade atribuída às partes (%) passa da quantidade do item (%).', v_sum, v_qty using errcode = 'PT409';
  end if;
  return null;
end;
$$;

-- 5g) Alocação de pagamento: pagamento e parte da MESMA conta, conta aberta de comanda/mesa, parte de divisão ativa.
create function public.partial_payments_guard_payment_alloc_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pay_session uuid;
  v_session public.service_sessions;
  v_split_status text;
begin
  select service_session_id into v_pay_session from public.service_payments where company_id = new.company_id and id = new.service_payment_id;
  if v_pay_session is distinct from new.service_session_id then
    raise exception 'O pagamento não pertence à conta da parte.' using errcode = 'PT409';
  end if;
  select * into v_session from public.service_sessions where company_id = new.company_id and id = new.service_session_id;
  if v_session.status is distinct from 'open' or v_session.kind is distinct from 'point' then
    raise exception 'Alocação de pagamento só existe em conta aberta de comanda/mesa.' using errcode = 'PT409';
  end if;
  select s.status into v_split_status
  from public.service_session_parts p
  join public.service_session_splits s on s.company_id = p.company_id and s.id = p.split_id
  where p.company_id = new.company_id and p.id = new.part_id;
  if v_split_status is distinct from 'active' then
    raise exception 'Só é possível alocar pagamento a partes de uma divisão ativa.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

-- 5h) Ao fim da transação: soma das alocações do pagamento <= valor do pagamento; líquido da parte (alocado - estornado)
--     <= valor previsto da parte.
create function public.partial_payments_check_payment_alloc_totals()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric(12, 2);
  v_sum numeric(12, 2);
  v_planned numeric(12, 2);
  v_part_alloc numeric(12, 2);
  v_part_refund numeric(12, 2);
begin
  select amount into v_amount from public.service_payments where company_id = new.company_id and id = new.service_payment_id;
  select coalesce(sum(amount), 0) into v_sum
  from public.service_payment_allocations where company_id = new.company_id and service_payment_id = new.service_payment_id;
  if v_sum > v_amount then
    raise exception 'As alocações (R$ %) passam do valor do pagamento (R$ %).', v_sum, v_amount using errcode = 'PT409';
  end if;

  select planned_amount into v_planned from public.service_session_parts where company_id = new.company_id and id = new.part_id;
  select coalesce(sum(amount), 0) into v_part_alloc
  from public.service_payment_allocations where company_id = new.company_id and part_id = new.part_id;
  select coalesce(sum(amount), 0) into v_part_refund
  from public.service_refund_allocations where company_id = new.company_id and part_id = new.part_id;
  if v_part_alloc - v_part_refund > v_planned then
    raise exception 'O valor pago na parte (R$ %) passa do valor previsto (R$ %).', v_part_alloc - v_part_refund, v_planned using errcode = 'PT409';
  end if;
  return null;
end;
$$;

-- 5i) Alocação de estorno: estorno e parte da MESMA conta; o estorno recompõe saldo (conta aberta); a parte já recebeu
--     daquele pagamento pelo menos o que se estorna (somando os estornos anteriores do mesmo pagamento nessa parte).
create function public.partial_payments_guard_refund_alloc_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_refund public.service_refunds;
  v_paid_to_part numeric(12, 2);
  v_refunded_part numeric(12, 2);
begin
  select * into v_refund from public.service_refunds where company_id = new.company_id and id = new.service_refund_id;
  if v_refund.service_session_id is distinct from new.service_session_id then
    raise exception 'O estorno não pertence à conta da parte.' using errcode = 'PT409';
  end if;
  if not v_refund.restores_balance then
    raise exception 'Só um estorno que recompõe saldo (conta aberta) tem alocação em partes.' using errcode = 'PT409';
  end if;
  select coalesce(sum(amount), 0) into v_paid_to_part
  from public.service_payment_allocations
  where company_id = new.company_id and service_payment_id = v_refund.service_payment_id and part_id = new.part_id;
  select coalesce(sum(ra.amount), 0) into v_refunded_part
  from public.service_refund_allocations ra
  join public.service_refunds r on r.company_id = ra.company_id and r.id = ra.service_refund_id
  where ra.company_id = new.company_id and ra.part_id = new.part_id and r.service_payment_id = v_refund.service_payment_id;
  if v_refunded_part + new.amount > v_paid_to_part then
    raise exception 'O estorno na parte (R$ %) passa do que aquele pagamento destinou a ela (R$ %).', v_refunded_part + new.amount, v_paid_to_part using errcode = 'PT409';
  end if;
  return new;
end;
$$;

-- 5j) Ao fim da transação: soma das alocações do estorno <= valor do estorno.
create function public.partial_payments_check_refund_alloc_total()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric(12, 2);
  v_sum numeric(12, 2);
begin
  select amount into v_amount from public.service_refunds where company_id = new.company_id and id = new.service_refund_id;
  select coalesce(sum(amount), 0) into v_sum
  from public.service_refund_allocations where company_id = new.company_id and service_refund_id = new.service_refund_id;
  if v_sum > v_amount then
    raise exception 'As alocações do estorno (R$ %) passam do valor estornado (R$ %).', v_sum, v_amount using errcode = 'PT409';
  end if;
  return null;
end;
$$;

-- 5k) Estorno: o pagamento é da MESMA conta e restores_balance combina com o status (aberta = true, fechada = false);
--     estorno que recompõe saldo só em comanda/mesa. As RPCs atuais (só contas fechadas, default false) já cumprem tudo.
create function public.partial_payments_guard_refund_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.service_sessions;
  v_pay_session uuid;
begin
  select service_session_id into v_pay_session from public.service_payments where company_id = new.company_id and id = new.service_payment_id;
  if v_pay_session is distinct from new.service_session_id then
    raise exception 'O pagamento estornado não pertence a esta conta.' using errcode = 'PT409';
  end if;
  select * into v_session from public.service_sessions where company_id = new.company_id and id = new.service_session_id;
  if new.restores_balance then
    if v_session.status is distinct from 'open' or v_session.kind is distinct from 'point' then
      raise exception 'Estorno que recompõe saldo só em conta aberta de comanda/mesa.' using errcode = 'PT409';
    end if;
  elsif v_session.status is distinct from 'closed' then
    raise exception 'Estorno de conta aberta deve recompor o saldo.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

-- 5l) Evento: a conta é da mesma empresa (FK) e o ator é quem executou; sem UPDATE/DELETE (5a).

create trigger service_session_splits_guard_insert
  before insert on public.service_session_splits
  for each row execute function public.partial_payments_guard_split_insert();
create trigger service_session_splits_guard_change
  before update or delete on public.service_session_splits
  for each row execute function public.partial_payments_guard_split_update();

create trigger service_session_parts_guard_insert
  before insert on public.service_session_parts
  for each row execute function public.partial_payments_guard_part_insert();
create trigger service_session_parts_immutable
  before update or delete on public.service_session_parts
  for each row execute function public.partial_payments_guard_immutable();

create trigger service_session_part_items_guard_insert
  before insert on public.service_session_part_items
  for each row execute function public.partial_payments_guard_part_item_insert();
create constraint trigger service_session_part_items_check_total
  after insert on public.service_session_part_items
  deferrable initially deferred
  for each row execute function public.partial_payments_check_part_item_total();
create trigger service_session_part_items_immutable
  before update or delete on public.service_session_part_items
  for each row execute function public.partial_payments_guard_immutable();

create trigger service_payment_allocations_guard_insert
  before insert on public.service_payment_allocations
  for each row execute function public.partial_payments_guard_payment_alloc_insert();
create constraint trigger service_payment_allocations_check_totals
  after insert on public.service_payment_allocations
  deferrable initially deferred
  for each row execute function public.partial_payments_check_payment_alloc_totals();
create trigger service_payment_allocations_immutable
  before update or delete on public.service_payment_allocations
  for each row execute function public.partial_payments_guard_immutable();

create trigger service_refund_allocations_guard_insert
  before insert on public.service_refund_allocations
  for each row execute function public.partial_payments_guard_refund_alloc_insert();
create constraint trigger service_refund_allocations_check_total
  after insert on public.service_refund_allocations
  deferrable initially deferred
  for each row execute function public.partial_payments_check_refund_alloc_total();
create trigger service_refund_allocations_immutable
  before update or delete on public.service_refund_allocations
  for each row execute function public.partial_payments_guard_immutable();

create trigger service_refunds_guard_partial_insert
  before insert on public.service_refunds
  for each row execute function public.partial_payments_guard_refund_insert();

create trigger service_session_events_immutable
  before update or delete on public.service_session_events
  for each row execute function public.partial_payments_guard_immutable();

revoke execute on function public.partial_payments_guard_immutable() from public, anon, authenticated;
revoke execute on function public.partial_payments_guard_split_update() from public, anon, authenticated;
revoke execute on function public.partial_payments_guard_split_insert() from public, anon, authenticated;
revoke execute on function public.partial_payments_guard_part_insert() from public, anon, authenticated;
revoke execute on function public.partial_payments_guard_part_item_insert() from public, anon, authenticated;
revoke execute on function public.partial_payments_check_part_item_total() from public, anon, authenticated;
revoke execute on function public.partial_payments_guard_payment_alloc_insert() from public, anon, authenticated;
revoke execute on function public.partial_payments_check_payment_alloc_totals() from public, anon, authenticated;
revoke execute on function public.partial_payments_guard_refund_alloc_insert() from public, anon, authenticated;
revoke execute on function public.partial_payments_check_refund_alloc_total() from public, anon, authenticated;
revoke execute on function public.partial_payments_guard_refund_insert() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6) RLS e grants — SÓ leitura pelo cliente; toda escrita vira RPC SECURITY DEFINER nas próximas etapas.
-- ---------------------------------------------------------------------------
alter table public.service_session_splits enable row level security;
alter table public.service_session_parts enable row level security;
alter table public.service_session_part_items enable row level security;
alter table public.service_payment_allocations enable row level security;
alter table public.service_refund_allocations enable row level security;
alter table public.service_session_events enable row level security;

-- Divisão e partes (previsão, sem dinheiro recebido): quem opera a conta lê (owner, admin, cashier, attendant).
-- production e courier não.
create policy service_session_splits_select on public.service_session_splits
  for select to authenticated
  using (
    company_id in (select public.user_company_ids())
    and public.user_role_in_company(company_id) in ('owner', 'admin', 'cashier', 'attendant')
  );
create policy service_session_parts_select on public.service_session_parts
  for select to authenticated
  using (
    company_id in (select public.user_company_ids())
    and public.user_role_in_company(company_id) in ('owner', 'admin', 'cashier', 'attendant')
  );
create policy service_session_part_items_select on public.service_session_part_items
  for select to authenticated
  using (
    company_id in (select public.user_company_ids())
    and public.user_role_in_company(company_id) in ('owner', 'admin', 'cashier', 'attendant')
  );

-- Alocação de pagamento: segue EXATAMENTE a visibilidade do pagamento (owner/admin veem todos; cashier só os do
-- próprio caixa; attendant nenhum). O estado financeiro agregado e visível a todo o time sai por RPC (E2).
create policy service_payment_allocations_select on public.service_payment_allocations
  for select to authenticated
  using (
    company_id in (select public.user_company_ids())
    and service_payment_id in (select id from public.service_payments)
  );

-- Financeiro sensível (como service_refunds): só owner/admin.
create policy service_refund_allocations_select on public.service_refund_allocations
  for select to authenticated
  using (public.user_role_in_company(company_id) in ('owner', 'admin'));
create policy service_session_events_select on public.service_session_events
  for select to authenticated
  using (public.user_role_in_company(company_id) in ('owner', 'admin'));

revoke all on public.service_session_splits from anon, authenticated;
revoke all on public.service_session_parts from anon, authenticated;
revoke all on public.service_session_part_items from anon, authenticated;
revoke all on public.service_payment_allocations from anon, authenticated;
revoke all on public.service_refund_allocations from anon, authenticated;
revoke all on public.service_session_events from anon, authenticated;
grant select on public.service_session_splits to authenticated;
grant select on public.service_session_parts to authenticated;
grant select on public.service_session_part_items to authenticated;
grant select on public.service_payment_allocations to authenticated;
grant select on public.service_refund_allocations to authenticated;
grant select on public.service_session_events to authenticated;
grant all on public.service_session_splits to service_role;
grant all on public.service_session_parts to service_role;
grant all on public.service_session_part_items to service_role;
grant all on public.service_payment_allocations to service_role;
grant all on public.service_refund_allocations to service_role;
grant all on public.service_session_events to service_role;

comment on table public.service_session_splits is 'Divisão da conta (igual | valores | produtos), versionada: uma ativa por conta; refazer = nova versão (a anterior vira superseded, com as partes pagas preservadas). Só comanda/mesa.';
comment on table public.service_session_parts is 'Partes de uma divisão. planned_amount é o PREVISTO (imutável); o não distribuído é total - soma das partes ativas, calculado na leitura (E2).';
comment on table public.service_session_part_items is 'Modo produtos: quantidade de cada item de pedido atribuída a cada parte.';
comment on table public.service_payment_allocations is 'Quanto de cada pagamento parcial foi para cada parte. Soma <= valor do pagamento; líquido da parte <= previsto (gatilhos, ao fim da transação).';
comment on table public.service_refund_allocations is 'Reversão nas partes de um estorno que recompõe saldo (conta aberta). Soma <= valor do estorno; por parte <= o que o pagamento destinou a ela.';
comment on table public.service_session_events is 'Trilha de auditoria append-only das operações financeiras da conta (divisão, pagamento, estorno, fechamento). Só owner/admin leem.';

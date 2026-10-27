-- Delivery e Retirada — NUMERAÇÃO SEQUENCIAL por empresa (DELIVERY #0001, RETIRADA #0002, DELIVERY #0003 ...).
-- ADITIVA: nenhuma migration publicada é editada; UUIDs e referências internas não mudam. O número é só a identificação
-- OPERACIONAL do pedido: não altera valores, pagamentos, estoque, produção, caixa nem idempotência.
--
-- Regras:
--   * Uma sequência única por empresa, compartilhada por Delivery e Retirada (pedido = delivery_orders, 1:1 com a sessão).
--   * Alocada NO BANCO por trigger BEFORE INSERT (todo caminho de criação passa por ele: motor único, IA/WhatsApp, humano).
--     Contador por empresa com UPSERT atômico (lock de linha) => dois pedidos simultâneos nunca recebem o mesmo número.
--   * Transacional: se a criação do pedido falha/reverte, o número volta junto (sem buraco). Pedido cancelado MANTÉM o seu número
--     (o número nunca é reutilizado). Solicitação duplicada (client_request_id) devolve o pedido existente: não consome número.
--   * Nunca reinicia por dia. Começa em 1 e continua do maior número atribuído. Exibição com 4 dígitos (0001); 10000+ funcionam.
--   * Pedidos históricos: numerados por ordem de criação (created_at, depois id — desempate determinístico). Só a coluna nova é
--     preenchida (o updated_at dos pedidos históricos NÃO é alterado).
--   * Imutável depois de criado (trigger) e único por empresa (índice). O contador só cresce.
--
-- As funções vigentes que devolvem/imprimem o código curto antigo (6 caracteres do UUID) são ajustadas por substituição EXATA
-- de trecho (pg_get_functiondef), com contagem conferida. Chaves antigas continuam existindo (compatibilidade com a v1.0.11).

-- ---------------------------------------------------------------------------
-- 1) Coluna, contador e funções auxiliares
-- ---------------------------------------------------------------------------
alter table public.delivery_orders add column order_number bigint;

create table public.delivery_order_counters (
  company_id uuid primary key references public.companies(id) on delete cascade,
  last_number bigint not null default 0
    constraint delivery_order_counters_last_check check (last_number >= 0),
  updated_at timestamptz not null default now()
);

comment on table public.delivery_order_counters is
  'Último número de pedido de Delivery/Retirada por empresa. Escrita só pelo trigger de alocação; só cresce.';
comment on column public.delivery_orders.order_number is
  'Número sequencial operacional do pedido (compartilhado entre Delivery e Retirada, por empresa). Imutável; nunca reutilizado.';

alter table public.delivery_order_counters enable row level security;
revoke all on public.delivery_order_counters from public, anon, authenticated;
grant all on public.delivery_order_counters to service_role;

-- Formato de exibição: 4 dígitos com zeros à esquerda; 10000 ou mais mostram todos os dígitos.
create function public.delivery_order_number_text(p_number bigint)
returns text
language sql
immutable
set search_path = public
as $$
  select case when p_number is null then null
              when p_number < 10000 then lpad(p_number::text, 4, '0')
              else p_number::text end;
$$;

-- Código do pedido para textos (movimentos de caixa, mensagens): número sequencial; pedido sem número cai no código antigo.
create function public.delivery_order_code(p_company_id uuid, p_delivery_order_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select public.delivery_order_number_text(d.order_number) from public.delivery_orders d
      where d.company_id = p_company_id and d.id = p_delivery_order_id),
    upper(left(replace(p_delivery_order_id::text, '-', ''), 6)));
$$;

-- Rótulo da sessão de delivery para impressão/avisos: "Delivery #0001" / "Retirada #0002" (NULL se a sessão não tem pedido de delivery).
create function public.delivery_session_label(p_company_id uuid, p_session_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case d.fulfillment when 'pickup' then 'Retirada' else 'Delivery' end || ' #' || public.delivery_order_number_text(d.order_number)
  from public.delivery_orders d
  where d.company_id = p_company_id and d.service_session_id = p_session_id;
$$;

revoke execute on function public.delivery_order_number_text(bigint) from public, anon, authenticated;
revoke execute on function public.delivery_order_code(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.delivery_session_label(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) Numeração dos pedidos históricos (ordem de criação, desempate por id) e contador
-- ---------------------------------------------------------------------------
-- O updated_at dos pedidos existentes não deve mudar por causa da numeração.
alter table public.delivery_orders disable trigger delivery_orders_set_updated_at;

update public.delivery_orders d
set order_number = r.rn
from (
  select id, row_number() over (partition by company_id order by created_at, id) as rn
  from public.delivery_orders
) r
where d.id = r.id;

alter table public.delivery_orders enable trigger delivery_orders_set_updated_at;

insert into public.delivery_order_counters (company_id, last_number)
select company_id, max(order_number) from public.delivery_orders group by company_id;

alter table public.delivery_orders alter column order_number set not null;
alter table public.delivery_orders add constraint delivery_orders_order_number_check check (order_number > 0);
create unique index delivery_orders_company_number_uidx on public.delivery_orders (company_id, order_number);

-- ---------------------------------------------------------------------------
-- 3) Alocação (BEFORE INSERT) e proteções
-- ---------------------------------------------------------------------------
-- Sempre sobrescreve o valor recebido: ninguém escolhe o número. O UPSERT trava a linha do contador da empresa até o fim da
-- transação, então a numeração é serial por empresa e não deixa buracos em caso de rollback.
create function public.assign_delivery_order_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.delivery_order_counters as c (company_id, last_number)
  values (new.company_id, 1)
  on conflict (company_id) do update set last_number = c.last_number + 1, updated_at = now()
  returning c.last_number into new.order_number;
  return new;
end;
$$;
revoke execute on function public.assign_delivery_order_number() from public, anon, authenticated;

create trigger delivery_orders_assign_number
  before insert on public.delivery_orders
  for each row execute function public.assign_delivery_order_number();

create function public.guard_delivery_order_number()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.order_number is distinct from old.order_number then
    raise exception 'O número do pedido não pode ser alterado.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_delivery_order_number() from public, anon, authenticated;

create trigger delivery_orders_guard_number
  before update on public.delivery_orders
  for each row execute function public.guard_delivery_order_number();

create function public.guard_delivery_order_counter()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    -- só como cascata da exclusão da EMPRESA
    if pg_trigger_depth() > 1 then
      return old;
    end if;
    raise exception 'O contador de pedidos não pode ser apagado.' using errcode = 'PT409';
  end if;
  if new.company_id is distinct from old.company_id or new.last_number < old.last_number then
    raise exception 'O contador de pedidos só pode crescer.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_delivery_order_counter() from public, anon, authenticated;

create trigger delivery_order_counters_guard
  before update or delete on public.delivery_order_counters
  for each row execute function public.guard_delivery_order_counter();

-- ---------------------------------------------------------------------------
-- 4) Funções existentes (substituição exata de trecho)
-- ---------------------------------------------------------------------------
create function pg_temp.patch_order_number_fn(p_name text, p_from text, p_to text, p_expected integer default 1)
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
  if (length(v_def) - length(replace(v_def, p_from, ''))) / greatest(length(p_from), 1) <> p_expected then
    raise exception 'patch: trecho esperado não ocorre % vez(es) em %', p_expected, p_name;
  end if;
  execute replace(v_def, p_from, p_to);
end;
$$;

-- Resumo devolvido ao criar/consultar o pedido
select pg_temp.patch_order_number_fn('delivery_order_summary',
  $f$'delivery_order_id', d.id,$f$,
  $f$'delivery_order_id', d.id,
    'order_number', d.order_number,$f$);

-- Quadro/lista/histórico do Delivery (get_delivery_order já traz a coluna via to_jsonb)
select pg_temp.patch_order_number_fn('list_delivery_orders',
  $f$'service_session_id', d.service_session_id,$f$,
  $f$'order_number', d.order_number,
        'service_session_id', d.service_session_id,$f$);

-- Contas de delivery/retirada no Caixa
select pg_temp.patch_order_number_fn('list_delivery_receivables',
  $f$'short_code', upper(left(replace(q.id::text, '-', ''), 6)),$f$,
  $f$'short_code', public.delivery_order_number_text(q.order_number),
        'order_number', q.order_number,$f$);
select pg_temp.patch_order_number_fn('list_delivery_receivables',
  $f$select d.id, d.service_session_id, d.fulfillment, d.delivery_status,$f$,
  $f$select d.id, d.order_number, d.service_session_id, d.fulfillment, d.delivery_status,$f$);

-- Acerto de entregadores
select pg_temp.patch_order_number_fn('list_courier_settlements',
  $f$'short_code', upper(left(replace(r.delivery_order_id::text, '-', ''), 6)),$f$,
  $f$'short_code', public.delivery_order_number_text(d.order_number), 'order_number', d.order_number, 'fulfillment', d.fulfillment,$f$);
select pg_temp.patch_order_number_fn('list_courier_cash_pending',
  $f$'short_code', upper(left(replace(a.delivery_order_id::text, '-', ''), 6)),$f$,
  $f$'short_code', public.delivery_order_number_text(d.order_number), 'order_number', d.order_number, 'fulfillment', d.fulfillment,$f$);
select pg_temp.patch_order_number_fn('list_courier_cash_pending',
  $f$'short_code', upper(left(replace(l.delivery_order_id::text, '-', ''), 6)),$f$,
  $f$'short_code', public.delivery_order_code(l.company_id, l.delivery_order_id),
        'order_number', (select o.order_number from public.delivery_orders o where o.company_id = l.company_id and o.id = l.delivery_order_id),
        'fulfillment', (select o.fulfillment from public.delivery_orders o where o.company_id = l.company_id and o.id = l.delivery_order_id),$f$);
select pg_temp.patch_order_number_fn('settle_courier_receipts',
  $f$'short_code', upper(left(replace(x.delivery_order_id::text, '-', ''), 6)),$f$,
  $f$'short_code', public.delivery_order_code(p_company_id, x.delivery_order_id),$f$);

-- Textos gravados nos movimentos do caixa e mensagens do troco
select pg_temp.patch_order_number_fn('give_courier_change_advance',
  $f$v_code := upper(left(replace(v_do.id::text, '-', ''), 6));$f$,
  $f$v_code := public.delivery_order_code(v_do.company_id, v_do.id);$f$);
select pg_temp.patch_order_number_fn('return_courier_change_advance',
  $f$v_code := upper(left(replace(v_adv.delivery_order_id::text, '-', ''), 6));$f$,
  $f$v_code := public.delivery_order_code(v_adv.company_id, v_adv.delivery_order_id);$f$);
select pg_temp.patch_order_number_fn('settle_courier_cash',
  $f$v_code := upper(left(replace(v_r.delivery_order_id::text, '-', ''), 6));$f$,
  $f$v_code := public.delivery_order_code(v_r.company_id, v_r.delivery_order_id);$f$);
select pg_temp.patch_order_number_fn('resolve_courier_difference',
  $f$v_code := upper(left(replace(v_line.delivery_order_id::text, '-', ''), 6));$f$,
  $f$v_code := public.delivery_order_code(v_line.company_id, v_line.delivery_order_id);$f$);

-- Produção/KDS (fila e histórico): número e tipo do pedido
select pg_temp.patch_order_number_fn('production_queue_base',
  $f$'fulfillment', (select d.fulfillment from public.delivery_orders d where d.company_id = ss.company_id and d.service_session_id = ss.id),$f$,
  $f$'fulfillment', (select d.fulfillment from public.delivery_orders d where d.company_id = ss.company_id and d.service_session_id = ss.id),
        'order_number', (select d.order_number from public.delivery_orders d where d.company_id = ss.company_id and d.service_session_id = ss.id),$f$,
  2);
select pg_temp.patch_order_number_fn('production_queue_base',
  $f$'reason', x.reason,$f$,
  $f$'fulfillment', (select d.fulfillment from public.delivery_orders d where d.company_id = ss.company_id and d.service_session_id = ss.id),
        'order_number', (select d.order_number from public.delivery_orders d where d.company_id = ss.company_id and d.service_session_id = ss.id),
        'reason', x.reason,$f$);
select pg_temp.patch_order_number_fn('production_history_base',
  $f$sp.display_name as point_name,$f$,
  $f$sp.display_name as point_name,
      ss.kind as session_kind,
      (select d.fulfillment from public.delivery_orders d where d.company_id = ss.company_id and d.service_session_id = ss.id) as fulfillment,
      (select d.order_number from public.delivery_orders d where d.company_id = ss.company_id and d.service_session_id = ss.id) as order_number,$f$);

-- Impressão: bloco "delivery" do pedido de produção + rótulo "Delivery #0001"/"Retirada #0002" nos demais documentos
select pg_temp.patch_order_number_fn('delivery_print_block',
  $f$'fulfillment', d.fulfillment,$f$,
  $f$'fulfillment', d.fulfillment,
    'order_number', d.order_number,$f$);
select pg_temp.patch_order_number_fn('print_session_header',
  $f$then 'Delivery'$f$,
  $f$then coalesce(public.delivery_session_label(p_session.company_id, p_session.id), 'Delivery')$f$);
select pg_temp.patch_order_number_fn('enqueue_order_print_jobs',
  $f$then 'Delivery'$f$,
  $f$then coalesce(public.delivery_session_label(v_order.company_id, v_order.service_session_id), 'Delivery')$f$);
select pg_temp.patch_order_number_fn('enqueue_cancellation_print_jobs',
  $f$then 'Delivery'$f$,
  $f$then coalesce(public.delivery_session_label(v_order.company_id, v_order.service_session_id), 'Delivery')$f$);

-- Avisos (push). Os textos gravados no Caixa ("Venda - Delivery", "Estorno - Delivery") NÃO mudam: o livro do caixa fica intacto.
select pg_temp.patch_order_number_fn('push_session_label',
  $f$then 'Delivery'$f$,
  $f$then coalesce(public.delivery_session_label(p_company_id, p_session_id), 'Delivery')$f$);

-- PUSH NOTIFICATIONS — etapa B: eventos (outbox), despacho assíncrono, gatilhos de domínio, resumo financeiro
-- diário e rede de segurança (retry).
--
-- Fluxo (server-authoritative; o frontend NUNCA envia push nem escolhe destinatários):
--   operação de negócio -> gatilho grava 1 linha em push_events (dedupe por empresa+chave)
--   -> push_dispatch_event() faz UMA chamada assíncrona (pg_net) para a Edge Function push-dispatch
--      (segredo e URL lidos do Supabase Vault; nenhum valor real nesta migration)
--   -> a Edge reivindica o evento (pending -> sending, atômico), resolve os destinatários NO SERVIDOR
--      (push_event_targets), envia o Web Push e registra o resultado.
--   Falha de push nunca desfaz a operação de negócio: gatilhos e despacho engolem erros com WARNING.
--
-- Dedupe em 3 níveis: (1) banco: unique (company_id, dedupe_key); (2) claim atômico em push_claim_event;
-- (3) service worker: notificationId como tag.
--
-- Eventos e destinatários (decisões de produto da v1):
--   new_order                       production dos setores do pedido (aparelho sem setores = todos)
--   order_ready                     SÓ quando o PEDIDO COMPLETO fica pronto -> o attendant que o enviou
--   order_cancelled_in_production   production do setor do item, só se o item já estava preparing/ready
--   receivables_daily / payables_daily   owner/admin, UM resumo por dia (não uma push por conta)
--   owner/admin não recebem pedido; cashier não recebe nada na v1.
--
-- Agendamento (resumo às 08:00 de São Paulo e retry): migration SEPARADA (20261004050000_push_cron.sql), como o
-- ciclo de cobrança — esta aqui é testável em qualquer Postgres.
--
-- Fora do Realtime. Sem sino/inbox: push é entrega ao aparelho.

-- ---------------------------------------------------------------------------
-- 0) pg_net (idempotente; só cria se a função ainda não existir)
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    create extension if not exists pg_net;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1) push_events
-- ---------------------------------------------------------------------------
create table public.push_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  event_type text not null
    constraint push_events_type_check check (event_type in (
      'new_order', 'order_ready', 'order_cancelled_in_production', 'receivables_daily', 'payables_daily')),
  dedupe_key text not null
    constraint push_events_dedupe_key_check check (char_length(dedupe_key) between 1 and 200),
  title text not null
    constraint push_events_title_check check (char_length(title) between 1 and 100),
  body text not null
    constraint push_events_body_check check (char_length(body) between 1 and 300),
  -- destino do toque (rota do app); a Edge aplica o mesmo para todos os destinatários do evento
  url text not null default '/'
    constraint push_events_url_check check (url ~ '^/[^/]' or url = '/'),
  order_id uuid,
  session_id uuid,
  -- setores afetados (só de pedido/cancelamento); array vazio = itens sem setor (só aparelhos "todos")
  sector_ids uuid[],
  -- destinatário único (order_ready: quem enviou o pedido)
  target_user_id uuid,
  status text not null default 'pending'
    constraint push_events_status_check check (status in ('pending', 'sending', 'sent', 'partial', 'failed')),
  attempt_count integer not null default 0 constraint push_events_attempt_check check (attempt_count >= 0),
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz,
  last_error text constraint push_events_last_error_check check (last_error is null or char_length(last_error) <= 500),
  constraint push_events_company_dedupe_key unique (company_id, dedupe_key)
);

comment on table public.push_events is
  'Outbox de Web Push. Um evento lógico por linha, com dedupe por (company_id, dedupe_key). Sem acesso de clientes; só gatilhos/funções SECURITY DEFINER e service_role.';

-- retry: só os eventos ainda não resolvidos
create index push_events_unresolved_idx on public.push_events (status, created_at) where status in ('pending', 'sending');

alter table public.push_events enable row level security;
revoke all on public.push_events from public, anon, authenticated;
grant all on public.push_events to service_role;

-- ---------------------------------------------------------------------------
-- 2) Despacho assíncrono (Vault + pg_net)
-- ---------------------------------------------------------------------------
-- Lê PUSH_DISPATCH_URL e PUSH_DISPATCH_SECRET do Supabase Vault (nomes dos segredos; os valores são
-- cadastrados à mão depois do deploy da Edge — ver docs/push-notifications.md). Sem eles, não faz nada: o
-- evento continua pending e o retry por cron o despacha quando a configuração existir.
create function public.push_dispatch_event(p_event_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'PUSH_DISPATCH_URL' limit 1;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'PUSH_DISPATCH_SECRET' limit 1;
  if nullif(btrim(coalesce(v_url, '')), '') is null or nullif(btrim(coalesce(v_secret, '')), '') is null then
    return;
  end if;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', v_secret),
    body := jsonb_build_object('event_id', p_event_id)
  );
exception when others then
  raise warning 'push_dispatch_event falhou para %: %', p_event_id, sqlerrm;
end;
$$;

-- Ponto único de criação: grava o evento (dedupe) e despacha. Devolve o id, ou NULL se já existia.
create function public.push_enqueue_event(
  p_company_id uuid,
  p_event_type text,
  p_dedupe_key text,
  p_title text,
  p_body text,
  p_url text,
  p_order_id uuid default null,
  p_session_id uuid default null,
  p_sector_ids uuid[] default null,
  p_target_user_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.push_events (company_id, event_type, dedupe_key, title, body, url, order_id, session_id, sector_ids, target_user_id)
  values (p_company_id, p_event_type, p_dedupe_key, left(p_title, 100), left(p_body, 300), p_url, p_order_id, p_session_id, p_sector_ids, p_target_user_id)
  on conflict (company_id, dedupe_key) do nothing
  returning id into v_id;

  if v_id is not null then
    perform public.push_dispatch_event(v_id);
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Rótulo do atendimento ("Comanda CMD001" / "Mesa M01")
-- ---------------------------------------------------------------------------
create function public.push_session_label(p_company_id uuid, p_session_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case sp.type when 'table' then 'Mesa ' else 'Comanda ' end || sp.code
  from public.service_sessions ss
  join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
  where ss.company_id = p_company_id and ss.id = p_session_id;
$$;

-- ---------------------------------------------------------------------------
-- 4) Gatilhos de domínio (não reescrevem nenhuma RPC existente)
-- ---------------------------------------------------------------------------
-- 4.1 Novo pedido. Constraint trigger DEFERRED: roda no FIM da transação de submit_service_order, quando os
-- itens já existem. Setores = production_sector_id dos itens ativos (itens sem setor só avisam aparelhos "todos").
create function public.push_trg_new_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_items integer;
  v_sectors uuid[];
  v_label text;
begin
  if new.status <> 'submitted' then
    return null;
  end if;

  select count(*),
         coalesce(array_agg(distinct i.production_sector_id) filter (where i.production_sector_id is not null), '{}')
    into v_items, v_sectors
  from public.service_order_items i
  where i.company_id = new.company_id and i.order_id = new.id and i.quantity > i.cancelled_quantity;

  if v_items = 0 then
    return null;
  end if;

  v_label := coalesce(public.push_session_label(new.company_id, new.service_session_id), 'Atendimento');
  perform public.push_enqueue_event(
    new.company_id, 'new_order', 'new-order:' || new.id,
    'Novo pedido',
    v_label || ' · ' || v_items || case when v_items = 1 then ' item' else ' itens' end,
    '/operacional/producao', new.id, new.service_session_id, v_sectors, null);
  return null;
exception when others then
  raise warning 'push_trg_new_order falhou para o pedido %: %', new.id, sqlerrm;
  return null;
end;
$$;

create constraint trigger push_new_order
  after insert on public.service_orders
  deferrable initially deferred
  for each row execute function public.push_trg_new_order();

-- 4.2 Pedido pronto: só quando TODOS os itens ativos do pedido estão ready. O lock por pedido serializa dois
-- itens ficando prontos ao mesmo tempo em transações diferentes (a segunda enxerga a primeira já confirmada).
create function public.push_check_order_ready(p_company_id uuid, p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.service_orders;
  v_active integer;
  v_ready integer;
  v_label text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_order_id::text, 0));

  select * into v_order from public.service_orders where company_id = p_company_id and id = p_order_id;
  if not found or v_order.status <> 'submitted' then
    return;
  end if;

  select count(*), count(*) filter (where i.production_status = 'ready')
    into v_active, v_ready
  from public.service_order_items i
  where i.company_id = p_company_id and i.order_id = p_order_id and i.quantity > i.cancelled_quantity;

  if v_active = 0 or v_ready <> v_active then
    return;
  end if;

  v_label := coalesce(public.push_session_label(p_company_id, v_order.service_session_id), 'Atendimento');
  perform public.push_enqueue_event(
    p_company_id, 'order_ready', 'order-ready:' || p_order_id,
    'Pedido pronto', v_label || ' · pedido completo',
    '/operacional/atendimento/' || v_order.service_session_id,
    p_order_id, v_order.service_session_id, null, v_order.created_by);
end;
$$;

create function public.push_trg_item_ready()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.push_check_order_ready(new.company_id, new.order_id);
  return null;
exception when others then
  raise warning 'push_trg_item_ready falhou para o item %: %', new.id, sqlerrm;
  return null;
end;
$$;

-- item que ACABA de ficar pronto (e ainda conta no pedido)
create trigger push_item_ready
  after update of production_status on public.service_order_items
  for each row
  when (old.production_status is distinct from 'ready' and new.production_status = 'ready' and new.quantity > new.cancelled_quantity)
  execute function public.push_trg_item_ready();

-- cancelar a última unidade ainda não pronta também completa o pedido
create trigger push_item_cancel_ready
  after update of cancelled_quantity on public.service_order_items
  for each row
  when (new.cancelled_quantity > old.cancelled_quantity)
  execute function public.push_trg_item_ready();

-- 4.3 Cancelamento relevante para a produção: item que JÁ estava preparing/ready.
create function public.push_trg_cancellation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.service_order_items;
  v_session uuid;
  v_label text;
begin
  select * into v_item from public.service_order_items where company_id = new.company_id and id = new.service_order_item_id;
  if not found or v_item.production_status = 'pending' then
    return null;
  end if;

  select o.service_session_id into v_session from public.service_orders o where o.company_id = v_item.company_id and o.id = v_item.order_id;
  v_label := coalesce(public.push_session_label(new.company_id, v_session), 'Atendimento');
  perform public.push_enqueue_event(
    new.company_id, 'order_cancelled_in_production', 'order-cancel:' || new.id,
    'Item cancelado',
    v_label || ' · ' || new.quantity || '× ' || v_item.product_name_snapshot || ' cancelado',
    '/operacional/producao', v_item.order_id, v_session,
    case when v_item.production_sector_id is null then '{}'::uuid[] else array[v_item.production_sector_id] end,
    null);
  return null;
exception when others then
  raise warning 'push_trg_cancellation falhou para o cancelamento %: %', new.id, sqlerrm;
  return null;
end;
$$;

create trigger push_item_cancellation
  after insert on public.service_order_item_cancellations
  for each row execute function public.push_trg_cancellation();

-- ---------------------------------------------------------------------------
-- 5) Resolução de destinatários (SERVIDOR; chamada só pela Edge, service_role)
-- ---------------------------------------------------------------------------
-- Sempre exige: aparelho ativo DA MESMA empresa do evento + vínculo ATIVO do dono do aparelho nessa empresa + papel
-- compatível com o tipo do evento. Nunca recebe lista de destinatários de fora.
create function public.push_event_targets(p_event_id uuid)
returns table (subscription_id uuid, user_id uuid, role public.company_role, endpoint text, p256dh text, auth text, url text)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.user_id, cu.role, s.endpoint, s.p256dh, s.auth, e.url
  from public.push_events e
  join public.push_subscriptions s on s.company_id = e.company_id and s.is_active
  join public.company_users cu on cu.company_id = e.company_id and cu.user_id = s.user_id and cu.status = 'active'
  where e.id = p_event_id
    and (
      (e.event_type in ('new_order', 'order_cancelled_in_production')
        and cu.role = 'production'
        and (s.sector_ids is null or (e.sector_ids is not null and s.sector_ids && e.sector_ids)))
      or (e.event_type = 'order_ready'
        and cu.role = 'attendant'
        and s.user_id = e.target_user_id)
      or (e.event_type in ('receivables_daily', 'payables_daily')
        and cu.role in ('owner', 'admin'))
    );
$$;

-- Reivindica o evento: pending -> sending, atômico. Só UM chamador recebe a linha.
create function public.push_claim_event(p_event_id uuid)
returns setof public.push_events
language sql
security definer
set search_path = public
as $$
  update public.push_events
     set status = 'sending', claimed_at = now(), attempt_count = attempt_count + 1
   where id = p_event_id and status = 'pending'
  returning *;
$$;

-- Fecha o evento: sent (sem falhas, inclusive 0 destinatários), partial (parte enviada) ou failed.
create function public.push_finish_event(p_event_id uuid, p_sent integer, p_failed integer, p_error text default null)
returns void
language sql
security definer
set search_path = public
as $$
  update public.push_events
     set status = case when p_failed = 0 then 'sent' when p_sent > 0 then 'partial' else 'failed' end,
         sent_count = greatest(p_sent, 0),
         failed_count = greatest(p_failed, 0),
         finished_at = now(),
         last_error = left(p_error, 500)
   where id = p_event_id and status = 'sending';
$$;

-- ---------------------------------------------------------------------------
-- 6) Resumo financeiro diário (owner/admin) — um evento por empresa e por dia
-- ---------------------------------------------------------------------------
create function public.push_format_brl(p_value numeric)
returns text
language sql
immutable
set search_path = public
as $$
  select 'R$ ' || translate(to_char(coalesce(p_value, 0), 'FM999,999,999,990.00'), ',.', '.,');
$$;

-- p_date NULL = hoje em America/Sao_Paulo. Só cria o evento da empresa que tem conta vencendo hoje ou atrasada.
-- Retorna quantos eventos NOVOS criou (reexecutar no mesmo dia não duplica).
create function public.push_enqueue_daily_summaries(p_date date default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_date date := coalesce(p_date, (now() at time zone 'America/Sao_Paulo')::date);
  v_created integer := 0;
  r record;
  v_parts text[];
begin
  -- contas a receber
  for r in
    select company_id,
           count(*) filter (where due_date = v_date) as today_n,
           coalesce(sum(amount - paid_amount) filter (where due_date = v_date), 0) as today_v,
           count(*) filter (where due_date < v_date) as late_n,
           coalesce(sum(amount - paid_amount) filter (where due_date < v_date), 0) as late_v
    from public.accounts_receivable
    where status = 'pending' and due_date <= v_date
    group by company_id
  loop
    v_parts := '{}';
    if r.today_n > 0 then
      v_parts := v_parts || (r.today_n || case when r.today_n = 1 then ' vence hoje (' else ' vencem hoje (' end || public.push_format_brl(r.today_v) || ')');
    end if;
    if r.late_n > 0 then
      v_parts := v_parts || (r.late_n || case when r.late_n = 1 then ' atrasada (' else ' atrasadas (' end || public.push_format_brl(r.late_v) || ')');
    end if;
    if public.push_enqueue_event(r.company_id, 'receivables_daily', 'receivables-daily:' || v_date,
         'Contas a receber', array_to_string(v_parts, ' · '), '/app/financeiro/contas-a-receber') is not null then
      v_created := v_created + 1;
    end if;
  end loop;

  -- contas a pagar
  for r in
    select company_id,
           count(*) filter (where due_date = v_date) as today_n,
           coalesce(sum(amount - paid_amount) filter (where due_date = v_date), 0) as today_v,
           count(*) filter (where due_date < v_date) as late_n,
           coalesce(sum(amount - paid_amount) filter (where due_date < v_date), 0) as late_v
    from public.accounts_payable
    where status = 'pending' and due_date <= v_date
    group by company_id
  loop
    v_parts := '{}';
    if r.today_n > 0 then
      v_parts := v_parts || (r.today_n || case when r.today_n = 1 then ' vence hoje (' else ' vencem hoje (' end || public.push_format_brl(r.today_v) || ')');
    end if;
    if r.late_n > 0 then
      v_parts := v_parts || (r.late_n || case when r.late_n = 1 then ' atrasada (' else ' atrasadas (' end || public.push_format_brl(r.late_v) || ')');
    end if;
    if public.push_enqueue_event(r.company_id, 'payables_daily', 'payables-daily:' || v_date,
         'Contas a pagar', array_to_string(v_parts, ' · '), '/app/financeiro/contas-a-pagar') is not null then
      v_created := v_created + 1;
    end if;
  end loop;

  return v_created;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) Retry (rede de segurança; agendado na migration de cron)
-- ---------------------------------------------------------------------------
-- 1) pending com mais de 1 dia vira failed (não avisar pedido velho);
-- 2) sending travado há mais de 5 min: volta a pending se ainda tem tentativas (< 3), senão failed;
-- 3) pending com mais de 1 min e menos de 5 tentativas é despachado de novo (até 200 por rodada).
-- O claim atômico garante que um redisparo nunca envia em duplicidade enquanto outro worker processa.
-- Retorna quantos eventos foram redespachados.
create function public.push_retry_pending()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_n integer := 0;
begin
  update public.push_events
     set status = 'failed', finished_at = now(), last_error = 'expirado'
   where status = 'pending' and created_at < now() - interval '1 day';

  update public.push_events
     set status = case when attempt_count < 3 then 'pending' else 'failed' end,
         claimed_at = case when attempt_count < 3 then null else claimed_at end,
         finished_at = case when attempt_count < 3 then null else now() end,
         last_error = case when attempt_count < 3 then last_error else 'travado em envio' end
   where status = 'sending' and claimed_at < now() - interval '5 minutes';

  for v_id in
    select id from public.push_events
    where status = 'pending' and created_at < now() - interval '1 minute' and attempt_count < 5
    order by created_at
    limit 200
  loop
    perform public.push_dispatch_event(v_id);
    v_n := v_n + 1;
  end loop;

  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8) ACL
-- ---------------------------------------------------------------------------
-- Internas (gatilhos, despacho, resumo, retry, formatação): nenhum papel de cliente executa.
revoke execute on function public.push_dispatch_event(uuid) from public, anon, authenticated;
revoke execute on function public.push_enqueue_event(uuid, text, text, text, text, text, uuid, uuid, uuid[], uuid) from public, anon, authenticated;
revoke execute on function public.push_session_label(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.push_trg_new_order() from public, anon, authenticated;
revoke execute on function public.push_check_order_ready(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.push_trg_item_ready() from public, anon, authenticated;
revoke execute on function public.push_trg_cancellation() from public, anon, authenticated;
revoke execute on function public.push_format_brl(numeric) from public, anon, authenticated;
revoke execute on function public.push_enqueue_daily_summaries(date) from public, anon, authenticated;
revoke execute on function public.push_retry_pending() from public, anon, authenticated;

-- Só a Edge (service_role): resolver destinatários, reivindicar e fechar evento.
revoke execute on function public.push_event_targets(uuid) from public, anon, authenticated;
grant execute on function public.push_event_targets(uuid) to service_role;
revoke execute on function public.push_claim_event(uuid) from public, anon, authenticated;
grant execute on function public.push_claim_event(uuid) to service_role;
revoke execute on function public.push_finish_event(uuid, integer, integer, text) from public, anon, authenticated;
grant execute on function public.push_finish_event(uuid, integer, integer, text) to service_role;

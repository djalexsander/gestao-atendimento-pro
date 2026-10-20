-- WhatsApp — ACOMPANHAMENTO AUTOMÁTICO DO PEDIDO (Fase 1): avisos operacionais ao cliente (OUTBOX).
--
-- Quando o pedido fica totalmente pronto (retirada ou delivery) e quando o delivery sai para entrega, o cliente que fez o
-- pedido pelo WhatsApp recebe uma mensagem DETERMINÍSTICA (sem OpenAI). Nada aqui depende do WhatsApp para a operação:
--   operador marca pronto -> a transação operacional termina -> um trigger só GRAVA uma linha na outbox (ON CONFLICT DO NOTHING,
--   exceções engolidas) -> o worker whatsapp-order-notify envia depois. Falha da Meta nunca volta status de produção/delivery.
--
-- Elegibilidade = VÍNCULO OFICIAL: service_order -> delivery_orders.service_order_id -> delivery_orders.whatsapp_conversation_id.
-- Não depende de created_via nem de nome/telefone/customer_id. Pedido sem vínculo (balcão, mesa, comanda, delivery manual)
-- não gera nada.
--
-- Tipos (v1): ORDER_READY_PICKUP, ORDER_READY_DELIVERY, OUT_FOR_DELIVERY. Validade: 2 h / 2 h / 1 h (depois, 'expired').
-- Janela de 24 h da Meta: dentro, texto livre; fora, 'blocked_window' (sem template nesta fase, sem retry cego).
-- Feature flag por empresa: company_whatsapp_ai_settings.order_status_notifications_enabled (default false). O worker tem ainda
-- um kill switch global no ambiente da Edge Function.
--
-- "Pedido pronto" = o MESMO predicado do push interno (push_check_order_ready), agora extraído para order_is_fully_ready() e
-- usado pelos dois (não existe uma segunda regra): pedido 'submitted', >= 1 item ativo (quantity > cancelled_quantity) e todos
-- os itens ativos 'ready'.

-- ---------------------------------------------------------------------------
-- 1) Feature flag por empresa
-- ---------------------------------------------------------------------------
alter table public.company_whatsapp_ai_settings
  add column order_status_notifications_enabled boolean not null default false;
comment on column public.company_whatsapp_ai_settings.order_status_notifications_enabled is
  'Avisos automáticos do pedido pelo WhatsApp (pronto / saiu para entrega). Default false; ligado por SQL por empresa.';

-- ---------------------------------------------------------------------------
-- 2) Predicado único de "pedido totalmente pronto"
-- ---------------------------------------------------------------------------
create function public.order_is_fully_ready(p_company_id uuid, p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.service_orders o where o.company_id = p_company_id and o.id = p_order_id and o.status = 'submitted')
     and exists (select 1 from public.service_order_items i
                  where i.company_id = p_company_id and i.order_id = p_order_id and i.quantity > i.cancelled_quantity)
     and not exists (select 1 from public.service_order_items i
                      where i.company_id = p_company_id and i.order_id = p_order_id and i.quantity > i.cancelled_quantity
                        and i.production_status <> 'ready');
$$;
revoke execute on function public.order_is_fully_ready(uuid, uuid) from public, anon, authenticated, service_role;

-- push_check_order_ready passa a usar o predicado compartilhado (mesmo resultado; assinatura, ACL e demais regras iguais)
create or replace function public.push_check_order_ready(p_company_id uuid, p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.service_orders;
  v_label text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_order_id::text, 0));

  select * into v_order from public.service_orders where company_id = p_company_id and id = p_order_id;
  if not found or v_order.status <> 'submitted' then
    return;
  end if;

  if not public.order_is_fully_ready(p_company_id, p_order_id) then
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

-- ---------------------------------------------------------------------------
-- 3) Outbox
-- ---------------------------------------------------------------------------
create table public.order_customer_notifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  service_order_id uuid not null,
  delivery_order_id uuid not null,
  conversation_id uuid not null references public.whatsapp_conversations(id) on delete cascade,
  notification_type text not null
    constraint order_customer_notifications_type_check check (notification_type in ('ORDER_READY_PICKUP', 'ORDER_READY_DELIVERY', 'OUT_FOR_DELIVERY')),
  status text not null default 'pending'
    constraint order_customer_notifications_status_check check (status in
      ('pending', 'processing', 'sent', 'blocked_window', 'skipped', 'expired', 'superseded', 'failed')),
  attempts integer not null default 0 constraint order_customer_notifications_attempts_check check (attempts between 0 and 20),
  available_at timestamptz not null default now(),
  expires_at timestamptz not null,
  locked_until timestamptz,
  message_id uuid,
  provider_message_id text constraint order_customer_notifications_provider_len check (provider_message_id is null or char_length(provider_message_id) <= 200),
  error_code text constraint order_customer_notifications_error_len check (error_code is null or char_length(error_code) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  constraint order_customer_notifications_order_fkey foreign key (company_id, service_order_id) references public.service_orders (company_id, id),
  constraint order_customer_notifications_delivery_fkey foreign key (company_id, delivery_order_id) references public.delivery_orders (company_id, id),
  -- UMA notificação lógica por pedido e evento (idempotência)
  constraint order_customer_notifications_once unique (service_order_id, notification_type),
  constraint order_customer_notifications_sent_check check ((status = 'sent') = (sent_at is not null)),
  constraint order_customer_notifications_delivered_check check (delivered_at is null or sent_at is not null)
);
create index order_customer_notifications_due_idx on public.order_customer_notifications (available_at) where status in ('pending', 'processing');
create index order_customer_notifications_company_idx on public.order_customer_notifications (company_id, service_order_id);

alter table public.order_customer_notifications enable row level security;
revoke all on public.order_customer_notifications from public, anon, authenticated;
grant select on public.order_customer_notifications to authenticated, service_role;
-- só LEITURA (estado do aviso, sem texto nem telefone) para quem opera pedidos; toda escrita é por trigger/RPC DEFINER
create policy order_customer_notifications_select on public.order_customer_notifications
  for select to authenticated
  using (
    public.company_has_module_rls(company_id, 'whatsapp')
    and public.user_role_in_company(company_id) in ('owner', 'admin', 'cashier', 'attendant', 'production')
  );

-- guarda: colunas de identidade imutáveis; estados finais nunca mudam (só delivered_at preenche depois de 'sent')
create function public.guard_order_customer_notification_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is distinct from old.company_id or new.service_order_id is distinct from old.service_order_id
     or new.delivery_order_id is distinct from old.delivery_order_id or new.conversation_id is distinct from old.conversation_id
     or new.notification_type is distinct from old.notification_type or new.created_at is distinct from old.created_at
     or new.expires_at is distinct from old.expires_at then
    raise exception 'Identidade da notificação não pode ser alterada.' using errcode = 'PT409';
  end if;
  if old.status in ('sent', 'blocked_window', 'skipped', 'expired', 'superseded', 'failed') and new.status is distinct from old.status then
    raise exception 'Notificação já encerrada (%).', old.status using errcode = 'PT409';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke execute on function public.guard_order_customer_notification_change() from public, anon, authenticated, service_role;
create trigger order_customer_notifications_guard before update on public.order_customer_notifications
  for each row execute function public.guard_order_customer_notification_change();

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'order_customer_notifications') then
    alter publication supabase_realtime add table public.order_customer_notifications;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4) Texto (determinístico) e validade por tipo
-- ---------------------------------------------------------------------------
create function public.ocn_body(p_type text)
returns text
language sql
immutable
set search_path = public
as $$
  select case p_type
    when 'ORDER_READY_PICKUP' then 'Seu pedido está pronto! 🎉 Pode vir retirar quando quiser.'
    when 'ORDER_READY_DELIVERY' then 'Seu pedido está pronto e aguardando a saída para entrega.'
    when 'OUT_FOR_DELIVERY' then 'Seu pedido saiu para entrega. 🛵'
  end;
$$;
create function public.ocn_ttl(p_type text)
returns interval
language sql
immutable
set search_path = public
as $$
  select case p_type when 'OUT_FOR_DELIVERY' then interval '1 hour' else interval '2 hours' end;
$$;
revoke execute on function public.ocn_body(text) from public, anon, authenticated, service_role;
revoke execute on function public.ocn_ttl(text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5) Geração da outbox (nunca derruba a transação operacional)
-- ---------------------------------------------------------------------------
-- Cria a linha da outbox para (pedido, tipo) SE o pedido tem vínculo oficial com uma conversa e a empresa ligou a flag.
create function public.ocn_insert(p_company_id uuid, p_delivery_order_id uuid, p_type text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_do public.delivery_orders;
  v_conv public.whatsapp_conversations;
  v_flag boolean;
  v_id uuid;
begin
  select coalesce(s.order_status_notifications_enabled, false) into v_flag
    from public.company_whatsapp_ai_settings s where s.company_id = p_company_id;
  if not coalesce(v_flag, false) then
    return null;
  end if;
  select * into v_do from public.delivery_orders where id = p_delivery_order_id and company_id = p_company_id;
  if not found or v_do.whatsapp_conversation_id is null then
    return null;                      -- sem vínculo oficial: nunca avisa
  end if;
  select * into v_conv from public.whatsapp_conversations where id = v_do.whatsapp_conversation_id;
  if not found or v_conv.company_id <> p_company_id then
    return null;                      -- vínculo inválido
  end if;
  insert into public.order_customer_notifications (company_id, service_order_id, delivery_order_id, conversation_id, notification_type,
                                                    status, error_code, expires_at)
  values (p_company_id, v_do.service_order_id, v_do.id, v_conv.id, p_type,
          case when v_conv.deleted_at is null then 'pending' else 'skipped' end,
          case when v_conv.deleted_at is null then null else 'conversation_deleted' end,
          now() + public.ocn_ttl(p_type))
  on conflict (service_order_id, notification_type) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

-- pedido ficou totalmente pronto? (chamada pelos triggers de item; trava por pedido = mesma técnica do push)
create function public.ocn_check_ready(p_company_id uuid, p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_do public.delivery_orders;
begin
  perform pg_advisory_xact_lock(hashtextextended('ocn-ready:' || p_order_id::text, 0));
  select * into v_do from public.delivery_orders where company_id = p_company_id and service_order_id = p_order_id;
  if not found or v_do.whatsapp_conversation_id is null or v_do.delivery_status <> 'confirmed' then
    return;
  end if;
  if not public.order_is_fully_ready(p_company_id, p_order_id) then
    return;
  end if;
  perform public.ocn_insert(p_company_id, v_do.id,
    case v_do.fulfillment when 'pickup' then 'ORDER_READY_PICKUP' else 'ORDER_READY_DELIVERY' end);
end;
$$;

-- saiu para entrega: cria OUT_FOR_DELIVERY e SUBSTITUI o "pronto" que ainda não foi enviado
create function public.ocn_out_for_delivery(p_company_id uuid, p_delivery_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_do public.delivery_orders;
begin
  select * into v_do from public.delivery_orders where id = p_delivery_order_id and company_id = p_company_id;
  if not found or v_do.whatsapp_conversation_id is null or v_do.fulfillment <> 'delivery' then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ocn-ready:' || v_do.service_order_id::text, 0));
  perform public.ocn_insert(p_company_id, v_do.id, 'OUT_FOR_DELIVERY');
  update public.order_customer_notifications
     set status = 'superseded', error_code = 'out_for_delivery', locked_until = null
   where service_order_id = v_do.service_order_id and notification_type = 'ORDER_READY_DELIVERY'
     and status in ('pending', 'blocked_window');
end;
$$;

create function public.ocn_trg_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.ocn_check_ready(new.company_id, new.order_id);
  return null;
exception when others then
  raise warning 'ocn_trg_item falhou para o item %: %', new.id, sqlerrm;
  return null;
end;
$$;
create function public.ocn_trg_delivery()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.ocn_out_for_delivery(new.company_id, new.id);
  return null;
exception when others then
  raise warning 'ocn_trg_delivery falhou para %: %', new.id, sqlerrm;
  return null;
end;
$$;
revoke execute on function public.ocn_insert(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.ocn_check_ready(uuid, uuid) from public, anon, authenticated, service_role;
revoke execute on function public.ocn_out_for_delivery(uuid, uuid) from public, anon, authenticated, service_role;
revoke execute on function public.ocn_trg_item() from public, anon, authenticated, service_role;
revoke execute on function public.ocn_trg_delivery() from public, anon, authenticated, service_role;

create trigger ocn_item_ready
  after update of production_status on public.service_order_items
  for each row
  when (old.production_status is distinct from 'ready' and new.production_status = 'ready' and new.quantity > new.cancelled_quantity)
  execute function public.ocn_trg_item();
-- cancelar a última unidade ainda não pronta também completa o pedido
create trigger ocn_item_cancel_ready
  after update of cancelled_quantity on public.service_order_items
  for each row
  when (new.cancelled_quantity > old.cancelled_quantity)
  execute function public.ocn_trg_item();
create trigger ocn_delivery_out
  after update of delivery_status on public.delivery_orders
  for each row
  when (old.delivery_status is distinct from 'out_for_delivery' and new.delivery_status = 'out_for_delivery')
  execute function public.ocn_trg_delivery();

-- ---------------------------------------------------------------------------
-- 6) Worker (SÓ service_role)
-- ---------------------------------------------------------------------------
-- Reserva as notificações vencidas/devidas: expira o que passou da validade, devolve leases mortos, e marca 'processing'.
create function public.order_notify_claim(p_limit integer default 10, p_lease_seconds integer default 120)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
begin
  update public.order_customer_notifications
     set status = 'expired', locked_until = null, error_code = coalesce(error_code, 'expired')
   where status in ('pending', 'processing') and expires_at <= now();
  -- lease morto com tentativas esgotadas
  update public.order_customer_notifications
     set status = 'failed', locked_until = null, error_code = coalesce(error_code, 'worker_interrupted')
   where status = 'processing' and locked_until < now() and attempts >= 5;

  with due as (
    select n.id from public.order_customer_notifications n
     where (n.status = 'pending' and n.available_at <= now())
        or (n.status = 'processing' and n.locked_until < now() and n.attempts < 5)
     order by n.available_at
     limit greatest(1, least(coalesce(p_limit, 10), 50))
       for update skip locked
  ), upd as (
    update public.order_customer_notifications n
       set status = 'processing', attempts = n.attempts + 1,
           locked_until = now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 120), 600)))
      from due where n.id = due.id
    returning n.id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_ids from upd;
  return jsonb_build_object('ids', to_jsonb(v_ids));
end;
$$;

-- Valida TUDO de novo no momento do envio e cria a mensagem 'queued' (origin='system'). Devolve:
--   {result:'queued', message_id} | {result:'blocked_window'|'skipped'|'expired'|'not_active', reason} | {result:'retry', reason}
create function public.order_notify_prepare(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n public.order_customer_notifications;
  v_do public.delivery_orders;
  v_so public.service_orders;
  v_conv public.whatsapp_conversations;
  v_conn public.company_whatsapp_connections;
  v_flag boolean;
  v_win jsonb;
  v_cr uuid;
  v_msg public.whatsapp_messages;
  v_old public.whatsapp_messages;
  v_body text;
begin
  select * into n from public.order_customer_notifications where id = p_id for update;
  if not found or n.status <> 'processing' then
    return jsonb_build_object('result', 'not_active');
  end if;
  if n.expires_at <= now() then
    update public.order_customer_notifications set status = 'expired', locked_until = null, error_code = 'expired' where id = n.id;
    return jsonb_build_object('result', 'expired');
  end if;

  select coalesce(s.order_status_notifications_enabled, false) into v_flag from public.company_whatsapp_ai_settings s where s.company_id = n.company_id;
  if not coalesce(v_flag, false) or not public.company_has_module(n.company_id, 'whatsapp') then
    update public.order_customer_notifications set status = 'skipped', locked_until = null, error_code = 'feature_disabled' where id = n.id;
    return jsonb_build_object('result', 'skipped', 'reason', 'feature_disabled');
  end if;

  select * into v_do from public.delivery_orders where id = n.delivery_order_id and company_id = n.company_id;
  select * into v_so from public.service_orders where id = n.service_order_id and company_id = n.company_id;
  if v_do.id is null or v_so.id is null or v_do.whatsapp_conversation_id is distinct from n.conversation_id then
    update public.order_customer_notifications set status = 'skipped', locked_until = null, error_code = 'link_invalid' where id = n.id;
    return jsonb_build_object('result', 'skipped', 'reason', 'link_invalid');
  end if;

  -- o estado oficial ainda é o que justifica o aviso?
  if n.notification_type = 'OUT_FOR_DELIVERY' then
    if v_so.status <> 'submitted' or v_do.delivery_status <> 'out_for_delivery' then
      update public.order_customer_notifications set status = 'skipped', locked_until = null, error_code = 'state_changed' where id = n.id;
      return jsonb_build_object('result', 'skipped', 'reason', 'state_changed');
    end if;
  else
    if v_do.delivery_status <> 'confirmed'
       or v_do.fulfillment <> (case n.notification_type when 'ORDER_READY_PICKUP' then 'pickup' else 'delivery' end)
       or not public.order_is_fully_ready(n.company_id, n.service_order_id) then
      update public.order_customer_notifications set status = 'skipped', locked_until = null, error_code = 'state_changed' where id = n.id;
      return jsonb_build_object('result', 'skipped', 'reason', 'state_changed');
    end if;
  end if;

  select * into v_conv from public.whatsapp_conversations where id = n.conversation_id;
  if not found then
    update public.order_customer_notifications set status = 'skipped', locked_until = null, error_code = 'conversation_missing' where id = n.id;
    return jsonb_build_object('result', 'skipped', 'reason', 'conversation_missing');
  end if;
  if v_conv.company_id <> n.company_id then
    update public.order_customer_notifications set status = 'skipped', locked_until = null, error_code = 'link_invalid' where id = n.id;
    return jsonb_build_object('result', 'skipped', 'reason', 'link_invalid');
  end if;
  if v_conv.deleted_at is not null then
    update public.order_customer_notifications set status = 'skipped', locked_until = null, error_code = 'conversation_deleted' where id = n.id;
    return jsonb_build_object('result', 'skipped', 'reason', 'conversation_deleted');
  end if;

  select * into v_conn from public.company_whatsapp_connections where id = v_conv.connection_id;
  if not found or v_conn.status <> 'active' then
    return jsonb_build_object('result', 'retry', 'reason', 'connection_inactive');
  end if;

  -- janela de 24 h (regra oficial); sem template nesta fase: fora dela NÃO tenta enviar
  v_win := public.whatsapp_can_send_freeform(v_conv.last_inbound_at);
  if not (v_win ->> 'can_send')::boolean then
    update public.order_customer_notifications set status = 'blocked_window', locked_until = null, error_code = 'window_closed' where id = n.id;
    return jsonb_build_object('result', 'blocked_window', 'reason', 'window_closed');
  end if;

  if v_conn.mode = 'test' and not exists (
    select 1 from public.whatsapp_test_recipients r
     where r.connection_id = v_conn.id and r.company_id = v_conn.company_id and r.is_active
       and public.whatsapp_br_phone_equivalent(r.phone_e164, v_conv.contact_phone)
  ) then
    update public.order_customer_notifications set status = 'skipped', locked_until = null, error_code = 'test_recipient_blocked' where id = n.id;
    return jsonb_build_object('result', 'skipped', 'reason', 'test_recipient_blocked');
  end if;

  -- tentativa anterior que ficou 'queued' (worker morreu antes de despachar): nunca fica "enviando" para sempre
  if n.message_id is not null then
    select * into v_old from public.whatsapp_messages where id = n.message_id for update;
    if found and v_old.status = 'queued' then
      update public.whatsapp_messages set status = 'failed' where id = v_old.id;
      insert into public.whatsapp_message_events (company_id, message_id, status, error_code)
      values (v_old.company_id, v_old.id, 'failed', 'send_interrupted') on conflict do nothing;
    end if;
  end if;

  -- uma mensagem por TENTATIVA (id determinístico: o retry do mesmo claim reaproveita a mesma mensagem)
  v_cr := md5(n.id::text || ':' || n.attempts::text)::uuid;
  select * into v_msg from public.whatsapp_messages where company_id = n.company_id and conversation_id = v_conv.id and client_request_id = v_cr;
  if not found then
    v_body := public.ocn_body(n.notification_type);
    insert into public.whatsapp_messages (company_id, connection_id, conversation_id, provider_message_id, direction, type, body,
                                          status, sent_by_user_id, client_request_id, origin)
    values (n.company_id, v_conv.connection_id, v_conv.id, null, 'outbound', 'text', v_body, 'queued', null, v_cr, 'system')
    returning * into v_msg;
    insert into public.whatsapp_message_events (company_id, message_id, status) values (n.company_id, v_msg.id, 'queued');
    update public.whatsapp_conversations
       set last_outbound_at = now(),
           last_message_at = greatest(coalesce(last_message_at, '-infinity'::timestamptz), now()),
           last_message_preview = left(v_body, 120)
     where id = v_conv.id;
  end if;
  update public.order_customer_notifications set message_id = v_msg.id where id = n.id;
  return jsonb_build_object('result', 'queued', 'message_id', v_msg.id, 'message_status', v_msg.status);
end;
$$;

-- Resultado do despacho. p_ok=true: lê a mensagem e fecha como 'sent'. p_ok=false: classifica o erro.
create function public.order_notify_finish(p_id uuid, p_ok boolean, p_error_code text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n public.order_customer_notifications;
  v_msg public.whatsapp_messages;
  v_code text := left(coalesce(nullif(btrim(p_error_code), ''), 'unknown'), 80);
  v_delay interval;
begin
  select * into n from public.order_customer_notifications where id = p_id for update;
  if not found or n.status <> 'processing' then
    return jsonb_build_object('result', 'not_active');
  end if;

  if p_ok then
    select * into v_msg from public.whatsapp_messages where id = n.message_id;
    update public.order_customer_notifications
       set status = 'sent', sent_at = now(), locked_until = null, error_code = null,
           provider_message_id = left(v_msg.provider_message_id, 200)
     where id = n.id;
    return jsonb_build_object('result', 'sent');
  end if;

  -- janela fechada segundo a própria Meta: encerra visível, sem retry
  if v_code in ('graph_131047', 'graph_131026') then
    update public.order_customer_notifications set status = 'blocked_window', locked_until = null, error_code = v_code where id = n.id;
    return jsonb_build_object('result', 'blocked_window');
  end if;
  if v_code = 'test_recipient_blocked' then
    update public.order_customer_notifications set status = 'skipped', locked_until = null, error_code = v_code where id = n.id;
    return jsonb_build_object('result', 'skipped');
  end if;
  -- entrega incerta (a Meta pode ter aceitado): NÃO repete, para nunca duplicar a mensagem ao cliente
  if v_code in ('timeout', 'invalid_response') then
    update public.order_customer_notifications set status = 'failed', locked_until = null, error_code = v_code where id = n.id;
    return jsonb_build_object('result', 'failed');
  end if;

  if n.attempts >= 5 then
    update public.order_customer_notifications set status = 'failed', locked_until = null, error_code = v_code where id = n.id;
    return jsonb_build_object('result', 'failed');
  end if;
  v_delay := case n.attempts when 1 then interval '30 seconds' when 2 then interval '2 minutes' when 3 then interval '10 minutes'
                              when 4 then interval '30 minutes' else interval '2 hours' end;
  if now() + v_delay >= n.expires_at then
    update public.order_customer_notifications set status = 'expired', locked_until = null, error_code = v_code where id = n.id;
    return jsonb_build_object('result', 'expired');
  end if;
  update public.order_customer_notifications
     set status = 'pending', available_at = now() + v_delay, locked_until = null, error_code = v_code
   where id = n.id;
  return jsonb_build_object('result', 'retry', 'retry_in_seconds', extract(epoch from v_delay)::integer);
end;
$$;

revoke execute on function public.order_notify_claim(integer, integer) from public, anon, authenticated;
revoke execute on function public.order_notify_prepare(uuid) from public, anon, authenticated;
revoke execute on function public.order_notify_finish(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.order_notify_claim(integer, integer) to service_role;
grant execute on function public.order_notify_prepare(uuid) to service_role;
grant execute on function public.order_notify_finish(uuid, boolean, text) to service_role;

-- ---------------------------------------------------------------------------
-- 7) "Entregue" ao cliente (status vindo do webhook da Meta) -> delivered_at da notificação
-- ---------------------------------------------------------------------------
create function public.ocn_trg_message_delivered()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.order_customer_notifications
     set delivered_at = coalesce(delivered_at, now())
   where message_id = new.id and status = 'sent';
  return null;
exception when others then
  raise warning 'ocn_trg_message_delivered falhou: %', sqlstate;
  return null;
end;
$$;
revoke execute on function public.ocn_trg_message_delivered() from public, anon, authenticated, service_role;
create trigger ocn_message_delivered
  after update of status on public.whatsapp_messages
  for each row
  when (new.origin = 'system' and new.status in ('delivered', 'read') and old.status is distinct from new.status)
  execute function public.ocn_trg_message_delivered();

-- ---------------------------------------------------------------------------
-- 8) Disparo do worker (pg_cron -> pg_net), no mesmo padrão do AUTO. Segredos no Vault:
--    WHATSAPP_ORDER_NOTIFY_URL e WHATSAPP_ORDER_NOTIFY_SECRET (criados SÓ com autorização, no ambiente real).
-- ---------------------------------------------------------------------------
create function public.order_notify_dispatch_due()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_secret text;
begin
  if not exists (
    select 1 from public.order_customer_notifications n
     where (n.status = 'pending' and n.available_at <= now()) or (n.status = 'processing' and n.locked_until < now())
  ) then
    return;
  end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'WHATSAPP_ORDER_NOTIFY_URL' limit 1;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'WHATSAPP_ORDER_NOTIFY_SECRET' limit 1;
  if nullif(btrim(coalesce(v_url, '')), '') is null or nullif(btrim(coalesce(v_secret, '')), '') is null then
    return;
  end if;
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', v_secret),
    body := jsonb_build_object('source', 'cron')
  );
exception when others then
  raise warning 'order_notify_dispatch_due falhou: %', sqlstate;
end;
$$;
revoke execute on function public.order_notify_dispatch_due() from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'gap-whatsapp-order-notify';
    perform cron.schedule('gap-whatsapp-order-notify', '10 seconds', 'select public.order_notify_dispatch_due()');
  end if;
end $$;

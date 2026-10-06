-- Notificações do DESKTOP (Tauri). Canal NATIVO do Windows, separado do Web Push: o WebView2 não tem Web Push.
-- V1: o Desktop só recebe com o aplicativo ABERTO (sem background/tray). Eventos pendentes expiram (TTL) e nunca são
-- mostrados fora da validade.
--
-- Fonte única das REGRAS de destinatário: push_role_receives() (papel x tipo de evento x destinatário único) e
-- push_sector_matches() (setor do evento x setores escolhidos no aparelho; null = todos). O Web Push (push_event_targets)
-- e o Desktop usam as MESMAS duas funções; o comportamento do Web Push não muda. Os dispositivos Desktop recebem as
-- entregas criadas na MESMA transação do evento (push_enqueue_event), sem passar pela Edge Function e sem tocar
-- sent_count/failed_count do Web Push.
--
-- Estruturas (nada disso mistura com push_subscriptions):
--   desktop_notification_devices      um Desktop (device_id gerado e guardado localmente) de um usuário em uma empresa.
--                                     is_enabled = escolha do usuário ("Desativar neste computador"); is_active = sessão
--                                     (logout desativa, login reativa). Só recebe com os dois ligados.
--   desktop_notification_deliveries   uma entrega por (evento, dispositivo), com snapshot do texto, rota e validade.
--
-- Segurança: RLS ligado, sem acesso direto a clientes (só SELECT das PRÓPRIAS entregas, para o Realtime respeitar RLS);
-- escrita só por RPCs SECURITY DEFINER que usam auth.uid() (nunca recebem user_id). device_id não concede autorização.

-- ---------------------------------------------------------------------------
-- 1) Regra de destinatário (papel x evento): função única
-- ---------------------------------------------------------------------------
create function public.push_role_receives(p_event_type text, p_role public.company_role, p_user_id uuid, p_target_user_id uuid)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case
    when p_event_type in ('new_order', 'order_cancelled_in_production') then p_role = 'production'
    when p_event_type = 'order_ready' then p_role = 'attendant' and p_user_id is not distinct from p_target_user_id
    when p_event_type in ('receivables_daily', 'payables_daily') then p_role in ('owner', 'admin')
    else false
  end;
$$;

revoke execute on function public.push_role_receives(text, public.company_role, uuid, uuid) from public, anon, authenticated;
grant execute on function public.push_role_receives(text, public.company_role, uuid, uuid) to service_role;

-- Setor: só new_order e order_cancelled_in_production dependem de setor. Aparelho com setores null = todos os setores;
-- com lista, só recebe se o evento tem setor e há interseção (evento sem setor/array vazio = só aparelhos "todos").
-- order_ready (attendant) e os resumos financeiros (owner/admin) nunca usam setor.
create function public.push_sector_matches(p_event_type text, p_event_sectors uuid[], p_device_sectors uuid[])
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_event_type not in ('new_order', 'order_cancelled_in_production')
      or p_device_sectors is null
      or (p_event_sectors is not null and p_device_sectors && p_event_sectors);
$$;

revoke execute on function public.push_sector_matches(text, uuid[], uuid[]) from public, anon, authenticated;
grant execute on function public.push_sector_matches(text, uuid[], uuid[]) to service_role;

-- Web Push: mesmo resultado de antes, agora com papel e setor vindos das funções únicas.
create or replace function public.push_event_targets(p_event_id uuid)
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
    and public.push_role_receives(e.event_type, cu.role, s.user_id, e.target_user_id)
    and public.push_sector_matches(e.event_type, e.sector_ids, s.sector_ids);
$$;

-- ---------------------------------------------------------------------------
-- 2) Dispositivos Desktop
-- ---------------------------------------------------------------------------
create table public.desktop_notification_devices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  device_name text constraint desktop_notification_devices_name_check check (device_name is null or char_length(device_name) between 1 and 80),
  is_enabled boolean not null default true,
  is_active boolean not null default true,
  -- Setores acompanhados (só production). null = todos; lista = só esses. Mesma semântica do Web Push.
  sector_ids uuid[],
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint desktop_notification_devices_unique unique (company_id, user_id, device_id)
);

-- Um Desktop físico nunca tem mais de UMA associação ativa (aparelho compartilhado entre usuários/empresas).
create unique index desktop_notification_devices_one_active on public.desktop_notification_devices (device_id) where is_active;
create index desktop_notification_devices_user_idx on public.desktop_notification_devices (user_id, company_id);

create trigger desktop_notification_devices_set_updated_at
  before update on public.desktop_notification_devices
  for each row execute function public.set_updated_at();

alter table public.desktop_notification_devices enable row level security;
revoke all on public.desktop_notification_devices from public, anon, authenticated;
grant all on public.desktop_notification_devices to service_role;

comment on table public.desktop_notification_devices is
  'Desktops (Tauri) que recebem notificações nativas. Uma linha por (empresa, usuário, device_id). Sem acesso direto de clientes; só RPCs.';

-- ---------------------------------------------------------------------------
-- 3) Entregas Desktop
-- ---------------------------------------------------------------------------
create table public.desktop_notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.push_events(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_row_id uuid not null references public.desktop_notification_devices(id) on delete cascade,
  device_id uuid not null,
  event_type text not null,
  title text not null,
  body text not null,
  url text not null,
  status text not null default 'pending'
    constraint desktop_notification_deliveries_status_check check (status in ('pending', 'claimed', 'delivered', 'failed', 'expired')),
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  -- IDEMPOTÊNCIA: um evento gera no máximo UMA entrega por dispositivo (retry/reprocessamento não duplica toast).
  constraint desktop_notification_deliveries_event_device_key unique (event_id, device_row_id)
);

create index desktop_notification_deliveries_claim_idx on public.desktop_notification_deliveries (device_row_id, status, created_at);

alter table public.desktop_notification_deliveries enable row level security;
revoke all on public.desktop_notification_deliveries from public, anon, authenticated;
grant all on public.desktop_notification_deliveries to service_role;
-- Só leitura das PRÓPRIAS entregas (necessário para o Realtime respeitar a RLS); nenhuma escrita direta.
grant select on public.desktop_notification_deliveries to authenticated;
create policy desktop_notification_deliveries_select_own on public.desktop_notification_deliveries
  for select to authenticated using (user_id = auth.uid());

comment on table public.desktop_notification_deliveries is
  'Entregas de notificação para Desktops, uma por (evento, dispositivo), com snapshot e validade (expires_at). Escrita só por funções internas/RPCs.';

-- Realtime acorda o Desktop aberto (a RLS limita cada usuário às próprias linhas); o claim por RPC garante a entrega.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'desktop_notification_deliveries') then
    alter publication supabase_realtime add table public.desktop_notification_deliveries;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 4) Criação das entregas (interna: chamada por push_enqueue_event, mesma transação do evento)
-- ---------------------------------------------------------------------------
-- Setor: production só recebe se o setor do evento está nos setores do Desktop (ou o Desktop é "todos"), decidido AQUI no
-- servidor por push_sector_matches. Validade: operacional = 1 h (igual ao TTL do Web Push de pedido); resumo financeiro = até o fim do MESMO dia
-- (America/Sao_Paulo). Só dispositivos vistos nos últimos 7 dias (Desktop abandonado não acumula entregas).
create function public.desktop_create_deliveries(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  insert into public.desktop_notification_deliveries (event_id, company_id, user_id, device_row_id, device_id, event_type, title, body, url, created_at, expires_at)
  select e.id, e.company_id, d.user_id, d.id, d.device_id, e.event_type, e.title, e.body, e.url, e.created_at,
         case when e.event_type in ('receivables_daily', 'payables_daily')
              then (((e.created_at at time zone 'America/Sao_Paulo')::date + 1)::timestamp at time zone 'America/Sao_Paulo')
              else e.created_at + interval '1 hour' end
  from public.push_events e
  join public.desktop_notification_devices d
    on d.company_id = e.company_id and d.is_enabled and d.is_active and d.last_seen_at > now() - interval '7 days'
  join public.company_users cu on cu.company_id = e.company_id and cu.user_id = d.user_id and cu.status = 'active'
  where e.id = p_event_id
    and public.push_role_receives(e.event_type, cu.role, d.user_id, e.target_user_id)
    and public.push_sector_matches(e.event_type, e.sector_ids, d.sector_ids)
  on conflict (event_id, device_row_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke execute on function public.desktop_create_deliveries(uuid) from public, anon, authenticated;
grant execute on function public.desktop_create_deliveries(uuid) to service_role;

-- Ponto único de criação do evento: grava (dedupe), despacha o Web Push (igual a antes) e cria as entregas Desktop.
-- A falha do canal Desktop NUNCA derruba o evento nem a operação que o gerou (pedido, cancelamento...).
create or replace function public.push_enqueue_event(
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
    begin
      perform public.desktop_create_deliveries(v_id);
    exception when others then
      raise warning 'desktop_create_deliveries falhou para %: %', v_id, sqlerrm;
    end;
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) RPCs do cliente (auth.uid(); nunca aceitam user_id)
-- ---------------------------------------------------------------------------
create function public.desktop_assert_member(p_company_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if not exists (select 1 from public.company_users cu where cu.company_id = p_company_id and cu.user_id = v_uid and cu.status = 'active') then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  return v_uid;
end;
$$;

revoke execute on function public.desktop_assert_member(uuid) from public, anon, authenticated;

-- Registra/reativa ESTE Desktop para o usuário atual. Desativa a associação ativa de qualquer OUTRO usuário/empresa
-- naquele device_id (aparelho compartilhado) e preserva a escolha is_enabled do próprio usuário (logout não é opt-out).
create function public.register_desktop_notification_device(p_company_id uuid, p_device_id uuid, p_device_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.desktop_assert_member(p_company_id);
  v_role public.company_role := public.user_role_in_company(p_company_id);
  v_name text := nullif(left(btrim(regexp_replace(coalesce(p_device_name, ''), '\s+', ' ', 'g')), 80), '');
  v_row public.desktop_notification_devices;
  v_sectors uuid[];
begin
  if p_device_id is null then
    raise exception 'Dispositivo inválido.' using errcode = 'PT400';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_device_id::text, 0));

  update public.desktop_notification_devices
     set is_active = false
   where device_id = p_device_id and is_active and not (user_id = v_uid and company_id = p_company_id);

  select * into v_row from public.desktop_notification_devices
   where company_id = p_company_id and user_id = v_uid and device_id = p_device_id for update;

  if found then
    -- Reativa a PRÓPRIA linha. Setores salvos: revalidados (ativos, da empresa); só production os mantém; sem nenhum
    -- válido vira "todos" (null). Igual ao Web Push.
    v_sectors := null;
    if v_role = 'production' and v_row.sector_ids is not null then
      select array_agg(ps.id order by ps.id) into v_sectors
      from public.production_sectors ps
      where ps.company_id = p_company_id and ps.is_active and ps.id = any (v_row.sector_ids);
    end if;
    update public.desktop_notification_devices
       set is_active = true, last_seen_at = now(), sector_ids = v_sectors,
           device_name = coalesce(v_name, device_name)
     where id = v_row.id
    returning * into v_row;
  else
    insert into public.desktop_notification_devices (company_id, user_id, device_id, device_name)
    values (p_company_id, v_uid, p_device_id, v_name)
    returning * into v_row;
  end if;

  return jsonb_build_object('id', v_row.id, 'is_enabled', v_row.is_enabled, 'is_active', v_row.is_active, 'last_seen_at', v_row.last_seen_at, 'sector_ids', v_row.sector_ids);
end;
$$;

-- "Desativar/Ativar neste computador": opt-out do usuário neste Desktop (nunca apaga a linha).
create function public.set_desktop_notification_enabled(p_company_id uuid, p_device_id uuid, p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.desktop_assert_member(p_company_id);
  v_row public.desktop_notification_devices;
begin
  if p_enabled is null then
    raise exception 'Valor inválido.' using errcode = 'PT400';
  end if;
  update public.desktop_notification_devices
     set is_enabled = p_enabled
   where company_id = p_company_id and user_id = v_uid and device_id = p_device_id
  returning * into v_row;
  if not found then
    raise exception 'Dispositivo não encontrado.' using errcode = 'PT404';
  end if;
  return jsonb_build_object('id', v_row.id, 'is_enabled', v_row.is_enabled, 'is_active', v_row.is_active, 'sector_ids', v_row.sector_ids);
end;
$$;

-- Setores deste Desktop (só production). null = todos; lista = só esses. O servidor valida: papel production, ao menos
-- um setor, todos ATIVOS e DA MESMA empresa (nada vindo do cliente é confiado). Mesma regra do Web Push.
create function public.set_desktop_notification_sectors(p_company_id uuid, p_device_id uuid, p_sector_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.desktop_assert_member(p_company_id);
  v_role public.company_role := public.user_role_in_company(p_company_id);
  v_sectors uuid[];
  v_row public.desktop_notification_devices;
begin
  if p_sector_ids is not null then
    if v_role <> 'production' then
      raise exception 'Só o papel Produção escolhe setores.' using errcode = 'PT403';
    end if;
    select coalesce(array_agg(distinct x), '{}') into v_sectors from unnest(p_sector_ids) as x;
    if cardinality(v_sectors) = 0 then
      raise exception 'Escolha ao menos um setor ou use todos.' using errcode = 'PT400';
    end if;
    if (select count(*) from public.production_sectors ps
         where ps.company_id = p_company_id and ps.id = any (v_sectors) and ps.is_active) <> cardinality(v_sectors) then
      raise exception 'Setor inválido.' using errcode = 'PT400';
    end if;
  end if;
  update public.desktop_notification_devices
     set sector_ids = v_sectors
   where company_id = p_company_id and user_id = v_uid and device_id = p_device_id
  returning * into v_row;
  if not found then
    raise exception 'Dispositivo não encontrado.' using errcode = 'PT404';
  end if;
  return jsonb_build_object('id', v_row.id, 'is_enabled', v_row.is_enabled, 'is_active', v_row.is_active, 'sector_ids', v_row.sector_ids);
end;
$$;

-- Logout: desativa a associação deste Desktop do usuário atual (todas as empresas). Não apaga entregas nem histórico.
create function public.deactivate_desktop_notification_device(p_device_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  update public.desktop_notification_devices set is_active = false where device_id = p_device_id and user_id = auth.uid() and is_active;
end;
$$;

-- Batimento (app aberto): renova last_seen_at e devolve o estado salvo.
create function public.heartbeat_desktop_notification_device(p_company_id uuid, p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.desktop_assert_member(p_company_id);
  v_row public.desktop_notification_devices;
begin
  update public.desktop_notification_devices
     set last_seen_at = now()
   where company_id = p_company_id and user_id = v_uid and device_id = p_device_id
  returning * into v_row;
  if not found then
    raise exception 'Dispositivo não encontrado.' using errcode = 'PT404';
  end if;
  return jsonb_build_object('id', v_row.id, 'is_enabled', v_row.is_enabled, 'is_active', v_row.is_active, 'last_seen_at', v_row.last_seen_at, 'sector_ids', v_row.sector_ids);
end;
$$;

-- Reivindica as entregas VÁLIDAS e pendentes deste Desktop (atômico, SKIP LOCKED). Entregas vencidas viram 'expired'
-- (nunca são devolvidas: sem toast de pedido de ontem). Uma entrega 'claimed' há mais de 2 min sem conclusão volta a
-- ser reivindicável (o app fechou no meio). Só devolve algo se o Desktop estiver ativo E habilitado e o vínculo ativo.
create function public.claim_desktop_notifications(p_company_id uuid, p_device_id uuid, p_limit integer default 5)
returns table (id uuid, event_type text, title text, body text, url text, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.desktop_assert_member(p_company_id);
  v_dev public.desktop_notification_devices;
begin
  select * into v_dev from public.desktop_notification_devices d
   where d.company_id = p_company_id and d.user_id = v_uid and d.device_id = p_device_id;
  if not found then
    raise exception 'Dispositivo não encontrado.' using errcode = 'PT404';
  end if;

  update public.desktop_notification_devices set last_seen_at = now() where desktop_notification_devices.id = v_dev.id;

  update public.desktop_notification_deliveries x
     set status = 'expired'
   where x.device_row_id = v_dev.id and x.status in ('pending', 'claimed') and x.expires_at <= now();

  if not v_dev.is_enabled or not v_dev.is_active then
    return;
  end if;

  return query
  with c as (
    select x.id
    from public.desktop_notification_deliveries x
    where x.device_row_id = v_dev.id
      and x.user_id = v_uid
      and x.expires_at > now()
      and (x.status = 'pending' or (x.status = 'claimed' and x.claimed_at < now() - interval '2 minutes'))
    order by x.created_at
    limit least(greatest(coalesce(p_limit, 5), 1), 20)
    for update skip locked
  )
  update public.desktop_notification_deliveries x
     set status = 'claimed', claimed_at = now(), attempts = x.attempts + 1
    from c
   where x.id = c.id
  returning x.id, x.event_type, x.title, x.body, x.url, x.created_at;
end;
$$;

-- Marca o resultado do toast (delivered/failed). Só a entrega do PRÓPRIO usuário, reivindicada e ainda válida.
create function public.complete_desktop_notification(p_delivery_id uuid, p_ok boolean default true)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  update public.desktop_notification_deliveries
     set status = case when coalesce(p_ok, true) then 'delivered' else 'failed' end,
         delivered_at = case when coalesce(p_ok, true) then now() else delivered_at end
   where id = p_delivery_id and user_id = auth.uid() and status = 'claimed';
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) ACL explícita (anon sem nada; authenticated só as RPCs do cliente)
-- ---------------------------------------------------------------------------
revoke execute on function public.register_desktop_notification_device(uuid, uuid, text) from public, anon;
revoke execute on function public.set_desktop_notification_enabled(uuid, uuid, boolean) from public, anon;
revoke execute on function public.set_desktop_notification_sectors(uuid, uuid, uuid[]) from public, anon;
revoke execute on function public.deactivate_desktop_notification_device(uuid) from public, anon;
revoke execute on function public.heartbeat_desktop_notification_device(uuid, uuid) from public, anon;
revoke execute on function public.claim_desktop_notifications(uuid, uuid, integer) from public, anon;
revoke execute on function public.complete_desktop_notification(uuid, boolean) from public, anon;
grant execute on function public.register_desktop_notification_device(uuid, uuid, text) to authenticated;
grant execute on function public.set_desktop_notification_enabled(uuid, uuid, boolean) to authenticated;
grant execute on function public.set_desktop_notification_sectors(uuid, uuid, uuid[]) to authenticated;
grant execute on function public.deactivate_desktop_notification_device(uuid) to authenticated;
grant execute on function public.heartbeat_desktop_notification_device(uuid, uuid) to authenticated;
grant execute on function public.claim_desktop_notifications(uuid, uuid, integer) to authenticated;
grant execute on function public.complete_desktop_notification(uuid, boolean) to authenticated;

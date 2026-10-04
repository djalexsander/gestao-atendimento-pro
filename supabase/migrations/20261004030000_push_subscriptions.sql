-- PUSH NOTIFICATIONS — etapa A: aparelhos (subscriptions de Web Push) e as RPCs que os gerenciam.
--
-- Um "aparelho" é um endpoint de Web Push de um navegador/PWA. Cada linha liga UM endpoint a UMA empresa e
-- UM usuário (decisão de produto: um aparelho acompanha uma empresa por vez, a do activeMembership).
-- Registrar o mesmo endpoint para outro usuário/empresa DESATIVA a associação antiga (aparelho
-- compartilhado nunca entrega o push do usuário anterior ao novo).
--
-- Segurança:
--   * endpoint, p256dh e auth são CREDENCIAIS de envio: nenhum papel de cliente (anon/authenticated) lê,
--     insere, altera ou apaga a tabela. Tudo passa por RPC SECURITY DEFINER (ou service_role, na Edge).
--   * my_push_devices devolve só metadados seguros (nunca endpoint/chaves).
--   * Os envios (Edge Functions push-test e push-dispatch) usam service_role e as funções push_* abaixo,
--     que NÃO têm EXECUTE para clientes.
--   * Fora do Realtime: nada aqui entra na publication supabase_realtime.
--
-- Erros: PT401 sem sessão, PT404 empresa/aparelho não encontrado, PT403 sem permissão, PT400 dados inválidos.

-- ---------------------------------------------------------------------------
-- 1) Tabela
-- ---------------------------------------------------------------------------
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null
    constraint push_subscriptions_endpoint_check check (endpoint ~ '^https://' and char_length(endpoint) <= 2000),
  p256dh text not null
    constraint push_subscriptions_p256dh_check check (char_length(p256dh) between 1 and 256),
  auth text not null
    constraint push_subscriptions_auth_check check (char_length(auth) between 1 and 256),
  platform text not null default 'unknown'
    constraint push_subscriptions_platform_check check (platform in ('ios', 'android', 'desktop', 'unknown')),
  user_agent text
    constraint push_subscriptions_user_agent_check check (user_agent is null or char_length(user_agent) <= 500),
  device_name text
    constraint push_subscriptions_device_name_check check (device_name is null or char_length(device_name) between 1 and 60),
  -- Só faz sentido para o papel production: setores que ESTE aparelho acompanha. NULL = todos.
  sector_ids uuid[]
    constraint push_subscriptions_sector_ids_check check (sector_ids is null or cardinality(sector_ids) between 1 and 100),
  is_active boolean not null default true,
  failure_count integer not null default 0
    constraint push_subscriptions_failure_count_check check (failure_count >= 0),
  last_failure_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint push_subscriptions_endpoint_company_key unique (endpoint, company_id)
);

comment on table public.push_subscriptions is
  'Aparelhos de Web Push. endpoint/p256dh/auth são credenciais: sem acesso direto de clientes (só RPC e service_role). Um endpoint ativo pertence a uma empresa/usuário por vez.';

create trigger push_subscriptions_set_updated_at
  before update on public.push_subscriptions
  for each row execute function public.set_updated_at();

-- aparelhos ativos de um usuário numa empresa (lista do usuário e resolução de destinatários)
create index push_subscriptions_active_user_idx
  on public.push_subscriptions (company_id, user_id) where is_active = true;
-- localizar rapidamente todas as associações de um mesmo endpoint
create index push_subscriptions_endpoint_idx on public.push_subscriptions (endpoint);

alter table public.push_subscriptions enable row level security;

revoke all on public.push_subscriptions from public, anon, authenticated;
grant all on public.push_subscriptions to service_role;

-- ---------------------------------------------------------------------------
-- 2) Helper interno: página inicial por papel (também usada pelos envios)
-- ---------------------------------------------------------------------------
create function public.push_home_path(p_role public.company_role)
returns text
language sql
immutable
set search_path = public
as $$
  select case p_role::text
    when 'production' then '/operacional/producao'
    when 'attendant' then '/operacional/atendimento'
    when 'cashier' then '/operacional/caixa'
    else '/app'
  end;
$$;

revoke execute on function public.push_home_path(public.company_role) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) RPCs do usuário (SECURITY DEFINER; só authenticated)
-- ---------------------------------------------------------------------------
create function public.register_push_subscription(
  p_company_id uuid,
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_platform text default 'unknown',
  p_user_agent text default null,
  p_device_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_endpoint text := btrim(coalesce(p_endpoint, ''));
  v_p256dh text := btrim(coalesce(p_p256dh, ''));
  v_auth text := btrim(coalesce(p_auth, ''));
  v_platform text := coalesce(nullif(btrim(coalesce(p_platform, '')), ''), 'unknown');
  v_name text := nullif(btrim(coalesce(p_device_name, '')), '');
  v_ua text := nullif(left(btrim(coalesce(p_user_agent, '')), 500), '');
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  -- vínculo ATIVO na empresa informada (nunca empresa arbitrária)
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;

  if v_endpoint = '' or v_endpoint !~ '^https://' or char_length(v_endpoint) > 2000 then
    raise exception 'Aparelho inválido para notificações.' using errcode = 'PT400';
  end if;
  if v_p256dh = '' or v_auth = '' or char_length(v_p256dh) > 256 or char_length(v_auth) > 256 then
    raise exception 'Aparelho inválido para notificações.' using errcode = 'PT400';
  end if;
  if v_platform not in ('ios', 'android', 'desktop', 'unknown') then
    raise exception 'Plataforma inválida.' using errcode = 'PT400';
  end if;
  if v_name is not null and char_length(v_name) > 60 then
    raise exception 'O nome do aparelho pode ter no máximo 60 caracteres.' using errcode = 'PT400';
  end if;

  -- O mesmo endpoint associado a OUTRO usuário ou a OUTRA empresa deixa de receber.
  update public.push_subscriptions
     set is_active = false
   where endpoint = v_endpoint
     and is_active
     and not (company_id = p_company_id and user_id = auth.uid());

  insert into public.push_subscriptions (company_id, user_id, endpoint, p256dh, auth, platform, user_agent, device_name)
  values (p_company_id, auth.uid(), v_endpoint, v_p256dh, v_auth, v_platform, v_ua, v_name)
  on conflict (endpoint, company_id) do update
    set user_id = auth.uid(),
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        platform = excluded.platform,
        user_agent = excluded.user_agent,
        device_name = coalesce(excluded.device_name, case when push_subscriptions.user_id = auth.uid() then push_subscriptions.device_name end),
        -- setores escolhidos só sobrevivem se o aparelho continua com o MESMO usuário
        sector_ids = case when push_subscriptions.user_id = auth.uid() then push_subscriptions.sector_ids end,
        is_active = true,
        failure_count = 0,
        last_failure_at = null
  returning id into v_id;

  return v_id;
end;
$$;

-- Desativa este aparelho (todas as associações do endpoint que sejam do próprio usuário). Idempotente.
create function public.remove_push_subscription(p_endpoint text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  update public.push_subscriptions
     set is_active = false
   where endpoint = btrim(coalesce(p_endpoint, '')) and user_id = auth.uid() and is_active;
end;
$$;

-- Metadados SEGUROS dos aparelhos do usuário numa empresa (nunca endpoint/p256dh/auth).
-- p_endpoint (opcional) só serve para marcar qual deles é o aparelho atual (is_current).
create function public.my_push_devices(p_company_id uuid, p_endpoint text default null)
returns table (
  id uuid,
  platform text,
  device_name text,
  is_active boolean,
  sector_ids uuid[],
  created_at timestamptz,
  last_used_at timestamptz,
  is_current boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if public.user_role_in_company(p_company_id) is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;

  return query
  select s.id, s.platform, s.device_name, s.is_active, s.sector_ids, s.created_at, s.last_used_at,
         (p_endpoint is not null and s.endpoint = p_endpoint) as is_current
  from public.push_subscriptions s
  where s.company_id = p_company_id and s.user_id = auth.uid()
  order by s.is_active desc, coalesce(s.last_used_at, s.created_at) desc, s.id;
end;
$$;

-- Opções de UM aparelho do próprio usuário: setores acompanhados (production) e nome.
-- p_sector_ids NULL = todos os setores. Array vazio é recusado.
create function public.set_push_device_options(
  p_device_id uuid,
  p_sector_ids uuid[] default null,
  p_device_name text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dev public.push_subscriptions;
  v_role public.company_role;
  v_sectors uuid[];
  v_name text := nullif(btrim(coalesce(p_device_name, '')), '');
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_dev from public.push_subscriptions where id = p_device_id and user_id = auth.uid();
  if not found then
    raise exception 'Aparelho não encontrado.' using errcode = 'PT404';
  end if;
  v_role := public.user_role_in_company(v_dev.company_id);
  if v_role is null then
    raise exception 'Aparelho não encontrado.' using errcode = 'PT404';
  end if;

  if v_name is not null and char_length(v_name) > 60 then
    raise exception 'O nome do aparelho pode ter no máximo 60 caracteres.' using errcode = 'PT400';
  end if;

  if p_sector_ids is not null then
    if v_role <> 'production' then
      raise exception 'Só o papel Produção escolhe setores.' using errcode = 'PT403';
    end if;
    select coalesce(array_agg(distinct x), '{}') into v_sectors from unnest(p_sector_ids) as x;
    if cardinality(v_sectors) = 0 then
      raise exception 'Escolha ao menos um setor ou use todos.' using errcode = 'PT400';
    end if;
    if (select count(*) from public.production_sectors ps
         where ps.company_id = v_dev.company_id and ps.id = any (v_sectors) and ps.is_active) <> cardinality(v_sectors) then
      raise exception 'Setor inválido.' using errcode = 'PT400';
    end if;
  end if;

  update public.push_subscriptions
     set sector_ids = v_sectors,
         device_name = coalesce(v_name, device_name)
   where id = v_dev.id;
end;
$$;

revoke execute on function public.register_push_subscription(uuid, text, text, text, text, text, text) from public, anon;
grant execute on function public.register_push_subscription(uuid, text, text, text, text, text, text) to authenticated;
revoke execute on function public.remove_push_subscription(text) from public, anon;
grant execute on function public.remove_push_subscription(text) to authenticated;
revoke execute on function public.my_push_devices(uuid, text) from public, anon;
grant execute on function public.my_push_devices(uuid, text) to authenticated;
revoke execute on function public.set_push_device_options(uuid, uuid[], text) from public, anon;
grant execute on function public.set_push_device_options(uuid, uuid[], text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Funções SÓ para a Edge (service_role): alvo do teste e resultado do envio
-- ---------------------------------------------------------------------------
-- Devolve as credenciais de UM aparelho se ele for do usuário (já autenticado pela Edge), estiver ativo e o
-- vínculo na empresa continuar ativo. Nunca exposta a clientes.
create function public.push_test_target(p_user_id uuid, p_device_id uuid)
returns table (subscription_id uuid, endpoint text, p256dh text, auth text, role public.company_role, url text)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.endpoint, s.p256dh, s.auth, cu.role, public.push_home_path(cu.role)
  from public.push_subscriptions s
  join public.company_users cu on cu.company_id = s.company_id and cu.user_id = s.user_id and cu.status = 'active'
  where s.id = p_device_id and s.user_id = p_user_id and s.is_active;
$$;

-- Registra o resultado de um envio: ok zera as falhas; gone (404/410) desativa; error soma falha e, a partir
-- de 5 falhas seguidas, desativa. Idempotente por chamada.
create function public.push_record_outcome(p_subscription_id uuid, p_outcome text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_outcome not in ('ok', 'gone', 'error') then
    raise exception 'Resultado inválido.' using errcode = 'PT400';
  end if;

  if p_outcome = 'ok' then
    update public.push_subscriptions
       set failure_count = 0, last_failure_at = null, last_used_at = now()
     where id = p_subscription_id;
  elsif p_outcome = 'gone' then
    update public.push_subscriptions
       set is_active = false, last_failure_at = now()
     where id = p_subscription_id;
  else
    update public.push_subscriptions
       set failure_count = failure_count + 1,
           last_failure_at = now(),
           is_active = case when failure_count + 1 >= 5 then false else is_active end
     where id = p_subscription_id;
  end if;
end;
$$;

revoke execute on function public.push_test_target(uuid, uuid) from public, anon, authenticated;
grant execute on function public.push_test_target(uuid, uuid) to service_role;
revoke execute on function public.push_record_outcome(uuid, text) from public, anon, authenticated;
grant execute on function public.push_record_outcome(uuid, text) to service_role;

-- WhatsApp e Inteligência Artificial como DOIS módulos comerciais independentes.
--
-- ANTES: tudo (canal, atendimento manual E a IA) era liberado pelo módulo 'whatsapp'. A IA não tinha módulo próprio.
-- DEPOIS:
--   whatsapp  canal: receber, enviar, atendimento manual, conversas, notificações de pedido. Não depende de 'ia'.
--   ia        automação: sugestão, atendimento automático, base de conhecimento, rascunhos e pedido pela IA. SÓ atua com
--             'whatsapp' também ativo (whatsapp_ai_allowed). 'ia' sozinho não executa nada pelo canal.
--
-- DECISÕES (aprovadas):
--  1) código 'ia'; os dois módulos seguem INATIVOS no catálogo e com preço 0 (preço/ativação comercial é decisão posterior).
--  2) 'ia' é concedido (company_module_overrides) APENAS às empresas que hoje têm 'whatsapp' por override — produção segue igual.
--  3) histórico preservado em SOMENTE LEITURA depois do cancelamento do WhatsApp (RLS de select sem exigir o módulo);
--     envio, atribuição, status, vínculo, exclusão e IA continuam exigindo o módulo.
--  4) modules.explicit_only: módulo que NUNCA entra no "todos os módulos ativos" de trial/legado. Só assinatura
--     (subscription_modules) ou override concede. whatsapp e ia nascem explicit_only.
--  5) nada é apagado: desconectar só marca a conexão (histórico, configurações e token no Vault permanecem).
--  6) Embedded Signup da Meta: apenas ESTRUTURA (flag da plataforma desligada + tentativas). Nada é simulado.
--
-- As funções existentes são ajustadas por substituição EXATA do trecho do gate (pg_get_functiondef), com contagem
-- conferida: se o corpo vigente não tiver o trecho esperado, a migration ABORTA em vez de aplicar pela metade.

-- ---------------------------------------------------------------------------
-- 1) Catálogo: módulo ia + explicit_only
-- ---------------------------------------------------------------------------
alter table public.modules add column explicit_only boolean not null default false;

comment on column public.modules.explicit_only is
  'true = o módulo nunca é concedido automaticamente a trial/legado por estar ativo no catálogo; só assinatura contratada ou override.';

insert into public.modules (code, name, description, monthly_price_cents, is_active) values
  ('ia', 'Inteligência Artificial',
   'Atendimento automático pelo WhatsApp: consulta ao catálogo, pedidos por conversa e transferência para humano. Requer o módulo WhatsApp.', 0, false)
on conflict (code) do nothing;

update public.modules set explicit_only = true where code in ('whatsapp', 'ia');

-- Concessão de 'ia' SOMENTE a quem hoje tem 'whatsapp' por override (mesma validade; nada global).
insert into public.company_module_overrides (company_id, module_code, reason, expires_at, created_by)
select o.company_id, 'ia', 'separação WhatsApp/IA: preserva a IA já em uso', o.expires_at, o.created_by
  from public.company_module_overrides o
 where o.module_code = 'whatsapp'
on conflict (company_id, module_code) do nothing;

-- ---------------------------------------------------------------------------
-- 2) Entitlement: explicit_only fora do "todos" de trial/legado (assinatura e override continuam concedendo)
-- ---------------------------------------------------------------------------
create or replace function public.company_entitlement(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_base jsonb;
  v_extra text[];
  v_mods text[];
begin
  v_base := public.company_entitlement_base(p_company_id);

  -- trial e legado recebem "todos os ativos": tira os módulos de concessão explícita.
  if v_base ->> 'mode' in ('trial', 'unmanaged') then
    select coalesce(array_agg(m order by m), '{}') into v_mods
      from jsonb_array_elements_text(v_base -> 'modules') m
     where not exists (select 1 from public.modules x where x.code = m and x.explicit_only);
    v_base := jsonb_set(v_base, '{modules}', to_jsonb(v_mods));
  end if;

  select coalesce(array_agg(o.module_code order by o.module_code), '{}') into v_extra
    from public.company_module_overrides o
   where o.company_id = p_company_id
     and (o.expires_at is null or o.expires_at > now());

  if cardinality(v_extra) = 0 or v_base ->> 'mode' = 'pending_payment' then
    return v_base;
  end if;

  return jsonb_set(
           v_base, '{modules}',
           (select coalesce(jsonb_agg(m order by m), '[]'::jsonb)
              from (select distinct m from unnest(array(select jsonb_array_elements_text(v_base -> 'modules')) || v_extra) as m) u)
         ) || jsonb_build_object('overrides', to_jsonb(v_extra));
end;
$$;

revoke execute on function public.company_entitlement(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) Helpers
-- ---------------------------------------------------------------------------
-- A IA só atua com os DOIS módulos. Usado por todo gate de automação.
create function public.whatsapp_ai_allowed(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.company_has_module(p_company_id, 'whatsapp') and public.company_has_module(p_company_id, 'ia');
$$;

-- Histórico em somente leitura: basta ser membro da empresa (o papel é conferido na própria policy).
create function public.whatsapp_history_rls(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.user_company_ids() u where u = p_company_id);
$$;

-- Leitor da IA: papel permitido + AMBOS os módulos.
create function public.whatsapp_assert_ai_reader(p_company_id uuid)
returns public.company_role
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
begin
  v_role := public.whatsapp_assert_reader(p_company_id);
  perform public.assert_company_module(p_company_id, 'ia');
  return v_role;
end;
$$;

revoke execute on function public.whatsapp_ai_allowed(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.whatsapp_history_rls(uuid) from public, anon, service_role;
grant execute on function public.whatsapp_history_rls(uuid) to authenticated;
revoke execute on function public.whatsapp_assert_ai_reader(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4) Gates nas funções existentes (substituição exata, conferida)
-- ---------------------------------------------------------------------------
create function pg_temp.patch_fn(p_name text, p_from text, p_to text, p_regex boolean default false)
returns void
language plpgsql
as $$
declare
  v_oid oid;
  v_def text;
  v_new text;
begin
  select p.oid into v_oid from pg_proc p where p.proname = p_name and p.pronamespace = 'public'::regnamespace;
  if v_oid is null then
    raise exception 'patch_fn: função % não encontrada', p_name;
  end if;
  v_def := pg_get_functiondef(v_oid);
  if p_regex then
    v_new := regexp_replace(v_def, p_from, p_to);
  else
    if (length(v_def) - length(replace(v_def, p_from, ''))) / greatest(length(p_from), 1) <> 1 then
      raise exception 'patch_fn: trecho esperado não ocorre exatamente 1 vez em %', p_name;
    end if;
    v_new := replace(v_def, p_from, p_to);
  end if;
  if v_new = v_def then
    raise exception 'patch_fn: nada mudou em %', p_name;
  end if;
  execute v_new;
end;
$$;

-- IA automática: ambos os módulos.
select pg_temp.patch_fn('whatsapp_ai_prepare_auto',
  $f$if not public.company_has_module(v_job.company_id, 'whatsapp') then$f$,
  $f$if not public.whatsapp_ai_allowed(v_job.company_id) then$f$);
select pg_temp.patch_fn('whatsapp_ai_auto_commit_send',
  $f$if not public.company_has_module(v_job.company_id, 'whatsapp') then$f$,
  $f$if not public.whatsapp_ai_allowed(v_job.company_id) then$f$);
select pg_temp.patch_fn('whatsapp_order_ctx',
  $f$not public.company_has_module(v_job.company_id, 'whatsapp') or$f$,
  $f$not public.whatsapp_ai_allowed(v_job.company_id) or$f$);
select pg_temp.patch_fn('create_delivery_order_engine',
  $f$perform public.assert_company_module(p_company_id, 'whatsapp');$f$,
  $f$perform public.assert_company_module(p_company_id, 'whatsapp');
    perform public.assert_company_module(p_company_id, 'ia');$f$);

-- Fila: sem os dois módulos nem job é criado.
select pg_temp.patch_fn('whatsapp_ai_enqueue_inbound',
  $f$select * into v_s from public.company_whatsapp_ai_settings where company_id = new.company_id;$f$,
  $f$select * into v_s from public.company_whatsapp_ai_settings where company_id = new.company_id;
    if not public.whatsapp_ai_allowed(new.company_id) then
      return new;
    end if;$f$);

-- Sugestão manual e consulta de conhecimento (acionadas por humanos, mas são IA).
select pg_temp.patch_fn('whatsapp_ai_prepare_suggestion',
  '(\w+) := public\.whatsapp_load_conversation\(p_conversation_id\);',
  E'\\1 := public.whatsapp_load_conversation(p_conversation_id);\n  perform public.assert_company_module(\\1.company_id, ''ia'');', true);
select pg_temp.patch_fn('whatsapp_ai_lookup_knowledge',
  '(\w+) := public\.whatsapp_load_conversation\(p_conversation_id\);',
  E'\\1 := public.whatsapp_load_conversation(p_conversation_id);\n  perform public.assert_company_module(\\1.company_id, ''ia'');', true);

-- Configuração da IA: ambos os módulos (o leitor de configuração, abaixo, é tolerante e informa o estado).
select pg_temp.patch_fn('whatsapp_ai_update_settings', 'public.whatsapp_assert_reader(', 'public.whatsapp_assert_ai_reader(');
select pg_temp.patch_fn('whatsapp_ai_set_display_name', 'public.whatsapp_assert_reader(', 'public.whatsapp_assert_ai_reader(');
select pg_temp.patch_fn('whatsapp_ai_get_business_profile', 'public.whatsapp_assert_reader(', 'public.whatsapp_assert_ai_reader(');
select pg_temp.patch_fn('whatsapp_ai_update_business_profile', 'public.whatsapp_assert_reader(', 'public.whatsapp_assert_ai_reader(');

-- Leitura da configuração (usada também pela caixa de entrada): sem 'ia' devolve modo desligado, sem erro.
select pg_temp.patch_fn('whatsapp_ai_get_settings',
  $f$v_role := public.whatsapp_assert_reader(p_company_id);$f$,
  $f$v_role := public.whatsapp_assert_reader(p_company_id);
  if not public.company_has_module(p_company_id, 'ia') then
    return jsonb_build_object('effective_mode', 'off', 'ai_allowed', false);
  end if;$f$);

-- O envio já enfileirado para de sair se o módulo WhatsApp for cancelado.
select pg_temp.patch_fn('whatsapp_get_send_context',
  $f$if not found or v_conn.status <> 'active' or v_conn.phone_number_id is null then$f$,
  $f$if not public.company_has_module(v_msg.company_id, 'whatsapp') then
    return jsonb_build_object('ok', false, 'error', 'module_inactive');
  end if;
  if not found or v_conn.status <> 'active' or v_conn.phone_number_id is null then$f$);

-- ---------------------------------------------------------------------------
-- 5) Policies de leitura
--    canal (conversas, mensagens, eventos, ajustes): histórico SEM exigir o módulo (somente leitura; só select existe)
--    IA (config, rascunhos, escolhas): exigem 'ia'
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  v_old constant text := 'company_has_module_rls(company_id, ''whatsapp''::text)';
  v_new text;
  v_n integer := 0;
begin
  for r in
    select tablename, policyname, qual
      from pg_policies
     where schemaname = 'public' and cmd = 'SELECT' and qual like '%' || v_old || '%'
       and tablename in (
         'whatsapp_conversations', 'whatsapp_messages', 'whatsapp_message_events', 'whatsapp_conversation_events',
         'company_whatsapp_settings',
         'company_whatsapp_ai_settings', 'whatsapp_order_drafts', 'whatsapp_order_draft_items',
         'whatsapp_order_draft_item_modifiers', 'whatsapp_order_draft_events', 'whatsapp_order_choices')
  loop
    v_new := case
      when r.tablename in ('whatsapp_conversations', 'whatsapp_messages', 'whatsapp_message_events',
                           'whatsapp_conversation_events', 'company_whatsapp_settings')
        then 'public.whatsapp_history_rls(company_id)'
      else 'public.company_has_module_rls(company_id, ''ia''::text)'
    end;
    execute format('alter policy %I on public.%I using (%s)', r.policyname, r.tablename, replace(r.qual, v_old, v_new));
    v_n := v_n + 1;
  end loop;
  if v_n <> 11 then
    raise exception 'policies ajustadas: % (esperado 11)', v_n;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Painel: estado dos módulos, resumo da conexão, desconexão, indicadores
-- ---------------------------------------------------------------------------
-- Estado para as telas (qualquer membro de papel operacional; NÃO exige módulo: é ele que explica o que falta).
create function public.whatsapp_get_module_state(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_wa boolean;
  v_ia boolean;
  v_conn_active boolean;
  v_signup jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'attendant', 'cashier') then
    raise exception 'Você não tem permissão para usar o WhatsApp.' using errcode = 'PT403';
  end if;
  v_wa := public.company_has_module(p_company_id, 'whatsapp');
  v_ia := public.company_has_module(p_company_id, 'ia');
  select exists (select 1 from public.company_whatsapp_connections c where c.company_id = p_company_id and c.status = 'active')
    into v_conn_active;
  v_signup := public.whatsapp_signup_availability();
  return jsonb_build_object(
    'whatsapp', v_wa,
    'ia', v_ia,
    'ai_allowed', v_wa and v_ia,
    'connection_active', v_conn_active,
    'has_history', exists (select 1 from public.whatsapp_conversations c where c.company_id = p_company_id and c.deleted_at is null),
    'can_manage', v_role in ('owner', 'admin'),
    'role', v_role,
    'signup', v_signup);
end;
$$;

-- Resumo da conexão: agora legível em somente leitura também sem o módulo (histórico), com indicadores de não lidas.
create or replace function public.whatsapp_get_connection_summary(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_c public.company_whatsapp_connections;
  v_unread bigint;
  v_open bigint;
  v_flags jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'attendant', 'cashier') then
    raise exception 'Você não tem permissão para usar o WhatsApp.' using errcode = 'PT403';
  end if;
  select coalesce(sum(unread_count), 0), count(*) filter (where status <> 'closed')
    into v_unread, v_open
    from public.whatsapp_conversations where company_id = p_company_id and deleted_at is null;
  v_flags := jsonb_build_object(
    'module_whatsapp', public.company_has_module(p_company_id, 'whatsapp'),
    'module_ia', public.company_has_module(p_company_id, 'ia'));
  select * into v_c from public.company_whatsapp_connections
   where company_id = p_company_id
   order by (status = 'active') desc, created_at desc
   limit 1;
  if not found then
    return jsonb_build_object('configured', false, 'unread_total', v_unread, 'open_conversations', v_open) || v_flags;
  end if;
  return v_flags || jsonb_build_object(
    'configured', true,
    'status', v_c.status,
    'mode', v_c.mode,
    'display_phone_number', v_c.display_phone_number,
    'business_name', v_c.business_name,
    'connected_at', v_c.connected_at,
    'disconnected_at', v_c.disconnected_at,
    'unread_total', v_unread,
    'open_conversations', v_open);
end;
$$;

-- Desconexão segura: owner/admin, confirmação explícita. Só marca a conexão; histórico, configurações e o segredo
-- no Vault permanecem (a reconexão é por Embedded Signup/operador). Cancela jobs de IA pendentes.
create function public.whatsapp_disconnect(p_company_id uuid, p_confirm text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_c public.company_whatsapp_connections;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Somente o proprietário ou administrador pode desconectar o WhatsApp.' using errcode = 'PT403';
  end if;
  if p_confirm is distinct from 'DESCONECTAR' then
    raise exception 'Confirme a desconexão digitando DESCONECTAR.' using errcode = 'PT400';
  end if;
  select * into v_c from public.company_whatsapp_connections
   where company_id = p_company_id and status = 'active' for update;
  if not found then
    raise exception 'Não há conexão ativa para desconectar.' using errcode = 'PT409';
  end if;
  update public.company_whatsapp_connections
     set status = 'disconnected', disconnected_at = now()
   where id = v_c.id;
  update public.whatsapp_ai_jobs
     set status = 'cancelled', outcome = 'aborted_mode', reason_code = 'mode_changed', locked_until = null
   where company_id = p_company_id and status in ('pending', 'processing');
  return jsonb_build_object('ok', true, 'status', 'disconnected');
end;
$$;

-- Indicadores da IA (30 dias). Só owner/admin, com os dois módulos.
create function public.whatsapp_ia_indicators(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_since timestamptz := now() - interval '30 days';
  v_jobs jsonb;
begin
  v_role := public.whatsapp_assert_ai_reader(p_company_id);
  if v_role not in ('owner', 'admin') then
    raise exception 'Somente o proprietário ou administrador vê os indicadores da IA.' using errcode = 'PT403';
  end if;
  select coalesce(jsonb_object_agg(o, n), '{}'::jsonb) into v_jobs
    from (select coalesce(outcome, status) o, count(*) n from public.whatsapp_ai_jobs
           where company_id = p_company_id and created_at >= v_since group by 1) x;
  return jsonb_build_object(
    'period_days', 30,
    'jobs_by_outcome', v_jobs,
    'ai_replies', (select count(*) from public.whatsapp_messages m
                    where m.company_id = p_company_id and m.origin = 'ai_auto' and m.created_at >= v_since),
    'handoffs', (select count(*) from public.whatsapp_conversation_events e
                  where e.company_id = p_company_id and e.event_type = 'ai_handoff' and e.created_at >= v_since),
    'conversations_under_human', (select count(*) from public.whatsapp_conversations c
                                   where c.company_id = p_company_id and c.deleted_at is null and c.ai_control = 'human'),
    'orders_by_ai', (select count(*) from public.delivery_orders d
                      where d.company_id = p_company_id and d.created_via = 'whatsapp_ai' and d.created_at >= v_since));
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) Embedded Signup (Meta): ESTRUTURA apenas. Desligado até a aprovação externa; nada simulado.
-- ---------------------------------------------------------------------------
create table public.whatsapp_platform_settings (
  singleton boolean primary key default true constraint whatsapp_platform_settings_singleton check (singleton),
  -- só o operador liga, depois de App Review / Tech Provider / config_id aprovados na Meta.
  embedded_signup_enabled boolean not null default false,
  meta_app_id text constraint whatsapp_platform_settings_app_id check (meta_app_id is null or meta_app_id ~ '^[0-9]{5,30}$'),
  embedded_signup_config_id text constraint whatsapp_platform_settings_config_id check (embedded_signup_config_id is null or embedded_signup_config_id ~ '^[0-9]{5,30}$'),
  updated_at timestamptz not null default now(),
  constraint whatsapp_platform_settings_ready check (not embedded_signup_enabled or (meta_app_id is not null and embedded_signup_config_id is not null))
);
insert into public.whatsapp_platform_settings (singleton) values (true);
alter table public.whatsapp_platform_settings enable row level security;
revoke all on public.whatsapp_platform_settings from public, anon, authenticated;
grant all on public.whatsapp_platform_settings to service_role;

create table public.whatsapp_signup_attempts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  state_nonce text not null unique constraint whatsapp_signup_attempts_nonce_len check (char_length(state_nonce) between 32 and 128),
  status text not null default 'started'
    constraint whatsapp_signup_attempts_status_check check (status in ('started', 'completed', 'failed', 'expired')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes'
);
create index whatsapp_signup_attempts_company_idx on public.whatsapp_signup_attempts (company_id, created_at desc);
alter table public.whatsapp_signup_attempts enable row level security;
revoke all on public.whatsapp_signup_attempts from public, anon, authenticated;
grant all on public.whatsapp_signup_attempts to service_role;

-- Disponibilidade (sem dados sensíveis): o botão só fica ativo se o operador liberou.
create function public.whatsapp_signup_availability()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when s.embedded_signup_enabled
      then jsonb_build_object('available', true, 'meta_app_id', s.meta_app_id, 'config_id', s.embedded_signup_config_id)
    else jsonb_build_object('available', false, 'reason', 'pending_meta_approval')
  end
  from public.whatsapp_platform_settings s;
$$;

-- Início da tentativa: owner/admin, módulo whatsapp contratado e plataforma liberada. Devolve o nonce (state).
create function public.whatsapp_signup_begin(p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_av jsonb;
  v_nonce text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Somente o proprietário ou administrador pode conectar o WhatsApp.' using errcode = 'PT403';
  end if;
  perform public.assert_company_module(p_company_id, 'whatsapp');
  v_av := public.whatsapp_signup_availability();
  if not (v_av ->> 'available')::boolean then
    raise exception 'A conexão automática ainda depende da aprovação da Meta e não está disponível.' using errcode = 'PT409';
  end if;
  update public.whatsapp_signup_attempts set status = 'expired'
   where company_id = p_company_id and status = 'started' and expires_at <= now();
  insert into public.whatsapp_signup_attempts (company_id, state_nonce, created_by) values (p_company_id, v_nonce, auth.uid());
  return jsonb_build_object('state', v_nonce, 'meta_app_id', v_av ->> 'meta_app_id', 'config_id', v_av ->> 'config_id');
end;
$$;

-- ---------------------------------------------------------------------------
-- 8) ACL explícita
-- ---------------------------------------------------------------------------
revoke execute on function public.whatsapp_get_module_state(uuid) from public, anon, service_role;
grant execute on function public.whatsapp_get_module_state(uuid) to authenticated;
revoke execute on function public.whatsapp_disconnect(uuid, text) from public, anon, service_role;
grant execute on function public.whatsapp_disconnect(uuid, text) to authenticated;
revoke execute on function public.whatsapp_ia_indicators(uuid) from public, anon, service_role;
grant execute on function public.whatsapp_ia_indicators(uuid) to authenticated;
revoke execute on function public.whatsapp_signup_availability() from public, anon, service_role;
grant execute on function public.whatsapp_signup_availability() to authenticated;
revoke execute on function public.whatsapp_signup_begin(uuid) from public, anon, service_role;
grant execute on function public.whatsapp_signup_begin(uuid) to authenticated;
revoke execute on function public.whatsapp_get_connection_summary(uuid) from public, anon, service_role;
grant execute on function public.whatsapp_get_connection_summary(uuid) to authenticated;

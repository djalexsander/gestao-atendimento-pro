-- Etapa 7.11C (LOCAL, NÃO aplicada): suporte de BANCO à sincronização de templates da Meta (a consulta à Graph API é da Edge whatsapp-templates-sync).
-- Migration ADITIVA sobre a 7.11B: 1 tabela nova, 1 coluna nova (whatsapp_message_templates.sync_run_id) e 6 funções novas. NÃO envia mensagem, NÃO inicia
-- conversa, NÃO muda webhook, IA, Coexistence nem conexões, NÃO ativa a funcionalidade e NÃO fala com a Meta (nenhuma função de banco faz HTTP).
--
-- Protocolo (cada passo é uma RPC; o token só existe no passo 2 e só para o service_role):
--   1) whatsapp_templates_sync_request(company)  [usuário, JWT]  valida papel (owner/admin; ou administrador da plataforma), módulo, funcionalidade ativada
--      (o administrador da plataforma pode sincronizar mesmo desativada, para validar o escopo antes de ativar), conexão ativa com WABA, saúde do token,
--      intervalo mínimo entre sincronizações e ADQUIRE o lease (uma sincronização por conexão; lease de 2 min caduca sozinho). Devolve só ids.
--   2) whatsapp_templates_sync_context(connection, run)  [service_role]  confere o lease e devolve waba_id + token do Vault.
--   3) whatsapp_templates_sync_apply(connection, run, templates)  [service_role]  upsert por (conexão, nome, idioma), idempotente, sem duplicar, ignora
--      entradas inválidas (conta 'skipped'), calcula o nº de variáveis do corpo e carimba sync_run_id.
--   4) whatsapp_templates_sync_finish(connection, run, ok, complete, erro)  [service_role]  só com ok E complete marca como DELETED os templates que a Meta
--      deixou de devolver; falha ou lista parcial NUNCA apaga nem marca nada. Libera o lease.
-- Leitura para a tela: whatsapp_list_start_templates(company)  [owner/admin/attendant]  devolve SÓ os APROVADOS, com a marca de elegibilidade para a V1.

-- ---------------------------------------------------------------------------
-- 1) Colunas / tabela
-- ---------------------------------------------------------------------------
alter table public.whatsapp_message_templates add column sync_run_id uuid;
comment on column public.whatsapp_message_templates.sync_run_id is 'Execução da sincronização que viu este template pela última vez (quem não aparece na execução completa seguinte vira DELETED).';

create table public.whatsapp_template_sync_state (
  connection_id uuid primary key references public.company_whatsapp_connections (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  status text not null default 'idle'
    constraint whatsapp_template_sync_state_status_check check (status in ('idle', 'running', 'ok', 'error')),
  run_id uuid,
  lease_until timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  last_success_at timestamptz,
  last_error_code text
    constraint whatsapp_template_sync_state_error_check check (last_error_code is null or char_length(last_error_code) <= 64),
  template_count integer not null default 0,
  requested_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);
create trigger whatsapp_template_sync_state_set_updated_at
  before update on public.whatsapp_template_sync_state
  for each row execute function public.set_updated_at();
alter table public.whatsapp_template_sync_state enable row level security;
revoke all on public.whatsapp_template_sync_state from public, anon, authenticated;
grant all on public.whatsapp_template_sync_state to service_role;

-- ---------------------------------------------------------------------------
-- 2) Passo 1: pedido (usuário) -> adquire o lease
-- ---------------------------------------------------------------------------
create function public.whatsapp_templates_sync_request(p_company_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_master boolean := false;
  v_role public.company_role;
  v_s public.company_whatsapp_start_settings;
  v_conn public.company_whatsapp_connections;
  v_state public.whatsapp_template_sync_state;
  v_eff text;
  v_run uuid := gen_random_uuid();
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_master := public.is_master_admin();
  if v_master then
    if not exists (select 1 from public.companies where id = p_company_id) then
      raise exception 'Empresa não encontrada.' using errcode = 'PT404';
    end if;
  else
    v_role := public.whatsapp_assert_reader(p_company_id);                 -- sessão, empresa do usuário, papel leitor, módulo WhatsApp
    if v_role not in ('owner', 'admin') then
      raise exception 'Somente donos e administradores podem atualizar os templates.' using errcode = 'PT403';
    end if;
    select * into v_s from public.company_whatsapp_start_settings where company_id = p_company_id;
    if not found or not v_s.enabled then
      raise exception 'Iniciar conversas está desativado para esta empresa.' using errcode = 'PT409';
    end if;
  end if;

  select * into v_conn from public.company_whatsapp_connections where company_id = p_company_id and status = 'active';
  if not found or v_conn.waba_id is null or v_conn.token_secret_id is null then
    raise exception 'O WhatsApp desta empresa não está conectado.' using errcode = 'PT409';
  end if;
  v_eff := public.whatsapp_token_effective_status(v_conn);
  if v_eff in ('expired', 'revoked') then
    raise exception 'A conexão do WhatsApp expirou ou foi revogada e precisa ser refeita.' using errcode = 'PT409';
  end if;

  -- linha de estado (uma por conexão) e lease atômico: só uma sincronização por vez
  insert into public.whatsapp_template_sync_state (connection_id, company_id) values (v_conn.id, p_company_id) on conflict (connection_id) do nothing;
  select * into v_state from public.whatsapp_template_sync_state where connection_id = v_conn.id for update;
  if v_state.status = 'running' and v_state.lease_until > now() then
    return jsonb_build_object('acquired', false, 'status', 'running', 'connection_id', v_conn.id);
  end if;
  if v_state.started_at is not null and v_state.started_at > now() - interval '60 seconds' then
    raise exception 'Aguarde um minuto antes de atualizar os templates de novo.' using errcode = 'PT409';
  end if;
  update public.whatsapp_template_sync_state
     set status = 'running', run_id = v_run, lease_until = now() + interval '2 minutes', started_at = now(), finished_at = null,
         requested_by = auth.uid()
   where connection_id = v_conn.id;
  return jsonb_build_object('acquired', true, 'status', 'running', 'connection_id', v_conn.id, 'run_id', v_run);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Passo 2: contexto (service_role) — ÚNICA leitura do token para templates
-- ---------------------------------------------------------------------------
create function public.whatsapp_templates_sync_context(p_connection_id uuid, p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_state public.whatsapp_template_sync_state;
  v_conn public.company_whatsapp_connections;
  v_token text;
begin
  select * into v_state from public.whatsapp_template_sync_state where connection_id = p_connection_id;
  if not found or v_state.status <> 'running' or v_state.run_id is distinct from p_run_id or v_state.lease_until <= now() then
    return jsonb_build_object('ok', false, 'error', 'no_active_run');
  end if;
  select * into v_conn from public.company_whatsapp_connections where id = p_connection_id and status = 'active';
  if not found or v_conn.waba_id is null or v_conn.token_secret_id is null then
    return jsonb_build_object('ok', false, 'error', 'connection_inactive');
  end if;
  select decrypted_secret into v_token from vault.decrypted_secrets where id = v_conn.token_secret_id;
  if v_token is null or v_token = '' then
    return jsonb_build_object('ok', false, 'error', 'token_unavailable');
  end if;
  return jsonb_build_object('ok', true, 'connection_id', v_conn.id, 'company_id', v_conn.company_id, 'waba_id', v_conn.waba_id, 'access_token', v_token);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Passo 3: upsert idempotente (uma chamada por página)
-- ---------------------------------------------------------------------------
create function public.whatsapp_templates_sync_apply(p_connection_id uuid, p_run_id uuid, p_templates jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_state public.whatsapp_template_sync_state;
  v_company uuid;
  v_upserted integer := 0;
  v_total integer;
begin
  select * into v_state from public.whatsapp_template_sync_state where connection_id = p_connection_id for update;
  if not found or v_state.status <> 'running' or v_state.run_id is distinct from p_run_id or v_state.lease_until <= now() then
    raise exception 'Sincronização não está ativa.' using errcode = 'PT409';
  end if;
  if p_templates is null or jsonb_typeof(p_templates) <> 'array' or jsonb_array_length(p_templates) > 500 then
    raise exception 'Lista de templates inválida.' using errcode = 'PT400';
  end if;
  v_company := v_state.company_id;
  v_total := jsonb_array_length(p_templates);

  -- válidos e sem duplicata (o último vence); a empresa e a conexão vêm do ESTADO, nunca do conteúdo
  with src as (
    select distinct on (e ->> 'name', e ->> 'language')
           nullif(left(e ->> 'id', 64), '') as provider_id,
           e ->> 'name' as name, e ->> 'language' as language,
           upper(e ->> 'category') as category, upper(e ->> 'status') as status,
           coalesce(e -> 'components', '[]'::jsonb) as components
      from jsonb_array_elements(p_templates) with ordinality as t(e, ord)
     where jsonb_typeof(e) = 'object'
       and (e ->> 'name') ~ '^[a-z0-9_]+$' and char_length(e ->> 'name') <= 512
       and (e ->> 'language') ~ '^[a-z]{2,3}([_-][A-Za-z]{2,4})?$'
       and upper(e ->> 'category') ~ '^[A-Z_]{3,32}$' and upper(e ->> 'status') ~ '^[A-Z_]{3,32}$'
       and jsonb_typeof(coalesce(e -> 'components', '[]'::jsonb)) = 'array' and octet_length(coalesce(e -> 'components', '[]'::jsonb)::text) <= 65536
     order by e ->> 'name', e ->> 'language', ord desc
  ),
  ins as (
    insert into public.whatsapp_message_templates (company_id, connection_id, provider_template_id, name, language, category, status, components, body_variable_count, sync_run_id, synced_at)
    select v_company, p_connection_id, s.provider_id, s.name, s.language, s.category, s.status, s.components,
           least(coalesce((
             select max((m)[1]::integer) from jsonb_array_elements(s.components) c,
                    lateral regexp_matches(coalesce(c ->> 'text', ''), '\{\{([0-9]{1,2})\}\}', 'g') m
              where upper(c ->> 'type') = 'BODY'), 0), 50),
           p_run_id, now()
      from src s
    on conflict (connection_id, name, language) do update
      set provider_template_id = excluded.provider_template_id, category = excluded.category, status = excluded.status,
          components = excluded.components, body_variable_count = excluded.body_variable_count, sync_run_id = excluded.sync_run_id, synced_at = excluded.synced_at
    returning 1
  )
  select count(*)::integer into v_upserted from ins;

  return jsonb_build_object('upserted', v_upserted, 'skipped', v_total - v_upserted);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Passo 4: encerramento
-- ---------------------------------------------------------------------------
create function public.whatsapp_templates_sync_finish(p_connection_id uuid, p_run_id uuid, p_ok boolean, p_complete boolean, p_error_code text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_state public.whatsapp_template_sync_state;
  v_removed integer := 0;
  v_count integer;
begin
  select * into v_state from public.whatsapp_template_sync_state where connection_id = p_connection_id for update;
  if not found or v_state.run_id is distinct from p_run_id then
    raise exception 'Sincronização não encontrada.' using errcode = 'PT404';
  end if;
  if v_state.status <> 'running' then
    return jsonb_build_object('status', v_state.status, 'changed', false);              -- encerramento repetido: idempotente
  end if;
  -- templates que a Meta deixou de devolver: SÓ com sincronização bem-sucedida E completa (lista parcial/falha nunca remove nada)
  if p_ok is true and p_complete is true then
    update public.whatsapp_message_templates
       set status = 'DELETED'
     where connection_id = p_connection_id and sync_run_id is distinct from p_run_id and status <> 'DELETED';
    get diagnostics v_removed = row_count;
  end if;
  select count(*)::integer into v_count from public.whatsapp_message_templates where connection_id = p_connection_id and status <> 'DELETED';
  update public.whatsapp_template_sync_state
     set status = case when p_ok is true then 'ok' else 'error' end,
         finished_at = now(), lease_until = null,
         last_success_at = case when p_ok is true then now() else last_success_at end,
         last_error_code = case when p_ok is true then null else left(nullif(btrim(coalesce(p_error_code, 'unknown')), ''), 64) end,
         template_count = v_count
   where connection_id = p_connection_id;
  return jsonb_build_object('status', case when p_ok is true then 'ok' else 'error' end, 'changed', true, 'removed', v_removed, 'template_count', v_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Elegibilidade (V1) e leitura para a tela
-- ---------------------------------------------------------------------------
-- V1 só envia corpo de texto com variáveis numeradas, rodapé fixo e cabeçalho de TEXTO sem variáveis; botões de resposta rápida. Qualquer outra coisa
-- (cabeçalho de mídia/localização, variável no cabeçalho, botões com URL/telefone dinâmico, fluxos, carrossel, oferta, catálogo) é INELEGÍVEL por ora.
create function public.whatsapp_template_ineligible_reason(p_components jsonb)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  c jsonb;
  v_type text;
  v_has_body boolean := false;
begin
  if p_components is null or jsonb_typeof(p_components) <> 'array' then return 'sem_componentes'; end if;
  for c in select * from jsonb_array_elements(p_components) loop
    v_type := upper(coalesce(c ->> 'type', ''));
    if v_type = 'BODY' then
      v_has_body := true;
    elsif v_type = 'HEADER' then
      if upper(coalesce(c ->> 'format', '')) <> 'TEXT' then return 'cabecalho_de_midia'; end if;
      if coalesce(c ->> 'text', '') like '%{{%' then return 'variavel_no_cabecalho'; end if;
    elsif v_type = 'FOOTER' then
      null;
    elsif v_type = 'BUTTONS' then
      if exists (select 1 from jsonb_array_elements(coalesce(c -> 'buttons', '[]'::jsonb)) b
                  where upper(coalesce(b ->> 'type', '')) <> 'QUICK_REPLY') then
        return 'botao_nao_suportado';
      end if;
    else
      return 'componente_nao_suportado';
    end if;
  end loop;
  if not v_has_body then return 'sem_corpo'; end if;
  return null;
end;
$$;

create function public.whatsapp_list_start_templates(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_conn public.company_whatsapp_connections;
  v_state public.whatsapp_template_sync_state;
begin
  v_role := public.whatsapp_assert_reader(p_company_id);
  if v_role not in ('owner', 'admin', 'attendant') then
    raise exception 'Seu perfil não pode iniciar conversas pelo WhatsApp.' using errcode = 'PT403';
  end if;
  select * into v_conn from public.company_whatsapp_connections where company_id = p_company_id and status = 'active';
  if not found then
    return jsonb_build_object('connected', false, 'templates', '[]'::jsonb, 'last_success_at', null, 'sync_status', null, 'stale', true);
  end if;
  select * into v_state from public.whatsapp_template_sync_state where connection_id = v_conn.id;
  return jsonb_build_object(
    'connected', true,
    'sync_status', v_state.status,
    'last_success_at', v_state.last_success_at,
    'last_error_code', v_state.last_error_code,
    'stale', v_state.last_success_at is null or v_state.last_success_at < now() - interval '24 hours',
    'templates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'name', t.name, 'language', t.language, 'category', t.category,
        'body_text', (select c ->> 'text' from jsonb_array_elements(t.components) c where upper(c ->> 'type') = 'BODY' limit 1),
        'body_variable_count', t.body_variable_count,
        'eligible', public.whatsapp_template_ineligible_reason(t.components) is null,
        'ineligible_reason', public.whatsapp_template_ineligible_reason(t.components),
        'synced_at', t.synced_at) order by t.name, t.language)
        from public.whatsapp_message_templates t
       where t.connection_id = v_conn.id and t.company_id = p_company_id and t.status = 'APPROVED'), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) ACL
-- ---------------------------------------------------------------------------
revoke execute on function public.whatsapp_templates_sync_request(uuid) from public, anon, service_role;
grant execute on function public.whatsapp_templates_sync_request(uuid) to authenticated;
revoke execute on function public.whatsapp_list_start_templates(uuid) from public, anon, service_role;
grant execute on function public.whatsapp_list_start_templates(uuid) to authenticated;
revoke execute on function public.whatsapp_templates_sync_context(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.whatsapp_templates_sync_apply(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.whatsapp_templates_sync_finish(uuid, uuid, boolean, boolean, text) from public, anon, authenticated;
grant execute on function public.whatsapp_templates_sync_context(uuid, uuid) to service_role;
grant execute on function public.whatsapp_templates_sync_apply(uuid, uuid, jsonb) to service_role;
grant execute on function public.whatsapp_templates_sync_finish(uuid, uuid, boolean, boolean, text) to service_role;
revoke execute on function public.whatsapp_template_ineligible_reason(jsonb) from public, anon, authenticated, service_role;

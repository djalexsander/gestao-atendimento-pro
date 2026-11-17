-- Etapa 7.11B (LOCAL, NÃO aplicada): FUNDAMENTOS para iniciar conversas pelo WhatsApp com templates oficiais da Meta.
-- Migration ADITIVA: 3 tabelas e 8 funções novas. NÃO envia mensagem, NÃO cria conversa, NÃO sincroniza com a Meta, NÃO muda webhook, IA,
-- Coexistence nem conexões, NÃO tem interface e NÃO ativa a funcionalidade para nenhuma empresa (ausência de linha = desativada).
--
-- Regras propostas da V1 (sujeitas à confirmação do dono do produto; tudo configurável):
--   * iniciar: owner, admin e attendant (cashier NÃO); funcionalidade DESLIGADA por padrão (company_whatsapp_start_settings.enabled = false);
--   * limite diário (padrão 50 por empresa, dia civil de America/Sao_Paulo) e intervalo mínimo por contato (padrão 24 h);
--   * templates criados no Gerenciador da Meta e apenas CONSULTADOS (cache por conexão; escrita só pelo service_role, na sincronização futura);
--   * consentimento: nesta fase a confirmação do operador (consent_source = 'operator_attestation') com data; sem guardar nada além disso.
--
-- Tabelas:
--   whatsapp_message_templates      cache de templates por conexão (RLS: leitura para owner/admin/attendant; escrita só service_role)
--   company_whatsapp_start_settings configuração por empresa (sem grant ao cliente; só RPCs)
--   whatsapp_start_requests         idempotência + auditoria de cada pedido de início (sem telefone: só hash da chave do contato, sem texto)
--
-- Funções públicas (só authenticated): whatsapp_get_start_settings (qualquer papel do WhatsApp lê o estado), whatsapp_set_start_settings (SOMENTE
-- administrador da plataforma). Funções internas (EXECUTE fechado; a RPC futura da 7.11F as chamará): reserve/finish do pedido, validação de papel,
-- contagem diária e hash do contato. Limites e intervalo são decididos pelo banco, sob lock por empresa (vale também sob concorrência).

-- ---------------------------------------------------------------------------
-- 1) Cache de templates por conexão
-- ---------------------------------------------------------------------------
create table public.whatsapp_message_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  connection_id uuid not null,
  provider_template_id text
    constraint whatsapp_message_templates_provider_id_check check (provider_template_id is null or char_length(provider_template_id) between 1 and 64),
  name text not null
    constraint whatsapp_message_templates_name_check check (name ~ '^[a-z0-9_]+$' and char_length(name) <= 512),
  language text not null
    constraint whatsapp_message_templates_language_check check (language ~ '^[a-z]{2,3}([_-][A-Za-z]{2,4})?$'),
  -- categoria e status como a Meta devolve (MARKETING/UTILITY/AUTHENTICATION; APPROVED/PENDING/REJECTED/PAUSED/...): padrão em vez de lista fechada,
  -- para a sincronização não quebrar quando a Meta criar um valor novo. A tela só usa APPROVED.
  category text not null
    constraint whatsapp_message_templates_category_check check (category ~ '^[A-Z_]{3,32}$'),
  status text not null
    constraint whatsapp_message_templates_status_check check (status ~ '^[A-Z_]{3,32}$'),
  components jsonb not null default '[]'::jsonb
    constraint whatsapp_message_templates_components_check check (jsonb_typeof(components) = 'array' and octet_length(components::text) <= 65536),
  -- quantidade de variáveis {{n}} do corpo (a validação dos parâmetros acontece na RPC de envio)
  body_variable_count integer not null default 0
    constraint whatsapp_message_templates_vars_check check (body_variable_count between 0 and 50),
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_message_templates_connection_fkey
    foreign key (connection_id, company_id) references public.company_whatsapp_connections (id, company_id) on delete cascade,
  constraint whatsapp_message_templates_unique unique (connection_id, name, language),
  constraint whatsapp_message_templates_id_company_key unique (id, company_id)
);
create index whatsapp_message_templates_list_idx on public.whatsapp_message_templates (company_id, connection_id, status, name);
create trigger whatsapp_message_templates_set_updated_at
  before update on public.whatsapp_message_templates
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2) Configuração por empresa (ausência de linha = desativado, limites padrão)
-- ---------------------------------------------------------------------------
create table public.company_whatsapp_start_settings (
  company_id uuid primary key references public.companies (id) on delete cascade,
  enabled boolean not null default false,
  daily_limit integer not null default 50
    constraint company_whatsapp_start_settings_daily_check check (daily_limit between 1 and 1000),
  min_interval_hours integer not null default 24
    constraint company_whatsapp_start_settings_interval_check check (min_interval_hours between 0 and 720),
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger company_whatsapp_start_settings_set_updated_at
  before update on public.company_whatsapp_start_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3) Pedidos de início: idempotência + auditoria (sem telefone, sem texto)
-- ---------------------------------------------------------------------------
create table public.whatsapp_start_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  connection_id uuid not null,
  requested_by uuid references auth.users (id) on delete set null,
  -- idempotência: o mesmo pedido (duplo clique/retry) devolve o mesmo registro
  client_request_id uuid not null,
  -- quem é o destinatário: contato manual ou cliente (SEM FK de propósito: não pode bloquear exclusão de cliente/contato, e a trilha sobrevive)
  contact_kind text not null
    constraint whatsapp_start_requests_kind_check check (contact_kind in ('manual', 'customer')),
  contact_ref uuid not null,
  -- sha256(empresa || ':' || chave do telefone): serve para o intervalo mínimo por contato (com equivalência do nono dígito) sem guardar o número
  contact_key_hash text not null
    constraint whatsapp_start_requests_hash_check check (contact_key_hash ~ '^[0-9a-f]{64}$'),
  template_id uuid,
  template_name text not null,
  template_language text not null,
  status text not null default 'queued'
    constraint whatsapp_start_requests_status_check check (status in ('queued', 'sent', 'failed')),
  error_code text
    constraint whatsapp_start_requests_error_check check (error_code is null or char_length(error_code) <= 64),
  conversation_id uuid,
  message_id uuid,
  -- consentimento (V1): confirmação do operador, com data. Nada além disso.
  consent_source text not null
    constraint whatsapp_start_requests_consent_source_check check (consent_source in ('operator_attestation')),
  consent_confirmed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_start_requests_connection_fkey
    foreign key (connection_id, company_id) references public.company_whatsapp_connections (id, company_id) on delete cascade,
  constraint whatsapp_start_requests_template_fkey
    foreign key (template_id, company_id) references public.whatsapp_message_templates (id, company_id) on delete set null (template_id),
  constraint whatsapp_start_requests_conversation_fkey
    foreign key (conversation_id, company_id) references public.whatsapp_conversations (id, company_id),
  constraint whatsapp_start_requests_message_fkey
    foreign key (message_id, company_id) references public.whatsapp_messages (id, company_id),
  constraint whatsapp_start_requests_idem_key unique (company_id, client_request_id),
  constraint whatsapp_start_requests_id_company_key unique (id, company_id)
);
create index whatsapp_start_requests_day_idx on public.whatsapp_start_requests (company_id, created_at desc);
create index whatsapp_start_requests_contact_idx on public.whatsapp_start_requests (company_id, contact_key_hash, created_at desc);

-- Imutabilidade e ciclo de vida: nada do pedido muda depois de criado, exceto o fechamento (queued -> sent|failed, uma vez) e a ligação com a
-- conversa/mensagem (uma vez, de nulo para valor). Os "soltar" do Postgres (autor apagado, template apagado) passam; DELETE só na cascata da empresa.
create function public.guard_whatsapp_start_request()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() <= 1 then
      raise exception 'Pedidos de início de conversa não podem ser apagados.' using errcode = 'PT409';
    end if;
    return old;
  end if;
  -- cascata do Postgres soltando autor/template (SET NULL): só essas colunas mudam
  if pg_trigger_depth() > 1 and (to_jsonb(new) - 'requested_by' - 'template_id' - 'updated_at') = (to_jsonb(old) - 'requested_by' - 'template_id' - 'updated_at')
     and (new.requested_by is null or new.requested_by = old.requested_by) and (new.template_id is null or new.template_id = old.template_id) then
    return new;
  end if;
  if new.company_id is distinct from old.company_id or new.connection_id is distinct from old.connection_id
     or new.requested_by is distinct from old.requested_by or new.client_request_id is distinct from old.client_request_id
     or new.contact_kind is distinct from old.contact_kind or new.contact_ref is distinct from old.contact_ref
     or new.contact_key_hash is distinct from old.contact_key_hash or new.template_id is distinct from old.template_id
     or new.template_name is distinct from old.template_name or new.template_language is distinct from old.template_language
     or new.consent_source is distinct from old.consent_source or new.consent_confirmed_at is distinct from old.consent_confirmed_at
     or new.created_at is distinct from old.created_at then
    raise exception 'Pedido de início de conversa é imutável.' using errcode = 'PT409';
  end if;
  if new.status is distinct from old.status and old.status <> 'queued' then
    raise exception 'Pedido de início de conversa já foi encerrado.' using errcode = 'PT409';
  end if;
  if (old.conversation_id is not null and new.conversation_id is distinct from old.conversation_id)
     or (old.message_id is not null and new.message_id is distinct from old.message_id) then
    raise exception 'Pedido de início de conversa já está ligado à conversa.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_whatsapp_start_request() from public, anon, authenticated, service_role;

create trigger whatsapp_start_requests_guard
  before update or delete on public.whatsapp_start_requests
  for each row execute function public.guard_whatsapp_start_request();
create trigger whatsapp_start_requests_set_updated_at
  before update on public.whatsapp_start_requests
  for each row execute function public.set_updated_at();
-- empresa em modo somente leitura (PT402): não cria nem fecha pedidos
create trigger guard_company_writable
  before insert or update on public.whatsapp_start_requests
  for each row execute function public.guard_company_writable();

-- ---------------------------------------------------------------------------
-- 4) RLS e permissões
-- ---------------------------------------------------------------------------
alter table public.whatsapp_message_templates enable row level security;
alter table public.company_whatsapp_start_settings enable row level security;
alter table public.whatsapp_start_requests enable row level security;

revoke all on public.whatsapp_message_templates from public, anon, authenticated;
revoke all on public.company_whatsapp_start_settings from public, anon, authenticated;
revoke all on public.whatsapp_start_requests from public, anon, authenticated;
grant all on public.whatsapp_message_templates to service_role;
grant all on public.company_whatsapp_start_settings to service_role;
grant all on public.whatsapp_start_requests to service_role;

-- só os templates podem ser LIDOS pelo cliente (e só por quem pode iniciar conversas, com o módulo contratado); escrita só pelo service_role
grant select on public.whatsapp_message_templates to authenticated;
create policy whatsapp_message_templates_select on public.whatsapp_message_templates
  for select to authenticated
  using (
    public.company_has_module_rls(company_id, 'whatsapp')
    and public.user_role_in_company(company_id) in ('owner', 'admin', 'attendant')
  );

-- ---------------------------------------------------------------------------
-- 5) Funções internas (sem EXECUTE para clientes)
-- ---------------------------------------------------------------------------
-- hash do contato por empresa (a chave de telefone vem de whatsapp_contact_key; o número em si não é guardado)
create function public.whatsapp_start_contact_hash(p_company_id uuid, p_contact_key text)
returns text
language sql
immutable
set search_path = public
as $$
  select encode(sha256(convert_to(p_company_id::text || ':' || coalesce(p_contact_key, ''), 'UTF8')), 'hex')
$$;
revoke execute on function public.whatsapp_start_contact_hash(uuid, text) from public, anon, authenticated, service_role;

-- quem pode INICIAR: sessão, empresa do usuário, módulo WhatsApp (via leitor) e papel owner/admin/attendant; escrita não bloqueada (PT402)
create function public.whatsapp_start_assert_starter(p_company_id uuid)
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
  if v_role not in ('owner', 'admin', 'attendant') then
    raise exception 'Seu perfil não pode iniciar conversas pelo WhatsApp.' using errcode = 'PT403';
  end if;
  if public.company_write_blocked(p_company_id) then
    raise exception 'Empresa em modo somente leitura (%). Regularize a contratação/pagamento para voltar a registrar alterações.',
      public.company_access_state(p_company_id) using errcode = 'PT402';
  end if;
  return v_role;
end;
$$;
revoke execute on function public.whatsapp_start_assert_starter(uuid) from public, anon, authenticated, service_role;

-- iniciações de HOJE (dia civil de São Paulo) que ainda valem: 'queued' e 'sent' (falha libera a vaga)
create function public.whatsapp_start_used_today(p_company_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer from public.whatsapp_start_requests r
   where r.company_id = p_company_id and r.status in ('queued', 'sent')
     and r.created_at >= (date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo')
$$;
revoke execute on function public.whatsapp_start_used_today(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6) RPCs públicas
-- ---------------------------------------------------------------------------
-- Estado para a tela (qualquer papel do WhatsApp lê; can_start diz se o PAPEL pode iniciar)
create function public.whatsapp_get_start_settings(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_s public.company_whatsapp_start_settings;
begin
  v_role := public.whatsapp_assert_reader(p_company_id);
  select * into v_s from public.company_whatsapp_start_settings where company_id = p_company_id;
  return jsonb_build_object(
    'enabled', coalesce(v_s.enabled, false),
    'daily_limit', coalesce(v_s.daily_limit, 50),
    'min_interval_hours', coalesce(v_s.min_interval_hours, 24),
    'used_today', public.whatsapp_start_used_today(p_company_id),
    'can_start', v_role in ('owner', 'admin', 'attendant'));
end;
$$;

-- Ativar/ajustar: SOMENTE o administrador da plataforma (custo e qualidade do número são da plataforma; o dono só enxerga o estado)
create function public.whatsapp_set_start_settings(p_company_id uuid, p_enabled boolean, p_daily_limit integer default 50, p_min_interval_hours integer default 24)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_s public.company_whatsapp_start_settings;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if not public.is_master_admin() then
    raise exception 'Somente o administrador da plataforma pode configurar o início de conversas.' using errcode = 'PT403';
  end if;
  if p_enabled is null or p_daily_limit is null or p_min_interval_hours is null
     or p_daily_limit not between 1 and 1000 or p_min_interval_hours not between 0 and 720 then
    raise exception 'Configuração inválida: limite diário de 1 a 1000 e intervalo de 0 a 720 horas.' using errcode = 'PT400';
  end if;
  if not exists (select 1 from public.companies where id = p_company_id) then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  insert into public.company_whatsapp_start_settings (company_id, enabled, daily_limit, min_interval_hours, updated_by)
  values (p_company_id, p_enabled, p_daily_limit, p_min_interval_hours, auth.uid())
  on conflict (company_id) do update
    set enabled = excluded.enabled, daily_limit = excluded.daily_limit, min_interval_hours = excluded.min_interval_hours, updated_by = excluded.updated_by
  returning * into v_s;
  return jsonb_build_object('enabled', v_s.enabled, 'daily_limit', v_s.daily_limit, 'min_interval_hours', v_s.min_interval_hours);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) Reserva e fechamento do pedido (INTERNAS: a RPC de iniciar conversa, na 7.11F, as usará)
-- ---------------------------------------------------------------------------
-- Valida tudo e grava o pedido 'queued' (ou devolve o mesmo, se o client_request_id já existe). Lock por empresa serializa a contagem do limite.
create function public.whatsapp_start_request_reserve(
  p_company_id uuid,
  p_connection_id uuid,
  p_client_request_id uuid,
  p_contact_kind text,
  p_contact_ref uuid,
  p_contact_key text,
  p_template_id uuid,
  p_consent_confirmed boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_s public.company_whatsapp_start_settings;
  v_t public.whatsapp_message_templates;
  v_conn public.company_whatsapp_connections;
  v_req public.whatsapp_start_requests;
  v_hash text;
  v_limit integer;
  v_interval integer;
begin
  perform public.whatsapp_start_assert_starter(p_company_id);
  if p_client_request_id is null or p_contact_ref is null or nullif(btrim(coalesce(p_contact_key, '')), '') is null
     or p_contact_kind is null or p_contact_kind not in ('manual', 'customer') or p_template_id is null then
    raise exception 'Pedido de início de conversa inválido.' using errcode = 'PT400';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('wa_start:' || p_company_id::text, 0));

  -- repetição do MESMO pedido (duplo clique/retry): devolve o mesmo registro, sem criar outro e sem consumir vaga
  select * into v_req from public.whatsapp_start_requests where company_id = p_company_id and client_request_id = p_client_request_id;
  if found then
    return jsonb_build_object('request_id', v_req.id, 'status', v_req.status, 'idempotent', true,
                              'conversation_id', v_req.conversation_id, 'message_id', v_req.message_id);
  end if;

  if p_consent_confirmed is distinct from true then
    raise exception 'Confirme que o contato autorizou receber mensagens da empresa.' using errcode = 'PT400';
  end if;

  select * into v_s from public.company_whatsapp_start_settings where company_id = p_company_id;
  if not found or not v_s.enabled then
    raise exception 'Iniciar conversas está desativado para esta empresa.' using errcode = 'PT409';
  end if;
  v_limit := v_s.daily_limit;
  v_interval := v_s.min_interval_hours;

  select * into v_conn from public.company_whatsapp_connections where id = p_connection_id and company_id = p_company_id;
  if not found or v_conn.status <> 'active' then
    raise exception 'O WhatsApp desta empresa não está conectado.' using errcode = 'PT409';
  end if;

  select * into v_t from public.whatsapp_message_templates where id = p_template_id and company_id = p_company_id and connection_id = p_connection_id;
  if not found then
    raise exception 'Template não encontrado.' using errcode = 'PT404';
  end if;
  if v_t.status <> 'APPROVED' then
    raise exception 'Este template não está aprovado pela Meta.' using errcode = 'PT409';
  end if;

  if public.whatsapp_start_used_today(p_company_id) >= v_limit then
    raise exception 'Limite diário de % iniciações de conversa atingido. Tente amanhã.', v_limit using errcode = 'PT409';
  end if;

  v_hash := public.whatsapp_start_contact_hash(p_company_id, p_contact_key);
  if v_interval > 0 and exists (
    select 1 from public.whatsapp_start_requests r
     where r.company_id = p_company_id and r.contact_key_hash = v_hash and r.status in ('queued', 'sent')
       and r.created_at > now() - make_interval(hours => v_interval)
  ) then
    raise exception 'Este contato já recebeu uma iniciação de conversa nas últimas % horas.', v_interval using errcode = 'PT409';
  end if;

  insert into public.whatsapp_start_requests (company_id, connection_id, requested_by, client_request_id, contact_kind, contact_ref, contact_key_hash,
                                              template_id, template_name, template_language, consent_source, consent_confirmed_at)
  values (p_company_id, p_connection_id, auth.uid(), p_client_request_id, p_contact_kind, p_contact_ref, v_hash,
          v_t.id, v_t.name, v_t.language, 'operator_attestation', now())
  returning * into v_req;

  return jsonb_build_object('request_id', v_req.id, 'status', v_req.status, 'idempotent', false, 'conversation_id', null, 'message_id', null);
end;
$$;
revoke execute on function public.whatsapp_start_request_reserve(uuid, uuid, uuid, text, uuid, text, uuid, boolean) from public, anon, authenticated, service_role;

-- Fecha o pedido: queued -> sent|failed (uma vez) e liga conversa/mensagem. Repetir o mesmo fechamento é idempotente.
create function public.whatsapp_start_request_finish(p_request_id uuid, p_status text, p_conversation_id uuid default null, p_message_id uuid default null, p_error_code text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_req public.whatsapp_start_requests;
begin
  if p_status is null or p_status not in ('sent', 'failed') then
    raise exception 'Status inválido.' using errcode = 'PT400';
  end if;
  select * into v_req from public.whatsapp_start_requests where id = p_request_id for update;
  if not found then
    raise exception 'Pedido não encontrado.' using errcode = 'PT404';
  end if;
  if v_req.status = p_status then
    return jsonb_build_object('request_id', v_req.id, 'status', v_req.status, 'changed', false);
  end if;
  if v_req.status <> 'queued' then
    raise exception 'Pedido de início de conversa já foi encerrado.' using errcode = 'PT409';
  end if;
  update public.whatsapp_start_requests
     set status = p_status,
         error_code = case when p_status = 'failed' then left(nullif(btrim(coalesce(p_error_code, '')), ''), 64) else null end,
         conversation_id = coalesce(conversation_id, p_conversation_id),
         message_id = coalesce(message_id, p_message_id)
   where id = v_req.id
  returning * into v_req;
  return jsonb_build_object('request_id', v_req.id, 'status', v_req.status, 'changed', true);
end;
$$;
revoke execute on function public.whatsapp_start_request_finish(uuid, text, uuid, uuid, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8) ACL das RPCs públicas
-- ---------------------------------------------------------------------------
revoke execute on function public.whatsapp_get_start_settings(uuid) from public, anon, service_role;
revoke execute on function public.whatsapp_set_start_settings(uuid, boolean, integer, integer) from public, anon, service_role;
grant execute on function public.whatsapp_get_start_settings(uuid) to authenticated;
grant execute on function public.whatsapp_set_start_settings(uuid, boolean, integer, integer) to authenticated;

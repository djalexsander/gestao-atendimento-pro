-- WhatsApp — Etapa 8: saúde dos tokens (expiração/revogação), proteção de envio, avisos e recuperação de registros incertos.
-- Aditiva e de baixo risco: 1 coluna nova (nula), 3 tabelas novas sem acesso do cliente, funções novas e 2 redefinições
-- (whatsapp_get_send_context, whatsapp_get_module_state). NENHUM dado existente é alterado: a conexão Djalexeventos (token_status
-- 'unknown', sem token_expires_at) continua enviando exatamente como antes.
--
-- Estados efetivos do token (whatsapp_token_effective_status):
--   revoked  : a Graph API CONFIRMOU token inválido/revogado (erro 190). Meta: 190 = "expirado, revogado ou inválido"; não distingue.
--   expired  : prazo conhecido (token_expires_at) vencido, ou expiração confirmada pela varredura.
--   expiring : prazo conhecido a até 10 dias.
--   error    : falha de autenticação NÃO confirmada (ex.: 190 com subcódigo de checkpoint). Não bloqueia.
--   valid    : confirmado (conexão concluída pelo signup / envio bem-sucedido) ou prazo conhecido no futuro.
--   unknown  : sem prazo conhecido e nunca confirmado. NUNCA é tratado como válido nem como inválido: não bloqueia, não avisa.
-- Bloqueio de envio SÓ para expired/revoked:
--   * prazo conhecido vencido        -> bloqueio firme (a Meta informou o prazo);
--   * confirmado pela Graph (revoked) -> bloqueia, mas permite UMA sondagem a cada 30 min (token_checked_at); se a sondagem passar, o
--     envio bem-sucedido restaura 'valid' (um erro transitório da Meta nunca bloqueia para sempre).
-- Erros de rede/timeout/5xx/429 e HTTP 401 sem o código 190 NÃO alteram a saúde do token. A conexão nunca é desativada sozinha e o
-- recebimento (webhook) não depende do token.

-- ---------------------------------------------------------------------------
-- 1) Colunas / tabelas
-- ---------------------------------------------------------------------------
alter table public.company_whatsapp_connections add column token_checked_at timestamptz;
comment on column public.company_whatsapp_connections.token_checked_at is
  'Última confirmação/sondagem da validade do token pela Graph API (controla a sondagem a cada 30 min enquanto bloqueado).';

-- Dedupe/auditoria dos avisos: uma linha por (conexão, tipo, credencial). Nenhum token aqui. Sem acesso do cliente.
create table public.whatsapp_token_alerts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  connection_id uuid not null references public.company_whatsapp_connections(id) on delete cascade,
  kind text not null constraint whatsapp_token_alerts_kind check (kind in ('expiring', 'expired', 'revoked')),
  token_secret_id uuid,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  occurrences integer not null default 1
);
create unique index whatsapp_token_alerts_dedupe
  on public.whatsapp_token_alerts (connection_id, kind, coalesce(token_secret_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index whatsapp_token_alerts_company_idx on public.whatsapp_token_alerts (company_id, first_seen_at desc);
alter table public.whatsapp_token_alerts enable row level security;
revoke all on public.whatsapp_token_alerts from public, anon, authenticated;
grant all on public.whatsapp_token_alerts to service_role;

-- Resolução administrativa de registros incertos: quem, quando, motivo e evidência. Sem PIN/token.
create table public.whatsapp_registration_resolutions (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references public.whatsapp_number_registrations(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  outcome text not null constraint whatsapp_registration_resolutions_outcome check (outcome in ('registered', 'failed')),
  prior_state text not null,
  evidence_type text not null
    constraint whatsapp_registration_resolutions_evidence_type check (evidence_type in ('meta_dashboard', 'graph_api_check', 'meta_support', 'customer_confirmation')),
  reason text not null constraint whatsapp_registration_resolutions_reason check (char_length(btrim(reason)) between 10 and 500),
  evidence text not null constraint whatsapp_registration_resolutions_evidence check (char_length(btrim(evidence)) between 10 and 1000),
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz not null default now()
);
create index whatsapp_registration_resolutions_reg_idx on public.whatsapp_registration_resolutions (registration_id, resolved_at desc);
alter table public.whatsapp_registration_resolutions enable row level security;
revoke all on public.whatsapp_registration_resolutions from public, anon, authenticated;
grant all on public.whatsapp_registration_resolutions to service_role;

-- ---------------------------------------------------------------------------
-- 2) Estado efetivo e aviso (internos, sem EXECUTE para clientes)
-- ---------------------------------------------------------------------------
create function public.whatsapp_token_effective_status(p_conn public.company_whatsapp_connections)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_exp timestamptz := p_conn.token_expires_at;
  v_st text := p_conn.token_status;
begin
  if v_st = 'revoked' then
    return 'revoked';
  end if;
  if v_exp is not null and v_exp <= now() then
    return 'expired';
  end if;
  if v_st = 'expired' then
    return 'expired';
  end if;
  if v_exp is not null and v_exp <= now() + interval '10 days' then
    return 'expiring';
  end if;
  if v_st = 'error' then
    return 'error';
  end if;
  if v_exp is not null then
    return 'valid';
  end if;
  if v_st = 'valid' then
    return 'valid';
  end if;
  return 'unknown';
end;
$$;

-- Aviso para owner/admin da empresa (a conexão ativa). null = nada a avisar. Nunca devolve token, segredo ou id de segredo.
create function public.whatsapp_token_alert_for(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_conn public.company_whatsapp_connections;
  v_eff text;
begin
  select * into v_conn from public.company_whatsapp_connections
   where company_id = p_company_id and status = 'active'
   order by connected_at desc nulls last limit 1;
  if not found then
    return null;
  end if;
  v_eff := public.whatsapp_token_effective_status(v_conn);
  if v_eff = 'expiring' then
    return jsonb_build_object('kind', 'expiring', 'level', 'warning', 'reconnect', true, 'expires_at', v_conn.token_expires_at,
                              'days_left', greatest(0, ceil(extract(epoch from (v_conn.token_expires_at - now())) / 86400.0)::integer));
  elsif v_eff = 'expired' then
    return jsonb_build_object('kind', 'expired', 'level', 'critical', 'reconnect', true, 'expires_at', v_conn.token_expires_at, 'days_left', null);
  elsif v_eff = 'revoked' then
    return jsonb_build_object('kind', 'revoked', 'level', 'critical', 'reconnect', true, 'expires_at', v_conn.token_expires_at, 'days_left', null);
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Contexto de envio (ÚNICO ponto que lê o token): igual ao anterior + proteção por saúde do token
-- ---------------------------------------------------------------------------
create or replace function public.whatsapp_get_send_context(p_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_msg public.whatsapp_messages;
  v_conn public.company_whatsapp_connections;
  v_conv public.whatsapp_conversations;
  v_token text;
  v_recipient text;
  v_matches integer;
  v_eff text;
  v_probe boolean := false;
  v_claimed uuid;
begin
  select * into v_msg from public.whatsapp_messages where id = p_message_id and direction = 'outbound';
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_msg.status <> 'queued' then
    return jsonb_build_object('ok', false, 'error', 'not_queued', 'status', v_msg.status);
  end if;
  select * into v_conv from public.whatsapp_conversations where id = v_msg.conversation_id;
  select * into v_conn from public.company_whatsapp_connections where id = v_msg.connection_id;
  if not public.company_has_module(v_msg.company_id, 'whatsapp') then
    return jsonb_build_object('ok', false, 'error', 'module_inactive');
  end if;
  if not found or v_conn.status <> 'active' or v_conn.phone_number_id is null then
    return jsonb_build_object('ok', false, 'error', 'connection_inactive');
  end if;

  v_recipient := v_conv.contact_phone;
  if v_conn.mode = 'test' then
    select count(distinct r.phone_e164), min(r.phone_e164)
      into v_matches, v_recipient
      from public.whatsapp_test_recipients r
     where r.connection_id = v_conn.id
       and r.company_id = v_conn.company_id
       and r.is_active
       and public.whatsapp_br_phone_equivalent(r.phone_e164, v_conv.contact_phone);
    -- nenhum autorizado ou ambíguo: falha fechada
    if v_matches <> 1 then
      return jsonb_build_object('ok', false, 'error', 'test_recipient_blocked');
    end if;
  end if;

  -- saúde do token: só expired/revoked bloqueiam (unknown/error/expiring/valid enviam). Mensagens e conversas NÃO são tocadas.
  v_eff := public.whatsapp_token_effective_status(v_conn);
  if v_eff in ('expired', 'revoked') then
    if v_conn.token_expires_at is not null and v_conn.token_expires_at <= now() then
      return jsonb_build_object('ok', false, 'error', 'token_expired');          -- prazo informado pela Meta: bloqueio firme
    end if;
    -- confirmado pela Graph: bloqueia, com UMA sondagem a cada 30 min (reivindicação atômica)
    update public.company_whatsapp_connections
       set token_checked_at = now()
     where id = v_conn.id and (token_checked_at is null or token_checked_at <= now() - interval '30 minutes')
     returning id into v_claimed;
    if v_claimed is null then
      return jsonb_build_object('ok', false, 'error', case when v_eff = 'expired' then 'token_expired' else 'token_revoked' end);
    end if;
    v_probe := true;
  end if;

  if v_conn.token_secret_id is null then
    return jsonb_build_object('ok', false, 'error', 'token_unavailable');
  end if;
  select decrypted_secret into v_token from vault.decrypted_secrets where id = v_conn.token_secret_id;
  if v_token is null or v_token = '' then
    return jsonb_build_object('ok', false, 'error', 'token_unavailable');
  end if;

  return jsonb_build_object(
    'ok', true,
    'message_id', v_msg.id,
    'connection_id', v_conn.id,
    'token_status', v_eff,
    'token_probe', v_probe,
    'phone_number_id', v_conn.phone_number_id,
    'recipient_phone', v_recipient,
    'body', v_msg.body,
    'access_token', v_token);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Relatórios do despacho (service_role): falha de autenticação CONFIRMADA / envio bem-sucedido
-- ---------------------------------------------------------------------------
-- p_kind 'invalid' = a Graph confirmou token inválido (erro 190); 'error' = falha de autenticação não confirmada (não bloqueia).
create function public.whatsapp_connection_report_token_failure(
  p_connection_id uuid,
  p_kind text,
  p_code text default null,
  p_subcode text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conn public.company_whatsapp_connections;
  v_code text := nullif(btrim(coalesce(p_code, '')), '');
  v_new text;
  v_alert text;
  v_first boolean := false;
begin
  if p_kind is null or p_kind not in ('invalid', 'error') then
    raise exception 'Tipo inválido.' using errcode = 'PT400';
  end if;
  if v_code is not null and v_code !~ '^[A-Za-z0-9_.:-]{1,60}$' then
    v_code := 'invalid_code';
  end if;
  if p_subcode is not null and p_subcode !~ '^[0-9]{1,6}$' then
    raise exception 'Subcódigo inválido.' using errcode = 'PT400';
  end if;
  select * into v_conn from public.company_whatsapp_connections where id = p_connection_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'connection_not_found');
  end if;
  v_code := coalesce(v_code, '190') || case when p_subcode is not null then ':' || p_subcode else '' end;

  if p_kind = 'invalid' then
    v_new := case when v_conn.token_expires_at is not null and v_conn.token_expires_at <= now() then 'expired' else 'revoked' end;
    update public.company_whatsapp_connections
       set token_status = v_new, last_error_code = left(v_code, 60), token_checked_at = now()
     where id = v_conn.id;
    v_alert := v_new;
  else
    -- não confirmado: não rebaixa um estado já confirmado e não bloqueia
    v_new := v_conn.token_status;
    if v_conn.token_status not in ('revoked', 'expired') then
      v_new := 'error';
      update public.company_whatsapp_connections
         set token_status = 'error', last_error_code = left(v_code, 60)
       where id = v_conn.id;
    end if;
  end if;

  if v_alert is not null then
    insert into public.whatsapp_token_alerts (company_id, connection_id, kind, token_secret_id)
    values (v_conn.company_id, v_conn.id, v_alert, v_conn.token_secret_id)
    on conflict (connection_id, kind, coalesce(token_secret_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do update set last_seen_at = now(), occurrences = public.whatsapp_token_alerts.occurrences + 1;
    v_first := (select occurrences = 1 from public.whatsapp_token_alerts
                 where connection_id = v_conn.id and kind = v_alert
                   and coalesce(token_secret_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(v_conn.token_secret_id, '00000000-0000-0000-0000-000000000000'::uuid));
  end if;
  return jsonb_build_object('ok', true, 'token_status', v_new, 'first_alert', v_first);
end;
$$;

-- Envio bem-sucedido: só restaura a saúde de quem estava error/revoked/expired (nunca mexe em 'unknown' nem em 'valid').
create function public.whatsapp_connection_report_send_ok(p_connection_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  update public.company_whatsapp_connections
     set token_status = 'valid', last_error_code = null, token_checked_at = now()
   where id = p_connection_id
     and token_status in ('error', 'revoked', 'expired')
     and (token_expires_at is null or token_expires_at > now())
   returning id into v_id;
  return jsonb_build_object('ok', true, 'restored', v_id is not null);
end;
$$;

-- Varredura (service_role; ainda NÃO agendada): sincroniza expiring/expired a partir de token_expires_at CONHECIDO e registra o aviso uma vez.
-- Nunca toca em conexões sem prazo conhecido (ex.: Djalexeventos).
create function public.whatsapp_token_health_sweep()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.company_whatsapp_connections;
  v_eff text;
  v_expiring integer := 0;
  v_expired integer := 0;
begin
  for v_row in
    select * from public.company_whatsapp_connections
     where status = 'active' and token_expires_at is not null and token_status not in ('revoked')
     for update
  loop
    v_eff := public.whatsapp_token_effective_status(v_row);
    if v_eff in ('expiring', 'expired') then
      if v_row.token_status is distinct from v_eff then
        update public.company_whatsapp_connections set token_status = v_eff where id = v_row.id;
      end if;
      insert into public.whatsapp_token_alerts (company_id, connection_id, kind, token_secret_id)
      values (v_row.company_id, v_row.id, v_eff, v_row.token_secret_id)
      on conflict (connection_id, kind, coalesce(token_secret_id, '00000000-0000-0000-0000-000000000000'::uuid))
      do update set last_seen_at = now();
      if v_eff = 'expiring' then v_expiring := v_expiring + 1; else v_expired := v_expired + 1; end if;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'expiring', v_expiring, 'expired', v_expired);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Estado dos módulos para as telas: + aviso de token (somente owner/admin)
-- ---------------------------------------------------------------------------
create or replace function public.whatsapp_get_module_state(p_company_id uuid)
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
  v_signup := public.whatsapp_signup_availability_for_company(p_company_id);
  return jsonb_build_object(
    'whatsapp', v_wa,
    'ia', v_ia,
    'ai_allowed', v_wa and v_ia,
    'connection_active', v_conn_active,
    'has_history', exists (select 1 from public.whatsapp_conversations c where c.company_id = p_company_id and c.deleted_at is null),
    'can_manage', v_role in ('owner', 'admin'),
    'role', v_role,
    'signup', v_signup,
    'connection_alert', case when v_role in ('owner', 'admin') and v_wa then public.whatsapp_token_alert_for(p_company_id) else null end);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Admin Master: saúde dos tokens (sem credenciais)
-- ---------------------------------------------------------------------------
create function public.master_whatsapp_token_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_master_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'company_id', c.company_id, 'company_name', co.name, 'connection_id', c.id, 'mode', c.mode,
             'connection_source', c.connection_source,
             'status', public.whatsapp_token_effective_status(c),
             'token_expires_at', c.token_expires_at, 'last_error_code', c.last_error_code, 'token_checked_at', c.token_checked_at)
           order by co.name)
      from public.company_whatsapp_connections c
      join public.companies co on co.id = c.company_id
     where c.status = 'active'), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) Recuperação de registros incertos (Admin Master). whatsapp_registration_resolve (service_role, sem ator/motivo/evidência)
--    NÃO atende aos requisitos de auditoria: continua existindo como primitivo interno e é chamado por esta RPC.
-- ---------------------------------------------------------------------------
create function public.master_whatsapp_registration_list(p_states text[] default array['uncertain', 'in_progress'])
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_master_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'registration_id', r.id, 'company_id', r.company_id, 'company_name', co.name,
             'phone_number_id', r.phone_number_id, 'waba_id', r.waba_id, 'state', r.state,
             'last_error_code', r.last_error_code, 'blocked_until', r.blocked_until, 'updated_at', r.updated_at,
             'pin_stored', r.pin_secret_id is not null, 'pin_source', r.pin_source,
             'attempts_total', (select count(*) from public.whatsapp_registration_attempts a where a.registration_id = r.id),
             'last_attempt', (select jsonb_build_object('status', a.status, 'meta_code', a.meta_code, 'started_at', a.started_at, 'finished_at', a.finished_at)
                                from public.whatsapp_registration_attempts a where a.registration_id = r.id order by a.started_at desc limit 1),
             'token_retained', exists (select 1 from public.whatsapp_registration_attempts a
                                         join public.whatsapp_signup_sessions s on s.id = a.session_id
                                        where a.registration_id = r.id and s.token_secret_id is not null),
             'resolutions', (select count(*) from public.whatsapp_registration_resolutions x where x.registration_id = r.id))
           order by r.updated_at desc)
      from public.whatsapp_number_registrations r
      join public.companies co on co.id = r.company_id
     where r.state = any (p_states)), '[]'::jsonb);
end;
$$;

create function public.master_whatsapp_registration_resolve(
  p_registration_id uuid,
  p_outcome text,
  p_evidence_type text,
  p_reason text,
  p_evidence text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_r public.whatsapp_number_registrations;
  v_last timestamptz;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_evidence text := btrim(coalesce(p_evidence, ''));
  v_res jsonb;
  v_sweep jsonb;
begin
  perform public.assert_master_admin();
  v_actor := auth.uid();
  if p_outcome is null or p_outcome not in ('registered', 'failed') then
    raise exception 'Resultado inválido.' using errcode = 'PT400';
  end if;
  if p_evidence_type is null or p_evidence_type not in ('meta_dashboard', 'graph_api_check', 'meta_support', 'customer_confirmation') then
    raise exception 'Tipo de evidência inválido.' using errcode = 'PT400';
  end if;
  if char_length(v_reason) not between 10 and 500 or char_length(v_evidence) not between 10 and 1000 then
    raise exception 'Informe o motivo (10 a 500 caracteres) e a evidência (10 a 1000 caracteres).' using errcode = 'PT400';
  end if;

  select * into v_r from public.whatsapp_number_registrations where id = p_registration_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'registration_not_found');
  end if;
  if v_r.state not in ('uncertain', 'in_progress') then
    return jsonb_build_object('ok', false, 'error', 'state_not_allowed', 'state', v_r.state);
  end if;
  if v_r.state = 'in_progress' then
    -- uma chamada à Meta pode ainda estar em andamento: só se resolve uma tentativa parada há mais de 30 min
    select max(started_at) into v_last from public.whatsapp_registration_attempts where registration_id = v_r.id;
    if v_last is null or v_last > now() - interval '30 minutes' then
      return jsonb_build_object('ok', false, 'error', 'operation_may_be_in_flight');
    end if;
  end if;

  v_res := public.whatsapp_registration_resolve(v_r.id, p_outcome);
  if (v_res ->> 'ok')::boolean is not true then
    return v_res;
  end if;
  insert into public.whatsapp_registration_resolutions
    (registration_id, company_id, outcome, prior_state, evidence_type, reason, evidence, resolved_by)
  values (v_r.id, v_r.company_id, p_outcome, v_r.state, p_evidence_type, v_reason, v_evidence, v_actor);
  -- limpeza segura SÓ depois da resolução: o token retido da sessão encerrada deixa de ter operação externa em aberto
  v_sweep := public.whatsapp_signup_sweep(v_r.company_id);
  return jsonb_build_object('ok', true, 'state', p_outcome, 'secrets_removed', v_sweep -> 'secrets_removed');
end;
$$;

-- ---------------------------------------------------------------------------
-- 8) ACL explícita
-- ---------------------------------------------------------------------------
revoke execute on function public.whatsapp_token_effective_status(public.company_whatsapp_connections) from public, anon, authenticated, service_role;
revoke execute on function public.whatsapp_token_alert_for(uuid) from public, anon, authenticated, service_role;

revoke execute on function public.whatsapp_connection_report_token_failure(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.whatsapp_connection_report_send_ok(uuid) from public, anon, authenticated;
revoke execute on function public.whatsapp_token_health_sweep() from public, anon, authenticated;
grant execute on function public.whatsapp_connection_report_token_failure(uuid, text, text, text) to service_role;
grant execute on function public.whatsapp_connection_report_send_ok(uuid) to service_role;
grant execute on function public.whatsapp_token_health_sweep() to service_role;

revoke execute on function public.master_whatsapp_token_health() from public, anon, service_role;
revoke execute on function public.master_whatsapp_registration_list(text[]) from public, anon, service_role;
revoke execute on function public.master_whatsapp_registration_resolve(uuid, text, text, text, text) from public, anon, service_role;
grant execute on function public.master_whatsapp_token_health() to authenticated;
grant execute on function public.master_whatsapp_registration_list(text[]) to authenticated;
grant execute on function public.master_whatsapp_registration_resolve(uuid, text, text, text, text) to authenticated;

-- redefinidas: create or replace preserva a ACL; reafirmada
revoke execute on function public.whatsapp_get_send_context(uuid) from public, anon, authenticated;
grant execute on function public.whatsapp_get_send_context(uuid) to service_role;
revoke execute on function public.whatsapp_get_module_state(uuid) from public, anon, service_role;
grant execute on function public.whatsapp_get_module_state(uuid) to authenticated;

-- Etapa 7.11D, parte 2 (LOCAL, NÃO aplicada): OPT-OUT — contatos que NÃO querem receber mensagens da empresa.
-- Migration ADITIVA sobre a 7.11B/C: 2 tabelas, 1 gatilho (só leitura da mensagem recebida) e 14 funções novas, mais UMA redefinição isolada de
-- whatsapp_start_request_reserve (a da 7.11B, ainda não aplicada) que passa a recusar contato bloqueado. NÃO envia mensagem, NÃO cria conversa, NÃO altera
-- o recebimento (whatsapp_ingest_message), a IA, a Coexistence, os webhooks nem as conexões, e NÃO ativa o início de conversas.
--
-- O que o opt-out BLOQUEIA: apenas NOVAS INICIAÇÕES de conversa por template (a reserva da 7.11B). O que NÃO bloqueia: receber mensagens do contato, mostrar a
-- conversa, atender dentro da janela de 24 h (resposta humana ou da IA) e qualquer atendimento que o próprio contato provoque. Quem pediu para sair continua
-- sendo atendido se escrever de novo; só não é procurado pela empresa.
--
-- Identidade do contato: hash sha256 (empresa + chave de telefone com equivalência do nono dígito), o mesmo hash dos pedidos da 7.11B. NUNCA guarda telefone,
-- nome nem o texto da mensagem; só o hash, a origem, quem registrou e a referência da mensagem recebida (id interno).
-- Como entra: (1) mensagem RECEBIDA que seja, INTEIRA, uma frase de saída conhecida (regra conservadora: nada de "contém"); (2) bloqueio manual por operador
-- (owner/admin/attendant); (3) erro de opt-out devolvido pela Meta (função interna, ligada ao despacho na 7.11E). Mensagens antigas (histórico importado) não decidem.
-- Como sai (reativação, sempre com novo consentimento VERIFICÁVEL): (a) o próprio contato escreve uma frase de retomada inteira depois do opt-out; ou (b)
-- owner/admin registra evidência ('written_consent' ou 'external_record') com referência do registro, atestando; a referência não pode conter telefone.

-- ---------------------------------------------------------------------------
-- 1) Tabelas
-- ---------------------------------------------------------------------------
create table public.whatsapp_contact_optouts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  contact_key_hash text not null
    constraint whatsapp_contact_optouts_hash_check check (contact_key_hash ~ '^[0-9a-f]{64}$'),
  opted_out boolean not null,
  source text not null
    constraint whatsapp_contact_optouts_source_check check (source in ('inbound_keyword', 'operator', 'meta_signal')),
  opted_out_at timestamptz not null,
  opted_out_by uuid references auth.users (id) on delete set null,
  reactivated_at timestamptz,
  reactivated_by uuid references auth.users (id) on delete set null,
  reactivation_kind text
    constraint whatsapp_contact_optouts_react_kind_check check (reactivation_kind is null or reactivation_kind in ('contact_message', 'written_consent', 'external_record')),
  reactivation_ref text
    constraint whatsapp_contact_optouts_react_ref_check check (reactivation_ref is null or char_length(reactivation_ref) between 3 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_contact_optouts_unique unique (company_id, contact_key_hash),
  -- reativado = tem data e tipo da evidência; bloqueado = sem dados de reativação
  constraint whatsapp_contact_optouts_state_check check (
    (opted_out and reactivated_at is null and reactivation_kind is null)
    or (not opted_out and reactivated_at is not null and reactivation_kind is not null))
);
create trigger whatsapp_contact_optouts_set_updated_at
  before update on public.whatsapp_contact_optouts
  for each row execute function public.set_updated_at();

create table public.whatsapp_optout_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  contact_key_hash text not null
    constraint whatsapp_optout_events_hash_check check (contact_key_hash ~ '^[0-9a-f]{64}$'),
  event_type text not null
    constraint whatsapp_optout_events_type_check check (event_type in ('opted_out', 'reactivated')),
  source text not null
    constraint whatsapp_optout_events_source_check check (source in ('inbound_keyword', 'operator', 'meta_signal', 'contact_message', 'written_consent', 'external_record')),
  actor_user_id uuid references auth.users (id) on delete set null,
  evidence_ref text
    constraint whatsapp_optout_events_ref_check check (evidence_ref is null or char_length(evidence_ref) between 3 and 80),
  -- id interno da mensagem recebida que originou o evento (sem FK: a trilha sobrevive; sem o texto da mensagem)
  message_ref uuid,
  created_at timestamptz not null default now()
);
create index whatsapp_optout_events_idx on public.whatsapp_optout_events (company_id, contact_key_hash, created_at);

-- Só acréscimo (mesmo padrão dos eventos de contato): UPDATE nunca (exceto o Postgres soltando o autor apagado); DELETE só na cascata da empresa
create function public.guard_whatsapp_optout_event()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if pg_trigger_depth() > 1 and new.actor_user_id is null and (to_jsonb(new) - 'actor_user_id') = (to_jsonb(old) - 'actor_user_id') then
      return new;
    end if;
    raise exception 'Eventos de opt-out não podem ser alterados.' using errcode = 'PT409';
  end if;
  if tg_op = 'DELETE' and pg_trigger_depth() <= 1 then
    raise exception 'Eventos de opt-out não podem ser apagados.' using errcode = 'PT409';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke execute on function public.guard_whatsapp_optout_event() from public, anon, authenticated, service_role;
create trigger whatsapp_optout_events_append_only
  before update or delete on public.whatsapp_optout_events
  for each row execute function public.guard_whatsapp_optout_event();

alter table public.whatsapp_contact_optouts enable row level security;
alter table public.whatsapp_optout_events enable row level security;
revoke all on public.whatsapp_contact_optouts from public, anon, authenticated;
revoke all on public.whatsapp_optout_events from public, anon, authenticated;
grant all on public.whatsapp_contact_optouts to service_role;
grant all on public.whatsapp_optout_events to service_role;

-- ---------------------------------------------------------------------------
-- 2) Detecção CONSERVADORA do texto (a mensagem INTEIRA precisa ser a frase)
-- ---------------------------------------------------------------------------
-- minúsculas, sem acento, pontuação/emoji viram espaço, espaços únicos: "PARAR!!" -> "parar"; "Não quero receber 🙏" -> "nao quero receber"
create function public.whatsapp_optout_normalize_text(p_text text)
returns text
language sql
immutable
set search_path = public
as $$
  select btrim(regexp_replace(regexp_replace(public.whatsapp_contact_fold(p_text), '[^a-z0-9 ]+', ' ', 'g'), ' +', ' ', 'g'))
$$;
revoke execute on function public.whatsapp_optout_normalize_text(text) from public, anon, authenticated, service_role;

-- Frase de SAÍDA: a mensagem inteira (até 60 caracteres) tem de ser uma destas. "cancelar" sozinho NÃO entra (é cancelar pedido); "sair"/"parar" entram
-- só quando são a mensagem toda ("pode parar na portaria", "quando vai sair meu pedido" NÃO casam). Efeito de um falso positivo: só deixa de ser procurado
-- por NOVA iniciação, é reversível e não afeta o atendimento.
create function public.whatsapp_optout_is_stop_message(p_text text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_text is not null and char_length(p_text) <= 60
     and public.whatsapp_optout_normalize_text(p_text) in (
       'parar', 'sair', 'stop', 'unsubscribe', 'parar de receber', 'parar mensagens', 'sair da lista', 'descadastrar', 'descadastre',
       'cancelar inscricao', 'nao quero receber', 'nao quero mais receber', 'nao enviar mais')
$$;
revoke execute on function public.whatsapp_optout_is_stop_message(text) from public, anon, authenticated, service_role;

-- Frase de RETOMADA (consentimento explícito do próprio contato): também a mensagem inteira
create function public.whatsapp_optout_is_resume_message(p_text text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_text is not null and char_length(p_text) <= 60
     and public.whatsapp_optout_normalize_text(p_text) in ('quero receber', 'quero voltar a receber', 'voltar a receber', 'reativar', 'ativar mensagens')
$$;
revoke execute on function public.whatsapp_optout_is_resume_message(text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) Núcleo (interno): consulta, registro, retomada
-- ---------------------------------------------------------------------------
create function public.whatsapp_optout_is_blocked(p_company_id uuid, p_contact_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.whatsapp_contact_optouts o
     where o.company_id = p_company_id and o.opted_out
       and o.contact_key_hash = public.whatsapp_start_contact_hash(p_company_id, public.whatsapp_contact_key(p_contact_key, false)))
$$;
revoke execute on function public.whatsapp_optout_is_blocked(uuid, text) from public, anon, authenticated, service_role;

-- Registra o opt-out. Idempotente: já bloqueado = nada muda e NENHUM evento novo. Um pedido mais antigo que uma reativação não a desfaz.
create function public.whatsapp_optout_register(p_company_id uuid, p_contact_key text, p_source text, p_actor uuid, p_message_ref uuid, p_at timestamptz default now())
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_hash text := public.whatsapp_start_contact_hash(p_company_id, public.whatsapp_contact_key(p_contact_key, false));
  v_row public.whatsapp_contact_optouts;
begin
  if p_company_id is null or nullif(btrim(coalesce(p_contact_key, '')), '') is null or p_source not in ('inbound_keyword', 'operator', 'meta_signal') then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('wa_optout:' || v_hash, 0));
  select * into v_row from public.whatsapp_contact_optouts where company_id = p_company_id and contact_key_hash = v_hash for update;
  if found then
    if v_row.opted_out then return false; end if;
    if v_row.reactivated_at is not null and p_at < v_row.reactivated_at then return false; end if;
    update public.whatsapp_contact_optouts
       set opted_out = true, source = p_source, opted_out_at = p_at, opted_out_by = p_actor,
           reactivated_at = null, reactivated_by = null, reactivation_kind = null, reactivation_ref = null
     where id = v_row.id;
  else
    insert into public.whatsapp_contact_optouts (company_id, contact_key_hash, opted_out, source, opted_out_at, opted_out_by)
    values (p_company_id, v_hash, true, p_source, p_at, p_actor);
  end if;
  insert into public.whatsapp_optout_events (company_id, contact_key_hash, event_type, source, actor_user_id, message_ref)
  values (p_company_id, v_hash, 'opted_out', p_source, p_actor, p_message_ref);
  return true;
end;
$$;
revoke execute on function public.whatsapp_optout_register(uuid, text, text, uuid, uuid, timestamptz) from public, anon, authenticated, service_role;

-- O próprio contato escreveu uma frase de retomada DEPOIS do opt-out: reativa (consentimento do contato, verificável pela mensagem)
create function public.whatsapp_optout_resume_from_contact(p_company_id uuid, p_contact_key text, p_message_ref uuid, p_at timestamptz)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_hash text := public.whatsapp_start_contact_hash(p_company_id, public.whatsapp_contact_key(p_contact_key, false));
  v_row public.whatsapp_contact_optouts;
begin
  perform pg_advisory_xact_lock(hashtextextended('wa_optout:' || v_hash, 0));
  select * into v_row from public.whatsapp_contact_optouts where company_id = p_company_id and contact_key_hash = v_hash for update;
  if not found or not v_row.opted_out or p_at <= v_row.opted_out_at then
    return false;
  end if;
  update public.whatsapp_contact_optouts
     set opted_out = false, reactivated_at = p_at, reactivated_by = null, reactivation_kind = 'contact_message', reactivation_ref = null
   where id = v_row.id;
  insert into public.whatsapp_optout_events (company_id, contact_key_hash, event_type, source, message_ref)
  values (p_company_id, v_hash, 'reactivated', 'contact_message', p_message_ref);
  return true;
end;
$$;
revoke execute on function public.whatsapp_optout_resume_from_contact(uuid, text, uuid, timestamptz) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4) Gatilho: lê a mensagem RECEBIDA (nunca a altera; nunca derruba o recebimento)
-- ---------------------------------------------------------------------------
create function public.whatsapp_optout_detect_inbound()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text;
  v_key text;
  v_at timestamptz;
  v_stop boolean;
begin
  begin
    if new.direction <> 'inbound' or new.type not in ('text', 'interactive') or new.body is null or char_length(new.body) > 60 then
      return new;
    end if;
    v_at := coalesce(new.provider_timestamp, new.created_at);
    if v_at < now() - interval '2 days' then
      return new;                                   -- histórico importado/atrasado não decide opt-out
    end if;
    v_stop := public.whatsapp_optout_is_stop_message(new.body);
    if not v_stop and not public.whatsapp_optout_is_resume_message(new.body) then
      return new;
    end if;
    select c.contact_phone into v_phone from public.whatsapp_conversations c where c.id = new.conversation_id and c.company_id = new.company_id;
    v_key := public.whatsapp_contact_key(v_phone, false);
    if v_key is null then
      return new;
    end if;
    if v_stop then
      perform public.whatsapp_optout_register(new.company_id, v_key, 'inbound_keyword', null, new.id, v_at);
    else
      perform public.whatsapp_optout_resume_from_contact(new.company_id, v_key, new.id, v_at);
    end if;
  exception when others then
    raise warning 'whatsapp_optout_detect_inbound falhou: %', sqlstate;   -- o recebimento NUNCA falha por causa do opt-out
  end;
  return new;
end;
$$;
revoke execute on function public.whatsapp_optout_detect_inbound() from public, anon, authenticated, service_role;
create trigger whatsapp_messages_optout_detect
  after insert on public.whatsapp_messages
  for each row when (new.direction = 'inbound' and new.type in ('text', 'interactive'))
  execute function public.whatsapp_optout_detect_inbound();

-- ---------------------------------------------------------------------------
-- 5) Erros de opt-out devolvidos pela Meta (preparado; o despacho chamará na 7.11E)
-- ---------------------------------------------------------------------------
-- 131050 = o usuário parou de receber mensagens de marketing da empresa (CONFIRMAR a lista na documentação vigente da Meta ao ligar o despacho).
create function public.whatsapp_optout_is_meta_error(p_code text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_code in ('131050')
$$;
revoke execute on function public.whatsapp_optout_is_meta_error(text) from public, anon, authenticated, service_role;

create function public.whatsapp_optout_from_meta_error(p_message_id uuid, p_error_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_msg public.whatsapp_messages;
  v_phone text;
  v_changed boolean;
begin
  if not public.whatsapp_optout_is_meta_error(p_error_code) then
    return jsonb_build_object('registered', false, 'reason', 'not_optout_error');
  end if;
  select * into v_msg from public.whatsapp_messages where id = p_message_id and direction = 'outbound';
  if not found then
    return jsonb_build_object('registered', false, 'reason', 'not_found');
  end if;
  select c.contact_phone into v_phone from public.whatsapp_conversations c where c.id = v_msg.conversation_id and c.company_id = v_msg.company_id;
  v_changed := public.whatsapp_optout_register(v_msg.company_id, public.whatsapp_contact_key(v_phone, false), 'meta_signal', null, v_msg.id, now());
  return jsonb_build_object('registered', v_changed, 'reason', case when v_changed then null else 'already_blocked' end);
end;
$$;
revoke execute on function public.whatsapp_optout_from_meta_error(uuid, text) from public, anon, authenticated;
grant execute on function public.whatsapp_optout_from_meta_error(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6) Contato -> chave do telefone (sempre da MESMA empresa; inexistente e de outra empresa dão a mesma resposta)
-- ---------------------------------------------------------------------------
create function public.whatsapp_optout_contact_key(p_company_id uuid, p_contact_kind text, p_contact_ref uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_key text;
begin
  if p_contact_kind = 'manual' then
    select m.contact_key into v_key from public.whatsapp_contacts m where m.id = p_contact_ref and m.company_id = p_company_id;
  elsif p_contact_kind = 'customer' then
    select public.whatsapp_contact_key(coalesce(nullif(u.whatsapp, ''), nullif(u.phone, '')), true) into v_key
      from public.customers u where u.id = p_contact_ref and u.company_id = p_company_id;
  else
    raise exception 'Tipo de contato inválido.' using errcode = 'PT400';
  end if;
  if v_key is null then
    raise exception 'Contato não encontrado ou sem telefone.' using errcode = 'PT404';
  end if;
  return v_key;
end;
$$;
revoke execute on function public.whatsapp_optout_contact_key(uuid, text, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7) RPCs públicas
-- ---------------------------------------------------------------------------
-- Estado do contato (para a tela futura): quem pode iniciar conversas vê se o contato está bloqueado
create function public.whatsapp_get_contact_optout(p_company_id uuid, p_contact_kind text, p_contact_ref uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_row public.whatsapp_contact_optouts;
begin
  v_role := public.whatsapp_assert_reader(p_company_id);
  if v_role not in ('owner', 'admin', 'attendant') then
    raise exception 'Seu perfil não pode consultar este bloqueio.' using errcode = 'PT403';
  end if;
  select * into v_row from public.whatsapp_contact_optouts
   where company_id = p_company_id and contact_key_hash = public.whatsapp_start_contact_hash(p_company_id, public.whatsapp_optout_contact_key(p_company_id, p_contact_kind, p_contact_ref));
  return jsonb_build_object('opted_out', coalesce(v_row.opted_out, false), 'source', case when v_row.opted_out then v_row.source end,
                            'since', case when v_row.opted_out then v_row.opted_out_at end);
end;
$$;

-- Bloqueio MANUAL (owner/admin/attendant). Ação protetora: não depende do modo somente leitura da empresa (PT402 não se aplica)
create function public.whatsapp_set_contact_optout(p_company_id uuid, p_contact_kind text, p_contact_ref uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_changed boolean;
begin
  v_role := public.whatsapp_assert_reader(p_company_id);
  if v_role not in ('owner', 'admin', 'attendant') then
    raise exception 'Seu perfil não pode bloquear contatos.' using errcode = 'PT403';
  end if;
  v_changed := public.whatsapp_optout_register(p_company_id, public.whatsapp_optout_contact_key(p_company_id, p_contact_kind, p_contact_ref), 'operator', auth.uid(), null, now());
  return jsonb_build_object('opted_out', true, 'changed', v_changed);
end;
$$;

-- REATIVAÇÃO manual: só owner/admin, com evidência verificável (tipo + referência do registro) e atestação; empresa não pode estar em somente leitura
create function public.whatsapp_reactivate_contact_optout(p_company_id uuid, p_contact_kind text, p_contact_ref uuid, p_evidence_kind text, p_evidence_ref text, p_attested boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_key text;
  v_hash text;
  v_ref text := nullif(btrim(coalesce(p_evidence_ref, '')), '');
  v_row public.whatsapp_contact_optouts;
begin
  v_role := public.whatsapp_assert_reader(p_company_id);
  if v_role not in ('owner', 'admin') then
    raise exception 'Somente donos e administradores podem reativar contatos bloqueados.' using errcode = 'PT403';
  end if;
  if public.company_write_blocked(p_company_id) then
    raise exception 'Empresa em modo somente leitura (%). Regularize a contratação/pagamento para voltar a registrar alterações.',
      public.company_access_state(p_company_id) using errcode = 'PT402';
  end if;
  if p_evidence_kind is null or p_evidence_kind not in ('written_consent', 'external_record') then
    raise exception 'Informe a evidência do novo consentimento (autorização por escrito ou registro externo).' using errcode = 'PT400';
  end if;
  if v_ref is null or char_length(v_ref) not between 3 and 80 then
    raise exception 'Informe a referência do registro que comprova o consentimento (3 a 80 caracteres).' using errcode = 'PT400';
  end if;
  if regexp_replace(v_ref, '[^0-9]', '', 'g') ~ '[0-9]{8,}' then
    raise exception 'A referência não pode conter telefone nem números longos (use letras ou no máximo 7 dígitos).' using errcode = 'PT400';
  end if;
  if p_attested is distinct from true then
    raise exception 'Confirme que existe autorização real do contato para receber mensagens.' using errcode = 'PT400';
  end if;

  v_key := public.whatsapp_optout_contact_key(p_company_id, p_contact_kind, p_contact_ref);
  v_hash := public.whatsapp_start_contact_hash(p_company_id, v_key);
  perform pg_advisory_xact_lock(hashtextextended('wa_optout:' || v_hash, 0));
  select * into v_row from public.whatsapp_contact_optouts where company_id = p_company_id and contact_key_hash = v_hash for update;
  if not found or not v_row.opted_out then
    raise exception 'Este contato não está bloqueado.' using errcode = 'PT409';
  end if;
  update public.whatsapp_contact_optouts
     set opted_out = false, reactivated_at = now(), reactivated_by = auth.uid(), reactivation_kind = p_evidence_kind, reactivation_ref = v_ref
   where id = v_row.id;
  insert into public.whatsapp_optout_events (company_id, contact_key_hash, event_type, source, actor_user_id, evidence_ref)
  values (p_company_id, v_hash, 'reactivated', p_evidence_kind, auth.uid(), v_ref);
  return jsonb_build_object('opted_out', false, 'changed', true);
end;
$$;

revoke execute on function public.whatsapp_get_contact_optout(uuid, text, uuid) from public, anon, service_role;
revoke execute on function public.whatsapp_set_contact_optout(uuid, text, uuid) from public, anon, service_role;
revoke execute on function public.whatsapp_reactivate_contact_optout(uuid, text, uuid, text, text, boolean) from public, anon, service_role;
grant execute on function public.whatsapp_get_contact_optout(uuid, text, uuid) to authenticated;
grant execute on function public.whatsapp_set_contact_optout(uuid, text, uuid) to authenticated;
grant execute on function public.whatsapp_reactivate_contact_optout(uuid, text, uuid, text, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 8) Reserva da 7.11B: recusa contato bloqueado (única mudança: o bloco do opt-out antes do limite diário)
-- ---------------------------------------------------------------------------
create or replace function public.whatsapp_start_request_reserve(
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

  -- 7.11D: contato que pediu para NÃO receber mensagens não recebe nova iniciação (antes de consumir vaga). Só bloqueia INICIAR por template: o
  -- recebimento de mensagens do contato e o atendimento dentro da janela de 24 h seguem normais.
  if public.whatsapp_optout_is_blocked(p_company_id, p_contact_key) then
    raise exception 'Este contato pediu para não receber mensagens da empresa.' using errcode = 'PT409';
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

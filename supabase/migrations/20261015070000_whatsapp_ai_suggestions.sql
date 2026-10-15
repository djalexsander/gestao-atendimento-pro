-- WhatsApp + IA, Fase 1: SUGESTÃO de resposta (a IA nunca envia nada).
--
-- Esta migration é só aditiva: duas tabelas novas e RPCs novas. Não altera tabela, função, política nem dado existente
-- do WhatsApp (whatsapp-send, webhook, conexão, token e destinatários seguem intactos).
--
--  * company_whatsapp_ai_settings: configuração por empresa. Modos off | suggest | auto; 'auto' EXISTE no desenho, mas é
--    barrado por CHECK (whatsapp_ai_settings_auto_blocked) e pelas RPCs. Para liberá-lo numa fase futura basta remover
--    essa constraint (nova migration). enabled=true exige a ciência de tratamento por provedor de IA (LGPD).
--  * whatsapp_ai_usage: uso append-only (provider, model, status, tokens, latência). NUNCA guarda prompt, mensagem,
--    sugestão, telefone ou dado pessoal. Base futura de franquia/cobrança (nada é cobrado aqui).
--  * RPCs: whatsapp_ai_get_settings / whatsapp_ai_update_settings (owner/admin configura), whatsapp_ai_prepare_suggestion
--    (attendant/cashier/owner/admin; devolve só o contexto mínimo, com cota) e whatsapp_ai_record_usage (service_role).
--
-- Provider/model NÃO são escolhidos pela empresa: vêm de Edge Secrets (a Edge os informa ao registrar o uso).

-- ---------------------------------------------------------------------------
-- 1) Tabelas
-- ---------------------------------------------------------------------------
create table public.company_whatsapp_ai_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  enabled boolean not null default false,
  mode text not null default 'off'
    constraint whatsapp_ai_settings_mode_check check (mode in ('off', 'suggest', 'auto')),
  business_name text
    constraint whatsapp_ai_settings_business_name_length check (business_name is null or char_length(business_name) <= 120),
  tone text
    constraint whatsapp_ai_settings_tone_length check (tone is null or char_length(tone) <= 80),
  custom_instructions text
    constraint whatsapp_ai_settings_instructions_length check (custom_instructions is null or char_length(custom_instructions) <= 2000),
  business_hours jsonb
    constraint whatsapp_ai_settings_hours_shape check (
      business_hours is null
      or (jsonb_typeof(business_hours) = 'object' and char_length(business_hours::text) <= 600)),
  fallback_to_human boolean not null default true,
  max_context_messages integer not null default 12
    constraint whatsapp_ai_settings_context_check check (max_context_messages between 1 and 30),
  ai_data_processing_acknowledged_at timestamptz,
  ai_data_processing_acknowledged_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- ciência explícita antes de ligar (LGPD)
  constraint whatsapp_ai_settings_ack_required check (not enabled or ai_data_processing_acknowledged_at is not null),
  -- FASE 1: o modo automático existe só no desenho. Remover esta constraint numa fase futura, com migration própria.
  constraint whatsapp_ai_settings_auto_blocked check (mode <> 'auto')
);

comment on column public.company_whatsapp_ai_settings.business_hours is
  'Objeto livre e curto, ex.: {"text": "Seg a Sex, 9h às 18h"}. Vai ao provedor de IA como contexto do estabelecimento.';
comment on column public.company_whatsapp_ai_settings.ai_data_processing_acknowledged_at is
  'Quando owner/admin confirmou que trechos da conversa poderão ser enviados ao provedor de IA para gerar sugestões.';

create trigger company_whatsapp_ai_settings_set_updated_at
  before update on public.company_whatsapp_ai_settings
  for each row execute function public.set_updated_at();

create table public.whatsapp_ai_usage (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  conversation_id uuid not null,
  user_id uuid,
  provider text not null
    constraint whatsapp_ai_usage_provider_length check (char_length(provider) between 1 and 60),
  model text not null
    constraint whatsapp_ai_usage_model_length check (char_length(model) between 1 and 120),
  status text not null
    constraint whatsapp_ai_usage_status_check check (status in ('ok', 'timeout', 'provider_error', 'rate_limited', 'invalid_output')),
  input_tokens integer
    constraint whatsapp_ai_usage_input_check check (input_tokens is null or input_tokens >= 0),
  output_tokens integer
    constraint whatsapp_ai_usage_output_check check (output_tokens is null or output_tokens >= 0),
  latency_ms integer
    constraint whatsapp_ai_usage_latency_check check (latency_ms is null or latency_ms >= 0),
  created_at timestamptz not null default now(),
  constraint whatsapp_ai_usage_conversation_fkey
    foreign key (conversation_id, company_id) references public.whatsapp_conversations (id, company_id) on delete cascade
);
-- user_id sem FK de propósito: a tabela é append-only (um ON DELETE SET NULL seria um UPDATE barrado).

create index whatsapp_ai_usage_company_idx on public.whatsapp_ai_usage (company_id, created_at desc);
create index whatsapp_ai_usage_user_idx on public.whatsapp_ai_usage (company_id, user_id, created_at desc);

create trigger whatsapp_ai_usage_immutable
  before update or delete on public.whatsapp_ai_usage
  for each row execute function public.whatsapp_guard_append_only();

-- ---------------------------------------------------------------------------
-- 2) RLS e GRANTs (cliente só LÊ a configuração; uso sem acesso direto)
-- ---------------------------------------------------------------------------
alter table public.company_whatsapp_ai_settings enable row level security;
alter table public.whatsapp_ai_usage enable row level security;

create policy company_whatsapp_ai_settings_select on public.company_whatsapp_ai_settings
  for select to authenticated
  using (
    public.company_has_module_rls(company_id, 'whatsapp')
    and public.user_role_in_company(company_id) in ('owner', 'admin')
  );

revoke all on public.company_whatsapp_ai_settings from public, anon, authenticated;
revoke all on public.whatsapp_ai_usage from public, anon, authenticated;
grant select on public.company_whatsapp_ai_settings to authenticated;
grant all on public.company_whatsapp_ai_settings to service_role;
grant select, insert on public.whatsapp_ai_usage to service_role;

-- ---------------------------------------------------------------------------
-- 3) Helpers internos
-- ---------------------------------------------------------------------------
-- Modo efetivo: só 'suggest' (ligado, com ciência). Qualquer outra coisa — inclusive 'auto' — é 'off'.
create function public.whatsapp_ai_effective_mode(p_enabled boolean, p_mode text, p_ack timestamptz)
returns text
language sql
immutable
set search_path = public
as $$
  select case when p_enabled and p_mode = 'suggest' and p_ack is not null then 'suggest' else 'off' end
$$;

-- Redação defensiva do que o cliente digitou: e-mails e sequências longas de dígitos (telefone, CPF/CNPJ, cartão).
create function public.whatsapp_ai_redact(p_text text)
returns text
language sql
immutable
set search_path = public
as $$
  select left(
    regexp_replace(
      regexp_replace(coalesce(p_text, ''), '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[e-mail]', 'g'),
      '\+?[0-9][0-9 .()/-]{7,}[0-9]', '[número]', 'g'),
    1000)
$$;

revoke execute on function public.whatsapp_ai_effective_mode(boolean, text, timestamptz) from public, anon, authenticated, service_role;
revoke execute on function public.whatsapp_ai_redact(text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4) Configuração
-- ---------------------------------------------------------------------------
-- Todos os papéis do WhatsApp recebem o modo efetivo (a tela do atendente precisa dele); só owner/admin recebem o resto.
create function public.whatsapp_ai_get_settings(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_s public.company_whatsapp_ai_settings;
  v_eff text;
  v_out jsonb;
  v_has boolean;
begin
  v_role := public.whatsapp_assert_reader(p_company_id);
  select * into v_s from public.company_whatsapp_ai_settings where company_id = p_company_id;
  v_has := found;

  if not v_has then
    v_eff := 'off';
  else
    v_eff := public.whatsapp_ai_effective_mode(v_s.enabled, v_s.mode, v_s.ai_data_processing_acknowledged_at);
  end if;
  v_out := jsonb_build_object('effective_mode', v_eff);

  if v_role in ('owner', 'admin') then
    if v_has then
      v_out := v_out || jsonb_build_object(
        'enabled', v_s.enabled,
        'mode', v_s.mode,
        'business_name', v_s.business_name,
        'tone', v_s.tone,
        'custom_instructions', v_s.custom_instructions,
        'business_hours', v_s.business_hours,
        'fallback_to_human', v_s.fallback_to_human,
        'max_context_messages', v_s.max_context_messages,
        'acknowledged_at', v_s.ai_data_processing_acknowledged_at);
    else
      v_out := v_out || jsonb_build_object(
        'enabled', false, 'mode', 'off', 'business_name', null, 'tone', null, 'custom_instructions', null,
        'business_hours', null, 'fallback_to_human', true, 'max_context_messages', 12, 'acknowledged_at', null);
    end if;
  end if;
  return v_out;
end;
$$;

create function public.whatsapp_ai_update_settings(
  p_company_id uuid,
  p_enabled boolean,
  p_mode text,
  p_business_name text,
  p_tone text,
  p_custom_instructions text,
  p_business_hours jsonb,
  p_fallback_to_human boolean,
  p_max_context_messages integer,
  p_acknowledge boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_old public.company_whatsapp_ai_settings;
  v_ack timestamptz;
  v_ack_by uuid;
  v_name text := nullif(btrim(coalesce(p_business_name, '')), '');
  v_tone text := nullif(btrim(coalesce(p_tone, '')), '');
  v_instr text := nullif(btrim(coalesce(p_custom_instructions, '')), '');
  v_hours jsonb := p_business_hours;
begin
  v_role := public.whatsapp_assert_reader(p_company_id);
  if v_role not in ('owner', 'admin') then
    raise exception 'Somente donos(as) e administradores(as) configuram a IA do WhatsApp.' using errcode = 'PT403';
  end if;

  if p_enabled is null or p_fallback_to_human is null or p_max_context_messages is null then
    raise exception 'Configuração inválida.' using errcode = 'PT400';
  end if;
  if p_mode is null or p_mode not in ('off', 'suggest', 'auto') then
    raise exception 'Modo da IA inválido.' using errcode = 'PT400';
  end if;
  if p_mode = 'auto' then
    raise exception 'O modo automático ainda não está disponível.' using errcode = 'PT409';
  end if;
  if p_max_context_messages < 1 or p_max_context_messages > 30 then
    raise exception 'O contexto deve ter entre 1 e 30 mensagens.' using errcode = 'PT400';
  end if;
  if v_name is not null and char_length(v_name) > 120 then
    raise exception 'O nome do estabelecimento pode ter no máximo 120 caracteres.' using errcode = 'PT400';
  end if;
  if v_tone is not null and char_length(v_tone) > 80 then
    raise exception 'O tom de voz pode ter no máximo 80 caracteres.' using errcode = 'PT400';
  end if;
  if v_instr is not null and char_length(v_instr) > 2000 then
    raise exception 'As instruções podem ter no máximo 2000 caracteres.' using errcode = 'PT400';
  end if;
  if v_hours is not null and (jsonb_typeof(v_hours) <> 'object' or char_length(v_hours::text) > 600) then
    raise exception 'Horário de atendimento inválido.' using errcode = 'PT400';
  end if;

  select * into v_old from public.company_whatsapp_ai_settings where company_id = p_company_id for update;
  v_ack := v_old.ai_data_processing_acknowledged_at;
  v_ack_by := v_old.ai_data_processing_acknowledged_by;
  if p_acknowledge and v_ack is null then
    v_ack := now();
    v_ack_by := auth.uid();
  end if;
  if p_enabled and v_ack is null then
    raise exception 'Confirme a ciência sobre o tratamento dos dados pelo provedor de IA para ativar.' using errcode = 'PT400';
  end if;

  insert into public.company_whatsapp_ai_settings (
    company_id, enabled, mode, business_name, tone, custom_instructions, business_hours, fallback_to_human,
    max_context_messages, ai_data_processing_acknowledged_at, ai_data_processing_acknowledged_by, updated_by)
  values (
    p_company_id, p_enabled, p_mode, v_name, v_tone, v_instr, v_hours, p_fallback_to_human,
    p_max_context_messages, v_ack, v_ack_by, auth.uid())
  on conflict (company_id) do update
     set enabled = excluded.enabled,
         mode = excluded.mode,
         business_name = excluded.business_name,
         tone = excluded.tone,
         custom_instructions = excluded.custom_instructions,
         business_hours = excluded.business_hours,
         fallback_to_human = excluded.fallback_to_human,
         max_context_messages = excluded.max_context_messages,
         ai_data_processing_acknowledged_at = excluded.ai_data_processing_acknowledged_at,
         ai_data_processing_acknowledged_by = excluded.ai_data_processing_acknowledged_by,
         updated_by = excluded.updated_by;

  return public.whatsapp_ai_get_settings(p_company_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Contexto mínimo da sugestão (chamada com o JWT do usuário pela Edge)
-- ---------------------------------------------------------------------------
create function public.whatsapp_ai_prepare_suggestion(p_conversation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conv public.whatsapp_conversations;
  v_s public.company_whatsapp_ai_settings;
  v_win jsonb;
  v_user_count integer;
  v_company_count integer;
  v_customer_first text;
  v_messages jsonb;
begin
  -- papel + módulo + empresa: tudo do banco (PT401/PT403/PT404)
  v_conv := public.whatsapp_load_conversation(p_conversation_id);

  select * into v_s from public.company_whatsapp_ai_settings where company_id = v_conv.company_id;
  if not found
     or public.whatsapp_ai_effective_mode(v_s.enabled, v_s.mode, v_s.ai_data_processing_acknowledged_at) <> 'suggest' then
    raise exception 'A sugestão por IA não está ativada para esta empresa.' using errcode = 'PT409';
  end if;

  if v_conv.status = 'closed' then
    raise exception 'Reabra a conversa para gerar uma sugestão.' using errcode = 'PT409';
  end if;
  v_win := public.whatsapp_can_send_freeform(v_conv.last_inbound_at);
  if not (v_win ->> 'can_send')::boolean then
    raise exception 'Fora da janela de atendimento de 24 horas.' using errcode = 'PT409';
  end if;

  -- cota: 10/min por usuário e 300/24 h por empresa (conta toda tentativa registrada)
  select count(*) into v_user_count
    from public.whatsapp_ai_usage
   where company_id = v_conv.company_id and user_id = auth.uid() and created_at > now() - interval '1 minute';
  if v_user_count >= 10 then
    raise exception 'Muitas sugestões em pouco tempo. Aguarde um instante e tente de novo.' using errcode = 'PT429';
  end if;
  select count(*) into v_company_count
    from public.whatsapp_ai_usage
   where company_id = v_conv.company_id and created_at > now() - interval '24 hours';
  if v_company_count >= 300 then
    raise exception 'O limite diário de sugestões por IA da empresa foi atingido.' using errcode = 'PT429';
  end if;

  -- só o primeiro nome do cliente vinculado (nunca telefone, e-mail, documento ou outro cliente)
  if v_conv.customer_id is not null then
    select split_part(btrim(c.name), ' ', 1) into v_customer_first
      from public.customers c
     where c.company_id = v_conv.company_id and c.id = v_conv.customer_id;
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object('direction', t.direction, 'at', t.at, 'text', t.txt) order by t.at, t.id), '[]'::jsonb)
    into v_messages
    from (
      select m.id, m.direction, coalesce(m.provider_timestamp, m.created_at) as at,
             case m.type
               when 'text' then public.whatsapp_ai_redact(m.body)
               else btrim(
                      case m.type
                        when 'image' then '[imagem]'
                        when 'audio' then '[áudio]'
                        when 'document' then '[documento]'
                        when 'location' then '[localização]'
                        when 'interactive' then '[mensagem interativa]'
                        when 'template' then '[mensagem modelo]'
                        else '[mensagem não suportada]'
                      end || ' ' || public.whatsapp_ai_redact(m.body))
             end as txt
        from public.whatsapp_messages m
       where m.company_id = v_conv.company_id
         and m.conversation_id = v_conv.id
         and m.status <> 'failed'
       order by coalesce(m.provider_timestamp, m.created_at) desc, m.id desc
       limit v_s.max_context_messages
    ) t;

  if jsonb_array_length(v_messages) = 0 then
    raise exception 'Não há mensagens para gerar uma sugestão.' using errcode = 'PT409';
  end if;

  return jsonb_build_object(
    'company_id', v_conv.company_id,
    'conversation_id', v_conv.id,
    'user_id', auth.uid(),
    'mode', public.whatsapp_ai_effective_mode(v_s.enabled, v_s.mode, v_s.ai_data_processing_acknowledged_at),
    'business_name', v_s.business_name,
    'tone', v_s.tone,
    'custom_instructions', v_s.custom_instructions,
    'business_hours', v_s.business_hours,
    'fallback_to_human', v_s.fallback_to_human,
    'customer_first_name', nullif(v_customer_first, ''),
    'messages', v_messages);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Registro de uso (SÓ service_role / Edge): métricas, nunca conteúdo
-- ---------------------------------------------------------------------------
create function public.whatsapp_ai_record_usage(
  p_company_id uuid,
  p_conversation_id uuid,
  p_user_id uuid,
  p_provider text,
  p_model text,
  p_status text,
  p_input_tokens integer,
  p_output_tokens integer,
  p_latency_ms integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.whatsapp_conversations where id = p_conversation_id and company_id = p_company_id
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;
  insert into public.whatsapp_ai_usage (
    company_id, conversation_id, user_id, provider, model, status, input_tokens, output_tokens, latency_ms)
  values (
    p_company_id, p_conversation_id, p_user_id, left(coalesce(nullif(btrim(p_provider), ''), 'unknown'), 60),
    left(coalesce(nullif(btrim(p_model), ''), 'unknown'), 120), p_status,
    case when p_input_tokens >= 0 then p_input_tokens end,
    case when p_output_tokens >= 0 then p_output_tokens end,
    case when p_latency_ms >= 0 then p_latency_ms end);
  return jsonb_build_object('result', 'ok');
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) ACL das RPCs
-- ---------------------------------------------------------------------------
revoke execute on function public.whatsapp_ai_get_settings(uuid) from public, anon, service_role;
revoke execute on function public.whatsapp_ai_update_settings(uuid, boolean, text, text, text, text, jsonb, boolean, integer, boolean) from public, anon, service_role;
revoke execute on function public.whatsapp_ai_prepare_suggestion(uuid) from public, anon, service_role;
grant execute on function public.whatsapp_ai_get_settings(uuid) to authenticated;
grant execute on function public.whatsapp_ai_update_settings(uuid, boolean, text, text, text, text, jsonb, boolean, integer, boolean) to authenticated;
grant execute on function public.whatsapp_ai_prepare_suggestion(uuid) to authenticated;

revoke execute on function public.whatsapp_ai_record_usage(uuid, uuid, uuid, text, text, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.whatsapp_ai_record_usage(uuid, uuid, uuid, text, text, text, integer, integer, integer) to service_role;

-- WhatsApp — NOME PERSONALIZADO DA ASSISTENTE VIRTUAL (Fase 2).
--
-- Cada empresa pode escolher o nome da assistente (ex.: Juliana). O nome é DADO DE APRESENTAÇÃO: a Edge Function monta uma
-- frase fixa na PRIMEIRA saída da conversa ("Olá! Eu sou a Juliana, assistente virtual da <empresa>."). Ele NUNCA entra no prompt
-- do modelo, e a apresentação não custa chamada à IA. Sempre diz que é assistente virtual (nunca finge ser pessoa).
--
--  * company_whatsapp_ai_settings.ai_display_name (nullable; 1 a 40 caracteres; letras, números, espaço e . ' -; uma linha).
--    Nome com cara de instrução (ignore/prompt/sistema/...) é recusado — defesa em profundidade, além de nunca ir ao prompt.
--  * RPC whatsapp_ai_set_display_name(company, name): SÓ owner/admin; vazio/espaços vira null (volta ao padrão "Assistente Virtual").
--  * whatsapp_ai_get_settings devolve ai_display_name (owner/admin), de forma aditiva.
--  * whatsapp_ai_auto_intro(job): SÓ service_role. Diz se este job vai gerar a 1ª saída da conversa e devolve a frase de apresentação.
--    "1ª saída" = a conversa não tem NENHUMA mensagem outbound que não tenha falhado (humana, IA ou aviso do pedido).
-- Os avisos operacionais do pedido (Bloco A) NÃO usam o nome. Nada aqui altera o suggest nem o fluxo humano.

-- ---------------------------------------------------------------------------
-- 1) Validação única do nome (usada pela constraint e pela RPC)
-- ---------------------------------------------------------------------------
create function public.whatsapp_ai_display_name_valid(p_name text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_name is not null
     and p_name = btrim(p_name)
     and char_length(p_name) between 1 and 40
     and p_name ~ '^[A-Za-zÀ-ÖØ-öø-ÿ0-9][A-Za-zÀ-ÖØ-öø-ÿ0-9 .''-]*$'
     and p_name !~ '  '                                              -- sem espaços duplos
     and array_length(string_to_array(p_name, ' '), 1) <= 4         -- um nome, não uma frase
     and p_name !~* '(ignor|instru|prompt|system|sistema|regra|desconsider|esque[cç]a|jailbreak|openai|chatgpt)'
$$;
revoke execute on function public.whatsapp_ai_display_name_valid(text) from public, anon, authenticated, service_role;

alter table public.company_whatsapp_ai_settings
  add column ai_display_name text
    constraint whatsapp_ai_settings_display_name_check check (ai_display_name is null or public.whatsapp_ai_display_name_valid(ai_display_name));
comment on column public.company_whatsapp_ai_settings.ai_display_name is
  'Nome da assistente virtual usado SÓ na apresentação inicial (nunca vai ao prompt). Null = "Assistente Virtual".';

-- ---------------------------------------------------------------------------
-- 2) Escrita (owner/admin)
-- ---------------------------------------------------------------------------
create function public.whatsapp_ai_set_display_name(p_company_id uuid, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_name text;
begin
  v_role := public.whatsapp_assert_reader(p_company_id);
  if v_role not in ('owner', 'admin') then
    raise exception 'Somente donos(as) e administradores(as) configuram a IA do WhatsApp.' using errcode = 'PT403';
  end if;
  -- quebra de linha/tab/controle NUNCA é "normalizada": o valor é rejeitado antes de qualquer limpeza de espaços
  if p_name ~ '[[:cntrl:]]' then
    raise exception 'Nome inválido. O nome deve ficar em uma única linha, com letras, números, espaço, ponto, apóstrofo ou hífen.' using errcode = 'PT400';
  end if;
  v_name := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  if v_name = '' then
    v_name := null;
  elsif not public.whatsapp_ai_display_name_valid(v_name) then
    raise exception 'Nome inválido. Use de 1 a 40 caracteres (letras, números, espaço, ponto, apóstrofo ou hífen), em até 4 palavras.' using errcode = 'PT400';
  end if;

  insert into public.company_whatsapp_ai_settings (company_id, ai_display_name)
  values (p_company_id, v_name)
  on conflict (company_id) do update set ai_display_name = excluded.ai_display_name, updated_by = auth.uid();

  return public.whatsapp_ai_get_settings(p_company_id);
end;
$$;
revoke execute on function public.whatsapp_ai_set_display_name(uuid, text) from public, anon, service_role;
grant execute on function public.whatsapp_ai_set_display_name(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Leitura: get_settings ganha ai_display_name (aditivo; mesmos campos de antes)
-- ---------------------------------------------------------------------------
create or replace function public.whatsapp_ai_get_settings(p_company_id uuid)
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
    v_eff := public.whatsapp_ai_effective_mode(v_s.enabled, v_s.mode, v_s.ai_data_processing_acknowledged_at, v_s.auto_acknowledged_at);
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
        'acknowledged_at', v_s.ai_data_processing_acknowledged_at,
        'auto_acknowledged_at', v_s.auto_acknowledged_at,
        'after_hours_policy', v_s.after_hours_policy,
        'after_hours_message', v_s.after_hours_message,
        'business_schedule', v_s.business_schedule,
        'ai_display_name', v_s.ai_display_name);
    else
      v_out := v_out || jsonb_build_object(
        'enabled', false, 'mode', 'off', 'business_name', null, 'tone', null, 'custom_instructions', null,
        'business_hours', null, 'fallback_to_human', true, 'max_context_messages', 12, 'acknowledged_at', null,
        'auto_acknowledged_at', null, 'after_hours_policy', 'ai_continues', 'after_hours_message', null, 'business_schedule', null,
        'ai_display_name', null);
    end if;
  end if;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Apresentação do job (SÓ service_role)
-- ---------------------------------------------------------------------------
-- first=true  -> nenhuma saída anterior (que não falhou) na conversa: a Edge prefixa a apresentação.
-- intro       -> frase FIXA: "Olá! Eu sou a Juliana, assistente virtual da Empresa." | "Olá! Sou a Assistente Virtual da Empresa."
create function public.whatsapp_ai_auto_intro(p_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_job public.whatsapp_ai_jobs;
  v_s public.company_whatsapp_ai_settings;
  v_biz text;
  v_first boolean;
begin
  select * into v_job from public.whatsapp_ai_jobs where id = p_job_id;
  if not found then
    return jsonb_build_object('first', false, 'intro', null);
  end if;
  select * into v_s from public.company_whatsapp_ai_settings where company_id = v_job.company_id;
  select coalesce(nullif(btrim(v_s.business_name), ''), c.name) into v_biz from public.companies c where c.id = v_job.company_id;

  select not exists (
    select 1 from public.whatsapp_messages m
     where m.company_id = v_job.company_id and m.conversation_id = v_job.conversation_id
       and m.direction = 'outbound' and m.status <> 'failed' and m.ai_job_id is distinct from v_job.id
  ) into v_first;

  return jsonb_build_object(
    'first', v_first,
    'intro', case
      when nullif(v_s.ai_display_name, '') is not null then 'Olá! Eu sou a ' || v_s.ai_display_name || ', assistente virtual da ' || v_biz || '.'
      else 'Olá! Sou a Assistente Virtual da ' || v_biz || '.'
    end);
end;
$$;
revoke execute on function public.whatsapp_ai_auto_intro(uuid) from public, anon, authenticated;
grant execute on function public.whatsapp_ai_auto_intro(uuid) to service_role;

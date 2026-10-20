-- WhatsApp IA (AUTO) — limite de chamadas por CONVERSA/HORA configurável por empresa.
--
-- Antes: 6 por conversa/hora, fixo no corpo de whatsapp_ai_reserve_auto_usage. O pedido conversacional gasta ~3 chamadas por
-- pedido (item, retirada/entrega, pagamento) mais as alterações, então 6/h é baixo para a jornada.
-- Agora: company_whatsapp_ai_settings.auto_max_per_conversation_hour (default 6 = comportamento atual; 1..30 = nunca ilimitado).
-- Só o limite POR CONVERSA é configurável. Minuto (10), hora (120), dia (1.000) e mês (20.000) da empresa continuam fixos;
-- a cota da SUGESTÃO (kind='suggest') não é tocada. Não há RPC/UI para o ajuste: é por SQL (como order_drafts_enabled).
-- A função só muda o limite lido; ACL (service_role) e o restante do corpo permanecem como estavam.

alter table public.company_whatsapp_ai_settings
  add column auto_max_per_conversation_hour integer not null default 6
    constraint whatsapp_ai_settings_auto_conv_limit_check check (auto_max_per_conversation_hour between 1 and 30);

comment on column public.company_whatsapp_ai_settings.auto_max_per_conversation_hour is
  'Máximo de chamadas de IA do AUTO por conversa por hora. Default 6; 1..30. Ajuste por SQL (sem UI).';

create or replace function public.whatsapp_ai_reserve_auto_usage(p_job_id uuid, p_provider text, p_model text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.whatsapp_ai_jobs;
  v_provider text := left(coalesce(nullif(btrim(p_provider), ''), 'unknown'), 60);
  v_model text := left(coalesce(nullif(btrim(p_model), ''), 'unknown'), 120);
  v_reason text;
  v_id uuid;
  v_min integer;
  v_hour integer;
  v_day integer;
  v_month integer;
  v_conv integer;
  v_conv_limit integer;
begin
  select * into v_job from public.whatsapp_ai_jobs where id = p_job_id and status = 'processing';
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('whatsapp_ai_auto_quota:' || v_job.company_id::text, 0));

  -- limite por conversa/hora: configurável por empresa (coluna auto_max_per_conversation_hour, default 6, máx. 30); os demais
  -- limites (minuto/hora/dia/mês da empresa) continuam fixos
  select coalesce((select s.auto_max_per_conversation_hour from public.company_whatsapp_ai_settings s where s.company_id = v_job.company_id), 6)
    into v_conv_limit;

  select count(*) filter (where created_at > now() - interval '1 minute'),
         count(*) filter (where created_at > now() - interval '1 hour'),
         count(*) filter (where created_at > now() - interval '24 hours'),
         count(*),
         count(*) filter (where conversation_id = v_job.conversation_id and created_at > now() - interval '1 hour')
    into v_min, v_hour, v_day, v_month, v_conv
    from public.whatsapp_ai_usage
   where company_id = v_job.company_id and kind = 'auto' and reservation_id is null and status <> 'blocked'
     and created_at > now() - interval '30 days';

  if v_conv >= v_conv_limit then v_reason := 'auto_conversation';
  elsif v_min >= 10 then v_reason := 'auto_minute';
  elsif v_hour >= 120 then v_reason := 'auto_hour';
  elsif v_day >= 1000 then v_reason := 'auto_day';
  elsif v_month >= 20000 then v_reason := 'auto_month';
  end if;

  if v_reason is not null then
    if not exists (
      select 1 from public.whatsapp_ai_usage
       where company_id = v_job.company_id and kind = 'auto' and status = 'blocked' and block_reason = v_reason
         and created_at > now() - interval '1 minute'
    ) then
      insert into public.whatsapp_ai_usage (company_id, conversation_id, user_id, provider, model, status, block_reason, kind, job_id, trigger_message_id)
      values (v_job.company_id, v_job.conversation_id, null, v_provider, v_model, 'blocked', v_reason, 'auto', v_job.id, v_job.latest_message_id);
    end if;
    return jsonb_build_object('result', 'blocked', 'reason', v_reason);
  end if;

  insert into public.whatsapp_ai_usage (company_id, conversation_id, user_id, provider, model, status, kind, job_id, trigger_message_id)
  values (v_job.company_id, v_job.conversation_id, null, v_provider, v_model, 'reserved', 'auto', v_job.id, v_job.latest_message_id)
  returning id into v_id;
  return jsonb_build_object('result', 'reserved', 'usage_id', v_id);
end;
$$;

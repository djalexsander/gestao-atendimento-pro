-- Rollback da migration 20261125010000 (Coexistence, Etapa 4: controle da sincronização). Remove tabelas/colunas/funções novas e restaura
-- whatsapp_coexistence_record da Etapa 3. O histórico de tentativas é descartado (era só auditoria). Rode só com a Edge whatsapp-coexistence-sync fora do ar.
begin;
drop function if exists public.whatsapp_coexistence_sync_status(uuid);
drop function if exists public.whatsapp_coexistence_sync_finish(uuid, text, text, text);
drop function if exists public.whatsapp_coexistence_sync_prepare(uuid, uuid, text);
drop trigger if exists company_whatsapp_connections_sync_seed_upd on public.company_whatsapp_connections;
drop trigger if exists company_whatsapp_connections_sync_seed_ins on public.company_whatsapp_connections;
drop function if exists public.whatsapp_coexistence_sync_seed();
-- restaura whatsapp_coexistence_record da Etapa 3 (sem o estado da sincronização)
create or replace function public.whatsapp_coexistence_record(
  p_phone_number_id text,
  p_kind text,
  p_event_name text,
  p_event_key text,
  p_detail jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conn public.company_whatsapp_connections;
  v_key text := left(nullif(btrim(coalesce(p_event_key, '')), ''), 300);
  v_detail jsonb := '{}'::jsonb;
  v_k text;
  v_id uuid;
begin
  if p_kind is null or p_kind not in ('contact_sync', 'history_chunk', 'history_declined', 'echo_revoke', 'echo_edit') or v_key is null then
    return jsonb_build_object('result', 'invalid');
  end if;
  select * into v_conn from public.company_whatsapp_connections where phone_number_id = p_phone_number_id;
  if not found then
    return jsonb_build_object('result', 'unknown_connection');
  end if;
  if v_conn.connection_type <> 'coexistence' then
    return jsonb_build_object('result', 'not_coexistence');
  end if;
  -- só números inteiros pequenos de uma lista fixa de chaves (nada de texto livre vindo do payload)
  if jsonb_typeof(coalesce(p_detail, '{}'::jsonb)) = 'object' then
    foreach v_k in array array['added', 'removed', 'threads', 'messages', 'phase', 'chunk_order', 'progress', 'error_code'] loop
      if p_detail ? v_k and jsonb_typeof(p_detail -> v_k) = 'number'
         and (p_detail ->> v_k) ~ '^[0-9]{1,9}$' then
        v_detail := v_detail || jsonb_build_object(v_k, (p_detail ->> v_k)::bigint);
      end if;
    end loop;
  end if;
  insert into public.whatsapp_coexistence_events (company_id, connection_id, kind, event_name, detail, provider_event_key)
  values (v_conn.company_id, v_conn.id, p_kind, left(regexp_replace(coalesce(p_event_name, ''), '[^A-Za-z0-9_]', '', 'g'), 60), v_detail, v_key)
  on conflict (provider_event_key) do nothing
  returning id into v_id;
  if v_id is null then
    return jsonb_build_object('result', 'duplicate');
  end if;
  return jsonb_build_object('result', 'recorded');
end;
$$;
drop table if exists public.whatsapp_coexistence_sync_attempts;
drop table if exists public.whatsapp_coexistence_sync;
alter table public.whatsapp_platform_settings drop column if exists coexistence_sync_enabled;
commit;

-- Rollback da migration 20261207010000 (Iniciar conversa com ACESSO AUTOMÁTICO pelo módulo WhatsApp). Volta ao modelo anterior:
-- só funciona onde existe linha em company_whatsapp_start_settings com enabled = true (sem linha = desligado, padrão da coluna = false).
-- ATENÇÃO (efeito comercial): depois do rollback, empresa sem linha deixa de poder iniciar conversas; só as habilitadas pelo Master (enabled = true) continuam.
-- Desfaz: (1) as duas substituições em whatsapp_start_request_reserve e a de whatsapp_templates_sync_request (substituição exata inversa; cada trecho tem de
-- ocorrer exatamente 1 vez, senão aborta); (2) whatsapp_get_start_settings volta ao corpo da 7.11B; (3) remove master_whatsapp_start_overview, a trilha
-- (trigger + função + tabela company_whatsapp_start_events) e whatsapp_start_gate; (4) padrão da coluna volta a false. Não toca configurações, pedidos,
-- conversas, mensagens, assinaturas, cortesias nem faturas. A trilha de auditoria é APAGADA (guarde uma cópia antes, se quiser).
-- Para poder reaplicar a migration depois:
--   node node_modules/supabase/dist/supabase.js migration repair --status reverted 20261207010000 --linked
begin;

create or replace function pg_temp.unpatch_start_fn(p_proc text, p_args text, p_from text, p_to text)
returns void
language plpgsql
as $$
declare
  v_oid oid;
  v_def text;
begin
  select p.oid into v_oid from pg_proc p
   where p.proname = p_proc and p.pronamespace = 'public'::regnamespace and pg_get_function_identity_arguments(p.oid) = p_args;
  if v_oid is null then
    raise exception 'unpatch_fn: função % não encontrada', p_proc;
  end if;
  v_def := replace(pg_get_functiondef(v_oid), chr(13), '');
  if (length(v_def) - length(replace(v_def, p_from, ''))) / greatest(length(p_from), 1) <> 1 then
    raise exception 'unpatch_fn: trecho esperado não ocorre exatamente 1 vez em %', p_proc;
  end if;
  execute replace(v_def, p_from, p_to);
end;
$$;

select pg_temp.unpatch_start_fn(
  'whatsapp_start_request_reserve',
  'p_company_id uuid, p_connection_id uuid, p_client_request_id uuid, p_contact_kind text, p_contact_ref uuid, p_contact_key text, p_template_id uuid, p_consent_confirmed boolean',
  $f$  -- acesso automático pelo módulo WhatsApp (assert_starter já exigiu o módulo); só o bloqueio explícito do Master recusa. Sem linha = limites padrão.
  v_gate := public.whatsapp_start_gate(p_company_id);
  if (v_gate ->> 'blocked')::boolean then
    raise exception 'Iniciar conversas está bloqueado para esta empresa pelo administrador da plataforma.' using errcode = 'PT409';
  end if;
  v_limit := (v_gate ->> 'daily_limit')::integer;
  v_interval := (v_gate ->> 'min_interval_hours')::integer;$f$,
  $f$  select * into v_s from public.company_whatsapp_start_settings where company_id = p_company_id;
  if not found or not v_s.enabled then
    raise exception 'Iniciar conversas está desativado para esta empresa.' using errcode = 'PT409';
  end if;
  v_limit := v_s.daily_limit;
  v_interval := v_s.min_interval_hours;$f$);

select pg_temp.unpatch_start_fn(
  'whatsapp_start_request_reserve',
  'p_company_id uuid, p_connection_id uuid, p_client_request_id uuid, p_contact_kind text, p_contact_ref uuid, p_contact_key text, p_template_id uuid, p_consent_confirmed boolean',
  $f$  v_limit integer;
  v_interval integer;
  v_gate jsonb;
begin
  perform public.whatsapp_start_assert_starter(p_company_id);$f$,
  $f$  v_limit integer;
  v_interval integer;
begin
  perform public.whatsapp_start_assert_starter(p_company_id);$f$);

select pg_temp.unpatch_start_fn(
  'whatsapp_templates_sync_request',
  'p_company_id uuid',
  $f$    -- acesso automático pelo módulo (whatsapp_assert_reader já exigiu o módulo); só o bloqueio explícito do Master recusa
    if (public.whatsapp_start_gate(p_company_id) ->> 'blocked')::boolean then
      raise exception 'Iniciar conversas está bloqueado para esta empresa pelo administrador da plataforma.' using errcode = 'PT409';
    end if;$f$,
  $f$    select * into v_s from public.company_whatsapp_start_settings where company_id = p_company_id;
    if not found or not v_s.enabled then
      raise exception 'Iniciar conversas está desativado para esta empresa.' using errcode = 'PT409';
    end if;$f$);

create or replace function public.whatsapp_get_start_settings(p_company_id uuid)
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

drop function public.master_whatsapp_start_overview(uuid);
drop trigger company_whatsapp_start_settings_audit on public.company_whatsapp_start_settings;
drop function public.company_whatsapp_start_settings_audit();
drop table public.company_whatsapp_start_events;
drop function public.whatsapp_start_gate(uuid);

comment on column public.company_whatsapp_start_settings.enabled is null;
alter table public.company_whatsapp_start_settings alter column enabled set default false;

commit;

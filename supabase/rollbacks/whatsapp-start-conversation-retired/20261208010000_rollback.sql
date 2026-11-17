-- Rollback da migration 20261208010000 (RETIRADA do Iniciar conversa por template). Reativa o servidor para o estado da 20261207010000 (acesso automático pelo
-- módulo WhatsApp com bloqueio do Master), desfazendo SOMENTE as substituições da retirada (substituição exata inversa; cada trecho tem de ocorrer exatamente
-- 1 vez, senão aborta), restaurando whatsapp_get_start_settings e removendo whatsapp_start_retired(). Não toca dados (pedidos, templates, opt-outs, configurações,
-- trilha, mensagens, conversas) nem preços. ATENÇÃO: reativar o servidor só devolve a funcionalidade se o frontend e as Edge Functions correspondentes estiverem publicados.
-- Para poder reaplicar a migration depois:
--   node node_modules/supabase/dist/supabase.js migration repair --status reverted 20261208010000 --linked
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
  'whatsapp_start_conversation',
  'p_company_id uuid, p_client_request_id uuid, p_contact_kind text, p_contact_ref uuid, p_template_id uuid, p_params jsonb, p_consent_confirmed boolean, p_consent_origin text, p_consent_ref text',
  $f$begin
  -- RETIRADA: iniciar conversa por template foi descontinuado; nada é criado, nem repetição de pedido antigo
  if public.whatsapp_start_retired() then
    raise exception 'Iniciar conversa por template foi descontinuado.' using errcode = 'PT409';
  end if;
  v_role := public.whatsapp_start_assert_starter(p_company_id);          -- PT401/PT404/PT403/PT402 + módulo WhatsApp (PT403)
$f$,
  $f$begin
  v_role := public.whatsapp_start_assert_starter(p_company_id);          -- PT401/PT404/PT403/PT402 + módulo WhatsApp (PT403)
$f$);

select pg_temp.unpatch_start_fn(
  'whatsapp_start_request_reserve',
  'p_company_id uuid, p_connection_id uuid, p_client_request_id uuid, p_contact_kind text, p_contact_ref uuid, p_contact_key text, p_template_id uuid, p_consent_confirmed boolean',
  $f$  v_gate jsonb;
begin
  -- RETIRADA: nenhuma reserva de pedido de início de conversa
  if public.whatsapp_start_retired() then
    raise exception 'Iniciar conversa por template foi descontinuado.' using errcode = 'PT409';
  end if;
  perform public.whatsapp_start_assert_starter(p_company_id);$f$,
  $f$  v_gate jsonb;
begin
  perform public.whatsapp_start_assert_starter(p_company_id);$f$);

select pg_temp.unpatch_start_fn(
  'whatsapp_templates_sync_request',
  'p_company_id uuid',
  $f$begin
  -- RETIRADA: a sincronização de templates serve só ao início de conversa e foi descontinuada
  if public.whatsapp_start_retired() then
    raise exception 'Iniciar conversa por template foi descontinuado.' using errcode = 'PT409';
  end if;
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_master := public.is_master_admin();$f$,
  $f$begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_master := public.is_master_admin();$f$);

select pg_temp.unpatch_start_fn(
  'whatsapp_set_start_settings',
  'p_company_id uuid, p_enabled boolean, p_daily_limit integer, p_min_interval_hours integer',
  $f$begin
  -- RETIRADA: a configuração deixou de existir (as linhas antigas ficam preservadas, só leitura)
  if public.whatsapp_start_retired() then
    raise exception 'Iniciar conversa por template foi descontinuado.' using errcode = 'PT409';
  end if;
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if not public.is_master_admin() then
    raise exception 'Somente o administrador da plataforma pode configurar o início de conversas.' using errcode = 'PT403';$f$,
  $f$begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if not public.is_master_admin() then
    raise exception 'Somente o administrador da plataforma pode configurar o início de conversas.' using errcode = 'PT403';$f$);

select pg_temp.unpatch_start_fn(
  'whatsapp_start_gate',
  'p_company_id uuid',
  $f$    'available', false,
    'reason', case when public.whatsapp_start_retired() then 'retired' when v_blocked then 'blocked' when not v_mod then 'no_module' when v_readonly then 'read_only' else 'available' end,$f$,
  $f$    'available', v_mod and not v_blocked and not v_readonly,
    'reason', case when v_blocked then 'blocked' when not v_mod then 'no_module' when v_readonly then 'read_only' else 'available' end,$f$);

create or replace function public.whatsapp_get_start_settings(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_g jsonb;
begin
  v_role := public.whatsapp_assert_reader(p_company_id);
  v_g := public.whatsapp_start_gate(p_company_id);
  return jsonb_build_object(
    'enabled', (v_g ->> 'available')::boolean,
    'blocked', (v_g ->> 'blocked')::boolean,
    'reason', v_g ->> 'reason',
    'source', v_g ->> 'source',
    'daily_limit', (v_g ->> 'daily_limit')::integer,
    'min_interval_hours', (v_g ->> 'min_interval_hours')::integer,
    'used_today', public.whatsapp_start_used_today(p_company_id),
    'can_start', v_role in ('owner', 'admin', 'attendant'));
end;
$$;

drop function public.whatsapp_start_retired();

commit;

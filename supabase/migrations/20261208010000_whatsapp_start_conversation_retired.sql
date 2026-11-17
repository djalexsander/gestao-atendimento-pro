-- Iniciar conversa por template — RETIRADA (decisão comercial definitiva, 2026-11-17).
--
-- O QUE FAZ: desliga NO SERVIDOR a criação de novas solicitações de início de conversa por template, de forma incondicional (não depende de nenhuma configuração
-- antiga, de módulo, de cortesia nem do Master) e também para chamadas DIRETAS às RPCs e às Edge Functions (que só chegam ao Meta depois de uma RPC):
--   whatsapp_start_conversation        recusa antes de qualquer verificação ou gravação
--   whatsapp_start_request_reserve     idem (a RPC interna que cria o pedido)
--   whatsapp_templates_sync_request    recusa o pedido de sincronização (inclusive o do Master): a Edge whatsapp-templates-sync não chega à Meta
--   whatsapp_set_start_settings        recusa (ninguém mais habilita, bloqueia ou ajusta limites)
--   whatsapp_get_start_settings        passa a devolver SEMPRE "desabilitado" (telas antigas, ainda abertas, escondem o recurso)
--   whatsapp_start_gate                available = false, reason = 'retired'
-- Tudo isso pela função whatsapp_start_retired() (constante TRUE): reverter exige este rollback, não um ajuste de configuração.
--
-- O QUE NÃO FAZ (preservado): recebimento de mensagens, atendimento manual, envio de texto, IA, histórico, contatos, Coexistence, Cloud API, webhooks, vínculos de
-- cliente, opt-out (continua registrando e respeitando pedidos de parar), as correções de equivalência do nono dígito e de concorrência do eco (7.11D e 7.11H:
-- whatsapp_ingest_message, whatsapp_ingest_echo e whatsapp_resolve_conversation_phone NÃO são tocadas). Nenhuma linha é apagada: pedidos antigos, templates em cache,
-- mensagens de template, opt-outs, configurações e a trilha de auditoria continuam. Consulta (whatsapp_list_start_requests) e resolução de pedidos antigos incertos
-- (whatsapp_start_request_resolve) continuam funcionando; o despacho de uma mensagem já enfileirada não é alterado. Preços dos módulos, assinaturas, cortesias e
-- faturas não são tocados.
--
-- Cada ajuste é por substituição exata do corpo atual (falha fechada se o trecho não ocorrer exatamente 1 vez); CREATE OR REPLACE preserva ACL e SECURITY DEFINER.

create function public.whatsapp_start_retired()
returns boolean
language sql
immutable
as $$ select true $$;
revoke execute on function public.whatsapp_start_retired() from public, anon, authenticated, service_role;

create or replace function pg_temp.patch_start_fn(p_proc text, p_args text, p_from text, p_to text)
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
    raise exception 'patch_fn: função % não encontrada', p_proc;
  end if;
  v_def := replace(pg_get_functiondef(v_oid), chr(13), '');
  if (length(v_def) - length(replace(v_def, p_from, ''))) / greatest(length(p_from), 1) <> 1 then
    raise exception 'patch_fn: trecho esperado não ocorre exatamente 1 vez em %', p_proc;
  end if;
  execute replace(v_def, p_from, p_to);
end;
$$;

-- 1) início de conversa (RPC pública)
select pg_temp.patch_start_fn(
  'whatsapp_start_conversation',
  'p_company_id uuid, p_client_request_id uuid, p_contact_kind text, p_contact_ref uuid, p_template_id uuid, p_params jsonb, p_consent_confirmed boolean, p_consent_origin text, p_consent_ref text',
  $f$begin
  v_role := public.whatsapp_start_assert_starter(p_company_id);          -- PT401/PT404/PT403/PT402 + módulo WhatsApp (PT403)
$f$,
  $f$begin
  -- RETIRADA: iniciar conversa por template foi descontinuado; nada é criado, nem repetição de pedido antigo
  if public.whatsapp_start_retired() then
    raise exception 'Iniciar conversa por template foi descontinuado.' using errcode = 'PT409';
  end if;
  v_role := public.whatsapp_start_assert_starter(p_company_id);          -- PT401/PT404/PT403/PT402 + módulo WhatsApp (PT403)
$f$);

-- 2) reserva do pedido (RPC interna)
select pg_temp.patch_start_fn(
  'whatsapp_start_request_reserve',
  'p_company_id uuid, p_connection_id uuid, p_client_request_id uuid, p_contact_kind text, p_contact_ref uuid, p_contact_key text, p_template_id uuid, p_consent_confirmed boolean',
  $f$  v_gate jsonb;
begin
  perform public.whatsapp_start_assert_starter(p_company_id);$f$,
  $f$  v_gate jsonb;
begin
  -- RETIRADA: nenhuma reserva de pedido de início de conversa
  if public.whatsapp_start_retired() then
    raise exception 'Iniciar conversa por template foi descontinuado.' using errcode = 'PT409';
  end if;
  perform public.whatsapp_start_assert_starter(p_company_id);$f$);

-- 3) pedido de sincronização de templates (inclusive Master): a Edge não chega à Meta
select pg_temp.patch_start_fn(
  'whatsapp_templates_sync_request',
  'p_company_id uuid',
  $f$begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_master := public.is_master_admin();$f$,
  $f$begin
  -- RETIRADA: a sincronização de templates serve só ao início de conversa e foi descontinuada
  if public.whatsapp_start_retired() then
    raise exception 'Iniciar conversa por template foi descontinuado.' using errcode = 'PT409';
  end if;
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_master := public.is_master_admin();$f$);

-- 4) configuração do Master: ninguém mais altera
select pg_temp.patch_start_fn(
  'whatsapp_set_start_settings',
  'p_company_id uuid, p_enabled boolean, p_daily_limit integer, p_min_interval_hours integer',
  $f$begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if not public.is_master_admin() then
    raise exception 'Somente o administrador da plataforma pode configurar o início de conversas.' using errcode = 'PT403';$f$,
  $f$begin
  -- RETIRADA: a configuração deixou de existir (as linhas antigas ficam preservadas, só leitura)
  if public.whatsapp_start_retired() then
    raise exception 'Iniciar conversa por template foi descontinuado.' using errcode = 'PT409';
  end if;
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if not public.is_master_admin() then
    raise exception 'Somente o administrador da plataforma pode configurar o início de conversas.' using errcode = 'PT403';$f$);

-- 5) portão: nunca disponível
select pg_temp.patch_start_fn(
  'whatsapp_start_gate',
  'p_company_id uuid',
  $f$    'available', v_mod and not v_blocked and not v_readonly,
    'reason', case when v_blocked then 'blocked' when not v_mod then 'no_module' when v_readonly then 'read_only' else 'available' end,$f$,
  $f$    'available', false,
    'reason', case when public.whatsapp_start_retired() then 'retired' when v_blocked then 'blocked' when not v_mod then 'no_module' when v_readonly then 'read_only' else 'available' end,$f$);

-- 6) estado para telas antigas ainda abertas: sempre desabilitado
create or replace function public.whatsapp_get_start_settings(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
begin
  v_role := public.whatsapp_assert_reader(p_company_id);
  return jsonb_build_object(
    'enabled', false,
    'blocked', false,
    'reason', 'retired',
    'source', 'none',
    'daily_limit', 50,
    'min_interval_hours', 24,
    'used_today', public.whatsapp_start_used_today(p_company_id),
    'can_start', false);
end;
$$;

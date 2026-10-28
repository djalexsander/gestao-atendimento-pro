-- Rollback MANUAL da migration 20261104010000_whatsapp_embedded_signup_foundation.sql (nunca roda sozinho).
-- Remove só o que ela criou e devolve whatsapp_signup_begin ao corpo de 20261028010000. Conexões, conversas, mensagens e a tabela
-- whatsapp_signup_attempts não são tocadas. Perdem-se apenas as colunas novas e as sessões de signup.
drop function if exists public.whatsapp_connection_set_health(uuid, text, text, timestamptz);
drop function if exists public.whatsapp_signup_complete(uuid, text, text, text, text, text, timestamptz, timestamptz, text);
drop function if exists public.whatsapp_signup_sweep(uuid);
drop function if exists public.whatsapp_signup_fail(uuid, text);
drop function if exists public.whatsapp_signup_store_token(uuid, text, timestamptz);
drop function if exists public.whatsapp_signup_reserve(text);

create or replace function public.whatsapp_signup_begin(p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_av jsonb;
  v_nonce text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Somente o proprietário ou administrador pode conectar o WhatsApp.' using errcode = 'PT403';
  end if;
  perform public.assert_company_module(p_company_id, 'whatsapp');
  v_av := public.whatsapp_signup_availability();
  if not (v_av ->> 'available')::boolean then
    raise exception 'A conexão automática ainda depende da aprovação da Meta e não está disponível.' using errcode = 'PT409';
  end if;
  update public.whatsapp_signup_attempts set status = 'expired'
   where company_id = p_company_id and status = 'started' and expires_at <= now();
  insert into public.whatsapp_signup_attempts (company_id, state_nonce, created_by) values (p_company_id, v_nonce, auth.uid());
  return jsonb_build_object('state', v_nonce, 'meta_app_id', v_av ->> 'meta_app_id', 'config_id', v_av ->> 'config_id');
end;
$$;

drop function if exists public.whatsapp_signup_user_can_manage(uuid, uuid);
drop table if exists public.whatsapp_signup_sessions;

alter table public.company_whatsapp_connections
  drop column if exists connection_source,
  drop column if exists connection_type,
  drop column if exists meta_business_id,
  drop column if exists token_expires_at,
  drop column if exists token_status,
  drop column if exists registered_at,
  drop column if exists webhook_subscribed_at,
  drop column if exists last_error_code;

-- WhatsApp Embedded Signup v4 — ETAPA 2 (correção de limpeza): segredo órfão de sessão JÁ marcada como failed.
--
-- Em 20261104010000, whatsapp_signup_complete marca a sessão como 'failed' (phone_in_use, company_has_active_connection,
-- unauthorized) sem apagar o segredo do Vault gravado por whatsapp_signup_store_token, e whatsapp_signup_fail/sweep só olhavam
-- sessões pending/reserved. O segredo ficava órfão. Aqui:
--   * whatsapp_signup_fail passa a limpar também uma sessão já 'failed' que ainda guarda a referência (idempotente).
--   * whatsapp_signup_sweep passa a varrer, além das vencidas, qualquer sessão 'failed' com referência pendente.
-- Duas travas independentes no DELETE: (1) o segredo não pode estar ligado a nenhuma conexão; (2) só se apaga segredo CRIADO por
-- whatsapp_signup_store_token (nome wa_token_signup_*), nunca um token de conexão manual/antiga.
-- Segredo ligado a uma conexão nunca é apagado. Assinaturas e ACL inalteradas (CREATE OR REPLACE mantém os grants).

create or replace function public.whatsapp_signup_fail(p_session_id uuid, p_error_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.whatsapp_signup_sessions;
  v_code text := coalesce(nullif(btrim(p_error_code), ''), 'unknown');
  v_cleaned boolean := false;
begin
  if v_code !~ '^[A-Za-z0-9_.:-]{1,60}$' then
    v_code := 'invalid_code';
  end if;
  select * into v_s from public.whatsapp_signup_sessions where id = p_session_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'session_not_found');
  end if;
  if v_s.status not in ('pending', 'reserved', 'failed') then
    return jsonb_build_object('ok', true, 'status', v_s.status, 'changed', false);
  end if;
  if v_s.token_secret_id is not null
     and not exists (select 1 from public.company_whatsapp_connections c where c.token_secret_id = v_s.token_secret_id) then
    delete from vault.secrets where id = v_s.token_secret_id and starts_with(name, 'wa_token_signup_');
    v_cleaned := true;
  end if;
  if v_s.status in ('pending', 'reserved') then
    update public.whatsapp_signup_sessions
       set status = 'failed', error_code = v_code, token_secret_id = null, token_expires_at = null
     where id = v_s.id;
    return jsonb_build_object('ok', true, 'status', 'failed', 'changed', true);
  end if;
  if v_cleaned then
    update public.whatsapp_signup_sessions set token_secret_id = null, token_expires_at = null where id = v_s.id;
  end if;
  return jsonb_build_object('ok', true, 'status', 'failed', 'changed', v_cleaned);
end;
$$;

create or replace function public.whatsapp_signup_sweep(p_company_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secrets integer := 0;
  v_sessions integer := 0;
  v_row record;
begin
  for v_row in
    select s.id, s.token_secret_id from public.whatsapp_signup_sessions s
     where s.status in ('pending', 'reserved') and s.expires_at <= now()
       and (p_company_id is null or s.company_id = p_company_id)
     for update
  loop
    if v_row.token_secret_id is not null
       and not exists (select 1 from public.company_whatsapp_connections c where c.token_secret_id = v_row.token_secret_id) then
      delete from vault.secrets where id = v_row.token_secret_id and starts_with(name, 'wa_token_signup_');
      v_secrets := v_secrets + 1;
    end if;
    v_sessions := v_sessions + 1;
    update public.whatsapp_signup_sessions
       set status = 'expired', token_secret_id = null, token_expires_at = null
     where id = v_row.id;
  end loop;

  -- sessões já falhas que ainda guardam a referência (falha dentro de whatsapp_signup_complete)
  for v_row in
    select s.id, s.token_secret_id from public.whatsapp_signup_sessions s
     where s.status = 'failed' and s.token_secret_id is not null
       and (p_company_id is null or s.company_id = p_company_id)
     for update
  loop
    if not exists (select 1 from public.company_whatsapp_connections c where c.token_secret_id = v_row.token_secret_id) then
      delete from vault.secrets where id = v_row.token_secret_id and starts_with(name, 'wa_token_signup_');
      v_secrets := v_secrets + 1;
    end if;
    update public.whatsapp_signup_sessions set token_secret_id = null, token_expires_at = null where id = v_row.id;
  end loop;

  return jsonb_build_object('ok', true, 'sessions_expired', v_sessions, 'secrets_removed', v_secrets);
end;
$$;

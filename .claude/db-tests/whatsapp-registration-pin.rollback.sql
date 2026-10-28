-- Rollback MANUAL da migration 20261106010000_whatsapp_registration_pin.sql (nunca roda sozinho).
-- Remove só o que ela criou e devolve whatsapp_signup_sweep ao corpo de 20261105010000. Conexões, conversas, mensagens, sessões de
-- signup e os tokens do Vault não são tocados.
-- ATENÇÃO: DROP TABLE não dispara o gatilho que apaga segredos. Os segredos de PIN (wa_pin_*) permanecem no Vault SEM referência;
-- depois de um rollback com uso real, o PIN de cada número só é recuperável pelo nome do segredo (wa_pin_<id do registro>_*).
-- Não rode este rollback depois de haver números registrados em produção sem antes exportar a lista de wa_pin_* por um operador.
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

drop function if exists public.whatsapp_pin_reveal_consume(uuid, uuid);
drop function if exists public.whatsapp_pin_reveal_authorize(uuid, text);
drop function if exists public.whatsapp_registration_sweep();
drop function if exists public.whatsapp_registration_link(uuid, uuid);
drop function if exists public.whatsapp_registration_resolve(uuid, text);
drop function if exists public.whatsapp_registration_finish_attempt(uuid, text, text);
drop function if exists public.whatsapp_registration_begin_attempt(uuid, uuid);
drop function if exists public.whatsapp_registration_store_pin(uuid, uuid, text, text);
drop function if exists public.whatsapp_registration_prepare(uuid, text, text);
drop function if exists public.whatsapp_registration_check_session(uuid, uuid);
drop table if exists public.whatsapp_pin_reveal_requests;
drop table if exists public.whatsapp_registration_attempts;
drop trigger if exists whatsapp_number_registrations_drop_secret on public.whatsapp_number_registrations;
drop table if exists public.whatsapp_number_registrations;
drop function if exists public.whatsapp_registration_drop_secret();

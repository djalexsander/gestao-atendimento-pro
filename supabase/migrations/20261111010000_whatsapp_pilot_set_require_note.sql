-- Etapa 10.1: a nota (motivo) passa a ser obrigatória no BANCO para autorizar ou revogar empresas do piloto.
-- Migration aditiva: apenas CREATE OR REPLACE da RPC já existente (mesma assinatura => ACL preservada, reafirmada abaixo).
-- Regras novas: nota aparada (btrim) com 5 a 500 caracteres; vazia/só espaços/curta/longa => PT400, sem gravar nada
-- (não trunca mais em silêncio). Mantidos: assert_master_admin() primeiro, lock por empresa, auditoria em
-- whatsapp_signup_pilot_events, encerramento das sessões ao revogar.

create or replace function public.master_whatsapp_pilot_set(p_company_id uuid, p_authorized boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_row public.whatsapp_signup_pilot_companies;
  v_closed integer := 0;
  v_sess record;
  v_changed boolean := false;
begin
  perform public.assert_master_admin();
  v_actor := auth.uid();
  if p_company_id is null or p_authorized is null then
    raise exception 'Parâmetros inválidos.' using errcode = 'PT400';
  end if;
  if v_note is null then
    raise exception 'Informe o motivo da alteração.' using errcode = 'PT400';
  end if;
  if char_length(v_note) < 5 then
    raise exception 'O motivo deve ter pelo menos 5 caracteres.' using errcode = 'PT400';
  end if;
  if char_length(v_note) > 500 then
    raise exception 'O motivo deve ter no máximo 500 caracteres.' using errcode = 'PT400';
  end if;
  if not exists (select 1 from public.companies where id = p_company_id) then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('wa_signup:' || p_company_id::text, 0));
  select * into v_row from public.whatsapp_signup_pilot_companies where company_id = p_company_id for update;

  if p_authorized then
    if not found then
      insert into public.whatsapp_signup_pilot_companies (company_id, authorized, authorized_by, authorized_at, note)
      values (p_company_id, true, v_actor, now(), v_note);
      v_changed := true;
    elsif not v_row.authorized then
      update public.whatsapp_signup_pilot_companies
         set authorized = true, authorized_by = v_actor, authorized_at = now(), revoked_by = null, revoked_at = null,
             note = v_note, updated_at = now()
       where company_id = p_company_id;
      v_changed := true;
    end if;
    if v_changed then
      insert into public.whatsapp_signup_pilot_events (company_id, action, actor_user_id, note) values (p_company_id, 'authorized', v_actor, v_note);
    end if;
  else
    if found and v_row.authorized then
      update public.whatsapp_signup_pilot_companies
         set authorized = false, revoked_by = v_actor, revoked_at = now(), updated_at = now()
       where company_id = p_company_id;
      insert into public.whatsapp_signup_pilot_events (company_id, action, actor_user_id, note) values (p_company_id, 'revoked', v_actor, v_note);
      v_changed := true;
      -- sessões em andamento não podem mais concluir; whatsapp_signup_fail só apaga o segredo ainda NÃO ligado a conexão
      for v_sess in
        select id from public.whatsapp_signup_sessions where company_id = p_company_id and status in ('pending', 'reserved')
      loop
        perform public.whatsapp_signup_fail(v_sess.id, 'pilot_revoked');
        v_closed := v_closed + 1;
      end loop;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'changed', v_changed, 'authorized', p_authorized, 'sessions_closed', v_closed);
end;
$$;

revoke execute on function public.master_whatsapp_pilot_set(uuid, boolean, text) from public, anon, service_role;
grant execute on function public.master_whatsapp_pilot_set(uuid, boolean, text) to authenticated;

-- Rollback de 20261111010000_whatsapp_pilot_set_require_note.sql: restaura a master_whatsapp_pilot_set de 20261107010000 (nota opcional, truncada em 500).
-- Só troca o corpo da função (mesma assinatura); nenhuma tabela, coluna ou dado é tocado. Rodar ANTES do rollback de 20261107010000.
create or replace function public.master_whatsapp_pilot_set(p_company_id uuid, p_authorized boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_note text := left(nullif(btrim(coalesce(p_note, '')), ''), 500);
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
             note = coalesce(v_note, note), updated_at = now()
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

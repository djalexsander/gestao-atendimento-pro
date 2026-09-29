-- Fechar o caixa de OUTRO operador exige justificativa.
--
-- Recria close_cash_session (mesma assinatura, mesmo SECURITY DEFINER e search_path, mesmo ACL)
-- somando uma regra: se quem fecha é owner/admin e o caixa foi aberto por OUTRA pessoa, a
-- observação (closing_notes) é obrigatória e não pode ser vazia/só espaços. Continuam iguais:
--   * cashier fecha apenas o PRÓPRIO caixa (observação opcional);
--   * owner/admin fecham o próprio caixa com observação opcional;
--   * owner/admin fecham caixa alheio (agora com justificativa); closed_by = quem fechou,
--     opened_by nunca muda (guard_cash_session_change);
--   * attendant não fecha caixa.
create or replace function public.close_cash_session(p_cash_session_id uuid, p_notes text default null)
returns public.cash_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cash public.cash_sessions;
  v_role public.company_role;
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_cash from public.cash_sessions where id = p_cash_session_id for update;
  if not found then
    raise exception 'Caixa não encontrado.' using errcode = 'PT404';
  end if;

  v_role := public.user_role_in_company(v_cash.company_id);
  if v_role is null or (v_role = 'cashier' and v_cash.opened_by <> auth.uid()) then
    raise exception 'Caixa não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier') then
    raise exception 'Você não tem permissão para fechar o caixa.' using errcode = 'PT403';
  end if;

  if v_cash.status <> 'open' then
    raise exception 'Este caixa já está fechado.' using errcode = 'PT409';
  end if;

  -- Caixa de outro operador (só owner/admin chegam aqui): justificativa obrigatória.
  if v_cash.opened_by <> auth.uid() and v_notes is null then
    raise exception 'Informe o motivo para fechar o caixa de outro operador.' using errcode = 'PT400';
  end if;

  if v_notes is not null and char_length(v_notes) > 500 then
    raise exception 'A observação pode ter no máximo 500 caracteres.' using errcode = 'PT400';
  end if;

  update public.cash_sessions
     set status = 'closed', closed_at = now(), closed_by = auth.uid(), closing_notes = v_notes
   where id = v_cash.id
  returning * into v_cash;

  return v_cash;
end;
$$;

-- Mesmo ACL da 040000 (CREATE OR REPLACE preserva, reafirmado por segurança).
revoke execute on function public.close_cash_session(uuid, text) from public, anon;
grant execute on function public.close_cash_session(uuid, text) to authenticated;

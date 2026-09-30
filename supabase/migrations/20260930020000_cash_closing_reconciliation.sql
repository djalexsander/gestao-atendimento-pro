-- Conferência física do dinheiro no fechamento do caixa + totais por caixa para o histórico.
--
-- 1) cash_sessions ganha closing_cash_amount (dinheiro CONTADO) e cash_difference (contado - esperado).
--    O esperado NÃO é gravado: é derivável com segurança (esperado = contado - diferença) e o caixa
--    fechado não recebe mais movimentos (guard_cash_session_change + close_service_session só usa
--    caixa 'open'). Caixas fechados ANTES desta migration ficam com os dois campos NULL (sem conferência).
-- 2) close_cash_session passa a exigir o dinheiro contado e calcula NO SERVIDOR:
--        esperado  = opening_amount + soma dos cash_movements 'sale' com payment_method = 'cash'
--        diferença = contado - esperado
--    (Pix/débito/crédito/outros NÃO entram no esperado; sangria/suprimento ainda não existem.)
--    A assinatura muda (novo parâmetro), então a antiga (uuid, text) é REMOVIDA: não fica caminho
--    de fechamento sem conferência.
-- 3) View cash_session_totals (security_invoker => aplica a RLS de cash_movements): vendas por forma
--    de pagamento de cada caixa, para o histórico listar sem trazer todos os movimentos.
--
-- Regras da observação (closing_notes): obrigatória quando (a) owner/admin fecha caixa de OUTRO
-- operador ou (b) há diferença (contado <> esperado). Uma observação só justifica as duas.
-- Não muda: permissões (cashier só o próprio; owner/admin qualquer), SECURITY DEFINER, search_path,
-- comandas abertas não impedem o fechamento, RLS de leitura.

alter table public.cash_sessions
  add column closing_cash_amount numeric(12, 2)
    constraint cash_sessions_closing_cash_amount_check check (closing_cash_amount >= 0 and closing_cash_amount <> 'NaN'::numeric),
  add column cash_difference numeric(12, 2)
    constraint cash_sessions_cash_difference_check check (cash_difference <> 'NaN'::numeric);

alter table public.cash_sessions
  add constraint cash_sessions_reconciliation_consistency check (
    (closing_cash_amount is null and cash_difference is null)
    or (status = 'closed' and closing_cash_amount is not null and cash_difference is not null)
  );

comment on column public.cash_sessions.closing_cash_amount is
  'Dinheiro contado na gaveta no fechamento. NULL em caixas fechados antes da conferência.';
comment on column public.cash_sessions.cash_difference is
  'contado - esperado (esperado = opening_amount + vendas em dinheiro do caixa), calculado no servidor. Negativo = falta; positivo = sobra.';

drop function public.close_cash_session(uuid, text);

create function public.close_cash_session(
  p_cash_session_id uuid,
  p_closing_cash_amount numeric,
  p_notes text default null
)
returns public.cash_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cash public.cash_sessions;
  v_role public.company_role;
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_cash_sales numeric(12, 2);
  v_expected numeric(12, 2);
  v_diff numeric(12, 2);
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  -- Trava o caixa: vendas em andamento (close_service_session usa FOR SHARE) terminam antes do cálculo.
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

  if p_closing_cash_amount is null then
    raise exception 'Informe o dinheiro contado no caixa.' using errcode = 'PT400';
  end if;
  if p_closing_cash_amount < 0 or p_closing_cash_amount >= 10000000000
     or p_closing_cash_amount <> round(p_closing_cash_amount, 2) then
    raise exception 'Informe um valor contado válido (zero ou mais, com até 2 casas decimais).' using errcode = 'PT400';
  end if;

  select coalesce(sum(amount), 0)::numeric(12, 2) into v_cash_sales
  from public.cash_movements
  where company_id = v_cash.company_id
    and cash_session_id = v_cash.id
    and movement_type = 'sale'
    and payment_method = 'cash';

  v_expected := v_cash.opening_amount + v_cash_sales;
  v_diff := p_closing_cash_amount - v_expected;

  -- Caixa de outro operador (só owner/admin chegam aqui): justificativa obrigatória.
  if v_cash.opened_by <> auth.uid() and v_notes is null then
    raise exception 'Informe o motivo para fechar o caixa de outro operador.' using errcode = 'PT400';
  end if;
  if v_diff <> 0 and v_notes is null then
    raise exception 'Informe o motivo da diferença encontrada no caixa.' using errcode = 'PT400';
  end if;

  if v_notes is not null and char_length(v_notes) > 500 then
    raise exception 'A observação pode ter no máximo 500 caracteres.' using errcode = 'PT400';
  end if;

  update public.cash_sessions
     set status = 'closed', closed_at = now(), closed_by = auth.uid(), closing_notes = v_notes,
         closing_cash_amount = p_closing_cash_amount, cash_difference = v_diff
   where id = v_cash.id
  returning * into v_cash;

  return v_cash;
end;
$$;

revoke execute on function public.close_cash_session(uuid, numeric, text) from public, anon;
grant execute on function public.close_cash_session(uuid, numeric, text) to authenticated;

-- Vendas por forma de pagamento de cada caixa (valores aplicados; o troco nunca entra).
create view public.cash_session_totals
with (security_invoker = true)
as
select
  cash_session_id,
  company_id,
  coalesce(sum(amount) filter (where payment_method = 'cash'), 0)::numeric(12, 2) as cash_total,
  coalesce(sum(amount) filter (where payment_method = 'pix'), 0)::numeric(12, 2) as pix_total,
  coalesce(sum(amount) filter (where payment_method = 'debit_card'), 0)::numeric(12, 2) as debit_total,
  coalesce(sum(amount) filter (where payment_method = 'credit_card'), 0)::numeric(12, 2) as credit_total,
  coalesce(sum(amount) filter (where payment_method = 'other'), 0)::numeric(12, 2) as other_total,
  coalesce(sum(amount), 0)::numeric(12, 2) as total_sold
from public.cash_movements
where movement_type = 'sale'
group by cash_session_id, company_id;

revoke all on public.cash_session_totals from public, anon, authenticated;
grant select on public.cash_session_totals to authenticated;
grant all on public.cash_session_totals to service_role;

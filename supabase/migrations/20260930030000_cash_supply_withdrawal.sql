-- Caixa: SUPRIMENTO (entrada manual de dinheiro físico) e SANGRIA (retirada manual).
--
-- Não são venda: não entram em faturamento nem em "total vendido". Reaproveitam cash_movements
-- (que já tem created_by, description, created_at, cash_session_id, company_id):
--   movement_type  'sale' | 'supply' | 'withdrawal'
--   payment_method sempre 'cash' nos manuais (é dinheiro físico)
--   description    o MOTIVO (obrigatório, 1..200)
--   created_by     quem fez o movimento (auditoria); service_session_id/service_payment_id ficam NULL
-- O cliente continua SEM INSERT/UPDATE/DELETE direto: só a RPC add_cash_movement grava movimento
-- manual (e 'sale' continua só em close_service_session). Não há edição nem exclusão nesta etapa.
--
-- Dinheiro físico do caixa (fonte única, server-side):
--   opening_amount + vendas em dinheiro + suprimentos - sangrias
-- É o "disponível para sangria" e, no fechamento, o "esperado" (close_cash_session recriada).
-- A view cash_session_totals ganha supply_total e withdrawal_total; total_sold segue só vendas.

-- ---------------------------------------------------------------------------
-- 1) cash_movements: novos tipos + consistência dos manuais
-- ---------------------------------------------------------------------------
alter table public.cash_movements drop constraint cash_movements_type_check;
alter table public.cash_movements
  add constraint cash_movements_type_check check (movement_type in ('sale', 'supply', 'withdrawal'));

alter table public.cash_movements
  add constraint cash_movements_manual_check check (
    movement_type = 'sale'
    or (payment_method = 'cash' and service_session_id is null and service_payment_id is null)
  );

comment on table public.cash_movements is
  'Livro financeiro do caixa. sale: uma venda paga em N formas gera N movimentos (amount = valor aplicado; troco nunca entra). supply/withdrawal: suprimento/sangria manuais em dinheiro (description = motivo), criados só por add_cash_movement().';

-- ---------------------------------------------------------------------------
-- 2) Dinheiro físico do caixa (interno; não exposto ao cliente)
-- ---------------------------------------------------------------------------
create function public.cash_session_physical_cash(p_cash_session_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select cs.opening_amount + coalesce((
    select sum(case cm.movement_type when 'withdrawal' then -cm.amount else cm.amount end)
    from public.cash_movements cm
    where cm.company_id = cs.company_id
      and cm.cash_session_id = cs.id
      and cm.payment_method = 'cash'
      and cm.movement_type in ('sale', 'supply', 'withdrawal')
  ), 0)
  from public.cash_sessions cs
  where cs.id = p_cash_session_id;
$$;

revoke execute on function public.cash_session_physical_cash(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) RPC: suprimento / sangria
-- ---------------------------------------------------------------------------
-- Erros: PT401 sem sessão, PT404 (caixa inexistente, de outra empresa ou de outro operador para
-- cashier), PT403 (attendant), PT409 caixa fechado, PT400 tipo/valor/motivo inválidos ou sangria
-- acima do dinheiro disponível. O caixa é travado (FOR UPDATE): duas sangrias simultâneas
-- serializam e a segunda enxerga o saldo já reduzido; vendas em andamento (FOR SHARE) esperam.
create function public.add_cash_movement(
  p_cash_session_id uuid,
  p_movement_type text,
  p_amount numeric,
  p_reason text
)
returns public.cash_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cash public.cash_sessions;
  v_role public.company_role;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_available numeric;
  v_movement public.cash_movements;
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
    raise exception 'Você não tem permissão para movimentar o caixa.' using errcode = 'PT403';
  end if;

  if v_cash.status <> 'open' then
    raise exception 'Este caixa já está fechado.' using errcode = 'PT409';
  end if;

  if p_movement_type is null or p_movement_type not in ('supply', 'withdrawal') then
    raise exception 'Tipo de movimento inválido. Use suprimento ou sangria.' using errcode = 'PT400';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount >= 10000000000 or p_amount <> round(p_amount, 2) then
    raise exception 'Informe um valor maior que zero, com até 2 casas decimais.' using errcode = 'PT400';
  end if;
  if v_reason is null then
    raise exception 'Informe o motivo do movimento.' using errcode = 'PT400';
  end if;
  if char_length(v_reason) > 200 then
    raise exception 'O motivo pode ter no máximo 200 caracteres.' using errcode = 'PT400';
  end if;

  if p_movement_type = 'withdrawal' then
    v_available := public.cash_session_physical_cash(v_cash.id);
    if p_amount > v_available then
      raise exception 'Valor da sangria maior que o dinheiro disponível no caixa.' using errcode = 'PT400';
    end if;
  end if;

  insert into public.cash_movements (
    company_id, cash_session_id, movement_type, payment_method, amount, description, created_by
  ) values (
    v_cash.company_id, v_cash.id, p_movement_type, 'cash', p_amount, v_reason, auth.uid()
  ) returning * into v_movement;

  return v_movement;
end;
$$;

comment on function public.add_cash_movement(uuid, text, numeric, text) is
  'Suprimento/sangria manuais em dinheiro no caixa ABERTO (cashier: só o próprio; owner/admin: qualquer da empresa). Motivo obrigatório; sangria limitada ao dinheiro disponível; caixa travado. Nunca cria venda.';

revoke execute on function public.add_cash_movement(uuid, text, numeric, text) from public, anon;
grant execute on function public.add_cash_movement(uuid, text, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) close_cash_session: esperado = inicial + vendas em dinheiro + suprimentos - sangrias
-- ---------------------------------------------------------------------------
-- Mesma assinatura, SECURITY DEFINER, search_path, regras de permissão e de observação da
-- 20260930020000; só o cálculo do esperado muda (agora pela função única acima).
create or replace function public.close_cash_session(
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
  v_expected numeric(12, 2);
  v_diff numeric(12, 2);
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

  if p_closing_cash_amount is null then
    raise exception 'Informe o dinheiro contado no caixa.' using errcode = 'PT400';
  end if;
  if p_closing_cash_amount < 0 or p_closing_cash_amount >= 10000000000
     or p_closing_cash_amount <> round(p_closing_cash_amount, 2) then
    raise exception 'Informe um valor contado válido (zero ou mais, com até 2 casas decimais).' using errcode = 'PT400';
  end if;

  v_expected := public.cash_session_physical_cash(v_cash.id);
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

-- ---------------------------------------------------------------------------
-- 5) View: totais por caixa (vendas separadas de suprimento/sangria)
-- ---------------------------------------------------------------------------
-- Colunas antigas mantidas na mesma ordem (só vendas); as novas entram no fim.
create or replace view public.cash_session_totals
with (security_invoker = true)
as
select
  cash_session_id,
  company_id,
  coalesce(sum(amount) filter (where movement_type = 'sale' and payment_method = 'cash'), 0)::numeric(12, 2) as cash_total,
  coalesce(sum(amount) filter (where movement_type = 'sale' and payment_method = 'pix'), 0)::numeric(12, 2) as pix_total,
  coalesce(sum(amount) filter (where movement_type = 'sale' and payment_method = 'debit_card'), 0)::numeric(12, 2) as debit_total,
  coalesce(sum(amount) filter (where movement_type = 'sale' and payment_method = 'credit_card'), 0)::numeric(12, 2) as credit_total,
  coalesce(sum(amount) filter (where movement_type = 'sale' and payment_method = 'other'), 0)::numeric(12, 2) as other_total,
  coalesce(sum(amount) filter (where movement_type = 'sale'), 0)::numeric(12, 2) as total_sold,
  coalesce(sum(amount) filter (where movement_type = 'supply'), 0)::numeric(12, 2) as supply_total,
  coalesce(sum(amount) filter (where movement_type = 'withdrawal'), 0)::numeric(12, 2) as withdrawal_total
from public.cash_movements
group by cash_session_id, company_id;

revoke all on public.cash_session_totals from public, anon, authenticated;
grant select on public.cash_session_totals to authenticated;
grant all on public.cash_session_totals to service_role;

-- Módulo opcional DELIVERY — Fase 1, BLOCO ESTRUTURAL (M2/M3/M4). Só a base; nenhum pedido de delivery
-- existe ainda (a RPC, delivery_orders, endereços, zonas, taxa e telas vêm em blocos seguintes).
-- Não altera nenhuma migration já aplicada: ALTER TABLE, CREATE OR REPLACE (mesma assinatura e ACL) e dados.
--
--   1. modules: código 'delivery', is_active = false, preço 0 (decisão comercial pendente). Módulo inativo
--      não entra em company_entitlement (trial nem "unmanaged"): NADA muda para os módulos atuais.
--   2. service_sessions.kind ('point' | 'delivery'): sessões existentes viram 'point' (DEFAULT no ADD COLUMN);
--      service_point_id passa a aceitar NULL, com CHECK forte kind <-> ponto. O índice único
--      "um atendimento aberto por ponto" continua valendo (NULLs não colidem: vários deliveries abertos).
--      kind não muda depois de criado.
--   3. service_orders.origin aceita 'delivery' (attendant/cashier/whatsapp preservados), e um trigger
--      recusa origin 'delivery' em atendimento que não seja kind 'delivery'.
--   4. can_manage_company_user(): owner e admin passam a gerenciar 'courier' (a RPC e a Edge que usam a
--      matriz não mudam). courier não gerencia ninguém; ninguém escala para owner/admin.
--
-- As funções que fazem JOIN com service_points (fila de produção, histórico, relatórios, impressão, push,
-- rótulos de caixa/estorno) ficam na migration seguinte (20261014030000).

-- ---------------------------------------------------------------------------
-- 1) Módulo (inativo, sem preço)
-- ---------------------------------------------------------------------------
insert into public.modules (code, name, description, monthly_price_cents, is_active) values
  ('delivery', 'Delivery',
   'Pedidos para entrega e retirada integrados a produção, estoque, caixa e impressão.', 0, false)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- 2) service_sessions: kind + ponto opcional
-- ---------------------------------------------------------------------------
alter table public.service_sessions
  add column kind text not null default 'point'
    constraint service_sessions_kind_check check (kind in ('point', 'delivery'));

alter table public.service_sessions
  alter column service_point_id drop not null;

alter table public.service_sessions
  add constraint service_sessions_kind_point_check check (
    (kind = 'point' and service_point_id is not null)
    or (kind = 'delivery' and service_point_id is null)
  );

comment on column public.service_sessions.kind is
  'point = atendimento de comanda/mesa (service_point_id obrigatório); delivery = atendimento de entrega/retirada (sem ponto). Imutável.';

-- Mesma guarda de 20261005010000 (empresa, abertura e cliente imutáveis) + kind imutável.
create or replace function public.guard_service_session_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is distinct from old.company_id
     or new.opened_by is distinct from old.opened_by
     or new.opened_at is distinct from old.opened_at then
    raise exception 'Empresa, funcionário e horário de abertura de um atendimento não podem ser alterados.'
      using errcode = 'PT409';
  end if;
  if new.customer_id is distinct from old.customer_id then
    raise exception 'O cliente de um atendimento não pode ser alterado.' using errcode = 'PT409';
  end if;
  if new.kind is distinct from old.kind then
    raise exception 'O tipo de um atendimento não pode ser alterado.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) service_orders.origin aceita 'delivery'
-- ---------------------------------------------------------------------------
alter table public.service_orders
  drop constraint service_orders_origin_check;
alter table public.service_orders
  add constraint service_orders_origin_check check (origin in ('attendant', 'cashier', 'whatsapp', 'delivery'));

comment on column public.service_orders.origin is
  'Quem originou o pedido: attendant, cashier (também owner/admin), whatsapp (futuro) ou delivery (pedido do módulo Delivery; só em atendimento kind=delivery).';

create function public.guard_service_order_origin_kind()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.origin = 'delivery' and not exists (
    select 1 from public.service_sessions ss
    where ss.company_id = new.company_id and ss.id = new.service_session_id and ss.kind = 'delivery'
  ) then
    raise exception 'Pedido de delivery só pode ser lançado em atendimento de delivery.'
      using errcode = 'PT409';
  end if;
  return new;
end;
$$;

create trigger service_orders_origin_kind
  before insert on public.service_orders
  for each row execute function public.guard_service_order_origin_kind();

revoke execute on function public.guard_service_order_origin_kind() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4) Matriz de gestão: owner e admin também gerenciam 'courier'
-- ---------------------------------------------------------------------------
-- Mesma assinatura, corpo e ACL de 20260930050000; só entra 'courier' nas duas listas.
create or replace function public.can_manage_company_user(
  p_company_id uuid,
  p_target_user_id uuid default null,
  p_new_role public.company_role default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_role public.company_role;
  v_manageable public.company_role[];
  v_current_role public.company_role;
begin
  if p_target_user_id is null and p_new_role is null then
    return false;
  end if;

  v_actor_role := public.user_role_in_company(p_company_id);
  if v_actor_role is null then
    return false;
  end if;

  if v_actor_role = 'owner' then
    v_manageable := array['admin', 'cashier', 'attendant', 'production', 'courier']::public.company_role[];
  elsif v_actor_role = 'admin' then
    v_manageable := array['cashier', 'attendant', 'production', 'courier']::public.company_role[];
  else
    return false;
  end if;

  if p_target_user_id is not null then
    if p_target_user_id = v_actor then
      return false;
    end if;

    select cu.role into v_current_role
    from public.company_users cu
    where cu.company_id = p_company_id
      and cu.user_id = p_target_user_id;

    if not coalesce(v_current_role = any(v_manageable), false) then
      return false;
    end if;
  end if;

  if p_new_role is not null and not (p_new_role = any(v_manageable)) then
    return false;
  end if;

  return true;
end;
$$;

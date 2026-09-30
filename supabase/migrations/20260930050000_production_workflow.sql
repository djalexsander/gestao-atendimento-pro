-- Produção / Cozinha (KDS): status de PRODUÇÃO por item do pedido, papel 'production' na matriz de
-- gestão, fila de produção e Realtime dos itens.
--
-- Fora daqui, de propósito: impressão/impressora por setor, cancelamento e estorno, prioridade
-- manual, estoque/ficha técnica, status "servido". Não altera nenhuma migration aplicada: soma
-- colunas a service_order_items (ALTER TABLE) e dois CREATE OR REPLACE que preservam assinatura e
-- ACL (can_manage_company_user, company_user_has_activity). O valor 'production' do enum foi criado
-- na migration anterior (20260930040000).
--
-- 1) service_order_items ganha o estado de produção POR ITEM (um pedido pode ter o item do Bar
--    pronto e o da Cozinha ainda em preparo): production_status pending|preparing|ready, carimbos
--    de início/pronto e quem atualizou. Itens já existentes viram 'pending' (DEFAULT) sem tocar em
--    nome, preço, setor nem observação (snapshots imutáveis: ver trigger abaixo).
-- 2) Trigger de guarda: só as colunas de produção mudam, e o status só avança
--    pending -> preparing -> ready (ou pending -> ready). Nada volta. Vale até para escrita direta.
-- 3) update_production_item_status(): a ÚNICA escrita de status (o cliente segue sem UPDATE).
--    Quem pode: owner, admin, production (ativos). cashier/attendant: PT403.
-- 4) production_queue(): a fila de produção numa chamada (itens + pedido + comanda/mesa + quem
--    enviou), filtrável por setor; itens prontos só dos últimos N minutos.
-- 5) can_manage_company_user(): owner e admin passam a poder cadastrar/gerenciar 'production'.
-- 6) company_user_has_activity(): quem já atualizou produção não é excluído (só desativado).
-- 7) service_order_items entra na publication supabase_realtime (item novo e mudança de status).

-- ---------------------------------------------------------------------------
-- 1) Colunas de produção
-- ---------------------------------------------------------------------------
alter table public.service_order_items
  add column production_status text not null default 'pending'
    constraint service_order_items_production_status_check check (production_status in ('pending', 'preparing', 'ready')),
  add column production_started_at timestamptz,
  add column production_ready_at timestamptz,
  -- RESTRICT: o histórico não some com a exclusão do usuário do Auth.
  add column production_updated_by uuid references auth.users(id) on delete restrict;

alter table public.service_order_items
  add constraint service_order_items_production_consistency check (
    (production_status = 'pending'
       and production_started_at is null and production_ready_at is null and production_updated_by is null)
    or (production_status = 'preparing'
       and production_started_at is not null and production_ready_at is null and production_updated_by is not null)
    or (production_status = 'ready'
       and production_ready_at is not null and production_updated_by is not null)
  );

create index service_order_items_production_updated_by_idx
  on public.service_order_items (production_updated_by) where production_updated_by is not null;
-- fila: itens por empresa e status
create index service_order_items_queue_idx
  on public.service_order_items (company_id, production_status, production_sector_id);

comment on column public.service_order_items.production_status is
  'Estado de produção DO ITEM: pending -> preparing -> ready (ou pending -> ready). Só update_production_item_status() altera; nunca volta.';

-- ---------------------------------------------------------------------------
-- 2) Guarda: snapshots imutáveis e transições válidas
-- ---------------------------------------------------------------------------
create function public.guard_service_order_item_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.id is distinct from old.id
     or new.company_id is distinct from old.company_id
     or new.order_id is distinct from old.order_id
     or new.product_id is distinct from old.product_id
     or new.product_name_snapshot is distinct from old.product_name_snapshot
     or new.quantity is distinct from old.quantity
     or new.unit_price is distinct from old.unit_price
     or new.production_sector_id is distinct from old.production_sector_id
     or new.notes is distinct from old.notes
     or new.created_at is distinct from old.created_at then
    raise exception 'Os dados de um item de pedido não podem ser alterados.' using errcode = 'PT409';
  end if;

  if new.production_status is distinct from old.production_status
     and not (
       (old.production_status = 'pending' and new.production_status in ('preparing', 'ready'))
       or (old.production_status = 'preparing' and new.production_status = 'ready')
     ) then
    raise exception 'Este item não pode voltar para uma etapa anterior da produção.' using errcode = 'PT409';
  end if;

  return new;
end;
$$;

create trigger service_order_items_guard_change
  before update on public.service_order_items
  for each row execute function public.guard_service_order_item_change();

revoke execute on function public.guard_service_order_item_change() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) RPC: atualizar o status de produção de um item
-- ---------------------------------------------------------------------------
-- p_status: 'preparing' ou 'ready' ('pending' é o estado inicial, nunca um destino).
-- Idempotente: pedir o status que o item já tem devolve o item sem alterar nada (clique duplo /
-- dois aparelhos). Pedir uma etapa anterior (ready -> preparing) é recusado (PT409).
-- Erros: PT401 sem sessão, PT404 item inexistente/de outra empresa/sem vínculo ativo, PT403 papel
-- sem acesso à produção (cashier/attendant), PT400 status inválido, PT409 pedido cancelado ou
-- retrocesso. Pedido de atendimento já fechado ainda pode ser concluído (a comida pode estar em
-- preparo); só pedido cancelado é recusado.
create function public.update_production_item_status(p_item_id uuid, p_status text)
returns public.service_order_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.service_order_items;
  v_role public.company_role;
  v_order_status text;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_item from public.service_order_items where id = p_item_id for update;
  if not found then
    raise exception 'Item não encontrado.' using errcode = 'PT404';
  end if;

  v_role := public.user_role_in_company(v_item.company_id);
  if v_role is null then
    raise exception 'Item não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'production') then
    raise exception 'Você não tem permissão para atualizar a produção.' using errcode = 'PT403';
  end if;

  if p_status is null or p_status not in ('preparing', 'ready') then
    raise exception 'Status de produção inválido.' using errcode = 'PT400';
  end if;

  select status into v_order_status
  from public.service_orders
  where company_id = v_item.company_id and id = v_item.order_id;
  if v_order_status is distinct from 'submitted' then
    raise exception 'Este pedido foi cancelado.' using errcode = 'PT409';
  end if;

  if v_item.production_status = p_status then
    return v_item; -- já está assim (outro aparelho chegou antes)
  end if;
  if v_item.production_status = 'ready' then
    raise exception 'Este item já está pronto.' using errcode = 'PT409';
  end if;

  update public.service_order_items
     set production_status = p_status,
         production_started_at = case when p_status = 'preparing' then now() else production_started_at end,
         production_ready_at = case when p_status = 'ready' then now() else null end,
         production_updated_by = auth.uid()
   where id = v_item.id
  returning * into v_item;

  return v_item;
end;
$$;

comment on function public.update_production_item_status(uuid, text) is
  'Único caminho de escrita do status de produção: pending -> preparing -> ready (ou pending -> ready), nunca para trás. owner/admin/production. Idempotente.';

revoke execute on function public.update_production_item_status(uuid, text) from public, anon;
grant execute on function public.update_production_item_status(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) RPC: fila de produção (uma chamada)
-- ---------------------------------------------------------------------------
-- Itens de pedidos 'submitted' da empresa: pendentes e em preparo (todos) + prontos dos últimos
-- p_ready_minutes (0..1440, padrão 60). p_sector_id filtra pelo SETOR DO ITEM (snapshot
-- production_sector_id; nunca a categoria). NULL = todos os setores (inclui itens sem setor).
-- Mais antigos primeiro. Máximo 500 itens.
create function public.production_queue(
  p_company_id uuid,
  p_sector_id uuid default null,
  p_ready_minutes integer default 60
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_minutes integer := least(greatest(coalesce(p_ready_minutes, 60), 0), 1440);
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'production') then
    raise exception 'Você não tem permissão para ver a produção.' using errcode = 'PT403';
  end if;

  select coalesce(jsonb_agg(q.item order by q.submitted_at, q.item_created_at), '[]'::jsonb)
    into v_result
  from (
    select
      o.submitted_at,
      i.created_at as item_created_at,
      jsonb_build_object(
        'id', i.id,
        'order_id', i.order_id,
        'quantity', i.quantity,
        'name', i.product_name_snapshot,
        'notes', i.notes,
        'sector_id', i.production_sector_id,
        'sector_name', s.name,
        'status', i.production_status,
        'started_at', i.production_started_at,
        'ready_at', i.production_ready_at,
        'submitted_at', o.submitted_at,
        'point_type', sp.type,
        'point_code', sp.code,
        'point_name', sp.display_name,
        'customer_name', ss.customer_name,
        'sent_by_name', pr.full_name
      ) as item
    from public.service_order_items i
    join public.service_orders o on o.company_id = i.company_id and o.id = i.order_id
    join public.service_sessions ss on ss.company_id = o.company_id and ss.id = o.service_session_id
    join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
    left join public.production_sectors s on s.company_id = i.company_id and s.id = i.production_sector_id
    left join public.profiles pr on pr.user_id = o.created_by
    where i.company_id = p_company_id
      and o.status = 'submitted'
      and (p_sector_id is null or i.production_sector_id = p_sector_id)
      and (
        i.production_status <> 'ready'
        or i.production_ready_at >= now() - make_interval(mins => v_minutes)
      )
    order by o.submitted_at, i.created_at
    limit 500
  ) q;

  return v_result;
end;
$$;

comment on function public.production_queue(uuid, uuid, integer) is
  'Fila de produção da empresa (owner/admin/production): itens pendentes/em preparo + prontos recentes, filtro pelo setor do item (snapshot). Somente leitura.';

revoke execute on function public.production_queue(uuid, uuid, integer) from public, anon;
grant execute on function public.production_queue(uuid, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) Matriz de gestão: owner e admin também gerenciam 'production'
-- ---------------------------------------------------------------------------
-- Mesma assinatura, corpo e ACL da 20260925070000; só entra 'production' nas duas listas.
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
    v_manageable := array['admin', 'cashier', 'attendant', 'production']::public.company_role[];
  elsif v_actor_role = 'admin' then
    v_manageable := array['cashier', 'attendant', 'production']::public.company_role[];
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

revoke execute on function public.can_manage_company_user(uuid, uuid, public.company_role)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6) Quem já atualizou produção não é excluído (só desativado)
-- ---------------------------------------------------------------------------
create or replace function public.company_user_has_activity(p_company_id uuid, p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.service_sessions ss
    where ss.company_id = p_company_id and (ss.opened_by = p_user_id or ss.closed_by = p_user_id)
  ) then
    return true;
  end if;

  if exists (
    select 1 from public.service_orders so
    where so.company_id = p_company_id and so.created_by = p_user_id
  ) then
    return true;
  end if;

  if exists (
    select 1 from public.cash_sessions cs
    where cs.company_id = p_company_id and (cs.opened_by = p_user_id or cs.closed_by = p_user_id)
  ) then
    return true;
  end if;

  if exists (
    select 1 from public.service_payments sp
    where sp.company_id = p_company_id and sp.created_by = p_user_id
  ) then
    return true;
  end if;

  if exists (
    select 1 from public.cash_movements cm
    where cm.company_id = p_company_id and cm.created_by = p_user_id
  ) then
    return true;
  end if;

  if exists (
    select 1 from public.service_order_items soi
    where soi.company_id = p_company_id and soi.production_updated_by = p_user_id
  ) then
    return true;
  end if;

  return false;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) Realtime: itens (novo item = INSERT; mudança de status = UPDATE)
-- ---------------------------------------------------------------------------
-- Só service_order_items (um pedido cria todos os itens na mesma transação). O Realtime respeita a
-- RLS service_order_items_select. Idempotente.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'service_order_items'
  ) then
    alter publication supabase_realtime add table public.service_order_items;
  end if;
end
$$;

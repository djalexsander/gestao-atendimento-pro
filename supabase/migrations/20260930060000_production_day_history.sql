-- Produção por DIA OPERACIONAL + histórico por data.
--
-- Nada é apagado nem arquivado: service_order_items é histórico comercial (quantidade, preço,
-- setor, observação, auditoria da produção). A solução é FILTRAR e PAGINAR na consulta.
--
-- DIA OPERACIONAL = dia civil em America/Sao_Paulo, calculado NO SERVIDOR com now() (mesma
-- convenção do faturamento: 20260924080000/090000). Não há timezone por empresa hoje; quando
-- houver, é aqui (uma constante em cada função) que passa a valer. O navegador nunca decide o dia.
--
-- 1) production_queue passa a ser só a OPERAÇÃO ATUAL:
--      * pendentes e em preparo: TODOS, de qualquer dia (não some produção que ficou pendente);
--        cada item traz submitted_date (dia do pedido em São Paulo) e a resposta traz `today`,
--        para a tela destacar "pedido de ontem";
--      * prontos: só os concluídos HOJE (production_ready_at >= início do dia), os p_ready_limit
--        mais recentes (padrão 15; "Mostrar mais" chama de novo com limite maior), e
--        ready_total = quantos prontos hoje existem (o contador mostra o total do dia).
--    A virada de dia é natural: à 00:00 os prontos de "hoje" viram 0, sem job.
--    O 3º parâmetro deixa de ser "minutos" e vira o limite de prontos: como o nome muda (o
--    PostgreSQL não renomeia parâmetro em CREATE OR REPLACE), a função antiga é removida e
--    recriada. A resposta agora é um objeto {items, ready_total, today} (ainda não há frontend
--    publicado que use a forma anterior).
-- 2) production_history(empresa, data, setor): itens CONCLUÍDOS naquele dia, mais recentes
--    primeiro (máx. 500), com resumo (itens, pedidos, tempo médio de produção, por setor).
--    Tempo de produção = pronto - horário do pedido. Uma data por consulta: nunca varre meses.
-- 3) Índice parcial (empresa, production_ready_at) dos itens prontos: serve "prontos de hoje" e
--    "histórico da data" sem varrer a tabela; pendentes/em preparo usam service_order_items_queue_idx.
--
-- Permissões iguais às da 20260930050000: owner, admin, production; SECURITY DEFINER; anon sem
-- execução. Somente leitura.

create index service_order_items_ready_at_idx
  on public.service_order_items (company_id, production_ready_at)
  where production_status = 'ready';

drop function public.production_queue(uuid, uuid, integer);

create function public.production_queue(
  p_company_id uuid,
  p_sector_id uuid default null,
  p_ready_limit integer default 15
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_limit integer := least(greatest(coalesce(p_ready_limit, 15), 0), 500);
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_start timestamptz := (v_today::timestamp) at time zone 'America/Sao_Paulo';
  v_active jsonb;
  v_ready jsonb;
  v_ready_total integer;
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

  -- Pendentes e em preparo: todos (de qualquer dia), mais antigos primeiro.
  select coalesce(jsonb_agg(q.item order by q.submitted_at, q.item_created_at), '[]'::jsonb)
    into v_active
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
        'submitted_date', (o.submitted_at at time zone 'America/Sao_Paulo')::date,
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
      and i.production_status <> 'ready'
      and (p_sector_id is null or i.production_sector_id = p_sector_id)
    order by o.submitted_at, i.created_at
    limit 500
  ) q;

  -- Prontos de HOJE: total do dia + os v_limit mais recentes.
  select count(*)::integer into v_ready_total
  from public.service_order_items i
  join public.service_orders o on o.company_id = i.company_id and o.id = i.order_id
  where i.company_id = p_company_id
    and o.status = 'submitted'
    and i.production_status = 'ready'
    and i.production_ready_at >= v_start
    and (p_sector_id is null or i.production_sector_id = p_sector_id);

  select coalesce(jsonb_agg(q.item order by q.ready_at desc), '[]'::jsonb)
    into v_ready
  from (
    select
      i.production_ready_at as ready_at,
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
        'submitted_date', (o.submitted_at at time zone 'America/Sao_Paulo')::date,
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
      and i.production_status = 'ready'
      and i.production_ready_at >= v_start
      and (p_sector_id is null or i.production_sector_id = p_sector_id)
    order by i.production_ready_at desc
    limit v_limit
  ) q;

  return jsonb_build_object(
    'today', v_today,
    'ready_total', v_ready_total,
    'items', v_active || v_ready
  );
end;
$$;

comment on function public.production_queue(uuid, uuid, integer) is
  'Fila OPERACIONAL da produção (owner/admin/production): todos os pendentes/em preparo + prontos de HOJE (dia em America/Sao_Paulo; os p_ready_limit mais recentes e ready_total do dia). Filtro pelo setor do item. Somente leitura.';

revoke execute on function public.production_queue(uuid, uuid, integer) from public, anon;
grant execute on function public.production_queue(uuid, uuid, integer) to authenticated;

create function public.production_history(
  p_company_id uuid,
  p_date date default null,
  p_sector_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_day date := coalesce(p_date, (now() at time zone 'America/Sao_Paulo')::date);
  v_start timestamptz;
  v_end timestamptz;
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

  if v_day < date '2000-01-01' or v_day > date '2100-01-01' then
    raise exception 'Data inválida.' using errcode = 'PT400';
  end if;

  v_start := (v_day::timestamp) at time zone 'America/Sao_Paulo';
  v_end := ((v_day + 1)::timestamp) at time zone 'America/Sao_Paulo';

  with base as (
    select
      i.id,
      i.order_id,
      i.quantity,
      i.product_name_snapshot as name,
      i.notes,
      i.production_sector_id as sector_id,
      s.name as sector_name,
      i.production_started_at as started_at,
      i.production_ready_at as ready_at,
      o.submitted_at,
      sp.type as point_type,
      sp.code as point_code,
      sp.display_name as point_name,
      ss.customer_name,
      pr.full_name as sent_by_name,
      round(extract(epoch from (i.production_ready_at - o.submitted_at)) / 60)::integer as minutes
    from public.service_order_items i
    join public.service_orders o on o.company_id = i.company_id and o.id = i.order_id
    join public.service_sessions ss on ss.company_id = o.company_id and ss.id = o.service_session_id
    join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
    left join public.production_sectors s on s.company_id = i.company_id and s.id = i.production_sector_id
    left join public.profiles pr on pr.user_id = o.created_by
    where i.company_id = p_company_id
      and o.status = 'submitted'
      and i.production_status = 'ready'
      and i.production_ready_at >= v_start
      and i.production_ready_at < v_end
      and (p_sector_id is null or i.production_sector_id = p_sector_id)
  )
  select jsonb_build_object(
    'date', v_day,
    'items', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.ready_at desc), '[]'::jsonb)
      from (select * from base order by ready_at desc limit 500) x
    ),
    'summary', jsonb_build_object(
      'items', (select count(*) from base),
      'orders', (select count(distinct order_id) from base),
      'avg_minutes', (select round(avg(minutes)) from base),
      'by_sector', (
        select coalesce(jsonb_agg(b order by b.items desc, b.name), '[]'::jsonb)
        from (
          select sector_id, coalesce(sector_name, 'Sem setor') as name, count(*)::integer as items
          from base
          group by sector_id, sector_name
        ) b
      )
    )
  ) into v_result;

  return v_result;
end;
$$;

comment on function public.production_history(uuid, date, uuid) is
  'Histórico da produção de UM dia (America/Sao_Paulo): itens concluídos naquela data (máx. 500, mais recentes primeiro) + resumo (itens, pedidos, tempo médio pedido->pronto, por setor). owner/admin/production. Somente leitura; nunca varre meses.';

revoke execute on function public.production_history(uuid, date, uuid) from public, anon;
grant execute on function public.production_history(uuid, date, uuid) to authenticated;

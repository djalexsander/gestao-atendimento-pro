-- Impressão — ETAPA 1: fundação (impressoras lógicas, roteamento por setor, fila, cancelamento,
-- reimpressão, teste). Só prepara o terreno para o Agente de Impressão do Windows (próxima etapa).
--
-- Conceitos:
--   * IMPRESSORA LÓGICA (print_devices): "Impressora Cozinha", "Impressora Bar". O nome pertence ao
--     sistema. A impressora FÍSICA do Windows (windows_printer_name) será escolhida/informada pelo
--     Agente; enquanto ele não existir a coluna fica NULL e nenhuma RPC daqui a escreve.
--   * ROTAS (print_device_routes): muitos-para-muitos. Uma impressora recebe um ou vários setores
--     (production_sector) e/ou o pedido completo (full_order) — rotas AUTOMÁTICAS de produção — e/ou
--     os DOCUMENTOS MANUAIS customer_bill (conta/pré-conta), payment_receipt (comprovante) e
--     cash_closing (fechamento de caixa). Vários dispositivos podem atender o mesmo destino.
--   * Documentos manuais NUNCA nascem sozinhos (fechar conta/pagar/fechar caixa não imprimem): só
--     quando o usuário pede (botão ou F8) pelas RPCs enqueue_customer_bill / enqueue_payment_receipt /
--     enqueue_cash_closing, que montam o snapshot COMPLETO no servidor.
--   * FILA (print_jobs) + ITENS (print_job_items): um job por pedido+impressora, com SNAPSHOT
--     completo em payload (dados, nunca bytes ESC/POS; a formatação é do Agente). print_job_items
--     liga o job aos itens exatos que ele levou: é daí que o cancelamento descobre o DESTINO ORIGINAL
--     (não a configuração atual) e que a reimpressão copia os itens.
--
-- Garantias:
--   * Impressão é COMPLEMENTAR: submit_service_order / cancel_service_order_item nunca falham por causa
--     dela (empresa sem impressora = nenhum job; erro interno ao enfileirar vira WARNING E uma linha em
--     print_enqueue_failures, visível a owner/admin; o pedido segue).
--   * Idempotência: job ORIGINAL único por (impressora, pedido) e por (impressora, cancelamento);
--     reimpressão explícita (reprint_of_id) é a exceção.
--   * Histórico auditável: print_jobs/print_job_items sem escrita pelo cliente; o payload e a
--     identidade do job são imutáveis (trigger); só status/tentativas/erro/horários andam (Agente).
--   * CADASTRADA != PRONTA: só recebe job quem está PRONTA (is_ready = ativa + vinculada a um Agente e a uma
--     impressora física do Windows). Impressora sem vínculo é totalmente configurável (nome, papel, setores,
--     documentos), mas NÃO gera job (nem pedido, cancelamento, documento, teste ou reimpressão): assim a fila
--     não acumula pedidos obsoletos antes do Agente existir. Quando o vínculo acontecer, só valem operações
--     NOVAS; nada é retroativo. Isso NÃO é falha (print_enqueue_failures é só para erro real).
--   * Remover impressora = arquivar (is_active=false, archived_at=now()); nunca DELETE.
--   * Realtime: nenhuma tabela entra na publication nesta etapa.
--
-- Quem pode o quê: configurar, remover, testar, reimprimir e ver a fila = SOMENTE owner/admin. Os demais
-- papéis apenas GERAM jobs pelas operações que já podem fazer. O cliente só tem SELECT (owner/admin).

-- ---------------------------------------------------------------------------
-- 1) Impressoras lógicas
-- ---------------------------------------------------------------------------
create table public.print_devices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null
    constraint print_devices_name_length check (char_length(name) between 1 and 80),
  paper_width integer not null
    constraint print_devices_paper_width_check check (paper_width in (58, 80)),
  -- Preenchido pelo Agente de Impressão (etapa futura). NULL = ainda sem impressora física.
  windows_printer_name text
    constraint print_devices_windows_name_length check (windows_printer_name is null or char_length(windows_printer_name) between 1 and 200),
  -- Vínculo físico (preenchido pelo Agente na etapa futura; nenhuma RPC do cliente escreve aqui). agent_id
  -- será a chave do computador/Agente quando essa tabela existir; por ora só o contrato (sem FK).
  agent_id uuid,
  bound_at timestamptz,
  is_active boolean not null default true,
  archived_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- PRONTA = habilitada, não arquivada e fisicamente vinculada (Agente + impressora do Windows).
  is_ready boolean generated always as (
    is_active and archived_at is null and agent_id is not null and windows_printer_name is not null
  ) stored,
  constraint print_devices_binding_consistency check (
    (agent_id is null and windows_printer_name is null and bound_at is null)
    or (agent_id is not null and windows_printer_name is not null and bound_at is not null)
  ),
  constraint print_devices_archive_consistency check (
    (is_active and archived_at is null) or (not is_active and archived_at is not null)
  ),
  constraint print_devices_company_id_id_key unique (company_id, id)
);

-- Nome único (sem diferenciar maiúsculas) entre as impressoras NÃO arquivadas da empresa.
create unique index print_devices_active_name_key
  on public.print_devices (company_id, lower(name)) where is_active;
create index print_devices_company_active_idx
  on public.print_devices (company_id) where is_active;
create index print_devices_company_ready_idx
  on public.print_devices (company_id) where is_ready;
create index print_devices_created_by_idx on public.print_devices (created_by);

create trigger print_devices_set_updated_at
  before update on public.print_devices
  for each row execute function public.set_updated_at();

comment on table public.print_devices is
  'Impressoras LÓGICAS do estabelecimento (nome amigável do sistema). windows_printer_name + agent_id + bound_at (vínculo físico) são preenchidos pelo Agente Windows (etapa futura); is_ready (gerada) = ativa + vinculada: só impressora PRONTA recebe jobs. Remover = arquivar (is_active=false + archived_at); nunca apagar.';

create function public.guard_print_device_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is distinct from old.company_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Os dados de origem de uma impressora não podem ser alterados.' using errcode = 'PT409';
  end if;
  if not old.is_active and new.is_active then
    raise exception 'Uma impressora removida não pode ser reativada.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

create trigger print_devices_guard_change
  before update on public.print_devices
  for each row execute function public.guard_print_device_change();

revoke execute on function public.guard_print_device_change() from public, anon, authenticated;

alter table public.print_devices enable row level security;
create policy print_devices_select on public.print_devices
  for select to authenticated
  using (public.user_role_in_company(company_id) in ('owner', 'admin'));
revoke all on public.print_devices from anon, authenticated;
grant select on public.print_devices to authenticated;
grant all on public.print_devices to service_role;

-- ---------------------------------------------------------------------------
-- 2) Rotas (impressora x setor / pedido completo)
-- ---------------------------------------------------------------------------
create table public.print_device_routes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  print_device_id uuid not null,
  route_type text not null
    constraint print_device_routes_type_check check (
      route_type in ('production_sector', 'full_order', 'customer_bill', 'payment_receipt', 'cash_closing')
    ),
  production_sector_id uuid,
  created_at timestamptz not null default now(),
  constraint print_device_routes_shape_check check (
    (route_type = 'production_sector' and production_sector_id is not null)
    or (route_type <> 'production_sector' and production_sector_id is null)
  ),
  constraint print_device_routes_device_fkey
    foreign key (company_id, print_device_id) references public.print_devices (company_id, id),
  constraint print_device_routes_sector_fkey
    foreign key (company_id, production_sector_id) references public.production_sectors (company_id, id)
);

create unique index print_device_routes_sector_key
  on public.print_device_routes (print_device_id, production_sector_id) where route_type = 'production_sector';
-- full_order e cada documento: no máximo uma linha por impressora.
create unique index print_device_routes_flag_key
  on public.print_device_routes (print_device_id, route_type) where route_type <> 'production_sector';
create index print_device_routes_doc_idx
  on public.print_device_routes (company_id, route_type) where route_type <> 'production_sector';
create index print_device_routes_sector_idx
  on public.print_device_routes (company_id, production_sector_id) where route_type = 'production_sector';

comment on table public.print_device_routes is
  'Destinos de cada impressora. AUTOMÁTICOS: production_sector (setor_id obrigatório) e full_order. MANUAIS (sector_id NULL): customer_bill, payment_receipt, cash_closing — só geram job quando o usuário pede. No máximo uma linha por impressora para cada flag. Configuração ATUAL: o cancelamento NÃO a usa (usa print_job_items dos jobs originais).';

alter table public.print_device_routes enable row level security;
create policy print_device_routes_select on public.print_device_routes
  for select to authenticated
  using (public.user_role_in_company(company_id) in ('owner', 'admin'));
revoke all on public.print_device_routes from anon, authenticated;
grant select on public.print_device_routes to authenticated;
grant all on public.print_device_routes to service_role;

-- ---------------------------------------------------------------------------
-- 3) Fila de impressão
-- ---------------------------------------------------------------------------
create table public.print_jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  print_device_id uuid not null,
  job_type text not null
    constraint print_jobs_type_check check (job_type in (
      'production_order', 'production_cancellation', 'test', 'customer_bill', 'payment_receipt', 'cash_closing'
    )),
  status text not null default 'pending'
    constraint print_jobs_status_check check (status in ('pending', 'claimed', 'printed', 'error', 'cancelled')),
  service_order_id uuid,
  cancellation_id uuid,
  -- Documentos manuais: conta/comprovante apontam a conta; fechamento aponta o caixa.
  service_session_id uuid,
  cash_session_id uuid,
  -- Snapshot pronto para imprimir (dados, não bytes de impressora). Imutável.
  payload jsonb not null,
  reprint_of_id uuid,
  attempts integer not null default 0
    constraint print_jobs_attempts_check check (attempts >= 0),
  error_message text
    constraint print_jobs_error_length check (error_message is null or char_length(error_message) <= 500),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  printed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint print_jobs_shape_check check (
    (job_type = 'production_order' and service_order_id is not null and cancellation_id is null
       and service_session_id is null and cash_session_id is null)
    or (job_type = 'production_cancellation' and service_order_id is not null and cancellation_id is not null
       and service_session_id is null and cash_session_id is null)
    or (job_type = 'test' and service_order_id is null and cancellation_id is null
       and service_session_id is null and cash_session_id is null)
    or (job_type in ('customer_bill', 'payment_receipt') and service_session_id is not null
       and service_order_id is null and cancellation_id is null and cash_session_id is null)
    or (job_type = 'cash_closing' and cash_session_id is not null
       and service_order_id is null and cancellation_id is null and service_session_id is null)
  ),
  constraint print_jobs_session_fkey
    foreign key (company_id, service_session_id) references public.service_sessions (company_id, id),
  constraint print_jobs_cash_session_fkey
    foreign key (company_id, cash_session_id) references public.cash_sessions (company_id, id),
  constraint print_jobs_device_fkey
    foreign key (company_id, print_device_id) references public.print_devices (company_id, id),
  constraint print_jobs_order_fkey
    foreign key (company_id, service_order_id) references public.service_orders (company_id, id),
  constraint print_jobs_cancellation_fkey
    foreign key (cancellation_id) references public.service_order_item_cancellations (id),
  constraint print_jobs_reprint_fkey
    foreign key (company_id, reprint_of_id) references public.print_jobs (company_id, id),
  constraint print_jobs_company_id_id_key unique (company_id, id)
);

-- Idempotência dos jobs ORIGINAIS (reimpressão, reprint_of_id preenchido, fica de fora).
create unique index print_jobs_original_order_key
  on public.print_jobs (print_device_id, service_order_id)
  where job_type = 'production_order' and reprint_of_id is null;
create unique index print_jobs_original_cancellation_key
  on public.print_jobs (print_device_id, cancellation_id)
  where job_type = 'production_cancellation' and reprint_of_id is null;

create index print_jobs_company_recent_idx on public.print_jobs (company_id, created_at desc);
create index print_jobs_device_status_idx on public.print_jobs (print_device_id, status, created_at);
create index print_jobs_reprint_idx on public.print_jobs (company_id, reprint_of_id) where reprint_of_id is not null;
create index print_jobs_cancellation_idx on public.print_jobs (cancellation_id) where cancellation_id is not null;
create index print_jobs_created_by_idx on public.print_jobs (created_by);

create trigger print_jobs_set_updated_at
  before update on public.print_jobs
  for each row execute function public.set_updated_at();

comment on table public.print_jobs is
  'Fila de impressão (auditável). payload = snapshot imprimível; nenhum caminho do cliente escreve aqui (só RPCs/helpers DEFINER e, depois, o Agente com service_role). pending sem Agente é esperado. Tipos: production_order, production_cancellation (automáticos), test, customer_bill, payment_receipt, cash_closing (manuais); reimpressão = mesmo tipo + reprint_of_id.';

-- O que existe naquele momento não muda: só a máquina de estados (Agente) anda.
create function public.guard_print_job_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.id is distinct from old.id
     or new.company_id is distinct from old.company_id
     or new.print_device_id is distinct from old.print_device_id
     or new.job_type is distinct from old.job_type
     or new.service_order_id is distinct from old.service_order_id
     or new.cancellation_id is distinct from old.cancellation_id
     or new.service_session_id is distinct from old.service_session_id
     or new.cash_session_id is distinct from old.cash_session_id
     or new.payload is distinct from old.payload
     or new.reprint_of_id is distinct from old.reprint_of_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Um job de impressão não pode ter seu conteúdo alterado.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

create trigger print_jobs_guard_change
  before update on public.print_jobs
  for each row execute function public.guard_print_job_change();

revoke execute on function public.guard_print_job_change() from public, anon, authenticated;

alter table public.print_jobs enable row level security;
create policy print_jobs_select on public.print_jobs
  for select to authenticated
  using (public.user_role_in_company(company_id) in ('owner', 'admin'));
revoke all on public.print_jobs from anon, authenticated;
grant select on public.print_jobs to authenticated;
grant all on public.print_jobs to service_role;

-- ---------------------------------------------------------------------------
-- 4) Itens de cada job
-- ---------------------------------------------------------------------------
create table public.print_job_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  print_job_id uuid not null,
  service_order_item_id uuid not null,
  -- Quantidade impressa neste job (no job de cancelamento: a quantidade cancelada naquele evento).
  quantity integer not null
    constraint print_job_items_quantity_check check (quantity > 0),
  created_at timestamptz not null default now(),
  constraint print_job_items_job_fkey
    foreign key (company_id, print_job_id) references public.print_jobs (company_id, id),
  constraint print_job_items_item_fkey
    foreign key (company_id, service_order_item_id) references public.service_order_items (company_id, id),
  constraint print_job_items_job_item_key unique (print_job_id, service_order_item_id)
);

create index print_job_items_item_idx on public.print_job_items (company_id, service_order_item_id);

comment on table public.print_job_items is
  'Itens exatos de cada job. Dos jobs ORIGINAIS de produção se descobre para qual impressora um item foi (cancelamento); copiados na reimpressão. Sem escrita pelo cliente.';

alter table public.print_job_items enable row level security;
create policy print_job_items_select on public.print_job_items
  for select to authenticated
  using (public.user_role_in_company(company_id) in ('owner', 'admin'));
revoke all on public.print_job_items from anon, authenticated;
grant select on public.print_job_items to authenticated;
grant all on public.print_job_items to service_role;

-- ---------------------------------------------------------------------------
-- 5) Helpers internos (sem EXECUTE para o cliente)
-- ---------------------------------------------------------------------------
create function public.print_actor_name(p_company_id uuid, p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    nullif(btrim(pr.full_name), ''),
    (select cu.login from public.company_users cu where cu.company_id = p_company_id and cu.user_id = p_user_id),
    'Usuário'
  )
  from (select 1) x
  left join public.profiles pr on pr.user_id = p_user_id;
$$;

revoke execute on function public.print_actor_name(uuid, uuid) from public, anon, authenticated;

-- Contexto comum (empresa/impressora) do snapshot.
create function public.print_base_payload(p_kind text, p_device public.print_devices)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'version', 1,
    'kind', p_kind,
    'company', jsonb_build_object('id', c.id, 'name', c.name),
    'printer', jsonb_build_object('id', p_device.id, 'name', p_device.name, 'paper_width', p_device.paper_width)
  )
  from public.companies c
  where c.id = p_device.company_id;
$$;

revoke execute on function public.print_base_payload(text, public.print_devices) from public, anon, authenticated;

-- Pedido -> um job por impressora ativa que tenha itens a imprimir. full_order recebe o pedido
-- completo UMA vez (sem duplicar por também ter setor); production_sector recebe só os itens dos
-- seus setores. Idempotente pelo índice único dos jobs originais.
create function public.enqueue_order_print_jobs(p_order_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.service_orders;
  v_point_type text;
  v_point_code text;
  v_point_name text;
  v_customer text;
  v_operator text;
  v_device public.print_devices;
  v_full boolean;
  v_items jsonb;
  v_job_id uuid;
  v_created integer := 0;
begin
  select * into v_order from public.service_orders where id = p_order_id;
  if not found then
    return 0;
  end if;

  select sp.type, sp.code, sp.display_name, ss.customer_name
    into v_point_type, v_point_code, v_point_name, v_customer
  from public.service_sessions ss
  join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
  where ss.company_id = v_order.company_id and ss.id = v_order.service_session_id;

  v_operator := public.print_actor_name(v_order.company_id, v_order.created_by);

  -- FOR SHARE: arquivar/editar rotas (FOR UPDATE) não corre junto de um pedido sendo roteado.
  for v_device in
    select * from public.print_devices
    where company_id = v_order.company_id and is_ready
    order by id
    for share
  loop
    select exists (
      select 1 from public.print_device_routes r where r.print_device_id = v_device.id and r.route_type = 'full_order'
    ) into v_full;

    select jsonb_agg(
             jsonb_build_object(
               'service_order_item_id', i.id,
               'product_name', i.product_name_snapshot,
               'quantity', i.quantity - i.cancelled_quantity,
               'notes', i.notes,
               'sector', case when s.id is null then null else jsonb_build_object('id', s.id, 'name', s.name) end
             ) order by i.created_at, i.id)
      into v_items
    from public.service_order_items i
    left join public.production_sectors s on s.company_id = i.company_id and s.id = i.production_sector_id
    where i.company_id = v_order.company_id
      and i.order_id = v_order.id
      and i.quantity - i.cancelled_quantity > 0
      and (
        v_full
        or (i.production_sector_id is not null and exists (
          select 1 from public.print_device_routes r
          where r.print_device_id = v_device.id
            and r.route_type = 'production_sector'
            and r.production_sector_id = i.production_sector_id
        ))
      );

    if v_items is null then
      continue;
    end if;

    v_job_id := null;
    insert into public.print_jobs (company_id, print_device_id, job_type, service_order_id, payload, created_by)
    values (
      v_order.company_id, v_device.id, 'production_order', v_order.id,
      public.print_base_payload('production_order', v_device) || jsonb_build_object(
        'order', jsonb_build_object('id', v_order.id, 'origin', v_order.origin),
        'service_point', jsonb_build_object(
          'type', v_point_type, 'code', v_point_code, 'display_name', v_point_name,
          'label', (case when v_point_type = 'table' then 'Mesa ' else 'Comanda ' end) || v_point_code
        ),
        'customer_name', v_customer,
        'operator', jsonb_build_object('name', v_operator),
        'sent_at', v_order.submitted_at,
        'scope', case when v_full then 'full_order' else 'production_sector' end,
        'items', v_items
      ),
      v_order.created_by
    )
    on conflict (print_device_id, service_order_id)
      where job_type = 'production_order' and reprint_of_id is null
      do nothing
    returning id into v_job_id;

    if v_job_id is null then
      continue;
    end if;

    insert into public.print_job_items (company_id, print_job_id, service_order_item_id, quantity)
    select v_order.company_id, v_job_id, (e ->> 'service_order_item_id')::uuid, (e ->> 'quantity')::integer
    from jsonb_array_elements(v_items) e;

    v_created := v_created + 1;
  end loop;

  return v_created;
end;
$$;

revoke execute on function public.enqueue_order_print_jobs(uuid) from public, anon, authenticated;
grant execute on function public.enqueue_order_print_jobs(uuid) to service_role;

-- Cancelamento -> um job por impressora que RECEBEU O ITEM ORIGINALMENTE (print_job_items dos jobs
-- originais de produção), nunca pela configuração de hoje. Impressora arquivada não recebe job novo.
create function public.enqueue_cancellation_print_jobs(p_cancellation_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c public.service_order_item_cancellations;
  v_item public.service_order_items;
  v_order public.service_orders;
  v_point_type text;
  v_point_code text;
  v_point_name text;
  v_customer text;
  v_sector jsonb;
  v_device public.print_devices;
  v_job_id uuid;
  v_by text;
  v_created integer := 0;
begin
  select * into v_c from public.service_order_item_cancellations where id = p_cancellation_id;
  if not found then
    return 0;
  end if;

  select * into v_item from public.service_order_items where company_id = v_c.company_id and id = v_c.service_order_item_id;
  select * into v_order from public.service_orders where company_id = v_item.company_id and id = v_item.order_id;

  select sp.type, sp.code, sp.display_name, ss.customer_name
    into v_point_type, v_point_code, v_point_name, v_customer
  from public.service_sessions ss
  join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
  where ss.company_id = v_order.company_id and ss.id = v_order.service_session_id;

  select jsonb_build_object('id', s.id, 'name', s.name) into v_sector
  from public.production_sectors s
  where s.company_id = v_item.company_id and s.id = v_item.production_sector_id;

  v_by := public.print_actor_name(v_c.company_id, v_c.cancelled_by);

  for v_device in
    select d.* from public.print_devices d
    where d.company_id = v_c.company_id
      and d.is_ready
      and d.id in (
        select pj.print_device_id
        from public.print_job_items pji
        join public.print_jobs pj on pj.company_id = pji.company_id and pj.id = pji.print_job_id
        where pji.company_id = v_c.company_id
          and pji.service_order_item_id = v_c.service_order_item_id
          and pj.job_type = 'production_order'
          and pj.reprint_of_id is null
      )
    order by d.id
    for share
  loop
    v_job_id := null;
    insert into public.print_jobs (company_id, print_device_id, job_type, service_order_id, cancellation_id, payload, created_by)
    values (
      v_c.company_id, v_device.id, 'production_cancellation', v_order.id, v_c.id,
      public.print_base_payload('production_cancellation', v_device) || jsonb_build_object(
        'order', jsonb_build_object('id', v_order.id, 'origin', v_order.origin),
        'service_point', jsonb_build_object(
          'type', v_point_type, 'code', v_point_code, 'display_name', v_point_name,
          'label', (case when v_point_type = 'table' then 'Mesa ' else 'Comanda ' end) || v_point_code
        ),
        'customer_name', v_customer,
        'sent_at', v_order.submitted_at,
        'reason', v_c.reason,
        'cancelled_by', jsonb_build_object('name', v_by),
        'cancelled_at', v_c.created_at,
        'items', jsonb_build_array(jsonb_build_object(
          'service_order_item_id', v_item.id,
          'product_name', v_item.product_name_snapshot,
          'quantity', v_c.quantity,
          'notes', v_item.notes,
          'sector', v_sector
        ))
      ),
      v_c.cancelled_by
    )
    on conflict (print_device_id, cancellation_id)
      where job_type = 'production_cancellation' and reprint_of_id is null
      do nothing
    returning id into v_job_id;

    if v_job_id is null then
      continue;
    end if;

    insert into public.print_job_items (company_id, print_job_id, service_order_item_id, quantity)
    values (v_c.company_id, v_job_id, v_item.id, v_c.quantity);

    v_created := v_created + 1;
  end loop;

  return v_created;
end;
$$;

revoke execute on function public.enqueue_cancellation_print_jobs(uuid) from public, anon, authenticated;
grant execute on function public.enqueue_cancellation_print_jobs(uuid) to service_role;

-- Aplica as rotas de uma impressora (substitui o conjunto). Setores precisam ser da empresa.
create function public.apply_print_device_routes(
  p_device_id uuid, p_full_order boolean, p_sector_ids uuid[], p_documents text[] default '{}'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_ids uuid[];
  v_docs text[];
begin
  select company_id into v_company from public.print_devices where id = p_device_id;
  select coalesce(array_agg(distinct x), '{}') into v_docs from unnest(coalesce(p_documents, '{}')) x where x is not null;
  if exists (select 1 from unnest(v_docs) d where d not in ('customer_bill', 'payment_receipt', 'cash_closing')) then
    raise exception 'Documento inválido.' using errcode = 'PT400';
  end if;
  select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(coalesce(p_sector_ids, '{}')) x where x is not null;

  if (select count(*) from public.production_sectors where company_id = v_company and id = any(v_ids))
     <> coalesce(array_length(v_ids, 1), 0) then
    raise exception 'Setor de produção não encontrado.' using errcode = 'PT404';
  end if;

  delete from public.print_device_routes where print_device_id = p_device_id;

  if coalesce(p_full_order, false) then
    insert into public.print_device_routes (company_id, print_device_id, route_type)
    values (v_company, p_device_id, 'full_order');
  end if;

  insert into public.print_device_routes (company_id, print_device_id, route_type, production_sector_id)
  select v_company, p_device_id, 'production_sector', x from unnest(v_ids) x;

  insert into public.print_device_routes (company_id, print_device_id, route_type)
  select v_company, p_device_id, d from unnest(v_docs) d;
end;
$$;

revoke execute on function public.apply_print_device_routes(uuid, boolean, uuid[], text[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6) RPCs administrativas (owner/admin)
-- ---------------------------------------------------------------------------
create function public.create_print_device(
  p_company_id uuid,
  p_name text,
  p_paper_width integer,
  p_full_order boolean default false,
  p_sector_ids uuid[] default '{}',
  p_documents text[] default '{}'
)
returns public.print_devices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_device public.print_devices;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if public.user_role_in_company(p_company_id) is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if public.user_role_in_company(p_company_id) not in ('owner', 'admin') then
    raise exception 'Você não tem permissão para configurar impressoras.' using errcode = 'PT403';
  end if;
  if char_length(v_name) not between 1 and 80 then
    raise exception 'Informe o nome da impressora (até 80 caracteres).' using errcode = 'PT400';
  end if;
  if p_paper_width is null or p_paper_width not in (58, 80) then
    raise exception 'Largura do papel inválida (58 ou 80 mm).' using errcode = 'PT400';
  end if;

  begin
    insert into public.print_devices (company_id, name, paper_width, created_by)
    values (p_company_id, v_name, p_paper_width, auth.uid())
    returning * into v_device;
  exception when unique_violation then
    raise exception 'Já existe uma impressora com esse nome.' using errcode = 'PT409';
  end;

  perform public.apply_print_device_routes(v_device.id, p_full_order, p_sector_ids, p_documents);
  return v_device;
end;
$$;

create function public.update_print_device(
  p_device_id uuid,
  p_name text,
  p_paper_width integer,
  p_full_order boolean default false,
  p_sector_ids uuid[] default '{}',
  p_documents text[] default '{}'
)
returns public.print_devices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_device public.print_devices;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_device from public.print_devices where id = p_device_id;
  if not found or public.user_role_in_company(v_device.company_id) is null then
    raise exception 'Impressora não encontrada.' using errcode = 'PT404';
  end if;
  if public.user_role_in_company(v_device.company_id) not in ('owner', 'admin') then
    raise exception 'Você não tem permissão para configurar impressoras.' using errcode = 'PT403';
  end if;
  if char_length(v_name) not between 1 and 80 then
    raise exception 'Informe o nome da impressora (até 80 caracteres).' using errcode = 'PT400';
  end if;
  if p_paper_width is null or p_paper_width not in (58, 80) then
    raise exception 'Largura do papel inválida (58 ou 80 mm).' using errcode = 'PT400';
  end if;

  select * into v_device from public.print_devices where id = p_device_id for update;
  if not v_device.is_active then
    raise exception 'Esta impressora foi removida.' using errcode = 'PT409';
  end if;

  begin
    update public.print_devices set name = v_name, paper_width = p_paper_width
     where id = p_device_id returning * into v_device;
  exception when unique_violation then
    raise exception 'Já existe uma impressora com esse nome.' using errcode = 'PT409';
  end;

  perform public.apply_print_device_routes(p_device_id, p_full_order, p_sector_ids, p_documents);
  return v_device;
end;
$$;

create function public.set_print_device_routes(
  p_device_id uuid,
  p_full_order boolean,
  p_sector_ids uuid[],
  p_documents text[] default '{}'
)
returns public.print_devices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.print_devices;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_device from public.print_devices where id = p_device_id;
  if not found or public.user_role_in_company(v_device.company_id) is null then
    raise exception 'Impressora não encontrada.' using errcode = 'PT404';
  end if;
  if public.user_role_in_company(v_device.company_id) not in ('owner', 'admin') then
    raise exception 'Você não tem permissão para configurar impressoras.' using errcode = 'PT403';
  end if;

  select * into v_device from public.print_devices where id = p_device_id for update;
  if not v_device.is_active then
    raise exception 'Esta impressora foi removida.' using errcode = 'PT409';
  end if;

  perform public.apply_print_device_routes(p_device_id, p_full_order, p_sector_ids, p_documents);
  return v_device;
end;
$$;

-- Remover = arquivar. Jobs ainda pendentes dessa impressora são cancelados (nunca imprimirão);
-- o histórico (jobs, itens, rotas) permanece.
create function public.archive_print_device(p_device_id uuid)
returns public.print_devices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.print_devices;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_device from public.print_devices where id = p_device_id;
  if not found or public.user_role_in_company(v_device.company_id) is null then
    raise exception 'Impressora não encontrada.' using errcode = 'PT404';
  end if;
  if public.user_role_in_company(v_device.company_id) not in ('owner', 'admin') then
    raise exception 'Você não tem permissão para remover impressoras.' using errcode = 'PT403';
  end if;

  select * into v_device from public.print_devices where id = p_device_id for update;
  if not v_device.is_active then
    return v_device;
  end if;

  update public.print_devices set is_active = false, archived_at = now()
   where id = p_device_id returning * into v_device;

  update public.print_jobs
     set status = 'cancelled', error_message = 'Impressora removida da configuração.'
   where print_device_id = p_device_id and status = 'pending';

  return v_device;
end;
$$;

create function public.enqueue_test_print(p_device_id uuid)
returns public.print_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.print_devices;
  v_job public.print_jobs;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_device from public.print_devices where id = p_device_id;
  if not found or public.user_role_in_company(v_device.company_id) is null then
    raise exception 'Impressora não encontrada.' using errcode = 'PT404';
  end if;
  if public.user_role_in_company(v_device.company_id) not in ('owner', 'admin') then
    raise exception 'Você não tem permissão para testar impressoras.' using errcode = 'PT403';
  end if;

  select * into v_device from public.print_devices where id = p_device_id for share;
  if not v_device.is_active then
    raise exception 'Esta impressora foi removida.' using errcode = 'PT409';
  end if;
  if not v_device.is_ready then
    raise exception 'Conecte o Agente de Impressão para testar.' using errcode = 'PT409';
  end if;

  insert into public.print_jobs (company_id, print_device_id, job_type, payload, created_by)
  values (
    v_device.company_id, v_device.id, 'test',
    public.print_base_payload('test', v_device) || jsonb_build_object(
      'title', 'TESTE DE IMPRESSÃO',
      'requested_at', now(),
      'operator', jsonb_build_object('name', public.print_actor_name(v_device.company_id, auth.uid()))
    ),
    auth.uid()
  )
  returning * into v_job;

  return v_job;
end;
$$;

-- Reimpressão: NOVO job (o original não muda) com o mesmo payload/itens/impressora, marcado como
-- REIMPRESSÃO. reprint_of_id aponta sempre para o job original (mesmo reimprimindo uma reimpressão).
create function public.reprint_print_job(p_job_id uuid)
returns public.print_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_src public.print_jobs;
  v_device public.print_devices;
  v_job public.print_jobs;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_src from public.print_jobs where id = p_job_id;
  if not found or public.user_role_in_company(v_src.company_id) is null then
    raise exception 'Impressão não encontrada.' using errcode = 'PT404';
  end if;
  if public.user_role_in_company(v_src.company_id) not in ('owner', 'admin') then
    raise exception 'Você não tem permissão para reimprimir.' using errcode = 'PT403';
  end if;

  select * into v_device from public.print_devices where id = v_src.print_device_id for share;
  if not v_device.is_active then
    raise exception 'A impressora desta impressão foi removida.' using errcode = 'PT409';
  end if;
  if not v_device.is_ready then
    raise exception 'A impressora desta impressão não está conectada ao Agente de Impressão.' using errcode = 'PT409';
  end if;

  insert into public.print_jobs (
    company_id, print_device_id, job_type, service_order_id, cancellation_id, service_session_id, cash_session_id,
    payload, reprint_of_id, created_by
  ) values (
    v_src.company_id, v_src.print_device_id, v_src.job_type, v_src.service_order_id, v_src.cancellation_id,
    v_src.service_session_id, v_src.cash_session_id,
    v_src.payload || jsonb_build_object(
      'reprint', jsonb_build_object(
        'label', '*** REIMPRESSÃO ***',
        'original_job_id', coalesce(v_src.reprint_of_id, v_src.id),
        'requested_at', now(),
        'requested_by', jsonb_build_object('name', public.print_actor_name(v_src.company_id, auth.uid()))
      )
    ),
    coalesce(v_src.reprint_of_id, v_src.id),
    auth.uid()
  )
  returning * into v_job;

  insert into public.print_job_items (company_id, print_job_id, service_order_item_id, quantity)
  select company_id, v_job.id, service_order_item_id, quantity
  from public.print_job_items where print_job_id = v_src.id;

  return v_job;
end;
$$;

revoke execute on function public.create_print_device(uuid, text, integer, boolean, uuid[], text[]) from public, anon;
revoke execute on function public.update_print_device(uuid, text, integer, boolean, uuid[], text[]) from public, anon;
revoke execute on function public.set_print_device_routes(uuid, boolean, uuid[], text[]) from public, anon;
revoke execute on function public.archive_print_device(uuid) from public, anon;
revoke execute on function public.enqueue_test_print(uuid) from public, anon;
revoke execute on function public.reprint_print_job(uuid) from public, anon;
grant execute on function public.create_print_device(uuid, text, integer, boolean, uuid[], text[]) to authenticated;
grant execute on function public.update_print_device(uuid, text, integer, boolean, uuid[], text[]) to authenticated;
grant execute on function public.set_print_device_routes(uuid, boolean, uuid[], text[]) to authenticated;
grant execute on function public.archive_print_device(uuid) to authenticated;
grant execute on function public.enqueue_test_print(uuid) to authenticated;
grant execute on function public.reprint_print_job(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6b) Falhas de enfileiramento automático (visíveis a owner/admin)
-- ---------------------------------------------------------------------------
-- A impressão automática NUNCA derruba pedido/cancelamento; quando o enfileiramento falha, a venda
-- segue e uma linha aqui avisa o administrador (Configurações → Impressão). error_message é técnico
-- (diagnóstico): a tela mostra só o resumo. Sem escrita pelo cliente, salvo resolve_print_enqueue_failure.
create table public.print_enqueue_failures (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  event_type text not null
    constraint print_enqueue_failures_event_check check (event_type in ('production_order', 'production_cancellation')),
  service_order_id uuid,
  cancellation_id uuid,
  summary text
    constraint print_enqueue_failures_summary_length check (summary is null or char_length(summary) <= 200),
  error_message text
    constraint print_enqueue_failures_error_length check (error_message is null or char_length(error_message) <= 500),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete restrict,
  constraint print_enqueue_failures_resolved_check check ((resolved_at is null) = (resolved_by is null)),
  constraint print_enqueue_failures_order_fkey
    foreign key (company_id, service_order_id) references public.service_orders (company_id, id),
  constraint print_enqueue_failures_cancellation_fkey
    foreign key (cancellation_id) references public.service_order_item_cancellations (id)
);

create index print_enqueue_failures_open_idx
  on public.print_enqueue_failures (company_id, created_at desc) where resolved_at is null;
create index print_enqueue_failures_order_idx
  on public.print_enqueue_failures (company_id, service_order_id) where service_order_id is not null;
create index print_enqueue_failures_cancellation_idx
  on public.print_enqueue_failures (cancellation_id) where cancellation_id is not null;
create index print_enqueue_failures_resolved_by_idx
  on public.print_enqueue_failures (resolved_by) where resolved_by is not null;

comment on table public.print_enqueue_failures is
  'Falhas ao criar jobs de impressão AUTOMÁTICOS (pedido/cancelamento). A venda segue; owner/admin vê o aviso e marca como resolvida (resolve_print_enqueue_failure). Sem recuperação automática nesta etapa (reimpressão pela fila, se o job existir).';

alter table public.print_enqueue_failures enable row level security;
create policy print_enqueue_failures_select on public.print_enqueue_failures
  for select to authenticated
  using (public.user_role_in_company(company_id) in ('owner', 'admin'));
revoke all on public.print_enqueue_failures from anon, authenticated;
grant select on public.print_enqueue_failures to authenticated;
grant all on public.print_enqueue_failures to service_role;

-- Chamado do bloco EXCEPTION de submit_service_order/cancel_service_order_item. Nunca falha (se nem
-- o registro puder ser gravado, só vira WARNING): a venda/cancelamento tem prioridade absoluta.
create function public.record_print_enqueue_failure(
  p_company_id uuid,
  p_event_type text,
  p_service_order_id uuid,
  p_cancellation_id uuid,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_label text;
begin
  begin
    select (case when sp.type = 'table' then 'Mesa ' else 'Comanda ' end) || sp.code into v_label
    from public.service_orders o
    join public.service_sessions ss on ss.company_id = o.company_id and ss.id = o.service_session_id
    join public.service_points sp on sp.company_id = ss.company_id and sp.id = ss.service_point_id
    where o.company_id = p_company_id and o.id = p_service_order_id;

    insert into public.print_enqueue_failures (
      company_id, event_type, service_order_id, cancellation_id, summary, error_message
    ) values (
      p_company_id, p_event_type, p_service_order_id, p_cancellation_id,
      (case when p_event_type = 'production_order' then 'Pedido' else 'Cancelamento de item' end)
        || coalesce(' da ' || v_label, ''),
      left(p_error, 500)
    );
  exception when others then
    raise warning 'Falha ao registrar print_enqueue_failures: %', sqlerrm;
  end;
end;
$$;

revoke execute on function public.record_print_enqueue_failure(uuid, text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.record_print_enqueue_failure(uuid, text, uuid, uuid, text) to service_role;

create function public.resolve_print_enqueue_failure(p_failure_id uuid)
returns public.print_enqueue_failures
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.print_enqueue_failures;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_row from public.print_enqueue_failures where id = p_failure_id;
  if not found or public.user_role_in_company(v_row.company_id) is null then
    raise exception 'Aviso não encontrado.' using errcode = 'PT404';
  end if;
  if public.user_role_in_company(v_row.company_id) not in ('owner', 'admin') then
    raise exception 'Você não tem permissão para resolver avisos de impressão.' using errcode = 'PT403';
  end if;

  update public.print_enqueue_failures
     set resolved_at = now(), resolved_by = auth.uid()
   where id = p_failure_id and resolved_at is null
  returning * into v_row;
  if not found then
    select * into v_row from public.print_enqueue_failures where id = p_failure_id;
  end if;
  return v_row;
end;
$$;

revoke execute on function public.resolve_print_enqueue_failure(uuid) from public, anon;
grant execute on function public.resolve_print_enqueue_failure(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6c) Documentos MANUAIS: conta/pré-conta, comprovante de pagamento, fechamento de caixa
-- ---------------------------------------------------------------------------
-- Nunca automáticos: só quando o usuário pede (botão ou F8). Cada RPC monta o snapshot COMPLETO no
-- servidor (o cliente só envia o id) — o Agente imprime sem consultar tabelas comerciais — e cria um
-- job por impressora ATIVA com a rota correspondente. Sem impressora configurada: nenhum job e
-- mensagem amigável (PT409). Pedir duas vezes cria dois jobs (ação intencional, sem idempotência).
-- Nenhuma delas altera conta, pagamento ou caixa.
create function public.enqueue_document_jobs(
  p_kind text,
  p_company_id uuid,
  p_doc jsonb,
  p_service_session_id uuid,
  p_cash_session_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.print_devices;
  v_n integer := 0;
  v_label text;
begin
  for v_device in
    select d.* from public.print_devices d
    where d.company_id = p_company_id
      and d.is_ready
      and exists (select 1 from public.print_device_routes r where r.print_device_id = d.id and r.route_type = p_kind)
    order by d.id
    for share
  loop
    insert into public.print_jobs (company_id, print_device_id, job_type, service_session_id, cash_session_id, payload, created_by)
    values (
      p_company_id, v_device.id, p_kind, p_service_session_id, p_cash_session_id,
      public.print_base_payload(p_kind, v_device) || p_doc,
      auth.uid()
    );
    v_n := v_n + 1;
  end loop;

  if v_n = 0 then
    v_label := case p_kind
      when 'customer_bill' then 'Conta / pré-conta'
      when 'payment_receipt' then 'Comprovante de pagamento'
      else 'Fechamento de caixa'
    end;
    -- Dois casos distintos: há rota configurada mas nenhuma impressora PRONTA, ou não há rota nenhuma.
    if exists (
      select 1 from public.print_devices d
      join public.print_device_routes r on r.print_device_id = d.id and r.route_type = p_kind
      where d.company_id = p_company_id and d.is_active
    ) then
      raise exception 'A impressora configurada para % ainda não está conectada ao Agente de Impressão.', v_label using errcode = 'PT409';
    end if;
    raise exception 'Nenhuma impressora está configurada para %.', v_label using errcode = 'PT409';
  end if;
  return v_n;
end;
$$;

revoke execute on function public.enqueue_document_jobs(text, uuid, jsonb, uuid, uuid) from public, anon, authenticated;
grant execute on function public.enqueue_document_jobs(text, uuid, jsonb, uuid, uuid) to service_role;

-- Dados comuns de conta (empresa/ponto/cliente).
create function public.print_session_header(p_session public.service_sessions)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'service_point', jsonb_build_object(
      'type', sp.type, 'code', sp.code, 'display_name', sp.display_name,
      'label', (case when sp.type = 'table' then 'Mesa ' else 'Comanda ' end) || sp.code
    ),
    'customer_name', p_session.customer_name,
    'session', jsonb_build_object('id', p_session.id, 'status', p_session.status,
                                  'opened_at', p_session.opened_at, 'closed_at', p_session.closed_at)
  )
  from public.service_points sp
  where sp.company_id = p_session.company_id and sp.id = p_session.service_point_id;
$$;

revoke execute on function public.print_session_header(public.service_sessions) from public, anon, authenticated;

-- Conta / pré-conta: owner, admin, cashier e attendant. Funciona com a conta ABERTA (uso normal) e fechada.
create function public.enqueue_customer_bill(p_service_session_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.service_sessions;
  v_role public.company_role;
  v_items jsonb;
  v_total numeric(12, 2);
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_session from public.service_sessions where id = p_service_session_id;
  if not found then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  v_role := public.user_role_in_company(v_session.company_id);
  if v_role is null then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier', 'attendant') then
    raise exception 'Você não tem permissão para imprimir a conta.' using errcode = 'PT403';
  end if;

  -- Mesma base do fechamento: quantidade cobrável (quantity - cancelled_quantity) de pedidos enviados.
  select
    jsonb_agg(jsonb_build_object(
      'product_name', i.product_name_snapshot,
      'quantity', i.quantity - i.cancelled_quantity,
      'unit_price', i.unit_price,
      'total', (i.quantity - i.cancelled_quantity) * i.unit_price,
      'notes', i.notes
    ) order by i.created_at, i.product_name_snapshot, i.id),
    coalesce(sum((i.quantity - i.cancelled_quantity) * i.unit_price), 0)::numeric(12, 2)
    into v_items, v_total
  from public.service_orders o
  join public.service_order_items i on i.company_id = o.company_id and i.order_id = o.id
  where o.company_id = v_session.company_id
    and o.service_session_id = v_session.id
    and o.status = 'submitted'
    and i.quantity - i.cancelled_quantity > 0;

  if v_items is null then
    raise exception 'Esta conta ainda não tem itens.' using errcode = 'PT409';
  end if;

  return public.enqueue_document_jobs(
    'customer_bill', v_session.company_id,
    public.print_session_header(v_session) || jsonb_build_object(
      'title', 'CONTA / PRÉ-CONTA',
      'items', v_items,
      'total', v_total,
      'printed_at', now(),
      'requested_by', jsonb_build_object('name', public.print_actor_name(v_session.company_id, auth.uid())),
      'footer', 'Documento não fiscal'
    ),
    v_session.id, null
  );
end;
$$;

-- Comprovante de pagamento: owner, admin e cashier; só conta FECHADA.
create function public.enqueue_payment_receipt(p_service_session_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.service_sessions;
  v_role public.company_role;
  v_payments jsonb;
  v_refunds jsonb;
  v_paid numeric(12, 2);
  v_refunded numeric(12, 2);
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_session from public.service_sessions where id = p_service_session_id;
  if not found then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  v_role := public.user_role_in_company(v_session.company_id);
  if v_role is null then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier') then
    raise exception 'Você não tem permissão para imprimir o comprovante.' using errcode = 'PT403';
  end if;
  if v_session.status <> 'closed' then
    raise exception 'A conta ainda está aberta. O comprovante só pode ser impresso depois do pagamento.' using errcode = 'PT409';
  end if;

  -- Uma linha por pagamento (pagamento dividido mostra todas as formas); dinheiro leva entregue e troco.
  select jsonb_agg(jsonb_build_object(
           'method', p.payment_method,
           'label', case p.payment_method
                      when 'cash' then 'Dinheiro' when 'pix' then 'Pix' when 'debit_card' then 'Débito'
                      when 'credit_card' then 'Crédito' else 'Outros' end,
           'amount', p.amount,
           'amount_received', p.amount_received,
           'change_amount', p.change_amount
         ) order by array_position(array['cash', 'pix', 'debit_card', 'credit_card', 'other'], p.payment_method), p.created_at, p.id),
         coalesce(sum(p.amount), 0)::numeric(12, 2)
    into v_payments, v_paid
  from public.service_payments p
  where p.company_id = v_session.company_id and p.service_session_id = v_session.id;

  select jsonb_agg(jsonb_build_object(
           'amount', r.amount,
           'method', p.payment_method,
           'created_at', r.created_at
         ) order by r.created_at, r.id),
         coalesce(sum(r.amount), 0)::numeric(12, 2)
    into v_refunds, v_refunded
  from public.service_refunds r
  join public.service_payments p on p.company_id = r.company_id and p.id = r.service_payment_id
  where r.company_id = v_session.company_id and r.service_session_id = v_session.id;

  return public.enqueue_document_jobs(
    'payment_receipt', v_session.company_id,
    public.print_session_header(v_session) || jsonb_build_object(
      'title', 'COMPROVANTE DE PAGAMENTO',
      'total', v_session.total_amount,
      'payments', coalesce(v_payments, '[]'::jsonb),
      'paid_total', v_paid,
      'refunds', coalesce(v_refunds, '[]'::jsonb),
      'refunded_total', v_refunded,
      'net_total', v_paid - v_refunded,
      'printed_at', now(),
      'requested_by', jsonb_build_object('name', public.print_actor_name(v_session.company_id, auth.uid())),
      'footer', 'Documento não fiscal'
    ),
    v_session.id, null
  );
end;
$$;

-- Fechamento de caixa: owner/admin (qualquer caixa da empresa) e cashier (só o PRÓPRIO); só caixa FECHADO.
create function public.enqueue_cash_closing(p_cash_session_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cash public.cash_sessions;
  v_role public.company_role;
  v_sales jsonb;
  v_totals record;
  v_expected numeric(12, 2);
  v_diff numeric(12, 2);
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_cash from public.cash_sessions where id = p_cash_session_id;
  if not found then
    raise exception 'Caixa não encontrado.' using errcode = 'PT404';
  end if;
  v_role := public.user_role_in_company(v_cash.company_id);
  if v_role is null or (v_role = 'cashier' and v_cash.opened_by <> auth.uid()) then
    raise exception 'Caixa não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier') then
    raise exception 'Você não tem permissão para imprimir o fechamento de caixa.' using errcode = 'PT403';
  end if;
  if v_cash.status <> 'closed' then
    raise exception 'O caixa ainda está aberto. O fechamento só pode ser impresso depois de fechar o caixa.' using errcode = 'PT409';
  end if;

  select
    coalesce(sum(amount) filter (where movement_type = 'sale' and payment_method = 'cash'), 0)::numeric(12, 2) as cash_sales,
    coalesce(sum(amount) filter (where movement_type = 'sale' and payment_method = 'pix'), 0)::numeric(12, 2) as pix_sales,
    coalesce(sum(amount) filter (where movement_type = 'sale' and payment_method = 'debit_card'), 0)::numeric(12, 2) as debit_sales,
    coalesce(sum(amount) filter (where movement_type = 'sale' and payment_method = 'credit_card'), 0)::numeric(12, 2) as credit_sales,
    coalesce(sum(amount) filter (where movement_type = 'sale' and payment_method = 'other'), 0)::numeric(12, 2) as other_sales,
    coalesce(sum(amount) filter (where movement_type = 'sale'), 0)::numeric(12, 2) as total_sales,
    coalesce(sum(amount) filter (where movement_type = 'supply'), 0)::numeric(12, 2) as supplies,
    coalesce(sum(amount) filter (where movement_type = 'withdrawal'), 0)::numeric(12, 2) as withdrawals,
    coalesce(sum(amount) filter (where movement_type = 'refund'), 0)::numeric(12, 2) as refunds
    into v_totals
  from public.cash_movements
  where company_id = v_cash.company_id and cash_session_id = v_cash.id;

  -- Esperado/diferença = o que foi apurado NO FECHAMENTO (contado - diferença).
  v_diff := v_cash.cash_difference;
  v_expected := v_cash.closing_cash_amount - v_diff;

  return public.enqueue_document_jobs(
    'cash_closing', v_cash.company_id,
    jsonb_build_object(
      'title', 'FECHAMENTO DE CAIXA',
      'operator', jsonb_build_object('name', public.print_actor_name(v_cash.company_id, v_cash.opened_by)),
      'closed_by', jsonb_build_object('name', public.print_actor_name(v_cash.company_id, v_cash.closed_by)),
      'opened_at', v_cash.opened_at,
      'closed_at', v_cash.closed_at,
      'opening_amount', v_cash.opening_amount,
      'sales', jsonb_build_object(
        'cash', v_totals.cash_sales, 'pix', v_totals.pix_sales, 'debit_card', v_totals.debit_sales,
        'credit_card', v_totals.credit_sales, 'other', v_totals.other_sales, 'total', v_totals.total_sales
      ),
      'supplies', v_totals.supplies,
      'withdrawals', v_totals.withdrawals,
      'refunds', v_totals.refunds,
      'expected_cash', v_expected,
      'counted_cash', v_cash.closing_cash_amount,
      'difference', v_diff,
      'difference_label', case
        when v_diff = 0 then 'CONFERE'
        when v_diff < 0 then 'FALTA R$ ' || replace(to_char(abs(v_diff), 'FM9999999990.00'), '.', ',')
        else 'SOBRA R$ ' || replace(to_char(v_diff, 'FM9999999990.00'), '.', ',')
      end,
      'closing_notes', v_cash.closing_notes,
      'printed_at', now(),
      'requested_by', jsonb_build_object('name', public.print_actor_name(v_cash.company_id, auth.uid()))
    ),
    null, v_cash.id
  );
end;
$$;

revoke execute on function public.enqueue_customer_bill(uuid) from public, anon;
revoke execute on function public.enqueue_payment_receipt(uuid) from public, anon;
revoke execute on function public.enqueue_cash_closing(uuid) from public, anon;
grant execute on function public.enqueue_customer_bill(uuid) to authenticated;
grant execute on function public.enqueue_payment_receipt(uuid) to authenticated;
grant execute on function public.enqueue_cash_closing(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7) Integração: submit_service_order e cancel_service_order_item
--    (mesmas assinaturas e ACL da 20260930080000; só ganham a chamada do helper no fim)
-- ---------------------------------------------------------------------------
create or replace function public.submit_service_order(
  p_service_session_id uuid,
  p_items jsonb
)
returns public.service_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.service_sessions;
  v_role public.company_role;
  v_origin text;
  v_order public.service_orders;
  v_item jsonb;
  v_product public.products;
  v_category public.product_categories;
  v_quantity numeric;
  v_notes text;
  v_sector_id uuid;
  v_item_id uuid;
  v_balance integer;
  v_label text;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_session from public.service_sessions where id = p_service_session_id;
  if not found then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;

  v_role := public.user_role_in_company(v_session.company_id);
  if v_role is null then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier', 'attendant') then
    raise exception 'Você não tem permissão para lançar pedidos.' using errcode = 'PT403';
  end if;

  if v_session.status <> 'open' then
    raise exception 'Este atendimento não está aberto.' using errcode = 'PT409';
  end if;

  -- Origem decidida pelo papel de quem chama (nunca por um valor enviado no payload): só
  -- attendant tem área operacional própria hoje; os demais papéis autorizados operam como Caixa.
  v_origin := case when v_role = 'attendant' then 'attendant' else 'cashier' end;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Informe ao menos um item.' using errcode = 'PT400';
  end if;
  if jsonb_array_length(p_items) > 100 then
    raise exception 'Envie no máximo 100 itens por pedido.' using errcode = 'PT400';
  end if;

  -- ESTOQUE: trava, em ORDEM DE id (sem deadlock entre vendas simultâneas), os produtos CONTROLADOS
  -- do pedido antes de gravar qualquer coisa. Produtos sem controle não participam.
  perform 1
  from public.products p
  where p.company_id = v_session.company_id
    and p.stock_control = 'quantity'
    and p.id in (
      select (e ->> 'product_id')::uuid from jsonb_array_elements(p_items) e where e ->> 'product_id' is not null
    )
  order by p.id
  for update;

  select (case when sp.type = 'table' then 'Mesa ' else 'Comanda ' end) || sp.code into v_label
  from public.service_points sp
  where sp.company_id = v_session.company_id and sp.id = v_session.service_point_id;

  insert into public.service_orders (company_id, service_session_id, origin, status, created_by)
  values (v_session.company_id, v_session.id, v_origin, 'submitted', auth.uid())
  returning * into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    if v_item ->> 'product_id' is null then
      raise exception 'Cada item precisa de um produto.' using errcode = 'PT400';
    end if;

    if jsonb_typeof(v_item -> 'quantity') is distinct from 'number' then
      raise exception 'Quantidade inválida.' using errcode = 'PT400';
    end if;
    v_quantity := (v_item ->> 'quantity')::numeric;
    if v_quantity is null or v_quantity <= 0 or v_quantity <> trunc(v_quantity) then
      raise exception 'A quantidade precisa ser um número inteiro maior que zero.' using errcode = 'PT400';
    end if;

    v_notes := nullif(btrim(v_item ->> 'notes'), '');
    if v_notes is not null and char_length(v_notes) > 200 then
      raise exception 'A observação pode ter no máximo 200 caracteres.' using errcode = 'PT400';
    end if;

    -- company_id no WHERE garante, sozinho, "produto de outra empresa é recusado" (not found).
    select * into v_product
    from public.products
    where id = (v_item ->> 'product_id')::uuid
      and company_id = v_session.company_id;
    if not found then
      raise exception 'Produto não encontrado.' using errcode = 'PT404';
    end if;
    if not v_product.is_active then
      raise exception 'Produto inativo.' using errcode = 'PT409';
    end if;
    if not v_product.available_for_sale then
      raise exception 'Este produto está indisponível para venda: %.', v_product.name using errcode = 'PT409';
    end if;

    select * into v_category
    from public.product_categories
    where id = v_product.category_id
      and company_id = v_session.company_id;
    if not found or not v_category.is_active then
      raise exception 'Categoria do produto inativa.' using errcode = 'PT409';
    end if;

    -- Setor EFETIVO no momento do envio (mesma regra de products_with_effective_sector, 040000).
    v_sector_id := coalesce(v_product.production_sector_id, v_category.default_production_sector_id);

    insert into public.service_order_items (
      company_id, order_id, product_id, product_name_snapshot, quantity, unit_price, production_sector_id, notes
    ) values (
      v_session.company_id, v_order.id, v_product.id, v_product.name, v_quantity::integer, v_product.sale_price, v_sector_id, v_notes
    ) returning id into v_item_id;

    -- BAIXA (só produto controlado; o produto já está travado acima). Várias linhas do mesmo
    -- produto baixam em sequência, então o saldo é conferido de forma agregada.
    if v_product.stock_control = 'quantity' then
      update public.products
         set stock_quantity = stock_quantity - v_quantity::integer
       where id = v_product.id and stock_quantity >= v_quantity::integer
      returning stock_quantity into v_balance;
      if not found then
        raise exception 'Estoque insuficiente para %. Disponível: %, solicitado: %.',
          v_product.name,
          (select stock_quantity from public.products where id = v_product.id),
          v_quantity::integer using errcode = 'PT409';
      end if;

      insert into public.product_stock_movements (
        company_id, product_id, movement_type, quantity, reason, balance_after, service_order_item_id, created_by
      ) values (
        v_session.company_id, v_product.id, 'sale', v_quantity::integer,
        left('Pedido ' || coalesce(v_label, ''), 200), v_balance, v_item_id, auth.uid()
      );
    end if;
  end loop;

  -- Impressão é complementar: um erro aqui nunca derruba o pedido (savepoint próprio; fica registrado em print_enqueue_failures).
  begin
    perform public.enqueue_order_print_jobs(v_order.id);
  exception when others then
    raise warning 'Falha ao enfileirar impressão (enqueue_order_print_jobs) %: %', v_order.id, sqlerrm;
    perform public.record_print_enqueue_failure(v_order.company_id, 'production_order', v_order.id, null, sqlerrm);
  end;

  return v_order;
end;
$$;

revoke execute on function public.submit_service_order(uuid, jsonb) from public, anon;
grant execute on function public.submit_service_order(uuid, jsonb) to authenticated;

create or replace function public.cancel_service_order_item(
  p_item_id uuid,
  p_quantity integer,
  p_reason text
)
returns public.service_order_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.service_order_items;
  v_order_status text;
  v_session public.service_sessions;
  v_role public.company_role;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_active integer;
  v_event_id uuid;
  v_product public.products;
  v_sold integer;
  v_reversed integer;
  v_back integer;
  v_balance integer;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  -- Leitura sem trava só para achar o atendimento; tudo é revalidado depois das travas.
  select * into v_item from public.service_order_items where id = p_item_id;
  if not found then
    raise exception 'Item não encontrado.' using errcode = 'PT404';
  end if;

  select ss.* into v_session
  from public.service_orders o
  join public.service_sessions ss on ss.company_id = o.company_id and ss.id = o.service_session_id
  where o.company_id = v_item.company_id and o.id = v_item.order_id
  for update of ss;
  if not found then
    raise exception 'Item não encontrado.' using errcode = 'PT404';
  end if;

  v_role := public.user_role_in_company(v_session.company_id);
  if v_role is null then
    raise exception 'Item não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier', 'attendant') then
    raise exception 'Você não tem permissão para cancelar itens.' using errcode = 'PT403';
  end if;

  if v_session.status <> 'open' then
    raise exception 'Esta conta já foi fechada. Utilize um estorno.' using errcode = 'PT409';
  end if;

  select * into v_item from public.service_order_items where id = p_item_id for update;

  select status into v_order_status
  from public.service_orders
  where company_id = v_item.company_id and id = v_item.order_id;
  if v_order_status is distinct from 'submitted' then
    raise exception 'Este pedido já foi cancelado.' using errcode = 'PT409';
  end if;

  v_active := v_item.quantity - v_item.cancelled_quantity;
  if v_active <= 0 then
    raise exception 'Este item já foi totalmente cancelado.' using errcode = 'PT409';
  end if;

  if v_role in ('cashier', 'attendant') and v_item.production_status <> 'pending' then
    raise exception 'Este item já entrou em produção. Solicite o cancelamento a um administrador.' using errcode = 'PT403';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Informe a quantidade a cancelar (número inteiro maior que zero).' using errcode = 'PT400';
  end if;
  if p_quantity > v_active then
    raise exception 'A quantidade a cancelar é maior que a disponível (%).', v_active using errcode = 'PT400';
  end if;
  if v_reason is null then
    raise exception 'Informe o motivo do cancelamento.' using errcode = 'PT400';
  end if;
  if char_length(v_reason) > 200 then
    raise exception 'O motivo pode ter no máximo 200 caracteres.' using errcode = 'PT400';
  end if;

  update public.service_order_items
     set cancelled_quantity = cancelled_quantity + p_quantity
   where id = v_item.id
  returning * into v_item;

  insert into public.service_order_item_cancellations (company_id, service_order_item_id, quantity, reason, cancelled_by)
  values (v_item.company_id, v_item.id, p_quantity, v_reason, auth.uid())
  returning id into v_event_id;

  -- ESTOQUE (só produto controlado): item ainda 'pending' devolve a quantidade deste evento, nunca
  -- mais do que foi vendido. Em 'preparing'/'ready' NÃO devolve automaticamente (owner/admin faz uma
  -- entrada se o produto voltou fisicamente). Produto sem controle: nenhuma movimentação.
  if v_item.production_status = 'pending' then
    select * into v_product from public.products
    where company_id = v_item.company_id and id = v_item.product_id for update;

    if found and v_product.stock_control = 'quantity' then
      select coalesce(sum(quantity), 0) into v_sold
      from public.product_stock_movements
      where service_order_item_id = v_item.id and movement_type = 'sale';

      select coalesce(sum(quantity), 0) into v_reversed
      from public.product_stock_movements
      where service_order_item_id = v_item.id and movement_type = 'cancellation_reversal';

      v_back := least(p_quantity, v_sold - v_reversed);
      if v_back > 0 then
        update public.products set stock_quantity = stock_quantity + v_back
         where id = v_product.id
        returning stock_quantity into v_balance;

        insert into public.product_stock_movements (
          company_id, product_id, movement_type, quantity, reason, balance_after,
          service_order_item_id, cancellation_id, created_by
        ) values (
          v_item.company_id, v_product.id, 'cancellation_reversal', v_back,
          left('Cancelamento: ' || v_reason, 200), v_balance, v_item.id, v_event_id, auth.uid()
        );
      end if;
    end if;
  end if;

  -- Pedido sem nenhuma unidade cobrável: cancelado por inteiro.
  if not exists (
    select 1 from public.service_order_items i
    where i.company_id = v_item.company_id and i.order_id = v_item.order_id
      and i.cancelled_quantity < i.quantity
  ) then
    update public.service_orders
       set status = 'cancelled', cancelled_at = now()
     where company_id = v_item.company_id and id = v_item.order_id;
  end if;

  -- Impressão é complementar: um erro aqui nunca derruba o cancelamento (savepoint próprio; fica registrado em print_enqueue_failures).
  begin
    perform public.enqueue_cancellation_print_jobs(v_event_id);
  exception when others then
    raise warning 'Falha ao enfileirar impressão (enqueue_cancellation_print_jobs) %: %', v_event_id, sqlerrm;
    perform public.record_print_enqueue_failure(v_item.company_id, 'production_cancellation', v_item.order_id, v_event_id, sqlerrm);
  end;

  return v_item;
end;
$$;

revoke execute on function public.cancel_service_order_item(uuid, integer, text) from public, anon;
grant execute on function public.cancel_service_order_item(uuid, integer, text) to authenticated;

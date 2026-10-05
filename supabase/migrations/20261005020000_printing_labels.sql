-- IMPRESSÃO → ETIQUETAS E IMPRESSORAS.
--
-- Estende o módulo de impressão EXISTENTE (print_devices, print_jobs, Agente, pareamento, Realtime) com um segundo
-- TIPO de impressora — etiquetas — sem tocar no caminho do cupom:
--
--   print_devices.device_kind   receipt (padrão; TODA impressora já cadastrada continua 'receipt') | label
--   print_devices.label_*       só para label: largura/altura (mm, tamanho livre), espaçamento (gap, mm), colunas,
--                               margens X/Y (mm). paper_width (58/80) só existe para receipt (NULL em label).
--   print_devices.is_default    impressora PADRÃO — só para etiquetas (cupom roteia por setor/documento; um
--                               "padrão de recibo" não teria efeito). Uma por empresa.
--
-- Fila: a MESMA print_jobs ganha 3 tipos (label_product, label_free, label_service_point). Um job = um pedido de
-- impressão com `quantity` etiquetas e o SNAPSHOT do conteúdo (nunca confia em preço/código do cliente: produto e
-- comanda/mesa são lidos do banco). A disposição em colunas/linhas e o desenho são do Agente (mesmo modelo de layout
-- do preview da tela).
--
-- Quem pode: configurar impressoras de etiqueta = owner/admin (como o cupom). Imprimir: produto e livre =
-- owner/admin/cashier; comanda/mesa = owner/admin/cashier/attendant; production nunca. cashier/attendant leem só a
-- LISTA mínima de impressoras de etiqueta (list_label_printers), não a tabela.
-- Isolamento: toda RPC valida o vínculo com a empresa; o job só nasce para impressora de etiqueta ATIVA e PRONTA da
-- MESMA empresa (FK composta + claim já filtra por empresa/agente).
-- Erros: PT401, PT404 (empresa/item não encontrado), PT403, PT400 (dados), PT409 (impressora não pronta/escolha).

-- ---------------------------------------------------------------------------
-- 1) print_devices: tipo, configuração de etiqueta e padrão
-- ---------------------------------------------------------------------------
alter table public.print_devices
  add column device_kind text not null default 'receipt'
    constraint print_devices_kind_check check (device_kind in ('receipt', 'label')),
  add column label_width_mm numeric(5, 1),
  add column label_height_mm numeric(5, 1),
  add column label_gap_mm numeric(4, 1),
  add column label_columns smallint,
  add column label_margin_x_mm numeric(4, 1),
  add column label_margin_y_mm numeric(4, 1),
  add column is_default boolean not null default false;

alter table public.print_devices alter column paper_width drop not null;
alter table public.print_devices drop constraint print_devices_paper_width_check;

alter table public.print_devices
  add constraint print_devices_kind_shape check (
    (device_kind = 'receipt'
      and paper_width in (58, 80)
      and label_width_mm is null and label_height_mm is null and label_gap_mm is null
      and label_columns is null and label_margin_x_mm is null and label_margin_y_mm is null
      and not is_default)
    or
    (device_kind = 'label'
      and paper_width is null
      and label_width_mm between 10 and 200
      and label_height_mm between 10 and 300
      and label_gap_mm between 0 and 30
      and label_columns between 1 and 4
      and label_margin_x_mm between 0 and 20
      and label_margin_y_mm between 0 and 20
      and label_margin_x_mm * 2 < label_width_mm
      and label_margin_y_mm * 2 < label_height_mm)
  );

-- Uma impressora de etiquetas padrão por empresa (entre as ativas).
create unique index print_devices_default_label_key
  on public.print_devices (company_id) where is_default and is_active;

comment on column public.print_devices.device_kind is
  'receipt (cupom/recibo ESC/POS, 58/80 mm — padrão de TODA impressora antiga) | label (etiquetas: tamanho livre em mm, colunas, gap e margens).';

-- Tipo e empresa não mudam depois de criada (mesma guarda da 010000, mais device_kind).
create or replace function public.guard_print_device_change()
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
  if new.device_kind is distinct from old.device_kind then
    raise exception 'O tipo de uma impressora não pode ser alterado. Cadastre outra.' using errcode = 'PT409';
  end if;
  if not old.is_active and new.is_active then
    raise exception 'Uma impressora removida não pode ser reativada.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

-- Impressora de etiquetas não tem rotas de produção/documentos (essas são do cupom).
create function public.guard_print_route_device_kind()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (select 1 from public.print_devices d where d.id = new.print_device_id and d.device_kind <> 'receipt') then
    raise exception 'Impressora de etiquetas não recebe pedidos nem documentos.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

create trigger print_device_routes_guard_kind
  before insert on public.print_device_routes
  for each row execute function public.guard_print_route_device_kind();

revoke execute on function public.guard_print_route_device_kind() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) print_jobs: três tipos novos (mesma fila)
-- ---------------------------------------------------------------------------
alter table public.print_jobs drop constraint print_jobs_type_check;
alter table public.print_jobs
  add constraint print_jobs_type_check check (job_type in (
    'production_order', 'production_cancellation', 'test', 'customer_bill', 'payment_receipt', 'cash_closing',
    'label_product', 'label_free', 'label_service_point'
  ));

alter table public.print_jobs drop constraint print_jobs_shape_check;
alter table public.print_jobs
  add constraint print_jobs_shape_check check (
    (job_type = 'production_order' and service_order_id is not null and cancellation_id is null
       and service_session_id is null and cash_session_id is null)
    or (job_type = 'production_cancellation' and service_order_id is not null and cancellation_id is not null
       and service_session_id is null and cash_session_id is null)
    or (job_type in ('test', 'label_product', 'label_free', 'label_service_point')
       and service_order_id is null and cancellation_id is null
       and service_session_id is null and cash_session_id is null)
    or (job_type in ('customer_bill', 'payment_receipt') and service_session_id is not null
       and service_order_id is null and cancellation_id is null and cash_session_id is null)
    or (job_type = 'cash_closing' and cash_session_id is not null
       and service_order_id is null and cancellation_id is null and service_session_id is null)
  );

-- ---------------------------------------------------------------------------
-- 3) Configurar impressora de etiquetas (owner/admin)
-- ---------------------------------------------------------------------------
create function public.label_printer_validate(
  p_name text, p_width numeric, p_height numeric, p_gap numeric, p_columns integer, p_margin_x numeric, p_margin_y numeric
)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
begin
  if char_length(v_name) not between 1 and 80 then
    raise exception 'Informe o nome da impressora (até 80 caracteres).' using errcode = 'PT400';
  end if;
  if p_width is null or p_width < 10 or p_width > 200 then
    raise exception 'A largura da etiqueta deve ficar entre 10 e 200 mm.' using errcode = 'PT400';
  end if;
  if p_height is null or p_height < 10 or p_height > 300 then
    raise exception 'A altura da etiqueta deve ficar entre 10 e 300 mm.' using errcode = 'PT400';
  end if;
  if p_gap is null or p_gap < 0 or p_gap > 30 then
    raise exception 'O espaçamento (gap) deve ficar entre 0 e 30 mm.' using errcode = 'PT400';
  end if;
  if p_columns is null or p_columns < 1 or p_columns > 4 then
    raise exception 'A quantidade de colunas deve ser de 1 a 4.' using errcode = 'PT400';
  end if;
  if p_margin_x is null or p_margin_x < 0 or p_margin_x > 20 or p_margin_y is null or p_margin_y < 0 or p_margin_y > 20 then
    raise exception 'As margens devem ficar entre 0 e 20 mm.' using errcode = 'PT400';
  end if;
  if p_margin_x * 2 >= p_width or p_margin_y * 2 >= p_height then
    raise exception 'As margens não podem ocupar toda a etiqueta.' using errcode = 'PT400';
  end if;
  return v_name;
end;
$$;

revoke execute on function public.label_printer_validate(text, numeric, numeric, numeric, integer, numeric, numeric) from public, anon, authenticated;

create function public.create_label_printer(
  p_company_id uuid,
  p_name text,
  p_width_mm numeric,
  p_height_mm numeric,
  p_gap_mm numeric default 3,
  p_columns integer default 1,
  p_margin_x_mm numeric default 1,
  p_margin_y_mm numeric default 1,
  p_is_default boolean default false
)
returns public.print_devices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_device public.print_devices;
  v_first boolean;
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
  v_name := public.label_printer_validate(p_name, p_width_mm, p_height_mm, p_gap_mm, p_columns, p_margin_x_mm, p_margin_y_mm);

  -- A primeira impressora de etiquetas da empresa já nasce como padrão.
  select not exists (select 1 from public.print_devices where company_id = p_company_id and device_kind = 'label' and is_active)
    into v_first;
  if coalesce(p_is_default, false) or v_first then
    update public.print_devices set is_default = false
     where company_id = p_company_id and device_kind = 'label' and is_default;
  end if;

  begin
    insert into public.print_devices (
      company_id, name, device_kind, paper_width, label_width_mm, label_height_mm, label_gap_mm, label_columns,
      label_margin_x_mm, label_margin_y_mm, is_default, created_by
    ) values (
      p_company_id, v_name, 'label', null, p_width_mm, p_height_mm, p_gap_mm, p_columns,
      p_margin_x_mm, p_margin_y_mm, coalesce(p_is_default, false) or v_first, auth.uid()
    )
    returning * into v_device;
  exception when unique_violation then
    raise exception 'Já existe uma impressora com esse nome.' using errcode = 'PT409';
  end;
  return v_device;
end;
$$;

create function public.update_label_printer(
  p_device_id uuid,
  p_name text,
  p_width_mm numeric,
  p_height_mm numeric,
  p_gap_mm numeric default 3,
  p_columns integer default 1,
  p_margin_x_mm numeric default 1,
  p_margin_y_mm numeric default 1,
  p_is_default boolean default false
)
returns public.print_devices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
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
  if v_device.device_kind <> 'label' then
    raise exception 'Esta não é uma impressora de etiquetas.' using errcode = 'PT409';
  end if;
  v_name := public.label_printer_validate(p_name, p_width_mm, p_height_mm, p_gap_mm, p_columns, p_margin_x_mm, p_margin_y_mm);

  select * into v_device from public.print_devices where id = p_device_id for update;
  if not v_device.is_active then
    raise exception 'Esta impressora foi removida.' using errcode = 'PT409';
  end if;

  if coalesce(p_is_default, false) and not v_device.is_default then
    update public.print_devices set is_default = false
     where company_id = v_device.company_id and device_kind = 'label' and is_default;
  end if;

  begin
    update public.print_devices
       set name = v_name, label_width_mm = p_width_mm, label_height_mm = p_height_mm, label_gap_mm = p_gap_mm,
           label_columns = p_columns, label_margin_x_mm = p_margin_x_mm, label_margin_y_mm = p_margin_y_mm,
           is_default = coalesce(p_is_default, false) or (is_default and p_is_default is null)
     where id = p_device_id
     returning * into v_device;
  exception when unique_violation then
    raise exception 'Já existe uma impressora com esse nome.' using errcode = 'PT409';
  end;
  return v_device;
end;
$$;

-- Define qual impressora de etiquetas é a padrão (a outra deixa de ser).
create function public.set_default_label_printer(p_device_id uuid)
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
  if v_device.device_kind <> 'label' then
    raise exception 'Só impressoras de etiquetas têm impressora padrão.' using errcode = 'PT409';
  end if;
  select * into v_device from public.print_devices where id = p_device_id for update;
  if not v_device.is_active then
    raise exception 'Esta impressora foi removida.' using errcode = 'PT409';
  end if;
  update public.print_devices set is_default = false
   where company_id = v_device.company_id and device_kind = 'label' and is_default and id <> v_device.id;
  update public.print_devices set is_default = true where id = v_device.id returning * into v_device;
  return v_device;
end;
$$;

-- Lista mínima para escolher a impressora de etiquetas ao imprimir (cashier/attendant não leem a tabela).
create function public.list_label_printers(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier', 'attendant') then
    raise exception 'Você não tem permissão para imprimir etiquetas.' using errcode = 'PT403';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', d.id, 'name', d.name, 'width_mm', d.label_width_mm, 'height_mm', d.label_height_mm,
      'gap_mm', d.label_gap_mm, 'columns', d.label_columns,
      'margin_x_mm', d.label_margin_x_mm, 'margin_y_mm', d.label_margin_y_mm,
      'is_default', d.is_default, 'is_ready', d.is_ready
    ) order by d.is_default desc, d.created_at, d.id)
    from public.print_devices d
    where d.company_id = p_company_id and d.device_kind = 'label' and d.is_active
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Enfileirar etiquetas (mesma fila print_jobs)
-- ---------------------------------------------------------------------------
-- Escolhe a impressora: a pedida (tem de ser etiqueta, ativa, pronta, da empresa) ou a padrão ou a única pronta.
create function public.print_resolve_label_device(p_company_id uuid, p_device_id uuid)
returns public.print_devices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.print_devices;
  v_ready integer;
begin
  if p_device_id is not null then
    select * into v_device from public.print_devices
     where id = p_device_id and company_id = p_company_id and device_kind = 'label' and is_active for share;
    if not found then
      raise exception 'Impressora de etiquetas não encontrada.' using errcode = 'PT404';
    end if;
    if not v_device.is_ready then
      raise exception 'A impressora de etiquetas ainda não está conectada ao Agente de Impressão.' using errcode = 'PT409';
    end if;
    return v_device;
  end if;

  select count(*) into v_ready from public.print_devices
   where company_id = p_company_id and device_kind = 'label' and is_active and is_ready;
  if v_ready = 0 then
    if exists (select 1 from public.print_devices where company_id = p_company_id and device_kind = 'label' and is_active) then
      raise exception 'A impressora de etiquetas ainda não está conectada ao Agente de Impressão.' using errcode = 'PT409';
    end if;
    raise exception 'Nenhuma impressora de etiquetas está configurada.' using errcode = 'PT409';
  end if;

  select * into v_device from public.print_devices
   where company_id = p_company_id and device_kind = 'label' and is_active and is_ready and is_default for share;
  if found then return v_device; end if;
  if v_ready = 1 then
    select * into v_device from public.print_devices
     where company_id = p_company_id and device_kind = 'label' and is_active and is_ready for share;
    return v_device;
  end if;
  raise exception 'Escolha a impressora de etiquetas.' using errcode = 'PT409';
end;
$$;

revoke execute on function public.print_resolve_label_device(uuid, uuid) from public, anon, authenticated;

create function public.label_printer_json(p_device public.print_devices)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select jsonb_build_object(
    'id', p_device.id, 'name', p_device.name, 'kind', 'label',
    'label', jsonb_build_object(
      'width_mm', p_device.label_width_mm, 'height_mm', p_device.label_height_mm, 'gap_mm', p_device.label_gap_mm,
      'columns', p_device.label_columns, 'margin_x_mm', p_device.label_margin_x_mm, 'margin_y_mm', p_device.label_margin_y_mm
    )
  );
$$;

revoke execute on function public.label_printer_json(public.print_devices) from public, anon, authenticated;

-- 'R$ 12,90'
create function public.label_price_text(p_price numeric)
returns text
language sql
stable
set search_path = public
as $$
  select 'R$ ' || replace(to_char(p_price, 'FM999999990.00'), '.', ',');
$$;

revoke execute on function public.label_price_text(numeric) from public, anon, authenticated;

-- EAN-13 válido (13 dígitos + dígito verificador GS1).
create function public.label_is_ean13(p_value text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
begin
  return p_value ~ '^[0-9]{13}$' and public.ean13_check_digit(substr(p_value, 1, 12)) = substr(p_value, 13, 1)::integer;
end;
$$;

revoke execute on function public.label_is_ean13(text) from public, anon, authenticated;

create function public.print_label_job(
  p_device public.print_devices, p_job_type text, p_quantity integer, p_label jsonb
)
returns public.print_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.print_jobs;
begin
  insert into public.print_jobs (company_id, print_device_id, job_type, payload, created_by)
  values (
    p_device.company_id, p_device.id, p_job_type,
    jsonb_build_object(
      'version', 1,
      'kind', p_job_type,
      'company', (select jsonb_build_object('id', c.id, 'name', c.name) from public.companies c where c.id = p_device.company_id),
      'printer', public.label_printer_json(p_device),
      'quantity', p_quantity,
      'label', p_label,
      'requested_at', now(),
      'operator', jsonb_build_object('name', public.print_actor_name(p_device.company_id, auth.uid()))
    ),
    auth.uid()
  )
  returning * into v_job;
  return v_job;
end;
$$;

revoke execute on function public.print_label_job(public.print_devices, text, integer, jsonb) from public, anon, authenticated;

-- Etiqueta de PRODUTO: nome/preço/código vêm do cadastro (não do cliente). owner/admin/cashier.
create function public.enqueue_product_labels(
  p_company_id uuid,
  p_product_id uuid,
  p_device_id uuid,
  p_quantity integer,
  p_show_name boolean default true,
  p_show_price boolean default true,
  p_show_barcode boolean default true,
  p_show_code boolean default false,
  p_show_company boolean default false
)
returns public.print_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_product public.products;
  v_device public.print_devices;
  v_label jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier') then
    raise exception 'Você não tem permissão para imprimir etiquetas de produtos.' using errcode = 'PT403';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 500 then
    raise exception 'A quantidade de etiquetas deve ser de 1 a 500.' using errcode = 'PT400';
  end if;
  if not (coalesce(p_show_name, false) or coalesce(p_show_price, false) or coalesce(p_show_barcode, false) or coalesce(p_show_code, false)) then
    raise exception 'Escolha pelo menos um item para aparecer na etiqueta.' using errcode = 'PT400';
  end if;

  select * into v_product from public.products where id = p_product_id and company_id = p_company_id;
  if not found then
    raise exception 'Produto não encontrado.' using errcode = 'PT404';
  end if;
  if not v_product.is_active then
    raise exception 'Este produto está inativo.' using errcode = 'PT409';
  end if;
  if coalesce(p_show_barcode, false) and v_product.barcode is null then
    raise exception 'Este produto não tem código de barras. Gere o código no cadastro do produto ou desmarque o código de barras.' using errcode = 'PT409';
  end if;

  v_device := public.print_resolve_label_device(p_company_id, p_device_id);

  v_label := jsonb_strip_nulls(jsonb_build_object(
    'header', case when coalesce(p_show_company, false) then (select name from public.companies where id = p_company_id) end,
    'title', case when coalesce(p_show_name, false) then v_product.name end,
    'price', case when coalesce(p_show_price, false) then public.label_price_text(v_product.sale_price) end,
    'barcode', case when coalesce(p_show_barcode, false) then jsonb_build_object(
        'value', v_product.barcode,
        'symbology', case when public.label_is_ean13(v_product.barcode) then 'ean13' else 'code128' end) end,
    'code_text', case when coalesce(p_show_code, false) then coalesce(v_product.barcode, v_product.code) end
  ));

  return public.print_label_job(v_device, 'label_product', p_quantity, v_label);
end;
$$;

-- Etiqueta LIVRE (sem vínculo com produto). owner/admin/cashier. Código de barras opcional.
-- p_barcode_type: auto (EAN-13 só se for válido, senão CODE128) | code128 | ean13 (exige EAN-13 válido).
create function public.enqueue_free_labels(
  p_company_id uuid,
  p_device_id uuid,
  p_quantity integer,
  p_title text default null,
  p_line1 text default null,
  p_line2 text default null,
  p_line3 text default null,
  p_price_text text default null,
  p_barcode text default null,
  p_barcode_type text default 'auto',
  p_extra text default null,
  p_show_company boolean default false
)
returns public.print_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_device public.print_devices;
  v_title text := nullif(btrim(coalesce(p_title, '')), '');
  v_l1 text := nullif(btrim(coalesce(p_line1, '')), '');
  v_l2 text := nullif(btrim(coalesce(p_line2, '')), '');
  v_l3 text := nullif(btrim(coalesce(p_line3, '')), '');
  v_price text := nullif(btrim(coalesce(p_price_text, '')), '');
  v_code text := nullif(btrim(coalesce(p_barcode, '')), '');
  v_extra text := nullif(btrim(coalesce(p_extra, '')), '');
  v_sym text;
  v_label jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier') then
    raise exception 'Você não tem permissão para imprimir etiquetas livres.' using errcode = 'PT403';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 500 then
    raise exception 'A quantidade de etiquetas deve ser de 1 a 500.' using errcode = 'PT400';
  end if;
  if char_length(coalesce(v_title, '')) > 60 or char_length(coalesce(v_l1, '')) > 60 or char_length(coalesce(v_l2, '')) > 60
     or char_length(coalesce(v_l3, '')) > 60 or char_length(coalesce(v_extra, '')) > 120 then
    raise exception 'Textos muito longos: título e linhas até 60 caracteres, texto adicional até 120.' using errcode = 'PT400';
  end if;
  if char_length(coalesce(v_price, '')) > 20 then
    raise exception 'O valor pode ter no máximo 20 caracteres.' using errcode = 'PT400';
  end if;
  if v_title is null and v_l1 is null and v_l2 is null and v_l3 is null and v_price is null and v_code is null and v_extra is null then
    raise exception 'Preencha pelo menos um campo da etiqueta.' using errcode = 'PT400';
  end if;

  if v_code is not null then
    if p_barcode_type is null or p_barcode_type not in ('auto', 'code128', 'ean13') then
      raise exception 'Tipo de código de barras inválido.' using errcode = 'PT400';
    end if;
    if v_code !~ '^[ -~]{1,40}$' then
      raise exception 'O código de barras aceita até 40 caracteres simples (letras, números e símbolos comuns).' using errcode = 'PT400';
    end if;
    if p_barcode_type = 'ean13' then
      if not public.label_is_ean13(v_code) then
        raise exception 'EAN-13 inválido: informe 13 dígitos com o dígito verificador correto.' using errcode = 'PT400';
      end if;
      v_sym := 'ean13';
    elsif p_barcode_type = 'code128' then
      v_sym := 'code128';
    else
      v_sym := case when public.label_is_ean13(v_code) then 'ean13' else 'code128' end;
    end if;
  end if;

  v_device := public.print_resolve_label_device(p_company_id, p_device_id);

  v_label := jsonb_strip_nulls(jsonb_build_object(
    'header', case when coalesce(p_show_company, false) then (select name from public.companies where id = p_company_id) end,
    'title', v_title,
    'lines', (select jsonb_agg(x) from unnest(array[v_l1, v_l2, v_l3]) x where x is not null),
    'price', v_price,
    'barcode', case when v_code is not null then jsonb_build_object('value', v_code, 'symbology', v_sym) end,
    'code_text', case when v_code is not null then v_code end,
    'footer', v_extra
  ));

  return public.print_label_job(v_device, 'label_free', p_quantity, v_label);
end;
$$;

-- Cartão de COMANDA ou MESA: usa o barcode já cadastrado do ponto (EAN-13 interno da empresa). Sem barcode, o código
-- (ex.: CMD005) vai como CODE128 — o painel já localiza o atendimento pelo código. owner/admin/cashier/attendant.
create function public.enqueue_service_point_labels(
  p_company_id uuid,
  p_service_point_id uuid,
  p_device_id uuid,
  p_quantity integer default 1,
  p_show_barcode boolean default true,
  p_show_code boolean default true,
  p_show_company boolean default false
)
returns public.print_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_point public.service_points;
  v_device public.print_devices;
  v_value text;
  v_label jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier', 'attendant') then
    raise exception 'Você não tem permissão para imprimir comandas e mesas.' using errcode = 'PT403';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 50 then
    raise exception 'A quantidade de etiquetas deve ser de 1 a 50.' using errcode = 'PT400';
  end if;

  select * into v_point from public.service_points where id = p_service_point_id and company_id = p_company_id;
  if not found then
    raise exception 'Comanda ou mesa não encontrada.' using errcode = 'PT404';
  end if;
  if not v_point.is_active then
    raise exception 'Esta comanda ou mesa está desativada.' using errcode = 'PT409';
  end if;

  v_device := public.print_resolve_label_device(p_company_id, p_device_id);
  v_value := coalesce(v_point.barcode, v_point.code);

  v_label := jsonb_strip_nulls(jsonb_build_object(
    'header', case when v_point.type = 'table' then 'MESA' else 'COMANDA' end,
    'title', regexp_replace(v_point.display_name, '^(comanda|mesa)[[:space:]]+', '', 'i'),
    'barcode', case when coalesce(p_show_barcode, true) then jsonb_build_object(
        'value', v_value,
        'symbology', case when public.label_is_ean13(v_value) then 'ean13' else 'code128' end,
        'source', case when v_point.barcode is not null then 'barcode' else 'code' end) end,
    'code_text', case when coalesce(p_show_code, true) then v_point.code end,
    'footer', case when coalesce(p_show_company, false) then (select name from public.companies where id = p_company_id) end,
    'big_title', true
  ));

  return public.print_label_job(v_device, 'label_service_point', p_quantity, v_label);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Teste de impressão de uma impressora de ETIQUETAS (mesma RPC do cupom, com ramo próprio)
-- ---------------------------------------------------------------------------
create or replace function public.enqueue_test_print(p_device_id uuid)
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

  if v_device.device_kind = 'label' then
    return public.print_label_job(v_device, 'label_free', 1, jsonb_build_object(
      'title', 'TESTE DE ETIQUETA',
      'lines', jsonb_build_array(v_device.name, v_device.label_width_mm::text || ' x ' || v_device.label_height_mm::text || ' mm'),
      'barcode', jsonb_build_object('value', 'TESTE123', 'symbology', 'code128'),
      'code_text', 'TESTE123'
    ));
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

-- ---------------------------------------------------------------------------
-- 6) Agente: devolve o tipo e a configuração de etiqueta (campos EXTRAS; agentes antigos os ignoram)
-- ---------------------------------------------------------------------------
create or replace function public.list_agent_print_devices(p_agent_id uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent public.print_agents;
begin
  v_agent := public.print_agent_auth(p_agent_id, p_token);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', d.id, 'name', d.name, 'paper_width', d.paper_width,
      'device_kind', d.device_kind,
      'label', case when d.device_kind = 'label' then (public.label_printer_json(d))->'label' end,
      'windows_printer_name', d.windows_printer_name,
      'escpos_codepage', d.escpos_codepage, 'cut_mode', d.cut_mode,
      'is_ready', d.is_ready,
      'bound_to_me', d.agent_id = v_agent.id,
      'bound_to_other', d.agent_id is not null and d.agent_id <> v_agent.id,
      'full_order', exists (select 1 from public.print_device_routes r where r.print_device_id = d.id and r.route_type = 'full_order'),
      'sectors', coalesce((select jsonb_agg(s.name order by s.name) from public.print_device_routes r
                           join public.production_sectors s on s.company_id = r.company_id and s.id = r.production_sector_id
                           where r.print_device_id = d.id and r.route_type = 'production_sector'), '[]'::jsonb),
      'documents', coalesce((select jsonb_agg(r.route_type order by r.route_type) from public.print_device_routes r
                             where r.print_device_id = d.id and r.route_type in ('customer_bill', 'payment_receipt', 'cash_closing')), '[]'::jsonb)
    ) order by d.created_at, d.id)
    from public.print_devices d
    where d.company_id = v_agent.company_id and d.is_active
  ), '[]'::jsonb);
end;
$$;

-- Capacidades do Agente: agentes ANTIGOS chamam com 3 argumentos (p_capabilities = {}) e não imprimem etiquetas; em vez de
-- receber um job que não entendem (e deixá-lo preso até o timeout), os jobs de etiqueta destinados a eles FALHAM aqui,
-- com mensagem clara e visível na fila. O agente novo envia p_capabilities = {labels}.
drop function public.claim_print_jobs(uuid, text, integer);

create function public.claim_print_jobs(p_agent_id uuid, p_token text, p_limit integer default 5, p_capabilities text[] default '{}')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent public.print_agents;
  v_limit integer := least(greatest(coalesce(p_limit, 5), 1), 10);
  v_result jsonb;
begin
  v_agent := public.print_agent_auth(p_agent_id, p_token);
  update public.print_agents set last_seen_at = now() where id = v_agent.id;

  -- Claim esquecido por ESTE agente: não volta para a fila (evita impressão dupla); vira erro visível.
  update public.print_jobs
     set status = 'error',
         error_message = 'Tempo de impressão esgotado. Confira se o papel saiu antes de reimprimir.'
   where company_id = v_agent.company_id
     and claimed_by_agent_id = v_agent.id
     and status = 'claimed'
     and claimed_at < now() - public.print_claim_timeout();

  if not ('labels' = any(coalesce(p_capabilities, '{}'))) then
    update public.print_jobs j
       set status = 'error',
           error_message = 'Este Agente de Impressão não imprime etiquetas. Atualize o Agente de Impressão neste computador e reimprima.'
      from public.print_devices d
     where j.company_id = v_agent.company_id
       and j.status = 'pending'
       and j.job_type in ('label_product', 'label_free', 'label_service_point')
       and d.company_id = j.company_id and d.id = j.print_device_id
       and d.agent_id = v_agent.id;
  end if;

  with picked as (
    select j.id
    from public.print_jobs j
    join public.print_devices d on d.company_id = j.company_id and d.id = j.print_device_id
    where j.company_id = v_agent.company_id
      and j.status = 'pending'
      and d.agent_id = v_agent.id
      and d.is_ready
    order by j.created_at, j.id
    limit v_limit
    for update of j skip locked
  ), upd as (
    update public.print_jobs j
       set status = 'claimed', attempts = j.attempts + 1, claimed_at = now(),
           claimed_by_agent_id = v_agent.id, error_message = null
      from picked
     where j.id = picked.id
    returning j.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', u.id, 'job_type', u.job_type, 'attempts', u.attempts, 'created_at', u.created_at,
           'reprint_of_id', u.reprint_of_id, 'payload', u.payload,
           'print_device_id', d.id, 'device_name', d.name, 'paper_width', d.paper_width,
           'device_kind', d.device_kind,
           'label', case when d.device_kind = 'label' then (public.label_printer_json(d))->'label' end,
           'windows_printer_name', d.windows_printer_name,
           'escpos_profile', d.escpos_profile, 'escpos_codepage', d.escpos_codepage, 'cut_mode', d.cut_mode
         ) order by u.created_at, u.id), '[]'::jsonb)
    into v_result
  from upd u
  join public.print_devices d on d.company_id = u.company_id and d.id = u.print_device_id;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) ACL (só usuário logado; cada função valida o papel por dentro)
-- ---------------------------------------------------------------------------
revoke execute on function public.claim_print_jobs(uuid, text, integer, text[]) from public;
grant execute on function public.claim_print_jobs(uuid, text, integer, text[]) to anon, authenticated, service_role;
revoke execute on function public.create_label_printer(uuid, text, numeric, numeric, numeric, integer, numeric, numeric, boolean) from public, anon;
grant execute on function public.create_label_printer(uuid, text, numeric, numeric, numeric, integer, numeric, numeric, boolean) to authenticated;
revoke execute on function public.update_label_printer(uuid, text, numeric, numeric, numeric, integer, numeric, numeric, boolean) from public, anon;
grant execute on function public.update_label_printer(uuid, text, numeric, numeric, numeric, integer, numeric, numeric, boolean) to authenticated;
revoke execute on function public.set_default_label_printer(uuid) from public, anon;
grant execute on function public.set_default_label_printer(uuid) to authenticated;
revoke execute on function public.list_label_printers(uuid) from public, anon;
grant execute on function public.list_label_printers(uuid) to authenticated;
revoke execute on function public.enqueue_product_labels(uuid, uuid, uuid, integer, boolean, boolean, boolean, boolean, boolean) from public, anon;
grant execute on function public.enqueue_product_labels(uuid, uuid, uuid, integer, boolean, boolean, boolean, boolean, boolean) to authenticated;
revoke execute on function public.enqueue_free_labels(uuid, uuid, integer, text, text, text, text, text, text, text, text, boolean) from public, anon;
grant execute on function public.enqueue_free_labels(uuid, uuid, integer, text, text, text, text, text, text, text, text, boolean) to authenticated;
revoke execute on function public.enqueue_service_point_labels(uuid, uuid, uuid, integer, boolean, boolean, boolean) from public, anon;
grant execute on function public.enqueue_service_point_labels(uuid, uuid, uuid, integer, boolean, boolean, boolean) to authenticated;

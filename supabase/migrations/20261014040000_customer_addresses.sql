-- Módulo Delivery, Fase 1 — M5: ENDEREÇOS DO CLIENTE (customer_addresses) + barreiras de papel/módulo do Delivery.
-- Nenhuma migration anterior é alterada. O módulo 'delivery' segue is_active=false no catálogo: sem entitlement,
-- NENHUMA leitura nem RPC daqui funciona (empresa em trial/unmanaged só enxerga o módulo quando ele for ativado).
--
--   1. delivery_assert_operator / delivery_assert_admin: helpers internos (sem EXECUTE para o cliente).
--        operador  = owner, admin, cashier, attendant   (lançam pedido; consultam endereço/zona/configuração)
--        gestor    = owner, admin                       (cadastram zona e configuração)
--      production e courier ficam de fora. Ordem: sessão -> vínculo ativo na empresa (PT404) -> papel (PT403)
--      -> módulo (assert_company_module, PT403).
--   2. customer_addresses: vários endereços por cliente. FK COMPOSTA (company_id, customer_id) ->
--      customers(company_id, id): um endereço nunca aponta para cliente de outra empresa, nem por escrita direta.
--   3. RLS: leitura só de operador da empresa COM o módulo (company_has_module_rls). Sem INSERT/UPDATE/DELETE direto:
--      escrita só pelas RPCs (SECURITY DEFINER, search_path fixo). Nunca se apaga: is_active.
--   4. RPCs (company_id resolvido a partir do cliente/endereço — o cliente da API não envia empresa):
--      list_customer_addresses, create_customer_address, update_customer_address, set_customer_address_active.
-- Normalização (sem ViaCEP/mapas): espaços aparados e colapsados; CEP só dígitos (8); UF em maiúsculas e válida;
-- latitude/longitude opcionais, só em par, sem uso nesta fase.

-- ---------------------------------------------------------------------------
-- 1) Barreiras de papel + módulo
-- ---------------------------------------------------------------------------
create function public.delivery_assert_operator(p_company_id uuid)
returns public.company_role
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
    raise exception 'Você não tem permissão para usar o Delivery.' using errcode = 'PT403';
  end if;
  perform public.assert_company_module(p_company_id, 'delivery');
  return v_role;
end;
$$;

create function public.delivery_assert_admin(p_company_id uuid)
returns public.company_role
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
  if v_role not in ('owner', 'admin') then
    raise exception 'Apenas owner ou admin podem configurar o Delivery.' using errcode = 'PT403';
  end if;
  perform public.assert_company_module(p_company_id, 'delivery');
  return v_role;
end;
$$;

revoke execute on function public.delivery_assert_operator(uuid) from public, anon, authenticated;
revoke execute on function public.delivery_assert_admin(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) Tabela
-- ---------------------------------------------------------------------------
create table public.customer_addresses (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  customer_id uuid not null,
  label text
    constraint customer_addresses_label_length check (label is null or char_length(label) between 1 and 30),
  cep text
    constraint customer_addresses_cep_format check (cep is null or cep ~ '^[0-9]{8}$'),
  street text not null
    constraint customer_addresses_street_length check (char_length(street) between 1 and 120),
  number text
    constraint customer_addresses_number_length check (number is null or char_length(number) between 1 and 20),
  complement text
    constraint customer_addresses_complement_length check (complement is null or char_length(complement) between 1 and 60),
  neighborhood text not null
    constraint customer_addresses_neighborhood_length check (char_length(neighborhood) between 1 and 80),
  city text not null
    constraint customer_addresses_city_length check (char_length(city) between 1 and 80),
  state text not null
    constraint customer_addresses_state_format check (state ~ '^[A-Z]{2}$'),
  reference text
    constraint customer_addresses_reference_length check (reference is null or char_length(reference) between 1 and 120),
  latitude numeric(9, 6)
    constraint customer_addresses_latitude_range check (latitude is null or latitude between -90 and 90),
  longitude numeric(9, 6)
    constraint customer_addresses_longitude_range check (longitude is null or longitude between -180 and 180),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_addresses_latlng_pair check ((latitude is null) = (longitude is null)),
  -- O cliente tem de ser da MESMA empresa. NO ACTION (padrão): excluir a empresa leva clientes e endereços na cascata.
  constraint customer_addresses_customer_fkey
    foreign key (company_id, customer_id) references public.customers (company_id, id),
  -- alvo de futura FK composta (snapshot/pedido de delivery)
  constraint customer_addresses_company_id_id_key unique (company_id, id)
);

create index customer_addresses_customer_idx
  on public.customer_addresses (company_id, customer_id, is_active);

comment on table public.customer_addresses is
  'Endereços de entrega do cliente (módulo Delivery). Escrita só por RPC. O pedido de delivery guardará SNAPSHOT do endereço (bloco futuro): editar aqui nunca muda pedido antigo.';

create trigger customer_addresses_set_updated_at
  before update on public.customer_addresses
  for each row execute function public.set_updated_at();

create function public.guard_customer_address_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is distinct from old.company_id
     or new.customer_id is distinct from old.customer_id
     or new.created_at is distinct from old.created_at then
    raise exception 'Empresa e cliente de um endereço não podem ser alterados.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_customer_address_change() from public, anon, authenticated;

create trigger customer_addresses_guard_change
  before update on public.customer_addresses
  for each row execute function public.guard_customer_address_change();

-- ---------------------------------------------------------------------------
-- 3) RLS / GRANTs: leitura de operador COM módulo; nenhuma escrita direta
-- ---------------------------------------------------------------------------
alter table public.customer_addresses enable row level security;

create policy customer_addresses_select on public.customer_addresses
  for select to authenticated
  using (
    public.company_has_module_rls(company_id, 'delivery')
    and public.user_role_in_company(company_id) in ('owner', 'admin', 'cashier', 'attendant')
  );

revoke all on public.customer_addresses from public, anon, authenticated;
grant select on public.customer_addresses to authenticated;
grant all on public.customer_addresses to service_role;

-- ---------------------------------------------------------------------------
-- 4) Normalização/validação (helper interno)
-- ---------------------------------------------------------------------------
create function public.delivery_clean_address(
  p_label text, p_cep text, p_street text, p_number text, p_complement text,
  p_neighborhood text, p_city text, p_state text, p_reference text,
  p_latitude numeric, p_longitude numeric
)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  v_label text := nullif(btrim(regexp_replace(coalesce(p_label, ''), '\s+', ' ', 'g')), '');
  v_cep text := nullif(regexp_replace(coalesce(p_cep, ''), '\D', '', 'g'), '');
  v_street text := nullif(btrim(regexp_replace(coalesce(p_street, ''), '\s+', ' ', 'g')), '');
  v_number text := nullif(btrim(regexp_replace(coalesce(p_number, ''), '\s+', ' ', 'g')), '');
  v_comp text := nullif(btrim(regexp_replace(coalesce(p_complement, ''), '\s+', ' ', 'g')), '');
  v_neigh text := nullif(btrim(regexp_replace(coalesce(p_neighborhood, ''), '\s+', ' ', 'g')), '');
  v_city text := nullif(btrim(regexp_replace(coalesce(p_city, ''), '\s+', ' ', 'g')), '');
  v_state text := nullif(upper(btrim(coalesce(p_state, ''))), '');
  v_ref text := nullif(btrim(regexp_replace(coalesce(p_reference, ''), '\s+', ' ', 'g')), '');
begin
  if v_street is null then raise exception 'Informe a rua.' using errcode = 'PT400'; end if;
  if v_neigh is null then raise exception 'Informe o bairro.' using errcode = 'PT400'; end if;
  if v_city is null then raise exception 'Informe a cidade.' using errcode = 'PT400'; end if;
  if v_state is null then raise exception 'Informe o estado (UF).' using errcode = 'PT400'; end if;
  if v_state not in ('AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO') then
    raise exception 'Estado (UF) inválido.' using errcode = 'PT400';
  end if;
  if v_cep is not null and char_length(v_cep) <> 8 then
    raise exception 'CEP inválido. Informe os 8 dígitos.' using errcode = 'PT400';
  end if;
  if char_length(v_street) > 120 then raise exception 'A rua pode ter no máximo 120 caracteres.' using errcode = 'PT400'; end if;
  if v_number is not null and char_length(v_number) > 20 then raise exception 'O número pode ter no máximo 20 caracteres.' using errcode = 'PT400'; end if;
  if v_comp is not null and char_length(v_comp) > 60 then raise exception 'O complemento pode ter no máximo 60 caracteres.' using errcode = 'PT400'; end if;
  if char_length(v_neigh) > 80 then raise exception 'O bairro pode ter no máximo 80 caracteres.' using errcode = 'PT400'; end if;
  if char_length(v_city) > 80 then raise exception 'A cidade pode ter no máximo 80 caracteres.' using errcode = 'PT400'; end if;
  if v_label is not null and char_length(v_label) > 30 then raise exception 'O apelido pode ter no máximo 30 caracteres.' using errcode = 'PT400'; end if;
  if v_ref is not null and char_length(v_ref) > 120 then raise exception 'A referência pode ter no máximo 120 caracteres.' using errcode = 'PT400'; end if;
  if (p_latitude is null) <> (p_longitude is null) then
    raise exception 'Informe latitude e longitude juntas.' using errcode = 'PT400';
  end if;
  if p_latitude is not null and (p_latitude not between -90 and 90 or p_longitude not between -180 and 180) then
    raise exception 'Coordenadas inválidas.' using errcode = 'PT400';
  end if;

  return jsonb_build_object(
    'label', v_label, 'cep', v_cep, 'street', v_street, 'number', v_number, 'complement', v_comp,
    'neighborhood', v_neigh, 'city', v_city, 'state', v_state, 'reference', v_ref,
    'latitude', p_latitude, 'longitude', p_longitude
  );
end;
$$;

revoke execute on function public.delivery_clean_address(text, text, text, text, text, text, text, text, text, numeric, numeric)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5) RPCs
-- ---------------------------------------------------------------------------
-- Lista os endereços de um cliente (ativos por padrão). A empresa vem do cliente; o chamador precisa ser operador dela.
create function public.list_customer_addresses(p_customer_id uuid, p_include_inactive boolean default false)
returns setof public.customer_addresses
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company uuid;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select c.company_id into v_company from public.customers c where c.id = p_customer_id;
  if v_company is null then
    raise exception 'Cliente não encontrado.' using errcode = 'PT404';
  end if;
  perform public.delivery_assert_operator(v_company);

  return query
    select a.*
    from public.customer_addresses a
    where a.company_id = v_company
      and a.customer_id = p_customer_id
      and (coalesce(p_include_inactive, false) or a.is_active)
    order by a.is_active desc, a.created_at, a.id;
end;
$$;

create function public.create_customer_address(
  p_customer_id uuid,
  p_street text,
  p_neighborhood text,
  p_city text,
  p_state text,
  p_number text default null,
  p_complement text default null,
  p_cep text default null,
  p_label text default null,
  p_reference text default null,
  p_latitude numeric default null,
  p_longitude numeric default null
)
returns public.customer_addresses
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer public.customers;
  v_clean jsonb;
  v_row public.customer_addresses;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  -- trava o cliente: duas criações simultâneas respeitam o teto de endereços
  select * into v_customer from public.customers where id = p_customer_id for update;
  if not found then
    raise exception 'Cliente não encontrado.' using errcode = 'PT404';
  end if;
  perform public.delivery_assert_operator(v_customer.company_id);
  if not v_customer.is_active then
    raise exception 'Este cliente está inativo.' using errcode = 'PT409';
  end if;

  v_clean := public.delivery_clean_address(p_label, p_cep, p_street, p_number, p_complement, p_neighborhood, p_city, p_state, p_reference, p_latitude, p_longitude);

  if (select count(*) from public.customer_addresses a where a.company_id = v_customer.company_id and a.customer_id = v_customer.id) >= 30 then
    raise exception 'Este cliente já tem o máximo de 30 endereços. Desative algum.' using errcode = 'PT409';
  end if;

  insert into public.customer_addresses (
    company_id, customer_id, label, cep, street, number, complement, neighborhood, city, state, reference, latitude, longitude
  ) values (
    v_customer.company_id, v_customer.id,
    v_clean ->> 'label', v_clean ->> 'cep', v_clean ->> 'street', v_clean ->> 'number', v_clean ->> 'complement',
    v_clean ->> 'neighborhood', v_clean ->> 'city', v_clean ->> 'state', v_clean ->> 'reference',
    (v_clean ->> 'latitude')::numeric, (v_clean ->> 'longitude')::numeric
  ) returning * into v_row;

  return v_row;
end;
$$;

create function public.update_customer_address(
  p_address_id uuid,
  p_street text,
  p_neighborhood text,
  p_city text,
  p_state text,
  p_number text default null,
  p_complement text default null,
  p_cep text default null,
  p_label text default null,
  p_reference text default null,
  p_latitude numeric default null,
  p_longitude numeric default null
)
returns public.customer_addresses
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.customer_addresses;
  v_clean jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_row from public.customer_addresses where id = p_address_id for update;
  if not found then
    raise exception 'Endereço não encontrado.' using errcode = 'PT404';
  end if;
  perform public.delivery_assert_operator(v_row.company_id);

  v_clean := public.delivery_clean_address(p_label, p_cep, p_street, p_number, p_complement, p_neighborhood, p_city, p_state, p_reference, p_latitude, p_longitude);

  update public.customer_addresses
     set label = v_clean ->> 'label', cep = v_clean ->> 'cep', street = v_clean ->> 'street',
         number = v_clean ->> 'number', complement = v_clean ->> 'complement',
         neighborhood = v_clean ->> 'neighborhood', city = v_clean ->> 'city', state = v_clean ->> 'state',
         reference = v_clean ->> 'reference',
         latitude = (v_clean ->> 'latitude')::numeric, longitude = (v_clean ->> 'longitude')::numeric
   where id = v_row.id
   returning * into v_row;

  return v_row;
end;
$$;

create function public.set_customer_address_active(p_address_id uuid, p_active boolean)
returns public.customer_addresses
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.customer_addresses;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if p_active is null then
    raise exception 'Informe se o endereço fica ativo.' using errcode = 'PT400';
  end if;
  select * into v_row from public.customer_addresses where id = p_address_id for update;
  if not found then
    raise exception 'Endereço não encontrado.' using errcode = 'PT404';
  end if;
  perform public.delivery_assert_operator(v_row.company_id);

  update public.customer_addresses set is_active = p_active where id = v_row.id returning * into v_row;
  return v_row;
end;
$$;

revoke execute on function public.list_customer_addresses(uuid, boolean) from public, anon;
revoke execute on function public.create_customer_address(uuid, text, text, text, text, text, text, text, text, text, numeric, numeric) from public, anon;
revoke execute on function public.update_customer_address(uuid, text, text, text, text, text, text, text, text, text, numeric, numeric) from public, anon;
revoke execute on function public.set_customer_address_active(uuid, boolean) from public, anon;
grant execute on function public.list_customer_addresses(uuid, boolean) to authenticated;
grant execute on function public.create_customer_address(uuid, text, text, text, text, text, text, text, text, text, numeric, numeric) to authenticated;
grant execute on function public.update_customer_address(uuid, text, text, text, text, text, text, text, text, text, numeric, numeric) to authenticated;
grant execute on function public.set_customer_address_active(uuid, boolean) to authenticated;

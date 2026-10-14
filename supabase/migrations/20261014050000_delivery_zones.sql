-- Módulo Delivery, Fase 1 — M6: ZONAS DE ENTREGA (taxa e previsão por cidade + bairro).
-- Mesmas regras de M5: sem entitlement 'delivery' nada funciona; leitura de operador (owner/admin/cashier/attendant);
-- escrita só owner/admin e só por RPC; nunca se apaga (is_active).
--
-- Normalização (sem extensão nova): delivery_norm_text() = sem acento, minúsculas, espaços colapsados e aparados.
-- A unicidade é por (empresa, cidade normalizada, bairro normalizado), em colunas geradas — "Centro", "centro" e
-- " CENTRO " (ou "São Paulo"/"Sao Paulo") são a MESMA zona. O campo name é só rótulo comercial. Uma zona desativada
-- continua ocupando a chave: reative-a em vez de recriar (preserva o histórico).
--
-- Resolução de taxa (resolve_delivery_zone): só zona ATIVA da MESMA empresa, match normalizado; sem zona devolve
-- found=false com taxa NULL — nunca inventa valor. A decisão final (zona > taxa padrão > ajuste manual) é do
-- pedido, bloco futuro; o cálculo pronto está em resolve_delivery_quote (migration 20261014060000).

create function public.delivery_norm_text(p_text text)
returns text
language sql
immutable
set search_path = public
as $$
  select btrim(regexp_replace(
    translate(lower(coalesce(p_text, '')), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn'),
    '\s+', ' ', 'g'));
$$;

revoke execute on function public.delivery_norm_text(text) from public, anon, authenticated;
grant execute on function public.delivery_norm_text(text) to service_role;

create table public.delivery_zones (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null
    constraint delivery_zones_name_length check (char_length(name) between 1 and 60),
  neighborhood text not null
    constraint delivery_zones_neighborhood_length check (char_length(neighborhood) between 1 and 80),
  city text not null
    constraint delivery_zones_city_length check (char_length(city) between 1 and 80),
  fee numeric(12, 2) not null
    constraint delivery_zones_fee_check check (fee >= 0 and fee <> 'NaN'::numeric),
  estimated_minutes integer
    constraint delivery_zones_minutes_check check (estimated_minutes is null or estimated_minutes between 1 and 1440),
  is_active boolean not null default true,
  neighborhood_key text generated always as (public.delivery_norm_text(neighborhood)) stored,
  city_key text generated always as (public.delivery_norm_text(city)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint delivery_zones_company_area_key unique (company_id, city_key, neighborhood_key),
  constraint delivery_zones_company_id_id_key unique (company_id, id)
);

comment on table public.delivery_zones is
  'Zonas de entrega (taxa e previsão por cidade+bairro normalizados). Escrita só por RPC (owner/admin).';

create trigger delivery_zones_set_updated_at
  before update on public.delivery_zones
  for each row execute function public.set_updated_at();

create function public.guard_delivery_zone_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is distinct from old.company_id or new.created_at is distinct from old.created_at then
    raise exception 'A empresa de uma zona não pode ser alterada.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_delivery_zone_change() from public, anon, authenticated;

create trigger delivery_zones_guard_change
  before update on public.delivery_zones
  for each row execute function public.guard_delivery_zone_change();

alter table public.delivery_zones enable row level security;

create policy delivery_zones_select on public.delivery_zones
  for select to authenticated
  using (
    public.company_has_module_rls(company_id, 'delivery')
    and public.user_role_in_company(company_id) in ('owner', 'admin', 'cashier', 'attendant')
  );

revoke all on public.delivery_zones from public, anon, authenticated;
grant select on public.delivery_zones to authenticated;
grant all on public.delivery_zones to service_role;

-- Validação/limpeza dos campos de zona (helper interno).
create function public.delivery_clean_zone(p_name text, p_neighborhood text, p_city text, p_fee numeric, p_minutes integer)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  v_name text := nullif(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), '');
  v_neigh text := nullif(btrim(regexp_replace(coalesce(p_neighborhood, ''), '\s+', ' ', 'g')), '');
  v_city text := nullif(btrim(regexp_replace(coalesce(p_city, ''), '\s+', ' ', 'g')), '');
begin
  if v_neigh is null then raise exception 'Informe o bairro.' using errcode = 'PT400'; end if;
  if v_city is null then raise exception 'Informe a cidade.' using errcode = 'PT400'; end if;
  -- sem nome, o rótulo é o próprio bairro
  v_name := coalesce(v_name, v_neigh);
  if char_length(v_name) > 60 then raise exception 'O nome da zona pode ter no máximo 60 caracteres.' using errcode = 'PT400'; end if;
  if char_length(v_neigh) > 80 then raise exception 'O bairro pode ter no máximo 80 caracteres.' using errcode = 'PT400'; end if;
  if char_length(v_city) > 80 then raise exception 'A cidade pode ter no máximo 80 caracteres.' using errcode = 'PT400'; end if;
  if p_fee is null or p_fee < 0 or p_fee >= 100000 or p_fee <> round(p_fee, 2) then
    raise exception 'Informe uma taxa de zero ou mais, com até 2 casas decimais.' using errcode = 'PT400';
  end if;
  if p_minutes is not null and (p_minutes < 1 or p_minutes > 1440) then
    raise exception 'A previsão deve ficar entre 1 e 1440 minutos.' using errcode = 'PT400';
  end if;
  return jsonb_build_object('name', v_name, 'neighborhood', v_neigh, 'city', v_city, 'fee', p_fee, 'minutes', p_minutes);
end;
$$;

revoke execute on function public.delivery_clean_zone(text, text, text, numeric, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RPCs (empresa explícita, SEMPRE validada pelo vínculo ativo do chamador)
-- ---------------------------------------------------------------------------
create function public.list_delivery_zones(p_company_id uuid, p_include_inactive boolean default false)
returns setof public.delivery_zones
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.delivery_assert_operator(p_company_id);
  return query
    select z.*
    from public.delivery_zones z
    where z.company_id = p_company_id
      and (coalesce(p_include_inactive, false) or z.is_active)
    order by z.city_key, z.neighborhood_key;
end;
$$;

create function public.create_delivery_zone(
  p_company_id uuid,
  p_neighborhood text,
  p_city text,
  p_fee numeric,
  p_estimated_minutes integer default null,
  p_name text default null
)
returns public.delivery_zones
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clean jsonb;
  v_row public.delivery_zones;
begin
  perform public.delivery_assert_admin(p_company_id);
  v_clean := public.delivery_clean_zone(p_name, p_neighborhood, p_city, p_fee, p_estimated_minutes);

  begin
    insert into public.delivery_zones (company_id, name, neighborhood, city, fee, estimated_minutes)
    values (p_company_id, v_clean ->> 'name', v_clean ->> 'neighborhood', v_clean ->> 'city',
            (v_clean ->> 'fee')::numeric, (v_clean ->> 'minutes')::integer)
    returning * into v_row;
  exception when unique_violation then
    raise exception 'Já existe uma zona para este bairro e cidade.' using errcode = 'PT409';
  end;
  return v_row;
end;
$$;

create function public.update_delivery_zone(
  p_zone_id uuid,
  p_neighborhood text,
  p_city text,
  p_fee numeric,
  p_estimated_minutes integer default null,
  p_name text default null
)
returns public.delivery_zones
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.delivery_zones;
  v_clean jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_row from public.delivery_zones where id = p_zone_id;
  if not found then
    raise exception 'Zona não encontrada.' using errcode = 'PT404';
  end if;
  perform public.delivery_assert_admin(v_row.company_id);
  v_clean := public.delivery_clean_zone(p_name, p_neighborhood, p_city, p_fee, p_estimated_minutes);

  begin
    update public.delivery_zones
       set name = v_clean ->> 'name', neighborhood = v_clean ->> 'neighborhood', city = v_clean ->> 'city',
           fee = (v_clean ->> 'fee')::numeric, estimated_minutes = (v_clean ->> 'minutes')::integer
     where id = v_row.id
     returning * into v_row;
  exception when unique_violation then
    raise exception 'Já existe uma zona para este bairro e cidade.' using errcode = 'PT409';
  end;
  return v_row;
end;
$$;

create function public.set_delivery_zone_active(p_zone_id uuid, p_active boolean)
returns public.delivery_zones
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.delivery_zones;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if p_active is null then
    raise exception 'Informe se a zona fica ativa.' using errcode = 'PT400';
  end if;
  select * into v_row from public.delivery_zones where id = p_zone_id;
  if not found then
    raise exception 'Zona não encontrada.' using errcode = 'PT404';
  end if;
  perform public.delivery_assert_admin(v_row.company_id);
  update public.delivery_zones set is_active = p_active where id = v_row.id returning * into v_row;
  return v_row;
end;
$$;

-- Resolve cidade+bairro -> zona ATIVA. Ausência controlada: found=false e demais campos NULL (nunca inventa taxa).
create function public.resolve_delivery_zone(p_company_id uuid, p_city text, p_neighborhood text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_zone public.delivery_zones;
begin
  perform public.delivery_assert_operator(p_company_id);

  select * into v_zone
  from public.delivery_zones z
  where z.company_id = p_company_id
    and z.is_active
    and z.city_key = public.delivery_norm_text(p_city)
    and z.neighborhood_key = public.delivery_norm_text(p_neighborhood);

  if not found then
    return jsonb_build_object('found', false, 'zone_id', null, 'name', null, 'fee', null, 'estimated_minutes', null);
  end if;
  return jsonb_build_object('found', true, 'zone_id', v_zone.id, 'name', v_zone.name, 'fee', v_zone.fee,
                            'estimated_minutes', v_zone.estimated_minutes);
end;
$$;

revoke execute on function public.list_delivery_zones(uuid, boolean) from public, anon;
revoke execute on function public.create_delivery_zone(uuid, text, text, numeric, integer, text) from public, anon;
revoke execute on function public.update_delivery_zone(uuid, text, text, numeric, integer, text) from public, anon;
revoke execute on function public.set_delivery_zone_active(uuid, boolean) from public, anon;
revoke execute on function public.resolve_delivery_zone(uuid, text, text) from public, anon;
grant execute on function public.list_delivery_zones(uuid, boolean) to authenticated;
grant execute on function public.create_delivery_zone(uuid, text, text, numeric, integer, text) to authenticated;
grant execute on function public.update_delivery_zone(uuid, text, text, numeric, integer, text) to authenticated;
grant execute on function public.set_delivery_zone_active(uuid, boolean) to authenticated;
grant execute on function public.resolve_delivery_zone(uuid, text, text) to authenticated;

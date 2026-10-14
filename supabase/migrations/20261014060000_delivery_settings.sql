-- Módulo Delivery, Fase 1 — M7: CONFIGURAÇÕES DO DELIVERY (company_delivery_settings) + resolução de taxa/previsão.
-- Tabela PRÓPRIA do módulo (não mistura com company_operational_settings).
--
-- Primeiro acesso: LAZY. Nenhuma linha é criada para empresa alguma enquanto o módulo está inativo (nem no
-- backfill, nem por trigger de empresa nova). get_delivery_settings devolve os DEFAULTS calculados quando não há
-- linha (configured=false) — sem INSERT em leitura. A linha nasce na primeira escrita autorizada
-- (update_delivery_settings, owner/admin, com o módulo contratado).
--
-- Quem pode o quê (igual às zonas): ler = owner/admin/cashier/attendant com o módulo; escrever = owner/admin com o
-- módulo; só por RPC. Sem módulo, tudo é recusado (PT403) e a RLS esconde a linha — os dados nunca são apagados.
--
-- REGRA DE TAXA (resolve_delivery_quote, só dados; o pedido vem em bloco futuro):
--   1. zona ATIVA para cidade+bairro  -> fee = zona.fee                       (fee_source 'zone')
--   2. senão, default_fee configurada -> fee = default_fee                    (fee_source 'default')
--   3. senão                          -> fee NULL, fee_source 'none' (nunca inventa taxa; o pedido decidirá se
--                                        exige ajuste manual, conforme allow_manual_fee)
--   Retirada: fee 0, fee_source 'pickup'.
-- REGRA DE PREVISÃO: entrega = zona.estimated_minutes, senão delivery_minutes; retirada = pickup_minutes.

create table public.company_delivery_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  delivery_enabled boolean not null default true,
  pickup_enabled boolean not null default true,
  delivery_minutes integer not null default 45
    constraint company_delivery_settings_delivery_minutes_check check (delivery_minutes between 1 and 1440),
  pickup_minutes integer not null default 30
    constraint company_delivery_settings_pickup_minutes_check check (pickup_minutes between 1 and 1440),
  default_fee numeric(12, 2)
    constraint company_delivery_settings_default_fee_check check (default_fee is null or (default_fee >= 0 and default_fee <> 'NaN'::numeric)),
  allow_manual_fee boolean not null default true,
  default_instructions text
    constraint company_delivery_settings_instructions_length check (default_instructions is null or char_length(default_instructions) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.company_delivery_settings is
  'Configuração do módulo Delivery (1 linha por empresa, criada na primeira escrita autorizada). Sem linha = defaults calculados por get_delivery_settings.';

create trigger company_delivery_settings_set_updated_at
  before update on public.company_delivery_settings
  for each row execute function public.set_updated_at();

alter table public.company_delivery_settings enable row level security;

create policy company_delivery_settings_select on public.company_delivery_settings
  for select to authenticated
  using (
    public.company_has_module_rls(company_id, 'delivery')
    and public.user_role_in_company(company_id) in ('owner', 'admin', 'cashier', 'attendant')
  );

revoke all on public.company_delivery_settings from public, anon, authenticated;
grant select on public.company_delivery_settings to authenticated;
grant all on public.company_delivery_settings to service_role;

-- Configuração EFETIVA (linha ou defaults) — helper interno, sem checagem de papel (quem chama já validou).
create function public.delivery_settings_effective(p_company_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select jsonb_build_object(
        'configured', true,
        'delivery_enabled', s.delivery_enabled, 'pickup_enabled', s.pickup_enabled,
        'delivery_minutes', s.delivery_minutes, 'pickup_minutes', s.pickup_minutes,
        'default_fee', s.default_fee, 'allow_manual_fee', s.allow_manual_fee,
        'default_instructions', s.default_instructions)
     from public.company_delivery_settings s where s.company_id = p_company_id),
    jsonb_build_object(
      'configured', false,
      'delivery_enabled', true, 'pickup_enabled', true,
      'delivery_minutes', 45, 'pickup_minutes', 30,
      'default_fee', null, 'allow_manual_fee', true, 'default_instructions', null)
  );
$$;

revoke execute on function public.delivery_settings_effective(uuid) from public, anon, authenticated;

create function public.get_delivery_settings(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.delivery_assert_operator(p_company_id);
  return public.delivery_settings_effective(p_company_id);
end;
$$;

-- Substitui TODOS os campos (a tela envia o formulário inteiro); default_fee/default_instructions nulos limpam.
create function public.update_delivery_settings(
  p_company_id uuid,
  p_delivery_enabled boolean,
  p_pickup_enabled boolean,
  p_delivery_minutes integer,
  p_pickup_minutes integer,
  p_default_fee numeric default null,
  p_allow_manual_fee boolean default true,
  p_default_instructions text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_instr text := nullif(btrim(coalesce(p_default_instructions, '')), '');
begin
  perform public.delivery_assert_admin(p_company_id);

  if p_delivery_enabled is null or p_pickup_enabled is null or p_allow_manual_fee is null then
    raise exception 'Informe todas as opções (sim/não).' using errcode = 'PT400';
  end if;
  if p_delivery_minutes is null or p_delivery_minutes < 1 or p_delivery_minutes > 1440 then
    raise exception 'O tempo padrão de entrega deve ficar entre 1 e 1440 minutos.' using errcode = 'PT400';
  end if;
  if p_pickup_minutes is null or p_pickup_minutes < 1 or p_pickup_minutes > 1440 then
    raise exception 'O tempo padrão de retirada deve ficar entre 1 e 1440 minutos.' using errcode = 'PT400';
  end if;
  if p_default_fee is not null and (p_default_fee < 0 or p_default_fee >= 100000 or p_default_fee <> round(p_default_fee, 2)) then
    raise exception 'A taxa padrão deve ser zero ou mais, com até 2 casas decimais.' using errcode = 'PT400';
  end if;
  if v_instr is not null and char_length(v_instr) > 500 then
    raise exception 'A instrução padrão pode ter no máximo 500 caracteres.' using errcode = 'PT400';
  end if;

  insert into public.company_delivery_settings (
    company_id, delivery_enabled, pickup_enabled, delivery_minutes, pickup_minutes, default_fee, allow_manual_fee, default_instructions
  ) values (
    p_company_id, p_delivery_enabled, p_pickup_enabled, p_delivery_minutes, p_pickup_minutes, p_default_fee, p_allow_manual_fee, v_instr
  )
  on conflict (company_id) do update
    set delivery_enabled = excluded.delivery_enabled,
        pickup_enabled = excluded.pickup_enabled,
        delivery_minutes = excluded.delivery_minutes,
        pickup_minutes = excluded.pickup_minutes,
        default_fee = excluded.default_fee,
        allow_manual_fee = excluded.allow_manual_fee,
        default_instructions = excluded.default_instructions;

  return public.delivery_settings_effective(p_company_id);
end;
$$;

-- Taxa + previsão de um destino (ou de uma retirada). Só consulta; não cria pedido.
create function public.resolve_delivery_quote(
  p_company_id uuid,
  p_fulfillment text,
  p_city text default null,
  p_neighborhood text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_settings jsonb;
  v_zone public.delivery_zones;
  v_fee numeric(12, 2);
  v_source text;
  v_minutes integer;
begin
  perform public.delivery_assert_operator(p_company_id);
  v_settings := public.delivery_settings_effective(p_company_id);

  if p_fulfillment is null or p_fulfillment not in ('delivery', 'pickup') then
    raise exception 'Informe entrega ou retirada.' using errcode = 'PT400';
  end if;

  if p_fulfillment = 'pickup' then
    if not (v_settings ->> 'pickup_enabled')::boolean then
      raise exception 'A retirada está desativada nas configurações do Delivery.' using errcode = 'PT409';
    end if;
    return jsonb_build_object(
      'fulfillment', 'pickup', 'fee', 0, 'fee_source', 'pickup', 'zone_id', null, 'zone_name', null,
      'estimated_minutes', (v_settings ->> 'pickup_minutes')::integer, 'minutes_source', 'pickup',
      'allow_manual_fee', (v_settings ->> 'allow_manual_fee')::boolean,
      'default_instructions', v_settings -> 'default_instructions');
  end if;

  if not (v_settings ->> 'delivery_enabled')::boolean then
    raise exception 'A entrega está desativada nas configurações do Delivery.' using errcode = 'PT409';
  end if;

  select * into v_zone
  from public.delivery_zones z
  where z.company_id = p_company_id
    and z.is_active
    and z.city_key = public.delivery_norm_text(p_city)
    and z.neighborhood_key = public.delivery_norm_text(p_neighborhood);

  if found then
    v_fee := v_zone.fee;
    v_source := 'zone';
  elsif (v_settings ->> 'default_fee') is not null then
    v_fee := (v_settings ->> 'default_fee')::numeric;
    v_source := 'default';
  else
    v_fee := null;
    v_source := 'none';
  end if;

  if found and v_zone.estimated_minutes is not null then
    v_minutes := v_zone.estimated_minutes;
    return jsonb_build_object(
      'fulfillment', 'delivery', 'fee', v_fee, 'fee_source', v_source, 'zone_id', v_zone.id, 'zone_name', v_zone.name,
      'estimated_minutes', v_minutes, 'minutes_source', 'zone',
      'allow_manual_fee', (v_settings ->> 'allow_manual_fee')::boolean,
      'default_instructions', v_settings -> 'default_instructions');
  end if;

  return jsonb_build_object(
    'fulfillment', 'delivery', 'fee', v_fee, 'fee_source', v_source,
    'zone_id', case when found then v_zone.id end, 'zone_name', case when found then v_zone.name end,
    'estimated_minutes', (v_settings ->> 'delivery_minutes')::integer, 'minutes_source', 'default',
    'allow_manual_fee', (v_settings ->> 'allow_manual_fee')::boolean,
    'default_instructions', v_settings -> 'default_instructions');
end;
$$;

revoke execute on function public.get_delivery_settings(uuid) from public, anon;
revoke execute on function public.update_delivery_settings(uuid, boolean, boolean, integer, integer, numeric, boolean, text) from public, anon;
revoke execute on function public.resolve_delivery_quote(uuid, text, text, text) from public, anon;
grant execute on function public.get_delivery_settings(uuid) to authenticated;
grant execute on function public.update_delivery_settings(uuid, boolean, boolean, integer, integer, numeric, boolean, text) to authenticated;
grant execute on function public.resolve_delivery_quote(uuid, text, text, text) to authenticated;

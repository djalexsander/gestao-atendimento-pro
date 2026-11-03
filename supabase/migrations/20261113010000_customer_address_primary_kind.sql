-- Endereços de entrega do cliente: TIPO (Casa / Trabalho / Outro), ENDEREÇO PRINCIPAL e bloqueio de DUPLICIDADE.
-- Nenhuma migration anterior é alterada. Nada é apagado: endereços continuam só ativados/desativados (pedidos antigos apontam para eles).
--
--   * customer_addresses.kind        'home' | 'work' | 'other' (padrão 'other'; o apelido livre `label` continua existindo);
--   * customer_addresses.is_primary  no máximo UM principal por cliente (índice único parcial); o principal é sempre ativo (CHECK);
--   * o 1º endereço ATIVO do cliente nasce principal; ao reativar o único endereço ativo, também; desativar o principal só tira a marca
--     (nenhum outro é escolhido sozinho); endereços já existentes NÃO são tocados (ficam 'other' e sem principal);
--   * set_customer_address_primary(p_address_id): troca o principal (atômico, serializado pelo cliente);
--   * duplicidade: dois endereços ATIVOS do mesmo cliente com a mesma chave normalizada (rua, número, complemento, bairro, cidade, UF —
--     sem acento/caixa/espaços; o CEP não entra) são recusados (PT409) na criação, edição e reativação. Verificação nas RPCs com o cliente
--     travado (FOR UPDATE), porque toda escrita passa por elas; duplicados que já existam não são alterados;
--   * create/update_customer_address ganham p_kind (as assinaturas antigas são trocadas; chamadas antigas por nome continuam válidas);
--   * list_customer_addresses ordena: ativos, principal primeiro, mais antigos;
--   * WhatsApp: whatsapp_saved_address_pick passa a preferir o principal ativo; sem principal, o ativo atualizado mais recentemente.
-- Permissões e isolamento iguais aos de antes (operador da empresa + módulo Delivery; a empresa vem do cliente/endereço, nunca do cliente da API).

-- ---------------------------------------------------------------------------
-- 1) Colunas, CHECKs e índice
-- ---------------------------------------------------------------------------
alter table public.customer_addresses
  add column kind text not null default 'other'
    constraint customer_addresses_kind_check check (kind in ('home', 'work', 'other')),
  add column is_primary boolean not null default false,
  add constraint customer_addresses_primary_active check (not is_primary or is_active);

create unique index customer_addresses_one_primary
  on public.customer_addresses (company_id, customer_id)
  where is_primary;

comment on column public.customer_addresses.kind is 'Tipo do endereço: home (Casa), work (Trabalho) ou other (Outro).';
comment on column public.customer_addresses.is_primary is 'Endereço principal do cliente (no máximo um; sempre ativo). Sugerido primeiro no pedido, sempre com confirmação do cliente.';

-- ---------------------------------------------------------------------------
-- 2) Duplicidade (helper interno)
-- ---------------------------------------------------------------------------
create function public.customer_address_key(p_street text, p_number text, p_complement text, p_neighborhood text, p_city text, p_state text)
returns text
language sql
immutable
set search_path = public
as $$
  select concat_ws('|',
    public.delivery_norm_text(p_street), public.delivery_norm_text(p_number), public.delivery_norm_text(p_complement),
    public.delivery_norm_text(p_neighborhood), public.delivery_norm_text(p_city), upper(btrim(coalesce(p_state, ''))))
$$;

-- Já existe OUTRO endereço ativo do mesmo cliente com a mesma chave? (p_exclude = o próprio endereço, na edição/reativação)
create function public.customer_address_is_duplicate(
  p_company_id uuid, p_customer_id uuid, p_street text, p_number text, p_complement text, p_neighborhood text, p_city text, p_state text, p_exclude uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.customer_addresses a
     where a.company_id = p_company_id and a.customer_id = p_customer_id and a.is_active
       and (p_exclude is null or a.id <> p_exclude)
       and public.customer_address_key(a.street, a.number, a.complement, a.neighborhood, a.city, a.state)
         = public.customer_address_key(p_street, p_number, p_complement, p_neighborhood, p_city, p_state)
  )
$$;

revoke execute on function public.customer_address_key(text, text, text, text, text, text) from public, anon, authenticated, service_role;
revoke execute on function public.customer_address_is_duplicate(uuid, uuid, text, text, text, text, text, text, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) RPCs (assinaturas antigas de create/update são trocadas)
-- ---------------------------------------------------------------------------
drop function public.create_customer_address(uuid, text, text, text, text, text, text, text, text, text, numeric, numeric);
drop function public.update_customer_address(uuid, text, text, text, text, text, text, text, text, text, numeric, numeric);

create or replace function public.list_customer_addresses(p_customer_id uuid, p_include_inactive boolean default false)
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
    order by a.is_active desc, a.is_primary desc, a.created_at, a.id;
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
  p_longitude numeric default null,
  p_kind text default 'other'
)
returns public.customer_addresses
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer public.customers;
  v_clean jsonb;
  v_kind text := coalesce(nullif(btrim(p_kind), ''), 'other');
  v_first boolean;
  v_row public.customer_addresses;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  -- trava o cliente: criações simultâneas respeitam o teto, a duplicidade e o "primeiro endereço vira principal"
  select * into v_customer from public.customers where id = p_customer_id for update;
  if not found then
    raise exception 'Cliente não encontrado.' using errcode = 'PT404';
  end if;
  perform public.delivery_assert_operator(v_customer.company_id);
  if not v_customer.is_active then
    raise exception 'Este cliente está inativo.' using errcode = 'PT409';
  end if;
  if v_kind not in ('home', 'work', 'other') then
    raise exception 'Tipo de endereço inválido. Use Casa, Trabalho ou Outro.' using errcode = 'PT400';
  end if;

  v_clean := public.delivery_clean_address(p_label, p_cep, p_street, p_number, p_complement, p_neighborhood, p_city, p_state, p_reference, p_latitude, p_longitude);

  if (select count(*) from public.customer_addresses a where a.company_id = v_customer.company_id and a.customer_id = v_customer.id) >= 30 then
    raise exception 'Este cliente já tem o máximo de 30 endereços. Desative algum.' using errcode = 'PT409';
  end if;
  if public.customer_address_is_duplicate(v_customer.company_id, v_customer.id, v_clean ->> 'street', v_clean ->> 'number', v_clean ->> 'complement',
                                          v_clean ->> 'neighborhood', v_clean ->> 'city', v_clean ->> 'state', null) then
    raise exception 'Este endereço já está cadastrado para o cliente.' using errcode = 'PT409';
  end if;

  v_first := not exists (select 1 from public.customer_addresses a where a.company_id = v_customer.company_id and a.customer_id = v_customer.id and a.is_active);

  insert into public.customer_addresses (
    company_id, customer_id, label, cep, street, number, complement, neighborhood, city, state, reference, latitude, longitude, kind, is_primary
  ) values (
    v_customer.company_id, v_customer.id,
    v_clean ->> 'label', v_clean ->> 'cep', v_clean ->> 'street', v_clean ->> 'number', v_clean ->> 'complement',
    v_clean ->> 'neighborhood', v_clean ->> 'city', v_clean ->> 'state', v_clean ->> 'reference',
    (v_clean ->> 'latitude')::numeric, (v_clean ->> 'longitude')::numeric, v_kind, v_first
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
  p_longitude numeric default null,
  p_kind text default null
)
returns public.customer_addresses
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.customer_addresses;
  v_clean jsonb;
  v_kind text;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_row from public.customer_addresses where id = p_address_id;
  if not found then
    raise exception 'Endereço não encontrado.' using errcode = 'PT404';
  end if;
  -- mesma ordem de trava das outras RPCs: cliente primeiro, depois o endereço
  perform 1 from public.customers where id = v_row.customer_id and company_id = v_row.company_id for update;
  select * into v_row from public.customer_addresses where id = p_address_id for update;
  perform public.delivery_assert_operator(v_row.company_id);

  v_kind := coalesce(nullif(btrim(p_kind), ''), v_row.kind);
  if v_kind not in ('home', 'work', 'other') then
    raise exception 'Tipo de endereço inválido. Use Casa, Trabalho ou Outro.' using errcode = 'PT400';
  end if;
  v_clean := public.delivery_clean_address(p_label, p_cep, p_street, p_number, p_complement, p_neighborhood, p_city, p_state, p_reference, p_latitude, p_longitude);
  if v_row.is_active and public.customer_address_is_duplicate(v_row.company_id, v_row.customer_id, v_clean ->> 'street', v_clean ->> 'number', v_clean ->> 'complement',
                                                               v_clean ->> 'neighborhood', v_clean ->> 'city', v_clean ->> 'state', v_row.id) then
    raise exception 'Este endereço já está cadastrado para o cliente.' using errcode = 'PT409';
  end if;

  update public.customer_addresses
     set label = v_clean ->> 'label', cep = v_clean ->> 'cep', street = v_clean ->> 'street',
         number = v_clean ->> 'number', complement = v_clean ->> 'complement',
         neighborhood = v_clean ->> 'neighborhood', city = v_clean ->> 'city', state = v_clean ->> 'state',
         reference = v_clean ->> 'reference',
         latitude = (v_clean ->> 'latitude')::numeric, longitude = (v_clean ->> 'longitude')::numeric,
         kind = v_kind
   where id = v_row.id
   returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.set_customer_address_active(p_address_id uuid, p_active boolean)
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
  select * into v_row from public.customer_addresses where id = p_address_id;
  if not found then
    raise exception 'Endereço não encontrado.' using errcode = 'PT404';
  end if;
  perform 1 from public.customers where id = v_row.customer_id and company_id = v_row.company_id for update;
  select * into v_row from public.customer_addresses where id = p_address_id for update;
  perform public.delivery_assert_operator(v_row.company_id);

  if p_active then
    if v_row.is_active then
      return v_row;   -- já ativo: nada muda (preserva o principal)
    end if;
    if public.customer_address_is_duplicate(v_row.company_id, v_row.customer_id, v_row.street, v_row.number, v_row.complement,
                                            v_row.neighborhood, v_row.city, v_row.state, v_row.id) then
      raise exception 'Já existe um endereço ativo igual a este para o cliente.' using errcode = 'PT409';
    end if;
    -- reativar o ÚNICO endereço ativo do cliente o torna principal
    update public.customer_addresses
       set is_active = true,
           is_primary = not exists (select 1 from public.customer_addresses o
                                     where o.company_id = v_row.company_id and o.customer_id = v_row.customer_id and o.is_active and o.id <> v_row.id)
     where id = v_row.id
     returning * into v_row;
  else
    -- desativar o principal só tira a marca; nenhum outro endereço é escolhido sozinho
    update public.customer_addresses set is_active = false, is_primary = false where id = v_row.id returning * into v_row;
  end if;
  return v_row;
end;
$$;

create function public.set_customer_address_primary(p_address_id uuid)
returns public.customer_addresses
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.customer_addresses;
  v_active boolean;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_row from public.customer_addresses where id = p_address_id;
  if not found then
    raise exception 'Endereço não encontrado.' using errcode = 'PT404';
  end if;
  select c.is_active into v_active from public.customers c where c.id = v_row.customer_id and c.company_id = v_row.company_id for update;
  select * into v_row from public.customer_addresses where id = p_address_id for update;
  perform public.delivery_assert_operator(v_row.company_id);
  if not coalesce(v_active, false) then
    raise exception 'Este cliente está inativo.' using errcode = 'PT409';
  end if;
  if not v_row.is_active then
    raise exception 'Ative o endereço antes de defini-lo como principal.' using errcode = 'PT409';
  end if;
  if v_row.is_primary then
    return v_row;
  end if;

  update public.customer_addresses set is_primary = false
   where company_id = v_row.company_id and customer_id = v_row.customer_id and is_primary and id <> v_row.id;
  update public.customer_addresses set is_primary = true where id = v_row.id returning * into v_row;
  return v_row;
end;
$$;

revoke execute on function public.list_customer_addresses(uuid, boolean) from public, anon;
revoke execute on function public.create_customer_address(uuid, text, text, text, text, text, text, text, text, text, numeric, numeric, text) from public, anon;
revoke execute on function public.update_customer_address(uuid, text, text, text, text, text, text, text, text, text, numeric, numeric, text) from public, anon;
revoke execute on function public.set_customer_address_active(uuid, boolean) from public, anon;
revoke execute on function public.set_customer_address_primary(uuid) from public, anon;
grant execute on function public.list_customer_addresses(uuid, boolean) to authenticated;
grant execute on function public.create_customer_address(uuid, text, text, text, text, text, text, text, text, text, numeric, numeric, text) to authenticated;
grant execute on function public.update_customer_address(uuid, text, text, text, text, text, text, text, text, text, numeric, numeric, text) to authenticated;
grant execute on function public.set_customer_address_active(uuid, boolean) to authenticated;
grant execute on function public.set_customer_address_primary(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) WhatsApp: o principal ativo é sugerido primeiro; sem principal, o ativo atualizado mais recentemente
-- ---------------------------------------------------------------------------
create or replace function public.whatsapp_saved_address_pick(p_company_id uuid, p_customer_id uuid)
returns public.customer_addresses
language sql
stable
security definer
set search_path = public
as $$
  select a.*
    from public.customer_addresses a
    join public.customers c on c.company_id = a.company_id and c.id = a.customer_id and c.is_active
   where a.company_id = p_company_id and a.customer_id = p_customer_id and a.is_active
   order by a.is_primary desc, a.updated_at desc, a.created_at desc, a.id desc
   limit 1
$$;

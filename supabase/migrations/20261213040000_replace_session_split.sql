-- =============================================================================
-- PAGAMENTOS PARCIAIS — ETAPA E4: replace_session_split (criar e SUBSTITUIR a divisão da conta, só sobre o que ainda não foi pago)
-- =============================================================================
-- Regras S-1..S-12 e os conflitos de modelagem em docs/pagamentos-parciais-e4-regras.md (escritos e testados ANTES do SQL).
-- Só funções NOVAS. Nenhuma RPC existente é alterada (close_service_session, register_service_payment, refund..., cancel..., submit...).
-- Depende da E1 (tabelas de divisão/alocação), da E2 (saldo) e da E3 (o gatilho provisório de fechamento segue valendo).
--
--   replace_session_split(sessão, modo, partes, versão_esperada, request_id)   owner | admin | cashier
--   service_session_split_item_pool(...)   interna: unidades de item ainda disponíveis para atribuir (modo produtos)
--   service_split_result(divisão, replay)  interna: resposta (divisão + partes + itens + estado agregado)
--
-- IDEIA CENTRAL: o saldo pendente (balance_due = total vigente - aplicado) é exatamente o que as partes novas devem cobrir. O pago nas
-- partes antigas continua contando como pago (E2: superseded_paid); partes, itens, alocações e pagamentos antigos NÃO são tocados.
-- ROLLBACK: supabase/rollbacks/replace-session-split/rollback.sql (recusa se já existir divisão criada por esta RPC).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Pool de unidades de item (interna)
-- ---------------------------------------------------------------------------
-- Disponível = cobrável (quantidade - cancelada) - unidades já alocadas a partes de divisões anteriores QUITADAS (essas ficam travadas).
create function public.service_session_split_item_pool(p_company_id uuid, p_service_session_id uuid)
returns table (item_id uuid, item_name text, unit_cents bigint, billable integer, locked integer, available integer)
language sql
stable
security definer
set search_path = public
as $$
  select i.id,
         i.product_name_snapshot,
         round(i.unit_price * 100)::bigint,
         (i.quantity - i.cancelled_quantity),
         coalesce(l.q, 0)::integer,
         greatest((i.quantity - i.cancelled_quantity) - coalesce(l.q, 0), 0)::integer
  from public.service_orders o
  join public.service_order_items i on i.company_id = o.company_id and i.order_id = o.id
  left join lateral (
    select sum(pi.quantity) as q
    from public.service_session_part_items pi
    join public.service_session_parts p on p.company_id = pi.company_id and p.id = pi.part_id
    where pi.company_id = i.company_id and pi.service_order_item_id = i.id
      and (coalesce((select sum(a.amount) from public.service_payment_allocations a where a.company_id = p.company_id and a.part_id = p.id), 0)
           - coalesce((select sum(a.amount) from public.service_refund_allocations a where a.company_id = p.company_id and a.part_id = p.id), 0))
          >= p.planned_amount
  ) l on true
  where o.company_id = p_company_id and o.service_session_id = p_service_session_id and o.status = 'submitted';
$$;

-- ---------------------------------------------------------------------------
-- 2) Resposta da divisão (interna)
-- ---------------------------------------------------------------------------
create function public.service_split_result(p_split_id uuid, p_replay boolean)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'split', jsonb_build_object('id', s.id, 'mode', s.mode, 'version', s.version, 'status', s.status, 'created_at', s.created_at),
    'replay', p_replay,
    'parts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'part_id', p.id, 'position', p.position, 'label', p.label, 'planned', p.planned_amount,
               'items', coalesce((
                 select jsonb_agg(jsonb_build_object('item_id', pi.service_order_item_id, 'quantity', pi.quantity) order by pi.service_order_item_id)
                 from public.service_session_part_items pi where pi.company_id = p.company_id and pi.part_id = p.id
               ), '[]'::jsonb)
             ) order by p.position)
      from public.service_session_parts p where p.company_id = s.company_id and p.split_id = s.id
    ), '[]'::jsonb),
    'state', public.service_session_financial_core(s.company_id, s.service_session_id)
  )
  from public.service_session_splits s
  where s.id = p_split_id;
$$;

-- ---------------------------------------------------------------------------
-- 3) RPC
-- ---------------------------------------------------------------------------
create function public.replace_session_split(
  p_service_session_id uuid,
  p_mode text,
  p_parts jsonb,
  p_expected_version integer,
  p_client_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_role public.company_role;
  v_session public.service_sessions;
  v_ev public.service_session_events;
  v_hash text;
  v_cur public.service_session_splits;
  v_cur_version integer := 0;
  v_core jsonb;
  v_bal bigint;
  v_n integer;
  v_i integer;
  v_el jsonb;
  v_it jsonb;
  v_label text;
  v_labels text[] := '{}';
  v_cents bigint[] := '{}';
  v_sum bigint := 0;
  v_base bigint;
  v_rem bigint;
  v_amt numeric;
  v_new uuid;
  v_part uuid;
  v_pool record;
  v_item uuid;
  v_qty integer;
  v_assigned jsonb := '{}'::jsonb;
  v_have integer;
  v_pool_value bigint := 0;
  v_unit bigint;
  v_part_cents bigint;
  v_part_ids uuid[] := '{}';
  v_summary jsonb := '[]'::jsonb;
  v_event_type text;
begin
  -- S-1: sessão e entradas
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if p_client_request_id is null then
    raise exception 'Informe o identificador da requisição (client_request_id).' using errcode = 'PT400';
  end if;
  if p_expected_version is null or p_expected_version < 0 then
    raise exception 'Informe a versão da divisão que você está vendo (0 se ainda não há divisão).' using errcode = 'PT400';
  end if;
  if p_mode is null or p_mode not in ('equal', 'values', 'products') then
    raise exception 'Modo de divisão inválido.' using errcode = 'PT400';
  end if;
  if p_parts is null or jsonb_typeof(p_parts) <> 'array' then
    raise exception 'Informe as partes da divisão.' using errcode = 'PT400';
  end if;
  v_n := jsonb_array_length(p_parts);
  if v_n < 2 or v_n > 50 then
    raise exception 'Uma divisão precisa de 2 a 50 partes.' using errcode = 'PT400';
  end if;

  select company_id into v_company from public.service_sessions where id = p_service_session_id;
  if v_company is null then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  v_role := public.user_role_in_company(v_company);
  if v_role is null then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier') then
    raise exception 'Você não tem permissão para dividir a conta.' using errcode = 'PT403';
  end if;

  -- S-6: trava a conta (mesma trava de pagamento, pedido, cancelamento e fechamento)
  select * into v_session from public.service_sessions where id = p_service_session_id for update;
  if not found then
    raise exception 'Atendimento não encontrado.' using errcode = 'PT404';
  end if;

  -- S-7: idempotência (antes das regras de estado: a réplica vale mesmo se já existe versão mais nova)
  v_hash := md5(p_mode || ':' || p_expected_version::text || ':' || p_parts::text);
  select * into v_ev from public.service_session_events
  where company_id = v_company and event_type in ('split_created', 'split_replaced') and request_id = p_client_request_id
  limit 1;
  if found then
    if v_ev.service_session_id = v_session.id and v_ev.payload ->> 'request_hash' = v_hash then
      return public.service_split_result((v_ev.payload ->> 'split_id')::uuid, true);
    end if;
    raise exception 'Este identificador de requisição já foi usado em outra divisão.' using errcode = 'PT409';
  end if;

  -- S-2
  if v_session.status <> 'open' then
    raise exception 'Este atendimento já foi fechado.' using errcode = 'PT409';
  end if;
  if v_session.kind <> 'point' then
    raise exception 'Delivery e retirada não têm divisão de conta.' using errcode = 'PT409';
  end if;

  -- S-6: versão
  select * into v_cur from public.service_session_splits
  where company_id = v_company and service_session_id = v_session.id and status = 'active';
  if found then v_cur_version := v_cur.version; end if;
  if p_expected_version <> v_cur_version then
    raise exception 'A divisão foi alterada por outra pessoa (versão atual %). Atualize a tela e refaça.', v_cur_version using errcode = 'PT409';
  end if;

  -- S-3: o saldo pendente é o que as partes novas precisam cobrir
  v_core := public.service_session_financial_core(v_company, v_session.id);
  v_bal := round((v_core ->> 'balance_due')::numeric * 100)::bigint;
  if v_bal <= 0 then
    raise exception 'Não há saldo pendente para dividir.' using errcode = 'PT409';
  end if;

  -- rótulos (comuns aos três modos) e valores por parte, em CENTAVOS
  for v_i in 1..v_n loop
    v_el := p_parts -> (v_i - 1);
    if jsonb_typeof(v_el) <> 'object' then
      raise exception 'Parte % inválida.', v_i using errcode = 'PT400';
    end if;
    if v_el ? 'label' and jsonb_typeof(v_el -> 'label') not in ('string', 'null') then
      raise exception 'O rótulo da parte % deve ser texto.', v_i using errcode = 'PT400';
    end if;
    v_label := nullif(btrim(coalesce(v_el ->> 'label', '')), '');
    if v_label is null then v_label := 'Pessoa ' || v_i; end if;
    if char_length(v_label) > 40 then
      raise exception 'O rótulo da parte % passa de 40 caracteres.', v_i using errcode = 'PT400';
    end if;
    if lower(v_label) = any (v_labels) then
      raise exception 'O rótulo "%" aparece mais de uma vez.', v_label using errcode = 'PT400';
    end if;
    v_labels := v_labels || lower(v_label);
    v_summary := v_summary || jsonb_build_array(jsonb_build_object('label', v_label));
  end loop;
  -- (v_labels guarda minúsculas só para a checagem; os rótulos reais são relidos abaixo)

  if p_mode = 'equal' then
    -- S-5: piso + centavos extras para as primeiras partes
    v_base := v_bal / v_n;
    v_rem := v_bal % v_n;
    if v_base < 1 then
      raise exception 'O saldo (% centavos) é menor que o número de partes.', v_bal using errcode = 'PT400';
    end if;
    for v_i in 1..v_n loop
      v_cents := v_cents || (v_base + case when v_i <= v_rem then 1 else 0 end);
    end loop;

  elsif p_mode = 'values' then
    for v_i in 1..v_n loop
      v_el := p_parts -> (v_i - 1);
      if jsonb_typeof(v_el -> 'amount') is distinct from 'number' then
        raise exception 'Informe o valor da parte %.', v_i using errcode = 'PT400';
      end if;
      v_amt := (v_el ->> 'amount')::numeric;
      if v_amt <= 0 or v_amt >= 10000000000 or v_amt <> round(v_amt, 2) then
        raise exception 'O valor de cada parte deve ser maior que zero, com até 2 casas decimais.' using errcode = 'PT400';
      end if;
      v_cents := v_cents || (v_amt * 100)::bigint;
      v_sum := v_sum + (v_amt * 100)::bigint;
    end loop;
    if v_sum <> v_bal then
      raise exception 'As partes (R$ %) precisam somar exatamente o saldo pendente (R$ %).',
        replace(to_char(v_sum / 100.0, 'FM9999999990.00'), '.', ','), replace(to_char(v_bal / 100.0, 'FM9999999990.00'), '.', ',') using errcode = 'PT400';
    end if;

  else
    -- products: S-8/S-9
    select coalesce(sum(available * unit_cents), 0) into v_pool_value
    from public.service_session_split_item_pool(v_company, v_session.id);
    if v_pool_value <> v_bal then
      raise exception 'O dinheiro já pago não corresponde a itens quitados (itens disponíveis R$ %, saldo R$ %). Divida o saldo em partes iguais ou por valores.',
        replace(to_char(v_pool_value / 100.0, 'FM9999999990.00'), '.', ','), replace(to_char(v_bal / 100.0, 'FM9999999990.00'), '.', ',') using errcode = 'PT409';
    end if;
    for v_i in 1..v_n loop
      v_el := p_parts -> (v_i - 1);
      v_it := v_el -> 'items';
      if jsonb_typeof(v_it) is distinct from 'array' or jsonb_array_length(v_it) = 0 then
        raise exception 'A parte % precisa ter pelo menos um item.', v_i using errcode = 'PT400';
      end if;
      v_part_cents := 0;
      for v_qty in 0..jsonb_array_length(v_it) - 1 loop
        if jsonb_typeof(v_it -> v_qty) <> 'object'
           or jsonb_typeof(v_it -> v_qty -> 'item_id') <> 'string'
           or (v_it -> v_qty ->> 'item_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           or jsonb_typeof(v_it -> v_qty -> 'quantity') <> 'number'
           or (v_it -> v_qty ->> 'quantity') !~ '^[0-9]+$' then
          raise exception 'Item inválido na parte %.', v_i using errcode = 'PT400';
        end if;
        v_item := (v_it -> v_qty ->> 'item_id')::uuid;
        v_have := (v_it -> v_qty ->> 'quantity')::integer;
        if v_have < 1 then
          raise exception 'A quantidade de cada item deve ser maior que zero.' using errcode = 'PT400';
        end if;
        select * into v_pool from public.service_session_split_item_pool(v_company, v_session.id) where item_id = v_item;
        if not found then
          raise exception 'Item não pertence a esta conta (ou o pedido foi cancelado).' using errcode = 'PT409';
        end if;
        v_assigned := jsonb_set(v_assigned, array[v_item::text], to_jsonb(coalesce((v_assigned ->> v_item::text)::integer, 0) + v_have));
        if (v_assigned ->> v_item::text)::integer > v_pool.available then
          raise exception 'O item "%" já foi atribuído ou pago (disponível: % unidade(s)); a mesma unidade não pode ser cobrada de duas pessoas.', v_pool.item_name, v_pool.available using errcode = 'PT409';
        end if;
        v_part_cents := v_part_cents + v_have * v_pool.unit_cents;
      end loop;
      v_cents := v_cents || v_part_cents;
      v_sum := v_sum + v_part_cents;
    end loop;
    for v_pool in select * from public.service_session_split_item_pool(v_company, v_session.id) where available > 0 loop
      if coalesce((v_assigned ->> v_pool.item_id::text)::integer, 0) < v_pool.available then
        raise exception 'Há unidades do item "%" sem pessoa responsável; atribua todas as unidades.', v_pool.item_name using errcode = 'PT409';
      end if;
    end loop;
    if v_sum <> v_bal then
      raise exception 'As partes por produto não somam o saldo pendente.' using errcode = 'PT400';
    end if;
  end if;

  -- grava: a versão ativa vira substituída (nada é apagado) e nasce a seguinte com as partes novas
  if v_cur_version > 0 then
    update public.service_session_splits set status = 'superseded', superseded_at = now() where id = v_cur.id;
  end if;
  insert into public.service_session_splits (company_id, service_session_id, mode, version, created_by)
  values (v_company, v_session.id, p_mode, v_cur_version + 1, auth.uid())
  returning id into v_new;

  v_summary := '[]'::jsonb;
  for v_i in 1..v_n loop
    v_el := p_parts -> (v_i - 1);
    v_label := coalesce(nullif(btrim(coalesce(v_el ->> 'label', '')), ''), 'Pessoa ' || v_i);
    insert into public.service_session_parts (company_id, split_id, service_session_id, position, label, planned_amount)
    values (v_company, v_new, v_session.id, v_i, v_label, v_cents[v_i]::numeric / 100)
    returning id into v_part;
    v_part_ids := v_part_ids || v_part;
    v_summary := v_summary || jsonb_build_array(jsonb_build_object('label', v_label, 'planned_cents', v_cents[v_i]));
    if p_mode = 'products' then
      for v_qty in 0..jsonb_array_length(v_el -> 'items') - 1 loop
        insert into public.service_session_part_items (company_id, part_id, service_session_id, service_order_item_id, quantity)
        values (v_company, v_part, v_session.id, (v_el -> 'items' -> v_qty ->> 'item_id')::uuid, (v_el -> 'items' -> v_qty ->> 'quantity')::integer);
      end loop;
    end if;
  end loop;

  v_event_type := case when v_cur_version = 0 then 'split_created' else 'split_replaced' end;
  begin
    insert into public.service_session_events (company_id, service_session_id, event_type, actor_id, request_id, payload)
    values (
      v_company, v_session.id, v_event_type, auth.uid(), p_client_request_id,
      jsonb_build_object(
        'split_id', v_new, 'mode', p_mode, 'version_from', v_cur_version, 'version_to', v_cur_version + 1,
        'replaced_split_id', case when v_cur_version > 0 then v_cur.id end,
        'balance_cents', v_bal, 'parts', v_summary, 'request_hash', v_hash
      )
    );
  exception when unique_violation then
    raise exception 'Este identificador de requisição já foi usado em outra divisão.' using errcode = 'PT409';
  end;

  return public.service_split_result(v_new, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Permissões
-- ---------------------------------------------------------------------------
revoke execute on function public.service_session_split_item_pool(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.service_split_result(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.replace_session_split(uuid, text, jsonb, integer, uuid) from public, anon;
grant execute on function public.replace_session_split(uuid, text, jsonb, integer, uuid) to authenticated;

comment on function public.replace_session_split(uuid, text, jsonb, integer, uuid) is
  'E4: cria ou SUBSTITUI a divisão (igual | valores | produtos) de uma conta aberta de comanda/mesa, sempre sobre o saldo pendente; versão otimista; idempotente; auditado. Regras: docs/pagamentos-parciais-e4-regras.md.';

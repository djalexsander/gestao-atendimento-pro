-- Delivery — regras de conclusão (ADITIVA; nenhuma migration publicada é editada).
--
--  1) Pedido mínimo e entrega grátis acima de um valor, configuráveis por empresa (company_delivery_settings).
--     * Pedido mínimo: vale para ENTREGA (retirada não tem mínimo); compara com o subtotal dos itens (sem a taxa).
--     * Entrega grátis: quando o subtotal dos itens alcança o limite, a taxa de zona/padrão vira 0 e fee_source = 'free'.
--       Taxa MANUAL informada por owner/admin nunca é sobrescrita. A taxa original fica no evento 'created' (fee_waived_from).
--       A taxa gravada no pedido continua SNAPSHOT imutável (guard_delivery_order_change já impede alteração posterior).
--     * Só o fluxo humano (app). O pedido da IA (WhatsApp) segue exatamente como estava: fora do escopo desta etapa.
--  2) Entregador obrigatório para marcar "saiu para entrega" (configurável; padrão DESLIGADO = comportamento atual).
--  3) Troca de entregador bloqueada enquanto houver valor em custódia (recibo 'held'); o registro do recebimento
--     também revalida o entregador depois da trava (corrida com a troca).
--  4) Entrega RECUSADA: refuse_delivery_order (owner/admin, só pedido em rota). Reaproveita cancel_delivery_order
--     (estoque, itens, impressão e fechamento oficiais) com motivo prefixado; recusa com valor em custódia ou pago
--     e não estornado é recusada (nada de estorno automático/duplicado). Idempotente.
--  5) Indicadores por entregador: delivery_courier_report (leitura).
--
-- As funções vigentes são ajustadas por substituição EXATA de trecho (pg_get_functiondef), com contagem conferida:
-- se o corpo vigente não tiver o trecho esperado, a migration ABORTA em vez de aplicar pela metade.

-- ---------------------------------------------------------------------------
-- 1) Configuração
-- ---------------------------------------------------------------------------
alter table public.company_delivery_settings
  add column min_order_amount numeric(12, 2)
    constraint company_delivery_settings_min_order_check check (min_order_amount is null or (min_order_amount > 0 and min_order_amount < 100000)),
  add column free_delivery_above numeric(12, 2)
    constraint company_delivery_settings_free_above_check check (free_delivery_above is null or (free_delivery_above > 0 and free_delivery_above < 100000)),
  add column require_courier_for_dispatch boolean not null default false;

comment on column public.company_delivery_settings.min_order_amount is
  'Pedido mínimo para ENTREGA (subtotal dos itens, sem a taxa). NULL = sem mínimo.';
comment on column public.company_delivery_settings.free_delivery_above is
  'Entrega grátis quando o subtotal dos itens alcança este valor (taxa de zona/padrão vira 0, fee_source free). NULL = desligado.';
comment on column public.company_delivery_settings.require_courier_for_dispatch is
  'true = só marca "saiu para entrega" com entregador atribuído.';

alter table public.delivery_orders drop constraint delivery_orders_fee_source_check;
alter table public.delivery_orders add constraint delivery_orders_fee_source_check
  check (fee_source in ('zone', 'default', 'manual', 'none', 'free'));

-- Configuração EFETIVA (mesma assinatura; chaves novas ao final)
create or replace function public.delivery_settings_effective(p_company_id uuid)
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
        'default_instructions', s.default_instructions,
        'min_order_amount', s.min_order_amount, 'free_delivery_above', s.free_delivery_above,
        'require_courier_for_dispatch', s.require_courier_for_dispatch)
     from public.company_delivery_settings s where s.company_id = p_company_id),
    jsonb_build_object(
      'configured', false,
      'delivery_enabled', true, 'pickup_enabled', true,
      'delivery_minutes', 45, 'pickup_minutes', 30,
      'default_fee', null, 'allow_manual_fee', true, 'default_instructions', null,
      'min_order_amount', null, 'free_delivery_above', null, 'require_courier_for_dispatch', false)
  );
$$;

revoke execute on function public.delivery_settings_effective(uuid) from public, anon, authenticated;

-- RPC própria (não mexe na assinatura de update_delivery_settings): owner/admin, módulo contratado.
create function public.update_delivery_rules(
  p_company_id uuid,
  p_min_order_amount numeric default null,
  p_free_delivery_above numeric default null,
  p_require_courier_for_dispatch boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.delivery_assert_admin(p_company_id);

  if p_require_courier_for_dispatch is null then
    raise exception 'Informe se o entregador é obrigatório (sim/não).' using errcode = 'PT400';
  end if;
  if p_min_order_amount is not null and (p_min_order_amount <= 0 or p_min_order_amount >= 100000 or p_min_order_amount <> round(p_min_order_amount, 2)) then
    raise exception 'O pedido mínimo deve ser maior que zero, com até 2 casas decimais (ou vazio para não ter mínimo).' using errcode = 'PT400';
  end if;
  if p_free_delivery_above is not null and (p_free_delivery_above <= 0 or p_free_delivery_above >= 100000 or p_free_delivery_above <> round(p_free_delivery_above, 2)) then
    raise exception 'O valor da entrega grátis deve ser maior que zero, com até 2 casas decimais (ou vazio para desligar).' using errcode = 'PT400';
  end if;
  if p_min_order_amount is not null and p_free_delivery_above is not null and p_free_delivery_above < p_min_order_amount then
    raise exception 'A entrega grátis deve começar em um valor igual ou maior que o pedido mínimo.' using errcode = 'PT400';
  end if;

  insert into public.company_delivery_settings (company_id, min_order_amount, free_delivery_above, require_courier_for_dispatch)
  values (p_company_id, p_min_order_amount, p_free_delivery_above, p_require_courier_for_dispatch)
  on conflict (company_id) do update
    set min_order_amount = excluded.min_order_amount,
        free_delivery_above = excluded.free_delivery_above,
        require_courier_for_dispatch = excluded.require_courier_for_dispatch;

  return public.delivery_settings_effective(p_company_id);
end;
$$;

revoke execute on function public.update_delivery_rules(uuid, numeric, numeric, boolean) from public, anon;
grant execute on function public.update_delivery_rules(uuid, numeric, numeric, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Ajustes por substituição exata
-- ---------------------------------------------------------------------------
create function pg_temp.patch_delivery_rules_fn(p_name text, p_from text, p_to text)
returns void
language plpgsql
as $$
declare
  v_oid oid;
  v_def text;
  v_new text;
begin
  select p.oid into v_oid from pg_proc p where p.proname = p_name and p.pronamespace = 'public'::regnamespace;
  if v_oid is null then
    raise exception 'patch_fn: função % não encontrada', p_name;
  end if;
  v_def := pg_get_functiondef(v_oid);
  if (length(v_def) - length(replace(v_def, p_from, ''))) / greatest(length(p_from), 1) <> 1 then
    raise exception 'patch_fn: trecho esperado não ocorre exatamente 1 vez em %', p_name;
  end if;
  v_new := replace(v_def, p_from, p_to);
  execute v_new;
end;
$$;

-- 2a) Motor de criação: pedido mínimo + entrega grátis (somente fluxo humano)
select pg_temp.patch_delivery_rules_fn('create_delivery_order_engine',
  $f$v_ai boolean := (p_actor_via = 'whatsapp_ai');$f$,
  $f$v_ai boolean := (p_actor_via = 'whatsapp_ai');
  v_min numeric(12, 2);
  v_free numeric(12, 2);
  v_waived numeric(12, 2) := null;$f$);

select pg_temp.patch_delivery_rules_fn('create_delivery_order_engine',
  $f$v_total := v_subtotal + v_fee;$f$,
  $f$if not v_ai and p_fulfillment = 'delivery' then
    v_min := nullif(v_settings ->> 'min_order_amount', '')::numeric;
    if v_min is not null and v_subtotal < v_min then
      raise exception 'O pedido mínimo para entrega é R$ %. Os itens somam R$ %.',
        replace(to_char(v_min, 'FM9999999990.00'), '.', ','), replace(to_char(v_subtotal, 'FM9999999990.00'), '.', ',')
        using errcode = 'PT409';
    end if;
    v_free := nullif(v_settings ->> 'free_delivery_above', '')::numeric;
    if v_free is not null and v_subtotal >= v_free and v_source in ('zone', 'default') and v_fee > 0 then
      v_waived := v_fee; v_fee := 0; v_source := 'free';
    end if;
  end if;
  v_total := v_subtotal + v_fee;$f$);

select pg_temp.patch_delivery_rules_fn('create_delivery_order_engine',
  $f$case when v_source = 'zone' then v_zone.id end$f$,
  $f$case when v_source in ('zone', 'free') and v_zone_found then v_zone.id end$f$);

select pg_temp.patch_delivery_rules_fn('create_delivery_order_engine',
  $f$jsonb_build_object('fulfillment', p_fulfillment, 'delivery_fee', v_fee, 'fee_source', v_source, 'total', v_total)$f$,
  $f$jsonb_build_object('fulfillment', p_fulfillment, 'delivery_fee', v_fee, 'fee_source', v_source, 'total', v_total)
          || case when v_waived is not null then jsonb_build_object('fee_waived_from', v_waived) else '{}'::jsonb end$f$);

-- 2b) Entregador obrigatório para sair em rota
select pg_temp.patch_delivery_rules_fn('set_delivery_status',
  $f$if p_status in ('out_for_delivery', 'picked_up') then$f$,
  $f$if p_status = 'out_for_delivery' and v_do.courier_user_id is null
     and coalesce((public.delivery_settings_effective(v_do.company_id) ->> 'require_courier_for_dispatch')::boolean, false) then
    raise exception 'Atribua um entregador antes de marcar a saída para entrega.' using errcode = 'PT409';
  end if;

  if p_status in ('out_for_delivery', 'picked_up') then$f$);

-- 2c) Troca de entregador com valor em custódia
select pg_temp.patch_delivery_rules_fn('assign_delivery_courier',
  $f$if p_courier_user_id is not null and not exists ($f$,
  $f$if p_courier_user_id is distinct from v_do.courier_user_id and exists (
    select 1 from public.delivery_courier_receipts r
    where r.company_id = v_do.company_id and r.delivery_order_id = v_do.id and r.status = 'held'
  ) then
    raise exception 'Este pedido tem um valor recebido pelo entregador aguardando acerto. Faça o acerto no Caixa (ou anule o recebimento) antes de trocar o entregador.' using errcode = 'PT409';
  end if;

  if p_courier_user_id is not null and not exists ($f$);

-- 2d) Registro do recebimento: o entregador precisa continuar sendo o atribuído DEPOIS da trava
select pg_temp.patch_delivery_rules_fn('courier_register_payment',
  $f$-- réplica idempotente: mesmo request => o recebimento já registrado$f$,
  $f$if v_do.courier_user_id is distinct from auth.uid() then
    raise exception 'Pedido de delivery não encontrado.' using errcode = 'PT404';
  end if;

  -- réplica idempotente: mesmo request => o recebimento já registrado$f$);

-- ---------------------------------------------------------------------------
-- 3) Entrega recusada
-- ---------------------------------------------------------------------------
create function public.refuse_delivery_order(p_delivery_order_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prefix constant text := 'Entrega recusada: ';
  v_do public.delivery_orders;
  v_role public.company_role;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_session public.service_sessions;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_do from public.delivery_orders where id = p_delivery_order_id;
  if not found then
    raise exception 'Pedido de delivery não encontrado.' using errcode = 'PT404';
  end if;
  v_role := public.delivery_assert_operator(v_do.company_id);
  if v_role not in ('owner', 'admin') then
    raise exception 'Só owner ou admin registram entrega recusada.' using errcode = 'PT403';
  end if;
  if v_reason is null then
    raise exception 'Informe o motivo da recusa.' using errcode = 'PT400';
  end if;
  if char_length(v_reason) > 180 then
    raise exception 'O motivo pode ter no máximo 180 caracteres.' using errcode = 'PT400';
  end if;

  -- mesma ordem de locks do fechamento/cancelamento: atendimento primeiro
  select * into v_session from public.service_sessions
  where company_id = v_do.company_id and id = v_do.service_session_id for update;
  select * into v_do from public.delivery_orders where id = p_delivery_order_id for update;

  -- idempotência: repetir a recusa devolve o resultado sem refazer nada
  if v_do.delivery_status = 'canceled' and starts_with(coalesce(v_do.cancel_reason, ''), v_prefix) then
    return public.delivery_order_summary(v_do.id, true);
  end if;
  if v_do.fulfillment <> 'delivery' then
    raise exception 'Retirada não tem entrega para recusar.' using errcode = 'PT409';
  end if;
  if v_do.delivery_status <> 'out_for_delivery' then
    raise exception 'Só é possível registrar a recusa de um pedido em rota.' using errcode = 'PT409';
  end if;
  if exists (select 1 from public.delivery_courier_receipts r
              where r.company_id = v_do.company_id and r.delivery_order_id = v_do.id and r.status in ('held', 'settled')) then
    raise exception 'Este pedido tem recebimento do entregador. Anule o recebimento (ou estorne no Caixa) antes de registrar a recusa.' using errcode = 'PT409';
  end if;

  -- cancelamento OFICIAL: itens/estoque (item pronto não devolve estoque), impressão, fechamento com total 0;
  -- conta já paga e não estornada é recusada ali ("Estorne o pagamento no Caixa antes de cancelar").
  return public.cancel_delivery_order(v_do.id, v_prefix || v_reason);
end;
$$;

revoke execute on function public.refuse_delivery_order(uuid, text) from public, anon;
grant execute on function public.refuse_delivery_order(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Indicadores por entregador (leitura)
-- ---------------------------------------------------------------------------
create function public.delivery_courier_report(p_company_id uuid, p_from date default null, p_to date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_from date := coalesce(p_from, (now() at time zone 'America/Sao_Paulo')::date - 6);
  v_to date := coalesce(p_to, (now() at time zone 'America/Sao_Paulo')::date);
begin
  v_role := public.delivery_assert_operator(p_company_id);
  if v_role not in ('owner', 'admin', 'cashier') then
    raise exception 'Você não tem permissão para ver os indicadores de entregadores.' using errcode = 'PT403';
  end if;
  if v_to < v_from or v_to - v_from > 366 then
    raise exception 'Período inválido (máximo de 366 dias).' using errcode = 'PT400';
  end if;

  return jsonb_build_object(
    'from', v_from, 'to', v_to, 'today', v_today,
    'couriers', coalesce((
      select jsonb_agg(x order by (x ->> 'delivered')::int desc, x ->> 'name')
      from (
        select jsonb_build_object(
          'courier_user_id', d.courier_user_id,
          'name', coalesce(p.full_name, 'Entregador'),
          'assigned', count(*),
          'delivered', count(*) filter (where d.delivery_status = 'delivered'),
          'in_route', count(*) filter (where d.delivery_status = 'out_for_delivery'),
          'waiting', count(*) filter (where d.delivery_status = 'confirmed'),
          'refused', count(*) filter (where d.delivery_status = 'canceled' and starts_with(coalesce(d.cancel_reason, ''), 'Entrega recusada: ')),
          'canceled', count(*) filter (where d.delivery_status = 'canceled' and not starts_with(coalesce(d.cancel_reason, ''), 'Entrega recusada: ')),
          'avg_minutes', round((avg(extract(epoch from (d.delivered_at - d.out_for_delivery_at)) / 60.0)
                                filter (where d.delivery_status = 'delivered'))::numeric, 1),
          'fees', coalesce(sum(d.delivery_fee) filter (where d.delivery_status = 'delivered'), 0),
          'delivered_total', coalesce(sum(a.subtotal + d.delivery_fee) filter (where d.delivery_status = 'delivered'), 0),
          'held_amount', (select coalesce(sum(r.amount), 0) from public.delivery_courier_receipts r
                           where r.company_id = d.company_id and r.courier_user_id = d.courier_user_id and r.status = 'held')
        ) as x
        from public.delivery_orders d
        left join public.profiles p on p.user_id = d.courier_user_id
        cross join lateral (
          select coalesce(sum((i.quantity - i.cancelled_quantity) * i.unit_price), 0)::numeric(12, 2) as subtotal
          from public.service_order_items i
          where i.company_id = d.company_id and i.order_id = d.service_order_id
        ) a
        where d.company_id = p_company_id and d.courier_user_id is not null
          and (d.created_at at time zone 'America/Sao_Paulo')::date between v_from and v_to
        group by d.company_id, d.courier_user_id, p.full_name
      ) t
    ), '[]'::jsonb));
end;
$$;

revoke execute on function public.delivery_courier_report(uuid, date, date) from public, anon;
grant execute on function public.delivery_courier_report(uuid, date, date) to authenticated;

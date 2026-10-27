-- Regras comerciais do Delivery (pedido mínimo e entrega grátis) também no pedido do WhatsApp com IA.
--
-- Causa (teste real de 27/10/2026, pedido #11): a migration 20261029010000 aplicou as regras só no fluxo humano do motor
-- (`if not v_ai and ...`) e o rascunho do WhatsApp sempre cobrava a taxa da zona. Subtotal R$ 112,00 com "entrega grátis a partir
-- de R$ 50,00" saiu com taxa R$ 8,00 (total R$ 120,00).
--
-- Mesma regra do manual, calculada SÓ no banco:
--   * entrega grátis: subtotal de produtos >= free_delivery_above => taxa 0 (a zona/identificação é mantida); fee_source do rascunho continua 'zone';
--   * pedido mínimo: subtotal de produtos (sem taxa) < min_order_amount vira a pendência 'below_minimum' (com o que falta) e o pedido NÃO é criado;
--   * retirada não tem mínimo nem taxa;
--   * o motor oficial passa a aplicar as mesmas regras também para 'whatsapp_ai' (gravando fee_source = 'free'), então o que o cliente
--     confirmou é exatamente o que o motor grava (a defesa totals_mismatch continua valendo).
-- O rascunho recalcula a cada mudança de itens (a taxa efetiva acompanha o subtotal). Pedidos antigos NÃO são tocados.
-- Ajuste por substituição exata das definições vivas (mesmo método da 20261029010000): se o trecho não existir uma vez, a migration falha.

create function pg_temp.patch_wa_delivery_rules_fn(p_name text, p_from text, p_to text)
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
  -- as definições vivas podem ter fim de linha CRLF (migration enviada de um checkout Windows): normaliza antes de comparar
  v_def := replace(pg_get_functiondef(v_oid), chr(13), '');
  if (length(v_def) - length(replace(v_def, p_from, ''))) / greatest(length(p_from), 1) <> 1 then
    raise exception 'patch_fn: trecho esperado não ocorre exatamente 1 vez em %', p_name;
  end if;
  v_new := replace(v_def, p_from, p_to);
  execute v_new;
end;
$$;

-- 1) Motor oficial: as regras valem para QUALQUER canal (inclui whatsapp_ai)
select pg_temp.patch_wa_delivery_rules_fn('create_delivery_order_engine',
  $f$if not v_ai and p_fulfillment = 'delivery' then$f$,
  $f$if p_fulfillment = 'delivery' then$f$);

-- 2) Recalculo do rascunho: taxa efetiva (zona atual, zerada com entrega grátis) e total
select pg_temp.patch_wa_delivery_rules_fn('whatsapp_order_recalc',
  $f$  v_fee numeric(12, 2);
begin$f$,
  $f$  v_fee numeric(12, 2);
  v_free numeric(12, 2);
begin$f$);

select pg_temp.patch_wa_delivery_rules_fn('whatsapp_order_recalc',
  $f$  v_fee := case when v_d.fulfillment = 'delivery' and v_d.fee_source = 'zone' then coalesce(v_d.delivery_fee, 0) else 0 end;$f$,
  $f$  -- taxa da zona de AGORA (o rascunho guarda a taxa EFETIVA); entrega grátis zera a taxa e mantém a zona
  v_fee := case when v_d.fulfillment = 'delivery' and v_d.fee_source = 'zone'
                then coalesce((select z.fee from public.delivery_zones z where z.company_id = v_d.company_id and z.id = v_d.zone_id), v_d.delivery_fee, 0)
                else 0 end;
  v_free := nullif(public.delivery_settings_effective(v_d.company_id) ->> 'free_delivery_above', '')::numeric;
  if v_fee > 0 and v_free is not null and v_items >= v_free then
    v_fee := 0;
  end if;$f$);

select pg_temp.patch_wa_delivery_rules_fn('whatsapp_order_recalc',
  $f$     set items_total = v_items,$f$,
  $f$     set items_total = v_items,
         delivery_fee = case when v_d.fulfillment = 'delivery' and v_d.fee_source = 'zone' then v_fee else delivery_fee end,$f$);

-- 3) Estado: pendência 'below_minimum' (com o que falta) + indicadores para o resumo
select pg_temp.patch_wa_delivery_rules_fn('whatsapp_order_state',
  $f$  v_ready := jsonb_array_length(v_pend) = 0;$f$,
  $f$  if d.fulfillment = 'delivery' and nullif(v_settings ->> 'min_order_amount', '') is not null
     and d.items_total < (v_settings ->> 'min_order_amount')::numeric then
    v_pend := v_pend || jsonb_build_array(jsonb_build_object('code', 'below_minimum',
                'minimum', (v_settings ->> 'min_order_amount')::numeric, 'subtotal', d.items_total,
                'missing_amount', (v_settings ->> 'min_order_amount')::numeric - d.items_total));
  end if;
  v_ready := jsonb_array_length(v_pend) = 0;$f$);

select pg_temp.patch_wa_delivery_rules_fn('whatsapp_order_state',
  $f$'delivery_fee', d.delivery_fee, 'estimated_minutes', d.estimated_minutes,$f$,
  $f$'delivery_fee', d.delivery_fee, 'estimated_minutes', d.estimated_minutes,
    'fee_waived', (d.fulfillment = 'delivery' and d.fee_source = 'zone' and coalesce(d.delivery_fee, 0) = 0
                   and coalesce((select z.fee from public.delivery_zones z where z.company_id = d.company_id and z.id = d.zone_id), 0) > 0),$f$);

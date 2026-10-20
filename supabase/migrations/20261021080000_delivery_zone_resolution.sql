-- WhatsApp pedido conversacional — resolução de ZONA/BAIRRO tolerante a variações de escrita, mas SEGURA.
--
-- Problema (1º teste real de delivery): a zona era "JARDIM SÃO FRANCISCO" e o cliente escreveu "São Francisco"; o casamento por
-- chave exata (minúsculas, sem acento) recusou o endereço. Clientes raramente escrevem o bairro igual ao cadastro.
--
-- Regra nova (determinística, sem fuzzy):
--   1) cidade continua exata (normalizada); nunca casa bairro de outra cidade;
--   2) 'exact'            : chave do bairro igual (como antes);
--   3) 'normalized_match' : pontuação ignorada e abreviação do 1º termo expandida (jd/jd. -> jardim, vl -> vila, res ->
--                           residencial, pq -> parque, cj/conj -> conjunto, lot -> loteamento); casa se as formas completas forem
--                           iguais, OU se o cliente NÃO escreveu prefixo ("São Francisco") e o "núcleo" (sem o prefixo) for igual
--                           ao núcleo de UMA zona;
--   4) 'ambiguous'        : mais de uma zona compatível (ex.: "Jardim São Francisco" e "Residencial São Francisco" para "São
--                           Francisco") => NÃO escolhe; a IA pergunta qual bairro;
--   5) 'none'             : nada compatível (inclui "São Franc", "Francisco", outra cidade, e cliente com prefixo diferente do da
--                           zona). Nunca cai na taxa padrão, nunca escolhe a mais próxima/barata/primeira.
-- A normalização é só para casar: o endereço digitado pelo cliente continua intacto no rascunho e no pedido; a zona resolvida é
-- uma referência técnica (zone_id) separada. O evento address_validated registra como a zona foi escolhida (zone_match).
-- whatsapp_order_set_address e whatsapp_order_confirm (revalidação) passam a usar a MESMA função; o resto do corpo é idêntico.

create function public.delivery_bairro_parts(p_text text)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  v_t text;
  v_tok text[];
  v_first text;
  v_prefix text;
  v_rest text[];
begin
  v_t := btrim(regexp_replace(regexp_replace(public.delivery_norm_text(p_text), '[^a-z0-9 ]+', ' ', 'g'), '\s+', ' ', 'g'));
  if v_t = '' then
    return jsonb_build_object('full', '', 'prefix', null, 'core', '');
  end if;
  v_tok := string_to_array(v_t, ' ');
  v_first := case v_tok[1]
    when 'jd' then 'jardim' when 'jdm' then 'jardim' when 'vl' then 'vila' when 'res' then 'residencial' when 'resid' then 'residencial'
    when 'pq' then 'parque' when 'parq' then 'parque' when 'cj' then 'conjunto' when 'conj' then 'conjunto' when 'lot' then 'loteamento'
    else v_tok[1] end;
  v_tok[1] := v_first;
  if v_first in ('jardim', 'vila', 'residencial', 'parque', 'conjunto', 'loteamento', 'setor', 'bairro', 'distrito') and cardinality(v_tok) > 1 then
    if v_first = 'jardim' and v_tok[2] = 'residencial' and cardinality(v_tok) > 2 then
      v_prefix := 'jardim residencial'; v_rest := v_tok[3:cardinality(v_tok)];
    else
      v_prefix := v_first; v_rest := v_tok[2:cardinality(v_tok)];
    end if;
  else
    v_prefix := null; v_rest := v_tok;
  end if;
  return jsonb_build_object('full', array_to_string(v_tok, ' '), 'prefix', v_prefix, 'core', array_to_string(v_rest, ' '));
end;
$$;
revoke execute on function public.delivery_bairro_parts(text) from public, anon, authenticated, service_role;

create function public.delivery_zone_resolve(p_company_id uuid, p_city text, p_neighborhood text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_city_key text := public.delivery_norm_text(p_city);
  v_key text := public.delivery_norm_text(p_neighborhood);
  v_c jsonb := public.delivery_bairro_parts(p_neighborhood);
  v_ids uuid[];
  v_cands jsonb;
begin
  if v_city_key = '' or v_key = '' then
    return jsonb_build_object('result', 'none');
  end if;
  -- 2) exata (comportamento anterior)
  select array_agg(z.id) into v_ids from public.delivery_zones z
   where z.company_id = p_company_id and z.is_active and z.city_key = v_city_key and z.neighborhood_key = v_key;
  if cardinality(v_ids) = 1 then
    return jsonb_build_object('result', 'exact', 'zone_id', v_ids[1]);
  end if;
  -- 3) formas completas iguais (abreviações/pontuação)
  select array_agg(z.id) into v_ids from public.delivery_zones z
   where z.company_id = p_company_id and z.is_active and z.city_key = v_city_key
     and public.delivery_bairro_parts(z.neighborhood) ->> 'full' = v_c ->> 'full';
  if cardinality(v_ids) = 1 then
    return jsonb_build_object('result', 'normalized_match', 'zone_id', v_ids[1], 'matched_by', 'full');
  elsif cardinality(v_ids) > 1 then
    return jsonb_build_object('result', 'ambiguous', 'candidates',
      (select jsonb_agg(jsonb_build_object('neighborhood', z.neighborhood) order by z.neighborhood) from public.delivery_zones z where z.id = any(v_ids)));
  end if;
  -- 3b) cliente SEM prefixo: compara só o núcleo (o prefixo da zona é ignorado); com prefixo, exige prefixo igual (coberto acima)
  if v_c ->> 'prefix' is null and (v_c ->> 'core') <> '' then
    select array_agg(z.id), jsonb_agg(jsonb_build_object('neighborhood', z.neighborhood) order by z.neighborhood)
      into v_ids, v_cands
      from public.delivery_zones z
     where z.company_id = p_company_id and z.is_active and z.city_key = v_city_key
       and public.delivery_bairro_parts(z.neighborhood) ->> 'core' = v_c ->> 'core';
    if cardinality(v_ids) = 1 then
      return jsonb_build_object('result', 'normalized_match', 'zone_id', v_ids[1], 'matched_by', 'core');
    elsif cardinality(v_ids) > 1 then
      return jsonb_build_object('result', 'ambiguous', 'candidates', v_cands);
    end if;
  end if;
  return jsonb_build_object('result', 'none');
end;
$$;
revoke execute on function public.delivery_zone_resolve(uuid, text, text) from public, anon, authenticated, service_role;

create or replace function public.whatsapp_order_set_address(p_job_id uuid, p_fields jsonb, p_expected_latest uuid default null, p_tail_count integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx jsonb := public.whatsapp_order_ctx(p_job_id, p_expected_latest);
  v_company uuid;
  v_d public.whatsapp_order_drafts;
  v_settings jsonb;
  v_k text;
  v_street text; v_number text; v_comp text; v_neigh text; v_city text; v_state text; v_cep text; v_ref text; v_inferred boolean;
  v_clean jsonb;
  v_zone public.delivery_zones;
  v_found boolean := false;
  v_status text;
  v_city_single text;
  v_res jsonb;
begin
  if not (v_ctx ->> 'ok')::boolean then
    return jsonb_build_object('result', 'blocked', 'reason', v_ctx ->> 'reason');
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    return jsonb_build_object('result', 'invalid', 'reason', 'fields');
  end if;
  v_company := (v_ctx ->> 'company_id')::uuid;
  v_d := public.whatsapp_order_open_draft(v_company, (v_ctx ->> 'conversation_id')::uuid);
  if v_d.id is null then
    return jsonb_build_object('result', 'invalid', 'reason', 'no_draft');
  end if;
  if v_d.fulfillment is distinct from 'delivery' then
    return jsonb_build_object('result', 'invalid', 'reason', 'not_delivery');
  end if;
  v_settings := public.delivery_settings_effective(v_company);
  if not (v_settings ->> 'delivery_enabled')::boolean then
    return jsonb_build_object('result', 'invalid', 'reason', 'delivery_disabled');
  end if;
  for v_k in select jsonb_object_keys(p_fields) loop
    if v_k not in ('street', 'number', 'complement', 'neighborhood', 'city', 'state', 'cep', 'reference') then
      return jsonb_build_object('result', 'invalid', 'reason', 'field_unknown');
    end if;
  end loop;

  -- mescla: campo presente (vazio = limpar) substitui; ausente mantém
  v_street := case when p_fields ? 'street' then nullif(btrim(regexp_replace(coalesce(p_fields ->> 'street', ''), '\s+', ' ', 'g')), '') else v_d.addr_street end;
  v_number := case when p_fields ? 'number' then nullif(btrim(regexp_replace(coalesce(p_fields ->> 'number', ''), '\s+', ' ', 'g')), '') else v_d.addr_number end;
  v_comp := case when p_fields ? 'complement' then nullif(btrim(regexp_replace(coalesce(p_fields ->> 'complement', ''), '\s+', ' ', 'g')), '') else v_d.addr_complement end;
  v_neigh := case when p_fields ? 'neighborhood' then nullif(btrim(regexp_replace(coalesce(p_fields ->> 'neighborhood', ''), '\s+', ' ', 'g')), '') else v_d.addr_neighborhood end;
  v_city := case when p_fields ? 'city' then nullif(btrim(regexp_replace(coalesce(p_fields ->> 'city', ''), '\s+', ' ', 'g')), '') else v_d.addr_city end;
  v_state := case when p_fields ? 'state' then nullif(upper(btrim(coalesce(p_fields ->> 'state', ''))), '') else v_d.addr_state end;
  v_cep := case when p_fields ? 'cep' then nullif(regexp_replace(coalesce(p_fields ->> 'cep', ''), '\D', '', 'g'), '') else v_d.addr_cep end;
  v_ref := case when p_fields ? 'reference' then nullif(btrim(regexp_replace(coalesce(p_fields ->> 'reference', ''), '\s+', ' ', 'g')), '') else v_d.addr_reference end;
  v_inferred := case when p_fields ? 'city' and v_city is not null then false else v_d.addr_city_inferred end;

  -- P2: a cidade só é inferida quando TODAS as zonas ativas são da mesma cidade (e aparece no resumo para o cliente confirmar).
  -- A UF não existe no cadastro de zonas/empresa: nunca é inferida (a IA pergunta).
  if v_city is null then
    select case when count(distinct z.city_key) = 1 then min(z.city) end into v_city_single
      from public.delivery_zones z where z.company_id = v_company and z.is_active;
    if v_city_single is not null then
      v_city := v_city_single; v_inferred := true;
    end if;
  end if;

  begin
    if v_street is not null and v_neigh is not null and v_city is not null and v_state is not null then
      -- validação OFICIAL (rua, bairro, cidade, UF válida, CEP de 8 dígitos, limites)
      v_clean := public.delivery_clean_address(null, v_cep, v_street, v_number, v_comp, v_neigh, v_city, v_state, v_ref, null, null);
      -- zona: exata, depois normalizada (abreviações/prefixos) SÓ quando houver UMA zona compatível; várias => ambiguous (pergunta)
      v_res := public.delivery_zone_resolve(v_company, v_clean ->> 'city', v_clean ->> 'neighborhood');
      v_found := (v_res ->> 'result') in ('exact', 'normalized_match');
      if v_found then
        select * into v_zone from public.delivery_zones z where z.id = (v_res ->> 'zone_id')::uuid and z.company_id = v_company;
      end if;
      update public.whatsapp_order_drafts
         set addr_street = v_clean ->> 'street', addr_number = v_clean ->> 'number', addr_complement = v_clean ->> 'complement',
             addr_neighborhood = v_clean ->> 'neighborhood', addr_city = v_clean ->> 'city', addr_state = v_clean ->> 'state',
             addr_cep = v_clean ->> 'cep', addr_reference = v_clean ->> 'reference', addr_city_inferred = v_inferred,
             zone_id = case when v_found then v_zone.id end, delivery_fee = case when v_found then v_zone.fee end,
             fee_source = case when v_found then 'zone' end,
             estimated_minutes = case when v_found then coalesce(v_zone.estimated_minutes, (v_settings ->> 'delivery_minutes')::integer) end
       where id = v_d.id;
      v_status := case when v_found then 'ok' when v_res ->> 'result' = 'ambiguous' then 'ambiguous_zone' else 'out_of_zone' end;
      perform public.whatsapp_order_event(v_company, v_d.id, 'address_validated',
                                          jsonb_build_object('zone_found', v_found, 'zone_match', v_res ->> 'result'));
    else
      -- incompleto: guarda o que veio (limites do CHECK) e zera zona/taxa
      update public.whatsapp_order_drafts
         set addr_street = v_street, addr_number = v_number, addr_complement = v_comp, addr_neighborhood = v_neigh, addr_city = v_city,
             addr_state = v_state, addr_cep = v_cep, addr_reference = v_ref, addr_city_inferred = v_inferred,
             zone_id = null, delivery_fee = null, fee_source = null, estimated_minutes = null
       where id = v_d.id;
      v_status := 'incomplete';
      perform public.whatsapp_order_event(v_company, v_d.id, 'address_set', '{}'::jsonb);
    end if;
  exception
    when sqlstate 'PT400' then
      return jsonb_build_object('result', 'invalid', 'reason', 'address_invalid', 'message', sqlerrm);
    when check_violation or string_data_right_truncation then
      return jsonb_build_object('result', 'invalid', 'reason', 'address_invalid');
  end;

  perform public.whatsapp_order_recalc(v_d.id);
  update public.whatsapp_order_drafts
     set version = version + 1,
         status = case when status = 'awaiting_confirmation' then 'collecting' else status end,
         summary_version = null, summary_message_id = null,
         last_customer_activity_at = now(), expires_at = now() + interval '60 minutes',
         last_ops_job_id = case when p_tail_count is not null then p_job_id else last_ops_job_id end,
         last_ops_tail_count = case when p_tail_count is not null then p_tail_count else last_ops_tail_count end
   where id = v_d.id;
  return jsonb_build_object('result', 'ok', 'address_status', v_status, 'zone_match', v_res ->> 'result',
                            'zone_candidates', case when v_status = 'ambiguous_zone' then v_res -> 'candidates' end,
                            'state', public.whatsapp_order_state(v_d.id));
end;
$$;

create or replace function public.whatsapp_order_confirm(p_job_id uuid, p_confirm_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx jsonb := public.whatsapp_order_ctx(p_job_id);
  v_company uuid;
  v_conv uuid;
  v_d public.whatsapp_order_drafts;
  v_done public.whatsapp_order_drafts;
  v_msg public.whatsapp_messages;
  v_sum public.whatsapp_messages;
  v_before jsonb;
  v_changes jsonb := '[]'::jsonb;
  v_old_fee numeric(12, 2);
  v_old_total numeric(12, 2);
  v_state jsonb;
  v_zone public.delivery_zones;
  v_zone_found boolean;
  v_zres jsonb;
  v_settings jsonb;
  v_items jsonb;
  v_addr jsonb;
  v_res jsonb;
  v_fee numeric(12, 2);
  v_err text;
  v_errmsg text;
  v_has_unavailable boolean;
begin
  if not (v_ctx ->> 'ok')::boolean then
    return jsonb_build_object('result', 'blocked', 'reason', v_ctx ->> 'reason');
  end if;
  v_company := (v_ctx ->> 'company_id')::uuid;
  v_conv := (v_ctx ->> 'conversation_id')::uuid;

  -- 1) a confirmação é a ÚLTIMA mensagem do lote, do cliente, texto, desta conversa
  if (v_ctx ->> 'latest_message_id')::uuid is distinct from p_confirm_message_id then
    return jsonb_build_object('result', 'invalid', 'reason', 'not_latest_message');
  end if;
  select * into v_msg from public.whatsapp_messages
   where id = p_confirm_message_id and company_id = v_company and conversation_id = v_conv and direction = 'inbound' and type = 'text';
  if not found then
    return jsonb_build_object('result', 'invalid', 'reason', 'message');
  end if;

  -- 2) rascunho aberto (travado) ou, se não há, o pedido já confirmado desta confirmação/recente (idempotência)
  v_d := public.whatsapp_order_open_draft(v_company, v_conv);
  -- "confirmar" repetido: é a MESMA mensagem (retry) ou uma das 3 mensagens do cliente que a antecedem, nos últimos 10 min,
  -- desde que nenhum rascunho novo tenha nascido depois do pedido confirmado.
  -- Qualquer outra conversa no meio (ou muito tempo depois) NÃO herda o pedido antigo.
  select * into v_done from public.whatsapp_order_drafts d
   where d.company_id = v_company and d.conversation_id = v_conv and d.status = 'confirmed'
     and (d.confirmed_by_message_id = p_confirm_message_id
          or (d.confirmed_at > now() - interval '10 minutes'
              -- e nenhum rascunho NOVO (aberto, falho, cancelado...) nasceu depois desse pedido
              and not exists (select 1 from public.whatsapp_order_drafts n where n.conversation_id = v_conv and n.created_at > d.created_at and n.id <> d.id)
              and d.confirmed_by_message_id in (
                select m.id from public.whatsapp_messages m
                 where m.company_id = v_company and m.conversation_id = v_conv and m.direction = 'inbound'
                   and (m.created_at, m.id) < (v_msg.created_at, v_msg.id)
                 order by m.created_at desc, m.id desc limit 3)))
   order by (d.confirmed_by_message_id = p_confirm_message_id) desc, d.confirmed_at desc limit 1;
  if v_d.id is null then
    if v_done.id is not null then
      return jsonb_build_object('result', 'already_confirmed', 'delivery_order_id', v_done.delivery_order_id, 'service_order_id', v_done.service_order_id);
    end if;
    return jsonb_build_object('result', 'no_draft');
  end if;
  if v_d.status <> 'awaiting_confirmation' then
    return jsonb_build_object('result', 'not_awaiting', 'state', public.whatsapp_order_state(v_d.id));
  end if;
  if v_d.summary_version is distinct from v_d.version then
    return jsonb_build_object('result', 'stale_summary', 'state', public.whatsapp_order_state(v_d.id));
  end if;
  -- o resumo foi ENVIADO e a confirmação veio DEPOIS dele
  select * into v_sum from public.whatsapp_messages
   where id = v_d.summary_message_id and company_id = v_company and conversation_id = v_conv and direction = 'outbound'
     and status in ('sent', 'delivered', 'read');
  if not found then
    return jsonb_build_object('result', 'summary_not_sent', 'state', public.whatsapp_order_state(v_d.id));
  end if;
  if v_msg.created_at <= v_sum.created_at then
    return jsonb_build_object('result', 'confirm_before_summary');
  end if;
  perform public.whatsapp_order_event(v_company, v_d.id, 'confirm_received', jsonb_build_object('version', v_d.version));

  -- 3) REVALIDAÇÃO: trava produtos (controlados FOR UPDATE; demais FOR SHARE; sempre em ordem de id)
  perform 1 from public.products p
   where p.company_id = v_company and p.stock_control = 'quantity'
     and p.id in (select i.product_id from public.whatsapp_order_draft_items i where i.draft_id = v_d.id)
   order by p.id for update;
  perform 1 from public.products p
   where p.company_id = v_company and p.stock_control <> 'quantity'
     and p.id in (select i.product_id from public.whatsapp_order_draft_items i where i.draft_id = v_d.id)
   order by p.id for share;

  v_old_fee := case when v_d.fulfillment = 'delivery' then coalesce(v_d.delivery_fee, 0) else 0 end;
  v_old_total := v_d.grand_total;
  select coalesce(jsonb_agg(jsonb_build_object('item_id', i.id, 'name', i.product_name_snapshot, 'unit_price', i.unit_price_snapshot, 'quantity', i.quantity)
                            order by i.position), '[]'::jsonb)
    into v_before from public.whatsapp_order_draft_items i where i.draft_id = v_d.id;

  -- taxa/zona de AGORA (a zona pode ter sido desativada, removida ou ter mudado a taxa)
  v_settings := public.delivery_settings_effective(v_company);
  if v_d.fulfillment = 'delivery' and v_d.addr_city is not null and v_d.addr_neighborhood is not null then
    -- mesma resolução do set_address (exata / normalizada única); ambiguidade ou nenhuma => sem zona => needs_changes
    v_zres := public.delivery_zone_resolve(v_company, v_d.addr_city, v_d.addr_neighborhood);
    v_zone_found := (v_zres ->> 'result') in ('exact', 'normalized_match');
    if v_zone_found then
      select * into v_zone from public.delivery_zones z where z.id = (v_zres ->> 'zone_id')::uuid and z.company_id = v_company;
    end if;
    update public.whatsapp_order_drafts
       set zone_id = case when v_zone_found then v_zone.id end, delivery_fee = case when v_zone_found then v_zone.fee end,
           fee_source = case when v_zone_found then 'zone' end,
           estimated_minutes = case when v_zone_found then coalesce(v_zone.estimated_minutes, (v_settings ->> 'delivery_minutes')::integer) end
     where id = v_d.id;
  end if;
  perform public.whatsapp_order_recalc(v_d.id);   -- preço de agora (produto + opções), completude, totais, troco

  select coalesce(jsonb_agg(jsonb_build_object('name', n.product_name_snapshot, 'old', o.unit_price, 'new', n.unit_price_snapshot, 'quantity', n.quantity) order by n.position), '[]'::jsonb)
    into v_changes
    from public.whatsapp_order_draft_items n
    join lateral (select (e ->> 'unit_price')::numeric as unit_price from jsonb_array_elements(v_before) e where (e ->> 'item_id')::uuid = n.id) o on true
   where n.draft_id = v_d.id and o.unit_price is distinct from n.unit_price_snapshot;
  select * into v_d from public.whatsapp_order_drafts where id = v_d.id;
  v_fee := case when v_d.fulfillment = 'delivery' then coalesce(v_d.delivery_fee, 0) else 0 end;
  v_state := public.whatsapp_order_state(v_d.id);
  v_has_unavailable := exists (select 1 from jsonb_array_elements(v_state -> 'pendings') p where p ->> 'code' = 'item_unavailable');

  if jsonb_array_length(v_state -> 'pendings') > 0 then
    -- algo deixou de valer (indisponível, opção inválida, fora da zona, forma de pagamento, troco...): volta a montar
    update public.whatsapp_order_drafts
       set status = 'collecting', version = version + 1, summary_version = null, summary_message_id = null
     where id = v_d.id;
    perform public.whatsapp_order_event(v_company, v_d.id, case when v_has_unavailable then 'unavailable' else 'revalidated' end,
                                        jsonb_build_object('pendings', jsonb_array_length(v_state -> 'pendings')));
    return jsonb_build_object('result', 'needs_changes', 'price_changes', v_changes, 'state', public.whatsapp_order_state(v_d.id));
  end if;
  if jsonb_array_length(v_changes) > 0 or v_fee is distinct from v_old_fee or v_d.grand_total is distinct from v_old_total then
    -- preço ou taxa mudou: NÃO cria; nova confirmação sobre o resumo novo
    update public.whatsapp_order_drafts
       set status = 'collecting', version = version + 1, summary_version = null, summary_message_id = null
     where id = v_d.id;
    perform public.whatsapp_order_event(v_company, v_d.id, 'price_changed',
                                        jsonb_build_object('old_total', v_old_total, 'new_total', v_d.grand_total, 'items', jsonb_array_length(v_changes)));
    return jsonb_build_object('result', 'price_changed', 'price_changes', v_changes, 'old_total', v_old_total, 'old_fee', v_old_fee,
                              'state', public.whatsapp_order_state(v_d.id));
  end if;
  perform public.whatsapp_order_event(v_company, v_d.id, 'revalidated', jsonb_build_object('total', v_d.grand_total));

  -- 4) CRIAÇÃO pelo motor oficial (subtransação: qualquer erro desfaz o pedido inteiro)
  select jsonb_agg(jsonb_build_object('product_id', i.product_id, 'quantity', i.quantity, 'notes', i.notes,
           'modifier_option_ids', coalesce((select jsonb_agg(m.modifier_option_id order by m.modifier_option_id)
                                              from public.whatsapp_order_draft_item_modifiers m where m.draft_item_id = i.id), '[]'::jsonb))
           order by i.position)
    into v_items from public.whatsapp_order_draft_items i where i.draft_id = v_d.id;
  v_addr := case when v_d.fulfillment = 'delivery' then jsonb_build_object(
              'street', v_d.addr_street, 'number', v_d.addr_number, 'complement', v_d.addr_complement, 'neighborhood', v_d.addr_neighborhood,
              'city', v_d.addr_city, 'state', v_d.addr_state, 'cep', v_d.addr_cep, 'reference', v_d.addr_reference) end;
  begin
    v_res := public.create_delivery_order_engine(
      v_company, null, 'whatsapp_ai', null, v_d.id, v_d.fulfillment, v_items, v_d.customer_id, v_d.contact_name, v_d.contact_phone,
      null, v_addr, null, null, v_d.expected_method, v_d.cash_change_for, v_d.notes, 'whatsapp', v_conv, v_d.id);
    -- defesa em profundidade: o que o motor gravou tem de ser IGUAL ao que o cliente confirmou
    if (v_res ->> 'items_subtotal')::numeric is distinct from v_d.items_total
       or coalesce((v_res ->> 'delivery_fee')::numeric, 0) is distinct from v_fee
       or (v_res ->> 'replayed')::boolean then
      raise exception 'totals_mismatch' using errcode = 'PT409';
    end if;
  exception when others then
    v_err := sqlstate;
    v_errmsg := sqlerrm;
    v_res := null;
  end;

  if v_res is null then
    if v_err = 'PT409' and (v_errmsg like 'Estoque insuficiente%' or v_errmsg like 'Este produto está indisponível%' or v_errmsg like 'Produto inativo%'
                            or v_errmsg like 'Categoria do produto inativa%') then
      -- corrida de estoque/disponibilidade entre a revalidação e o motor (não deveria ocorrer com os locks): volta a montar
      update public.whatsapp_order_drafts
         set status = 'collecting', version = version + 1, summary_version = null, summary_message_id = null
       where id = v_d.id;
      perform public.whatsapp_order_event(v_company, v_d.id, 'unavailable', jsonb_build_object('race', true));
      return jsonb_build_object('result', 'needs_changes', 'price_changes', '[]'::jsonb, 'state', public.whatsapp_order_state(v_d.id));
    end if;
    update public.whatsapp_order_drafts set status = 'failed', failure_code = left('engine_' || coalesce(v_err, 'unknown'), 60) where id = v_d.id;
    perform public.whatsapp_order_event(v_company, v_d.id, 'failed', jsonb_build_object('code', coalesce(v_err, 'unknown')));
    return jsonb_build_object('result', 'failed', 'code', coalesce(v_err, 'unknown'));
  end if;

  update public.whatsapp_order_drafts
     set status = 'confirmed', confirmed_at = now(), confirmed_by_message_id = p_confirm_message_id,
         delivery_order_id = (v_res ->> 'delivery_order_id')::uuid, service_order_id = (v_res ->> 'service_order_id')::uuid
   where id = v_d.id;
  perform public.whatsapp_order_event(v_company, v_d.id, 'order_created',
                                      jsonb_build_object('delivery_order_id', v_res ->> 'delivery_order_id', 'total', v_res -> 'total', 'fulfillment', v_d.fulfillment));
  return jsonb_build_object('result', 'created', 'delivery_order_id', (v_res ->> 'delivery_order_id')::uuid,
                            'service_order_id', (v_res ->> 'service_order_id')::uuid, 'total', v_res -> 'total',
                            'fulfillment', v_d.fulfillment);
end;
$$;

-- O motor oficial também resolvia a zona por chave exata; só o caminho da IA (v_ai) passa a usar a resolução tolerante.
-- O caminho humano fica byte a byte como era (mesma consulta, mesma taxa padrão/manual).
create or replace function public.create_delivery_order_engine(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_actor_via text,
  p_actor_role public.company_role,
  p_client_request_id uuid,
  p_fulfillment text,
  p_items jsonb,
  p_customer_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_address_id uuid,
  p_address jsonb,
  p_manual_fee numeric,
  p_payment_timing text,
  p_expected_method text,
  p_cash_change_for numeric,
  p_notes text,
  p_channel text,
  p_whatsapp_conversation_id uuid,
  p_whatsapp_order_draft_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ai boolean := (p_actor_via = 'whatsapp_ai');
  v_role public.company_role := p_actor_role;
  v_existing public.delivery_orders;
  v_settings jsonb;
  v_customer public.customers;
  v_addr public.customer_addresses;
  v_clean jsonb;
  v_a_source_id uuid;
  v_a_street text;
  v_a_number text;
  v_a_complement text;
  v_a_neigh text;
  v_a_city text;
  v_a_state text;
  v_a_cep text;
  v_a_ref text;
  v_zone public.delivery_zones;
  v_zone_found boolean := false;
  v_zres jsonb;
  v_name text;
  v_phone text;
  v_fee numeric(12, 2) := 0;
  v_source text := 'none';
  v_old_fee jsonb := null;
  v_override boolean := false;
  v_minutes integer;
  v_timing text;
  v_method text := nullif(btrim(coalesce(p_expected_method, '')), '');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_session public.service_sessions;
  v_order public.service_orders;
  v_subtotal numeric(12, 2);
  v_total numeric(12, 2);
  v_ready timestamptz;
  v_deliv timestamptz;
  v_do public.delivery_orders;
begin
  -- Ator, canal e vínculo coerentes (as mesmas regras dos CHECKs de autoria, com erro legível).
  if p_actor_via is null or p_actor_via not in ('user', 'whatsapp_ai')
     or (p_actor_via = 'user') <> (p_actor_user_id is not null) then
    raise exception 'Ator do pedido inválido.' using errcode = 'PT400';
  end if;
  if p_channel is null or p_channel not in ('counter', 'phone', 'whatsapp', 'other') then
    raise exception 'Canal do pedido inválido.' using errcode = 'PT400';
  end if;
  if v_ai then
    if p_actor_role is not null or p_channel <> 'whatsapp'
       or p_whatsapp_conversation_id is null or p_whatsapp_order_draft_id is null then
      raise exception 'Pedido do WhatsApp sem a origem completa (conversa e rascunho).' using errcode = 'PT400';
    end if;
    -- a IA nunca usa taxa manual, endereço cadastrado nem cliente inexistente na empresa
    if p_manual_fee is not null or p_address_id is not null then
      raise exception 'Pedido do WhatsApp não aceita taxa manual nem endereço cadastrado.' using errcode = 'PT400';
    end if;
    perform public.assert_company_module(p_company_id, 'delivery');
    perform public.assert_company_module(p_company_id, 'whatsapp');
  else
    if p_whatsapp_conversation_id is not null or p_whatsapp_order_draft_id is not null or p_address is not null then
      raise exception 'Dados de origem do WhatsApp só valem para o pedido da IA.' using errcode = 'PT400';
    end if;
  end if;

  if p_client_request_id is null then
    raise exception 'Identificador da requisição ausente.' using errcode = 'PT400';
  end if;
  if p_fulfillment is null or p_fulfillment not in ('delivery', 'pickup') then
    raise exception 'Informe entrega ou retirada.' using errcode = 'PT400';
  end if;

  -- Idempotência: serializa requisições iguais e devolve o pedido já criado.
  perform pg_advisory_xact_lock(hashtextextended('delivery:' || p_company_id::text || ':' || p_client_request_id::text, 0));
  select * into v_existing from public.delivery_orders
  where company_id = p_company_id and client_request_id = p_client_request_id;
  if found then
    return public.delivery_order_summary(v_existing.id, true);
  end if;

  -- records inicializados (campos nulos): o pickup nunca os preenche e o INSERT os referencia
  select * into v_addr from public.customer_addresses where false;
  select * into v_zone from public.delivery_zones where false;

  v_settings := public.delivery_settings_effective(p_company_id);
  if p_fulfillment = 'delivery' and not (v_settings ->> 'delivery_enabled')::boolean then
    raise exception 'A entrega está desativada nas configurações do Delivery.' using errcode = 'PT409';
  end if;
  if p_fulfillment = 'pickup' and not (v_settings ->> 'pickup_enabled')::boolean then
    raise exception 'A retirada está desativada nas configurações do Delivery.' using errcode = 'PT409';
  end if;

  if v_notes is not null and char_length(v_notes) > 300 then
    raise exception 'A observação pode ter no máximo 300 caracteres.' using errcode = 'PT400';
  end if;

  -- Cliente (snapshot de nome e telefone)
  if p_customer_id is not null then
    select * into v_customer from public.customers where id = p_customer_id and company_id = p_company_id;
    if not found then
      raise exception 'Cliente não encontrado.' using errcode = 'PT404';
    end if;
    if not v_customer.is_active then
      raise exception 'Este cliente está inativo.' using errcode = 'PT409';
    end if;
    v_name := v_customer.name;
    v_phone := coalesce(public.delivery_digits(p_customer_phone), v_customer.phone, v_customer.whatsapp);
  else
    -- sem cliente cadastrado: só a retirada pelo caminho humano; o pedido da IA aceita também a entrega (snapshot do contato)
    if p_fulfillment = 'delivery' and not v_ai then
      raise exception 'Informe o cliente cadastrado para a entrega.' using errcode = 'PT400';
    end if;
    v_name := nullif(btrim(regexp_replace(coalesce(p_customer_name, ''), '\s+', ' ', 'g')), '');
    if v_name is null then
      raise exception 'Informe o cliente.' using errcode = 'PT400';
    end if;
    if char_length(v_name) > 80 then
      raise exception 'O nome do cliente pode ter no máximo 80 caracteres.' using errcode = 'PT400';
    end if;
    v_phone := public.delivery_digits(p_customer_phone);
    if v_ai and v_phone is null then
      raise exception 'Informe o telefone do contato.' using errcode = 'PT400';
    end if;
  end if;
  -- E.164 sem o "+": 8 a 15 dígitos (mesmo limite do CHECK de delivery_orders.customer_phone)
  if v_phone is not null and char_length(v_phone) not between 8 and 15 then
    raise exception 'Telefone inválido. Informe o DDD e o número.' using errcode = 'PT400';
  end if;

  -- Pagamento esperado (informação; o recebimento real é no Caixa)
  v_timing := coalesce(nullif(btrim(coalesce(p_payment_timing, '')), ''),
                       case p_fulfillment when 'delivery' then 'on_delivery' else 'on_pickup' end);
  if (p_fulfillment = 'delivery' and v_timing not in ('on_order', 'on_delivery'))
     or (p_fulfillment = 'pickup' and v_timing not in ('on_order', 'on_pickup')) then
    raise exception 'Momento do pagamento inválido para este tipo de pedido.' using errcode = 'PT400';
  end if;
  if v_method is not null and v_method not in ('cash', 'pix', 'debit_card', 'credit_card', 'other') then
    raise exception 'Forma de pagamento inválida.' using errcode = 'PT400';
  end if;
  if p_cash_change_for is not null then
    if v_method is distinct from 'cash' then
      raise exception 'Troco só se aplica a pagamento em dinheiro.' using errcode = 'PT400';
    end if;
    if p_cash_change_for <= 0 or p_cash_change_for >= 100000000 or p_cash_change_for <> round(p_cash_change_for, 2) then
      raise exception 'Valor do troco inválido.' using errcode = 'PT400';
    end if;
  end if;

  -- Endereço (entrega). Humano: SÓ de customer_addresses, ativo, da mesma empresa e do mesmo cliente.
  -- IA: snapshot (p_address) validado e normalizado por delivery_clean_address; nada é gravado em customer_addresses.
  if p_fulfillment = 'delivery' then
    if not v_ai then
      if p_address_id is null then
        raise exception 'Informe o endereço de entrega.' using errcode = 'PT400';
      end if;
      select * into v_addr from public.customer_addresses where id = p_address_id and company_id = p_company_id;
      if not found then
        raise exception 'Endereço não encontrado.' using errcode = 'PT404';
      end if;
      if not v_addr.is_active then
        raise exception 'Este endereço está desativado.' using errcode = 'PT409';
      end if;
      if v_addr.customer_id <> p_customer_id then
        raise exception 'O endereço não pertence a este cliente.' using errcode = 'PT400';
      end if;
      v_a_source_id := v_addr.id; v_a_street := v_addr.street; v_a_number := v_addr.number; v_a_complement := v_addr.complement;
      v_a_neigh := v_addr.neighborhood; v_a_city := v_addr.city; v_a_state := v_addr.state; v_a_cep := v_addr.cep;
      v_a_ref := v_addr.reference;
    else
      if p_address is null or jsonb_typeof(p_address) <> 'object' then
        raise exception 'Informe o endereço de entrega.' using errcode = 'PT400';
      end if;
      v_clean := public.delivery_clean_address(
        null, p_address ->> 'cep', p_address ->> 'street', p_address ->> 'number', p_address ->> 'complement',
        p_address ->> 'neighborhood', p_address ->> 'city', p_address ->> 'state', p_address ->> 'reference', null, null);
      v_a_source_id := null; v_a_street := v_clean ->> 'street'; v_a_number := v_clean ->> 'number';
      v_a_complement := v_clean ->> 'complement'; v_a_neigh := v_clean ->> 'neighborhood'; v_a_city := v_clean ->> 'city';
      v_a_state := v_clean ->> 'state'; v_a_cep := v_clean ->> 'cep'; v_a_ref := v_clean ->> 'reference';
    end if;
  elsif p_address_id is not null or p_address is not null then
    raise exception 'Retirada não usa endereço de entrega.' using errcode = 'PT400';
  end if;

  -- Taxa e previsão (servidor)
  if p_manual_fee is not null and (p_manual_fee < 0 or p_manual_fee >= 100000 or p_manual_fee <> round(p_manual_fee, 2)) then
    raise exception 'A taxa manual deve ser zero ou mais, com até 2 casas decimais.' using errcode = 'PT400';
  end if;

  if p_fulfillment = 'pickup' then
    if p_manual_fee is not null then
      raise exception 'Retirada não tem taxa de entrega.' using errcode = 'PT400';
    end if;
    v_ready := now() + make_interval(mins => (v_settings ->> 'pickup_minutes')::integer);
  else
    select * into v_zone
    from public.delivery_zones z
    where z.company_id = p_company_id and z.is_active
      and z.city_key = public.delivery_norm_text(v_a_city)
      and z.neighborhood_key = public.delivery_norm_text(v_a_neigh);
    v_zone_found := found;
    -- SÓ a IA: mesma resolução tolerante/única do rascunho (abreviações, prefixo); o fluxo humano continua exato como sempre
    if v_ai and not v_zone_found then
      v_zres := public.delivery_zone_resolve(p_company_id, v_a_city, v_a_neigh);
      if (v_zres ->> 'result') in ('exact', 'normalized_match') then
        select * into v_zone from public.delivery_zones z where z.id = (v_zres ->> 'zone_id')::uuid and z.company_id = p_company_id;
        v_zone_found := found;
      end if;
    end if;

    if v_ai then
      -- P1: a IA só entrega em ZONA ATIVA cadastrada. Nunca usa a taxa padrão nem taxa manual.
      if not v_zone_found then
        raise exception 'Este endereço está fora das zonas de entrega atendidas.' using errcode = 'PT409';
      end if;
      v_fee := v_zone.fee; v_source := 'zone';
    else
      if v_zone_found then
        v_fee := v_zone.fee; v_source := 'zone';
      elsif (v_settings ->> 'default_fee') is not null then
        v_fee := (v_settings ->> 'default_fee')::numeric; v_source := 'default';
      end if;

      if p_manual_fee is not null then
        if not (v_settings ->> 'allow_manual_fee')::boolean then
          raise exception 'O ajuste manual da taxa está desativado nas configurações do Delivery.' using errcode = 'PT403';
        end if;
        if v_source <> 'none' then
          if v_role not in ('owner', 'admin') then
            raise exception 'Já existe taxa cadastrada para este bairro. Só owner ou admin podem alterá-la.' using errcode = 'PT403';
          end if;
          v_old_fee := jsonb_build_object('fee', v_fee, 'source', v_source);
        end if;
        v_fee := p_manual_fee; v_source := 'manual'; v_override := true;
      elsif v_source = 'none' then
        raise exception 'Não há taxa cadastrada para este bairro. Cadastre a zona ou informe a taxa manual.' using errcode = 'PT409';
      end if;
    end if;

    v_minutes := coalesce(case when v_zone_found then v_zone.estimated_minutes end, (v_settings ->> 'delivery_minutes')::integer);
    v_deliv := now() + make_interval(mins => v_minutes);
  end if;

  -- Atendimento delivery (sem ponto) + pedido pelo MOTOR ÚNICO (preço, modificadores, estoque, setor, snapshots)
  insert into public.service_sessions (company_id, kind, customer_name, customer_id, status, opened_by, created_via)
  values (p_company_id, 'delivery', v_name, p_customer_id, 'open', p_actor_user_id, p_actor_via)
  returning * into v_session;

  v_order := public.submit_service_order_engine(v_session.id, p_items, 'delivery', false, p_actor_user_id, p_actor_via);

  select coalesce(sum(i.quantity * i.unit_price), 0)::numeric(12, 2) into v_subtotal
  from public.service_order_items i where i.company_id = p_company_id and i.order_id = v_order.id;
  v_total := v_subtotal + v_fee;

  if p_cash_change_for is not null and p_cash_change_for < v_total then
    raise exception 'O troco deve ser para um valor igual ou maior que o total (R$ %).',
      replace(to_char(v_total, 'FM9999999990.00'), '.', ',') using errcode = 'PT400';
  end if;

  insert into public.delivery_orders (
    company_id, service_session_id, service_order_id, client_request_id, fulfillment, delivery_status,
    customer_id, customer_name, customer_phone, source_address_id,
    addr_street, addr_number, addr_complement, addr_neighborhood, addr_city, addr_state, addr_cep, addr_reference,
    delivery_fee, fee_source, zone_id, estimated_ready_at, estimated_delivery_at,
    payment_timing, expected_method, cash_change_for, notes, created_by,
    channel, created_via, whatsapp_conversation_id, whatsapp_order_draft_id
  ) values (
    p_company_id, v_session.id, v_order.id, p_client_request_id, p_fulfillment, 'confirmed',
    p_customer_id, v_name, v_phone, case when p_fulfillment = 'delivery' then v_a_source_id end,
    case when p_fulfillment = 'delivery' then v_a_street end, case when p_fulfillment = 'delivery' then v_a_number end,
    case when p_fulfillment = 'delivery' then v_a_complement end, case when p_fulfillment = 'delivery' then v_a_neigh end,
    case when p_fulfillment = 'delivery' then v_a_city end, case when p_fulfillment = 'delivery' then v_a_state end,
    case when p_fulfillment = 'delivery' then v_a_cep end, case when p_fulfillment = 'delivery' then v_a_ref end,
    v_fee, v_source, case when v_source = 'zone' then v_zone.id end, v_ready, v_deliv,
    v_timing, v_method, p_cash_change_for, v_notes, p_actor_user_id,
    p_channel, p_actor_via, p_whatsapp_conversation_id, p_whatsapp_order_draft_id
  ) returning * into v_do;

  insert into public.delivery_order_events (company_id, delivery_order_id, event_type, actor_user_id, new_value)
  values (p_company_id, v_do.id, 'created', p_actor_user_id,
          jsonb_build_object('fulfillment', p_fulfillment, 'delivery_fee', v_fee, 'fee_source', v_source, 'total', v_total)
          || case when v_ai then jsonb_build_object(
               'created_via', 'whatsapp_ai',
               'whatsapp_conversation_id', p_whatsapp_conversation_id,
               'whatsapp_order_draft_id', p_whatsapp_order_draft_id) else '{}'::jsonb end);
  if v_override then
    insert into public.delivery_order_events (company_id, delivery_order_id, event_type, actor_user_id, old_value, new_value)
    values (p_company_id, v_do.id, 'fee_overridden', p_actor_user_id, v_old_fee,
            jsonb_build_object('fee', v_fee, 'source', 'manual'));
  end if;

  -- Impressão é complementar (mesmo padrão de submit_service_order): erro aqui nunca derruba o pedido.
  begin
    perform public.enqueue_order_print_jobs(v_order.id);
  exception when others then
    raise warning 'Falha ao enfileirar impressão (delivery) %: %', v_order.id, sqlerrm;
    perform public.record_print_enqueue_failure(p_company_id, 'production_order', v_order.id, null, sqlerrm);
  end;

  return public.delivery_order_summary(v_do.id, false);
end;
$$;

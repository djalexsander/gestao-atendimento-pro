-- Etapa 7.10D (LOCAL, NÃO aplicada): busca UNIFICADA de contatos. Substitui o corpo de whatsapp_contacts_query (mesma assinatura, CREATE OR REPLACE),
-- que alimenta list_whatsapp_contacts e search_whatsapp_contacts. Nenhuma tabela, índice, trigger, política ou outra função muda; sem interface;
-- sem tocar em conversas, mensagens, IA, Coexistence, webhooks, conexões ou sincronização Meta; nenhuma conversa é criada.
--
-- Fontes: whatsapp_conversations (não excluídas) + customers (ativos) + whatsapp_contacts (manuais ATIVOS; arquivados somem). Uma linha por (empresa, chave
-- normalizada do telefone): contact_key da tabela manual = whatsapp_contact_key(phone, false), a mesma chave das conversas (nono dígito incluso).
-- Nome: manual > cliente > perfil do WhatsApp > telefone. Cliente de um contato manual vale como vínculo (igual ao vínculo da conversa); vários
-- candidatos continuam sinalizados em customer_matches. A busca também olha o nome manual (nunca as observações, que não saem na listagem).
-- Saída: as mesmas chaves da 7.2 (source segue conversation/customer/both; 'manual' só quando existe contato manual SEM conversa) mais is_manual,
-- manual_contact_id e sources (lista das fontes presentes). name_source ganha o valor 'manual'. Sem contatos manuais o resultado é o da 7.2.

create or replace function public.whatsapp_contacts_query(
  p_company_id uuid,
  p_query text,
  p_limit integer,
  p_after_sort text,
  p_after_key text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
-- plano com os valores reais (o plano genérico escolhia junções em laço aninhado com volume)
set plan_cache_mode = force_custom_plan
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_query text := nullif(btrim(coalesce(p_query, '')), '');
  v_numeric boolean := false;
  v_digits text := '';
  v_n integer := 0;
  v_terms text[] := '{}';
  v_qkey text;
  v_ddd text;
  v_suffix text;
  v_empty boolean := false;
  v_rows jsonb;
  v_has_more boolean := false;
  v_next jsonb := null;
  v_count integer;
begin
  perform public.whatsapp_assert_reader(p_company_id);

  if v_query is not null and char_length(v_query) > 100 then
    raise exception 'A busca é muito longa.' using errcode = 'PT400';
  end if;
  if (p_after_sort is null) <> (p_after_key is null) then
    raise exception 'Cursor inválido.' using errcode = 'PT400';
  end if;

  if v_query is not null then
    if v_query ~ '^[0-9[:space:]()+.-]+$' and v_query ~ '[0-9]' then
      v_numeric := true;
      v_digits := regexp_replace(v_query, '[^0-9]', '', 'g');
      v_n := char_length(v_digits);
      if v_n < 2 or v_n > 13 then
        v_empty := true;                         -- 1 dígito é largo demais; mais de 13 não é telefone
      elsif v_n = 2 then
        v_ddd := v_digits;                       -- DDD
      elsif v_n <= 9 then
        -- últimos dígitos; 9 dígitos "9 + 8 locais" perdem o 9 (a chave canônica não o tem)
        v_suffix := case when v_n = 9 and v_digits ~ '^9[6-9]' then substr(v_digits, 2) else v_digits end;
      else
        v_qkey := public.whatsapp_contact_key(v_digits, true);   -- número completo, com/sem 55 e com/sem o nono dígito
      end if;
    else
      v_terms := (select coalesce(array_agg(t), '{}') from (
        select left(x, 40) as t from unnest(string_to_array(public.whatsapp_contact_fold(v_query), ' ')) x where x <> '' limit 6) q);
      if cardinality(v_terms) = 0 then
        v_empty := true;
      end if;
    end if;
  end if;

  if v_empty then
    return jsonb_build_object('contacts', '[]'::jsonb, 'has_more', false, 'next_cursor', null);
  end if;

  with convs as (
    select c.id, c.connection_id, c.contact_phone, c.contact_display_name, c.customer_id, c.last_message_at, c.last_inbound_at, c.created_at,
           public.whatsapp_contact_key(c.contact_phone, false) as k
      from public.whatsapp_conversations c
     where c.company_id = p_company_id and c.deleted_at is null
  ),
  -- UMA linha por chave, num único agrupamento (a conversa mais recente + contagem + nome do perfil mais recente não vazio).
  -- (Evita juntar dois CTEs por chave: o planejador os juntava em laço aninhado, 6000 x 6000.)
  conv_g as (
    select k,
           (array_agg(id order by last_message_at desc nulls last, created_at desc, id desc))[1] as id,
           (array_agg(connection_id order by last_message_at desc nulls last, created_at desc, id desc))[1] as connection_id,
           (array_agg(contact_phone order by last_message_at desc nulls last, created_at desc, id desc))[1] as contact_phone,
           (array_agg(last_message_at order by last_message_at desc nulls last, created_at desc, id desc))[1] as last_message_at,
           (array_agg(last_inbound_at order by last_message_at desc nulls last, created_at desc, id desc))[1] as last_inbound_at,
           count(*)::integer as conversation_count,
           (array_agg(contact_display_name order by last_message_at desc nulls last, created_at desc, id desc)
              filter (where nullif(btrim(contact_display_name), '') is not null))[1] as profile_name
      from convs group by k
  ),
  -- contatos MANUAIS ativos (arquivados não entram); a chave é a mesma das conversas (contact_key = whatsapp_contact_key(phone, false))
  man as (
    select m.id, m.phone_e164, m.name, m.customer_id, m.contact_key as k
      from public.whatsapp_contacts m where m.company_id = p_company_id and m.archived_at is null
  ),
  keyset as (select k from conv_g union select k from man),
  -- cliente vinculado a uma conversa NÃO excluída (o mais recente), só se ativo
  conv_linked as (
    select distinct on (v.k) v.k, v.customer_id
      from convs v join public.customers cu on cu.company_id = p_company_id and cu.id = v.customer_id and cu.is_active
     where v.customer_id is not null
     order by v.k, v.last_message_at desc nulls last, v.created_at desc, v.id desc
  ),
  cust as (
    select cu.id, cu.name, cu.whatsapp, cu.phone,
           public.whatsapp_contact_key(cu.whatsapp, true) as kw, public.whatsapp_contact_key(cu.phone, true) as kp
      from public.customers cu where cu.company_id = p_company_id and cu.is_active
  ),
  cust_keys as (
    select id, name, kw as k from cust where kw is not null
    union
    select id, name, kp from cust where kp is not null
  ),
  -- (chave da conversa, cliente) por coincidência de telefone OU por vínculo
  matched as materialized (
    select ck.k, ck.id, ck.name, false as by_link from cust_keys ck join keyset ks on ks.k = ck.k
    union
    select cl.k, cu.id, cu.name, true from conv_linked cl join cust cu on cu.id = cl.customer_id
    union
    select mn.k, cu.id, cu.name, true from man mn join cust cu on cu.id = mn.customer_id
  ),
  represented as (select distinct id from matched),
  -- por chave: o vinculado, senão o primeiro por (nome, id); e quantos clientes distintos coincidem (mesmo agrupamento)
  matched_one as (select k, id, min(name) as name, bool_or(by_link) as by_link from matched group by k, id),
  conv_cust as materialized (
    select distinct on (k) k, id as customer_id, name as customer_name, (count(*) over (partition by k))::integer as n
      from matched_one order by k, by_link desc, lower(name), id
  ),
  -- clientes ativos sem conversa: UMA chave por cliente (WhatsApp, senão telefone); quem já está representado não duplica
  cust_only_pick as (
    select cu.id, cu.name, coalesce(cu.kw, cu.kp) as k, case when cu.kw is not null then cu.whatsapp else cu.phone end as raw
      from cust cu where coalesce(cu.kw, cu.kp) is not null and cu.id not in (select id from represented)
  ),
  cust_only as (
    select distinct on (k) k, id as customer_id, name as customer_name, raw, (count(*) over (partition by k))::integer as n
      from cust_only_pick order by k, lower(name), id
  ),
  -- MATERIALIZED (base, matched, conv_cust): sem isso o planejador empurrava filtros para dentro das junções e escolhia laço aninhado (3x a 7x mais lento com contatos manuais)
  base as materialized (
    select ks.k as key,
           coalesce(cg.contact_phone, mn.phone_e164) as phone,
           cc.customer_id, cc.customer_name, coalesce(cc.n, 0) as customer_matches,
           cg.profile_name, cg.id as conversation_id, cg.connection_id, coalesce(cg.conversation_count, 0) as conversation_count, cg.last_message_at, cg.last_inbound_at,
           case when cg.k is not null then (case when cc.customer_id is not null then 'both' else 'conversation' end) else 'manual' end as source,
           mn.id as manual_id, mn.name as manual_name
      from keyset ks
      left join conv_g cg on cg.k = ks.k
      left join man mn on mn.k = ks.k
      left join conv_cust cc on cc.k = ks.k
    union all
    select co.k, regexp_replace(co.raw, '[^0-9]', '', 'g'), co.customer_id, co.customer_name, co.n, null, null, null, 0, null, null, 'customer', null::uuid, null::text
      from cust_only co
  ),
  named as (
    select b.*,
           case when b.manual_name is not null then b.manual_name
                when b.customer_name is not null then b.customer_name
                when nullif(btrim(b.profile_name), '') is not null then btrim(b.profile_name)
                else b.phone end as display_name,
           case when b.manual_name is not null then 'manual'
                when b.customer_name is not null then 'customer'
                when nullif(btrim(b.profile_name), '') is not null then 'profile'
                else 'phone' end as name_source
      from base b
  ),
  keyed as (
    select n.*,
           (case when n.name_source = 'phone' then '1|' else '0|' end) || public.whatsapp_contact_fold(n.display_name) as sort_name,
           public.whatsapp_contact_fold(coalesce(n.manual_name, '') || ' ' || coalesce(n.customer_name, '') || ' ' || coalesce(n.profile_name, '')) as search_text
      from named n
  ),
  filtered as (
    select * from keyed k
     where (p_after_sort is null or (k.sort_name, k.key) > (p_after_sort, p_after_key))
       and (v_query is null
            or (v_numeric and (
                  (v_ddd is not null and k.key ~ '^55[0-9]{2}' and substr(k.key, 3, 2) = v_ddd)
               or (v_suffix is not null and right(k.key, char_length(v_suffix)) = v_suffix)
               or (v_qkey is not null and k.key = v_qkey)))
            or (not v_numeric and not exists (select 1 from unnest(v_terms) t where strpos(k.search_text, t) = 0)))
     order by k.sort_name, k.key
     limit v_limit + 1
  )
  select count(*)::integer,
         coalesce(jsonb_agg(jsonb_build_object(
           'contact_key', f.key, 'display_name', f.display_name, 'name_source', f.name_source, 'phone', f.phone,
           'customer_id', f.customer_id, 'customer_matches', f.customer_matches, 'profile_name', f.profile_name,
           'conversation_id', f.conversation_id, 'connection_id', f.connection_id, 'conversation_count', f.conversation_count,
           'last_message_at', f.last_message_at, 'last_inbound_at', f.last_inbound_at, 'source', f.source, 'sort_name', f.sort_name,
           'is_manual', f.manual_id is not null, 'manual_contact_id', f.manual_id,
           'sources', to_jsonb(array_remove(array[case when f.manual_id is not null then 'manual' end, case when f.customer_id is not null then 'customer' end, case when f.conversation_id is not null then 'conversation' end], null)))
           order by f.sort_name, f.key), '[]'::jsonb)
    into v_count, v_rows
    from filtered f;

  if v_count > v_limit then
    v_has_more := true;
    v_rows := (select coalesce(jsonb_agg(e order by ord), '[]'::jsonb) from jsonb_array_elements(v_rows) with ordinality as t(e, ord) where ord <= v_limit);
  end if;
  if v_has_more and jsonb_array_length(v_rows) > 0 then
    v_next := jsonb_build_object('sort', (v_rows -> (jsonb_array_length(v_rows) - 1)) ->> 'sort_name',
                                 'key', (v_rows -> (jsonb_array_length(v_rows) - 1)) ->> 'contact_key');
  end if;

  return jsonb_build_object('contacts', v_rows, 'has_more', v_has_more, 'next_cursor', v_next);
end;
$$;
revoke execute on function public.whatsapp_contacts_query(uuid, text, integer, text, text) from public, anon, authenticated, service_role;

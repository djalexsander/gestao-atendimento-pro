-- Etapa 7.2 (LOCAL, NÃO aplicada): camada de LEITURA dos Contatos do WhatsApp. Migration ADITIVA: só funções novas.
-- Nenhuma tabela, coluna, índice, trigger, policy ou função existente é criada/alterada/removida. Não toca IA, Coexistence, webhooks,
-- conexões nem sincronização de contatos (isso é uma etapa futura e separada).
--
-- Fonte dos contatos (nada é copiado): whatsapp_conversations (NÃO excluídas) + customers (ATIVOS), por empresa.
-- Identidade = "chave de contato" (whatsapp_contact_key): o número só com dígitos, com o nono dígito brasileiro tratado.
--
-- POR QUE NÃO USAR whatsapp_phone_core (auditoria da normalização existente, docs/whatsapp-contatos-normalizacao.md):
--   whatsapp_phone_core remove o 9 de QUALQUER número de 11 dígitos cujo 3º dígito seja 9, sem olhar o que vem depois. Os celulares
--   "9 + 6..9xxxxxxx" ganharam o 9 em 2012; as faixas novas ("9 + 1..5xxxxxxx") nunca existiram com 8 dígitos. Assim, "11 9 5xxx-xxxx"
--   (celular novo) vira "115xxxxxxx", IGUAL ao fixo "11 5xxx-xxxx": duas pessoas diferentes agrupadas. A chave nova segue a regra de
--   whatsapp_br_phone_equivalent (a do envio): só descarta o 9 quando o dígito seguinte é 6..9 (equivalência real), e só em números
--   brasileiros (começam com 55). Números de outros países nunca são alterados.
--
-- Prioridade do nome: cliente cadastrado ATIVO > nome do perfil do WhatsApp > telefone.
-- Cliente vinculado à conversa vale mesmo sem coincidir o telefone; sem vínculo, vale o cliente ativo cujo telefone/WhatsApp tem a mesma chave.
-- Vários clientes ativos com o mesmo número: escolhe-se de forma determinística (nome, id) e 'customer_matches' avisa a ambiguidade.
-- Cliente inativo NUNCA empresta o nome (nem aparece como contato). Conversa excluída (soft delete) NUNCA aparece nem empresta o nome do perfil.

-- ---------------------------------------------------------------------------
-- 1) Helpers puros (sem acesso a tabelas, sem EXECUTE para clientes)
-- ---------------------------------------------------------------------------

-- Dobra para busca: minúsculas e sem acentos (tabela fixa; não depende da extensão unaccent). Nomes em Unicode decomposto (NFD) ficam fora.
create function public.whatsapp_contact_fold(p_text text)
returns text
language sql
immutable
set search_path = public
as $$
  select btrim(lower(translate(coalesce(p_text, ''),
    'ÁÀÂÃÄÅáàâãäåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñÝýÿ',
    'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNnYyy')))
$$;

-- Chave de contato. p_br_local = true quando o número pode vir SEM código do país (cadastro de cliente e texto digitado na busca):
-- 10 ou 11 dígitos são tratados como DDD + número do Brasil. Telefones de conversa vêm sempre com o código do país (E.164): p_br_local = false.
-- Brasil canônico = '55' + DDD + número local, e o celular antigo SEM o 9 é a forma canônica (o 9 só é removido se vier seguido de 6..9).
-- (Só comparações de tamanho/posição depois de UMA limpeza de dígitos: é chamada para cada conversa e cliente da empresa.)
create function public.whatsapp_contact_key(p_text text, p_br_local boolean default false)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when l = 0 then null
    -- 13 dígitos brasileiros: 55 DD 9 [6-9]xxxxxxx -> 55 DD [6-9]xxxxxxx
    when l = 13 and substr(d, 1, 2) = '55' and substr(d, 5, 1) = '9' and substr(d, 6, 1) between '6' and '9' then substr(d, 1, 4) || substr(d, 6)
    -- local com DDD, 11 dígitos: DD 9 [6-9]xxxxxxx
    when p_br_local and l = 11 and substr(d, 3, 1) = '9' and substr(d, 4, 1) between '6' and '9' then '55' || substr(d, 1, 2) || substr(d, 4)
    when p_br_local and l in (10, 11) then '55' || d
    else d
  end
  from (select d, char_length(d) as l from (select regexp_replace(coalesce(p_text, ''), '[^0-9]', '', 'g') as d) z) s
$$;

revoke execute on function public.whatsapp_contact_fold(text) from public, anon, authenticated, service_role;
revoke execute on function public.whatsapp_contact_key(text, boolean) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) Consulta única (interna): lista e busca usam o MESMO código
-- ---------------------------------------------------------------------------
create function public.whatsapp_contacts_query(
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
  matched as (
    select ck.k, ck.id, ck.name, false as by_link from cust_keys ck join conv_g cg on cg.k = ck.k
    union
    select cl.k, cu.id, cu.name, true from conv_linked cl join cust cu on cu.id = cl.customer_id
  ),
  represented as (select distinct id from matched),
  -- por chave: o vinculado, senão o primeiro por (nome, id); e quantos clientes distintos coincidem (mesmo agrupamento)
  matched_one as (select k, id, min(name) as name, bool_or(by_link) as by_link from matched group by k, id),
  conv_cust as (
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
  base as (
    select cg.k as key,
           cg.contact_phone as phone,
           cc.customer_id, cc.customer_name, coalesce(cc.n, 0) as customer_matches,
           cg.profile_name, cg.id as conversation_id, cg.connection_id, cg.conversation_count, cg.last_message_at, cg.last_inbound_at,
           case when cc.customer_id is not null then 'both' else 'conversation' end as source
      from conv_g cg
      left join conv_cust cc on cc.k = cg.k
    union all
    select co.k, regexp_replace(co.raw, '[^0-9]', '', 'g'), co.customer_id, co.customer_name, co.n, null, null, null, 0, null, null, 'customer'
      from cust_only co
  ),
  named as (
    select b.*,
           case when b.customer_name is not null then b.customer_name
                when nullif(btrim(b.profile_name), '') is not null then btrim(b.profile_name)
                else b.phone end as display_name,
           case when b.customer_name is not null then 'customer'
                when nullif(btrim(b.profile_name), '') is not null then 'profile'
                else 'phone' end as name_source
      from base b
  ),
  keyed as (
    select n.*,
           (case when n.name_source = 'phone' then '1|' else '0|' end) || public.whatsapp_contact_fold(n.display_name) as sort_name,
           public.whatsapp_contact_fold(coalesce(n.customer_name, '') || ' ' || coalesce(n.profile_name, '')) as search_text
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
           'last_message_at', f.last_message_at, 'last_inbound_at', f.last_inbound_at, 'source', f.source, 'sort_name', f.sort_name)
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

-- ---------------------------------------------------------------------------
-- 3) RPCs públicas (só authenticated; o papel e o módulo são conferidos dentro, por empresa)
-- ---------------------------------------------------------------------------
create function public.list_whatsapp_contacts(
  p_company_id uuid,
  p_limit integer default 30,
  p_after_sort text default null,
  p_after_key text default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.whatsapp_contacts_query(p_company_id, null, p_limit, p_after_sort, p_after_key)
$$;

create function public.search_whatsapp_contacts(
  p_company_id uuid,
  p_query text,
  p_limit integer default 30,
  p_after_sort text default null,
  p_after_key text default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.whatsapp_contacts_query(p_company_id, p_query, p_limit, p_after_sort, p_after_key)
$$;

revoke execute on function public.list_whatsapp_contacts(uuid, integer, text, text) from public, anon, service_role;
revoke execute on function public.search_whatsapp_contacts(uuid, text, integer, text, text) from public, anon, service_role;
grant execute on function public.list_whatsapp_contacts(uuid, integer, text, text) to authenticated;
grant execute on function public.search_whatsapp_contacts(uuid, text, integer, text, text) to authenticated;

comment on function public.search_whatsapp_contacts(uuid, text, integer, text, text) is
  'Contatos do WhatsApp (conversas não excluídas + clientes ativos) unificados por chave de telefone. Busca por nome (sem acento/caixa), número completo, DDD (2 dígitos) e finais (3 a 9 dígitos). Cursor estável (sort, key).';

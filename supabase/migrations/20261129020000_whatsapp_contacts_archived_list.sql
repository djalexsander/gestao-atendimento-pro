-- Etapa 7.10F.1 (LOCAL, NÃO aplicada): listagem paginada dos contatos MANUAIS ARQUIVADOS. Migration ADITIVA: só UMA função nova.
-- Não altera tabelas, políticas, triggers nem funções existentes (a busca de contatos ativos da 7.10D continua igual), não toca em conversas,
-- mensagens, IA, Coexistence, webhooks, conexões nem sincronização Meta, e não escreve nada (função STABLE, só leitura).
--
-- Quem lê: owner, admin, attendant e cashier (whatsapp_assert_reader: sessão, empresa do usuário, papel e módulo WhatsApp). Restaurar continua
-- exclusivo de owner/admin na RPC restore_whatsapp_contact (7.10C); esta função só localiza.
-- Busca (mesmas regras da busca de contatos): texto = termos do nome (sem acento/caixa); só dígitos = DDD (2), final (3 a 9) ou número completo
-- (10 a 13, com/sem 55 e com/sem o nono dígito, pela whatsapp_contact_key). Ordem estável: nome dobrado, id. As observações NÃO saem na lista.
create function public.list_archived_whatsapp_contacts(
  p_company_id uuid,
  p_query text default null,
  p_limit integer default 30,
  p_after_sort text default null,
  p_after_key text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
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
  v_rows jsonb;
  v_count integer;
  v_has_more boolean := false;
  v_next jsonb := null;
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
        return jsonb_build_object('contacts', '[]'::jsonb, 'has_more', false, 'next_cursor', null);
      elsif v_n = 2 then
        v_ddd := v_digits;
      elsif v_n <= 9 then
        v_suffix := case when v_n = 9 and v_digits ~ '^9[6-9]' then substr(v_digits, 2) else v_digits end;
      else
        v_qkey := public.whatsapp_contact_key(v_digits, true);
      end if;
    else
      v_terms := (select coalesce(array_agg(t), '{}') from (
        select left(x, 40) as t from unnest(string_to_array(public.whatsapp_contact_fold(v_query), ' ')) x where x <> '' limit 6) q);
      if cardinality(v_terms) = 0 then
        return jsonb_build_object('contacts', '[]'::jsonb, 'has_more', false, 'next_cursor', null);
      end if;
    end if;
  end if;

  with base as (
    select m.id, m.name, m.phone_e164, m.contact_key, m.customer_id, m.archived_at,
           public.whatsapp_contact_fold(m.name) as sort_name
      from public.whatsapp_contacts m
     where m.company_id = p_company_id and m.archived_at is not null
  ),
  filtered as (
    select b.* from base b
     where (p_after_sort is null or (b.sort_name, b.id::text) > (p_after_sort, p_after_key))
       and (v_query is null
            or (v_numeric and (
                  (v_ddd is not null and b.contact_key ~ '^55[0-9]{2}' and substr(b.contact_key, 3, 2) = v_ddd)
               or (v_suffix is not null and right(b.contact_key, char_length(v_suffix)) = v_suffix)
               or (v_qkey is not null and b.contact_key = v_qkey)))
            or (not v_numeric and not exists (select 1 from unnest(v_terms) t where strpos(b.sort_name, t) = 0)))
     order by b.sort_name, b.id::text
     limit v_limit + 1
  )
  select count(*)::integer,
         coalesce(jsonb_agg(jsonb_build_object(
           'manual_contact_id', f.id, 'name', f.name, 'phone', f.phone_e164, 'contact_key', f.contact_key,
           'customer_id', f.customer_id,
           'customer_name', (select u.name from public.customers u where u.company_id = p_company_id and u.id = f.customer_id),
           'archived_at', f.archived_at, 'sort_name', f.sort_name)
           order by f.sort_name, f.id::text), '[]'::jsonb)
    into v_count, v_rows
    from filtered f;

  if v_count > v_limit then
    v_has_more := true;
    v_rows := (select coalesce(jsonb_agg(e order by ord), '[]'::jsonb) from jsonb_array_elements(v_rows) with ordinality as t(e, ord) where ord <= v_limit);
  end if;
  if v_has_more and jsonb_array_length(v_rows) > 0 then
    v_next := jsonb_build_object('sort', (v_rows -> (jsonb_array_length(v_rows) - 1)) ->> 'sort_name',
                                 'key', (v_rows -> (jsonb_array_length(v_rows) - 1)) ->> 'manual_contact_id');
  end if;
  return jsonb_build_object('contacts', v_rows, 'has_more', v_has_more, 'next_cursor', v_next);
end;
$$;

revoke execute on function public.list_archived_whatsapp_contacts(uuid, text, integer, text, text) from public, anon, service_role;
grant execute on function public.list_archived_whatsapp_contacts(uuid, text, integer, text, text) to authenticated;

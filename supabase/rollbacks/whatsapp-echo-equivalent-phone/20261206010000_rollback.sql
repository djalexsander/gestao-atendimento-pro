-- Rollback da migration 20261206010000 (eco com lock e equivalência do nono dígito, Etapa 7.11H). Desfaz SOMENTE as duas substituições em
-- whatsapp_ingest_echo (substituição exata inversa; cada trecho tem de ocorrer exatamente 1 vez, senão aborta). NÃO remove whatsapp_resolve_conversation_phone
-- (é da 7.11D e o recebimento depende dela). Conversas, mensagens e dados não são tocados; conversas que deixaram de ser duplicadas continuam únicas.
-- Para poder reaplicar a migration depois:
--   node node_modules/supabase/dist/supabase.js migration repair --status reverted 20261206010000 --linked
begin;
create or replace function pg_temp.unpatch_wa_echo_fn()
returns void
language plpgsql
as $$
declare
  v_oid oid;
  v_def text;
  v_a_from constant text := $f$  -- 7.11H: mesmo lock de contato e mesma equivalência do recebimento (7.11D): usa o telefone da conversa ATIVA equivalente, se houver
  v_phone := public.whatsapp_resolve_conversation_phone(v_conn.id, v_phone);

  -- conversa do contato (ativa, tolerando a variação do nono dígito brasileiro)
  select * into v_conv from public.whatsapp_conversations c$f$;
  v_a_to constant text := $f$  -- conversa do contato (ativa, tolerando a variação do nono dígito brasileiro)
  select * into v_conv from public.whatsapp_conversations c$f$;
  v_b_from constant text := $f$   order by (c.contact_phone = v_phone) desc, c.last_message_at desc nulls last, c.created_at desc, c.id
   limit 1
   for update;$f$;
  v_b_to constant text := $f$   order by c.last_message_at desc nulls last
   limit 1
   for update;$f$;
begin
  select p.oid into v_oid from pg_proc p where p.proname = 'whatsapp_ingest_echo' and p.pronamespace = 'public'::regnamespace;
  if v_oid is null then
    raise exception 'unpatch_fn: função whatsapp_ingest_echo não encontrada';
  end if;
  v_def := replace(pg_get_functiondef(v_oid), chr(13), '');
  if (length(v_def) - length(replace(v_def, v_a_from, ''))) / length(v_a_from) <> 1 then
    raise exception 'unpatch_fn: bloco A da 7.11H não ocorre exatamente 1 vez em whatsapp_ingest_echo';
  end if;
  if (length(v_def) - length(replace(v_def, v_b_from, ''))) / length(v_b_from) <> 1 then
    raise exception 'unpatch_fn: bloco B da 7.11H não ocorre exatamente 1 vez em whatsapp_ingest_echo';
  end if;
  execute replace(replace(v_def, v_a_from, v_a_to), v_b_from, v_b_to);
end;
$$;
select pg_temp.unpatch_wa_echo_fn();
commit;

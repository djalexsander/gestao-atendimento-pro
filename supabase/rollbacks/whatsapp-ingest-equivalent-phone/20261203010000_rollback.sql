-- Rollback da migration 20261203010000 (equivalência do nono dígito no recebimento, Etapa 7.11D parte 1). Remove SOMENTE o bloco que ela inseriu em
-- whatsapp_ingest_message (substituição exata inversa; todo o resto do corpo atual é preservado, inclusive o vínculo automático de cliente) e o auxiliar novo,
-- sem CASCADE. Conversas, mensagens e dados não são tocados; conversas que o recebimento deixou de duplicar continuam únicas.
-- Para poder reaplicar a migration depois:
--   node node_modules/supabase/dist/supabase.js migration repair --status reverted 20261203010000 --linked
begin;
create or replace function pg_temp.unpatch_wa_ingest_fn(p_from text, p_to text)
returns void
language plpgsql
as $$
declare
  v_oid oid;
  v_def text;
begin
  select p.oid into v_oid from pg_proc p where p.proname = 'whatsapp_ingest_message' and p.pronamespace = 'public'::regnamespace;
  if v_oid is null then
    raise exception 'unpatch_fn: função whatsapp_ingest_message não encontrada';
  end if;
  v_def := replace(pg_get_functiondef(v_oid), chr(13), '');
  if (length(v_def) - length(replace(v_def, p_from, ''))) / greatest(length(p_from), 1) <> 1 then
    raise exception 'unpatch_fn: bloco da 7.11D não ocorre exatamente 1 vez em whatsapp_ingest_message';
  end if;
  execute replace(v_def, p_from, p_to);
end;
$$;

select pg_temp.unpatch_wa_ingest_fn(
  $f$  -- 7.11D: se já existe conversa ATIVA equivalente (nono dígito brasileiro), usa o telefone DELA; assim o upsert abaixo cai na conversa existente
  -- em vez de criar uma duplicada. Sem equivalente, v_phone fica como veio da Meta (comportamento anterior). Lock por contato evita corrida.
  v_phone := public.whatsapp_resolve_conversation_phone(v_conn.id, v_phone);

$f$, '');

drop function if exists public.whatsapp_resolve_conversation_phone(uuid, text);
commit;

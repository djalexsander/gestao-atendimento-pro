-- Etapa 7.11D, parte 1 (LOCAL, NÃO aplicada): equivalência do NONO DÍGITO brasileiro no recebimento de mensagens.
-- Problema: a Meta entrega o wa_id de celulares antigos SEM o nono dígito (554498807633) e a conversa é única por telefone EXATO; uma conversa criada ou
-- encontrada com o outro formato (5544998807633) geraria uma SEGUNDA conversa para a mesma pessoa. O envio de template (7.11F) criará conversas, então
-- isto precisa estar resolvido antes.
-- Mudança ISOLADA em whatsapp_ingest_message: UMA linha nova antes do upsert da conversa, que troca v_phone pelo telefone da conversa ativa EQUIVALENTE, se houver.
-- Feita por SUBSTITUIÇÃO EXATA do trecho (a mesma técnica da 20261112010000): o corpo ATUAL da função é lido do banco, o trecho esperado tem de ocorrer
-- exatamente UMA vez (senão a migration falha, sem alterar nada) e todo o resto é preservado, inclusive o vínculo automático de cliente (auto_link) e qualquer
-- ajuste posterior. CREATE OR REPLACE preserva a ACL, SECURITY DEFINER e search_path. O teste confere: remover a linha nova devolve o texto anterior.
--   * equivalência = whatsapp_br_phone_equivalent (a mesma do eco da Coexistence e do modo teste): só Brasil (55), DDD válido, mesmo DDD e mesmos 8 dígitos,
--     o celular antigo (6–9) com e sem o 9. Outros países e fixos nunca são alterados;
--   * mesma CONEXÃO (e portanto mesma empresa), conversas NÃO excluídas; excluída continua não "ressuscitando";
--   * se JÁ existirem duas conversas ativas duplicadas (histórico), prefere a de telefone EXATO; senão a de atividade mais recente. Nada é mesclado nem apagado;
--   * lock consultivo por (conexão, chave do contato) na transação: duas mensagens simultâneas (cada uma num formato) são serializadas e a segunda encontra a
--     conversa criada pela primeira;
--   * sem equivalente: nenhuma mudança de comportamento. Mensagens, IA (gatilhos), Coexistence e webhook não são tocados.

create function public.whatsapp_resolve_conversation_phone(p_connection_id uuid, p_phone text)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_existing text;
begin
  if p_connection_id is null or p_phone is null then
    return p_phone;
  end if;
  -- lock por contato: serializa mensagens simultâneas do mesmo contato (mesma chave para as duas formas do nono dígito)
  perform pg_advisory_xact_lock(hashtextextended('wa_conv:' || p_connection_id::text || ':' || coalesce(public.whatsapp_contact_key(p_phone, false), p_phone), 0));
  select c.contact_phone into v_existing
    from public.whatsapp_conversations c
   where c.connection_id = p_connection_id and c.deleted_at is null and public.whatsapp_br_phone_equivalent(c.contact_phone, p_phone)
   order by (c.contact_phone = p_phone) desc, c.last_message_at desc nulls last, c.created_at desc, c.id
   limit 1;
  return coalesce(v_existing, p_phone);
end;
$$;
revoke execute on function public.whatsapp_resolve_conversation_phone(uuid, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Ajuste na função existente (substituição exata; falha fechada se o trecho não for único)
-- ---------------------------------------------------------------------------
create or replace function pg_temp.patch_wa_ingest_fn(p_from text, p_to text)
returns void
language plpgsql
as $$
declare
  v_oid oid;
  v_def text;
begin
  select p.oid into v_oid from pg_proc p where p.proname = 'whatsapp_ingest_message' and p.pronamespace = 'public'::regnamespace;
  if v_oid is null then
    raise exception 'patch_fn: função whatsapp_ingest_message não encontrada';
  end if;
  v_def := replace(pg_get_functiondef(v_oid), chr(13), '');
  if (length(v_def) - length(replace(v_def, p_from, ''))) / greatest(length(p_from), 1) <> 1 then
    raise exception 'patch_fn: trecho esperado não ocorre exatamente 1 vez em whatsapp_ingest_message';
  end if;
  execute replace(v_def, p_from, p_to);
end;
$$;

select pg_temp.patch_wa_ingest_fn(
  $f$  insert into public.whatsapp_conversations (company_id, connection_id, contact_phone, contact_display_name, status)
  values (v_conn.company_id, v_conn.id, v_phone, v_name, 'open')$f$,
  $f$  -- 7.11D: se já existe conversa ATIVA equivalente (nono dígito brasileiro), usa o telefone DELA; assim o upsert abaixo cai na conversa existente
  -- em vez de criar uma duplicada. Sem equivalente, v_phone fica como veio da Meta (comportamento anterior). Lock por contato evita corrida.
  v_phone := public.whatsapp_resolve_conversation_phone(v_conn.id, v_phone);

  insert into public.whatsapp_conversations (company_id, connection_id, contact_phone, contact_display_name, status)
  values (v_conn.company_id, v_conn.id, v_phone, v_name, 'open')$f$);

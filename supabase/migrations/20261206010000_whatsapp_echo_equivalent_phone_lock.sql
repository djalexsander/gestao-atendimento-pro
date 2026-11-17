-- Etapa 7.11H (LOCAL, NÃO aplicada): o ECO da Coexistence passa a usar o MESMO lock de contato e a MESMA equivalência do nono dígito do recebimento (7.11D).
-- Problema: whatsapp_ingest_echo localizava a conversa por equivalência SEM lock e, ao criar, só colidia no telefone EXATO. Um eco concorrente com um
-- recebimento/início (forma do telefone com/sem o 9) podia criar uma SEGUNDA conversa ativa do mesmo contato.
-- Mudança ISOLADA em whatsapp_ingest_echo, por SUBSTITUIÇÃO EXATA do corpo ATUAL lido do banco (a técnica da 20261203010000): cada trecho esperado tem de ocorrer
-- exatamente UMA vez; senão a migration ABORTA sem alterar nada. Duas trocas apenas:
--   1) antes da busca da conversa: v_phone := whatsapp_resolve_conversation_phone(v_conn.id, v_phone)  (advisory lock 'wa_conv:<conexão>:<chave>' + telefone da
--      conversa ativa equivalente; já existe desde a 7.11D);
--   2) ordem de escolha: telefone EXATO primeiro, depois atividade mais recente, depois created_at e id (a mesma do resolvedor).
-- Todo o resto (vínculos de cliente, mensagens, auditoria, pausa da IA, api_match, Coexistence) é preservado. CREATE OR REPLACE mantém ACL, SECURITY DEFINER e
-- search_path. Nada é mesclado nem apagado: conversas duplicadas históricas continuam existindo (o eco apenas escolhe uma de forma determinística).

create or replace function pg_temp.patch_wa_echo_fn()
returns void
language plpgsql
as $$
declare
  v_oid oid;
  v_def text;
  v_a_from constant text := $f$  -- conversa do contato (ativa, tolerando a variação do nono dígito brasileiro)
  select * into v_conv from public.whatsapp_conversations c$f$;
  v_a_to constant text := $f$  -- 7.11H: mesmo lock de contato e mesma equivalência do recebimento (7.11D): usa o telefone da conversa ATIVA equivalente, se houver
  v_phone := public.whatsapp_resolve_conversation_phone(v_conn.id, v_phone);

  -- conversa do contato (ativa, tolerando a variação do nono dígito brasileiro)
  select * into v_conv from public.whatsapp_conversations c$f$;
  v_b_from constant text := $f$   order by c.last_message_at desc nulls last
   limit 1
   for update;$f$;
  v_b_to constant text := $f$   order by (c.contact_phone = v_phone) desc, c.last_message_at desc nulls last, c.created_at desc, c.id
   limit 1
   for update;$f$;
begin
  select p.oid into v_oid from pg_proc p where p.proname = 'whatsapp_ingest_echo' and p.pronamespace = 'public'::regnamespace;
  if v_oid is null then
    raise exception 'patch_fn: função whatsapp_ingest_echo não encontrada';
  end if;
  v_def := replace(pg_get_functiondef(v_oid), chr(13), '');
  if position('whatsapp_resolve_conversation_phone' in v_def) > 0 then
    raise exception 'patch_fn: whatsapp_ingest_echo já usa o resolvedor';
  end if;
  if (length(v_def) - length(replace(v_def, v_a_from, ''))) / length(v_a_from) <> 1 then
    raise exception 'patch_fn: trecho A não ocorre exatamente 1 vez em whatsapp_ingest_echo';
  end if;
  if (length(v_def) - length(replace(v_def, v_b_from, ''))) / length(v_b_from) <> 1 then
    raise exception 'patch_fn: trecho B não ocorre exatamente 1 vez em whatsapp_ingest_echo';
  end if;
  execute replace(replace(v_def, v_a_from, v_a_to), v_b_from, v_b_to);
end;
$$;

select pg_temp.patch_wa_echo_fn();

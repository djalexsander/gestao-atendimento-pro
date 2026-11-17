-- Etapa 7.10I (LOCAL, NÃO aplicada): EXCLUSÃO DEFINITIVA de contato manual do WhatsApp. Migration ADITIVA: só UMA função nova.
-- Não altera tabelas, políticas, triggers nem funções existentes. Segue docs/whatsapp-contatos-exclusao-definitiva.md.
--
-- delete_whatsapp_contact(p_contact_id, p_confirmation):
--   * somente o DONO (owner) da empresa; sessão (PT401), empresa do usuário (PT404, igual para inexistente/de outra empresa), módulo WhatsApp (PT403)
--     e escrita bloqueada (PT402, empresa em modo somente leitura);
--   * o contato precisa estar ARQUIVADO (PT409 "arquive antes"); dois passos deliberados;
--   * confirmação conferida NO BANCO: o texto precisa ser exatamente EXCLUIR (PT400 caso contrário; nada é apagado);
--   * apaga SOMENTE a linha de whatsapp_contacts (e grava o evento 'deleted' na mesma transação). Não toca em clientes, conversas, mensagens, IA,
--     Coexistence nem conexões; a FK de cliente aponta DO contato para o cliente, então o cliente permanece intacto;
--   * o evento 'deleted' guarda só metadados (quais campos existiam, se havia cliente) e NUNCA nome, telefone nem observações; a trilha de
--     eventos não tem FK para o contato, por isso sobrevive à exclusão;
--   * repetir a chamada: o contato já não existe e a resposta é PT404 (nenhum efeito colateral); SELECT ... FOR UPDATE serializa duas exclusões.
create function public.delete_whatsapp_contact(p_contact_id uuid, p_confirmation text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_c public.whatsapp_contacts;
  v_role public.company_role;
  v_fields text[] := array['nome', 'telefone'];
begin
  v_c := public.whatsapp_contacts_load(p_contact_id, true);          -- PT401 sem sessão; PT404 inexistente ou de outra empresa
  v_role := public.whatsapp_assert_reader(v_c.company_id);           -- empresa do usuário, papel leitor e módulo WhatsApp (PT403)
  if v_role <> 'owner' then
    raise exception 'Somente o dono da empresa pode excluir contatos definitivamente.' using errcode = 'PT403';
  end if;
  if public.company_write_blocked(v_c.company_id) then
    raise exception 'Empresa em modo somente leitura (%). Regularize a contratação/pagamento para voltar a registrar alterações.',
      public.company_access_state(v_c.company_id) using errcode = 'PT402';
  end if;
  if v_c.archived_at is null then
    raise exception 'Arquive o contato antes de excluí-lo definitivamente.' using errcode = 'PT409';
  end if;
  if p_confirmation is distinct from 'EXCLUIR' then
    raise exception 'Confirmação inválida. Digite EXCLUIR para excluir definitivamente.' using errcode = 'PT400';
  end if;

  if v_c.notes is not null then v_fields := array_append(v_fields, 'observacoes'); end if;
  delete from public.whatsapp_contacts where id = v_c.id;
  insert into public.whatsapp_contact_events (company_id, contact_id, event_type, actor_user_id, old_value)
  values (v_c.company_id, v_c.id, 'deleted', auth.uid(),
          jsonb_build_object('campos', to_jsonb(v_fields), 'tinha_cliente', v_c.customer_id is not null, 'estava_arquivado', true));

  return jsonb_build_object('ok', true, 'deleted', true, 'contact_id', v_c.id);
end;
$$;

revoke execute on function public.delete_whatsapp_contact(uuid, text) from public, anon, service_role;
grant execute on function public.delete_whatsapp_contact(uuid, text) to authenticated;

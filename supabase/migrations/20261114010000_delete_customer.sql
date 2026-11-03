-- EXCLUSÃO SEGURA DE CLIENTE: delete_customer(p_customer_id).
-- Só funções novas: nenhuma tabela/coluna/dado existente é alterado ao aplicar. Sem ON DELETE CASCADE: as chaves
-- estrangeiras seguem NO ACTION e funcionam como SEGUNDA barreira se um dia surgir uma tabela nova que referencie o cliente.
--
-- Regras (todas no servidor):
--   * só owner/admin da empresa do cliente (customers_assert_manager); outra empresa/estranho não enxerga o cliente;
--   * empresa em modo somente leitura (mesma barreira e mesma mensagem do trigger guard_company_writable): recusa;
--   * bloqueia se houver QUALQUER referência histórica: pedidos de Delivery (do cliente ou de um endereço dele), atendimentos/comandas,
--     recebíveis, conversas do WhatsApp, rascunhos de pedido do WhatsApp (do cliente ou oferta de endereço dele);
--   * sem histórico: apaga os endereços do cliente e o próprio cliente na MESMA transação;
--   * trava o cliente (FOR UPDATE) e depois seus endereços, a mesma ordem das RPCs de endereço; duas exclusões simultâneas:
--     a segunda espera, não encontra mais o cliente e recebe "Cliente não encontrado". Quem cria um vínculo novo (pedido,
--     conversa...) trava o cliente em FOR KEY SHARE pela FK, então também se serializa com a exclusão.
create function public.delete_customer(p_customer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_name text;
  v_addr_ids uuid[];
  v_n bigint;
  v_reasons text[] := '{}';
  v_deleted bigint;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if p_customer_id is null then
    raise exception 'Informe o cliente.' using errcode = 'PT400';
  end if;

  -- 1) empresa do cliente (sem travar) -> permissão no servidor; quem não é da empresa recebe 404 (não revela o cliente)
  select c.company_id into v_company from public.customers c where c.id = p_customer_id;
  if v_company is null then
    raise exception 'Cliente não encontrado.' using errcode = 'PT404';
  end if;
  perform public.customers_assert_manager(v_company);

  -- 2) empresa em somente leitura: mesma mensagem do trigger de barreira (e evita apagar endereços antes de o cliente ser recusado)
  if public.company_write_blocked(v_company) then
    raise exception 'Empresa em modo somente leitura (%). Regularize a contratação/pagamento para voltar a registrar alterações.',
      public.company_access_state(v_company) using errcode = 'PT402';
  end if;

  -- 3) trava: cliente primeiro, endereços depois (mesma ordem de set_customer_address_*). Reconfere a existência já sob a trava.
  select c.name into v_name from public.customers c where c.id = p_customer_id and c.company_id = v_company for update;
  if not found then
    raise exception 'Cliente não encontrado.' using errcode = 'PT404';
  end if;
  select coalesce(array_agg(a.id), '{}') into v_addr_ids
    from (select id from public.customer_addresses where company_id = v_company and customer_id = p_customer_id order by id for update) a;

  -- 4) referências históricas (todas filtradas pela empresa)
  select count(*) into v_n from public.delivery_orders d
   where d.company_id = v_company and (d.customer_id = p_customer_id or d.source_address_id = any (v_addr_ids));
  if v_n > 0 then v_reasons := v_reasons || (v_n || case when v_n = 1 then ' pedido de Delivery' else ' pedidos de Delivery' end); end if;

  select count(*) into v_n from public.service_sessions s where s.company_id = v_company and s.customer_id = p_customer_id;
  if v_n > 0 then v_reasons := v_reasons || (v_n || case when v_n = 1 then ' atendimento/comanda' else ' atendimentos/comandas' end); end if;

  select count(*) into v_n from public.accounts_receivable r where r.company_id = v_company and r.customer_id = p_customer_id;
  if v_n > 0 then v_reasons := v_reasons || (v_n || case when v_n = 1 then ' recebível' else ' recebíveis' end); end if;

  select count(*) into v_n from public.whatsapp_conversations w where w.company_id = v_company and w.customer_id = p_customer_id;
  if v_n > 0 then v_reasons := v_reasons || (v_n || case when v_n = 1 then ' conversa do WhatsApp' else ' conversas do WhatsApp' end); end if;

  select count(*) into v_n from public.whatsapp_order_drafts d
   where d.company_id = v_company and (d.customer_id = p_customer_id or d.address_offer_address_id = any (v_addr_ids));
  if v_n > 0 then v_reasons := v_reasons || (v_n || case when v_n = 1 then ' rascunho de pedido do WhatsApp' else ' rascunhos de pedido do WhatsApp' end); end if;

  if array_length(v_reasons, 1) > 0 then
    raise exception 'Este cliente não pode ser excluído porque possui histórico: %. Use "Inativar" para ocultá-lo e manter o histórico.',
      array_to_string(v_reasons, ', ') using errcode = 'PT409';
  end if;

  -- 5) sem histórico: endereços e cliente juntos (sem CASCADE; qualquer FK nova ainda barra)
  begin
    delete from public.customer_addresses where company_id = v_company and customer_id = p_customer_id;
    get diagnostics v_deleted = row_count;
    delete from public.customers where id = p_customer_id and company_id = v_company;
  exception when foreign_key_violation then
    raise exception 'Este cliente não pode ser excluído porque possui registros vinculados. Use "Inativar" para ocultá-lo e manter o histórico.'
      using errcode = 'PT409';
  end;

  return jsonb_build_object('id', p_customer_id, 'name', v_name, 'addresses_deleted', v_deleted);
end;
$$;

revoke execute on function public.delete_customer(uuid) from public, anon;
grant execute on function public.delete_customer(uuid) to authenticated;

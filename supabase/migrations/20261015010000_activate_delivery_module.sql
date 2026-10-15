-- ATIVAÇÃO COMERCIAL do módulo Delivery.
--
-- A linha modules.code = 'delivery' já existe (20261014020000, inativa e sem preço). Esta migration só ATUALIZA essa linha:
-- preço R$ 29,90/mês e is_active = true, com a descrição comercial. Não recria o módulo e não toca nos demais.
--
-- Efeito (pela arquitetura comercial existente, sem nenhuma regra nova):
--   * empresas unmanaged (ex.: ALEXPROAPPS) e em trial passam a ter o Delivery (todos os módulos ativos);
--   * assinaturas existentes NÃO o recebem: precisam contratá-lo (adição proporcional por Pix, como os demais módulos);
--   * contratos já firmados não mudam (preço contratado fica no vínculo da assinatura).
-- Overrides (company_module_overrides) não são alterados aqui.

do $$
declare
  v_rows integer;
begin
  update public.modules
     set monthly_price_cents = 2990,
         is_active = true,
         description = 'Delivery completo para pedidos de entrega e retirada, com clientes, endereços, taxas, produção, entregadores e integração com o caixa.'
   where code = 'delivery';

  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'ativação do módulo delivery: esperado 1 linha atualizada, obtido %', v_rows;
  end if;
end;
$$;

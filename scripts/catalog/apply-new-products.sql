-- Aplicação IDEMPOTENTE e SEGURA de produtos de catálogo (ex.: carga de teste da Djalexeventos).
--
-- REGRAS (incidente de 2026-10-19: um UPDATE em lote regravou stock_control/stock_quantity/minimum_stock_quantity de 35
-- produtos, inclusive o que o usuário já tinha colocado em controle por quantidade, deixando snapshot e ledger divergentes):
--   1. PRODUTO NOVO nasce com os DEFAULTS do banco (stock_control none, saldo 0, mínimo 0, available_for_sale true).
--      As colunas de estoque NÃO aparecem no INSERT.
--   2. PRODUTO EXISTENTE (mesma empresa + code) NUNCA é atualizado por esta carga: ON CONFLICT DO NOTHING.
--      Reexecutar não altera nada (nem estoque, nem preço, nem disponibilidade, nem ativo/inativo).
--   3. Estoque quantitativo só pela RPC oficial set_product_stock_control + add_stock_movement, nunca por UPDATE direto.
--   4. Só a empresa informada em $1 é tocada.
--   5. PROIBIDO em scripts/ qualquer UPDATE em products que mencione as colunas de estoque
--      (o teste stock-catalog-idempotent.mjs varre scripts/ e falha se achar).
--
-- Parâmetros: $1 = company_id (uuid); $2 = payload jsonb:
--   [{ "category_id": "...", "name": "...", "code": "...", "description": null, "barcode": null, "sale_price": 12.5 }]
-- Devolve os produtos efetivamente CRIADOS nesta execução (os já existentes ficam de fora).
insert into public.products (company_id, category_id, name, description, code, barcode, sale_price)
select $1::uuid, i.category_id, i.name, i.description, i.code, i.barcode, i.sale_price
  from jsonb_to_recordset($2::jsonb)
       as i(category_id uuid, name text, description text, code text, barcode text, sale_price numeric)
on conflict (company_id, code) do nothing
returning id, code;

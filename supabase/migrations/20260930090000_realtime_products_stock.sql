-- Realtime de PRODUTOS: adiciona SOMENTE public.products à publication supabase_realtime.
--
-- Motivo: a baixa/devolução de estoque (submit_service_order, cancel_service_order_item, add_stock_movement)
-- e a disponibilidade manual mudam stock_quantity, minimum_stock_quantity, stock_control, available_for_sale
-- e is_active em products. As telas abertas (Cadastros > Estoque e o catálogo do pedido) recarregam a
-- lista quando chega o evento; o estado atual vem de products, então o ledger
-- (product_stock_movements) NÃO é publicado. O Realtime respeita a RLS de products. Idempotente.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'products'
  ) then
    alter publication supabase_realtime add table public.products;
  end if;
end
$$;

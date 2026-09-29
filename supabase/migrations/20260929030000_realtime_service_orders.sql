-- Realtime dos pedidos: publica SOMENTE public.service_orders (a RPC grava pedido e itens na
-- mesma transação, então o evento do pedido basta para a tela recarregar tudo). O Realtime
-- respeita a RLS service_orders_select. Idempotente: não falha se já estiver publicada.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'service_orders'
  ) then
    alter publication supabase_realtime add table public.service_orders;
  end if;
end
$$;

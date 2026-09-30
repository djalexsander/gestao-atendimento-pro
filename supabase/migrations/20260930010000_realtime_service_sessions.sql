-- Realtime da lista de Comandas/Mesas: publica SOMENTE public.service_sessions (abrir e fechar
-- atendimento gravam nela). O Realtime respeita a RLS service_sessions_select. Idempotente.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'service_sessions'
  ) then
    alter publication supabase_realtime add table public.service_sessions;
  end if;
end
$$;

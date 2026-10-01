-- Realtime da IMPRESSÃO: adiciona à publication supabase_realtime SOMENTE
--   public.print_jobs, public.print_devices, public.print_agents, public.print_enqueue_failures.
-- Não publica print_job_items, print_device_routes, print_agent_pairing_codes nem print_agent_pair_attempts.
-- Não remove nem altera nenhuma tabela já publicada. Idempotente (pode rodar de novo sem efeito).
--
-- Motivo: Configurações → Impressão (fila, cards de impressoras, agentes e avisos de falha) passa a se
-- atualizar sozinha quando o Agente faz claim/imprime/falha, vincula uma impressora ou envia heartbeat.
-- A tela NÃO usa o payload como estado: ao receber o evento ela recarrega do servidor (reload coalescido).
--
-- Segurança:
--   * O Realtime respeita a RLS atual (SELECT só de owner/admin da empresa); nada de grants novo.
--   * print_agents é publicada COM LISTA DE COLUNAS, sem token_hash: o hash do token do agente nunca é
--     enviado pelo canal Realtime (a coluna também não é legível por SELECT do cliente).
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'print_jobs') then
    alter publication supabase_realtime add table public.print_jobs;
  end if;

  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'print_devices') then
    alter publication supabase_realtime add table public.print_devices;
  end if;

  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'print_agents') then
    alter publication supabase_realtime add table public.print_agents
      (id, company_id, name, machine_id, machine_name, is_active, last_seen_at, created_by, created_at, updated_at, revoked_at);
  end if;

  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'print_enqueue_failures') then
    alter publication supabase_realtime add table public.print_enqueue_failures;
  end if;
end
$$;

-- WhatsApp — Etapa 10: histórico paginado da varredura dos tokens para o Admin Master (somente leitura, aditiva).
-- Uma RPC nova; nenhuma tabela, coluna, função existente ou dado é alterado. A tela /master/whatsapp lê o histórico SÓ por aqui
-- (whatsapp_token_sweep_runs continua sem acesso de cliente). A mensagem de erro já é gravada sanitizada pela própria varredura.

create function public.master_whatsapp_token_sweep_history(
  p_status text default null,
  p_source text default null,
  p_limit integer default 20,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total bigint;
begin
  perform public.assert_master_admin();
  if p_status is not null and p_status not in ('success', 'failed', 'skipped_concurrent') then
    raise exception 'Filtro de resultado inválido.' using errcode = 'PT400';
  end if;
  if p_source is not null and p_source not in ('cron', 'manual') then
    raise exception 'Filtro de origem inválido.' using errcode = 'PT400';
  end if;

  select count(*) into v_total from public.whatsapp_token_sweep_runs r
   where (p_status is null or r.status = p_status) and (p_source is null or r.source = p_source);

  return jsonb_build_object(
    'total', v_total, 'limit', v_limit, 'offset', v_offset,
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', x.id, 'source', x.source, 'status', x.status, 'started_at', x.started_at, 'finished_at', x.finished_at,
               'checked', x.connections_checked, 'locked_skipped', x.connections_locked_skipped, 'updated', x.states_updated,
               'alerts_created', x.alerts_created, 'alerts_refreshed', x.alerts_refreshed,
               'error_code', x.error_code, 'error_message', x.error_message)
             order by x.started_at desc, x.id desc)
        from (select * from public.whatsapp_token_sweep_runs r
               where (p_status is null or r.status = p_status) and (p_source is null or r.source = p_source)
               order by r.started_at desc, r.id desc limit v_limit offset v_offset) x), '[]'::jsonb));
end;
$$;
revoke execute on function public.master_whatsapp_token_sweep_history(text, text, integer, integer) from public, anon, service_role;
grant execute on function public.master_whatsapp_token_sweep_history(text, text, integer, integer) to authenticated;

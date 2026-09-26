-- Módulo operacional — etapa 2: leitura enxuta do painel de comandas e mesas.
--
-- service_points_panel(p_company_id) devolve, numa chamada só, o modo de atendimento da
-- empresa e os pontos COMPATÍVEIS com esse modo (command mostra comandas, table mostra
-- mesas, both mostra os dois), cada um já com o atendimento ABERTO, se houver, e o nome
-- de quem abriu. Uma consulta no lugar de uma por ponto (N+1).
--
--   {
--     "service_mode": "command" | "table" | "both",
--     "points": [
--       { "id", "type", "code", "display_name", "barcode", "is_active",
--         "open_session": null | { "id", "customer_name", "opened_at",
--                                  "opened_by", "opened_by_name" } }, ...
--     ]
--   }
--
-- Pontos inativos vêm na lista (is_active = false) para a tela poder mostrá-los como
-- "Inativo". A busca por código, nome, cliente ou código de barras é feita na tela em
-- cima desta lista.
--
-- SECURITY INVOKER, de propósito: quem enxerga o quê continua sendo o RLS de quem chama
-- (service_points, service_sessions, company_operational_settings e o perfil dos
-- colegas). Empresa que a pessoa não enxerga, ou vínculo inativo, responde como
-- inexistente (PT404), sem revelar nada. Só leitura: nenhuma tabela muda.

create function public.service_points_panel(p_company_id uuid)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_mode text;
begin
  select s.service_mode into v_mode
  from public.company_operational_settings s
  where s.company_id = p_company_id;

  if v_mode is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;

  return jsonb_build_object(
    'service_mode', v_mode,
    'points', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', sp.id,
          'type', sp.type,
          'code', sp.code,
          'display_name', sp.display_name,
          'barcode', sp.barcode,
          'is_active', sp.is_active,
          'open_session', case
            when ss.id is null then null
            else jsonb_build_object(
              'id', ss.id,
              'customer_name', ss.customer_name,
              'opened_at', ss.opened_at,
              'opened_by', ss.opened_by,
              'opened_by_name', pr.full_name
            )
          end
        )
        order by sp.type, sp.code
      )
      from public.service_points sp
      left join public.service_sessions ss
        on ss.service_point_id = sp.id and ss.status = 'open'
      left join public.profiles pr on pr.user_id = ss.opened_by
      where sp.company_id = p_company_id
        and (v_mode = 'both' or sp.type = v_mode)
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.service_points_panel(uuid) from public, anon;
grant execute on function public.service_points_panel(uuid) to authenticated;

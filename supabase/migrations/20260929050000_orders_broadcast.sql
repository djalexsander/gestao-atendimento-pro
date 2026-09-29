-- Broadcast PRIVADO do Realtime para avisar, em ~1s, que uma comanda/mesa recebeu pedido.
-- O aviso não carrega dado nenhum além do id do atendimento; quem recebe recarrega do banco.
--
-- Topic: 'service-session:<uuid do atendimento>' (um por atendimento; nunca global).
-- Autorização (Realtime Authorization, tabela realtime.messages): só quem é membro ATIVO da
-- empresa dona do atendimento pode RECEBER e ENVIAR nesse topic. Membro de outra empresa, ou
-- topic fora do padrão / de atendimento inexistente, é negado.
--
-- Não altera nenhuma migration anterior nem tabela de negócio. Se o schema realtime não existir
-- (ambiente de teste sem Supabase), só a função é criada e as policies são puladas.

create or replace function public.can_use_service_session_topic(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
begin
  if auth.uid() is null or p_topic is null or p_topic !~ '^service-session:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;

  v_session_id := substr(p_topic, char_length('service-session:') + 1)::uuid;

  return exists (
    select 1
    from public.service_sessions ss
    where ss.id = v_session_id
      and ss.company_id in (select public.user_company_ids())
  );
end;
$$;

revoke execute on function public.can_use_service_session_topic(text) from public, anon;
grant execute on function public.can_use_service_session_topic(text) to authenticated;

do $$
begin
  if to_regclass('realtime.messages') is null then
    raise notice 'realtime.messages não existe: policies de Broadcast puladas.';
    return;
  end if;

  execute 'drop policy if exists service_session_broadcast_receive on realtime.messages';
  execute 'drop policy if exists service_session_broadcast_send on realtime.messages';

  execute $p$
    create policy service_session_broadcast_receive on realtime.messages
      for select to authenticated
      using (extension = 'broadcast' and public.can_use_service_session_topic(realtime.topic()))
  $p$;

  execute $p$
    create policy service_session_broadcast_send on realtime.messages
      for insert to authenticated
      with check (extension = 'broadcast' and public.can_use_service_session_topic(realtime.topic()))
  $p$;
end
$$;

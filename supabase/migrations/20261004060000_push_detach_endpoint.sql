-- PUSH NOTIFICATIONS — detach_push_endpoint: garante que NENHUMA associação ativa permaneça num endpoint.
--
-- Problema: aparelho compartilhado. Se o logout do usuário anterior não conseguiu desativar a associação dele
-- (rede/timeout), ela continua ativa no servidor quando o próximo usuário entra no mesmo navegador. Se o próximo
-- usuário NÃO deve receber push (opt-out manual, por exemplo), register_push_subscription não serve (ele ATIVARIA o
-- usuário atual) e remove_push_subscription não alcança a linha do usuário anterior (só desativa as do próprio).
--
-- detach_push_endpoint desativa, numa única instrução atômica, TODAS as associações ativas daquele endpoint, de
-- qualquer usuário/empresa, e NÃO ativa ninguém. O estado final é "zero usuários ativos no endpoint".
--
-- Segurança:
--   * exige sessão e vínculo ATIVO do chamador na empresa informada (contexto válido);
--   * não recebe user_id (o usuário vem de auth.uid()), não recebe chaves e não devolve endpoint/chaves: devolve só
--     a quantidade de linhas desativadas;
--   * só DESLIGA entregas (nunca liga, nunca lê). Quem conhece o endpoint (URL secreta que só o próprio aparelho
--     tem) já controla o aparelho; no pior caso desliga entregas, que o dono reativa ao entrar.
--   * nenhum SELECT direto novo; a tabela continua fechada para os papéis de cliente.
--
-- Erros (mesmo padrão das RPCs de push): PT401 sem sessão, PT404 empresa/vínculo, PT400 endpoint inválido.

create function public.detach_push_endpoint(p_company_id uuid, p_endpoint text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_endpoint text := btrim(coalesce(p_endpoint, ''));
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  -- vínculo ATIVO na empresa informada (contexto válido)
  if public.user_role_in_company(p_company_id) is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;

  if v_endpoint = '' or v_endpoint !~ '^https://' or char_length(v_endpoint) > 2000 then
    raise exception 'Aparelho inválido para notificações.' using errcode = 'PT400';
  end if;

  update public.push_subscriptions
     set is_active = false,
         updated_at = now()
   where endpoint = v_endpoint
     and is_active;
  get diagnostics v_count = row_count;

  return v_count;
end;
$$;

comment on function public.detach_push_endpoint(uuid, text) is
  'Desativa, atomicamente, TODAS as associações ativas de um endpoint (qualquer usuário/empresa) e não ativa ninguém. Exige sessão e vínculo ativo na empresa informada. Devolve só a contagem.';

revoke execute on function public.detach_push_endpoint(uuid, text) from public, anon;
grant execute on function public.detach_push_endpoint(uuid, text) to authenticated, service_role;

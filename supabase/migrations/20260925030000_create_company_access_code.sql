-- Funcionários e acesso — etapa 3: create_company passa a exigir o código de acesso.
--
-- ATENÇÃO — muda a ASSINATURA da RPC. Não aplicar no remoto antes do frontend
-- novo (o atual chama a assinatura antiga e quebra a criação de empresa):
--
--   antes:  create_company(p_name text, p_slug text, p_document text default null)
--   agora:  create_company(p_name text, p_slug text, p_access_code text, p_document text default null)
--
-- A empresa nasce já com name, slug e access_code, na mesma transação do
-- vínculo owner. O parâmetro novo entra ANTES de p_document porque, no
-- PostgreSQL, parâmetros com DEFAULT precisam vir por último. A assinatura
-- antiga é REMOVIDA, não mantida como overload: com as duas convivendo, o
-- frontend antigo continuaria criando empresas sem código. Chamadas
-- POSICIONAIS antigas (nome, slug, documento) passariam o documento como
-- código; o supabase-js usa parâmetros nomeados, então o app não é afetado
-- por isso — só falha, até ser atualizado, por não enviar p_access_code.
--
-- access_code:
--   * vem do chamador, explicitamente — NÃO é derivado do slug;
--   * é normalizado com btrim + lower antes do INSERT;
--   * NULL é recusado aqui, porque a CHECK aceita NULL (a coluna segue opcional
--     para empresas criadas por outros caminhos);
--   * formato e unicidade continuam decididos pelas constraints
--     companies_access_code_format e companies_access_code_key. A função não
--     repete a regra: só traduz as violações dessas duas constraints em
--     mensagens amigáveis. Como a tradução parte do erro do próprio INSERT,
--     vale também numa corrida entre dois cadastros com o mesmo código (quem
--     perde recebe a mesma mensagem amigável).
--
-- Os erros amigáveis usam SQLSTATE P0001 (raise exception comum), de propósito
-- e NÃO 23505: o AuthProvider trata 23505 como "slug em uso" e refaz a chamada
-- com outro slug. Violações de qualquer outra constraint (ex.:
-- companies_slug_key) seguem exatamente como antes, com o erro original.
--
-- O resto é idêntico à versão anterior: SECURITY DEFINER, search_path, exigência
-- de auth.uid(), vínculo owner em company_users e retorno public.companies (a
-- linha devolvida agora traz também access_code).

drop function public.create_company(text, text, text);

create function public.create_company(
  p_name text,
  p_slug text,
  p_access_code text,
  p_document text default null
)
returns public.companies
language plpgsql
security definer
set search_path = public
as $$
declare
  c_invalid_code constant text :=
    'Código da empresa inválido. Use de 3 a 32 caracteres, apenas letras minúsculas, números e hífen simples entre os termos.';
  c_code_in_use constant text := 'Este código de empresa já está em uso.';
  v_company public.companies;
  v_access_code text;
  v_constraint text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  v_access_code := lower(btrim(p_access_code));
  if v_access_code is null then
    raise exception '%', c_invalid_code;
  end if;

  -- Só o INSERT da empresa é traduzido; o bloco interno também isola o erro
  -- original (com o valor do código no DETAIL) da resposta ao cliente.
  begin
    insert into public.companies (name, slug, access_code, document)
    values (p_name, p_slug, v_access_code, p_document)
    returning * into v_company;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'companies_access_code_key' then
        raise exception '%', c_code_in_use;
      end if;
      raise;
    when check_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'companies_access_code_format' then
        raise exception '%', c_invalid_code;
      end if;
      raise;
  end;

  insert into public.company_users (company_id, user_id, role)
  values (v_company.id, auth.uid(), 'owner');

  return v_company;
end;
$$;

revoke execute on function public.create_company(text, text, text, text) from public, anon, authenticated;
grant execute on function public.create_company(text, text, text, text) to authenticated;

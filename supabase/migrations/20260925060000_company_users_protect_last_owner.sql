-- Funcionários e acesso — etapa 7: a empresa nunca fica sem owner ativo.
--
-- Trigger em company_users que impede o ÚLTIMO owner ativo de uma empresa de:
--   * ser removido (DELETE);
--   * deixar de ser owner (role trocada para admin, attendant ou cashier);
--   * ficar inativo (status diferente de 'active');
--   * ser movido para outra empresa (company_id alterado).
-- A recusa é a mensagem amigável "Não é possível remover ou desativar o último
-- proprietário da empresa." (SQLSTATE P0001, como as demais mensagens amigáveis
-- do projeto; o employee-admin pode reconhecê-la pelo texto).
--
-- É regra da TABELA, não de RLS: vale para qualquer role e caminho de escrita —
-- service_role (que ignora RLS), SQL direto e futuras Edge Functions.
--
-- "Último" = não existe OUTRO vínculo da mesma empresa com role owner e status
-- 'active'. Owner inativo não conta como proteção. Havendo outro owner ativo, a
-- alteração ou remoção passa normalmente. INSERT não é afetado e nada cria owner
-- automaticamente. Vínculos que não são owner ativo (admin, attendant, cashier,
-- owner inativo) não disparam nada: o trigger só roda quando a linha ANTIGA é um
-- owner ativo, e um UPDATE que mantém a linha como owner ativo da mesma empresa
-- (ex.: must_change_password) passa direto.
--
-- Uma instrução que mexe em vários owners de uma vez (ex.: desativar todos) é
-- recusada por inteiro: a checagem de cada linha enxerga as alterações que a
-- própria instrução já fez nas anteriores.
--
-- Exceção deliberada: o DELETE em CASCATA da exclusão da própria empresa (FK
-- company_users.company_id ON DELETE CASCADE) é permitido. Nesse momento a linha
-- da empresa já foi apagada e o trigger enxerga isso. Sem essa exceção nenhuma
-- empresa poderia ser excluída, nem pela policy companies_delete do owner nem por
-- SQL. Consequência a saber: apagar a conta de Auth do último owner (cascade por
-- user_id) é recusado enquanto a empresa existir; apagar a empresa continua
-- permitido.
--
-- Concorrência: a pergunta "existe outro owner ativo?" roda sob um lock de
-- transação por empresa (pg_advisory_xact_lock). Sem ele, dois pedidos
-- simultâneos, cada um mexendo num de dois owners, poderiam passar juntos e
-- deixar a empresa sem owner. O lock só é tomado quando a alteração realmente
-- tira um owner ativo, e é liberado no fim da transação.
--
-- Fora do alcance de um trigger de linha (exigem dono da tabela/superusuário):
-- TRUNCATE, desabilitar o trigger e session_replication_role = replica.
--
-- Não altera RLS, grants, roles, status, login, Auth, company_invites nem
-- create_company. SECURITY DEFINER só para a checagem enxergar todos os vínculos
-- independentemente de RLS de quem escreve.

create function public.guard_last_active_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Só interessa quando a linha ANTIGA é um owner ativo.
  if not (old.role = 'owner' and old.status = 'active') then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- Continua sendo owner ativo da mesma empresa: nada a proteger.
    if new.role = 'owner' and new.status = 'active' and new.company_id = old.company_id then
      return new;
    end if;
  elsif not exists (select 1 from public.companies c where c.id = old.company_id) then
    -- DELETE em cascata da exclusão da própria empresa.
    return old;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('company_users:last_owner:' || old.company_id::text, 0));

  if not exists (
    select 1
    from public.company_users cu
    where cu.company_id = old.company_id
      and cu.role = 'owner'
      and cu.status = 'active'
      and cu.id <> old.id
  ) then
    raise exception 'Não é possível remover ou desativar o último proprietário da empresa.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger company_users_guard_last_owner
  before update or delete on public.company_users
  for each row
  when (old.role = 'owner' and old.status = 'active')
  execute function public.guard_last_active_owner();

revoke execute on function public.guard_last_active_owner() from public, anon, authenticated;

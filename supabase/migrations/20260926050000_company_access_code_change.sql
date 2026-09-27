-- Código de acesso da empresa — troca controlada (tela "Configurações da empresa").
--
-- Até aqui companies.access_code era IMUTÁVEL depois de definido (trigger da migration
-- 20260925020000). A tela de configurações passa a permitir a troca, mas só enquanto ela não
-- afeta ninguém: o código faz parte do e-mail técnico das contas de funcionário,
--     <login>@<access_code>.staff.alexproapps.com.br
-- então trocá-lo com funcionário cadastrado quebraria o login deles. Esta migration NÃO tenta
-- atualizar e-mails técnicos.
--
-- Regra, decidida no BANCO (a tela só a espelha):
--   1. A troca só vale se NÃO existir nenhum company_users da empresa com login preenchido,
--      ativo ou inativo (um funcionário desativado ainda tem o e-mail técnico e pode ser
--      reativado). Vale para QUALQUER caminho de escrita, inclusive service_role e SQL direto.
--      Excluir o funcionário (some a linha) destrava.
--   2. Quem troca é owner ou admin ATIVO da empresa. Vale para qualquer usuário logado.
--      service_role e SQL direto (sem auth.uid()) não têm papel e só se sujeitam à regra 1 —
--      a mesma convenção do trigger que barra conta de funcionário criando empresa.
--   3. O código nunca é removido (valor -> NULL segue recusado).
--   4. Definir o primeiro código (NULL -> valor) segue as mesmas regras.
--
-- Como o cliente escreve: continua SEM grant de UPDATE em access_code (authenticated só
-- atualiza name e document em companies). A escrita é pela RPC abaixo, no mesmo estilo de
-- create_company: normaliza (btrim + lower), não repete o formato (traduz a violação das
-- constraints companies_access_code_format e companies_access_code_key em mensagem amigável)
-- e devolve a empresa atualizada.
--
-- slug: nada aqui o lê nem o altera. Trocar o código não muda o slug e trocar o slug não muda
-- o código.
--
-- Concorrência: a RPC trava a linha da empresa (FOR UPDATE) ANTES de olhar os funcionários.
-- Um cadastro de funcionário que já inseriu o vínculo segura um KEY SHARE nessa mesma linha (a
-- FK de company_users), então a troca espera esse cadastro terminar e só depois conta os
-- funcionários (e o encontra). Resta uma janela teórica de milissegundos: um cadastro que já
-- LEU o código antigo e só grava depois do commit da troca. Fechá-la exige uma trava no próprio
-- cadastro de funcionário, que esta migration não altera.

-- ---------------------------------------------------------------------------
-- 1) Trigger: da "imutabilidade" para a troca controlada
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE mantém o OID e o trigger companies_access_code_immutable (nome mantido
-- para não recriar um trigger no ar; o comentário abaixo diz o que ele passou a fazer).
-- SECURITY DEFINER para enxergar todos os company_users da empresa, qualquer que seja quem
-- escreve (sob RLS um usuário só veria parte deles).
create or replace function public.prevent_company_access_code_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
begin
  -- Não mexeu no código: nada a decidir.
  if new.access_code is not distinct from old.access_code then
    return new;
  end if;

  if new.access_code is null then
    raise exception 'O código da empresa não pode ser removido.' using errcode = 'PT409';
  end if;

  if exists (
    select 1
    from public.company_users cu
    where cu.company_id = old.id and cu.login is not null
  ) then
    raise exception 'Este código não pode ser alterado enquanto houver funcionários cadastrados, pois ele faz parte das credenciais de acesso.'
      using errcode = 'PT409';
  end if;

  -- Só olha o papel quando há usuário logado (service_role e SQL direto não têm).
  if auth.uid() is not null then
    v_role := public.user_role_in_company(old.id);
    if v_role is null or v_role not in ('owner', 'admin') then
      raise exception 'Somente donos(as) e administradores(as) podem alterar o código da empresa.'
        using errcode = 'PT403';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.prevent_company_access_code_change() from public, anon, authenticated;

comment on function public.prevent_company_access_code_change() is
  'Guarda de companies.access_code: só muda se a empresa NÃO tem funcionário com login (qualquer caminho) e, havendo usuário logado, se ele é owner/admin ativo; nunca vira NULL.';
comment on trigger companies_access_code_immutable on public.companies is
  'Nome antigo (era imutável). Hoje: troca controlada do access_code, ver prevent_company_access_code_change().';
comment on column public.companies.access_code is
  'Código de acesso da empresa no login dos funcionários. Independente de slug; [a-z0-9-], 3 a 32 caracteres, sem hífen no início, no fim nem dois seguidos; único. Só muda enquanto a empresa não tem funcionário com login, por owner/admin (RPC update_company_access_code); nunca é removido.';

-- ---------------------------------------------------------------------------
-- 2) RPC: trocar (ou definir) o código da empresa
-- ---------------------------------------------------------------------------
-- Erros (o PostgREST devolve ### como status HTTP): PT401 sem sessão, PT404 empresa não
-- encontrada (também para quem não é membro ativo dela), PT403 sem permissão, PT400 código
-- inválido, PT409 código em uso ou travado por funcionário cadastrado. Um código igual ao atual
-- não muda nada e devolve a empresa como está.
create function public.update_company_access_code(
  p_company_id uuid,
  p_access_code text
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
  v_role public.company_role;
  v_code text := lower(btrim(coalesce(p_access_code, '')));
  v_company public.companies;
  v_constraint text;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  -- Quem não é membro ativo recebe a mesma resposta de uma empresa que não existe, e
  -- nem chega a travar a linha da empresa alheia.
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Somente donos(as) e administradores(as) podem alterar o código da empresa.'
      using errcode = 'PT403';
  end if;

  select * into v_company from public.companies where id = p_company_id for update;
  if not found then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;

  if v_company.access_code is not distinct from v_code then
    return v_company;
  end if;

  -- O trigger companies_access_code_immutable decide a regra dos funcionários e do papel; o
  -- bloco só traduz as violações de formato e de unicidade do próprio UPDATE.
  begin
    update public.companies
    set access_code = v_code
    where id = p_company_id
    returning * into v_company;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'companies_access_code_key' then
        raise exception '%', c_code_in_use using errcode = 'PT409';
      end if;
      raise;
    when check_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'companies_access_code_format' then
        raise exception '%', c_invalid_code using errcode = 'PT400';
      end if;
      raise;
  end;

  return v_company;
end;
$$;

revoke execute on function public.update_company_access_code(uuid, text) from public, anon, authenticated;
grant execute on function public.update_company_access_code(uuid, text) to authenticated;

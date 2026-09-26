-- Funcionários e acesso — etapa 8: regra de autorização para gerenciar equipe.
--
-- Cria public.can_manage_company_user(), o helper que o futuro employee-admin
-- consultará ANTES de criar, editar, trocar a role, redefinir a senha, ativar,
-- desativar ou excluir um funcionário. Esta migration só centraliza a REGRA: não
-- cria nem altera funcionário, não chama a Admin API/service_role, não registra
-- eventos e não mexe em RLS, policies, grants de tabela, Auth, company_invites
-- nem create_company.
--
--   can_manage_company_user(p_company_id      uuid,
--                           p_target_user_id  uuid                default null,
--                           p_new_role        public.company_role default null)
--   returns boolean
--
-- O ator é sempre auth.uid(). O resultado é true ou false, nunca NULL: sem
-- sessão, empresa inexistente, alvo que não é da empresa, role desconhecida ou
-- parâmetros incompletos dão false.
--
-- Como chamar (p_target_user_id, p_new_role):
--   criar funcionário            (NULL,    role a criar)
--   agir sobre quem já existe    (usuário, NULL)         editar, senha, status, excluir
--   trocar a role                (usuário, role nova)
-- Sem alvo e sem role não há o que autorizar: false.
--
-- Matriz (role do ator -> roles que ele pode gerenciar e atribuir):
--   owner                 -> admin, cashier, attendant
--   admin                 -> cashier, attendant
--   cashier, attendant    -> nenhuma
-- Ninguém gerencia owner nem atribui a role owner por este fluxo (transferir a
-- titularidade é outro assunto), e ninguém age sobre si próprio.
--
-- Regras, na ordem em que são aplicadas:
--   1. Ator: precisa ter vínculo ATIVO na empresa. Usa user_role_in_company(), o
--      mesmo critério das policies. Inativo, sem vínculo ou de outra empresa: false.
--   2. Alvo existente: precisa ser vínculo da PRÓPRIA empresa (qualquer status,
--      porque reativar, redefinir senha e excluir também recaem sobre funcionário
--      inativo), ser outra pessoa que não o ator, e ter uma role que o ator
--      gerencia.
--   3. Role informada (criação ou troca): a role de DESTINO também precisa estar
--      na lista do ator. Na troca valem as duas: a atual e a de destino.
--   Exemplos: owner   attendant->cashier, cashier->admin, admin->attendant: sim.
--             admin   attendant->cashier, cashier->attendant: sim;
--                     attendant->admin: não (destino admin).
--
-- Limites deliberados:
--   * Decide só por empresa, role e status. Não distingue conta operacional (com
--     login) de conta normal por e-mail; o employee-admin decide isso por
--     operação (ex.: redefinir senha só de conta com login).
--   * É uma leitura no instante da chamada, sem trava. Quem gravar depois precisa
--     reavaliar dentro da própria transação.
--
-- Segurança: SECURITY DEFINER (lê company_users sem depender das policies de quem
-- chama) com search_path fixo; EXECUTE revogado de PUBLIC, anon e authenticated,
-- porque não é RPC de cliente. service_role mantém o default da plataforma, mas
-- sem sessão de usuário (auth.uid() nulo) o resultado é false. Quando o
-- employee-admin existir, ou ele chama por um wrapper SECURITY DEFINER ou esta
-- função ganha um GRANT explícito para authenticated: decisão da etapa dele,
-- nada disso é necessário agora.

create function public.can_manage_company_user(
  p_company_id uuid,
  p_target_user_id uuid default null,
  p_new_role public.company_role default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_role public.company_role;
  v_manageable public.company_role[];
  v_current_role public.company_role;
begin
  -- Sem alvo e sem role não há o que autorizar.
  if p_target_user_id is null and p_new_role is null then
    return false;
  end if;

  -- Ator: vínculo ativo na empresa (NULL = inativo, sem vínculo ou sem sessão).
  v_actor_role := public.user_role_in_company(p_company_id);
  if v_actor_role is null then
    return false;
  end if;

  -- A matriz, num só lugar: as roles que o ator pode gerenciar e atribuir.
  if v_actor_role = 'owner' then
    v_manageable := array['admin', 'cashier', 'attendant']::public.company_role[];
  elsif v_actor_role = 'admin' then
    v_manageable := array['cashier', 'attendant']::public.company_role[];
  else
    return false;
  end if;

  if p_target_user_id is not null then
    -- Ninguém age sobre si próprio. Explícito de propósito: a matriz de hoje já
    -- o implica, mas uma matriz futura não pode reabrir isso sem querer.
    if p_target_user_id = v_actor then
      return false;
    end if;

    select cu.role into v_current_role
    from public.company_users cu
    where cu.company_id = p_company_id
      and cu.user_id = p_target_user_id;

    -- Alvo fora da empresa, ou com role que o ator não gerencia (owner incluso).
    if not coalesce(v_current_role = any(v_manageable), false) then
      return false;
    end if;
  end if;

  -- Role de destino (criação ou troca de role).
  if p_new_role is not null and not (p_new_role = any(v_manageable)) then
    return false;
  end if;

  return true;
end;
$$;

revoke execute on function public.can_manage_company_user(uuid, uuid, public.company_role)
  from public, anon, authenticated;

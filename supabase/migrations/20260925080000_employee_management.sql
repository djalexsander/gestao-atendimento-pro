-- Funcionários e acesso — etapa 9: gestão de funcionários (banco).
--
-- REGRA DE PRODUTO: funcionário NÃO é "membro convidado". Não há convite, e-mail
-- visível, confirmação por e-mail, cadastro próprio, recuperação de senha por
-- e-mail nem troca obrigatória de credencial no primeiro acesso. O dono ou o
-- admin cria a conta direto (nome, login, PIN ou senha, função). O e-mail
-- <login>@<access_code>.staff.alexproapps.com.br existe SÓ como detalhe interno
-- do Supabase Auth; o funcionário nunca o vê. A credencial (PIN de 6 dígitos ou
-- senha) fica SOMENTE no Auth: nada neste arquivo a recebe, guarda ou registra.
-- company_users.must_change_password continua nascendo false (campo reservado
-- para uso futuro; nada aqui o liga).
--
-- O QUE ESTA MIGRATION CRIA
--   1. company_user_events: auditoria append-only da gestão de funcionários.
--   2. company_user_has_activity(): ponto ÚNICO da regra "quem tem movimentação
--      não pode ser excluído". Hoje devolve false (ainda não há pedidos, caixa,
--      comandas nem mesas).
--   3. company_staff_email(): o e-mail técnico, num lugar só.
--   4. handle_new_user() e handle_user_email_updated(): conta gerenciada nunca
--      copia o e-mail técnico para profiles.email (colegas leem profiles).
--   5. Login imutável (trigger em company_users).
--   6. RPCs employee_*: toda escrita em company_users, profiles e eventos.
--
-- COMO A EDGE FUNCTION employee-admin USA ISTO
--   As RPCs são SECURITY DEFINER e a Edge Function as chama com o JWT REAL do
--   ator: auth.uid() é o dono/admin e cada RPC reavalia can_manage_company_user()
--   (migration 070000) no momento da escrita. A Edge Function usa service_role só
--   na Auth Admin API (criar usuário, trocar credencial, banir, apagar) e nunca
--   escreve em tabela.
--
--   Ordem de cada ação (falha parcial nunca deixa acesso indevido):
--     criar       prepare_create -> Auth createUser -> create_member
--                 (se o vínculo falhar, a Edge Function apaga o usuário do Auth)
--     editar      update (só banco)
--     credencial  prepare_manage -> Auth updateUserById(senha) -> record_password_reset
--     desativar   set_status('inactive') -> Auth ban. Banco primeiro: o RLS da
--                 050000 corta o acesso na hora; o ban barra novo login e a
--                 renovação de sessão (o access token já emitido vale até expirar,
--                 mas sem dados). Se o ban falhar, o funcionário segue inativo.
--     ativar      prepare_manage -> Auth unban -> set_status('active'). Se algo
--                 falhar no meio, o funcionário segue inativo.
--     excluir     prepare_delete -> Auth deleteUser (a cascata apaga vínculo e
--                 perfil) -> record_deleted (auditoria com o snapshot)
--
-- Só contas GERENCIADAS (company_users.login preenchido) passam por estas RPCs:
-- nunca o owner nem um membro que tenha e-mail próprio, cuja credencial não é do
-- dono/admin para trocar.
--
-- Erros das RPCs: mensagem amigável em português, que a Edge Function repassa.
--   PT401 sem sessão   PT403 sem permissão   PT404 não encontrado
--   PT400 dado inválido   PT409 conflito ou regra de negócio
-- (PT###: o PostgREST devolve ### como status HTTP.)
--
-- Fora daqui, de propósito: telas de login, create_company recusar conta
-- gerenciada, company_invites e as RPCs de convite (seguem no banco, sem uso).

-- ---------------------------------------------------------------------------
-- 1) company_user_events: auditoria append-only.
--    actor_user_id e target_user_id são uuid SEM FK, de propósito: o histórico
--    sobrevive à exclusão de quem agiu e do próprio funcionário (o payload do
--    evento 'deleted' guarda o snapshot). seq ordena eventos gravados na mesma
--    transação (created_at é igual entre eles).
-- ---------------------------------------------------------------------------
create table public.company_user_events (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  company_id uuid not null references public.companies(id) on delete cascade,
  actor_user_id uuid,
  target_user_id uuid,
  event_type text not null check (event_type in (
    'created', 'updated', 'role_changed', 'password_reset',
    'activated', 'deactivated', 'deleted'
  )),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index company_user_events_company_idx
  on public.company_user_events (company_id, seq desc);
create index company_user_events_target_idx
  on public.company_user_events (target_user_id) where target_user_id is not null;

alter table public.company_user_events enable row level security;

-- Sem policy e sem grant: o frontend não lê nem escreve. Só as RPCs abaixo gravam.
revoke all on public.company_user_events from anon, authenticated;

-- Append-only no banco (não só nas RPCs). Única exceção: o DELETE em cascata da
-- exclusão da própria empresa, quando a linha da empresa já sumiu.
create function public.prevent_company_user_event_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from public.companies c where c.id = old.company_id
  ) then
    return old;
  end if;
  raise exception 'company_user_events é append-only';
end;
$$;

create trigger company_user_events_no_change
  before update or delete on public.company_user_events
  for each row execute function public.prevent_company_user_event_change();

revoke execute on function public.prevent_company_user_event_change() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) company_user_has_activity(): quem tem movimentação não é excluído; só
--    desativado. É o ÚNICO lugar dessa regra.
-- ---------------------------------------------------------------------------
create function public.company_user_has_activity(p_company_id uuid, p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- Ainda não existem pedidos, caixa, comandas, mesas nem pagamentos: nenhum
  -- funcionário tem movimentação, e o resultado é false de forma explícita.
  --
  -- FUTURO: cada tabela operacional acrescenta AQUI a sua checagem, por exemplo
  --   if exists (select 1 from public.orders
  --              where company_id = p_company_id and created_by = p_user_id) then
  --     return true;
  --   end if;
  -- Essas tabelas devem guardar a referência histórica do funcionário (sem apagar
  -- em cascata), para o histórico sobreviver e a exclusão ser sempre recusada.
  return false;
end;
$$;

revoke execute on function public.company_user_has_activity(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) O e-mail técnico do Auth. É o ÚNICO lugar do banco onde o domínio aparece;
--    a futura tela de login monta o mesmo endereço. Nunca é mostrado a ninguém.
-- ---------------------------------------------------------------------------
create function public.company_staff_email(p_login text, p_access_code text)
returns text
language sql
immutable
set search_path = public
as $$
  select lower(p_login) || '@' || lower(p_access_code) || '.staff.alexproapps.com.br';
$$;

revoke execute on function public.company_staff_email(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4) Conta gerenciada (app_metadata.managed = true, gravado só pela Admin API)
--    fica com profiles.email NULL: os colegas leem profiles, e o e-mail técnico
--    não pode aparecer. Valem os dois triggers que copiam o e-mail do Auth. Mesmas
--    assinaturas: CREATE OR REPLACE mantém os triggers e os ACLs.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, full_name, email)
  values (
    new.id,
    new.raw_user_meta_data ->> 'full_name',
    case when coalesce(new.raw_app_meta_data ->> 'managed', '') = 'true' then null else new.email end
  );
  return new;
end;
$$;

create or replace function public.handle_user_email_updated()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
  set email = case when coalesce(new.raw_app_meta_data ->> 'managed', '') = 'true' then null else new.email end
  where user_id = new.id;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Login imutável (e, com ele, o e-mail técnico). Vale para qualquer caminho
--    de escrita, service_role inclusive.
-- ---------------------------------------------------------------------------
create function public.prevent_company_user_login_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'O login do funcionário não pode ser alterado.';
end;
$$;

create trigger company_users_login_immutable
  before update on public.company_users
  for each row
  when (old.login is distinct from new.login)
  execute function public.prevent_company_user_login_change();

revoke execute on function public.prevent_company_user_login_change() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6) Helpers internos (sem EXECUTE para nenhum role de cliente).
-- ---------------------------------------------------------------------------
create function public.employee_log_event(
  p_company_id uuid,
  p_target_user_id uuid,
  p_event_type text,
  p_payload jsonb default '{}'::jsonb
)
returns void
language sql
set search_path = public
as $$
  insert into public.company_user_events (company_id, actor_user_id, target_user_id, event_type, payload)
  values (p_company_id, auth.uid(), p_target_user_id, p_event_type, coalesce(p_payload, '{}'::jsonb));
$$;

-- O funcionário como a UI o vê. Nunca inclui o e-mail técnico.
create function public.employee_member_json(p_company_id uuid, p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', cu.id,
    'company_id', cu.company_id,
    'user_id', cu.user_id,
    'name', pr.full_name,
    'login', cu.login,
    'role', cu.role,
    'status', cu.status,
    'must_change_password', cu.must_change_password,
    'created_by', cu.created_by,
    'created_at', cu.created_at,
    'updated_at', cu.updated_at
  )
  from public.company_users cu
  left join public.profiles pr on pr.user_id = cu.user_id
  where cu.company_id = p_company_id and cu.user_id = p_user_id;
$$;

-- Porta de entrada das ações sobre um funcionário que JÁ existe: exige sessão,
-- ator que gerencia equipe, alvo existente, permissão sobre o alvo (role atual e,
-- se informada, a de destino) e alvo gerenciado. Trava a linha do alvo.
create function public.employee_lock_target(
  p_company_id uuid,
  p_target_user_id uuid,
  p_new_role public.company_role default null
)
returns public.company_users
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target public.company_users;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  -- Quem não gerencia nem o nível mais baixo não descobre se o alvo existe.
  if not public.can_manage_company_user(p_company_id, null, 'attendant') then
    raise exception 'Você não tem permissão para gerenciar funcionários desta empresa.' using errcode = 'PT403';
  end if;

  select * into v_target
  from public.company_users
  where company_id = p_company_id and user_id = p_target_user_id
  for update;

  if not found then
    raise exception 'Funcionário não encontrado.' using errcode = 'PT404';
  end if;

  if not public.can_manage_company_user(p_company_id, p_target_user_id, p_new_role) then
    raise exception 'Você não tem permissão para gerenciar este funcionário.' using errcode = 'PT403';
  end if;

  if v_target.login is null then
    raise exception 'Este usuário não é um funcionário com login e não pode ser gerenciado aqui.' using errcode = 'PT403';
  end if;

  return v_target;
end;
$$;

revoke execute on function public.employee_log_event(uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public.employee_member_json(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.employee_lock_target(uuid, uuid, public.company_role) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7) RPCs (JWT do ator). Todas SECURITY DEFINER, EXECUTE só para authenticated.
-- ---------------------------------------------------------------------------

-- Criar, passo 1: valida tudo ANTES de criar a conta no Auth e devolve o e-mail
-- técnico (só para a Edge Function) e, se houver, uma conta órfã de uma tentativa
-- anterior falha, para a Edge Function apagar. O login é validado pelas próprias
-- constraints de company_users, sem repetir a regra aqui.
create function public.employee_prepare_create(
  p_company_id uuid,
  p_login text,
  p_role public.company_role,
  p_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_login text := lower(btrim(coalesce(p_login, '')));
  v_name text := btrim(coalesce(p_name, ''));
  v_access_code text;
  v_email text;
  v_existing_id uuid;
  v_orphan boolean;
  v_reclaim uuid;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  if p_role is null or not public.can_manage_company_user(p_company_id, null, p_role) then
    raise exception 'Você não tem permissão para cadastrar funcionário com esta função.' using errcode = 'PT403';
  end if;

  if char_length(v_name) < 1 or char_length(v_name) > 120 then
    raise exception 'Informe o nome do funcionário (até 120 caracteres).' using errcode = 'PT400';
  end if;

  select c.access_code into v_access_code from public.companies c where c.id = p_company_id;
  if v_access_code is null then
    raise exception 'A empresa ainda não tem código de acesso. Defina o código da empresa antes de cadastrar funcionários.' using errcode = 'PT400';
  end if;

  -- Ensaio de INSERT em company_users: formato do login (CHECK) e unicidade na
  -- empresa. O user_id inexistente faz a FK falhar por último, quando todas as
  -- outras constraints já passaram; o RAISE final garante o rollback do ensaio
  -- mesmo que a FK um dia não falhe. Nada é gravado.
  begin
    insert into public.company_users (company_id, user_id, role, login)
    values (p_company_id, gen_random_uuid(), p_role, v_login);
    raise exception using errcode = 'P0099', message = 'ensaio';
  exception
    when check_violation then
      raise exception 'Login inválido. Use de 3 a 32 caracteres: letras minúsculas, números, _ e -, com ponto apenas entre grupos.' using errcode = 'PT400';
    when unique_violation then
      raise exception 'Este login já está em uso nesta empresa.' using errcode = 'PT409';
    when foreign_key_violation then
      null;
    when sqlstate 'P0099' then
      null;
  end;

  v_email := public.company_staff_email(v_login, v_access_code);

  select u.id,
         coalesce(u.raw_app_meta_data ->> 'managed', '') = 'true'
           and coalesce(u.raw_app_meta_data ->> 'company_id', '') = p_company_id::text
    into v_existing_id, v_orphan
  from auth.users u
  where lower(u.email) = v_email;

  if v_existing_id is not null then
    -- Já existe conta com este e-mail técnico. Só é reaproveitável se for uma
    -- conta gerenciada DESTA empresa que ficou sem vínculo (tentativa anterior
    -- falha); qualquer outra situação é login indisponível.
    if exists (select 1 from public.company_users cu where cu.user_id = v_existing_id) or not v_orphan then
      raise exception 'Este login já está em uso.' using errcode = 'PT409';
    end if;
    v_reclaim := v_existing_id;
  end if;

  return jsonb_build_object(
    'login', v_login,
    'email', v_email,
    'access_code', v_access_code,
    'reclaim_user_id', v_reclaim
  );
end;
$$;

-- Criar, passo 2: depois do Auth. Reavalia a permissão e só vincula uma conta
-- gerenciada criada para ESTA empresa e ESTE login (app_metadata gravado pela
-- Admin API + e-mail técnico esperado), que ainda não tenha vínculo algum: não
-- serve para anexar uma conta qualquer.
create function public.employee_create_member(
  p_company_id uuid,
  p_user_id uuid,
  p_login text,
  p_name text,
  p_role public.company_role
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_login text := lower(btrim(coalesce(p_login, '')));
  v_name text := btrim(coalesce(p_name, ''));
  v_access_code text;
  v_email text;
  v_meta jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  if p_role is null or not public.can_manage_company_user(p_company_id, null, p_role) then
    raise exception 'Você não tem permissão para cadastrar funcionário com esta função.' using errcode = 'PT403';
  end if;

  if char_length(v_name) < 1 or char_length(v_name) > 120 then
    raise exception 'Informe o nome do funcionário (até 120 caracteres).' using errcode = 'PT400';
  end if;

  select c.access_code into v_access_code from public.companies c where c.id = p_company_id;

  select u.email, u.raw_app_meta_data into v_email, v_meta from auth.users u where u.id = p_user_id;
  if not found then
    raise exception 'Conta de acesso não encontrada.' using errcode = 'PT404';
  end if;

  if v_access_code is null
     or coalesce(v_meta ->> 'managed', '') <> 'true'
     or coalesce(v_meta ->> 'company_id', '') <> p_company_id::text
     or lower(coalesce(v_email, '')) <> public.company_staff_email(v_login, v_access_code) then
    raise exception 'Esta conta de acesso não corresponde a este cadastro.' using errcode = 'PT403';
  end if;

  if exists (select 1 from public.company_users cu where cu.user_id = p_user_id) then
    raise exception 'Esta conta de acesso já está vinculada a uma empresa.' using errcode = 'PT409';
  end if;

  begin
    insert into public.company_users (company_id, user_id, role, login, status, must_change_password, created_by)
    values (p_company_id, p_user_id, p_role, v_login, 'active', false, auth.uid());
  exception
    when check_violation then
      raise exception 'Login inválido. Use de 3 a 32 caracteres: letras minúsculas, números, _ e -, com ponto apenas entre grupos.' using errcode = 'PT400';
    when unique_violation then
      raise exception 'Este login já está em uso nesta empresa.' using errcode = 'PT409';
  end;

  -- O nome real do funcionário; nunca o e-mail técnico.
  insert into public.profiles (user_id, full_name, email)
  values (p_user_id, v_name, null)
  on conflict (user_id) do update set full_name = excluded.full_name, email = null;

  perform public.employee_log_event(
    p_company_id, p_user_id, 'created',
    jsonb_build_object('login', v_login, 'role', p_role, 'name', v_name)
  );

  return public.employee_member_json(p_company_id, p_user_id);
end;
$$;

-- Editar: só nome e função (o login é imutável). Considera a role atual E a de
-- destino. Só grava e audita o que de fato mudou.
create function public.employee_update(
  p_company_id uuid,
  p_target_user_id uuid,
  p_name text default null,
  p_role public.company_role default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target public.company_users;
  v_name text := btrim(p_name);
  v_old_name text;
  v_name_changed boolean := false;
  v_role_changed boolean := false;
  v_changes jsonb := '{}'::jsonb;
begin
  v_target := public.employee_lock_target(p_company_id, p_target_user_id, null);

  if p_name is null and p_role is null then
    raise exception 'Informe o nome ou a função a alterar.' using errcode = 'PT400';
  end if;
  if p_name is not null and (char_length(v_name) < 1 or char_length(v_name) > 120) then
    raise exception 'Informe o nome do funcionário (até 120 caracteres).' using errcode = 'PT400';
  end if;

  if p_role is not null and p_role <> v_target.role then
    if not public.can_manage_company_user(p_company_id, p_target_user_id, p_role) then
      raise exception 'Você não tem permissão para atribuir esta função.' using errcode = 'PT403';
    end if;
    v_role_changed := true;
  end if;

  select pr.full_name into v_old_name from public.profiles pr where pr.user_id = p_target_user_id;
  if p_name is not null and v_name is distinct from v_old_name then
    v_name_changed := true;
  end if;

  if v_role_changed then
    update public.company_users set role = p_role where id = v_target.id;
    v_changes := v_changes || jsonb_build_object('role', jsonb_build_object('from', v_target.role, 'to', p_role));
  end if;

  if v_name_changed then
    insert into public.profiles (user_id, full_name, email)
    values (p_target_user_id, v_name, null)
    on conflict (user_id) do update set full_name = excluded.full_name;
    v_changes := v_changes || jsonb_build_object('name', jsonb_build_object('from', v_old_name, 'to', v_name));
  end if;

  if v_role_changed or v_name_changed then
    perform public.employee_log_event(p_company_id, p_target_user_id, 'updated', v_changes);
    if v_role_changed then
      perform public.employee_log_event(
        p_company_id, p_target_user_id, 'role_changed',
        jsonb_build_object('from', v_target.role, 'to', p_role)
      );
    end if;
  end if;

  return public.employee_member_json(p_company_id, p_target_user_id);
end;
$$;

-- Passo prévio das ações que mexem no Auth (trocar credencial, reativar):
-- autoriza ANTES de qualquer chamada à Admin API.
create function public.employee_prepare_manage(p_company_id uuid, p_target_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target public.company_users;
begin
  v_target := public.employee_lock_target(p_company_id, p_target_user_id, null);
  return jsonb_build_object(
    'user_id', v_target.user_id,
    'login', v_target.login,
    'role', v_target.role,
    'status', v_target.status
  );
end;
$$;

-- Trocar PIN/senha, passo final: só a auditoria. A credencial vai direto ao Auth e
-- nunca passa por aqui, nem entra no payload. must_change_password não é tocado.
create function public.employee_record_password_reset(p_company_id uuid, p_target_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target public.company_users;
begin
  v_target := public.employee_lock_target(p_company_id, p_target_user_id, null);
  perform public.employee_log_event(
    p_company_id, p_target_user_id, 'password_reset',
    jsonb_build_object('login', v_target.login)
  );
  return public.employee_member_json(p_company_id, p_target_user_id);
end;
$$;

-- Ativar/desativar. Idempotente: pedir o status que já vale não grava evento e
-- devolve changed = false (a Edge Function ainda refaz o ban/unban no Auth, o que
-- permite repetir uma desativação que falhou no meio).
create function public.employee_set_status(
  p_company_id uuid,
  p_target_user_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target public.company_users;
begin
  v_target := public.employee_lock_target(p_company_id, p_target_user_id, null);

  if p_status is null or p_status not in ('active', 'inactive') then
    raise exception 'Status inválido.' using errcode = 'PT400';
  end if;

  if v_target.status = p_status then
    return jsonb_build_object('changed', false, 'member', public.employee_member_json(p_company_id, p_target_user_id));
  end if;

  update public.company_users set status = p_status where id = v_target.id;

  perform public.employee_log_event(
    p_company_id, p_target_user_id,
    case when p_status = 'active' then 'activated' else 'deactivated' end,
    jsonb_build_object('login', v_target.login, 'from', v_target.status, 'to', p_status)
  );

  return jsonb_build_object('changed', true, 'member', public.employee_member_json(p_company_id, p_target_user_id));
end;
$$;

-- Excluir, passo 1: autoriza, recusa quem tem movimentação e devolve o snapshot
-- que a auditoria vai guardar.
create function public.employee_prepare_delete(p_company_id uuid, p_target_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target public.company_users;
  v_name text;
begin
  v_target := public.employee_lock_target(p_company_id, p_target_user_id, null);

  if public.company_user_has_activity(p_company_id, p_target_user_id) then
    raise exception 'Este funcionário possui movimentações e não pode ser excluído. Desative o acesso.' using errcode = 'PT409';
  end if;

  select pr.full_name into v_name from public.profiles pr where pr.user_id = p_target_user_id;

  return jsonb_build_object('snapshot', jsonb_build_object(
    'login', v_target.login,
    'role', v_target.role,
    'status', v_target.status,
    'name', v_name,
    'created_at', v_target.created_at,
    'created_by', v_target.created_by
  ));
end;
$$;

-- Excluir, passo final: depois que o Auth apagou o usuário (e a cascata levou
-- vínculo e perfil), grava o evento 'deleted' com o snapshot. O alvo já não
-- existe, então a permissão é reavaliada sobre a role que ele tinha. Só registra
-- se a exclusão de fato aconteceu, é idempotente e só aproveita campos conhecidos
-- e limitados do snapshot.
create function public.employee_record_deleted(
  p_company_id uuid,
  p_target_user_id uuid,
  p_snapshot jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_status text := p_snapshot ->> 'status';
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  begin
    v_role := (p_snapshot ->> 'role')::public.company_role;
  exception
    when invalid_text_representation then
      raise exception 'Snapshot do funcionário inválido.' using errcode = 'PT400';
  end;

  if v_role is null or not public.can_manage_company_user(p_company_id, null, v_role) then
    raise exception 'Você não tem permissão para registrar esta exclusão.' using errcode = 'PT403';
  end if;

  if exists (select 1 from public.company_users cu where cu.company_id = p_company_id and cu.user_id = p_target_user_id)
     or exists (select 1 from auth.users u where u.id = p_target_user_id) then
    raise exception 'A exclusão do funcionário ainda não foi concluída.' using errcode = 'PT409';
  end if;

  if exists (
    select 1 from public.company_user_events e
    where e.company_id = p_company_id and e.target_user_id = p_target_user_id and e.event_type = 'deleted'
  ) then
    return;
  end if;

  perform public.employee_log_event(
    p_company_id, p_target_user_id, 'deleted',
    jsonb_build_object(
      'login', left(coalesce(p_snapshot ->> 'login', ''), 64),
      'role', v_role,
      'status', case when v_status in ('active', 'inactive') then v_status else null end,
      'name', left(coalesce(p_snapshot ->> 'name', ''), 120),
      'created_at', left(coalesce(p_snapshot ->> 'created_at', ''), 40),
      'created_by', left(coalesce(p_snapshot ->> 'created_by', ''), 36)
    )
  );
end;
$$;

revoke execute on function public.employee_prepare_create(uuid, text, public.company_role, text) from public, anon;
revoke execute on function public.employee_create_member(uuid, uuid, text, text, public.company_role) from public, anon;
revoke execute on function public.employee_update(uuid, uuid, text, public.company_role) from public, anon;
revoke execute on function public.employee_prepare_manage(uuid, uuid) from public, anon;
revoke execute on function public.employee_record_password_reset(uuid, uuid) from public, anon;
revoke execute on function public.employee_set_status(uuid, uuid, text) from public, anon;
revoke execute on function public.employee_prepare_delete(uuid, uuid) from public, anon;
revoke execute on function public.employee_record_deleted(uuid, uuid, jsonb) from public, anon;

grant execute on function public.employee_prepare_create(uuid, text, public.company_role, text) to authenticated;
grant execute on function public.employee_create_member(uuid, uuid, text, text, public.company_role) to authenticated;
grant execute on function public.employee_update(uuid, uuid, text, public.company_role) to authenticated;
grant execute on function public.employee_prepare_manage(uuid, uuid) to authenticated;
grant execute on function public.employee_record_password_reset(uuid, uuid) to authenticated;
grant execute on function public.employee_set_status(uuid, uuid, text) to authenticated;
grant execute on function public.employee_prepare_delete(uuid, uuid) to authenticated;
grant execute on function public.employee_record_deleted(uuid, uuid, jsonb) to authenticated;

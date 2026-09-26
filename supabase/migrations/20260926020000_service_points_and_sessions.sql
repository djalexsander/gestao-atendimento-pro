-- Módulo operacional — etapa 1: fundação de comandas e mesas.
--
-- Só a ESTRUTURA. Fora daqui, de propósito: produtos, categorias, pedidos, itens,
-- preços, cozinha/churrasqueira/bar, impressoras, fechamento, recebimento, estoque,
-- WhatsApp, imagem do código de barras e telas.
--
--   1. company_operational_settings: modo de atendimento da empresa
--      (command | table | both; padrão command). Uma linha por empresa, criada
--      sozinha ao criar a empresa (e preenchida agora para as que já existem).
--      Tabela própria, e não coluna de companies, para receber as próximas
--      configurações operacionais sem inchar companies.
--   2. service_points: estrutura ÚNICA para comanda e mesa (type = command | table).
--   3. service_sessions: o atendimento (a conta) em andamento num ponto.
--   4. open_service_session(): RPC que abre um atendimento.
--   5. company_user_has_activity(): passa a enxergar os atendimentos abertos por um
--      funcionário (quem já abriu atendimento não é excluído; só desativado).
--
-- Multiempresa: toda linha tem company_id e toda leitura passa por
-- user_company_ids(), que só devolve vínculos ATIVOS (funcionário inativo não vê
-- nada). Os vínculos entre as tabelas são compostos (company_id, id), então nem
-- uma escrita fora das policies (service_role, SQL direto) consegue ligar um
-- atendimento a um ponto de outra empresa.
--
-- Quem pode o quê:
--   ler pontos, atendimentos e o modo   owner, admin, cashier, attendant (ativos)
--   cadastrar/editar/desativar pontos   owner e admin (policies)
--   mudar o modo de atendimento         owner e admin (policy)
--   abrir atendimento (RPC)             owner, admin, cashier, attendant (ativos)
--   escrever direto em atendimentos     ninguém pelo cliente: só a RPC
-- cashier e attendant NUNCA cadastram estrutura.
--
-- Comanda/mesa (service_points):
--   * code: identificador único na empresa (ex.: CMD001, MESA12). Guardado em
--     MAIÚSCULAS e sem espaços nas pontas pelo próprio banco (cmd001 = CMD001);
--     formato [A-Z0-9][A-Z0-9_-] até 32 caracteres.
--   * display_name: o texto que a pessoa vê (ex.: "Comanda 001", "Mesa 12"). O id
--     interno nunca é o número visível.
--   * barcode: opcional, para comanda ou mesa; único na empresa quando preenchido
--     (vários pontos sem barcode convivem). O índice serve à busca futura do Caixa
--     por (company_id, barcode). Espaços nas pontas caem; vazio vira NULL.
--   * type, code e company_id não mudam depois de criados (para corrigir, desativa
--     e cadastra outro). Editáveis: display_name, barcode e is_active.
--   * Não se apaga (nenhuma policy de DELETE): desativa-se. Não dá para desativar
--     um ponto que tem atendimento aberto.
--   * O tipo do ponto não é limitado pelo modo na hora de cadastrar (é
--     configuração); o modo vale na hora de ABRIR atendimento.
--
-- Atendimento (service_sessions):
--   * status open | closed; closed_at só existe quando closed.
--   * UM ponto nunca tem dois atendimentos open ao mesmo tempo (índice único
--     parcial); fechado o anterior, abre-se outro.
--   * opened_by = auth.users(id) do funcionário que abriu, com RESTRICT: o
--     histórico não some com a exclusão do usuário do Auth. Por isso
--     company_user_has_activity() devolve true para quem já abriu atendimento.
--   * Nesta etapa NÃO há fechamento nem financeiro: closed existe só como estado.

-- ---------------------------------------------------------------------------
-- 1) Configuração operacional da empresa
-- ---------------------------------------------------------------------------
create table public.company_operational_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  service_mode text not null default 'command'
    constraint company_operational_settings_service_mode_check
    check (service_mode in ('command', 'table', 'both')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger company_operational_settings_set_updated_at
  before update on public.company_operational_settings
  for each row execute function public.set_updated_at();

-- Empresas que já existem ganham a configuração padrão.
insert into public.company_operational_settings (company_id)
select id from public.companies
on conflict (company_id) do nothing;

-- Empresa nova nasce com a configuração padrão (create_company, RPCs do Master...).
create function public.create_company_operational_settings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.company_operational_settings (company_id)
  values (new.id)
  on conflict (company_id) do nothing;
  return new;
end;
$$;

create trigger companies_create_operational_settings
  after insert on public.companies
  for each row execute function public.create_company_operational_settings();

revoke execute on function public.create_company_operational_settings() from public, anon, authenticated;

alter table public.company_operational_settings enable row level security;

create policy company_operational_settings_select on public.company_operational_settings
  for select to authenticated
  using (company_id in (select public.user_company_ids()));

create policy company_operational_settings_update on public.company_operational_settings
  for update to authenticated
  using (public.user_role_in_company(company_id) in ('owner', 'admin'))
  with check (public.user_role_in_company(company_id) in ('owner', 'admin'));

revoke all on public.company_operational_settings from anon, authenticated;
grant select on public.company_operational_settings to authenticated;
grant update (service_mode) on public.company_operational_settings to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Pontos de atendimento: comanda e mesa
-- ---------------------------------------------------------------------------
create table public.service_points (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  type text not null
    constraint service_points_type_check check (type in ('command', 'table')),
  code text not null
    constraint service_points_code_format check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  display_name text not null
    constraint service_points_display_name_length check (char_length(display_name) between 1 and 60),
  barcode text
    constraint service_points_barcode_format check (barcode is null or barcode ~ '^[^[:space:]]{1,64}$'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint service_points_company_code_key unique (company_id, code),
  -- alvo da chave composta de service_sessions
  constraint service_points_company_id_id_key unique (company_id, id)
);

-- Barcode único na empresa, só quando preenchido. Também é o índice da busca do Caixa.
create unique index service_points_company_barcode_key
  on public.service_points (company_id, barcode)
  where barcode is not null;

comment on column public.service_points.code is
  'Identificador único na empresa, em maiúsculas (ex.: CMD001, MESA12). Não muda depois de criado.';
comment on column public.service_points.barcode is
  'Código de barras próprio da comanda (ou mesa), opcional. Único na empresa quando preenchido.';

-- Normaliza a entrada (code em maiúsculas, textos sem espaços nas pontas, barcode vazio
-- = NULL), trava o que não muda e recusa desativar ponto com atendimento aberto. Roda
-- ANTES das constraints, que enxergam o valor já normalizado.
create function public.prepare_service_point()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.code := upper(btrim(new.code));
  new.display_name := btrim(new.display_name);
  new.barcode := nullif(btrim(new.barcode), '');

  if tg_op = 'UPDATE' then
    if new.company_id is distinct from old.company_id
       or new.type is distinct from old.type
       or new.code is distinct from old.code then
      raise exception 'Empresa, tipo e código de uma comanda ou mesa não podem ser alterados. Desative-a e cadastre outra.'
        using errcode = 'PT409';
    end if;

    if old.is_active and not new.is_active and exists (
      select 1 from public.service_sessions ss
      where ss.service_point_id = new.id and ss.status = 'open'
    ) then
      raise exception 'Há um atendimento aberto neste ponto. Feche-o antes de desativar.'
        using errcode = 'PT409';
    end if;
  end if;

  return new;
end;
$$;

create trigger service_points_prepare
  before insert or update on public.service_points
  for each row execute function public.prepare_service_point();

create trigger service_points_set_updated_at
  before update on public.service_points
  for each row execute function public.set_updated_at();

revoke execute on function public.prepare_service_point() from public, anon, authenticated;

alter table public.service_points enable row level security;

-- Ler: qualquer vínculo ATIVO da empresa (inativo cai fora por user_company_ids()).
create policy service_points_select on public.service_points
  for select to authenticated
  using (company_id in (select public.user_company_ids()));

-- Cadastrar e editar (o que inclui desativar): só owner e admin. Sem DELETE.
create policy service_points_insert on public.service_points
  for insert to authenticated
  with check (public.user_role_in_company(company_id) in ('owner', 'admin'));

create policy service_points_update on public.service_points
  for update to authenticated
  using (public.user_role_in_company(company_id) in ('owner', 'admin'))
  with check (public.user_role_in_company(company_id) in ('owner', 'admin'));

-- Colunas liberadas: id, is_active e timestamps ficam por conta dos defaults; type, code
-- e company_id só entram na criação.
revoke all on public.service_points from anon, authenticated;
grant select on public.service_points to authenticated;
grant insert (company_id, type, code, display_name, barcode) on public.service_points to authenticated;
grant update (display_name, barcode, is_active) on public.service_points to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Atendimentos (a conta em andamento num ponto)
-- ---------------------------------------------------------------------------
create table public.service_sessions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  service_point_id uuid not null,
  customer_name text
    constraint service_sessions_customer_name_length
    check (customer_name is null or char_length(customer_name) between 1 and 80),
  status text not null default 'open'
    constraint service_sessions_status_check check (status in ('open', 'closed')),
  -- Quem abriu. RESTRICT: o histórico não some com a exclusão do usuário do Auth.
  opened_by uuid not null references auth.users(id) on delete restrict,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  constraint service_sessions_closed_consistency check (
    (status = 'open' and closed_at is null) or (status = 'closed' and closed_at is not null)
  ),
  -- O ponto tem de ser da MESMA empresa. NO ACTION (o padrão), e não RESTRICT, para
  -- que excluir uma empresa continue possível: a checagem roda no fim do comando,
  -- depois que a cascata levou pontos e atendimentos juntos.
  constraint service_sessions_point_fkey
    foreign key (company_id, service_point_id)
    references public.service_points (company_id, id)
);

-- Um ponto nunca tem dois atendimentos abertos ao mesmo tempo.
create unique index service_sessions_one_open_per_point
  on public.service_sessions (service_point_id)
  where status = 'open';

create index service_sessions_company_open_idx
  on public.service_sessions (company_id)
  where status = 'open';

create index service_sessions_opened_by_idx on public.service_sessions (opened_by);

comment on column public.service_sessions.opened_by is
  'auth.users.id do funcionário que abriu o atendimento. RESTRICT: quem já abriu não é excluído, só desativado.';

-- Quem abriu, quando e em qual empresa nunca mudam (o ponto pode mudar no futuro, ex.:
-- troca de mesa).
create function public.guard_service_session_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is distinct from old.company_id
     or new.opened_by is distinct from old.opened_by
     or new.opened_at is distinct from old.opened_at then
    raise exception 'Empresa, funcionário e horário de abertura de um atendimento não podem ser alterados.'
      using errcode = 'PT409';
  end if;
  return new;
end;
$$;

create trigger service_sessions_guard_change
  before update on public.service_sessions
  for each row execute function public.guard_service_session_change();

revoke execute on function public.guard_service_session_change() from public, anon, authenticated;

alter table public.service_sessions enable row level security;

create policy service_sessions_select on public.service_sessions
  for select to authenticated
  using (company_id in (select public.user_company_ids()));

-- Nenhuma policy nem grant de escrita: só a RPC abaixo abre atendimento.
revoke all on public.service_sessions from anon, authenticated;
grant select on public.service_sessions to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Abrir atendimento
-- ---------------------------------------------------------------------------
-- Quem não é membro ativo da empresa do ponto recebe a mesma resposta de um ponto que não
-- existe (nada vaza entre empresas). Respeita o modo de atendimento da empresa. Erros:
-- PT401 sem sessão, PT403 sem permissão, PT404 não encontrado, PT400 dado inválido,
-- PT409 conflito ou regra de negócio (o PostgREST devolve ### como status HTTP).
create function public.open_service_session(
  p_service_point_id uuid,
  p_customer_name text default null
)
returns public.service_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_point public.service_points;
  v_role public.company_role;
  v_mode text;
  v_customer text := nullif(btrim(coalesce(p_customer_name, '')), '');
  v_session public.service_sessions;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_point from public.service_points where id = p_service_point_id;
  if not found then
    raise exception 'Comanda ou mesa não encontrada.' using errcode = 'PT404';
  end if;

  v_role := public.user_role_in_company(v_point.company_id);
  if v_role is null then
    raise exception 'Comanda ou mesa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier', 'attendant') then
    raise exception 'Você não tem permissão para abrir atendimentos.' using errcode = 'PT403';
  end if;

  if not v_point.is_active then
    raise exception 'Esta comanda ou mesa está desativada.' using errcode = 'PT409';
  end if;

  select s.service_mode into v_mode
  from public.company_operational_settings s
  where s.company_id = v_point.company_id;
  v_mode := coalesce(v_mode, 'command');

  if v_point.type = 'command' and v_mode = 'table' then
    raise exception 'Esta empresa não trabalha com comandas.' using errcode = 'PT409';
  end if;
  if v_point.type = 'table' and v_mode = 'command' then
    raise exception 'Esta empresa não trabalha com mesas.' using errcode = 'PT409';
  end if;

  if v_customer is not null and char_length(v_customer) > 80 then
    raise exception 'O nome do cliente pode ter no máximo 80 caracteres.' using errcode = 'PT400';
  end if;

  begin
    insert into public.service_sessions (company_id, service_point_id, customer_name, status, opened_by)
    values (v_point.company_id, v_point.id, v_customer, 'open', auth.uid())
    returning * into v_session;
  exception
    when unique_violation then
      raise exception 'Este atendimento já está aberto.' using errcode = 'PT409';
  end;

  return v_session;
end;
$$;

revoke execute on function public.open_service_session(uuid, text) from public, anon;
grant execute on function public.open_service_session(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) Quem já abriu atendimento não é excluído (só desativado)
-- ---------------------------------------------------------------------------
-- Mesma assinatura e mesmo ACL da 080000 (CREATE OR REPLACE): agora com a primeira
-- checagem real. As próximas tabelas operacionais somam a delas aqui.
create or replace function public.company_user_has_activity(p_company_id uuid, p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.service_sessions ss
    where ss.company_id = p_company_id and ss.opened_by = p_user_id
  ) then
    return true;
  end if;

  -- FUTURO: pedidos, caixa, pagamentos... (cada tabela operacional acrescenta a sua
  -- checagem AQUI e guarda a referência histórica do funcionário, sem apagar em cascata).
  return false;
end;
$$;

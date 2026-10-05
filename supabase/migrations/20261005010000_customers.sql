-- CADASTRO DE CLIENTES (Cadastros → Clientes) + vínculo opcional com atendimentos e contas a receber.
--
-- Cliente pertence à EMPRESA (company_id) e nunca é apagado pela aplicação: só ativado/inativado. Cliente
-- inativo não aparece na busca de novos atendimentos/contas, mas o histórico continua apontando para ele.
--
-- Estrutura:
--   customers                 cadastro (pessoa física ou empresa): nome, documento (só dígitos), telefone,
--                             WhatsApp, e-mail, nascimento, observações, ativo.
--   service_sessions.customer_id        NULLABLE: atendimento pode apontar para um cliente cadastrado. O
--   accounts_receivable.customer_id     NULLABLE: customer_name continua gravado como SNAPSHOT (o nome usado
--                                       na época); renomear o cliente depois não altera o histórico.
--
-- Escrita SOMENTE por RPC (SECURITY DEFINER). Leitura direta (RLS): owner/admin da empresa.
--   owner/admin ........ create_customer, update_customer, set_customer_active, list_customers,
--                        customers_summary, get_customer
--   owner/admin/cashier/attendant ... search_active_customers (id, nome e só os 4 últimos dígitos do
--                        telefone; sem documento, e-mail, observações), quick_create_customer (nome + telefone)
--   production ......... nenhum acesso
-- Erros: PT401 sem sessão, PT404 não encontrado/outra empresa, PT403 sem permissão, PT400 dados inválidos,
-- PT409 conflito (documento duplicado) ou estado que não permite a ação.
--
-- Fora desta migration (de propósito): Realtime, CRM, fidelidade, importação, endereço.

-- ---------------------------------------------------------------------------
-- 1) Tabela
-- ---------------------------------------------------------------------------
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  customer_type text not null default 'person'
    constraint customers_type_check check (customer_type in ('person', 'company')),
  -- 80 = mesmo limite do snapshot em service_sessions.customer_name (o nome cabe inteiro no atendimento).
  name text not null
    constraint customers_name_length check (char_length(name) between 1 and 80),
  -- CPF (11) ou CNPJ (14), SOMENTE dígitos. Opcional.
  document text
    constraint customers_document_check check (document is null or document ~ '^[0-9]{11}$' or document ~ '^[0-9]{14}$'),
  phone text
    constraint customers_phone_check check (phone is null or phone ~ '^[0-9]{8,13}$'),
  whatsapp text
    constraint customers_whatsapp_check check (whatsapp is null or whatsapp ~ '^[0-9]{8,13}$'),
  email text
    constraint customers_email_check check (email is null or (char_length(email) <= 254 and email = lower(email) and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  birth_date date
    constraint customers_birth_check check (birth_date is null or birth_date >= date '1900-01-01'),
  notes text
    constraint customers_notes_length check (notes is null or char_length(notes) between 1 and 1000),
  is_active boolean not null default true,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- alvo das chaves compostas de service_sessions e accounts_receivable (cliente da MESMA empresa)
  constraint customers_company_id_id_key unique (company_id, id)
);

comment on table public.customers is
  'Clientes da empresa. Nunca apagados pela aplicação (is_active). Documento/telefone/WhatsApp só dígitos; e-mail em minúsculas. Escrita só por RPC.';

create trigger customers_set_updated_at
  before update on public.customers
  for each row execute function public.set_updated_at();

-- Empresa, autor e criação não mudam nunca (a RPC também não os envia; isto protege mesmo contra superusuário distraído).
create function public.guard_customer_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is distinct from old.company_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Empresa e autoria de um cliente não podem ser alteradas.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_customer_change() from public, anon, authenticated;

create trigger customers_guard_change
  before update on public.customers
  for each row execute function public.guard_customer_change();

-- ---------------------------------------------------------------------------
-- 2) Índices (só os que as consultas usam)
-- ---------------------------------------------------------------------------
-- Documento único por empresa (só quando informado). Telefone/WhatsApp/e-mail/nome NÃO são únicos.
create unique index customers_company_document_key on public.customers (company_id, document) where document is not null;
-- Lista padrão: status + nome A-Z
create index customers_company_active_name_idx on public.customers (company_id, is_active, lower(name));
-- Cards "novos este mês" / ordenar por mais recentes
create index customers_company_created_idx on public.customers (company_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3) RLS e GRANTs: leitura só owner/admin; nenhuma escrita direta
-- ---------------------------------------------------------------------------
alter table public.customers enable row level security;

create policy customers_select on public.customers
  for select to authenticated
  using (public.user_role_in_company(company_id) in ('owner', 'admin'));

revoke all on public.customers from public, anon, authenticated;
grant select on public.customers to authenticated;
grant all on public.customers to service_role;

-- ---------------------------------------------------------------------------
-- 4) Vínculos opcionais (snapshot do nome é mantido)
-- ---------------------------------------------------------------------------
alter table public.service_sessions add column customer_id uuid;
alter table public.service_sessions
  add constraint service_sessions_customer_fkey
  foreign key (company_id, customer_id) references public.customers (company_id, id);
create index service_sessions_customer_idx on public.service_sessions (company_id, customer_id) where customer_id is not null;
comment on column public.service_sessions.customer_id is
  'Cliente cadastrado (opcional). customer_name continua sendo o snapshot do nome usado na abertura.';

alter table public.accounts_receivable add column customer_id uuid;
alter table public.accounts_receivable
  add constraint accounts_receivable_customer_fkey
  foreign key (company_id, customer_id) references public.customers (company_id, id);
create index accounts_receivable_customer_idx on public.accounts_receivable (company_id, customer_id) where customer_id is not null;
comment on column public.accounts_receivable.customer_id is
  'Cliente cadastrado (opcional). customer_name continua sendo o snapshot do nome informado.';

-- O vínculo do atendimento é definido na abertura e não muda (mesma lógica de empresa/abertura).
create or replace function public.guard_service_session_change()
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
  if new.customer_id is distinct from old.customer_id then
    raise exception 'O cliente de um atendimento não pode ser alterado.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Helpers internos (sem EXECUTE para o cliente da API)
-- ---------------------------------------------------------------------------
create function public.customers_assert_manager(p_company_id uuid)
returns public.company_role
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Você não tem permissão para gerenciar clientes.' using errcode = 'PT403';
  end if;
  return v_role;
end;
$$;

-- owner/admin/cashier/attendant (production fica de fora).
create function public.customers_assert_reader(p_company_id uuid)
returns public.company_role
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin', 'cashier', 'attendant') then
    raise exception 'Você não tem permissão para buscar clientes.' using errcode = 'PT403';
  end if;
  return v_role;
end;
$$;

-- CPF (11) ou CNPJ (14), só dígitos, com dígitos verificadores.
create function public.customers_valid_document(p_digits text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  v_sum integer;
  v_i integer;
  v_d integer;
  v_w1 integer[] := array[5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  v_w2 integer[] := array[6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
begin
  if p_digits is null then return false; end if;
  if p_digits ~ '^(\d)\1+$' then return false; end if; -- 000.000.000-00, 111..., etc.

  if p_digits ~ '^[0-9]{11}$' then
    v_sum := 0;
    for v_i in 1..9 loop v_sum := v_sum + substr(p_digits, v_i, 1)::integer * (11 - v_i); end loop;
    v_d := (v_sum * 10) % 11; if v_d = 10 then v_d := 0; end if;
    if v_d <> substr(p_digits, 10, 1)::integer then return false; end if;
    v_sum := 0;
    for v_i in 1..10 loop v_sum := v_sum + substr(p_digits, v_i, 1)::integer * (12 - v_i); end loop;
    v_d := (v_sum * 10) % 11; if v_d = 10 then v_d := 0; end if;
    return v_d = substr(p_digits, 11, 1)::integer;
  elsif p_digits ~ '^[0-9]{14}$' then
    v_sum := 0;
    for v_i in 1..12 loop v_sum := v_sum + substr(p_digits, v_i, 1)::integer * v_w1[v_i]; end loop;
    v_d := v_sum % 11; v_d := case when v_d < 2 then 0 else 11 - v_d end;
    if v_d <> substr(p_digits, 13, 1)::integer then return false; end if;
    v_sum := 0;
    for v_i in 1..13 loop v_sum := v_sum + substr(p_digits, v_i, 1)::integer * v_w2[v_i]; end loop;
    v_d := v_sum % 11; v_d := case when v_d < 2 then 0 else 11 - v_d end;
    return v_d = substr(p_digits, 14, 1)::integer;
  end if;
  return false;
end;
$$;

-- Normaliza e valida os campos do cadastro; devolve jsonb com os valores limpos (null = vazio).
create function public.customers_clean(
  p_name text,
  p_type text,
  p_document text,
  p_phone text,
  p_whatsapp text,
  p_email text,
  p_birth_date date,
  p_notes text
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_name text := nullif(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), '');
  v_type text := coalesce(nullif(btrim(coalesce(p_type, '')), ''), 'person');
  v_doc text := nullif(regexp_replace(coalesce(p_document, ''), '\D', '', 'g'), '');
  v_phone text := nullif(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), '');
  v_wa text := nullif(regexp_replace(coalesce(p_whatsapp, ''), '\D', '', 'g'), '');
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
begin
  if v_name is null then raise exception 'Informe o nome do cliente.' using errcode = 'PT400'; end if;
  if char_length(v_name) > 80 then raise exception 'O nome pode ter no máximo 80 caracteres.' using errcode = 'PT400'; end if;
  if v_type not in ('person', 'company') then raise exception 'Tipo de cliente inválido.' using errcode = 'PT400'; end if;
  if v_doc is not null and not public.customers_valid_document(v_doc) then
    raise exception 'CPF/CNPJ inválido. Confira os números.' using errcode = 'PT400';
  end if;
  if v_phone is not null and char_length(v_phone) not between 8 and 13 then
    raise exception 'Telefone inválido. Informe o DDD e o número.' using errcode = 'PT400';
  end if;
  if v_wa is not null and char_length(v_wa) not between 8 and 13 then
    raise exception 'WhatsApp inválido. Informe o DDD e o número.' using errcode = 'PT400';
  end if;
  if v_email is not null and (char_length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    raise exception 'E-mail inválido.' using errcode = 'PT400';
  end if;
  if p_birth_date is not null and (p_birth_date < date '1900-01-01' or p_birth_date > (now() at time zone 'America/Sao_Paulo')::date) then
    raise exception 'Data de nascimento inválida.' using errcode = 'PT400';
  end if;
  if v_notes is not null and char_length(v_notes) > 1000 then
    raise exception 'As observações podem ter no máximo 1000 caracteres.' using errcode = 'PT400';
  end if;

  return jsonb_build_object(
    'name', v_name, 'customer_type', v_type, 'document', v_doc, 'phone', v_phone,
    'whatsapp', v_wa, 'email', v_email, 'birth_date', p_birth_date, 'notes', v_notes
  );
end;
$$;

revoke execute on function public.customers_assert_manager(uuid) from public, anon, authenticated;
revoke execute on function public.customers_assert_reader(uuid) from public, anon, authenticated;
revoke execute on function public.customers_valid_document(text) from public, anon, authenticated;
revoke execute on function public.customers_clean(text, text, text, text, text, text, date, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6) RPCs de escrita
-- ---------------------------------------------------------------------------
create function public.create_customer(
  p_company_id uuid,
  p_name text,
  p_customer_type text default 'person',
  p_document text default null,
  p_phone text default null,
  p_whatsapp text default null,
  p_email text default null,
  p_birth_date date default null,
  p_notes text default null
)
returns public.customers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c jsonb;
  v_row public.customers;
begin
  perform public.customers_assert_manager(p_company_id);
  v_c := public.customers_clean(p_name, p_customer_type, p_document, p_phone, p_whatsapp, p_email, p_birth_date, p_notes);

  begin
    insert into public.customers (company_id, customer_type, name, document, phone, whatsapp, email, birth_date, notes, created_by)
    values (p_company_id, v_c->>'customer_type', v_c->>'name', v_c->>'document', v_c->>'phone', v_c->>'whatsapp',
            v_c->>'email', (v_c->>'birth_date')::date, v_c->>'notes', auth.uid())
    returning * into v_row;
  exception
    when unique_violation then
      raise exception 'Já existe um cliente com este CPF/CNPJ.' using errcode = 'PT409';
  end;

  return v_row;
end;
$$;

create function public.update_customer(
  p_customer_id uuid,
  p_name text,
  p_customer_type text default 'person',
  p_document text default null,
  p_phone text default null,
  p_whatsapp text default null,
  p_email text default null,
  p_birth_date date default null,
  p_notes text default null
)
returns public.customers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.customers;
  v_c jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_row from public.customers where id = p_customer_id for update;
  if not found then
    raise exception 'Cliente não encontrado.' using errcode = 'PT404';
  end if;
  perform public.customers_assert_manager(v_row.company_id);
  v_c := public.customers_clean(p_name, p_customer_type, p_document, p_phone, p_whatsapp, p_email, p_birth_date, p_notes);

  begin
    update public.customers
       set customer_type = v_c->>'customer_type', name = v_c->>'name', document = v_c->>'document',
           phone = v_c->>'phone', whatsapp = v_c->>'whatsapp', email = v_c->>'email',
           birth_date = (v_c->>'birth_date')::date, notes = v_c->>'notes'
     where id = v_row.id
     returning * into v_row;
  exception
    when unique_violation then
      raise exception 'Já existe um cliente com este CPF/CNPJ.' using errcode = 'PT409';
  end;

  return v_row;
end;
$$;

-- Ativa/inativa (idempotente). Nunca apaga.
create function public.set_customer_active(p_customer_id uuid, p_active boolean)
returns public.customers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.customers;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if p_active is null then
    raise exception 'Informe se o cliente fica ativo ou inativo.' using errcode = 'PT400';
  end if;
  select * into v_row from public.customers where id = p_customer_id for update;
  if not found then
    raise exception 'Cliente não encontrado.' using errcode = 'PT404';
  end if;
  perform public.customers_assert_manager(v_row.company_id);

  if v_row.is_active is distinct from p_active then
    update public.customers set is_active = p_active where id = v_row.id returning * into v_row;
  end if;
  return v_row;
end;
$$;

-- Cadastro rápido no atendimento: só nome (+ telefone opcional). Qualquer papel operacional, só para a própria empresa.
create function public.quick_create_customer(p_company_id uuid, p_name text, p_phone text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c jsonb;
  v_row public.customers;
begin
  perform public.customers_assert_reader(p_company_id);
  v_c := public.customers_clean(p_name, 'person', null, p_phone, null, null, null, null);

  insert into public.customers (company_id, customer_type, name, phone, created_by)
  values (p_company_id, 'person', v_c->>'name', v_c->>'phone', auth.uid())
  returning * into v_row;

  return jsonb_build_object('id', v_row.id, 'name', v_row.name, 'phone_last4', right(v_row.phone, 4));
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) Leitura
-- ---------------------------------------------------------------------------
-- Busca para novos atendimentos/contas: SÓ ativos da empresa, no máximo 20, mínimo 2 caracteres.
-- Devolve apenas id, nome e os 4 últimos dígitos do telefone (para distinguir homônimos).
create function public.search_active_customers(p_company_id uuid, p_search text, p_limit integer default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_term text := nullif(btrim(coalesce(p_search, '')), '');
  v_pattern text;
  v_digits text;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 20);
  v_rows jsonb;
begin
  perform public.customers_assert_reader(p_company_id);

  if v_term is null or char_length(v_term) < 2 then
    return '[]'::jsonb;
  end if;
  v_pattern := '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_digits := nullif(regexp_replace(v_term, '\D', '', 'g'), '');
  if v_digits is not null and char_length(v_digits) < 3 then v_digits := null; end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'phone_last4', right(coalesce(t.whatsapp, t.phone), 4)) order by t.lname, t.id), '[]'::jsonb)
    into v_rows
  from (
    select c.id, c.name, c.phone, c.whatsapp, lower(c.name) as lname
    from public.customers c
    where c.company_id = p_company_id
      and c.is_active
      and (c.name ilike v_pattern
           or (v_digits is not null and (c.phone like '%' || v_digits || '%' or c.whatsapp like '%' || v_digits || '%')))
    order by lower(c.name), c.id
    limit v_limit
  ) t;

  return v_rows;
end;
$$;

-- Lista (owner/admin). p_status: all | active | inactive. p_type: all | person | company.
-- p_sort: name | recent | last_visit | spent. Estatísticas vêm de UMA agregação dos atendimentos vinculados da empresa.
create function public.list_customers(
  p_company_id uuid,
  p_status text default 'all',
  p_type text default 'all',
  p_search text default null,
  p_sort text default 'name',
  p_limit integer default 30,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_term text := nullif(btrim(coalesce(p_search, '')), '');
  v_pattern text;
  v_digits text;
  v_limit integer := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total bigint;
  v_rows jsonb;
begin
  perform public.customers_assert_manager(p_company_id);

  if p_status is null or p_status not in ('all', 'active', 'inactive') then
    raise exception 'Filtro de status inválido.' using errcode = 'PT400';
  end if;
  if p_type is null or p_type not in ('all', 'person', 'company') then
    raise exception 'Filtro de tipo inválido.' using errcode = 'PT400';
  end if;
  if p_sort is null or p_sort not in ('name', 'recent', 'last_visit', 'spent') then
    raise exception 'Ordenação inválida.' using errcode = 'PT400';
  end if;

  if v_term is not null then
    v_pattern := '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    v_digits := nullif(regexp_replace(v_term, '\D', '', 'g'), '');
  end if;

  with st as (
    select s.customer_id,
           count(*) as visits,
           max(s.opened_at) as last_visit,
           coalesce(sum(s.total_amount) filter (where s.status = 'closed'), 0)::numeric(12, 2) as spent
    from public.service_sessions s
    where s.company_id = p_company_id and s.customer_id is not null
    group by s.customer_id
  ),
  f as (
    select
      c.*,
      st.visits, st.last_visit, st.spent,
      count(*) over () as total_count,
      row_number() over (
        order by
          case when p_sort = 'recent' then c.created_at end desc nulls last,
          case when p_sort = 'last_visit' then st.last_visit end desc nulls last,
          case when p_sort = 'spent' then coalesce(st.spent, 0) end desc nulls last,
          lower(c.name), c.id
      ) as ord
    from public.customers c
    left join st on st.customer_id = c.id
    where c.company_id = p_company_id
      and (p_status = 'all' or (p_status = 'active' and c.is_active) or (p_status = 'inactive' and not c.is_active))
      and (p_type = 'all' or c.customer_type = p_type)
      and (v_pattern is null
           or c.name ilike v_pattern
           or coalesce(c.email, '') ilike v_pattern
           or (v_digits is not null and (
                 coalesce(c.document, '') like '%' || v_digits || '%'
              or coalesce(c.phone, '') like '%' || v_digits || '%'
              or coalesce(c.whatsapp, '') like '%' || v_digits || '%')))
  )
  select
    coalesce(max(f.total_count), 0),
    coalesce(jsonb_agg(
      jsonb_build_object(
        'id', f.id,
        'customer_type', f.customer_type,
        'name', f.name,
        'document', f.document,
        'phone', f.phone,
        'whatsapp', f.whatsapp,
        'email', f.email,
        'is_active', f.is_active,
        'created_at', f.created_at,
        'visits', coalesce(f.visits, 0),
        'last_visit_at', f.last_visit,
        'total_spent', coalesce(f.spent, 0)
      ) order by f.ord
    ) filter (where f.ord > v_offset and f.ord <= v_offset + v_limit), '[]'::jsonb)
    into v_total, v_rows
  from f;

  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$$;

-- Cards do topo: ativos, inativos, novos este mês (America/Sao_Paulo) e com atendimento nos últimos 30 dias.
create function public.customers_summary(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_month_start timestamptz := date_trunc('month', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo';
  v_active bigint;
  v_inactive bigint;
  v_new bigint;
  v_recent bigint;
begin
  perform public.customers_assert_manager(p_company_id);

  select count(*) filter (where is_active), count(*) filter (where not is_active), count(*) filter (where created_at >= v_month_start)
    into v_active, v_inactive, v_new
  from public.customers where company_id = p_company_id;

  select count(distinct s.customer_id) into v_recent
  from public.service_sessions s
  where s.company_id = p_company_id and s.customer_id is not null and s.opened_at >= now() - interval '30 days';

  return jsonb_build_object('active', v_active, 'inactive', v_inactive, 'new_this_month', v_new, 'recent_visits', v_recent);
end;
$$;

-- Detalhe: cadastro completo + resumo (atendimentos, última visita, total gasto, ticket médio, saldo a receber).
create function public.get_customer(p_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_c public.customers;
  v_visits bigint;
  v_last timestamptz;
  v_closed bigint;
  v_spent numeric(12, 2);
  v_open_balance numeric(12, 2);
  v_open_count bigint;
  v_creator text;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_c from public.customers where id = p_customer_id;
  if not found then
    raise exception 'Cliente não encontrado.' using errcode = 'PT404';
  end if;
  perform public.customers_assert_manager(v_c.company_id);

  select count(*), max(opened_at), count(*) filter (where status = 'closed'),
         coalesce(sum(total_amount) filter (where status = 'closed'), 0)::numeric(12, 2)
    into v_visits, v_last, v_closed, v_spent
  from public.service_sessions where company_id = v_c.company_id and customer_id = v_c.id;

  select coalesce(sum(amount - paid_amount), 0)::numeric(12, 2), count(*)
    into v_open_balance, v_open_count
  from public.accounts_receivable where company_id = v_c.company_id and customer_id = v_c.id and status = 'pending';

  select full_name into v_creator from public.profiles where user_id = v_c.created_by;

  return jsonb_build_object(
    'id', v_c.id, 'customer_type', v_c.customer_type, 'name', v_c.name, 'document', v_c.document,
    'phone', v_c.phone, 'whatsapp', v_c.whatsapp, 'email', v_c.email, 'birth_date', v_c.birth_date,
    'notes', v_c.notes, 'is_active', v_c.is_active, 'created_at', v_c.created_at, 'updated_at', v_c.updated_at,
    'created_by_name', v_creator,
    'visits', v_visits, 'last_visit_at', v_last, 'closed_visits', v_closed, 'total_spent', v_spent,
    'average_ticket', case when v_closed > 0 then round(v_spent / v_closed, 2) else 0 end,
    'open_receivable_balance', v_open_balance, 'open_receivable_count', v_open_count
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 8) Atendimento: abrir com cliente cadastrado (opcional). Substitui a assinatura (uuid, text).
-- ---------------------------------------------------------------------------
drop function public.open_service_session(uuid, text);

create function public.open_service_session(
  p_service_point_id uuid,
  p_customer_name text default null,
  p_customer_id uuid default null
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
  v_cust public.customers;
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

  -- Cliente cadastrado: tem de ser da MESMA empresa e estar ativo; o nome do cadastro vira o snapshot.
  if p_customer_id is not null then
    select * into v_cust from public.customers where id = p_customer_id and company_id = v_point.company_id;
    if not found then
      raise exception 'Cliente não encontrado.' using errcode = 'PT404';
    end if;
    if not v_cust.is_active then
      raise exception 'Este cliente está inativo.' using errcode = 'PT409';
    end if;
    v_customer := v_cust.name;
  end if;

  if v_customer is not null and char_length(v_customer) > 80 then
    raise exception 'O nome do cliente pode ter no máximo 80 caracteres.' using errcode = 'PT400';
  end if;

  begin
    insert into public.service_sessions (company_id, service_point_id, customer_name, customer_id, status, opened_by)
    values (v_point.company_id, v_point.id, v_customer, p_customer_id, 'open', auth.uid())
    returning * into v_session;
  exception
    when unique_violation then
      raise exception 'Este atendimento já está aberto.' using errcode = 'PT409';
  end;

  return v_session;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9) Contas a receber: cliente cadastrado opcional (assinaturas ganham p_customer_id no FIM, com default)
-- ---------------------------------------------------------------------------
drop function public.create_receivable(uuid, text, text, numeric, date, text, text);
drop function public.update_receivable(uuid, text, text, numeric, date, text, text);

create function public.create_receivable(
  p_company_id uuid,
  p_customer_name text,
  p_description text,
  p_amount numeric,
  p_due_date date,
  p_reference text default null,
  p_notes text default null,
  p_customer_id uuid default null
)
returns public.accounts_receivable
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer text := nullif(btrim(coalesce(p_customer_name, '')), '');
  v_desc text := nullif(btrim(coalesce(p_description, '')), '');
  v_ref text := nullif(btrim(coalesce(p_reference, '')), '');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_cust public.customers;
  v_row public.accounts_receivable;
begin
  perform public.receivables_assert_manager(p_company_id);

  if p_customer_id is not null then
    select * into v_cust from public.customers where id = p_customer_id and company_id = p_company_id;
    if not found then raise exception 'Cliente não encontrado.' using errcode = 'PT404'; end if;
    if not v_cust.is_active then raise exception 'Este cliente está inativo.' using errcode = 'PT409'; end if;
    v_customer := v_cust.name;
  end if;

  if v_customer is null then raise exception 'Informe o cliente.' using errcode = 'PT400'; end if;
  if char_length(v_customer) > 120 then raise exception 'O nome do cliente pode ter no máximo 120 caracteres.' using errcode = 'PT400'; end if;
  if v_desc is null then raise exception 'Informe a descrição.' using errcode = 'PT400'; end if;
  if char_length(v_desc) > 200 then raise exception 'A descrição pode ter no máximo 200 caracteres.' using errcode = 'PT400'; end if;
  if v_ref is not null and char_length(v_ref) > 60 then raise exception 'A referência pode ter no máximo 60 caracteres.' using errcode = 'PT400'; end if;
  if v_notes is not null and char_length(v_notes) > 500 then raise exception 'A observação pode ter no máximo 500 caracteres.' using errcode = 'PT400'; end if;
  if p_amount is null or p_amount <= 0 or p_amount >= 10000000000 or p_amount <> round(p_amount, 2) then
    raise exception 'Informe um valor maior que zero, com até 2 casas decimais.' using errcode = 'PT400';
  end if;
  if p_due_date is null or p_due_date < date '2000-01-01' or p_due_date > date '2100-01-01' then
    raise exception 'Informe um vencimento válido.' using errcode = 'PT400';
  end if;

  insert into public.accounts_receivable (company_id, customer_id, customer_name, description, reference, notes, amount, due_date, created_by)
  values (p_company_id, p_customer_id, v_customer, v_desc, v_ref, v_notes, p_amount, p_due_date, auth.uid())
  returning * into v_row;

  insert into public.accounts_receivable_events (company_id, receivable_id, event_type, amount, created_by)
  values (p_company_id, v_row.id, 'created', p_amount, auth.uid());

  return v_row;
end;
$$;

-- p_customer_id nulo = sem cliente cadastrado (nome livre). Mesmo cliente de antes = mantém o snapshot do nome.
create function public.update_receivable(
  p_receivable_id uuid,
  p_customer_name text,
  p_description text,
  p_amount numeric,
  p_due_date date,
  p_reference text default null,
  p_notes text default null,
  p_customer_id uuid default null
)
returns public.accounts_receivable
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.accounts_receivable;
  v_customer text := nullif(btrim(coalesce(p_customer_name, '')), '');
  v_desc text := nullif(btrim(coalesce(p_description, '')), '');
  v_ref text := nullif(btrim(coalesce(p_reference, '')), '');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_cust public.customers;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_row from public.accounts_receivable where id = p_receivable_id for update;
  if not found then
    raise exception 'Conta não encontrada.' using errcode = 'PT404';
  end if;
  perform public.receivables_assert_manager(v_row.company_id);

  if v_row.status <> 'pending' then
    raise exception 'Só é possível editar uma conta pendente.' using errcode = 'PT409';
  end if;

  if p_customer_id is not null then
    select * into v_cust from public.customers where id = p_customer_id and company_id = v_row.company_id;
    if not found then raise exception 'Cliente não encontrado.' using errcode = 'PT404'; end if;
    if p_customer_id is not distinct from v_row.customer_id then
      v_customer := v_row.customer_name;
    else
      if not v_cust.is_active then raise exception 'Este cliente está inativo.' using errcode = 'PT409'; end if;
      v_customer := v_cust.name;
    end if;
  end if;

  if v_customer is null then raise exception 'Informe o cliente.' using errcode = 'PT400'; end if;
  if char_length(v_customer) > 120 then raise exception 'O nome do cliente pode ter no máximo 120 caracteres.' using errcode = 'PT400'; end if;
  if v_desc is null then raise exception 'Informe a descrição.' using errcode = 'PT400'; end if;
  if char_length(v_desc) > 200 then raise exception 'A descrição pode ter no máximo 200 caracteres.' using errcode = 'PT400'; end if;
  if v_ref is not null and char_length(v_ref) > 60 then raise exception 'A referência pode ter no máximo 60 caracteres.' using errcode = 'PT400'; end if;
  if v_notes is not null and char_length(v_notes) > 500 then raise exception 'A observação pode ter no máximo 500 caracteres.' using errcode = 'PT400'; end if;
  if p_amount is null or p_amount <= 0 or p_amount >= 10000000000 or p_amount <> round(p_amount, 2) then
    raise exception 'Informe um valor maior que zero, com até 2 casas decimais.' using errcode = 'PT400';
  end if;
  if p_amount <= v_row.paid_amount then
    raise exception 'O valor deve ser maior que o já recebido (R$ %).', to_char(v_row.paid_amount, 'FM999999990.00') using errcode = 'PT400';
  end if;
  if p_due_date is null or p_due_date < date '2000-01-01' or p_due_date > date '2100-01-01' then
    raise exception 'Informe um vencimento válido.' using errcode = 'PT400';
  end if;

  update public.accounts_receivable
     set customer_id = p_customer_id, customer_name = v_customer, description = v_desc, reference = v_ref, notes = v_notes,
         amount = p_amount, due_date = p_due_date
   where id = v_row.id
   returning * into v_row;

  insert into public.accounts_receivable_events (company_id, receivable_id, event_type, created_by)
  values (v_row.company_id, v_row.id, 'updated', auth.uid());

  return v_row;
end;
$$;

-- list_receivables passa a devolver customer_id (mesma assinatura; só uma linha a mais no JSON).
create or replace function public.list_receivables(
  p_company_id uuid,
  p_status text default 'all',
  p_date_field text default 'due',
  p_from date default null,
  p_to date default null,
  p_search text default null,
  p_sort text default 'due',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_today date := public.receivables_today();
  v_term text := nullif(btrim(coalesce(p_search, '')), '');
  v_pattern text;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total bigint;
  v_rows jsonb;
begin
  perform public.receivables_assert_manager(p_company_id);

  if p_status is null or p_status not in ('all', 'pending', 'due_today', 'overdue', 'paid', 'cancelled') then
    raise exception 'Filtro de status inválido.' using errcode = 'PT400';
  end if;
  if p_date_field is null or p_date_field not in ('due', 'paid') then
    raise exception 'Filtro de data inválido.' using errcode = 'PT400';
  end if;
  if p_sort is null or p_sort not in ('due', 'overdue', 'amount', 'recent') then
    raise exception 'Ordenação inválida.' using errcode = 'PT400';
  end if;
  if (p_from is not null and p_to is not null and p_from > p_to) then
    raise exception 'A data inicial não pode ser depois da final.' using errcode = 'PT400';
  end if;

  if v_term is not null then
    v_pattern := '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  with f as (
    select
      r.*,
      count(*) over () as total_count,
      row_number() over (
        order by
          case when p_sort = 'overdue' then case r.status when 'pending' then 0 when 'paid' then 1 else 2 end end asc nulls last,
          case when p_sort = 'amount' then r.amount end desc nulls last,
          case when p_sort = 'recent' then r.created_at end desc nulls last,
          r.due_date asc, r.created_at asc, r.id
      ) as ord
    from public.accounts_receivable r
    where r.company_id = p_company_id
      and (
        p_status = 'all'
        or (p_status = 'pending' and r.status = 'pending' and r.due_date >= v_today)
        or (p_status = 'due_today' and r.status = 'pending' and r.due_date = v_today)
        or (p_status = 'overdue' and r.status = 'pending' and r.due_date < v_today)
        or (p_status = 'paid' and r.status = 'paid')
        or (p_status = 'cancelled' and r.status = 'cancelled')
      )
      and (v_pattern is null
           or r.customer_name ilike v_pattern
           or r.description ilike v_pattern
           or coalesce(r.reference, '') ilike v_pattern)
      and (
        (p_from is null and p_to is null)
        or (p_date_field = 'due'
            and (p_from is null or r.due_date >= p_from)
            and (p_to is null or r.due_date <= p_to))
        or (p_date_field = 'paid'
            and exists (
              select 1 from public.accounts_receivable_events e
              where e.company_id = r.company_id and e.receivable_id = r.id and e.event_type = 'payment'
                and (p_from is null or e.paid_on >= p_from)
                and (p_to is null or e.paid_on <= p_to)))
      )
  )
  select
    coalesce(max(f.total_count), 0),
    coalesce(jsonb_agg(
      jsonb_build_object(
        'id', f.id,
        'customer_id', f.customer_id,
        'customer_name', f.customer_name,
        'description', f.description,
        'reference', f.reference,
        'notes', f.notes,
        'amount', f.amount,
        'paid_amount', f.paid_amount,
        'balance', f.amount - f.paid_amount,
        'due_date', f.due_date,
        'status', f.status,
        'display_status', case
          when f.status = 'pending' and f.due_date < v_today then 'overdue'
          when f.status = 'pending' and f.due_date = v_today then 'due_today'
          else f.status
        end,
        'payment_method', f.payment_method,
        'paid_at', f.paid_at,
        'cancelled_at', f.cancelled_at,
        'cancel_reason', f.cancel_reason,
        'created_at', f.created_at,
        'updated_at', f.updated_at,
        'created_by_name', pr.full_name
      ) order by f.ord
    ) filter (where f.ord > v_offset and f.ord <= v_offset + v_limit), '[]'::jsonb)
    into v_total, v_rows
  from f
  left join public.profiles pr on pr.user_id = f.created_by;

  return jsonb_build_object('total', v_total, 'today', v_today, 'rows', v_rows);
end;
$$;

-- Quem já cadastrou cliente não é excluído (só desativado).
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
    where ss.company_id = p_company_id and (ss.opened_by = p_user_id or ss.closed_by = p_user_id)
  ) then
    return true;
  end if;

  if exists (
    select 1 from public.service_orders so
    where so.company_id = p_company_id and so.created_by = p_user_id
  ) then
    return true;
  end if;

  if exists (
    select 1 from public.cash_sessions cs
    where cs.company_id = p_company_id and (cs.opened_by = p_user_id or cs.closed_by = p_user_id)
  ) then
    return true;
  end if;

  if exists (
    select 1 from public.service_payments sp
    where sp.company_id = p_company_id and sp.created_by = p_user_id
  ) then
    return true;
  end if;

  if exists (
    select 1 from public.cash_movements cm
    where cm.company_id = p_company_id and cm.created_by = p_user_id
  ) then
    return true;
  end if;

  if exists (
    select 1 from public.service_order_items soi
    where soi.company_id = p_company_id and soi.production_updated_by = p_user_id
  ) then
    return true;
  end if;

  if exists (
    select 1 from public.service_order_item_cancellations c
    where c.company_id = p_company_id and c.cancelled_by = p_user_id
  ) then
    return true;
  end if;

  if exists (
    select 1 from public.service_refunds r
    where r.company_id = p_company_id and r.created_by = p_user_id
  ) then
    return true;
  end if;

  if exists (
    select 1 from public.customers cu
    where cu.company_id = p_company_id and cu.created_by = p_user_id
  ) then
    return true;
  end if;

  return false;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10) ACL (só usuário logado; cada função valida o papel por dentro)
-- ---------------------------------------------------------------------------
revoke execute on function public.create_customer(uuid, text, text, text, text, text, text, date, text) from public, anon;
grant execute on function public.create_customer(uuid, text, text, text, text, text, text, date, text) to authenticated;
revoke execute on function public.update_customer(uuid, text, text, text, text, text, text, date, text) from public, anon;
grant execute on function public.update_customer(uuid, text, text, text, text, text, text, date, text) to authenticated;
revoke execute on function public.set_customer_active(uuid, boolean) from public, anon;
grant execute on function public.set_customer_active(uuid, boolean) to authenticated;
revoke execute on function public.quick_create_customer(uuid, text, text) from public, anon;
grant execute on function public.quick_create_customer(uuid, text, text) to authenticated;
revoke execute on function public.search_active_customers(uuid, text, integer) from public, anon;
grant execute on function public.search_active_customers(uuid, text, integer) to authenticated;
revoke execute on function public.list_customers(uuid, text, text, text, text, integer, integer) from public, anon;
grant execute on function public.list_customers(uuid, text, text, text, text, integer, integer) to authenticated;
revoke execute on function public.customers_summary(uuid) from public, anon;
grant execute on function public.customers_summary(uuid) to authenticated;
revoke execute on function public.get_customer(uuid) from public, anon;
grant execute on function public.get_customer(uuid) to authenticated;

revoke execute on function public.open_service_session(uuid, text, uuid) from public, anon;
grant execute on function public.open_service_session(uuid, text, uuid) to authenticated;
revoke execute on function public.create_receivable(uuid, text, text, numeric, date, text, text, uuid) from public, anon;
grant execute on function public.create_receivable(uuid, text, text, numeric, date, text, text, uuid) to authenticated;
revoke execute on function public.update_receivable(uuid, text, text, numeric, date, text, text, uuid) from public, anon;
grant execute on function public.update_receivable(uuid, text, text, numeric, date, text, text, uuid) to authenticated;

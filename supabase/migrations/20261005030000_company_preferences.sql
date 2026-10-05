-- CONFIGURAÇÕES → SISTEMA / PREFERÊNCIAS.
--
-- NÃO cria tabela nova: public.company_operational_settings (1:1 por empresa, criada por trigger em toda empresa
-- nova e já preenchida para as existentes — migration 020000) já é a configuração operacional da empresa e passa
-- a guardar também as preferências abaixo. Empresa existente herda os DEFAULTS (comportamento de hoje) sem seed.
--
--   default_service_point_type   ask | command | table   Filtro inicial do painel de Comandas/Mesas quando a
--                                                        empresa trabalha com os dois (modo 'both'). 'ask' =
--                                                        como hoje (mostra tudo). Nunca remove uma opção.
--   allow_quick_customer_create  boolean (true)           attendant/cashier podem usar o cadastro rápido de
--                                                        cliente no atendimento. owner/admin sempre podem.
--   show_customer_on_service_card boolean (true)          Mostra o cliente nas listagens operacionais (cards de
--                                                        comanda/mesa e Comandas/Mesas abertas). Não apaga nem
--                                                        esconde o customer_name do atendimento.
--   compact_operational_cards    boolean (true)           true = cards como hoje; false = cards mais espaçosos
--                                                        (só listagens operacionais).
--   updated_by                   quem salvou por último (updated_at já é automático).
--
-- Dados de contato da empresa (companies): ganha phone, whatsapp e email (nullable, só dígitos/minúsculas). Nome
-- e documento já existiam e continuam sendo os mesmos campos.
--
-- Escrita SOMENTE por RPC (SECURITY DEFINER): update_company_preferences. Leitura da tela: get_company_preferences
-- (owner/admin). As preferências operacionais continuam legíveis por todo vínculo ativo da empresa pela policy
-- de SELECT existente (os cards precisam delas); nada sensível mora ali.
-- Erros: PT401 sem sessão, PT404 empresa não encontrada/sem vínculo, PT403 sem permissão, PT400 dados inválidos.

-- ---------------------------------------------------------------------------
-- 1) Colunas
-- ---------------------------------------------------------------------------
alter table public.company_operational_settings
  add column default_service_point_type text not null default 'ask'
    constraint company_operational_settings_default_type_check check (default_service_point_type in ('ask', 'command', 'table')),
  add column allow_quick_customer_create boolean not null default true,
  add column show_customer_on_service_card boolean not null default true,
  add column compact_operational_cards boolean not null default true,
  add column updated_by uuid references auth.users(id) on delete set null;

alter table public.companies
  add column phone text
    constraint companies_phone_check check (phone is null or phone ~ '^[0-9]{8,13}$'),
  add column whatsapp text
    constraint companies_whatsapp_check check (whatsapp is null or whatsapp ~ '^[0-9]{8,13}$'),
  add column email text
    constraint companies_email_check check (email is null or (char_length(email) <= 254 and email = lower(email) and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'));

-- As colunas novas NÃO entram no GRANT UPDATE de authenticated (só name/document têm): escrita só pela RPC.

-- ---------------------------------------------------------------------------
-- 2) Leitura (tela Sistema / Preferências): owner/admin
-- ---------------------------------------------------------------------------
create function public.company_prefs_assert_manager(p_company_id uuid)
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
    raise exception 'Você não tem permissão para alterar as preferências do sistema.' using errcode = 'PT403';
  end if;
  return v_role;
end;
$$;

revoke execute on function public.company_prefs_assert_manager(uuid) from public, anon, authenticated;

create function public.get_company_preferences(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_c public.companies;
  v_s public.company_operational_settings;
  v_by text;
begin
  perform public.company_prefs_assert_manager(p_company_id);

  select * into v_c from public.companies where id = p_company_id;
  select * into v_s from public.company_operational_settings where company_id = p_company_id;
  if v_s.company_id is not null and v_s.updated_by is not null then
    select full_name into v_by from public.profiles where user_id = v_s.updated_by;
  end if;

  -- Empresa sem linha de configuração (não deveria existir): devolve os defaults, sem exigir seed.
  return jsonb_build_object(
    'company', jsonb_build_object(
      'name', v_c.name, 'slug', v_c.slug, 'document', v_c.document,
      'phone', v_c.phone, 'whatsapp', v_c.whatsapp, 'email', v_c.email
    ),
    'preferences', jsonb_build_object(
      'service_mode', coalesce(v_s.service_mode, 'command'),
      'default_service_point_type', coalesce(v_s.default_service_point_type, 'ask'),
      'allow_quick_customer_create', coalesce(v_s.allow_quick_customer_create, true),
      'show_customer_on_service_card', coalesce(v_s.show_customer_on_service_card, true),
      'compact_operational_cards', coalesce(v_s.compact_operational_cards, true),
      'updated_at', v_s.updated_at,
      'updated_by_name', v_by
    ),
    'timezone', 'America/Sao_Paulo',
    'currency', 'BRL'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Escrita: dados de contato + preferências numa transação só
-- ---------------------------------------------------------------------------
create function public.update_company_preferences(
  p_company_id uuid,
  p_name text,
  p_document text,
  p_phone text,
  p_whatsapp text,
  p_email text,
  p_default_service_point_type text,
  p_allow_quick_customer_create boolean,
  p_show_customer_on_service_card boolean,
  p_compact_operational_cards boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c public.companies;
  v_name text := nullif(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), '');
  v_doc_in text := nullif(btrim(coalesce(p_document, '')), '');
  v_doc_digits text;
  v_doc text;
  v_phone text := nullif(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), '');
  v_wa text := nullif(regexp_replace(coalesce(p_whatsapp, ''), '\D', '', 'g'), '');
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
begin
  perform public.company_prefs_assert_manager(p_company_id);

  if v_name is null then raise exception 'Informe o nome da empresa.' using errcode = 'PT400'; end if;
  if char_length(v_name) > 120 then raise exception 'O nome da empresa pode ter no máximo 120 caracteres.' using errcode = 'PT400'; end if;
  if p_default_service_point_type is null or p_default_service_point_type not in ('ask', 'command', 'table') then
    raise exception 'Tipo de atendimento padrão inválido.' using errcode = 'PT400';
  end if;
  if p_allow_quick_customer_create is null or p_show_customer_on_service_card is null or p_compact_operational_cards is null then
    raise exception 'Preferência inválida.' using errcode = 'PT400';
  end if;

  select * into v_c from public.companies where id = p_company_id for update;

  -- Documento: só CPF/CNPJ com dígito verificador. Se não mudou (mesmos dígitos do que já estava salvo,
  -- inclusive texto livre antigo), o valor existente é mantido como está.
  if v_doc_in is null then
    v_doc := null;
  else
    v_doc_digits := regexp_replace(v_doc_in, '\D', '', 'g');
    if v_c.document is not null and v_doc_digits = regexp_replace(v_c.document, '\D', '', 'g') and v_doc_digits <> '' then
      v_doc := v_c.document;
    elsif public.customers_valid_document(v_doc_digits) then
      v_doc := v_doc_digits;
    else
      raise exception 'CNPJ/CPF inválido. Confira os números.' using errcode = 'PT400';
    end if;
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

  update public.companies
     set name = v_name, document = v_doc, phone = v_phone, whatsapp = v_wa, email = v_email
   where id = p_company_id;

  insert into public.company_operational_settings as s (
    company_id, default_service_point_type, allow_quick_customer_create,
    show_customer_on_service_card, compact_operational_cards, updated_by
  ) values (
    p_company_id, p_default_service_point_type, p_allow_quick_customer_create,
    p_show_customer_on_service_card, p_compact_operational_cards, auth.uid()
  )
  on conflict (company_id) do update
     set default_service_point_type = excluded.default_service_point_type,
         allow_quick_customer_create = excluded.allow_quick_customer_create,
         show_customer_on_service_card = excluded.show_customer_on_service_card,
         compact_operational_cards = excluded.compact_operational_cards,
         updated_by = excluded.updated_by;

  return public.get_company_preferences(p_company_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Cadastro rápido de cliente respeita a preferência (também no servidor)
-- ---------------------------------------------------------------------------
create or replace function public.quick_create_customer(p_company_id uuid, p_name text, p_phone text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_c jsonb;
  v_row public.customers;
begin
  v_role := public.customers_assert_reader(p_company_id);

  -- owner/admin cadastram clientes na tela Clientes; o cadastro rápido só é barrado para os papéis operacionais.
  if v_role not in ('owner', 'admin') and not coalesce((
    select s.allow_quick_customer_create from public.company_operational_settings s where s.company_id = p_company_id
  ), true) then
    raise exception 'O cadastro rápido de clientes está desativado nesta empresa.' using errcode = 'PT403';
  end if;

  v_c := public.customers_clean(p_name, 'person', null, p_phone, null, null, null, null);

  insert into public.customers (company_id, customer_type, name, phone, created_by)
  values (p_company_id, 'person', v_c->>'name', v_c->>'phone', auth.uid())
  returning * into v_row;

  return jsonb_build_object('id', v_row.id, 'name', v_row.name, 'phone_last4', right(v_row.phone, 4));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) ACL
-- ---------------------------------------------------------------------------
revoke execute on function public.get_company_preferences(uuid) from public, anon;
grant execute on function public.get_company_preferences(uuid) to authenticated;
revoke execute on function public.update_company_preferences(uuid, text, text, text, text, text, text, boolean, boolean, boolean) from public, anon;
grant execute on function public.update_company_preferences(uuid, text, text, text, text, text, text, boolean, boolean, boolean) to authenticated;

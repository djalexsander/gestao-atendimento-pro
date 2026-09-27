-- Módulo operacional — EAN-13 automático para comandas e mesas (service_points.barcode).
--
-- Só a GERAÇÃO do código, no banco. Fora daqui, de propósito: imagem/SVG/PNG do código de
-- barras, impressão, etiqueta e qualquer coisa de produtos, pedidos, pagamento ou estoque.
-- Não altera 020000 nem 030000 (já aplicadas): tudo aqui é ALTER TABLE + tabela/funções novas.
--
--   1. ean13_check_digit(): dígito verificador oficial do EAN-13, a partir de 12 dígitos.
--   2. CHECK nova em service_points.barcode: só se aplica a códigos no formato interno
--      (prefixo 200 + 13 dígitos); qualquer outro formato continua liberado como já era.
--   3. company_ean_sequences: sequência PRÓPRIA de cada empresa, só cresce.
--   4. next_service_point_ean13(): consome o próximo número da empresa e monta o EAN-13
--      completo (uso interno, nunca exposta ao cliente).
--   5. generate_service_point_ean13(): RPC — gera (ou regenera, explicitamente) o barcode de
--      UM ponto existente.
--   6. create_service_points_batch(): RPC — cria um lote de pontos (com ou sem EAN-13) em UMA
--      transação: ou o lote inteiro entra, ou nada.
--
-- Padrão do código interno: "200" + sequência de 9 dígitos (000000001..999999999) + dígito
-- verificador = 13 dígitos. Ex.: sequência 1 da empresa -> "200" || "000000001" || check digit.
--
-- Concorrência: a sequência é uma linha por empresa (company_ean_sequences), consumida por um
-- UPDATE atômico (next_value = next_value + 1 RETURNING ...). O UPDATE tranca a linha: uma
-- segunda chamada concorrente da MESMA empresa espera a primeira terminar e recebe o próximo
-- número, nunca o mesmo. O UNIQUE de service_points.barcode (já existente, 020000) é defesa
-- adicional. A sequência nunca volta atrás (só incrementa; remover um ponto no futuro não
-- libera o número de volta).
--
-- Permissões: gerar/regenerar é owner/admin da PRÓPRIA empresa (RLS via user_role_in_company);
-- cashier/attendant e funcionário inativo não executam; anon não executa. Empresa A nunca gera
-- código para service_point da empresa B (o RPC confirma a empresa do ponto antes de checar o
-- papel, igual ao open_service_session).

-- ---------------------------------------------------------------------------
-- 1) Dígito verificador EAN-13 (GS1): peso 1 nas posições ímpares (1ª..11ª), peso 3 nas pares
--    (2ª..12ª), contando da ESQUERDA; check = (10 - soma_ponderada mod 10) mod 10.
-- ---------------------------------------------------------------------------
create function public.ean13_check_digit(p_digits12 text)
returns integer
language plpgsql
immutable
set search_path = public
as $$
declare
  v_sum integer := 0;
  i integer;
begin
  if p_digits12 !~ '^[0-9]{12}$' then
    raise exception 'ean13_check_digit espera exatamente 12 dígitos.' using errcode = 'PT400';
  end if;

  for i in 1..12 loop
    v_sum := v_sum + substr(p_digits12, i, 1)::integer * (case when i % 2 = 0 then 3 else 1 end);
  end loop;

  return (10 - (v_sum % 10)) % 10;
end;
$$;

comment on function public.ean13_check_digit(text) is
  'Dígito verificador EAN-13 oficial dos 12 primeiros dígitos. Pura (sem tabela); usada na geração e na CHECK de service_points.barcode.';

revoke execute on function public.ean13_check_digit(text) from public, anon;
grant execute on function public.ean13_check_digit(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) CHECK nova: só restringe o formato interno (prefixo 200, 13 dígitos). Qualquer outro
--    barcode (legado, próprio do estabelecimento) continua passando só pela CHECK já existente
--    (service_points_barcode_format: sem espaço, até 64 caracteres).
-- ---------------------------------------------------------------------------
alter table public.service_points
  add constraint service_points_barcode_ean13_check_digit
  check (
    barcode !~ '^200[0-9]{10}$'
    or substr(barcode, 13, 1)::integer = public.ean13_check_digit(left(barcode, 12))
  );

comment on constraint service_points_barcode_ean13_check_digit on public.service_points is
  'Só se aplica a códigos no formato interno (200 + 13 dígitos): o 13º dígito tem de ser o verificador EAN-13 correto. Outros formatos de barcode não são afetados.';

-- ---------------------------------------------------------------------------
-- 3) Sequência de EAN-13 por empresa: uma linha por empresa, só cresce (000000001..999999999).
-- ---------------------------------------------------------------------------
create table public.company_ean_sequences (
  company_id uuid primary key references public.companies(id) on delete cascade,
  next_value bigint not null default 1
    constraint company_ean_sequences_next_value_check check (next_value >= 1),
  updated_at timestamptz not null default now()
);

comment on table public.company_ean_sequences is
  'Contador PRÓPRIO de cada empresa para o EAN-13 interno de service_points. Só incrementa (nunca reaproveita número): consumido por next_service_point_ean13() via UPDATE atômico.';
comment on column public.company_ean_sequences.next_value is
  'Próximo número de 9 dígitos a consumir (1..999999999). Nunca decresce.';

create trigger company_ean_sequences_set_updated_at
  before update on public.company_ean_sequences
  for each row execute function public.set_updated_at();

-- Empresas que já existem ganham a sequência agora.
insert into public.company_ean_sequences (company_id)
select id from public.companies
on conflict (company_id) do nothing;

-- Empresa nova nasce com a sequência (mesmo padrão de company_operational_settings, 020000).
create function public.create_company_ean_sequence()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.company_ean_sequences (company_id)
  values (new.id)
  on conflict (company_id) do nothing;
  return new;
end;
$$;

create trigger companies_create_ean_sequence
  after insert on public.companies
  for each row execute function public.create_company_ean_sequence();

revoke execute on function public.create_company_ean_sequence() from public, anon, authenticated;

-- Ninguém lê/escreve direto: é implementação interna, só usada pelas funções abaixo.
alter table public.company_ean_sequences enable row level security;
revoke all on public.company_ean_sequences from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4) Consome o próximo EAN-13 da empresa (uso interno; nunca chamada direto pelo cliente).
-- ---------------------------------------------------------------------------
create function public.next_service_point_ean13(p_company_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq bigint;
begin
  -- UPDATE atômico: tranca a linha da empresa, então uma segunda chamada concorrente espera
  -- esta terminar e recebe o número seguinte (nunca o mesmo).
  update public.company_ean_sequences
  set next_value = next_value + 1
  where company_id = p_company_id
  returning next_value - 1 into v_seq;

  if not found then
    raise exception 'Sequência de código de barras não encontrada para esta empresa.' using errcode = 'PT404';
  end if;
  if v_seq > 999999999 then
    raise exception 'A sequência de código de barras desta empresa se esgotou.' using errcode = 'PT409';
  end if;

  return '200' || lpad(v_seq::text, 9, '0') || public.ean13_check_digit('200' || lpad(v_seq::text, 9, '0'))::text;
end;
$$;

comment on function public.next_service_point_ean13(uuid) is
  'Consome e devolve o próximo EAN-13 (13 dígitos) da empresa. Uso interno: sem grant a anon/authenticated, só chamada por generate_service_point_ean13() e create_service_points_batch().';

revoke execute on function public.next_service_point_ean13(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5) RPC: gerar (ou regenerar) o EAN-13 de UM ponto existente.
-- ---------------------------------------------------------------------------
-- Erros: PT401 sem sessão, PT404 ponto não encontrado (também para quem não é membro ativo da
-- empresa dele), PT403 sem permissão (cashier/attendant/inativo), PT409 já existe um barcode e
-- p_regenerate não foi pedido explicitamente.
create function public.generate_service_point_ean13(
  p_service_point_id uuid,
  p_regenerate boolean default false
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_point public.service_points;
  v_role public.company_role;
  v_barcode text;
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
  if v_role not in ('owner', 'admin') then
    raise exception 'Você não tem permissão para gerar código de barras.' using errcode = 'PT403';
  end if;

  if v_point.barcode is not null and not p_regenerate then
    raise exception 'Esta comanda ou mesa já possui um código de barras. Para gerar outro, confirme a regeneração.'
      using errcode = 'PT409';
  end if;

  v_barcode := public.next_service_point_ean13(v_point.company_id);

  update public.service_points set barcode = v_barcode where id = v_point.id;

  return v_barcode;
end;
$$;

revoke execute on function public.generate_service_point_ean13(uuid, boolean) from public, anon;
grant execute on function public.generate_service_point_ean13(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 6) RPC: cadastro em lote (com ou sem EAN-13 automático), transacional — o corpo da função é
--    UMA transação: qualquer erro no meio desfaz o lote inteiro (nenhuma linha fica meio-criada).
-- ---------------------------------------------------------------------------
-- Erros: PT401 sem sessão, PT404 empresa não encontrada (também para quem não é membro ativo
-- dela), PT403 sem permissão, PT400 lote vazio/tipo inválido/grande demais, PT409 código
-- duplicado (dentro do lote ou já existente) ou falha de negócio.
create function public.create_service_points_batch(
  p_company_id uuid,
  p_type text,
  p_rows jsonb,
  p_generate_ean boolean default false
)
returns setof public.service_points
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_row jsonb;
  v_point public.service_points;
  v_barcode text;
  v_constraint text;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Você não tem permissão para cadastrar comandas ou mesas.' using errcode = 'PT403';
  end if;

  if p_type not in ('command', 'table') then
    raise exception 'Tipo inválido.' using errcode = 'PT400';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'Informe ao menos um ponto para cadastrar.' using errcode = 'PT400';
  end if;
  if jsonb_array_length(p_rows) > 200 then
    raise exception 'Gere no máximo 200 por vez.' using errcode = 'PT400';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    begin
      insert into public.service_points (company_id, type, code, display_name)
      values (p_company_id, p_type, v_row ->> 'code', v_row ->> 'display_name')
      returning * into v_point;
    exception
      when unique_violation then
        get stacked diagnostics v_constraint = constraint_name;
        if v_constraint = 'service_points_company_code_key' then
          raise exception 'Algum código do intervalo já existe. Atualize a lista e tente de novo.'
            using errcode = 'PT409';
        end if;
        raise;
    end;

    if p_generate_ean then
      v_barcode := public.next_service_point_ean13(p_company_id);
      update public.service_points set barcode = v_barcode where id = v_point.id;
      v_point.barcode := v_barcode;
    end if;

    return next v_point;
  end loop;

  return;
end;
$$;

revoke execute on function public.create_service_points_batch(uuid, text, jsonb, boolean) from public, anon;
grant execute on function public.create_service_points_batch(uuid, text, jsonb, boolean) to authenticated;

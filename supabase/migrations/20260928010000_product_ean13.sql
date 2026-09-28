-- EAN-13 automático — generaliza a infraestrutura da migration 060000 (service_points) para
-- QUALQUER cadastro com código de barras, a começar por products. NÃO modifica a 060000 já
-- aplicada: tudo aqui é CREATE novo + um CREATE OR REPLACE que preserva assinatura e ACL.
--
--   1. next_company_ean13(company_id): helper genérico — extrai o NÚCLEO de
--      next_service_point_ean13() (mesmo algoritmo: UPDATE atômico em company_ean_sequences,
--      prefixo 200 + 9 dígitos + dígito verificador). Uso interno, nunca exposto ao cliente.
--   2. next_service_point_ean13(): CREATE OR REPLACE virando um wrapper de 1 linha sobre o
--      helper genérico. Mesma assinatura e mesma ACL (CREATE OR REPLACE preserva grants/revokes
--      já feitos em 060000 — o OID da função não muda). generate_service_point_ean13() e
--      create_service_points_batch() continuam funcionando SEM NENHUMA alteração de comportamento.
--   3. ean13_internal_format_valid(barcode): predicado reutilizável com a MESMA regra da CHECK
--      já aplicada em service_points.barcode (060000, inline) — usado pela CHECK nova de
--      products.barcode, e pronto para qualquer cadastro futuro com barcode.
--   4. CHECK nova em products.barcode: mesmo formato (200 + 13 dígitos, dígito verificador
--      correto); qualquer outro formato de barcode (legado/próprio do estabelecimento) não é
--      afetado — igual a service_points.
--   5. generate_product_ean13(): RPC — gera (ou regenera, explicitamente) o barcode de UM
--      produto existente. Espelha generate_service_point_ean13() ponto a ponto (mesmos erros,
--      mesma checagem de papel, mesmo comportamento de regeneração).
--
-- Sequência ÚNICA por empresa (company_ean_sequences, já existe desde 060000; não recriada
-- aqui): products e service_points agora consomem da MESMA linha por empresa, então dois EANs
-- gerados automaticamente NUNCA colidem, mesmo entre tabelas diferentes — comanda 001 pode
-- consumir o número 1 da sequência, o próximo PRODUTO consome o número 2, e assim por diante.
-- A garantia vem do UPDATE atômico de next_company_ean13() (tranca a linha da empresa: uma
-- segunda chamada concorrente, de QUALQUER cadastro, espera a primeira terminar e recebe o
-- próximo número, nunca o mesmo) — por isso não é preciso FK nem checagem cruzada entre
-- products e service_points: a central única já impede a colisão por construção. Cada tabela
-- mantém seu próprio UNIQUE (barcode) só para proteger contra colisão de digitação MANUAL
-- dentro dela mesma, como já era.
--
-- Regra de arquitetura (vale para qualquer cadastro futuro com coluna barcode): reusar
-- next_company_ean13() para gerar, ean13_check_digit()/ean13_internal_format_valid() para
-- validar, e o mesmo formato de RPC generate_<entidade>_ean13(p_id, p_regenerate default false)
-- para gerar/regenerar. Não duplicar o algoritmo.
--
-- Permissões: gerar/regenerar o EAN de um produto é owner/admin da PRÓPRIA empresa dele (mesma
-- checagem de generate_service_point_ean13); cashier/attendant e funcionário inativo não
-- executam; anon não executa. Empresa A nunca gera código para produto da empresa B.

-- ---------------------------------------------------------------------------
-- 1) Helper genérico: consome o próximo EAN-13 (13 dígitos) da sequência da empresa.
-- ---------------------------------------------------------------------------
create function public.next_company_ean13(p_company_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq bigint;
begin
  -- UPDATE atômico: tranca a linha da empresa, então uma segunda chamada concorrente (de
  -- QUALQUER cadastro que use este helper) espera esta terminar e recebe o número seguinte.
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

comment on function public.next_company_ean13(uuid) is
  'Consome e devolve o próximo EAN-13 (13 dígitos) da sequência ÚNICA da empresa (company_ean_sequences, 060000) — COMPARTILHADA por todos os cadastros com barcode: service_points (via next_service_point_ean13, agora um wrapper deste helper), products (via generate_product_ean13), e qualquer cadastro futuro. Uso interno: sem grant a anon/authenticated.';

revoke execute on function public.next_company_ean13(uuid) from public, anon, authenticated;

comment on table public.company_ean_sequences is
  'Contador ÚNICO de cada empresa para o EAN-13 interno, COMPARTILHADO por todos os cadastros com barcode (service_points desde 060000; products desde esta migration; e qualquer cadastro futuro). Só incrementa (nunca reaproveita número): consumido via next_company_ean13().';

-- ---------------------------------------------------------------------------
-- 2) service_points passa a usar o helper genérico. MESMA assinatura (uuid -> text): o OID da
--    função não muda, então os grants/revokes de 060000 continuam valendo sem repeti-los aqui.
--    generate_service_point_ean13() e create_service_points_batch() chamam pelo nome e não
--    precisam de nenhum ajuste.
-- ---------------------------------------------------------------------------
create or replace function public.next_service_point_ean13(p_company_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.next_company_ean13(p_company_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Predicado reutilizável: mesma regra da CHECK já aplicada em service_points.barcode
--    (060000, escrita inline lá; aqui vira função para não duplicar a expressão de novo em
--    products e nos cadastros futuros).
-- ---------------------------------------------------------------------------
create function public.ean13_internal_format_valid(p_barcode text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_barcode !~ '^200[0-9]{10}$'
     or substr(p_barcode, 13, 1)::integer = public.ean13_check_digit(left(p_barcode, 12));
$$;

comment on function public.ean13_internal_format_valid(text) is
  'true quando o barcode NÃO está no formato interno (200 + 13 dígitos, então a regra do dígito verificador não se aplica) OU quando está e o dígito verificador confere. Mesma regra da CHECK inline de service_points.barcode (060000); usada aqui pela CHECK nova de products.barcode e reutilizável por qualquer cadastro futuro com barcode.';

-- Mesmo motivo de ean13_check_digit (060000): a CHECK roda com o papel de quem faz o INSERT/
-- UPDATE (authenticated via RLS), então authenticated precisa de EXECUTE para a constraint ser
-- avaliável.
revoke execute on function public.ean13_internal_format_valid(text) from public, anon;
grant execute on function public.ean13_internal_format_valid(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) CHECK nova em products.barcode — só restringe o formato interno; qualquer outro barcode
--    (legado, próprio do estabelecimento) continua passando só pela CHECK já existente
--    (products_barcode_format: sem espaço, até 64 caracteres, migration 040000).
-- ---------------------------------------------------------------------------
alter table public.products
  add constraint products_barcode_ean13_check_digit
  check (public.ean13_internal_format_valid(barcode));

comment on constraint products_barcode_ean13_check_digit on public.products is
  'Só se aplica a códigos no formato interno (200 + 13 dígitos): o 13º dígito tem de ser o verificador EAN-13 correto (ean13_internal_format_valid). Outros formatos de barcode não são afetados. Mesma regra de service_points.barcode (060000).';

-- ---------------------------------------------------------------------------
-- 5) RPC: gerar (ou regenerar) o EAN-13 de UM produto existente. Espelha
--    generate_service_point_ean13() (060000) ponto a ponto.
-- ---------------------------------------------------------------------------
-- Erros: PT401 sem sessão, PT404 produto não encontrado (também para quem não é membro ativo da
-- empresa dele — mesma ambiguidade proposital de generate_service_point_ean13), PT403 sem
-- permissão (cashier/attendant/inativo), PT409 já existe um barcode e p_regenerate não foi
-- pedido explicitamente (ou a sequência da empresa se esgotou).
create function public.generate_product_ean13(
  p_product_id uuid,
  p_regenerate boolean default false
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.products;
  v_role public.company_role;
  v_barcode text;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  select * into v_product from public.products where id = p_product_id;
  if not found then
    raise exception 'Produto não encontrado.' using errcode = 'PT404';
  end if;

  v_role := public.user_role_in_company(v_product.company_id);
  if v_role is null then
    raise exception 'Produto não encontrado.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Você não tem permissão para gerar código de barras.' using errcode = 'PT403';
  end if;

  if v_product.barcode is not null and not p_regenerate then
    raise exception 'Este produto já possui um código de barras. Para gerar outro, confirme a regeneração.'
      using errcode = 'PT409';
  end if;

  v_barcode := public.next_company_ean13(v_product.company_id);

  update public.products set barcode = v_barcode where id = v_product.id;

  return v_barcode;
end;
$$;

comment on function public.generate_product_ean13(uuid, boolean) is
  'RPC: gera (p_regenerate=false, recusa se já existe barcode) ou regenera (true) o EAN-13 de UM produto existente, consumindo a sequência ÚNICA da empresa (next_company_ean13 -> company_ean_sequences, compartilhada com service_points). Espelha generate_service_point_ean13 (060000).';

revoke execute on function public.generate_product_ean13(uuid, boolean) from public, anon;
grant execute on function public.generate_product_ean13(uuid, boolean) to authenticated;

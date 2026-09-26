-- Funcionários e acesso — etapa 2: código de acesso da empresa.
--
-- companies.access_code é o identificador da empresa no login dos funcionários
-- (código da empresa + login + senha). É independente de `slug`: o slug segue
-- com a sua própria regra e nada aqui o lê nem o altera.
--
--   * formato: minúsculas, dígitos e hífen ([a-z0-9-]), de 3 a 32 caracteres,
--     sem hífen no início, no fim nem dois seguidos;
--   * único entre empresas;
--   * imutável depois de definido.
--
-- A coluna nasce opcional (NULL) de propósito: create_company continua sem
-- informá-la até a etapa seguinte, então uma empresa nova pode existir sem
-- código por enquanto. Só a empresa real já existente (ALEXPROAPPS) recebe o
-- código agora.
--
-- Escrita: `authenticated` só tem UPDATE em (name, document) desde a migration
-- 20260924020000, e essa lista não muda aqui — o código não é gravável pelo
-- cliente. Quem o define é o backend (create_company / Edge Function, etapa
-- seguinte). A leitura segue a RLS de companies: cada membro vê o código da
-- própria empresa.

alter table public.companies add column access_code text;

comment on column public.companies.access_code is
  'Código de acesso da empresa no login dos funcionários. Independente de slug; [a-z0-9-], 3 a 32 caracteres, sem hífen no início, no fim nem dois seguidos; único; imutável depois de definido (NULL até ser atribuído).';

-- Formato. NULL é aceito (a coluna ainda é opcional); todo valor não nulo
-- precisa ter de 3 a 32 caracteres E casar por inteiro com
-- [a-z0-9]+(-[a-z0-9]+)*, isto é, grupos de minúsculas/dígitos separados por
-- um único hífen: sem hífen no início, sem hífen no fim e sem dois seguidos.
-- Maiúsculas, espaços, sublinhado, acentos, quebra de linha e qualquer outro
-- caractere fora de [a-z0-9-] também são recusados. O tamanho é checado à parte
-- (char_length) para o padrão ficar legível.
alter table public.companies
  add constraint companies_access_code_format
  check (
    access_code is null
    or (
      char_length(access_code) between 3 and 32
      and access_code ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    )
  );

-- Unicidade. Em UNIQUE os NULL são distintos entre si: várias empresas sem
-- código coexistem, mas dois códigos iguais não. Como o formato só admite
-- minúsculas, igualdade do texto já é igualdade sem diferenciar caixa.
alter table public.companies
  add constraint companies_access_code_key unique (access_code);

-- Imutabilidade. Um CHECK não enxerga OLD/NEW, por isso um trigger pequeno e
-- fechado:
--   NULL  -> valor        permitido (definição inicial)
--   valor -> mesmo valor  permitido (o UPDATE não muda o código)
--   valor -> outro valor  recusado
--   valor -> NULL         recusado
-- Vale para qualquer role e caminho de escrita, inclusive service_role e SQL
-- direto. Não toca em nenhuma outra tabela.
create function public.prevent_company_access_code_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.access_code is not null
     and new.access_code is distinct from old.access_code then
    raise exception 'access_code da empresa é imutável depois de definido';
  end if;
  return new;
end;
$$;

create trigger companies_access_code_immutable
  before update on public.companies
  for each row execute function public.prevent_company_access_code_change();

revoke execute on function public.prevent_company_access_code_change() from public, anon, authenticated;

-- Backfill: SOMENTE a empresa real existente (ALEXPROAPPS). Nenhuma outra
-- empresa é tocada e o slug não muda. Em bancos sem essa empresa (reset local,
-- ambiente novo) o UPDATE simplesmente não casa nenhuma linha.
update public.companies
set access_code = 'alexproapps'
where id = '394e96f7-4336-4fc8-8ce0-7d118d5e7039'
  and access_code is null;

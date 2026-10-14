-- ATIVAÇÃO CONTROLADA de módulo por EMPRESA (teste real do Delivery) sem ativar o módulo no catálogo.
--
-- PROBLEMA: company_entitlement só enxerga módulos com modules.is_active = true (assinatura: subscription_modules ativos
-- INTERSECÇÃO catálogo ativo; trial/legado: TODOS os ativos). Ativar o módulo delivery no catálogo o entregaria às empresas
-- legado/trial. Um módulo inativo, portanto, não pode ser concedido a UMA empresa de forma limpa.
--
-- SOLUÇÃO (aditiva e reversível):
--   * company_module_overrides (company_id, module_code): concessão explícita e AUDITÁVEL de um módulo EXISTENTE a uma empresa,
--     mesmo com modules.is_active = false. Sem policy nem GRANT para clientes: só o operador (service_role / SQL do
--     projeto) escreve e lê. Remover a linha desfaz a concessão.
--   * company_entitlement (a função que TODO o resto consulta: assert_company_module, company_has_module(_rls),
--     tenant_get_entitlements) vira um invólucro: chama o corpo ORIGINAL, renomeado para company_entitlement_base
--     (inalterado, mesma ACL), e só ACRESCENTA ao array "modules" os módulos concedidos por override. Empresa sem
--     override recebe EXATAMENTE o mesmo resultado de antes. pending_payment nunca recebe override.
--
-- Não altera preço, catálogo, trial, assinaturas nem nenhuma outra função.

create table public.company_module_overrides (
  company_id uuid not null references public.companies(id) on delete cascade,
  module_code text not null references public.modules(code) on update cascade on delete cascade,
  reason text not null
    constraint company_module_overrides_reason_length check (char_length(btrim(reason)) between 3 and 200),
  created_at timestamptz not null default now(),
  primary key (company_id, module_code)
);

comment on table public.company_module_overrides is
  'Concessão explícita de um módulo a UMA empresa, independente de modules.is_active (ativação controlada/teste). Só operador; remover a linha reverte.';

alter table public.company_module_overrides enable row level security;
revoke all on public.company_module_overrides from public, anon, authenticated;
grant all on public.company_module_overrides to service_role;

-- O corpo ORIGINAL passa a se chamar company_entitlement_base (ALTER ... RENAME preserva dono, ACL e definição).
alter function public.company_entitlement(uuid) rename to company_entitlement_base;

create function public.company_entitlement(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_base jsonb;
  v_extra text[];
begin
  v_base := public.company_entitlement_base(p_company_id);

  select coalesce(array_agg(o.module_code order by o.module_code), '{}') into v_extra
  from public.company_module_overrides o
  where o.company_id = p_company_id;

  if cardinality(v_extra) = 0 or v_base ->> 'mode' = 'pending_payment' then
    return v_base;
  end if;

  return jsonb_set(
           v_base, '{modules}',
           (select coalesce(jsonb_agg(m order by m), '[]'::jsonb)
              from (select distinct m from unnest(array(select jsonb_array_elements_text(v_base -> 'modules')) || v_extra) as m) u)
         ) || jsonb_build_object('overrides', to_jsonb(v_extra));
end;
$$;

-- Mesma ACL da original: só o dono (as demais funções DEFINER a chamam).
revoke execute on function public.company_entitlement(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.company_entitlement_base(uuid) from public, anon, authenticated, service_role;

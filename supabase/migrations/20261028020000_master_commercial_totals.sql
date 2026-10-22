-- CORREÇÃO: "Configurações comerciais" do Painel Master somava os módulos opcionais com uma lista FIXA de códigos
-- ('financeiro','producao','estoque','impressao', da migration 20261005040000), anterior ao Delivery. O Delivery (ativo, R$ 29,90)
-- ficava fora: R$ 79,60 em vez de R$ 109,50 (e total completo R$ 159,50 em vez de R$ 189,40).
--
-- AGORA: a soma é DINÂMICA sobre o catálogo oficial (public.modules): todo módulo ATIVO entra, qualquer que seja o código;
-- inativo (inclusive whatsapp e ia, enquanto inativos) não entra; preço zero entra com 0. Mesma regra da tela Módulos.
-- Dinheiro em centavos inteiros (bigint na soma). Só leitura: nenhum preço, contrato, assinatura ou fatura é alterado
-- (assinaturas e faturas usam o preço congelado de cada contrato, não este total).

create or replace function public.master_get_commercial_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_base bigint;
  v_modules bigint;
begin
  perform public.assert_master_admin();

  select p.monthly_price_cents into v_base from public.plans p where p.code = 'base';
  select coalesce(sum(m.monthly_price_cents), 0)::bigint into v_modules
    from public.modules m
   where m.is_active;

  return jsonb_build_object(
    'trial_days', public.trial_duration_days(),
    'grace_days', public.billing_grace_days(),
    'base_price_cents', coalesce(v_base, 0),
    'modules_total_cents', v_modules,
    'full_total_cents', coalesce(v_base, 0) + v_modules
  );
end;
$$;

revoke execute on function public.master_get_commercial_settings() from public, anon;
grant execute on function public.master_get_commercial_settings() to authenticated;

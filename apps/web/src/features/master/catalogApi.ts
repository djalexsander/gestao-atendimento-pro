import { supabase } from "../../lib/supabaseClient";
import type { CatalogModule, CatalogPlan } from "../../lib/types";

// Todas as chamadas são RPCs SECURITY DEFINER que reautenticam master_admin
// no backend; as tabelas do catálogo não são acessíveis diretamente.

interface ModuleRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  monthly_price_cents: number;
  is_active: boolean;
}

interface PlanRow extends ModuleRow {
  limits: Record<string, number | null> | null;
  module_ids: string[] | null;
}

const toModule = (r: ModuleRow): CatalogModule => ({
  id: r.id,
  code: r.code,
  name: r.name,
  description: r.description,
  monthlyPriceCents: r.monthly_price_cents,
  isActive: r.is_active,
});

export async function listModules(): Promise<{ data: CatalogModule[]; error: string | null }> {
  const { data, error } = await supabase.rpc("master_list_modules");
  if (error) return { data: [], error: error.message };
  return { data: ((data ?? []) as ModuleRow[]).map(toModule), error: null };
}

export async function listPlans(): Promise<{ data: CatalogPlan[]; error: string | null }> {
  const { data, error } = await supabase.rpc("master_list_plans");
  if (error) return { data: [], error: error.message };
  return {
    data: ((data ?? []) as PlanRow[]).map((r) => ({
      ...toModule(r),
      limits: r.limits ?? {},
      moduleIds: r.module_ids ?? [],
    })),
    error: null,
  };
}

interface ItemInput {
  id: string | null;
  code: string;
  name: string;
  description: string;
  monthlyPriceCents: number;
  isActive: boolean;
}

const itemArgs = (i: ItemInput) => ({
  p_id: i.id,
  p_code: i.code,
  p_name: i.name,
  p_description: i.description,
  p_monthly_price_cents: i.monthlyPriceCents,
  p_is_active: i.isActive,
});

export async function saveModule(i: ItemInput): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc("master_upsert_module", itemArgs(i));
  return { error: error?.message ?? null };
}

// Cria/atualiza o plano e, em seguida, substitui limites e módulos incluídos.
export async function savePlan(
  i: ItemInput,
  limits: Record<string, number | null>,
  moduleIds: string[],
): Promise<{ error: string | null }> {
  const { data, error } = await supabase.rpc("master_upsert_plan", itemArgs(i));
  if (error) return { error: error.message };
  const planId = (data as { id: string }).id;

  const limitsResult = await supabase.rpc("master_set_plan_limits", {
    p_plan_id: planId,
    p_limits: limits,
  });
  if (limitsResult.error) return { error: limitsResult.error.message };

  const modulesResult = await supabase.rpc("master_set_plan_modules", {
    p_plan_id: planId,
    p_module_ids: moduleIds,
  });
  return { error: modulesResult.error?.message ?? null };
}

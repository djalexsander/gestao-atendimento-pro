import { supabase } from "../../lib/supabaseClient";
import type { BillingState, CompanyDetail, SubscriptionHistory, SubscriptionStatus } from "../../lib/types";

// Todas as chamadas são RPCs SECURITY DEFINER que reautenticam master_admin
// no backend. As tabelas comerciais não são acessíveis ao cliente.

export async function getCompanyDetail(
  companyId: string,
): Promise<{ data: CompanyDetail | null; error: string | null }> {
  const { data, error } = await supabase.rpc("master_get_company", { p_company_id: companyId });
  if (error) return { data: null, error: error.message };
  return { data: data as CompanyDetail, error: null };
}

// Contratação PAGA. O front não escolhe status nem dia de vencimento: o banco cria
// a assinatura em pending_payment com a cobrança inicial integral (plano + extras)
// vencendo hoje, e o dia da contratação vira a âncora das mensalidades. Se a
// empresa está em período grátis (ou o teve e expirou), o banco encerra o teste
// como "convertido" na mesma transação.
export async function subscribeCompany(
  companyId: string,
  planId: string,
  extraModuleIds: string[],
): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc("master_subscribe_company", {
    p_company_id: companyId,
    p_plan_id: planId,
    p_extra_module_ids: extraModuleIds,
  });
  return { error: error?.message ?? null };
}

// Período grátis: fluxo próprio e explícito no backend (7 dias, sem cobrança,
// um por empresa). Nada disto é inferido de plano nem de preço R$ 0.
export async function startTrial(companyId: string): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc("master_start_trial", { p_company_id: companyId });
  return { error: error?.message ?? null };
}

export async function cancelTrial(
  companyId: string,
  reason: string | null,
): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc("master_cancel_trial", {
    p_company_id: companyId,
    p_reason: reason,
  });
  return { error: error?.message ?? null };
}

export async function changePlan(
  subscriptionId: string,
  planId: string,
): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc("master_change_plan", {
    p_subscription_id: subscriptionId,
    p_plan_id: planId,
  });
  return { error: error?.message ?? null };
}

export async function setSubscriptionModules(
  subscriptionId: string,
  moduleIds: string[],
): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc("master_set_subscription_modules", {
    p_subscription_id: subscriptionId,
    p_module_ids: moduleIds,
  });
  return { error: error?.message ?? null };
}

export async function setSubscriptionStatus(
  subscriptionId: string,
  status: SubscriptionStatus,
  graceUntil: string | null,
): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc("master_set_subscription_status", {
    p_subscription_id: subscriptionId,
    p_status: status,
    p_grace_until: graceUntil,
  });
  return { error: error?.message ?? null };
}

export async function setBillingDay(
  subscriptionId: string,
  billingDay: number,
): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc("master_set_billing_day", {
    p_subscription_id: subscriptionId,
    p_billing_day: billingDay,
  });
  return { error: error?.message ?? null };
}

export async function getSubscriptionHistory(
  subscriptionId: string,
): Promise<{ data: SubscriptionHistory | null; error: string | null }> {
  const { data, error } = await supabase.rpc("master_get_subscription_history", {
    p_subscription_id: subscriptionId,
  });
  if (error) return { data: null, error: error.message };
  return { data: data as SubscriptionHistory, error: null };
}

export async function getBillingState(
  subscriptionId: string,
): Promise<{ data: BillingState | null; error: string | null }> {
  const { data, error } = await supabase.rpc("master_get_billing_state", {
    p_subscription_id: subscriptionId,
  });
  if (error) return { data: null, error: error.message };
  return { data: data as BillingState, error: null };
}

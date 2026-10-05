import { supabase } from "../../lib/supabaseClient";
import type { SubscriptionStatus, TrialState } from "../../lib/types";

// RPCs SECURITY DEFINER com assert_master_admin(): o banco recusa quem não é Master. Nenhum valor financeiro é enviado
// pelo frontend (MRR, totais e vencimentos são calculados no banco).

export interface CommercialOverview {
  totalCompanies: number;
  totalUsers: number;
  trialingCompanies: number;
  activeSubscriptions: number;
  blockedSubscriptions: number;
  mrrCents: number;
}

export interface CompanySummaryRow {
  id: string;
  name: string;
  document: string | null;
  createdAt: string;
  memberCount: number;
  subscriptionId: string | null;
  subscriptionStatus: SubscriptionStatus | null;
  planName: string | null;
  trialState: TrialState | null;
  trialEndsAt: string | null;
  nextDueDate: string | null;
  activeModuleNames: string[];
  monthlyTotalCents: number | null;
}

export interface CompanyContact {
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
}

export interface CommercialSettings {
  trialDays: number;
  graceDays: number;
  basePriceCents: number;
  modulesTotalCents: number;
  fullTotalCents: number;
}

export async function getCommercialOverview(): Promise<{ data: CommercialOverview | null; error: string | null }> {
  const { data, error } = await supabase.rpc("master_get_commercial_overview");
  if (error) return { data: null, error: error.message };
  const r = data as Record<string, number>;
  return {
    data: {
      totalCompanies: Number(r.total_companies),
      totalUsers: Number(r.total_users),
      trialingCompanies: Number(r.trialing_companies),
      activeSubscriptions: Number(r.active_subscriptions),
      blockedSubscriptions: Number(r.blocked_subscriptions),
      mrrCents: Number(r.mrr_cents),
    },
    error: null,
  };
}

export async function listCompaniesSummary(): Promise<{ data: CompanySummaryRow[]; error: string | null }> {
  const { data, error } = await supabase.rpc("master_list_companies_summary");
  if (error) return { data: [], error: error.message };
  const rows = (data ?? []) as Array<{
    id: string;
    name: string;
    document: string | null;
    created_at: string;
    member_count: number;
    subscription_id: string | null;
    subscription_status: SubscriptionStatus | null;
    plan_name: string | null;
    trial_state: TrialState | null;
    trial_ends_at: string | null;
    next_due_date: string | null;
    active_module_names: string[] | null;
    monthly_total_cents: number | null;
  }>;
  return {
    data: rows.map((r) => ({
      id: r.id,
      name: r.name,
      document: r.document,
      createdAt: r.created_at,
      memberCount: Number(r.member_count),
      subscriptionId: r.subscription_id,
      subscriptionStatus: r.subscription_status,
      planName: r.plan_name,
      trialState: r.trial_state,
      trialEndsAt: r.trial_ends_at,
      nextDueDate: r.next_due_date,
      activeModuleNames: r.active_module_names ?? [],
      monthlyTotalCents: r.monthly_total_cents === null ? null : Number(r.monthly_total_cents),
    })),
    error: null,
  };
}

export async function getCompanyContact(companyId: string): Promise<{ data: CompanyContact | null; error: string | null }> {
  const { data, error } = await supabase.rpc("master_get_company_contact", { p_company_id: companyId });
  if (error) return { data: null, error: error.message };
  return { data: data as CompanyContact, error: null };
}

// Edita SÓ os dados cadastrais: o banco nunca altera id/slug/código de acesso nem dados operacionais.
export async function updateCompany(
  companyId: string,
  v: { name: string; document: string; phone: string; whatsapp: string; email: string },
): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc("master_update_company", {
    p_company_id: companyId,
    p_name: v.name,
    p_document: v.document,
    p_phone: v.phone,
    p_whatsapp: v.whatsapp,
    p_email: v.email,
  });
  return { error: error?.message ?? null };
}

export async function getCommercialSettings(): Promise<{ data: CommercialSettings | null; error: string | null }> {
  const { data, error } = await supabase.rpc("master_get_commercial_settings");
  if (error) return { data: null, error: error.message };
  const r = data as Record<string, number>;
  return {
    data: {
      trialDays: Number(r.trial_days),
      graceDays: Number(r.grace_days),
      basePriceCents: Number(r.base_price_cents),
      modulesTotalCents: Number(r.modules_total_cents),
      fullTotalCents: Number(r.full_total_cents),
    },
    error: null,
  };
}

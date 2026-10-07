import { supabase } from "../../lib/supabaseClient";
import type { AccessInfo, Catalog, InvoicePayment } from "./commercialLogic";

// Acesso às RPCs tenant_* e à Edge billing-charge. Nenhum valor financeiro, documento, empresa ou vencimento é
// decidido aqui: o servidor lê tudo da fatura. A mensagem de erro vem pronta do banco (PT400/403/409) ou da Edge.

// Quais módulos a empresa pode USAR agora (tenant_get_entitlements). trial = período de teste realmente vigente (todos);
// subscription = só os módulos pagos/ativos; pending_payment/none = nenhum extra; unmanaged = empresa antiga (todos).
export type EntitlementMode = "trial" | "subscription" | "pending_payment" | "none" | "unmanaged";
export interface Entitlements { mode: EntitlementMode; modules: string[] }
export interface BillingSubscription {
  status: string;
  plan_id: string;
  plan_name: string;
  plan_code: string;
  billing_day: number;
  grace_until: string | null;
  monthly_cents: number;
  modules: Array<{ id: string; code: string; name: string; monthly_price_cents: number; source: "plan" | "extra" }>;
  next_due_date: string | null;
}
export interface BillingState {
  access_state: string;
  write_blocked: boolean;
  trial: { state?: string; trial_ends_at?: string | null; trial_days?: number | null } | null;
  subscription: BillingSubscription | null;
  debt: { state: string; due_date: string | null; grace_until: string | null; restriction_from: string | null } | null;
  pending_change: PendingChange | null;
  // adição de módulos aguardando o pagamento da cobrança proporcional (os módulos ainda NÃO estão ativos)
  pending_module_addition: PendingModuleAddition | null;
  open_invoices: number;
}
export interface AdditionLine { module_id: string; code: string; name: string; monthly_price_cents: number; prorated_cents: number }
export interface PendingModuleAddition {
  id: string;
  invoice_id: string;
  amount_cents: number;
  due_date: string;
  invoice_status: string;
  cycle_start: string;
  cycle_end: string;
  cycle_days: number;
  remaining_days: number;
  modules: AdditionLine[];
  previous_monthly_cents: number;
  new_monthly_cents: number;
  requested_at: string;
}
export interface Quote {
  monthly_cents: number;
  plan: { id: string; name: string; monthly_price_cents: number };
  modules: Array<{ id: string; name: string; monthly_price_cents: number }>;
}
export interface ModuleLine { module_id: string; code: string; name: string; price_cents: number }
export interface PendingChange {
  id: string;
  effective_at: string;
  effective_competence: string;
  previous_monthly_cents: number;
  new_monthly_cents: number;
  new_modules: ModuleLine[];
  previous_modules: ModuleLine[];
  added: ModuleLine[];
  removed: ModuleLine[];
  locked: boolean;
}
export interface ModuleChangeQuote {
  // add_now: cobrança proporcional + Pix; add_deferred: abaixo do mínimo do Pix (próximo ciclo, sem cobrança);
  // remove_next_cycle: sem estorno, sai no próximo vencimento; mixed: recusado (uma alteração por vez)
  mode: "identical" | "mixed" | "remove_next_cycle" | "add_now" | "add_deferred";
  blocked_reason: string | null;
  lines: AdditionLine[];
  prorated_total_cents: number;
  charge_today_cents: number;
  min_charge_cents: number;
  cycle_start: string | null;
  cycle_end: string | null;
  cycle_days: number | null;
  remaining_days: number | null;
  next_due_date: string | null;
  order_id: string | null;
  order_invoice_id: string | null;
  order_same: boolean;
  plan: { name: string; monthly_price_cents: number };
  current_modules: ModuleLine[];
  new_modules: ModuleLine[];
  added: ModuleLine[];
  removed: ModuleLine[];
  identical: boolean;
  previous_monthly_cents: number;
  new_monthly_cents: number;
  effective_competence: string;
  effective_at: string;
  deferred_to_following_cycle: boolean;
  pending_id: string | null;
  pending_locked: boolean;
  pending_same: boolean;
}
export interface ScheduleResult {
  mode: "add_now" | "add_deferred" | "remove_next_cycle";
  idempotent: boolean;
  new_monthly_cents: number;
  // add_now: a fatura proporcional criada (ou a já aberta, em retry)
  invoice_id?: string;
  amount_cents?: number;
  due_date?: string;
  cycle_end?: string;
  // add_deferred / remove_next_cycle: alteração agendada
  scheduled?: boolean;
  replaced?: boolean;
  below_minimum?: boolean;
  effective_at?: string;
  effective_competence?: string;
  previous_monthly_cents?: number;
  deferred_to_following_cycle?: boolean;
}
export interface TenantInvoice {
  id: string;
  kind: "initial" | "recurring" | "module_addition";
  competence: string;
  due_date: string;
  amount_cents: number;
  status: "open" | "overdue" | "paid" | "void";
  paid_at: string | null;
  items: Array<{ kind: string; description: string; amount_cents: number }>;
  payment_status: string | null;
  pix_ready: boolean;
}
export interface SubscribeResult {
  subscription_id: string;
  status: string;
  invoice_id: string;
  amount_cents: number;
  due_date: string;
}
export type ChargeResult =
  | { state: "ready" }
  | { state: "creating" }
  | { state: "error"; message: string };

type Result<T> = { data: T; error: null } | { data: null; error: string };

export interface CommercialSource {
  getAccessState(companyId: string): Promise<Result<AccessInfo>>;
  getBillingState(companyId: string): Promise<Result<BillingState>>;
  getEntitlements(companyId: string): Promise<Result<Entitlements>>;
  getCatalog(companyId: string): Promise<Result<Catalog>>;
  listInvoices(companyId: string): Promise<Result<TenantInvoice[]>>;
  getInvoicePayment(invoiceId: string): Promise<Result<InvoicePayment>>;
  quote(companyId: string, planId: string, extraModuleIds: string[]): Promise<Result<Quote>>;
  quoteModuleChange(companyId: string, moduleIds: string[]): Promise<Result<ModuleChangeQuote>>;
  scheduleModuleChange(companyId: string, moduleIds: string[]): Promise<Result<ScheduleResult>>;
  cancelModuleChange(companyId: string): Promise<Result<{ ok: boolean; canceled: boolean }>>;
  cancelModuleAddition(companyId: string): Promise<Result<{ ok: boolean; canceled: boolean }>>;
  subscribe(companyId: string, planId: string, extraModuleIds: string[]): Promise<Result<SubscribeResult>>;
  requestCharge(invoiceId: string): Promise<ChargeResult>;
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<Result<T>> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { data: null, error: error.message };
  return { data: data as T, error: null };
}

const GENERIC_CHARGE_ERROR = "Não foi possível gerar o Pix agora. Tente novamente em instantes.";

export const supabaseCommercialSource: CommercialSource = {
  getAccessState: (companyId) => rpc<AccessInfo>("tenant_get_access_state", { p_company_id: companyId }),
  getBillingState: (companyId) => rpc<BillingState>("tenant_get_billing_state", { p_company_id: companyId }),
  getEntitlements: (companyId) => rpc<Entitlements>("tenant_get_entitlements", { p_company_id: companyId }),
  getCatalog: (companyId) => rpc<Catalog>("tenant_get_catalog", { p_company_id: companyId }),
  listInvoices: (companyId) => rpc<TenantInvoice[]>("tenant_list_invoices", { p_company_id: companyId }),
  getInvoicePayment: (invoiceId) => rpc<InvoicePayment>("tenant_get_invoice_payment", { p_invoice_id: invoiceId }),
  quote: (companyId, planId, extraModuleIds) =>
    rpc<Quote>("tenant_quote_subscription", { p_company_id: companyId, p_plan_id: planId, p_extra_module_ids: extraModuleIds }),
  quoteModuleChange: (companyId, moduleIds) => rpc<ModuleChangeQuote>("tenant_quote_module_change", { p_company_id: companyId, p_module_ids: moduleIds }),
  scheduleModuleChange: (companyId, moduleIds) => rpc<ScheduleResult>("tenant_schedule_module_change", { p_company_id: companyId, p_module_ids: moduleIds }),
  cancelModuleChange: (companyId) => rpc<{ ok: boolean; canceled: boolean }>("tenant_cancel_module_change", { p_company_id: companyId }),
  cancelModuleAddition: (companyId) => rpc<{ ok: boolean; canceled: boolean }>("tenant_cancel_module_addition", { p_company_id: companyId }),
  subscribe: (companyId, planId, extraModuleIds) =>
    rpc<SubscribeResult>("tenant_subscribe", { p_company_id: companyId, p_plan_id: planId, p_extra_module_ids: extraModuleIds }),

  // Edge billing-charge: SÓ envia o id da fatura. 200 ready, 202 creating (outro processo criando), erro com mensagem curta.
  async requestCharge(invoiceId) {
    const { data, error } = await supabase.functions.invoke("billing-charge", { body: { invoice_id: invoiceId } });
    if (error) {
      let message = GENERIC_CHARGE_ERROR;
      const context = (error as { context?: unknown }).context;
      if (typeof Response !== "undefined" && context instanceof Response) {
        try {
          const body = (await context.json()) as { error?: unknown };
          if (typeof body.error === "string" && body.error) message = body.error;
        } catch {
          // mantém a mensagem genérica
        }
      }
      return { state: "error", message };
    }
    return (data as { state?: string } | null)?.state === "ready" ? { state: "ready" } : { state: "creating" };
  },
};

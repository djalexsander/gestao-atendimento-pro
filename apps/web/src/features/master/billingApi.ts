import { supabase } from "../../lib/supabaseClient";

// RPCs master_* de cobrança (assert_master_admin no banco). Nada sensível sai: sem id Asaas, Pix, QR, chave ou payload.

export interface CompanyAccessRow {
  company_id: string;
  access_state: string;
  write_blocked: boolean;
}
export interface InvoiceGatewayRow {
  invoice_id: string;
  gateway: "asaas" | null;
  charge_status: string | null;
  invoice_url: string | null;
  gateway_due_date: string | null;
  attempts: number | null;
  last_error: string | null;
  open_anomalies: number;
}
export interface BillingAnomaly {
  id: string;
  kind: string;
  company_id: string | null;
  company_name: string | null;
  invoice_id: string | null;
  charge_id: string | null;
  detail: Record<string, unknown>;
  created_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
}

type Result<T> = { data: T; error: null } | { data: null; error: string };

async function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<Result<T>> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { data: null, error: error.message };
  return { data: (data ?? []) as T, error: null };
}

export interface PendingModuleChange {
  id: string;
  effective_at: string;
  effective_competence: string;
  previous_monthly_cents: number;
  new_monthly_cents: number;
  current_monthly_cents: number;
  added: Array<{ module_id: string; name: string; price_cents: number }>;
  removed: Array<{ module_id: string; name: string; price_cents: number }>;
  locked: boolean;
}
export async function getPendingModuleChange(companyId: string): Promise<Result<PendingModuleChange | null>> {
  const r = await call<PendingModuleChange | unknown[]>("master_get_pending_module_change", { p_company_id: companyId });
  if (r.error !== null) return { data: null, error: r.error };
  // `call` troca null por [] (listas); aqui "sem alteração" é null
  return { data: Array.isArray(r.data) ? null : r.data, error: null };
}

export const listCompanyAccessStates = () => call<CompanyAccessRow[]>("master_list_company_access_states");
export const listInvoiceGateway = (invoiceId: string | null = null) =>
  call<InvoiceGatewayRow[]>("master_list_invoice_gateway", { p_invoice_id: invoiceId });
export const listBillingAnomalies = (onlyOpen: boolean) => call<BillingAnomaly[]>("master_list_billing_anomalies", { p_only_open: onlyOpen });

export async function resolveBillingAnomaly(id: string, note: string): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc("master_resolve_billing_anomaly", { p_anomaly_id: id, p_note: note });
  return { error: error?.message ?? null };
}

export const ANOMALY_KIND_LABEL: Record<string, string> = {
  value_mismatch: "Valor divergente",
  reference_mismatch: "Referência divergente",
  invoice_not_found: "Fatura não encontrada",
  unexpected_payment: "Pagamento inesperado",
  company_mismatch: "Empresa divergente",
  paid_void_invoice: "Pago em fatura anulada",
  duplicate_payment: "Pagamento duplicado",
  payment_not_found_in_asaas: "Pagamento não encontrado no gateway",
  payment_restored: "Cobrança restaurada",
  refund: "Estorno",
  chargeback: "Chargeback",
  dunning: "Negativação",
  charge_job_failed: "Falha ao gerar a cobrança",
};

export const CHARGE_STATUS_LABEL: Record<string, string> = {
  creating: "Gerando",
  pending: "Aguardando pagamento",
  confirmed: "Confirmada",
  received: "Recebida",
  overdue: "Vencida no gateway",
  failed: "Falhou (será retentada)",
  anomaly: "Em análise",
  deleted: "Excluída",
  refunded: "Estornada",
};

export const ACCESS_STATE_TEXT: Record<string, string> = {
  active: "Ativa",
  grace: "Carência",
  past_due: "Em atraso",
  pending_payment: "Aguardando pagamento (somente leitura)",
  restricted: "Restrita (somente leitura)",
  suspended: "Suspensa (somente leitura)",
  trial: "Período grátis",
  trial_expired: "Grátis encerrado (somente leitura)",
  trial_canceled: "Grátis cancelado (somente leitura)",
  canceled: "Cancelada (somente leitura)",
  unmanaged: "Sem registro comercial (liberada)",
};

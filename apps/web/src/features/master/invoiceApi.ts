import { supabase } from "../../lib/supabaseClient";
import type { InvoiceDetail, InvoiceRow, InvoiceStatus } from "../../lib/types";

// RPCs SECURITY DEFINER com assert_master_admin(). Nenhum valor financeiro é
// enviado pelo frontend: total, itens e vencimento são calculados no banco.

export async function listInvoices(filters: {
  companyId?: string;
  status?: InvoiceStatus | "";
  competence?: string | null;
}): Promise<{ data: InvoiceRow[]; error: string | null }> {
  const { data, error } = await supabase.rpc("master_list_invoices", {
    p_company_id: filters.companyId ?? null,
    p_status: filters.status || null,
    p_competence: filters.competence ?? null,
  });
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as InvoiceRow[], error: null };
}

export async function getInvoice(
  invoiceId: string,
): Promise<{ data: InvoiceDetail | null; error: string | null }> {
  const { data, error } = await supabase.rpc("master_get_invoice", { p_invoice_id: invoiceId });
  if (error) return { data: null, error: error.message };
  return { data: data as InvoiceDetail, error: null };
}

export async function generateInvoice(
  subscriptionId: string,
  competence: string,
): Promise<{ data: { invoice_id: string; created: boolean } | null; error: string | null }> {
  const { data, error } = await supabase.rpc("master_generate_invoice", {
    p_subscription_id: subscriptionId,
    p_competence: competence,
  });
  if (error) return { data: null, error: error.message };
  return { data: data as { invoice_id: string; created: boolean }, error: null };
}

export async function markInvoicePaid(
  invoiceId: string,
  paidAt: string | null,
): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc("master_mark_invoice_paid", {
    p_invoice_id: invoiceId,
    p_paid_at: paidAt,
  });
  return { error: error?.message ?? null };
}

export async function voidInvoice(
  invoiceId: string,
  reason: string | null,
): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc("master_void_invoice", {
    p_invoice_id: invoiceId,
    p_reason: reason,
  });
  return { error: error?.message ?? null };
}

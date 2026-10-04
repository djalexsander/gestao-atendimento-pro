import { supabase } from "../../lib/supabaseClient";
import { describeOrderError } from "../orders/ordersLogic";
import {
  toCents,
  type DisplayStatus,
  type ListParams,
  type PayableCategory,
  type PaymentMethodKey,
  type PayableEvent,
  type PayablePayload,
  type PayableRow,
  type PayablesSummary,
} from "./payablesLogic";

const LOAD_ERROR = "Não foi possível carregar as contas a pagar.";
const SAVE_ERROR = "Não foi possível salvar agora. Tente novamente.";
const PAGE = 30;
export const PAYABLES_PAGE = PAGE;

export type Result<T> = { data: T; error: null } | { data: null; error: string };

// Fonte de dados de Contas a pagar. Recebida por parâmetro para exercitar a tela com dados simulados.
// Toda regra (status, saldo, papéis) é do servidor: o navegador não envia status nem valor pago.
export interface PayablesSource {
  list(companyId: string, params: ListParams, offset: number): Promise<Result<{ rows: PayableRow[]; total: number; today: string }>>;
  summary(companyId: string, from: string, to: string): Promise<Result<PayablesSummary>>;
  create(companyId: string, payload: PayablePayload): Promise<Result<PayableRow | null>>;
  update(id: string, payload: PayablePayload): Promise<Result<null>>;
  pay(id: string, amount: number, method: PaymentMethodKey, paidOn: string, note: string | null): Promise<Result<null>>;
  cancel(id: string, reason: string | null): Promise<Result<null>>;
  history(companyId: string, id: string): Promise<Result<PayableEvent[]>>;
}

interface RawRow {
  id: string;
  supplier_name: string;
  description: string;
  category: PayableCategory;
  reference: string | null;
  document_number: string | null;
  notes: string | null;
  amount: number | string;
  paid_amount: number | string;
  balance: number | string;
  due_date: string;
  status: "pending" | "paid" | "cancelled";
  display_status: DisplayStatus;
  last_payment_method: PaymentMethodKey | null;
  last_paid_on: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  created_at: string;
  updated_at: string;
  created_by_name: string | null;
}

function toRow(r: RawRow): PayableRow {
  return {
    id: r.id,
    supplierName: r.supplier_name,
    description: r.description,
    category: r.category,
    reference: r.reference,
    documentNumber: r.document_number,
    notes: r.notes,
    amountCents: toCents(Number(r.amount)),
    paidCents: toCents(Number(r.paid_amount)),
    balanceCents: toCents(Number(r.balance)),
    dueDate: r.due_date,
    status: r.status,
    displayStatus: r.display_status,
    lastPaymentMethod: r.last_payment_method,
    lastPaidOn: r.last_paid_on,
    cancelledAt: r.cancelled_at,
    cancellationReason: r.cancellation_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    createdByName: r.created_by_name,
  };
}

function fail<T>(code: string | null | undefined, error: { code?: string | null; message?: string | null }, fallback: string): Result<T> {
  console.error("Falha em contas a pagar:", code ?? error.code);
  return { data: null, error: describeOrderError(error, fallback) };
}

export const supabasePayablesSource: PayablesSource = {
  async list(companyId, params, offset) {
    const { data, error } = await supabase.rpc("list_payables", {
      p_company_id: companyId,
      p_status: params.status,
      p_date_field: params.dateField,
      p_from: params.from,
      p_to: params.to,
      p_search: params.search,
      p_sort: params.sort,
      p_limit: PAGE,
      p_offset: offset,
    });
    if (error) return fail(null, error, LOAD_ERROR);
    const body = data as { total: number; today: string; rows: RawRow[] };
    return { data: { rows: body.rows.map(toRow), total: Number(body.total), today: body.today }, error: null };
  },

  async summary(companyId, from, to) {
    const { data, error } = await supabase.rpc("payables_summary", { p_company_id: companyId, p_from: from, p_to: to });
    if (error) return fail(null, error, LOAD_ERROR);
    const s = data as Record<string, number | string>;
    return {
      data: {
        openCents: toCents(Number(s.open_balance)),
        openCount: Number(s.open_count),
        dueTodayCents: toCents(Number(s.due_today_balance)),
        dueTodayCount: Number(s.due_today_count),
        overdueCents: toCents(Number(s.overdue_balance)),
        overdueCount: Number(s.overdue_count),
        paidPeriodCents: toCents(Number(s.paid)),
        paidPeriodCount: Number(s.paid_count),
      },
      error: null,
    };
  },

  async create(companyId, p) {
    const { error } = await supabase.rpc("create_payable", {
      p_company_id: companyId,
      p_supplier_name: p.supplierName,
      p_description: p.description,
      p_category: p.category,
      p_amount: p.amount,
      p_due_date: p.dueDate,
      p_reference: p.reference,
      p_document_number: p.documentNumber,
      p_notes: p.notes,
    });
    if (error) return fail(null, error, SAVE_ERROR);
    return { data: null, error: null };
  },

  async update(id, p) {
    const { error } = await supabase.rpc("update_payable", {
      p_payable_id: id,
      p_supplier_name: p.supplierName,
      p_description: p.description,
      p_category: p.category,
      p_amount: p.amount,
      p_due_date: p.dueDate,
      p_reference: p.reference,
      p_document_number: p.documentNumber,
      p_notes: p.notes,
    });
    if (error) return fail(null, error, SAVE_ERROR);
    return { data: null, error: null };
  },

  async pay(id, amount, method, paidOn, note) {
    const { error } = await supabase.rpc("register_payable_payment", {
      p_payable_id: id,
      p_amount: amount,
      p_payment_method: method,
      p_paid_on: paidOn,
      p_note: note,
    });
    if (error) return fail(null, error, "Não foi possível registrar o pagamento agora. Tente novamente.");
    return { data: null, error: null };
  },

  async cancel(id, reason) {
    const { error } = await supabase.rpc("cancel_payable", { p_payable_id: id, p_reason: reason });
    if (error) return fail(null, error, "Não foi possível cancelar agora. Tente novamente.");
    return { data: null, error: null };
  },

  async history(companyId, id) {
    const { data, error } = await supabase
      .from("accounts_payable_events")
      .select("id, event_type, amount, payment_method, paid_on, note, created_at, created_by")
      .eq("company_id", companyId)
      .eq("payable_id", id)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) return fail(null, error, LOAD_ERROR);
    const rows = (data ?? []) as Array<{
      id: string;
      event_type: PayableEvent["type"];
      amount: number | string | null;
      payment_method: PaymentMethodKey | null;
      paid_on: string | null;
      note: string | null;
      created_at: string;
      created_by: string;
    }>;
    const names = new Map<string, string>();
    const ids = Array.from(new Set(rows.map((r) => r.created_by)));
    if (ids.length > 0) {
      const { data: profiles } = await supabase.from("profiles").select("user_id, full_name").in("user_id", ids);
      for (const p of (profiles ?? []) as Array<{ user_id: string; full_name: string | null }>) if (p.full_name) names.set(p.user_id, p.full_name);
    }
    return {
      data: rows.map((r) => ({
        id: r.id,
        type: r.event_type,
        amountCents: r.amount === null ? null : toCents(Number(r.amount)),
        method: r.payment_method,
        paidOn: r.paid_on,
        note: r.note,
        createdAt: r.created_at,
        createdByName: names.get(r.created_by) ?? null,
      })),
      error: null,
    };
  },
};

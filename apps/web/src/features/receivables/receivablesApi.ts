import { supabase } from "../../lib/supabaseClient";
import { describeOrderError } from "../orders/ordersLogic";
import {
  toCents,
  type DisplayStatus,
  type ListParams,
  type PaymentMethodKey,
  type ReceivableEvent,
  type ReceivablePayload,
  type ReceivableRow,
  type ReceivablesSummary,
} from "./receivablesLogic";

const LOAD_ERROR = "Não foi possível carregar as contas a receber.";
const SAVE_ERROR = "Não foi possível salvar agora. Tente novamente.";
const PAGE = 30;
export const RECEIVABLES_PAGE = PAGE;

export type Result<T> = { data: T; error: null } | { data: null; error: string };

// Fonte de dados de Contas a receber. Recebida por parâmetro para exercitar a tela com dados simulados.
// Toda regra (status, saldo, papéis) é do servidor: o navegador não envia status nem valor recebido.
export interface ReceivablesSource {
  list(companyId: string, params: ListParams, offset: number): Promise<Result<{ rows: ReceivableRow[]; total: number; today: string }>>;
  summary(companyId: string, from: string, to: string): Promise<Result<ReceivablesSummary>>;
  create(companyId: string, payload: ReceivablePayload): Promise<Result<ReceivableRow | null>>;
  update(id: string, payload: ReceivablePayload): Promise<Result<null>>;
  receive(id: string, amount: number, method: PaymentMethodKey, paidOn: string, note: string | null): Promise<Result<null>>;
  cancel(id: string, reason: string | null): Promise<Result<null>>;
  history(companyId: string, id: string): Promise<Result<ReceivableEvent[]>>;
}

interface RawRow {
  id: string;
  customer_id: string | null;
  customer_name: string;
  description: string;
  reference: string | null;
  notes: string | null;
  amount: number | string;
  paid_amount: number | string;
  balance: number | string;
  due_date: string;
  status: "pending" | "paid" | "cancelled";
  display_status: DisplayStatus;
  payment_method: PaymentMethodKey | null;
  paid_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
  created_by_name: string | null;
}

function toRow(r: RawRow): ReceivableRow {
  return {
    id: r.id,
    customerId: r.customer_id,
    customerName: r.customer_name,
    description: r.description,
    reference: r.reference,
    notes: r.notes,
    amountCents: toCents(Number(r.amount)),
    paidCents: toCents(Number(r.paid_amount)),
    balanceCents: toCents(Number(r.balance)),
    dueDate: r.due_date,
    status: r.status,
    displayStatus: r.display_status,
    paymentMethod: r.payment_method,
    paidAt: r.paid_at,
    cancelledAt: r.cancelled_at,
    cancelReason: r.cancel_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    createdByName: r.created_by_name,
  };
}

function fail<T>(code: string | null | undefined, error: { code?: string | null; message?: string | null }, fallback: string): Result<T> {
  console.error("Falha em contas a receber:", code ?? error.code);
  return { data: null, error: describeOrderError(error, fallback) };
}

export const supabaseReceivablesSource: ReceivablesSource = {
  async list(companyId, params, offset) {
    const { data, error } = await supabase.rpc("list_receivables", {
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
    const { data, error } = await supabase.rpc("receivables_summary", { p_company_id: companyId, p_from: from, p_to: to });
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
        receivedCents: toCents(Number(s.received)),
        receivedCount: Number(s.received_count),
      },
      error: null,
    };
  },

  async create(companyId, p) {
    const { error } = await supabase.rpc("create_receivable", {
      p_company_id: companyId,
      p_customer_name: p.customerName,
      p_description: p.description,
      p_amount: p.amount,
      p_due_date: p.dueDate,
      p_reference: p.reference,
      p_notes: p.notes,
      p_customer_id: p.customerId,
    });
    if (error) return fail(null, error, SAVE_ERROR);
    return { data: null, error: null };
  },

  async update(id, p) {
    const { error } = await supabase.rpc("update_receivable", {
      p_receivable_id: id,
      p_customer_name: p.customerName,
      p_description: p.description,
      p_amount: p.amount,
      p_due_date: p.dueDate,
      p_reference: p.reference,
      p_notes: p.notes,
      p_customer_id: p.customerId,
    });
    if (error) return fail(null, error, SAVE_ERROR);
    return { data: null, error: null };
  },

  async receive(id, amount, method, paidOn, note) {
    const { error } = await supabase.rpc("register_receivable_payment", {
      p_receivable_id: id,
      p_amount: amount,
      p_payment_method: method,
      p_paid_on: paidOn,
      p_note: note,
    });
    if (error) return fail(null, error, "Não foi possível registrar o recebimento agora. Tente novamente.");
    return { data: null, error: null };
  },

  async cancel(id, reason) {
    const { error } = await supabase.rpc("cancel_receivable", { p_receivable_id: id, p_reason: reason });
    if (error) return fail(null, error, "Não foi possível cancelar agora. Tente novamente.");
    return { data: null, error: null };
  },

  async history(companyId, id) {
    const { data, error } = await supabase
      .from("accounts_receivable_events")
      .select("id, event_type, amount, payment_method, paid_on, note, created_at, created_by")
      .eq("company_id", companyId)
      .eq("receivable_id", id)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) return fail(null, error, LOAD_ERROR);
    const rows = (data ?? []) as Array<{
      id: string;
      event_type: ReceivableEvent["type"];
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

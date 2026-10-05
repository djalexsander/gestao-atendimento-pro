import { supabase } from "../../lib/supabaseClient";
import { describeOrderError } from "../orders/ordersLogic";
import type {
  CustomerDetail,
  CustomerFilters,
  CustomerOption,
  CustomerPayload,
  CustomerRow,
  CustomersSummary,
  CustomerType,
} from "./customersLogic";

const LOAD_ERROR = "Não foi possível carregar os clientes agora. Tente novamente.";
const SAVE_ERROR = "Não foi possível salvar o cliente agora. Tente novamente.";
export const CUSTOMERS_PAGE = 30;

export type Result<T> = { data: T; error: null } | { data: null; error: string };

// Fonte de dados de Clientes. Recebida por parâmetro para exercitar as telas com dados simulados. Toda
// regra (normalização, duplicidade, papéis, empresa) é do servidor: o navegador nunca decide permissão.
export interface CustomersSource {
  // owner/admin
  list(companyId: string, filters: CustomerFilters, offset: number): Promise<Result<{ rows: CustomerRow[]; total: number }>>;
  summary(companyId: string): Promise<Result<CustomersSummary>>;
  get(id: string): Promise<Result<CustomerDetail>>;
  create(companyId: string, payload: CustomerPayload): Promise<Result<null>>;
  update(id: string, payload: CustomerPayload): Promise<Result<null>>;
  setActive(id: string, active: boolean): Promise<Result<null>>;
  // todos os papéis operacionais (id, nome e final do telefone apenas)
  search(companyId: string, term: string): Promise<Result<CustomerOption[]>>;
  quickCreate(companyId: string, name: string, phone: string | null): Promise<Result<CustomerOption>>;
}

interface RawRow {
  id: string;
  customer_type: CustomerType;
  name: string;
  document: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  is_active: boolean;
  created_at: string;
  visits: number | string;
  last_visit_at: string | null;
  total_spent: number | string;
}

const toCents = (reais: number | string): number => Math.round(Number(reais) * 100);

function fail<T>(error: { code?: string | null; message?: string | null }, fallback: string): Result<T> {
  console.error("Falha em clientes:", error.code ?? "sem código"); // nunca registra dados do cliente
  return { data: null, error: describeOrderError(error, fallback) };
}

const payloadArgs = (p: CustomerPayload) => ({
  p_name: p.name,
  p_customer_type: p.type,
  p_document: p.document,
  p_phone: p.phone,
  p_whatsapp: p.whatsapp,
  p_email: p.email,
  p_birth_date: p.birthDate,
  p_notes: p.notes,
});

export const supabaseCustomersSource: CustomersSource = {
  async list(companyId, filters, offset) {
    const search = filters.search.trim();
    const { data, error } = await supabase.rpc("list_customers", {
      p_company_id: companyId,
      p_status: filters.status,
      p_type: filters.type,
      p_search: search === "" ? null : search,
      p_sort: filters.sort,
      p_limit: CUSTOMERS_PAGE,
      p_offset: offset,
    });
    if (error) return fail(error, LOAD_ERROR);
    const body = data as { total: number; rows: RawRow[] };
    return {
      data: {
        total: Number(body.total),
        rows: body.rows.map((r) => ({
          id: r.id,
          type: r.customer_type,
          name: r.name,
          document: r.document,
          phone: r.phone,
          whatsapp: r.whatsapp,
          email: r.email,
          isActive: r.is_active,
          createdAt: r.created_at,
          visits: Number(r.visits),
          lastVisitAt: r.last_visit_at,
          totalSpentCents: toCents(r.total_spent),
        })),
      },
      error: null,
    };
  },

  async summary(companyId) {
    const { data, error } = await supabase.rpc("customers_summary", { p_company_id: companyId });
    if (error) return fail(error, LOAD_ERROR);
    const s = data as Record<string, number>;
    return { data: { active: Number(s.active), inactive: Number(s.inactive), newThisMonth: Number(s.new_this_month), recentVisits: Number(s.recent_visits) }, error: null };
  },

  async get(id) {
    const { data, error } = await supabase.rpc("get_customer", { p_customer_id: id });
    if (error) return fail(error, LOAD_ERROR);
    const c = data as Record<string, string | number | null>;
    return {
      data: {
        id: c.id as string,
        type: c.customer_type as CustomerType,
        name: c.name as string,
        document: c.document as string | null,
        phone: c.phone as string | null,
        whatsapp: c.whatsapp as string | null,
        email: c.email as string | null,
        birthDate: c.birth_date as string | null,
        notes: c.notes as string | null,
        isActive: Boolean(c.is_active),
        createdAt: c.created_at as string,
        updatedAt: c.updated_at as string,
        createdByName: c.created_by_name as string | null,
        visits: Number(c.visits),
        lastVisitAt: c.last_visit_at as string | null,
        closedVisits: Number(c.closed_visits),
        totalSpentCents: toCents(c.total_spent as number),
        averageTicketCents: toCents(c.average_ticket as number),
        openReceivableCents: toCents(c.open_receivable_balance as number),
        openReceivableCount: Number(c.open_receivable_count),
      },
      error: null,
    };
  },

  async create(companyId, payload) {
    const { error } = await supabase.rpc("create_customer", { p_company_id: companyId, ...payloadArgs(payload) });
    if (error) return fail(error, SAVE_ERROR);
    return { data: null, error: null };
  },

  async update(id, payload) {
    const { error } = await supabase.rpc("update_customer", { p_customer_id: id, ...payloadArgs(payload) });
    if (error) return fail(error, SAVE_ERROR);
    return { data: null, error: null };
  },

  async setActive(id, active) {
    const { error } = await supabase.rpc("set_customer_active", { p_customer_id: id, p_active: active });
    if (error) return fail(error, SAVE_ERROR);
    return { data: null, error: null };
  },

  async search(companyId, term) {
    const { data, error } = await supabase.rpc("search_active_customers", { p_company_id: companyId, p_search: term });
    if (error) return fail(error, "Não foi possível buscar clientes agora.");
    const rows = data as Array<{ id: string; name: string; phone_last4: string | null }>;
    return { data: rows.map((r) => ({ id: r.id, name: r.name, phoneLast4: r.phone_last4 })), error: null };
  },

  async quickCreate(companyId, name, phone) {
    const { data, error } = await supabase.rpc("quick_create_customer", { p_company_id: companyId, p_name: name, p_phone: phone });
    if (error) return fail(error, SAVE_ERROR);
    const r = data as { id: string; name: string; phone_last4: string | null };
    return { data: { id: r.id, name: r.name, phoneLast4: r.phone_last4 }, error: null };
  },
};

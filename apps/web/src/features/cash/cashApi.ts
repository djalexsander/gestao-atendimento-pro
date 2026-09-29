import { supabase } from "../../lib/supabaseClient";
import { describeOrderError } from "../orders/ordersLogic";
import type { CashMovementRow, PaymentMethod, PaymentPayload } from "./cashLogic";

const LOAD_ERROR = "Não foi possível carregar o caixa agora. Tente novamente.";
const OPEN_ERROR = "Não foi possível abrir o caixa agora. Tente novamente.";
const CLOSE_CASH_ERROR = "Não foi possível fechar o caixa agora. Tente novamente.";
const CLOSE_ACCOUNT_ERROR = "Não foi possível fechar a conta agora. Tente novamente.";

// Código que o banco devolve quando falta caixa aberto (PT412, "Abra o caixa antes de receber").
export const NO_OPEN_CASH_CODE = "PT412";

export interface CashSession {
  id: string;
  companyId: string;
  openedBy: string;
  openedByName: string | null;
  openingAmount: number;
  status: "open" | "closed";
  openedAt: string;
  closedAt: string | null;
  closingNotes: string | null;
}

export type CloseAccountResult = { error: null } | { error: string; noOpenCash: boolean };

// Fonte de dados do caixa/financeiro. Recebida por parâmetro (a real, abaixo, é o padrão) para
// exercitar as telas com dados simulados. Mesmo padrão de features/orders/ordersApi.ts.
export interface CashSource {
  // Caixa aberto do PRÓPRIO usuário na empresa (a RLS já limita ao dele; owner/admin filtram por uid).
  getMyOpenCash(companyId: string, userId: string): Promise<{ data: CashSession | null; error: string | null }>;
  openCash(companyId: string, openingAmount: number): Promise<{ data: CashSession | null; error: string | null }>;
  closeCash(cashSessionId: string, notes: string | null): Promise<{ error: string | null }>;
  // Recebe e fecha a conta. Total, quitação e troco são validados no servidor.
  closeAccount(sessionId: string, payments: PaymentPayload[]): Promise<CloseAccountResult>;
  // Administrativo
  listCashSessions(companyId: string): Promise<{ data: CashSession[] | null; error: string | null }>;
  listMovements(cashSessionId: string): Promise<{ data: CashMovementRow[] | null; error: string | null }>;
}

interface CashRow {
  id: string;
  company_id: string;
  opened_by: string;
  opening_amount: number | string;
  status: "open" | "closed";
  opened_at: string;
  closed_at: string | null;
  closing_notes: string | null;
}

const CASH_COLUMNS = "id, company_id, opened_by, opening_amount, status, opened_at, closed_at, closing_notes";

function toCashSession(row: CashRow, names: Map<string, string>): CashSession {
  return {
    id: row.id,
    companyId: row.company_id,
    openedBy: row.opened_by,
    openedByName: names.get(row.opened_by) ?? null,
    openingAmount: Number(row.opening_amount),
    status: row.status,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    closingNotes: row.closing_notes,
  };
}

async function loadNames(userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = Array.from(new Set(userIds));
  if (unique.length === 0) return map;
  const { data } = await supabase.from("profiles").select("user_id, full_name").in("user_id", unique);
  for (const row of (data ?? []) as { user_id: string; full_name: string | null }[]) {
    if (row.full_name) map.set(row.user_id, row.full_name);
  }
  return map;
}

export const supabaseCashSource: CashSource = {
  async getMyOpenCash(companyId, userId) {
    const { data, error } = await supabase
      .from("cash_sessions")
      .select(CASH_COLUMNS)
      .eq("company_id", companyId)
      .eq("opened_by", userId)
      .eq("status", "open")
      .maybeSingle();
    if (error) {
      console.error("Falha ao carregar o caixa aberto:", error.code);
      return { data: null, error: LOAD_ERROR };
    }
    return { data: data ? toCashSession(data as CashRow, new Map()) : null, error: null };
  },

  async openCash(companyId, openingAmount) {
    const { data, error } = await supabase.rpc("open_cash_session", {
      p_company_id: companyId,
      p_opening_amount: openingAmount,
    });
    if (error) {
      console.error("Falha ao abrir o caixa:", error.code);
      return { data: null, error: describeOrderError(error, OPEN_ERROR) };
    }
    return { data: toCashSession(data as CashRow, new Map()), error: null };
  },

  async closeCash(cashSessionId, notes) {
    const { error } = await supabase.rpc("close_cash_session", { p_cash_session_id: cashSessionId, p_notes: notes });
    if (error) {
      console.error("Falha ao fechar o caixa:", error.code);
      return { error: describeOrderError(error, CLOSE_CASH_ERROR) };
    }
    return { error: null };
  },

  async closeAccount(sessionId, payments) {
    const { error } = await supabase.rpc("close_service_session", {
      p_service_session_id: sessionId,
      p_payments: payments,
    });
    if (error) {
      console.error("Falha ao fechar a conta:", error.code);
      return { error: describeOrderError(error, CLOSE_ACCOUNT_ERROR), noOpenCash: error.code === NO_OPEN_CASH_CODE };
    }
    return { error: null };
  },

  async listCashSessions(companyId) {
    const { data, error } = await supabase
      .from("cash_sessions")
      .select(CASH_COLUMNS)
      .eq("company_id", companyId)
      .order("opened_at", { ascending: false })
      .limit(50);
    if (error) {
      console.error("Falha ao listar os caixas:", error.code);
      return { data: null, error: LOAD_ERROR };
    }
    const rows = (data ?? []) as CashRow[];
    const names = await loadNames(rows.map((r) => r.opened_by));
    return { data: rows.map((r) => toCashSession(r, names)), error: null };
  },

  async listMovements(cashSessionId) {
    const { data, error } = await supabase
      .from("cash_movements")
      .select("id, payment_method, amount, description, created_at")
      .eq("cash_session_id", cashSessionId)
      .order("created_at", { ascending: false });
    if (error) {
      console.error("Falha ao listar os movimentos:", error.code);
      return { data: null, error: LOAD_ERROR };
    }
    const rows = (data ?? []) as { id: string; payment_method: PaymentMethod; amount: number | string; description: string; created_at: string }[];
    return {
      data: rows.map((r) => ({
        id: r.id,
        paymentMethod: r.payment_method,
        amount: Number(r.amount),
        description: r.description,
        createdAt: r.created_at,
      })),
      error: null,
    };
  },
};

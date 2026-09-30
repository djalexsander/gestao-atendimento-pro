import { supabase } from "../../lib/supabaseClient";
import { describeOrderError } from "../orders/ordersLogic";
import type { CashMovementRow, PaymentMethod, PaymentPayload } from "./cashLogic";

const LOAD_ERROR = "Não foi possível carregar o caixa agora. Tente novamente.";
const OPEN_ERROR = "Não foi possível abrir o caixa agora. Tente novamente.";
const CLOSE_CASH_ERROR = "Não foi possível fechar o caixa agora. Tente novamente.";
const CLOSE_ACCOUNT_ERROR = "Não foi possível fechar a conta agora. Tente novamente.";

// Código que o banco devolve quando falta caixa aberto (PT412, "Abra o caixa antes de receber").
export const NO_OPEN_CASH_CODE = "PT412";

// Vendas por forma de pagamento de um caixa (view cash_session_totals; valores aplicados, sem troco).
export interface CashTotals {
  cash: number;
  pix: number;
  debit: number;
  credit: number;
  other: number;
  total: number;
}

export interface CashSession {
  id: string;
  companyId: string;
  openedBy: string;
  openedByName: string | null;
  openingAmount: number;
  status: "open" | "closed";
  openedAt: string;
  closedAt: string | null;
  closedBy: string | null;
  closedByName: string | null;
  closingNotes: string | null;
  // Conferência (calculada no servidor). null em caixa aberto e em caixas fechados antes dela existir.
  closingCashAmount: number | null;
  cashDifference: number | null;
  // Só nas listagens administrativas.
  totals: CashTotals | null;
}

export interface CashHistoryFilters {
  status: "all" | "open" | "closed";
  operatorId: string | null;
  from: string | null; // yyyy-mm-dd (dia local, inclusivo)
  to: string | null; // yyyy-mm-dd (dia local, inclusivo)
}

export const EMPTY_CASH_FILTERS: CashHistoryFilters = { status: "all", operatorId: null, from: null, to: null };
export const CASH_HISTORY_PAGE = 30;

export type CloseAccountResult = { error: null } | { error: string; noOpenCash: boolean };

// Fonte de dados do caixa/financeiro. Recebida por parâmetro (a real, abaixo, é o padrão) para
// exercitar as telas com dados simulados. Mesmo padrão de features/orders/ordersApi.ts.
export interface CashSource {
  // Caixa aberto do PRÓPRIO usuário na empresa (a RLS já limita ao dele; owner/admin filtram por uid).
  getMyOpenCash(companyId: string, userId: string): Promise<{ data: CashSession | null; error: string | null }>;
  openCash(companyId: string, openingAmount: number): Promise<{ data: CashSession | null; error: string | null }>;
  // `countedAmount` = dinheiro contado na gaveta. Esperado e diferença são calculados no servidor.
  closeCash(cashSessionId: string, countedAmount: number, notes: string | null): Promise<{ error: string | null }>;
  // Recebe e fecha a conta. Total, quitação e troco são validados no servidor.
  closeAccount(sessionId: string, payments: PaymentPayload[]): Promise<CloseAccountResult>;
  // Administrativo
  // Mais recentes primeiro; `limit` cresce com "Carregar mais". hasMore = existe registro além do limite.
  listCashSessions(
    companyId: string,
    filters: CashHistoryFilters,
    limit: number,
  ): Promise<{ data: CashSession[] | null; hasMore: boolean; error: string | null }>;
  listCashOperators(companyId: string): Promise<{ data: { id: string; name: string }[]; error: string | null }>;
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
  closed_by: string | null;
  closing_notes: string | null;
  closing_cash_amount: number | string | null;
  cash_difference: number | string | null;
}

interface TotalsRow {
  cash_session_id: string;
  cash_total: number | string;
  pix_total: number | string;
  debit_total: number | string;
  credit_total: number | string;
  other_total: number | string;
  total_sold: number | string;
}

const CASH_COLUMNS =
  "id, company_id, opened_by, opening_amount, status, opened_at, closed_at, closed_by, closing_notes, closing_cash_amount, cash_difference";

const numOrNull = (value: number | string | null) => (value === null ? null : Number(value));

function toTotals(row: TotalsRow | undefined): CashTotals {
  return {
    cash: Number(row?.cash_total ?? 0),
    pix: Number(row?.pix_total ?? 0),
    debit: Number(row?.debit_total ?? 0),
    credit: Number(row?.credit_total ?? 0),
    other: Number(row?.other_total ?? 0),
    total: Number(row?.total_sold ?? 0),
  };
}

function toCashSession(row: CashRow, names: Map<string, string>, totals: CashTotals | null = null): CashSession {
  return {
    id: row.id,
    companyId: row.company_id,
    openedBy: row.opened_by,
    openedByName: names.get(row.opened_by) ?? null,
    openingAmount: Number(row.opening_amount),
    status: row.status,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    closedBy: row.closed_by,
    closedByName: row.closed_by ? (names.get(row.closed_by) ?? null) : null,
    closingNotes: row.closing_notes,
    closingCashAmount: numOrNull(row.closing_cash_amount),
    cashDifference: numOrNull(row.cash_difference),
    totals,
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

  async closeCash(cashSessionId, countedAmount, notes) {
    const { error } = await supabase.rpc("close_cash_session", {
      p_cash_session_id: cashSessionId,
      p_closing_cash_amount: countedAmount,
      p_notes: notes,
    });
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

  async listCashSessions(companyId, filters, limit) {
    let query = supabase.from("cash_sessions").select(CASH_COLUMNS).eq("company_id", companyId);
    if (filters.status !== "all") query = query.eq("status", filters.status);
    if (filters.operatorId) query = query.eq("opened_by", filters.operatorId);
    // Dia local -> instante (o navegador aplica o fuso): [from 00:00, to+1 00:00).
    if (filters.from) query = query.gte("opened_at", new Date(`${filters.from}T00:00:00`).toISOString());
    if (filters.to) {
      const end = new Date(`${filters.to}T00:00:00`);
      end.setDate(end.getDate() + 1);
      query = query.lt("opened_at", end.toISOString());
    }
    // Pede 1 a mais só para saber se há mais registros.
    const { data, error } = await query.order("opened_at", { ascending: false }).limit(limit + 1);
    if (error) {
      console.error("Falha ao listar os caixas:", error.code);
      return { data: null, hasMore: false, error: LOAD_ERROR };
    }
    const all = (data ?? []) as CashRow[];
    const rows = all.slice(0, limit);
    const ids = rows.map((r) => r.id);
    const [names, totalsResult] = await Promise.all([
      loadNames(rows.flatMap((r) => (r.closed_by ? [r.opened_by, r.closed_by] : [r.opened_by]))),
      ids.length
        ? supabase
            .from("cash_session_totals")
            .select("cash_session_id, cash_total, pix_total, debit_total, credit_total, other_total, total_sold")
            .in("cash_session_id", ids)
        : Promise.resolve({ data: [] as TotalsRow[], error: null }),
    ]);
    if (totalsResult.error) {
      console.error("Falha ao carregar os totais dos caixas:", totalsResult.error.code);
      return { data: null, hasMore: false, error: LOAD_ERROR };
    }
    const totalsById = new Map((totalsResult.data as TotalsRow[]).map((t) => [t.cash_session_id, t]));
    return {
      data: rows.map((r) => toCashSession(r, names, toTotals(totalsById.get(r.id)))),
      hasMore: all.length > limit,
      error: null,
    };
  },

  async listCashOperators(companyId) {
    const { data, error } = await supabase.from("cash_sessions").select("opened_by").eq("company_id", companyId).limit(1000);
    if (error) {
      console.error("Falha ao listar os operadores:", error.code);
      return { data: [], error: LOAD_ERROR };
    }
    const ids = Array.from(new Set((data ?? []).map((r) => (r as { opened_by: string }).opened_by)));
    const names = await loadNames(ids);
    return {
      data: ids.map((id) => ({ id, name: names.get(id) ?? "Operador" })).sort((x, y) => x.name.localeCompare(y.name, "pt-BR")),
      error: null,
    };
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

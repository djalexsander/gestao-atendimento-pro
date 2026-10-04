import { supabase } from "../../lib/supabaseClient";
import { describeOrderError } from "../orders/ordersLogic";
import type { ReportData, ReportPeriod } from "../reports/reportsLogic";
import { periodBoundsIso, type CashSessionRaw, type ClosedSessionRow, type FinancialRaw } from "./financialOverviewLogic";

const LOAD_ERROR = "Não foi possível carregar a visão financeira.";
const PAGE = 1000;
const MAX_SESSION_PAGES = 20; // até 20.000 contas fechadas para o gráfico/ticket; além disso marca como parcial
const MAX_CASH_SESSIONS = 300;
const CHUNK = 50;

// Fonte de dados da Visão financeira. Recebida por parâmetro para exercitar a tela com dados simulados.
export interface FinancialOverviewSource {
  load(companyId: string, period: ReportPeriod, previous: ReportPeriod | null): Promise<{ data: FinancialRaw | null; error: string | null }>;
}

async function rpcReport(companyId: string, period: ReportPeriod): Promise<ReportData> {
  const { data, error } = await supabase.rpc("report_period", {
    p_company_id: companyId,
    p_from: period.from,
    p_to: period.to,
    p_category_id: null,
    p_sector_id: null,
  });
  if (error) {
    console.error("Falha ao gerar a visão financeira (report_period):", error.code);
    throw new Error(describeOrderError(error, LOAD_ERROR));
  }
  return data as ReportData;
}

// Contas fechadas no período (só closed_at e total): alimenta o gráfico e o ticket médio.
async function loadClosedSessions(companyId: string, period: ReportPeriod): Promise<{ rows: ClosedSessionRow[]; truncated: boolean }> {
  const { start, end } = periodBoundsIso(period);
  const rows: ClosedSessionRow[] = [];
  for (let page = 0; page < MAX_SESSION_PAGES; page += 1) {
    const { data, error } = await supabase
      .from("service_sessions")
      .select("closed_at, total_amount")
      .eq("company_id", companyId)
      .eq("status", "closed")
      .gte("closed_at", start)
      .lt("closed_at", end)
      .order("closed_at", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) {
      console.error("Falha ao carregar as contas fechadas:", error.code);
      throw new Error(LOAD_ERROR);
    }
    const batch = (data ?? []) as Array<{ closed_at: string | null; total_amount: number | string | null }>;
    for (const r of batch) if (r.closed_at) rows.push({ closedAt: r.closed_at, total: Number(r.total_amount ?? 0) });
    if (batch.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

interface CashRow {
  id: string;
  opened_by: string;
  opened_at: string;
  closed_at: string | null;
  status: "open" | "closed";
  opening_amount: number | string;
  cash_difference: number | string | null;
}

interface TotalsRow {
  cash_session_id: string;
  cash_total: number | string;
  supply_total: number | string;
  withdrawal_total: number | string;
}

// Caixas abertos no período + todos os abertos agora, com vendas em dinheiro/suprimento/sangria
// (view cash_session_totals) e estornos em DINHEIRO (cash_movements 'refund' em dinheiro).
async function loadCashSessions(companyId: string, period: ReportPeriod): Promise<CashSessionRaw[]> {
  const { start, end } = periodBoundsIso(period);
  const { data, error } = await supabase
    .from("cash_sessions")
    .select("id, opened_by, opened_at, closed_at, status, opening_amount, cash_difference")
    .eq("company_id", companyId)
    .or(`status.eq.open,and(opened_at.gte.${start},opened_at.lt.${end})`)
    .order("opened_at", { ascending: false })
    .limit(MAX_CASH_SESSIONS);
  if (error) {
    console.error("Falha ao carregar os caixas:", error.code);
    throw new Error(LOAD_ERROR);
  }
  const sessions = (data ?? []) as CashRow[];
  if (sessions.length === 0) return [];

  const ids = sessions.map((s) => s.id);
  const totals = new Map<string, TotalsRow>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data: t, error: tErr } = await supabase
      .from("cash_session_totals")
      .select("cash_session_id, cash_total, supply_total, withdrawal_total")
      .in("cash_session_id", ids.slice(i, i + CHUNK));
    if (tErr) {
      console.error("Falha ao carregar os totais dos caixas:", tErr.code);
      throw new Error(LOAD_ERROR);
    }
    for (const row of (t ?? []) as TotalsRow[]) totals.set(row.cash_session_id, row);
  }

  // Estornos em dinheiro (poucos): do abertura do caixa mais antigo em diante, somados por caixa.
  const oldest = sessions.reduce((min, s) => (s.opened_at < min ? s.opened_at : min), sessions[0].opened_at);
  const { data: refunds, error: rErr } = await supabase
    .from("cash_movements")
    .select("cash_session_id, amount")
    .eq("company_id", companyId)
    .eq("movement_type", "refund")
    .eq("payment_method", "cash")
    .gte("created_at", oldest)
    .limit(5000);
  if (rErr) {
    console.error("Falha ao carregar os estornos em dinheiro:", rErr.code);
    throw new Error(LOAD_ERROR);
  }
  const cashRefund = new Map<string, number>();
  for (const r of (refunds ?? []) as Array<{ cash_session_id: string; amount: number | string }>) {
    cashRefund.set(r.cash_session_id, (cashRefund.get(r.cash_session_id) ?? 0) + Math.round(Number(r.amount) * 100));
  }

  const names = new Map<string, string>();
  const userIds = Array.from(new Set(sessions.map((s) => s.opened_by)));
  const { data: profiles } = await supabase.from("profiles").select("user_id, full_name").in("user_id", userIds);
  for (const p of (profiles ?? []) as Array<{ user_id: string; full_name: string | null }>) if (p.full_name) names.set(p.user_id, p.full_name);

  return sessions.map((s) => {
    const t = totals.get(s.id);
    return {
      id: s.id,
      operatorName: names.get(s.opened_by) ?? null,
      openedAt: s.opened_at,
      closedAt: s.closed_at,
      status: s.status,
      openingAmount: Number(s.opening_amount),
      cashSales: Number(t?.cash_total ?? 0),
      supply: Number(t?.supply_total ?? 0),
      withdrawal: Number(t?.withdrawal_total ?? 0),
      cashRefund: (cashRefund.get(s.id) ?? 0) / 100,
      cashDifference: s.cash_difference === null ? null : Number(s.cash_difference),
    };
  });
}

export const supabaseFinancialOverviewSource: FinancialOverviewSource = {
  async load(companyId, period, previous) {
    try {
      const [report, previousReport, closed, cashSessions] = await Promise.all([
        rpcReport(companyId, period),
        previous ? rpcReport(companyId, previous) : Promise.resolve(null),
        loadClosedSessions(companyId, period),
        loadCashSessions(companyId, period),
      ]);
      return {
        data: { report, previous: previousReport, closedSessions: closed.rows, sessionsTruncated: closed.truncated, cashSessions },
        error: null,
      };
    } catch (e) {
      return { data: null, error: e instanceof Error && e.message ? e.message : LOAD_ERROR };
    }
  },
};

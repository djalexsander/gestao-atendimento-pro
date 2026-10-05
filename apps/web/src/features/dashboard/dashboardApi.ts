import { supabase } from "../../lib/supabaseClient";
import { supabaseCustomersSource } from "../customers/customersApi";
import { supabaseFinancialOverviewSource } from "../financial/financialOverviewApi";
import { periodBoundsIso } from "../financial/financialOverviewLogic";
import { supabasePayablesSource } from "../payables/payablesApi";
import { supabaseProductionSource } from "../production/productionApi";
import { supabaseReceivablesSource } from "../receivables/receivablesApi";
import { addDays, type ReportPeriod } from "../reports/reportsLogic";
import { supabaseStockSource } from "../stock/stockApi";
import { summaryPeriod, type AttendanceCounts, type DashboardRaw, type Section } from "./dashboardLogic";

const SECTION_ERROR = "Não foi possível carregar esta seção.";

// O Dashboard NÃO consulta tabelas para calcular métricas: reaproveita as MESMAS fontes oficiais de cada módulo (Visão
// financeira, Contas a receber/pagar, Produção, Estoque, Clientes) e dispara tudo em paralelo, sem uma RPC por card e sem
// N+1. As únicas leituras novas são 3 CONTAGENS (head) de atendimentos abertos e de pedidos do período.
export interface DashboardSource {
  load(companyId: string, period: ReportPeriod, previous: ReportPeriod | null): Promise<DashboardRaw>;
}

async function section<T>(run: () => Promise<{ data: T | null; error: string | null }>): Promise<Section<T>> {
  try {
    const result = await run();
    if (result.error || result.data === null) return { ok: false, error: result.error ?? SECTION_ERROR };
    return { ok: true, data: result.data };
  } catch {
    return { ok: false, error: SECTION_ERROR };
  }
}

async function count(query: PromiseLike<{ count: number | null; error: { code?: string } | null }>): Promise<number> {
  const { count: n, error } = await query;
  if (error) {
    console.error("Falha em contagem do Dashboard:", error.code ?? "sem código");
    throw new Error(SECTION_ERROR);
  }
  return n ?? 0;
}

async function loadCounts(companyId: string, period: ReportPeriod): Promise<{ data: AttendanceCounts | null; error: string | null }> {
  const { start, end } = periodBoundsIso(period);
  try {
    const [openSessions, ordersInPeriod, cancelledOrdersInPeriod] = await Promise.all([
      count(supabase.from("service_sessions").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("status", "open")),
      count(supabase.from("service_orders").select("id", { count: "exact", head: true }).eq("company_id", companyId).gte("submitted_at", start).lt("submitted_at", end)),
      count(
        supabase.from("service_orders").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("status", "cancelled").gte("submitted_at", start).lt("submitted_at", end),
      ),
    ]);
    return { data: { openSessions, ordersInPeriod, cancelledOrdersInPeriod }, error: null };
  } catch {
    return { data: null, error: SECTION_ERROR };
  }
}

export const supabaseDashboardSource: DashboardSource = {
  async load(companyId, period, previous) {
    const summaryRange = summaryPeriod(period, addDays);
    const [financial, receivables, payables, production, stock, customers, counts] = await Promise.all([
      section(() => supabaseFinancialOverviewSource.load(companyId, period, previous)),
      section(() => supabaseReceivablesSource.summary(companyId, summaryRange.from, summaryRange.to)),
      section(() => supabasePayablesSource.summary(companyId, summaryRange.from, summaryRange.to)),
      section(async () => {
        const r = await supabaseProductionSource.loadQueue(companyId, null, 0);
        return { data: r.data ? { items: r.data.items, readyTotal: r.data.readyTotal, today: r.data.today } : null, error: r.error };
      }),
      section(() => supabaseStockSource.listControlled(companyId)),
      section(() => supabaseCustomersSource.summary(companyId)),
      section(() => loadCounts(companyId, period)),
    ]);
    return { financial, receivables, payables, production, stock, customers, counts };
  },
};

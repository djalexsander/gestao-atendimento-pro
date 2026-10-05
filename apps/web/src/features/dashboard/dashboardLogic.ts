import { buildOverview, expectedPhysicalCents, toCents, type FinancialOverviewModel, type FinancialRaw } from "../financial/financialOverviewLogic";
import type { CustomersSummary } from "../customers/customersLogic";
import type { PayablesSummary } from "../payables/payablesLogic";
import type { ProductionItem } from "../production/productionLogic";
import type { ReceivablesSummary } from "../receivables/receivablesLogic";
import type { ReportPeriod } from "../reports/reportsLogic";
import { countByStatus, type StockRow } from "../stock/stockLogic";

// Regras PURAS do Dashboard (sem React, sem Supabase). O Dashboard NÃO tem regra própria: vende, recebe, caixa, ticket,
// formas de pagamento, produtos e série do gráfico vêm de buildOverview (a MESMA da Visão financeira); receber/pagar de
// receivables_summary/payables_summary; produção da fila oficial; estoque da regra oficial (stockStatus); clientes de
// customers_summary. NÃO existe "entradas − saídas": contas a receber/pagar são módulos manuais SEM vínculo com as vendas
// (nenhum service_payments é criado ao receber uma conta), então somar "vendas recebidas" com "contas recebidas" pode contar
// duas vezes o mesmo dinheiro (venda a prazo lançada nos dois lugares). Cada fonte é mostrada SEPARADA, sem resultado líquido.
// Aqui só se monta o que a tela mostra e se decide o que "precisa de atenção". Dinheiro em CENTAVOS.

// Cada seção carrega e falha sozinha: uma seção secundária fora do ar não derruba o painel, mas o erro aparece nela.
export type Section<T> = { ok: true; data: T } | { ok: false; error: string };

export interface AttendanceCounts {
  openSessions: number; // atendimentos abertos AGORA
  ordersInPeriod: number; // pedidos enviados no período
  cancelledOrdersInPeriod: number; // pedidos cancelados (status cancelled) enviados no período
}

export interface ProductionNow {
  pending: number;
  preparing: number;
  ready: number; // prontos de HOJE
  stalePending: number; // pendentes de dias anteriores
}

export interface DashboardRaw {
  financial: Section<FinancialRaw>;
  receivables: Section<ReceivablesSummary>;
  payables: Section<PayablesSummary>;
  production: Section<{ items: ProductionItem[]; readyTotal: number; today: string }>;
  stock: Section<StockRow[]>;
  customers: Section<CustomersSummary>;
  counts: Section<AttendanceCounts>;
}

export interface CashNow {
  openCount: number;
  openingCents: number;
  cashSalesCents: number;
  supplyCents: number;
  withdrawalCents: number;
  cashRefundCents: number;
  expectedCents: number; // fórmula oficial: abertura + vendas em dinheiro + suprimentos - sangrias - estornos em dinheiro
}

export interface Alert {
  key: string;
  level: "danger" | "warn";
  text: string;
  to: string;
}

export interface DashboardModel {
  period: ReportPeriod;
  overview: Section<FinancialOverviewModel>;
  cash: Section<CashNow>;
  receivables: Section<ReceivablesSummary>;
  payables: Section<PayablesSummary>;
  attendance: Section<{ open: number; closed: number; soldCents: number; ticketCents: number | null }>;
  orders: Section<{ total: number; itemsSold: number; cancelledOrders: number; cancelledItems: number; cancelledCents: number }>;
  production: Section<ProductionNow & { avgMinutes: number | null }>;
  stock: Section<{ low: number; out: number; alerts: number; worst: Array<{ name: string; quantity: number; status: "low" | "out" }> }>;
  customers: Section<CustomersSummary>;
  alerts: Alert[];
  allEmpty: boolean;
}

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export function buildCashNow(raw: FinancialRaw): CashNow {
  const open = raw.cashSessions.filter((s) => s.status === "open");
  const sum = (pick: (s: (typeof open)[number]) => number) => open.reduce((acc, s) => acc + toCents(pick(s)), 0);
  return {
    openCount: open.length,
    openingCents: sum((s) => s.openingAmount),
    cashSalesCents: sum((s) => s.cashSales),
    supplyCents: sum((s) => s.supply),
    withdrawalCents: sum((s) => s.withdrawal),
    cashRefundCents: sum((s) => s.cashRefund),
    expectedCents: open.reduce((acc, s) => acc + expectedPhysicalCents(s), 0),
  };
}

export function buildProductionNow(items: ProductionItem[], readyTotal: number, today: string): ProductionNow {
  const pending = items.filter((i) => i.status === "pending");
  return {
    pending: pending.length,
    preparing: items.filter((i) => i.status === "preparing").length,
    ready: readyTotal,
    stalePending: pending.filter((i) => i.submittedDate < today).length,
  };
}

export function buildAlerts(m: Pick<DashboardModel, "receivables" | "payables" | "stock" | "production">): Alert[] {
  const alerts: Alert[] = [];
  if (m.receivables.ok && m.receivables.data.overdueCount > 0) {
    alerts.push({ key: "rec", level: "danger", text: `${m.receivables.data.overdueCount} ${m.receivables.data.overdueCount === 1 ? "conta a receber atrasada" : "contas a receber atrasadas"}`, to: "/app/financeiro/contas-a-receber" });
  }
  if (m.payables.ok && m.payables.data.overdueCount > 0) {
    alerts.push({ key: "pay", level: "danger", text: `${m.payables.data.overdueCount} ${m.payables.data.overdueCount === 1 ? "conta a pagar atrasada" : "contas a pagar atrasadas"}`, to: "/app/financeiro/contas-a-pagar" });
  }
  if (m.payables.ok && m.payables.data.dueTodayCount > 0) {
    alerts.push({ key: "pay-today", level: "warn", text: `${m.payables.data.dueTodayCount} ${m.payables.data.dueTodayCount === 1 ? "conta a pagar vence hoje" : "contas a pagar vencem hoje"}`, to: "/app/financeiro/contas-a-pagar" });
  }
  if (m.receivables.ok && m.receivables.data.dueTodayCount > 0) {
    alerts.push({ key: "rec-today", level: "warn", text: `${m.receivables.data.dueTodayCount} ${m.receivables.data.dueTodayCount === 1 ? "conta a receber vence hoje" : "contas a receber vencem hoje"}`, to: "/app/financeiro/contas-a-receber" });
  }
  if (m.stock.ok && m.stock.data.out > 0) alerts.push({ key: "stock-out", level: "danger", text: `${m.stock.data.out} ${m.stock.data.out === 1 ? "produto indisponível" : "produtos indisponíveis"} por estoque`, to: "/app/cadastros/estoque" });
  if (m.stock.ok && m.stock.data.low > 0) alerts.push({ key: "stock-low", level: "warn", text: `${m.stock.data.low} ${m.stock.data.low === 1 ? "produto com estoque baixo" : "produtos com estoque baixo"}`, to: "/app/cadastros/estoque" });
  if (m.production.ok && m.production.data.stalePending > 0) {
    alerts.push({ key: "prod-stale", level: "warn", text: `${m.production.data.stalePending} ${m.production.data.stalePending === 1 ? "item pendente na produção é de dias anteriores" : "itens pendentes na produção são de dias anteriores"}`, to: "/operacional/producao" });
  }
  return alerts;
}

export function buildDashboard(raw: DashboardRaw, period: ReportPeriod): DashboardModel {
  const overview: DashboardModel["overview"] = raw.financial.ok ? { ok: true, data: buildOverview(raw.financial.data, period) } : fail(raw.financial.error);
  const cash: DashboardModel["cash"] = raw.financial.ok ? { ok: true, data: buildCashNow(raw.financial.data) } : fail(raw.financial.error);

  let attendance: DashboardModel["attendance"];
  if (overview.ok && raw.counts.ok) {
    attendance = { ok: true, data: { open: raw.counts.data.openSessions, closed: overview.data.sessionsClosed, soldCents: overview.data.sales.effectiveCents, ticketCents: overview.data.ticket.cents } };
  } else attendance = fail(!overview.ok ? overview.error : (raw.counts as { error: string }).error);

  let orders: DashboardModel["orders"];
  if (overview.ok && raw.counts.ok) {
    orders = {
      ok: true,
      data: {
        total: raw.counts.data.ordersInPeriod,
        itemsSold: overview.data.itemsSold,
        cancelledOrders: raw.counts.data.cancelledOrdersInPeriod,
        cancelledItems: overview.data.sales.cancelledQuantity,
        cancelledCents: overview.data.sales.cancelledCents,
      },
    };
  } else orders = fail(!overview.ok ? overview.error : (raw.counts as { error: string }).error);

  let production: DashboardModel["production"];
  if (raw.production.ok) {
    const avg = raw.financial.ok ? raw.financial.data.report.production.avg_minutes : null;
    production = { ok: true, data: { ...buildProductionNow(raw.production.data.items, raw.production.data.readyTotal, raw.production.data.today), avgMinutes: avg } };
  } else production = fail(raw.production.error);

  let stock: DashboardModel["stock"];
  if (raw.stock.ok) {
    const counts = countByStatus(raw.stock.data);
    const worst = raw.stock.data
      .filter((r) => r.is_active && r.stock_quantity <= r.minimum_stock_quantity)
      .sort((a, b) => a.stock_quantity - b.stock_quantity || a.name.localeCompare(b.name, "pt-BR"))
      .slice(0, 4)
      .map((r) => ({ name: r.name, quantity: r.stock_quantity, status: (r.stock_quantity <= 0 ? "out" : "low") as "low" | "out" }));
    stock = { ok: true, data: { low: counts.low, out: counts.out, alerts: counts.low + counts.out, worst } };
  } else stock = fail(raw.stock.error);

  const partial = { receivables: raw.receivables, payables: raw.payables, stock, production };
  const model: DashboardModel = {
    period,
    overview,
    cash,
    receivables: raw.receivables,
    payables: raw.payables,
    attendance,
    orders,
    production,
    stock,
    customers: raw.customers,
    alerts: buildAlerts(partial),
    allEmpty: false,
  };
  model.allEmpty =
    overview.ok &&
    overview.data.empty &&
    raw.receivables.ok &&
    raw.receivables.data.openCount === 0 &&
    raw.payables.ok &&
    raw.payables.data.openCount === 0 &&
    raw.counts.ok &&
    raw.counts.data.ordersInPeriod === 0 &&
    raw.counts.data.openSessions === 0;
  return model;
}

export const SHORTCUTS: Array<{ label: string; to: string; hint: string }> = [
  { label: "Abrir atendimento", to: "/operacional/caixa", hint: "Comandas e mesas" },
  { label: "Caixa", to: "/app/financeiro/caixa", hint: "Caixas e conferência" },
  { label: "Contas a receber", to: "/app/financeiro/contas-a-receber", hint: "Cobranças em aberto" },
  { label: "Contas a pagar", to: "/app/financeiro/contas-a-pagar", hint: "Compromissos" },
  { label: "Clientes", to: "/app/cadastros/clientes", hint: "Cadastro" },
  { label: "Produção", to: "/operacional/producao", hint: "Fila da cozinha" },
  { label: "Estoque", to: "/app/cadastros/estoque", hint: "Alertas e entradas" },
];

// Recebimento/pagamento são limitados a 366 dias nas RPCs de receber/pagar: período maior usa os últimos 366 dias.
export function summaryPeriod(period: ReportPeriod, addDays: (iso: string, n: number) => string): ReportPeriod {
  const earliest = addDays(period.to, -365);
  return period.from < earliest ? { from: earliest, to: period.to } : period;
}

import {
  addDays,
  formatDateBR,
  METHOD_LABEL,
  periodLabel,
  validatePeriod,
  type PaymentMethodKey,
  type ReportData,
  type ReportPeriod,
} from "../reports/reportsLogic";

// Regras PURAS da Visão financeira (sem React, sem Supabase). Os números de venda, recebimento,
// estorno, cancelamento e produtos vêm prontos do servidor (report_period, a mesma fonte dos
// Relatórios); aqui só há períodos, comparativo, série do gráfico, saldo físico do caixa e a
// montagem do que a tela mostra. Todo dinheiro é trabalhado em CENTAVOS inteiros.
//
// Conceitos (nunca somados entre si):
//   VENDA          = total das contas FECHADAS no período (service_sessions.total_amount, já sem os itens
//                    cancelados antes do fechamento). Original = vendido + cancelado.
//   RECEBIMENTO    = pagamentos reais (service_payments) criados no período, por forma.
//   CANCELAMENTO   = valor dos itens cancelados em contas fechadas no período (reduz a venda, não é devolução).
//   ESTORNO        = dinheiro devolvido depois do pagamento (service_refunds); nunca reduz a venda original.
//   CAIXA          = abertura + vendas em dinheiro + suprimentos - sangrias - estornos em dinheiro.

export type FinancialPeriodKey = "today" | "yesterday" | "week" | "month" | "prev_month" | "custom";

export const FINANCIAL_PRESETS: FinancialPeriodKey[] = ["today", "yesterday", "week", "month", "prev_month", "custom"];

export const FINANCIAL_PRESET_LABEL: Record<FinancialPeriodKey, string> = {
  today: "Hoje",
  yesterday: "Ontem",
  week: "Últimos 7 dias",
  month: "Este mês",
  prev_month: "Mês anterior",
  custom: "Período",
};

export const toCents = (reais: number): number => Math.round(reais * 100);

// --- Períodos e comparativo (dias civis de America/Sao_Paulo) ----------------------------------

function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

function firstOfPreviousMonth(isoDate: string): { year: number; month: number } {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

const pad = (n: number) => String(n).padStart(2, "0");

export function financialPeriod(key: FinancialPeriodKey, today: string, custom: ReportPeriod): ReportPeriod {
  if (key === "custom") return custom;
  if (key === "today") return { from: today, to: today };
  if (key === "yesterday") {
    const y = addDays(today, -1);
    return { from: y, to: y };
  }
  if (key === "week") return { from: addDays(today, -6), to: today };
  if (key === "month") return { from: `${today.slice(0, 8)}01`, to: today };
  const prev = firstOfPreviousMonth(today);
  return { from: `${prev.year}-${pad(prev.month)}-01`, to: `${prev.year}-${pad(prev.month)}-${pad(daysInMonth(prev.year, prev.month))}` };
}

export function periodDays(period: ReportPeriod): number {
  return Math.round((Date.parse(period.to) - Date.parse(period.from)) / 86400000) + 1;
}

// Regra única do comparativo:
//   Este mês      -> mês anterior até o MESMO dia do mês (período equivalente);
//   Mês anterior  -> o mês completo antes dele;
//   demais        -> o período imediatamente anterior, com o mesmo número de dias
//                    (Hoje -> Ontem, Ontem -> anteontem, 7 dias -> 7 dias anteriores).
export function comparisonPeriod(key: FinancialPeriodKey, period: ReportPeriod): ReportPeriod {
  if (key === "month") {
    const prev = firstOfPreviousMonth(period.from);
    const elapsed = periodDays(period);
    const day = Math.min(elapsed, daysInMonth(prev.year, prev.month));
    return { from: `${prev.year}-${pad(prev.month)}-01`, to: `${prev.year}-${pad(prev.month)}-${pad(day)}` };
  }
  if (key === "prev_month") {
    const prev = firstOfPreviousMonth(period.from);
    return { from: `${prev.year}-${pad(prev.month)}-01`, to: `${prev.year}-${pad(prev.month)}-${pad(daysInMonth(prev.year, prev.month))}` };
  }
  const days = periodDays(period);
  return { from: addDays(period.from, -days), to: addDays(period.from, -1) };
}

export function comparisonLabel(key: FinancialPeriodKey, previous: ReportPeriod): string {
  if (key === "today") return "ontem";
  if (previous.from === previous.to) return formatDateBR(previous.from);
  return periodLabel(previous);
}

// Período válido para consultar (mesma regra do servidor: máx. 366 dias).
export function financialPeriodProblem(period: ReportPeriod): string | null {
  return validatePeriod(period);
}

// Variação em % com 1 casa; null quando não há base de comparação (anterior = 0).
export function percentChange(currentCents: number, previousCents: number): number | null {
  if (previousCents <= 0) return null;
  return Math.round(((currentCents - previousCents) / previousCents) * 1000) / 10;
}

export function formatPercentChange(pct: number | null): string {
  if (pct === null) return "Sem base de comparação";
  const text = Math.abs(pct).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (pct === 0) return "0,0%";
  return `${pct > 0 ? "+" : "-"}${text}%`;
}

// --- Fuso: America/Sao_Paulo --------------------------------------------------------------------

const SP = "America/Sao_Paulo";
const spFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: SP,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

export function spDateAndHour(instant: string | number | Date): { date: string; hour: number } {
  const parts = spFormat.formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

// Instante (ms) em que o dia civil `date` começa em São Paulo (considera horário de verão histórico).
export function spDayStartMs(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  for (const offset of [3, 2, 4]) {
    const ms = Date.UTC(y, m - 1, d, offset);
    const at = spDateAndHour(ms);
    if (at.date === date && at.hour === 0) return ms;
  }
  return Date.UTC(y, m - 1, d, 3);
}

// Limites [início, fim) do período como ISO (para filtrar colunas timestamptz).
export function periodBoundsIso(period: ReportPeriod): { start: string; end: string } {
  return {
    start: new Date(spDayStartMs(period.from)).toISOString(),
    end: new Date(spDayStartMs(addDays(period.to, 1))).toISOString(),
  };
}

// --- Dados crus (o que a camada de API entrega) -------------------------------------------------

// Conta fechada no período (só o que o gráfico e o ticket precisam).
export interface ClosedSessionRow {
  closedAt: string;
  total: number; // reais
}

// Um caixa, com os movimentos já agregados no servidor (view cash_session_totals) e os estornos em dinheiro.
export interface CashSessionRaw {
  id: string;
  operatorName: string | null;
  openedAt: string;
  closedAt: string | null;
  status: "open" | "closed";
  openingAmount: number;
  cashSales: number; // vendas em dinheiro
  supply: number;
  withdrawal: number;
  cashRefund: number; // estornos pagos em DINHEIRO por este caixa
  cashDifference: number | null; // conferência do fechamento (contado - esperado)
}

export interface FinancialRaw {
  report: ReportData;
  previous: ReportData | null;
  closedSessions: ClosedSessionRow[];
  sessionsTruncated: boolean;
  cashSessions: CashSessionRaw[]; // abertos no período + todos os abertos agora
}

// --- Caixa --------------------------------------------------------------------------------------

// Fórmula já estabelecida (espelha cash_session_physical_cash do servidor e cashLogic.netCash).
export function expectedPhysicalCents(c: CashSessionRaw): number {
  return toCents(c.openingAmount) + toCents(c.cashSales) + toCents(c.supply) - toCents(c.withdrawal) - toCents(c.cashRefund);
}

export interface OpenCashView {
  id: string;
  operatorName: string | null;
  openedAt: string;
  openingCents: number;
  expectedCents: number;
}

export interface CashOverview {
  openCount: number; // caixas abertos AGORA (qualquer data de abertura)
  closedCount: number; // dos abertos no período, quantos já fecharam
  openingCents: number;
  cashSalesCents: number;
  supplyCents: number;
  withdrawalCents: number;
  cashRefundCents: number;
  expectedCents: number;
  closings: number; // fechamentos (caixas do período já fechados)
  withDifference: number;
  shortageCents: number; // faltas (positivo)
  surplusCents: number; // sobras (positivo)
  openCashes: OpenCashView[];
  hasMovement: boolean;
}

export function buildCashOverview(sessions: CashSessionRaw[], period: ReportPeriod): CashOverview {
  const { start, end } = periodBoundsIso(period);
  const inPeriod = sessions.filter((s) => s.openedAt >= start && s.openedAt < end);
  const sum = (pick: (s: CashSessionRaw) => number) => inPeriod.reduce((acc, s) => acc + pick(s), 0);
  const closed = inPeriod.filter((s) => s.status === "closed");
  const openingCents = sum((s) => toCents(s.openingAmount));
  const cashSalesCents = sum((s) => toCents(s.cashSales));
  const supplyCents = sum((s) => toCents(s.supply));
  const withdrawalCents = sum((s) => toCents(s.withdrawal));
  const cashRefundCents = sum((s) => toCents(s.cashRefund));
  let shortageCents = 0;
  let surplusCents = 0;
  let withDifference = 0;
  for (const s of closed) {
    if (s.cashDifference === null || s.cashDifference === 0) continue;
    withDifference += 1;
    const diff = toCents(s.cashDifference);
    if (diff < 0) shortageCents += -diff;
    else surplusCents += diff;
  }
  const openCashes = sessions
    .filter((s) => s.status === "open")
    .sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1))
    .map((s) => ({
      id: s.id,
      operatorName: s.operatorName,
      openedAt: s.openedAt,
      openingCents: toCents(s.openingAmount),
      expectedCents: expectedPhysicalCents(s),
    }));
  return {
    openCount: openCashes.length,
    closedCount: closed.length,
    openingCents,
    cashSalesCents,
    supplyCents,
    withdrawalCents,
    cashRefundCents,
    expectedCents: openingCents + cashSalesCents + supplyCents - withdrawalCents - cashRefundCents,
    closings: closed.length,
    withDifference,
    shortageCents,
    surplusCents,
    openCashes,
    hasMovement: inPeriod.length > 0,
  };
}

// --- Série do gráfico ---------------------------------------------------------------------------

export interface SeriesPoint {
  key: string; // "14" (hora) ou "2026-10-04" (dia)
  label: string; // "14h" ou "04/10"
  cents: number;
}

export interface SalesSeries {
  granularity: "hour" | "day";
  points: SeriesPoint[];
  maxCents: number;
}

// Hoje/Ontem: vendas por hora (24 barras); demais períodos: por dia. Venda = total da conta no
// horário de FECHAMENTO, em America/Sao_Paulo.
export function buildSalesSeries(rows: ClosedSessionRow[], period: ReportPeriod): SalesSeries {
  const granularity = period.from === period.to ? "hour" : "day";
  const buckets = new Map<string, number>();
  for (const row of rows) {
    const at = spDateAndHour(row.closedAt);
    if (at.date < period.from || at.date > period.to) continue;
    const key = granularity === "hour" ? String(at.hour) : at.date;
    buckets.set(key, (buckets.get(key) ?? 0) + toCents(row.total));
  }
  const points: SeriesPoint[] = [];
  if (granularity === "hour") {
    for (let h = 0; h < 24; h += 1) points.push({ key: String(h), label: `${h}h`, cents: buckets.get(String(h)) ?? 0 });
  } else {
    for (let d = period.from; d <= period.to; d = addDays(d, 1)) {
      points.push({ key: d, label: `${d.slice(8, 10)}/${d.slice(5, 7)}`, cents: buckets.get(d) ?? 0 });
    }
  }
  return { granularity, points, maxCents: points.reduce((m, p) => Math.max(m, p.cents), 0) };
}

// --- Modelo da tela -----------------------------------------------------------------------------

export interface Delta {
  pct: number | null;
  label: string; // "+12,4%" ou "Sem base de comparação"
  direction: "up" | "down" | "flat" | "none";
}

function delta(current: number, previous: number | null): Delta | null {
  if (previous === null) return null;
  const pct = percentChange(current, previous);
  if (pct === null) return { pct: null, label: formatPercentChange(null), direction: "none" };
  return { pct, label: formatPercentChange(pct), direction: pct > 0 ? "up" : pct < 0 ? "down" : "flat" };
}

export interface MethodView {
  method: PaymentMethodKey;
  label: string;
  paidCents: number;
  refundedCents: number;
  sharePct: number | null; // % do total recebido
}

export interface FinancialOverviewModel {
  period: ReportPeriod;
  sales: {
    originalCents: number;
    cancelledCents: number;
    effectiveCents: number;
    cancelledQuantity: number;
    breakdownAvailable: boolean; // false se a lista de produtos do servidor foi truncada
    delta: Delta | null;
  };
  received: { totalCents: number; delta: Delta | null; methods: MethodView[] };
  refunds: { totalCents: number; count: number; byMethod: Array<{ method: PaymentMethodKey; label: string; cents: number }> };
  netReceived: { cents: number; delta: Delta | null };
  ticket: { cents: number | null; basis: number }; // basis = contas fechadas COM venda
  sessionsClosed: number;
  itemsSold: number;
  topProducts: Array<{ name: string; quantity: number; valueCents: number }>;
  cash: CashOverview;
  series: SalesSeries;
  seriesPartial: boolean;
  empty: boolean;
}

const sumReceived = (r: ReportData) => r.methods.reduce((acc, m) => acc + toCents(m.paid), 0);

export function buildOverview(raw: FinancialRaw, period: ReportPeriod): FinancialOverviewModel {
  const { report, previous } = raw;
  const effectiveCents = toCents(report.sales.gross);
  const productsTruncated = report.products.length >= 500;
  const cancelledCents = report.products.reduce((acc, p) => acc + toCents(p.cancelled_value), 0);
  const cancelledQuantity = report.products.reduce((acc, p) => acc + p.cancelled_quantity, 0);

  const receivedCents = sumReceived(report);
  const refundTotalCents = toCents(report.refunds.total);
  const netCents = receivedCents - refundTotalCents;

  const methods: MethodView[] = report.methods.map((m) => ({
    method: m.method,
    label: METHOD_LABEL[m.method],
    paidCents: toCents(m.paid),
    refundedCents: toCents(m.refunded),
    sharePct: receivedCents > 0 ? Math.round((toCents(m.paid) / receivedCents) * 1000) / 10 : null,
  }));

  const prevEffective = previous ? toCents(previous.sales.gross) : null;
  const prevReceived = previous ? sumReceived(previous) : null;
  const prevNet = previous && prevReceived !== null ? prevReceived - toCents(previous.refunds.total) : null;

  // Ticket médio = vendido / contas fechadas COM venda (conta zerada/teste fica fora). Só é confiável
  // se a lista de contas não foi truncada.
  const withSale = raw.closedSessions.filter((s) => toCents(s.total) > 0);
  const ticketBasis = withSale.length;
  const ticketCents =
    raw.sessionsTruncated || ticketBasis === 0 ? null : Math.round(withSale.reduce((acc, s) => acc + toCents(s.total), 0) / ticketBasis);

  const cash = buildCashOverview(raw.cashSessions, period);

  const model: FinancialOverviewModel = {
    period,
    sales: {
      originalCents: effectiveCents + cancelledCents,
      cancelledCents,
      effectiveCents,
      cancelledQuantity,
      breakdownAvailable: !productsTruncated,
      delta: delta(effectiveCents, prevEffective),
    },
    received: { totalCents: receivedCents, delta: delta(receivedCents, prevReceived), methods },
    refunds: {
      totalCents: refundTotalCents,
      count: report.refunds.count,
      byMethod: report.methods.filter((m) => toCents(m.refunded) > 0).map((m) => ({ method: m.method, label: METHOD_LABEL[m.method], cents: toCents(m.refunded) })),
    },
    netReceived: { cents: netCents, delta: delta(netCents, prevNet) },
    ticket: { cents: ticketCents, basis: ticketBasis },
    sessionsClosed: report.sales.sessions,
    itemsSold: report.sales.items_sold,
    topProducts: report.products
      .filter((p) => p.quantity_valid > 0)
      .slice(0, 5)
      .map((p) => ({ name: p.name, quantity: p.quantity_valid, valueCents: toCents(p.value_net) })),
    cash,
    series: buildSalesSeries(raw.closedSessions, period),
    seriesPartial: raw.sessionsTruncated,
    empty: false,
  };
  model.empty =
    effectiveCents === 0 && receivedCents === 0 && refundTotalCents === 0 && cancelledCents === 0 && report.sales.sessions === 0 && !cash.hasMovement;
  return model;
}

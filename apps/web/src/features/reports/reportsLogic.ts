// Tipos e regras PURAS dos relatórios por período. Os números vêm prontos do servidor
// (report_period agrega tudo); aqui só há datas, rótulos e pequenas somas de apresentação.

export type PaymentMethodKey = "cash" | "pix" | "debit_card" | "credit_card" | "other";

export const METHOD_LABEL: Record<PaymentMethodKey, string> = {
  cash: "Dinheiro",
  pix: "Pix",
  debit_card: "Débito",
  credit_card: "Crédito",
  other: "Outros",
};

export interface ReportPeriod {
  from: string; // yyyy-mm-dd (dia civil em America/Sao_Paulo, inclusivo)
  to: string;
}

export interface ReportSales {
  gross: number;
  refunded: number;
  net: number;
  sessions: number;
  ticket: number | null;
  items_sold: number;
}

export interface ReportMethod {
  method: PaymentMethodKey;
  paid: number;
  refunded: number;
  net: number;
}

export interface ReportProduct {
  product_id: string;
  name: string;
  category: string | null;
  quantity_valid: number;
  value_gross: number;
  cancelled_quantity: number;
  cancelled_value: number;
  value_net: number;
}

export interface ReportCancellation {
  id: string;
  created_at: string;
  product: string;
  quantity: number;
  value: number;
  reason: string;
  cancelled_by_name: string | null;
  point_code: string;
  point_type: "command" | "table";
}

export interface ReportRefund {
  id: string;
  created_at: string;
  method: PaymentMethodKey;
  amount: number;
  reason: string;
  refunded_by_name: string | null;
  point_code: string;
  point_type: "command" | "table";
}

export interface ReportCashSession {
  id: string;
  operator_name: string | null;
  opened_at: string;
  closed_at: string | null;
  status: "open" | "closed";
  opening_amount: number;
  sales: number;
  supply: number;
  withdrawal: number;
  refund: number;
  closing_cash_amount: number | null;
  cash_difference: number | null;
}

export interface ReportData {
  period: ReportPeriod;
  sales: ReportSales;
  methods: ReportMethod[];
  products: ReportProduct[];
  cancellations: { events: number; quantity: number; value: number; list: ReportCancellation[] };
  refunds: { count: number; total: number; list: ReportRefund[] };
  cash: {
    open_count: number;
    closed_count: number;
    opening_total: number;
    sales_total: number;
    supply_total: number;
    withdrawal_total: number;
    refund_total: number;
    shortage_total: number;
    surplus_total: number;
    list: ReportCashSession[];
  };
  production: {
    items: number;
    avg_minutes: number | null;
    by_product: Array<{ name: string; quantity: number }>;
    by_sector: Array<{ sector: string; quantity: number }>;
    cancelled_in_production: number;
  };
}

// --- Datas (America/Sao_Paulo) -----------------------------------------------------------------

const SP = "America/Sao_Paulo";

// Dia civil de hoje em São Paulo (yyyy-mm-dd), independente do fuso do navegador.
export function todayInSaoPaulo(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SP, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export type Preset = "today" | "yesterday" | "week" | "month";

export const PRESET_LABEL: Record<Preset, string> = {
  today: "Hoje",
  yesterday: "Ontem",
  week: "Últimos 7 dias",
  month: "Este mês",
};

export function presetPeriod(preset: Preset, today: string): ReportPeriod {
  if (preset === "today") return { from: today, to: today };
  if (preset === "yesterday") {
    const y = addDays(today, -1);
    return { from: y, to: y };
  }
  if (preset === "week") return { from: addDays(today, -6), to: today };
  return { from: `${today.slice(0, 8)}01`, to: today };
}

export function formatDateBR(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
}

export function periodLabel(period: ReportPeriod): string {
  return `${formatDateBR(period.from)} a ${formatDateBR(period.to)}`;
}

export function validatePeriod(period: ReportPeriod): string | null {
  if (!period.from || !period.to) return "Informe as duas datas.";
  if (period.from > period.to) return "A data inicial não pode ser depois da final.";
  const days = (Date.parse(period.to) - Date.parse(period.from)) / 86400000;
  if (days > 365) return "O período pode ter no máximo 366 dias.";
  return null;
}

export function pointText(c: { point_type: "command" | "table"; point_code: string }): string {
  return `${c.point_type === "table" ? "Mesa" : "Comanda"} ${c.point_code}`;
}

// Faltas e sobras de caixa: nunca somadas como se fossem uma gaveta só (o servidor já separa).
export function cashDifferenceText(diff: number | null, format: (n: number) => string): string {
  if (diff === null) return "Sem conferência";
  if (diff === 0) return "Confere";
  return diff < 0 ? `Falta ${format(Math.abs(diff))}` : `Sobra ${format(diff)}`;
}

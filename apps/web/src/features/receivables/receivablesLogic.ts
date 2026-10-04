import { parseCents } from "../../lib/money";
import { addDays, formatDateBR, validatePeriod, type ReportPeriod } from "../reports/reportsLogic";

// Regras PURAS de Contas a receber (sem React, sem Supabase). O servidor é a autoridade (status, saldo,
// recebimento, cancelamento, papéis); aqui só há rótulos, filtros, períodos, validação de formulário e o que
// habilita cada botão. Dinheiro em CENTAVOS inteiros no frontend (numeric(12,2) em REAIS no banco).
//
// Status persistido: pending | paid | cancelled. "Vencendo hoje" e "Atrasada" são DERIVADOS pelo servidor
// (display_status) a partir do vencimento em America/Sao_Paulo. Recebimento parcial = pending com paid > 0.

export type PaymentMethodKey = "cash" | "pix" | "debit_card" | "credit_card" | "other";

export const RECEIVABLE_METHOD_LABEL: Record<PaymentMethodKey, string> = {
  cash: "Dinheiro",
  pix: "Pix",
  debit_card: "Cartão de débito",
  credit_card: "Cartão de crédito",
  other: "Outra forma",
};
export const RECEIVABLE_METHODS = Object.keys(RECEIVABLE_METHOD_LABEL) as PaymentMethodKey[];

export type DisplayStatus = "pending" | "due_today" | "overdue" | "paid" | "cancelled";

export interface ReceivableRow {
  id: string;
  customerName: string;
  description: string;
  reference: string | null;
  notes: string | null;
  amountCents: number;
  paidCents: number;
  balanceCents: number;
  dueDate: string; // yyyy-mm-dd
  status: "pending" | "paid" | "cancelled";
  displayStatus: DisplayStatus;
  paymentMethod: PaymentMethodKey | null;
  paidAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  createdByName: string | null;
}

export interface ReceivableEvent {
  id: string;
  type: "created" | "updated" | "payment" | "cancelled";
  amountCents: number | null;
  method: PaymentMethodKey | null;
  paidOn: string | null;
  note: string | null;
  createdAt: string;
  createdByName: string | null;
}

export interface ReceivablesSummary {
  openCents: number;
  openCount: number;
  dueTodayCents: number;
  dueTodayCount: number;
  overdueCents: number;
  overdueCount: number;
  receivedCents: number;
  receivedCount: number;
}

export const toCents = (reais: number): number => Math.round(reais * 100);

// --- Rótulos ------------------------------------------------------------------------------------

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  pending: "A vencer",
  due_today: "Vence hoje",
  overdue: "Atrasada",
  paid: "Recebida",
  cancelled: "Cancelada",
};

// Recebimento parcial é uma marca à parte (a conta continua pendente/atrasada).
export function isPartial(row: Pick<ReceivableRow, "status" | "paidCents">): boolean {
  return row.status === "pending" && row.paidCents > 0;
}

export function isOpen(row: Pick<ReceivableRow, "status">): boolean {
  return row.status === "pending";
}

// O que cada botão exige. A autoridade é o servidor (RPC); isto só decide o que mostrar.
export function canEdit(row: ReceivableRow): boolean {
  return row.status === "pending";
}
export function canReceive(row: ReceivableRow): boolean {
  return row.status === "pending" && row.balanceCents > 0;
}
export function canCancel(row: ReceivableRow): boolean {
  return row.status === "pending" && row.paidCents === 0;
}

// "Vence hoje", "Venceu há 3 dias", "Vence em 5 dias" (só para contas em aberto).
export function dueHint(dueDate: string, today: string): string {
  const days = Math.round((Date.parse(dueDate) - Date.parse(today)) / 86400000);
  if (days === 0) return "Vence hoje";
  if (days < 0) return days === -1 ? "Venceu ontem" : `Venceu há ${-days} dias`;
  return days === 1 ? "Vence amanhã" : `Vence em ${days} dias`;
}

// --- Filtros ------------------------------------------------------------------------------------

export type StatusFilter = "all" | "pending" | "due_today" | "overdue" | "paid" | "cancelled";
export const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "pending", label: "Pendentes" },
  { value: "due_today", label: "Vencendo hoje" },
  { value: "overdue", label: "Atrasados" },
  { value: "paid", label: "Recebidos" },
  { value: "cancelled", label: "Cancelados" },
];

export type DateField = "due" | "paid";
export const DATE_FIELD_LABEL: Record<DateField, string> = { due: "Vencimento", paid: "Recebimento" };

export type PeriodKey = "none" | "today" | "week" | "month" | "next30" | "custom";
export const PERIOD_FILTERS: Array<{ value: PeriodKey; label: string }> = [
  { value: "none", label: "Todo o período" },
  { value: "today", label: "Hoje" },
  { value: "week", label: "Últimos 7 dias" },
  { value: "month", label: "Este mês" },
  { value: "next30", label: "Próximos 30 dias" },
  { value: "custom", label: "Período" },
];

export type SortKey = "due" | "overdue" | "amount" | "recent";
export const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "due", label: "Vencimento mais próximo" },
  { value: "overdue", label: "Mais atrasadas" },
  { value: "amount", label: "Maior valor" },
  { value: "recent", label: "Mais recentes" },
];

export interface ReceivableFilters {
  status: StatusFilter;
  dateField: DateField;
  period: PeriodKey;
  custom: ReportPeriod;
  search: string;
  sort: SortKey;
}

export function defaultFilters(today: string): ReceivableFilters {
  return { status: "all", dateField: "due", period: "none", custom: { from: today, to: today }, search: "", sort: "due" };
}

// Período efetivo do filtro (null = sem filtro de data).
export function periodRange(key: PeriodKey, today: string, custom: ReportPeriod): ReportPeriod | null {
  if (key === "none") return null;
  if (key === "today") return { from: today, to: today };
  if (key === "week") return { from: addDays(today, -6), to: today };
  if (key === "month") return { from: `${today.slice(0, 8)}01`, to: today };
  if (key === "next30") return { from: today, to: addDays(today, 30) };
  return custom;
}

export function filtersProblem(filters: ReceivableFilters): string | null {
  return filters.period === "custom" ? validatePeriod(filters.custom) : null;
}

// Parâmetros do list_receivables.
export interface ListParams {
  status: StatusFilter;
  dateField: DateField;
  from: string | null;
  to: string | null;
  search: string | null;
  sort: SortKey;
}

export function toListParams(filters: ReceivableFilters, today: string): ListParams {
  const range = periodRange(filters.period, today, filters.custom);
  const search = filters.search.trim();
  return {
    status: filters.status,
    dateField: filters.dateField,
    from: range?.from ?? null,
    to: range?.to ?? null,
    search: search === "" ? null : search,
    sort: filters.sort,
  };
}

// Período do card "Recebido": o do filtro quando ele é por RECEBIMENTO; senão, o mês até hoje.
export function summaryRange(filters: ReceivableFilters, today: string): { range: ReportPeriod; label: string } {
  const range = filters.dateField === "paid" ? periodRange(filters.period, today, filters.custom) : null;
  if (range) return { range, label: range.from === range.to ? formatDateBR(range.from) : `${formatDateBR(range.from)} a ${formatDateBR(range.to)}` };
  return { range: { from: `${today.slice(0, 8)}01`, to: today }, label: "este mês" };
}

// --- Formulários --------------------------------------------------------------------------------

export interface ReceivableDraft {
  customer: string;
  description: string;
  amount: string;
  dueDate: string;
  reference: string;
  notes: string;
}

export const EMPTY_DRAFT: ReceivableDraft = { customer: "", description: "", amount: "", dueDate: "", reference: "", notes: "" };

export function draftFromRow(row: ReceivableRow): ReceivableDraft {
  return {
    customer: row.customerName,
    description: row.description,
    amount: (row.amountCents / 100).toFixed(2).replace(".", ","),
    dueDate: row.dueDate,
    reference: row.reference ?? "",
    notes: row.notes ?? "",
  };
}

export interface ReceivablePayload {
  customerName: string;
  description: string;
  amount: number; // reais
  dueDate: string;
  reference: string | null;
  notes: string | null;
}

const isIsoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

// Valida o formulário; `paidCents` (edição de conta com recebimento parcial) exige valor maior que o recebido.
export function validateDraft(draft: ReceivableDraft, paidCents = 0): { error: string } | { payload: ReceivablePayload } {
  const customer = draft.customer.trim();
  const description = draft.description.trim();
  if (customer === "") return { error: "Informe o cliente." };
  if (customer.length > 120) return { error: "O nome do cliente pode ter no máximo 120 caracteres." };
  if (description === "") return { error: "Informe a descrição." };
  if (description.length > 200) return { error: "A descrição pode ter no máximo 200 caracteres." };
  const cents = parseCents(draft.amount);
  if (cents === null || cents <= 0) return { error: "Informe um valor maior que zero, ex.: 150,00." };
  if (paidCents > 0 && cents <= paidCents) return { error: "O valor precisa ser maior que o já recebido." };
  if (!isIsoDate(draft.dueDate)) return { error: "Informe o vencimento." };
  if (draft.reference.trim().length > 60) return { error: "A referência pode ter no máximo 60 caracteres." };
  if (draft.notes.trim().length > 500) return { error: "A observação pode ter no máximo 500 caracteres." };
  return {
    payload: {
      customerName: customer,
      description,
      amount: cents / 100,
      dueDate: draft.dueDate,
      reference: draft.reference.trim() === "" ? null : draft.reference.trim(),
      notes: draft.notes.trim() === "" ? null : draft.notes.trim(),
    },
  };
}

export interface PaymentDraft {
  amount: string;
  method: PaymentMethodKey;
  paidOn: string;
  note: string;
}

export function newPaymentDraft(balanceCents: number, today: string): PaymentDraft {
  return { amount: (balanceCents / 100).toFixed(2).replace(".", ","), method: "pix", paidOn: today, note: "" };
}

export function validatePayment(
  draft: PaymentDraft,
  balanceCents: number,
  today: string,
): { error: string } | { payload: { amount: number; method: PaymentMethodKey; paidOn: string; note: string | null } } {
  const cents = parseCents(draft.amount);
  if (cents === null || cents <= 0) return { error: "Informe o valor recebido." };
  if (cents > balanceCents) return { error: "O valor recebido não pode ser maior que o saldo da conta." };
  if (!isIsoDate(draft.paidOn)) return { error: "Informe a data do recebimento." };
  if (draft.paidOn > today) return { error: "A data do recebimento não pode ser futura." };
  if (draft.note.trim().length > 500) return { error: "A observação pode ter no máximo 500 caracteres." };
  return { payload: { amount: cents / 100, method: draft.method, paidOn: draft.paidOn, note: draft.note.trim() === "" ? null : draft.note.trim() } };
}

// Saldo que sobra depois de um recebimento (prévia na tela; o servidor recalcula).
export function balanceAfter(balanceCents: number, amountText: string): number | null {
  const cents = parseCents(amountText);
  if (cents === null || cents <= 0 || cents > balanceCents) return null;
  return balanceCents - cents;
}

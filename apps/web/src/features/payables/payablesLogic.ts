import { parseCents } from "../../lib/money";
import { addDays, formatDateBR, validatePeriod, type ReportPeriod } from "../reports/reportsLogic";

// Regras PURAS de Contas a pagar (sem React, sem Supabase). O servidor é a autoridade (status, saldo,
// pagamento, cancelamento, papéis); aqui só há rótulos, filtros, períodos, validação de formulário e o que
// habilita cada botão. Dinheiro em CENTAVOS inteiros no frontend (numeric(12,2) em REAIS no banco).
//
// Status persistido: pending | paid | cancelled. "Vencendo hoje" e "Atrasada" são DERIVADOS pelo servidor
// (display_status) a partir do vencimento em America/Sao_Paulo. Pagamento parcial = pending com paid > 0.

export type PaymentMethodKey = "cash" | "pix" | "debit_card" | "credit_card" | "other";

export const PAYABLE_METHOD_LABEL: Record<PaymentMethodKey, string> = {
  cash: "Dinheiro",
  pix: "Pix",
  debit_card: "Cartão de débito",
  credit_card: "Cartão de crédito",
  other: "Outra forma",
};
export const PAYABLE_METHODS = Object.keys(PAYABLE_METHOD_LABEL) as PaymentMethodKey[];

// Categoria da despesa: texto controlado (mesmos 12 códigos do CHECK da migration 20261004020000).
export type PayableCategory =
  | "suppliers"
  | "rent"
  | "energy"
  | "water"
  | "internet_phone"
  | "payroll"
  | "taxes"
  | "maintenance"
  | "equipment"
  | "marketing"
  | "services"
  | "other";

export const PAYABLE_CATEGORY_LABEL: Record<PayableCategory, string> = {
  suppliers: "Fornecedores",
  rent: "Aluguel",
  energy: "Energia",
  water: "Água",
  internet_phone: "Internet/Telefone",
  payroll: "Funcionários",
  taxes: "Impostos",
  maintenance: "Manutenção",
  equipment: "Equipamentos",
  marketing: "Marketing",
  services: "Serviços",
  other: "Outros",
};
export const PAYABLE_CATEGORIES = Object.keys(PAYABLE_CATEGORY_LABEL) as PayableCategory[];

export type DisplayStatus = "pending" | "due_today" | "overdue" | "paid" | "cancelled";

export interface PayableRow {
  id: string;
  supplierName: string;
  description: string;
  category: PayableCategory;
  reference: string | null;
  documentNumber: string | null;
  notes: string | null;
  amountCents: number;
  paidCents: number;
  balanceCents: number;
  dueDate: string; // yyyy-mm-dd
  status: "pending" | "paid" | "cancelled";
  displayStatus: DisplayStatus;
  lastPaymentMethod: PaymentMethodKey | null;
  lastPaidOn: string | null; // yyyy-mm-dd
  cancelledAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
  updatedAt: string;
  createdByName: string | null;
}

export interface PayableEvent {
  id: string;
  type: "created" | "updated" | "payment" | "cancelled";
  amountCents: number | null;
  method: PaymentMethodKey | null;
  paidOn: string | null;
  note: string | null;
  createdAt: string;
  createdByName: string | null;
}

export interface PayablesSummary {
  openCents: number;
  openCount: number;
  dueTodayCents: number;
  dueTodayCount: number;
  overdueCents: number;
  overdueCount: number;
  paidPeriodCents: number;
  paidPeriodCount: number;
}

export const toCents = (reais: number): number => Math.round(reais * 100);

// --- Rótulos ------------------------------------------------------------------------------------

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  pending: "A vencer",
  due_today: "Vence hoje",
  overdue: "Atrasada",
  paid: "Paga",
  cancelled: "Cancelada",
};

// Pagamento parcial é uma marca à parte (a conta continua pendente/atrasada).
export function isPartial(row: Pick<PayableRow, "status" | "paidCents">): boolean {
  return row.status === "pending" && row.paidCents > 0;
}

export function isOpen(row: Pick<PayableRow, "status">): boolean {
  return row.status === "pending";
}

// O que cada botão exige. A autoridade é o servidor (RPC); isto só decide o que mostrar.
// Editar: só conta pendente SEM pagamento (com parcial, valor/vencimento ficam congelados).
export function canEdit(row: PayableRow): boolean {
  return row.status === "pending" && row.paidCents === 0;
}
export function canPay(row: PayableRow): boolean {
  return row.status === "pending" && row.balanceCents > 0;
}
export function canCancel(row: PayableRow): boolean {
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
  { value: "paid", label: "Pagos" },
  { value: "cancelled", label: "Cancelados" },
];

export type DateField = "due" | "paid";
export const DATE_FIELD_LABEL: Record<DateField, string> = { due: "Vencimento", paid: "Pagamento" };

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

export interface PayableFilters {
  status: StatusFilter;
  dateField: DateField;
  period: PeriodKey;
  custom: ReportPeriod;
  search: string;
  sort: SortKey;
}

export function defaultFilters(today: string): PayableFilters {
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

export function filtersProblem(filters: PayableFilters): string | null {
  return filters.period === "custom" ? validatePeriod(filters.custom) : null;
}

// Parâmetros do list_payables.
export interface ListParams {
  status: StatusFilter;
  dateField: DateField;
  from: string | null;
  to: string | null;
  search: string | null;
  sort: SortKey;
}

export function toListParams(filters: PayableFilters, today: string): ListParams {
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

// Período do card "Pago": o do filtro quando ele é por PAGAMENTO; senão, o mês até hoje.
export function summaryRange(filters: PayableFilters, today: string): { range: ReportPeriod; label: string } {
  const range = filters.dateField === "paid" ? periodRange(filters.period, today, filters.custom) : null;
  if (range) return { range, label: range.from === range.to ? formatDateBR(range.from) : `${formatDateBR(range.from)} a ${formatDateBR(range.to)}` };
  return { range: { from: `${today.slice(0, 8)}01`, to: today }, label: "este mês" };
}

// --- Formulários --------------------------------------------------------------------------------

export interface PayableDraft {
  supplier: string;
  description: string;
  category: PayableCategory;
  amount: string;
  dueDate: string;
  reference: string;
  documentNumber: string;
  notes: string;
}

export const EMPTY_DRAFT: PayableDraft = { supplier: "", description: "", category: "other", amount: "", dueDate: "", reference: "", documentNumber: "", notes: "" };

export function draftFromRow(row: PayableRow): PayableDraft {
  return {
    supplier: row.supplierName,
    description: row.description,
    category: row.category,
    amount: (row.amountCents / 100).toFixed(2).replace(".", ","),
    dueDate: row.dueDate,
    reference: row.reference ?? "",
    documentNumber: row.documentNumber ?? "",
    notes: row.notes ?? "",
  };
}

export interface PayablePayload {
  supplierName: string;
  description: string;
  category: PayableCategory;
  amount: number; // reais
  dueDate: string;
  reference: string | null;
  documentNumber: string | null;
  notes: string | null;
}

const isIsoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

// Valida o formulário (o servidor valida de novo e só aceita editar conta pendente sem pagamento).
export function validateDraft(draft: PayableDraft): { error: string } | { payload: PayablePayload } {
  const supplier = draft.supplier.trim();
  const description = draft.description.trim();
  if (supplier === "") return { error: "Informe o fornecedor." };
  if (supplier.length > 120) return { error: "O nome do fornecedor pode ter no máximo 120 caracteres." };
  if (description === "") return { error: "Informe a descrição." };
  if (description.length > 200) return { error: "A descrição pode ter no máximo 200 caracteres." };
  const cents = parseCents(draft.amount);
  if (cents === null || cents <= 0) return { error: "Informe um valor maior que zero, ex.: 150,00." };
  if (!PAYABLE_CATEGORIES.includes(draft.category)) return { error: "Escolha a categoria da despesa." };
  if (!isIsoDate(draft.dueDate)) return { error: "Informe o vencimento." };
  if (draft.reference.trim().length > 60) return { error: "A referência pode ter no máximo 60 caracteres." };
  if (draft.documentNumber.trim().length > 60) return { error: "O número do documento pode ter no máximo 60 caracteres." };
  if (draft.notes.trim().length > 500) return { error: "A observação pode ter no máximo 500 caracteres." };
  return {
    payload: {
      supplierName: supplier,
      description,
      category: draft.category,
      amount: cents / 100,
      dueDate: draft.dueDate,
      reference: draft.reference.trim() === "" ? null : draft.reference.trim(),
      documentNumber: draft.documentNumber.trim() === "" ? null : draft.documentNumber.trim(),
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
  if (cents === null || cents <= 0) return { error: "Informe o valor pago." };
  if (cents > balanceCents) return { error: "O valor pago não pode ser maior que o saldo da conta." };
  if (!isIsoDate(draft.paidOn)) return { error: "Informe a data do pagamento." };
  if (draft.paidOn > today) return { error: "A data do pagamento não pode ser futura." };
  if (draft.note.trim().length > 500) return { error: "A observação pode ter no máximo 500 caracteres." };
  return { payload: { amount: cents / 100, method: draft.method, paidOn: draft.paidOn, note: draft.note.trim() === "" ? null : draft.note.trim() } };
}

// Saldo que sobra depois de um pagamento (prévia na tela; o servidor recalcula).
export function balanceAfter(balanceCents: number, amountText: string): number | null {
  const cents = parseCents(amountText);
  if (cents === null || cents <= 0 || cents > balanceCents) return null;
  return balanceCents - cents;
}

// Regras PURAS do módulo Delivery (sem React, sem Supabase). A AUTORIDADE é o backend (create_delivery_order,
// set_delivery_status, cancel_delivery_order, ...): taxa, previsão, estado, permissão e total são decididos lá.
// Aqui ficam tipos, rótulos, estado visual DERIVADO (produção vem dos itens, nunca de delivery_status), regras de
// QUAIS BOTÕES mostrar (espelho do backend, só UX), validação amigável de formulário e montagem do payload.

import type { CompanyRole } from "../../lib/types";

export type Fulfillment = "delivery" | "pickup";
export type LogisticStatus = "confirmed" | "out_for_delivery" | "delivered" | "picked_up" | "canceled";
export type ProductionState = "pending" | "preparing" | "ready" | null;
export type PaymentTiming = "on_order" | "on_delivery" | "on_pickup";
export type ExpectedMethod = "cash" | "pix" | "debit_card" | "credit_card" | "other";
export type FeeSource = "zone" | "default" | "manual" | "none";

export const FULFILLMENT_LABEL: Record<Fulfillment, string> = { delivery: "ENTREGA", pickup: "RETIRADA" };
export const LOGISTIC_LABEL: Record<LogisticStatus, string> = {
  confirmed: "Confirmado",
  out_for_delivery: "Em rota",
  delivered: "Entregue",
  picked_up: "Retirado",
  canceled: "Cancelado",
};
export const PRODUCTION_LABEL: Record<Exclude<ProductionState, null>, string> = {
  pending: "Aguardando produção",
  preparing: "Em produção",
  ready: "Pronto",
};
export const TIMING_LABEL: Record<PaymentTiming, string> = {
  on_order: "Pagamento no pedido",
  on_delivery: "Pagar na entrega",
  on_pickup: "Pagar na retirada",
};
export const METHOD_LABEL: Record<ExpectedMethod, string> = {
  cash: "Dinheiro",
  pix: "Pix",
  debit_card: "Cartão de débito",
  credit_card: "Cartão de crédito",
  other: "Outro",
};
export const FEE_SOURCE_LABEL: Record<FeeSource, string> = {
  zone: "Zona de entrega",
  default: "Taxa padrão",
  manual: "Taxa manual",
  none: "Sem taxa",
};

// Situação FINANCEIRA derivada do estado oficial da sessão/pagamentos (nunca do "momento de pagamento" informado no pedido).
export type FinancialStatus = "pending" | "paid" | "refunded" | "no_charge";
export const FINANCIAL_LABEL: Record<FinancialStatus, string> = {
  pending: "A receber",
  paid: "Pago",
  refunded: "Estornado",
  no_charge: "Sem cobrança",
};

export interface DeliveryAddress {
  street: string | null;
  number: string | null;
  complement: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  cep: string | null;
  reference: string | null;
}

export interface DeliveryRow {
  id: string;
  sessionId: string;
  orderId: string;
  fulfillment: Fulfillment;
  status: LogisticStatus;
  production: ProductionState;
  itemsActive: number;
  itemsReady: number;
  customerId: string | null;
  customerName: string;
  customerPhone: string | null;
  address: DeliveryAddress | null;
  deliveryFee: number;
  feeSource: FeeSource;
  itemsSubtotal: number;
  total: number;
  estimatedReadyAt: string | null;
  estimatedDeliveryAt: string | null;
  paymentTiming: PaymentTiming;
  expectedMethod: ExpectedMethod | null;
  cashChangeFor: number | null;
  courierUserId: string | null;
  courierName: string | null;
  outForDeliveryAt: string | null;
  deliveredAt: string | null;
  pickedUpAt: string | null;
  canceledAt: string | null;
  cancelReason: string | null;
  notes: string | null;
  sessionStatus: "open" | "closed";
  createdAt: string;
  financialStatus: FinancialStatus;
  paidAmount: number;
}

// Linha crua de list_delivery_orders (snake_case, numeric como string/number).
export interface RawDeliveryRow {
  id: string;
  service_session_id: string;
  service_order_id: string;
  fulfillment: Fulfillment;
  delivery_status: LogisticStatus;
  production: ProductionState;
  items_active: number;
  items_ready: number;
  customer_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  address: {
    street: string | null; number: string | null; complement: string | null; neighborhood: string | null;
    city: string | null; state: string | null; cep: string | null; reference: string | null;
  } | null;
  delivery_fee: number | string;
  fee_source: FeeSource;
  items_subtotal: number | string;
  total: number | string;
  estimated_ready_at: string | null;
  estimated_delivery_at: string | null;
  payment_timing: PaymentTiming;
  expected_method: ExpectedMethod | null;
  cash_change_for: number | string | null;
  courier_user_id: string | null;
  courier_name: string | null;
  out_for_delivery_at: string | null;
  delivered_at: string | null;
  picked_up_at: string | null;
  canceled_at: string | null;
  cancel_reason: string | null;
  notes: string | null;
  session_status: "open" | "closed";
  created_at: string;
  financial_status?: FinancialStatus;
  paid_amount?: number | string;
}

const num = (v: number | string | null | undefined): number => Number(v ?? 0);

export function toDeliveryRow(raw: RawDeliveryRow): DeliveryRow {
  return {
    id: raw.id,
    sessionId: raw.service_session_id,
    orderId: raw.service_order_id,
    fulfillment: raw.fulfillment,
    status: raw.delivery_status,
    production: raw.production ?? null,
    itemsActive: raw.items_active,
    itemsReady: raw.items_ready,
    customerId: raw.customer_id,
    customerName: raw.customer_name,
    customerPhone: raw.customer_phone,
    address: raw.address,
    deliveryFee: num(raw.delivery_fee),
    feeSource: raw.fee_source,
    itemsSubtotal: num(raw.items_subtotal),
    total: num(raw.total),
    estimatedReadyAt: raw.estimated_ready_at,
    estimatedDeliveryAt: raw.estimated_delivery_at,
    paymentTiming: raw.payment_timing,
    expectedMethod: raw.expected_method,
    cashChangeFor: raw.cash_change_for === null || raw.cash_change_for === undefined ? null : num(raw.cash_change_for),
    courierUserId: raw.courier_user_id,
    courierName: raw.courier_name,
    outForDeliveryAt: raw.out_for_delivery_at,
    deliveredAt: raw.delivered_at,
    pickedUpAt: raw.picked_up_at,
    canceledAt: raw.canceled_at,
    cancelReason: raw.cancel_reason,
    notes: raw.notes,
    sessionStatus: raw.session_status,
    createdAt: raw.created_at,
    // servidor atual manda o status; sem ele (versão antiga) vale só o que é certo: sessão aberta = a receber, nunca "pago"
    financialStatus: raw.financial_status ?? (raw.delivery_status === "canceled" ? "no_charge" : raw.session_status === "open" ? "pending" : "paid"),
    paidAmount: num(raw.paid_amount),
  };
}

// ---- Seções do quadro (estado VISUAL derivado; nada disto é persistido) ------------------------------------------------
export type BoardSection = "production" | "ready" | "route" | "delivered" | "pickedUp" | "canceled";

export const SECTION_TITLE: Record<BoardSection, string> = {
  production: "Em produção",
  ready: "Prontos",
  route: "Em rota",
  delivered: "Entregues",
  pickedUp: "Retiradas",
  canceled: "Cancelados",
};
export const SECTION_ORDER: BoardSection[] = ["production", "ready", "route", "delivered", "pickedUp", "canceled"];

// confirmed + algum item não pronto => Em produção; confirmed + todos prontos => Prontos (entrega pronta ou retirada
// pronta); out_for_delivery => Em rota; delivered => Entregues; picked_up => Retiradas; canceled => Cancelados.
export function sectionOf(row: Pick<DeliveryRow, "status" | "production">): BoardSection {
  switch (row.status) {
    case "canceled":
      return "canceled";
    case "out_for_delivery":
      return "route";
    case "delivered":
      return "delivered";
    case "picked_up":
      return "pickedUp";
    default:
      return row.production === "ready" ? "ready" : "production";
  }
}

export function groupBySection(rows: DeliveryRow[]): Record<BoardSection, DeliveryRow[]> {
  const out: Record<BoardSection, DeliveryRow[]> = { production: [], ready: [], route: [], delivered: [], pickedUp: [], canceled: [] };
  for (const row of rows) out[sectionOf(row)].push(row);
  return out;
}

/** Rótulo único do estado: logístico quando já saiu do "confirmado"; senão o de produção derivado. */
export function stateLabel(row: Pick<DeliveryRow, "status" | "production" | "fulfillment">): string {
  if (row.status === "confirmed") {
    if (row.production === "ready") return row.fulfillment === "pickup" ? "Pronto para retirada" : "Pronto";
    return row.production ? PRODUCTION_LABEL[row.production] : "Sem itens ativos";
  }
  return LOGISTIC_LABEL[row.status];
}

// ---- Ações disponíveis (espelho de set_delivery_status / cancel_delivery_order / assign_delivery_courier) --------------
export interface ActionContext {
  role: CompanyRole | null;
  userId: string | null;
}
export type DeliveryAction = "out_for_delivery" | "delivered" | "picked_up" | "cancel" | "assign" | "receive";

const OPERATORS: readonly CompanyRole[] = ["owner", "admin", "cashier", "attendant"];
export const isOperator = (role: CompanyRole | null): boolean => role !== null && OPERATORS.includes(role);

export function availableActions(row: DeliveryRow, ctx: ActionContext): DeliveryAction[] {
  const { role, userId } = ctx;
  if (!role) return [];
  const actions: DeliveryAction[] = [];
  const operator = isOperator(role);
  const ownCourier = role === "courier" && userId !== null && row.courierUserId === userId;
  const ready = row.production === "ready" && row.itemsActive > 0;

  if (row.status === "confirmed" && row.fulfillment === "delivery" && ready && (operator || ownCourier)) actions.push("out_for_delivery");
  if (row.status === "out_for_delivery" && (operator || ownCourier)) actions.push("delivered");
  if (row.status === "confirmed" && row.fulfillment === "pickup" && ready && operator) actions.push("picked_up");

  if (operator && row.fulfillment === "delivery" && (row.status === "confirmed" || row.status === "out_for_delivery")) actions.push("assign");

  // cashier/attendant só cancelam item ainda pendente (o servidor recusa o resto): não oferece o botão quando já entrou em produção.
  if (row.status === "confirmed" && (role === "owner" || role === "admin" || (operator && row.production === "pending"))) actions.push("cancel");
  if (row.status === "out_for_delivery" && (role === "owner" || role === "admin")) actions.push("cancel");

  // Recebimento é do Caixa (owner/admin/cashier), com a conta ainda aberta e o pedido não cancelado.
  if ((role === "owner" || role === "admin" || role === "cashier") && row.status !== "canceled" && row.sessionStatus === "open") actions.push("receive");
  return actions;
}

export const ACTION_LABEL: Record<DeliveryAction, string> = {
  out_for_delivery: "SAIR PARA ENTREGA",
  delivered: "MARCAR COMO ENTREGUE",
  picked_up: "MARCAR COMO RETIRADO",
  cancel: "CANCELAR PEDIDO",
  assign: "Atribuir entregador",
  receive: "Receber no Caixa",
};

// ---- Período e filtros ------------------------------------------------------------------------------------------------
export type PeriodPreset = "today" | "yesterday" | "range";

const SP_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });
export function spDate(d: Date): string {
  return SP_DATE.format(d); // yyyy-mm-dd
}
export function periodDates(preset: PeriodPreset, range: { from: string; to: string }, now: Date = new Date()): { from: string; to: string } {
  const today = spDate(now);
  if (preset === "today") return { from: today, to: today };
  if (preset === "yesterday") {
    const y = spDate(new Date(now.getTime() - 24 * 3600 * 1000));
    return { from: y, to: y };
  }
  return range;
}
export function validatePeriod(p: { from: string; to: string }): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.from) || !/^\d{4}-\d{2}-\d{2}$/.test(p.to)) return "Informe as datas do período.";
  if (p.to < p.from) return "A data final não pode ser anterior à inicial.";
  const days = (Date.parse(p.to) - Date.parse(p.from)) / 86400000;
  if (days > 62) return "O período pode ter no máximo 63 dias.";
  return null;
}

export interface DeliveryFilters {
  preset: PeriodPreset;
  range: { from: string; to: string };
  fulfillment: Fulfillment | "all";
  status: LogisticStatus | "all";
  courierUserId: string | "all" | "none";
  query: string;
}
export const DEFAULT_FILTERS: DeliveryFilters = {
  preset: "today",
  range: { from: "", to: "" },
  fulfillment: "all",
  status: "all",
  courierUserId: "all",
  query: "",
};

export function normalizeText(v: string): string {
  return v.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
export function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 6).toUpperCase();
}

/** Busca livre no que já foi carregado: cliente, telefone, bairro, rua, entregador e número do pedido. */
export function matchesQuery(row: DeliveryRow, query: string): boolean {
  const q = normalizeText(query.trim());
  if (!q) return true;
  const digits = q.replace(/\D/g, "");
  const hay = normalizeText(
    [row.customerName, row.address?.neighborhood, row.address?.street, row.courierName, shortId(row.id)].filter(Boolean).join(" "),
  );
  if (hay.includes(q)) return true;
  return digits.length >= 3 && (row.customerPhone ?? "").includes(digits);
}

/** Filtros que o backend NÃO faz (busca livre e "sem entregador"): aplicados sobre as linhas carregadas. */
export function applyLocalFilters(rows: DeliveryRow[], f: Pick<DeliveryFilters, "query" | "courierUserId">): DeliveryRow[] {
  return rows.filter((r) => (f.courierUserId === "none" ? r.courierUserId === null : true) && matchesQuery(r, f.query));
}

// ---- Formatação ------------------------------------------------------------------------------------------------------
export function formatCep(digits: string | null | undefined): string {
  const d = (digits ?? "").replace(/\D/g, "");
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
}
export function formatPhone(digits: string | null | undefined): string {
  const d = (digits ?? "").replace(/\D/g, "");
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return d;
}
export function formatAddressLine(a: DeliveryAddress | null): string {
  if (!a) return "";
  const first = [a.street, a.number].filter(Boolean).join(", ");
  const rest = [a.complement, a.neighborhood, [a.city, a.state].filter(Boolean).join("/")].filter(Boolean).join(" · ");
  return [first, rest].filter(Boolean).join(" — ");
}
const HOUR = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
export const formatTime = (iso: string | null): string => (iso ? HOUR.format(new Date(iso)) : "—");
export function etaOf(row: Pick<DeliveryRow, "fulfillment" | "estimatedDeliveryAt" | "estimatedReadyAt">): string | null {
  return row.fulfillment === "pickup" ? row.estimatedReadyAt : row.estimatedDeliveryAt;
}

// ---- Novo pedido -----------------------------------------------------------------------------------------------------
export interface DeliveryQuote {
  fulfillment: Fulfillment;
  fee: number | null;
  feeSource: FeeSource;
  zoneId: string | null;
  zoneName: string | null;
  estimatedMinutes: number;
  allowManualFee: boolean;
  defaultInstructions: string | null;
}
export interface RawQuote {
  fulfillment: Fulfillment;
  fee: number | string | null;
  fee_source: FeeSource;
  zone_id: string | null;
  zone_name: string | null;
  estimated_minutes: number;
  allow_manual_fee: boolean;
  default_instructions: string | null;
}
export function toQuote(raw: RawQuote): DeliveryQuote {
  return {
    fulfillment: raw.fulfillment,
    fee: raw.fee === null ? null : Number(raw.fee),
    feeSource: raw.fee_source,
    zoneId: raw.zone_id,
    zoneName: raw.zone_name,
    estimatedMinutes: raw.estimated_minutes,
    allowManualFee: raw.allow_manual_fee,
    defaultInstructions: raw.default_instructions,
  };
}

/**
 * Quando o formulário oferece "taxa manual" (espelho do backend, que continua sendo a fonte da verdade):
 *  - sem zona nem taxa padrão: qualquer operador, se a empresa permite;
 *  - com zona/padrão: só owner/admin (sobrescrita), se a empresa permite.
 * Retirada nunca tem taxa.
 */
export function manualFeeMode(q: DeliveryQuote | null, role: CompanyRole | null): "required" | "override" | "hidden" {
  if (!q || q.fulfillment === "pickup" || !q.allowManualFee) return "hidden";
  if (q.feeSource === "none") return "required";
  return role === "owner" || role === "admin" ? "override" : "hidden";
}

export function feeToCharge(q: DeliveryQuote | null, manual: number | null): number | null {
  if (!q) return null; // cotação ainda não chegou
  if (q.fulfillment === "pickup") return 0;
  return manual !== null ? manual : q.fee;
}

export interface NewOrderDraft {
  fulfillment: Fulfillment;
  customerId: string | null;
  customerName: string;
  customerPhone: string;
  addressId: string | null;
  manualFee: number | null;
  paymentTiming: PaymentTiming;
  expectedMethod: ExpectedMethod | null;
  cashChangeFor: number | null;
  notes: string;
}

export function defaultTiming(f: Fulfillment): PaymentTiming {
  return f === "delivery" ? "on_delivery" : "on_pickup";
}
export function timingOptions(f: Fulfillment): PaymentTiming[] {
  return f === "delivery" ? ["on_order", "on_delivery"] : ["on_order", "on_pickup"];
}
export function emptyDraft(f: Fulfillment = "delivery"): NewOrderDraft {
  return {
    fulfillment: f,
    customerId: null,
    customerName: "",
    customerPhone: "",
    addressId: null,
    manualFee: null,
    paymentTiming: defaultTiming(f),
    expectedMethod: null,
    cashChangeFor: null,
    notes: "",
  };
}

/** Trocar entrega/retirada limpa o que não vale mais (endereço, taxa manual, momento de pagamento). */
export function switchFulfillment(d: NewOrderDraft, f: Fulfillment): NewOrderDraft {
  if (d.fulfillment === f) return d;
  return { ...d, fulfillment: f, addressId: null, manualFee: null, paymentTiming: defaultTiming(f) };
}

export function setMethod(d: NewOrderDraft, m: ExpectedMethod | null): NewOrderDraft {
  return { ...d, expectedMethod: m, cashChangeFor: m === "cash" ? d.cashChangeFor : null };
}

export type StepId = "type" | "customer" | "address" | "products" | "notes" | "fee" | "payment" | "review";
export function stepsFor(f: Fulfillment): StepId[] {
  return f === "delivery"
    ? ["type", "customer", "address", "products", "notes", "fee", "payment", "review"]
    : ["type", "customer", "products", "notes", "fee", "payment", "review"];
}
export const STEP_TITLE: Record<StepId, string> = {
  type: "Tipo do pedido",
  customer: "Cliente",
  address: "Endereço",
  products: "Produtos",
  notes: "Observações",
  fee: "Taxa e previsão",
  payment: "Pagamento",
  review: "Revisão",
};

export interface StepCheck {
  draft: NewOrderDraft;
  cartCount: number;
  quote: DeliveryQuote | null;
  role: CompanyRole | null;
  total: number;
}

/** Mensagem do que falta para AVANÇAR da etapa (null = ok). O servidor revalida tudo no envio. */
export function stepProblem(step: StepId, c: StepCheck): string | null {
  const d = c.draft;
  switch (step) {
    case "customer":
      if (d.fulfillment === "delivery" && !d.customerId) return "Escolha ou cadastre o cliente para a entrega.";
      if (d.fulfillment === "pickup" && !d.customerId && d.customerName.trim().length === 0) return "Informe o nome do cliente.";
      return null;
    case "address":
      return d.addressId ? null : "Escolha ou cadastre o endereço de entrega.";
    case "products":
      return c.cartCount > 0 ? null : "Adicione ao menos um produto.";
    case "fee": {
      if (d.fulfillment === "pickup") return null;
      if (!c.quote) return "Calculando a taxa…";
      const mode = manualFeeMode(c.quote, c.role);
      if (c.quote.feeSource === "none" && d.manualFee === null) {
        return mode === "required" ? "Não há taxa cadastrada para este bairro. Informe a taxa manual." : "Não há taxa cadastrada para este bairro e o ajuste manual está desativado.";
      }
      return null;
    }
    case "payment":
      if (d.cashChangeFor !== null) {
        if (d.expectedMethod !== "cash") return "Troco só vale para pagamento em dinheiro.";
        if (d.cashChangeFor < c.total) return "O troco deve ser para um valor igual ou maior que o total.";
      }
      return null;
    default:
      return null;
  }
}

export interface CreateArgs {
  p_company_id: string;
  p_client_request_id: string;
  p_fulfillment: Fulfillment;
  p_items: Array<{ product_id: string; quantity: number; notes: string | null; modifier_option_ids: string[] }>;
  p_customer_id: string | null;
  p_customer_name: string | null;
  p_customer_phone: string | null;
  p_address_id: string | null;
  p_manual_fee: number | null;
  p_payment_timing: PaymentTiming;
  p_expected_method: ExpectedMethod | null;
  p_cash_change_for: number | null;
  p_notes: string | null;
}

/** Só IDs, quantidades e observações vão para o servidor: preço, taxa efetiva, previsão e total são dele. */
export function buildCreateArgs(
  companyId: string,
  requestId: string,
  d: NewOrderDraft,
  items: CreateArgs["p_items"],
  quote: DeliveryQuote | null,
): CreateArgs {
  const manual = d.fulfillment === "delivery" && d.manualFee !== null && manualFeeAllowed(quote) ? d.manualFee : null;
  return {
    p_company_id: companyId,
    p_client_request_id: requestId,
    p_fulfillment: d.fulfillment,
    p_items: items,
    p_customer_id: d.customerId,
    p_customer_name: d.customerId ? null : d.customerName.trim() || null,
    p_customer_phone: d.customerPhone.replace(/\D/g, "") || null,
    p_address_id: d.fulfillment === "delivery" ? d.addressId : null,
    p_manual_fee: manual,
    p_payment_timing: d.paymentTiming,
    p_expected_method: d.expectedMethod,
    p_cash_change_for: d.expectedMethod === "cash" ? d.cashChangeFor : null,
    p_notes: d.notes.trim() || null,
  };
}
function manualFeeAllowed(q: DeliveryQuote | null): boolean {
  return !!q && q.allowManualFee;
}

// ---- Configurações e zonas ---------------------------------------------------------------------------------------------
export interface DeliverySettings {
  configured: boolean;
  deliveryEnabled: boolean;
  pickupEnabled: boolean;
  deliveryMinutes: number;
  pickupMinutes: number;
  defaultFee: number | null;
  allowManualFee: boolean;
  defaultInstructions: string;
}
export interface RawSettings {
  configured: boolean;
  delivery_enabled: boolean;
  pickup_enabled: boolean;
  delivery_minutes: number;
  pickup_minutes: number;
  default_fee: number | string | null;
  allow_manual_fee: boolean;
  default_instructions: string | null;
}
export function toSettings(r: RawSettings): DeliverySettings {
  return {
    configured: r.configured,
    deliveryEnabled: r.delivery_enabled,
    pickupEnabled: r.pickup_enabled,
    deliveryMinutes: r.delivery_minutes,
    pickupMinutes: r.pickup_minutes,
    defaultFee: r.default_fee === null ? null : Number(r.default_fee),
    allowManualFee: r.allow_manual_fee,
    defaultInstructions: r.default_instructions ?? "",
  };
}

export function parseMinutes(input: string): number | null {
  const t = input.trim();
  if (!/^\d{1,4}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 1440 ? n : null;
}
export function parseMoney(input: string): number | null {
  const s = input.trim().replace(/\s/g, "").replace(/^R\$/, "");
  if (!s) return null;
  const normalized = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  return Math.round(Number(normalized) * 100) / 100;
}

export interface ZoneRow {
  id: string;
  name: string;
  neighborhood: string;
  city: string;
  fee: number;
  estimatedMinutes: number | null;
  isActive: boolean;
}
export interface RawZone {
  id: string;
  name: string;
  neighborhood: string;
  city: string;
  fee: number | string;
  estimated_minutes: number | null;
  is_active: boolean;
}
export const toZone = (r: RawZone): ZoneRow => ({
  id: r.id, name: r.name, neighborhood: r.neighborhood, city: r.city, fee: Number(r.fee),
  estimatedMinutes: r.estimated_minutes, isActive: r.is_active,
});

export interface AddressRow {
  id: string;
  label: string | null;
  cep: string | null;
  street: string;
  number: string | null;
  complement: string | null;
  neighborhood: string;
  city: string;
  state: string;
  reference: string | null;
  isActive: boolean;
}
export interface RawAddress {
  id: string; label: string | null; cep: string | null; street: string; number: string | null; complement: string | null;
  neighborhood: string; city: string; state: string; reference: string | null; is_active: boolean;
}
export const toAddress = (r: RawAddress): AddressRow => ({
  id: r.id, label: r.label, cep: r.cep, street: r.street, number: r.number, complement: r.complement,
  neighborhood: r.neighborhood, city: r.city, state: r.state, reference: r.reference, isActive: r.is_active,
});

export interface AddressForm {
  label: string; cep: string; street: string; number: string; complement: string;
  neighborhood: string; city: string; state: string; reference: string;
}
export const EMPTY_ADDRESS: AddressForm = { label: "", cep: "", street: "", number: "", complement: "", neighborhood: "", city: "", state: "SP", reference: "" };
export function addressFormProblem(f: AddressForm): string | null {
  if (!f.street.trim()) return "Informe a rua.";
  if (!f.neighborhood.trim()) return "Informe o bairro.";
  if (!f.city.trim()) return "Informe a cidade.";
  if (!/^[A-Za-z]{2}$/.test(f.state.trim())) return "Informe o estado (UF) com 2 letras.";
  const cep = f.cep.replace(/\D/g, "");
  if (cep && cep.length !== 8) return "CEP inválido. Informe os 8 dígitos.";
  return null;
}

export interface ZoneForm { name: string; neighborhood: string; city: string; fee: string; minutes: string }
export function zoneFormProblem(f: ZoneForm): string | null {
  if (!f.neighborhood.trim()) return "Informe o bairro.";
  if (!f.city.trim()) return "Informe a cidade.";
  if (parseMoney(f.fee) === null) return "Informe a taxa (zero ou mais, ex.: 8,00).";
  if (f.minutes.trim() && parseMinutes(f.minutes) === null) return "A previsão deve ficar entre 1 e 1440 minutos.";
  return null;
}

export const BLOCKED_TEXT = "O módulo Delivery não está liberado para esta empresa.";

/** Texto do selo financeiro do card/detalhe. Nunca "Pago" sem pagamento real registrado. */
export function financialBadge(row: Pick<DeliveryRow, "financialStatus">): { label: string; tone: "pending" | "paid" | "muted" } {
  switch (row.financialStatus) {
    case "pending":
      return { label: FINANCIAL_LABEL.pending, tone: "pending" };
    case "paid":
      return { label: FINANCIAL_LABEL.paid, tone: "paid" };
    case "refunded":
      return { label: FINANCIAL_LABEL.refunded, tone: "muted" };
    default:
      return { label: FINANCIAL_LABEL.no_charge, tone: "muted" };
  }
}

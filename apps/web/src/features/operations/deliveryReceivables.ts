// Delivery / Retirada no Caixa (Fase 4A): lógica PURA das contas de delivery/retirada mostradas junto das comandas/mesas.
// Não há financeiro paralelo: o status financeiro é DERIVADO no banco (list_delivery_receivables) a partir da sessão e dos
// pagamentos oficiais; aqui só se tipa, se filtra, se busca e se rotula.
import { CUSTODY_LABEL, FINANCIAL_LABEL, LOGISTIC_LABEL, METHOD_LABEL, toCustody, type CourierCustody, type ExpectedMethod, type FinancialStatus, type LogisticStatus, type RawCourierCustody } from "../delivery/deliveryLogic";

export interface RawReceivable {
  delivery_order_id: string;
  service_session_id: string;
  short_code: string;
  fulfillment: "delivery" | "pickup";
  delivery_status: LogisticStatus;
  customer_name: string;
  customer_phone: string | null;
  items_subtotal: number | string;
  delivery_fee: number | string;
  total: number | string;
  payment_timing: "on_order" | "on_delivery" | "on_pickup";
  expected_method: ExpectedMethod | null;
  cash_change_for: number | string | null;
  financial_status: FinancialStatus;
  paid_amount: number | string;
  refunded_amount: number | string;
  session_status: "open" | "closed";
  created_at: string;
  delivered_at: string | null;
  picked_up_at: string | null;
  closed_at: string | null;
  courier_custody?: RawCourierCustody | null;
}

export interface DeliveryReceivable {
  deliveryOrderId: string;
  sessionId: string;
  shortCode: string;
  fulfillment: "delivery" | "pickup";
  status: LogisticStatus;
  customerName: string;
  customerPhone: string | null;
  itemsSubtotal: number;
  deliveryFee: number;
  total: number;
  paymentTiming: "on_order" | "on_delivery" | "on_pickup";
  expectedMethod: ExpectedMethod | null;
  cashChangeFor: number | null;
  financialStatus: FinancialStatus;
  paidAmount: number;
  refundedAmount: number;
  createdAt: string;
  deliveredAt: string | null;
  pickedUpAt: string | null;
  closedAt: string | null;
  /** Recebido pelo entregador e ainda NÃO acertado no Caixa (continua "pendente" no financeiro oficial). */
  courierCustody: CourierCustody | null;
}

const num = (v: number | string | null | undefined): number => Number(v ?? 0);

export function toReceivable(r: RawReceivable): DeliveryReceivable {
  return {
    deliveryOrderId: r.delivery_order_id,
    sessionId: r.service_session_id,
    shortCode: r.short_code,
    fulfillment: r.fulfillment,
    status: r.delivery_status,
    customerName: r.customer_name,
    customerPhone: r.customer_phone,
    itemsSubtotal: num(r.items_subtotal),
    deliveryFee: num(r.delivery_fee),
    total: num(r.total),
    paymentTiming: r.payment_timing,
    expectedMethod: r.expected_method,
    cashChangeFor: r.cash_change_for === null || r.cash_change_for === undefined ? null : num(r.cash_change_for),
    financialStatus: r.financial_status,
    paidAmount: num(r.paid_amount),
    refundedAmount: num(r.refunded_amount),
    createdAt: r.created_at,
    deliveredAt: r.delivered_at,
    pickedUpAt: r.picked_up_at,
    closedAt: r.closed_at,
    courierCustody: toCustody(r.courier_custody),
  };
}

/** O que o Caixa mostra: tudo, só comandas/mesas, só delivery/retirada, ou só o que falta receber. */
export type CashierView = "all" | "points" | "delivery" | "receivable" | "settlement";
export const VIEW_LABEL: Record<CashierView, string> = {
  all: "Todos",
  points: "Comandas / Mesas",
  delivery: "Delivery / Retirada",
  receivable: "A receber",
  settlement: "Acerto de entregadores",
};
export const VIEW_ORDER: readonly CashierView[] = ["all", "points", "delivery", "receivable", "settlement"];

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
const digits = (v: string): string => v.replace(/\D/g, "");

export const FULFILLMENT_TITLE: Record<"delivery" | "pickup", string> = { delivery: "DELIVERY", pickup: "RETIRADA" };

/** "DELIVERY #E34007" / "RETIRADA #E34008". */
export const receivableTitle = (r: Pick<DeliveryReceivable, "fulfillment" | "shortCode">): string => `${FULFILLMENT_TITLE[r.fulfillment]} #${r.shortCode}`;

/** Quanto falta receber já com o pedido entregue/retirado: o que precisa de destaque. */
export const isOverdueToCollect = (r: Pick<DeliveryReceivable, "financialStatus" | "status"> & { courierCustody?: CourierCustody | null }): boolean =>
  r.financialStatus === "pending" && !r.courierCustody && (r.status === "delivered" || r.status === "picked_up");

export const operationalLabel = (r: Pick<DeliveryReceivable, "status">): string => LOGISTIC_LABEL[r.status];
/** "A receber" ou, com o valor na mão do entregador, "Com entregador · aguardando acerto" (nunca "Pago" antes do acerto). */
export const financialLabel = (r: Pick<DeliveryReceivable, "financialStatus"> & { courierCustody?: CourierCustody | null }): string =>
  r.financialStatus === "pending" && r.courierCustody ? CUSTODY_LABEL : FINANCIAL_LABEL[r.financialStatus];
export const financialTone = (r: Pick<DeliveryReceivable, "financialStatus"> & { courierCustody?: CourierCustody | null }): string =>
  r.financialStatus === "pending" && r.courierCustody ? "custody" : r.financialStatus;
export const expectedMethodLabel = (r: Pick<DeliveryReceivable, "expectedMethod">): string | null => (r.expectedMethod ? METHOD_LABEL[r.expectedMethod] : null);

/** Busca: cliente, código curto (com ou sem #), telefone (só dígitos), tipo ("delivery"/"retirada") e forma pretendida. */
export function matchesReceivable(r: DeliveryReceivable, query: string): boolean {
  const q = normalize(query.trim()).replace(/^#/, "");
  if (!q) return true;
  const hay = normalize([r.customerName, r.shortCode, FULFILLMENT_TITLE[r.fulfillment], expectedMethodLabel(r) ?? "", operationalLabel(r)].join(" "));
  if (hay.includes(q)) return true;
  const qd = digits(q);
  return qd.length >= 3 && digits(r.customerPhone ?? "").includes(qd);
}

/** Lista filtrada pela visão e pela busca. "A receber" = SOMENTE pendentes; "Todos" e "Delivery" incluem pagos recentes. */
export function filterReceivables(list: DeliveryReceivable[], view: CashierView, query: string): DeliveryReceivable[] {
  if (view === "points" || view === "settlement") return [];
  return list.filter((r) => (view === "receivable" ? r.financialStatus === "pending" : true) && matchesReceivable(r, query));
}

export const pendingCount = (list: DeliveryReceivable[], query = ""): number =>
  list.filter((r) => r.financialStatus === "pending" && matchesReceivable(r, query)).length;

/** Enter na busca: o único delivery/retirada que a busca devolve (leitor de código de barras de comanda não passa por aqui). */
export function resolveReceivableScan(list: DeliveryReceivable[], raw: string): DeliveryReceivable | null {
  const value = raw.trim();
  if (!value) return null;
  const matches = list.filter((r) => matchesReceivable(r, value));
  const pending = matches.filter((r) => r.financialStatus === "pending");
  if (matches.length === 1) return matches[0];
  return pending.length === 1 ? pending[0] : null;
}

/** Pré-preenchimento do recebimento: forma pretendida e, em dinheiro com "troco para", o valor entregue. Tudo editável. */
export interface ReceiptPrefill {
  method: "cash" | "pix" | "debit_card" | "credit_card" | "other";
  /** Só dinheiro: texto do valor entregue sugerido (ex.: "50,00"), ou "" quando não há "troco para". */
  receivedText: string;
}
export function receiptPrefill(expectedMethod: ExpectedMethod | null, cashChangeFor: number | null, totalReais: number): ReceiptPrefill {
  const method = expectedMethod ?? "pix";
  if (method === "cash" && cashChangeFor !== null && cashChangeFor >= totalReais && totalReais > 0) {
    return { method, receivedText: cashChangeFor.toFixed(2).replace(".", ",") };
  }
  return { method, receivedText: "" };
}

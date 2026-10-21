// Acerto de entregadores no Caixa (Fase 4B): lógica PURA. O valor recebido pelo entregador fica em CUSTÓDIA até o Caixa
// confirmar o acerto; só então o núcleo oficial registra pagamento + movimento de caixa. Aqui só se tipa, soma e seleciona;
// o servidor revalida tudo (entregador, status do recibo, caixa aberto).
import { METHOD_LABEL, type ExpectedMethod } from "../delivery/deliveryLogic";

export type PayMethod = Exclude<ExpectedMethod, never>;

export interface RawSettlementReceipt {
  receipt_id: string;
  delivery_order_id: string;
  service_session_id: string;
  short_code: string;
  customer_name: string;
  order_total: number | string;
  expected_method: ExpectedMethod | null;
  method: ExpectedMethod;
  amount: number | string;
  amount_received: number | string | null;
  change_amount: number | string;
  note: string | null;
  received_at: string;
  delivery_status: string;
}

export interface RawSettlementGroup {
  courier_user_id: string;
  courier_name: string;
  receipts_count: number;
  total: number | string;
  by_method: Record<string, number | string>;
  receipts: RawSettlementReceipt[];
}

export interface SettlementReceipt {
  receiptId: string;
  deliveryOrderId: string;
  sessionId: string;
  shortCode: string;
  customerName: string;
  orderTotal: number;
  expectedMethod: ExpectedMethod | null;
  method: ExpectedMethod;
  amount: number;
  amountReceived: number | null;
  changeAmount: number;
  note: string | null;
  receivedAt: string;
  deliveryStatus: string;
}

export interface SettlementGroup {
  courierUserId: string;
  courierName: string;
  count: number;
  total: number;
  byMethod: Record<ExpectedMethod, number>;
  receipts: SettlementReceipt[];
}

export interface SettlementResult {
  settlementId: string;
  receiptCount: number;
  totalAmount: number;
  byMethod: Record<ExpectedMethod, number>;
  replayed: boolean;
}

const num = (v: number | string | null | undefined): number => Number(v ?? 0);
export const METHODS: readonly ExpectedMethod[] = ["cash", "pix", "debit_card", "credit_card", "other"];

function methodTotals(raw: Record<string, number | string> | undefined): Record<ExpectedMethod, number> {
  const out = { cash: 0, pix: 0, debit_card: 0, credit_card: 0, other: 0 } as Record<ExpectedMethod, number>;
  for (const m of METHODS) out[m] = num(raw?.[m]);
  return out;
}

export function toSettlementGroup(raw: RawSettlementGroup): SettlementGroup {
  return {
    courierUserId: raw.courier_user_id,
    courierName: raw.courier_name || "Entregador",
    count: raw.receipts_count,
    total: num(raw.total),
    byMethod: methodTotals(raw.by_method),
    receipts: (raw.receipts ?? []).map((r) => ({
      receiptId: r.receipt_id,
      deliveryOrderId: r.delivery_order_id,
      sessionId: r.service_session_id,
      shortCode: r.short_code,
      customerName: r.customer_name,
      orderTotal: num(r.order_total),
      expectedMethod: r.expected_method,
      method: r.method,
      amount: num(r.amount),
      amountReceived: r.amount_received === null || r.amount_received === undefined ? null : num(r.amount_received),
      changeAmount: num(r.change_amount),
      note: r.note,
      receivedAt: r.received_at,
      deliveryStatus: r.delivery_status,
    })),
  };
}

/** Resposta de settle_courier_receipts. */
export function toSettlementResult(raw: { settlement_id?: string; receipt_count: number; total_amount: number | string; by_method: Record<string, number | string>; replayed?: boolean }): SettlementResult {
  return { settlementId: raw.settlement_id ?? "", receiptCount: raw.receipt_count, totalAmount: num(raw.total_amount), byMethod: methodTotals(raw.by_method), replayed: !!raw.replayed };
}

/** Soma (em centavos, sem erro de ponto flutuante) dos recibos escolhidos. */
export function selectedTotal(group: SettlementGroup, selected: ReadonlySet<string>): number {
  const cents = group.receipts.reduce((acc, r) => acc + (selected.has(r.receiptId) ? Math.round(r.amount * 100) : 0), 0);
  return cents / 100;
}

export function selectedByMethod(group: SettlementGroup, selected: ReadonlySet<string>): Record<ExpectedMethod, number> {
  const cents = { cash: 0, pix: 0, debit_card: 0, credit_card: 0, other: 0 } as Record<ExpectedMethod, number>;
  for (const r of group.receipts) if (selected.has(r.receiptId)) cents[r.method] += Math.round(r.amount * 100);
  for (const m of METHODS) cents[m] /= 100;
  return cents;
}

export function toggleReceipt(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export const selectAll = (group: SettlementGroup): Set<string> => new Set(group.receipts.map((r) => r.receiptId));

/** Só o que ainda existe no grupo: depois de recarregar, recibo acertado/anulado por outro aparelho sai da seleção. */
export function pruneSelection(group: SettlementGroup | undefined, selected: ReadonlySet<string>): Set<string> {
  const alive = new Set((group?.receipts ?? []).map((r) => r.receiptId));
  return new Set([...selected].filter((id) => alive.has(id)));
}

export const pendingSettlementCount = (groups: SettlementGroup[]): number => groups.reduce((acc, g) => acc + g.count, 0);
export const pendingSettlementTotal = (groups: SettlementGroup[]): number => groups.reduce((acc, g) => acc + Math.round(g.total * 100), 0) / 100;

/** "Dinheiro R$ 40,00 · Pix R$ 20,00" — só as formas com valor. */
export function methodSummary(byMethod: Record<ExpectedMethod, number>, format: (n: number) => string): string {
  return METHODS.filter((m) => byMethod[m] > 0).map((m) => `${METHOD_LABEL[m]} ${format(byMethod[m])}`).join(" · ");
}

/** Mensagem para quem tenta acertar sem selecionar nada. */
export const NOTHING_SELECTED = "Marque ao menos um recebimento para acertar.";

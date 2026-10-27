// Acerto de entregadores no Caixa (Fase 4B): lógica PURA. O valor recebido pelo entregador fica em CUSTÓDIA até o Caixa
// confirmar o acerto; só então o núcleo oficial registra pagamento + movimento de caixa. Aqui só se tipa, soma e seleciona;
// o servidor revalida tudo (entregador, status do recibo, caixa aberto).
import { METHOD_LABEL, parseMoney, type ExpectedMethod } from "../delivery/deliveryLogic";

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
  // troco do entregador (migration 20261030010000); ausentes em servidor antigo => 0
  advance_id?: string | null;
  advance_amount?: number | string | null;
  sale_cash?: number | string | null;
  expected_return?: number | string | null;
  net_sale?: number | string | null;
}

export interface RawSettlementGroup {
  courier_user_id: string;
  courier_name: string;
  receipts_count: number;
  total: number | string;
  advance_total?: number | string | null;
  expected_total?: number | string | null;
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
  advanceId: string | null;
  /** Troco adiantado ao entregador para este pedido (0 = sem adiantamento). */
  advanceAmount: number;
  /** Parte em dinheiro da venda. */
  saleCash: number;
  /** Dinheiro bruto esperado na devolução = venda em dinheiro + adiantamento. */
  expectedReturn: number;
  /** Valor líquido da venda (o que vira faturamento). */
  netSale: number;
}

export interface SettlementGroup {
  courierUserId: string;
  courierName: string;
  count: number;
  total: number;
  advanceTotal: number;
  expectedTotal: number;
  byMethod: Record<ExpectedMethod, number>;
  receipts: SettlementReceipt[];
}

export interface SettlementResult {
  settlementId: string;
  receiptCount: number;
  totalAmount: number;
  byMethod: Record<ExpectedMethod, number>;
  replayed: boolean;
  expectedTotal: number | null;
  countedTotal: number | null;
  differenceTotal: number;
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
    advanceTotal: num(raw.advance_total),
    expectedTotal: raw.expected_total === null || raw.expected_total === undefined ? num(raw.total) : num(raw.expected_total),
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
      advanceId: r.advance_id ?? null,
      advanceAmount: num(r.advance_amount),
      saleCash: r.sale_cash === null || r.sale_cash === undefined ? (r.method === "cash" ? num(r.amount) : 0) : num(r.sale_cash),
      expectedReturn: r.expected_return === null || r.expected_return === undefined ? (r.method === "cash" ? num(r.amount) : 0) + num(r.advance_amount) : num(r.expected_return),
      netSale: r.net_sale === null || r.net_sale === undefined ? num(r.amount) : num(r.net_sale),
    })),
  };
}

/** Resposta de settle_courier_receipts. */
export function toSettlementResult(raw: { settlement_id?: string; receipt_count: number; total_amount: number | string; by_method: Record<string, number | string>; replayed?: boolean; expected_total?: number | string; counted_total?: number | string; difference_total?: number | string }): SettlementResult {
  return {
    settlementId: raw.settlement_id ?? "",
    receiptCount: raw.receipt_count,
    totalAmount: num(raw.total_amount),
    byMethod: methodTotals(raw.by_method),
    replayed: !!raw.replayed,
    expectedTotal: raw.expected_total === undefined ? null : num(raw.expected_total),
    countedTotal: raw.counted_total === undefined ? null : num(raw.counted_total),
    differenceTotal: num(raw.difference_total),
  };
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

// ---- Troco do entregador: dinheiro bruto esperado, contado, diferença -----------------------------------------------------
const toCents = (v: number): number => Math.round(v * 100);

/** Dinheiro bruto esperado na devolução dos recibos escolhidos (venda em dinheiro + troco adiantado). */
export function selectedExpectedReturn(group: SettlementGroup, selected: ReadonlySet<string>): number {
  return group.receipts.reduce((acc, r) => acc + (selected.has(r.receiptId) ? toCents(r.expectedReturn) : 0), 0) / 100;
}
export function selectedAdvance(group: SettlementGroup, selected: ReadonlySet<string>): number {
  return group.receipts.reduce((acc, r) => acc + (selected.has(r.receiptId) ? toCents(r.advanceAmount) : 0), 0) / 100;
}
/** Líquido da venda (faturamento) dos recibos escolhidos: nunca inclui o adiantamento devolvido. */
export function selectedNetSales(group: SettlementGroup, selected: ReadonlySet<string>): number {
  return group.receipts.reduce((acc, r) => acc + (selected.has(r.receiptId) ? toCents(r.netSale) : 0), 0) / 100;
}

/** Valor contado de UM recibo: vazio = o esperado. `error` quando o texto é inválido. */
export function countedOf(r: SettlementReceipt, text: string | undefined): { value: number; error: string | null } {
  const t = (text ?? "").trim();
  if (!t) return { value: r.expectedReturn, error: null };
  const v = parseMoney(t);
  if (v === null || v < 0) return { value: r.expectedReturn, error: `Valor contado inválido (#${r.shortCode}).` };
  return { value: v, error: null };
}

export interface SettleItem {
  receipt_id: string;
  counted_amount: number;
  note: string | null;
}

export interface SettlePlan {
  items: SettleItem[];
  expectedTotal: number;
  countedTotal: number;
  /** esperado - contado (positivo = falta). */
  difference: number;
  /** Primeiro impedimento (valor inválido ou diferença sem motivo); null = pode confirmar. */
  problem: string | null;
}

/** Monta o acerto com dinheiro bruto. Diferença exige motivo (o servidor confere de novo). */
export function planSettlement(group: SettlementGroup, selected: ReadonlySet<string>, countedText: Record<string, string>, notes: Record<string, string>): SettlePlan {
  const items: SettleItem[] = [];
  let expected = 0;
  let counted = 0;
  let problem: string | null = null;
  for (const r of group.receipts) {
    if (!selected.has(r.receiptId)) continue;
    const c = countedOf(r, countedText[r.receiptId]);
    if (c.error && !problem) problem = c.error;
    const diff = toCents(r.expectedReturn) - toCents(c.value);
    const note = (notes[r.receiptId] ?? "").trim();
    if (!c.error && diff !== 0 && !note && !problem) problem = `Informe o motivo da diferença (#${r.shortCode}).`;
    expected += toCents(r.expectedReturn);
    counted += toCents(c.value);
    items.push({ receipt_id: r.receiptId, counted_amount: c.value, note: note || null });
  }
  return { items, expectedTotal: expected / 100, countedTotal: counted / 100, difference: (expected - counted) / 100, problem };
}

/** Texto do botão: "Confirmar recebimento de R$ 100,00" (dinheiro bruto que o entregador devolve). */
export const confirmReceiptLabel = (total: number, format: (n: number) => string): string => `Confirmar recebimento de ${format(total)}`;

/** Chave estável da tentativa: mesma seleção, valores e motivos => mesmo request id (nunca duplica); qualquer mudança gera outro. */
export function attemptKey(plan: SettlePlan): string {
  return plan.items.map((i) => `${i.receipt_id}:${i.counted_amount}:${i.note ?? ""}`).sort().join("|");
}

// ---- Pendências financeiras do troco (listadas no Caixa) ---------------------------------------------------------------------
export interface RawPendingReturn {
  advance_id: string;
  delivery_order_id: string;
  short_code: string;
  courier_user_id: string;
  courier_name: string;
  customer_name: string;
  delivery_status: string;
  cancel_reason: string | null;
  amount: number | string;
  given_at: string;
}
export interface RawOpenDifference {
  line_id: string;
  kind: "settlement" | "advance_return";
  delivery_order_id: string;
  short_code: string;
  courier_user_id: string;
  courier_name: string;
  expected: number | string;
  counted: number | string;
  difference: number | string;
  shortfall_open: number | string;
  reason: string | null;
  created_at: string;
}
export interface PendingReturn {
  advanceId: string;
  deliveryOrderId: string;
  shortCode: string;
  courierName: string;
  customerName: string;
  deliveryStatus: string;
  cancelReason: string | null;
  amount: number;
  givenAt: string;
}
export interface OpenDifference {
  lineId: string;
  kind: "settlement" | "advance_return";
  shortCode: string;
  courierName: string;
  expected: number;
  counted: number;
  difference: number;
  shortfallOpen: number;
  reason: string | null;
  createdAt: string;
}
export interface CashPending {
  returns: PendingReturn[];
  differences: OpenDifference[];
}
export function toCashPending(raw: { pending_returns?: RawPendingReturn[]; open_differences?: RawOpenDifference[] } | null | undefined): CashPending {
  return {
    returns: (raw?.pending_returns ?? []).map((r) => ({
      advanceId: r.advance_id,
      deliveryOrderId: r.delivery_order_id,
      shortCode: r.short_code,
      courierName: r.courier_name || "Entregador",
      customerName: r.customer_name,
      deliveryStatus: r.delivery_status,
      cancelReason: r.cancel_reason,
      amount: num(r.amount),
      givenAt: r.given_at,
    })),
    differences: (raw?.open_differences ?? []).map((d) => ({
      lineId: d.line_id,
      kind: d.kind,
      shortCode: d.short_code,
      courierName: d.courier_name || "Entregador",
      expected: num(d.expected),
      counted: num(d.counted),
      difference: num(d.difference),
      shortfallOpen: num(d.shortfall_open),
      reason: d.reason,
      createdAt: d.created_at,
    })),
  };
}
export const cashPendingCount = (p: CashPending | null | undefined): number => (p ? p.returns.length + p.differences.length : 0);
export const cashPendingTotal = (p: CashPending | null | undefined): number =>
  p ? (p.returns.reduce((a, r) => a + toCents(r.amount), 0) + p.differences.reduce((a, d) => a + toCents(d.shortfallOpen), 0)) / 100 : 0;

/** Valor devolvido de um adiantamento: vazio = integral; inválido/maior que o adiantamento => erro. Diferença exige motivo. */
export function returnProblem(amount: number, text: string, note: string): { value: number; problem: string | null } {
  const t = text.trim();
  const v = t ? parseMoney(t) : amount;
  if (v === null || v < 0 || v > amount) return { value: amount, problem: "Informe um valor entre zero e o troco adiantado." };
  if (toCents(v) !== toCents(amount) && !note.trim()) return { value: v, problem: "Informe o motivo da diferença." };
  return { value: v, problem: null };
}
/** Regularização: valor > 0 e no máximo a pendência. */
export function resolveProblem(open: number, text: string): { value: number; problem: string | null } {
  const v = text.trim() ? parseMoney(text) : open;
  if (v === null || v <= 0 || toCents(v) > toCents(open)) return { value: open, problem: "Informe um valor maior que zero e até a pendência." };
  return { value: v, problem: null };
}

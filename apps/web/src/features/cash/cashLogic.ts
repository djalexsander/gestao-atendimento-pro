import { parseReais } from "../../lib/money";

// Regras puras do fechamento de conta e do caixa (sem React, sem Supabase). O servidor é a
// autoridade do total e da quitação (close_service_session); aqui só se calcula o que a tela
// mostra e se habilita o botão. Valores em REAIS (numeric(12,2) no banco), trabalhados em
// centavos inteiros para não acumular erro de ponto flutuante.

export type PaymentMethod = "cash" | "pix" | "debit_card" | "credit_card" | "other";

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: "Dinheiro",
  pix: "Pix",
  debit_card: "Cartão de débito",
  credit_card: "Cartão de crédito",
  other: "Outro",
};

export const PAYMENT_METHODS = Object.keys(PAYMENT_METHOD_LABEL) as PaymentMethod[];

// Uma linha do formulário de pagamento (textos como o usuário digitou).
export interface PaymentDraft {
  key: string;
  method: PaymentMethod;
  amount: string;
  received: string; // só dinheiro
}

export interface PaymentPayload {
  method: PaymentMethod;
  amount: number;
  amount_received?: number;
}

export function toCents(reais: number): number {
  return Math.round(reais * 100);
}

export function parseDraftCents(text: string): number | null {
  const reais = parseReais(text);
  return reais === null ? null : toCents(reais);
}

// Valor do pagamento da linha (centavos) = o que ABATE a conta (amount); 0 se vazio/inválido.
// O valor entregue pelo cliente (dinheiro) nunca entra aqui: só define o troco.
export function draftAppliedCents(draft: PaymentDraft): number {
  return parseDraftCents(draft.amount) ?? 0;
}

export function totalInformedCents(drafts: PaymentDraft[]): number {
  return drafts.reduce((sum, d) => sum + draftAppliedCents(d), 0);
}

export function remainingCents(totalCents: number, drafts: PaymentDraft[]): number {
  return totalCents - totalInformedCents(drafts);
}

// Troco de uma linha em dinheiro (centavos): recebido - aplicado, nunca negativo. Sem valor
// recebido informado, é considerado igual ao aplicado (troco 0).
export function draftChangeCents(draft: PaymentDraft): number {
  if (draft.method !== "cash") return 0;
  const applied = draftAppliedCents(draft);
  const received = draft.received.trim() === "" ? applied : (parseDraftCents(draft.received) ?? applied);
  return Math.max(0, received - applied);
}

// Erro de uma linha (ou null): valor > 0; dinheiro recebido >= aplicado.
export function draftProblem(draft: PaymentDraft): string | null {
  const applied = parseDraftCents(draft.amount);
  if (applied === null || applied <= 0) return "Informe um valor maior que zero.";
  if (draft.method === "cash" && draft.received.trim() !== "") {
    const received = parseDraftCents(draft.received);
    if (received === null) return "Valor entregue inválido.";
    if (received < applied) return "O valor entregue pelo cliente deve ser igual ou maior que o valor pago em dinheiro.";
  }
  return null;
}

// Só libera "Finalizar" com saldo zerado e todas as linhas válidas (conta sem valor não exige linhas).
export function canFinalize(totalCents: number, drafts: PaymentDraft[]): boolean {
  if (totalCents === 0) return drafts.length === 0;
  if (drafts.length === 0) return false;
  if (drafts.some((d) => draftProblem(d) !== null)) return false;
  return remainingCents(totalCents, drafts) === 0;
}

export function toPaymentPayload(drafts: PaymentDraft[]): PaymentPayload[] {
  return drafts.map((d) => {
    const amount = draftAppliedCents(d) / 100;
    if (d.method === "cash") {
      const received = d.received.trim() === "" ? amount : (parseDraftCents(d.received) ?? toCents(amount)) / 100;
      return { method: d.method, amount, amount_received: received };
    }
    return { method: d.method, amount };
  });
}

// Preenche uma nova linha com o saldo restante (atalho comum: "o resto no Pix").
export function suggestedAmountText(remaining: number): string {
  return remaining > 0 ? (remaining / 100).toFixed(2).replace(".", ",") : "";
}

let draftSeq = 0;
export function newDraft(method: PaymentMethod, amount: string): PaymentDraft {
  draftSeq += 1;
  return { key: `p${draftSeq}`, method, amount, received: "" };
}

// Valor inicial do caixa: "" vale 0.
export function parseOpeningAmount(text: string): number | null {
  if (text.trim() === "") return 0;
  return parseReais(text);
}

// --- Resumo do caixa (tela administrativa) ---------------------------------

export type MovementType = "sale" | "supply" | "withdrawal" | "refund";

export const MOVEMENT_TYPE_LABEL: Record<MovementType, string> = {
  sale: "Venda",
  supply: "Suprimento",
  withdrawal: "Sangria",
  refund: "Estorno",
};

export interface CashMovementRow {
  id: string;
  movementType: MovementType;
  paymentMethod: PaymentMethod;
  amount: number;
  description: string;
  createdAt: string;
}

export interface CashSummary {
  // Vendas por forma de pagamento (suprimento/sangria NUNCA entram aqui).
  byMethod: Record<PaymentMethod, number>;
  total: number; // total vendido (só vendas)
  supply: number;
  withdrawal: number;
  // Estornos PAGOS por este caixa (todas as formas); só os em dinheiro saem da gaveta.
  refund: number;
  // Dinheiro físico movimentado no caixa: vendas em dinheiro + suprimentos - sangrias - estornos
  // em dinheiro (somado ao saldo inicial dá o dinheiro esperado/disponível; o servidor é a autoridade).
  netCash: number;
}

export function summarizeMovements(movements: CashMovementRow[]): CashSummary {
  const cents: Record<PaymentMethod, number> = { cash: 0, pix: 0, debit_card: 0, credit_card: 0, other: 0 };
  let supply = 0;
  let withdrawal = 0;
  let refund = 0;
  let refundCash = 0;
  for (const m of movements) {
    if (m.movementType === "supply") supply += toCents(m.amount);
    else if (m.movementType === "withdrawal") withdrawal += toCents(m.amount);
    else if (m.movementType === "refund") {
      refund += toCents(m.amount);
      if (m.paymentMethod === "cash") refundCash += toCents(m.amount);
    } else cents[m.paymentMethod] += toCents(m.amount);
  }
  const total = Object.values(cents).reduce((a, b) => a + b, 0);
  return {
    byMethod: {
      cash: cents.cash / 100,
      pix: cents.pix / 100,
      debit_card: cents.debit_card / 100,
      credit_card: cents.credit_card / 100,
      other: cents.other / 100,
    },
    total: total / 100,
    supply: supply / 100,
    withdrawal: withdrawal / 100,
    refund: refund / 100,
    netCash: (cents.cash + supply - withdrawal - refundCash) / 100,
  };
}

// --- Estorno ------------------------------------------------------------------------------------
// O estorno é financeiro e ligado ao PAGAMENTO original: cada pagamento sabe quanto foi pago, quanto
// já foi estornado e quanto ainda pode ser. O servidor (refund_service_payment) é a autoridade.

export interface PaymentRefund {
  id: string;
  paymentId: string;
  amount: number;
  reason: string;
  createdAt: string;
  createdByName: string | null;
}

export interface SalePaymentRow {
  paymentId: string;
  method: PaymentMethod;
  amount: number;
  label: string; // "Venda - Comanda CMD001"
  createdAt: string;
}

export interface RefundablePayment extends SalePaymentRow {
  refunded: number;
  available: number;
  refunds: PaymentRefund[];
}

export function buildRefundablePayments(sales: SalePaymentRow[], refunds: PaymentRefund[]): RefundablePayment[] {
  return sales.map((sale) => {
    const mine = refunds.filter((r) => r.paymentId === sale.paymentId);
    const refundedCents = mine.reduce((sum, r) => sum + toCents(r.amount), 0);
    return {
      ...sale,
      refunded: refundedCents / 100,
      available: Math.max(0, toCents(sale.amount) - refundedCents) / 100,
      refunds: [...mine].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    };
  });
}

// Original / estornado / líquido do conjunto de pagamentos (a venda bruta original nunca é reduzida).
export function refundTotals(payments: RefundablePayment[]): { original: number; refunded: number; net: number } {
  const original = payments.reduce((s, p) => s + toCents(p.amount), 0);
  const refunded = payments.reduce((s, p) => s + toCents(p.refunded), 0);
  return { original: original / 100, refunded: refunded / 100, net: (original - refunded) / 100 };
}

// --- Conferência do dinheiro no fechamento ---------------------------------
// netCash = vendas em dinheiro + suprimentos - sangrias (CashSummary.netCash).
// A tela só PREVÊ o que o servidor vai gravar (close_cash_session recalcula tudo e é a autoridade).

export interface CashReconciliation {
  expectedCents: number; // saldo inicial + vendas em dinheiro
  countedCents: number | null; // null = campo vazio/inválido
  differenceCents: number | null; // contado - esperado
}

export function reconcile(openingAmount: number, netCash: number, countedText: string): CashReconciliation {
  const expectedCents = toCents(openingAmount) + toCents(netCash);
  const countedCents = parseDraftCents(countedText);
  return { expectedCents, countedCents, differenceCents: countedCents === null ? null : countedCents - expectedCents };
}

// Texto do resultado da conferência (cents em centavos; sinal decide falta/sobra).
export function describeDifference(differenceCents: number, format: (reais: number) => string): string {
  if (differenceCents === 0) return "Caixa confere";
  const value = format(Math.abs(differenceCents) / 100);
  return differenceCents < 0 ? `Falta ${value}` : `Sobra ${value}`;
}

// Diferença exige observação; o fechamento de caixa alheio também (uma só observação vale pelas duas).
export function closingNotesRequired(differenceCents: number | null, otherOperator: boolean): boolean {
  return otherOperator || (differenceCents !== null && differenceCents !== 0);
}

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

// Valor aplicado da linha (centavos); 0 se vazio/ inválido.
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
    if (received === null) return "Valor recebido inválido.";
    if (received < applied) return "O valor recebido deve ser igual ou maior que o valor aplicado.";
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

export interface CashMovementRow {
  id: string;
  paymentMethod: PaymentMethod;
  amount: number;
  description: string;
  createdAt: string;
}

export interface CashSummary {
  byMethod: Record<PaymentMethod, number>;
  total: number;
}

export function summarizeMovements(movements: CashMovementRow[]): CashSummary {
  const cents: Record<PaymentMethod, number> = { cash: 0, pix: 0, debit_card: 0, credit_card: 0, other: 0 };
  for (const m of movements) cents[m.paymentMethod] += toCents(m.amount);
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
  };
}

// --- Conferência do dinheiro no fechamento ---------------------------------
// A tela só PREVÊ o que o servidor vai gravar (close_cash_session recalcula tudo e é a autoridade).

export interface CashReconciliation {
  expectedCents: number; // saldo inicial + vendas em dinheiro
  countedCents: number | null; // null = campo vazio/inválido
  differenceCents: number | null; // contado - esperado
}

export function reconcile(openingAmount: number, cashSales: number, countedText: string): CashReconciliation {
  const expectedCents = toCents(openingAmount) + toCents(cashSales);
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

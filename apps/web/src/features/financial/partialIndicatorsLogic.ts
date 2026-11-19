import { METHOD_LABEL, type PaymentMethodKey, type ReportData } from "../reports/reportsLogic";

// E9.6 — Indicadores financeiros dos pagamentos parciais (PURO; sem React/Supabase). Os números vêm PRONTOS do servidor
// (report_period, E9.1); aqui só se interpreta o JSON, se confere a coerência interna e se decide o que mostrar.
//
// MÓDULO DESLIGADO: o JSON do servidor é o legado (sem `open_accounts`, sem `corrections`) e o resultado daqui é `null`:
// nenhuma tela muda. LIGADO, os blocos são SEPARADOS e NUNCA somados entre si (cada um responde uma pergunta diferente):
//   • Formas de pagamento = SÓ vendas FECHADAS no período: recebido (paid) − correções (corrections) − devoluções (refunded) = líquido (net).
//   • Recebido em contas ainda abertas (open_accounts) = dinheiro que entrou em contas NÃO encerradas até o fim do período. Não é venda.
//   • Correções de pagamento (E6: estorno que RECOMPÕE o saldo de uma conta aberta) = visão por EVENTO no período (sales/refunds.corrections).
//     Não é devolução de venda fechada: devolução = refunds.total/count (já exclui as correções, pelo servidor).
//   • Caixa: cash.correction_refund_total é PARTE de cash.refund_total (estornos pagos pelo caixa, de QUALQUER forma, pois cash_movements registra todas);
//     nunca soma por cima. O saldo físico esperado usa só os estornos em DINHEIRO (cash_movements.payment_method='cash'), outra conta.
// As correções por evento (sales.corrections) NÃO são a soma de methods[].corrections + open_accounts.corrections: o primeiro é por
// data do estorno, os outros dois por situação da conta. Por isso são mostrados em blocos distintos, jamais totalizados juntos.

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const cents = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) : null);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

// Papéis que enxergam valores financeiros agregados: o mesmo conjunto que o servidor exige em report_period (owner/admin).
export const canViewPartialIndicators = (role: string | null | undefined): boolean => role === "owner" || role === "admin";

export interface PartialMethodRow { method: PaymentMethodKey; label: string; paidCents: number; correctionsCents: number; refundedCents: number; netCents: number }
export interface PartialIndicators {
  salesCorrectionsCents: number;          // sales.corrections — correções de pagamento registradas no período (evento)
  refundCorrections: { count: number; totalCents: number }; // refunds.corrections — idem, em quantidade e valor
  openAccounts: { accounts: number; receivedCents: number; correctionsCents: number; netCents: number }; // recebido em contas ainda abertas
  cashCorrectionRefundCents: number;      // cash.correction_refund_total — parte das correções dentro do estorno pago pelo caixa (todas as formas)
  methods: PartialMethodRow[];            // só vendas FECHADAS no período
  methodsNetCents: number;                // soma dos líquidos por forma (vendas fechadas)
  // Devoluções de venda fechada (refunds.total/count), já SEM as correções. Mantidas separadas das correções.
  devolutionsCents: number;
  devolutionsCount: number;
  consistent: boolean;                    // coerência interna do JSON (linhas por forma e conta aberta fecham)
  problems: string[];
}

const METHODS: PaymentMethodKey[] = ["cash", "pix", "debit_card", "credit_card", "other"];

// null = módulo desligado (JSON legado). Objeto com `consistent=false` = JSON do módulo ligado porém incoerente (mostrar aviso, nunca esconder).
export function parsePartialIndicators(report: ReportData): PartialIndicators | null {
  const r = report as unknown as Record<string, unknown>;
  if (!isObj(r.open_accounts)) return null;
  const problems: string[] = [];
  const sales = isObj(r.sales) ? r.sales : {};
  const refunds = isObj(r.refunds) ? r.refunds : {};
  const cash = isObj(r.cash) ? r.cash : {};
  const oa = r.open_accounts;

  const salesCorr = cents(sales.corrections);
  const refCorr = isObj(refunds.corrections) ? refunds.corrections : null;
  const refCorrCount = refCorr ? count(refCorr.count) : null, refCorrTotal = refCorr ? cents(refCorr.total) : null;
  const oaAccounts = count(oa.accounts), oaReceived = cents(oa.received), oaCorr = cents(oa.corrections), oaNet = cents(oa.net);
  const cashCorr = cents(cash.correction_refund_total);
  if (salesCorr === null) problems.push("sales.corrections ausente");
  if (refCorrCount === null || refCorrTotal === null) problems.push("refunds.corrections ausente");
  if (oaAccounts === null || oaReceived === null || oaCorr === null || oaNet === null) problems.push("open_accounts incompleto");
  if (cashCorr === null) problems.push("cash.correction_refund_total ausente");

  const rows: PartialMethodRow[] = [];
  const list = Array.isArray(r.methods) ? r.methods : [];
  for (const raw of list) {
    if (!isObj(raw)) { problems.push("forma de pagamento inválida"); continue; }
    const method = raw.method as PaymentMethodKey;
    const paid = cents(raw.paid), corr = cents(raw.corrections), refunded = cents(raw.refunded), net = cents(raw.net);
    if (!METHODS.includes(method) || paid === null || corr === null || refunded === null || net === null) { problems.push("forma de pagamento incompleta"); continue; }
    if (net !== paid - corr - refunded) problems.push(`${METHOD_LABEL[method]}: líquido não fecha`);
    rows.push({ method, label: METHOD_LABEL[method], paidCents: paid, correctionsCents: corr, refundedCents: refunded, netCents: net });
  }
  if (oaReceived !== null && oaCorr !== null && oaNet !== null && oaNet !== oaReceived - oaCorr) problems.push("contas abertas: líquido não fecha");
  // A correção devolvida pelo caixa é PARTE do total de estornos do caixa (refund_total): nunca maior que ele.
  const cashRefundTotal = cents(cash.refund_total);
  if (cashCorr !== null && cashRefundTotal !== null && cashCorr > cashRefundTotal) problems.push("correção do caixa maior que o total de estornos do caixa");

  return {
    salesCorrectionsCents: salesCorr ?? 0,
    refundCorrections: { count: refCorrCount ?? 0, totalCents: refCorrTotal ?? 0 },
    openAccounts: { accounts: oaAccounts ?? 0, receivedCents: oaReceived ?? 0, correctionsCents: oaCorr ?? 0, netCents: oaNet ?? 0 },
    cashCorrectionRefundCents: cashCorr ?? 0,
    methods: rows,
    methodsNetCents: rows.reduce((s, m) => s + m.netCents, 0),
    devolutionsCents: cents(refunds.total) ?? 0,
    devolutionsCount: count(refunds.count) ?? 0,
    consistent: problems.length === 0,
    problems,
  };
}

// Linhas de apresentação (rótulos fixos) usadas por Financeiro, Dashboard, Relatórios e PDF: um só texto para cada regra.
export interface PartialLine { key: string; label: string; cents: number; hint?: string; note?: string }
export const PARTIAL_LABELS = {
  openAccounts: "Recebimentos de contas ainda abertas",
  corrections: "Correções de pagamento",
  devolutions: "Devoluções de vendas fechadas",
  cashCorrections: "Correções devolvidas pelo caixa (todas as formas)",
  methodsTitle: "Formas de pagamento (vendas fechadas)",
} as const;
export const PARTIAL_NOTES = {
  openAccounts: "Dinheiro que entrou em contas ainda não encerradas. Não é venda: vira venda só quando a conta for fechada.",
  corrections: "Estorno que devolve o pagamento e reabre o saldo de uma conta aberta. Não é devolução de venda.",
  devolutions: "Dinheiro devolvido de vendas já fechadas. Não inclui as correções de pagamento.",
  cashCorrections: "Parte dos estornos pagos pelo caixa, em qualquer forma (Pix, cartão ou dinheiro). Só a parte em dinheiro reduz o saldo físico esperado; este valor não é descontado de novo.",
} as const;

export function partialLines(p: PartialIndicators): PartialLine[] {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return [
    { key: "open", label: PARTIAL_LABELS.openAccounts, cents: p.openAccounts.netCents, hint: plural(p.openAccounts.accounts, "conta", "contas"), note: PARTIAL_NOTES.openAccounts },
    { key: "corr", label: PARTIAL_LABELS.corrections, cents: p.refundCorrections.totalCents, hint: plural(p.refundCorrections.count, "correção", "correções"), note: PARTIAL_NOTES.corrections },
    { key: "dev", label: PARTIAL_LABELS.devolutions, cents: p.devolutionsCents, hint: plural(p.devolutionsCount, "devolução", "devoluções"), note: PARTIAL_NOTES.devolutions },
  ];
}

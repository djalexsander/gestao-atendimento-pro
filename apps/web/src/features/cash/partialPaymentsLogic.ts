import { parseDraftCents, toCents } from "./cashLogic";
import type { PaymentMethod } from "./cashLogic";

// E9.2 — Regras PURAS do estado financeiro da conta (pagamento parcial, divisão, estorno de conta aberta e encerramento).
// Sem React, sem Supabase, sem tela. O SERVIDOR é a autoridade (saldo, partes, quitação, papéis, módulo): aqui só se interpreta o que
// ele devolve, se montam os argumentos das RPCs e se validam os dados antes do envio. Valores em REAIS no banco (numeric(12,2)) e
// em CENTAVOS inteiros aqui. O recurso é controlado por empresa (módulo `partial_payments`, desligado por padrão).

export const PARTIAL_PAYMENTS_MODULE = "partial_payments";
export const MAX_SPLIT_PARTS = 50;
export const MIN_SPLIT_PARTS = 2;
export const MAX_PART_LABEL = 40;

// ---------------------------------------------------------------------------------------------- recurso por empresa e papéis
// Desligado por padrão: sem entitlement carregado, ou sem o módulo, é falso.
export function isPartialPaymentsEnabled(entitlements: { modules?: readonly string[] | null } | null | undefined): boolean {
  return !!entitlements && Array.isArray(entitlements.modules) && entitlements.modules.includes(PARTIAL_PAYMENTS_MODULE);
}

export type CompanyRole = "owner" | "admin" | "cashier" | "attendant" | "production" | "courier";
// Quem vê VALORES da conta, quem opera pagamento/divisão/encerramento e quem estorna (o banco decide de verdade; isto só esconde botões).
export const canViewFinancialValues = (role: CompanyRole | null | undefined): boolean => role === "owner" || role === "admin" || role === "cashier";
export const canOperatePartialPayments = canViewFinancialValues;
export const canRefundOpenPayment = (role: CompanyRole | null | undefined): boolean => role === "owner" || role === "admin";
// O atendente enxerga SÓ o status de pagamento, nunca valor.
export const canViewStatusOnly = (role: CompanyRole | null | undefined): boolean => role === "attendant";

// ---------------------------------------------------------------------------------------------- status
export type PaymentStatus = "closed" | "no_charge" | "unpaid" | "partial" | "paid";
export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  closed: "Encerrada",
  no_charge: "Sem cobrança",
  unpaid: "Sem pagamento",
  partial: "Pago em parte",
  paid: "Quitada",
};
export function paymentStatusLabel(status: string | null | undefined): string {
  return status && status in PAYMENT_STATUS_LABEL ? PAYMENT_STATUS_LABEL[status as PaymentStatus] : "—";
}
// Quando a conta está pronta para encerrar (o banco confirma na hora de encerrar).
export const readyToClose = (status: string | null | undefined): boolean => status === "paid" || status === "no_charge";

// ---------------------------------------------------------------------------------------------- leitura defensiva do estado (JSON do banco)
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const cents = (v: unknown): number | null => { const n = num(v); return n === null ? null : toCents(n); };
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export type SplitMode = "equal" | "values" | "products";
export interface PartState { partId: string; position: number; label: string; plannedCents: number; paidCents: number; pendingCents: number; status: "pending" | "partial" | "paid" }
export interface FinancialState {
  sessionId: string;
  sessionStatus: "open" | "closed";
  paymentStatus: PaymentStatus;
  totalCents: number;
  paidCents: number;
  refundedCents: number;
  netPaidCents: number;
  settledPaidCents: number;
  balanceDueCents: number;
  overpaidCents: number;
  paymentsCount: number;
  refundsCount: number;
  split: { id: string; mode: SplitMode; version: number } | null;
  parts: PartState[];
  undistributedCents: number | null;
  overDistributedCents: number | null;
}

// Devolve null se o JSON não tiver a forma esperada (nunca inventa valor).
export function parseFinancialState(raw: unknown): FinancialState | null {
  if (!isObj(raw)) return null;
  const sessionId = str(raw.service_session_id), status = str(raw.session_status), pay = str(raw.payment_status);
  const total = cents(raw.total), paid = cents(raw.paid), refunded = cents(raw.refunded), net = cents(raw.net_paid), settled = cents(raw.settled_paid), bal = cents(raw.balance_due), over = cents(raw.overpaid);
  if (!sessionId || (status !== "open" && status !== "closed") || !pay || !(pay in PAYMENT_STATUS_LABEL)) return null;
  if ([total, paid, refunded, net, settled, bal, over].some((x) => x === null)) return null;
  let split: FinancialState["split"] = null;
  if (isObj(raw.split)) {
    const id = str(raw.split.id), mode = str(raw.split.mode), version = num(raw.split.version);
    if (!id || (mode !== "equal" && mode !== "values" && mode !== "products") || version === null) return null;
    split = { id, mode, version };
  }
  const parts: PartState[] = [];
  if (Array.isArray(raw.parts)) {
    for (const p of raw.parts) {
      if (!isObj(p)) return null;
      const partId = str(p.part_id), position = num(p.position), label = str(p.label), planned = cents(p.planned), pd = cents(p.paid), pend = cents(p.pending), st = str(p.status);
      if (!partId || position === null || label === null || planned === null || pd === null || pend === null || (st !== "pending" && st !== "partial" && st !== "paid")) return null;
      parts.push({ partId, position, label, plannedCents: planned, paidCents: pd, pendingCents: pend, status: st });
    }
  }
  return {
    sessionId, sessionStatus: status, paymentStatus: pay as PaymentStatus,
    totalCents: total!, paidCents: paid!, refundedCents: refunded!, netPaidCents: net!, settledPaidCents: settled!, balanceDueCents: bal!, overpaidCents: over!,
    paymentsCount: num(raw.payments_count) ?? 0, refundsCount: num(raw.refunds_count) ?? 0,
    split, parts: parts.sort((a, b) => a.position - b.position),
    undistributedCents: raw.undistributed === null || raw.undistributed === undefined ? null : cents(raw.undistributed),
    overDistributedCents: raw.over_distributed === null || raw.over_distributed === undefined ? null : cents(raw.over_distributed),
  };
}

// Linha da visão geral das contas abertas. Atendente: SÓ status (financial = null); caixa/admin/dono: valores.
export interface OverviewRow {
  sessionId: string;
  servicePointId: string | null;
  paymentStatus: PaymentStatus;
  financial: null | { totalCents: number; settledPaidCents: number; balanceDueCents: number; overpaidCents: number; paymentsCount: number; hasSplit: boolean; undistributedCents: number | null; overDistributedCents: number | null; partsPending: number };
}
export interface PaymentOverview { rows: OverviewRow[]; totalOpen: number; truncated: boolean }
export function parsePaymentOverview(raw: unknown): PaymentOverview | null {
  if (!isObj(raw) || !Array.isArray(raw.sessions)) return null;
  const rows: OverviewRow[] = [];
  for (const s of raw.sessions) {
    if (!isObj(s)) return null;
    const sessionId = str(s.service_session_id), pay = str(s.payment_status);
    if (!sessionId || !pay || !(pay in PAYMENT_STATUS_LABEL)) return null;
    const hasValues = "total" in s;
    let financial: OverviewRow["financial"] = null;
    if (hasValues) {
      const total = cents(s.total), settled = cents(s.settled_paid), bal = cents(s.balance_due), over = cents(s.overpaid);
      if ([total, settled, bal, over].some((x) => x === null)) return null;
      financial = { totalCents: total!, settledPaidCents: settled!, balanceDueCents: bal!, overpaidCents: over!, paymentsCount: num(s.payments_count) ?? 0, hasSplit: s.has_split === true,
        undistributedCents: s.undistributed == null ? null : cents(s.undistributed), overDistributedCents: s.over_distributed == null ? null : cents(s.over_distributed), partsPending: num(s.parts_pending) ?? 0 };
    }
    rows.push({ sessionId, servicePointId: str(s.service_point_id), paymentStatus: pay as PaymentStatus, financial });
  }
  return { rows, totalOpen: num(raw.total_open) ?? rows.length, truncated: raw.truncated === true };
}

// ---------------------------------------------------------------------------------------------- idempotência (client_request_id)
// Um id ESTÁVEL por tentativa: reenvio, timeout e duplo clique reusam o MESMO id (o banco devolve a réplica sem duplicar). Só vira id novo
// depois de sucesso ou de uma recusa DEFINITIVA do servidor (PT4xx: a requisição recusada não deixa registro). Falha sem código do banco
// (rede/timeout) é ambígua: mantém o id.
export interface RequestKeys { keyFor(action: string): string; release(action: string): void; has(action: string): boolean; size(): number }
export function createRequestKeys(newId: () => string): RequestKeys {
  const keys = new Map<string, string>();
  return {
    keyFor(action) { let k = keys.get(action); if (!k) { k = newId(); keys.set(action, k); } return k; },
    release(action) { keys.delete(action); },
    has(action) { return keys.has(action); },
    size() { return keys.size; },
  };
}
export interface RpcError { code?: string | null; message?: string | null }
export const isDefinitiveRefusal = (e: RpcError | null | undefined): boolean => !!e && typeof e.code === "string" && /^PT4\d\d$/.test(e.code);
export const isAmbiguousFailure = (e: RpcError | null | undefined): boolean => !!e && !isDefinitiveRefusal(e);
// Depois de uma resposta: sucesso (sem erro) ou recusa definitiva liberam o id; falha ambígua mantém.
export function shouldReleaseKey(e: RpcError | null | undefined): boolean { return !e || isDefinitiveRefusal(e); }

// ---------------------------------------------------------------------------------------------- mensagens de erro
export const FEATURE_OFF_MESSAGE = "O recurso de pagamentos parciais não está habilitado para esta empresa.";
export function isFeatureOffError(e: RpcError | null | undefined): boolean { return !!e && e.code === "PT403" && /não está habilitado/.test(e.message ?? ""); }
// O saldo/divisão mudou por outro operador: a tela deve recarregar o estado antes de tentar de novo.
export function isStaleStateError(e: RpcError | null | undefined): boolean { return !!e && e.code === "PT409" && /(saldo da conta mudou|foi alterada por outra pessoa|Atualize a tela)/.test(e.message ?? ""); }
export function needsOpenCash(e: RpcError | null | undefined): boolean { return !!e && e.code === "PT412"; }
// O banco devolve PT4xx com mensagem pronta em português (sem valores sensíveis); o resto vira texto genérico.
export function describePartialError(e: RpcError | null | undefined, fallback: string): string {
  if (!e) return fallback;
  if (isFeatureOffError(e)) return FEATURE_OFF_MESSAGE;
  const code = e.code ?? "", message = e.message ?? "";
  if (code.startsWith("PT") && message) return message;
  return fallback;
}

// ---------------------------------------------------------------------------------------------- pagamento parcial
export interface PaymentInput {
  sessionId: string;
  method: PaymentMethod;
  amountCents: number;
  receivedCents?: number | null;     // só dinheiro; ausente = igual ao valor (sem troco)
  expectedBalanceCents?: number | null; // saldo que a tela mostrava; o banco recusa (PT409) se mudou
  partId?: string | null;            // conta dividida: parte que recebe
  allocations?: { partId: string; amountCents: number }[] | null; // excedente: alocações (exigem confirmação)
  confirmAllocation?: boolean;
}
export interface RegisterPaymentArgs {
  p_service_session_id: string; p_method: PaymentMethod; p_amount: number; p_amount_received: number | null; p_client_request_id: string;
  p_expected_balance: number | null; p_part_id: string | null; p_allocations: { part_id: string; amount: number }[] | null; p_confirm_allocation: boolean;
}
export const centsToReais = (c: number): number => c / 100;
export function changeCents(input: Pick<PaymentInput, "method" | "amountCents" | "receivedCents">): number {
  if (input.method !== "cash") return 0;
  return Math.max((input.receivedCents ?? input.amountCents) - input.amountCents, 0);
}
// Problema de preenchimento (texto para a tela) ou null. Usa o estado só para recusar o óbvio; a decisão final é do servidor.
export function validatePayment(input: PaymentInput, state?: FinancialState | null): string | null {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) return "Informe um valor maior que zero.";
  if (input.method === "cash") {
    const received = input.receivedCents ?? input.amountCents;
    if (!Number.isInteger(received) || received < input.amountCents) return "O valor entregue em dinheiro deve ser igual ou maior que o valor aplicado.";
  } else if (input.receivedCents !== null && input.receivedCents !== undefined) {
    return "Só o pagamento em dinheiro tem valor entregue e troco.";
  }
  if (input.partId && input.allocations) return "Informe a parte ou as alocações, não os dois.";
  if (input.allocations) {
    if (!input.confirmAllocation) return "Confirme a distribuição do valor entre as partes.";
    if (input.allocations.length < 1 || input.allocations.length > MAX_SPLIT_PARTS) return "Informe de 1 a 50 alocações.";
    if (new Set(input.allocations.map((a) => a.partId)).size !== input.allocations.length) return "A mesma parte aparece duas vezes.";
    if (input.allocations.some((a) => !Number.isInteger(a.amountCents) || a.amountCents <= 0)) return "O valor de cada alocação deve ser maior que zero.";
    if (input.allocations.reduce((s, a) => s + a.amountCents, 0) !== input.amountCents) return "As alocações precisam somar o valor do pagamento.";
  }
  if (state) {
    if (state.sessionStatus !== "open") return "Esta conta já foi encerrada.";
    if (state.balanceDueCents <= 0) return "Esta conta não tem saldo a receber.";
    if (input.amountCents > state.balanceDueCents) return "O valor ultrapassa o saldo pendente da conta.";
    if (state.split && !input.partId && !input.allocations) return "Esta conta está dividida: escolha a parte que receberá o pagamento.";
    if (!state.split && (input.partId || input.allocations)) return "Esta conta não tem divisão; não informe parte.";
    if (state.overDistributedCents !== null && state.overDistributedCents > 0 && state.split) return "As partes passam do total da conta. Refaça a divisão antes de receber.";
    if (input.partId && state.split) {
      const part = state.parts.find((p) => p.partId === input.partId);
      if (!part) return "Parte inexistente na divisão atual.";
      if (part.pendingCents <= 0) return "Esta parte já está quitada.";
    }
  }
  return null;
}
export function toRegisterPaymentArgs(input: PaymentInput, requestId: string): RegisterPaymentArgs {
  return {
    p_service_session_id: input.sessionId,
    p_method: input.method,
    p_amount: centsToReais(input.amountCents),
    p_amount_received: input.method === "cash" ? centsToReais(input.receivedCents ?? input.amountCents) : null,
    p_client_request_id: requestId,
    p_expected_balance: input.expectedBalanceCents === null || input.expectedBalanceCents === undefined ? null : centsToReais(input.expectedBalanceCents),
    p_part_id: input.partId ?? null,
    p_allocations: input.allocations ? input.allocations.map((a) => ({ part_id: a.partId, amount: centsToReais(a.amountCents) })) : null,
    p_confirm_allocation: input.confirmAllocation === true,
  };
}

// Várias formas de pagamento para o mesmo saldo = um pagamento por forma, em sequência, cada um com o SEU id. O saldo esperado de cada
// chamada é o saldo anterior menos o que já foi aplicado. Devolve null se a soma passar do saldo.
export interface MultiLine { method: PaymentMethod; amountCents: number; receivedCents?: number | null; partId?: string | null }
export function planMultiPayment(balanceCents: number, lines: MultiLine[]): { expectedBefore: number; line: MultiLine }[] | null {
  const plan: { expectedBefore: number; line: MultiLine }[] = [];
  let remaining = balanceCents;
  for (const line of lines) {
    if (!Number.isInteger(line.amountCents) || line.amountCents <= 0 || line.amountCents > remaining) return null;
    plan.push({ expectedBefore: remaining, line });
    remaining -= line.amountCents;
  }
  return plan;
}
export const parseMoneyInput = parseDraftCents;

// ---------------------------------------------------------------------------------------------- divisão
export interface SplitPartInput { label?: string; amountCents?: number; items?: { itemId: string; quantity: number }[] }
export function defaultPartLabels(n: number): string[] { return Array.from({ length: n }, (_, i) => `Pessoa ${i + 1}`); }
export function validateSplit(mode: SplitMode, parts: SplitPartInput[], pendingBalanceCents: number): string | null {
  if (parts.length < MIN_SPLIT_PARTS || parts.length > MAX_SPLIT_PARTS) return "Uma divisão precisa de 2 a 50 partes.";
  const labels = parts.map((p) => (p.label ?? "").trim()).filter((l) => l !== "");
  if (labels.some((l) => l.length > MAX_PART_LABEL)) return "O nome da parte pode ter no máximo 40 caracteres.";
  if (new Set(labels).size !== labels.length) return "Dois nomes de parte estão repetidos.";
  if (mode === "equal") {
    if (pendingBalanceCents < parts.length) return "O saldo é menor que o número de partes.";
    return null;
  }
  if (mode === "values") {
    if (parts.some((p) => !Number.isInteger(p.amountCents) || (p.amountCents ?? 0) <= 0)) return "O valor de cada parte deve ser maior que zero.";
    if (parts.reduce((s, p) => s + (p.amountCents ?? 0), 0) !== pendingBalanceCents) return "As partes precisam somar exatamente o saldo pendente.";
    return null;
  }
  // products
  for (const p of parts) {
    if (!p.items || p.items.length < 1) return "Cada parte precisa ter pelo menos um item.";
    for (const it of p.items) {
      if (!it.itemId || !Number.isInteger(it.quantity) || it.quantity <= 0) return "A quantidade de cada item deve ser um número inteiro maior que zero.";
    }
  }
  return null;
}
export interface ReplaceSplitArgs { p_service_session_id: string; p_mode: SplitMode; p_parts: Record<string, unknown>[]; p_expected_version: number; p_client_request_id: string }
// A versão informada é a que a tela está vendo (0 = ainda não há divisão); o banco recusa (PT409) se outra pessoa mudou.
export function toReplaceSplitArgs(sessionId: string, mode: SplitMode, parts: SplitPartInput[], currentVersion: number, requestId: string): ReplaceSplitArgs {
  const p_parts = parts.map((p, i) => {
    const label = (p.label ?? "").trim() || `Pessoa ${i + 1}`;
    if (mode === "equal") return { label };
    if (mode === "values") return { label, amount: centsToReais(p.amountCents ?? 0) };
    return { label, items: (p.items ?? []).map((it) => ({ item_id: it.itemId, quantity: it.quantity })) };
  });
  return { p_service_session_id: sessionId, p_mode: mode, p_parts, p_expected_version: currentVersion, p_client_request_id: requestId };
}

// ---------------------------------------------------------------------------------------------- estorno de conta aberta e encerramento
export interface RefundArgs { p_service_payment_id: string; p_amount: number; p_reason: string; p_client_request_id: string }
export function validateRefundOpen(amountCents: number, availableCents: number, reason: string): string | null {
  if (!Number.isInteger(amountCents) || amountCents <= 0) return "Informe um valor maior que zero.";
  if (amountCents > availableCents) return "O valor passa do que ainda pode ser estornado neste pagamento.";
  const r = reason.trim();
  if (r.length < 3) return "Informe o motivo do estorno.";
  if (r.length > 200) return "O motivo pode ter no máximo 200 caracteres.";
  return null;
}
export const toRefundOpenArgs = (paymentId: string, amountCents: number, reason: string, requestId: string): RefundArgs =>
  ({ p_service_payment_id: paymentId, p_amount: centsToReais(amountCents), p_reason: reason.trim(), p_client_request_id: requestId });
// Encerrar: só com a conta quitada segundo o ESTADO mais recente (o banco revalida tudo).
export function validateClose(state: FinancialState | null | undefined): string | null {
  if (!state) return "Carregue o estado da conta antes de encerrar.";
  if (state.sessionStatus !== "open") return "Esta conta já foi encerrada.";
  if (state.balanceDueCents > 0) return "Ainda há saldo a receber nesta conta.";
  if (state.overpaidCents > 0) return "A conta recebeu mais do que o total. Estorne o excedente antes de encerrar.";
  if ((state.overDistributedCents ?? 0) > 0) return "As partes da divisão passam do total da conta. Refaça a divisão antes de encerrar.";
  if ((state.undistributedCents ?? 0) > 0) return "Há valor da conta fora das partes da divisão. Refaça a divisão antes de encerrar.";
  if (state.parts.some((p) => p.pendingCents > 0)) return "Há parte da divisão ainda não quitada.";
  return null;
}
export const toCloseArgs = (sessionId: string, requestId: string) => ({ p_service_session_id: sessionId, p_client_request_id: requestId });

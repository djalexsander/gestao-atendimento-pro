import { PAYMENT_METHOD_LABEL, parseDraftCents, type PaymentMethod } from "./cashLogic";
import { formatCents } from "../../lib/money";
import {
  FEATURE_OFF_MESSAGE,
  centsToReais,
  changeCents,
  classifyOutcome,
  createRequestKeys,
  paymentSignature,
  suggestedPaymentCents,
  validateClose,
  validatePayment,
  validateRefundOpen,
  type FinancialState,
  type PaymentInput,
  type RpcError,
  type SessionPaymentRow,
} from "./partialPaymentsLogic";
import type { PartialPaymentsApi } from "./partialPaymentsApi";

// E9.4 — Controlador do diálogo financeiro da conta (sem React): é onde mora a regra de idempotência, de saldo desatualizado e de
// resultado desconhecido. O componente só desenha o que está aqui. O SERVIDOR é a autoridade do saldo, das partes e da quitação: depois
// de cada operação o estado vem do servidor (resposta da RPC ou nova leitura), nunca de conta feita no cliente.
//
// Regras centrais:
//  * cada tentativa tem UM client_request_id estável (mesmos dados = mesmo id): reenvio/timeout/clique duplo reaproveitam o id;
//  * falha SEM resposta do banco (rede/timeout) = resultado DESCONHECIDO: o id é mantido, o formulário trava e só se pode REENVIAR
//    o mesmo pedido (idempotente) ou conferir a situação; nunca se cria um id novo para a mesma operação;
//  * recusa definitiva (PT4xx) ou sucesso liberam o id; saldo/divisão desatualizados recarregam o estado antes de nova tentativa.

export interface PaymentForm {
  method: PaymentMethod;
  amountText: string;
  receivedText: string;                      // só dinheiro; vazio = igual ao valor aplicado (sem troco)
  partId: string | null;                     // conta dividida: parte que recebe
  allocations: { partId: string; text: string }[] | null; // excedente distribuído entre partes (exige confirmação)
  confirmAllocation: boolean;
}
export interface RefundForm { paymentId: string; amountText: string; reason: string }
export interface Notice { kind: "ok" | "error" | "info"; text: string }
export interface UnknownPending { op: "payment" | "refund" | "close"; text: string; countBefore: number }
export interface LastPayment { methodLabel: string; appliedCents: number; receivedCents: number | null; changeCents: number }
export interface FinanceView {
  loading: boolean;
  loadError: string | null;
  state: FinancialState | null;
  payments: SessionPaymentRow[];
  busy: boolean;
  notice: Notice | null;
  unknown: UnknownPending | null;
  needsCash: boolean;
  closed: boolean;
  lastPayment: LastPayment | null;
}

export interface ControllerDeps {
  api: PartialPaymentsApi;
  sessionId: string;
  canRefund: boolean;
  newId: () => string;
}

type Attempt = { op: "payment"; form: PaymentForm } | { op: "refund"; form: RefundForm } | { op: "close" };

export function createAccountFinanceController(deps: ControllerDeps) {
  const keys = createRequestKeys(deps.newId);
  const listeners = new Set<(v: FinanceView) => void>();
  let view: FinanceView = { loading: true, loadError: null, state: null, payments: [], busy: false, notice: null, unknown: null, needsCash: false, closed: false, lastPayment: null };
  let attempt: Attempt | null = null;     // última operação com resultado desconhecido (para reenviar com o MESMO id)
  let unknownKey: string | null = null;   // ação (chave) da operação pendente

  const set = (patch: Partial<FinanceView>) => { view = { ...view, ...patch }; for (const l of listeners) l(view); };
  const ok = (text: string): Notice => ({ kind: "ok", text });
  const err = (text: string): Notice => ({ kind: "error", text });

  async function load(): Promise<void> {
    set({ loading: true });
    const r = await deps.api.getFinancialState(deps.sessionId);
    if (!r.ok) { set({ loading: false, loadError: r.message }); return; }
    const payments = deps.canRefund ? await deps.api.listSessionPayments(deps.sessionId) : null;
    set({ loading: false, loadError: null, state: r.data, payments: payments && payments.ok ? payments.data : view.payments });
  }

  // Aplica o estado devolvido pela própria RPC (mesmo instante) ou, sem ele, recarrega do servidor.
  async function adopt(state: FinancialState | null | undefined): Promise<void> {
    if (state) {
      const payments = deps.canRefund ? await deps.api.listSessionPayments(deps.sessionId) : null;
      set({ state, loadError: null, payments: payments && payments.ok ? payments.data : view.payments });
    } else await load();
  }

  const parse = (text: string): number | null => parseDraftCents(text);

  function toInput(form: PaymentForm, st: FinancialState): { input: PaymentInput | null; problem: string | null } {
    const amount = parse(form.amountText);
    if (amount === null || amount <= 0) return { input: null, problem: "Informe um valor maior que zero." };
    let received: number | null = null;
    if (form.method === "cash") {
      received = form.receivedText.trim() === "" ? amount : parse(form.receivedText);
      if (received === null) return { input: null, problem: "Valor entregue inválido." };
    }
    let allocations: PaymentInput["allocations"] = null;
    if (form.allocations) {
      allocations = [];
      for (const a of form.allocations) {
        const c = parse(a.text);
        if (a.text.trim() === "") continue;
        if (c === null || c <= 0) return { input: null, problem: "Valor de alocação inválido." };
        allocations.push({ partId: a.partId, amountCents: c });
      }
    }
    const input: PaymentInput = {
      sessionId: deps.sessionId, method: form.method, amountCents: amount, receivedCents: received,
      expectedBalanceCents: st.balanceDueCents, partId: allocations ? null : form.partId, allocations, confirmAllocation: !!allocations && form.confirmAllocation,
    };
    return { input, problem: validatePayment(input, st) };
  }

  async function runPayment(form: PaymentForm): Promise<void> {
    const st = view.state;
    if (!st) return;
    const { input, problem } = toInput(form, st);
    const key = input ? `pay:${paymentSignature(input)}` : null;
    // Pendência de resultado desconhecido tem PRIORIDADE: só se pode reenviar exatamente o mesmo pedido (ou conferir a situação).
    if (unknownKey && unknownKey !== key) { set({ notice: err("Há uma operação com resultado desconhecido. Reenvie a mesma operação ou confira a situação antes de continuar.") }); return; }
    if (!input || !key || problem) { set({ notice: err(problem ?? "Dados inválidos.") }); return; }
    const requestId = keys.keyFor(key);
    set({ busy: true, notice: null });
    const r = await deps.api.registerPayment(input, requestId);
    const outcome = classifyOutcome(r.ok ? null : r.error);
    if (outcome === "unknown") {
      attempt = { op: "payment", form }; unknownKey = key;
      set({ busy: false, unknown: { op: "payment", countBefore: st.paymentsCount, text: "Não foi possível confirmar se o pagamento foi registrado (falha de conexão). Reenvie o MESMO pagamento: se ele já existir, o sistema não cobra de novo." } });
      return;
    }
    keys.release(key); attempt = null; unknownKey = null;
    if (r.ok) {
      await adopt(r.data.state);
      const applied = r.data.amountCents || input.amountCents;
      set({ busy: false, unknown: null, needsCash: false, notice: ok(r.data.replay ? "Este pagamento já estava registrado (não foi cobrado de novo)." : "Pagamento registrado."),
        lastPayment: { methodLabel: PAYMENT_METHOD_LABEL[input.method], appliedCents: applied, receivedCents: input.method === "cash" ? input.receivedCents ?? applied : null, changeCents: r.data.changeCents || changeCents(input) } });
      return;
    }
    if (outcome === "stale") { await load(); set({ busy: false, notice: err(`${r.message} O saldo foi atualizado: confira os valores.`) }); return; }
    if (outcome === "needs-cash") { set({ busy: false, needsCash: true, notice: err(r.message) }); return; }
    if (outcome === "feature-off") { set({ busy: false, notice: err(FEATURE_OFF_MESSAGE) }); return; }
    if (r.error.code === "PT409") await load();   // conflito de estado (parte quitada, conta fechada...): mostra a situação real
    set({ busy: false, notice: err(r.message) });
  }

  async function runRefund(form: RefundForm): Promise<void> {
    if (!deps.canRefund) { set({ notice: err("Só o proprietário ou um administrador pode estornar pagamentos.") }); return; }
    const pay = view.payments.find((p) => p.paymentId === form.paymentId);
    const amount = parse(form.amountText);
    if (!pay) { set({ notice: err("Escolha o pagamento a estornar.") }); return; }
    const problem = amount === null ? "Informe um valor maior que zero." : validateRefundOpen(amount, pay.availableCents, form.reason);
    if (problem || amount === null) { set({ notice: err(problem ?? "Valor inválido.") }); return; }
    const key = `refund:${form.paymentId}:${amount}:${form.reason.trim()}`;
    if (unknownKey && unknownKey !== key) { set({ notice: err("Há uma operação com resultado desconhecido. Reenvie a mesma ou confira a situação antes.") }); return; }
    const requestId = keys.keyFor(key);
    set({ busy: true, notice: null });
    const r = await deps.api.refundOpenPayment(form.paymentId, amount, form.reason, requestId);
    const outcome = classifyOutcome(r.ok ? null : r.error);
    if (outcome === "unknown") {
      attempt = { op: "refund", form }; unknownKey = key;
      set({ busy: false, unknown: { op: "refund", countBefore: view.state?.refundsCount ?? 0, text: "Não foi possível confirmar se o estorno foi registrado (falha de conexão). Reenvie o MESMO estorno: se já existir, não estorna de novo." } });
      return;
    }
    keys.release(key); attempt = null; unknownKey = null;
    if (r.ok) { await adopt(r.data.state); set({ busy: false, unknown: null, notice: ok(r.data.replay ? "Este estorno já estava registrado." : "Estorno registrado. O valor voltou para o saldo da conta.") }); return; }
    if (outcome === "stale") await load();
    set({ busy: false, needsCash: outcome === "needs-cash", notice: err(outcome === "feature-off" ? FEATURE_OFF_MESSAGE : r.message) });
  }

  async function runClose(): Promise<void> {
    const problem = validateClose(view.state);
    if (problem) { set({ notice: err(problem) }); return; }
    const key = `close:${deps.sessionId}`;
    if (unknownKey && unknownKey !== key) { set({ notice: err("Há uma operação com resultado desconhecido. Resolva antes de encerrar.") }); return; }
    const requestId = keys.keyFor(key);
    set({ busy: true, notice: null });
    const r = await deps.api.closeSettled(deps.sessionId, requestId);
    const outcome = classifyOutcome(r.ok ? null : r.error);
    if (outcome === "unknown") {
      attempt = { op: "close" }; unknownKey = key;
      set({ busy: false, unknown: { op: "close", countBefore: 0, text: "Não foi possível confirmar se a conta foi encerrada (falha de conexão). Reenvie o encerramento: é seguro repetir." } });
      return;
    }
    keys.release(key); attempt = null; unknownKey = null;
    if (r.ok) { set({ busy: false, unknown: null, closed: true, notice: ok("Conta encerrada.") }); return; }
    if (outcome === "stale" || outcome === "refused") await load();
    set({ busy: false, notice: err(outcome === "feature-off" ? FEATURE_OFF_MESSAGE : r.message) });
  }

  const guarded = <A extends unknown[]>(fn: (...a: A) => Promise<void>) => async (...a: A): Promise<void> => { if (view.busy) return; await fn(...a); };

  return {
    getView: () => view,
    subscribe(l: (v: FinanceView) => void) { listeners.add(l); return () => { listeners.delete(l); }; },
    load,
    // E9.5: depois de salvar a divisão, adota o estado devolvido pela RPC (ou recarrega do servidor).
    refresh: (state?: FinancialState | null) => adopt(state),
    registerPayment: guarded(runPayment),
    refund: guarded(runRefund),
    close: guarded(runClose),
    // Reenvia a operação de resultado desconhecido com o MESMO id (o banco devolve a réplica se já gravou).
    retryUnknown: guarded(async () => {
      if (!attempt) return;
      if (attempt.op === "payment") await runPayment(attempt.form);
      else if (attempt.op === "refund") await runRefund(attempt.form);
      else await runClose();
    }),
    // "Já conferi": descarta a pendência e mostra a situação real do servidor (o id da tentativa é liberado).
    confirmUnknown: guarded(async () => {
      const u = view.unknown;
      if (!u) return;
      const before = u.countBefore;
      if (unknownKey) keys.release(unknownKey);
      attempt = null; unknownKey = null;
      set({ busy: true });
      await load();
      const st = view.state;
      const changed = u.op === "payment" ? (st?.paymentsCount ?? 0) > before : u.op === "refund" ? (st?.refundsCount ?? 0) > before : st?.sessionStatus === "closed";
      set({ busy: false, unknown: null, closed: u.op === "close" && st?.sessionStatus === "closed" ? true : view.closed,
        notice: changed ? ok("A operação aparece registrada na conta.") : { kind: "info", text: "A operação não aparece na conta. Você pode registrá-la de novo." } });
    }),
    cashOpened() { set({ needsCash: false, notice: { kind: "info", text: "Caixa aberto. Registre o pagamento novamente." } }); },
    dismissNeedsCash() { set({ needsCash: false }); },
    clearNotice() { set({ notice: null }); },
    suggestedAmountText(partId?: string | null): string { const c = suggestedPaymentCents(view.state, partId); return c > 0 ? String(centsToReais(c).toFixed(2)).replace(".", ",") : ""; },
    summary(): { total: string; received: string; balance: string } { const s = view.state; return { total: s ? formatCents(s.totalCents) : "—", received: s ? formatCents(s.settledPaidCents) : "—", balance: s ? formatCents(s.balanceDueCents) : "—" }; },
    errorOf: (r: { ok: false; error: RpcError; message: string }) => r.message,
  };
}
export type AccountFinanceController = ReturnType<typeof createAccountFinanceController>;

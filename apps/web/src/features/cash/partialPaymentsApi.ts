import { supabase } from "../../lib/supabaseClient";
import {
  describePartialError,
  buildSessionPayments,
  parseFinancialState,
  parsePaymentOverview,
  toCloseArgs,
  toRefundOpenArgs,
  toRegisterPaymentArgs,
  toReplaceSplitArgs,
} from "./partialPaymentsLogic";
import { parseSplitHistory, type SplitHistory } from "./splitEditorLogic";
import type { FinancialState, MovementRow, PaymentInput, PaymentOverview, RpcError, SessionPaymentRow, SplitMode, SplitPartInput } from "./partialPaymentsLogic";

// E9.2 — Camada de dados do estado financeiro da conta (somente RPCs; nenhuma tela usa isto ainda). O recurso é controlado POR EMPRESA
// no banco (módulo partial_payments, desligado por padrão): desligado, as RPCs respondem PT403 "não está habilitado" e nada é gravado.
// O fluxo tradicional (cashApi.closeAccount / close_service_session) NÃO passa por aqui.

export type Rpc = (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: RpcError | null }>;

export type Outcome<T> = { ok: true; data: T } | { ok: false; error: RpcError; message: string };

const LOAD_ERROR = "Não foi possível carregar o estado da conta agora. Tente novamente.";
const PAY_ERROR = "Não foi possível registrar o pagamento agora. Tente novamente.";
const SPLIT_ERROR = "Não foi possível salvar a divisão agora. Tente novamente.";
const REFUND_ERROR = "Não foi possível registrar o estorno agora. Tente novamente.";
const CLOSE_ERROR = "Não foi possível encerrar a conta agora. Tente novamente.";

export interface RegisterPaymentResult {
  paymentId: string;
  replay: boolean;
  amountCents: number;
  changeCents: number;
  allocations: { partId: string; amountCents: number }[];
  state: FinancialState | null; // estado financeiro DEPOIS do pagamento (mesmo instante)
}
export interface RefundOpenResult { refundId: string | null; replay: boolean; state: FinancialState | null }
export interface CloseResult { sessionId: string; replayed: boolean; closedAt: string | null; totalCents: number | null }
export interface SplitResult { splitId: string | null; version: number | null; replay: boolean; state: FinancialState | null; raw: unknown }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const toCents = (v: unknown): number => (typeof v === "number" ? Math.round(v * 100) : typeof v === "string" && v !== "" ? Math.round(Number(v) * 100) : 0);

// Leitura dos movimentos de caixa de uma conta (vendas e estornos por pagamento), para o estorno de conta aberta. Mesma fonte que a tela
// de estorno de conta fechada já usa (cash_movements, com RLS): só owner/admin enxergam os movimentos de outros caixas.
export type MovementsReader = (sessionId: string) => Promise<{ data: MovementRow[] | null; error: RpcError | null }>;

export function createPartialPaymentsApi(rpc: Rpc, readMovements?: MovementsReader) {
  async function call<T>(name: string, args: Record<string, unknown>, fallback: string, map: (data: unknown) => T | null): Promise<Outcome<T>> {
    let res: { data: unknown; error: RpcError | null };
    try { res = await rpc(name, args); } catch { return { ok: false, error: { code: null, message: null }, message: fallback }; }
    if (res.error) return { ok: false, error: res.error, message: describePartialError(res.error, fallback) };
    const data = map(res.data);
    if (data === null) return { ok: false, error: { code: null, message: "resposta inesperada" }, message: fallback };
    return { ok: true, data };
  }
  return {
    // Leitura (owner/admin/cashier; o atendente só vê status em getPaymentStatus/overview)
    getFinancialState: (sessionId: string) =>
      call("get_session_financial_state", { p_service_session_id: sessionId }, LOAD_ERROR, (d) => parseFinancialState(d)),
    getPaymentStatus: (sessionId: string) =>
      call("get_session_payment_status", { p_service_session_id: sessionId }, LOAD_ERROR, (d) => (isObj(d) && typeof d.payment_status === "string" ? { sessionStatus: String(d.session_status), paymentStatus: d.payment_status } : null)),
    listPaymentOverview: (companyId: string) =>
      call<PaymentOverview>("list_session_payment_overview", { p_company_id: companyId }, LOAD_ERROR, (d) => parsePaymentOverview(d)),
    getSplitHistory: (sessionId: string) =>
      call<SplitHistory>("get_session_split_history", { p_service_session_id: sessionId }, LOAD_ERROR, (d) => parseSplitHistory(d)),
    listSessionPayments: async (sessionId: string): Promise<Outcome<SessionPaymentRow[]>> => {
      if (!readMovements) return { ok: false, error: { code: null, message: null }, message: LOAD_ERROR };
      try {
        const res = await readMovements(sessionId);
        if (res.error || !res.data) return { ok: false, error: res.error ?? { code: null, message: null }, message: LOAD_ERROR };
        return { ok: true, data: buildSessionPayments(res.data) };
      } catch { return { ok: false, error: { code: null, message: null }, message: LOAD_ERROR }; }
    },
    // Escrita (todas exigem o módulo ligado para a empresa; owner/admin/cashier, estorno só owner/admin)
    registerPayment: (input: PaymentInput, requestId: string) =>
      call<RegisterPaymentResult>("register_service_payment", toRegisterPaymentArgs(input, requestId) as unknown as Record<string, unknown>, PAY_ERROR, (d) => {
        if (!isObj(d) || typeof d.payment_id !== "string") return null;
        const allocs = Array.isArray(d.allocations) ? d.allocations.filter(isObj).map((a) => ({ partId: String(a.part_id), amountCents: toCents(a.amount) })) : [];
        return { paymentId: d.payment_id, replay: d.replay === true, amountCents: toCents(d.amount), changeCents: toCents(d.change_amount), allocations: allocs, state: parseFinancialState(d.state) };
      }),
    replaceSplit: (sessionId: string, mode: SplitMode, parts: SplitPartInput[], currentVersion: number, requestId: string) =>
      call<SplitResult>("replace_session_split", toReplaceSplitArgs(sessionId, mode, parts, currentVersion, requestId) as unknown as Record<string, unknown>, SPLIT_ERROR, (d) => {
        if (!isObj(d)) return null;
        const split = isObj(d.split) ? d.split : null;
        return { splitId: split && typeof split.id === "string" ? split.id : null, version: split && typeof split.version === "number" ? split.version : null, replay: d.replay === true, state: parseFinancialState(d.state), raw: d };
      }),
    refundOpenPayment: (paymentId: string, amountCents: number, reason: string, requestId: string) =>
      call<RefundOpenResult>("refund_open_session_payment", toRefundOpenArgs(paymentId, amountCents, reason, requestId) as unknown as Record<string, unknown>, REFUND_ERROR, (d) => {
        if (!isObj(d)) return null;
        return { refundId: typeof d.refund_id === "string" ? d.refund_id : null, replay: d.replay === true, state: parseFinancialState(d.state) };
      }),
    closeSettled: (sessionId: string, requestId: string) =>
      call<CloseResult>("close_settled_service_session", toCloseArgs(sessionId, requestId), CLOSE_ERROR, (d) => {
        if (!isObj(d) || typeof d.service_session_id !== "string") return null;
        return { sessionId: d.service_session_id, replayed: d.replayed === true, closedAt: typeof d.closed_at === "string" ? d.closed_at : null, totalCents: d.total_amount === null || d.total_amount === undefined ? null : toCents(d.total_amount) };
      }),
  };
}

export type PartialPaymentsApi = ReturnType<typeof createPartialPaymentsApi>;

// Instância de produção (nada a usa até a E9.3+).
export const partialPaymentsApi: PartialPaymentsApi = createPartialPaymentsApi(
  async (name, args) => {
    const { data, error } = await supabase.rpc(name, args);
    return { data, error: error ? { code: error.code ?? null, message: error.message ?? null } : null };
  },
  async (sessionId) => {
    const { data, error } = await supabase.from("cash_movements").select("service_payment_id, movement_type, payment_method, amount, created_at").eq("service_session_id", sessionId).in("movement_type", ["sale", "refund"]);
    return { data: (data ?? null) as MovementRow[] | null, error: error ? { code: error.code ?? null, message: error.message ?? null } : null };
  },
);

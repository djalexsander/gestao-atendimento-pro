import { classifyOutcome, createRequestKeys, FEATURE_OFF_MESSAGE, validateSplit, type FinancialState, type SplitMode, type SplitPartInput } from "./partialPaymentsLogic";
import { currentVersion, labelProblem, replaceImpact, type SplitHistory } from "./splitEditorLogic";
import type { PartialPaymentsApi } from "./partialPaymentsApi";

// E9.5 — Controlador do editor de divisão (sem React). Mesmas regras da E9.4: um client_request_id ESTÁVEL por tentativa (mesmos dados e
// mesma versão = mesmo id), resultado desconhecido (rede/timeout) trava e só permite reenviar o MESMO pedido, versão desatualizada
// (PT409) recarrega o histórico e o saldo antes de nova tentativa. O servidor cobre sempre o SALDO PENDENTE e nunca altera pagamentos nem
// alocações já feitos; aqui, quando há valor já pago na divisão atual, exige uma CONFIRMAÇÃO explícita antes de refazer.

export interface SplitDraft { mode: SplitMode; parts: SplitPartInput[]; confirmReplace: boolean }
export interface SplitNotice { kind: "ok" | "error" | "info"; text: string }
export interface SplitView { loading: boolean; history: SplitHistory | null; loadError: string | null; busy: boolean; notice: SplitNotice | null; unknown: { text: string } | null }

export interface SplitDeps {
  api: PartialPaymentsApi;
  sessionId: string;
  newId: () => string;
  getBalanceCents: () => number;
  onApplied: (state: FinancialState | null) => void | Promise<void>;   // estado novo (da RPC) ou null = recarregar do servidor
}

export function createSplitEditorController(deps: SplitDeps) {
  const keys = createRequestKeys(deps.newId);
  const listeners = new Set<(v: SplitView) => void>();
  let view: SplitView = { loading: true, history: null, loadError: null, busy: false, notice: null, unknown: null };
  let attempt: SplitDraft | null = null;
  let unknownKey: string | null = null;
  const set = (patch: Partial<SplitView>) => { view = { ...view, ...patch }; for (const l of listeners) l(view); };
  const err = (text: string): SplitNotice => ({ kind: "error", text });

  async function loadHistory(): Promise<void> {
    set({ loading: true });
    const r = await deps.api.getSplitHistory(deps.sessionId);
    if (!r.ok) { set({ loading: false, loadError: r.message }); return; }
    set({ loading: false, loadError: null, history: r.data });
  }

  async function run(draft: SplitDraft): Promise<void> {
    const history = view.history;
    if (!history) { set({ notice: err("Carregue o histórico da divisão antes de salvar.") }); return; }
    const balance = deps.getBalanceCents();
    const version = currentVersion(history);
    const key = `split:${deps.sessionId}:${version}:${draft.mode}:${JSON.stringify(draft.parts)}`;
    if (unknownKey && unknownKey !== key) { set({ notice: err("Há uma divisão com resultado desconhecido. Reenvie a mesma divisão ou confira a situação antes de continuar.") }); return; }
    if (balance <= 0) { set({ notice: err("Não há saldo pendente para dividir.") }); return; }
    const problem = labelProblem(draft.parts.map((p) => p.label ?? "")) ?? validateSplit(draft.mode, draft.parts, balance);
    if (problem) { set({ notice: err(problem) }); return; }
    if (replaceImpact(history, balance).needsConfirm && !draft.confirmReplace) { set({ notice: err("Confirme que entendeu o que acontece com o que já foi pago antes de refazer a divisão.") }); return; }
    const requestId = keys.keyFor(key);
    set({ busy: true, notice: null });
    const r = await deps.api.replaceSplit(deps.sessionId, draft.mode, draft.parts, version, requestId);
    const outcome = classifyOutcome(r.ok ? null : r.error);
    if (outcome === "unknown") {
      attempt = draft; unknownKey = key;
      set({ busy: false, unknown: { text: "Não foi possível confirmar se a divisão foi salva (falha de conexão). Reenvie a MESMA divisão: se ela já existir, o sistema não cria outra versão." } });
      return;
    }
    keys.release(key); attempt = null; unknownKey = null;
    if (r.ok) {
      await loadHistory();
      await deps.onApplied(r.data.state);
      set({ busy: false, unknown: null, notice: { kind: "ok", text: r.data.replay ? "Esta divisão já estava salva (nenhuma versão nova foi criada)." : `Divisão salva${r.data.version ? ` (versão ${r.data.version})` : ""}. Os pagamentos já feitos foram preservados.` } });
      return;
    }
    if (outcome === "stale" || (r.error.code === "PT409")) { await loadHistory(); await deps.onApplied(null); }
    set({ busy: false, notice: err(outcome === "feature-off" ? FEATURE_OFF_MESSAGE : outcome === "stale" ? `${r.message} A divisão atual foi recarregada: confira e refaça.` : r.message) });
  }

  const guarded = <A extends unknown[]>(fn: (...a: A) => Promise<void>) => async (...a: A): Promise<void> => { if (view.busy) return; await fn(...a); };
  return {
    getView: () => view,
    subscribe(l: (v: SplitView) => void) { listeners.add(l); return () => { listeners.delete(l); }; },
    loadHistory,
    save: guarded(run),
    retryUnknown: guarded(async () => { if (attempt) await run(attempt); }),
    // "Já conferi": descarta a pendência e recarrega o histórico real (o id da tentativa é liberado).
    confirmUnknown: guarded(async () => {
      if (!view.unknown) return;
      const before = currentVersion(view.history);
      if (unknownKey) keys.release(unknownKey);
      attempt = null; unknownKey = null;
      set({ busy: true });
      await loadHistory(); await deps.onApplied(null);
      const changed = currentVersion(view.history) > before;
      set({ busy: false, unknown: null, notice: changed ? { kind: "ok", text: "A divisão aparece salva (nova versão)." } : { kind: "info", text: "A divisão não aparece salva. Você pode salvá-la de novo." } });
    }),
    clearNotice() { set({ notice: null }); },
  };
}
export type SplitEditorController = ReturnType<typeof createSplitEditorController>;

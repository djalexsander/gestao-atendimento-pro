import { useEffect, useMemo, useRef, useState } from "react";
import { formatCents } from "../../lib/money";
import { parseDraftCents } from "./cashLogic";
import { createSplitEditorController, type SplitView } from "./splitEditorController";
import type { PartialPaymentsApi } from "./partialPaymentsApi";
import { MAX_SPLIT_PARTS, MIN_SPLIT_PARTS, validateSplit, type FinancialState, type SplitMode, type SplitPartInput } from "./partialPaymentsLogic";
import {
  MODE_LABEL, activeSplit, buildPool, equalPreview, labelProblem, partCents, personTotals, productsModeProblem, replaceImpact, unassignedUnits, validateProducts, valuesRemaining,
  type Assignment, type OrderItemSource,
} from "./splitEditorLogic";

// PDV do Caixa (v1.0.20) — editor de divisão na aba "Dividir conta" da coluna central (layout do preview aprovado: modos em botões, seletor de
// pessoas − n +, linhas compactas por valor e MATRIZ produto × pessoa com "Sobra"). Só muda o DESENHO: estado financeiro, histórico, versões,
// validações (labelProblem/validateSplit/validateProducts/replaceImpact), confirmação obrigatória, idempotência e resultado desconhecido
// vêm do MESMO splitEditorController e de splitEditorLogic usados pelo editor do diálogo (SplitEditor.tsx, intocado).

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
const STATUS_TEXT = { paid: "quitada", partial: "em andamento", pending: "pendente" } as const;
const MODE_BUTTON: Record<SplitMode, string> = { equal: "Igual", values: "Valores individuais", products: "Por produtos" };
const fmtDate = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }); };
const clampCount = (n: number) => Math.min(Math.max(Number.isFinite(n) ? Math.trunc(n) : MIN_SPLIT_PARTS, MIN_SPLIT_PARTS), MAX_SPLIT_PARTS);

function Stepper({ value, onChange, min = MIN_SPLIT_PARTS, max = MAX_SPLIT_PARTS, label }: { value: number; onChange: (n: number) => void; min?: number; max?: number; label: string }) {
  return (
    <span className="pdv-stepper" role="group" aria-label={label}>
      <button type="button" aria-label={`Menos ${label.toLowerCase()}`} disabled={value <= min} onClick={() => onChange(value - 1)}>−</button>
      <b data-testid="pdv-stepper-value">{value}</b>
      <button type="button" aria-label={`Mais ${label.toLowerCase()}`} disabled={value >= max} onClick={() => onChange(value + 1)}>+</button>
    </span>
  );
}

export function PdvSplitEditor({
  api,
  sessionId,
  state,
  orderItems,
  disabled,
  onApplied,
  onPendingChange,
}: {
  api: PartialPaymentsApi;
  sessionId: string;
  state: FinancialState;
  orderItems: OrderItemSource[];
  disabled: boolean;
  onApplied: (state: FinancialState | null) => void | Promise<void>;
  onPendingChange: (pending: boolean) => void;
}) {
  const balanceRef = useRef(state.balanceDueCents);
  balanceRef.current = state.balanceDueCents;
  const ctrl = useMemo(() => createSplitEditorController({ api, sessionId, newId, getBalanceCents: () => balanceRef.current, onApplied }), [api, sessionId, onApplied]);
  const [view, setView] = useState<SplitView>(ctrl.getView());
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<SplitMode>("equal");
  const [count, setCount] = useState(2);
  const [names, setNames] = useState<string[]>(["", ""]);
  const [rows, setRows] = useState<{ label: string; amount: string }[]>([{ label: "", amount: "" }, { label: "", amount: "" }]);
  const [assign, setAssign] = useState<Assignment[]>([{ label: "", qty: {} }, { label: "", qty: {} }]);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => { const off = ctrl.subscribe(setView); void ctrl.loadHistory(); return off; }, [ctrl]);
  const pending = view.busy || view.unknown !== null;
  useEffect(() => { onPendingChange(pending); }, [pending, onPendingChange]);
  useEffect(() => { void ctrl.loadHistory(); }, [ctrl, state.split?.version, state.balanceDueCents, state.paymentsCount]);

  const balance = state.balanceDueCents;
  const history = view.history;
  const act = activeSplit(history);
  const impact = replaceImpact(history, balance);
  const pool = useMemo(() => buildPool(orderItems, history), [orderItems, history]);
  const poolOpen = pool.filter((it) => it.available > 0);
  const locked = disabled || pending;

  const amounts = rows.map((r) => parseDraftCents(r.amount));
  const equal = equalPreview(balance, count);
  const parts: SplitPartInput[] = mode === "equal" ? names.slice(0, count).map((l) => ({ label: l }))
    : mode === "values" ? rows.map((r, i) => ({ label: r.label, amountCents: amounts[i] ?? 0 }))
    : assign.map((a) => ({ label: a.label, items: Object.entries(a.qty).filter(([, q]) => q > 0).map(([itemId, quantity]) => ({ itemId, quantity })) }));
  const problem = (() => {
    if (balance <= 0) return "Não há saldo pendente para dividir.";
    const lp = labelProblem(parts.map((p) => p.label ?? ""));
    if (lp) return lp;
    if (mode === "values" && amounts.some((a) => a === null)) return "Informe o valor de cada parte (ex.: 20,50).";
    if (mode === "products") return validateProducts(pool, assign, balance);
    return validateSplit(mode, parts, balance);
  })();
  const needsConfirm = impact.needsConfirm;
  const canSave = !problem && !locked && (!needsConfirm || confirm);
  const productsProblem = productsModeProblem(pool, balance);
  const showEditor = balance > 0 && (open || !act);

  function setCountSafe(n: number) {
    const c = clampCount(n);
    setCount(c); setNames((cur) => Array.from({ length: c }, (_, i) => cur[i] ?? ""));
  }
  function setPeopleProducts(n: number) {
    const c = clampCount(n);
    setAssign((cur) => Array.from({ length: c }, (_, i) => cur[i] ?? { label: "", qty: {} }));
  }
  async function save() {
    await ctrl.save({ mode, parts, confirmReplace: confirm });
    if (ctrl.getView().notice?.kind === "ok") { setOpen(false); setConfirm(false); }
  }

  const left = unassignedUnits(pool, assign);
  const rem = valuesRemaining(balance, amounts.map((a) => a ?? 0));

  return (
    <section className="pdv-split" aria-label="Divisão da conta" data-testid="split-editor">
      <div className="pdv-split-title">Divisão da conta{act ? ` — versão ${act.version} (${MODE_LABEL[act.mode].toLowerCase()})` : ""}</div>
      {view.loadError && !history && <div className="form-error" role="alert">{view.loadError} <button type="button" className="btn-secondary btn-small" onClick={() => void ctrl.loadHistory()}>Tentar de novo</button></div>}

      {act && (
        <div className="pdv-split-parts" data-testid="split-parts">
          {act.parts.map((p) => (
            <div key={p.partId} className="pdv-split-part">
              <b>{p.label}</b>
              <span className="muted">{formatCents(p.paidCents)} de {formatCents(p.plannedCents)}{p.pendingCents > 0 ? ` · falta ${formatCents(p.pendingCents)}` : ""}</span>
              <span className={`pdv-split-status pdv-split-status-${p.status}`}>{STATUS_TEXT[p.status]}</span>
            </div>
          ))}
        </div>
      )}
      {!act && balance > 0 && <p className="field-hint">A conta ainda não está dividida. Saldo a dividir: <strong>{formatCents(balance)}</strong>.</p>}

      {view.notice && <div className={view.notice.kind === "error" ? "form-error" : "form-notice"} role={view.notice.kind === "error" ? "alert" : "status"} data-testid="split-notice">{view.notice.text}</div>}
      {view.unknown && (
        <div className="form-error" role="alert" data-testid="split-unknown">
          <p>{view.unknown.text}</p>
          <div className="modal-actions">
            <button type="button" className="btn-primary btn-auto" disabled={view.busy} onClick={() => void ctrl.retryUnknown()} data-testid="split-retry">Reenviar a mesma divisão</button>
            <button type="button" className="btn-secondary" disabled={view.busy} onClick={() => void ctrl.confirmUnknown()} data-testid="split-check">Já conferi: atualizar situação</button>
          </div>
        </div>
      )}

      {!showEditor && balance > 0 && act && (
        <button type="button" className="btn-secondary btn-small" disabled={locked} onClick={() => setOpen(true)} data-testid="split-open">Refazer a divisão</button>
      )}
      {balance <= 0 && <small className="field-hint">Sem saldo pendente: não há o que dividir.</small>}

      {showEditor && (
        <form className="pdv-split-form" data-testid="split-form" onSubmit={(e) => { e.preventDefault(); if (canSave) void save(); }}>
          <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 10 }}>
            <div className="pdv-modes" role="radiogroup" aria-label="Como dividir">
              {(["equal", "values", "products"] as SplitMode[]).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? "pdv-mode pdv-mode-on" : "pdv-mode"} data-mode={m} onClick={() => { setMode(m); ctrl.clearNotice(); }}>{MODE_BUTTON[m]}</button>
              ))}
            </div>

            {mode === "equal" && (
              <div data-testid="split-equal" className="pdv-split-block">
                <div className="pdv-split-sec">Divisão igual por número de pessoas</div>
                <div className="pdv-split-row">Pessoas: <Stepper value={count} onChange={setCountSafe} label="Pessoas" /></div>
                <div className="pdv-split-rows" data-testid="split-equal-preview">
                  {Array.from({ length: count }, (_, i) => (
                    <div key={i} className="pdv-split-line">
                      <input aria-label={`Nome da pessoa ${i + 1}`} placeholder={`Pessoa ${i + 1}`} maxLength={40} value={names[i] ?? ""} onChange={(e) => setNames((cur) => cur.map((x, j) => (j === i ? e.target.value : x)))} />
                      <b>{equal ? formatCents(equal[i]) : "—"}</b>
                    </div>
                  ))}
                </div>
                <p className="field-hint">Saldo {formatCents(balance)} ÷ {count}. Os centavos que sobram vão para as primeiras pessoas; a soma sempre bate com o saldo.</p>
              </div>
            )}

            {mode === "values" && (
              <div data-testid="split-values" className="pdv-split-block">
                <div className="pdv-split-sec">Divisão por valores individuais</div>
                <div className="pdv-split-rows">
                  {rows.map((r, i) => (
                    <div className="pdv-split-line" key={i}>
                      <input aria-label={`Nome da parte ${i + 1}`} placeholder={`Pessoa ${i + 1}`} maxLength={40} value={r.label} onChange={(e) => setRows((cur) => cur.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                      <input className="pdv-num" aria-label={`Valor da parte ${i + 1}`} inputMode="decimal" placeholder="0,00" value={r.amount} onChange={(e) => setRows((cur) => cur.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
                      <button type="button" className="btn-secondary btn-small" aria-label={`Remover parte ${i + 1}`} disabled={rows.length <= MIN_SPLIT_PARTS} onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))}>×</button>
                    </div>
                  ))}
                </div>
                <div><button type="button" className="btn-secondary btn-small" disabled={rows.length >= MAX_SPLIT_PARTS} onClick={() => setRows((cur) => [...cur, { label: "", amount: "" }])}>+ Pessoa</button></div>
                <div className="pdv-split-sum" data-testid="split-values-remaining">
                  <div><span>Saldo a dividir</span><b>{formatCents(balance)}</b></div>
                  <div><span>Soma das partes</span><b>{formatCents(balance - rem)}</b></div>
                  <div><span>{rem > 0 ? "Falta distribuir" : rem < 0 ? "Excede" : "Conferido"}</span><b className={rem === 0 ? "pdv-ok" : "pdv-bad"}>{rem === 0 ? "✔ R$ 0,00" : formatCents(Math.abs(rem))}</b></div>
                </div>
              </div>
            )}

            {mode === "products" && (
              <div data-testid="split-products" className="pdv-split-block">
                <div className="pdv-split-sec">Divisão por produtos e quantidades consumidas</div>
                {productsProblem && <div className="form-error" data-testid="split-products-problem">{productsProblem}</div>}
                {!productsProblem && (
                  <>
                    <div className="pdv-split-row">Pessoas: <Stepper value={assign.length} onChange={setPeopleProducts} label="Pessoas" /></div>
                    <div className="pdv-matrix-wrap">
                      <table className="pdv-matrix" data-testid="split-matrix">
                        <thead>
                          <tr>
                            <th>Produto</th><th className="n">Qtd</th>
                            {assign.map((a, i) => (
                              <th key={i} className="n"><input aria-label={`Nome da parte ${i + 1}`} placeholder={`P${i + 1}`} maxLength={40} value={a.label} onChange={(e) => setAssign((cur) => cur.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} /></th>
                            ))}
                            <th className="n">Sobra</th>
                          </tr>
                        </thead>
                        <tbody>
                          {poolOpen.map((it) => {
                            const sobra = left[it.itemId] ?? 0;
                            return (
                              <tr key={it.itemId} data-item={it.itemId}>
                                <td>{it.name}<small className="muted"> {formatCents(it.unitCents)} cada{it.locked > 0 ? ` · ${it.locked} já quitado(s)` : ""}</small></td>
                                <td className="n">{it.available}</td>
                                {assign.map((a, i) => {
                                  const q = a.qty[it.itemId] ?? 0;
                                  const setQ = (v: number) => setAssign((cur) => cur.map((x, j) => (j === i ? { ...x, qty: { ...x.qty, [it.itemId]: Math.max(0, v) } } : x)));
                                  return (
                                    <td key={i} className="n">
                                      <span className="pdv-stepper">
                                        <button type="button" aria-label={`Menos ${it.name} para ${a.label || `pessoa ${i + 1}`}`} disabled={q <= 0} onClick={() => setQ(q - 1)}>−</button>
                                        <b>{q}</b>
                                        <button type="button" aria-label={`Mais ${it.name} para ${a.label || `pessoa ${i + 1}`}`} disabled={sobra <= 0} onClick={() => setQ(q + 1)}>+</button>
                                      </span>
                                    </td>
                                  );
                                })}
                                <td className={`n pdv-sobra${sobra === 0 ? " pdv-ok" : " pdv-bad"}`} data-testid={`sobra-${it.itemId}`}>{sobra}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                        <tfoot>
                          <tr><td colSpan={2}><b>Parte de cada pessoa</b></td>{assign.map((a, i) => <td key={i} className="n"><b>{formatCents(partCents(pool, a.qty))}</b></td>)}<td /></tr>
                        </tfoot>
                      </table>
                    </div>
                    <p className="field-hint" data-testid="split-unassigned">Cada unidade consumida é atribuída a uma pessoa. “Sobra” é o que ainda não foi atribuído e precisa chegar a 0. Itens cancelados e já quitados não entram.</p>
                  </>
                )}
              </div>
            )}

            <div className="pdv-split-impact" data-testid="split-impact">
              <p className="field-hint">Saldo pendente a dividir: <strong>{formatCents(balance)}</strong>. Pagamentos e alocações já feitos nunca são alterados.</p>
              {impact.lines.length > 0 && <ul>{impact.lines.map((l, i) => <li key={i} className="field-hint">{l}</li>)}</ul>}
              {needsConfirm && (
                <label className="field-checkbox"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} data-testid="split-confirm" /> Entendi: o que já foi pago fica preservado e a nova divisão cobre só o saldo pendente.</label>
              )}
            </div>
            {problem && mode !== "products" && <div className="field-error" data-testid="split-problem">{problem}</div>}
            {problem && mode === "products" && !productsProblem && <div className="field-error" data-testid="split-problem">{problem}</div>}
            <div className="pdv-split-actions">
              {act && <button type="button" className="btn-secondary" onClick={() => { setOpen(false); ctrl.clearNotice(); }}>Cancelar</button>}
              <button type="submit" className="btn-primary btn-auto" disabled={!canSave} data-testid="split-save">{view.busy ? "Salvando…" : act ? "Salvar nova versão" : `Aplicar divisão ${mode === "equal" ? "igual" : mode === "values" ? "por valores" : "por produtos"}`}</button>
            </div>
          </fieldset>
        </form>
      )}

      {history && history.splits.length > 0 && (
        <details className="fin-history" data-testid="split-history">
          <summary>Histórico da divisão ({history.splits.length} {history.splits.length === 1 ? "versão" : "versões"})</summary>
          <ol reversed className="fin-parts">
            {[...history.splits].reverse().map((s) => (
              <li key={s.splitId} data-testid={`split-version-${s.version}`}>
                <strong>Versão {s.version}{s.status === "active" ? " (ativa)" : " (substituída)"}</strong> · {MODE_LABEL[s.mode].toLowerCase()} · {fmtDate(s.createdAt)} · previsto {formatCents(s.plannedTotalCents)} · pago {formatCents(s.paidTotalCents)}
                <ul>{s.parts.map((p) => <li key={p.partId} className="field-hint">{p.label}: {formatCents(p.paidCents)} de {formatCents(p.plannedCents)} ({STATUS_TEXT[p.status]})</li>)}</ul>
              </li>
            ))}
          </ol>
          {history.splits.length > 1 && (
            <p className="field-hint" data-testid="split-people">Por pessoa: {personTotals(history).map((p) => `${p.label} pagou ${formatCents(p.paidCents)}${p.pendingCents > 0 ? `, falta ${formatCents(p.pendingCents)}` : ""}`).join(" · ")}</p>
          )}
        </details>
      )}
    </section>
  );
}

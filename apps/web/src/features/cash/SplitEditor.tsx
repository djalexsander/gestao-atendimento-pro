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

// E9.5 — Editor de divisão da conta (dentro do diálogo financeiro). Por pessoas iguais, por valores ou por produtos; sempre sobre o SALDO
// PENDENTE; mostra o saldo de cada parte e o histórico de versões. O servidor decide; aqui só se monta o pedido e se explica o impacto.

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
const STATUS_TEXT = { paid: "quitada", partial: "em andamento", pending: "pendente" } as const;
const fmtDate = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }); };

export function SplitEditor({
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
  disabled: boolean;                                   // pagamento em andamento/pendente no diálogo
  onApplied: (state: FinancialState | null) => void | Promise<void>;
  onPendingChange: (pending: boolean) => void;         // este editor está ocupado ou com resultado desconhecido
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
  // O histórico muda por fora (pagamento, outro operador): recarrega quando a versão da divisão ou o saldo mudam.
  useEffect(() => { void ctrl.loadHistory(); }, [ctrl, state.split?.version, state.balanceDueCents, state.paymentsCount]);

  const balance = state.balanceDueCents;
  const history = view.history;
  const act = activeSplit(history);
  const impact = replaceImpact(history, balance);
  const pool = useMemo(() => buildPool(orderItems, history), [orderItems, history]);
  const locked = disabled || pending;

  // ---- rascunho e validação por modo
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

  function setCountSafe(n: number) {
    const c = Math.min(Math.max(Number.isFinite(n) ? Math.trunc(n) : MIN_SPLIT_PARTS, MIN_SPLIT_PARTS), MAX_SPLIT_PARTS);
    setCount(c); setNames((cur) => Array.from({ length: c }, (_, i) => cur[i] ?? ""));
  }
  async function save() {
    await ctrl.save({ mode, parts, confirmReplace: confirm });
    if (ctrl.getView().notice?.kind === "ok") { setOpen(false); setConfirm(false); }
  }
  const productsProblem = productsModeProblem(pool, balance);

  return (
    <section className="fin-section" aria-label="Divisão da conta" data-testid="split-editor">
      <h4 className="checkout-payment-title">Divisão da conta{act ? ` — versão ${act.version} (${MODE_LABEL[act.mode].toLowerCase()})` : ""}</h4>
      {view.loadError && !history && <div className="form-error" role="alert">{view.loadError} <button type="button" className="btn-secondary btn-small" onClick={() => void ctrl.loadHistory()}>Tentar de novo</button></div>}

      {act && (
        <ul className="fin-parts" data-testid="split-parts">
          {act.parts.map((p) => (
            <li key={p.partId} className="fin-part"><span>{p.label}</span><span>{formatCents(p.paidCents)} de {formatCents(p.plannedCents)} · pendente {formatCents(p.pendingCents)} · {STATUS_TEXT[p.status]}</span></li>
          ))}
        </ul>
      )}
      {!act && <p className="field-hint">A conta ainda não está dividida. Saldo a dividir: <strong>{formatCents(balance)}</strong>.</p>}

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

      {!open && balance > 0 && (
        <button type="button" className="btn-secondary btn-small" disabled={locked} onClick={() => setOpen(true)} data-testid="split-open">{act ? "Refazer a divisão" : "Dividir a conta"}</button>
      )}
      {!open && balance <= 0 && <small className="field-hint">Sem saldo pendente: não há o que dividir.</small>}

      {open && (
        <form className="fin-editor" data-testid="split-form" onSubmit={(e) => { e.preventDefault(); if (canSave) void save(); }}>
          <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0 }}>
            <div className="field" role="radiogroup" aria-label="Como dividir">
              {(["equal", "values", "products"] as SplitMode[]).map((m) => (
                <label key={m} className="field-checkbox"><input type="radio" name="split-mode" checked={mode === m} onChange={() => { setMode(m); ctrl.clearNotice(); }} /> {MODE_LABEL[m]}</label>
              ))}
            </div>

            {mode === "equal" && (
              <div data-testid="split-equal">
                <div className="field">
                  <label htmlFor="split-count">Número de pessoas</label>
                  <input id="split-count" type="number" min={MIN_SPLIT_PARTS} max={MAX_SPLIT_PARTS} value={count} onChange={(e) => setCountSafe(Number(e.target.value))} />
                </div>
                <ul className="fin-parts" data-testid="split-equal-preview">
                  {Array.from({ length: count }, (_, i) => (
                    <li key={i} className="fin-part">
                      <input aria-label={`Nome da pessoa ${i + 1}`} placeholder={`Pessoa ${i + 1}`} maxLength={40} value={names[i] ?? ""} onChange={(e) => setNames((cur) => cur.map((x, j) => (j === i ? e.target.value : x)))} />
                      <span>{equal ? formatCents(equal[i]) : "—"}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {mode === "values" && (
              <div data-testid="split-values">
                {rows.map((r, i) => (
                  <div className="fin-part" key={i}>
                    <input aria-label={`Nome da parte ${i + 1}`} placeholder={`Pessoa ${i + 1}`} maxLength={40} value={r.label} onChange={(e) => setRows((cur) => cur.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                    <input aria-label={`Valor da parte ${i + 1}`} inputMode="decimal" placeholder="R$ 0,00" value={r.amount} onChange={(e) => setRows((cur) => cur.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
                    {rows.length > MIN_SPLIT_PARTS && <button type="button" className="btn-secondary btn-small" onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))}>Remover</button>}
                  </div>
                ))}
                {rows.length < MAX_SPLIT_PARTS && <button type="button" className="btn-secondary btn-small" onClick={() => setRows((cur) => [...cur, { label: "", amount: "" }])}>Adicionar parte</button>}
                <p className="checkout-change" data-testid="split-values-remaining">
                  {(() => { const rem = valuesRemaining(balance, amounts.map((a) => a ?? 0)); return rem === 0 ? "As partes somam exatamente o saldo." : rem > 0 ? `Falta distribuir ${formatCents(rem)}.` : `Passou ${formatCents(-rem)} do saldo.`; })()}
                </p>
              </div>
            )}

            {mode === "products" && (
              <div data-testid="split-products">
                {productsProblem && <div className="form-error" data-testid="split-products-problem">{productsProblem}</div>}
                {!productsProblem && assign.map((a, i) => (
                  <div className="fin-section" key={i}>
                    <div className="fin-part">
                      <input aria-label={`Nome da parte ${i + 1}`} placeholder={`Pessoa ${i + 1}`} maxLength={40} value={a.label} onChange={(e) => setAssign((cur) => cur.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                      <strong>{formatCents(partCents(pool, a.qty))}</strong>
                      {assign.length > MIN_SPLIT_PARTS && <button type="button" className="btn-secondary btn-small" onClick={() => setAssign((cur) => cur.filter((_, j) => j !== i))}>Remover</button>}
                    </div>
                    {pool.filter((it) => it.available > 0).map((it) => (
                      <div className="fin-part" key={it.itemId}>
                        <label htmlFor={`sp-${i}-${it.itemId}`}>{it.name} ({formatCents(it.unitCents)})</label>
                        <input id={`sp-${i}-${it.itemId}`} type="number" min={0} max={it.available} value={a.qty[it.itemId] ?? 0}
                          onChange={(e) => setAssign((cur) => cur.map((x, j) => (j === i ? { ...x, qty: { ...x.qty, [it.itemId]: Math.max(0, Math.trunc(Number(e.target.value) || 0)) } } : x)))} />
                      </div>
                    ))}
                  </div>
                ))}
                {!productsProblem && assign.length < MAX_SPLIT_PARTS && <button type="button" className="btn-secondary btn-small" onClick={() => setAssign((cur) => [...cur, { label: "", qty: {} }])}>Adicionar parte</button>}
                {!productsProblem && (
                  <p className="field-hint" data-testid="split-unassigned">
                    {pool.filter((it) => it.available > 0).map((it) => { const left = unassignedUnits(pool, assign)[it.itemId]; return `${it.name}: ${left === 0 ? "todas atribuídas" : left > 0 ? `faltam ${left}` : `${-left} a mais`}`; }).join(" · ")}
                  </p>
                )}
              </div>
            )}

            <div className="fin-impact" data-testid="split-impact">
              <p className="field-hint">Saldo pendente a dividir: <strong>{formatCents(balance)}</strong>. Pagamentos e alocações já feitos nunca são alterados.</p>
              <ul>{impact.lines.map((l, i) => <li key={i} className="field-hint">{l}</li>)}</ul>
              {needsConfirm && (
                <label className="field-checkbox"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} data-testid="split-confirm" /> Entendi: o que já foi pago fica preservado e a nova divisão cobre só o saldo pendente.</label>
              )}
            </div>
            {problem && <div className="field-error" data-testid="split-problem">{problem}</div>}
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => { setOpen(false); ctrl.clearNotice(); }}>Cancelar</button>
              <button type="submit" className="btn-primary btn-auto" disabled={!canSave} data-testid="split-save">{view.busy ? "Salvando…" : act ? "Salvar nova versão" : "Salvar divisão"}</button>
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

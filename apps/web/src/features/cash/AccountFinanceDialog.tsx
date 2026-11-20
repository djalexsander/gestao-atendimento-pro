import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { formatCents } from "../../lib/money";
import { Modal } from "../employees/Modal";
import { OpenCashDialog } from "./CashDialogs";
import type { CashSource } from "./cashApi";
import { PAYMENT_METHODS, PAYMENT_METHOD_LABEL, parseDraftCents, type PaymentMethod } from "./cashLogic";
import { createAccountFinanceController, type FinanceView, type PaymentForm } from "./accountFinanceController";
import { SplitEditor } from "./SplitEditor";
import { PdvSplitEditor } from "./PdvSplitEditor";
import { PaymentMethodButtons } from "./PaymentMethodButtons";
import type { OrderItemSource } from "./splitEditorLogic";
import { partialPaymentsApi, type PartialPaymentsApi } from "./partialPaymentsApi";
import { canRefundOpenPayment, paymentStatusLabel, validateClose, changeCents, type CompanyRole, type FinancialState } from "./partialPaymentsLogic";

// E9.4 — Diálogo financeiro da conta (Caixa): saldo, pagamentos parciais por várias formas, estorno de conta aberta (owner/admin) e
// encerramento da conta quitada. Faz parte do plano base (quem monta este diálogo confere o estado da empresa: não somente leitura). O saldo, as
// partes e a quitação vêm SEMPRE do servidor; aqui só se desenha o estado do controlador (accountFinanceController.ts).

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

const emptyForm = (method: PaymentMethod = "pix"): PaymentForm => ({ method, amountText: "", receivedText: "", partId: null, allocations: null, confirmAllocation: false });

export function AccountFinanceDialog({
  sessionId,
  pointLabel,
  role,
  companyId,
  cashSource,
  api = partialPaymentsApi,
  orderItems = [],
  onClose,
  onClosed,
  inline = false,
  onChanged,
  splitHost = null,
}: {
  sessionId: string;
  pointLabel: string;
  role: CompanyRole | null | undefined;
  companyId: string;
  cashSource: CashSource;
  api?: PartialPaymentsApi;
  orderItems?: OrderItemSource[];   // itens cobráveis da conta (para dividir por produto)
  onClose: () => void;     // fechar o diálogo (a tela recarrega o estado)
  onClosed: () => void;    // conta encerrada
  inline?: boolean;        // PDV de três colunas: sem moldura de diálogo, com atalhos
  onChanged?: () => void;  // pagamento/estorno/divisão aplicados: o PDV recarrega as outras colunas
  splitHost?: HTMLElement | null;   // PDV: o editor de divisão (E9.5, o MESMO componente) é desenhado na aba "Dividir conta" do painel central
}) {
  const canRefund = canRefundOpenPayment(role);
  const ctrl = useMemo(() => createAccountFinanceController({ api, sessionId, canRefund, newId }), [api, sessionId, canRefund]);
  const [view, setView] = useState<FinanceView>(ctrl.getView());
  const [form, setForm] = useState<PaymentForm>(emptyForm());
  const [refund, setRefund] = useState({ paymentId: "", amountText: "", reason: "" });
  // PDV: nenhuma forma vem marcada; F1–F5 / clique escolhem e sugerem o saldo pendente. Sem forma escolhida não há recebimento.
  const [chosen, setChosen] = useState(!inline);
  const [splitPending, setSplitPending] = useState(false);   // E9.5: o editor de divisão está ocupado ou com resultado desconhecido
  const onSplitApplied = useCallback((s: FinancialState | null) => ctrl.refresh(s), [ctrl]);

  useEffect(() => {
    const off = ctrl.subscribe(setView);
    void ctrl.load();
    return off;
  }, [ctrl]);

  const st = view.state;
  const open = st?.sessionStatus === "open";
  const locked = view.busy || view.unknown !== null || splitPending;
  const split = st?.split ?? null;
  const partsOpen = st?.parts.filter((p) => p.pendingCents > 0) ?? [];

  // Sugestão de valor: pendente da parte escolhida ou saldo da conta; refeita quando o estado ou a parte mudam.
  useEffect(() => {
    if (!st) return;
    setForm((f) => {
      const partId = split ? (f.partId && partsOpen.some((p) => p.partId === f.partId) ? f.partId : partsOpen[0]?.partId ?? null) : null;
      return { ...f, partId, amountText: ctrl.suggestedAmountText(partId), receivedText: "", allocations: null, confirmAllocation: false };
    });
    if (inline) setChosen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st?.balanceDueCents, st?.split?.version, st?.paymentsCount, ctrl]);

  useEffect(() => { if (view.closed) onClosed(); }, [view.closed, onClosed]);

  // PDV: avisa as outras colunas quando o estado financeiro muda por uma operação (não na primeira leitura).
  const changeKey = st ? `${st.paymentsCount}:${st.refundsCount}:${st.split?.version ?? 0}:${st.balanceDueCents}` : null;
  const lastChange = useRef<string | null>(null);
  useEffect(() => {
    if (changeKey === null) return;
    if (lastChange.current !== null && lastChange.current !== changeKey) onChanged?.();
    lastChange.current = changeKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changeKey]);

  const applied = parseDraftCents(form.amountText);
  const received = form.method === "cash" ? (form.receivedText.trim() === "" ? applied : parseDraftCents(form.receivedText)) : null;
  const change = form.method === "cash" && applied !== null && received !== null ? changeCents({ method: "cash", amountCents: applied, receivedCents: received }) : 0;
  const closeProblem = validateClose(st);
  const payAvailable = open && (st?.balanceDueCents ?? 0) > 0;
  const refundables = view.payments.filter((p) => p.availableCents > 0);

  function chooseMethod(method: PaymentMethod) {
    setChosen(true);
    // sugere o saldo pendente (da parte escolhida) quando não há valor válido digitado; um valor já editado é preservado
    setForm((f) => {
      const cents = parseDraftCents(f.amountText);
      return { ...f, method, receivedText: "", amountText: cents === null || cents <= 0 ? ctrl.suggestedAmountText(f.allocations ? null : f.partId) : f.amountText };
    });
  }
  function pickPart(partId: string) {
    setForm((f) => ({ ...f, partId, amountText: ctrl.suggestedAmountText(partId), allocations: null, confirmAllocation: false }));
  }
  function toggleAllocations(on: boolean) {
    setForm((f) => ({ ...f, allocations: on ? partsOpen.map((p) => ({ partId: p.partId, text: "" })) : null, confirmAllocation: false }));
  }
  const paymentReady = chosen && applied !== null && applied > 0 && (form.method !== "cash" || form.receivedText.trim() === "" || (received !== null && received >= applied));
  function submitPayment(e: FormEvent) { e.preventDefault(); if (inline && !paymentReady) return; void ctrl.registerPayment(form); }

  // Atalhos do PDV (F1–F5 escolhem a forma; Ctrl+Enter registra o pagamento sugerido ou encerra a conta quitada).
  const chooseMethodRef = useRef(chooseMethod);
  chooseMethodRef.current = chooseMethod;
  const shortcutRef = useRef({ form, locked, payAvailable, closeProblem, paymentReady });
  shortcutRef.current = { form, locked, payAvailable, closeProblem, paymentReady };
  useEffect(() => {
    if (!inline) return;
    function onShortcut(e: Event) {
      const d = (e as CustomEvent<{ kind: string; method?: PaymentMethod }>).detail;
      const cur = shortcutRef.current;
      if (d.kind === "method" && d.method) { if (!cur.locked && cur.payAvailable) chooseMethodRef.current(d.method); return; }
      if (d.kind === "finalize" && !cur.locked) {
        // Enter só finaliza com pagamento VÁLIDO (forma escolhida, valor > 0, entregue ≥ aplicado) ou com a conta quitada (encerra).
        if (cur.payAvailable) { if (cur.paymentReady) void ctrl.registerPayment(cur.form); }
        else if (cur.closeProblem === null) void ctrl.close();
      }
    }
    window.addEventListener("pdv-shortcut", onShortcut);
    return () => window.removeEventListener("pdv-shortcut", onShortcut);
  }, [inline, ctrl]);
  function submitRefund(e: FormEvent) { e.preventDefault(); void ctrl.refund({ paymentId: refund.paymentId || refundables[0]?.paymentId || "", amountText: refund.amountText, reason: refund.reason }); }

  const body = (
    <>
      {view.loading && !st && <p className="modal-text" role="status">Carregando a situação da conta…</p>}
      {view.loadError && !st && (
        <div className="form-error" role="alert">
          {view.loadError}{" "}
          <button type="button" className="btn-secondary btn-small" onClick={() => void ctrl.load()}>Tentar de novo</button>
        </div>
      )}

      {st && (
        <>
          <dl className="checkout-summary" data-testid="fin-summary">
            <div><dt>Total da conta</dt><dd data-testid="fin-total">{formatCents(st.totalCents)}</dd></div>
            <div><dt>Recebido</dt><dd data-testid="fin-received">{formatCents(st.settledPaidCents)}</dd></div>
            <div><dt>Saldo restante</dt><dd data-testid="fin-balance" className={st.overpaidCents > 0 ? "checkout-over" : undefined}>{formatCents(st.balanceDueCents)}</dd></div>
            <div><dt>Situação</dt><dd data-testid="fin-status">{paymentStatusLabel(st.paymentStatus)}</dd></div>
          </dl>
          {st.overpaidCents > 0 && <div className="form-error">A conta recebeu {formatCents(st.overpaidCents)} a mais que o total. Estorne o excedente antes de encerrar.</div>}

          {open && (() => {
            // PDV (aba "Dividir conta"): a MESMA lógica/controlador num desenho próprio; fora do PDV o editor do diálogo segue igual.
            if (inline && splitHost) return createPortal(<PdvSplitEditor api={api} sessionId={sessionId} state={st} orderItems={orderItems} disabled={view.busy || view.unknown !== null} onApplied={onSplitApplied} onPendingChange={setSplitPending} />, splitHost);
            return <SplitEditor api={api} sessionId={sessionId} state={st} orderItems={orderItems} disabled={view.busy || view.unknown !== null} onApplied={onSplitApplied} onPendingChange={setSplitPending} />;
          })()}
          {split && ((st.overDistributedCents ?? 0) > 0 || (st.undistributedCents ?? 0) > 0) && <div className="form-error">A divisão está desatualizada em relação ao consumo. Refaça a divisão antes de receber ou encerrar.</div>}

          {view.notice && <div className={view.notice.kind === "error" ? "form-error" : "form-notice"} role={view.notice.kind === "error" ? "alert" : "status"} data-testid="fin-notice">{view.notice.text}</div>}

          {view.unknown && (
            <div className="form-error" role="alert" data-testid="fin-unknown">
              <p>{view.unknown.text}</p>
              <div className="modal-actions">
                <button type="button" className="btn-primary btn-auto" disabled={view.busy} onClick={() => void ctrl.retryUnknown()} data-testid="fin-retry">Reenviar o mesmo pedido</button>
                <button type="button" className="btn-secondary" disabled={view.busy} onClick={() => void ctrl.confirmUnknown()} data-testid="fin-check">Já conferi: atualizar situação</button>
              </div>
            </div>
          )}

          {view.lastPayment && !view.unknown && (
            <p className="field-hint" data-testid="fin-last">
              Último pagamento ({view.lastPayment.methodLabel}): aplicado {formatCents(view.lastPayment.appliedCents)}
              {view.lastPayment.receivedCents !== null && <> · entregue {formatCents(view.lastPayment.receivedCents)} · troco {formatCents(view.lastPayment.changeCents)}</>}
            </p>
          )}

          {payAvailable && (
            <form onSubmit={submitPayment} className="fin-section" aria-label="Receber pagamento" data-testid="fin-pay-form">
              <h4 className="checkout-payment-title">Receber pagamento</h4>
              {split && (
                <div className="field">
                  <label htmlFor="fin-part">Parte que recebe</label>
                  <select id="fin-part" value={form.allocations ? "" : form.partId ?? ""} disabled={locked || !!form.allocations} onChange={(e) => pickPart(e.target.value)}>
                    {partsOpen.map((p) => <option key={p.partId} value={p.partId}>{p.label} — pendente {formatCents(p.pendingCents)}</option>)}
                  </select>
                </div>
              )}
              {inline ? (
                <>
                  <div className="pay-methods-title">Forma de pagamento (escolha uma)</div>
                  <PaymentMethodButtons value={chosen ? form.method : null} onSelect={chooseMethod} disabled={locked} />
                  {!chosen && <p className="field-hint pay-methods-hint" data-testid="fin-no-method">Nenhuma forma selecionada. Ao escolher F1–F5, o valor pendente é <strong>sugerido</strong> e pode ser editado. Só vale depois de registrado.</p>}
                </>
              ) : (
                <div className="field">
                  <label htmlFor="fin-method">Forma</label>
                  <select id="fin-method" value={form.method} disabled={locked} onChange={(e) => setForm((f) => ({ ...f, method: e.target.value as PaymentMethod, receivedText: "" }))}>
                    {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABEL[m]}</option>)}
                  </select>
                </div>
              )}
              {chosen && (<>
              <div className="field">
                <label htmlFor="fin-amount">Valor aplicado à conta</label>
                <input id="fin-amount" inputMode="decimal" placeholder="R$ 0,00" value={form.amountText} disabled={locked} onChange={(e) => setForm((f) => ({ ...f, amountText: e.target.value }))} />
                <small className="field-hint">Este valor é abatido do saldo da conta.</small>
              </div>
              {form.method === "cash" && (
                <>
                  <div className="field">
                    <label htmlFor="fin-received">Valor entregue pelo cliente</label>
                    <input id="fin-received" inputMode="decimal" placeholder={applied !== null ? formatCents(applied) : "R$ 0,00"} value={form.receivedText} disabled={locked} onChange={(e) => setForm((f) => ({ ...f, receivedText: e.target.value }))} />
                    <small className="field-hint">Em branco = igual ao valor aplicado (sem troco).</small>
                  </div>
                  <p className="checkout-change" data-testid="fin-change">
                    Aplicado: <strong>{applied !== null ? formatCents(applied) : "—"}</strong> · Entregue: <strong>{received !== null ? formatCents(received) : "—"}</strong> · Troco: <strong>{formatCents(change)}</strong>
                  </p>
                </>
              )}
              </>)}
              {chosen && split && partsOpen.length > 1 && (
                <>
                  <label className="field-checkbox"><input type="checkbox" checked={!!form.allocations} disabled={locked} onChange={(e) => toggleAllocations(e.target.checked)} /> Distribuir o valor entre várias partes</label>
                  {form.allocations && (
                    <div className="fin-alloc" data-testid="fin-alloc">
                      {partsOpen.map((p, i) => (
                        <div className="field" key={p.partId}>
                          <label htmlFor={`fin-alloc-${p.partId}`}>{p.label} (pendente {formatCents(p.pendingCents)})</label>
                          <input id={`fin-alloc-${p.partId}`} inputMode="decimal" placeholder="R$ 0,00" value={form.allocations?.[i]?.text ?? ""} disabled={locked}
                            onChange={(e) => setForm((f) => ({ ...f, allocations: (f.allocations ?? []).map((a, j) => (j === i ? { ...a, text: e.target.value } : a)) }))} />
                        </div>
                      ))}
                      <label className="field-checkbox"><input type="checkbox" checked={form.confirmAllocation} disabled={locked} onChange={(e) => setForm((f) => ({ ...f, confirmAllocation: e.target.checked }))} /> Confirmo a distribuição acima</label>
                    </div>
                  )}
                </>
              )}
              <div className="modal-actions">
                <button type="submit" className="btn-primary btn-auto" disabled={locked || (inline && !paymentReady)} data-testid="fin-pay-submit"><span>{view.busy ? "Registrando…" : "Registrar pagamento"}</span>{inline && <kbd className="pay-submit-key">Enter</kbd>}</button>
              </div>
            </form>
          )}

          {canRefund && open && refundables.length > 0 && (
            <form onSubmit={submitRefund} className="fin-section" aria-label="Estornar pagamento" data-testid="fin-refund-form">
              <h4 className="checkout-payment-title">Estornar pagamento (correção)</h4>
              <div className="field">
                <label htmlFor="fin-refund-pay">Pagamento</label>
                <select id="fin-refund-pay" value={refund.paymentId || refundables[0].paymentId} disabled={locked}
                  onChange={(e) => { const p = refundables.find((x) => x.paymentId === e.target.value); setRefund((r) => ({ ...r, paymentId: e.target.value, amountText: p ? (p.availableCents / 100).toFixed(2).replace(".", ",") : "" })); }}>
                  {refundables.map((p) => <option key={p.paymentId} value={p.paymentId}>{PAYMENT_METHOD_LABEL[p.method]} — {formatCents(p.amountCents)} (estornável {formatCents(p.availableCents)})</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="fin-refund-amount">Valor a estornar</label>
                <input id="fin-refund-amount" inputMode="decimal" placeholder="R$ 0,00" value={refund.amountText} disabled={locked} onChange={(e) => setRefund((r) => ({ ...r, amountText: e.target.value }))} />
              </div>
              <div className="field">
                <label htmlFor="fin-refund-reason">Motivo (obrigatório)</label>
                <input id="fin-refund-reason" maxLength={200} value={refund.reason} disabled={locked} onChange={(e) => setRefund((r) => ({ ...r, reason: e.target.value }))} />
                <small className="field-hint">O valor estornado volta para o saldo da conta; é preciso ter o seu caixa aberto.</small>
              </div>
              <div className="modal-actions">
                <button type="submit" className="btn-secondary" disabled={locked} data-testid="fin-refund-submit">Estornar</button>
              </div>
            </form>
          )}

          {open && (
            <div className="fin-section">
              <button type="button" className="btn-primary btn-auto" disabled={locked || closeProblem !== null} title={closeProblem ?? undefined} onClick={() => void ctrl.close()} data-testid="fin-close">Encerrar conta</button>
              {closeProblem && <small className="field-hint" data-testid="fin-close-hint"> {closeProblem}</small>}
            </div>
          )}
        </>
      )}

      {!inline && (
        <div className="modal-actions">
          <button type="button" className="btn-secondary" disabled={view.busy} onClick={onClose}>Fechar</button>
        </div>
      )}

      {view.needsCash && (
        <OpenCashDialog source={cashSource} companyId={companyId} notice="Abra o caixa antes de registrar o pagamento." onOpened={() => ctrl.cashOpened()} onClose={() => ctrl.dismissNeedsCash()} />
      )}
    </>
  );
  if (inline) return <div className="pdv-inline" data-testid="pdv-finance">{body}</div>;
  return (
    <Modal title={`Pagamentos da conta — ${pointLabel}`} onClose={view.busy ? () => undefined : onClose}>
      {body}
    </Modal>
  );
}

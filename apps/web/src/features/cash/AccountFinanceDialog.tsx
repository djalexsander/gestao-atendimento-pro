import { useEffect, useMemo, useState, type FormEvent } from "react";
import { formatCents } from "../../lib/money";
import { Modal } from "../employees/Modal";
import { OpenCashDialog } from "./CashDialogs";
import type { CashSource } from "./cashApi";
import { PAYMENT_METHODS, PAYMENT_METHOD_LABEL, parseDraftCents, type PaymentMethod } from "./cashLogic";
import { createAccountFinanceController, type FinanceView, type PaymentForm } from "./accountFinanceController";
import { partialPaymentsApi, type PartialPaymentsApi } from "./partialPaymentsApi";
import { canRefundOpenPayment, paymentStatusLabel, validateClose, changeCents, type CompanyRole } from "./partialPaymentsLogic";

// E9.4 — Diálogo financeiro da conta (Caixa): saldo, pagamentos parciais por várias formas, estorno de conta aberta (owner/admin) e
// encerramento da conta quitada. Só existe com o módulo partial_payments habilitado (quem monta este diálogo confere). O saldo, as
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
  onClose,
  onClosed,
}: {
  sessionId: string;
  pointLabel: string;
  role: CompanyRole | null | undefined;
  companyId: string;
  cashSource: CashSource;
  api?: PartialPaymentsApi;
  onClose: () => void;     // fechar o diálogo (a tela recarrega o estado)
  onClosed: () => void;    // conta encerrada
}) {
  const canRefund = canRefundOpenPayment(role);
  const ctrl = useMemo(() => createAccountFinanceController({ api, sessionId, canRefund, newId }), [api, sessionId, canRefund]);
  const [view, setView] = useState<FinanceView>(ctrl.getView());
  const [form, setForm] = useState<PaymentForm>(emptyForm());
  const [refund, setRefund] = useState({ paymentId: "", amountText: "", reason: "" });

  useEffect(() => {
    const off = ctrl.subscribe(setView);
    void ctrl.load();
    return off;
  }, [ctrl]);

  const st = view.state;
  const open = st?.sessionStatus === "open";
  const locked = view.busy || view.unknown !== null;
  const split = st?.split ?? null;
  const partsOpen = st?.parts.filter((p) => p.pendingCents > 0) ?? [];

  // Sugestão de valor: pendente da parte escolhida ou saldo da conta; refeita quando o estado ou a parte mudam.
  useEffect(() => {
    if (!st) return;
    setForm((f) => {
      const partId = split ? (f.partId && partsOpen.some((p) => p.partId === f.partId) ? f.partId : partsOpen[0]?.partId ?? null) : null;
      return { ...f, partId, amountText: ctrl.suggestedAmountText(partId), receivedText: "", allocations: null, confirmAllocation: false };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st?.balanceDueCents, st?.split?.version, st?.paymentsCount, ctrl]);

  useEffect(() => { if (view.closed) onClosed(); }, [view.closed, onClosed]);

  const applied = parseDraftCents(form.amountText);
  const received = form.method === "cash" ? (form.receivedText.trim() === "" ? applied : parseDraftCents(form.receivedText)) : null;
  const change = form.method === "cash" && applied !== null && received !== null ? changeCents({ method: "cash", amountCents: applied, receivedCents: received }) : 0;
  const closeProblem = validateClose(st);
  const payAvailable = open && (st?.balanceDueCents ?? 0) > 0;
  const refundables = view.payments.filter((p) => p.availableCents > 0);

  function pickPart(partId: string) {
    setForm((f) => ({ ...f, partId, amountText: ctrl.suggestedAmountText(partId), allocations: null, confirmAllocation: false }));
  }
  function toggleAllocations(on: boolean) {
    setForm((f) => ({ ...f, allocations: on ? partsOpen.map((p) => ({ partId: p.partId, text: "" })) : null, confirmAllocation: false }));
  }
  function submitPayment(e: FormEvent) { e.preventDefault(); void ctrl.registerPayment(form); }
  function submitRefund(e: FormEvent) { e.preventDefault(); void ctrl.refund({ paymentId: refund.paymentId || refundables[0]?.paymentId || "", amountText: refund.amountText, reason: refund.reason }); }

  return (
    <Modal title={`Pagamentos da conta — ${pointLabel}`} onClose={view.busy ? () => undefined : onClose}>
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

          {split && (
            <section className="fin-section" aria-label="Divisão da conta">
              <h4 className="checkout-payment-title">Divisão da conta (versão {split.version})</h4>
              <ul className="fin-parts" data-testid="fin-parts">
                {st.parts.map((p) => (
                  <li key={p.partId} className="fin-part">
                    <span>{p.label}</span>
                    <span>{formatCents(p.paidCents)} de {formatCents(p.plannedCents)} · {p.status === "paid" ? "quitada" : p.status === "partial" ? "em andamento" : "pendente"}</span>
                  </li>
                ))}
              </ul>
              {((st.overDistributedCents ?? 0) > 0 || (st.undistributedCents ?? 0) > 0) && <div className="form-error">A divisão está desatualizada em relação ao consumo. Peça para refazer a divisão antes de receber ou encerrar.</div>}
            </section>
          )}

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
              <div className="field">
                <label htmlFor="fin-method">Forma</label>
                <select id="fin-method" value={form.method} disabled={locked} onChange={(e) => setForm((f) => ({ ...f, method: e.target.value as PaymentMethod, receivedText: "" }))}>
                  {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABEL[m]}</option>)}
                </select>
              </div>
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
              {split && partsOpen.length > 1 && (
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
                <button type="submit" className="btn-primary btn-auto" disabled={locked} data-testid="fin-pay-submit">{view.busy ? "Registrando…" : "Registrar pagamento"}</button>
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

      <div className="modal-actions">
        <button type="button" className="btn-secondary" disabled={view.busy} onClick={onClose}>Fechar</button>
      </div>

      {view.needsCash && (
        <OpenCashDialog source={cashSource} companyId={companyId} notice="Abra o caixa antes de registrar o pagamento." onOpened={() => ctrl.cashOpened()} onClose={() => ctrl.dismissNeedsCash()} />
      )}
    </Modal>
  );
}

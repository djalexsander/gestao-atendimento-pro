import { useState, type FormEvent } from "react";
import { formatReais } from "../../lib/money";
import { Modal } from "../employees/Modal";
import type { CashSession, CashSource } from "./cashApi";
import {
  canFinalize,
  draftAppliedCents,
  draftChangeCents,
  draftProblem,
  newDraft,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABEL,
  parseOpeningAmount,
  remainingCents,
  suggestedAmountText,
  summarizeMovements,
  toPaymentPayload,
  totalInformedCents,
  type CashMovementRow,
  type PaymentDraft,
  type PaymentMethod,
} from "./cashLogic";

const cents = (value: number) => formatReais(value / 100);

// Abrir o caixa: só o valor inicial. `onOpened` volta ao fluxo que pediu o caixa.
export function OpenCashDialog({
  source,
  companyId,
  notice,
  onOpened,
  onClose,
}: {
  source: CashSource;
  companyId: string;
  notice?: string;
  onOpened: () => void;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    const value = parseOpeningAmount(amount);
    if (value === null) {
      setError("Informe um valor inicial válido, ex.: 100,00.");
      return;
    }
    setError(null);
    setSubmitting(true);
    const result = await source.openCash(companyId, value);
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onOpened();
  }

  return (
    <Modal title="Abrir caixa" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        {notice && <p className="modal-text">{notice}</p>}
        {error && <div className="form-error">{error}</div>}
        <div className="field">
          <label htmlFor="opening-amount">Valor inicial do caixa</label>
          <input
            id="opening-amount"
            inputMode="decimal"
            placeholder="R$ 0,00"
            autoFocus
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <div className="modal-actions">
          <button className="btn-secondary" type="button" disabled={submitting} onClick={onClose}>
            Cancelar
          </button>
          <button className="btn-primary btn-auto" type="submit" disabled={submitting}>
            {submitting ? "Abrindo…" : "Abrir caixa"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

// Fechar o caixa (simples, sem conferência física): mostra o resumo do caixa e pede só uma
// observação opcional. Quem valida a permissão é o servidor (close_cash_session).
export function CloseCashDialog({
  source,
  cash,
  operatorName,
  movements,
  requireNotes = false,
  title = "Fechar caixa",
  notesHint,
  onClosed,
  onClose,
}: {
  source: CashSource;
  cash: CashSession;
  operatorName: string | null;
  movements: CashMovementRow[];
  // Fechamento administrativo do caixa de outro operador: a observação passa a ser obrigatória.
  requireNotes?: boolean;
  title?: string;
  notesHint?: string;
  onClosed: () => void;
  onClose: () => void;
}) {
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const summary = summarizeMovements(movements);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    if (requireNotes && notes.trim() === "") {
      setError("Informe uma observação para fechar o caixa de outro operador.");
      return;
    }
    setError(null);
    setSubmitting(true);
    const result = await source.closeCash(cash.id, notes.trim() || null);
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onClosed();
  }

  return (
    <Modal title={title} onClose={submitting ? () => undefined : onClose}>
      <form onSubmit={handleSubmit}>
        <dl className="cash-summary cash-summary-modal">
          <div>
            <dt>Operador</dt>
            <dd>{operatorName ?? cash.openedByName ?? "—"}</dd>
          </div>
          <div>
            <dt>Abertura</dt>
            <dd>{dateTime.format(new Date(cash.openedAt))}</dd>
          </div>
          <div>
            <dt>Saldo inicial</dt>
            <dd>{formatReais(cash.openingAmount)}</dd>
          </div>
          {PAYMENT_METHODS.map((method) => (
            <div key={method}>
              <dt>Vendas — {PAYMENT_METHOD_LABEL[method]}</dt>
              <dd>{formatReais(summary.byMethod[method])}</dd>
            </div>
          ))}
          <div>
            <dt>Total vendido</dt>
            <dd>{formatReais(summary.total)}</dd>
          </div>
        </dl>
        <p className="modal-text">Depois de fechado, este caixa não recebe mais vendas.</p>
        {error && <div className="form-error">{error}</div>}
        <div className="field">
          <label htmlFor="closing-notes">{requireNotes ? "Observação (obrigatória)" : "Observação (opcional)"}</label>
          <input
            id="closing-notes"
            maxLength={500}
            required={requireNotes}
            placeholder={notesHint}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="modal-actions">
          <button className="btn-secondary" type="button" disabled={submitting} onClick={onClose}>
            Cancelar
          </button>
          <button className="btn-danger" type="submit" disabled={submitting}>
            {submitting ? "Fechando…" : "Confirmar fechamento"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Fechar a conta: total (vindo do histórico já carregado — o servidor recalcula e é a autoridade),
// pagamentos divididos, troco em dinheiro. "Finalizar" só habilita com saldo zerado.
export function CheckoutDialog({
  source,
  sessionId,
  pointLabel,
  totalReais,
  onNeedCash,
  onDone,
  onClose,
}: {
  source: CashSource;
  sessionId: string;
  pointLabel: string;
  totalReais: number;
  onNeedCash: () => void; // caixa fechado/inexistente: a tela oferece "Abrir caixa"
  onDone: () => void;
  onClose: () => void;
}) {
  const totalCents = Math.round(totalReais * 100);
  const [drafts, setDrafts] = useState<PaymentDraft[]>(() => (totalCents > 0 ? [newDraft("pix", suggestedAmountText(totalCents))] : []));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const informed = totalInformedCents(drafts);
  const remaining = remainingCents(totalCents, drafts);
  const finalizable = canFinalize(totalCents, drafts);

  function update(key: string, patch: Partial<PaymentDraft>) {
    setError(null);
    setDrafts((current) => current.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  }

  function addPayment() {
    setError(null);
    setDrafts((current) => [...current, newDraft("pix", suggestedAmountText(remainingCents(totalCents, current)))]);
  }

  function removePayment(key: string) {
    setError(null);
    setDrafts((current) => current.filter((d) => d.key !== key));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!finalizable || submitting) return;
    setError(null);
    setSubmitting(true);
    const result = await source.closeAccount(sessionId, toPaymentPayload(drafts));
    setSubmitting(false);
    if (result.error === null) {
      onDone();
      return;
    }
    if (result.noOpenCash) {
      onNeedCash();
      return;
    }
    setError(result.error);
  }

  return (
    <Modal title="Fechar conta" onClose={submitting ? () => undefined : onClose}>
      <form onSubmit={handleSubmit}>
        <p className="modal-text">
          <strong>{pointLabel}</strong>
        </p>
        <dl className="checkout-summary">
          <div>
            <dt>Total da conta</dt>
            <dd>{formatReais(totalReais)}</dd>
          </div>
          <div>
            <dt>Já informado</dt>
            <dd>{cents(informed)}</dd>
          </div>
          <div>
            <dt>Saldo restante</dt>
            <dd className={remaining < 0 ? "checkout-over" : undefined}>{cents(remaining)}</dd>
          </div>
        </dl>

        {error && <div className="form-error">{error}</div>}
        {remaining < 0 && <div className="form-error">Os pagamentos ultrapassam o total da conta.</div>}

        <ul className="checkout-payments">
          {drafts.map((draft, index) => {
            const problem = draft.amount.trim() === "" && draft.received.trim() === "" ? null : draftProblem(draft);
            return (
              <li key={draft.key} className="checkout-payment">
                <div className="field">
                  <label htmlFor={`method-${draft.key}`}>Forma de pagamento {drafts.length > 1 ? index + 1 : ""}</label>
                  <select
                    id={`method-${draft.key}`}
                    value={draft.method}
                    onChange={(e) => update(draft.key, { method: e.target.value as PaymentMethod, received: "" })}
                  >
                    {PAYMENT_METHODS.map((method) => (
                      <option key={method} value={method}>
                        {PAYMENT_METHOD_LABEL[method]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={`amount-${draft.key}`}>{draft.method === "cash" ? "Valor aplicado" : "Valor"}</label>
                  <input
                    id={`amount-${draft.key}`}
                    inputMode="decimal"
                    placeholder="R$ 0,00"
                    value={draft.amount}
                    onChange={(e) => update(draft.key, { amount: e.target.value })}
                  />
                </div>
                {draft.method === "cash" && (
                  <>
                    <div className="field">
                      <label htmlFor={`received-${draft.key}`}>Valor recebido</label>
                      <input
                        id={`received-${draft.key}`}
                        inputMode="decimal"
                        placeholder={cents(draftAppliedCents(draft))}
                        value={draft.received}
                        onChange={(e) => update(draft.key, { received: e.target.value })}
                      />
                    </div>
                    <p className="checkout-change">
                      Troco: <strong>{cents(draftChangeCents(draft))}</strong>
                    </p>
                  </>
                )}
                {problem && <div className="field-error">{problem}</div>}
                {drafts.length > 1 && (
                  <button type="button" className="btn-secondary btn-small btn-danger-text" onClick={() => removePayment(draft.key)}>
                    Remover pagamento
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        {totalCents > 0 && (
          <button type="button" className="btn-secondary btn-small" disabled={submitting} onClick={addPayment}>
            Adicionar pagamento
          </button>
        )}
        {totalCents === 0 && <p className="modal-text">Esta conta não tem valor a receber.</p>}

        <div className="modal-actions">
          <button className="btn-secondary" type="button" disabled={submitting} onClick={onClose}>
            Cancelar
          </button>
          <button className="btn-primary btn-auto" type="submit" disabled={!finalizable || submitting}>
            {submitting ? "Finalizando…" : "Finalizar e fechar conta"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

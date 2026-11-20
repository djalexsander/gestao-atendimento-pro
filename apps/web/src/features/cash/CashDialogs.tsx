import { useEffect, useRef, useState, type FormEvent } from "react";
import { formatReais } from "../../lib/money";
import { Modal } from "../employees/Modal";
import { PaymentMethodButtons } from "./PaymentMethodButtons";
import type { CashSession, CashSource } from "./cashApi";
import { expectedMethodLabel, receiptPrefill } from "../operations/deliveryReceivables";
import type { ExpectedMethod } from "../delivery/deliveryLogic";
import {
  canFinalize,
  closingNotesRequired,
  describeDifference,
  reconcile,
  draftAppliedCents,
  draftChangeCents,
  draftProblem,
  newDraft,
  parseDraftCents,
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
  type RefundablePayment,
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

// Suprimento (entrada) ou sangria (retirada) de dinheiro no caixa ABERTO. Pertence ao caixa, não a
// uma comanda. Na sangria mostra o dinheiro disponível (prévia; o servidor recusa valor maior).
export function CashMovementDialog({
  source,
  cash,
  kind,
  movements,
  operatorName,
  onDone,
  onClose,
}: {
  source: CashSource;
  cash: CashSession;
  kind: "supply" | "withdrawal";
  movements: CashMovementRow[];
  operatorName: string | null;
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const isWithdrawal = kind === "withdrawal";
  const title = isWithdrawal ? "Sangria" : "Suprimento";
  const availableCents = reconcile(cash.openingAmount, summarizeMovements(movements).netCash, "").expectedCents;
  const valueCents = parseDraftCents(amount);
  const tooMuch = isWithdrawal && valueCents !== null && valueCents > availableCents;
  const valid = valueCents !== null && valueCents > 0 && reason.trim() !== "" && !tooMuch;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting || !valid || valueCents === null) return;
    setError(null);
    setSubmitting(true);
    const result = await source.addMovement(cash.id, kind, valueCents / 100, reason.trim());
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onDone(isWithdrawal ? "Sangria registrada." : "Suprimento registrado.");
  }

  return (
    <Modal title={title} onClose={submitting ? () => undefined : onClose}>
      <form onSubmit={handleSubmit}>
        <p className="modal-text">
          Caixa de <strong>{operatorName ?? cash.openedByName ?? "—"}</strong>
        </p>
        {isWithdrawal && (
          <div className="cash-expected">
            <span>Dinheiro disponível no caixa</span>
            <strong>{cents(availableCents)}</strong>
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="field">
          <label htmlFor="movement-amount">{isWithdrawal ? "Valor da sangria" : "Valor do suprimento"}</label>
          <input
            id="movement-amount"
            inputMode="decimal"
            placeholder="R$ 0,00"
            autoFocus
            value={amount}
            onChange={(e) => {
              setError(null);
              setAmount(e.target.value);
            }}
          />
          {amount.trim() !== "" && (valueCents === null || valueCents <= 0) && (
            <div className="field-error">Informe um valor maior que zero, ex.: 100,00.</div>
          )}
          {tooMuch && <div className="field-error">Valor da sangria maior que o dinheiro disponível no caixa.</div>}
        </div>
        <div className="field">
          <label htmlFor="movement-reason">Motivo (obrigatório)</label>
          <input
            id="movement-reason"
            maxLength={200}
            placeholder={isWithdrawal ? "Ex.: Retirada para cofre" : "Ex.: Troco adicional"}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <div className="modal-actions">
          <button className="btn-secondary" type="button" disabled={submitting} onClick={onClose}>
            Cancelar
          </button>
          <button className="btn-primary btn-auto" type="submit" disabled={!valid || submitting}>
            {submitting ? "Registrando…" : isWithdrawal ? "Confirmar sangria" : "Confirmar suprimento"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Fechar o caixa COM conferência: resumo, dinheiro esperado (saldo inicial + vendas em dinheiro),
// dinheiro contado e diferença. O servidor recalcula esperado e diferença (close_cash_session);
// aqui é só a prévia. Diferença ou caixa de outro operador exigem observação.
export function CloseCashDialog({
  source,
  cash,
  operatorName,
  movements,
  otherOperator = false,
  title = "Fechar caixa",
  notesHint,
  onClosed,
  onClose,
}: {
  source: CashSource;
  cash: CashSession;
  operatorName: string | null;
  movements: CashMovementRow[];
  // Fechamento administrativo do caixa de outro operador: a observação é sempre obrigatória.
  otherOperator?: boolean;
  title?: string;
  notesHint?: string;
  onClosed: () => void;
  onClose: () => void;
}) {
  const [counted, setCounted] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const summary = summarizeMovements(movements);
  const rec = reconcile(cash.openingAmount, summary.netCash, counted);
  const notesRequired = closingNotesRequired(rec.differenceCents, otherOperator);
  const hasDifference = rec.differenceCents !== null && rec.differenceCents !== 0;
  const countedInvalid = counted.trim() !== "" && rec.countedCents === null;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    if (rec.countedCents === null) {
      setError("Informe o dinheiro contado, ex.: 350,00 (pode ser 0).");
      return;
    }
    if (notesRequired && notes.trim() === "") {
      setError(hasDifference ? "Informe o motivo da diferença encontrada no caixa." : "Informe uma observação para fechar o caixa de outro operador.");
      return;
    }
    setError(null);
    setSubmitting(true);
    const result = await source.closeCash(cash.id, rec.countedCents / 100, notes.trim() || null);
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
        <h4 className="cash-section-title">Resumo do caixa</h4>
        <dl className="cash-summary cash-summary-modal">
          <div>
            <dt>Operador</dt>
            <dd>{operatorName ?? cash.openedByName ?? "—"}</dd>
          </div>
          <div>
            <dt>Aberto em</dt>
            <dd>{dateTime.format(new Date(cash.openedAt))}</dd>
          </div>
          <div>
            <dt>Saldo inicial</dt>
            <dd>{formatReais(cash.openingAmount)}</dd>
          </div>
        </dl>

        <h4 className="cash-section-title">Vendas</h4>
        <dl className="cash-summary cash-summary-modal">
          {PAYMENT_METHODS.map((method) => (
            <div key={method}>
              <dt>{PAYMENT_METHOD_LABEL[method]}</dt>
              <dd>{formatReais(summary.byMethod[method])}</dd>
            </div>
          ))}
          <div className="cash-summary-strong">
            <dt>Total vendido</dt>
            <dd>{formatReais(summary.total)}</dd>
          </div>
        </dl>

        <h4 className="cash-section-title">Movimentos de caixa</h4>
        <dl className="cash-summary cash-summary-modal">
          <div>
            <dt>Suprimentos</dt>
            <dd>{formatReais(summary.supply)}</dd>
          </div>
          <div>
            <dt>Sangrias</dt>
            <dd>{formatReais(summary.withdrawal)}</dd>
          </div>
          <div>
            <dt>Estornos pagos</dt>
            <dd>{formatReais(summary.refund)}</dd>
          </div>
        </dl>

        <h4 className="cash-section-title">Conferência do dinheiro</h4>
        <div className="cash-expected">
          <span>Dinheiro esperado no caixa</span>
          <strong>{cents(rec.expectedCents)}</strong>
          <small>Saldo inicial + vendas em dinheiro + suprimentos − sangrias − estornos em dinheiro</small>
        </div>
        <div className="field">
          <label htmlFor="closing-counted">Dinheiro contado</label>
          <input
            id="closing-counted"
            inputMode="decimal"
            placeholder="R$ 0,00"
            autoFocus
            value={counted}
            onChange={(e) => {
              setError(null);
              setCounted(e.target.value);
            }}
          />
          {countedInvalid && <div className="field-error">Informe um valor válido, ex.: 350,00.</div>}
        </div>
        {rec.differenceCents !== null && (
          <p
            role="status"
            className={`cash-difference ${rec.differenceCents === 0 ? "cash-difference-ok" : "cash-difference-bad"}`}
          >
            {describeDifference(rec.differenceCents, formatReais)}
          </p>
        )}

        <p className="modal-text">Depois de fechado, este caixa não recebe mais vendas.</p>
        {error && <div className="form-error">{error}</div>}
        <div className="field">
          <label htmlFor="closing-notes">{notesRequired ? "Observação (obrigatória)" : "Observação (opcional)"}</label>
          <input
            id="closing-notes"
            maxLength={500}
            required={notesRequired}
            placeholder={hasDifference ? "Motivo da diferença encontrada" : notesHint}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="modal-actions">
          <button className="btn-secondary" type="button" disabled={submitting} onClick={onClose}>
            Cancelar
          </button>
          <button className="btn-danger" type="submit" disabled={submitting || rec.countedCents === null}>
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
  delivery,
  onNeedCash,
  onDone,
  onClose,
  inline = false,
}: {
  source: CashSource;
  sessionId: string;
  pointLabel: string;
  totalReais: number;
  // Delivery/retirada: forma PRETENDIDA e "troco para" só PRÉ-PREENCHEM (tudo editável); o recebimento usa a RPC idempotente.
  delivery?: { deliveryOrderId: string; expectedMethod: ExpectedMethod | null; cashChangeFor: number | null } | null;
  onNeedCash: () => void; // caixa fechado/inexistente: a tela oferece "Abrir caixa"
  onDone: () => void;
  onClose: () => void;
  // PDV de três colunas (v1.0.20): o MESMO formulário, sem moldura de diálogo e com atalhos (F1–F5 forma, Ctrl+Enter finaliza).
  inline?: boolean;
}) {
  const totalCents = Math.round(totalReais * 100);
  const [drafts, setDrafts] = useState<PaymentDraft[]>(() => {
    if (totalCents <= 0) return [];
    if (!delivery) return [newDraft("pix", suggestedAmountText(totalCents))];
    const pre = receiptPrefill(delivery.expectedMethod, delivery.cashChangeFor, totalReais);
    return [{ ...newDraft(pre.method, suggestedAmountText(totalCents)), received: pre.receivedText }];
  });
  // Um pedido de recebimento por abertura do diálogo: tentar de novo (rede/clique duplo) reaproveita o MESMO id e nunca duplica.
  const requestId = useRef<string>(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)),
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  // PDV (inline): a forma só conta depois de ESCOLHIDA (botão/F1–F5). Delivery/retirada já vem com a forma pretendida pré-marcada (editável).
  const [chosenKeys, setChosenKeys] = useState<Set<string>>(() => new Set(delivery ? drafts.map((d) => d.key) : []));
  const allChosen = !inline || drafts.every((d) => chosenKeys.has(d.key));
  const submittingRef = useRef(false);

  const informed = totalInformedCents(drafts);
  const remaining = remainingCents(totalCents, drafts);
  const finalizable = canFinalize(totalCents, drafts) && allChosen;

  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const finalizableRef = useRef(finalizable);
  finalizableRef.current = finalizable;
  const chooseMethodRef = useRef<(key: string, method: PaymentMethod) => void>(() => undefined);
  function chooseMethod(key: string, method: PaymentMethod) { chooseMethodRef.current(key, method); }
  useEffect(() => {
    if (!inline) return;
    function onShortcut(e: Event) {
      const d = (e as CustomEvent<{ kind: string; method?: PaymentMethod }>).detail;
      if (d.kind === "method" && d.method) { const last = draftsRef.current[draftsRef.current.length - 1]; if (last) chooseMethod(last.key, d.method); }
      if (d.kind === "finalize" && finalizableRef.current && !submittingRef.current) formRef.current?.requestSubmit();
    }
    window.addEventListener("pdv-shortcut", onShortcut);
    return () => window.removeEventListener("pdv-shortcut", onShortcut);
  }, [inline]);

  // Escolher a forma (botão ou F1–F5): marca a linha e SUGERE o saldo restante se o valor estiver vazio/inválido (valor já editado é mantido).
  chooseMethodRef.current = (key, method) => {
    setError(null);
    setChosenKeys((cur) => new Set(cur).add(key));
    setDrafts((cur) => cur.map((d) => {
      if (d.key !== key) return d;
      const c = parseDraftCents(d.amount);
      const others = cur.filter((x) => x.key !== key);
      return { ...d, method, received: "", amount: c === null || c <= 0 ? suggestedAmountText(remainingCents(totalCents, others)) : d.amount };
    }));
  };

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
    if (!finalizable || submitting || submittingRef.current) return;   // proteção contra duplo acionamento (Enter repetido/clique duplo)
    submittingRef.current = true;
    setError(null);
    setSubmitting(true);
    const payload = toPaymentPayload(drafts);
    const result = delivery ? await source.receiveDelivery(delivery.deliveryOrderId, payload, requestId.current) : await source.closeAccount(sessionId, payload);
    submittingRef.current = false;
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

  const checkoutForm = (
      <form ref={formRef} onSubmit={handleSubmit}>
        <p className="modal-text">
          <strong>{pointLabel}</strong>
        </p>
        {delivery && (
          <p className="field-hint" data-testid="checkout-intended">
            Forma pretendida pelo cliente: <strong>{expectedMethodLabel({ expectedMethod: delivery.expectedMethod }) ?? "não informada"}</strong>
            {delivery.cashChangeFor !== null ? <> · troco para <strong>{formatReais(delivery.cashChangeFor)}</strong></> : null}
            . Confirme a forma REAL recebida: você pode alterar.
          </p>
        )}
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
                <h4 className="checkout-payment-title">Forma de pagamento {index + 1}</h4>
                {inline ? (
                  <PaymentMethodButtons value={chosenKeys.has(draft.key) ? draft.method : null} disabled={submitting} onSelect={(m) => chooseMethod(draft.key, m)} />
                ) : (
                <div className="field">
                  <label htmlFor={`method-${draft.key}`}>Forma</label>
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
                )}
                {inline && !chosenKeys.has(draft.key) && <p className="field-hint pay-methods-hint">Nenhuma forma selecionada. Ao escolher F1–F5, o valor pendente é sugerido e pode ser editado.</p>}
                <div className="field">
                  <label htmlFor={`amount-${draft.key}`}>{draft.method === "cash" ? "Valor pago em dinheiro" : "Valor do pagamento"}</label>
                  <input
                    id={`amount-${draft.key}`}
                    inputMode="decimal"
                    placeholder="R$ 0,00"
                    value={draft.amount}
                    onChange={(e) => update(draft.key, { amount: e.target.value })}
                  />
                  <small className="field-hint">Este valor será abatido do saldo da conta.</small>
                </div>
                {draft.method === "cash" && (
                  <>
                    <div className="field">
                      <label htmlFor={`received-${draft.key}`}>Valor entregue pelo cliente (opcional)</label>
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
          {!inline && (
            <button className="btn-secondary" type="button" disabled={submitting} onClick={onClose}>
              Cancelar
            </button>
          )}
          <button className="btn-primary btn-auto" type="submit" disabled={!finalizable || submitting}>
            <span>{submitting ? "Finalizando…" : "Finalizar e fechar conta"}</span>{inline && <kbd className="pay-submit-key">Enter</kbd>}
          </button>
        </div>
      </form>
  );
  if (inline) return <div className="pdv-inline" data-testid="pdv-checkout">{checkoutForm}</div>;
  return (
    <Modal title={delivery ? "Receber / Fechar conta" : "Fechar conta"} onClose={submitting ? () => undefined : onClose}>
      {checkoutForm}
    </Modal>
  );
}

// Estornar (parte de) um pagamento de conta FECHADA. Registro financeiro interno: a conta e o
// pagamento originais não mudam; o servidor limita ao valor ainda estornável e exige caixa aberto.
export function RefundDialog({
  source,
  payment,
  onDone,
  onClose,
}: {
  source: CashSource;
  payment: RefundablePayment;
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const availableCents = Math.round(payment.available * 100);
  const valueCents = parseDraftCents(amount);
  const tooMuch = valueCents !== null && valueCents > availableCents;
  const valid = valueCents !== null && valueCents > 0 && !tooMuch && reason.trim() !== "";

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting || !valid || valueCents === null) return;
    setError(null);
    setSubmitting(true);
    const result = await source.refundPayment(payment.paymentId, valueCents / 100, reason.trim());
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onDone("Estorno registrado.");
  }

  return (
    <Modal title="Estornar pagamento" onClose={submitting ? () => undefined : onClose}>
      <form onSubmit={handleSubmit}>
        <dl className="cash-summary cash-summary-modal">
          <div>
            <dt>Forma</dt>
            <dd>{PAYMENT_METHOD_LABEL[payment.method]}</dd>
          </div>
          <div>
            <dt>Valor pago</dt>
            <dd>{formatReais(payment.amount)}</dd>
          </div>
          <div>
            <dt>Já estornado</dt>
            <dd>{formatReais(payment.refunded)}</dd>
          </div>
          <div className="cash-summary-strong">
            <dt>Disponível para estorno</dt>
            <dd>{formatReais(payment.available)}</dd>
          </div>
        </dl>
        {payment.method === "cash" && (
          <p className="field-hint">Estorno em dinheiro sai do dinheiro do SEU caixa aberto.</p>
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="field">
          <label htmlFor="refund-amount">Valor a estornar</label>
          <input
            id="refund-amount"
            inputMode="decimal"
            placeholder="R$ 0,00"
            autoFocus
            value={amount}
            onChange={(e) => {
              setError(null);
              setAmount(e.target.value);
            }}
          />
          {amount.trim() !== "" && (valueCents === null || valueCents <= 0) && (
            <div className="field-error">Informe um valor maior que zero, ex.: 50,00.</div>
          )}
          {tooMuch && <div className="field-error">Valor maior que o disponível para estorno.</div>}
        </div>
        <div className="field">
          <label htmlFor="refund-reason">Motivo (obrigatório)</label>
          <input
            id="refund-reason"
            maxLength={200}
            placeholder="Ex.: Cobrança duplicada"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <div className="modal-actions">
          <button className="btn-secondary" type="button" disabled={submitting} onClick={onClose}>
            Cancelar
          </button>
          <button className="btn-danger" type="submit" disabled={!valid || submitting}>
            {submitting ? "Estornando…" : "Confirmar estorno"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

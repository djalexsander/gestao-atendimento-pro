import { useEffect, useState, type FormEvent } from "react";
import { formatCents } from "../../lib/money";
import { Modal } from "../employees/Modal";
import { formatDateBR } from "../reports/reportsLogic";
import type { ReceivablesSource } from "./receivablesApi";
import {
  balanceAfter,
  canCancel,
  canEdit,
  canReceive,
  draftFromRow,
  dueHint,
  EMPTY_DRAFT,
  isPartial,
  newPaymentDraft,
  RECEIVABLE_METHOD_LABEL,
  RECEIVABLE_METHODS,
  STATUS_LABEL,
  validateDraft,
  validatePayment,
  type PaymentMethodKey,
  type ReceivableDraft,
  type ReceivableEvent,
  type ReceivableRow,
} from "./receivablesLogic";

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });
const when = (iso: string) => dateTime.format(new Date(iso));

export function StatusBadge({ row }: { row: ReceivableRow }) {
  return (
    <span className="rec-badges">
      <span className={`rec-badge rec-badge-${row.displayStatus}`}>{STATUS_LABEL[row.displayStatus]}</span>
      {isPartial(row) && <span className="rec-badge rec-badge-partial">Parcial</span>}
    </span>
  );
}

// Nova conta / editar conta pendente. O servidor valida de novo (e recusa edição de conta paga/cancelada).
export function ReceivableFormDialog({
  source,
  companyId,
  row,
  onDone,
  onClose,
}: {
  source: ReceivablesSource;
  companyId: string;
  row: ReceivableRow | null; // null = nova conta
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ReceivableDraft>(row ? draftFromRow(row) : EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const set = (key: keyof ReceivableDraft) => (e: { target: { value: string } }) => setDraft({ ...draft, [key]: e.target.value });

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    const checked = validateDraft(draft, row?.paidCents ?? 0);
    if ("error" in checked) {
      setError(checked.error);
      return;
    }
    setError(null);
    setSubmitting(true);
    const result = row ? await source.update(row.id, checked.payload) : await source.create(companyId, checked.payload);
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onDone(row ? "Conta atualizada." : "Conta criada.");
  }

  return (
    <Modal title={row ? "Editar conta" : "Nova conta a receber"} onClose={onClose}>
      <form className="rec-form" onSubmit={handleSubmit}>
        {error && <div className="form-error">{error}</div>}
        {row && row.paidCents > 0 && <p className="modal-text">Já recebido: {formatCents(row.paidCents)}. O novo valor precisa ser maior que isso.</p>}
        <div className="field">
          <label htmlFor="rec-customer">Cliente</label>
          <input id="rec-customer" autoFocus maxLength={120} value={draft.customer} onChange={set("customer")} />
        </div>
        <div className="field">
          <label htmlFor="rec-description">Descrição</label>
          <input id="rec-description" maxLength={200} placeholder="Ex.: Encomenda de espetos" value={draft.description} onChange={set("description")} />
        </div>
        <div className="rec-form-row">
          <div className="field">
            <label htmlFor="rec-amount">Valor</label>
            <input id="rec-amount" inputMode="decimal" placeholder="R$ 0,00" value={draft.amount} onChange={set("amount")} />
          </div>
          <div className="field">
            <label htmlFor="rec-due">Vencimento</label>
            <input id="rec-due" type="date" value={draft.dueDate} onChange={set("dueDate")} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="rec-reference">Referência (opcional)</label>
          <input id="rec-reference" maxLength={60} placeholder="Ex.: Pedido 123" value={draft.reference} onChange={set("reference")} />
        </div>
        <div className="field">
          <label htmlFor="rec-notes">Observação (opcional)</label>
          <textarea id="rec-notes" rows={2} maxLength={500} value={draft.notes} onChange={set("notes")} />
        </div>
        <div className="modal-actions">
          <button className="btn-secondary" type="button" disabled={submitting} onClick={onClose}>
            Cancelar
          </button>
          <button className="btn-primary btn-auto" type="submit" disabled={submitting}>
            {submitting ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Registrar recebimento (total ou parcial). Não lança nada no Caixa.
export function ReceivePaymentDialog({
  source,
  row,
  today,
  onDone,
  onClose,
}: {
  source: ReceivablesSource;
  row: ReceivableRow;
  today: string;
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(() => newPaymentDraft(row.balanceCents, today));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const rest = balanceAfter(row.balanceCents, draft.amount);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    const checked = validatePayment(draft, row.balanceCents, today);
    if ("error" in checked) {
      setError(checked.error);
      return;
    }
    setError(null);
    setSubmitting(true);
    const { amount, method, paidOn, note } = checked.payload;
    const result = await source.receive(row.id, amount, method, paidOn, note);
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onDone(rest === 0 ? "Conta recebida." : "Recebimento registrado.");
  }

  return (
    <Modal title="Registrar recebimento" onClose={onClose}>
      <form className="rec-form" onSubmit={handleSubmit}>
        <p className="modal-text">
          <strong>{row.customerName}</strong> · {row.description}
          <br />
          Valor da conta {formatCents(row.amountCents)} · Saldo <strong>{formatCents(row.balanceCents)}</strong>
        </p>
        {error && <div className="form-error">{error}</div>}
        <div className="rec-form-row">
          <div className="field">
            <label htmlFor="pay-amount">Valor recebido</label>
            <input id="pay-amount" inputMode="decimal" autoFocus value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="pay-date">Data do recebimento</label>
            <input id="pay-date" type="date" max={today} value={draft.paidOn} onChange={(e) => setDraft({ ...draft, paidOn: e.target.value })} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="pay-method">Forma de pagamento</label>
          <select id="pay-method" value={draft.method} onChange={(e) => setDraft({ ...draft, method: e.target.value as PaymentMethodKey })}>
            {RECEIVABLE_METHODS.map((m) => (
              <option key={m} value={m}>
                {RECEIVABLE_METHOD_LABEL[m]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="pay-note">Observação (opcional)</label>
          <input id="pay-note" maxLength={500} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
        </div>
        {rest !== null && <p className="field-hint">{rest === 0 ? "A conta será quitada." : `Saldo restante: ${formatCents(rest)}.`}</p>}
        <p className="field-hint">Este recebimento não é lançado no Caixa.</p>
        <div className="modal-actions">
          <button className="btn-secondary" type="button" disabled={submitting} onClick={onClose}>
            Voltar
          </button>
          <button className="btn-primary btn-auto" type="submit" disabled={submitting}>
            {submitting ? "Registrando…" : "Registrar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function CancelReceivableDialog({
  source,
  row,
  onDone,
  onClose,
}: {
  source: ReceivablesSource;
  row: ReceivableRow;
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    const result = await source.cancel(row.id, reason.trim() === "" ? null : reason.trim());
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onDone("Conta cancelada.");
  }

  return (
    <Modal title="Cancelar conta" onClose={onClose}>
      <form className="rec-form" onSubmit={handleSubmit}>
        <p className="modal-text">
          Cancelar a conta de <strong>{row.customerName}</strong> ({formatCents(row.amountCents)})? Ela continua no histórico como cancelada.
        </p>
        {error && <div className="form-error">{error}</div>}
        <div className="field">
          <label htmlFor="cancel-reason">Motivo (opcional)</label>
          <input id="cancel-reason" autoFocus maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div className="modal-actions">
          <button className="btn-secondary" type="button" disabled={submitting} onClick={onClose}>
            Voltar
          </button>
          <button className="btn-danger btn-auto" type="submit" disabled={submitting}>
            {submitting ? "Cancelando…" : "Cancelar conta"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const EVENT_LABEL: Record<ReceivableEvent["type"], string> = {
  created: "Conta criada",
  updated: "Dados alterados",
  payment: "Recebimento",
  cancelled: "Conta cancelada",
};

export function ReceivableDetailDialog({
  source,
  companyId,
  row,
  today,
  onEdit,
  onReceive,
  onCancel,
  onClose,
}: {
  source: ReceivablesSource;
  companyId: string;
  row: ReceivableRow;
  today: string;
  onEdit: () => void;
  onReceive: () => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const [events, setEvents] = useState<ReceivableEvent[] | null>(null);

  useEffect(() => {
    let alive = true;
    void source.history(companyId, row.id).then((r) => {
      if (alive) setEvents(r.data ?? []);
    });
    return () => {
      alive = false;
    };
  }, [source, companyId, row.id]);

  return (
    <Modal title="Detalhes da conta" onClose={onClose}>
      <div className="rec-detail">
        <div className="rec-detail-head">
          <strong>{row.customerName}</strong>
          <StatusBadge row={row} />
        </div>
        <p className="rec-detail-desc">{row.description}</p>
        <dl className="rec-detail-grid">
          <div><dt>Valor original</dt><dd>{formatCents(row.amountCents)}</dd></div>
          <div><dt>Recebido</dt><dd>{formatCents(row.paidCents)}</dd></div>
          <div><dt>Saldo</dt><dd>{formatCents(row.balanceCents)}</dd></div>
          <div>
            <dt>Vencimento</dt>
            <dd>
              {formatDateBR(row.dueDate)}
              {row.status === "pending" && <small className="muted"> · {dueHint(row.dueDate, today)}</small>}
            </dd>
          </div>
          {row.paymentMethod && (
            <div><dt>Última forma de pagamento</dt><dd>{RECEIVABLE_METHOD_LABEL[row.paymentMethod]}</dd></div>
          )}
          {row.paidAt && <div><dt>Último recebimento</dt><dd>{when(row.paidAt)}</dd></div>}
          {row.reference && <div><dt>Referência</dt><dd>{row.reference}</dd></div>}
          <div><dt>Criada por</dt><dd>{row.createdByName ?? "—"} · {when(row.createdAt)}</dd></div>
          <div><dt>Atualizada em</dt><dd>{when(row.updatedAt)}</dd></div>
          {row.status === "cancelled" && (
            <div><dt>Cancelamento</dt><dd>{row.cancelledAt ? when(row.cancelledAt) : "—"}{row.cancelReason ? ` · ${row.cancelReason}` : ""}</dd></div>
          )}
        </dl>
        {row.notes && <p className="rec-detail-notes">{row.notes}</p>}

        <h4>Histórico</h4>
        {events === null ? (
          <p className="muted">Carregando…</p>
        ) : events.length === 0 ? (
          <p className="muted">Sem registros.</p>
        ) : (
          <ul className="rec-history">
            {events.map((e) => (
              <li key={e.id}>
                <span>
                  <strong>{EVENT_LABEL[e.type]}</strong>
                  {e.amountCents !== null && ` · ${formatCents(e.amountCents)}`}
                  {e.method && ` · ${RECEIVABLE_METHOD_LABEL[e.method]}`}
                  {e.paidOn && ` · em ${formatDateBR(e.paidOn)}`}
                  {e.note && <small className="muted"> · {e.note}</small>}
                </span>
                <small className="muted">{e.createdByName ?? "—"} · {when(e.createdAt)}</small>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="modal-actions rec-detail-actions">
        {canEdit(row) && <button className="btn-secondary btn-auto" type="button" onClick={onEdit}>Editar</button>}
        {canCancel(row) && <button className="btn-secondary btn-auto" type="button" onClick={onCancel}>Cancelar conta</button>}
        {canReceive(row) && <button className="btn-primary btn-auto" type="button" onClick={onReceive}>Registrar recebimento</button>}
        <button className="btn-secondary btn-auto" type="button" onClick={onClose}>Fechar</button>
      </div>
    </Modal>
  );
}

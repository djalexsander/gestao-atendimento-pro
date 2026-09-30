import { useState, type FormEvent } from "react";
import { Modal } from "../employees/Modal";
import type { OrdersSource } from "./ordersApi";
import { activeQuantity, type SubmittedOrderItem } from "./ordersLogic";

// Cancelar (parte de) um item de conta ABERTA. Não apaga nada: o servidor soma à quantidade
// cancelada e guarda um evento com o motivo. Se só resta 1 unidade, já vem sugerido.
export function CancelItemDialog({
  source,
  item,
  onDone,
  onClose,
}: {
  source: OrdersSource;
  item: SubmittedOrderItem;
  onDone: () => void;
  onClose: () => void;
}) {
  const available = activeQuantity(item);
  const [quantity, setQuantity] = useState(available === 1 ? "1" : "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const value = /^\d+$/.test(quantity.trim()) ? Number(quantity.trim()) : null;
  const quantityProblem =
    quantity.trim() === "" ? null : value === null || value <= 0 ? "Informe um número inteiro maior que zero." : value > available ? `No máximo ${available}.` : null;
  const valid = value !== null && value > 0 && value <= available && reason.trim() !== "";

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting || !valid || value === null) return;
    setError(null);
    setSubmitting(true);
    const result = await source.cancelItem(item.id, value, reason.trim());
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onDone();
  }

  return (
    <Modal title="Cancelar item" onClose={submitting ? () => undefined : onClose}>
      <form onSubmit={handleSubmit}>
        <dl className="cash-summary cash-summary-modal">
          <div>
            <dt>Produto</dt>
            <dd>{item.productNameSnapshot}</dd>
          </div>
          <div>
            <dt>Quantidade pedida</dt>
            <dd>{item.quantity}</dd>
          </div>
          <div>
            <dt>Já cancelada</dt>
            <dd>{item.cancelledQuantity}</dd>
          </div>
          <div>
            <dt>Disponível</dt>
            <dd>{available}</dd>
          </div>
        </dl>
        {error && <div className="form-error">{error}</div>}
        <div className="field">
          <label htmlFor="cancel-quantity">Quantidade a cancelar</label>
          <input
            id="cancel-quantity"
            inputMode="numeric"
            autoFocus
            value={quantity}
            onChange={(e) => {
              setError(null);
              setQuantity(e.target.value);
            }}
          />
          {quantityProblem && <div className="field-error">{quantityProblem}</div>}
        </div>
        <div className="field">
          <label htmlFor="cancel-reason">Motivo (obrigatório)</label>
          <input
            id="cancel-reason"
            maxLength={200}
            placeholder="Ex.: Cliente desistiu"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <div className="modal-actions">
          <button className="btn-secondary" type="button" disabled={submitting} onClick={onClose}>
            Voltar
          </button>
          <button className="btn-danger" type="submit" disabled={!valid || submitting}>
            {submitting ? "Cancelando…" : "Confirmar cancelamento"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

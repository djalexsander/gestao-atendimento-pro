import { useEffect, useState, type FormEvent } from "react";
import { Modal } from "../employees/Modal";
import type { StockMovement, StockSource } from "./stockApi";
import { isOutgoing, MOVEMENT_LABEL, parseQuantity, resultingBalance } from "./stockLogic";

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

// Entrada (reposição) ou ajuste (entrada/saída) de um produto CONTROLADO. O saldo nunca é digitado:
// só movimentos. Mostra o saldo resultante antes de confirmar; o servidor recusa saldo negativo.
export function StockMovementDialog({
  source,
  productId,
  productName,
  current,
  mode,
  onDone,
  onClose,
}: {
  source: StockSource;
  productId: string;
  productName: string;
  current: number;
  mode: "entry" | "adjust";
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const [direction, setDirection] = useState<"adjustment_in" | "adjustment_out">("adjustment_in");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState(mode === "entry" ? "Reposição" : "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const type = mode === "entry" ? "entry" : direction;
  const value = parseQuantity(quantity);
  const result = value === null ? null : resultingBalance(current, type, value);
  const negative = result !== null && result < 0;
  const valid = value !== null && !negative && (mode === "entry" || reason.trim() !== "");

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting || !valid || value === null) return;
    setError(null);
    setSubmitting(true);
    const response = await source.move(productId, type, value, reason.trim());
    setSubmitting(false);
    if (response.error) {
      setError(response.error);
      return;
    }
    onDone(mode === "entry" ? "Entrada registrada." : "Ajuste registrado.");
  }

  return (
    <Modal title={mode === "entry" ? "Entrada de estoque" : "Ajustar estoque"} onClose={submitting ? () => undefined : onClose}>
      <form onSubmit={handleSubmit}>
        <dl className="cash-summary cash-summary-modal">
          <div>
            <dt>Produto</dt>
            <dd>{productName}</dd>
          </div>
          <div>
            <dt>Saldo atual</dt>
            <dd>{current}</dd>
          </div>
        </dl>
        {mode === "adjust" && (
          <div className="field">
            <span className="field-label">Tipo</span>
            <div className="radio-row">
              <label>
                <input type="radio" name="stock-direction" checked={direction === "adjustment_in"} onChange={() => setDirection("adjustment_in")} /> Entrada
              </label>
              <label>
                <input type="radio" name="stock-direction" checked={direction === "adjustment_out"} onChange={() => setDirection("adjustment_out")} /> Saída
              </label>
            </div>
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="field">
          <label htmlFor="stock-quantity">Quantidade</label>
          <input
            id="stock-quantity"
            inputMode="numeric"
            autoFocus
            placeholder="Ex.: 30"
            value={quantity}
            onChange={(e) => {
              setError(null);
              setQuantity(e.target.value);
            }}
          />
          {quantity.trim() !== "" && value === null && <div className="field-error">Informe um número inteiro maior que zero.</div>}
        </div>
        <div className="field">
          <label htmlFor="stock-reason">{mode === "entry" ? "Motivo (opcional)" : "Motivo (obrigatório)"}</label>
          <input
            id="stock-reason"
            maxLength={200}
            placeholder={mode === "entry" ? "Ex.: Reposição" : "Ex.: Contagem física, quebra, perda"}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        {result !== null && (
          <p className={negative ? "form-error" : "cash-difference cash-difference-ok"} role="status">
            {negative ? "Essa saída deixaria o estoque negativo." : `Saldo resultante: ${result}`}
          </p>
        )}
        <div className="modal-actions">
          <button className="btn-secondary" type="button" disabled={submitting} onClick={onClose}>
            Cancelar
          </button>
          <button className="btn-primary btn-auto" type="submit" disabled={!valid || submitting}>
            {submitting ? "Registrando…" : mode === "entry" ? "Confirmar entrada" : "Confirmar ajuste"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Histórico recente (30 últimos) do produto: tipo, quantidade, saldo após, motivo, quem e quando.
export function StockHistoryDialog({
  source,
  productId,
  productName,
  onClose,
}: {
  source: StockSource;
  productId: string;
  productName: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<StockMovement[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void source.history(productId).then((result) => {
      if (cancelled) return;
      if (result.error || !result.data) setError(result.error ?? "Não foi possível carregar o histórico.");
      else setRows(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [source, productId]);

  return (
    <Modal title={`Histórico — ${productName}`} onClose={onClose}>
      {error && <div className="form-error">{error}</div>}
      {!rows && !error && <p className="op-state">Carregando…</p>}
      {rows && rows.length === 0 && <p className="field-hint">Nenhum movimento ainda.</p>}
      {rows && rows.length > 0 && (
        <ul className="stock-history">
          {rows.map((m) => (
            <li key={m.id}>
              <div className="stock-history-head">
                <strong>{MOVEMENT_LABEL[m.type]}</strong>
                <span className={isOutgoing(m.type) ? "stock-out" : "stock-in"}>
                  {isOutgoing(m.type) ? "−" : "+"}
                  {m.quantity}
                </span>
                <span className="muted">saldo {m.balanceAfter}</span>
              </div>
              <div className="muted">
                {m.reason} · {m.createdByName ?? "—"} · {dateTime.format(new Date(m.createdAt))}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="modal-actions">
        <button className="btn-secondary" type="button" onClick={onClose}>
          Fechar
        </button>
      </div>
    </Modal>
  );
}

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Modal } from "../employees/Modal";
import { formatOpenedFull, STATUS_LABEL, statusOf, type ServicePoint } from "./panel";

const CUSTOMER_MAX_LENGTH = 80;
// Leitor de código de barras configurado com Enter duplo (ou Enter apertado duas vezes) faria o
// segundo Enter cair no diálogo recém-aberto e abrir o atendimento sem querer: nesse
// intervalo depois de abrir, o envio é ignorado.
const IGNORE_SUBMIT_MS = 600;

// Ponto LIVRE: pede só o cliente (opcional) e abre o atendimento. `onSubmit` devolve a mensagem
// de erro (ou null quando abriu); quem fecha o diálogo em caso de sucesso é o painel.
export function OpenSessionDialog({
  point,
  onSubmit,
  onClose,
}: {
  point: ServicePoint;
  onSubmit: (customer: string | null) => Promise<string | null>;
  onClose: () => void;
}) {
  const [customer, setCustomer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const openedAt = useRef(0);

  useEffect(() => {
    openedAt.current = Date.now();
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (Date.now() - openedAt.current < IGNORE_SUBMIT_MS) return;
    setError(null);
    setSubmitting(true);
    const problem = await onSubmit(customer.trim() || null);
    setSubmitting(false);
    if (problem) setError(problem);
  }

  return (
    <Modal title="Abrir atendimento" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <p className="modal-text">
          <strong>{point.display_name}</strong> está livre.
        </p>
        {error && <div className="form-error">{error}</div>}
        <div className="field">
          <label htmlFor="op-customer">Cliente (opcional)</label>
          <input
            id="op-customer"
            type="text"
            maxLength={CUSTOMER_MAX_LENGTH}
            autoComplete="off"
            value={customer}
            onChange={(e) => setCustomer(e.target.value)}
          />
        </div>
        <div className="modal-actions">
          <button className="btn-secondary" type="button" disabled={submitting} onClick={onClose}>
            Cancelar
          </button>
          <button className="btn-primary btn-auto" type="submit" disabled={submitting}>
            {submitting ? "Abrindo…" : "Abrir atendimento"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Ponto em ATENDIMENTO: tela provisória. Pedidos e produtos entram na próxima etapa.
export function SessionDetailDialog({ point, onClose }: { point: ServicePoint; onClose: () => void }) {
  const session = point.open_session;
  const status = statusOf(point);

  return (
    <Modal title={point.display_name} onClose={onClose}>
      <dl className="op-detail">
        <div>
          <dt>{point.type === "table" ? "Mesa" : "Comanda"}</dt>
          <dd>
            {point.display_name} <span className="muted">({point.code})</span>
          </dd>
        </div>
        <div>
          <dt>Cliente</dt>
          <dd>{session?.customer_name ?? "Não informado"}</dd>
        </div>
        <div>
          <dt>Aberta em</dt>
          <dd>{session ? formatOpenedFull(session.opened_at) : "—"}</dd>
        </div>
        <div>
          <dt>Aberta por</dt>
          <dd>{session?.opened_by_name ?? "—"}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            <span className={`status-badge status-${status}`}>{STATUS_LABEL[status]}</span>
          </dd>
        </div>
      </dl>
      <p className="modal-text muted">Pedidos e produtos serão adicionados na próxima etapa.</p>
      <div className="modal-actions">
        <button className="btn-secondary" type="button" onClick={onClose}>
          Fechar
        </button>
      </div>
    </Modal>
  );
}

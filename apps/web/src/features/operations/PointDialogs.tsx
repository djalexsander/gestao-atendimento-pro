import { useEffect, useRef, useState, type FormEvent } from "react";
import { CustomerPicker } from "../customers/CustomerPicker";
import type { CustomerOption } from "../customers/customersLogic";
import { Modal } from "../employees/Modal";
import type { ServicePoint } from "./panel";

const CUSTOMER_MAX_LENGTH = 80;
// Leitor de código de barras configurado com Enter duplo (ou Enter apertado duas vezes) faria o
// segundo Enter cair no diálogo recém-aberto e abrir o atendimento sem querer: nesse
// intervalo depois de abrir, o envio é ignorado.
const IGNORE_SUBMIT_MS = 600;

// Ponto LIVRE: pede só o cliente (opcional: nome livre OU cliente cadastrado) e abre o atendimento. `onSubmit` devolve a mensagem
// de erro (ou null quando abriu); quem fecha o diálogo em caso de sucesso é o painel.
export function OpenSessionDialog({
  point,
  companyId,
  allowQuickCreate = true,
  onSubmit,
  onClose,
}: {
  point: ServicePoint;
  companyId: string | null;
  allowQuickCreate?: boolean;
  onSubmit: (customer: string | null, customerId: string | null) => Promise<string | null>;
  onClose: () => void;
}) {
  const [customer, setCustomer] = useState("");
  const [selected, setSelected] = useState<CustomerOption | null>(null);
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
    const problem = await onSubmit(customer.trim() || null, selected?.id ?? null);
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
        {companyId ? (
          <CustomerPicker
            companyId={companyId}
            inputId="op-customer"
            label="Cliente (opcional)"
            maxLength={CUSTOMER_MAX_LENGTH}
            text={customer}
            onTextChange={setCustomer}
            selected={selected}
            onSelect={setSelected}
            allowQuickCreate={allowQuickCreate}
          />
        ) : (
          <div className="field">
            <label htmlFor="op-customer">Cliente (opcional)</label>
            <input id="op-customer" type="text" maxLength={CUSTOMER_MAX_LENGTH} autoComplete="off" value={customer} onChange={(e) => setCustomer(e.target.value)} />
          </div>
        )}
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

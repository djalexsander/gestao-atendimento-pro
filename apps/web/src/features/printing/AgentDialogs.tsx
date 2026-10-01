import { useEffect, useRef, useState, type FormEvent } from "react";
import { Modal } from "../employees/Modal";
import {
  formatCountdown,
  formatPairingCode,
  secondsLeft,
  type PairingCode,
  type PrintAgent,
  type PrintDevice,
} from "./printingLogic";

// Confirmação genérica (desvincular, revogar). `onConfirm` devolve a mensagem de erro (ou null).
export function ConfirmDialog({
  title,
  text,
  hint,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  text: string;
  hint?: string;
  confirmLabel: string;
  onConfirm: () => Promise<string | null>;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const failure = await onConfirm();
    setSubmitting(false);
    if (failure) setError(failure);
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <p className="modal-text">{text}</p>
        {hint && <p className="field-hint">{hint}</p>}
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn-secondary" type="button" disabled={submitting} onClick={onClose}>
            Cancelar
          </button>
          <button className="btn-danger" type="submit" disabled={submitting}>
            {submitting ? "Aguarde…" : confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Código de conexão (uso único, 10 min). Gerar outro invalida o anterior no servidor.
export function PairingCodeDialog({
  generate,
  onClose,
}: {
  generate: () => Promise<{ data: PairingCode | null; error: string | null }>;
  onClose: () => void;
}) {
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  // Gera UM código ao abrir (o StrictMode do dev monta o efeito duas vezes e invalidaria o 1º código).
  const started = useRef(false);

  async function load() {
    setLoading(true);
    setError(null);
    const result = await generate();
    setLoading(false);
    if (result.error || !result.data) {
      setPairing(null);
      setError(result.error ?? "Não foi possível gerar o código agora.");
      return;
    }
    setPairing(result.data);
    setNow(Date.now());
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const left = pairing ? secondsLeft(pairing.expires_at, now) : 0;

  return (
    <Modal title="Conectar computador" onClose={onClose}>
      {loading && <p className="modal-text">Gerando código…</p>}
      {error && <div className="form-error">{error}</div>}
      {pairing && !loading && (
        <>
          <p className="field-hint">Código de conexão:</p>
          <p className="pairing-code" aria-live="polite">
            {left > 0 ? formatPairingCode(pairing.code) : "—"}
          </p>
          <p className="modal-text">{left > 0 ? `Expira em: ${formatCountdown(left)}` : "Código expirado. Gere outro."}</p>
          <p className="field-hint">Abra o Agente de Impressão no computador e informe este código.</p>
        </>
      )}
      <div className="modal-actions">
        <button className="btn-secondary" type="button" disabled={loading} onClick={() => void load()}>
          Gerar outro código
        </button>
        <button className="btn-primary btn-auto" type="button" onClick={onClose}>
          Fechar
        </button>
      </div>
    </Modal>
  );
}

// Gerenciar um agente: impressoras vinculadas (desvincular) e revogação.
export function ManageAgentDialog({
  agent,
  devices,
  onUnbind,
  onRevoke,
  onClose,
}: {
  agent: PrintAgent;
  devices: PrintDevice[];
  onUnbind: (device: PrintDevice) => void;
  onRevoke: () => void;
  onClose: () => void;
}) {
  const bound = devices.filter((d) => d.agent_id === agent.id);
  return (
    <Modal title={agent.name} onClose={onClose}>
      <dl className="print-details">
        <dt>Computador</dt>
        <dd>{agent.machine_name ?? "—"}</dd>
      </dl>
      <h4 className="cash-section-title">Impressoras vinculadas</h4>
      {bound.length === 0 ? (
        <p className="field-hint">Nenhuma impressora vinculada a este computador.</p>
      ) : (
        <ul className="print-failures">
          {bound.map((d) => (
            <li key={d.id}>
              <span>
                {d.name} → {d.windows_printer_name ?? "—"}
              </span>
              <button className="btn-secondary btn-small" type="button" onClick={() => onUnbind(d)}>
                Desvincular
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="modal-actions">
        <button className="btn-danger" type="button" onClick={onRevoke}>
          Revogar agente
        </button>
        <button className="btn-secondary" type="button" onClick={onClose}>
          Fechar
        </button>
      </div>
    </Modal>
  );
}

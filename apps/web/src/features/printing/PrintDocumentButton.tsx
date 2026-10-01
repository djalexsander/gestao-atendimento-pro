import { useRef, useState } from "react";
import { usePrintShortcut } from "./printShortcut";

// Botão de documento manual (conta, comprovante, fechamento) + atalho F8 contextual. O botão e o
// teclado chamam a MESMA função (`run`). Enquanto a requisição roda, ambos ficam inertes
// (duplo clique / F8 repetido). O feedback diz "enviado para impressão", nunca "impresso": o job
// fica pending até o Agente de impressão existir.
export function PrintDocumentButton({
  label,
  successMessage,
  request,
  enabled = true,
  allowInDialog = false,
  className = "btn-secondary btn-small",
}: {
  label: string;
  successMessage: string;
  request: () => Promise<{ error: string | null }>;
  enabled?: boolean;
  // O botão está dentro de um modal (ex.: "Conta fechada"): o F8 vale mesmo com ele aberto.
  allowInDialog?: boolean;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const busyRef = useRef(false);

  async function run() {
    if (busyRef.current || !enabled) return;
    busyRef.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      const result = await request();
      setFeedback(result.error ? { kind: "error", text: result.error } : { kind: "ok", text: successMessage });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  usePrintShortcut(
    () => void run(),
    () => ({ enabled, busy: busyRef.current, allowInDialog }),
  );

  return (
    <div className="print-doc">
      <button className={className} type="button" disabled={!enabled || busy} onClick={() => void run()}>
        {busy ? "Enviando…" : label}
        <span className="print-key-hint"> · F8</span>
      </button>
      {feedback && (
        <p role="status" className={feedback.kind === "ok" ? "form-notice" : "form-error"}>
          {feedback.text}
        </p>
      )}
    </div>
  );
}

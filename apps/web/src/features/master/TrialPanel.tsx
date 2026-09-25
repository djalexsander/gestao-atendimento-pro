import { useState } from "react";
import { fmtDateTimeSP } from "../../lib/dates";
import { TRIAL_EVENT_LABEL, TRIAL_STATE_LABEL } from "../../lib/subscriptionLabels";
import type { CompanyTrial } from "../../lib/types";
import { cancelTrial, startTrial } from "./subscriptionApi";

// Período grátis da empresa. Só exibe o que o BANCO decide (estado efetivo em
// tempo real, datas em America/Sao_Paulo, elegibilidade) e dispara as ações
// explícitas de iniciar/cancelar. Contratar um plano pago (que converte o teste)
// é o formulário "Contratar plano" logo abaixo.
export function TrialPanel({ companyId, trial, onChanged }: { companyId: string; trial: CompanyTrial; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  async function run(action: () => Promise<{ error: string | null }>) {
    setError(null);
    setBusy(true);
    const result = await action();
    setBusy(false);
    if (result.error) return setError(result.error);
    onChanged();
  }

  return (
    <div style={{ margin: "16px 0" }}>
      <h4>Período grátis</h4>
      {error && <div className="form-error">{error}</div>}

      {trial.state === "none" && trial.can_start && (
        <>
          <p>
            <strong>{trial.offer_days} dias grátis</strong> — sem fatura e sem cobrança. Depois é só contratar um
            plano pago (formulário abaixo).
          </p>
          <button
            className="btn-secondary"
            type="button"
            disabled={busy}
            onClick={() => run(() => startTrial(companyId))}
          >
            {busy ? "Iniciando…" : `Iniciar ${trial.offer_days} dias grátis`}
          </button>
        </>
      )}

      {trial.state === "none" && !trial.can_start && (
        <p style={{ color: "var(--text-muted)" }}>
          Período grátis indisponível: esta empresa já possui assinatura (ele é só para quem ainda não contratou).
        </p>
      )}

      {trial.state === "trialing" && (
        <>
          <p>
            <strong>{TRIAL_STATE_LABEL.trialing}</strong> · início {fmtDateTimeSP(trial.trial_started_at)} · término{" "}
            {fmtDateTimeSP(trial.trial_ends_at)} ({trial.trial_days} dias)
          </p>
          <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
            Nenhuma fatura é gerada no período grátis. Ao contratar um plano pago, o período grátis termina NA HORA
            (os dias restantes não continuam valendo) e a cobrança inicial é gerada; a assinatura fica aguardando o
            pagamento inicial. O dia de vencimento é o dia da contratação, não o do início ou do fim do teste.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", maxWidth: 460 }}>
            <input
              aria-label="Motivo do cancelamento (opcional)"
              placeholder="Motivo (opcional)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <button
              className="btn-secondary"
              type="button"
              disabled={busy}
              onClick={() => run(() => cancelTrial(companyId, reason.trim() || null))}
            >
              Cancelar período grátis
            </button>
          </div>
        </>
      )}

      {trial.state === "expired" && (
        <p>
          <strong>{TRIAL_STATE_LABEL.expired}</strong> em {fmtDateTimeSP(trial.trial_ends_at)} (início{" "}
          {fmtDateTimeSP(trial.trial_started_at)}). Nenhuma cobrança foi gerada e o período grátis não pode ser
          reiniciado. Contrate um plano pago para continuar.
        </p>
      )}

      {trial.state === "converted" && (
        <p>
          Período grátis usado (início {fmtDateTimeSP(trial.trial_started_at)}, término previsto{" "}
          {fmtDateTimeSP(trial.trial_ends_at)}) e <strong>convertido em plano pago</strong> em{" "}
          {fmtDateTimeSP(trial.converted_at)}.
        </p>
      )}

      {trial.state === "canceled" && (
        <p>
          <strong>{TRIAL_STATE_LABEL.canceled}</strong> em {fmtDateTimeSP(trial.canceled_at)}
          {trial.cancel_reason ? ` — ${trial.cancel_reason}` : ""}. O período grátis não pode ser reiniciado.
        </p>
      )}

      {trial.events.length > 0 && (
        <ul style={{ paddingLeft: 18, fontSize: 13 }}>
          {trial.events.map((e) => (
            <li key={e.id}>
              {TRIAL_EVENT_LABEL[e.event_type] ?? e.event_type} — {fmtDateTimeSP(e.created_at)}
              {e.actor_email ? ` — ${e.actor_email}` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

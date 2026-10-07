import { useState } from "react";
import { formatCents } from "../../lib/money";
import type { CommercialSource, PendingChange } from "./commercialApi";
import { DEFERRED_ADD_NOTE, LOCKED_PENDING_NOTE, REMOVAL_NOTE, fmtFullDate } from "./commercialLogic";

// "Próxima alteração": o que foi agendado (módulos que entram/saem, novo valor e data de início). Owner: Alterar / Cancelar
// alteração (o banco recusa as duas quando a mensalidade desse ciclo já foi gerada). Admin: só leitura.
export function PendingChangeCard({
  companyId,
  source,
  change,
  isOwner,
  onEdit,
  onCanceled,
}: {
  companyId: string;
  source: CommercialSource;
  change: PendingChange;
  isOwner: boolean;
  onEdit: () => void;
  onCanceled: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    setBusy(true);
    setError(null);
    const result = await source.cancelModuleChange(companyId);
    setBusy(false);
    if (result.error !== null) setError(result.error);
    else onCanceled();
  }

  return (
    <section className="overview-card pending-change" aria-label="Próxima alteração">
      <h3>{change.removed.length > 0 && change.added.length === 0 ? "Remoção agendada" : "Próxima alteração"}</h3>
      <dl className="payment-summary">
        <div><dt>Valor atual</dt><dd>{formatCents(change.previous_monthly_cents)}/mês</dd></div>
        <div><dt>Após {fmtFullDate(change.effective_at)}</dt><dd>{formatCents(change.new_monthly_cents)}/mês</dd></div>
      </dl>
      <ul className="pending-lists">
        {change.added.map((m) => <li key={m.module_id} className="pending-added">+ {m.name} — {formatCents(m.price_cents)}/mês</li>)}
        {change.removed.map((m) => <li key={m.module_id} className="pending-removed">− {m.name}</li>)}
      </ul>
      <p className="field-hint">{change.locked ? LOCKED_PENDING_NOTE : change.added.length > 0 ? DEFERRED_ADD_NOTE : REMOVAL_NOTE} Os módulos atuais continuam ativos até lá.</p>
      {error && <div className="form-error">{error}</div>}
      {isOwner && !change.locked && (
        <div className="row-actions">
          <button type="button" className="btn-secondary btn-auto" onClick={onEdit} disabled={busy}>Alterar</button>
          <button type="button" className="btn-secondary btn-auto" onClick={() => void cancel()} disabled={busy}>
            {busy ? "Cancelando…" : "Cancelar alteração"}
          </button>
        </div>
      )}
    </section>
  );
}

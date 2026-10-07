import { useState } from "react";
import { fmtDateOnly } from "../../lib/dates";
import { formatCents } from "../../lib/money";
import type { CommercialSource, PendingModuleAddition } from "./commercialApi";
import { fmtFullDate } from "./commercialLogic";
import { PaymentPanel } from "./PaymentPanel";

// "Alteração de módulos aguardando pagamento": a cobrança proporcional (Pix) foi gerada, mas os módulos ainda estão
// BLOQUEADOS — só são liberados quando o servidor dá baixa na fatura (webhook do Asaas). Owner: paga e pode cancelar a
// solicitação. Admin: só consulta. Nenhum valor é calculado aqui.
export function PendingAdditionCard({
  companyId,
  source,
  addition,
  isOwner,
  onPaid,
  onCanceled,
}: {
  companyId: string;
  source: CommercialSource;
  addition: PendingModuleAddition;
  isOwner: boolean;
  onPaid: () => void;
  onCanceled: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    setBusy(true);
    setError(null);
    const result = await source.cancelModuleAddition(companyId);
    setBusy(false);
    if (result.error !== null) setError(result.error);
    else onCanceled();
  }

  const names = addition.modules.map((m) => m.name).join(", ");
  return (
    <section className="overview-card pending-addition" aria-label="Alteração de módulos aguardando pagamento">
      <h3>Aguardando pagamento</h3>
      <p>
        <strong>{names}</strong> {addition.modules.length > 1 ? "continuam bloqueados" : "continua bloqueado"} até a confirmação do Pix.
        Cobrança proporcional de <strong>{formatCents(addition.amount_cents)}</strong>, vencimento hoje ({fmtDateOnly(addition.due_date)}).
      </p>
      <ul className="pending-lists">
        {addition.modules.map((m) => (
          <li key={m.module_id} className="pending-added">
            + {m.name} — {formatCents(m.prorated_cents)}{" "}
            <span className="field-hint">(até {fmtFullDate(addition.cycle_end)}; {formatCents(m.monthly_price_cents)}/mês)</span>
          </li>
        ))}
      </ul>
      <p className="field-hint">
        Depois do pagamento o módulo é liberado na hora. A partir de {fmtFullDate(addition.cycle_end)} sua mensalidade será{" "}
        {formatCents(addition.new_monthly_cents)}/mês, sem mudar o dia de vencimento.
      </p>
      {error && <div className="form-error">{error}</div>}
      {isOwner && <PaymentPanel key={addition.invoice_id} invoiceId={addition.invoice_id} source={source} onPaid={onPaid} />}
      {isOwner && (
        <div className="row-actions">
          <button type="button" className="btn-secondary btn-auto" onClick={() => void cancel()} disabled={busy}>
            {busy ? "Cancelando…" : "Cancelar solicitação"}
          </button>
        </div>
      )}
    </section>
  );
}

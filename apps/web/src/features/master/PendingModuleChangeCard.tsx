import { useEffect, useState } from "react";
import { fmtDateOnly } from "../../lib/dates";
import { formatCents } from "../../lib/money";
import { getPendingModuleChange, type PendingModuleChange } from "./billingApi";

// Master: alteração de módulos AGENDADA pelo cliente (só leitura; o Master já altera módulos pelas RPCs master_* existentes).
export function PendingModuleChangeCard({ companyId }: { companyId: string }) {
  const [change, setChange] = useState<PendingModuleChange | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getPendingModuleChange(companyId).then((r) => {
      if (cancelled) return;
      if (r.error !== null) setError(r.error);
      else setChange(r.data);
    });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  if (error) return <div className="form-error">{error}</div>;
  if (!change) return null;
  return (
    <section>
      <h3 style={{ fontSize: 18 }}>Alteração de módulos agendada pelo cliente</h3>
      <p>
        Vale a partir de <strong>{fmtDateOnly(change.effective_at)}</strong>: valor atual{" "}
        <strong>{formatCents(change.current_monthly_cents)}</strong> → próximo <strong>{formatCents(change.new_monthly_cents)}</strong>
        {change.locked && " · já faturada (travada)"}
      </p>
      <ul>
        {change.added.map((m) => <li key={m.module_id}>+ {m.name} ({formatCents(m.price_cents)})</li>)}
        {change.removed.map((m) => <li key={m.module_id}>− {m.name}</li>)}
      </ul>
      <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Sem pró-rata. Os módulos atuais seguem ativos até a data de início.</p>
    </section>
  );
}

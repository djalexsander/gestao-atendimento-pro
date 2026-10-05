import { useEffect, useState } from "react";
import { fmtDateOnly, fmtDateTimeSP } from "../../lib/dates";
import { formatCents } from "../../lib/money";
import { STATUS_LABEL } from "../../lib/subscriptionLabels";
import type { CompanyDetail, InvoiceRow } from "../../lib/types";
import { listInvoices } from "./invoiceApi";
import { CompanyStatusBadge, Kpi } from "./MasterBits";

// Resumo no topo do detalhe: assinatura, trial, carência e financeiro (valor mensal contratado, faturas, última/próxima cobrança).
export function CompanySummary({ detail }: { detail: CompanyDetail }) {
  const sub = detail.subscription;
  const [invoices, setInvoices] = useState<InvoiceRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await listInvoices({ companyId: detail.company.id });
      if (!cancelled) setInvoices(r.error ? null : r.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [detail.company.id]);

  const monthly = sub ? sub.plan.price_cents_snapshot + sub.extra_modules.reduce((a, e) => a + e.price_cents_snapshot, 0) : null;
  const pending = (invoices ?? []).filter((i) => i.status === "open" || i.status === "overdue");
  const next = pending.map((i) => i.due_date).sort()[0] ?? null;
  const last = [...(invoices ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const trial = detail.trial;

  return (
    <>
      <dl className="mst-kpis">
        <Kpi label="Assinatura" value={<CompanyStatusBadge status={sub?.status ?? null} trialState={trial.state} trialEndsAt={trial.trial_ends_at} />} />
        <Kpi strong label="Valor mensal total" value={monthly === null ? "—" : formatCents(monthly)} hint={sub ? `Plano ${sub.plan.name} + ${sub.extra_modules.length} módulo(s)` : "sem assinatura paga"} />
        <Kpi label="Próximo vencimento" value={fmtDateOnly(next)} hint={pending.length ? `${pending.length} fatura(s) em aberto` : undefined} />
        <Kpi label="Faturas" value={invoices === null ? "…" : invoices.length} hint={last ? `última: ${fmtDateOnly(last.due_date)} (${formatCents(last.amount_cents)})` : undefined} />
      </dl>
      <section className="mst-card">
        <h3>Assinatura e bloqueio</h3>
        <dl className="mst-dl">
          <dt>Plano</dt>
          <dd>{sub ? sub.plan.name : "—"}</dd>
          <dt>Status</dt>
          <dd>{sub ? STATUS_LABEL[sub.status] : "Sem assinatura paga"}</dd>
          <dt>Início da assinatura</dt>
          <dd>{sub ? fmtDateTimeSP(sub.started_at) : "—"}</dd>
          <dt>Fim do trial</dt>
          <dd>{trial.trial_ends_at ? fmtDateTimeSP(trial.trial_ends_at) : "—"}</dd>
          <dt>Dia âncora</dt>
          <dd>{sub ? `todo dia ${sub.billing_day}` : "—"}</dd>
          <dt>Carência / bloqueio</dt>
          <dd>{sub?.grace_until ? `Carência até ${fmtDateOnly(sub.grace_until)}` : sub && ["restricted", "suspended"].includes(sub.status) ? STATUS_LABEL[sub.status] : "—"}</dd>
        </dl>
      </section>
    </>
  );
}

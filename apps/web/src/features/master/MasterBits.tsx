import type { ReactNode } from "react";
import { fmtDateTimeSP } from "../../lib/dates";
import { INVOICE_STATUS_LABEL, STATUS_LABEL, TRIAL_STATE_LABEL } from "../../lib/subscriptionLabels";
import type { InvoiceStatus, SubscriptionStatus, TrialState } from "../../lib/types";

type Tone = "ok" | "warn" | "bad" | "muted";

const SUB_TONE: Record<SubscriptionStatus, Tone> = {
  active: "ok",
  trialing: "warn",
  pending_payment: "warn",
  grace: "warn",
  past_due: "bad",
  restricted: "bad",
  suspended: "bad",
  canceled: "muted",
};
const INV_TONE: Record<InvoiceStatus, Tone> = { paid: "ok", open: "warn", overdue: "bad", void: "muted" };

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`mst-badge mst-badge-${tone}`}>{children}</span>;
}

// Assinatura vigente manda; sem ela, mostra o período grátis quando ele é a situação atual.
export function CompanyStatusBadge({ status, trialState, trialEndsAt }: { status: SubscriptionStatus | null; trialState: TrialState | null; trialEndsAt: string | null }) {
  if (status) return <Badge tone={SUB_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
  if (trialState === "trialing") return <Badge tone="warn">{`${TRIAL_STATE_LABEL.trialing} (até ${fmtDateTimeSP(trialEndsAt)})`}</Badge>;
  if (trialState === "expired" || trialState === "canceled") return <Badge tone="bad">{TRIAL_STATE_LABEL[trialState]}</Badge>;
  return <Badge tone="muted">Sem assinatura</Badge>;
}

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  return <Badge tone={INV_TONE[status]}>{INVOICE_STATUS_LABEL[status]}</Badge>;
}

export function Kpi({ label, value, hint, strong }: { label: string; value: ReactNode; hint?: string; strong?: boolean }) {
  return (
    <div className={`mst-kpi${strong ? " mst-kpi-strong" : ""}`}>
      <dt>{label}</dt>
      <dd>
        {value}
        {hint && <small>{hint}</small>}
      </dd>
    </div>
  );
}

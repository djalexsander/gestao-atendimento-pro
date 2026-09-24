import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getInvoice, markInvoicePaid, voidInvoice } from "../features/master/invoiceApi";
import { fmtCompetence, fmtDateOnly } from "../lib/dates";
import { formatCents } from "../lib/money";
import { INVOICE_EVENT_LABEL, INVOICE_STATUS_LABEL, STATUS_LABEL } from "../lib/subscriptionLabels";
import type { InvoiceDetail } from "../lib/types";

const cell = { padding: "8px 4px" } as const;
const KIND_LABEL: Record<string, string> = { plan: "Plano", module: "Módulo", adjustment: "Ajuste" };

export function MasterInvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [paidAt, setPaidAt] = useState("");
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      const result = await getInvoice(id);
      if (cancelled) return;
      setDetail(result.data);
      setError(result.error);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [id, reloadKey]);

  async function run(action: () => Promise<{ error: string | null }>) {
    setActionError(null);
    setBusy(true);
    const result = await action();
    setBusy(false);
    if (result.error) return setActionError(result.error);
    setVoiding(false);
    setReason("");
    setPaidAt("");
    setReloadKey((k) => k + 1);
  }

  if (loading) return <p>Carregando fatura…</p>;
  if (error || !detail) return <div className="form-error">{error ?? "Fatura não encontrada."}</div>;

  const { invoice, company, subscription, items, events } = detail;
  const canAct = invoice.status === "open" || invoice.status === "overdue";
  const planItem = items.find((i) => i.kind === "plan");

  return (
    <div>
      <p>
        <Link to="/master/faturas">← Faturas</Link>
      </p>
      <h2>
        Fatura {fmtCompetence(invoice.competence)} — {company.name}
      </h2>

      <p>
        <strong>{INVOICE_STATUS_LABEL[invoice.status]}</strong> · Vencimento{" "}
        <strong>{fmtDateOnly(invoice.due_date)}</strong>
        {invoice.paid_at && ` · Paga em ${new Date(invoice.paid_at).toLocaleString("pt-BR")}`}
      </p>
      <p style={{ color: "var(--text-muted)" }}>
        Empresa: <Link to={`/master/empresas/${company.id}`}>{company.name}</Link>
        {planItem && ` · ${planItem.description} (na geração)`}
        {subscription &&
          ` · Assinatura hoje: ${STATUS_LABEL[subscription.status]}, vence dia ${subscription.billing_day}`}
      </p>
      <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
        Valores e vencimento são um retrato do momento da geração; mudanças posteriores na assinatura ou no
        catálogo não alteram esta fatura.
      </p>

      <h3 style={{ fontSize: 18 }}>Itens</h3>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
            <th style={cell}>Tipo</th>
            <th style={cell}>Descrição</th>
            <th style={{ ...cell, textAlign: "right" }}>Valor</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id} style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={cell}>{KIND_LABEL[i.kind] ?? i.kind}</td>
              <td style={cell}>{i.description}</td>
              <td style={{ ...cell, textAlign: "right" }}>{formatCents(i.amount_cents)}</td>
            </tr>
          ))}
          <tr>
            <td style={cell} colSpan={2}>
              <strong>Total</strong>
            </td>
            <td style={{ ...cell, textAlign: "right" }}>
              <strong>{formatCents(invoice.amount_cents)}</strong>
            </td>
          </tr>
        </tbody>
      </table>

      {actionError && (
        <div className="form-error" style={{ marginTop: 16 }}>
          {actionError}
        </div>
      )}
      {canAct && (
        <div style={{ display: "grid", gap: 16, maxWidth: 460, marginTop: 24 }}>
          <div>
            <label htmlFor="paid-at">Data/hora do pagamento (vazio = agora)</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input id="paid-at" type="datetime-local" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
              <button
                className="btn-primary"
                style={{ width: "auto" }}
                type="button"
                disabled={busy}
                onClick={() =>
                  run(() => markInvoicePaid(invoice.id, paidAt ? new Date(paidAt).toISOString() : null))
                }
              >
                Marcar como paga
              </button>
            </div>
          </div>

          <div>
            {!voiding ? (
              <button className="btn-secondary" type="button" disabled={busy} onClick={() => setVoiding(true)}>
                Anular fatura…
              </button>
            ) : (
              <div>
                <label htmlFor="void-reason">Motivo da anulação (opcional)</label>
                <input id="void-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
                  A fatura anulada é mantida no histórico e continua ocupando a competência.
                </p>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="btn-secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => run(() => voidInvoice(invoice.id, reason.trim() || null))}
                  >
                    Confirmar anulação
                  </button>
                  <button className="btn-secondary" type="button" onClick={() => setVoiding(false)}>
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {!canAct && (
        <p style={{ color: "var(--text-muted)", marginTop: 16 }}>
          Fatura {INVOICE_STATUS_LABEL[invoice.status].toLowerCase()}: definitiva, sem novas alterações.
        </p>
      )}

      <h3 style={{ fontSize: 18, marginTop: 24 }}>Histórico da fatura</h3>
      <ul style={{ paddingLeft: 18 }}>
        {events.map((e) => (
          <li key={e.id} style={{ marginBottom: 4 }}>
            <strong>{INVOICE_EVENT_LABEL[e.event_type] ?? e.event_type}</strong> —{" "}
            {new Date(e.created_at).toLocaleString("pt-BR")}
            {e.actor_email && ` — ${e.actor_email}`}
            <br />
            <code style={{ fontSize: 12 }}>{JSON.stringify(e.payload)}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

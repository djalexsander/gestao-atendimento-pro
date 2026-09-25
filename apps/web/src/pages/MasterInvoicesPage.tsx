import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listInvoices } from "../features/master/invoiceApi";
import { fmtCompetence, fmtDateOnly, monthToCompetence } from "../lib/dates";
import { formatCents } from "../lib/money";
import { INVOICE_KIND_LABEL, INVOICE_STATUS_LABEL } from "../lib/subscriptionLabels";
import type { InvoiceRow, InvoiceStatus } from "../lib/types";

const cell = { padding: "8px 4px" } as const;
const STATUSES = Object.keys(INVOICE_STATUS_LABEL) as InvoiceStatus[];

export function MasterInvoicesPage() {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<InvoiceStatus | "">("");
  const [month, setMonth] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await listInvoices({ status, competence: monthToCompetence(month) });
      if (cancelled) return;
      setInvoices(result.data);
      setError(result.error);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [status, month]);

  return (
    <div>
      <h2>Faturas</h2>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <div>
          <label htmlFor="inv-status">Status</label>
          <select id="inv-status" value={status} onChange={(e) => setStatus(e.target.value as InvoiceStatus | "")}>
            <option value="">Todos</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {INVOICE_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="inv-month">Competência</label>
          <input id="inv-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
      </div>

      {error && <div className="form-error">{error}</div>}
      {loading ? (
        <p>Carregando faturas…</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
              <th style={cell}>Empresa</th>
              <th style={cell}>Tipo</th>
              <th style={cell}>Competência</th>
              <th style={cell}>Vencimento</th>
              <th style={cell}>Valor</th>
              <th style={cell}>Status</th>
              <th style={cell}>Atraso</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((i) => (
              <tr key={i.id} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={cell}>
                  <Link to={`/master/faturas/${i.id}`}>{i.company_name}</Link>
                </td>
                <td style={cell}>{INVOICE_KIND_LABEL[i.kind]}</td>
                <td style={cell}>{fmtCompetence(i.competence)}</td>
                <td style={cell}>{fmtDateOnly(i.due_date)}</td>
                <td style={cell}>{formatCents(i.amount_cents)}</td>
                <td style={cell}>{INVOICE_STATUS_LABEL[i.status]}</td>
                <td style={cell}>{i.days_overdue ? `${i.days_overdue} dia(s)` : "—"}</td>
              </tr>
            ))}
            {invoices.length === 0 && (
              <tr>
                <td style={cell} colSpan={7}>
                  Nenhuma fatura encontrada. As faturas são geradas manualmente na página da empresa.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

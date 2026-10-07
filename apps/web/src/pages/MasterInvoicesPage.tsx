import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CHARGE_STATUS_LABEL, listInvoiceGateway, type InvoiceGatewayRow } from "../features/master/billingApi";
import { InvoiceStatusBadge, Kpi } from "../features/master/MasterBits";
import { listInvoices } from "../features/master/invoiceApi";
import { filterInvoices } from "../features/master/masterLogic";
import { fmtCompetence, fmtDateOnly, fmtDateTimeSP, monthToCompetence } from "../lib/dates";
import { formatCents } from "../lib/money";
import { INVOICE_KIND_LABEL, INVOICE_STATUS_LABEL } from "../lib/subscriptionLabels";
import type { InvoiceRow, InvoiceStatus } from "../lib/types";

const STATUSES = Object.keys(INVOICE_STATUS_LABEL) as InvoiceStatus[];

export function MasterInvoicesPage() {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<InvoiceStatus | "">("");
  const [month, setMonth] = useState("");
  const [company, setCompany] = useState("");
  const [dueFrom, setDueFrom] = useState("");
  const [dueTo, setDueTo] = useState("");
  const [gateway, setGateway] = useState<Record<string, InvoiceGatewayRow>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await listInvoices({ status, competence: monthToCompetence(month) });
      const gw = await listInvoiceGateway();
      if (cancelled) return;
      setGateway(Object.fromEntries((gw.data ?? []).map((g) => [g.invoice_id, g])));
      setInvoices(result.data);
      setError(result.error);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [status, month]);

  const rows = useMemo(() => filterInvoices(invoices, { company, dueFrom, dueTo }), [invoices, company, dueFrom, dueTo]);
  const openCents = rows.filter((i) => i.status === "open" || i.status === "overdue").reduce((a, i) => a + i.amount_cents, 0);
  const overdueCount = rows.filter((i) => i.days_overdue).length;
  const paidCents = rows.filter((i) => i.status === "paid").reduce((a, i) => a + i.amount_cents, 0);

  return (
    <div>
      <div className="mst-head">
        <h2>Faturas</h2>
      </div>
      <p className="mst-sub">As faturas são geradas no ciclo de cobrança ou manualmente na página da empresa; a baixa é manual. Abra uma fatura para ver itens, histórico e dar baixa.</p>

      <div className="mst-toolbar">
        <div>
          <label htmlFor="inv-company">Empresa</label>
          <input id="inv-company" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Nome da empresa" />
        </div>
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
        <div>
          <label htmlFor="inv-from">Vencimento de</label>
          <input id="inv-from" type="date" value={dueFrom} onChange={(e) => setDueFrom(e.target.value)} />
        </div>
        <div>
          <label htmlFor="inv-to">até</label>
          <input id="inv-to" type="date" value={dueTo} onChange={(e) => setDueTo(e.target.value)} />
        </div>
      </div>

      <dl className="mst-kpis">
        <Kpi label="Faturas listadas" value={rows.length} />
        <Kpi label="A receber (aberto + vencido)" value={formatCents(openCents)} />
        <Kpi label="Com atraso" value={overdueCount} />
        <Kpi label="Pagas (listadas)" value={formatCents(paidCents)} />
      </dl>

      {error && <div className="form-error">{error}</div>}
      {loading ? (
        <p>Carregando faturas…</p>
      ) : (
        <div className="mst-scroll">
          <table className="mst-table">
            <thead>
              <tr>
                <th>Empresa</th>
                <th>Tipo</th>
                <th>Competência</th>
                <th>Vencimento</th>
                <th className="mst-num">Valor</th>
                <th>Status</th>
                <th className="mst-num">Dias de atraso</th>
                <th>Pagamento</th>
                <th>Cobrança (gateway)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id}>
                  <td>
                    <Link to={`/master/faturas/${i.id}`}>{i.company_name}</Link>
                  </td>
                  <td>{INVOICE_KIND_LABEL[i.kind]}</td>
                  <td>{fmtCompetence(i.competence)}</td>
                  <td>{fmtDateOnly(i.due_date)}</td>
                  <td className="mst-num">{formatCents(i.amount_cents)}</td>
                  <td>
                    <InvoiceStatusBadge status={i.status} />
                  </td>
                  <td className="mst-num">{i.days_overdue ? i.days_overdue : "—"}</td>
                  <td>{i.paid_at ? fmtDateTimeSP(i.paid_at) : "—"}</td>
                  <td>
                    {gateway[i.id]?.gateway ? `Asaas · ${CHARGE_STATUS_LABEL[gateway[i.id].charge_status ?? ""] ?? gateway[i.id].charge_status}` : "—"}
                    {gateway[i.id]?.open_anomalies ? ` · ⚠ ${gateway[i.id].open_anomalies} anomalia(s)` : ""}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9}>Nenhuma fatura encontrada para os filtros.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { currentMonthValue, fmtCompetence, fmtDateOnly, monthToCompetence } from "../../lib/dates";
import { formatCents } from "../../lib/money";
import { INVOICE_KIND_LABEL, INVOICE_STATUS_LABEL } from "../../lib/subscriptionLabels";
import type { InvoiceRow } from "../../lib/types";
import { generateInvoice, listInvoices } from "./invoiceApi";

const cell = { padding: "6px 4px" } as const;

// Faturas de UMA empresa + geração manual por competência. O total e os itens
// são calculados no banco a partir da assinatura; aqui só se escolhe o mês.
export function CompanyInvoices({
  companyId,
  subscriptionId,
}: {
  companyId: string;
  subscriptionId: string | null;
}) {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [month, setMonth] = useState(currentMonthValue());
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await listInvoices({ companyId });
      if (cancelled) return;
      setInvoices(result.data);
      setError(result.error);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, reloadKey]);

  async function generate() {
    const competence = monthToCompetence(month);
    if (!subscriptionId || !competence) {
      setError("Selecione uma competência (mês) válida.");
      return;
    }
    setError(null);
    setNotice(null);
    setBusy(true);
    const result = await generateInvoice(subscriptionId, competence);
    setBusy(false);
    if (result.error || !result.data) return setError(result.error ?? "Falha ao gerar a fatura.");
    setNotice(
      result.data.created
        ? `Fatura de ${fmtCompetence(competence)} gerada.`
        : `A fatura de ${fmtCompetence(competence)} já existia (nada foi duplicado).`,
    );
    setReloadKey((k) => k + 1);
  }

  return (
    <div>
      <h3 style={{ fontSize: 18, marginTop: 24 }}>Faturas</h3>
      <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
        A fatura é um retrato imutável: depois de gerada (mesmo adiantada), trocas de plano, módulos ou dia de
        vencimento não a alteram. Uma competência ainda não gerada usa o contrato que valia nela.
      </p>
      {error && <div className="form-error">{error}</div>}
      {notice && <p style={{ color: "var(--text-muted)" }}>{notice}</p>}

      {subscriptionId ? (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 12 }}>
          <div>
            <label htmlFor="gen-month">Competência</label>
            <input id="gen-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </div>
          <button className="btn-secondary" type="button" disabled={busy} onClick={generate}>
            {busy ? "Gerando…" : "Gerar fatura"}
          </button>
        </div>
      ) : (
        <p style={{ color: "var(--text-muted)" }}>
          Sem assinatura vigente: não é possível gerar novas faturas por aqui.
        </p>
      )}

      {loading ? (
        <p>Carregando faturas…</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
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
                <td style={cell}>{INVOICE_KIND_LABEL[i.kind]}</td>
                <td style={cell}>
                  <Link to={`/master/faturas/${i.id}`}>{fmtCompetence(i.competence)}</Link>
                </td>
                <td style={cell}>{fmtDateOnly(i.due_date)}</td>
                <td style={cell}>{formatCents(i.amount_cents)}</td>
                <td style={cell}>{INVOICE_STATUS_LABEL[i.status]}</td>
                <td style={cell}>{i.days_overdue ? `${i.days_overdue} dia(s)` : "—"}</td>
              </tr>
            ))}
            {invoices.length === 0 && (
              <tr>
                <td style={cell} colSpan={6}>
                  Nenhuma fatura gerada para esta empresa.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

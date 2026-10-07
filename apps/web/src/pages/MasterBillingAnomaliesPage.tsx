import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "../features/master/MasterBits";
import { ANOMALY_KIND_LABEL, listBillingAnomalies, resolveBillingAnomaly, type BillingAnomaly } from "../features/master/billingApi";
import { fmtDateTimeSP } from "../lib/dates";

// Anomalias de cobrança: o que o webhook/worker NÃO pôde resolver sozinho (valor divergente, pagamento duplicado, estorno...).
// Aqui só se LÊ e se marca como conferida, com observação. Nada financeiro é automático.
function reasonOf(a: BillingAnomaly): string {
  const d = a.detail ?? {};
  const bits: string[] = [];
  if (typeof d.why === "string") bits.push(d.why.replace(/_/g, " "));
  if (typeof d.event === "string") bits.push(d.event);
  if (typeof d.asaas_status === "string") bits.push(`status ${d.asaas_status}`);
  if (typeof d.value_cents === "number" && typeof d.charge_amount_cents === "number") bits.push(`recebido ${d.value_cents} x esperado ${d.charge_amount_cents} (centavos)`);
  if (typeof d.error === "string") bits.push(d.error);
  return bits.join(" · ") || "—";
}

export function MasterBillingAnomaliesPage() {
  const [rows, setRows] = useState<BillingAnomaly[]>([]);
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await listBillingAnomalies(onlyOpen);
    setRows(result.data ?? []);
    setError(result.error);
    setLoading(false);
  }, [onlyOpen]);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(id: string) {
    setBusy(true);
    const { error: err } = await resolveBillingAnomaly(id, note);
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setResolving(null);
    setNote("");
    await load();
  }

  return (
    <div>
      <div className="mst-head"><h2>Anomalias de cobrança</h2></div>
      <p className="mst-sub">
        Divergências que a integração com o gateway não resolve sozinha. Confira no extrato do Asaas e marque como resolvida com uma
        observação; nada financeiro é alterado automaticamente.
      </p>
      <div className="mst-toolbar">
        <label className="checkbox-row">
          <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> Só pendentes
        </label>
      </div>
      {error && <div className="form-error">{error}</div>}
      {loading ? <p>Carregando…</p> : (
        <div className="mst-scroll">
          <table className="mst-table">
            <thead>
              <tr><th>Tipo</th><th>Empresa</th><th>Fatura</th><th>Data</th><th>Motivo</th><th>Situação</th></tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td>{ANOMALY_KIND_LABEL[a.kind] ?? a.kind}</td>
                  <td>{a.company_id ? <Link to={`/master/empresas/${a.company_id}`}>{a.company_name ?? "Empresa"}</Link> : "—"}</td>
                  <td>{a.invoice_id ? <Link to={`/master/faturas/${a.invoice_id}`}>Abrir fatura</Link> : "—"}</td>
                  <td>{fmtDateTimeSP(a.created_at)}</td>
                  <td>{reasonOf(a)}</td>
                  <td>
                    {a.resolved_at ? (
                      <span><Badge tone="ok">Resolvida</Badge> <small>{a.resolution_note}</small></span>
                    ) : resolving === a.id ? (
                      <div>
                        <input aria-label="Observação da resolução" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Observação (obrigatória)" />
                        <div className="row-actions">
                          <button type="button" className="btn-primary btn-small btn-auto" disabled={busy || !note.trim()} onClick={() => void resolve(a.id)}>Marcar resolvida</button>
                          <button type="button" className="btn-secondary btn-small" onClick={() => { setResolving(null); setNote(""); }}>Cancelar</button>
                        </div>
                      </div>
                    ) : (
                      <span><Badge tone="warn">Pendente</Badge>{" "}
                        <button type="button" className="btn-secondary btn-small" onClick={() => setResolving(a.id)}>Resolver</button></span>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6}>Nenhuma anomalia {onlyOpen ? "pendente" : "registrada"}.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

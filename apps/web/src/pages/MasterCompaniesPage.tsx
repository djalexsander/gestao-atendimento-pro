import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchMasterCompanies } from "../features/master/api";
import { STATUS_LABEL } from "../lib/subscriptionLabels";
import type { MasterCompanyRow } from "../lib/types";

export function MasterCompaniesPage() {
  const [companies, setCompanies] = useState<MasterCompanyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await fetchMasterCompanies();
      if (cancelled) return;
      setCompanies(result.data);
      setError(result.error);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <p>Carregando empresas…</p>;
  if (error) return <div className="form-error">{error}</div>;

  return (
    <div>
      <h2>Empresas</h2>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
            <th style={{ padding: "8px 4px" }}>Nome</th>
            <th style={{ padding: "8px 4px" }}>Documento</th>
            <th style={{ padding: "8px 4px" }}>Membros</th>
            <th style={{ padding: "8px 4px" }}>Plano</th>
            <th style={{ padding: "8px 4px" }}>Assinatura</th>
          </tr>
        </thead>
        <tbody>
          {companies.map((c) => (
            <tr key={c.id} style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: "8px 4px" }}>
                <Link to={`/master/empresas/${c.id}`}>{c.name}</Link>
              </td>
              <td style={{ padding: "8px 4px" }}>{c.document ?? "—"}</td>
              <td style={{ padding: "8px 4px" }}>{c.memberCount}</td>
              <td style={{ padding: "8px 4px" }}>{c.planName ?? "—"}</td>
              <td style={{ padding: "8px 4px" }}>
                {c.subscriptionStatus ? STATUS_LABEL[c.subscriptionStatus] : "Sem assinatura"}
              </td>
            </tr>
          ))}
          {companies.length === 0 && (
            <tr>
              <td style={{ padding: "8px 4px" }} colSpan={5}>
                Nenhuma empresa cadastrada ainda.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

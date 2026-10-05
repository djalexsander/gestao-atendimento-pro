import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { listCompaniesSummary, type CompanySummaryRow } from "../features/master/commercialApi";
import { CompanyStatusBadge } from "../features/master/MasterBits";
import { filterCompanies, fmtDocument } from "../features/master/masterLogic";
import { fmtDateOnly } from "../lib/dates";
import { formatCents } from "../lib/money";

export function MasterCompaniesPage() {
  const [companies, setCompanies] = useState<CompanySummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await listCompaniesSummary();
      if (cancelled) return;
      setCompanies(result.data);
      setError(result.error);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(() => filterCompanies(companies, search), [companies, search]);

  if (loading) return <p>Carregando empresas…</p>;
  if (error) return <div className="form-error">{error}</div>;

  return (
    <div>
      <div className="mst-head">
        <h2>Empresas</h2>
      </div>
      <p className="mst-sub">Gerencie cadastro, assinatura e módulos de cada empresa. Empresas não são excluídas por aqui.</p>
      <div className="mst-toolbar">
        <div>
          <label htmlFor="mst-search">Buscar por nome ou documento</label>
          <input id="mst-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nome ou CPF/CNPJ" />
        </div>
      </div>
      <div className="mst-scroll">
        <table className="mst-table">
          <thead>
            <tr>
              <th>Empresa</th>
              <th>Documento</th>
              <th>Plano</th>
              <th>Assinatura</th>
              <th>Vencimento</th>
              <th>Módulos</th>
              <th className="mst-num">Mensal</th>
              <th className="mst-num">Usuários</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link to={`/master/empresas/${c.id}`}>{c.name}</Link>
                </td>
                <td>{fmtDocument(c.document)}</td>
                <td>{c.planName ?? "—"}</td>
                <td>
                  <CompanyStatusBadge status={c.subscriptionStatus} trialState={c.trialState} trialEndsAt={c.trialEndsAt} />
                </td>
                <td>{fmtDateOnly(c.nextDueDate)}</td>
                <td>{c.activeModuleNames.length ? c.activeModuleNames.join(", ") : "—"}</td>
                <td className="mst-num">{c.monthlyTotalCents === null ? "—" : formatCents(c.monthlyTotalCents)}</td>
                <td className="mst-num">{c.memberCount}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8}>{companies.length === 0 ? "Nenhuma empresa cadastrada ainda." : "Nenhuma empresa encontrada para a busca."}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

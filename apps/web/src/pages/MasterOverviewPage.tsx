import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getCommercialOverview, listCompaniesSummary, type CommercialOverview, type CompanySummaryRow } from "../features/master/commercialApi";
import { CompanyStatusBadge, Kpi } from "../features/master/MasterBits";
import { fmtDocument } from "../features/master/masterLogic";
import { fmtDateOnly } from "../lib/dates";
import { formatCents } from "../lib/money";

export function MasterOverviewPage() {
  const navigate = useNavigate();
  const [overview, setOverview] = useState<CommercialOverview | null>(null);
  const [companies, setCompanies] = useState<CompanySummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [o, c] = await Promise.all([getCommercialOverview(), listCompaniesSummary()]);
      if (cancelled) return;
      setOverview(o.data);
      setCompanies(c.data);
      setError(o.error ?? c.error);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <p>Carregando painel master…</p>;
  if (error || !overview) return <div className="form-error">{error ?? "Não foi possível carregar o painel."}</div>;

  return (
    <div>
      <div className="mst-head">
        <h2>Visão geral</h2>
      </div>
      <p className="mst-sub">Situação comercial de todas as empresas da plataforma.</p>

      <dl className="mst-kpis">
        <Kpi label="Total de empresas" value={overview.totalCompanies} />
        <Kpi label="Em trial" value={overview.trialingCompanies} hint="período grátis vigente" />
        <Kpi label="Assinaturas ativas" value={overview.activeSubscriptions} />
        <Kpi label="Bloqueadas / inadimplentes" value={overview.blockedSubscriptions} hint="atraso, carência, restrita, suspensa ou aguardando pagamento" />
        <Kpi label="Total de usuários" value={overview.totalUsers} />
        <Kpi strong label="MRR estimado" value={formatCents(overview.mrrCents)} hint="só assinaturas ativas pagas (sem trial)" />
      </dl>

      <h3 style={{ fontSize: 18, margin: "0 0 8px" }}>Empresas</h3>
      <div className="mst-scroll">
        <table className="mst-table">
          <thead>
            <tr>
              <th>Empresa</th>
              <th>Documento</th>
              <th>Plano</th>
              <th>Assinatura</th>
              <th>Vencimento</th>
              <th>Módulos ativos</th>
              <th className="mst-num">Usuários</th>
            </tr>
          </thead>
          <tbody>
            {companies.map((c) => (
              <tr key={c.id} onClick={() => navigate(`/master/empresas/${c.id}`)} style={{ cursor: "pointer" }}>
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
                <td className="mst-num">{c.memberCount}</td>
              </tr>
            ))}
            {companies.length === 0 && (
              <tr>
                <td colSpan={7}>Nenhuma empresa cadastrada ainda.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

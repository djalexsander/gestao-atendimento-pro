import { useEffect, useState } from "react";
import { fetchMasterCompanies, fetchMasterOverview } from "../features/master/api";
import type { MasterCompanyRow, MasterOverview } from "../lib/types";

export function MasterOverviewPage() {
  const [overview, setOverview] = useState<MasterOverview | null>(null);
  const [companies, setCompanies] = useState<MasterCompanyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [overviewResult, companiesResult] = await Promise.all([
        fetchMasterOverview(),
        fetchMasterCompanies(),
      ]);
      if (cancelled) return;
      setOverview(overviewResult.data);
      setCompanies(companiesResult.data);
      setError(overviewResult.error ?? companiesResult.error ?? null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <p>Carregando painel master…</p>;
  if (error) return <div className="form-error">{error}</div>;

  return (
    <div>
      <h2>Visão geral</h2>

      <div style={{ display: "flex", gap: 16, marginBottom: 32, flexWrap: "wrap" }}>
        <StatCard label="Total de empresas" value={overview?.totalCompanies ?? 0} />
        <StatCard label="Total de usuários" value={overview?.totalUsers ?? 0} />
        <StatCard label="Empresas ativas" value={overview?.activeCompanies ?? 0} />
      </div>

      <h3 style={{ fontSize: 18 }}>Empresas</h3>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
            <th style={{ padding: "8px 4px" }}>Nome</th>
            <th style={{ padding: "8px 4px" }}>Documento</th>
            <th style={{ padding: "8px 4px" }}>Criada em</th>
            <th style={{ padding: "8px 4px" }}>Membros</th>
          </tr>
        </thead>
        <tbody>
          {companies.map((c) => (
            <tr key={c.id} style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: "8px 4px" }}>{c.name}</td>
              <td style={{ padding: "8px 4px" }}>{c.document ?? "—"}</td>
              <td style={{ padding: "8px 4px" }}>
                {new Date(c.createdAt).toLocaleDateString("pt-BR")}
              </td>
              <td style={{ padding: "8px 4px" }}>{c.memberCount}</td>
            </tr>
          ))}
          {companies.length === 0 && (
            <tr>
              <td style={{ padding: "8px 4px" }} colSpan={4}>
                Nenhuma empresa cadastrada ainda.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "16px 20px",
        minWidth: 160,
        background: "var(--surface)",
      }}
    >
      <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: "var(--text-h)" }}>{value}</div>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { listCompaniesSummary, type CompanySummaryRow } from "../features/master/commercialApi";
import { listModules, listPlans } from "../features/master/catalogApi";
import { CourtesyAttentionPanel, CourtesyCompanyFlag } from "../features/master/CourtesyAttentionPanel";
import { listActiveBridges, listCourtesyAttention } from "../features/master/courtesyApi";
import { accessStateLabel, activeBridgeByCompany, summarizeByCompany, type AccessLabelContext, type CompanyFlags } from "../features/master/courtesyLogic";
import type { CatalogModule, CatalogPlan } from "../lib/types";
import { ACCESS_STATE_TEXT, listCompanyAccessStates } from "../features/master/billingApi";
import { Badge, CompanyStatusBadge } from "../features/master/MasterBits";
import { filterCompanies, fmtDocument } from "../features/master/masterLogic";
import { fmtDateOnly, fmtDateTimeSP } from "../lib/dates";
import { formatCents } from "../lib/money";

export function MasterCompaniesPage() {
  const [companies, setCompanies] = useState<CompanySummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [access, setAccess] = useState<Record<string, { state: string; blocked: boolean }>>({});
  const [plans, setPlans] = useState<CatalogPlan[]>([]);
  const [modules, setModules] = useState<CatalogModule[]>([]);
  const [flags, setFlags] = useState<Record<string, CompanyFlags>>({});
  // pontes 2C ativas por empresa; null = consulta indisponível (RPC ausente/erro): o rótulo fica neutro, sem afirmar ponte nem cortesia preservada
  const [preservedIds, setPreservedIds] = useState<Set<string>>(new Set());
  const [bridgeIndex, setBridgeIndex] = useState<Record<string, NonNullable<AccessLabelContext["bridge"]>> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await listCompaniesSummary();
      const states = await listCompanyAccessStates();
      const [p, m] = await Promise.all([listPlans(), listModules()]);
      // selo por empresa: as 100 mais urgentes (a lista completa e paginada fica no painel de cortesias); indisponível = sem selo
      const attention = await listCourtesyAttention("all", 7, 100, 0);
      const bridgeList = attention.status === "ok" ? await listActiveBridges() : null;
      // F1: lista própria (a lista "tudo" é limitada às 100 mais urgentes); indisponível/erro = sem o dado explícito (o rótulo cai no fallback)
      const preservedList = attention.status === "ok" ? await listCourtesyAttention("preserved_pending_payment", 7, 100, 0) : null;
      if (cancelled) return;
      setBridgeIndex(bridgeList && bridgeList.status === "ok" ? activeBridgeByCompany(bridgeList.data) : null);
      setPlans(p.data);
      setModules(m.data);
      const preservedItems = preservedList && preservedList.status === "ok" ? preservedList.data.items : [];
      setPreservedIds(new Set(preservedItems.map((i) => i.company_id)));
      setFlags(attention.status === "ok" ? summarizeByCompany([...attention.data.items.filter((i) => i.kind !== "preserved_pending_payment"), ...preservedItems]) : {});
      setAccess(Object.fromEntries((states.data ?? []).map((s) => [s.company_id, { state: s.access_state, blocked: s.write_blocked }])));
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
      <CourtesyAttentionPanel plans={plans} modules={modules} />
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
              <th>Acesso</th>
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
                  {flags[c.id] && <CourtesyCompanyFlag {...flags[c.id]} />}
                </td>
                <td>{fmtDocument(c.document)}</td>
                <td>{c.planName ?? "—"}</td>
                <td>
                  <CompanyStatusBadge status={c.subscriptionStatus} trialState={c.trialState} trialEndsAt={c.trialEndsAt} />
                </td>
                <td>
                  {access[c.id] ? <Badge wrap tone={access[c.id].blocked ? "bad" : access[c.id].state === "unmanaged" ? "muted" : access[c.id].state === "pending_payment" ? "warn" : "ok"}>{accessStateLabel(access[c.id].state, access[c.id].blocked, ACCESS_STATE_TEXT, { bridge: bridgeIndex?.[c.id] ?? null, bridgesKnown: bridgeIndex !== null, preserved: preservedIds.has(c.id) }, fmtDateTimeSP)}</Badge> : "—"}
                </td>
                <td>{fmtDateOnly(c.nextDueDate)}</td>
                <td>{c.activeModuleNames.length ? c.activeModuleNames.join(", ") : "—"}</td>
                <td className="mst-num">{c.monthlyTotalCents === null ? "—" : formatCents(c.monthlyTotalCents)}</td>
                <td className="mst-num">{c.memberCount}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9}>{companies.length === 0 ? "Nenhuma empresa cadastrada ainda." : "Nenhuma empresa encontrada para a busca."}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

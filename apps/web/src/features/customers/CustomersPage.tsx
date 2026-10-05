import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../../app/useAuth";
import { formatCents } from "../../lib/money";
import { ActiveBadge, CustomerDetailDialog, CustomerFormDialog } from "./CustomerDialogs";
import { CUSTOMERS_PAGE, supabaseCustomersSource, type CustomersSource } from "./customersApi";
import {
  CUSTOMER_TYPE_LABEL,
  DEFAULT_FILTERS,
  formatDocument,
  formatPhone,
  hasActiveFilters,
  SORT_OPTIONS,
  STATUS_FILTERS,
  TYPE_FILTERS,
  when,
  type CustomerFilters,
  type CustomerRow,
  type CustomersSummary,
  type SortKey,
  type StatusFilter,
  type TypeFilter,
} from "./customersLogic";

const LOAD_ERROR = "Não foi possível carregar os clientes agora. Tente novamente.";
const STALE_AFTER_MS = 60_000;

type Dialog = { kind: "new" } | { kind: "edit"; id: string } | { kind: "detail"; id: string };

function SummaryCard({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="fin-kpi">
      <dt>{label}</dt>
      <dd>{value}</dd>
      {hint && <span className="fin-delta">{hint}</span>}
    </div>
  );
}

// Cadastros → Clientes (owner/admin, rota /app). Cadastro por empresa; cliente nunca é apagado, só inativado.
// Toda regra é do servidor; a tela atualiza pelo botão, por ação local e ao voltar para a aba (sem Realtime).
export function CustomersPage({ source = supabaseCustomersSource }: { source?: CustomersSource }) {
  const { activeMembership } = useAuth();
  const companyId = activeMembership?.companyId ?? null;

  const [filters, setFilters] = useState<CustomerFilters>(DEFAULT_FILTERS);
  const [searchText, setSearchText] = useState("");
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<CustomersSummary | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const seq = useRef(0);
  const loadedAt = useRef(0);
  const filtersRef = useRef(filters);

  const load = useCallback(
    async (next: CustomerFilters) => {
      if (!companyId) return;
      const id = ++seq.current;
      setLoading(true);
      setError(null);
      const [list, sum] = await Promise.all([source.list(companyId, next, 0), source.summary(companyId)]);
      if (id !== seq.current) return;
      setLoading(false);
      if (list.error || sum.error || !list.data || !sum.data) {
        setError(list.error ?? sum.error ?? LOAD_ERROR);
        return;
      }
      loadedAt.current = Date.now();
      filtersRef.current = next;
      setRows(list.data.rows);
      setTotal(list.data.total);
      setSummary(sum.data);
      setLoaded(true);
    },
    [companyId, source],
  );

  useEffect(() => {
    void load(filtersRef.current);
  }, [load]);

  // Busca com pequena espera (~350 ms): não consulta a cada tecla.
  useEffect(() => {
    if (searchText.trim() === filters.search.trim()) return;
    const t = window.setTimeout(() => {
      const next = { ...filters, search: searchText };
      setFilters(next);
      void load(next);
    }, 350);
    return () => window.clearTimeout(t);
  }, [searchText, filters, load]);

  useEffect(() => {
    function refreshWhenVisible() {
      if (document.visibilityState === "visible" && Date.now() - loadedAt.current > STALE_AFTER_MS) void load(filtersRef.current);
    }
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => document.removeEventListener("visibilitychange", refreshWhenVisible);
  }, [load]);

  function apply(patch: Partial<CustomerFilters>) {
    const next = { ...filters, ...patch };
    setFilters(next);
    void load(next);
  }

  async function loadMore() {
    if (!companyId || loadingMore) return;
    setLoadingMore(true);
    const result = await source.list(companyId, filtersRef.current, rows.length);
    setLoadingMore(false);
    if (result.error || !result.data) {
      setError(result.error ?? LOAD_ERROR);
      return;
    }
    const known = new Set(rows.map((r) => r.id));
    setRows([...rows, ...result.data.rows.filter((r) => !known.has(r.id))]);
    setTotal(result.data.total);
  }

  function done(message: string) {
    setDialog(null);
    setNotice(message);
    void load(filtersRef.current);
  }

  async function toggleActive(id: string, name: string, active: boolean) {
    const result = await source.setActive(id, active);
    setDialog(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    setNotice(active ? `${name} foi ativado.` : `${name} foi inativado e não aparece mais em novos atendimentos.`);
    void load(filtersRef.current);
  }

  return (
    <div className="fin-page rec-page cus-page">
      <div className="page-header">
        <h2>Clientes</h2>
        <div className="rec-header-actions">
          <button className="btn-secondary btn-auto" type="button" disabled={loading} onClick={() => void load(filtersRef.current)}>
            {loading ? "Atualizando…" : "Atualizar"}
          </button>
          <button className="btn-primary btn-auto" type="button" onClick={() => setDialog({ kind: "new" })}>
            Novo cliente
          </button>
        </div>
      </div>

      {notice && (
        <div className="rec-notice" role="status">
          {notice}
          <button type="button" className="btn-link" onClick={() => setNotice(null)}>
            Fechar
          </button>
        </div>
      )}

      {summary ? (
        <dl className="fin-kpis rec-kpis">
          <SummaryCard label="Clientes ativos" value={summary.active} />
          <SummaryCard label="Clientes inativos" value={summary.inactive} />
          <SummaryCard label="Novos este mês" value={summary.newThisMonth} />
          <SummaryCard label="Com atendimento recente" value={summary.recentVisits} hint="últimos 30 dias" />
        </dl>
      ) : (
        !error && (
          <div className="fin-kpis" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="fin-kpi fin-skeleton-block" />
            ))}
          </div>
        )
      )}

      <div className="rec-filters">
        <div className="report-presets" role="group" aria-label="Situação">
          {STATUS_FILTERS.map((s) => (
            <button key={s.value} type="button" className="op-chip" aria-pressed={filters.status === s.value} onClick={() => apply({ status: s.value as StatusFilter })}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="rec-filter-row">
          <div className="field rec-search">
            <label htmlFor="cus-search">Buscar</label>
            <input
              id="cus-search"
              type="search"
              autoComplete="off"
              placeholder="Nome, CPF/CNPJ, telefone, WhatsApp ou e-mail"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="cus-type-filter">Tipo</label>
            <select id="cus-type-filter" value={filters.type} onChange={(e) => apply({ type: e.target.value as TypeFilter })}>
              {TYPE_FILTERS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="cus-sort">Ordenar por</label>
            <select id="cus-sort" value={filters.sort} onChange={(e) => apply({ sort: e.target.value as SortKey })}>
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {error && (
        <div className="form-error fin-error" role="alert">
          <p>{error}</p>
          <button className="btn-secondary btn-auto" type="button" onClick={() => void load(filtersRef.current)}>
            Tentar novamente
          </button>
        </div>
      )}

      {!loaded && !error && <p className="op-state">Carregando…</p>}

      {loaded && rows.length === 0 && !error && (
        <div className="fin-empty">
          {hasActiveFilters(filters)
            ? "Nenhum cliente encontrado com esses filtros."
            : "Nenhum cliente cadastrado. Use “Novo cliente” para cadastrar o primeiro."}
        </div>
      )}

      {loaded && rows.length > 0 && (
        <>
          <p className="field-hint">
            {total} {total === 1 ? "cliente" : "clientes"}
            {rows.length < total ? ` · mostrando ${rows.length}` : ""}
          </p>
          <ul className={loading ? "rec-list fin-loading" : "rec-list"}>
            {rows.map((row) => (
              <li key={row.id} className={row.isActive ? "rec-item cus-item" : "rec-item cus-item cus-item-inactive"}>
                <button type="button" className="rec-main" onClick={() => setDialog({ kind: "detail", id: row.id })} aria-label={`Ver detalhes de ${row.name}`}>
                  <span className="rec-customer">
                    {row.name}
                    {row.type === "company" && <small className="muted"> · {CUSTOMER_TYPE_LABEL.company}</small>}
                  </span>
                  <span className="rec-desc">
                    {[row.phone && formatPhone(row.phone), row.whatsapp && row.whatsapp !== row.phone ? `WhatsApp ${formatPhone(row.whatsapp)}` : null, row.document && formatDocument(row.document)]
                      .filter(Boolean)
                      .join(" · ") || <span className="muted">Sem telefone ou documento</span>}
                  </span>
                  {row.email && <span className="rec-due">{row.email}</span>}
                </button>
                <div className="rec-money cus-stats">
                  <ActiveBadge active={row.isActive} />
                  <small className="muted">{row.lastVisitAt ? `Última visita ${when(row.lastVisitAt)}` : "Sem atendimentos"}</small>
                  {row.visits > 0 && (
                    <small className="muted">
                      {row.visits} {row.visits === 1 ? "atendimento" : "atendimentos"}
                      {row.totalSpentCents > 0 ? ` · ${formatCents(row.totalSpentCents)}` : ""}
                    </small>
                  )}
                </div>
                <div className="rec-actions">
                  <button type="button" className="btn-secondary btn-auto" onClick={() => setDialog({ kind: "detail", id: row.id })}>
                    Ver
                  </button>
                  <button type="button" className="btn-secondary btn-auto" onClick={() => setDialog({ kind: "edit", id: row.id })}>
                    Editar
                  </button>
                  <button type="button" className="btn-secondary btn-auto" onClick={() => void toggleActive(row.id, row.name, !row.isActive)}>
                    {row.isActive ? "Inativar" : "Ativar"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {rows.length < total && rows.length >= CUSTOMERS_PAGE && (
            <button className="btn-secondary btn-auto" type="button" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? "Carregando…" : "Carregar mais"}
            </button>
          )}
        </>
      )}

      {dialog?.kind === "new" && companyId && <CustomerFormDialog source={source} companyId={companyId} customerId={null} onDone={done} onClose={() => setDialog(null)} />}
      {dialog?.kind === "edit" && companyId && (
        <CustomerFormDialog key={dialog.id} source={source} companyId={companyId} customerId={dialog.id} onDone={done} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "detail" && (
        <CustomerDetailDialog
          key={dialog.id}
          source={source}
          customerId={dialog.id}
          onEdit={() => setDialog({ kind: "edit", id: dialog.id })}
          onToggleActive={(c) => void toggleActive(c.id, c.name, !c.isActive)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

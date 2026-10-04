import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../../app/useAuth";
import { formatCents } from "../../lib/money";
import { formatDateBR, todayInSaoPaulo } from "../reports/reportsLogic";
import { PAYABLES_PAGE, supabasePayablesSource, type PayablesSource } from "./payablesApi";
import {
  canCancel,
  canEdit,
  canPay,
  DATE_FIELD_LABEL,
  defaultFilters,
  dueHint,
  filtersProblem,
  PERIOD_FILTERS,
  PAYABLE_CATEGORY_LABEL,
  PAYABLE_METHOD_LABEL,
  SORT_OPTIONS,
  STATUS_FILTERS,
  summaryRange,
  toListParams,
  type DateField,
  type PeriodKey,
  type PayableFilters,
  type PayableRow,
  type PayablesSummary,
  type SortKey,
  type StatusFilter,
} from "./payablesLogic";
import { CancelPayableDialog, PayableDetailDialog, PayableFormDialog, PayPaymentDialog, StatusBadge } from "./PayableDialogs";

const LOAD_ERROR = "Não foi possível carregar as contas a pagar.";
const STALE_AFTER_MS = 60_000;

type Dialog =
  | { kind: "new" }
  | { kind: "edit"; row: PayableRow }
  | { kind: "pay"; row: PayableRow }
  | { kind: "cancel"; row: PayableRow }
  | { kind: "detail"; row: PayableRow };

function SummaryCard({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "danger" | "warn" }) {
  return (
    <div className={tone ? `fin-kpi rec-kpi-${tone}` : "fin-kpi"}>
      <dt>{label}</dt>
      <dd>{value}</dd>
      {hint && <span className="fin-delta">{hint}</span>}
    </div>
  );
}

const countText = (n: number) => `${n} ${n === 1 ? "conta" : "contas"}`;

// Financeiro → Contas a pagar (owner/admin, rota /app). Valores que ainda serão pagos, separados das
// vendas já pagas no Caixa. Toda regra é do servidor (list/summary/create/update/pay/cancel); a tela
// atualiza pelo botão, por ação local e ao voltar para a aba (sem Realtime nesta versão).
export function PayablesPage({ source = supabasePayablesSource }: { source?: PayablesSource }) {
  const { activeMembership } = useAuth();
  const companyId = activeMembership?.companyId ?? null;

  const [filters, setFilters] = useState<PayableFilters>(() => defaultFilters(todayInSaoPaulo()));
  const [searchText, setSearchText] = useState("");
  const [rows, setRows] = useState<PayableRow[]>([]);
  const [total, setTotal] = useState(0);
  const [today, setToday] = useState(() => todayInSaoPaulo());
  const [summary, setSummary] = useState<PayablesSummary | null>(null);
  const [paidLabel, setReceivedLabel] = useState("este mês");
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const seq = useRef(0);
  const loadedAt = useRef(0);
  const filtersRef = useRef(filters);

  const load = useCallback(
    async (next: PayableFilters) => {
      if (!companyId) return;
      const problem = filtersProblem(next);
      if (problem) {
        setFormError(problem);
        return;
      }
      setFormError(null);
      const id = ++seq.current;
      const now = todayInSaoPaulo();
      const range = summaryRange(next, now);
      setLoading(true);
      setError(null);
      const [list, sum] = await Promise.all([
        source.list(companyId, toListParams(next, now), 0),
        source.summary(companyId, range.range.from, range.range.to),
      ]);
      if (id !== seq.current) return;
      setLoading(false);
      if (list.error || sum.error || !list.data || !sum.data) {
        setError(LOAD_ERROR);
        return;
      }
      loadedAt.current = Date.now();
      filtersRef.current = next;
      setRows(list.data.rows);
      setTotal(list.data.total);
      setToday(list.data.today);
      setSummary(sum.data);
      setReceivedLabel(range.label);
      setLoaded(true);
    },
    [companyId, source],
  );

  useEffect(() => {
    void load(filtersRef.current);
  }, [load]);

  // Busca com pequena espera (não consulta a cada tecla).
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

  function apply(patch: Partial<PayableFilters>, runNow = true) {
    const next = { ...filters, ...patch };
    setFilters(next);
    if (runNow) void load(next);
  }

  async function loadMore() {
    if (!companyId || loadingMore) return;
    setLoadingMore(true);
    const result = await source.list(companyId, toListParams(filtersRef.current, todayInSaoPaulo()), rows.length);
    setLoadingMore(false);
    if (result.error || !result.data) {
      setError(LOAD_ERROR);
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

  const customPeriod = filters.period === "custom";

  return (
    <div className="fin-page rec-page">
      <div className="page-header">
        <h2>Contas a pagar</h2>
        <div className="rec-header-actions">
          <button className="btn-secondary btn-auto" type="button" disabled={loading} onClick={() => void load(filtersRef.current)}>
            {loading ? "Atualizando…" : "Atualizar"}
          </button>
          <button className="btn-primary btn-auto" type="button" onClick={() => setDialog({ kind: "new" })}>
            Nova conta
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
          <SummaryCard label="A pagar" value={formatCents(summary.openCents)} hint={countText(summary.openCount)} />
          <SummaryCard label="Vencendo hoje" value={formatCents(summary.dueTodayCents)} hint={countText(summary.dueTodayCount)} tone={summary.dueTodayCount > 0 ? "warn" : undefined} />
          <SummaryCard label="Atrasado" value={formatCents(summary.overdueCents)} hint={countText(summary.overdueCount)} tone={summary.overdueCount > 0 ? "danger" : undefined} />
          <SummaryCard label="Pago" value={formatCents(summary.paidPeriodCents)} hint={paidLabel} />
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
            <label htmlFor="rec-search">Buscar</label>
            <input id="rec-search" type="search" placeholder="Fornecedor, descrição, categoria ou documento" value={searchText} onChange={(e) => setSearchText(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="rec-sort">Ordenar por</label>
            <select id="rec-sort" value={filters.sort} onChange={(e) => apply({ sort: e.target.value as SortKey })}>
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="rec-datefield">Filtrar período por</label>
            <select id="rec-datefield" value={filters.dateField} onChange={(e) => apply({ dateField: e.target.value as DateField })}>
              {(Object.keys(DATE_FIELD_LABEL) as DateField[]).map((d) => (
                <option key={d} value={d}>
                  {DATE_FIELD_LABEL[d]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="rec-period">Período</label>
            <select id="rec-period" value={filters.period} onChange={(e) => apply({ period: e.target.value as PeriodKey }, e.target.value !== "custom")}>
              {PERIOD_FILTERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {customPeriod && (
          <div className="rec-filter-row">
            <div className="field">
              <label htmlFor="rec-from">Data inicial</label>
              <input id="rec-from" type="date" value={filters.custom.from} onChange={(e) => apply({ custom: { ...filters.custom, from: e.target.value } }, false)} />
            </div>
            <div className="field">
              <label htmlFor="rec-to">Data final</label>
              <input id="rec-to" type="date" value={filters.custom.to} onChange={(e) => apply({ custom: { ...filters.custom, to: e.target.value } }, false)} />
            </div>
            <button className="btn-primary btn-auto" type="button" disabled={loading} onClick={() => void load(filters)}>
              Aplicar
            </button>
          </div>
        )}
      </div>
      {formError && <div className="form-error">{formError}</div>}
      <p className="field-hint">
        Horário de Brasília. Vencimento = quando a conta vence; Pagamento = quando a conta foi paga. Pagamentos aqui não movimentam o Caixa.
      </p>

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
          {filters.status === "all" && filters.search.trim() === "" && filters.period === "none"
            ? "Nenhuma conta a pagar cadastrada. Use “Nova conta” para lançar a primeira."
            : "Nenhuma conta encontrada com esses filtros."}
        </div>
      )}

      {loaded && rows.length > 0 && (
        <>
          <p className="field-hint">
            {total} {total === 1 ? "conta" : "contas"}
            {rows.length < total ? ` · mostrando ${rows.length}` : ""}
          </p>
          <ul className={loading ? "rec-list fin-loading" : "rec-list"}>
            {rows.map((row) => (
              <li key={row.id} className={`rec-item rec-item-${row.displayStatus}`}>
                <button type="button" className="rec-main" onClick={() => setDialog({ kind: "detail", row })} aria-label={`Ver detalhes de ${row.supplierName}`}>
                  <span className="rec-customer">{row.supplierName}</span>
                  <span className="rec-desc">
                    {row.description}
                    <small className="muted"> · {PAYABLE_CATEGORY_LABEL[row.category]}</small>
                    {row.reference && <small className="muted"> · {row.reference}</small>}
                  </span>
                  <span className="rec-due">
                    Vence em {formatDateBR(row.dueDate)}
                    {row.status === "pending" && <small className={row.displayStatus === "overdue" ? "rec-late" : "muted"}> · {dueHint(row.dueDate, today)}</small>}
                    {row.status === "paid" && row.lastPaymentMethod && <small className="muted"> · paga via {PAYABLE_METHOD_LABEL[row.lastPaymentMethod]}</small>}
                  </span>
                </button>
                <div className="rec-money">
                  <StatusBadge row={row} />
                  <span className="rec-amount">{formatCents(row.amountCents)}</span>
                  {row.status !== "cancelled" && (
                    <small className="muted">
                      Pago {formatCents(row.paidCents)} · Saldo {formatCents(row.balanceCents)}
                    </small>
                  )}
                </div>
                <div className="rec-actions">
                  <button type="button" className="btn-secondary btn-auto" onClick={() => setDialog({ kind: "detail", row })}>
                    Ver
                  </button>
                  {canEdit(row) && (
                    <button type="button" className="btn-secondary btn-auto" onClick={() => setDialog({ kind: "edit", row })}>
                      Editar
                    </button>
                  )}
                  {canPay(row) && (
                    <button type="button" className="btn-primary btn-auto" onClick={() => setDialog({ kind: "pay", row })}>
                      Pagar
                    </button>
                  )}
                  {canCancel(row) && (
                    <button type="button" className="btn-secondary btn-auto" onClick={() => setDialog({ kind: "cancel", row })}>
                      Cancelar
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {rows.length < total && rows.length >= PAYABLES_PAGE && (
            <button className="btn-secondary btn-auto" type="button" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? "Carregando…" : "Carregar mais"}
            </button>
          )}
        </>
      )}

      {dialog?.kind === "new" && companyId && <PayableFormDialog source={source} companyId={companyId} row={null} onDone={done} onClose={() => setDialog(null)} />}
      {dialog?.kind === "edit" && companyId && <PayableFormDialog source={source} companyId={companyId} row={dialog.row} onDone={done} onClose={() => setDialog(null)} />}
      {dialog?.kind === "pay" && <PayPaymentDialog source={source} row={dialog.row} today={today} onDone={done} onClose={() => setDialog(null)} />}
      {dialog?.kind === "cancel" && <CancelPayableDialog source={source} row={dialog.row} onDone={done} onClose={() => setDialog(null)} />}
      {dialog?.kind === "detail" && companyId && (
        <PayableDetailDialog
          source={source}
          companyId={companyId}
          row={dialog.row}
          today={today}
          onEdit={() => setDialog({ kind: "edit", row: dialog.row })}
          onPay={() => setDialog({ kind: "pay", row: dialog.row })}
          onCancel={() => setDialog({ kind: "cancel", row: dialog.row })}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

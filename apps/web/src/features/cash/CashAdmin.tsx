import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../app/useAuth";
import { formatReais } from "../../lib/money";
import {
  CASH_HISTORY_PAGE,
  EMPTY_CASH_FILTERS,
  supabaseCashSource,
  type CashHistoryFilters,
  type CashSession,
  type CashSource,
} from "./cashApi";
import { CloseCashDialog, OpenCashDialog } from "./CashDialogs";
import { notifyCashChanged } from "./useMyOpenCash";
import {
  describeDifference,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABEL,
  reconcile,
  summarizeMovements,
  type CashMovementRow,
} from "./cashLogic";

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
const fmt = (iso: string) => dateTime.format(new Date(iso));

type Tab = "open" | "history";

// Só o que muda entre "abertos" e "histórico": a lista de abertos é sempre completa (são poucos).
const OPEN_FILTERS: CashHistoryFilters = { ...EMPTY_CASH_FILTERS, status: "open" };

function DifferenceBadge({ cash }: { cash: CashSession }) {
  if (cash.cashDifference === null) return <span className="field-hint">Sem conferência</span>;
  const cents = Math.round(cash.cashDifference * 100);
  return (
    <span className={cents === 0 ? "status-badge status-active" : "status-badge status-inactive"}>
      {describeDifference(cents, formatReais)}
    </span>
  );
}

// Detalhe de UM caixa (aberto ou fechado): dados, vendas por forma, conferência e movimentos.
// Somente leitura: nada aqui altera um caixa fechado.
function CashDetail({
  cash,
  movements,
  onCloseCash,
}: {
  cash: CashSession;
  movements: CashMovementRow[] | null;
  onCloseCash?: () => void;
}) {
  const summary = summarizeMovements(movements ?? []);
  const loading = movements === null;
  const value = (reais: number) => (loading ? "…" : formatReais(reais));
  const expected = reconcile(cash.openingAmount, summary.byMethod.cash, "").expectedCents / 100;

  return (
    <section className="cash-detail" aria-label="Detalhe do caixa">
      <h3>
        Caixa de {cash.openedByName ?? "—"} · {fmt(cash.openedAt)}
      </h3>
      <p className="field-hint">
        {cash.status === "open"
          ? "Aberto"
          : `Fechado em ${cash.closedAt ? fmt(cash.closedAt) : "—"} por ${cash.closedByName ?? "—"}`}
      </p>
      {cash.closingNotes && <p className="field-hint">Observação: {cash.closingNotes}</p>}
      {onCloseCash && (
        <button className="btn-danger" type="button" disabled={loading} onClick={onCloseCash}>
          Fechar caixa do operador
        </button>
      )}

      <dl className="cash-summary">
        <div>
          <dt>Saldo inicial</dt>
          <dd>{formatReais(cash.openingAmount)}</dd>
        </div>
        {PAYMENT_METHODS.map((method) => (
          <div key={method}>
            <dt>Vendas — {PAYMENT_METHOD_LABEL[method]}</dt>
            <dd>{value(summary.byMethod[method])}</dd>
          </div>
        ))}
        <div className="cash-summary-strong">
          <dt>Total vendido</dt>
          <dd>{value(summary.total)}</dd>
        </div>
      </dl>

      {cash.status === "closed" && (
        <>
          <h4 className="cash-section-title">Conferência do dinheiro</h4>
          {cash.closingCashAmount === null || cash.cashDifference === null ? (
            <p className="field-hint">Este caixa foi fechado antes da conferência de dinheiro existir.</p>
          ) : (
            <dl className="cash-summary">
              <div>
                <dt>Dinheiro esperado</dt>
                {/* derivado: contado - diferença (o servidor não grava o esperado) */}
                <dd>{formatReais(Math.round((cash.closingCashAmount - cash.cashDifference) * 100) / 100)}</dd>
              </div>
              <div>
                <dt>Dinheiro contado</dt>
                <dd>{formatReais(cash.closingCashAmount)}</dd>
              </div>
              <div>
                <dt>Diferença</dt>
                <dd>
                  <DifferenceBadge cash={cash} />
                </dd>
              </div>
            </dl>
          )}
        </>
      )}
      {cash.status === "open" && !loading && (
        <p className="field-hint">Dinheiro esperado no caixa até agora: {formatReais(expected)}</p>
      )}

      <h4 className="cash-section-title">Movimentos</h4>
      {loading ? (
        <p className="field-hint">Carregando movimentos…</p>
      ) : movements.length === 0 ? (
        <p className="field-hint">Nenhuma venda registrada neste caixa.</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Hora</th>
                <th>Comanda / mesa</th>
                <th>Forma</th>
                <th>Valor</th>
              </tr>
            </thead>
            <tbody>
              {movements.map((m) => (
                <tr key={m.id}>
                  <td>{fmt(m.createdAt)}</td>
                  <td>{m.description}</td>
                  <td>{PAYMENT_METHOD_LABEL[m.paymentMethod]}</td>
                  <td>{formatReais(m.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// Financeiro > Caixa: "Caixas abertos" e "Histórico" (fechados, com filtros e "carregar mais"),
// detalhe do caixa selecionado e abrir/fechar o caixa do próprio usuário. Só leitura de dinheiro:
// tudo que grava passa pelas RPCs. RLS: owner/admin veem todos os caixas da empresa; cashier só os seus.
export function CashAdmin({ source = supabaseCashSource }: { source?: CashSource }) {
  const { activeMembership, user, profile } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const userId = user?.id ?? null;
  const role = activeMembership?.role ?? null;
  const canAdminClose = role === "owner" || role === "admin";

  const [tab, setTab] = useState<Tab>("open");
  const [openSessions, setOpenSessions] = useState<CashSession[] | null>(null);
  const [history, setHistory] = useState<CashSession[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [limit, setLimit] = useState(CASH_HISTORY_PAGE);
  const [filters, setFilters] = useState<CashHistoryFilters>({ ...EMPTY_CASH_FILTERS, status: "closed" });
  const [operators, setOperators] = useState<{ id: string; name: string }[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selected, setSelected] = useState<CashSession | null>(null);
  // Movimentos JÁ carregados e de QUAL caixa são: só valem se forem do caixa selecionado.
  const [loaded, setLoaded] = useState<{ cashId: string; rows: CashMovementRow[] } | null>(null);
  // Movimentos do PRÓPRIO caixa, carregados ao abrir o fechamento (independe da seleção).
  const [ownMovements, setOwnMovements] = useState<CashMovementRow[]>([]);
  const [dialog, setDialog] = useState<"open" | "close" | "close-other" | null>(null);

  const reloadOpen = useCallback(async () => {
    if (!companyId) return;
    const result = await source.listCashSessions(companyId, OPEN_FILTERS, 100);
    if (result.error || !result.data) {
      setLoadError(result.error ?? "Não foi possível carregar o caixa.");
      return;
    }
    setLoadError(null);
    setOpenSessions(result.data);
  }, [companyId, source]);

  const reloadHistory = useCallback(async () => {
    if (!companyId) return;
    const result = await source.listCashSessions(companyId, filters, limit);
    if (result.error || !result.data) {
      setLoadError(result.error ?? "Não foi possível carregar o histórico.");
      return;
    }
    setLoadError(null);
    setHistory(result.data);
    setHasMore(result.hasMore);
  }, [companyId, source, filters, limit]);

  useEffect(() => {
    void reloadOpen();
  }, [reloadOpen]);

  useEffect(() => {
    if (tab === "history") void reloadHistory();
  }, [tab, reloadHistory]);

  useEffect(() => {
    if (!companyId || !canAdminClose) return;
    void source.listCashOperators(companyId).then((result) => setOperators(result.data));
  }, [companyId, canAdminClose, source]);

  useEffect(() => {
    if (!selected) return;
    const cashId = selected.id;
    let cancelled = false;
    void source.listMovements(cashId).then((result) => {
      if (!cancelled && result.data) setLoaded({ cashId, rows: result.data });
    });
    return () => {
      cancelled = true;
    };
  }, [selected, source]);

  const myOpen = openSessions?.find((s) => s.openedBy === userId) ?? null;
  const movements = selected && loaded && loaded.cashId === selected.id ? loaded.rows : null;
  const canCloseSelected =
    canAdminClose && selected !== null && selected.status === "open" && selected.openedBy !== userId && movements !== null;

  async function startClose() {
    if (!myOpen) return;
    const result = await source.listMovements(myOpen.id);
    setOwnMovements(result.data ?? []);
    setDialog("close");
  }

  function afterClosing() {
    setDialog(null);
    setSelected(null);
    setLoaded(null);
    void reloadOpen();
    if (tab === "history") void reloadHistory();
    notifyCashChanged();
  }

  function changeFilters(patch: Partial<CashHistoryFilters>) {
    setLimit(CASH_HISTORY_PAGE);
    setFilters((current) => ({ ...current, ...patch }));
  }

  function select(cash: CashSession) {
    setLoaded(null);
    setSelected(cash);
  }

  const list = tab === "open" ? openSessions : history;

  return (
    <div>
      <div className="page-header">
        <h2>Caixa</h2>
        {myOpen ? (
          <button className="btn-danger" type="button" onClick={() => void startClose()}>
            Fechar meu caixa
          </button>
        ) : (
          <button className="btn-primary btn-auto" type="button" onClick={() => setDialog("open")}>
            Abrir caixa
          </button>
        )}
      </div>

      <div className="tab-bar" role="tablist" aria-label="Caixas">
        <button role="tab" type="button" aria-selected={tab === "open"} className={tab === "open" ? "tab tab-active" : "tab"} onClick={() => setTab("open")}>
          Caixas abertos
        </button>
        <button role="tab" type="button" aria-selected={tab === "history"} className={tab === "history" ? "tab tab-active" : "tab"} onClick={() => setTab("history")}>
          Histórico
        </button>
      </div>

      {tab === "history" && (
        <div className="cash-filters">
          <div className="field">
            <label htmlFor="cash-filter-from">De</label>
            <input id="cash-filter-from" type="date" value={filters.from ?? ""} onChange={(e) => changeFilters({ from: e.target.value || null })} />
          </div>
          <div className="field">
            <label htmlFor="cash-filter-to">Até</label>
            <input id="cash-filter-to" type="date" value={filters.to ?? ""} onChange={(e) => changeFilters({ to: e.target.value || null })} />
          </div>
          {canAdminClose && (
            <div className="field">
              <label htmlFor="cash-filter-operator">Operador</label>
              <select id="cash-filter-operator" value={filters.operatorId ?? ""} onChange={(e) => changeFilters({ operatorId: e.target.value || null })}>
                <option value="">Todos</option>
                {operators.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {loadError && <div className="form-error">{loadError}</div>}
      {!list && !loadError && <p className="op-state">Carregando…</p>}
      {list && list.length === 0 && (
        <p className="field-hint">{tab === "open" ? "Nenhum caixa aberto no momento." : "Nenhum caixa fechado encontrado."}</p>
      )}

      {list && list.length > 0 && tab === "open" && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Operador</th>
                <th>Abertura</th>
                <th>Saldo inicial</th>
                <th>Total vendido</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id}>
                  <td>{s.openedByName ?? "—"}</td>
                  <td>{fmt(s.openedAt)}</td>
                  <td>{formatReais(s.openingAmount)}</td>
                  <td>{formatReais(s.totals?.total ?? 0)}</td>
                  <td>
                    <button className="btn-secondary btn-small" type="button" onClick={() => select(s)}>
                      {s.id === selected?.id ? "Selecionado" : "Ver detalhe"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {list && list.length > 0 && tab === "history" && (
        <>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Operador</th>
                  <th>Abertura</th>
                  <th>Fechamento</th>
                  <th>Fechado por</th>
                  <th>Saldo inicial</th>
                  <th>Dinheiro</th>
                  <th>Pix</th>
                  <th>Débito</th>
                  <th>Crédito</th>
                  <th>Outros</th>
                  <th>Total vendido</th>
                  <th>Contado</th>
                  <th>Diferença</th>
                  <th>Observação</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.id}>
                    <td>{s.openedByName ?? "—"}</td>
                    <td>{fmt(s.openedAt)}</td>
                    <td>{s.closedAt ? fmt(s.closedAt) : "—"}</td>
                    <td>{s.closedByName ?? "—"}</td>
                    <td>{formatReais(s.openingAmount)}</td>
                    <td>{formatReais(s.totals?.cash ?? 0)}</td>
                    <td>{formatReais(s.totals?.pix ?? 0)}</td>
                    <td>{formatReais(s.totals?.debit ?? 0)}</td>
                    <td>{formatReais(s.totals?.credit ?? 0)}</td>
                    <td>{formatReais(s.totals?.other ?? 0)}</td>
                    <td>{formatReais(s.totals?.total ?? 0)}</td>
                    <td>{s.closingCashAmount === null ? "—" : formatReais(s.closingCashAmount)}</td>
                    <td>
                      <DifferenceBadge cash={s} />
                    </td>
                    <td>{s.closingNotes ?? "—"}</td>
                    <td>
                      <button className="btn-secondary btn-small" type="button" onClick={() => select(s)}>
                        {s.id === selected?.id ? "Selecionado" : "Ver detalhe"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {hasMore && (
            <button className="btn-secondary btn-small" type="button" onClick={() => setLimit((current) => current + CASH_HISTORY_PAGE)}>
              Carregar mais
            </button>
          )}
        </>
      )}

      {selected && (
        <CashDetail cash={selected} movements={movements} onCloseCash={canCloseSelected ? () => setDialog("close-other") : undefined} />
      )}

      {dialog === "open" && companyId && (
        <OpenCashDialog
          source={source}
          companyId={companyId}
          onOpened={() => {
            setDialog(null);
            setSelected(null);
            void reloadOpen();
            notifyCashChanged();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "close" && myOpen && (
        <CloseCashDialog
          source={source}
          cash={myOpen}
          operatorName={profile?.full_name ?? null}
          movements={ownMovements}
          onClosed={afterClosing}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "close-other" && selected && movements && (
        <CloseCashDialog
          source={source}
          cash={selected}
          operatorName={selected.openedByName}
          movements={movements}
          otherOperator
          title="Fechar caixa do operador"
          notesHint="Ex.: Operador encerrou o expediente sem fechar o caixa."
          onClosed={afterClosing}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

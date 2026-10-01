import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseDocumentsSource } from "../printing/documentsApi";
import { PrintDocumentButton } from "../printing/PrintDocumentButton";
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
import { CashMovementDialog, CloseCashDialog, OpenCashDialog, RefundDialog } from "./CashDialogs";
import { notifyCashChanged } from "./useMyOpenCash";
import {
  describeDifference,
  buildRefundablePayments,
  MOVEMENT_TYPE_LABEL,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABEL,
  reconcile,
  refundTotals,
  summarizeMovements,
  type CashMovementRow,
  type PaymentRefund,
  type RefundablePayment,
  type SalePaymentRow,
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
  payments,
  onCloseCash,
  onMovement,
  onRefund,
}: {
  cash: CashSession;
  movements: CashMovementRow[] | null;
  payments: RefundablePayment[] | null;
  onCloseCash?: () => void;
  onMovement?: (kind: "supply" | "withdrawal") => void;
  onRefund?: (payment: RefundablePayment) => void;
}) {
  const summary = summarizeMovements(movements ?? []);
  const loading = movements === null;
  const value = (reais: number) => (loading ? "…" : formatReais(reais));
  const expected = reconcile(cash.openingAmount, summary.netCash, "").expectedCents / 100;

  return (
    <section className="cash-detail cash-detail-panel" aria-label="Detalhe do caixa">
      <h3>Detalhe do caixa</h3>
      {cash.status === "closed" && (
        // Fechamento de caixa (manual; F8 contextual): só caixa FECHADO. O servidor valida papel e dono do caixa.
        <PrintDocumentButton
          label="Imprimir fechamento"
          successMessage="Fechamento enviado para impressão."
          request={() => supabaseDocumentsSource.cashClosing(cash.id)}
        />
      )}
      {onCloseCash && (
        <button className="btn-danger" type="button" disabled={loading} onClick={onCloseCash}>
          Fechar caixa do operador
        </button>
      )}

      {onMovement && (
        <div className="cash-detail-actions">
          <button className="btn-secondary btn-small" type="button" disabled={loading} onClick={() => onMovement("supply")}>
            Suprimento
          </button>
          <button className="btn-secondary btn-small" type="button" disabled={loading} onClick={() => onMovement("withdrawal")}>
            Sangria
          </button>
        </div>
      )}

      <h4 className="cash-section-title">Informações</h4>
      <dl className="cash-summary">
        <div>
          <dt>Operador</dt>
          <dd>{cash.openedByName ?? "—"}</dd>
        </div>
        <div>
          <dt>Aberto em</dt>
          <dd>{fmt(cash.openedAt)}</dd>
        </div>
        <div>
          <dt>Fechado em</dt>
          <dd>{cash.closedAt ? fmt(cash.closedAt) : "Ainda aberto"}</dd>
        </div>
        <div>
          <dt>Fechado por</dt>
          <dd>{cash.status === "closed" ? (cash.closedByName ?? "—") : "—"}</dd>
        </div>
      </dl>

      <h4 className="cash-section-title">Resumo financeiro</h4>
      <dl className="cash-summary">
        <div>
          <dt>Saldo inicial</dt>
          <dd>{formatReais(cash.openingAmount)}</dd>
        </div>
        {PAYMENT_METHODS.map((method) => (
          <div key={method}>
            <dt>{PAYMENT_METHOD_LABEL[method]}</dt>
            <dd>{value(summary.byMethod[method])}</dd>
          </div>
        ))}
        <div className="cash-summary-strong">
          <dt>Total vendido</dt>
          <dd>{value(summary.total)}</dd>
        </div>
      </dl>

      <h4 className="cash-section-title">Movimentos de caixa</h4>
      <dl className="cash-summary">
        <div>
          <dt>Suprimentos</dt>
          <dd>{value(summary.supply)}</dd>
        </div>
        <div>
          <dt>Sangrias</dt>
          <dd>{value(summary.withdrawal)}</dd>
        </div>
        <div>
          <dt>Estornos pagos por este caixa</dt>
          <dd>{value(summary.refund)}</dd>
        </div>
      </dl>

      {payments && payments.length > 0 && (
        <>
          <h4 className="cash-section-title">Pagamentos e estornos</h4>
          {(() => {
            const totals = refundTotals(payments);
            return (
              <dl className="cash-summary">
                <div>
                  <dt>Vendido (original)</dt>
                  <dd>{formatReais(totals.original)}</dd>
                </div>
                <div>
                  <dt>Estornado</dt>
                  <dd>{formatReais(totals.refunded)}</dd>
                </div>
                <div className="cash-summary-strong">
                  <dt>Líquido</dt>
                  <dd>{formatReais(totals.net)}</dd>
                </div>
              </dl>
            );
          })()}
          <ul className="refund-list">
            {payments.map((p) => (
              <li key={p.paymentId} className="refund-card">
                <div className="refund-card-head">
                  <strong>
                    {PAYMENT_METHOD_LABEL[p.method]} · {p.label.replace(/^Venda - /, "")}
                  </strong>
                  <span className="muted">{fmt(p.createdAt)}</span>
                </div>
                <p className="refund-card-values">
                  Pago: {formatReais(p.amount)} · Estornado: {formatReais(p.refunded)} · Disponível: {formatReais(p.available)}
                </p>
                {onRefund && p.available > 0 && (
                  <button type="button" className="btn-secondary btn-small btn-danger-text" onClick={() => onRefund(p)}>
                    Estornar
                  </button>
                )}
                {p.refunds.length > 0 && (
                  <ul className="refund-events">
                    {p.refunds.map((r) => (
                      <li key={r.id}>
                        Estorno {PAYMENT_METHOD_LABEL[p.method]} {formatReais(r.amount)} · Motivo: {r.reason} · Realizado por{" "}
                        {r.createdByName ?? "—"} · {fmt(r.createdAt)}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <h4 className="cash-section-title">Conferência</h4>
      {cash.status === "open" ? (
        !loading && <p className="field-hint">Dinheiro esperado atual: {formatReais(expected)} (saldo inicial + vendas em dinheiro + suprimentos − sangrias)</p>
      ) : cash.closingCashAmount === null || cash.cashDifference === null ? (
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
      {cash.status === "closed" && <p className="field-hint">Observação: {cash.closingNotes ?? "—"}</p>}

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
                <th>Tipo</th>
                <th>Comanda / mesa / motivo</th>
                <th>Forma</th>
                <th>Valor</th>
              </tr>
            </thead>
            <tbody>
              {movements.map((m) => (
                <tr key={m.id}>
                  <td>{fmt(m.createdAt)}</td>
                  <td>{MOVEMENT_TYPE_LABEL[m.movementType]}</td>
                  <td>{m.description}</td>
                  <td>{PAYMENT_METHOD_LABEL[m.paymentMethod]}</td>
                  <td>{m.movementType === "withdrawal" || m.movementType === "refund" ? `− ${formatReais(m.amount)}` : formatReais(m.amount)}</td>
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
  const [dialog, setDialog] = useState<"open" | "close" | "close-other" | "supply" | "withdrawal" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Pagamentos do caixa selecionado + estornos (só owner/admin leem estornos) e o pagamento em estorno.
  const [paymentData, setPaymentData] = useState<{ cashId: string; sales: SalePaymentRow[]; refunds: PaymentRefund[] } | null>(null);
  const [refunding, setRefunding] = useState<RefundablePayment | null>(null);

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

  useEffect(() => {
    if (!selected) return;
    const cashId = selected.id;
    let cancelled = false;
    void source.listPayments(cashId).then((result) => {
      if (!cancelled && result.data) setPaymentData({ cashId, ...result.data });
    });
    return () => {
      cancelled = true;
    };
  }, [selected, source]);

  const payments = useMemo(
    () => (paymentData && selected && paymentData.cashId === selected.id ? buildRefundablePayments(paymentData.sales, paymentData.refunds) : null),
    [paymentData, selected],
  );

  const myOpen = openSessions?.find((s) => s.openedBy === userId) ?? null;
  const movements = selected && loaded && loaded.cashId === selected.id ? loaded.rows : null;
  const canCloseSelected =
    canAdminClose && selected !== null && selected.status === "open" && selected.openedBy !== userId && movements !== null;

  // Owner/admin movimentam qualquer caixa aberto; o cashier só o próprio (o servidor confirma).
  const canMoveSelected =
    selected !== null && selected.status === "open" && (canAdminClose || selected.openedBy === userId) && movements !== null;

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
          <div className="cash-history-table">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Operador</th>
                  <th>Abertura</th>
                  <th>Fechamento</th>
                  <th>Total vendido</th>
                  <th>Conferência</th>
                  <th>Fechado por</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.id}>
                    <td>{s.openedByName ?? "—"}</td>
                    <td>{fmt(s.openedAt)}</td>
                    <td>{s.closedAt ? fmt(s.closedAt) : "—"}</td>
                    <td>{formatReais(s.totals?.total ?? 0)}</td>
                    <td>
                      <DifferenceBadge cash={s} />
                    </td>
                    <td>{s.closedByName ?? "—"}</td>
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
          <ul className="cash-history-cards">
            {list.map((s) => (
              <li key={s.id} className="cash-history-card">
                <strong>{s.openedByName ?? "—"}</strong>
                <span>
                  {fmt(s.openedAt)} → {s.closedAt ? fmt(s.closedAt) : "—"}
                </span>
                <span>Total vendido: {formatReais(s.totals?.total ?? 0)}</span>
                <DifferenceBadge cash={s} />
                <button className="btn-secondary btn-small" type="button" onClick={() => select(s)}>
                  {s.id === selected?.id ? "Selecionado" : "Ver detalhe"}
                </button>
              </li>
            ))}
          </ul>
          {hasMore && (
            <button className="btn-secondary btn-small" type="button" onClick={() => setLimit((current) => current + CASH_HISTORY_PAGE)}>
              Carregar mais
            </button>
          )}
        </>
      )}

      {notice && (
        <div role="status" className="form-notice">
          {notice}
        </div>
      )}

      {selected && (
        <CashDetail
          cash={selected}
          movements={movements}
          payments={payments}
          onRefund={canAdminClose ? (payment) => setRefunding(payment) : undefined}
          onCloseCash={canCloseSelected ? () => setDialog("close-other") : undefined}
          onMovement={
            canMoveSelected
              ? (kind) => {
                  setNotice(null);
                  setDialog(kind);
                }
              : undefined
          }
        />
      )}
      {refunding && (
        <RefundDialog
          source={source}
          payment={refunding}
          onDone={(message) => {
            setRefunding(null);
            setNotice(message);
            setLoaded(null);
            setPaymentData(null);
            if (selected) setSelected({ ...selected }); // recarrega movimentos e pagamentos
            void reloadOpen();
          }}
          onClose={() => setRefunding(null)}
        />
      )}
      {(dialog === "supply" || dialog === "withdrawal") && selected && movements && (
        <CashMovementDialog
          source={source}
          cash={selected}
          kind={dialog}
          movements={movements}
          operatorName={selected.openedByName}
          onDone={(message) => {
            setDialog(null);
            setNotice(message);
            setLoaded(null);
            setSelected({ ...selected }); // recarrega os movimentos do caixa selecionado
            void reloadOpen();
          }}
          onClose={() => setDialog(null)}
        />
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

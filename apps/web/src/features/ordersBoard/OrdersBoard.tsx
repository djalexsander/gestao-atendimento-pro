import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../app/useAuth";
import { formatReais } from "../../lib/money";
import { Modal } from "../employees/Modal";
import { ModifierLines } from "../modifiers/ModifierDialog";
import { attendancePath } from "../operations/openSessions";
import { createCoalescedRunner } from "../orders/coalesce";
import { supabaseOrdersBoardApi, type OrdersBoardApi } from "./ordersBoardApi";
import {
  activeQty,
  canOpenAttendance,
  countOrders,
  createBoardController,
  currentTotal,
  filterOrders,
  formatDateTime,
  formatTime,
  groupByDay,
  KIND_LABEL,
  NO_FILTERS,
  originalTotal,
  shouldGroupByDay,
  PERIOD_LABEL,
  PRODUCTION_LABEL,
  sectorOptions,
  sortOrders,
  STATUS_LABEL,
  summarize,
  waiterOptions,
  type AggStatus,
  type BoardFilters,
  type BoardOrder,
  type BoardState,
  type KindFilter,
  type OrderDetail,
  type PeriodFilter,
  type SortKey,
  type StatusFilter,
} from "./ordersBoardLogic";

const SEARCH_LABEL = "Buscar mesa, comanda, cliente, atendente, produto ou código";
const PERIODS: PeriodFilter[] = ["today", "yesterday", "week", "custom"];

const STATUS_CHIPS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "pending", label: STATUS_LABEL.pending },
  { value: "preparing", label: STATUS_LABEL.preparing },
  { value: "ready", label: STATUS_LABEL.ready },
  { value: "partial", label: STATUS_LABEL.partial },
  { value: "cancelled", label: STATUS_LABEL.cancelled },
];
const KIND_CHIPS: Array<{ value: KindFilter; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "table", label: "Mesas" },
  { value: "command", label: "Comandas" },
];
const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "newest", label: "Mais recentes" },
  { value: "oldest", label: "Mais antigos" },
  { value: "value", label: "Maior valor" },
];

const itemsText = (n: number) => (n === 1 ? "1 item" : `${n} itens`);

function StatusBadge({ status }: { status: AggStatus }) {
  return <span className={`ob-status ob-status-${status}`}>{STATUS_LABEL[status]}</span>;
}

function OrderCard({ order, onDetails }: { order: BoardOrder; onDetails: (order: BoardOrder) => void }) {
  const s = summarize(order);
  const title = order.kind === "table" ? order.displayName : order.code;
  return (
    <li className={`ob-card ob-${s.status}`}>
      <div className="ob-top">
        <span className="ob-time">{formatTime(order.submittedAt)}</span>
        <span className="ob-code">#{order.shortId}</span>
        <StatusBadge status={s.status} />
        {s.status === "partial" && s.production && <span className="ob-prod">{PRODUCTION_LABEL[s.production]}</span>}
      </div>
      <div className="ob-main">
        <span className={`ob-kind ob-kind-${order.kind}`}>{KIND_LABEL[order.kind]}</span>
        <span className="ob-title">{title}</span>
        <span className="ob-total">{formatReais(s.total)}</span>
      </div>
      <div className="ob-meta">
        {order.customerName && <span>Cliente: {order.customerName}</span>}
        <span>Atendente: {order.waiterName ?? "—"}</span>
      </div>
      <div className="ob-items">
        <span className="ob-count">{itemsText(s.itemCount)}</span>
        {s.itemsText && <span className="ob-names">{s.itemsText}</span>}
      </div>
      {s.sectors.length > 0 && (
        <div className="ob-sectors" aria-label="Setores">
          {s.sectors.map((name) => (
            <span key={name} className="ob-chip">
              {name}
            </span>
          ))}
        </div>
      )}
      <button className="btn-secondary ob-details" type="button" onClick={() => onDetails(order)}>
        Ver detalhes
      </button>
    </li>
  );
}

function DetailDialog({
  order,
  detail,
  error,
  loading,
  onClose,
  onOpenAttendance,
}: {
  order: BoardOrder;
  detail: OrderDetail | null;
  error: string | null;
  loading: boolean;
  onClose: () => void;
  onOpenAttendance: () => void;
}) {
  const items = detail?.items ?? order.items;
  const s = summarize({ ...order, items });
  const title = `${KIND_LABEL[order.kind]} ${order.kind === "table" ? order.displayName.replace(/^Mesa\s*/i, "") : order.code} · #${order.shortId}`;
  return (
    <Modal title={title} onClose={onClose}>
      <dl className="op-detail">
        <div>
          <dt>Status</dt>
          <dd>
            <StatusBadge status={s.status} />
          </dd>
        </div>
        <div>
          <dt>Horário</dt>
          <dd>{formatDateTime(order.submittedAt)}</dd>
        </div>
        <div>
          <dt>Cliente</dt>
          <dd>{order.customerName ?? "sem nome"}</dd>
        </div>
        <div>
          <dt>Atendente</dt>
          <dd>{order.waiterName ?? "—"}</dd>
        </div>
        <div>
          <dt>Total original</dt>
          <dd>{formatReais(originalTotal(items))}</dd>
        </div>
        <div>
          <dt>Total atual</dt>
          <dd>
            <strong>{formatReais(currentTotal(items))}</strong>
          </dd>
        </div>
      </dl>

      {error && <div className="form-error">{error}</div>}
      {loading && !detail && <p className="muted">Carregando itens…</p>}

      <ul className="ob-detail-items">
        {items.map((item) => {
          const active = activeQty(item);
          const fully = active === 0;
          const detailed = detail?.items.find((d) => d.id === item.id);
          return (
            <li key={item.id} className={fully ? "ob-detail-item ob-detail-cancelled" : "ob-detail-item"}>
              <div className="ob-detail-head">
                <span className="ob-detail-name">
                  {item.quantity}× {item.name}
                </span>
                <span className="ob-detail-price">{formatReais(item.unitPrice * active)}</span>
              </div>
              {detailed && <ModifierLines modifiers={detailed.modifiers} />}
              {detailed?.notes && <div className="ob-note">Obs: {detailed.notes}</div>}
              <div className="ob-detail-state">
                {item.sector && <span className="ob-chip">{item.sector}</span>}
                <span className={`ob-prod ob-prod-${fully ? "cancelled" : item.productionStatus}`}>
                  {fully ? "Cancelado" : PRODUCTION_LABEL[item.productionStatus]}
                </span>
                {item.cancelledQuantity > 0 && !fully && (
                  <span className="ob-cancel-sum">
                    {item.cancelledQuantity} {item.cancelledQuantity === 1 ? "cancelado" : "cancelados"} · {active} {active === 1 ? "ativo" : "ativos"}
                  </span>
                )}
              </div>
              {detailed?.cancellations.map((c, index) => (
                <div key={index} className="ob-cancel-line">
                  {c.quantity}× cancelado — {c.reason}
                  {c.byName ? ` (${c.byName})` : ""}
                </div>
              ))}
            </li>
          );
        })}
      </ul>

      <div className="modal-actions">
        <button className="btn-secondary" type="button" onClick={onClose}>
          Fechar
        </button>
        {canOpenAttendance(order) && (
          <button className="btn-primary btn-auto" type="button" onClick={onOpenAttendance}>
            Abrir atendimento
          </button>
        )}
      </div>
    </Modal>
  );
}

// Histórico operacional de pedidos enviados (consulta): período, status, busca, filtros, detalhe sob
// demanda e Realtime. Não altera nada (nem produção, nem cancelamento).
export function OrdersBoard({ source = supabaseOrdersBoardApi }: { source?: OrdersBoardApi }) {
  const navigate = useNavigate();
  const { activeMembership } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const role = activeMembership?.role ?? null;

  const [state, setState] = useState<BoardState | null>(null);
  const [filters, setFilters] = useState<BoardFilters>(NO_FILTERS);
  const [sort, setSort] = useState<SortKey>("newest");
  const controller = useRef<ReturnType<typeof createBoardController> | null>(null);

  const [selected, setSelected] = useState<BoardOrder | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const detailSeq = useRef(0);
  const selectedId = useRef<string | null>(null);

  useEffect(() => {
    if (!companyId) return;
    const c = createBoardController({ source, companyId, onChange: setState });
    controller.current = c;
    void c.init();
    return () => {
      c.dispose();
      controller.current = null;
    };
  }, [companyId, source]);

  // Detalhe sob demanda (só do pedido aberto); só a resposta MAIS NOVA vale.
  const loadDetail = useCallback(
    async (orderId: string) => {
      const seq = ++detailSeq.current;
      setDetailLoading(true);
      const result = await source.loadDetail(orderId);
      if (seq !== detailSeq.current) return;
      setDetailLoading(false);
      setDetailError(result.error);
      if (result.data) setDetail(result.data);
    },
    [source],
  );

  // Realtime (sem polling): recarrega a cabeça (só se o período inclui hoje) e, se há detalhe aberto, ele.
  useEffect(() => {
    if (!companyId || !source.subscribe) return;
    const run = createCoalescedRunner(async () => {
      await controller.current?.onRealtime();
      if (selectedId.current) await loadDetail(selectedId.current);
    });
    return source.subscribe(companyId, run);
  }, [companyId, source, loadDetail]);

  // Ao voltar para a aba: recarrega a cabeça (coalescido; sem tempestade de requisições).
  useEffect(() => {
    const run = createCoalescedRunner(async () => {
      await controller.current?.onVisible();
    });
    function onVisibility() {
      if (document.visibilityState === "visible") run();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  function openDetails(order: BoardOrder) {
    selectedId.current = order.id;
    setSelected(order);
    setDetail(null);
    setDetailError(null);
    void loadDetail(order.id);
  }

  function closeDetails() {
    selectedId.current = null;
    detailSeq.current += 1;
    setSelected(null);
    setDetail(null);
    setDetailLoading(false);
  }

  const orders = useMemo(() => state?.orders ?? [], [state?.orders]);
  const counts = useMemo(() => countOrders(orders), [orders]);
  const sectors = useMemo(() => sectorOptions(orders), [orders]);
  const waiters = useMemo(() => waiterOptions(orders), [orders]);
  const shown = useMemo(() => sortOrders(filterOrders(orders, filters), sort), [orders, filters, sort]);
  // Cabeçalho por dia só faz sentido na ordem por data; em "Maior valor" a lista é corrida (sem repetir o mesmo dia).
  const groups = useMemo(() => (state && shouldGroupByDay(state.range, sort) ? groupByDay(shown) : null), [shown, state, sort]);

  const patch = (p: Partial<BoardFilters>) => setFilters((f) => ({ ...f, ...p }));
  const plus = state?.hasMore ? "+" : "";

  let content;
  if (!state || (state.loading && state.orders === null)) {
    content = <p className="op-state">Carregando pedidos…</p>;
  } else if (state.rangeError) {
    content = null;
  } else if (state.orders === null) {
    content = (
      <div className="op-state">
        <button className="btn-secondary" type="button" onClick={() => void controller.current?.refresh()}>
          Tentar de novo
        </button>
      </div>
    );
  } else if (state.orders.length === 0) {
    content = <p className="op-state">Nenhum pedido neste período.</p>;
  } else if (shown.length === 0) {
    content = <p className="op-state">Nada encontrado com esses filtros.</p>;
  } else if (groups) {
    content = groups.map((g, index) => (
      <div key={`${g.day}-${index}`} className="ob-day-group">
        <h4 className="ob-day">{g.label}</h4>
        <ul className="ob-grid" role="list">
          {g.orders.map((o) => (
            <OrderCard key={o.id} order={o} onDetails={openDetails} />
          ))}
        </ul>
      </div>
    ));
  } else {
    content = (
      <ul className="ob-grid" role="list">
        {shown.map((o) => (
          <OrderCard key={o.id} order={o} onDetails={openDetails} />
        ))}
      </ul>
    );
  }

  return (
    <section className="op-panel ob-board">
      {state && state.orders !== null && (
        <dl className="oa-counters ob-counters" aria-label="Resumo">
          <div>
            <dt>Pedidos</dt>
            <dd>
              {counts.all}
              {plus}
            </dd>
          </div>
          <div>
            <dt>Aguardando</dt>
            <dd>{counts.pending}</dd>
          </div>
          <div>
            <dt>Em produção</dt>
            <dd>{counts.preparing}</dd>
          </div>
          <div>
            <dt>Prontos</dt>
            <dd>{counts.ready}</dd>
          </div>
          <div>
            <dt>Cancelados</dt>
            <dd>{counts.cancelled}</dd>
          </div>
        </dl>
      )}

      <div className="pq-toolbar">
        <div className="pq-chips" role="group" aria-label="Período">
          {PERIODS.map((p) => (
            <button key={p} className="op-chip" type="button" aria-pressed={state?.filter === p} onClick={() => void controller.current?.setFilter(p)}>
              {PERIOD_LABEL[p]}
            </button>
          ))}
        </div>
        <button className="btn-secondary btn-small" type="button" disabled={state?.loading} onClick={() => void controller.current?.refresh()}>
          {state?.loading ? "Atualizando…" : "Atualizar"}
        </button>
      </div>

      {state?.filter === "custom" && (
        <div className="pq-custom">
          <div className="field">
            <label htmlFor="ob-from">Data inicial</label>
            <input id="ob-from" type="date" value={state.custom.from} onChange={(e) => void controller.current?.setCustom(e.target.value, state.custom.to)} />
          </div>
          <div className="field">
            <label htmlFor="ob-to">Data final</label>
            <input id="ob-to" type="date" value={state.custom.to} onChange={(e) => void controller.current?.setCustom(state.custom.from, e.target.value)} />
          </div>
          {state.rangeError && <div className="form-error">{state.rangeError}</div>}
        </div>
      )}

      <form className="op-toolbar" role="search" onSubmit={(e) => e.preventDefault()}>
        <div className="op-search">
          <input
            className="op-search-input"
            type="search"
            value={filters.query}
            placeholder={SEARCH_LABEL}
            aria-label={SEARCH_LABEL}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
            onChange={(e) => patch({ query: e.target.value })}
          />
        </div>
      </form>

      <div className="op-filters" role="group" aria-label="Situação">
        {STATUS_CHIPS.map((chip) => (
          <button key={chip.value} type="button" className="op-chip" aria-pressed={filters.status === chip.value} onClick={() => patch({ status: chip.value })}>
            {chip.label}
            {chip.value !== "all" && <span className="op-chip-count">{counts[chip.value]}</span>}
          </button>
        ))}
      </div>

      <div className="op-filters" role="group" aria-label="Filtros">
        {KIND_CHIPS.map((chip) => (
          <button key={chip.value} type="button" className="op-chip" aria-pressed={filters.kind === chip.value} onClick={() => patch({ kind: chip.value })}>
            {chip.label}
          </button>
        ))}
        <label className="oa-sort">
          <span className="oa-sort-label">Setor</span>
          <select value={filters.sector ?? ""} onChange={(e) => patch({ sector: e.target.value || null })} aria-label="Filtrar por setor">
            <option value="">Todos os setores</option>
            {sectors.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="oa-sort ob-select">
          <span className="oa-sort-label">Atendente</span>
          <select value={filters.waiter ?? ""} onChange={(e) => patch({ waiter: e.target.value || null })} aria-label="Filtrar por atendente">
            <option value="">Todos os atendentes</option>
            {waiters.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="oa-sort ob-select">
          <span className="oa-sort-label">Ordenar</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Ordenar por">
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {state?.error && <div className="form-error">{state.error}</div>}

      {content}

      {state?.hasMore && (
        <div className="pq-more">
          <button className="btn-secondary" type="button" disabled={state.loadingMore} onClick={() => void controller.current?.loadMore()}>
            {state.loadingMore ? "Carregando…" : "Carregar mais"}
          </button>
        </div>
      )}

      {selected && (
        <DetailDialog
          order={selected}
          detail={detail}
          error={detailError}
          loading={detailLoading}
          onClose={closeDetails}
          onOpenAttendance={() => navigate(attendancePath(role, selected.sessionId))}
        />
      )}
    </section>
  );
}

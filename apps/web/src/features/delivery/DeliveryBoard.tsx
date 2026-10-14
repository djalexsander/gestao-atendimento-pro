import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../../app/useAuth";
import { formatReais } from "../../lib/money";
import { createCoalescedRunner } from "../orders/coalesce";
import { DeliveryDetail } from "./DeliveryDetail";
import { DeliveryNewOrder } from "./DeliveryNewOrder";
import { supabaseDeliverySource, type CourierOption, type DeliverySource } from "./deliveryApi";
import {
  DEFAULT_FILTERS,
  FULFILLMENT_LABEL,
  METHOD_LABEL,
  SECTION_ORDER,
  SECTION_TITLE,
  applyLocalFilters,
  etaOf,
  formatTime,
  groupBySection,
  isOperator,
  shortId,
  stateLabel,
  validatePeriod,
  periodDates,
  type DeliveryFilters,
  type DeliveryRow,
  type LogisticStatus,
} from "./deliveryLogic";

const STATUS_FILTERS: Array<{ value: LogisticStatus | "all"; label: string }> = [
  { value: "all", label: "Todos os estados" },
  { value: "confirmed", label: "Confirmados" },
  { value: "out_for_delivery", label: "Em rota" },
  { value: "delivered", label: "Entregues" },
  { value: "picked_up", label: "Retirados" },
  { value: "canceled", label: "Cancelados" },
];

function DeliveryCard({ row, isCourier, onOpen }: { row: DeliveryRow; isCourier: boolean; onOpen: () => void }) {
  const eta = etaOf(row);
  return (
    <li>
      <button type="button" className={`dl-card dl-card-${row.status}`} onClick={onOpen}>
        <span className="dl-card-top">
          <span className={`dl-badge dl-badge-${row.fulfillment}`}>{FULFILLMENT_LABEL[row.fulfillment]}</span>
          <span className="dl-card-id">#{shortId(row.id)}</span>
          <span className="dl-card-time">{formatTime(row.createdAt)}</span>
        </span>
        <span className="dl-card-name">{row.customerName}</span>
        {row.fulfillment === "delivery" && row.address?.neighborhood && <span className="dl-card-line">{row.address.neighborhood}</span>}
        <span className="dl-card-line">
          <span className={`dl-badge dl-badge-state dl-state-${row.status}${row.status === "confirmed" && row.production === "ready" ? " dl-state-ready" : ""}`}>
            {stateLabel(row)}
          </span>
          {eta && row.status === "confirmed" && <span className="dl-card-eta">até {formatTime(eta)}</span>}
        </span>
        <span className="dl-card-line dl-card-foot">
          <strong>{formatReais(row.total)}</strong>
          <span className="muted">{row.expectedMethod ? METHOD_LABEL[row.expectedMethod] : row.paymentTiming === "on_order" ? "Pago" : "A receber"}</span>
        </span>
        {!isCourier && row.fulfillment === "delivery" && (
          <span className="dl-card-line muted">{row.courierName ?? "Sem entregador"}</span>
        )}
      </button>
    </li>
  );
}

// Delivery / Retirada: quadro por situação (produção derivada dos itens + estado logístico), em tempo real.
// Mesma tela para o entregador: o BANCO já devolve só os pedidos atribuídos a ele (RLS + list_delivery_orders).
export function DeliveryBoard({ source = supabaseDeliverySource }: { source?: DeliverySource }) {
  const { activeMembership, user } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const role = activeMembership?.role ?? null;
  const userId = user?.id ?? null;
  const isCourier = role === "courier";
  const canCreate = isOperator(role);

  const [filters, setFilters] = useState<DeliveryFilters>(DEFAULT_FILTERS);
  const [rows, setRows] = useState<DeliveryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [couriers, setCouriers] = useState<CourierOption[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const known = useRef<Set<string> | null>(null);

  const periodError = filters.preset === "range" ? validatePeriod(filters.range) : null;

  const load = useCallback(async () => {
    if (!companyId || periodError) return;
    const r = await source.list(companyId, filters);
    if (r.data) {
      // aviso discreto de pedido novo chegando em outro aparelho (o push cobre o app fechado)
      const seen = known.current;
      const fresh = r.data.filter((x) => seen && !seen.has(x.id) && x.status === "confirmed" && x.createdAt > new Date(Date.now() - 120000).toISOString());
      known.current = new Set(r.data.map((x) => x.id));
      if (fresh.length > 0) setNotice(`${fresh.length === 1 ? "Novo pedido" : `${fresh.length} novos pedidos`}: ${fresh[0].customerName}`);
      setRows(r.data);
      setError(null);
    } else {
      setError(r.error);
    }
  }, [companyId, filters, source, periodError]);

  const requestLoad = useMemo(() => createCoalescedRunner(load), [load]);

  useEffect(() => {
    known.current = null;
    void requestLoad();
  }, [requestLoad]);

  // Realtime (sem polling): pedido novo, estado, entregador, produção dos itens e fechamento.
  useEffect(() => {
    if (!companyId) return;
    return source.subscribe(companyId, () => requestLoad());
  }, [companyId, source, requestLoad]);

  // Fallback barato ao voltar o foco.
  useEffect(() => {
    function refresh() {
      if (document.visibilityState === "visible") requestLoad();
    }
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [requestLoad]);

  useEffect(() => {
    if (!companyId || !canCreate) return;
    void source.couriers(companyId).then((r) => setCouriers(r.data ?? []));
  }, [companyId, canCreate, source]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const visible = useMemo(() => applyLocalFilters(rows ?? [], filters), [rows, filters]);
  const groups = useMemo(() => groupBySection(visible), [visible]);
  const selected = rows?.find((r) => r.id === selectedId) ?? null;

  const patch = (p: Partial<DeliveryFilters>) => setFilters((f) => ({ ...f, ...p }));
  const dates = periodDates(filters.preset, filters.range);

  if (!companyId) return <p className="op-state">Selecione uma empresa.</p>;

  return (
    <div className="dl-board">
      <div className="dl-toolbar">
        <div className="dl-chips" role="group" aria-label="Período">
          {([["today", "Hoje"], ["yesterday", "Ontem"], ["range", "Período"]] as const).map(([v, l]) => (
            <button key={v} type="button" className="op-chip" aria-pressed={filters.preset === v} onClick={() => patch({ preset: v })}>{l}</button>
          ))}
        </div>
        {filters.preset === "range" && (
          <div className="dl-range">
            <input type="date" aria-label="De" value={filters.range.from} onChange={(e) => patch({ range: { ...filters.range, from: e.target.value } })} />
            <input type="date" aria-label="Até" value={filters.range.to} onChange={(e) => patch({ range: { ...filters.range, to: e.target.value } })} />
          </div>
        )}
        <input
          className="dl-search"
          type="search"
          placeholder="Buscar cliente, telefone, bairro ou nº"
          aria-label="Buscar"
          value={filters.query}
          onChange={(e) => patch({ query: e.target.value })}
        />
        <select aria-label="Tipo" value={filters.fulfillment} onChange={(e) => patch({ fulfillment: e.target.value as DeliveryFilters["fulfillment"] })}>
          <option value="all">Entrega e retirada</option>
          <option value="delivery">Só entrega</option>
          <option value="pickup">Só retirada</option>
        </select>
        <select aria-label="Estado" value={filters.status} onChange={(e) => patch({ status: e.target.value as DeliveryFilters["status"] })}>
          {STATUS_FILTERS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        {!isCourier && (
          <select aria-label="Entregador" value={filters.courierUserId} onChange={(e) => patch({ courierUserId: e.target.value })}>
            <option value="all">Todos os entregadores</option>
            <option value="none">Sem entregador</option>
            {couriers.map((c) => <option key={c.userId} value={c.userId}>{c.name}</option>)}
          </select>
        )}
        {canCreate && (
          <button type="button" className="btn-primary btn-auto dl-new-btn" onClick={() => setCreating(true)}>Novo pedido</button>
        )}
      </div>

      {notice && <div className="form-notice" role="status">{notice}</div>}
      {periodError && <div className="form-error">{periodError}</div>}
      {error && <div className="form-error" role="alert">{error} <button type="button" className="btn-secondary btn-small" onClick={() => void load()}>Tentar novamente</button></div>}
      {rows === null && !error && !periodError && <p className="op-state">Carregando pedidos…</p>}

      {rows !== null && (
        <>
          <p className="muted dl-period">
            {dates.from === dates.to ? dates.from.split("-").reverse().join("/") : `${dates.from.split("-").reverse().join("/")} a ${dates.to.split("-").reverse().join("/")}`} · {visible.length} {visible.length === 1 ? "pedido" : "pedidos"}
          </p>
          {visible.length === 0 ? (
            <p className="op-state">{isCourier ? "Nenhuma entrega atribuída a você neste período." : "Nenhum pedido neste período."}</p>
          ) : (
            <div className="dl-columns">
              {SECTION_ORDER.map((section) => (
                <section key={section} className={`dl-column dl-column-${section}`} aria-label={SECTION_TITLE[section]}>
                  <h3 className="dl-column-title">
                    {SECTION_TITLE[section]} <span className="op-chip-count">{groups[section].length}</span>
                  </h3>
                  {groups[section].length === 0 ? (
                    <p className="dl-empty">—</p>
                  ) : (
                    <ul className="dl-list">
                      {groups[section].map((row) => (
                        <DeliveryCard key={row.id} row={row} isCourier={isCourier} onOpen={() => setSelectedId(row.id)} />
                      ))}
                    </ul>
                  )}
                </section>
              ))}
            </div>
          )}
        </>
      )}

      {selected && (
        <DeliveryDetail
          row={selected}
          companyId={companyId}
          role={role}
          userId={userId}
          source={source}
          onClose={() => setSelectedId(null)}
          onChanged={() => requestLoad()}
        />
      )}
      {creating && (
        <DeliveryNewOrder
          companyId={companyId}
          role={role}
          source={source}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            requestLoad();
          }}
        />
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../../app/useAuth";
import { createCoalescedRunner } from "../orders/coalesce";
import {
  supabaseProductionSource,
  type HistoryData,
  type ProductionSector,
  type ProductionSource,
  type QueueData,
} from "./productionApi";
import {
  actionsFor,
  ageMinutes,
  formatAge,
  formatDuration,
  groupByOrder,
  groupHistory,
  pointLabel,
  previousDayLabel,
  PRODUCTION_COLUMNS,
  READY_PAGE,
  readyRemaining,
  urgencyOf,
  type OrderGroup,
  type ProductionItem,
  type ProductionStatus,
} from "./productionLogic";

const timeOnly = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const hhmm = (iso: string) => timeOnly.format(new Date(iso));

function OrderCard({
  group,
  status,
  now,
  today,
  showSector,
  busyId,
  onAction,
}: {
  group: OrderGroup;
  status: ProductionStatus;
  now: number;
  today: string | null;
  showSector: boolean;
  busyId: string | null;
  onAction: (item: ProductionItem, to: "preparing" | "ready") => void;
}) {
  const minutes = ageMinutes(group.submittedAt, now);
  const urgency = status === "ready" ? "normal" : urgencyOf(minutes);
  const readyAt = status === "ready" ? group.items.reduce<string | null>((latest, i) => (i.readyAt && (!latest || i.readyAt > latest) ? i.readyAt : latest), null) : null;
  const previous = status === "ready" ? null : previousDayLabel(today, group.submittedDate);

  return (
    <li className={`kds-card kds-${urgency}`}>
      <div className="kds-card-head">
        <strong className="kds-card-title">{pointLabel(group)}</strong>
        <span className="kds-age" title={`Pedido às ${hhmm(group.submittedAt)}`}>
          {status === "ready" && readyAt ? `Pronto ${formatAge(ageMinutes(readyAt, now))}` : formatAge(minutes)}
        </span>
      </div>
      {previous && (
        <p className="kds-previous" role="note">
          ⚠ {previous} · enviado às {hhmm(group.submittedAt)}
        </p>
      )}
      <p className="kds-card-meta">
        Pedido {hhmm(group.submittedAt)}
        {group.customerName ? ` · ${group.customerName}` : ""}
        {group.sentByName ? ` · enviado por ${group.sentByName}` : ""}
      </p>
      <ul className="kds-items">
        {group.items.map((item) => (
          <li key={item.id} className="kds-item">
            <div className="kds-item-line">
              <span className="kds-qty">{item.quantity}×</span>
              <span className="kds-name">{item.name}</span>
              {showSector && <span className="kds-sector">{item.sectorName ?? "Sem setor"}</span>}
            </div>
            {item.notes && <p className="kds-notes">Obs.: {item.notes}</p>}
            {status === "ready" ? (
              item.readyAt && <p className="kds-card-meta">Pronto às {hhmm(item.readyAt)}</p>
            ) : (
              <div className="kds-actions">
                {actionsFor(item.status).map((action) => (
                  <button
                    key={action.to}
                    type="button"
                    className={action.to === "ready" ? "btn-primary btn-auto kds-btn" : "btn-secondary kds-btn"}
                    disabled={busyId === item.id}
                    onClick={() => onAction(item, action.to)}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </li>
  );
}

// Fila OPERACIONAL: pendentes e em preparo (de qualquer dia, com aviso de "pedido de ontem") e os
// prontos de HOJE (os mais recentes; "Mostrar mais" pede mais ao servidor). Tempo real por
// Realtime (service_order_items), sem polling: o relógio dos cards re-renderiza uma vez por minuto
// e nunca consulta o banco. Foco/visibilidade recarregam como fallback.
function QueueView({
  companyId,
  sectorId,
  source,
}: {
  companyId: string;
  sectorId: string | null;
  source: ProductionSource;
}) {
  const [queue, setQueue] = useState<QueueData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [readyLimit, setReadyLimit] = useState(READY_PAGE);
  const [now, setNow] = useState(() => Date.now());
  const requestId = useRef(0);

  // Trocar de setor volta ao limite inicial de prontos.
  useEffect(() => {
    setReadyLimit(READY_PAGE);
  }, [sectorId]);

  // Só a resposta MAIS NOVA vale (eventos e cliques podem se cruzar).
  const reload = useCallback(async () => {
    const current = ++requestId.current;
    const result = await source.loadQueue(companyId, sectorId, readyLimit);
    if (current !== requestId.current) return;
    if (result.error || !result.data) {
      setError(result.error ?? "Não foi possível carregar a produção.");
      return;
    }
    setError(null);
    setQueue(result.data);
  }, [companyId, sectorId, readyLimit, source]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Realtime só da operação atual: um evento recarrega (coalescido: no máximo 1 busca em andamento
  // + 1 pendente). O banco é a fonte da verdade — o payload não altera os cards.
  useEffect(() => {
    const scheduleReload = createCoalescedRunner(reload);
    return source.subscribe(companyId, scheduleReload);
  }, [companyId, source, reload]);

  useEffect(() => {
    function refreshWhenVisible() {
      if (document.visibilityState === "visible") void reload();
    }
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => document.removeEventListener("visibilitychange", refreshWhenVisible);
  }, [reload]);

  // Só o RELÓGIO dos cards (tempo decorrido): re-render local a cada minuto, sem tocar no banco.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);

  async function handleAction(item: ProductionItem, to: "preparing" | "ready") {
    if (busyId) return;
    setActionError(null);
    setBusyId(item.id);
    const result = await source.updateStatus(item.id, to);
    setBusyId(null);
    if (result.error) setActionError(result.error);
    void reload(); // com erro (ex.: outro aparelho chegou antes) ou sem, mostra o estado real
  }

  const items = queue?.items ?? null;
  const columns = useMemo(
    () => PRODUCTION_COLUMNS.map((col) => ({ ...col, groups: groupByOrder(items ?? [], col.status) })),
    [items],
  );
  const shownReady = (items ?? []).filter((i) => i.status === "ready").length;
  const readyTotal = queue?.readyTotal ?? 0;
  const remaining = readyRemaining(readyTotal, shownReady);
  const activeCount = (items ?? []).filter((i) => i.status !== "ready").length;

  return (
    <>
      <p className="kds-count">{items ? `${activeCount} ${activeCount === 1 ? "item na fila" : "itens na fila"}` : ""}</p>
      {error && <div className="form-error">{error}</div>}
      {actionError && (
        <div className="form-error" role="alert">
          {actionError}
        </div>
      )}
      {!items && !error && <p className="op-state">Carregando…</p>}

      {items && (
        <div className="kds-board">
          {columns.map((col) => {
            const isReady = col.status === "ready";
            const count = isReady ? readyTotal : col.groups.reduce((n, g) => n + g.items.length, 0);
            return (
              <section key={col.status} className={`kds-column kds-column-${col.status}`} aria-label={col.title}>
                <h3 className="kds-column-title">
                  {isReady ? "Prontos de hoje" : col.title} <span className="kds-column-count">{count}</span>
                </h3>
                {col.groups.length === 0 ? (
                  <p className="kds-empty">{isReady ? "Nenhum item pronto hoje." : "Nada por aqui."}</p>
                ) : (
                  <ul className="kds-list">
                    {col.groups.map((group) => (
                      <OrderCard
                        key={`${group.orderId}:${col.status}`}
                        group={group}
                        status={col.status}
                        now={now}
                        today={queue?.today ?? null}
                        showSector={sectorId === null}
                        busyId={busyId}
                        onAction={(item, to) => void handleAction(item, to)}
                      />
                    ))}
                  </ul>
                )}
                {isReady && (remaining > 0 || readyLimit > READY_PAGE) && (
                  <div className="kds-more">
                    {remaining > 0 && (
                      <button type="button" className="btn-secondary btn-small" onClick={() => setReadyLimit((n) => n + READY_PAGE)}>
                        Mostrar mais ({remaining} restantes)
                      </button>
                    )}
                    {readyLimit > READY_PAGE && (
                      <button type="button" className="btn-secondary btn-small" onClick={() => setReadyLimit(READY_PAGE)}>
                        Mostrar menos
                      </button>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

function shiftDate(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return next.toISOString().slice(0, 10);
}

// Histórico de UMA data: itens concluídos naquele dia (agrupados por pedido) + resumo. Sem
// Realtime: dias anteriores não mudam. Uma consulta por data — nunca carrega meses.
function HistoryView({
  companyId,
  sectorId,
  source,
  today,
}: {
  companyId: string;
  sectorId: string | null;
  source: ProductionSource;
  today: string;
}) {
  const [date, setDate] = useState(today);
  const [data, setData] = useState<HistoryData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    setData(null);
    void source.loadHistory(companyId, date, sectorId).then((result) => {
      if (cancelled) return;
      if (result.error || !result.data) {
        setError(result.error ?? "Não foi possível carregar o histórico.");
        return;
      }
      setError(null);
      setData(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [companyId, date, sectorId, source]);

  const orders = useMemo(() => groupHistory(data?.items ?? []), [data]);
  const summary = data?.summary ?? null;
  const dateLabel = date ? new Date(`${date}T12:00:00`).toLocaleDateString("pt-BR") : "";

  return (
    <>
      <div className="kds-history-date">
        <button type="button" className="btn-secondary btn-small" onClick={() => date && setDate(shiftDate(date, -1))}>
          ← Dia anterior
        </button>
        <div className="field">
          <label htmlFor="kds-history-date">Data</label>
          <input id="kds-history-date" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
        </div>
        <button
          type="button"
          className="btn-secondary btn-small"
          disabled={!date || date >= today}
          onClick={() => date && setDate(shiftDate(date, 1))}
        >
          Dia seguinte →
        </button>
      </div>

      {error && <div className="form-error">{error}</div>}
      {!data && !error && <p className="op-state">Carregando…</p>}

      {data && summary && (
        <>
          <dl className="cash-summary kds-summary">
            <div>
              <dt>Produzidos</dt>
              <dd>{summary.items} {summary.items === 1 ? "item" : "itens"}</dd>
            </div>
            <div>
              <dt>Pedidos</dt>
              <dd>{summary.orders}</dd>
            </div>
            <div>
              <dt>Tempo médio de produção</dt>
              <dd>{summary.avgMinutes === null ? "—" : formatDuration(summary.avgMinutes)}</dd>
            </div>
            {summary.bySector.map((s) => (
              <div key={s.name}>
                <dt>{s.name}</dt>
                <dd>{s.items}</dd>
              </div>
            ))}
          </dl>

          {orders.length === 0 ? (
            <p className="kds-empty">Nenhum item concluído em {dateLabel}.</p>
          ) : (
            <ul className="kds-history-list">
              {orders.map((order) => (
                <li key={order.orderId} className="kds-card">
                  <div className="kds-card-head">
                    <strong className="kds-card-title">{pointLabel(order)}</strong>
                    <span className="kds-age">{hhmm(order.submittedAt)}</span>
                  </div>
                  {order.customerName && <p className="kds-card-meta">{order.customerName}</p>}
                  <ul className="kds-items">
                    {order.items.map((item) => (
                      <li key={item.id} className="kds-item">
                        <div className="kds-item-line">
                          <span className="kds-qty">{item.quantity}×</span>
                          <span className="kds-name">{item.name}</span>
                          {item.sectorName && <span className="kds-sector">{item.sectorName}</span>}
                        </div>
                        {item.notes && <p className="kds-notes">Obs.: {item.notes}</p>}
                        <p className="kds-card-meta">
                          Pronto às {hhmm(item.readyAt)} · Tempo de produção: {formatDuration(item.minutes)}
                        </p>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          {summary.items > data.items.length && (
            <p className="field-hint">Mostrando os {data.items.length} itens mais recentes de {summary.items}. Use o filtro de setor para refinar.</p>
          )}
        </>
      )}
    </>
  );
}

// Produção / Cozinha (KDS): aba "Produção" (fila operacional atual) e aba "Histórico" (por data),
// com o filtro de setor compartilhado. Nada é apagado: o histórico só consulta por data.
export function ProductionBoard({ source = supabaseProductionSource }: { source?: ProductionSource }) {
  const { activeMembership } = useAuth();
  const companyId = activeMembership?.companyId ?? null;

  const [tab, setTab] = useState<"queue" | "history">("queue");
  const [sectors, setSectors] = useState<ProductionSector[] | null>(null);
  const [sectorId, setSectorId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Dia do servidor (America/Sao_Paulo), aprendido pela fila; até lá, o dia local só como ponto de partida.
  const [today, setToday] = useState(() => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10));
  const autoPicked = useRef(false);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    void source.listSectors(companyId).then((result) => {
      if (cancelled) return;
      if (result.error || !result.data) {
        setError(result.error);
        return;
      }
      setSectors(result.data);
      // Um único setor ativo: já vem selecionado.
      if (result.data.length === 1 && !autoPicked.current) {
        autoPicked.current = true;
        setSectorId(result.data[0].id);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [companyId, source]);

  // O "hoje" do servidor: uma chamada leve (0 prontos) ao abrir, independente do setor.
  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    void source.loadQueue(companyId, null, 0).then((result) => {
      if (!cancelled && result.data) setToday(result.data.today);
    });
    return () => {
      cancelled = true;
    };
  }, [companyId, source]);

  if (!companyId) return null;

  return (
    <div className="kds">
      <div className="tab-bar" role="tablist" aria-label="Produção">
        <button role="tab" type="button" aria-selected={tab === "queue"} className={tab === "queue" ? "tab tab-active" : "tab"} onClick={() => setTab("queue")}>
          Produção
        </button>
        <button role="tab" type="button" aria-selected={tab === "history"} className={tab === "history" ? "tab tab-active" : "tab"} onClick={() => setTab("history")}>
          Histórico
        </button>
      </div>

      <div className="kds-toolbar">
        <div className="kds-sectors" role="group" aria-label="Setor">
          <span className="kds-sectors-label">Setor</span>
          <button type="button" className="op-chip" aria-pressed={sectorId === null} onClick={() => setSectorId(null)}>
            Todos
          </button>
          {(sectors ?? []).map((s) => (
            <button key={s.id} type="button" className="op-chip" aria-pressed={sectorId === s.id} onClick={() => setSectorId(s.id)}>
              {s.name}
            </button>
          ))}
        </div>
      </div>
      {error && <div className="form-error">{error}</div>}

      {tab === "queue" ? (
        <QueueView companyId={companyId} sectorId={sectorId} source={source} />
      ) : (
        <HistoryView companyId={companyId} sectorId={sectorId} source={source} today={today} />
      )}
    </div>
  );
}

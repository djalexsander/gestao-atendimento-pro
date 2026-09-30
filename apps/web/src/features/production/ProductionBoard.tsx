import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../../app/useAuth";
import { createCoalescedRunner } from "../orders/coalesce";
import { supabaseProductionSource, type ProductionSector, type ProductionSource } from "./productionApi";
import {
  actionsFor,
  ageMinutes,
  formatAge,
  groupByOrder,
  pointLabel,
  PRODUCTION_COLUMNS,
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
  showSector,
  busyId,
  onAction,
}: {
  group: OrderGroup;
  status: ProductionStatus;
  now: number;
  showSector: boolean;
  busyId: string | null;
  onAction: (item: ProductionItem, to: "preparing" | "ready") => void;
}) {
  const minutes = ageMinutes(group.submittedAt, now);
  const urgency = status === "ready" ? "normal" : urgencyOf(minutes);
  const readyAt = status === "ready" ? group.items.reduce<string | null>((latest, i) => (i.readyAt && (!latest || i.readyAt > latest) ? i.readyAt : latest), null) : null;

  return (
    <li className={`kds-card kds-${urgency}`}>
      <div className="kds-card-head">
        <strong className="kds-card-title">{pointLabel(group)}</strong>
        <span className="kds-age" title={`Pedido às ${hhmm(group.submittedAt)}`}>
          {status === "ready" && readyAt ? `Pronto ${formatAge(ageMinutes(readyAt, now))}` : formatAge(minutes)}
        </span>
      </div>
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

// Produção / Cozinha (KDS): pendentes, em preparo e prontos recentes por setor. O status é POR
// ITEM (um pedido pode ter o Bar pronto e a Cozinha em preparo). Tempo real por Realtime
// (service_order_items), sem polling: o relógio dos cards só re-renderiza uma vez por minuto,
// nunca consulta o banco. Foco/visibilidade recarregam como fallback.
export function ProductionBoard({ source = supabaseProductionSource }: { source?: ProductionSource }) {
  const { activeMembership } = useAuth();
  const companyId = activeMembership?.companyId ?? null;

  const [sectors, setSectors] = useState<ProductionSector[] | null>(null);
  const [sectorId, setSectorId] = useState<string | null>(null);
  const [items, setItems] = useState<ProductionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const requestId = useRef(0);
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

  // Só a resposta MAIS NOVA vale (eventos e cliques podem se cruzar).
  const reload = useCallback(async () => {
    if (!companyId) return;
    const current = ++requestId.current;
    const result = await source.loadQueue(companyId, sectorId);
    if (current !== requestId.current) return;
    if (result.error || !result.data) {
      setError(result.error ?? "Não foi possível carregar a produção.");
      return;
    }
    setError(null);
    setItems(result.data);
  }, [companyId, sectorId, source]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Realtime: uma assinatura por empresa; cada evento recarrega (coalescido: no máximo 1 busca
  // em andamento + 1 pendente). O banco é a fonte da verdade — o payload não altera os cards.
  useEffect(() => {
    if (!companyId) return;
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

  const columns = useMemo(
    () => PRODUCTION_COLUMNS.map((col) => ({ ...col, groups: groupByOrder(items ?? [], col.status) })),
    [items],
  );
  const showSector = sectorId === null;
  const activeCount = (items ?? []).filter((i) => i.status !== "ready").length;

  return (
    <div className="kds">
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
        <span className="kds-count">{items ? `${activeCount} ${activeCount === 1 ? "item na fila" : "itens na fila"}` : ""}</span>
      </div>

      {error && <div className="form-error">{error}</div>}
      {actionError && (
        <div className="form-error" role="alert">
          {actionError}
        </div>
      )}
      {!items && !error && <p className="op-state">Carregando…</p>}

      {items && (
        <div className="kds-board">
          {columns.map((col) => (
            <section key={col.status} className={`kds-column kds-column-${col.status}`} aria-label={col.title}>
              <h3 className="kds-column-title">
                {col.title} <span className="kds-column-count">{col.groups.reduce((n, g) => n + g.items.length, 0)}</span>
              </h3>
              {col.groups.length === 0 ? (
                <p className="kds-empty">{col.status === "ready" ? "Nenhum item pronto na última hora." : "Nada por aqui."}</p>
              ) : (
                <ul className="kds-list">
                  {col.groups.map((group) => (
                    <OrderCard
                      key={`${group.orderId}:${col.status}`}
                      group={group}
                      status={col.status}
                      now={now}
                      showSector={showSector}
                      busyId={busyId}
                      onAction={(item, to) => void handleAction(item, to)}
                    />
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { OPERATIONAL_PATH } from "../../app/accessRules";
import { useAuth } from "../../app/useAuth";
import { supabaseServicePanelSource, type ServicePanelSource } from "./api";
import { createCoalescedRunner } from "../orders/coalesce";
import { CAN_ALWAYS_CREATE_CUSTOMER } from "../system/systemLogic";
import { useOperationalPreferences } from "../system/useOperationalPreferences";
import { OpenSessionDialog } from "./PointDialogs";
import { CourierSettlementPanel } from "./CourierSettlementPanel";
import { cashPendingCount, pendingSettlementCount, type CashPending, type SettlementGroup } from "./courierSettlement";
import { OpenCashDialog } from "../cash/CashDialogs";
import { supabaseCashSource, type CashSource } from "../cash/cashApi";
import {
  VIEW_LABEL,
  VIEW_ORDER,
  expectedMethodLabel,
  filterReceivables,
  financialLabel,
  financialTone,
  isOverdueToCollect,
  operationalLabel,
  pendingCount,
  receivableTitle,
  resolveReceivableScan,
  type CashierView,
  type DeliveryReceivable,
} from "./deliveryReceivables";
import { formatReais } from "../../lib/money";
import {
  countByStatus,
  filterPoints,
  formatOpenedShort,
  resolveScan,
  sortPoints,
  statusOf,
  STATUS_LABEL,
  TYPE_LABEL,
  type OpenSession,
  type ServicePanelData,
  type ServicePoint,
  type ServicePointType,
  type StatusFilter,
  type TypeFilter,
} from "./panel";

const SEARCH_LABEL = "Buscar comanda, mesa, cliente ou código de barras";

const STATUS_CHIPS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "free", label: "Livres" },
  { value: "busy", label: "Em atendimento" },
];

const TYPE_CHIPS: ServicePointType[] = ["command", "table"];

const EMPTY_TEXT = {
  command: "Nenhuma comanda cadastrada ainda. Peça ao administrador para cadastrar.",
  table: "Nenhuma mesa cadastrada ainda. Peça ao administrador para cadastrar.",
  both: "Nenhuma comanda ou mesa cadastrada ainda. Peça ao administrador para cadastrar.",
} as const;

type OpenDialog = { kind: "open"; point: ServicePoint };

// Card de delivery/retirada no Caixa: tipo + código curto, cliente, situação operacional e FINANCEIRA, total e forma pretendida.
function DeliveryCard({ item, onSelect }: { item: DeliveryReceivable; onSelect: (item: DeliveryReceivable) => void }) {
  const method = expectedMethodLabel(item);
  const overdue = isOverdueToCollect(item);
  const label = [receivableTitle(item), item.customerName, operationalLabel(item), financialLabel(item), formatReais(item.total)].join(", ");
  return (
    <li>
      <button
        type="button"
        className={`op-card op-card-delivery op-card-fin-${item.financialStatus}${overdue ? " op-card-overdue" : ""}`}
        aria-label={label}
        data-testid="delivery-card"
        onClick={() => onSelect(item)}
      >
        <span className="op-card-head">
          <span className="op-card-title">{receivableTitle(item)}</span>
        </span>
        <span className="op-card-line">{item.customerName}</span>
        <span className="op-card-line">
          <span className={`status-badge dl-state-${item.status}`}>{operationalLabel(item)}</span>
          <span className={`op-fin op-fin-${financialTone(item)}`}>{financialLabel(item)}</span>
        </span>
        <span className="op-card-line op-card-total">
          <strong>{formatReais(item.total)}</strong>
          {method && <span className="op-card-muted"> · {method}</span>}
          {item.cashChangeFor !== null && item.financialStatus === "pending" && <span className="op-card-muted"> · troco p/ {formatReais(item.cashChangeFor)}</span>}
        </span>
      </button>
    </li>
  );
}

function PointCard({ point, showCustomer, onSelect }: { point: ServicePoint; showCustomer: boolean; onSelect: (point: ServicePoint) => void }) {
  const status = statusOf(point);
  const session = point.open_session;
  const label = [
    point.display_name,
    STATUS_LABEL[status],
    session && showCustomer ? `cliente ${session.customer_name ?? "sem nome"}` : "",
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <li>
      <button
        type="button"
        className={`op-card op-card-${status}`}
        aria-label={label}
        aria-disabled={status === "inactive"}
        onClick={() => onSelect(point)}
      >
        <span className="op-card-head">
          <span className="op-card-title">{point.display_name}</span>
          <span className="op-card-code">{point.code}</span>
        </span>
        <span className={`status-badge status-${status}`}>{STATUS_LABEL[status]}</span>
        {session && (
          <>
            {showCustomer && <span className="op-card-line">Cliente: {session.customer_name ?? "sem nome"}</span>}
            <span className="op-card-line op-card-muted">{formatOpenedShort(session.opened_at)}</span>
          </>
        )}
      </button>
    </li>
  );
}

// Painel de Comandas / Mesas: o MESMO componente serve às duas áreas operacionais (Atendimento
// e Caixa / Balcão). `variant` só muda a ênfase da busca; as ações são as mesmas por enquanto.
export function ServicePointsPanel({
  variant,
  source = supabaseServicePanelSource,
  cashSource = supabaseCashSource,
}: {
  variant: "attendant" | "cashier";
  source?: ServicePanelSource;
  cashSource?: CashSource;
}) {
  const navigate = useNavigate();
  const { activeMembership, profile } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const myName = profile?.full_name ?? null;
  const area = variant === "attendant" ? "atendimento" : "caixa";

  const [data, setData] = useState<ServicePanelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [typeChoice, setTypeChoice] = useState<TypeFilter>(null);
  // Caixa: delivery/retirada junto das comandas/mesas (a mesma conta, o mesmo fechamento oficial)
  const [view, setView] = useState<CashierView>("all");
  const [receivables, setReceivables] = useState<DeliveryReceivable[] | null>(null);
  const [receivablesHidden, setReceivablesHidden] = useState(true);
  const [receivablesError, setReceivablesError] = useState<string | null>(null);
  // Acerto de entregadores (custódia): fila por entregador; some em silêncio para quem não pode ver
  const [settlements, setSettlements] = useState<SettlementGroup[] | null>(null);
  const [settlementsHidden, setSettlementsHidden] = useState(true);
  // Pendências do troco (adiantamento a devolver / diferenças em aberto): ficam visíveis até a regularização
  const [cashPending, setCashPending] = useState<CashPending | null>(null);
  const [openCashFor, setOpenCashFor] = useState(false);
  const { prefs, loaded: prefsLoaded } = useOperationalPreferences(companyId);
  const typeInitialized = useRef(false);
  const allowQuick = prefs.allowQuickCustomerCreate || CAN_ALWAYS_CREATE_CUSTOMER.includes(activeMembership?.role ?? "");
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  // Caixa num computador (mouse): a busca abre com o foco e o recupera depois de cada ação,
  // pronta para o leitor de código de barras. No celular não abre o teclado sozinha.
  const [keepSearchFocused] = useState(
    () => variant === "cashier" && window.matchMedia("(pointer: fine)").matches,
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);

  // Uma única chamada traz modo + pontos + atendimento aberto. Só a resposta MAIS NOVA vale.
  const reload = useCallback(async (): Promise<ServicePanelData | null> => {
    if (!companyId) return null;
    const current = ++requestId.current;
    setRefreshing(true);
    const wantsDelivery = variant === "cashier" && !!source.loadReceivables;
    const [result, rec, set, pend] = await Promise.all([
      source.load(companyId),
      wantsDelivery ? source.loadReceivables!(companyId) : Promise.resolve(null),
      wantsDelivery && source.loadSettlements ? source.loadSettlements(companyId) : Promise.resolve(null),
      wantsDelivery && source.loadCashPending ? source.loadCashPending(companyId) : Promise.resolve(null),
    ]);
    if (current !== requestId.current) return result.data;
    if (pend) setCashPending(pend.data ?? null);
    if (set) {
      setSettlementsHidden(set.hidden);
      if (set.data) setSettlements(set.data);
    }
    if (rec) {
      setReceivablesHidden(rec.hidden);
      setReceivablesError(rec.error);
      if (rec.data) setReceivables(rec.data);
    }
    setRefreshing(false);
    setLoading(false);
    if (result.error || !result.data) {
      setLoadError(result.error ?? "Não foi possível carregar as comandas e mesas.");
      return null;
    }
    setLoadError(null);
    setData(result.data);
    return result.data;
  }, [companyId, source, variant]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Ao voltar para a aba/aparelho, mostra o que os colegas abriram nesse meio tempo.
  useEffect(() => {
    function refreshWhenVisible() {
      if (document.visibilityState === "visible") void reload();
    }
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => document.removeEventListener("visibilitychange", refreshWhenVisible);
  }, [reload]);

  // Realtime: abrir/fechar atendimento em outro aparelho recarrega a lista (o banco é a fonte da
  // verdade; o evento não altera cards). Coalescido: no máximo 1 busca em andamento + 1 pendente.
  // Uma assinatura por empresa; removida ao desmontar ou trocar de empresa.
  useEffect(() => {
    if (!companyId || !source.subscribe) return;
    const scheduleReload = createCoalescedRunner(reload);
    return source.subscribe(companyId, scheduleReload);
  }, [companyId, source, reload]);

  const points = useMemo(() => data?.points ?? [], [data]);
  const mode = data?.service_mode ?? "command";

  // Preferência "ao abrir o painel": só no modo Comandas e mesas, uma vez, sem remover nenhuma opção (o filtro continua trocável).
  useEffect(() => {
    if (typeInitialized.current || !prefsLoaded || !data) return;
    typeInitialized.current = true;
    if (data.service_mode === "both" && prefs.defaultType !== "ask") setTypeChoice(prefs.defaultType);
  }, [prefsLoaded, prefs.defaultType, data]);
  const type = mode === "both" ? typeChoice : null;
  const shown = useMemo(
    () => sortPoints(filterPoints(points, { query, status, type })),
    [points, query, status, type],
  );
  const counts = useMemo(() => countByStatus(points, { query, type }), [points, query, type]);
  const showDeliverySection = variant === "cashier" && !receivablesHidden && receivables !== null;
  const effectiveView: CashierView = showDeliverySection ? (view === "settlement" && !(!settlementsHidden && settlements !== null) ? "all" : view) : "all";
  const canVoid = activeMembership?.role === "owner" || activeMembership?.role === "admin";
  const showPoints = effectiveView === "all" || effectiveView === "points";
  const settlementContent = effectiveView === "settlement" && companyId && settlements !== null ? (
    <CourierSettlementPanel companyId={companyId} groups={settlements} pending={cashPending} source={source} canVoid={canVoid} onChanged={() => void reload()} onNeedCash={() => setOpenCashFor(true)} />
  ) : null;
  const deliveryShown = useMemo(
    () => (showDeliverySection ? filterReceivables(receivables ?? [], effectiveView, query) : []),
    [showDeliverySection, receivables, effectiveView, query],
  );
  const toReceive = useMemo(() => pendingCount(receivables ?? [], query), [receivables, query]);
  const showSettlement = showDeliverySection && !settlementsHidden && settlements !== null;
  const settleCount = pendingSettlementCount(settlements ?? []) + cashPendingCount(cashPending);

  function focusSearch() {
    if (keepSearchFocused) requestAnimationFrame(() => searchRef.current?.focus());
  }

  function closeDialog() {
    setDialog(null);
    focusSearch();
  }

  // Livre abre o diálogo de abertura; em atendimento vai para a tela real do pedido; inativo só avisa.
  function openPoint(point: ServicePoint) {
    setNotice(null);
    setScanMessage(null);
    if (!point.is_active) {
      setScanMessage(`${point.display_name} está inativa. Fale com o administrador.`);
      return;
    }
    if (point.open_session) {
      navigate(`${OPERATIONAL_PATH[area]}/${point.open_session.id}`);
      return;
    }
    setDialog({ kind: "open", point });
  }

  // Delivery/retirada: abre a MESMA tela de conta do Caixa (itens, taxa, total e "Receber / Fechar conta").
  function openDelivery(item: DeliveryReceivable) {
    setNotice(null);
    setScanMessage(null);
    navigate(`${OPERATIONAL_PATH[area]}/${item.sessionId}`);
  }

  // Enter na busca (o leitor USB digita o código e manda Enter): acha o ponto na hora, sem
  // olhar os filtros. Se não achar, recarrega uma vez (pode ser um ponto recém-cadastrado).
  async function handleSearchSubmit(event: FormEvent) {
    event.preventDefault();
    const value = query.trim();
    if (!value) return;
    setNotice(null);
    setScanMessage(null);

    let target = resolveScan(points, value);
    if (!target) {
      // não é comanda/mesa: um único delivery/retirada que a busca encontra abre a conta dele
      const hit = showDeliverySection ? resolveReceivableScan(receivables ?? [], value) : null;
      if (hit) {
        setQuery("");
        openDelivery(hit);
        return;
      }
      const fresh = await reload();
      target = fresh ? resolveScan(fresh.points, value) : null;
    }
    if (!target) {
      setScanMessage(`Nenhuma comanda, mesa${showDeliverySection ? ", delivery ou retirada" : ""} encontrada para “${value}”.`);
      searchRef.current?.select(); // o próximo código lido substitui este
      return;
    }
    setQuery("");
    openPoint(target);
  }

  // Abre o atendimento e, só depois do banco confirmar, vai direto para a tela do pedido (a mesma de
  // clicar numa comanda em atendimento). O cartão já fica em atendimento no cache local, para a lista
  // estar certa quando o usuário voltar. Em falha, devolve o erro e o diálogo permanece aberto.
  const opening = useRef(false);
  async function submitOpen(point: ServicePoint, customer: string | null, customerId: string | null): Promise<string | null> {
    if (opening.current) return null; // clique/Enter repetido enquanto a abertura está em andamento
    opening.current = true;
    try {
      const result = await source.open(point.id, customer, customerId);
      if (result.error || !result.session) {
        if (result.conflict) void reload();
        return result.error ?? "Não foi possível abrir o atendimento.";
      }
      const session: OpenSession = { ...result.session, opened_by_name: result.session.opened_by_name ?? myName };
      setData((prev) =>
        prev && {
          ...prev,
          points: prev.points.map((p) => (p.id === point.id ? { ...p, open_session: session } : p)),
        },
      );
      setDialog(null);
      navigate(`${OPERATIONAL_PATH[area]}/${session.id}`);
      return null;
    } finally {
      opening.current = false;
    }
  }

  const pointsContent = (() => {
    if (!data) return null;
    if (points.length === 0) return <p className="op-state">{EMPTY_TEXT[mode]}</p>;
    if (shown.length === 0) return <p className="op-state">Nada encontrado com esses filtros.</p>;
    return (
      <ul className={prefs.compactCards ? "op-grid" : "op-grid op-grid-comfy"} role="list">
        {shown.map((point) => (
          <PointCard key={point.id} point={point} showCustomer={prefs.showCustomerOnCard} onSelect={openPoint} />
        ))}
      </ul>
    );
  })();

  let content;
  if (showDeliverySection && data) {
    const deliveryContent =
      deliveryShown.length === 0 ? (
        <p className="op-state" data-testid="delivery-empty">
          {effectiveView === "receivable" ? "Nenhuma conta de delivery ou retirada a receber." : "Nenhum delivery ou retirada encontrado."}
        </p>
      ) : (
        <ul className="op-grid op-grid-comfy" role="list" aria-label="Delivery e retirada">
          {deliveryShown.map((item) => (
            <DeliveryCard key={item.deliveryOrderId} item={item} onSelect={openDelivery} />
          ))}
        </ul>
      );
    content = (
      <>
        {settlementContent}
        {effectiveView !== "points" && effectiveView !== "all" && effectiveView !== "settlement" && deliveryContent}
        {effectiveView === "all" && (
          <>
            {deliveryShown.length > 0 && (
              <section aria-label="Delivery e retirada">
                <h3 className="op-section-title">Delivery / Retirada</h3>
                {deliveryContent}
              </section>
            )}
            <section aria-label="Comandas e mesas">
              {deliveryShown.length > 0 && <h3 className="op-section-title">Comandas / Mesas</h3>}
              {pointsContent}
            </section>
          </>
        )}
        {effectiveView === "points" && pointsContent}
      </>
    );
  } else if (loading && !data) {
    content = <p className="op-state">Carregando comandas e mesas…</p>;
  } else if (!data) {
    content = (
      <div className="op-state">
        <button className="btn-secondary" type="button" onClick={() => void reload()}>
          Tentar de novo
        </button>
      </div>
    );
  } else {
    content = pointsContent;
  }

  return (
    <section className={`op-panel op-panel-${variant}`}>
      <form className="op-toolbar" role="search" onSubmit={(event) => void handleSearchSubmit(event)}>
        <div className="op-search">
          <input
            ref={searchRef}
            className="op-search-input"
            type="search"
            value={query}
            placeholder={SEARCH_LABEL}
            aria-label={SEARCH_LABEL}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
            autoFocus={keepSearchFocused}
            onChange={(e) => {
              setQuery(e.target.value);
              setScanMessage(null);
            }}
          />
        </div>
        <button
          className="btn-secondary op-refresh"
          type="button"
          aria-label={refreshing ? "Atualizando" : "Atualizar"}
          disabled={refreshing}
          onClick={() => void reload()}
        >
          <span aria-hidden="true">↻</span>
          <span className="op-refresh-label">{refreshing ? "Atualizando…" : "Atualizar"}</span>
        </button>
      </form>

      {data && showDeliverySection && (
        <div className="op-filters op-views" role="group" aria-label="Mostrar">
          {VIEW_ORDER.filter((v) => v !== "settlement" || showSettlement).map((v) => (
            <button key={v} type="button" className="op-chip" aria-pressed={effectiveView === v} data-testid={`view-${v}`} onClick={() => setView(v)}>
              {VIEW_LABEL[v]}
              {v === "receivable" && <span className="op-chip-count">{toReceive}</span>}
              {v === "settlement" && <span className="op-chip-count">{settleCount}</span>}
            </button>
          ))}
        </div>
      )}

      {data && showPoints && (
        <div className="op-filters" role="group" aria-label="Filtros">
          {STATUS_CHIPS.map((chip) => (
            <button
              key={chip.value}
              type="button"
              className="op-chip"
              aria-pressed={status === chip.value}
              onClick={() => setStatus(chip.value)}
            >
              {chip.label}
              <span className="op-chip-count">{counts[chip.value]}</span>
            </button>
          ))}
          {mode === "both" && (
            <>
              <span className="op-filters-sep" aria-hidden="true" />
              {TYPE_CHIPS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className="op-chip"
                  aria-pressed={typeChoice === value}
                  onClick={() => setTypeChoice((current) => (current === value ? null : value))}
                >
                  {TYPE_LABEL[value]}
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {loadError && <div className="form-error">{loadError}</div>}
      {receivablesError && <div className="form-error">{receivablesError}</div>}
      {scanMessage && <div className="form-error">{scanMessage}</div>}
      {notice && <div className="form-notice">{notice}</div>}

      {content}

      {openCashFor && companyId && (
        <OpenCashDialog
          source={cashSource}
          companyId={companyId}
          notice="Abra o caixa antes de confirmar o acerto do entregador."
          onOpened={() => { setOpenCashFor(false); setNotice("Caixa aberto. Confirme o acerto novamente."); }}
          onClose={() => setOpenCashFor(false)}
        />
      )}

      {dialog?.kind === "open" && (
        <OpenSessionDialog
          key={dialog.point.id}
          point={dialog.point}
          companyId={companyId}
          allowQuickCreate={allowQuick}
          onSubmit={(customer, customerId) => submitOpen(dialog.point, customer, customerId)}
          onClose={closeDialog}
        />
      )}
    </section>
  );
}

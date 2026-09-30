import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { OPERATIONAL_PATH } from "../../app/accessRules";
import { useAuth } from "../../app/useAuth";
import { supabaseServicePanelSource, type ServicePanelSource } from "./api";
import { createCoalescedRunner } from "../orders/coalesce";
import { OpenSessionDialog } from "./PointDialogs";
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

function PointCard({ point, onSelect }: { point: ServicePoint; onSelect: (point: ServicePoint) => void }) {
  const status = statusOf(point);
  const session = point.open_session;
  const label = [
    point.display_name,
    STATUS_LABEL[status],
    session ? `cliente ${session.customer_name ?? "sem nome"}` : "",
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
            <span className="op-card-line">Cliente: {session.customer_name ?? "sem nome"}</span>
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
}: {
  variant: "attendant" | "cashier";
  source?: ServicePanelSource;
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
    const result = await source.load(companyId);
    if (current !== requestId.current) return result.data;
    setRefreshing(false);
    setLoading(false);
    if (result.error || !result.data) {
      setLoadError(result.error ?? "Não foi possível carregar as comandas e mesas.");
      return null;
    }
    setLoadError(null);
    setData(result.data);
    return result.data;
  }, [companyId, source]);

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
  const type = mode === "both" ? typeChoice : null;
  const shown = useMemo(
    () => sortPoints(filterPoints(points, { query, status, type })),
    [points, query, status, type],
  );
  const counts = useMemo(() => countByStatus(points, { query, type }), [points, query, type]);

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
      const fresh = await reload();
      target = fresh ? resolveScan(fresh.points, value) : null;
    }
    if (!target) {
      setScanMessage(`Nenhuma comanda ou mesa encontrada para “${value}”.`);
      searchRef.current?.select(); // o próximo código lido substitui este
      return;
    }
    setQuery("");
    openPoint(target);
  }

  // Abre o atendimento e já mostra o cartão em atendimento (o backend grava quem abriu); a
  // recarga em seguida acerta qualquer diferença com o que está no banco.
  async function submitOpen(point: ServicePoint, customer: string | null): Promise<string | null> {
    const result = await source.open(point.id, customer);
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
    setNotice(`${point.display_name} aberta${customer ? ` para ${customer}` : ""}.`);
    focusSearch();
    void reload();
    return null;
  }

  let content;
  if (loading && !data) {
    content = <p className="op-state">Carregando comandas e mesas…</p>;
  } else if (!data) {
    content = (
      <div className="op-state">
        <button className="btn-secondary" type="button" onClick={() => void reload()}>
          Tentar de novo
        </button>
      </div>
    );
  } else if (points.length === 0) {
    content = <p className="op-state">{EMPTY_TEXT[mode]}</p>;
  } else if (shown.length === 0) {
    content = <p className="op-state">Nada encontrado com esses filtros.</p>;
  } else {
    content = (
      <ul className="op-grid" role="list">
        {shown.map((point) => (
          <PointCard key={point.id} point={point} onSelect={openPoint} />
        ))}
      </ul>
    );
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

      {data && (
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
      {scanMessage && <div className="form-error">{scanMessage}</div>}
      {notice && <div className="form-notice">{notice}</div>}

      {content}

      {dialog?.kind === "open" && (
        <OpenSessionDialog
          key={dialog.point.id}
          point={dialog.point}
          onSubmit={(customer) => submitOpen(dialog.point, customer)}
          onClose={closeDialog}
        />
      )}
    </section>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../app/useAuth";
import { formatCents } from "../../lib/money";
import { createCoalescedRunner } from "../orders/coalesce";
import { supabaseOpenSessionsSource, type OpenSessionsSource } from "./openSessionsApi";
import {
  ageTier,
  attendancePath,
  countByKind,
  countOpen,
  filterOpen,
  formatElapsed,
  KIND_LABEL,
  sortOpen,
  type KindFilter,
  type OpenAttendance,
  type SortKey,
} from "./openSessions";
import { formatOpenedShort } from "./panel";

const SEARCH_LABEL = "Buscar mesa, comanda, cliente ou atendente";
const CLOCK_MS = 30_000;

const KIND_CHIPS: Array<{ value: KindFilter; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "table", label: "Mesas" },
  { value: "command", label: "Comandas" },
];

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "oldest", label: "Mais antigos" },
  { value: "newest", label: "Mais recentes" },
  { value: "value", label: "Maior valor" },
];

function itemsText(count: number): string {
  return count === 1 ? "1 item" : `${count} itens`;
}

function AttendanceCard({ item, now, onOpen }: { item: OpenAttendance; now: Date; onOpen: (item: OpenAttendance) => void }) {
  const tier = ageTier(item.openedAt, now);
  const title = item.kind === "table" ? item.displayName : item.code;
  return (
    <li className={`oa-card oa-${item.kind} oa-age-${tier}`}>
      <div className="oa-head">
        <span className={`oa-kind oa-kind-${item.kind}`}>{KIND_LABEL[item.kind]}</span>
        <span className="oa-title">{title}</span>
        {item.kind === "command" && item.displayName !== item.code && <span className="oa-sub">{item.displayName}</span>}
        {item.kind === "table" && item.displayName !== item.code && <span className="oa-sub">{item.code}</span>}
      </div>
      <dl className="oa-meta">
        <div>
          <dt>Cliente</dt>
          <dd>{item.customerName ?? "sem nome"}</dd>
        </div>
        <div>
          <dt>Atendente</dt>
          <dd>{item.waiterName ?? "—"}</dd>
        </div>
      </dl>
      <div className="oa-time">
        <span>{formatOpenedShort(item.openedAt, now)}</span>
        <span className="oa-elapsed">{formatElapsed(item.openedAt, now)}</span>
      </div>
      <div className="oa-foot">
        <span className="oa-items">{itemsText(item.itemCount)}</span>
        <span className="oa-total">{formatCents(Math.round(item.total * 100))}</span>
      </div>
      <button className="btn-primary oa-open" type="button" onClick={() => onOpen(item)}>
        Abrir atendimento
      </button>
    </li>
  );
}

// Painel em tempo real dos atendimentos ABERTOS da empresa (mesas e comandas). Só leitura: o botão
// leva à tela de atendimento que já existe (mesma rota de quem abre pelo painel de Comandas / Mesas).
export function OpenAttendancesBoard({
  source = supabaseOpenSessionsSource,
  emptyAction,
}: {
  source?: OpenSessionsSource;
  emptyAction?: { label: string; path: string };
}) {
  const navigate = useNavigate();
  const { activeMembership } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const role = activeMembership?.role ?? null;

  const [items, setItems] = useState<OpenAttendance[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [sort, setSort] = useState<SortKey>("oldest");
  const [now, setNow] = useState(() => new Date());
  const requestId = useRef(0);

  // Só a resposta MAIS NOVA vale (Realtime + foco + botão podem chegar quase juntos).
  const reload = useCallback(async () => {
    if (!companyId) return;
    const current = ++requestId.current;
    setRefreshing(true);
    const result = await source.load(companyId);
    if (current !== requestId.current) return;
    setRefreshing(false);
    setLoading(false);
    if (result.error || !result.data) {
      setLoadError(result.error ?? "Não foi possível carregar os atendimentos abertos.");
      return;
    }
    setLoadError(null);
    setItems(result.data);
    setNow(new Date());
  }, [companyId, source]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Ao voltar para a aba/aparelho, acerta o que mudou enquanto estava escondida.
  useEffect(() => {
    function refreshWhenVisible() {
      if (document.visibilityState === "visible") void reload();
    }
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => document.removeEventListener("visibilitychange", refreshWhenVisible);
  }, [reload]);

  // Realtime (sem polling): sessão aberta/fechada, pedido novo, item cancelado. Coalescido.
  useEffect(() => {
    if (!companyId || !source.subscribe) return;
    const scheduleReload = createCoalescedRunner(reload);
    return source.subscribe(companyId, scheduleReload);
  }, [companyId, source, reload]);

  // O "há X min" anda pelo relógio local: nenhuma consulta ao banco.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), CLOCK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const all = useMemo(() => items ?? [], [items]);
  const counts = useMemo(() => countOpen(all), [all]);
  const kindCounts = useMemo(() => countByKind(all, query), [all, query]);
  const shown = useMemo(() => sortOpen(filterOpen(all, { query, kind }), sort), [all, query, kind, sort]);

  function openAttendance(item: OpenAttendance) {
    navigate(attendancePath(role, item.id));
  }

  let content;
  if (loading && !items) {
    content = <p className="op-state">Carregando atendimentos abertos…</p>;
  } else if (!items) {
    content = (
      <div className="op-state">
        <button className="btn-secondary" type="button" onClick={() => void reload()}>
          Tentar de novo
        </button>
      </div>
    );
  } else if (items.length === 0) {
    content = (
      <div className="op-state">
        <p>Nenhuma mesa ou comanda aberta no momento.</p>
        {emptyAction && (
          <button className="btn-secondary" type="button" onClick={() => navigate(emptyAction.path)}>
            {emptyAction.label}
          </button>
        )}
      </div>
    );
  } else if (shown.length === 0) {
    content = <p className="op-state">Nada encontrado com esses filtros.</p>;
  } else {
    content = (
      <ul className="oa-grid" role="list">
        {shown.map((item) => (
          <AttendanceCard key={item.id} item={item} now={now} onOpen={openAttendance} />
        ))}
      </ul>
    );
  }

  return (
    <section className="op-panel oa-board">
      {items && (
        <dl className="oa-counters" aria-label="Resumo">
          <div>
            <dt>Abertos</dt>
            <dd>{counts.all}</dd>
          </div>
          <div>
            <dt>Mesas</dt>
            <dd>{counts.table}</dd>
          </div>
          <div>
            <dt>Comandas</dt>
            <dd>{counts.command}</dd>
          </div>
          <div>
            <dt>Total em aberto</dt>
            <dd>{formatCents(Math.round(counts.totalAmount * 100))}</dd>
          </div>
        </dl>
      )}

      <form className="op-toolbar" role="search" onSubmit={(event) => event.preventDefault()}>
        <div className="op-search">
          <input
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
            onChange={(e) => setQuery(e.target.value)}
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

      {items && (
        <div className="op-filters" role="group" aria-label="Filtros">
          {KIND_CHIPS.map((chip) => (
            <button key={chip.value} type="button" className="op-chip" aria-pressed={kind === chip.value} onClick={() => setKind(chip.value)}>
              {chip.label}
              <span className="op-chip-count">{kindCounts[chip.value]}</span>
            </button>
          ))}
          <span className="op-filters-sep" aria-hidden="true" />
          <label className="oa-sort">
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
      )}

      {loadError && <div className="form-error">{loadError}</div>}

      {content}
    </section>
  );
}

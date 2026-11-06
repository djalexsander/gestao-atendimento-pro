import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fmtDateTimeSP } from "../../lib/dates";
import { formatCents } from "../../lib/money";
import { courtesyUnavailable, getCourtesyCounters, listCourtesyAttention, resetCourtesyAvailability, type CourtesyResult } from "./courtesyApi";
import {
  ATTENTION_FILTER_TEXT,
  attentionKey,
  COURTESY_STATE_TEXT,
  COURTESY_STATE_TONE,
  BRIDGE_STATE_TEXT,
  BRIDGE_STATE_TONE,
  itemLabel,
  pageInfo,
  urgencyOf,
  type AttentionFilter,
  type AttentionItem,
  type AttentionPage,
  type CompanyFlags,
  type CourtesyCounters,
} from "./courtesyLogic";
import { Badge, Kpi } from "./MasterBits";

const PAGE_SIZE = 10;
const WITHIN_DAYS = 7;
const FILTERS: AttentionFilter[] = ["all", "bridge_expired", "expired_pending_decision", "preserved_pending_payment", "expiring_soon"];

interface Named {
  id: string;
  code: string;
  name: string;
}

/** Aviso discreto quando as RPCs de cortesia ainda não existem neste ambiente. Nada é repetido sozinho. */
export function CourtesyUnavailableNotice({ onRetry }: { onRetry?: () => void }) {
  return (
    <p className="mst-sub mst-courtesy-note" role="status">
      Cortesias: recurso ainda não disponível neste ambiente (as migrations de cortesia não foram aplicadas). Nenhuma ação é necessária.{" "}
      {onRetry && (
        <button type="button" className="btn-link" onClick={onRetry}>
          Verificar novamente
        </button>
      )}
    </p>
  );
}

type Load<T> = { phase: "loading" } | { phase: "unavailable" } | { phase: "error"; error: string } | { phase: "ok"; data: T };

function toLoad<T>(r: CourtesyResult<T>): Load<T> {
  return r.status === "ok" ? { phase: "ok", data: r.data } : r.status === "unavailable" ? { phase: "unavailable" } : { phase: "error", error: r.error };
}

/** Contadores + lista de atenção (somente leitura) do Painel Master. Uma consulta por ação do usuário; sem repetição automática. */
export function CourtesyAttentionPanel({ plans, modules }: { plans: Named[]; modules: Named[] }) {
  const [counters, setCounters] = useState<Load<CourtesyCounters>>({ phase: "loading" });
  const [page, setPage] = useState<Load<AttentionPage>>({ phase: "loading" });
  const [filter, setFilter] = useState<AttentionFilter>("all");
  const [offset, setOffset] = useState(0);
  const [version, setVersion] = useState(0);

  // Os efeitos só buscam e gravam o resultado (setState depois do await). O estado "carregando" é marcado nos eventos que pedem nova busca.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await getCourtesyCounters(WITHIN_DAYS);
      if (!cancelled) setCounters(toLoad(r));
    })();
    return () => {
      cancelled = true;
    };
  }, [version]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await listCourtesyAttention(filter, WITHIN_DAYS, PAGE_SIZE, offset);
      if (!cancelled) setPage(toLoad(r));
    })();
    return () => {
      cancelled = true;
    };
  }, [filter, offset, version]);

  const refresh = (resetAvailability = false) => {
    if (resetAvailability) resetCourtesyAvailability();
    setCounters({ phase: "loading" });
    setPage({ phase: "loading" });
    setVersion((v) => v + 1);
  };
  const retry = () => refresh(true);

  if (counters.phase === "unavailable" || page.phase === "unavailable" || (courtesyUnavailable() && counters.phase !== "ok")) {
    return <CourtesyUnavailableNotice onRetry={retry} />;
  }

  const c = counters.phase === "ok" ? counters.data : null;
  const info = page.phase === "ok" ? pageInfo(page.data.total, page.data.limit || PAGE_SIZE, page.data.offset) : null;

  return (
    <section className="mst-card mst-courtesy" aria-label="Cortesias que exigem atenção">
      <div className="mst-head">
        <h3>Cortesias que exigem atenção</h3>
        <button type="button" className="btn-secondary" onClick={() => refresh()} disabled={page.phase === "loading"}>
          Atualizar
        </button>
      </div>

      {counters.phase === "error" && <div className="form-error">{counters.error}</div>}
      <dl className="mst-kpis">
        <Kpi strong label="Vencidas aguardando decisão" value={c ? c.expired_pending_decision : "…"} hint={c && c.expired_with_conversion_request > 0 ? `${c.expired_with_conversion_request} com pedido de conversão` : "acesso e isenção seguem até a decisão"} />
        <Kpi label="Vencem em até 7 dias" value={c ? c.expiring_soon : "…"} hint="cortesias ainda vigentes" />
        <Kpi strong label="Cortesia preservada aguardando pagamento" value={c ? (c.preserved_pending_payment ?? "—") : "…"} hint={c ? (c.preserved_pending_payment === null ? "indisponível neste ambiente (migration pendente)" : c.preserved_pending_payment > 0 ? `outro plano pendente; a mais antiga há ${c.preserved_pending_oldest_days ?? 0} dia(s); sem prazo automático` : "nenhuma empresa nessa situação") : undefined} />
        <Kpi strong label="Pontes Pix expiradas sem pagamento" value={c ? c.bridges_expired_unpaid : "…"} hint={c ? `${c.bridges_active} ponte(s) ativa(s)${c.bridges_ending_24h > 0 ? `, ${c.bridges_ending_24h} acaba(m) em 24 h` : ""}` : undefined} />
      </dl>

      <div className="mst-toolbar">
        <div>
          <label htmlFor="mst-court-filter">Mostrar</label>
          <select
            id="mst-court-filter"
            value={filter}
            onChange={(e) => {
              setPage({ phase: "loading" });
              setOffset(0);
              setFilter(e.target.value as AttentionFilter);
            }}
          >
            {FILTERS.map((f) => (
              <option key={f} value={f}>
                {ATTENTION_FILTER_TEXT[f]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {page.phase === "loading" && <p>Carregando cortesias…</p>}
      {page.phase === "error" && (
        <div className="form-error">
          {page.error}{" "}
          <button type="button" className="btn-link" onClick={() => refresh()}>
            Tentar novamente
          </button>
        </div>
      )}
      {page.phase === "ok" && page.data.items.length === 0 && <p className="mst-sub">Nenhuma cortesia exige atenção{filter === "all" ? "" : " neste filtro"}.</p>}
      {page.phase === "ok" && page.data.items.length > 0 && (
        <div className="mst-scroll">
          <table className="mst-table">
            <thead>
              <tr>
                <th>Empresa</th>
                <th>Item</th>
                <th>Vencimento</th>
                <th>Status</th>
                <th>Urgência</th>
              </tr>
            </thead>
            <tbody>
              {page.data.items.map((i) => (
                <AttentionRow key={attentionKey(i)} item={i} plans={plans} modules={modules} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {info && info.total > PAGE_SIZE && (
        <div className="mst-actions mst-pager" role="navigation" aria-label="Paginação das cortesias">
          <button type="button" className="btn-secondary" disabled={!info.hasPrev} onClick={() => { setPage({ phase: "loading" }); setOffset(info.prevOffset); }}>
            Anterior
          </button>
          <span>
            {info.from}–{info.to} de {info.total}
          </span>
          <button type="button" className="btn-secondary" disabled={!info.hasNext} onClick={() => { setPage({ phase: "loading" }); setOffset(info.nextOffset); }}>
            Próxima
          </button>
        </div>
      )}
    </section>
  );
}

function AttentionRow({ item, plans, modules }: { item: AttentionItem; plans: Named[]; modules: Named[] }) {
  const u = urgencyOf(item);
  const link = <Link to={`/master/empresas/${item.company_id}`}>{item.company_name}</Link>;
  if (item.kind === "preserved_pending_payment") {
    return (
      <tr>
        <td>{link}</td>
        <td>
          Plano “{item.pending_plan_name ?? "contratado"}” aguarda pagamento
          <small className="mst-cell-sub">cortesia original preservada: {itemLabel(item, plans, modules)}</small>
          {item.conversion_requested && <small className="mst-cell-sub">pedido de conversão registrado</small>}
        </td>
        <td>
          Pendente desde {fmtDateTimeSP(item.pending_since)}
          <small className="mst-cell-sub">cortesia vigente até {fmtDateTimeSP(item.ends_at)}; o acesso segue sem prazo adicional</small>
        </td>
        <td>
          <Badge tone="warn">Cortesia preservada</Badge>
        </td>
        <td>
          <Badge tone={u.tone}>{u.label}</Badge>
        </td>
      </tr>
    );
  }
  if (item.kind === "bridge_expired") {
    return (
      <tr>
        <td>{link}</td>
        <td>
          Ponte de pagamento (Pix)
          <small className="mst-cell-sub">fatura inicial {item.invoice_status === "overdue" ? "vencida" : "em aberto"}</small>
        </td>
        <td>{fmtDateTimeSP(item.until_at)}</td>
        <td>
          <Badge tone={BRIDGE_STATE_TONE[item.state]}>{BRIDGE_STATE_TEXT[item.state]}</Badge>
        </td>
        <td>
          <Badge tone={u.tone}>{u.label}</Badge>
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td>{link}</td>
      <td>
        {itemLabel(item, plans, modules)}
        {item.reference_price_cents > 0 && <small className="mst-cell-sub">referência {formatCents(item.reference_price_cents)}/mês</small>}
        {item.conversion_requested && <small className="mst-cell-sub">pedido de conversão registrado</small>}
      </td>
      <td>{fmtDateTimeSP(item.ends_at)}</td>
      <td>
        <Badge tone={COURTESY_STATE_TONE[item.effective_state]}>{COURTESY_STATE_TEXT[item.effective_state]}</Badge>
      </td>
      <td>
        <Badge tone={u.tone}>{u.label}</Badge>
      </td>
    </tr>
  );
}

/** Selo curto por empresa na lista de empresas (vencidas / a vencer). */
export function CourtesyCompanyFlag({ expired, soon, bridge, preserved }: CompanyFlags) {
  if (expired === 0 && soon === 0 && bridge === 0 && preserved === 0) return null;
  return (
    <span className="mst-court-flags">
      {bridge > 0 && <Badge tone="bad">{bridge === 1 ? "Ponte Pix expirada" : `${bridge} pontes Pix expiradas`}</Badge>}
      {expired > 0 && <Badge tone="bad">{expired === 1 ? "Cortesia vencida" : `${expired} cortesias vencidas`}</Badge>}
      {soon > 0 && <Badge tone="warn">{soon === 1 ? "Cortesia vence em ≤ 7 dias" : `${soon} vencem em ≤ 7 dias`}</Badge>}
      {preserved > 0 && <Badge tone="warn">Cortesia preservada (aguarda pagamento)</Badge>}
    </span>
  );
}


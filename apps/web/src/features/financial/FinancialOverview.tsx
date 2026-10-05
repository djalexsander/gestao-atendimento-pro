import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../app/useAuth";
import { formatCents } from "../../lib/money";
import { formatDateBR, periodLabel, todayInSaoPaulo, type ReportPeriod } from "../reports/reportsLogic";
import { supabaseFinancialOverviewSource, type FinancialOverviewSource } from "./financialOverviewApi";
import {
  buildOverview,
  comparisonLabel,
  comparisonPeriod,
  FINANCIAL_PRESET_LABEL,
  FINANCIAL_PRESETS,
  financialPeriod,
  financialPeriodProblem,
  type Delta,
  type FinancialOverviewModel,
  type FinancialPeriodKey,
} from "./financialOverviewLogic";

const LOAD_ERROR = "Não foi possível carregar a visão financeira.";
const STALE_AFTER_MS = 60_000;

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });
const when = (iso: string) => dateTime.format(new Date(iso));
const pct = (n: number | null) => (n === null ? "—" : `${n.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`);

export function DeltaText({ delta, versus }: { delta: Delta | null; versus: string }) {
  if (!delta) return null;
  return (
    <span className={`fin-delta fin-delta-${delta.direction}`}>
      {delta.label}
      {delta.direction !== "none" && <span className="fin-delta-vs"> vs {versus}</span>}
    </span>
  );
}

export function Kpi({ label, value, delta, versus, strong }: { label: string; value: string; delta?: Delta | null; versus: string; strong?: boolean }) {
  return (
    <div className={strong ? "fin-kpi fin-kpi-strong" : "fin-kpi"}>
      <dt>{label}</dt>
      <dd>{value}</dd>
      {delta !== undefined && <DeltaText delta={delta} versus={versus} />}
    </div>
  );
}

export function Line({ label, value, hint, strong }: { label: string; value: string; hint?: string; strong?: boolean }) {
  return (
    <li className={strong ? "fin-line fin-line-strong" : "fin-line"}>
      <span>
        {label}
        {hint && <small className="muted"> {hint}</small>}
      </span>
      <span>{value}</span>
    </li>
  );
}

function Skeleton() {
  return (
    <div className="fin-skeleton" aria-busy="true" aria-label="Carregando a visão financeira">
      <div className="fin-kpis">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="fin-kpi fin-skeleton-block" />
        ))}
      </div>
      <div className="fin-grid">
        <div className="fin-card fin-skeleton-block fin-skeleton-tall" />
        <div className="fin-card fin-skeleton-block fin-skeleton-tall" />
      </div>
    </div>
  );
}

export function SalesChart({ model }: { model: FinancialOverviewModel }) {
  const { series } = model;
  const dense = series.points.length > 31;
  return (
    <section className="fin-card">
      <h3>{series.granularity === "hour" ? "Vendas por hora" : "Vendas por dia"}</h3>
      {series.maxCents === 0 ? (
        <p className="muted">Sem vendas para exibir neste período.</p>
      ) : (
        <div className="fin-chart" role="img" aria-label={series.granularity === "hour" ? "Gráfico de vendas por hora" : "Gráfico de vendas por dia"}>
          {series.points.map((p, i) => (
            <div key={p.key} className="fin-bar-col" title={`${p.label}: ${formatCents(p.cents)}`}>
              <div className="fin-bar-track">
                <div className="fin-bar" style={{ height: `${Math.max(p.cents > 0 ? 3 : 0, (p.cents / series.maxCents) * 100)}%` }} />
              </div>
              {(!dense ? true : i % 7 === 0) && (series.granularity === "day" || i % 3 === 0) && <span className="fin-bar-label">{p.label}</span>}
            </div>
          ))}
        </div>
      )}
      {model.seriesPartial && <p className="field-hint">Período com muitas contas: o gráfico mostra apenas parte delas.</p>}
    </section>
  );
}

function Content({ model, versus, hasComparison }: { model: FinancialOverviewModel; versus: string; hasComparison: boolean }) {
  const { sales, received, refunds, netReceived, cash } = model;
  const cmp = (d: Delta | null) => (hasComparison ? d : undefined);
  return (
    <>
      {cash.openCashes.length > 0 && (
        <section className="fin-open-cash" aria-label="Caixa aberto">
          <div className="fin-open-cash-head">
            <strong>{cash.openCashes.length > 1 ? `${cash.openCashes.length} caixas abertos` : "Caixa aberto"}</strong>
            <Link className="btn-secondary btn-auto" to="/app/financeiro/caixa">
              Ir para Caixa
            </Link>
          </div>
          <ul className="fin-open-cash-list">
            {cash.openCashes.map((c) => (
              <li key={c.id}>
                <span>
                  <strong>{c.operatorName ?? "Operador"}</strong>
                  <small className="muted"> · aberto em {when(c.openedAt)}</small>
                </span>
                <span>
                  Inicial {formatCents(c.openingCents)} · Esperado agora <strong>{formatCents(c.expectedCents)}</strong>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <dl className="fin-kpis">
        <Kpi label="Vendas" value={formatCents(sales.effectiveCents)} delta={cmp(sales.delta)} versus={versus} strong />
        <Kpi label="Recebido" value={formatCents(received.totalCents)} delta={cmp(received.delta)} versus={versus} />
        <Kpi label="Estornos" value={formatCents(refunds.totalCents)} versus={versus} />
        <Kpi label="Líquido recebido" value={formatCents(netReceived.cents)} delta={cmp(netReceived.delta)} versus={versus} strong />
      </dl>

      {model.empty && <p className="fin-empty">Nenhum movimento financeiro neste período.</p>}

      <div className="fin-grid">
        <section className="fin-card">
          <h3>Vendas</h3>
          <ul className="fin-lines">
            {sales.breakdownAvailable ? (
              <>
                <Line label="Valor original" value={formatCents(sales.originalCents)} />
                <Line label="Cancelamentos" value={`- ${formatCents(sales.cancelledCents)}`} hint={sales.cancelledQuantity > 0 ? `${sales.cancelledQuantity} un.` : undefined} />
              </>
            ) : null}
            <Line label="Vendido" value={formatCents(sales.effectiveCents)} strong />
          </ul>
          <ul className="fin-lines fin-lines-sub">
            <Line label="Ticket médio" value={model.ticket.cents === null ? "—" : formatCents(model.ticket.cents)} hint={model.ticket.basis > 0 ? `${model.ticket.basis} atend. com venda` : undefined} />
            <Line label="Atendimentos fechados" value={String(model.sessionsClosed)} />
            <Line label="Itens vendidos" value={String(model.itemsSold)} />
          </ul>
          {!sales.breakdownAvailable && <p className="field-hint">Detalhe de cancelamentos indisponível: muitos produtos no período.</p>}
        </section>

        <section className="fin-card">
          <h3>Recebimentos</h3>
          <ul className="fin-methods">
            {received.methods.map((m) => (
              <li key={m.method} className={m.paidCents === 0 ? "fin-method fin-method-zero" : "fin-method"}>
                <div className="fin-method-head">
                  <span>{m.label}</span>
                  <span>
                    <strong>{formatCents(m.paidCents)}</strong>
                    <small className="muted"> {pct(m.sharePct)}</small>
                  </span>
                </div>
                <div className="fin-method-track">
                  <div className="fin-method-fill" style={{ width: `${m.sharePct ?? 0}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <SalesChart model={model} />

      <div className="fin-grid">
        <section className="fin-card">
          <h3>Estornos e cancelamentos</h3>
          <ul className="fin-lines">
            <Line label="Estornos (dinheiro devolvido)" value={formatCents(refunds.totalCents)} hint={refunds.count > 0 ? `${refunds.count} estorno${refunds.count > 1 ? "s" : ""}` : undefined} />
            {refunds.byMethod.map((m) => (
              <Line key={m.method} label={`· ${m.label}`} value={formatCents(m.cents)} />
            ))}
            <Line label="Cancelamentos (antes do fechamento)" value={formatCents(sales.cancelledCents)} hint={sales.cancelledQuantity > 0 ? `${sales.cancelledQuantity} un.` : undefined} />
          </ul>
          <p className="field-hint">Cancelamento reduz a venda; estorno devolve um pagamento já recebido e não altera a venda original.</p>
        </section>

        <section className="fin-card">
          <h3>Caixa</h3>
          <ul className="fin-lines">
            <Line label="Saldo inicial" value={formatCents(cash.openingCents)} />
            <Line label="+ Vendas em dinheiro" value={formatCents(cash.cashSalesCents)} />
            <Line label="+ Suprimentos" value={formatCents(cash.supplyCents)} />
            <Line label="- Sangrias" value={formatCents(cash.withdrawalCents)} />
            <Line label="- Estornos em dinheiro" value={formatCents(cash.cashRefundCents)} />
            <Line label="Saldo físico esperado" value={formatCents(cash.expectedCents)} strong />
          </ul>
          <ul className="fin-lines fin-lines-sub">
            <Line label="Caixas abertos agora" value={String(cash.openCount)} />
            <Line label="Fechamentos no período" value={String(cash.closings)} />
            {cash.closings > 0 && (
              <Line
                label="Divergência"
                value={cash.shortageCents === 0 && cash.surplusCents === 0 ? "Sem divergência" : `${cash.shortageCents > 0 ? `Faltas ${formatCents(cash.shortageCents)}` : ""}${cash.shortageCents > 0 && cash.surplusCents > 0 ? " · " : ""}${cash.surplusCents > 0 ? `Sobras ${formatCents(cash.surplusCents)}` : ""}`}
              />
            )}
          </ul>
          <p className="field-hint">Caixas abertos no período. Não entra em venda nem em resultado.</p>
        </section>
      </div>

      {model.topProducts.length > 0 && (
        <section className="fin-card">
          <h3>Produtos mais vendidos</h3>
          <ol className="fin-top">
            {model.topProducts.map((p) => (
              <li key={p.name}>
                <span>{p.name}</span>
                <span className="muted">{p.quantity} un.</span>
                <strong>{formatCents(p.valueCents)}</strong>
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}

// Visão financeira (owner/admin, rota /app). Os números vêm do servidor (report_period, a mesma fonte dos
// Relatórios) + caixas/contas fechadas; as regras ficam em financialOverviewLogic.ts. Atualiza pelo botão
// e ao voltar para a aba (sem polling): pagamentos/estornos/caixa não estão no Realtime.
export function FinancialOverview({ source = supabaseFinancialOverviewSource }: { source?: FinancialOverviewSource }) {
  const { activeMembership } = useAuth();
  const companyId = activeMembership?.companyId ?? null;

  const [key, setKey] = useState<FinancialPeriodKey>("today");
  const [custom, setCustom] = useState<ReportPeriod>(() => {
    const today = todayInSaoPaulo();
    return { from: today, to: today };
  });
  const [applied, setApplied] = useState<ReportPeriod>(() => financialPeriod("today", todayInSaoPaulo(), { from: "", to: "" }));
  const [appliedKey, setAppliedKey] = useState<FinancialPeriodKey>("today");
  const [model, setModel] = useState<FinancialOverviewModel | null>(null);
  const [versus, setVersus] = useState("ontem");
  const [hasComparison, setHasComparison] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const seq = useRef(0);
  const loadedAt = useRef(0);

  const load = useCallback(
    async (nextKey: FinancialPeriodKey, period: ReportPeriod) => {
      if (!companyId) return;
      const id = ++seq.current;
      const previous = comparisonPeriod(nextKey, period);
      setLoading(true);
      setError(null);
      const result = await source.load(companyId, period, previous);
      if (id !== seq.current) return; // resposta de uma consulta antiga
      setLoading(false);
      if (result.error || !result.data) {
        setError(LOAD_ERROR);
        return;
      }
      loadedAt.current = Date.now();
      setApplied(period);
      setAppliedKey(nextKey);
      setVersus(comparisonLabel(nextKey, previous));
      setHasComparison(result.data.previous !== null);
      setModel(buildOverview(result.data, period));
    },
    [companyId, source],
  );

  useEffect(() => {
    void load("today", financialPeriod("today", todayInSaoPaulo(), custom));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  // Ao voltar para a aba, atualiza se os dados estiverem velhos.
  useEffect(() => {
    function refreshWhenVisible() {
      if (document.visibilityState === "visible" && Date.now() - loadedAt.current > STALE_AFTER_MS) {
        void load(appliedKey, financialPeriod(appliedKey, todayInSaoPaulo(), applied));
      }
    }
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => document.removeEventListener("visibilitychange", refreshWhenVisible);
  }, [load, appliedKey, applied]);

  function choose(next: FinancialPeriodKey) {
    setKey(next);
    setFormError(null);
    if (next === "custom") return; // espera "Aplicar"
    void load(next, financialPeriod(next, todayInSaoPaulo(), custom));
  }

  function applyCustom() {
    const problem = financialPeriodProblem(custom);
    if (problem) {
      setFormError(problem);
      return;
    }
    setFormError(null);
    void load("custom", custom);
  }

  function refresh() {
    void load(appliedKey, appliedKey === "custom" ? applied : financialPeriod(appliedKey, todayInSaoPaulo(), applied));
  }

  return (
    <div className="fin-page">
      <div className="page-header">
        <h2>Visão financeira</h2>
        <button className="btn-secondary btn-auto" type="button" disabled={loading} onClick={refresh}>
          {loading ? "Atualizando…" : "Atualizar"}
        </button>
      </div>

      <div className="report-filters">
        <div className="report-presets" role="group" aria-label="Período">
          {FINANCIAL_PRESETS.map((p) => (
            <button key={p} type="button" className="op-chip" aria-pressed={key === p} onClick={() => choose(p)}>
              {FINANCIAL_PRESET_LABEL[p]}
            </button>
          ))}
        </div>
        {key === "custom" && (
          <>
            <div className="field">
              <label htmlFor="fin-from">Data inicial</label>
              <input id="fin-from" type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="fin-to">Data final</label>
              <input id="fin-to" type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
            </div>
            <button className="btn-primary btn-auto" type="button" disabled={loading} onClick={applyCustom}>
              Aplicar
            </button>
          </>
        )}
      </div>
      {formError && <div className="form-error">{formError}</div>}
      <p className="field-hint">
        Horário de Brasília. {model ? `Mostrando ${applied.from === applied.to ? formatDateBR(applied.from) : periodLabel(applied)}.` : ""}
        {model && hasComparison ? ` Comparativo com ${versus}.` : ""}
      </p>

      {error && (
        <div className="form-error fin-error" role="alert">
          <p>{error}</p>
          <button className="btn-secondary btn-auto" type="button" onClick={refresh}>
            Tentar novamente
          </button>
        </div>
      )}

      {!model && !error && <Skeleton />}
      {model && (
        <div className={loading ? "fin-content fin-loading" : "fin-content"} aria-busy={loading}>
          <Content model={model} versus={versus} hasComparison={hasComparison} />
        </div>
      )}
    </div>
  );
}

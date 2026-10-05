import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../app/useAuth";
import { formatCents } from "../../lib/money";
import { Kpi, Line, SalesChart } from "../financial/FinancialOverview";
import {
  comparisonLabel,
  comparisonPeriod,
  FINANCIAL_PRESET_LABEL,
  FINANCIAL_PRESETS,
  financialPeriod,
  financialPeriodProblem,
  type FinancialPeriodKey,
} from "../financial/financialOverviewLogic";
import { formatDateBR, periodLabel, todayInSaoPaulo, type ReportPeriod } from "../reports/reportsLogic";
import { supabaseDashboardSource, type DashboardSource } from "./dashboardApi";
import { buildDashboard, SHORTCUTS, type DashboardModel, type Section } from "./dashboardLogic";

const STALE_AFTER_MS = 60_000;

function Card({ title, to, linkLabel, children, className }: { title: string; to?: string; linkLabel?: string; children: ReactNode; className?: string }) {
  return (
    <section className={className ? `fin-card dash-card ${className}` : "fin-card dash-card"}>
      <div className="dash-card-head">
        <h3>{title}</h3>
        {to && (
          <Link className="dash-link" to={to}>
            {linkLabel ?? "Ver detalhes"}
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

// Seção que falhou: o erro aparece NA seção (nunca some em silêncio) e o painel segue com as demais.
function SectionError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="dash-section-error" role="alert">
      <p>{message}</p>
      <button type="button" className="btn-secondary btn-auto" onClick={onRetry}>
        Tentar novamente
      </button>
    </div>
  );
}

function Body<T>({ section, onRetry, children }: { section: Section<T>; onRetry: () => void; children: (data: T) => ReactNode }) {
  return section.ok ? <>{children(section.data)}</> : <SectionError message={section.error} onRetry={onRetry} />;
}

const countText = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Skeleton() {
  return (
    <div className="fin-skeleton" aria-busy="true" aria-label="Carregando o dashboard">
      <div className="fin-kpis">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="fin-kpi fin-skeleton-block" />
        ))}
      </div>
      <div className="dash-grid dash-grid-2">
        <div className="fin-card fin-skeleton-block fin-skeleton-tall" />
        <div className="fin-card fin-skeleton-block fin-skeleton-tall" />
      </div>
    </div>
  );
}

function Content({ model, versus, hasComparison, onRetry }: { model: DashboardModel; versus: string; hasComparison: boolean; onRetry: () => void }) {
  const ov = model.overview;
  return (
    <>
      {model.allEmpty && (
        <div className="fin-empty" role="status">
          Ainda não há movimento neste período. Assim que houver vendas, pedidos ou contas, os números aparecem aqui.
        </div>
      )}

      {ov.ok ? (
        <dl className="fin-kpis">
          <Kpi label="Faturamento" value={formatCents(ov.data.sales.effectiveCents)} delta={ov.data.sales.delta} versus={versus} strong />
          <Kpi label="Ticket médio" value={ov.data.ticket.cents === null ? "—" : formatCents(ov.data.ticket.cents)} versus={versus} />
          <Kpi label="Atendimentos fechados" value={String(ov.data.sessionsClosed)} versus={versus} />
          <Kpi label="Pedidos" value={model.orders.ok ? String(model.orders.data.total) : "—"} versus={versus} />
        </dl>
      ) : (
        <SectionError message={ov.error} onRetry={onRetry} />
      )}
      {hasComparison && ov.ok && <p className="field-hint">Faturamento comparado com {versus}. Ticket médio considera só contas com venda.</p>}

      <div className="dash-grid dash-grid-main">
        {ov.ok ? <SalesChart model={ov.data} /> : <Card title="Vendas"><SectionError message={ov.error} onRetry={onRetry} /></Card>}

        <Card title="Caixa agora" to="/app/financeiro/caixa" linkLabel="Ver caixas">
          <Body section={model.cash} onRetry={onRetry}>
            {(c) =>
              c.openCount === 0 ? (
                <p className="muted">Nenhum caixa aberto no momento.</p>
              ) : (
                <>
                  <p className="dash-status">
                    <span className="rec-badge rec-badge-paid">{countText(c.openCount, "caixa aberto", "caixas abertos")}</span>
                  </p>
                  <ul className="fin-lines">
                    <Line label="Abertura" value={formatCents(c.openingCents)} />
                    <Line label="Vendas em dinheiro" value={formatCents(c.cashSalesCents)} />
                    <Line label="Suprimentos" value={formatCents(c.supplyCents)} />
                    <Line label="Sangrias" value={`− ${formatCents(c.withdrawalCents)}`} />
                    <Line label="Devoluções em dinheiro" value={`− ${formatCents(c.cashRefundCents)}`} />
                    <Line label="Saldo físico esperado" value={formatCents(c.expectedCents)} strong />
                  </ul>
                </>
              )
            }
          </Body>
        </Card>
      </div>

      <div className="dash-grid dash-grid-2">
        <Card title="A receber" to="/app/financeiro/contas-a-receber">
          <Body section={model.receivables} onRetry={onRetry}>
            {(r) => (
              <>
                <p className="dash-big">{formatCents(r.openCents)}</p>
                <p className="muted">{countText(r.openCount, "conta em aberto", "contas em aberto")}</p>
                <ul className="fin-lines">
                  <Line label="Vencendo hoje" value={formatCents(r.dueTodayCents)} hint={String(r.dueTodayCount)} />
                  <Line label="Atrasado" value={formatCents(r.overdueCents)} hint={String(r.overdueCount)} />
                  <Line label="Recebido no período" hint="contas a receber" value={formatCents(r.receivedCents)} />
                </ul>
              </>
            )}
          </Body>
        </Card>

        <Card title="A pagar" to="/app/financeiro/contas-a-pagar">
          <Body section={model.payables} onRetry={onRetry}>
            {(p) => (
              <>
                <p className="dash-big">{formatCents(p.openCents)}</p>
                <p className="muted">{countText(p.openCount, "conta em aberto", "contas em aberto")}</p>
                <ul className="fin-lines">
                  <Line label="Vencendo hoje" value={formatCents(p.dueTodayCents)} hint={String(p.dueTodayCount)} />
                  <Line label="Atrasado" value={formatCents(p.overdueCents)} hint={String(p.overdueCount)} />
                  <Line label="Pago no período" hint="contas a pagar" value={formatCents(p.paidPeriodCents)} />
                </ul>
              </>
            )}
          </Body>
        </Card>

      </div>

      <div className="dash-grid dash-grid-3">
        <Card title="Atendimentos">
          <Body section={model.attendance} onRetry={onRetry}>
            {(a) => (
              <ul className="fin-lines">
                <Line label="Abertos agora" value={String(a.open)} />
                <Line label="Fechados no período" value={String(a.closed)} />
                <Line label="Total vendido" value={formatCents(a.soldCents)} />
                <Line label="Ticket médio" value={a.ticketCents === null ? "—" : formatCents(a.ticketCents)} />
              </ul>
            )}
          </Body>
        </Card>

        <Card title="Pedidos" to="/operacional/pedidos">
          <Body section={model.orders} onRetry={onRetry}>
            {(o) => (
              <ul className="fin-lines">
                <Line label="Pedidos no período" value={String(o.total)} />
                <Line label="Itens vendidos" value={String(o.itemsSold)} />
                <Line label="Pedidos cancelados" value={String(o.cancelledOrders)} />
                <Line label="Itens cancelados" value={String(o.cancelledItems)} hint={o.cancelledCents > 0 ? formatCents(o.cancelledCents) : undefined} />
              </ul>
            )}
          </Body>
        </Card>

        <Card title="Produção" to="/operacional/producao">
          <Body section={model.production} onRetry={onRetry}>
            {(p) => (
              <ul className="fin-lines">
                <Line label="Aguardando" value={String(p.pending)} />
                <Line label="Preparando" value={String(p.preparing)} />
                <Line label="Prontos hoje" value={String(p.ready)} />
                <Line label="Tempo médio de preparo" hint="no período" value={p.avgMinutes === null ? "—" : `${p.avgMinutes.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} min`} />
              </ul>
            )}
          </Body>
        </Card>
      </div>

      <div className="dash-grid dash-grid-3">
        <Card title="Formas de pagamento">
          {ov.ok ? (
            ov.data.received.totalCents === 0 ? (
              <p className="muted">Nenhum recebimento neste período.</p>
            ) : (
              <ul className="dash-methods">
                {ov.data.received.methods
                  .filter((m) => m.paidCents > 0)
                  .map((m) => (
                    <li key={m.method}>
                      <div className="dash-method-head">
                        <span>{m.label}</span>
                        <span>
                          {formatCents(m.paidCents)}
                          {m.sharePct !== null && <small className="muted"> · {m.sharePct.toLocaleString("pt-BR")}%</small>}
                        </span>
                      </div>
                      <div className="dash-meter" aria-hidden="true">
                        <div style={{ width: `${m.sharePct ?? 0}%` }} />
                      </div>
                    </li>
                  ))}
              </ul>
            )
          ) : (
            <SectionError message={ov.error} onRetry={onRetry} />
          )}
        </Card>

        <Card title="Produtos mais vendidos" to="/app/financeiro/relatorios" linkLabel="Relatórios">
          {ov.ok ? (
            ov.data.topProducts.length === 0 ? (
              <p className="muted">Nenhum produto vendido neste período.</p>
            ) : (
              <ol className="dash-top">
                {ov.data.topProducts.map((p, i) => (
                  <li key={`${p.name}-${i}`}>
                    <span className="dash-top-name">{p.name}</span>
                    <span className="dash-top-nums">
                      {p.quantity}× · {formatCents(p.valueCents)}
                    </span>
                  </li>
                ))}
              </ol>
            )
          ) : (
            <SectionError message={ov.error} onRetry={onRetry} />
          )}
        </Card>

        <Card title="Precisa de atenção">
          {model.alerts.length === 0 ? (
            <p className="muted">Nada pendente no momento.</p>
          ) : (
            <ul className="dash-alerts">
              {model.alerts.map((a) => (
                <li key={a.key} className={`dash-alert dash-alert-${a.level}`}>
                  <Link to={a.to}>{a.text}</Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="dash-grid dash-grid-3">
        <Card title="Estoque" to="/app/cadastros/estoque" linkLabel="Ver estoque">
          <Body section={model.stock} onRetry={onRetry}>
            {(s) =>
              s.alerts === 0 ? (
                <p className="muted">Nenhum alerta de estoque.</p>
              ) : (
                <>
                  <ul className="fin-lines">
                    <Line label="Estoque baixo" value={String(s.low)} />
                    <Line label="Indisponíveis" value={String(s.out)} />
                  </ul>
                  <ul className="dash-mini">
                    {s.worst.map((w) => (
                      <li key={w.name}>
                        <span>{w.name}</span>
                        <span className={w.status === "out" ? "dash-danger" : "dash-warn"}>{w.status === "out" ? "Sem estoque" : `${w.quantity} un.`}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )
            }
          </Body>
        </Card>

        <Card title="Clientes" to="/app/cadastros/clientes">
          <Body section={model.customers} onRetry={onRetry}>
            {(c) => (
              <ul className="fin-lines">
                <Line label="Clientes ativos" value={String(c.active)} />
                <Line label="Novos este mês" value={String(c.newThisMonth)} />
                <Line label="Com atendimento" hint="últimos 30 dias" value={String(c.recentVisits)} />
              </ul>
            )}
          </Body>
        </Card>

        <Card title="Atalhos">
          <div className="dash-shortcuts">
            {SHORTCUTS.map((s) => (
              <Link key={s.to + s.label} to={s.to} className="dash-shortcut">
                <strong>{s.label}</strong>
                <small className="muted">{s.hint}</small>
              </Link>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}

// Dashboard (owner/admin, rota /app). Visão executiva e operacional que só CONSOME as fontes oficiais dos módulos. Carrega
// ao abrir e ao trocar o período; atualiza pelo botão e ao voltar para a aba (sem polling).
export function DashboardPage({ source = supabaseDashboardSource }: { source?: DashboardSource }) {
  const { activeMembership } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const role = activeMembership?.role ?? null;

  const [key, setKey] = useState<FinancialPeriodKey>("today");
  const [custom, setCustom] = useState<ReportPeriod>(() => {
    const today = todayInSaoPaulo();
    return { from: today, to: today };
  });
  const [applied, setApplied] = useState<ReportPeriod>(() => financialPeriod("today", todayInSaoPaulo(), { from: "", to: "" }));
  const [appliedKey, setAppliedKey] = useState<FinancialPeriodKey>("today");
  const [model, setModel] = useState<DashboardModel | null>(null);
  const [versus, setVersus] = useState("ontem");
  const [hasComparison, setHasComparison] = useState(false);
  const [loading, setLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const seq = useRef(0);
  const loadedAt = useRef(0);

  const load = useCallback(
    async (nextKey: FinancialPeriodKey, period: ReportPeriod) => {
      if (!companyId) return;
      const id = ++seq.current;
      const previous = comparisonPeriod(nextKey, period);
      setLoading(true);
      const raw = await source.load(companyId, period, previous);
      if (id !== seq.current) return; // resposta de uma consulta antiga
      setLoading(false);
      loadedAt.current = Date.now();
      setApplied(period);
      setAppliedKey(nextKey);
      setVersus(comparisonLabel(nextKey, previous));
      setHasComparison(raw.financial.ok && raw.financial.data.previous !== null);
      setModel(buildDashboard(raw, period));
    },
    [companyId, source],
  );

  useEffect(() => {
    void load("today", financialPeriod("today", todayInSaoPaulo(), custom));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  useEffect(() => {
    function refreshWhenVisible() {
      if (document.visibilityState === "visible" && Date.now() - loadedAt.current > STALE_AFTER_MS) {
        void load(appliedKey, financialPeriod(appliedKey, todayInSaoPaulo(), applied));
      }
    }
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => document.removeEventListener("visibilitychange", refreshWhenVisible);
  }, [load, appliedKey, applied]);

  if (role !== null && role !== "owner" && role !== "admin") {
    return <p className="form-notice">O Dashboard é exclusivo de donos(as) e administradores(as).</p>;
  }

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
    <div className="fin-page dash-page">
      <div className="page-header">
        <h2>Dashboard</h2>
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
              <label htmlFor="dash-from">Data inicial</label>
              <input id="dash-from" type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="dash-to">Data final</label>
              <input id="dash-to" type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
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
      </p>

      {!model && <Skeleton />}
      {model && (
        <div className={loading ? "fin-content fin-loading" : "fin-content"} aria-busy={loading}>
          <Content model={model} versus={versus} hasComparison={hasComparison} onRetry={refresh} />
        </div>
      )}
    </div>
  );
}

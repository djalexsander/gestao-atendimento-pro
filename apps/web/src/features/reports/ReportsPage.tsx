import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../app/useAuth";
import { formatReais } from "../../lib/money";
import { buildReportPdf, reportFileName } from "./reportPdf";
import { supabaseReportsSource, type ReportFilterOption, type ReportsSource } from "./reportsApi";
import {
  cashDifferenceText,
  METHOD_LABEL,
  periodLabel,
  pointText,
  PRESET_LABEL,
  presetPeriod,
  todayInSaoPaulo,
  validatePeriod,
  type Preset,
  type ReportData,
  type ReportPeriod,
} from "./reportsLogic";

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });
const when = (iso: string) => dateTime.format(new Date(iso));

type Tab = "sales" | "products" | "cash" | "cancellations" | "refunds" | "production";

const TABS: Array<{ value: Tab; label: string }> = [
  { value: "sales", label: "Vendas" },
  { value: "products", label: "Produtos vendidos" },
  { value: "cash", label: "Caixas" },
  { value: "cancellations", label: "Cancelamentos" },
  { value: "refunds", label: "Estornos" },
  { value: "production", label: "Produção" },
];

function Card({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={strong ? "cash-summary-strong" : undefined}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

// Relatórios por período (owner/admin). O servidor agrega tudo (report_period); a tela só mostra e
// exporta o PDF estruturado. Período em dias civis de America/Sao_Paulo.
export function ReportsPage({ source = supabaseReportsSource }: { source?: ReportsSource }) {
  const { activeMembership } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const companyName = activeMembership?.company.name ?? "";

  const [period, setPeriod] = useState<ReportPeriod>(() => presetPeriod("today", todayInSaoPaulo()));
  const [categoryId, setCategoryId] = useState("");
  const [sectorId, setSectorId] = useState("");
  const [categories, setCategories] = useState<ReportFilterOption[]>([]);
  const [sectors, setSectors] = useState<ReportFilterOption[]>([]);
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [tab, setTab] = useState<Tab>("sales");

  useEffect(() => {
    if (!companyId) return;
    void source.listCategories(companyId).then(setCategories);
    void source.listSectors(companyId).then(setSectors);
  }, [companyId, source]);

  const generate = useCallback(
    async (p: ReportPeriod) => {
      if (!companyId) return;
      const problem = validatePeriod(p);
      if (problem) {
        setError(problem);
        return;
      }
      setLoading(true);
      setError(null);
      const result = await source.load(companyId, p, { categoryId: categoryId || null, sectorId: sectorId || null });
      setLoading(false);
      if (result.error || !result.data) {
        setError(result.error ?? "Não foi possível gerar o relatório.");
        return;
      }
      setData(result.data);
    },
    [companyId, source, categoryId, sectorId],
  );

  // Abre já com o relatório de hoje.
  useEffect(() => {
    void generate(period);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  function applyPreset(preset: Preset) {
    const next = presetPeriod(preset, todayInSaoPaulo());
    setPeriod(next);
    void generate(next);
  }

  async function exportPdf() {
    if (!data) return;
    setExporting(true);
    setError(null);
    try {
      const blob = await buildReportPdf(data, companyName);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = reportFileName(data);
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Falha ao gerar o PDF:", e);
      setError("Não foi possível gerar o PDF agora. Tente novamente.");
    } finally {
      setExporting(false);
    }
  }

  const f = formatReais;

  return (
    <div>
      <div className="page-header">
        <h2>Relatórios</h2>
        <button className="btn-primary btn-auto" type="button" disabled={!data || exporting} onClick={() => void exportPdf()}>
          {exporting ? "Gerando PDF…" : "Exportar PDF"}
        </button>
      </div>

      <div className="report-filters">
        <div className="report-presets" role="group" aria-label="Atalhos de período">
          {(Object.keys(PRESET_LABEL) as Preset[]).map((p) => (
            <button key={p} type="button" className="op-chip" onClick={() => applyPreset(p)}>
              {PRESET_LABEL[p]}
            </button>
          ))}
        </div>
        <div className="field">
          <label htmlFor="report-from">De</label>
          <input id="report-from" type="date" value={period.from} onChange={(e) => setPeriod({ ...period, from: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="report-to">Até</label>
          <input id="report-to" type="date" value={period.to} onChange={(e) => setPeriod({ ...period, to: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="report-category">Categoria</label>
          <select id="report-category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Todas</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="report-sector">Setor</label>
          <select id="report-sector" value={sectorId} onChange={(e) => setSectorId(e.target.value)}>
            <option value="">Todos</option>
            {sectors.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <button className="btn-secondary" type="button" disabled={loading} onClick={() => void generate(period)}>
          {loading ? "Gerando…" : "Gerar relatório"}
        </button>
      </div>
      <p className="field-hint">
        Período em dias corridos, horário de Brasília. Categoria e setor filtram Produtos vendidos e Produção.
        {data && ` Mostrando: ${periodLabel(data.period)}.`}
      </p>

      {error && <div className="form-error">{error}</div>}
      {!data && !error && <p className="op-state">Gerando relatório…</p>}

      {data && (
        <>
          <dl className="cash-summary report-cards">
            <Card label="Total vendido" value={f(data.sales.gross)} strong />
            <Card label="Estornado" value={f(data.sales.refunded)} />
            <Card label="Líquido" value={f(data.sales.net)} strong />
            <Card label="Contas fechadas" value={String(data.sales.sessions)} />
            <Card label="Ticket médio" value={data.sales.ticket === null ? "—" : f(data.sales.ticket)} />
            <Card label="Itens vendidos" value={String(data.sales.items_sold)} />
          </dl>

          <div className="tab-bar" role="tablist" aria-label="Seções do relatório">
            {TABS.map((t) => (
              <button key={t.value} role="tab" type="button" aria-selected={tab === t.value} className={tab === t.value ? "tab tab-active" : "tab"} onClick={() => setTab(t.value)}>
                {t.label}
              </button>
            ))}
          </div>

          {tab === "sales" && (
            <section>
              <h3>Formas de pagamento</h3>
              <ul className="report-list">
                {data.methods.map((m) => (
                  <li key={m.method} className="report-row">
                    <strong>{METHOD_LABEL[m.method]}</strong>
                    <span>Recebido: {f(m.paid)}</span>
                    <span>Estornado: {f(m.refunded)}</span>
                    <span>Líquido: {f(m.net)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {tab === "products" && (
            <section>
              {data.products.length === 0 ? (
                <p className="field-hint">Nenhum produto vendido no período.</p>
              ) : (
                <ul className="report-list">
                  {data.products.map((p) => (
                    <li key={p.product_id} className="report-row">
                      <strong>{p.name}</strong>
                      <span>{p.quantity_valid} un</span>
                      <span>Bruto: {f(p.value_gross)}</span>
                      <span>{p.cancelled_quantity > 0 ? `Cancelados: ${p.cancelled_quantity} (${f(p.cancelled_value)})` : "Sem cancelamentos"}</span>
                      <span>Líquido: {f(p.value_net)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {tab === "cash" && (
            <section>
              <dl className="cash-summary">
                <Card label="Caixas abertos / fechados" value={`${data.cash.open_count} / ${data.cash.closed_count}`} />
                <Card label="Saldo inicial (soma)" value={f(data.cash.opening_total)} />
                <Card label="Vendas" value={f(data.cash.sales_total)} />
                <Card label="Suprimentos" value={f(data.cash.supply_total)} />
                <Card label="Sangrias" value={f(data.cash.withdrawal_total)} />
                <Card label="Estornos pagos" value={f(data.cash.refund_total)} />
                <Card label="Faltas" value={f(data.cash.shortage_total)} />
                <Card label="Sobras" value={f(data.cash.surplus_total)} />
              </dl>
              <h3>Por sessão de caixa</h3>
              {data.cash.list.length === 0 ? (
                <p className="field-hint">Nenhum caixa aberto no período.</p>
              ) : (
                <ul className="report-list">
                  {data.cash.list.map((k) => (
                    <li key={k.id} className="report-row">
                      <strong>{k.operator_name ?? "—"}</strong>
                      <span>
                        {when(k.opened_at)} → {k.closed_at ? when(k.closed_at) : "aberto"}
                      </span>
                      <span>Inicial {f(k.opening_amount)} · Vendas {f(k.sales)}</span>
                      <span>
                        Suprimento {f(k.supply)} · Sangria {f(k.withdrawal)} · Estornos {f(k.refund)}
                      </span>
                      <span>{cashDifferenceText(k.cash_difference, f)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {tab === "cancellations" && (
            <section>
              <dl className="cash-summary">
                <Card label="Eventos" value={String(data.cancellations.events)} />
                <Card label="Itens cancelados" value={String(data.cancellations.quantity)} />
                <Card label="Valor" value={f(data.cancellations.value)} />
              </dl>
              {data.cancellations.list.length === 0 ? (
                <p className="field-hint">Nenhum cancelamento no período.</p>
              ) : (
                <ul className="report-list">
                  {data.cancellations.list.map((c) => (
                    <li key={c.id} className="report-row">
                      <strong>
                        {c.quantity}× {c.product}
                      </strong>
                      <span>{pointText(c)}</span>
                      <span>“{c.reason}”</span>
                      <span>
                        {c.cancelled_by_name ?? "—"} · {when(c.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {tab === "refunds" && (
            <section>
              <dl className="cash-summary">
                <Card label="Estornos" value={String(data.refunds.count)} />
                <Card label="Total estornado" value={f(data.refunds.total)} />
              </dl>
              {data.refunds.list.length === 0 ? (
                <p className="field-hint">Nenhum estorno no período.</p>
              ) : (
                <ul className="report-list">
                  {data.refunds.list.map((r) => (
                    <li key={r.id} className="report-row">
                      <strong>
                        {METHOD_LABEL[r.method]} · {f(r.amount)}
                      </strong>
                      <span>{pointText(r)}</span>
                      <span>“{r.reason}”</span>
                      <span>
                        {r.refunded_by_name ?? "—"} · {when(r.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {tab === "production" && (
            <section>
              <dl className="cash-summary">
                <Card label="Itens produzidos" value={String(data.production.items)} />
                <Card label="Tempo médio de produção" value={data.production.avg_minutes === null ? "—" : `${data.production.avg_minutes} min`} />
                <Card label="Cancelados em produção" value={String(data.production.cancelled_in_production)} />
              </dl>
              <div className="report-two-cols">
                <div>
                  <h3>Por setor</h3>
                  {data.production.by_sector.length === 0 ? (
                    <p className="field-hint">Sem produção no período.</p>
                  ) : (
                    <ul className="report-list">
                      {data.production.by_sector.map((s) => (
                        <li key={s.sector} className="report-row">
                          <strong>{s.sector}</strong>
                          <span>{s.quantity}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <h3>Por produto</h3>
                  {data.production.by_product.length === 0 ? (
                    <p className="field-hint">Sem produção no período.</p>
                  ) : (
                    <ul className="report-list">
                      {data.production.by_product.map((p) => (
                        <li key={p.name} className="report-row">
                          <strong>{p.name}</strong>
                          <span>{p.quantity}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

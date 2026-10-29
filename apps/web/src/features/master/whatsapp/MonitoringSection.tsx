import { useCallback, useEffect, useState } from "react";
import { fmtDateTimeSP } from "../../../lib/dates";
import { Badge, Kpi } from "../MasterBits";
import { whatsappMasterApi } from "./whatsappMasterApi";
import {
  HEALTH_LABEL,
  HEALTH_TONE,
  HISTORY_PAGE_SIZE,
  RUN_SOURCE_LABEL,
  RUN_STATUS_LABEL,
  RUN_STATUS_TONE,
  describeMonitoring,
  offsetForPage,
  pageCount,
  pageOfOffset,
  type HistoryPage,
  type RunSource,
  type RunStatus,
  type SweepStatus,
} from "./whatsappMasterLogic";

export function MonitoringSection() {
  const [status, setStatus] = useState<SweepStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async () => {
    setLoading(true);
    const r = await whatsappMasterApi.sweepStatus();
    setStatus(r.data);
    setStatusError(r.error);
    setNow(new Date());
    setLoading(false);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const view = status ? describeMonitoring(status, now) : null;
  const last = status?.lastRun ?? null;

  return (
    <section className="mst-card" aria-labelledby="wa-mon-title">
      <div className="mst-head">
        <h3 id="wa-mon-title">Monitoramento da saúde dos tokens</h3>
        <button type="button" className="btn-secondary" onClick={() => void load()} disabled={loading}>
          {loading ? "Atualizando…" : "Atualizar"}
        </button>
      </div>
      {statusError && (
        <div className="form-error" role="alert">
          {statusError}
        </div>
      )}
      {!status && !statusError && <p>Carregando…</p>}
      {status && view && (
        <>
          <dl className="mst-kpis">
            <Kpi label="Saúde da varredura" value={<Badge tone={HEALTH_TONE[status.health]}>{HEALTH_LABEL[status.health]}</Badge>} />
            <Kpi
              label="Última execução"
              value={last ? <Badge tone={RUN_STATUS_TONE[last.status]}>{RUN_STATUS_LABEL[last.status]}</Badge> : "—"}
              hint={last ? `${fmtDateTimeSP(last.startedAt)} · ${RUN_SOURCE_LABEL[last.source]}` : "Nenhuma execução registrada"}
            />
            <Kpi label="Último sucesso" value={status.lastSuccessAt ? fmtDateTimeSP(status.lastSuccessAt) : "—"} />
            <Kpi
              label="Próximo disparo"
              value={view.nextRunAt ? fmtDateTimeSP(view.nextRunAt.toISOString()) : "—"}
              hint={status.job ? (status.job.active ? "Agendador ativo (a cada 6 h)" : "Agendador desativado") : "Agendador não encontrado"}
            />
            <Kpi label="Falhas nas últimas 24 h" value={status.failures24h} />
            <Kpi
              label="Disparo automático"
              value={view.cronConfirmed ? "Confirmado" : "Pendente"}
              hint={view.cronConfirmed ? `Último: ${fmtDateTimeSP(status.lastCronRun?.startTime ?? null)}` : "Nenhuma execução do agendador registrada"}
            />
          </dl>
          {view.notices.length > 0 && (
            <ul className="mst-banner" aria-label="Avisos do monitoramento" style={{ listStylePosition: "inside" }}>
              {view.notices.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          {status.recentFailures.length > 0 && (
            <details>
              <summary>Falhas recentes ({status.recentFailures.length})</summary>
              <ul>
                {status.recentFailures.map((f, i) => (
                  <li key={`${f.startedAt}-${i}`}>
                    {fmtDateTimeSP(f.startedAt)} · {RUN_SOURCE_LABEL[f.source]} · {f.errorCode ?? "—"}
                    {f.errorMessage ? ` — ${f.errorMessage}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      <HistoryTable />
    </section>
  );
}

export function HistoryTable() {
  const [statusFilter, setStatusFilter] = useState<RunStatus | "">("");
  const [sourceFilter, setSourceFilter] = useState<RunSource | "">("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const r = await whatsappMasterApi.sweepHistory({ status: statusFilter || null, source: sourceFilter || null, limit: HISTORY_PAGE_SIZE, offset });
      if (cancelled) return;
      setPage(r.data);
      setError(r.error);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [statusFilter, sourceFilter, offset]);

  const current = pageOfOffset(offset, HISTORY_PAGE_SIZE);
  const total = page ? pageCount(page.total, page.limit) : 1;

  return (
    <div style={{ marginTop: 16 }}>
      <h4 style={{ margin: "0 0 8px" }}>Histórico de execuções</h4>
      <div className="mst-toolbar">
        <div>
          <label htmlFor="wa-h-status">Resultado</label>
          <select
            id="wa-h-status"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as RunStatus | "");
              setOffset(0);
            }}
          >
            <option value="">Todos</option>
            <option value="success">Sucesso</option>
            <option value="failed">Falha</option>
            <option value="skipped_concurrent">Ignorada</option>
          </select>
        </div>
        <div>
          <label htmlFor="wa-h-source">Origem</label>
          <select
            id="wa-h-source"
            value={sourceFilter}
            onChange={(e) => {
              setSourceFilter(e.target.value as RunSource | "");
              setOffset(0);
            }}
          >
            <option value="">Todas</option>
            <option value="cron">Agendador (cron)</option>
            <option value="manual">Manual</option>
          </select>
        </div>
      </div>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {!error && loading && !page && <p>Carregando histórico…</p>}
      {page && <HistoryContent page={page} loading={loading} current={current} total={total} onPage={(p) => setOffset(offsetForPage(p, HISTORY_PAGE_SIZE))} />}
    </div>
  );
}

export function HistoryContent({ page, loading, current, total, onPage }: { page: HistoryPage; loading: boolean; current: number; total: number; onPage: (p: number) => void }) {
  return (
    <>
      {page.rows.length === 0 && <p className="mst-sub">Nenhuma execução encontrada com esses filtros.</p>}
      {page && page.rows.length > 0 && (
        <div className="mst-scroll">
          <table className="mst-table">
            <thead>
              <tr>
                <th>Início</th>
                <th>Origem</th>
                <th>Resultado</th>
                <th className="mst-num">Verificadas</th>
                <th className="mst-num">Atualizadas</th>
                <th className="mst-num">Alertas (novos/renovados)</th>
                <th>Erro</th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((r) => (
                <tr key={r.id ?? `${r.startedAt}-${r.source}`}>
                  <td>{fmtDateTimeSP(r.startedAt)}</td>
                  <td>{RUN_SOURCE_LABEL[r.source]}</td>
                  <td>
                    <Badge tone={RUN_STATUS_TONE[r.status]}>{RUN_STATUS_LABEL[r.status]}</Badge>
                  </td>
                  <td className="mst-num">{r.checked}</td>
                  <td className="mst-num">{r.updated}</td>
                  <td className="mst-num">
                    {r.alertsCreated}/{r.alertsRefreshed}
                  </td>
                  <td>{r.errorCode ? `${r.errorCode}${r.errorMessage ? ` — ${r.errorMessage}` : ""}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page && page.total > page.limit && (
        <div className="mst-actions" role="navigation" aria-label="Paginação do histórico">
          <button type="button" className="btn-secondary" disabled={loading || current <= 1} onClick={() => onPage(current - 1)}>
            Anterior
          </button>
          <span style={{ alignSelf: "center" }}>
            Página {current} de {total} · {page.total} execuções
          </span>
          <button type="button" className="btn-secondary" disabled={loading || current >= total} onClick={() => onPage(current + 1)}>
            Próxima
          </button>
        </div>
      )}
    </>
  );
}

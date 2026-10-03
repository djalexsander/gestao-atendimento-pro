import { offlinePendingNotices, STATUS_LABEL, jobOrderLabel, jobPrinterName, jobTypeLabel, type PrintAgent, type PrintDevice, type PrintJob } from "./printingLogic";
import {
  FILTER_LABEL,
  attentionCounts,
  formatDayBR,
  groupByDay,
  visibleHistory,
  type QueueFilter,
  type QueueState,
} from "./printingQueueLogic";
import { formatDateTime } from "./PrinterDialogs";

const FILTERS: QueueFilter[] = ["today", "yesterday", "week", "custom"];

const timeFmt = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : timeFmt.format(d);
}

function statusClass(job: PrintJob): string {
  if (job.status === "error") return "print-status-error";
  if (job.status === "printed") return "status-active";
  return "status-inactive";
}

function JobRow({
  job,
  showDate,
  busy,
  canReprint,
  reprintHint,
  onDetails,
  onReprint,
}: {
  job: PrintJob;
  showDate: boolean;
  busy: boolean;
  canReprint: boolean;
  reprintHint: string | undefined;
  onDetails: () => void;
  onReprint: () => void;
}) {
  const base = jobTypeLabel({ job_type: job.job_type, reprint_of_id: null });
  return (
    <li className={`pq-row pq-${job.status}`}>
      <div className="pq-main">
        <span className="pq-title">{base}</span>
        {job.reprint_of_id && <span className="pq-reprint">Reimpressão</span>}
        <span className="pq-ref">{jobOrderLabel(job)}</span>
      </div>
      <div className="pq-meta">
        {showDate ? formatDateTime(job.created_at) : formatTime(job.created_at)} · {jobPrinterName(job)}
        {job.attempts > 1 ? ` · ${job.attempts} tentativas` : ""}
      </div>
      {job.status === "error" && job.error_message && <div className="pq-error">{job.error_message}</div>}
      <div className="pq-side">
        <span className={`status-badge ${statusClass(job)}`}>{STATUS_LABEL[job.status]}</span>
        <button className="btn-secondary btn-small" type="button" onClick={onDetails}>
          Detalhes
        </button>
        <button className="btn-secondary btn-small" type="button" disabled={busy || !canReprint} title={reprintHint} onClick={onReprint}>
          {busy ? "Enviando…" : "Reimprimir"}
        </button>
      </div>
    </li>
  );
}

// Aba "Fila de impressão": filtros de período, bloco Atenção (qualquer data) e Histórico do período (paginado).
export function PrintQueue({
  state,
  devices,
  agents,
  now,
  busyId,
  onFilter,
  onCustom,
  onRefresh,
  onLoadMore,
  onDetails,
  onReprint,
}: {
  state: QueueState | null;
  devices: PrintDevice[];
  agents: PrintAgent[] | null;
  now: number;
  busyId: string | null;
  onFilter: (filter: QueueFilter) => void;
  onCustom: (from: string, to: string) => void;
  onRefresh: () => void;
  onLoadMore: () => void;
  onDetails: (job: PrintJob) => void;
  onReprint: (job: PrintJob) => void;
}) {
  if (!state) return <p className="op-state">Carregando fila de impressão…</p>;

  const readyIds = new Set(devices.filter((d) => d.ready).map((d) => d.id));
  const activeIds = new Set(devices.map((d) => d.id));
  const attention = state.attention ?? [];
  const history = visibleHistory(state.history ?? [], attention);
  const counts = attentionCounts(attention);
  const multiDay = state.range.from !== state.range.to;
  const reprintHint = (job: PrintJob) =>
    readyIds.has(job.print_device_id)
      ? undefined
      : activeIds.has(job.print_device_id)
        ? "A impressora ainda não está conectada ao Agente de Impressão."
        : "A impressora desta impressão foi removida.";
  const row = (job: PrintJob, showDate: boolean) => (
    <JobRow
      key={job.id}
      job={job}
      showDate={showDate}
      busy={busyId === job.id}
      canReprint={readyIds.has(job.print_device_id)}
      reprintHint={reprintHint(job)}
      onDetails={() => onDetails(job)}
      onReprint={() => onReprint(job)}
    />
  );

  return (
    <div className="pq">
      <div className="pq-toolbar">
        <div className="pq-chips" role="group" aria-label="Período">
          {FILTERS.map((f) => (
            <button key={f} className="op-chip" type="button" aria-pressed={state.filter === f} onClick={() => onFilter(f)}>
              {FILTER_LABEL[f]}
            </button>
          ))}
        </div>
        <button className="btn-secondary btn-small" type="button" onClick={onRefresh}>
          Atualizar
        </button>
      </div>

      {state.filter === "custom" && (
        <div className="pq-custom">
          <div className="field">
            <label htmlFor="pq-from">Data inicial</label>
            <input id="pq-from" type="date" value={state.custom.from} onChange={(e) => onCustom(e.target.value, state.custom.to)} />
          </div>
          <div className="field">
            <label htmlFor="pq-to">Data final</label>
            <input id="pq-to" type="date" value={state.custom.to} onChange={(e) => onCustom(state.custom.from, e.target.value)} />
          </div>
          {state.rangeError && <div className="form-error">{state.rangeError}</div>}
        </div>
      )}

      {state.error && <div className="form-error">{state.error}</div>}

      {offlinePendingNotices(attention, devices, agents, now).map((message) => (
        <p key={message} className="form-notice" role="status">
          {message}
        </p>
      ))}

      {attention.length > 0 && (
        <section className="pq-section pq-attention" aria-label="Atenção">
          <h3 className="pq-heading">
            Atenção
            <span className="pq-counters">
              {counts.pending > 0 && ` · Pendentes: ${counts.pending}`}
              {counts.claimed > 0 && ` · Imprimindo: ${counts.claimed}`}
              {counts.error > 0 && ` · Erros: ${counts.error}`}
            </span>
          </h3>
          {state.attentionTruncated && (
            <p className="field-hint">Há {state.attentionTotal} impressões em aberto. Mostrando as {attention.length} mais prioritárias (erros primeiro).</p>
          )}
          <ul className="pq-list">{attention.map((job) => row(job, true))}</ul>
        </section>
      )}

      <section className="pq-section" aria-label="Histórico do período">
        <h3 className="pq-heading">
          Histórico do período
          <span className="pq-counters">
            {" · "}
            {multiDay ? `${formatDayBR(state.range.from)} a ${formatDayBR(state.range.to)}` : formatDayBR(state.range.from)}
          </span>
        </h3>
        {state.rangeError ? null : state.history === null ? (
          <p className="op-state">Carregando…</p>
        ) : history.length === 0 ? (
          <p className="op-state">Nenhuma impressão neste período.</p>
        ) : multiDay ? (
          groupByDay(history).map((group) => (
            <div key={group.day} className="pq-day-group">
              <h4 className="pq-day">{group.label}</h4>
              <ul className="pq-list">{group.jobs.map((job) => row(job, false))}</ul>
            </div>
          ))
        ) : (
          <ul className="pq-list">{history.map((job) => row(job, false))}</ul>
        )}
        {state.hasMore && (
          <div className="pq-more">
            <button className="btn-secondary" type="button" disabled={state.loadingMore} onClick={onLoadMore}>
              {state.loadingMore ? "Carregando…" : "Carregar mais"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

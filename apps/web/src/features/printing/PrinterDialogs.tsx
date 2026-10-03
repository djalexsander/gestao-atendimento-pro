import { useEffect, useState, type FormEvent } from "react";
import type { JobDetails } from "./printingApi";
import { Modal } from "../employees/Modal";
import {
  DOCUMENT_ROUTES,
  NAME_MAX_LENGTH,
  PAPER_WIDTHS,
  printersForSector,
  validateDeviceName,
  type DeviceInput,
  type DocumentRoute,
  type PaperWidth,
  type PrintDevice,
  type PrintJob,
  type PrintSector,
  STATUS_LABEL,
  jobOrderLabel,
  jobPrinterName,
  jobTypeLabel,
} from "./printingLogic";

// `onSubmit` devolve a mensagem de erro (ou null quando deu certo); quem fecha o diálogo em caso
// de sucesso é a tela (mesmo contrato dos demais diálogos administrativos).
type Submit<T> = (value: T) => Promise<string | null>;

function Actions({
  submitting,
  submitLabel,
  submittingLabel,
  danger,
  onClose,
}: {
  submitting: boolean;
  submitLabel: string;
  submittingLabel: string;
  danger?: boolean;
  onClose: () => void;
}) {
  return (
    <div className="modal-actions">
      <button className="btn-secondary" type="button" disabled={submitting} onClick={onClose}>
        Cancelar
      </button>
      <button className={danger ? "btn-danger" : "btn-primary btn-auto"} type="submit" disabled={submitting}>
        {submitting ? submittingLabel : submitLabel}
      </button>
    </div>
  );
}

// ADICIONAR / EDITAR impressora. `device` ausente = adicionar.
// O campo "Impressora do Windows" é só o CONTRATO: sem Agente conectado não há lista, e o
// navegador nunca deixa digitar um nome como se fosse descoberta automática. Quando o Agente
// existir, `windowsPrinters` passa a trazer a lista e o campo vira um select habilitado.
export function PrinterDialog({
  device,
  devices,
  sectors,
  windowsPrinters = [],
  onSubmit,
  onClose,
}: {
  device?: PrintDevice;
  devices: PrintDevice[];
  sectors: PrintSector[];
  windowsPrinters?: string[];
  onSubmit: Submit<DeviceInput>;
  onClose: () => void;
}) {
  const [name, setName] = useState(device?.name ?? "");
  const [width, setWidth] = useState<PaperWidth>(device?.paper_width ?? 80);
  const [fullOrder, setFullOrder] = useState(device?.full_order ?? false);
  const [sectorIds, setSectorIds] = useState<string[]>(device?.sector_ids ?? []);
  const [documents, setDocuments] = useState<DocumentRoute[]>(device?.documents ?? []);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Setores ativos; um setor inativo já escolhido continua aparecendo para poder ser desmarcado.
  const listed = sectors
    .filter((s) => s.is_active || sectorIds.includes(s.id))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  const agentConnected = windowsPrinters.length > 0;

  function toggle(id: string) {
    setSectorIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function toggleDocument(value: DocumentRoute) {
    setDocuments((prev) => (prev.includes(value) ? prev.filter((x) => x !== value) : [...prev, value]));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const problem = validateDeviceName(name);
    if (problem) {
      setError(problem);
      return;
    }
    setSubmitting(true);
    const failure = await onSubmit({ name: name.trim(), paper_width: width, full_order: fullOrder, sector_ids: sectorIds, documents });
    setSubmitting(false);
    if (failure) setError(failure);
  }

  return (
    <Modal title={device ? "Editar impressora" : "Adicionar impressora"} onClose={onClose}>
      <form onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label htmlFor="printer-name">Nome</label>
          <input
            id="printer-name"
            type="text"
            value={name}
            maxLength={NAME_MAX_LENGTH}
            placeholder="Impressora Cozinha"
            autoComplete="off"
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="printer-width">Largura do papel</label>
          <select id="printer-width" value={width} onChange={(e) => setWidth(Number(e.target.value) as PaperWidth)}>
            {PAPER_WIDTHS.map((w) => (
              <option key={w} value={w}>
                {w} mm
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="printer-windows">Impressora do Windows</label>
          <select id="printer-windows" disabled={!agentConnected} defaultValue="">
            {agentConnected ? (
              windowsPrinters.map((p) => <option key={p}>{p}</option>)
            ) : (
              <option value="">Agente de impressão não conectado</option>
            )}
          </select>
          <p className="field-hint">A impressora física será escolhida pelo Agente de impressão.</p>
        </div>

        <fieldset className="print-destinations">
          <legend>Destinos automáticos</legend>
          <p className="field-hint">Imprimem sozinhos quando o pedido é enviado.</p>
          <label className="checkbox-row">
            <input type="checkbox" checked={fullOrder} onChange={(e) => setFullOrder(e.target.checked)} />
            Pedido completo
          </label>
          {listed.length === 0 ? (
            <p className="field-hint">Nenhum setor de produção cadastrado.</p>
          ) : (
            listed.map((sector) => {
              const checked = sectorIds.includes(sector.id);
              const count = printersForSector(sector.id, devices, { id: device?.id ?? null, checked });
              return (
                <div key={sector.id}>
                  <label className="checkbox-row">
                    <input type="checkbox" checked={checked} onChange={() => toggle(sector.id)} />
                    {sector.name}
                    {!sector.is_active && " (inativo)"}
                  </label>
                  {checked && count >= 2 && <p className="field-hint">Este setor imprime em {count} impressoras.</p>}
                </div>
              );
            })
          )}
        </fieldset>

        <fieldset className="print-destinations">
          <legend>Documentos manuais</legend>
          <p className="field-hint">Só imprimem quando o usuário pede (botão Imprimir ou F8).</p>
          {DOCUMENT_ROUTES.map((doc) => (
            <label key={doc.value} className="checkbox-row">
              <input type="checkbox" checked={documents.includes(doc.value)} onChange={() => toggleDocument(doc.value)} />
              {doc.label}
            </label>
          ))}
        </fieldset>

        {error && <div className="form-error">{error}</div>}
        <Actions submitting={submitting} submitLabel="Salvar" submittingLabel="Salvando…" onClose={onClose} />
      </form>
    </Modal>
  );
}

export function RemovePrinterDialog({
  device,
  onConfirm,
  onClose,
}: {
  device: PrintDevice;
  onConfirm: () => Promise<string | null>;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const failure = await onConfirm();
    setSubmitting(false);
    if (failure) setError(failure);
  }

  return (
    <Modal title="Remover impressora" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <p className="modal-text">Remover a impressora '{device.name}' da configuração?</p>
        <p className="field-hint">O histórico de impressões será preservado.</p>
        {error && <div className="form-error">{error}</div>}
        <Actions submitting={submitting} submitLabel="Remover impressora" submittingLabel="Removendo…" danger onClose={onClose} />
      </form>
    </Modal>
  );
}

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });
export function formatDateTime(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : dateTime.format(d);
}

function formatMoney(value: number): string {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function JobDetailsDialog({
  job: listJob,
  loadDetails,
  onClose,
}: {
  job: PrintJob;
  loadDetails: () => Promise<{ data: JobDetails | null; error: string | null }>;
  onClose: () => void;
}) {
  // A lista traz só o resumo; o payload completo e os carimbos de tempo vêm sob demanda, ao abrir.
  const [details, setDetails] = useState<JobDetails | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void loadDetails().then((result) => {
      if (cancelled) return;
      if (result.data) setDetails(result.data);
      else setFailed(true);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listJob.id]);
  const job = details?.job ?? listJob;
  const p = job.payload;
  return (
    <Modal title="Detalhes da impressão" onClose={onClose}>
      {failed && <div className="form-error">Não foi possível carregar todos os detalhes agora.</div>}
      <dl className="print-details">
        <dt>Código</dt>
        <dd className="mono">{job.id}</dd>
        <dt>Tipo</dt>
        <dd>{jobTypeLabel(job)}</dd>
        <dt>Impressora</dt>
        <dd>{details?.printer_name ?? jobPrinterName(job)}</dd>
        {details && (
          <>
            <dt>Impressora do Windows</dt>
            <dd>{details.windows_printer_name ?? "Sem vínculo"}</dd>
          </>
        )}
        <dt>Status</dt>
        <dd>{STATUS_LABEL[job.status]}</dd>
        <dt>Criado em</dt>
        <dd>{formatDateTime(job.created_at)}</dd>
        {details && (
          <>
            <dt>Enviado ao Agente</dt>
            <dd>{formatDateTime(details.claimed_at ?? undefined)}</dd>
            <dt>Impresso em</dt>
            <dd>{formatDateTime(details.printed_at ?? undefined)}</dd>
          </>
        )}
        <dt>Tentativas</dt>
        <dd>{job.attempts}</dd>
        {(job.job_type === "production_order" || job.job_type === "production_cancellation" || job.job_type === "customer_bill" || job.job_type === "payment_receipt") && (
          <>
            <dt>Comanda/Mesa</dt>
            <dd>{jobOrderLabel(job)}</dd>
            {p.customer_name && (
              <>
                <dt>Cliente</dt>
                <dd>{p.customer_name}</dd>
              </>
            )}
          </>
        )}
        {job.job_type === "production_cancellation" ? (
          <>
            <dt>Motivo</dt>
            <dd>{p.reason ?? "—"}</dd>
            <dt>Cancelado por</dt>
            <dd>{p.cancelled_by?.name ?? "—"}</dd>
          </>
        ) : (
          job.job_type === "production_order" && (
            <>
              <dt>Enviado por</dt>
              <dd>{p.operator?.name ?? "—"}</dd>
            </>
          )
        )}
        {(job.job_type === "customer_bill" || job.job_type === "payment_receipt") && p.total !== undefined && (
          <>
            <dt>Total</dt>
            <dd>{formatMoney(p.total)}</dd>
          </>
        )}
        {job.job_type === "payment_receipt" && p.net_total !== undefined && (
          <>
            <dt>Líquido</dt>
            <dd>{formatMoney(p.net_total)}</dd>
          </>
        )}
        {job.job_type === "cash_closing" && p.difference_label && (
          <>
            <dt>Conferência</dt>
            <dd>{p.difference_label}</dd>
          </>
        )}
        {p.reprint && (
          <>
            <dt>Reimpressão</dt>
            <dd>
              {formatDateTime(p.reprint.requested_at)}
              {p.reprint.requested_by?.name ? ` · ${p.reprint.requested_by.name}` : ""}
            </dd>
          </>
        )}
        {job.error_message && (
          <>
            <dt>Erro</dt>
            <dd>{job.error_message}</dd>
          </>
        )}
      </dl>
      {(p.items?.length ?? 0) > 0 && (
        <ul className="print-items">
          {p.items!.map((item, index) => (
            <li key={index}>
              {item.quantity}x {item.product_name}
              {item.notes ? ` — ${item.notes}` : ""}
            </li>
          ))}
        </ul>
      )}
      <div className="modal-actions">
        <button className="btn-secondary" type="button" onClick={onClose}>
          Fechar
        </button>
      </div>
    </Modal>
  );
}

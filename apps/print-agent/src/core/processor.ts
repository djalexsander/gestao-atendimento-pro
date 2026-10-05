import type { ApiResult, Credentials } from "./api.ts";
import { buildDocument } from "./document-builders.ts";
import type { PrintDocument } from "./document.ts";
import { describeJob, type JobModel } from "./model.ts";
import { renderLabelPages, type LabelPageBitmap, type SurfaceFactory } from "./labels/labelRaster.ts";
import type { PrinterTransport } from "./transport.ts";

// Etiquetas: o agente desenha o bitmap (superfície injetada) e o envia ao DRIVER do Windows (GDI), sem ZPL/EPL/TSPL.
export interface LabelPrinterPort {
  printLabels(printerName: string, pages: LabelPageBitmap[], purpose: "diagnostic" | "job"): Promise<void>;
}
export interface LabelDeps {
  port: LabelPrinterPort;
  makeSurface: SurfaceFactory;
}

// Pipeline de UM job já reclamado (claimed):
//   documento (PrintDocument) -> transporte (simulação | RAW ESC/POS) -> complete_print_job
// complete só roda DEPOIS do transporte: nunca se marca "impresso" antes. Nesta etapa o app injeta SEMPRE o
// transporte de SIMULAÇÃO para jobs do servidor (nenhum papel sai); a troca para o real é decisão futura.

export interface ProcessorDeps {
  creds: Credentials;
  transport: PrinterTransport;
  complete(c: Credentials, jobId: string): Promise<ApiResult<null>>;
  fail(c: Credentials, jobId: string, error: string): Promise<ApiResult<null>>;
  log(line: string): void;
  onPreview?(job: JobModel, lines: string[]): void;
  sleep?(ms: number): Promise<void>;
  build?(job: JobModel): PrintDocument;
  labels?: LabelDeps;
}

const COMPLETE_RETRIES = 3;

export async function processJob(job: JobModel, deps: ProcessorDeps): Promise<"completed" | "failed" | "stuck"> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  deps.log(`Job recebido: ${describeJob(job)} (impressora ${job.printerName} → ${job.windowsPrinter ?? "sem impressora do Windows"})`);

  if (job.label) return processLabelJob(job, deps);

  let document: PrintDocument;
  try {
    document = (deps.build ?? buildDocument)(job);
  } catch (error) {
    return failJob(job, deps, `Falha ao montar o papel: ${messageOf(error)}`);
  }

  let mode: "simulation" | "real";
  let sentBytes: number | undefined;
  const target = job.windowsPrinter ?? "impressora não vinculada";
  if (deps.transport.mode === "real") deps.log(`Enviando para ${target}...`);
  try {
    const result = await deps.transport.print({
      printerName: job.windowsPrinter,
      paperWidth: job.paperWidth,
      codePage: job.codePage,
      cutMode: job.cutMode,
      document,
      job,
    });
    mode = result.mode;
    sentBytes = result.bytes;
    deps.onPreview?.(job, result.preview);
  } catch (error) {
    // Falha física: NUNCA marca printed; avisa o servidor com mensagem sem segredos. Não repete sozinho.
    const reason = messageOf(error);
    deps.log(`Falha de impressão: ${reason}`);
    return failJob(job, deps, `Falha ao imprimir em ${target}: ${reason}`, false);
  }
  if (mode === "simulation") deps.log("Simulação concluída (nenhum papel foi impresso)");
  else {
    if (sentBytes !== undefined) deps.log(`${sentBytes} bytes enviados ao spooler`);
    deps.log("Impressão concluída.");
  }

  for (let attempt = 1; attempt <= COMPLETE_RETRIES; attempt += 1) {
    const done = await deps.complete(deps.creds, job.id);
    if (done.ok) return "completed";
    if (done.kind === "rejected" || done.kind === "unauthorized") {
      deps.log(`Servidor não aceitou a conclusão: ${done.message}`);
      return "failed";
    }
    if (attempt < COMPLETE_RETRIES) await sleep(1_000 * attempt);
  }
  // Sem rede para confirmar: o job continua claimed no servidor (vira erro visível após o timeout).
  deps.log("Sem conexão para confirmar a conclusão; o servidor tratará o job se não houver resposta.");
  return "stuck";
}

// Job de etiquetas: rasteriza (uma página por linha física) -> driver do Windows -> complete (só DEPOIS de imprimir).
async function processLabelJob(job: JobModel, deps: ProcessorDeps): Promise<"completed" | "failed" | "stuck"> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const label = job.label!;
  const target = job.windowsPrinter ?? "impressora não vinculada";
  if (!deps.labels) return failJob(job, deps, "Este agente não imprime etiquetas.");
  if (!job.windowsPrinter) return failJob(job, deps, "Nenhuma impressora do Windows vinculada a esta impressora de etiquetas.");

  let pages: LabelPageBitmap[];
  try {
    pages = renderLabelPages(label, deps.labels.makeSurface);
  } catch (error) {
    return failJob(job, deps, `Falha ao montar a etiqueta: ${messageOf(error)}`);
  }
  const g = label.geometry;
  deps.onPreview?.(job, [`${label.quantity} etiqueta(s) ${g.widthMm}x${g.heightMm} mm, ${g.columns} coluna(s) → ${pages.length} linha(s) física(s)`]);
  deps.log(`Enviando ${label.quantity} etiqueta(s) para ${target}...`);
  try {
    await deps.labels.port.printLabels(job.windowsPrinter, pages, "job");
  } catch (error) {
    const reason = messageOf(error);
    deps.log(`Falha de impressão: ${reason}`);
    return failJob(job, deps, `Falha ao imprimir em ${target}: ${reason}`, false);
  }
  deps.log("Impressão concluída.");

  for (let attempt = 1; attempt <= COMPLETE_RETRIES; attempt += 1) {
    const done = await deps.complete(deps.creds, job.id);
    if (done.ok) return "completed";
    if (done.kind === "rejected" || done.kind === "unauthorized") {
      deps.log(`Servidor não aceitou a conclusão: ${done.message}`);
      return "failed";
    }
    if (attempt < COMPLETE_RETRIES) await sleep(1_000 * attempt);
  }
  deps.log("Sem conexão para confirmar a conclusão; o servidor tratará o job se não houver resposta.");
  return "stuck";
}

async function failJob(job: JobModel, deps: ProcessorDeps, message: string, logIt = true): Promise<"failed"> {
  if (logIt) deps.log(`Erro: ${message}`);
  const res = await deps.fail(deps.creds, job.id, message);
  if (!res.ok) deps.log(`Não foi possível avisar o servidor da falha: ${res.message}`);
  return "failed";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

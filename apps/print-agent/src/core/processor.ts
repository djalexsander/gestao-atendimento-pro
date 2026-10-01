import type { ApiResult, Credentials } from "./api.ts";
import { buildDocument } from "./document-builders.ts";
import type { PrintDocument } from "./document.ts";
import { describeJob, type JobModel } from "./model.ts";
import type { PrinterTransport } from "./transport.ts";

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
}

const COMPLETE_RETRIES = 3;

export async function processJob(job: JobModel, deps: ProcessorDeps): Promise<"completed" | "failed" | "stuck"> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  deps.log(`Job recebido: ${describeJob(job)} (impressora ${job.printerName} → ${job.windowsPrinter ?? "sem impressora do Windows"})`);

  let document: PrintDocument;
  try {
    document = (deps.build ?? buildDocument)(job);
  } catch (error) {
    return failJob(job, deps, `Falha ao montar o papel: ${messageOf(error)}`);
  }

  let mode: "simulation" | "real";
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
    deps.onPreview?.(job, result.preview);
  } catch (error) {
    return failJob(job, deps, `Falha ao imprimir: ${messageOf(error)}`);
  }
  deps.log(mode === "simulation" ? "Simulação concluída (nenhum papel foi impresso)" : "Impressão concluída");

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

async function failJob(job: JobModel, deps: ProcessorDeps, message: string): Promise<"failed"> {
  deps.log(`Erro: ${message}`);
  const res = await deps.fail(deps.creds, job.id, message);
  if (!res.ok) deps.log(`Não foi possível avisar o servidor da falha: ${res.message}`);
  return "failed";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

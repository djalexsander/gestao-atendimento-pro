// Modelo interno de um job recebido do servidor (claim_print_jobs) e do que a tela precisa.

import type { CodePage, CutMode } from "./document.ts";

export type JobType =
  | "production_order"
  | "production_cancellation"
  | "test"
  | "customer_bill"
  | "payment_receipt"
  | "cash_closing";

const JOB_TYPES: readonly string[] = [
  "production_order",
  "production_cancellation",
  "test",
  "customer_bill",
  "payment_receipt",
  "cash_closing",
];

export interface JobItem {
  quantity: number;
  productName: string;
  notes: string | null;
  unitPrice: number | null;
  total: number | null;
}

export interface JobModel {
  id: string;
  type: JobType;
  attempts: number;
  isReprint: boolean;
  printerName: string; // impressora LÓGICA (snapshot do job)
  windowsPrinter: string | null; // impressora física vinculada
  paperWidth: 58 | 80;
  codePage: CodePage;
  cutMode: CutMode;
  pointLabel: string | null;
  customerName: string | null;
  items: JobItem[];
  payload: Record<string, unknown>; // snapshot completo (o render lê daqui)
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
const text = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// Transforma o JSON cru do servidor no modelo interno; devolve null se faltar o essencial (o chamador
// então FALHA o job com mensagem clara em vez de imprimir lixo).
export function toJobModel(raw: unknown): JobModel | null {
  const o = asRecord(raw);
  const id = text(o.id);
  const type = text(o.job_type);
  if (!id || !type || !JOB_TYPES.includes(type)) return null;
  const payload = asRecord(o.payload);
  const items = Array.isArray(payload.items)
    ? payload.items.map((entry): JobItem => {
        const e = asRecord(entry);
        return {
          quantity: num(e.quantity) ?? 0,
          productName: text(e.product_name) ?? "?",
          notes: text(e.notes),
          unitPrice: num(e.unit_price),
          total: num(e.total),
        };
      })
    : [];
  const point = asRecord(payload.service_point);
  return {
    id,
    type: type as JobType,
    attempts: num(o.attempts) ?? 0,
    isReprint: payload.reprint !== undefined || text(o.reprint_of_id) !== null,
    printerName: text(o.device_name) ?? text(asRecord(payload.printer).name) ?? "?",
    windowsPrinter: text(o.windows_printer_name),
    paperWidth: o.paper_width === 58 ? 58 : 80,
    codePage: o.escpos_codepage === "cp860" || o.escpos_codepage === "cp1252" ? o.escpos_codepage : "cp850",
    cutMode: o.cut_mode === "none" || o.cut_mode === "full" ? o.cut_mode : "partial",
    pointLabel: text(point.label),
    customerName: text(payload.customer_name),
    items,
    payload,
  };
}

export function parseClaimResult(raw: unknown): { jobs: JobModel[]; invalid: number } {
  if (!Array.isArray(raw)) return { jobs: [], invalid: 0 };
  const jobs: JobModel[] = [];
  let invalid = 0;
  for (const entry of raw) {
    const job = toJobModel(entry);
    if (job) jobs.push(job);
    else invalid += 1;
  }
  return { jobs, invalid };
}

export const JOB_TYPE_LABEL: Record<JobType, string> = {
  production_order: "Pedido",
  production_cancellation: "Cancelamento",
  test: "Teste",
  customer_bill: "Conta",
  payment_receipt: "Comprovante",
  cash_closing: "Fechamento de caixa",
};

// Rótulo curto para o log: "Pedido CMD005", "Teste", "Fechamento de caixa".
export function describeJob(job: JobModel): string {
  const base = JOB_TYPE_LABEL[job.type];
  const where = job.pointLabel ? ` ${job.pointLabel.replace(/^(Comanda|Mesa)\s+/, "")}` : "";
  return `${base}${where}${job.isReprint ? " (reimpressão)" : ""}`;
}

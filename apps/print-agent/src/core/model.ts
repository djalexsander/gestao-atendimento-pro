// Modelo interno de um job recebido do servidor (claim_print_jobs) e do que a tela precisa.

import type { CodePage, CutMode } from "./document.ts";
import type { LabelContent, LabelGeometry } from "./labels/labelLayout.ts";

export type JobType =
  | "production_order"
  | "production_cancellation"
  | "test"
  | "customer_bill"
  | "payment_receipt"
  | "cash_closing"
  | "label_product"
  | "label_free"
  | "label_service_point";

const JOB_TYPES: readonly string[] = [
  "production_order",
  "production_cancellation",
  "test",
  "customer_bill",
  "payment_receipt",
  "cash_closing",
  "label_product",
  "label_free",
  "label_service_point",
];

// Adicional/opção escolhida no item (snapshot do servidor). priceDelta só vem na CONTA; produção não leva preço.
export interface JobModifier {
  name: string;
  type: "add" | "remove";
  priceDelta: number | null;
}

export interface JobItem {
  quantity: number;
  productName: string;
  notes: string | null;
  modifiers: JobModifier[];
  unitPrice: number | null;
  total: number | null;
}

// Job de ETIQUETAS: o conteúdo (snapshot do servidor), a quantidade e a geometria da impressora (mm).
export interface LabelJobModel {
  quantity: number;
  content: LabelContent;
  geometry: LabelGeometry;
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
  label: LabelJobModel | null; // só nos jobs label_*
  payload: Record<string, unknown>; // snapshot completo (o render lê daqui)
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
const text = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// Transforma o JSON cru do servidor no modelo interno; devolve null se faltar o essencial (o chamador
// então FALHA o job com mensagem clara em vez de imprimir lixo).
function toLabelContent(raw: unknown): LabelContent {
  const l = asRecord(raw);
  const barcode = asRecord(l.barcode);
  const symbology = barcode.symbology === "ean13" ? "ean13" : barcode.symbology === "code128" ? "code128" : null;
  const value = text(barcode.value);
  return {
    header: text(l.header) ?? undefined,
    title: text(l.title) ?? undefined,
    lines: Array.isArray(l.lines) ? l.lines.filter((x): x is string => typeof x === "string" && x.length > 0) : undefined,
    price: text(l.price) ?? undefined,
    barcode: symbology && value ? { value, symbology } : undefined,
    code_text: text(l.code_text) ?? undefined,
    footer: text(l.footer) ?? undefined,
    big_title: l.big_title === true ? true : undefined,
  };
}

// Geometria vem do claim (impressora ATUAL); cai no snapshot do payload. Valores fora dos limites do banco = job inválido.
function toLabelGeometry(...sources: unknown[]): LabelGeometry | null {
  for (const s of sources) {
    const g = asRecord(s);
    const w = num(g.width_mm), h = num(g.height_mm), gap = num(g.gap_mm), cols = num(g.columns), mx = num(g.margin_x_mm), my = num(g.margin_y_mm);
    if (w === null || h === null || gap === null || cols === null || mx === null || my === null) continue;
    if (w < 10 || w > 200 || h < 10 || h > 300 || gap < 0 || gap > 30 || !Number.isInteger(cols) || cols < 1 || cols > 4 || mx < 0 || my < 0 || mx * 2 >= w || my * 2 >= h) return null;
    return { widthMm: w, heightMm: h, marginXMm: mx, marginYMm: my, columns: cols, gapMm: gap };
  }
  return null;
}

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
          modifiers: Array.isArray(e.modifiers)
            ? e.modifiers.map((m): JobModifier => {
                const mm = asRecord(m);
                return { name: text(mm.name) ?? "?", type: mm.type === "remove" ? "remove" : "add", priceDelta: num(mm.price_delta) };
              })
            : [],
          unitPrice: num(e.unit_price),
          total: num(e.total),
        };
      })
    : [];
  const point = asRecord(payload.service_point);
  let label: LabelJobModel | null = null;
  if (type.startsWith("label_")) {
    const geometry = toLabelGeometry(o.label, asRecord(payload.printer).label);
    const quantity = num(payload.quantity);
    if (!geometry || quantity === null || !Number.isInteger(quantity) || quantity < 1 || quantity > 500) return null;
    label = { quantity, content: toLabelContent(payload.label), geometry };
  }
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
    label,
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
  label_product: "Etiqueta de produto",
  label_free: "Etiqueta livre",
  label_service_point: "Cartão de comanda/mesa",
};

// Rótulo curto para o log: "Pedido CMD005", "Teste", "Fechamento de caixa".
export function describeJob(job: JobModel): string {
  const base = JOB_TYPE_LABEL[job.type];
  const where = job.pointLabel ? ` ${job.pointLabel.replace(/^(Comanda|Mesa)\s+/, "")}` : "";
  return `${base}${where}${job.isReprint ? " (reimpressão)" : ""}`;
}

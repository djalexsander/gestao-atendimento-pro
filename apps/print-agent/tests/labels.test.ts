import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApiResult } from "../src/core/api.ts";
import { monoStride, renderLabelPages, DOTS_PER_MM, type RasterSurface } from "../src/core/labels/labelRaster.ts";
import { toJobModel } from "../src/core/model.ts";
import { processJob, type LabelPrinterPort } from "../src/core/processor.ts";
import { SimulationPrinterTransport } from "../src/core/transport.ts";

const geometry = { width_mm: 38, height_mm: 25, gap_mm: 2.5, columns: 2, margin_x_mm: 1.5, margin_y_mm: 1 };
const payload = (extra: Record<string, unknown> = {}) => ({
  version: 1,
  kind: "label_product",
  quantity: 5,
  printer: { id: "d", name: "Argox", kind: "label", label: geometry },
  label: { title: "Espetinho de Alcatra", price: "R$ 12,90", barcode: { value: "5901234123457", symbology: "ean13" }, code_text: "5901234123457" },
  ...extra,
});
const raw = (over: Record<string, unknown> = {}) => ({
  id: "j1",
  job_type: "label_product",
  attempts: 1,
  device_name: "Argox",
  device_kind: "label",
  label: geometry,
  paper_width: null,
  windows_printer_name: "Argox OS-214",
  payload: payload(),
  ...over,
});

class FakeSurface implements RasterSurface {
  rects: Array<[number, number, number, number]> = [];
  texts: string[] = [];
  readonly w: number;
  readonly h: number;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
  }
  fillRect(x: number, y: number, w: number, h: number) {
    this.rects.push([x, y, w, h]);
  }
  drawText(text: string) {
    this.texts.push(text);
  }
  toMono() {
    return new Uint8Array(monoStride(this.w) * this.h).fill(0xff);
  }
}

test("model: job de etiqueta vira JobModel com conteúdo, quantidade e geometria (mm) da impressora", () => {
  const job = toJobModel(raw())!;
  assert.equal(job.type, "label_product");
  assert.equal(job.label!.quantity, 5);
  assert.equal(job.label!.geometry.widthMm, 38);
  assert.equal(job.label!.geometry.columns, 2);
  assert.equal(job.label!.content.barcode!.symbology, "ean13");
  assert.equal(job.windowsPrinter, "Argox OS-214");
});

test("model: geometria só no snapshot do payload também funciona; sem geometria/quantidade inválida = job inválido", () => {
  assert.ok(toJobModel(raw({ label: undefined })) !== null);
  assert.equal(toJobModel(raw({ label: undefined, payload: payload({ printer: { name: "x" } }) })), null);
  assert.equal(toJobModel(raw({ payload: payload({ quantity: 0 }) })), null);
  assert.equal(toJobModel(raw({ payload: payload({ quantity: 501 }) })), null);
  assert.equal(toJobModel(raw({ label: { ...geometry, columns: 9 } })), null);
  assert.equal(toJobModel(raw({ label: { ...geometry, margin_x_mm: 30 } })), null);
});

test("model: cupom antigo continua igual (sem label) e tipos de etiqueta existem", () => {
  const receipt = toJobModel({ id: "r", job_type: "production_order", device_name: "C", paper_width: 80, windows_printer_name: "EPSON", payload: { items: [] } })!;
  assert.equal(receipt.label, null);
  for (const t of ["label_free", "label_service_point"]) assert.equal(toJobModel(raw({ job_type: t }))!.type, t);
});

test("raster: 5 etiquetas em 2 colunas = 3 páginas (2,2,1); tamanho da folha = 2*38 + gap em pontos", () => {
  const job = toJobModel(raw())!;
  const surfaces: FakeSurface[] = [];
  const pages = renderLabelPages(job.label!, (w, h) => {
    const s = new FakeSurface(w, h);
    surfaces.push(s);
    return s;
  });
  assert.equal(pages.length, 3);
  assert.equal(pages[0].widthPx, Math.round((38 * 2 + 2.5) * DOTS_PER_MM));
  assert.equal(pages[0].heightPx, 25 * DOTS_PER_MM);
  assert.equal(pages[0].widthMm, 78.5);
  assert.equal(pages[0].data.length, monoStride(pages[0].widthPx) * pages[0].heightPx);
  // páginas cheias desenham 2 colunas; a última, só 1 (textos pela metade)
  assert.equal(surfaces[0].texts.length, surfaces[2].texts.length * 2);
});

test("raster: barras em pontos inteiros, dentro da folha, uma coluna não invade a outra", () => {
  const job = toJobModel(raw({ payload: payload({ quantity: 2 }) }))!;
  let s!: FakeSurface;
  renderLabelPages(job.label!, (w, h) => (s = new FakeSurface(w, h)));
  assert.ok(s.rects.length > 20, "EAN-13 desenha dezenas de barras");
  assert.ok(s.rects.every(([x, y, w, h]) => Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(w) && Number.isInteger(h) && x >= 0 && y >= 0 && x + w <= s.w && y + h <= s.h));
  const colW = 38 * DOTS_PER_MM, gap = Math.round(2.5 * DOTS_PER_MM);
  const firstCol = s.rects.filter(([x]) => x < colW);
  const secondCol = s.rects.filter(([x]) => x >= colW + gap);
  assert.equal(firstCol.length + secondCol.length, s.rects.length);
  assert.equal(firstCol.length, secondCol.length);
});

const ok: ApiResult<null> = { ok: true, data: null };
const creds = { agentId: "a", token: "TOKEN-SECRETO" };
const sim = new SimulationPrinterTransport();

function deps(over: Partial<Parameters<typeof processJob>[1]> = {}, order: string[] = []) {
  const port: LabelPrinterPort = {
    printLabels: async (printer, pages, purpose) => {
      order.push(`print:${printer}:${pages.length}:${purpose}`);
    },
  };
  return {
    creds,
    transport: sim,
    labels: { port, makeSurface: (w: number, h: number) => new FakeSurface(w, h) },
    complete: async () => {
      order.push("complete");
      return ok;
    },
    fail: async (_c: unknown, _id: string, e: string) => {
      order.push(`fail:${e}`);
      return ok;
    },
    log: () => {},
    ...over,
  };
}

test("processador: etiqueta -> driver (3 páginas, purpose job) -> complete SÓ depois; token nunca no log", async () => {
  const order: string[] = [];
  const logs: string[] = [];
  const res = await processJob(toJobModel(raw())!, deps({ log: (l) => logs.push(l) }, order));
  assert.equal(res, "completed");
  assert.deepEqual(order, ["print:Argox OS-214:3:job", "complete"]);
  assert.ok(!logs.join("\n").includes("TOKEN-SECRETO"));
});

test("processador: falha do driver NUNCA marca impresso; avisa o servidor", async () => {
  const order: string[] = [];
  const res = await processJob(
    toJobModel(raw())!,
    deps({ labels: { port: { printLabels: async () => { throw new Error("A impressora está sem papel."); } }, makeSurface: (w, h) => new FakeSurface(w, h) } }, order),
  );
  assert.equal(res, "failed");
  assert.ok(order.some((o) => o.startsWith("fail:Falha ao imprimir em Argox OS-214: A impressora está sem papel.")));
  assert.ok(!order.includes("complete"));
});

test("processador: sem suporte a etiquetas ou sem impressora do Windows = falha clara", async () => {
  const order: string[] = [];
  assert.equal(await processJob(toJobModel(raw())!, deps({ labels: undefined }, order)), "failed");
  assert.ok(order[0].includes("não imprime etiquetas"));
  const o2: string[] = [];
  assert.equal(await processJob(toJobModel(raw({ windows_printer_name: null }))!, deps({}, o2)), "failed");
  assert.ok(o2[0].includes("Nenhuma impressora do Windows"));
});

test("processador: sem rede para confirmar = stuck (job fica claimed no servidor); servidor recusa = failed", async () => {
  const stuck = await processJob(toJobModel(raw())!, deps({ complete: async () => ({ ok: false, kind: "offline", message: "x" }) as ApiResult<null>, sleep: async () => {} }));
  assert.equal(stuck, "stuck");
  const rejected = await processJob(toJobModel(raw())!, deps({ complete: async () => ({ ok: false, kind: "rejected", message: "não" }) as ApiResult<null> }));
  assert.equal(rejected, "failed");
});

test("regressão: job de cupom segue pelo caminho ESC/POS e nunca toca no driver de etiquetas", async () => {
  const order: string[] = [];
  const receipt = toJobModel({ id: "r", job_type: "production_order", device_name: "C", paper_width: 80, windows_printer_name: "EPSON", payload: { service_point: { label: "Comanda CMD005" }, items: [{ quantity: 1, product_name: "Espeto" }] } })!;
  const res = await processJob(receipt, deps({}, order));
  assert.equal(res, "completed");
  assert.deepEqual(order, ["complete"]);
});

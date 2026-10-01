import assert from "node:assert/strict";
import { test } from "node:test";
import { describeJob, parseClaimResult, toJobModel } from "../src/core/model.ts";

const raw = {
  id: "j1",
  job_type: "production_order",
  attempts: 1,
  reprint_of_id: null,
  print_device_id: "d1",
  device_name: "Impressora Cozinha",
  paper_width: 58,
  windows_printer_name: "EPSON TM-T20",
  payload: { service_point: { label: "Comanda CMD005" }, customer_name: "Fulano", items: [{ quantity: 2, product_name: "Espeto", notes: "ao ponto" }] },
};

test("transforma o JSON do claim no modelo interno", () => {
  const job = toJobModel(raw)!;
  assert.equal(job.type, "production_order");
  assert.equal(job.paperWidth, 58);
  assert.equal(job.windowsPrinter, "EPSON TM-T20");
  assert.deepEqual(job.items, [{ quantity: 2, productName: "Espeto", notes: "ao ponto", unitPrice: null, total: null }]);
  assert.equal(describeJob(job), "Pedido CMD005");
});

test("reimpressão é detectada pelo reprint_of_id ou pelo payload", () => {
  assert.equal(toJobModel({ ...raw, reprint_of_id: "x" })!.isReprint, true);
  assert.equal(describeJob(toJobModel({ ...raw, payload: { ...raw.payload, reprint: { label: "*** REIMPRESSÃO ***" } } })!), "Pedido CMD005 (reimpressão)");
});

test("job inválido vira null e é contado, sem derrubar o lote", () => {
  assert.equal(toJobModel({ id: "j", job_type: "desconhecido" }), null);
  assert.equal(toJobModel(null), null);
  const r = parseClaimResult([raw, { nada: 1 }, "x"]);
  assert.equal(r.jobs.length, 1);
  assert.equal(r.invalid, 2);
  assert.deepEqual(parseClaimResult({ não: "array" }), { jobs: [], invalid: 0 });
});

test("largura de papel desconhecida cai em 80", () => {
  assert.equal(toJobModel({ ...raw, paper_width: 72 })!.paperWidth, 80);
});

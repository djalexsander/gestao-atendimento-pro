import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApiResult } from "../src/core/api.ts";
import { toJobModel } from "../src/core/model.ts";
import { processJob } from "../src/core/processor.ts";
import { RawEscPosPrinterTransport, SimulationPrinterTransport, type PrinterTransport, type RawPrinterPort } from "../src/core/transport.ts";

const job = toJobModel({
  id: "j1",
  job_type: "production_order",
  attempts: 1,
  device_name: "Cozinha",
  paper_width: 80,
  windows_printer_name: "EPSON",
  payload: { service_point: { label: "Comanda CMD005" }, items: [{ quantity: 2, product_name: "Espeto" }] },
})!;
const ok: ApiResult<null> = { ok: true, data: null };
const creds = { agentId: "a", token: "TOKEN-SECRETO" };
const sim = new SimulationPrinterTransport();

test("ordem: documento -> transporte -> complete (complete só DEPOIS do transporte)", async () => {
  const order: string[] = [];
  const logs: string[] = [];
  const transport: PrinterTransport = {
    mode: "simulation",
    print: async (req) => {
      order.push(`transport:${req.document.blocks.length > 0}`);
      return { mode: "simulation", preview: ["x"] };
    },
  };
  const res = await processJob(job, {
    creds,
    transport,
    complete: async () => {
      order.push("complete");
      return ok;
    },
    fail: async () => {
      order.push("fail");
      return ok;
    },
    log: (l) => logs.push(l),
    onPreview: () => order.push("preview"),
  });
  assert.equal(res, "completed");
  assert.deepEqual(order, ["transport:true", "preview", "complete"]);
  assert.ok(logs[0].startsWith("Job recebido: Pedido CMD005"));
  assert.ok(logs.some((l) => l.includes("Simulação concluída")));
  assert.ok(!logs.join("\n").includes("TOKEN-SECRETO"), "token nunca vai para o log");
});

test("transporte de simulação não chama impressora e devolve preview em texto", async () => {
  let preview: string[] = [];
  await processJob(job, { creds, transport: sim, complete: async () => ok, fail: async () => ok, log: () => {}, onPreview: (_j, lines) => (preview = lines) });
  assert.ok(preview.some((l) => l.includes("2x ESPETO")));
});

test("falha do transporte (erro do spooler): fail_print_job com mensagem, NUNCA complete", async () => {
  const calls: string[] = [];
  const port: RawPrinterPort = {
    printRaw: async () => {
      throw new Error("A impressora está sem papel. (erro 28 do Windows)");
    },
  };
  const res = await processJob(job, {
    creds,
    transport: new RawEscPosPrinterTransport(port, "job"),
    complete: async () => {
      calls.push("complete");
      return ok;
    },
    fail: async (_c, _id, err) => {
      calls.push(`fail:${err}`);
      return ok;
    },
    log: () => {},
  });
  assert.equal(res, "failed");
  assert.deepEqual(calls, ["fail:Falha ao imprimir em EPSON: A impressora está sem papel. (erro 28 do Windows)"]);
});

test("sem rede no complete: tenta 3x e deixa o job claimed (não marca falha)", async () => {
  let tries = 0;
  const res = await processJob(job, {
    creds,
    transport: sim,
    complete: async () => {
      tries += 1;
      return { ok: false, kind: "offline", message: "Sem conexão com o servidor." };
    },
    fail: async () => {
      throw new Error("não deveria falhar o job");
    },
    log: () => {},
    sleep: async () => {},
  });
  assert.equal(res, "stuck");
  assert.equal(tries, 3);
});

test("recusa do servidor no complete não é repetida", async () => {
  let tries = 0;
  const res = await processJob(job, {
    creds,
    transport: sim,
    log: () => {},
    sleep: async () => {},
    complete: async () => {
      tries += 1;
      return { ok: false, kind: "rejected", message: "Este job não está em impressão" };
    },
    fail: async () => ok,
  });
  assert.equal(res, "failed");
  assert.equal(tries, 1);
});

test("erro ao montar o documento também falha o job (sem imprimir)", async () => {
  let printed = false;
  const calls: string[] = [];
  const res = await processJob(job, {
    creds,
    transport: { mode: "simulation", print: async () => ((printed = true), { mode: "simulation" as const, preview: [] }) },
    build: () => {
      throw new Error("payload ruim");
    },
    complete: async () => ok,
    fail: async (_c, _id, err) => (calls.push(err), ok),
    log: () => {},
  });
  assert.equal(res, "failed");
  assert.equal(printed, false);
  assert.deepEqual(calls, ["Falha ao montar o papel: payload ruim"]);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentApi, type FetchLike } from "../src/core/api.ts";
import { PrintAgentApp } from "../src/core/app.ts";
import type { KeyValueStore, SecretStore } from "../src/core/config.ts";
import type { Timers } from "../src/core/poller.ts";
import { RawEscPosPrinterTransport, type RawPrinterPort } from "../src/core/transport.ts";
import { fakeStartup } from "./helpers.ts";

const CFG = { supabaseUrl: "https://x.supabase.co", anonKey: "k".repeat(30) };
const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
};

// Relógio falso: guarda os callbacks pendentes; `tick()` executa todos (um ciclo de cada poller).
function fakeTimers() {
  let seq = 0;
  const pending = new Map<number, () => void>();
  const timers: Timers = {
    setTimeout: (fn) => {
      seq += 1;
      pending.set(seq, fn);
      return seq;
    },
    clearTimeout: (h) => void pending.delete(h as number),
  };
  return {
    timers,
    count: () => pending.size,
    async tick() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
      await flush();
    },
  };
}

function memStore(initial: string | null) {
  const s = {
    value: initial,
    async load() {
      return s.value;
    },
    async save(j: string) {
      s.value = j;
    },
  };
  return s as KeyValueStore & { value: string | null };
}
const secrets = (): SecretStore => ({ get: async () => "T", set: async () => {}, delete: async () => {} });

const JOB = {
  id: "job-1",
  job_type: "production_order",
  attempts: 1,
  reprint_of_id: null,
  device_name: "Balcão",
  paper_width: 80,
  windows_printer_name: "POS-80",
  escpos_profile: "generic_escpos",
  escpos_codepage: "cp850",
  cut_mode: "partial",
  payload: { service_point: { label: "Comanda CMD001" }, sent_at: "2026-10-01T17:32:00Z", operator: { name: "JULIANA" }, items: [{ quantity: 2, product_name: "Espeto de carne", sector: { name: "Churrasqueira" } }] },
};

function setup(opts: { printMode?: "real" | "simulation" | undefined; jobs?: unknown[]; rawFails?: string | null; store?: ReturnType<typeof memStore> }) {
  const events: string[] = [];
  const calls = { claim: 0, complete: 0, fail: 0, heartbeat: 0, failMessage: "" };
  const raw: Array<{ printer: string; bytes: Uint8Array; purpose: string }> = [];
  let served = false;
  const fetchFn: FetchLike = async (url, init) => {
    const name = url.split("/rpc/")[1];
    const body = JSON.parse(init.body);
    let out: unknown = {};
    if (name === "claim_print_jobs") {
      calls.claim += 1;
      out = served ? [] : (served = true, opts.jobs ?? [JOB]);
      events.push("claim");
    } else if (name === "complete_print_job") {
      calls.complete += 1;
      events.push("complete");
    } else if (name === "fail_print_job") {
      calls.fail += 1;
      calls.failMessage = body.p_error;
      events.push("fail");
    } else if (name === "print_agent_heartbeat") {
      calls.heartbeat += 1;
      out = { ok: true, company_name: "ACME", agent_name: "Caixa" };
    } else if (name === "list_agent_print_devices") out = [];
    return { ok: true, status: 200, text: async () => JSON.stringify(out) };
  };
  const port: RawPrinterPort = {
    printRaw: async (printer, bytes, purpose) => {
      events.push("spooler");
      if (opts.rawFails) throw new Error(opts.rawFails);
      raw.push({ printer, bytes, purpose });
    },
  };
  const state: Record<string, unknown> = { machineId: "machine-test-0001", agentId: "agent-1", agentName: "Caixa", companyName: "ACME" };
  if (opts.printMode !== undefined) state.printMode = opts.printMode;
  const store = opts.store ?? memStore(JSON.stringify(state));
  const clock = fakeTimers();
  const app = new PrintAgentApp({
    api: new AgentApi(CFG, fetchFn),
    store,
    secrets: secrets(),
    rawPort: port,
    startup: fakeStartup().port,
    listPrinters: async () => [{ name: "POS-80", isDefault: true }],
    hostName: async () => "PC",
    newId: () => "machine-test-0001",
    timers: clock.timers,
  });
  return { app, calls, raw, events, clock, store };
}
const logs = (app: PrintAgentApp) => app.snapshot().log.map((l) => l.text);

test("1. default = simulação (instalação nova e arquivo antigo sem printMode)", async () => {
  const fresh = setup({ printMode: undefined, store: memStore(null) });
  await fresh.app.init();
  assert.equal(fresh.app.snapshot().printMode, "simulation");
  assert.equal(fresh.app.snapshot().queuePaused, true);
  const old = setup({ printMode: undefined });
  await old.app.init();
  assert.equal(old.app.snapshot().printMode, "simulation", "atualizar o executável NÃO ativa o real");
  assert.equal(JSON.parse(old.store.value!).printMode ?? "simulation", "simulation");
  const junk = setup({ printMode: "REAL" as unknown as "real" });
  await junk.app.init();
  assert.equal(junk.app.snapshot().printMode, "simulation", "valor inválido = simulação");
});

test("2/3. simulação: NÃO faz claim, NÃO marca printed/error, heartbeat continua e a fila fica pausada", async () => {
  const t = setup({ printMode: "simulation" });
  await t.app.init();
  for (let i = 0; i < 3; i += 1) await t.clock.tick();
  assert.equal(t.calls.claim, 0, "nenhum claim_print_jobs");
  assert.equal(t.calls.complete, 0);
  assert.equal(t.calls.fail, 0);
  assert.ok(t.calls.heartbeat >= 1, "heartbeat continua");
  assert.equal(t.raw.length, 0, "nada vai ao spooler");
  assert.ok(logs(t.app).includes("Fila automática pausada — modo simulação."));
  t.app.stop();
});

test("4/5/6. real: faz claim, usa o transporte RAW e a impressora FÍSICA vinculada ao job (não a padrão)", async () => {
  const t = setup({ printMode: "real", jobs: [{ ...JOB, windows_printer_name: "EPSON TM-T20" }] });
  await t.app.init();
  await t.clock.tick();
  assert.equal(t.calls.claim, 1);
  assert.equal(t.raw.length, 1);
  assert.equal(t.raw[0].printer, "EPSON TM-T20", "usa windows_printer_name do job, não a impressora padrão (POS-80)");
  assert.equal(t.raw[0].purpose, "job");
  t.app.stop();
});

test("7. sucesso: complete só DEPOIS do spooler; logs e preview do que foi enviado", async () => {
  const t = setup({ printMode: "real" });
  await t.app.init();
  await t.clock.tick();
  assert.deepEqual(t.events.filter((e) => e !== "claim"), ["spooler", "complete"]);
  const bytes = t.raw[0].bytes;
  assert.deepEqual(Array.from(bytes.slice(0, 5)), [0x1b, 0x40, 0x1b, 0x74, 0x02], "ESC @ + CP850");
  assert.ok(Array.from(bytes.slice(-3)).join() === [0x1d, 0x56, 0x01].join(), "termina com corte parcial");
  const l = logs(t.app);
  assert.ok(l.includes("Impressão automática REAL ativada."));
  assert.ok(l.some((x) => x.startsWith("Job recebido: Pedido CMD001")));
  assert.ok(l.includes("Enviando para POS-80..."));
  assert.ok(l.includes(`${bytes.length} bytes enviados ao spooler`));
  assert.ok(l.includes("Impressão concluída."));
  assert.ok(t.app.snapshot().preview?.some((x) => x.includes("2x ESPETO DE CARNE")));
  t.app.stop();
});

test("8/9. falha física: chama fail_print_job (mensagem sanitizada), NUNCA complete, sem repetir", async () => {
  const t = setup({ printMode: "real", rawFails: "Impressora não encontrada no Windows. (erro 1801 do Windows)" });
  await t.app.init();
  await t.clock.tick();
  await t.clock.tick();
  assert.equal(t.calls.fail, 1);
  assert.equal(t.calls.complete, 0);
  assert.match(t.calls.failMessage, /^Falha ao imprimir em POS-80:/);
  assert.ok(!t.calls.failMessage.includes("T"), "sem token");
  assert.equal(t.raw.length, 0);
  assert.ok(logs(t.app).some((x) => x.startsWith("Falha de impressão:")));
  t.app.stop();
});

test("10. escrita parcial no spooler é erro (job NÃO vira impresso)", async () => {
  const t = setup({ printMode: "real", rawFails: "Falha ao enviar os dados para a impressora (WritePrinter enviou 100 de 311 bytes)." });
  await t.app.init();
  await t.clock.tick();
  assert.equal(t.calls.complete, 0);
  assert.equal(t.calls.fail, 1);
  assert.match(t.calls.failMessage, /WritePrinter enviou 100 de 311 bytes/);
  t.app.stop();
});

test("11/12. simulação -> real exige ação explícita e é persistido (sobrevive a reiniciar)", async () => {
  const t = setup({ printMode: "simulation" });
  await t.app.init();
  await t.clock.tick();
  assert.equal(t.app.snapshot().printMode, "simulation", "nada muda sozinho");
  assert.equal(t.calls.claim, 0);
  assert.equal(await t.app.setPrintMode("simulation"), false, "mesmo modo não faz nada");
  assert.equal(await t.app.setPrintMode("real"), true);
  assert.equal(JSON.parse(t.store.value!).printMode, "real");
  t.app.stop();
  // reabre o app com o mesmo state.json
  const again = setup({ printMode: undefined, store: t.store, jobs: [] });
  await again.app.init();
  assert.equal(again.app.snapshot().printMode, "real");
  assert.ok(logs(again.app).includes("Impressão automática REAL ativada."));
  await again.clock.tick();
  assert.equal(again.calls.claim, 1);
  again.app.stop();
});

test("real -> simulação para a fila na hora (nenhum claim depois)", async () => {
  const t = setup({ printMode: "real", jobs: [] });
  await t.app.init();
  await t.clock.tick();
  const before = t.calls.claim;
  await t.app.setPrintMode("simulation");
  await t.clock.tick();
  await t.clock.tick();
  assert.equal(t.calls.claim, before);
  assert.equal(JSON.parse(t.store.value!).printMode, "simulation");
  assert.ok(logs(t.app).includes("Fila automática pausada — modo simulação."));
  t.app.stop();
});

test("ligar o modo real com o app aberto passa a processar a fila", async () => {
  const t = setup({ printMode: "simulation" });
  await t.app.init();
  await t.clock.tick();
  await t.app.setPrintMode("real");
  await t.clock.tick();
  assert.equal(t.calls.claim, 1);
  assert.equal(t.calls.complete, 1);
  t.app.stop();
});

test("13. diagnóstico é independente do modo (usa o transporte com purpose=diagnostic)", async () => {
  const sent: string[] = [];
  const port: RawPrinterPort = { printRaw: async (_p, _b, purpose) => void sent.push(purpose) };
  const t = setup({ printMode: "simulation" });
  await t.app.init();
  const { buildDiagnosticDocument } = await import("../src/core/document-builders.ts");
  const doc = buildDiagnosticDocument({ printerName: "POS-80", paperWidth: 80, codePage: "cp850" });
  await new RawEscPosPrinterTransport(port, "diagnostic").print({ printerName: "POS-80", paperWidth: 80, codePage: "cp850", cutMode: "partial", document: doc });
  assert.deepEqual(sent, ["diagnostic"]);
  assert.equal(t.calls.claim, 0, "e a fila continua pausada");
  t.app.stop();
});

test("14. reimpressão em modo real usa RAW e leva *** REIMPRESSÃO ***", async () => {
  const reprint = { ...JOB, reprint_of_id: "orig", payload: { ...JOB.payload, reprint: { label: "*** REIMPRESSÃO ***", requested_at: "2026-10-01T18:00:00Z" } } };
  const t = setup({ printMode: "real", jobs: [reprint] });
  await t.app.init();
  await t.clock.tick();
  assert.equal(t.raw.length, 1);
  assert.equal(t.raw[0].purpose, "job");
  const text = Buffer.from(t.raw[0].bytes).toString("latin1");
  assert.ok(text.includes("*** REIMPRESS"));
  assert.equal(t.calls.complete, 1);
  t.app.stop();
});

test("desconectar volta ao modo simulação (sem credencial não há fila)", async () => {
  const t = setup({ printMode: "real", jobs: [] });
  await t.app.init();
  await t.app.disconnect();
  assert.equal(t.app.snapshot().printMode, "simulation");
  assert.equal(JSON.parse(t.store.value!).printMode, "simulation");
});

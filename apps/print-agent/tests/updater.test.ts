import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentApi, type FetchLike } from "../src/core/api.ts";
import { PrintAgentApp } from "../src/core/app.ts";
import { installBlockReason, UPDATE_BUSY_MESSAGE, UPDATE_CHECK_MS, type UpdaterPort } from "../src/core/updater.ts";
import type { Timers } from "../src/core/poller.ts";
import type { KeyValueStore, SecretStore } from "../src/core/config.ts";
import { fakeStartup } from "./helpers.ts";

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
};
function fakeTimers() {
  let seq = 0;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      seq += 1;
      pending.set(seq, { fn, ms });
      return seq;
    },
    clearTimeout: (h) => void pending.delete(h as number),
  };
  return {
    timers,
    delays: () => [...pending.values()].map((p) => p.ms),
    async tick() {
      const items = [...pending.values()];
      pending.clear();
      for (const i of items) i.fn();
      await flush();
    },
  };
}
const store = (json: string | null): KeyValueStore & { value: string | null } => {
  const s = { value: json, load: async () => s.value, save: async (j: string) => void (s.value = j) };
  return s;
};
const secret: SecretStore = { get: async () => "T", set: async () => {}, delete: async () => {} };

function setup(opts: { updater?: UpdaterPort; claim?: () => Promise<unknown> } = {}) {
  const t = fakeTimers();
  const st = fakeStartup();
  const state = JSON.stringify({ machineId: "machine-test-0001", agentId: "a1", agentName: "Caixa", companyName: "ACME", computerName: "PC", printMode: "real", autostart: true, keepBackground: true, trayNoticeShown: true });
  const fetchFn: FetchLike = async (url) => {
    const name = url.split("/rpc/")[1];
    let out: unknown = {};
    if (name === "print_agent_heartbeat") out = { ok: true, company_name: "ACME", agent_name: "Caixa" };
    else if (name === "claim_print_jobs") out = opts.claim ? await opts.claim() : [];
    else if (name === "list_agent_print_devices") out = [];
    return { ok: true, status: 200, json: async () => out, text: async () => JSON.stringify(out) } as unknown as Response;
  };
  const app = new PrintAgentApp({
    api: new AgentApi({ supabaseUrl: "https://x.supabase.co", anonKey: "k".repeat(30) }, fetchFn),
    store: store(state),
    secrets: secret,
    rawPort: { printRaw: async () => {} },
    startup: st.port,
    updater: opts.updater,
    listPrinters: async () => [],
    hostName: async () => "PC",
    newId: () => "id",
    timers: t.timers,
  });
  return { app, t, st };
}

const NEW = { version: "1.0.2", current: "1.0.1" };

test("regra: só instala com atualização disponível e Agente ocioso", () => {
  assert.equal(installBlockReason(false, "none"), "Nenhuma atualização disponível.");
  assert.equal(installBlockReason(true, "available"), UPDATE_BUSY_MESSAGE);
  assert.equal(installBlockReason(false, "available"), null);
  assert.equal(installBlockReason(false, "installing"), "Nenhuma atualização disponível.");
});

test("sem updater configurado: não consulta nada e o snapshot fica sem atualização", async () => {
  const { app } = setup({});
  await app.init();
  await flush();
  assert.equal(app.snapshot().update.status, "none");
  await app.checkForUpdate();
  assert.equal(app.snapshot().update.info, null);
});

test("ao iniciar consulta; nova versão: estado available, registro e aviso discreto UMA vez", async () => {
  let checks = 0;
  const updater: UpdaterPort = { check: async () => (checks++, NEW), install: async () => {} };
  const { app, st, t } = setup({ updater });
  await app.init();
  await flush();
  await t.tick();
  assert.equal(checks, 1);
  assert.deepEqual(app.snapshot().update.info, NEW);
  assert.equal(app.snapshot().update.status, "available");
  assert.equal(st.calls.notify.filter((n) => n.includes("1.0.2")).length, 1);
  await app.checkForUpdate();
  assert.equal(st.calls.notify.filter((n) => n.includes("1.0.2")).length, 1, "não repete o aviso da mesma versão");
});

test("reconsulta a cada 6 horas", async () => {
  const updater: UpdaterPort = { check: async () => null, install: async () => {} };
  const { app, t } = setup({ updater });
  await app.init();
  await flush();
  await t.tick();
  assert.ok(t.delays().includes(UPDATE_CHECK_MS));
});

test("falha ao consultar (rede/assinatura) não derruba nada: só registro", async () => {
  const updater: UpdaterPort = {
    check: async () => {
      throw new Error("sem rede");
    },
    install: async () => {},
  };
  const { app, t } = setup({ updater });
  await app.init();
  await flush();
  await t.tick();
  assert.equal(app.snapshot().update.status, "none");
  assert.ok(app.snapshot().log.some((l) => l.text.includes("não foi possível verificar atualização")));
});

test("instalar ocioso: pausa fila/heartbeat e chama o instalador", async () => {
  let installed = 0;
  const updater: UpdaterPort = { check: async () => NEW, install: async () => void installed++ };
  const { app, t } = setup({ updater });
  await app.init();
  await flush();
  await t.tick();
  assert.equal(await app.installUpdate(), true);
  assert.equal(installed, 1);
  assert.equal(app.snapshot().update.status, "installing");
});

test("NÃO instala com impressão em andamento (claim em processamento)", async () => {
  let installed = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const updater: UpdaterPort = { check: async () => NEW, install: async () => void installed++ };
  const { app, t } = setup({
    updater,
    claim: async () => {
      await gate;
      return [];
    },
  });
  await app.init();
  await flush();
  await t.tick(); // dispara o claim, que fica preso
  assert.equal(app.printing, true);
  assert.equal(await app.installUpdate(), false);
  assert.equal(installed, 0);
  assert.equal(app.snapshot().update.message, UPDATE_BUSY_MESSAGE);
  release();
  await flush();
  assert.equal(app.printing, false);
  assert.equal(await app.installUpdate(), true);
  assert.equal(installed, 1);
});

test("falha ao instalar: volta a operar e mostra o erro", async () => {
  const updater: UpdaterPort = {
    check: async () => NEW,
    install: async () => {
      throw new Error("assinatura inválida");
    },
  };
  const { app, t } = setup({ updater });
  await app.init();
  await flush();
  await t.tick();
  assert.equal(await app.installUpdate(), false);
  const u = app.snapshot().update;
  assert.equal(u.status, "error");
  assert.ok(u.message?.includes("assinatura inválida"));
});

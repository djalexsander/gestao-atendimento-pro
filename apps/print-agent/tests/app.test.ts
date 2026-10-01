import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentApi, type FetchLike } from "../src/core/api.ts";
import { PrintAgentApp } from "../src/core/app.ts";
import { SECRET_ERROR_MESSAGE, type KeyValueStore, type SecretStore } from "../src/core/config.ts";
import type { Timers } from "../src/core/poller.ts";
import { fakeStartup } from "./helpers.ts";

const CFG = { supabaseUrl: "https://x.supabase.co", anonKey: "k".repeat(30) };
const noTimers: Timers = { setTimeout: () => 0, clearTimeout: () => {} };
const flush = () => new Promise((r) => setImmediate(r));

function store(initial: string | null = null) {
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

function secrets(initial: string | null = null, failSet = false, failGet = false) {
  const s = {
    token: initial,
    deleted: 0,
    async get() {
      if (failGet) throw new Error("x");
      return s.token;
    },
    async set(t: string) {
      if (failSet) throw new Error("x");
      s.token = t;
    },
    async delete() {
      s.deleted += 1;
      s.token = null;
    },
  };
  return s as SecretStore & { token: string | null; deleted: number };
}

// Servidor falso: responde por nome de RPC; `offline` simula internet fora.
function fakeServer(handlers: Record<string, (args: Record<string, unknown>) => { status?: number; body: unknown }>) {
  const state = { offline: false, calls: [] as string[] };
  const fetchFn: FetchLike = async (url, init) => {
    const name = url.split("/rpc/")[1];
    state.calls.push(name);
    if (state.offline) throw new TypeError("fetch failed");
    const h = handlers[name];
    const r = h ? h(JSON.parse(init.body)) : { status: 404, body: { message: "?" } };
    const status = r.status ?? 200;
    return { ok: status < 300, status, text: async () => JSON.stringify(r.body) };
  };
  return { state, fetchFn };
}

const printers = async () => [
  { name: "EPSON TM-T20", isDefault: true },
  { name: "Microsoft Print to PDF", isDefault: false },
];
const mkApp = (fetchFn: FetchLike, st: KeyValueStore, sec: SecretStore = secrets()) =>
  new PrintAgentApp({
    api: new AgentApi(CFG, fetchFn),
    store: st,
    secrets: sec,
    rawPort: { printRaw: async () => {} },
    startup: fakeStartup().port,
    listPrinters: printers,
    hostName: async () => "CAIXA-01",
    newId: () => "machine-test-0001",
    timers: noTimers,
  });

const PAIR_OK = { pair_print_agent: () => ({ body: { ok: true, agent_id: "agent-1", token: "SEGREDO-TOKEN", agent_name: "Caixa Principal", company_name: "ALEXPROAPPS" } }) };

test("pareamento: token vai para o COFRE, state.json fica sem token, e nada no log", async () => {
  const st = store();
  const sec = secrets();
  const app = mkApp(fakeServer(PAIR_OK).fetchFn, st, sec);
  await app.init();
  assert.equal(app.snapshot().phase, "unpaired");
  assert.equal(await app.pair("4827 3105", "Caixa Principal"), true);
  assert.equal(sec.token, "SEGREDO-TOKEN");
  assert.ok(!st.value!.includes("SEGREDO-TOKEN"), "arquivo sem token");
  const saved = JSON.parse(st.value!);
  assert.equal(saved.machineId, "machine-test-0001");
  assert.equal(saved.agentId, "agent-1");
  assert.ok(!("token" in saved));
  assert.ok(!app.snapshot().log.map((l) => l.text).join("\n").includes("SEGREDO-TOKEN"));
  assert.ok(!JSON.stringify(app.snapshot()).includes("SEGREDO-TOKEN"), "token não vaza no snapshot da tela");
  app.stop();
});

test("cofre falhou no pareamento: NÃO continua, mostra erro e não grava token em lugar nenhum", async () => {
  const st = store();
  const sec = secrets(null, true);
  const app = mkApp(fakeServer(PAIR_OK).fetchFn, st, sec);
  await app.init();
  assert.equal(await app.pair("48273105", "Caixa"), false);
  assert.equal(app.snapshot().message, SECRET_ERROR_MESSAGE);
  assert.equal(app.snapshot().phase, "unpaired");
  assert.ok(!st.value!.includes("SEGREDO-TOKEN"));
  assert.equal(JSON.parse(st.value!).agentId, null);
});

test("cofre indisponível ao abrir: avisa, fica sem credencial e não vaza nada", async () => {
  const st = store(JSON.stringify({ machineId: "machine-test-0001", agentId: "agent-1" }));
  const app = mkApp(fakeServer({}).fetchFn, st, secrets(null, false, true));
  await app.init();
  assert.equal(app.snapshot().phase, "unpaired");
  assert.equal(app.snapshot().message, SECRET_ERROR_MESSAGE);
});

test("código errado mostra mensagem amigável e não pareia", async () => {
  const srv = fakeServer({ pair_print_agent: () => ({ body: { ok: false, error: "invalid_code" } }) });
  const app = mkApp(srv.fetchFn, store());
  await app.init();
  assert.equal(await app.pair("00000000", "X"), false);
  assert.match(app.snapshot().message ?? "", /inválido ou expirado/);
  assert.equal(app.snapshot().phase, "unpaired");
});

test("reabrir o app já pareado retoma sem pedir código (token do cofre, machine_id do arquivo)", async () => {
  const st = store(JSON.stringify({ machineId: "machine-test-0001", agentId: "agent-1", agentName: "Caixa", companyName: "ACME" }));
  const app = mkApp(fakeServer({}).fetchFn, st, secrets("T"));
  await app.init();
  assert.equal(app.snapshot().phase, "paired");
  assert.equal(app.snapshot().agentName, "Caixa");
  app.stop();
});

test("offline não derruba: mostra estado, mantém credencial e reconecta sozinho", async () => {
  const st = store(JSON.stringify({ machineId: "machine-test-0001", agentId: "agent-1" }));
  const sec = secrets("T");
  const srv = fakeServer({
    print_agent_heartbeat: () => ({ body: { ok: true, company_name: "ACME", agent_name: "Caixa" } }),
    list_agent_print_devices: () => ({ body: [] }),
    claim_print_jobs: () => ({ body: [] }),
  });
  const app = mkApp(srv.fetchFn, st, sec);
  await app.init();
  srv.state.offline = true;
  await app.refreshDevices();
  assert.equal(app.snapshot().connection, "offline");
  assert.ok(app.snapshot().log.some((l) => l.text === "Sem conexão com o servidor."));
  assert.equal(sec.token, "T", "token mantido no cofre");
  srv.state.offline = false;
  await app.refreshDevices();
  assert.equal(app.snapshot().connection, "online");
  assert.ok(app.snapshot().log.some((l) => l.text === "Agente restaurado após reconexão."));
  app.stop();
});

test("credencial recusada (revogado): REMOVE o token do cofre, mantém machine_id e para tudo", async () => {
  const st = store(JSON.stringify({ machineId: "machine-test-0001", agentId: "agent-1" }));
  const sec = secrets("T");
  const srv = fakeServer({ list_agent_print_devices: () => ({ status: 401, body: { code: "PT401", message: "Agente não autorizado." } }) });
  const app = mkApp(srv.fetchFn, st, sec);
  await app.init();
  await app.refreshDevices();
  await flush();
  assert.equal(app.snapshot().phase, "revoked");
  assert.equal(sec.token, null);
  assert.equal(sec.deleted, 1);
  const saved = JSON.parse(st.value!);
  assert.equal(saved.agentId, null);
  assert.equal(saved.machineId, "machine-test-0001");
  app.stop();
});

test("desconectar (ação do usuário) remove o token do cofre e mantém o machine_id", async () => {
  const st = store(JSON.stringify({ machineId: "machine-test-0001", agentId: "agent-1" }));
  const sec = secrets("T");
  const app = mkApp(fakeServer({}).fetchFn, st, sec);
  await app.init();
  await app.disconnect();
  assert.equal(sec.token, null);
  assert.equal(app.snapshot().phase, "unpaired");
  assert.equal(JSON.parse(st.value!).machineId, "machine-test-0001");
});

test("padrão do modo de impressão = simulação, com a fila pausada", async () => {
  const app = mkApp(fakeServer({}).fetchFn, store(), secrets());
  await app.init();
  assert.equal(app.snapshot().printMode, "simulation");
  assert.equal(app.snapshot().simulation, true);
  assert.equal(app.snapshot().queuePaused, true);
});

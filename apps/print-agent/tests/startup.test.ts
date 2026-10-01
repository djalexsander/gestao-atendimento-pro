import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentApi, type FetchLike } from "../src/core/api.ts";
import { PrintAgentApp } from "../src/core/app.ts";
import { parseState, serializeState, type KeyValueStore, type SecretStore } from "../src/core/config.ts";
import type { Timers } from "../src/core/poller.ts";
import { fakeStartup } from "./helpers.ts";

const CFG = { supabaseUrl: "https://x.supabase.co", anonKey: "k".repeat(30) };
const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
};

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
const secret = (t: string | null = "T"): SecretStore => ({ get: async () => t, set: async () => {}, delete: async () => {} });

function setup(state: Record<string, unknown> | null, startupOpts: Parameters<typeof fakeStartup>[0] = {}, pairBody?: unknown) {
  const calls = { heartbeat: 0, claim: 0 };
  const fetchFn: FetchLike = async (url) => {
    const name = url.split("/rpc/")[1];
    let out: unknown = {};
    if (name === "print_agent_heartbeat") {
      calls.heartbeat += 1;
      out = { ok: true, company_name: "ACME", agent_name: "Caixa" };
    } else if (name === "claim_print_jobs") {
      calls.claim += 1;
      out = [];
    } else if (name === "list_agent_print_devices") out = [];
    else if (name === "pair_print_agent") out = pairBody ?? { ok: true, agent_id: "agent-1", token: "SEGREDO", agent_name: "Caixa", company_name: "ACME" };
    return { ok: true, status: 200, text: async () => JSON.stringify(out) };
  };
  const store = memStore(state ? JSON.stringify(state) : null);
  const startup = fakeStartup(startupOpts);
  const clock = fakeTimers();
  const app = new PrintAgentApp({
    api: new AgentApi(CFG, fetchFn),
    store,
    secrets: secret(state ? "T" : null),
    rawPort: { printRaw: async () => {} },
    startup: startup.port,
    listPrinters: async () => [],
    hostName: async () => "PC",
    newId: () => "machine-test-0001",
    timers: clock.timers,
  });
  return { app, store, startup, calls, clock };
}
const PAIRED = { machineId: "machine-test-0001", agentId: "agent-1", agentName: "Caixa", companyName: "ACME" };
const logs = (a: PrintAgentApp) => a.snapshot().log.map((l) => l.text);

test("config: autostart e segundo plano LIGADOS por padrão (arquivo antigo/ausente); só false explícito desliga", () => {
  const old = parseState(JSON.stringify({ machineId: "abcdefgh-1234" }))!;
  assert.equal(old.autostart, true);
  assert.equal(old.keepBackground, true);
  assert.equal(old.trayNoticeShown, false);
  const off = parseState(JSON.stringify({ machineId: "abcdefgh-1234", autostart: false, keepBackground: false, trayNoticeShown: true }))!;
  assert.deepEqual([off.autostart, off.keepBackground, off.trayNoticeShown], [false, false, true]);
  assert.equal(parseState(JSON.stringify({ machineId: "abcdefgh-1234", autostart: "no" }))!.autostart, true, "valor inválido = padrão");
});

test("config: opções persistem no state.json (e o token continua fora dele)", () => {
  const raw = serializeState({ machineId: "abcdefgh-1234", agentId: "a", token: "SEGREDO", agentName: null, companyName: null, computerName: null, printMode: "real", autostart: false, keepBackground: true, trayNoticeShown: true });
  const j = JSON.parse(raw);
  assert.deepEqual([j.printMode, j.autostart, j.keepBackground, j.trayNoticeShown], ["real", false, true, true]);
  assert.ok(!raw.includes("SEGREDO"));
});

test("pareamento concluído liga 'Iniciar com o Windows' por padrão", async () => {
  const t = setup(null);
  await t.app.init();
  assert.deepEqual(t.startup.calls.setAutostart, [], "antes de parear não mexe no autostart");
  assert.equal(await t.app.pair("48273105", "Caixa"), true);
  assert.deepEqual(t.startup.calls.setAutostart, [true]);
  assert.equal(JSON.parse(t.store.value!).autostart, true);
  assert.ok(t.startup.isEnabled());
  t.app.stop();
});

test("reiniciar o Windows: instalação pareada reutiliza TUDO (sem novo código) e sobe a fila/heartbeat", async () => {
  const t = setup({ ...PAIRED, printMode: "real", autostart: true }, { hidden: true });
  await t.app.init();
  assert.equal(t.app.snapshot().phase, "paired", "sem pedir novo código de pareamento");
  assert.equal(t.app.snapshot().printMode, "real", "modo REAL escolhido antes é mantido");
  assert.ok(logs(t.app).includes("Agente iniciado automaticamente com o Windows."));
  assert.ok(logs(t.app).includes("Impressão automática REAL ativada."));
  await t.clock.tick();
  assert.ok(t.calls.heartbeat >= 1 && t.calls.claim >= 1, "heartbeat e claim rodam logo na subida");
  assert.deepEqual(t.startup.calls.setAutostart, [true], "reconcilia a entrada do Windows com a opção salva");
  assert.equal(t.startup.calls.showWindow, 0, "subida escondida: não abre janela");
  t.app.stop();
});

test("subida manual (não escondida) não loga 'iniciado automaticamente'", async () => {
  const t = setup({ ...PAIRED, autostart: true }, { hidden: false });
  await t.app.init();
  assert.ok(!logs(t.app).includes("Agente iniciado automaticamente com o Windows."));
  t.app.stop();
});

test("não pareado: não registra autostart (antes do pareamento fica desativado)", async () => {
  const t = setup(null);
  await t.app.init();
  assert.deepEqual(t.startup.calls.setAutostart, []);
});

test("desmarcar 'Iniciar com o Windows' persiste e remove a entrada; reiniciar respeita", async () => {
  const t = setup({ ...PAIRED, autostart: true }, { autostartEnabled: true });
  await t.app.init();
  await t.app.setAutostart(false);
  assert.equal(JSON.parse(t.store.value!).autostart, false);
  assert.deepEqual(t.startup.calls.setAutostart, [false]);
  t.app.stop();
  const again = setup(JSON.parse(t.store.value!), { autostartEnabled: true });
  await again.app.init();
  assert.equal(again.startup.isEnabled(), false, "na próxima subida a entrada é reconciliada com a opção desligada");
  again.app.stop();
});

test("falha ao registrar autostart não derruba o agente (aviso)", async () => {
  const t = setup(null, { failAutostart: true });
  await t.app.init();
  assert.equal(await t.app.pair("48273105", "Caixa"), true);
  assert.equal(t.app.snapshot().phase, "paired");
  assert.ok(logs(t.app).some((l) => l.startsWith('Aviso: não foi possível ativar "Iniciar com o Windows"')));
  t.app.stop();
});

test("fechar a janela (X) -> tray: log, aviso só na 1ª vez, e persistido", async () => {
  const t = setup({ ...PAIRED });
  await t.app.init();
  await t.app.onHiddenToTray();
  assert.ok(logs(t.app).includes("Executando em segundo plano."));
  assert.deepEqual(t.startup.calls.notify, ["O Agente de Impressão continuará ativo em segundo plano."]);
  assert.equal(JSON.parse(t.store.value!).trayNoticeShown, true);
  await t.app.onHiddenToTray();
  assert.equal(t.startup.calls.notify.length, 1, "não repete o aviso");
  t.app.stop();
});

test("heartbeat e fila NÃO dependem da janela: continuam depois de esconder na bandeja", async () => {
  const t = setup({ ...PAIRED, printMode: "real" });
  await t.app.init();
  await t.clock.tick();
  const before = { ...t.calls };
  await t.app.onHiddenToTray();
  await t.clock.tick();
  await t.clock.tick();
  assert.ok(t.calls.heartbeat > before.heartbeat, "heartbeat segue com a janela escondida");
  assert.ok(t.calls.claim > before.claim, "claim segue com a janela escondida");
  t.app.stop();
});

test("'Manter ativo em segundo plano' persiste (o Rust lê o valor ao fechar a janela)", async () => {
  const t = setup({ ...PAIRED });
  await t.app.init();
  assert.equal(t.app.snapshot().keepBackground, true);
  await t.app.setKeepBackground(false);
  assert.equal(JSON.parse(t.store.value!).keepBackground, false);
  assert.equal(t.app.snapshot().keepBackground, false);
  t.app.stop();
});

test("'Sair do Agente' (shutdown) para heartbeat e fila: nenhum ciclo depois", async () => {
  const t = setup({ ...PAIRED, printMode: "real" });
  await t.app.init();
  await t.clock.tick();
  t.app.shutdown();
  const frozen = { ...t.calls };
  assert.equal(t.clock.count(), 0, "nenhum timer pendente");
  await t.clock.tick();
  assert.deepEqual(t.calls, frozen);
  assert.ok(logs(t.app).includes("Agente encerrado."));
});

test("bandeja reflete status e modo (conexão/modo mudam -> atualiza o menu)", async () => {
  const t = setup({ ...PAIRED, printMode: "simulation" });
  await t.app.init();
  await t.clock.tick();
  await flush();
  assert.ok(t.startup.calls.tray.includes("online/simulation"), t.startup.calls.tray.join());
  await t.app.setPrintMode("real");
  assert.ok(t.startup.calls.tray.includes("online/real"));
  t.app.stop();
});

test("sem regressão: em simulação a fila continua pausada mesmo em segundo plano", async () => {
  const t = setup({ ...PAIRED, printMode: "simulation" });
  await t.app.init();
  await t.app.onHiddenToTray();
  await t.clock.tick();
  await t.clock.tick();
  assert.equal(t.calls.claim, 0);
  assert.ok(t.calls.heartbeat >= 1);
  t.app.stop();
});

test("cofre com problema ao subir: pede atenção abrindo a janela (mesmo iniciando escondido)", async () => {
  const store = memStore(JSON.stringify(PAIRED));
  const startup = fakeStartup({ hidden: true });
  const app = new PrintAgentApp({
    api: new AgentApi(CFG, async () => ({ ok: true, status: 200, text: async () => "{}" })),
    store,
    secrets: { get: async () => { throw new Error("cofre"); }, set: async () => {}, delete: async () => {} },
    rawPort: { printRaw: async () => {} },
    startup: startup.port,
    listPrinters: async () => [],
    hostName: async () => "PC",
    newId: () => "machine-test-0001",
    timers: fakeTimers().timers,
  });
  await app.init();
  assert.equal(startup.calls.showWindow, 1);
  assert.equal(app.snapshot().phase, "unpaired");
});

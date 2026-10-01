import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isPaired,
  loadOrCreateState,
  parsePublicConfig,
  parseState,
  SecretStoreError,
  serializeState,
  type KeyValueStore,
  type SecretStore,
} from "../src/core/config.ts";

function memoryStore(initial: string | null = null): KeyValueStore & { value: string | null; saves: number } {
  const s = {
    value: initial,
    saves: 0,
    async load() {
      return s.value;
    },
    async save(json: string) {
      s.value = json;
      s.saves += 1;
    },
  };
  return s;
}

function memorySecrets(initial: string | null = null, failing = false): SecretStore & { token: string | null } {
  const s = {
    token: initial,
    async get() {
      if (failing) throw new Error("cofre quebrado");
      return s.token;
    },
    async set(t: string) {
      if (failing) throw new Error("cofre quebrado");
      s.token = t;
    },
    async delete() {
      s.token = null;
    },
  };
  return s;
}

test("1ª execução gera machine_id e PERSISTE; as seguintes reutilizam o mesmo", async () => {
  const store = memoryStore();
  const secrets = memorySecrets();
  let n = 0;
  const first = await loadOrCreateState(store, secrets, () => `machine-${++n}-aaaaaaaa`);
  assert.equal(first.machineId, "machine-1-aaaaaaaa");
  assert.equal(store.saves, 1);
  const second = await loadOrCreateState(store, secrets, () => `machine-${++n}-aaaaaaaa`);
  assert.equal(second.machineId, "machine-1-aaaaaaaa");
  assert.equal(store.saves, 1, "não regrava nem gera outro id");
});

test("estado corrompido não derruba: gera novo machine_id sem token", async () => {
  const s = await loadOrCreateState(memoryStore("{nao é json"), memorySecrets(), () => "novo-machine-0001");
  assert.equal(s.machineId, "novo-machine-0001");
  assert.equal(isPaired(s), false);
});

test("o arquivo state.json NUNCA contém o token (nem de arquivo antigo)", async () => {
  const state = { machineId: "abcdefgh-1234", agentId: "a1", token: "SEGREDO", agentName: "Caixa", companyName: "ACME", computerName: "PC", printMode: "simulation" as const, autostart: true, keepBackground: true, trayNoticeShown: false };
  assert.ok(!serializeState(state).includes("SEGREDO"));
  assert.ok(!serializeState(state).includes("token"));
  const legacy = JSON.stringify({ machineId: "abcdefgh-1234", agentId: "a1", token: "SEGREDO-ANTIGO" });
  assert.equal(parseState(legacy)!.token, null, "token em arquivo antigo é ignorado");
});

test("pareado = agent_id no arquivo + token no cofre; token vem do cofre", async () => {
  const store = memoryStore(JSON.stringify({ machineId: "abcdefgh-1234", agentId: "a1", agentName: "Caixa", companyName: "ACME" }));
  const s = await loadOrCreateState(store, memorySecrets("TOKEN-DO-COFRE"), () => "x".repeat(10));
  assert.ok(isPaired(s));
  assert.equal(s.token, "TOKEN-DO-COFRE");
});

test("agent_id no arquivo mas SEM token no cofre = não pareado, e o arquivo é limpo (machine_id fica)", async () => {
  const store = memoryStore(JSON.stringify({ machineId: "abcdefgh-1234", agentId: "a1", agentName: "Caixa" }));
  const s = await loadOrCreateState(store, memorySecrets(null), () => "x".repeat(10));
  assert.equal(isPaired(s), false);
  assert.equal(s.machineId, "abcdefgh-1234");
  assert.equal(JSON.parse(store.value!).agentId, null);
});

test("cofre indisponível: lança SecretStoreError (sem fallback para texto puro)", async () => {
  const store = memoryStore(JSON.stringify({ machineId: "abcdefgh-1234", agentId: "a1" }));
  await assert.rejects(() => loadOrCreateState(store, memorySecrets(null, true), () => "x".repeat(10)), SecretStoreError);
});

test("parseState tolera BOM no início do arquivo", () => {
  const raw = "﻿" + JSON.stringify({ machineId: "abcdefgh-1234", agentId: "a1", printMode: "real" });
  const s = parseState(raw);
  assert.ok(s && s.agentId === "a1" && s.printMode === "real");
});

test("parseState: tolerante e consistente", () => {
  assert.equal(parseState(null), null);
  assert.equal(parseState("[]"), null);
  assert.equal(parseState(JSON.stringify({ machineId: "curto" })), null, "machine_id inválido");
  const ok = parseState(JSON.stringify({ machineId: "abcdefgh-1234", agentId: "a1", agentName: "Caixa", companyName: "ACME" }));
  assert.ok(ok && ok.agentName === "Caixa");
  const noAgent = parseState(JSON.stringify({ machineId: "abcdefgh-1234", agentName: "Caixa" }));
  assert.ok(noAgent && noAgent.agentName === null, "nome sem agent_id é descartado");
});

test("parsePublicConfig: exige https (ou localhost) e chave plausível", () => {
  assert.deepEqual(parsePublicConfig({ VITE_SUPABASE_URL: "https://abc.supabase.co/", VITE_SUPABASE_ANON_KEY: "x".repeat(30) }), {
    supabaseUrl: "https://abc.supabase.co",
    anonKey: "x".repeat(30),
  });
  assert.equal(parsePublicConfig({ VITE_SUPABASE_URL: "http://evil.example", VITE_SUPABASE_ANON_KEY: "x".repeat(30) }), null);
  assert.equal(parsePublicConfig({ VITE_SUPABASE_URL: "https://abc.supabase.co" }), null);
  assert.ok(parsePublicConfig({ VITE_SUPABASE_URL: "http://localhost:54321", VITE_SUPABASE_ANON_KEY: "y".repeat(30) }));
});

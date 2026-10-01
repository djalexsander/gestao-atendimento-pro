import assert from "node:assert/strict";
import { test } from "node:test";
import { Poller, type Timers } from "../src/core/poller.ts";

// Relógio falso: guarda o próximo callback; `fire()` o executa.
function fakeTimers() {
  let pending: (() => void) | null = null;
  const timers: Timers = {
    setTimeout: (fn) => {
      pending = fn;
      return 1;
    },
    clearTimeout: () => {
      pending = null;
    },
  };
  return {
    timers,
    fire: () => {
      const f = pending;
      pending = null;
      f?.();
    },
    hasPending: () => pending !== null,
  };
}
const flush = () => new Promise((r) => setImmediate(r));

test("nunca roda dois ciclos ao mesmo tempo, mesmo com ciclo lento", async () => {
  const clock = fakeTimers();
  let active = 0;
  let max = 0;
  let runs = 0;
  let release!: () => void;
  const poller = new Poller(
    async () => {
      active += 1;
      max = Math.max(max, active);
      runs += 1;
      await new Promise<void>((r) => (release = r));
      active -= 1;
    },
    () => 2000,
    clock.timers,
  );
  poller.start();
  clock.fire();
  await flush();
  assert.equal(poller.busy, true);
  assert.equal(clock.hasPending(), false, "enquanto o ciclo roda não há próximo agendado");
  poller.start(); // start repetido é inofensivo
  clock.fire();
  assert.equal(runs, 1);
  release();
  await flush();
  assert.equal(clock.hasPending(), true, "o próximo só é agendado depois que o anterior termina");
  clock.fire();
  await flush();
  assert.equal(runs, 2);
  assert.equal(max, 1);
  poller.stop();
});

test("erro no ciclo não mata o loop e é reportado", async () => {
  const clock = fakeTimers();
  const errors: unknown[] = [];
  let runs = 0;
  const poller = new Poller(
    async () => {
      runs += 1;
      throw new Error("boom");
    },
    () => 10,
    clock.timers,
    (e) => errors.push(e),
  );
  poller.start();
  clock.fire();
  await flush();
  clock.fire();
  await flush();
  assert.equal(runs, 2);
  assert.equal(errors.length, 2);
  poller.stop();
});

test("stop cancela o agendamento e impede novos ciclos", async () => {
  const clock = fakeTimers();
  let runs = 0;
  const poller = new Poller(
    async () => {
      runs += 1;
    },
    () => 10,
    clock.timers,
  );
  poller.start();
  clock.fire();
  await flush();
  poller.stop();
  assert.equal(clock.hasPending(), false);
  assert.equal(poller.isRunning, false);
  clock.fire();
  await flush();
  assert.equal(runs, 1);
});

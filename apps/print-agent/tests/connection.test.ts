import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectionTracker, pollDelayMs } from "../src/core/connection.ts";

test("online/offline/online e contagem de falhas", () => {
  const t = new ConnectionTracker();
  const seen: string[] = [];
  t.subscribe((s) => seen.push(s));
  assert.equal(t.state, "unknown");
  t.reachable();
  t.unreachable();
  t.unreachable();
  assert.equal(t.consecutiveFailures, 2);
  t.reachable();
  assert.equal(t.consecutiveFailures, 0);
  assert.deepEqual(seen, ["online", "offline", "online"]);
});

test("revogado é terminal até reset()", () => {
  const t = new ConnectionTracker();
  t.revoked();
  t.reachable();
  t.unreachable();
  assert.equal(t.state, "revoked");
  t.reset();
  assert.equal(t.state, "unknown");
});

test("intervalo: 2 s normal; offline recua e volta a 2 s ao reconectar", () => {
  assert.equal(pollDelayMs("online", 0), 2000);
  assert.equal(pollDelayMs("unknown", 0), 2000);
  assert.deepEqual([1, 2, 3, 4, 9].map((n) => pollDelayMs("offline", n)), [4000, 8000, 15000, 30000, 30000]);
  assert.equal(pollDelayMs("revoked", 0), 60000);
});

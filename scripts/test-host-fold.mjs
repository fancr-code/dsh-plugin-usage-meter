// Host-fold regression test for the 0.2.x session API.
//
// 0.2.2 removed `session.events`; the host half must fold `session/event`
// payloads and backfill through `snapshotEvents(fromSeq)` instead. This test
// drives the real `apply()` with a fake host context and verifies:
//   - request/header + request/context supply the model
//   - assistant/attempt and assistant/message replace the same turn/step sample
//   - llm/retry-started closes the slot so a retry adds again
//   - replaying an already-folded event does not double count
//   - lastSeq/last are persisted, so a fresh module instance (restart) resumes
//     from the cursor instead of replaying the whole log
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const home = await mkdtemp(join(tmpdir(), "usage-meter-fold-"));
process.env.DSH_HOME = home;
process.env.DEEPSEEK_BASE_URL = "http://127.0.0.1:1";
process.env.USAGE_METER_AUTO_PLATFORM_TOKEN = "0";
// Keep /state offline and deterministic; the ledger is what this test asserts.
globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });

const moduleUrl = new URL("../lib/index.js", import.meta.url).href;
const mod = await import(`${moduleUrl}?test=${Date.now()}`);

const T = Date.parse("2026-11-11T10:00:00+08:00");
const usage = (inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
});
const chunk = (u) => ({ type: "chunk", chunk: { type: "usage", usage: u } });

const events = [
  { seq: 0, type: "request/header", time: T, data: { header: { config: { provider: "deepseek", model: "deepseek-flash" } }, reason: "initial" } },
  { seq: 1, type: "request/context", time: T, data: { model: "deepseek-flash", contextWindow: 128000 } },
  { seq: 2, type: "assistant/attempt", time: T, data: { turn: 0, step: 0, stream: [chunk(usage(1000, 100, 200, 50))] } },
  { seq: 3, type: "assistant/message", time: T, data: { turn: 0, step: 0, usage: usage(1200, 120, 200, 50), stream: [] } },
  { seq: 4, type: "llm/retry-started", time: T, data: { turn: 0, step: 0 } },
  { seq: 5, type: "assistant/attempt", time: T, data: { turn: 0, step: 0, stream: [chunk(usage(700, 70))] } },
];
const liveSession = {
  id: "session-test",
  seq: events.length,
  eventAt(index) {
    return events[index];
  },
  snapshotEvents(from = 0) {
    return events.slice(from);
  },
};

/** Build the minimal host context the plugin touches. */
function makeContext(config = {}) {
  const routes = [];
  const listeners = new Map();
  const sessions = { list: () => [liveSession] };
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    sessions,
    get(service) {
      return service === "sessions" ? sessions : undefined;
    },
    on(event, listener) {
      listeners.set(event, listener);
      return () => {};
    },
    effect(callback) {
      const dispose = callback();
      return () => {
        if (typeof dispose === "function") dispose();
      };
    },
    logger: { warn() {} },
    fiber: { config, effectiveConfig: config },
  };
  return { ctx, routes, listeners };
}

/** Read `/usage-meter/state` through the registered route. */
async function readState(route) {
  const res = {
    status: 0,
    body: "",
    writeHead(status) {
      this.status = status;
    },
    end(body) {
      this.body = body;
    },
  };
  await route.handler({ method: "GET", url: "/usage-meter/state" }, res);
  return JSON.parse(res.body);
}

const { ctx, routes, listeners } = makeContext();
mod.apply(ctx, {});
await new Promise((resolve) => setTimeout(resolve, 100));
const route = routes.find((r) => r.path === "/usage-meter");
assert.ok(route, "host half must register the /usage-meter prefix route");

const first = await readState(route);
assert.deepEqual(first.grand, {
  uncachedInputTokens: 1900,
  outputTokens: 190,
  cacheReadTokens: 200,
  cacheWriteTokens: 50,
});
assert.equal(first.sessions["session-test"].lastSeq, 6);
assert.ok(first.sessions["session-test"].last !== null);

// A replayed event (same seq) must not count twice.
listeners.get("session/event")(liveSession, events[5]);
const replayed = await readState(route);
assert.deepEqual(replayed.grand, first.grand);

// A new live event folds incrementally.
const next = { seq: 6, type: "assistant/attempt", time: T, data: { turn: 1, step: 0, stream: [chunk(usage(300, 30))] } };
events.push(next);
liveSession.seq = events.length;
listeners.get("session/event")(liveSession, next);
const afterLive = await readState(route);
assert.deepEqual(afterLive.grand, {
  uncachedInputTokens: 2200,
  outputTokens: 220,
  cacheReadTokens: 200,
  cacheWriteTokens: 50,
});

// Persist is debounced by 2s; wait for it, then assert the resume cursor is on disk.
await new Promise((resolve) => setTimeout(resolve, 2300));
const ledgerPath = join(home, "usage-meter", "ledger.json");
const persisted = JSON.parse(await readFile(ledgerPath, "utf8"));
assert.equal(persisted.sessions["session-test"].lastSeq, 7);
assert.ok(persisted.sessions["session-test"].last !== null);

// Restart: a fresh module instance must resume from lastSeq, not replay.
const restarted = await import(`${moduleUrl}?test=restart-${Date.now()}`);
const restartCtx = makeContext();
restarted.apply(restartCtx.ctx, {});
await new Promise((resolve) => setTimeout(resolve, 100));
const restartRoute = restartCtx.routes.find((r) => r.path === "/usage-meter");
const afterRestart = await readState(restartRoute);
assert.deepEqual(afterRestart.grand, afterLive.grand);

await rm(home, { recursive: true, force: true });
console.log("host fold: ok");

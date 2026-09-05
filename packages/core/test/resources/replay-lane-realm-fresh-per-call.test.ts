/**
 * A code resource runs every call in a realm of its own, so nothing a body does to its globals,
 * its intrinsics or its definition-time closure reaches the next call — and the brand
 * `ReplayReport.hermetic` rests on is finally a claim about the body rather than about the
 * process's history.
 *
 * Measured at 95a3dde through `createFunctionLoader` on the counter body below: `{n:1}`, `{n:2}`,
 * then `{n:3}` on a fresh `load` of the same ref; the hook loader the same. `compileRealm` built
 * one `vm` context per (digest, deadline) and both loaders cached it for the life of the process,
 * so under `loom serve` run #2 journaled `{n:2}`, a replay in a fresh process got `{n:1}`, and
 * `isRealmBounded(body)` answered `true` throughout. `HOOK_BRIDGE` had already made this argument
 * for one name — it re-installs `Math.random` per call "because bodies are cached per digest" —
 * and the namespace it lives in was left open.
 *
 * The last two tests are the ordinary half: a body that touches nothing behaves identically and
 * the compile cache still counts one entry per digest, and the cost of a fresh realm per call is
 * bounded by an absolute number with an order-of-magnitude margin.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { NodeId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { replayRun } from "../../src/run/replay.ts";
import { createFunctionLoader } from "../../src/resources/functions.ts";
import { createHookLoader } from "../../src/resources/hook-loader.ts";
import { isRealmBounded } from "../../src/resources/realm.ts";
import { ResourceStore } from "../../src/resources/store.ts";

const ACTOR = { kind: "human", id: "u:test" } as const;

const GLOBAL_COUNTER = `(view, ctx) => { globalThis.__n = (globalThis.__n || 0) + 1; return { writes: { n: globalThis.__n } }; }`;
/** The same hazard with no global at all: state in the body's own definition-time closure. */
const CLOSURE_COUNTER = `(function () { var n = 0; return function (view, ctx) { n += 1; return { writes: { n: n } }; }; })()`;
/** And through an intrinsic's prototype, which every later call in a shared realm would inherit. */
const PROTOTYPE_TAINT = `(view, ctx) => { var seen = typeof Array.prototype.__loomTaint; Array.prototype.__loomTaint = 1; return { writes: { seen: seen } }; }`;
const HOOK_COUNTER = `(input, ctx) => { globalThis.__n = (globalThis.__n || 0) + 1; return { n: globalThis.__n }; }`;
const PURE = `(view, ctx) => ({ writes: { out: (view.get("x") ?? 0) + 1 } })`;

function published(bodies: Record<string, string>, kind: "function" | "hook" = "function"): ResourceStore {
  const store = new ResourceStore({ now: () => 1 });
  for (const [name, content] of Object.entries(bodies)) {
    const ref = store.publish({ kind, name, content, actor: ACTOR });
    store.promote(ref, "canary", ACTOR);
    store.promote(ref, "stable", ACTOR);
  }
  return store;
}

const view = (values: Record<string, unknown> = {}) =>
  ({ visible: Object.keys(values), get: (k: string) => values[k], hash: "sha256:0" }) as never;
const callCtx = { now: () => 0, runId: "r", taskId: "t", nodeId: "n", attempt: 1, seed: 1, signal: { aborted: false } } as never;

test("A BODY'S WRITES TO globalThis DO NOT SURVIVE THE CALL — and a fresh load of the same ref starts at nothing too", () => {
  const loader = createFunctionLoader({ store: published({ ctr: GLOBAL_COUNTER }) });
  const body = loader.load("function/ctr@stable")!;
  assert.deepEqual(body(view(), callCtx), { writes: { n: 1 } });
  assert.deepEqual(body(view(), callCtx), { writes: { n: 1 } }, "the second call sees no trace of the first");
  assert.deepEqual(body(view(), callCtx), { writes: { n: 1 } });
  const again = loader.load("function/ctr@stable")!;
  assert.deepEqual(again(view(), callCtx), { writes: { n: 1 } }, "the cached body is the same body, and it still starts clean");
  assert.equal(isRealmBounded(body), true, "the brand is kept — and now it is true");
});

test("NEITHER DOES DEFINITION-TIME CLOSURE STATE, NOR A TAINTED INTRINSIC PROTOTYPE", () => {
  const loader = createFunctionLoader({ store: published({ closure: CLOSURE_COUNTER, taint: PROTOTYPE_TAINT }) });
  const closure = loader.load("function/closure@stable")!;
  assert.deepEqual(closure(view(), callCtx), { writes: { n: 1 } });
  assert.deepEqual(closure(view(), callCtx), { writes: { n: 1 } }, "the body expression is evaluated afresh, so its closure is too");
  const taint = loader.load("function/taint@stable")!;
  assert.deepEqual(taint(view(), callCtx), { writes: { seen: "undefined" } });
  assert.deepEqual(taint(view(), callCtx), { writes: { seen: "undefined" } }, "the previous call's Array.prototype is gone with its realm");
  assert.equal(typeof (Array.prototype as { __loomTaint?: unknown }).__loomTaint, "undefined", "and the HOST's prototype was never in reach");
});

test("THE HOOK REALM IS FRESH PER CALL TOO", () => {
  const loader = createHookLoader({ store: published({ ctr: HOOK_COUNTER }, "hook") });
  const hook = loader.load("hook/ctr@stable")!;
  const ctx = { point: "onComplete", runId: "r", signal: { aborted: false } } as never;
  assert.deepEqual(hook({}, ctx), { n: 1 });
  assert.deepEqual(hook({}, ctx), { n: 1 });
});

/** A one-node graph over the counter body, so the hazard is measured through the Engine. */
const spec = (): GraphSpec => ({
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "ctr", project: "t", version: 1 },
  channels: { n: { type: "number", reduce: "replace" } },
  inputs: [],
  nodes: [{ id: "count" as NodeId, type: "function", writes: ["n"], function: { ref: "function/ctr@stable" } }],
  edges: [],
  outputs: ["n"],
});

test("TWO RUNS ON ONE ENGINE JOURNAL THE SAME VALUE, AND THE SECOND REPLAYS HERMETIC AND MATCHING", async () => {
  const resources = published({ ctr: GLOBAL_COUNTER });
  const loader = createFunctionLoader({ store: resources });
  const functions = new FunctionRegistry({ loader: (ref) => loader.load(ref) });
  const store = new MemoryStateStore();
  const engine = new Engine({ store, bus: new InProcessEventBus(), tools: new ToolRegistry(), functions, models: new ModelRegistry(), resolver: resources });
  const graph = compileOrThrow({ spec: spec(), resolver: resources, tools: {}, tenantCapabilities: [] });

  const first = await engine.submit({ graph, inputs: {} });
  assert.equal((await engine.advance(first)).channels["n"], 1);
  const second = await engine.submit({ graph, inputs: {} });
  assert.equal((await engine.advance(second)).channels["n"], 1, "run #2 does not inherit run #1's realm — this journaled 2 before");

  // A replay in THIS process, with the same cached body, is the worst case: before the fix the
  // body's counter was already at 2 and the replay computed 3.
  const report = await replayRun({ store, runId: second, graph, engine: { tools: new ToolRegistry(), functions, models: new ModelRegistry() } });
  assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match)));
  assert.equal(report.hermetic, true);
  assert.equal(report.replayed.channels["n"], 1);
});

test("ORDINARY HALF — a body that touches nothing behaves identically, the compile cache still holds one entry per digest, and a call stays cheap", () => {
  const loader = createFunctionLoader({ store: published({ pure: PURE }) });
  const body = loader.load("function/pure@stable")!;
  assert.deepEqual(body(view({ x: 41 }), callCtx), { writes: { out: 42 } });
  assert.deepEqual(body(view({ x: 41 }), callCtx), { writes: { out: 42 } });
  loader.load("function/pure@stable");
  assert.equal(loader.compiled, 1, "compiled once per digest — the realm is per call, the parse is not");

  // Absolute, with an order-of-magnitude margin: 1,000 fresh realms measured ~0.3 s on the
  // machine this was written on, and the point is that the cost is a fraction of a millisecond
  // per call and not a compile per call.
  const started = Date.now();
  for (let i = 0; i < 1000; i++) body(view({ x: i }), callCtx);
  assert.ok(Date.now() - started < 5000, "1,000 calls, each in a realm of its own, stay under five seconds");
});

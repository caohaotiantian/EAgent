/**
 * The digest-addressed function loader (open thread T2).
 *
 * The gap: a graph naming `function/merge@stable` only ran if someone had called
 * `functions.register` by hand in the same process. The compiler pinned the ref, the
 * manifest recorded its digest, and the executor ignored both — `function` was the one
 * node type whose resource reference was decorative.
 *
 * The second gap, found later and closed here: T2 pinned the ref and then resolved it
 * again at RUN time, so a promotion between compile and execute swapped the body under a
 * live run. `FunctionLoaderOptions.pins` makes the run's manifest authoritative; the tests
 * under "the manifest, not the selector" are that property, and the last of them records
 * the half a caller can still get wrong.
 *
 * The honesty this file has to keep: `node:vm` is NOT a sandbox. These tests assert
 * scoping, which is what it actually provides, and never claim isolation.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { NodeId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { createFunctionLoader } from "../../src/resources/functions.ts";
import { ResourceStore } from "../../src/resources/store.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { makeStateView, type ChannelSpec } from "../../src/state/channels.ts";

const n = (id: string): NodeId => id as NodeId;

const ACTOR = { kind: "human", id: "u:test" } as const;

/** Promotion is a LADDER — draft → canary → stable. Skipping a rung is a conflict. */
function promoteToStable(store: ResourceStore, ref: ReturnType<ResourceStore["publish"]>): void {
  store.promote(ref, "canary", ACTOR);
  store.promote(ref, "stable", ACTOR);
}

const SPECS: Record<string, ChannelSpec> = {
  amount: { type: "number", reduce: "replace" },
  doubled: { type: "number", reduce: "replace" },
};
const view = (channels: Record<string, unknown>) => makeStateView(SPECS, channels, Object.keys(SPECS));
const ctx = () => ({ taskId: "t@root#0" as never, signal: new AbortController().signal, now: () => 1 });

const DOUBLE = `(view) => ({ writes: { doubled: (view.get("amount") ?? 0) * 2 } })`;
const TRIPLE = `(view) => ({ writes: { doubled: (view.get("amount") ?? 0) * 3 } })`;

function storeWith(source: unknown, name = "double") {
  const store = new ResourceStore({ now: () => 1 });
  const ref = store.publish({ kind: "function", name, content: source, actor: ACTOR });
  promoteToStable(store, ref);
  return { store, ref };
}

/** What the engine would hand the loader: the run's own manifest, as a lookup. */
const pinsOf = (graph: RunGraph) => (ref: string) =>
  graph.resolutionManifest.find((r) => r.ref === ref)?.digest;

// ── loading ──────────────────────────────────────────────────────────────────

test("a function resource becomes a runnable body", () => {
  const { store } = storeWith(DOUBLE);
  const loader = createFunctionLoader({ store });
  const body = loader.load("function/double@stable")!;
  assert.deepEqual(body(view({ amount: 21 }), ctx()), { writes: { doubled: 42 } });
});

test("the source may be a bare string or {source}", () => {
  const bare = createFunctionLoader({ store: storeWith(DOUBLE).store });
  const wrapped = createFunctionLoader({ store: storeWith({ source: DOUBLE }).store });
  assert.equal(typeof bare.load("function/double@stable"), "function");
  assert.equal(typeof wrapped.load("function/double@stable"), "function");
});

test("BODIES ARE CACHED PER DIGEST — the pinning rule, applied to code", () => {
  const { store, ref } = storeWith(DOUBLE);
  const loader = createFunctionLoader({ store });

  const viaRef = loader.load("function/double@stable")!;
  const viaDigest = loader.loadDigest(ref.digest);
  assert.equal(viaRef, viaDigest, "one digest, one compiled function — the ref is just a way to find it");
  assert.equal(loader.compiled, 1, "compiled once, however it was reached");
});

test("two identically-sourced resources are still DISTINCT — the digest covers identity", () => {
  // `function/passthrough` and `function/merge` both with content `{}` must not collide;
  // the digest is over {kind, name, content}, so same source under two names is two
  // resources and two compiled bodies.
  const store = new ResourceStore({ now: () => 1 });
  const a = store.publish({ kind: "function", name: "alpha", content: DOUBLE, actor: ACTOR });
  const b = store.publish({ kind: "function", name: "beta", content: DOUBLE, actor: ACTOR });
  promoteToStable(store, a);
  promoteToStable(store, b);

  assert.notEqual(a.digest, b.digest);
  const loader = createFunctionLoader({ store });
  loader.loadDigest(a.digest);
  loader.loadDigest(b.digest);
  assert.equal(loader.compiled, 2);
});

test("a ref repointed at new bytes gets a NEW body", () => {
  const store = new ResourceStore({ now: () => 1 });
  const v1 = store.publish({ kind: "function", name: "f", content: DOUBLE, actor: ACTOR });
  promoteToStable(store, v1);
  const loader = createFunctionLoader({ store });
  assert.deepEqual(loader.load("function/f@stable")!(view({ amount: 2 }), ctx()), { writes: { doubled: 4 } });

  const v2 = store.publish({
    kind: "function",
    name: "f",
    content: `(view) => ({ writes: { doubled: (view.get("amount") ?? 0) * 3 } })`,
    actor: ACTOR,
  });
  promoteToStable(store, v2);
  assert.deepEqual(loader.load("function/f@stable")!(view({ amount: 2 }), ctx()), { writes: { doubled: 6 } });
  assert.equal(loader.compiled, 2);
});

test("an unresolvable ref is undefined, not a throw", () => {
  const loader = createFunctionLoader({ store: storeWith(DOUBLE).store });
  assert.equal(loader.load("function/nope@stable"), undefined);
});

test("a ref naming a NON-function resource is not a function", () => {
  const store = new ResourceStore({ now: () => 1 });
  const p = store.publish({ kind: "prompt", name: "hello", content: "hi", actor: ACTOR });
  promoteToStable(store, p);
  const loader = createFunctionLoader({ store });
  assert.equal(loader.load("prompt/hello@stable"), undefined);
  assert.throws(() => loader.loadDigest(p.digest), (e: unknown) => (e as { code: string }).code === "E_RESOURCE_INVALID");
});

// ── what it refuses ──────────────────────────────────────────────────────────

test("source that is not a function is refused at LOAD, not at call time", () => {
  // The alternative is a graph that compiles, schedules, leases a task, and only then
  // discovers its body is the number 42.
  const { store } = storeWith(`42`);
  const loader = createFunctionLoader({ store });
  assert.throws(
    () => loader.load("function/double@stable"),
    (e: unknown) => /evaluated to number/.test((e as Error).message),
  );
});

test("source that does not parse is a validation error naming the resource", () => {
  const { store } = storeWith(`(view) => { this is not javascript`);
  const loader = createFunctionLoader({ store });
  assert.throws(
    () => loader.load("function/double@stable"),
    (e: unknown) => (e as { code: string }).code === "E_RESOURCE_INVALID",
  );
});

test("content with no source at all is refused", () => {
  const { store } = storeWith({ notSource: "x" });
  const loader = createFunctionLoader({ store });
  assert.throws(() => loader.load("function/double@stable"), /has no source/);
});

test("A LOADED BODY RETURNS HOST-REALM VALUES", () => {
  // Found by `deepStrictEqual` refusing two structurally identical objects. An object
  // literal inside a `vm` context is built from THAT context's intrinsics, so it has a
  // different `Object.prototype` — it looks identical, passes `typeof`, and any
  // downstream prototype check would quietly disagree with itself depending on whether
  // the body was loaded or hand-registered.
  const { store } = storeWith(DOUBLE);
  const out = createFunctionLoader({ store }).load("function/double@stable")!(view({ amount: 1 }), ctx());
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(Object.getPrototypeOf((out as { writes: object }).writes), Object.prototype, "recursively");
  assert.deepEqual(out, { writes: { doubled: 2 } }, "…which is what makes this comparison work at all");
});

test("arrays survive the rebuild as real host arrays", () => {
  const { store } = storeWith(`(view) => ({ writes: { doubled: 1 }, take: ["e1", "e2"] })`);
  const out = createFunctionLoader({ store }).load("function/double@stable")!(view({}), ctx()) as { take: string[] };
  assert.ok(Array.isArray(out.take));
  // `Array.isArray` is realm-agnostic, so it would pass either way — the prototype is
  // what actually says which realm built it, and `.map` would have preserved the wrong one.
  assert.equal(Object.getPrototypeOf(out.take), Array.prototype);
  assert.deepEqual(out.take, ["e1", "e2"]);
});

// ── scoping (NOT isolation) ──────────────────────────────────────────────────

test("a body does not see the host's globals", () => {
  // SCOPING, not security. `node:vm` is not a sandbox and this test does not claim it
  // is — what it pins is that a body cannot reach `process.env` BY ACCIDENT, which is
  // the realistic failure for trusted code.
  const { store } = storeWith(`(view) => ({ writes: { doubled: typeof process } })`);
  const loader = createFunctionLoader({ store });
  const out = loader.load("function/double@stable")!(view({}), ctx()) as { writes: { doubled: string } };
  assert.equal(out.writes.doubled, "undefined");
});

test("Date is deliberately unavailable — a body that reads the clock breaks its own replay", () => {
  // GRAPH013 already refuses clock-dependent expressions. Leaving the constructor
  // reachable here would be an inconsistent seam; `ctx.now` is the injected, recorded way.
  const { store } = storeWith(`(view) => ({ writes: { doubled: typeof Date } })`);
  const loader = createFunctionLoader({ store });
  const out = loader.load("function/double@stable")!(view({}), ctx()) as { writes: { doubled: string } };
  assert.equal(out.writes.doubled, "undefined");
});

test("JSON and Math ARE available — a body that cannot parse or round is not useful", () => {
  const { store } = storeWith(`(view) => ({ writes: { doubled: Math.round(JSON.parse("1.6")) } })`);
  const loader = createFunctionLoader({ store });
  assert.deepEqual(loader.load("function/double@stable")!(view({}), ctx()), { writes: { doubled: 2 } });
});

test("extra globals can be injected deliberately", () => {
  const { store } = storeWith(`(view) => ({ writes: { doubled: TENANT } })`);
  const loader = createFunctionLoader({ store, globals: { TENANT: 7 } });
  assert.deepEqual(loader.load("function/double@stable")!(view({}), ctx()), { writes: { doubled: 7 } });
});

// ── the manifest, not the selector ───────────────────────────────────────────

test("A PIN BEATS A MOVED SELECTOR — the body that runs is the body that was compiled", () => {
  // `load(ref)` called `store.resolve` — the COMPILE-time half of the pinning rule — from
  // inside a running node. Promote a new version and the selector moves under the run's
  // feet, so the body that executes need not be the body the compiler gated.
  const { store, ref } = storeWith(DOUBLE);
  const loader = createFunctionLoader({ store, pins: (r) => (r === "function/double@stable" ? ref.digest : undefined) });

  promoteToStable(store, store.publish({ kind: "function", name: "double", content: TRIPLE, actor: ACTOR }));

  assert.deepEqual(
    loader.load("function/double@stable")!(view({ amount: 2 }), ctx()),
    { writes: { doubled: 4 } },
    "the pinned digest, not whatever @stable points at now",
  );
});

test("a manifest is EXHAUSTIVE — a ref it does not name refuses to load at all", () => {
  // Fail closed. The alternative — falling back to the selector for an unpinned ref — is
  // the hole this option exists to close, reachable by a typo in one ref.
  const { store } = storeWith(DOUBLE);
  const loader = createFunctionLoader({ store, pins: () => undefined });
  assert.throws(
    () => loader.load("function/double@stable"),
    (e: unknown) => (e as { code: string }).code === "E_FLOATING_REF_AT_RUNTIME",
  );
});

test("a pinned digest naming a non-function is `undefined`, exactly as an unpinned one is", () => {
  const store = new ResourceStore({ now: () => 1 });
  const p = store.publish({ kind: "prompt", name: "hello", content: "hi", actor: ACTOR });
  promoteToStable(store, p);
  const loader = createFunctionLoader({ store, pins: () => p.digest });
  assert.equal(loader.load("prompt/hello@stable"), undefined);
});

test("a yanked pin still loads — in-flight runs are not stranded mid-way", () => {
  // D8.5: yanking breaks NEW compiles and escalates in-flight runs to human oversight; it
  // does not strand them. `store.resolve` returns `undefined` for a yanked resource, so a
  // loader that re-resolved would kill the run outright. `fetch` by digest does not.
  const { store, ref } = storeWith(DOUBLE);
  store.yank("function", "double", 1, "INC-1", ACTOR);

  const floating = createFunctionLoader({ store });
  assert.equal(floating.load("function/double@stable"), undefined, "re-resolving: the selector is gone");

  const pinned = createFunctionLoader({ store, pins: () => ref.digest });
  assert.deepEqual(pinned.load("function/double@stable")!(view({ amount: 2 }), ctx()), { writes: { doubled: 4 } });
});

// ── the registry seam ────────────────────────────────────────────────────────

test("a HAND-REGISTERED body wins over a stored one", () => {
  // An embedder or a test overriding a resource is doing so deliberately. Preferring the
  // stored version would make the override look like it worked while doing nothing.
  const { store } = storeWith(DOUBLE);
  const loader = createFunctionLoader({ store });
  const registry = new FunctionRegistry({ loader: (ref) => loader.load(ref) });
  registry.register("function/double@stable", () => ({ writes: { doubled: -1 } }));
  assert.deepEqual(registry.require("function/double@stable")(view({ amount: 5 }), ctx()), { writes: { doubled: -1 } });
});

test("A GRAPH RUNS WITH NO HAND-REGISTERED FUNCTIONS AT ALL", async () => {
  // The whole point of T2: a graph's `function` ref is enough to run it. WHICH body that
  // ref reaches is the separate question the next test asks.
  const { store } = storeWith(DOUBLE);
  const spec: GraphSpec = {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "loaded", project: "t", version: 1 },
    channels: SPECS,
    inputs: ["amount"],
    outputs: ["doubled"],
    nodes: [
      { id: n("double"), type: "function", reads: ["amount"], writes: ["doubled"], function: { ref: "function/double@stable" } },
    ],
    edges: [],
  };

  const loader = createFunctionLoader({ store });
  const journal = new MemoryStateStore({ now: () => 1 });
  const engine = new Engine({
    store: journal,
    bus: new InProcessEventBus({ store: journal }),
    tools: new ToolRegistry(),
    functions: new FunctionRegistry({ loader: (ref) => loader.load(ref) }),
    models: new ModelRegistry(),
    now: () => 1,
    resolver: store,
    policy: { granted: ["*"], systemFloor: "out" },
  });

  const graph = compileOrThrow({ spec, resolver: store, tools: {}, tenantCapabilities: ["*"] });
  const runId = await engine.submit({ graph, inputs: { amount: 20 } });
  const p = await engine.advance(runId);

  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.equal(p.channels["doubled"], 40);
  assert.equal(loader.compiled, 1);
});

test("A RUN EXECUTES THE BODY ITS MANIFEST PINNED, not the one @stable moved to", async () => {
  // `RunGraph`'s own docstring: "a Run reads only what its manifest names, so a Resource
  // published, promoted, or deprecated mid-run cannot affect it." That was true of every
  // dependency except the one that is CODE — a `function` body was looked up by ref when
  // the node ran, so a promotion between compile and execute swapped it.
  const { store } = storeWith(DOUBLE);
  const spec: GraphSpec = {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "pinned", project: "t", version: 1 },
    channels: SPECS,
    inputs: ["amount"],
    outputs: ["doubled"],
    nodes: [
      { id: n("double"), type: "function", reads: ["amount"], writes: ["doubled"], function: { ref: "function/double@stable" } },
    ],
    edges: [],
  };

  const graph = compileOrThrow({ spec, resolver: store, tools: {}, tenantCapabilities: ["*"] });
  // …and now the selector moves, exactly as a promotion between compile and execute would.
  promoteToStable(store, store.publish({ kind: "function", name: "double", content: TRIPLE, actor: ACTOR }));

  const loader = createFunctionLoader({ store, pins: pinsOf(graph) });
  const journal = new MemoryStateStore({ now: () => 1 });
  const engine = new Engine({
    store: journal,
    bus: new InProcessEventBus({ store: journal }),
    tools: new ToolRegistry(),
    functions: new FunctionRegistry({ loader: (ref) => loader.load(ref) }),
    models: new ModelRegistry(),
    now: () => 1,
    resolver: store,
    policy: { granted: ["*"], systemFloor: "out" },
  });

  const runId = await engine.submit({ graph, inputs: { amount: 20 } });
  const p = await engine.advance(runId);

  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.equal(p.channels["doubled"], 40, "×2 was compiled and gated; ×3 was promoted afterwards");
});

test("A REGISTRY SHARED ACROSS RUNS DEFEATS THE PIN — so build one per run", () => {
  // `FunctionRegistry` caches a loaded body under the REF, not the digest (`#stacks.set(ref,
  // [loaded])`), so the second run never reaches its own loader. Pinning the manifest fixes
  // which digest a loader resolves and does nothing about a cache above it. Asserted rather
  // than only written down, because it is the road the same drift comes back by.
  const { store, ref } = storeWith(DOUBLE);
  const v2 = store.publish({ kind: "function", name: "double", content: TRIPLE, actor: ACTOR });
  promoteToStable(store, v2);

  const runA = createFunctionLoader({ store, pins: () => ref.digest });
  const runB = createFunctionLoader({ store, pins: () => v2.digest });

  // A seam that IS run-aware — it re-reads `current` on every call — wrapped by one
  // long-lived registry.
  let current = runA;
  const shared = new FunctionRegistry({ loader: (r) => current.load(r) });

  assert.deepEqual(shared.require("function/double@stable")(view({ amount: 1 }), ctx()), { writes: { doubled: 2 } });
  current = runB;
  assert.deepEqual(
    shared.require("function/double@stable")(view({ amount: 1 }), ctx()),
    { writes: { doubled: 2 } },
    "run B's manifest is never consulted: the cache answered first, keyed by ref",
  );

  const perRun = new FunctionRegistry({ loader: (r) => runB.load(r) });
  assert.deepEqual(
    perRun.require("function/double@stable")(view({ amount: 1 }), ctx()),
    { writes: { doubled: 3 } },
    "…which a registry built for run B gets right",
  );
});

test("a graph naming a function nobody published still fails LOUDLY", async () => {
  const store = new ResourceStore({ now: () => 1 });
  const loader = createFunctionLoader({ store });
  const registry = new FunctionRegistry({ loader: (ref) => loader.load(ref) });
  assert.throws(
    () => registry.require("function/absent@stable"),
    (e: unknown) => (e as { code: string }).code === "E_RESOURCE_NOT_FOUND",
  );
});

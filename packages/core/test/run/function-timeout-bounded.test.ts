/**
 * `NodeSpec.timeoutMs` AGAINST A BODY THAT OWNS THE THREAD (audit F36).
 *
 * `Engine.#withNodeDeadline` is a `Promise.race` on this thread. A synchronous `function` body
 * never yields, so the timer cannot fire and the deadline is not late — it is unreachable.
 * Measured on the tree before this file existed, through `Engine.advance`, on the graph below
 * declaring `timeoutMs: 200`:
 *
 *     for (let i = 0; i < 4e9; i++)  →  2,332 ms, status "succeeded"
 *     while (true) {}                →  30,005 ms, "failed" E_INTERNAL
 *                                       "Script execution timed out after 30000ms"
 *
 * The 30,000 was a hardcoded default in `resources/functions.ts` that no CLI flag and no graph
 * field reached, and it is the only bound the product had. A graph author who cannot commit code
 * could make the process unstoppable — against CLAUDE.md's "run it, watch it, stop it", that is
 * the whole bar.
 *
 * WHAT IS PINNED HERE, and no more than that. `vm`'s timeout terminates SYNCHRONOUS execution and
 * nothing else, so this file pins three separate claims:
 *
 *   1. a synchronous sandboxed body is TERMINATED at the declared deadline (both node types that
 *      run one), and reports the code `timeoutMs` promises;
 *   2. the shapes that cannot be bounded are REFUSED and named — an `async` body at load, a
 *      thenable-returning one when it returns;
 *   3. the gap that remains is real and is pinned as a gap: a hand-registered body is host code
 *      with no realm, and its declared `timeoutMs` still bounds only its Task's outcome.
 *
 * THE TIMING ASSERTIONS ARE ORDER-OF-MAGNITUDE, not clock-dependent in the sense CLAUDE.md
 * forbids: 200 ms declared against a 30,000 ms default, asserted at 5,000 ms. No test here
 * asserts that a machine was fast.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { CODES } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { NodeId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { createFunctionLoader } from "../../src/resources/functions.ts";
import { ResourceStore } from "../../src/resources/store.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type FunctionBody } from "../../src/run/registry.ts";

const ACTOR = { kind: "human", id: "u:test" } as const;
const n = (id: string): NodeId => id as NodeId;

/**
 * A spin with NO clock read, because `Date` is shadowed out of the realm on purpose.
 *
 * ~2.3 s on the machine this was written on, which is the point: it is comfortably longer than
 * the 200 ms deadline everywhere, and no assertion below depends on WHICH side of a second it
 * lands. A body that is killed never finishes it at all.
 */
const SPIN = `let x = 0; for (let i = 0; i < 4e9; i++) { x += i & 7; }`;

type Outcome = { status: string; code: unknown; message: string; ms: number };

/**
 * One graph, one node, one published body, run to completion through the real engine.
 *
 * `kind` picks which of the TWO node types that invoke a `FunctionBody` runs it. Both are here
 * because every previous change to this contract — the seed, the clock, the outcome shape — was
 * applied to `#runFunction` and forgotten at `#runEvaluator` until a test noticed.
 */
async function runNode(opts: {
  source: string;
  timeoutMs?: number;
  kind?: "function" | "evaluator";
  eager?: boolean;
  register?: FunctionBody;
}): Promise<Outcome> {
  const store = new ResourceStore({ now: () => 1 });
  const published = store.publish({ kind: "function", name: "spin", content: opts.source, actor: ACTOR });
  store.promote(published, "canary", ACTOR);
  store.promote(published, "stable", ACTOR);
  const ref = "function/spin@stable";

  const node =
    opts.kind === "evaluator"
      ? { id: n("spin"), type: "evaluator", reads: ["amount"], writes: ["doubled"], evaluator: { kind: "assertion", ref, threshold: 1 } }
      : { id: n("spin"), type: "function", reads: ["amount"], writes: ["doubled"], function: { ref } };

  const spec: GraphSpec = {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "spin", project: "t", version: 1 },
    channels: { amount: { type: "number", reduce: "replace" }, doubled: { type: "number", reduce: "replace" } },
    inputs: ["amount"],
    outputs: ["doubled"],
    nodes: [{ ...node, ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }) }],
    edges: [],
  } as unknown as GraphSpec;

  const loader = createFunctionLoader({ store });
  // THE PRODUCT PATH IS THE EAGER ONE, and it is a different code path through the registry.
  // `cli.ts registerFunctions` compiles every published body at boot and `register`s it by ref;
  // the lazy loader seam is what an embedder gets. The bound rides on the compiled body itself,
  // so both must keep it — `eager` is which of the two this run exercises.
  const functions = opts.eager === true ? new FunctionRegistry() : new FunctionRegistry({ loader: (r) => loader.load(r) });
  if (opts.eager === true) functions.register(ref, loader.load(ref)!);
  // A HAND-REGISTERED body shadows the published one, which is how the third claim above is
  // measured: same graph, same declared deadline, host code instead of a realm.
  if (opts.register !== undefined) functions.register(ref, opts.register);

  const journal = new MemoryStateStore({ now: () => 1 });
  const engine = new Engine({
    store: journal,
    bus: new InProcessEventBus({ store: journal }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now: () => 1,
    resolver: store,
    policy: { granted: ["*"], systemFloor: "out" },
  });

  const graph = compileOrThrow({ spec, resolver: store, tools: {}, tenantCapabilities: ["*"] });
  const runId = await engine.submit({ graph, inputs: { amount: 20 } });
  const t0 = Date.now();
  const p = await engine.advance(runId);
  return {
    status: p.status,
    code: (p.error as { code?: unknown } | undefined)?.code,
    message: String((p.error as { message?: unknown } | undefined)?.message ?? ""),
    ms: Date.now() - t0,
  };
}

// ── 1 · what IS bounded ──────────────────────────────────────────────────────

test("A BODY THAT NEVER YIELDS IS TERMINATED AT THE NODE'S DECLARED timeoutMs", async () => {
  // The measurement that matters. Before: 30,005 ms, because the only live bound was the
  // loader's hardcoded 30 s default. 5,000 ms is two orders below that and 20x above the
  // declared 200 ms, so this discriminates the fix from the defect on any machine.
  const r = await runNode({ source: `(view) => { while (true) {} }`, timeoutMs: 200 });
  assert.equal(r.status, "failed");
  assert.equal(r.code, CODES.E_TASK_TIMEOUT, `expected the code timeoutMs promises, got ${r.message}`);
  assert.ok(r.ms < 5_000, `the node's own deadline must bound it: took ${r.ms}ms for a declared 200ms`);
  assert.match(r.message, /200ms/, "the message names the deadline the GRAPH declared, not a default");
});

test("A BODY THAT WOULD HAVE FINISHED LATE DOES NOT REPORT succeeded", async () => {
  // The audit's headline: a purely synchronous body blew past a 200 ms deadline and the node
  // said `succeeded` — 2,332 ms measured. No timing assertion is needed to catch that, because
  // a body killed at 200 ms cannot reach its `return` at all.
  const r = await runNode({ source: `(view) => { ${SPIN} return { writes: { doubled: x % 7 } }; }`, timeoutMs: 200 });
  assert.equal(r.status, "failed", "a body that outran its deadline must not commit its writes");
  assert.equal(r.code, CODES.E_TASK_TIMEOUT);
});

test("THE SECOND NODE TYPE THAT RUNS A FUNCTION BODY IS BOUND TOO", async () => {
  // `evaluator{assertion}` invokes a `FunctionBody` through the same registry. Every earlier
  // change to this contract landed at `#runFunction` and reached this arm a commit later.
  const r = await runNode({ source: `(view) => { while (true) {} }`, timeoutMs: 200, kind: "evaluator" });
  assert.equal(r.status, "failed");
  assert.equal(r.code, CODES.E_TASK_TIMEOUT);
  assert.ok(r.ms < 5_000, `took ${r.ms}ms for a declared 200ms`);
});

test("THE BOUND SURVIVES THE CLI'S EAGER REGISTRATION, which is the product path", async () => {
  // `cli.ts registerFunctions` loads every published body at boot and hands it to
  // `FunctionRegistry.register`. That is a different path through the registry than the lazy
  // loader seam every other test here uses, and it is the one a `loom run` actually takes.
  const r = await runNode({ source: `(view) => { while (true) {} }`, timeoutMs: 200, eager: true });
  assert.equal(r.status, "failed");
  assert.equal(r.code, CODES.E_TASK_TIMEOUT);
  assert.ok(r.ms < 5_000, `took ${r.ms}ms for a declared 200ms`);
});

test("a body that finishes inside its deadline is untouched", async () => {
  // The bound must not be a tax on correct bodies, and a deadline wired to the wrong number
  // (a millisecond, say) would still pass every test above.
  const r = await runNode({ source: `(view) => ({ writes: { doubled: view.get("amount") * 2 } })`, timeoutMs: 200 });
  assert.equal(r.status, "succeeded", r.message);
});

test("with NO declared timeoutMs a body keeps the loader's default", async () => {
  // Nothing here changes the unbounded-by-declaration case: it is still 30 s, and asserting that
  // would cost 30 s, so what is pinned is that such a body still RUNS.
  const r = await runNode({ source: `(view) => ({ writes: { doubled: 1 } })` });
  assert.equal(r.status, "succeeded", r.message);
});

// ── 2 · what is REFUSED, because it cannot be bounded ────────────────────────

test("AN ASYNC BODY IS REFUSED, because no deadline can bound one", async () => {
  // Measured before the refusal existed, same graph, `timeoutMs: 200`: no output at all and the
  // process still spinning when the harness SIGKILLed it at 25 s. `vm`'s timeout is satisfied at
  // the first `await`, and the continuation resumes on the microtask queue where no timer and no
  // AbortSignal reach it — the engine's own deadline could not even report.
  const r = await runNode({ source: `(async (view) => { await 0; return { writes: { doubled: 1 } }; })`, timeoutMs: 200 });
  assert.equal(r.status, "failed");
  assert.equal(r.code, CODES.E_RESOURCE_INVALID);
  assert.match(r.message, /async function body cannot be bounded/);
});

test("a THENABLE-returning body is refused when it returns", async () => {
  // The other shape: a plain function that hands back a promise. The continuation here is
  // FINITE on purpose — with `while (true) {}` in it the process never returns at all, which is
  // the limitation the refusal does NOT fix and which `resources/functions.ts` states.
  const r = await runNode({
    source: `((view) => Promise.resolve().then(() => ({ writes: { doubled: 1 } })))`,
    timeoutMs: 200,
  });
  assert.equal(r.status, "failed");
  assert.equal(r.code, CODES.E_RESOURCE_INVALID);
  assert.match(r.message, /returned a promise/);
});

// ── 3 · the gap that remains, pinned as a gap ────────────────────────────────

test("A HAND-REGISTERED BODY IS STILL UNBOUNDED — the honest remainder", async () => {
  // Host code, no realm, no interrupt: `vm`'s timeout is the only thing in this process that can
  // stop a body, and a body registered through `FunctionRegistry.register` never enters one.
  // 5e8 iterations is ~0.3 s here and vastly more than the 10 ms declared, on any machine.
  //
  // ASSERTED AS A SUCCESS, deliberately. If a later change makes this fail, the change closed
  // the gap — delete this test and say so, rather than loosening it.
  let ran = false;
  const r = await runNode({
    source: `(view) => ({ writes: { doubled: 0 } })`,
    timeoutMs: 10,
    register: () => {
      let x = 0;
      for (let i = 0; i < 5e8; i++) x += i & 7;
      ran = true;
      return { writes: { doubled: x % 7 } };
    },
  });
  assert.ok(ran, "the host body ran to completion despite a 10ms declared deadline");
  assert.equal(r.status, "succeeded", r.message);
});

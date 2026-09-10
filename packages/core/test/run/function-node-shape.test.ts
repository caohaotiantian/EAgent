/**
 * A BODY COULD NOT READ ITS OWN NODE, SO A BOUND THE GRAPH DECLARES WAS SPELLED TWICE.
 *
 * TODO A.44. `examples/resources/function/triage-plan.js` carries `const SHARD_CEILING = 24`
 * beside a `fanout` edge declaring `maxWidth: 24`, and a comment saying the two "MUST TRACK" each
 * other — because a fan-out CLAMPS silently (30 shards at a width of 24 runs 24 branches and
 * nothing in the run, the trace or the report says the other six were never read), so a body that
 * wants to REFUSE above the width has to hard-code the number the graph already holds.
 *
 * `ctx.node` is the seam. What this suite has to hold is three things, and only the first is the
 * feature:
 *
 *   1. The number is READABLE, and it is the number the executor actually clamps at.
 *   2. BOTH PATHS AGREE. A hand-registered body is host code handed the engine's own object; a
 *      resource-loaded body gets a `JSON.parse` of a payload. `JSON.stringify` DROPS
 *      undefined-valued keys, so `{maxWidth: undefined}` written host-side would make
 *      `"maxWidth" in edge` answer differently on the two paths — for the same graph. The
 *      conditional spread in `nodeShapeOf` is what stops that, and nothing but a test comparing
 *      the two key sets can tell whether it is still there.
 *   3. IT DECIDES NOTHING. Spec-derived, frozen, and read back by nobody — so a replay
 *      re-executing the body computes the identical object with nothing journaled.
 *
 * AND BOTH CALLERS. `functions.require` has two, and the seed, the clock, the outcome shape and
 * `take` each landed at one of them a commit before the other.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { createFunctionLoader } from "../../src/resources/functions.ts";
import { ResourceStore } from "../../src/resources/store.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type FunctionOutcome } from "../../src/run/registry.ts";
import { replayRun } from "../../src/run/replay.ts";
import { resolver } from "./skeleton.ts";

const NOW = 1_700_000_000_000;
const REF = "function/plan@stable";
const ACTOR = { kind: "human", id: "u:test" } as const;
const MAX_WIDTH = 24;

/**
 * The shipped example's shape, minus its work: a `plan` node above a `fanout` edge with a
 * declared `maxWidth`, and a `work` node under it. `plan` is the node under test, and it is
 * either a `function` or an `assertion` evaluator.
 */
function spec(kind: "function" | "evaluator"): GraphSpec {
  const plan =
    kind === "function"
      ? { id: "plan", type: "function", reads: ["items", "absent"], writes: ["shards", "probe"], function: { ref: REF } }
      : {
          id: "plan",
          type: "evaluator",
          reads: ["items", "absent"],
          writes: ["shards", "probe"],
          evaluator: { kind: "assertion", ref: REF, threshold: 0.5 },
        };
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "nodeshape", project: "t", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 64, maxDepth: 1, maxFanout: 32, maxLoopIterations: 2 } },
    channels: {
      items: { type: "array", reduce: "replace" },
      shards: { type: "array", reduce: "replace" },
      absent: { type: "string", reduce: "replace" },
      shard: { type: "string", reduce: "replace" },
      probe: { type: "string", reduce: "replace" },
      done: { type: "array", reduce: "append_ordered" },
    },
    inputs: ["items"],
    outputs: ["probe"],
    nodes: [
      plan,
      { id: "work", type: "function", reads: ["shard"], writes: ["done"], function: { ref: "function/work@stable" } },
      // A fan-out needs a join (`GRAPH021_FANOUT_WITHOUT_JOIN`), so the fixture carries one. It
      // is scenery: `plan`, the node under test, is above the fan and never runs.
      { id: "collect", type: "join", writes: ["done"], join: { branches: ["work"], mode: "all", onBranchError: "fail" } },
    ],
    edges: [
      { id: "fan", from: "plan", to: "work", kind: "fanout", over: "shards", as: "shard", maxWidth: MAX_WIDTH },
      { id: "j", from: "work", to: "collect", kind: "join" },
    ],
  } as unknown as GraphSpec;
}

/** A hand-registered body: host code, no realm, handed the engine's own `ctx.node`. */
async function hostRun(body: unknown, kind: "function" | "evaluator" = "function") {
  const functions = new FunctionRegistry();
  functions.register(REF, body as () => FunctionOutcome);
  functions.register("function/work@stable", (() => ({ writes: { done: ["x"] } })) as never);
  const store = new MemoryStateStore({ now: () => NOW });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: [], systemFloor: "out" },
  });
  const graph = compileOrThrow({ spec: spec(kind), resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { items: [] } });
  let p = await engine.advance(runId);
  for (let i = 0; i < 4 && p.status === "running"; i++) p = await engine.advance(runId);
  return p;
}

/** The same graph with the `plan` body living in a `vm` realm, reached through the loader. */
function sandbox(source: string, kind: "function" | "evaluator" = "function") {
  const store = new MemoryStateStore({ now: () => NOW });
  const resources = new ResourceStore({ now: () => 1 });
  for (const [name, content] of [
    ["plan", source],
    ["work", `(view) => ({ writes: { done: ["x"] } })`],
  ] as const) {
    const published = resources.publish({ kind: "function", name, content, actor: ACTOR });
    resources.promote(published, "canary", ACTOR);
    resources.promote(published, "stable", ACTOR);
  }
  const loader = createFunctionLoader({ store: resources });
  const functions = new FunctionRegistry({ loader: (r) => loader.load(r) });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    resolver: resources,
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: [], systemFloor: "out" },
  });
  const graph = compileOrThrow({ spec: spec(kind), resolver: resources, tools: {}, tenantCapabilities: [] });
  return { store, engine, graph, functions };
}

async function sandboxRun(source: string, kind: "function" | "evaluator" = "function") {
  const h = sandbox(source, kind);
  const runId = await h.engine.submit({ graph: h.graph, inputs: { items: [] } });
  let p = await h.engine.advance(runId);
  for (let i = 0; i < 4 && p.status === "running"; i++) p = await h.engine.advance(runId);
  return p;
}

/** What the example would write instead of `SHARD_CEILING`. */
const CEILING = `(view, ctx) => {
  var fan = ctx.node.out.filter(function (e) { return e.kind === "fanout" && e.over === "shards"; })[0];
  return { writes: { shards: [], probe: String(fan.maxWidth) } };
}`;

// ── the number, on both paths ────────────────────────────────────────────────

test("A BODY READS ITS OWN FAN-OUT CEILING, with the number written nowhere in the body", async () => {
  // The row's repro, inverted: `24` appears in the GRAPH and not in the source below.
  assert.doesNotMatch(CEILING, /24/, "the body must not contain the number it is meant to derive");
  const p = await hostRun(new Function("return " + CEILING)());
  assert.equal(p.channels["probe"], String(MAX_WIDTH), JSON.stringify(p.error ?? {}));
});

test("...AND A SANDBOXED BODY READS THE SAME NUMBER — the path the example actually uses", async () => {
  // `examples/resources/function/triage-plan.js` is a RESOURCE. A `ctx.node` that reached only
  // hand-registered bodies would close nothing.
  const p = await sandboxRun(CEILING);
  assert.equal(p.channels["probe"], String(MAX_WIDTH), JSON.stringify(p.error ?? {}));
});

test("THE TWO PATHS AGREE ON THE EXACT KEY SET, absent fields included", async () => {
  // `JSON.stringify` DROPS undefined-valued keys. If `nodeShapeOf` wrote `maxIterations:
  // e.maxIterations` instead of spreading it conditionally, a hand-registered body would see the
  // key and a sandboxed one would not — the same graph, two answers, and no test but this one
  // could tell. The `fan` edge declares `over`, `as` and `maxWidth` and NOT `maxIterations`, so
  // it exercises both sides of the conditional at once.
  const probe = `(view, ctx) => ({ writes: { shards: [], probe: JSON.stringify([
    Object.keys(ctx.node).sort(),
    Object.keys(ctx.node.out[0]).sort()
  ]) } })`;
  const host = await hostRun(new Function("return " + probe)());
  const sand = await sandboxRun(probe);
  assert.equal(host.channels["probe"], sand.channels["probe"], "a hand-registered body and a realm body must see one object");
  assert.equal(
    String(host.channels["probe"]),
    JSON.stringify([
      ["id", "out", "reads", "type", "writes"],
      ["as", "id", "kind", "maxWidth", "over"],
    ]),
    "and the set is the declared one — no `timeoutMs`, and no key holding `undefined`",
  );
});

test("THE DECLARED SHAPE IS THE NODE'S OWN — id, type, reads, writes", async () => {
  const probe = `(view, ctx) => ({ writes: { shards: [], probe: [
    ctx.node.id, ctx.node.type, ctx.node.reads.join("+"), ctx.node.writes.join("+")
  ].join("|") } })`;
  const p = await hostRun(new Function("return " + probe)());
  assert.equal(p.channels["probe"], "plan|function|items+absent|shards+probe", JSON.stringify(p.error ?? {}));
});

test("`reads` IS THE DECLARED SET, NOT `view.visible` — which is why it is not redundant", async () => {
  // `makeStateView` builds `visible` out of the channels that hold a VALUE. `plan` declares two
  // reads and nothing ever writes `absent`, so the declared set and the visible set differ by
  // exactly that channel. Collapsing `ctx.node.reads` into `view.visible` would lose the
  // declaration, which is the half a body reasoning about its own contract needs — and without
  // an unwritten channel in the fixture this test would pass for the collapsed version too.
  const probe = `(view, ctx) => ({ writes: { shards: [], probe: ctx.node.reads.join("+") + "/" + view.visible.join("+") } })`;
  const p = await hostRun(new Function("return " + probe)());
  assert.equal(p.channels["probe"], "items+absent/items", JSON.stringify(p.error ?? {}));
});

test("`maxIterations` IS CARRIED TOO — the loop analogue of `maxWidth`, and the SECOND clause member", async () => {
  // WITHOUT THIS TEST THE FIELD SHIPPED UNEXERCISED. A reviewer deleted the `maxIterations`
  // spread from `nodeShapeOf` outright and the whole 3,693-test suite stayed green: no fixture in
  // the tree gave a `function`/`evaluator` node a `loop` edge, so the key-set test above only ever
  // proved that its ABSENCE was spelled correctly. `maxIterations` is a member the plan chose on
  // purpose, and a member with no fixture is a member nobody has checked.
  //
  // This is the exact twin of `A BODY READS ITS OWN FAN-OUT CEILING`: `#loopMayContinue` reads
  // `w.task.iteration + 1 < (e.maxIterations ?? 1)`, so a body re-entered by a loop is cut off at
  // a number it could not see, for the same reason a fan-out clamps at one.
  const loopSpec = {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "nodeshape-loop", project: "t", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 64, maxDepth: 1, maxFanout: 4, maxLoopIterations: 5 } },
    channels: {
      seed: { type: "string", reduce: "replace" },
      probe: { type: "string", reduce: "replace" },
      hop: { type: "string", reduce: "replace" },
    },
    inputs: ["seed"],
    outputs: ["probe"],
    nodes: [
      { id: "plan", type: "function", reads: ["seed"], writes: ["probe"], function: { ref: REF } },
      { id: "again", type: "function", reads: ["probe"], writes: ["hop"], function: { ref: "function/work@stable" } },
    ],
    edges: [
      { id: "fwd", from: "plan", to: "again", kind: "seq" },
      { id: "back", from: "again", to: "plan", kind: "loop", until: "has(hop)", maxIterations: 3 },
    ],
  } as unknown as GraphSpec;

  const functions = new FunctionRegistry();
  // `plan` reports what it can see of its OWN outgoing edges. The loop edge leaves `again`, not
  // `plan`, so this asserts the field on the node that declares it — `again` is where it lands.
  functions.register(REF, ((_v: unknown, ctx: { node: { out: { id: string }[] } }) => ({
    writes: { probe: JSON.stringify(ctx.node.out) },
  })) as never);
  functions.register("function/work@stable", ((_v: unknown, ctx: { node: { out: { kind: string; maxIterations?: number }[] } }) => ({
    writes: { hop: String(ctx.node.out.find((e) => e.kind === "loop")?.maxIterations) },
  })) as never);

  const store = new MemoryStateStore({ now: () => NOW });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: [], systemFloor: "out" },
  });
  const graph = compileOrThrow({ spec: loopSpec, resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { seed: "go" } });
  let p = await engine.advance(runId);
  for (let i = 0; i < 8 && p.status === "running"; i++) p = await engine.advance(runId);

  assert.equal(p.channels["hop"], "3", `the loop ceiling must be readable off the node that declares it: ${JSON.stringify(p.error ?? {})}`);
  // ...and `plan`'s own `out` carries the plain `seq` edge with NO `maxIterations` key, which is
  // the conditional spread doing its job on the other side.
  assert.deepEqual(JSON.parse(String(p.channels["probe"])), [{ id: "fwd", kind: "seq" }]);
});

test("AN `error` EDGE APPEARS IN `out` AND IS NOT TAKEABLE — the docstring's claim, pinned", async () => {
  // `FunctionNodeShape` says an `error` or `compensation` edge "appears here and is REFUSED if
  // named in a `take`", and that `kind` is there so a body can tell. Both halves were unpinned:
  // no fixture gave the probed node an error edge. This drives the pair on one node.
  const errSpec = {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "nodeshape-err", project: "t", version: 1 },
    policy: { posture: "out" },
    channels: { seed: { type: "string", reduce: "replace" }, probe: { type: "string", reduce: "replace" }, caught: { type: "string", reduce: "replace" } },
    inputs: ["seed"],
    outputs: ["probe"],
    nodes: [
      { id: "plan", type: "function", reads: ["seed"], writes: ["probe"], function: { ref: REF } },
      { id: "rescue", type: "function", reads: ["seed"], writes: ["caught"], function: { ref: "function/work@stable" }, unhandled: true },
    ],
    edges: [{ id: "err", from: "plan", to: "rescue", kind: "error" }],
  } as unknown as GraphSpec;

  const run = async (body: unknown) => {
    const functions = new FunctionRegistry();
    functions.register(REF, body as () => FunctionOutcome);
    functions.register("function/work@stable", (() => ({ writes: { caught: "x" } })) as never);
    const store = new MemoryStateStore({ now: () => NOW });
    const engine = new Engine({
      store,
      bus: new InProcessEventBus({ store }),
      tools: new ToolRegistry(),
      functions,
      models: new ModelRegistry(),
      now: () => NOW,
      sleep: async () => {},
      policy: { granted: [], systemFloor: "out" },
    });
    const graph = compileOrThrow({ spec: errSpec, resolver: resolver(), tools: {}, tenantCapabilities: [] });
    const runId = await engine.submit({ graph, inputs: { seed: "go" } });
    let p = await engine.advance(runId);
    for (let i = 0; i < 4 && p.status === "running"; i++) p = await engine.advance(runId);
    return p;
  };

  // IT APPEARS, with its kind, so a body can tell it HAS a rescue arm.
  const seen = await run((_v: unknown, ctx: { node: { out: { id: string; kind: string }[] } }) => ({
    writes: { probe: ctx.node.out.map((e) => `${e.id}:${e.kind}`).join(",") },
  }));
  assert.equal(seen.channels["probe"], "err:error", JSON.stringify(seen.error ?? {}));

  // AND NAMING IT IN A `take` IS REFUSED, not silently dropped — `TAKEABLE_EDGE_KINDS`.
  const took = await run((_v: unknown, ctx: { node: { out: { id: string }[] } }) => ({
    writes: { probe: "x" },
    take: [ctx.node.out[0]!.id],
  }));
  assert.equal(took.status, "failed", JSON.stringify(took.error ?? {}));
  assert.match(String(took.error?.message), /error|take/i, JSON.stringify(took.error ?? {}));
});

// ── the second caller ────────────────────────────────────────────────────────

test("AND THE EVALUATOR ARM GETS IT TOO — the caller that has kept every previous defect", async () => {
  // A mutation deleting `node:` from `#runEvaluator`'s ctx leaves every test above green.
  const p = await hostRun(new Function("return " + CEILING)(), "evaluator");
  assert.equal(p.channels["probe"], String(MAX_WIDTH), JSON.stringify(p.error ?? {}));

  // THE FOURTH CELL OF THE MATRIX. {function, evaluator} x {host, sandbox} is four cases, and
  // three of them were driven while the evaluator arm was only ever host code. An `assertion`
  // evaluator's ref IS a function body and the shipped ones are resources, so this is the cell a
  // real graph is most likely to be in.
  const sand = await sandboxRun(CEILING, "evaluator");
  assert.equal(sand.channels["probe"], String(MAX_WIDTH), JSON.stringify(sand.error ?? {}));
});

// ── it decides nothing ───────────────────────────────────────────────────────

test("IT IS FROZEN, THREE DEEP — `Object.freeze` is shallow and two levels sit below it", async () => {
  // A hand-registered body is handed the engine's ACTUAL object. Without the inner freezes a
  // body could rewrite the edge list it was shown; nothing reads it back, so nothing would
  // break — which is exactly why an unfrozen version would survive every other test here.
  // EVERY ARRAY, NAMED — `writes` was missing from this probe for one review round, and deleting
  // its freeze left the whole 3,693-test suite green. A freeze test that skips a member is a
  // freeze test for the members it happens to list.
  const probe = `(view, ctx) => ({ writes: { shards: [], probe: [
    Object.isFrozen(ctx.node), Object.isFrozen(ctx.node.out), Object.isFrozen(ctx.node.out[0]),
    Object.isFrozen(ctx.node.reads), Object.isFrozen(ctx.node.writes)
  ].join(",") } })`;
  const p = await hostRun(new Function("return " + probe)());
  assert.equal(p.channels["probe"], "true,true,true,true,true", JSON.stringify(p.error ?? {}));
});

test("A BODY CANNOT REACH THE HOST THROUGH IT — the argument bridge's whole job", async () => {
  // `ctx.node` is a new object crossing into the realm, and the module's recorded finding is that
  // a HOST object handed to a body hands over the host `Function` with it:
  // `ctx.now.constructor("return globalThis")().process` reached the real `process`. This asserts
  // the new field did not reopen that door.
  const probe = `(view, ctx) => ({ writes: { shards: [],
    probe: String(ctx.node.constructor.constructor("return typeof globalThis.process")()) } })`;
  const p = await sandboxRun(probe);
  assert.equal(p.channels["probe"], "undefined", `a realm body must not see the host's process: ${JSON.stringify(p.error ?? {})}`);
});

test("A RUN THAT READ `ctx.node` REPLAYS TO THE SAME ANSWER, with nothing journaled for it", async () => {
  // The shape is derived from the compiled spec, which `graphHash` pins — no clock, no draw, no
  // projection — so a replay re-executing the body computes the identical object. This is what
  // says so, rather than the docstring saying so.
  const h = sandbox(CEILING);
  const runId = await h.engine.submit({ graph: h.graph, inputs: { items: [] } });
  let recorded = await h.engine.advance(runId);
  for (let i = 0; i < 4 && recorded.status === "running"; i++) recorded = await h.engine.advance(runId);
  assert.equal(recorded.channels["probe"], String(MAX_WIDTH), JSON.stringify(recorded.error ?? {}));

  const events = [];
  for await (const e of h.store.read(runId, 1)) events.push(e);
  const kinds = new Set(events.filter((e) => e.type === "effect.started").map((e) => (e.payload as { kind: string }).kind));
  assert.deepEqual([...kinds].sort(), ["random"], "the only effect a function body draws is its seed — `ctx.node` journals nothing");

  const report = await replayRun({
    store: h.store,
    runId,
    graph: h.graph,
    engine: { tools: new ToolRegistry(), functions: h.functions, models: new ModelRegistry() },
  });
  assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match)));
  assert.equal(report.replayed.channels["probe"], String(MAX_WIDTH));
});

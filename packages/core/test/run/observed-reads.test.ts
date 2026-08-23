/**
 * T2 — `reads` is not the read set, and two decisions were computed as though it were.
 *
 * `#runToolNode` resolves `tool.args` against `scopeFor(...)`, the WHOLE channel scope, so a
 * template names a channel and the node reads it whether or not `reads` mentions it. Anything
 * derived from the DECLARED set is therefore one token from being switched off: delete the
 * channel's name from `reads`, leave `${channel}` in the arguments, and the graph still
 * compiles clean.
 *
 * `observedChannels` was written for the taint half of this and wired to taint alone. Two other
 * sites still read `node.reads`, and both feed the posture `max`:
 *
 *     run/engine.ts    `dataClassification` handed to `policy.decide`
 *     graph/compile.ts `dataFloor` → `plans[n.id].posture` → the `declaredPosture` term
 *
 * Measured before the fix, on a graph that compiled clean, with `token` declared
 * `classification: "secret_ref"` — whose floor is `in`, a gate:
 *
 *     reads DECLARES the secret:   awaiting_gate   gates=1   tool saw: nothing
 *     reads OMITS it, same args:   succeeded       gates=0   tool saw: "sk-live-SUPER-SECRET"
 *
 * The tests below are that reproduction, plus the boundary written as a set rather than sampled
 * at one point.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import { observedChannels, type GraphSpec, type NodeSpec } from "../../src/graph/spec.ts";
import type { ToolManifestLite } from "../../src/graph/validate.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import type { Classification } from "../../src/vocab.ts";

const MANIFEST: ToolManifestLite = {
  name: "net.post",
  version: "1.0",
  capabilities: ["net:fetch"],
  // `read_only`, so CLASSIFICATION IS THE ONLY TERM THAT CAN RAISE THIS.
  //
  // The first version of this fixture used `reversible_write`, whose own floor is already `on`
  // — which makes `pii` (also `on`) the IDENTITY, and a test built on it proves nothing about
  // the classification at all. That is precisely the mistake this repo found in E8, where taint
  // was written into a `max` that `CLASS_DEFAULT_POSTURE` had already pinned. Caught here by
  // the `public` row refusing to come back `out`.
  irreversibility: "read_only",
  idempotent: true,
};

function spec(reads: readonly string[], classification: Classification): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "t2", project: "p", version: 1 },
    policy: { posture: "out", capabilities: ["net:fetch"] },
    channels: {
      token: { type: "string", reduce: "replace", classification },
      out: { type: "object", reduce: "replace" },
    },
    inputs: ["token"],
    outputs: ["out"],
    nodes: [
      {
        id: "post" as never,
        type: "tool",
        reads: [...reads],
        writes: ["out"],
        tool: { name: "net.post", version: "1.0", args: { body: "${token}" } },
      },
    ],
    edges: [],
  };
}

async function run(reads: readonly string[], classification: Classification) {
  const seen: string[] = [];
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const tools = new ToolRegistry();
  tools.register({
    ...MANIFEST,
    description: "post",
    parameters: { type: "object", properties: { body: { type: "string" } } },
    execute: (args) => {
      seen.push(String(args["body"]));
      return { content: "ok", writes: { out: { sent: true } } };
    },
  });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now,
    sleep: async () => {},
    policy: { granted: ["net:fetch"], systemFloor: "out" },
  });
  const graph = compileOrThrow({
    spec: spec(reads, classification),
    resolver: { resolve: () => undefined },
    tools: { "net.post": MANIFEST },
    tenantCapabilities: ["net:fetch"],
  });
  const runId = await engine.submit({ graph, inputs: { token: "sk-live-SUPER-SECRET" } });
  const p = await engine.advance(runId);
  return {
    status: p.status,
    gates: Object.values(p.gates).filter((g) => g.state === "open").length,
    toolSaw: seen[0],
    plannedPosture: graph.plans["post" as never]?.posture,
  };
}

test("A SECRET IN tool.args RAISES THE FLOOR WHETHER OR NOT `reads` NAMES IT", async () => {
  const declared = await run(["token"], "secret_ref");
  const omitted = await run([], "secret_ref");

  assert.equal(declared.status, "awaiting_gate", "declaring the secret must gate — the baseline");
  assert.equal(declared.toolSaw, undefined, "and the tool must not have run");

  // THE DEFECT: this row used to be `succeeded`, 0 gates, and the tool holding the secret.
  assert.equal(omitted.status, "awaiting_gate", "omitting it from `reads` must not switch the floor off");
  assert.equal(omitted.gates, 1);
  assert.equal(omitted.toolSaw, undefined, "the tool must not receive a secret nobody was asked about");
  assert.deepEqual(omitted, declared, "the two graphs differ by one token of DECLARATION and must decide alike");
});

test("...and the COMPILED floor agrees, because two answers to one question is how they drift", async () => {
  // `plans[n.id].posture` is read by the graph-binding check as the compiled oversight floor.
  // The engine's own `max` would have closed the hole alone; leaving the compiler computing off
  // the declared set would have left a second, quieter answer.
  const declared = await run(["token"], "secret_ref");
  const omitted = await run([], "secret_ref");
  assert.equal(declared.plannedPosture, "in");
  assert.equal(omitted.plannedPosture, "in", "the compiler must floor it too");
});

test("the WHOLE classification table travels through the arguments, not just its loudest row", async () => {
  // Proving `secret_ref` proves one row. `pii` floors at `on` — an intervention window rather
  // than a gate — so it shows the correction reaching a different OUTCOME, and `public` shows it
  // raising nothing, which is what stops this test from passing for the wrong reason.
  const omitted = await run([], "pii");
  assert.equal(omitted.plannedPosture, "on");
  assert.equal(omitted.status, "succeeded", "at `on` the run proceeds — under a hold, not a gate");
  assert.equal(omitted.gates, 0);
  assert.equal(omitted.toolSaw, "sk-live-SUPER-SECRET");

  const publicChannel = await run([], "public");
  assert.equal(publicChannel.plannedPosture, "out", "and an unclassified channel raises nothing");
});

// ── the derivation itself ───────────────────────────────────────────────────

const node = (over: Partial<NodeSpec>): NodeSpec =>
  ({ id: "n" as never, type: "tool", tool: { name: "t", version: "1", args: {} }, ...over }) as NodeSpec;

test("observedChannels IS the declared set PLUS every channel a template names", () => {
  assert.deepEqual([...observedChannels(node({ reads: ["a"] }))].sort(), ["a"]);
  assert.deepEqual(
    [...observedChannels(node({ reads: ["a"], tool: { name: "t", version: "1", args: { x: "${b}" } } }))].sort(),
    ["a", "b"],
  );
  // Only the ROOT segment is a channel: `${a.b.c}` reads channel `a`.
  assert.deepEqual([...observedChannels(node({ tool: { name: "t", version: "1", args: { x: "${a.b.c}" } } }))], ["a"]);
  // Nested, and through arrays — a template hidden one level down is still a read.
  assert.deepEqual(
    [...observedChannels(node({ tool: { name: "t", version: "1", args: { o: { p: ["${deep}"] } } } }))].sort(),
    ["deep"],
  );
  // Two in one string, and whitespace inside the braces.
  assert.deepEqual(
    [...observedChannels(node({ tool: { name: "t", version: "1", args: { x: "${ one } and ${two}" } } }))].sort(),
    ["one", "two"],
  );
  // A node with no tool block observes exactly what it declares.
  assert.deepEqual([...observedChannels({ id: "n" as never, type: "function", reads: ["only"] } as NodeSpec)], ["only"]);
});

test("THE BOUNDARY IS NAMED, not assumed: a router's `when` is NOT covered", () => {
  // `when` reads the scope through the expression evaluator rather than through a `${}`
  // template, so nothing here sees it — control-flow influence, a different question from
  // feeding an action, and it is HANDOFF T1. Written as a test so the gap is a fact somebody
  // can find rather than a sentence in a docstring that may have stopped being true.
  const router = {
    id: "r" as never,
    type: "router",
    router: { mode: "rules", cases: [{ when: "secret != null", edge: "e1" }], fallbackEdge: "e2" },
  } as unknown as NodeSpec;
  assert.deepEqual([...observedChannels(router)], [], "if this ever returns [\"secret\"], T1 was closed — update it");
});

test("THE ENGINE DOES NOT TRUST THE COMPILED PLAN to have computed this floor", async () => {
  // Why the correction is made in BOTH places, and the test that tells them apart.
  //
  // `plans` are excluded from `graphHash` (01-INTERFACES, the graph-binding row) precisely
  // because a different process can recompute a different plan for identical bytes — "a process
  // registering fewer tools recomputes a weaker posture under an identical hash". So a RunGraph
  // can arrive carrying `posture: "out"` for a node whose channels say `in`, and when it does,
  // the engine's own `dataClassification` is the only term left.
  //
  // Without this, reverting the engine site alone changed no outcome and its mutation stayed
  // green — a fix with no test that could fail, which this repo treats as no fix at all.
  const seen: string[] = [];
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const tools = new ToolRegistry();
  tools.register({
    ...MANIFEST,
    description: "post",
    parameters: { type: "object", properties: { body: { type: "string" } } },
    execute: (args) => {
      seen.push(String(args["body"]));
      return { content: "ok", writes: { out: { sent: true } } };
    },
  });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now,
    sleep: async () => {},
    policy: { granted: ["net:fetch"], systemFloor: "out" },
  });

  const compiled = compileOrThrow({
    spec: spec([], "secret_ref"),
    resolver: { resolve: () => undefined },
    tools: { "net.post": MANIFEST },
    tenantCapabilities: ["net:fetch"],
  });
  assert.equal(compiled.plans["post" as never]?.posture, "in", "the compiler got it right — now take that away");

  // The same bytes, the same hash, a weaker plan. This is the shape the hash cannot detect.
  const weakened = {
    ...compiled,
    plans: { ...compiled.plans, ["post" as never]: { ...compiled.plans["post" as never]!, posture: "out" as const } },
  };

  const runId = await engine.submit({ graph: weakened, inputs: { token: "sk-live-SUPER-SECRET" } });
  const p = await engine.advance(runId);

  assert.equal(p.status, "awaiting_gate", "the engine must floor it from the channels, not from the plan it was handed");
  assert.equal(seen.length, 0, "and the secret must not reach the tool");
});

/**
 * A graph's `policy.capabilities` was a request, and the design says it is a ceiling.
 *
 * `02-EXECUTION-GRAPH.md` D5's schema line:
 *
 *     capabilities: [string]         # allowlist; intersected with system + tenant (never widened)
 *
 * Only the upward half existed. `rule017Capabilities` checked the list against the TENANT and
 * nothing checked a node's tools against the LIST — `grep -arn 'policy.capabilities'` over
 * `src/` returned three sites, two of them that upward check and one that reads a NODE's list.
 * Nothing narrowed anything. Measured, with the tenant holding `pay`:
 *
 *     graph declares ["pay"]      → succeeded, charged
 *     graph declares []           → succeeded, CHARGED
 *     graph declares nothing      → succeeded, charged
 *
 * An author writing `capabilities: []` reads it as "this graph needs nothing" and got a graph
 * that can move money.
 *
 * **ABSENT IS NOT EMPTY**, and the distinction is the whole compatibility story: a graph that
 * declares no list has no ceiling and is untouched. Every graph in this repo that declares one
 * already names what its tools need — checked by arming the rule and running the whole suite
 * before writing a line of it: zero failures.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compile, compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";

const CHARGE: ToolManifestLite = { name: "pay.charge", version: "1.0", capabilities: ["pay"], irreversibility: "reversible_write", idempotent: true };
const MANIFESTS = { "pay.charge": CHARGE };

function spec(caps: readonly string[] | undefined): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "cap", project: "p", version: 1 },
    policy: { posture: "out", ...(caps === undefined ? {} : { capabilities: [...caps] }) },
    channels: { out: { type: "object", reduce: "replace" } },
    inputs: [],
    outputs: ["out"],
    nodes: [{ id: "act" as never, type: "tool", writes: ["out"], tool: { name: "pay.charge", version: "1.0", args: {} } }],
    edges: [],
  };
}

const RESOLVER: ResourceResolver = { resolve: () => undefined };

function errorsOf(caps: readonly string[] | undefined): readonly string[] {
  const r = compile({ spec: spec(caps), resolver: RESOLVER, tools: MANIFESTS, tenantCapabilities: ["pay"] });
  return r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}

test("A GRAPH THAT DECLARES NO CAPABILITIES CANNOT USE ONE", () => {
  // THE DEFECT: this compiled and charged.
  assert.deepEqual(errorsOf([]), ["GRAPH017_CAPABILITY_NOT_DECLARED"]);
  assert.deepEqual(errorsOf(["pay"]), [], "declaring it is how you use it");
});

test("ABSENT IS NOT EMPTY — a graph with no list has no ceiling", () => {
  // The compatibility hinge. Making absent behave like `[]` would refuse every graph that has
  // never declared the field, which is most of them.
  assert.deepEqual(errorsOf(undefined), []);
});

test("the message names the capability, the tool and the fix", () => {
  const r = compile({ spec: spec([]), resolver: RESOLVER, tools: MANIFESTS, tenantCapabilities: ["pay"] });
  const d = r.diagnostics.find((x) => x.code === "GRAPH017_CAPABILITY_NOT_DECLARED")!;
  assert.match(d.message, /pay\.charge/);
  assert.match(d.message, /"pay"/);
  assert.match(d.fix ?? "", /add "pay" to the graph's policy\.capabilities/);
});

// ── and the runtime half ────────────────────────────────────────────────────

function rig(tenant: readonly string[]) {
  const charged: number[] = [];
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const tools = new ToolRegistry();
  const def: ToolDefinition = {
    ...CHARGE,
    description: "c",
    parameters: { type: "object", properties: {} },
    execute: () => {
      charged.push(1);
      return { content: "ok", writes: { out: {} } };
    },
  };
  tools.register(def);
  const engine = new Engine({
    store, bus: new InProcessEventBus({ store }), tools,
    functions: new FunctionRegistry(), models: new ModelRegistry(), now, sleep: async () => {},
    policy: { granted: [...tenant], systemFloor: "out" },
  });
  return { engine, charged, tools };
}

test("THE CEILING IS ENFORCED AT RUN TIME TOO, not only at compile", async () => {
  // `plans` are excluded from `graphHash` and `attach` is public, so a graph can reach the
  // engine without passing this build's compiler — the same argument that made the engine's own
  // classification floor load-bearing next door. A compile-only ceiling is a ceiling a graph
  // can walk under.
  const r = rig(["pay"]);
  // Compiled while the graph still declared `pay`, then the declaration is taken away — which
  // is exactly the shape a stale or hand-built `RunGraph` has.
  const graph = compileOrThrow({ spec: spec(["pay"]), resolver: RESOLVER, tools: MANIFESTS, tenantCapabilities: ["pay"] });
  const narrowed = { ...graph, spec: { ...graph.spec, policy: { ...graph.spec.policy, capabilities: [] } } };
  const runId = await r.engine.submit({ graph: narrowed, inputs: {} });
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "failed", "the engine must refuse a capability the graph does not declare");
  assert.equal(r.charged.length, 0);
});

// ── delegation, which is where the last two of these went wrong ─────────────

const CHILD: GraphSpec = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "child", project: "p", version: 1 },
  policy: { posture: "out", capabilities: ["pay"] },
  channels: { receipt: { type: "object", reduce: "replace" } },
  inputs: [],
  outputs: ["receipt"],
  nodes: [{ id: "charge" as never, type: "tool", writes: ["receipt"], tool: { name: "pay.charge", version: "1.0", args: {} } }],
  edges: [],
};

function parentSpec(caps: readonly string[] | undefined): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "parent", project: "p", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 16, maxDepth: 2, maxFanout: 2, maxLoopIterations: 1 }, ...(caps === undefined ? {} : { capabilities: [...caps] }) },
    channels: { result: { type: "object", reduce: "replace" } },
    inputs: [],
    outputs: ["result"],
    nodes: [{ id: "delegate" as never, type: "subgraph", writes: ["result"], subgraph: { ref: "graph/child@stable", inputs: {}, outputs: { result: "receipt" } } }],
    edges: [],
  };
}

const CHILD_RESOLVER: ResourceResolver = {
  resolve: (ref) => (/^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref) ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" } : undefined),
  subgraph: (ref) => (ref === "graph/child@stable" ? CHILD : undefined),
};

test("A CEILING TRAVELS INTO A SUBGRAPH — and now the COMPILER says so", () => {
  // This used to end "the parent's own node reaches no tool — a `subgraph` node names none — so
  // the compile-time check cannot see this. Only the run-time ceiling can." That was true, and
  // it was the cost: the refusal arrived as an `E_CAP_DENIED` that killed a RUNNING run, which
  // is precisely the "compiles, then fails at run time" the compile stage exists to prevent.
  // GRAPH017 now folds the resolved child spec into the parent's ceiling.
  const refused = compile({ spec: parentSpec([]), resolver: CHILD_RESOLVER, tools: MANIFESTS, tenantCapabilities: ["pay"] });
  assert.equal(refused.ok, false, "a parent that declares nothing must not compile over a child that charges");
  const d = refused.diagnostics.filter((x) => x.code === "GRAPH017_CAPABILITY_NOT_DECLARED");
  assert.equal(d.length, 1, JSON.stringify(refused.diagnostics));
  // NAMING THE CHILD, not the parent's node alone — the two have different fixes, and an author
  // told only "node delegate" has nowhere to look.
  assert.match(d[0]!.message, /tool "pay\.charge" used by subgraph "graph\/child@stable" under node "delegate"/);
});

test("…and the RUN-TIME ceiling still stands behind it, for a graph that skipped this compiler", async () => {
  // T6's lesson, applied before it could become T6's defect: a guarantee a child escapes is not
  // a guarantee. `plans` are excluded from `graphHash` and `attach` is public, so a graph can
  // reach the engine without passing this build's compiler — so the compile diagnostic above is
  // the EARLIER answer, never the only one. Compiled while the parent still declared `pay`, then
  // the declaration is taken away, exactly as the run-time test further up does.
  const charged: number[] = [];
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const tools = new ToolRegistry();
  tools.register({ ...CHARGE, description: "c", parameters: { type: "object", properties: {} },
    execute: () => { charged.push(1); return { content: "ok", writes: { receipt: {} } }; } });
  const engine = new Engine({
    store, bus: new InProcessEventBus({ store }), tools,
    functions: new FunctionRegistry(), models: new ModelRegistry(), now, sleep: async () => {},
    resolver: CHILD_RESOLVER, policy: { granted: ["pay"], systemFloor: "out" },
  });

  const compiled = compileOrThrow({ spec: parentSpec(["pay"]), resolver: CHILD_RESOLVER, tools: MANIFESTS, tenantCapabilities: ["pay"] });
  const bounded = { ...compiled, spec: { ...compiled.spec, policy: { ...compiled.spec.policy, capabilities: [] } } };
  const p = await engine.advance(await engine.submit({ graph: bounded, inputs: {} }));
  assert.equal(p.status, "failed", "a parent that declares nothing must not charge through a child");
  assert.equal(charged.length, 0, "and the money must not move");
});

test("...while a parent that DOES declare it still delegates fine", async () => {
  const charged: number[] = [];
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const tools = new ToolRegistry();
  tools.register({ ...CHARGE, description: "c", parameters: { type: "object", properties: {} },
    execute: () => { charged.push(1); return { content: "ok", writes: { receipt: {} } }; } });
  const engine = new Engine({
    store, bus: new InProcessEventBus({ store }), tools,
    functions: new FunctionRegistry(), models: new ModelRegistry(), now, sleep: async () => {},
    resolver: CHILD_RESOLVER, policy: { granted: ["pay"], systemFloor: "out" },
  });
  const ok = compileOrThrow({ spec: parentSpec(["pay"]), resolver: CHILD_RESOLVER, tools: MANIFESTS, tenantCapabilities: ["pay"] });
  const p = await engine.advance(await engine.submit({ graph: ok, inputs: {} }));
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.equal(charged.length, 1, "otherwise the test above passes because delegation is broken");
});

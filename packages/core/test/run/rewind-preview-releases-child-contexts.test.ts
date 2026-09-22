/**
 * A PREVIEW RELEASES WHAT IT INSTALLED — INCLUDING THE CHILD CONTEXTS. §A.76.
 *
 * `planRewind` is the READ half of `rewind`, and its `finally` says so: "otherwise an operator
 * previewing rewinds of finished runs re-attaches one per call, for the life of the process, which
 * is the leak `#retire` exists to close. Only what THIS call attached". It retired the PARENT and
 * nothing else. But the walk it runs — `#rewindPlanOf` → `#planRollbackChildSteps` →
 * `#childContextFor` → `#contextFor` — REGISTERS a rebuilt context for every child whose graph the
 * parent's `subgraphs[ref]` can be compiled from, and `#contextFor`'s first line returns an
 * existing context untouched, discarding the graph the caller passed.
 *
 * SO `attach(childRunId, correctedGraph)` WAS A SILENT NO-OP after a preview — no error and no
 * effect — and the stale context the preview installed was what the next verb read. That is the
 * one shape where it costs something real: a child whose graph THIS build cannot rebuild
 * correctly, because the workflow at that `ref` has been edited since the child ran. The rebuilt
 * context carries the NEW graph's capability allowlist, and the child's undo needs the OLD one.
 *
 * THE OBSERVABLE THE ROW DEMANDED, and it is money rather than a membership predicate — `#runs` has
 * no public membership question and `attach` returns `void`, which is why the row was recorded as
 * "not measurable through a public surface yet". A delegated `pay.refundable` charge, previewed
 * through `planRewind(parent)`, re-attached with the child's REAL graph, then rewound:
 *
 *     before   refund records: [ { run: 'child', outcome: 'failed' } ]      refunds: []
 *     after    refund records: [ { run: 'child', outcome: 'compensated' } ] refunds: [ 42 ]
 *
 * THE CONTROL IS THE SAME RUN WITH NO PREVIEW IN FRONT OF IT — an `attach` on a child nothing
 * holds has always worked, so a test that only drove the preview path could pass on a build where
 * `attach` was the thing broken. Both legs are here, and the only difference between them is
 * whether a preview ran first.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import type { RunId, Seq } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import { OPERATOR, rewindWithPlan } from "./operator.ts";

const NOW = 1_700_000_000_000;
const CHILD_REF = "graph/double@stable";

const CHARGE: ToolManifestLite = {
  name: "pay.refundable",
  version: "1.0",
  capabilities: ["pay"],
  irreversibility: "irreversible",
  idempotent: false,
  compensation: { tool: "pay.refund" },
};
const REFUND: ToolManifestLite = {
  name: "pay.refund",
  version: "1.0",
  capabilities: ["pay"],
  irreversibility: "reversible_write",
  idempotent: true,
};
const MANIFESTS: Record<string, ToolManifestLite> = { "pay.refundable": CHARGE, "pay.refund": REFUND };

const CHILD_CHANNELS = {
  amount: { type: "number", reduce: "replace" },
  doubled: { type: "number", reduce: "replace" },
  receipt: { type: "object", reduce: "replace" },
} as const;

/** What the child actually ran: it charges, so it declares `pay`. */
function realChildSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "double", project: "sub", version: 1 },
    policy: { posture: "out", capabilities: ["pay"] },
    channels: CHILD_CHANNELS,
    inputs: ["amount"],
    outputs: ["receipt"],
    nodes: [
      { id: "double", type: "function", reads: ["amount"], writes: ["doubled"], function: { ref: "function/double@stable" } },
      {
        id: "charge",
        type: "tool",
        reads: ["doubled"],
        writes: ["receipt"],
        tool: { name: "pay.refundable", version: "1.0", args: { amount: "${doubled}" } },
        unhandled: true,
      },
    ],
    edges: [{ id: "c", from: "double", to: "charge", kind: "seq" }],
  } as unknown as GraphSpec;
}

/**
 * What the workflow at that same `ref` says NOW: the charge was taken out of it, so it declares no
 * capability at all. It compiles — which is exactly why the preview installs it — and it is not
 * the graph the child ran under.
 */
function editedChildSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "double", project: "sub", version: 2 },
    policy: { posture: "out", capabilities: [] },
    channels: CHILD_CHANNELS,
    inputs: ["amount"],
    outputs: ["receipt"],
    nodes: [
      { id: "double", type: "function", reads: ["amount"], writes: ["doubled", "receipt"], function: { ref: "function/double@stable" } },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

function parentSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "parent", project: "sub", version: 1 },
    policy: {
      posture: "out",
      capabilities: ["pay"],
      expansion: { maxNodes: 32, maxDepth: 3, maxFanout: 4, maxLoopIterations: 1 },
    },
    channels: { total: { type: "number", reduce: "replace" }, result: { type: "object", reduce: "replace" } },
    inputs: ["total"],
    outputs: ["result"],
    nodes: [
      {
        id: "delegate",
        type: "subgraph",
        reads: ["total"],
        writes: ["result"],
        checkpoint: "before",
        subgraph: { ref: CHILD_REF, inputs: { amount: "total" }, outputs: { result: "receipt" }, budgetShare: 0.5 },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

function resolverWith(child: GraphSpec): ResourceResolver {
  return {
    resolve: (ref) =>
      /^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref) ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" } : undefined,
    subgraph: (ref) => (ref === CHILD_REF ? child : undefined),
  } as ResourceResolver;
}

type Ledger = { readonly charges: number[]; readonly refunds: number[] };

function newEngine(store: MemoryStateStore, ledger: Ledger, child: GraphSpec): Engine {
  const tools = new ToolRegistry();
  tools.register({
    ...CHARGE,
    description: "Take money.",
    parameters: { type: "object", properties: { amount: { type: "number" } } },
    execute: (args: Record<string, unknown>) => {
      ledger.charges.push(Number(args["amount"]));
      // `details` is the only channel an undo's arguments can come from.
      return { content: "charged", details: { amount: Number(args["amount"]) }, writes: { receipt: { ok: true } } };
    },
  } as unknown as ToolDefinition);
  tools.register({
    ...REFUND,
    description: "Give it back.",
    parameters: { type: "object", properties: { amount: { type: "number" } } },
    execute: (args: Record<string, unknown>) => {
      ledger.refunds.push(Number(args["amount"]));
      return { content: "refunded" };
    },
  } as unknown as ToolDefinition);
  const functions = new FunctionRegistry();
  // Writes `doubled` ONLY: the real child's `double` node declares exactly that, and a node that
  // writes what it did not declare fails the run.
  functions.register("function/double@stable", (view) => ({ writes: { doubled: (view.get<number>("amount") ?? 0) * 2 } }));
  return new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions,
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    resolver: resolverWith(child),
    policy: { granted: ["pay"], systemFloor: "out", budget: { runUsd: 10 } },
  });
}

/** Every `compensation.recorded` under a run and its children, tagged with the journal it landed in. */
async function records(
  store: MemoryStateStore,
  runId: RunId,
): Promise<readonly { readonly run: "parent" | "child"; readonly outcome: string; readonly reason?: string }[]> {
  const out: { readonly run: "parent" | "child"; readonly outcome: string; readonly reason?: string }[] = [];
  const journals: { readonly runId: RunId; readonly which: "parent" | "child" }[] = [{ runId, which: "parent" }];
  for await (const ev of store.read(runId, 1 as Seq)) {
    if (ev.type === "subgraph.started") journals.push({ runId: ev.payload.childRunId, which: "child" });
  }
  for (const j of journals) {
    for await (const ev of store.read(j.runId, 1 as Seq)) {
      if (ev.type === "compensation.recorded") out.push({ run: j.which, ...(ev.payload as object) } as never);
    }
  }
  return out;
}

/** Run the parent on a build that HAS the real child graph, and leave the charge standing. */
async function chargeUnderTheRealGraph(): Promise<{
  readonly store: MemoryStateStore;
  readonly ledger: Ledger;
  readonly runId: RunId;
  readonly childRunId: RunId;
}> {
  const store = new MemoryStateStore({ now: () => NOW });
  const ledger: Ledger = { charges: [], refunds: [] };
  const engine = newEngine(store, ledger, realChildSpec());
  const graph = compileOrThrow({
    spec: parentSpec(),
    resolver: resolverWith(realChildSpec()),
    tools: MANIFESTS,
    tenantCapabilities: ["pay"],
  });
  const runId: RunId = await engine.submit({ graph, inputs: { total: 21 } });
  let p = await engine.advance(runId);
  for (let i = 0; i < 4 && p.status === "awaiting_gate"; i++) {
    const open = Object.values(p.gates).find((g) => g.state === "open");
    if (open === undefined) break;
    p = await engine.resolveGate(runId, {
      gateId: open.gateId,
      decision: { kind: "approve" },
      actor: OPERATOR,
      idempotencyKey: `k${i}`,
    });
  }
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(ledger.charges, [42], "the child took the money");
  let childRunId: RunId | undefined;
  for await (const ev of store.read(runId, 1 as Seq)) {
    if (ev.type === "subgraph.started") childRunId = ev.payload.childRunId;
  }
  assert.ok(childRunId !== undefined, "the parent journal names its child");
  return { store, ledger, runId, childRunId };
}

/** The child's real graph, compiled — what an operator still holds and hands to `attach`. */
function realChildGraph(): RunGraph {
  return compileOrThrow({
    spec: realChildSpec(),
    resolver: resolverWith(realChildSpec()),
    tools: MANIFESTS,
    tenantCapabilities: ["pay"],
  });
}

test("§A.76 — a preview does not wedge a later `attach` on the child it rebuilt", async () => {
  const { store, ledger, runId, childRunId } = await chargeUnderTheRealGraph();

  // A NEW PROCESS, holding the workflow as it reads TODAY. `subgraphs[CHILD_REF]` is the edited
  // child, so the context this build rebuilds for the child declares no `pay`.
  const engine = newEngine(store, ledger, editedChildSpec());
  const parentGraph = compileOrThrow({
    spec: parentSpec(),
    resolver: resolverWith(editedChildSpec()),
    tools: MANIFESTS,
    tenantCapabilities: ["pay"],
  });
  engine.attach(runId, parentGraph);

  // 1 · THE OPERATOR PREVIEWS. This is the call that registers the child's context.
  const preview = await engine.planRewind(runId, 1 as Seq, OPERATOR);
  assert.ok(
    preview.steps.some((s) => s.runId === childRunId),
    `the preview shows the child's undo: ${JSON.stringify(preview.steps)}`,
  );

  // 2 · THE OPERATOR FIXES THE CHILD, with the graph the child actually ran under — the move the
  //     product tells them to make ("attach it and rewind, or the effect stands").
  engine.attach(childRunId, realChildGraph());

  // 3 · AND REWINDS. The undo has to dispatch under the graph they attached.
  await rewindWithPlan(engine, runId, 1 as Seq, "operator asked to undo");

  const rows = await records(store, runId);
  const child = rows.filter((r) => r.run === "child");
  assert.equal(child.length, 1, `one undo in the child's journal: ${JSON.stringify(rows)}`);
  assert.equal(
    child[0]?.outcome,
    "compensated",
    `the attached graph is what the undo runs under — got ${JSON.stringify(child[0])}`,
  );
  assert.deepEqual(ledger.refunds, [42], "and the money comes back");
});

test("§A.76 — THE CONTROL: with no preview in front of it, the same `attach` always worked", async () => {
  // The same three steps with step 1 removed. This leg passes on the unfixed build too, which is
  // what makes the leg above a measurement of the PREVIEW rather than of `attach` in general.
  const { store, ledger, runId, childRunId } = await chargeUnderTheRealGraph();
  const engine = newEngine(store, ledger, editedChildSpec());
  engine.attach(
    runId,
    compileOrThrow({
      spec: parentSpec(),
      resolver: resolverWith(editedChildSpec()),
      tools: MANIFESTS,
      tenantCapabilities: ["pay"],
    }),
  );
  engine.attach(childRunId, realChildGraph());
  await rewindWithPlan(engine, runId, 1 as Seq, "operator asked to undo");

  const child = (await records(store, runId)).filter((r) => r.run === "child");
  assert.equal(child[0]?.outcome, "compensated", `${JSON.stringify(child)}`);
  assert.deepEqual(ledger.refunds, [42], "the money comes back");
});

test("§A.76 — and the edited graph is genuinely what refuses the undo, with no `attach` at all", async () => {
  // The third leg, which is what makes the other two mean anything: on this build, rewinding
  // WITHOUT attaching the child's real graph leaves the charge standing, because the rebuilt
  // context's allowlist does not carry `pay`. If this leg ever reads `compensated`, the fixture
  // has stopped discriminating and the two legs above are vacuous.
  const { store, ledger, runId } = await chargeUnderTheRealGraph();
  const engine = newEngine(store, ledger, editedChildSpec());
  engine.attach(
    runId,
    compileOrThrow({
      spec: parentSpec(),
      resolver: resolverWith(editedChildSpec()),
      tools: MANIFESTS,
      tenantCapabilities: ["pay"],
    }),
  );
  await rewindWithPlan(engine, runId, 1 as Seq, "operator asked to undo");

  const child = (await records(store, runId)).filter((r) => r.run === "child");
  assert.equal(child[0]?.outcome, "failed", `the undo is refused under the edited graph: ${JSON.stringify(child)}`);
  assert.match(
    String(child[0]?.reason ?? ""),
    /capability "pay" is outside the graph's declared `policy\.capabilities`/,
    `and the reason names the capability the edited graph no longer declares: ${String(child[0]?.reason)}`,
  );
  assert.deepEqual(ledger.refunds, [], "so the money does not come back");
});

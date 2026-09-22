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
import { CODES } from "../../src/errors.ts";
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
const MID_REF = "graph/mid@stable";

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

function resolverWith(child: GraphSpec, mid?: GraphSpec): ResourceResolver {
  return {
    resolve: (ref) =>
      /^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref) ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" } : undefined,
    subgraph: (ref) => (ref === CHILD_REF ? child : ref === MID_REF ? mid : undefined),
  } as ResourceResolver;
}

/** The middle of `top -> mid -> leaf`: it delegates onward and does nothing of its own. */
function midSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "mid", project: "sub", version: 1 },
    policy: {
      posture: "out",
      capabilities: ["pay"],
      expansion: { maxNodes: 32, maxDepth: 4, maxFanout: 4, maxLoopIterations: 1 },
    },
    channels: { total: { type: "number", reduce: "replace" }, result: { type: "object", reduce: "replace" } },
    inputs: ["total"],
    outputs: ["result"],
    nodes: [
      {
        id: "onward",
        type: "subgraph",
        reads: ["total"],
        writes: ["result"],
        subgraph: { ref: CHILD_REF, inputs: { amount: "total" }, outputs: { result: "receipt" }, budgetShare: 0.5 },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

/** The top of `top -> mid -> leaf`. */
function topSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "top", project: "sub", version: 1 },
    policy: {
      posture: "out",
      capabilities: ["pay"],
      expansion: { maxNodes: 32, maxDepth: 4, maxFanout: 4, maxLoopIterations: 1 },
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
        subgraph: { ref: MID_REF, inputs: { total: "total" }, outputs: { result: "result" }, budgetShare: 0.5 },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

type Ledger = { readonly charges: number[]; readonly refunds: number[] };

function newEngine(store: MemoryStateStore, ledger: Ledger, child: GraphSpec, mid?: GraphSpec): Engine {
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
    resolver: resolverWith(child, mid),
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
  /** The engine that RAN it, for the one leg whose question is about what this engine retired. */
  readonly ran: Engine;
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
  return { store, ledger, runId, childRunId, ran: engine };
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

test("§A.76 — and a preview does not undo `forget(childRunId)`, which is the other half of \"restores\"", async () => {
  // THE `finally` CLAIMED TO RESTORE WHAT IT FOUND AND DROPPED THE CONTEXT ONLY. `#contextFor`'s
  // first act is `this.#forgotten.delete(runId)`, so a child an operator had explicitly `forget`ten
  // came back as a child this engine had merely never seen — and `#retainedGraphOf` answers those
  // two differently. `forget`'s own docstring is the contract being broken: an explicit release
  // means "`#reattach` declines it until `attach` says otherwise".
  //
  // MEASURED THROUGH THE DOOR THAT READS IT, because `#forgotten` has no public predicate either.
  // A rewind of the CHILD with nothing attached goes through `#reattach` -> `#retainedGraphOf`,
  // which declines a forgotten run — so the two states are "refused" and "proceeded, money moved".
  // Before this arm, the leg WITH a preview in front of it proceeded and refunded 42.
  for (const previewFirst of [false, true]) {
    // THE SAME ENGINE THAT RAN IT, which is load-bearing and was wrong in the first draft of this
    // test. `#retainedGraphOf` asks `#retiredRuns` FIRST, and only the engine that drove the child
    // to a terminal state has it there — so on a fresh engine both legs refuse for a different
    // reason (no retained graph at all) and the test measures nothing. Caught by mutating the
    // restore away and watching this stay green.
    const { ledger, runId, childRunId, ran: engine } = await chargeUnderTheRealGraph();

    // The operator says: this engine holds nothing for that run.
    engine.forget(childRunId);
    if (previewFirst) await engine.planRewind(runId, 1 as Seq, OPERATOR);

    let refused: string | undefined;
    try {
      const plan = await engine.planRewind(childRunId, 1 as Seq, OPERATOR);
      await engine.rewind(childRunId, 1 as Seq, "undo", OPERATOR, { planHash: plan.planHash });
    } catch (e) {
      refused = (e as { code?: string }).code;
    }
    assert.equal(
      refused,
      CODES.E_RESTORE_ILLEGAL,
      `previewFirst=${previewFirst}: a forgotten child is not re-attachable from what this engine retired`,
    );
    assert.deepEqual(ledger.refunds, [], `previewFirst=${previewFirst}: and no undo was dispatched`);
  }
});

/**
 * A store that runs a callback the first time the preview's own `rewind.plan` row is appended.
 *
 * THIS IS HOW THE RACE IS MADE DETERMINISTIC WITHOUT TOUCHING A PRIVATE SEAM. `planRewind` journals
 * what it showed (`#journalPlanShown`) after the walk and before its `finally`, so an append hook on
 * that row lands in exactly the window where a concurrent `attach` used to be lost: the walk has
 * already built the child's context, and the release has not run yet.
 */
class HookedStore extends MemoryStateStore {
  #onPlanShown: (() => void) | undefined;
  onPlanShown(fn: () => void): void {
    this.#onPlanShown = fn;
  }
  override async append(input: Parameters<MemoryStateStore["append"]>[0]): ReturnType<MemoryStateStore["append"]> {
    const out = await super.append(input);
    const shows = input.events.some(
      (e) => e.type === "operator.command" && (e.payload as { kind?: string } | undefined)?.kind === "rewind.plan",
    );
    if (shows && this.#onPlanShown !== undefined) {
      const fn = this.#onPlanShown;
      this.#onPlanShown = undefined;
      fn();
    }
    return out;
  }
}

test("§A.76 — an `attach` that lands DURING the preview is not re-forgotten by its release", async () => {
  // THE RACE ROUND 2 FOUND. `planRewind` is async; `attach` and `forget` are synchronous and public.
  // The first cut of the `forget` restore sampled `#forgotten` before the walk and wrote it back in
  // the `finally`, which is after an `await` — so an operator's `attach(child, graph)` landing in
  // between was overwritten by the older sample, and a run they had just asked for came back
  // forgotten. The fix moves the restore into `#childContextFor`, in the same tick as the build, so
  // the flag is clear at release time only if a CALLER cleared it.
  //
  // DRIVEN THROUGH THE JOURNAL RATHER THAN A PRIVATE HOOK: the callback fires on the append of the
  // preview's own `rewind.plan` row, which is written after the walk and before the release.
  const store = new HookedStore({ now: () => NOW });
  const ledger: Ledger = { charges: [], refunds: [] };
  const engine = newEngine(store, ledger, realChildSpec());
  const graph = compileOrThrow({ spec: parentSpec(), resolver: resolverWith(realChildSpec()), tools: MANIFESTS, tenantCapabilities: ["pay"] });
  const runId: RunId = await engine.submit({ graph, inputs: { total: 21 } });
  let p = await engine.advance(runId);
  for (let i = 0; i < 4 && p.status === "awaiting_gate"; i++) {
    const open = Object.values(p.gates).find((g) => g.state === "open");
    if (open === undefined) break;
    p = await engine.resolveGate(runId, { gateId: open.gateId, decision: { kind: "approve" }, actor: OPERATOR, idempotencyKey: `k${i}` });
  }
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  let childRunId: RunId | undefined;
  for await (const ev of store.read(runId, 1 as Seq)) {
    if (ev.type === "subgraph.started") childRunId = ev.payload.childRunId;
  }
  assert.ok(childRunId !== undefined);

  // The operator releases the child, then — mid-preview — asks for it back.
  engine.forget(childRunId);
  store.onPlanShown(() => engine.attach(childRunId, realChildGraph()));
  await engine.planRewind(runId, 1 as Seq, OPERATOR);

  // THE OBSERVABLE: the child is rewindable, because the last thing anyone SAID about it was
  // "attach". Before this fix the preview's release re-forgot it and this refused
  // `E_RESTORE_ILLEGAL` — an operator's own request undone by a read-only verb.
  const plan = await engine.planRewind(childRunId, 1 as Seq, OPERATOR);
  await engine.rewind(childRunId, 1 as Seq, "undo", OPERATOR, { planHash: plan.planHash });
  assert.deepEqual(ledger.refunds, [42], "the undo dispatched under the graph the operator attached");

  // AND THE CONTROL, one line apart: no `attach` in that window, so the `forget` still stands.
  const quiet = await chargeUnderTheRealGraph();
  quiet.ran.forget(quiet.childRunId);
  await quiet.ran.planRewind(quiet.runId, 1 as Seq, OPERATOR);
  let refused: string | undefined;
  try {
    const p2 = await quiet.ran.planRewind(quiet.childRunId, 1 as Seq, OPERATOR);
    await quiet.ran.rewind(quiet.childRunId, 1 as Seq, "undo", OPERATOR, { planHash: p2.planHash });
  } catch (e) {
    refused = (e as { code?: string }).code;
  }
  assert.equal(refused, CODES.E_RESTORE_ILLEGAL, "a forgotten child nobody re-attached is still forgotten");
  assert.deepEqual(quiet.ledger.refunds, [], "and no undo ran");
});

test("§A.76 — the release reaches a GRANDCHILD, at depth 2", async () => {
  // ROUND 0 LEAKED AT DEPTH 2 AND THE FIX COVERS IT BY CONSTRUCTION — `#planRollback` threads
  // `installed` down its own descent, so every level the walk rebuilds is reported. Unpinned until
  // now, which is the half that matters: the descent is where a per-level fix would have been
  // written by hand and missed a level.
  //
  // `top -> mid -> leaf`, with the charge at the LEAF, so the walk has to rebuild two contexts to
  // reach it and the one under test is the deeper one.
  const store = new MemoryStateStore({ now: () => NOW });
  const ledger: Ledger = { charges: [], refunds: [] };
  const engine = newEngine(store, ledger, realChildSpec(), midSpec());
  const graph = compileOrThrow({
    spec: topSpec(),
    resolver: resolverWith(realChildSpec(), midSpec()),
    tools: MANIFESTS,
    tenantCapabilities: ["pay"],
  });
  const runId: RunId = await engine.submit({ graph, inputs: { total: 21 } });
  let p = await engine.advance(runId);
  for (let i = 0; i < 6 && p.status === "awaiting_gate"; i++) {
    const open = Object.values(p.gates).find((g) => g.state === "open");
    if (open === undefined) break;
    p = await engine.resolveGate(runId, { gateId: open.gateId, decision: { kind: "approve" }, actor: OPERATOR, idempotencyKey: `k${i}` });
  }
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(ledger.charges, [42], "the money moved at the leaf");

  // The LEAF is two `subgraph.started` hops down: the mid run's journal names it, not the top's.
  const childrenOf = async (of: RunId): Promise<RunId[]> => {
    const out: RunId[] = [];
    for await (const ev of store.read(of, 1 as Seq)) if (ev.type === "subgraph.started") out.push(ev.payload.childRunId);
    return out;
  };
  const mid = (await childrenOf(runId))[0];
  assert.ok(mid !== undefined, "the top run names its child");
  const leaf = (await childrenOf(mid))[0];
  assert.ok(leaf !== undefined, "and the child names the grandchild");

  engine.forget(leaf);
  await engine.planRewind(runId, 1 as Seq, OPERATOR);

  // If the preview left the GRANDCHILD's context installed, this would proceed on the graph the
  // preview built. It refuses, because the release reached depth 2 and the `forget` survived it.
  let refused: string | undefined;
  try {
    const plan = await engine.planRewind(leaf, 1 as Seq, OPERATOR);
    await engine.rewind(leaf, 1 as Seq, "undo", OPERATOR, { planHash: plan.planHash });
  } catch (e) {
    refused = (e as { code?: string }).code;
  }
  assert.equal(refused, CODES.E_RESTORE_ILLEGAL, "the grandchild is released and still forgotten");
  assert.deepEqual(ledger.refunds, [], "and nothing was undone behind the operator's back");
});

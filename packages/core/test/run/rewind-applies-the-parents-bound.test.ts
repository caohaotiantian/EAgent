/**
 * A REWIND IS A DOOR ONTO THE TOOLS, SO IT IS A DOOR ONTO THE CAPABILITY BOUND.
 *
 * `PolicyEngine.restore` folds the ceilings a run was submitted under back onto the live object
 * — and for a subgraph CHILD that is the only way a fresh process can learn them, because
 * `attach(childRunId, childGraph)` builds the child at the deployment's budget and the child
 * graph's OWN capability list. The parent's narrowing lives in the child's `run.submitted`.
 *
 * `restore` had one caller: `#advanceSerially`. `#rewindSerially` dispatches compensation tools
 * through `#invokeTool` and clears the seeding flag AFTERWARDS, so on the attach-then-rewind
 * door every undo ran against the child graph's own list. Measured, before the fix: a parent
 * granting `["db.write"]` to a child whose graph declares `["db.write","db.undo"]` rewound with
 * `undone=[7]` and `compensation.recorded: compensated` — `db.delete` ran, needing a capability
 * the parent had removed.
 *
 * THE DOOR IS REACHABLE AND TAKES NO ADVANCE ON THE WAY. `POST /runs/<childRunId>/commands
 * {"kind":"rewind"}` goes `ownsRun` (a child inherits the parent's `submittedBy`, so the same
 * principal owns it) then `#bindFromIndex` then `engine.rewind`; `loom rewind <childRunId>` is
 * the same. Neither advances first, which is what made the bound hold on one verb and not the
 * other. A capability bound that holds on one verb is not a bound.
 *
 * THE CONTROL IS WHAT MAKES THE DEFECT ARM MEAN ANYTHING. Take `db.undo` out of the CHILD
 * GRAPH's own list and the allowlist forbids it with or without the re-seed — so the control
 * must refuse on both trees. Without it, "the defect arm refuses" is equally consistent with any
 * other guard firing anywhere on the path. Measured across the fix: the defect arm flips
 * `compensated` -> `failed`, the control is byte-identical.
 *
 * ONE DIMENSION OF FIVE IS ASSERTED HERE. `restore` also folds escalations, human ceilings,
 * spend and reservations, and this file exercises only the allowlist. They travel together
 * because `#seedPolicy` is the whole `restore` call and not a slice of it — which is a property
 * of the code rather than of this test, and is the reason the extraction was the fix.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import type { RunId, Seq } from "../../src/ids.ts";
import type { HumanActor, JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";

const NOW = 1_700_000_000_000;
const OPERATOR = { kind: "human", subject: "u:alice", via: "console" } as HumanActor;

const INSERT = {
  name: "db.insert",
  version: "1.0",
  capabilities: ["db.write"],
  irreversibility: "reversible_write",
  idempotent: true,
  compensation: { tool: "db.delete" },
} as const;

const DELETE = {
  name: "db.delete",
  version: "1.0",
  capabilities: ["db.undo"],
  irreversibility: "reversible_write",
  idempotent: true,
} as const;

const MANIFESTS = { "db.insert": INSERT, "db.delete": DELETE } as unknown as Record<string, ToolManifestLite>;

/** Wide on purpose: the TENANT grant must never be the thing that refuses, or the test proves nothing. */
const TENANT = ["db.write", "db.undo"];

function childSpec(caps: readonly string[]): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "child", project: "probe", version: 1 },
    policy: { posture: "out", capabilities: [...caps], expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { seed: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: ["seed"],
    outputs: ["out"],
    nodes: [
      {
        id: "cins",
        type: "tool",
        reads: ["seed"],
        writes: ["out"],
        tool: { name: "db.insert", version: "1.0", args: { row: 7 } },
        retry: { maxAttempts: 1 },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

/** The ceiling. `db.undo` is deliberately absent, and the child graph below may declare it anyway. */
function parentSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "parent", project: "probe", version: 1 },
    policy: { posture: "out", capabilities: ["db.write"], expansion: { maxNodes: 32, maxDepth: 2, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { seed: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: ["seed"],
    outputs: ["out"],
    nodes: [
      {
        id: "delegate",
        type: "subgraph",
        reads: ["seed"],
        writes: ["out"],
        subgraph: { ref: "graph/child@stable", inputs: { seed: "seed" }, outputs: { out: "out" } },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

interface World {
  rows: number[];
  undone: number[];
}

/** One engine over a shared store. Two of these is what "a fresh process" means here. */
function rig(store: MemoryStateStore, world: World, childCaps: readonly string[]): { engine: Engine; resolver: ResourceResolver } {
  const tools = new ToolRegistry();
  tools.register({
    ...INSERT,
    description: "insert",
    parameters: { type: "object", properties: { row: { type: "number" } }, required: ["row"] },
    execute: (args: Record<string, unknown>) => {
      const row = Number(args["row"]);
      world.rows.push(row);
      // `details` is the only channel an undo's arguments can come from.
      return { content: `inserted ${String(row)}`, details: { row }, writes: { out: { row } } };
    },
  } as never);
  tools.register({
    ...DELETE,
    description: "undo",
    parameters: { type: "object", properties: { row: { type: "number" } }, required: ["row"] },
    execute: (args: Record<string, unknown>) => {
      const row = Number(args["row"]);
      world.undone.push(row);
      const at = world.rows.indexOf(row);
      if (at >= 0) world.rows.splice(at, 1);
      return { content: `deleted ${String(row)}` };
    },
  } as never);

  const resolver = {
    resolve: (ref: string) =>
      /^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref) ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" } : undefined,
    subgraph: (ref: string) => (ref === "graph/child@stable" ? childSpec(childCaps) : undefined),
  } as unknown as ResourceResolver;

  const engine = new Engine({
    store,
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    resolver,
    policy: { granted: ["*"], systemFloor: "out", budget: { runUsd: 10 } },
  } as never);
  return { engine, resolver };
}

async function eventsOf(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const e of store.read(runId, 1 as Seq)) out.push(e);
  return out;
}

/** `rewind` refuses without the hash of a plan a person was shown; this is the two-phase call. */
async function rewindWithPlan(engine: Engine, runId: RunId, atSeq: number, reason: string): Promise<void> {
  const plan = await engine.planRewind(runId, atSeq as Seq, OPERATOR);
  await engine.rewind(runId, atSeq as Seq, reason, OPERATOR, { planHash: plan.planHash });
}

interface ArmResult {
  recordedCapabilities: unknown;
  undone: readonly number[];
  rows: readonly number[];
  outcomes: readonly { outcome: unknown; reason: string }[];
}

/**
 * Run the parent to completion, then ATTACH AND REWIND THE CHILD IN A SECOND ENGINE with no
 * `advance` in between — the door on which the bound was never applied.
 */
async function arm(childCaps: readonly string[]): Promise<ArmResult> {
  const store = new MemoryStateStore({ now: () => NOW });

  const first: World = { rows: [], undone: [] };
  const p1 = rig(store, first, childCaps);
  const graph = compileOrThrow({ spec: parentSpec(), resolver: p1.resolver, tools: MANIFESTS, tenantCapabilities: TENANT });
  const runId = await p1.engine.submit({ graph, inputs: { seed: "x" } });
  for (let i = 0; i < 20; i++) {
    const p = await p1.engine.advance(runId);
    if (p.status === "succeeded" || p.status === "failed") break;
  }
  assert.deepEqual(first.rows, [7], "the parent's delegated insert must actually have happened");

  const started = (await eventsOf(store, runId)).find((e) => e.type === "subgraph.started");
  const childId = (started!.payload as { childRunId: string }).childRunId as RunId;
  const submitted = (await eventsOf(store, childId)).find((e) => e.type === "run.submitted");
  const recordedCapabilities = (submitted!.payload as { capabilities?: unknown }).capabilities;

  const second: World = { rows: [...first.rows], undone: [] };
  const p2 = rig(store, second, childCaps);
  const childGraph = compileOrThrow({ spec: childSpec(childCaps), resolver: p2.resolver, tools: MANIFESTS, tenantCapabilities: TENANT });
  p2.engine.attach(childId, childGraph);
  await rewindWithPlan(p2.engine, childId, 1, "the operator rewinds a child in a process that never held its parent");

  const outcomes = (await eventsOf(store, childId))
    .filter((e) => e.type === "compensation.recorded")
    .map((e) => {
      const payload = e.payload as { outcome: unknown; reason?: unknown };
      return { outcome: payload.outcome, reason: String(payload.reason ?? "") };
    });
  return { recordedCapabilities, undone: second.undone, rows: second.rows, outcomes };
}

test("A CHILD REWOUND IN A FRESH PROCESS COMPENSATES INSIDE THE ALLOWLIST ITS PARENT NARROWED", async () => {
  // The child graph declares `db.undo` for itself. Only the parent's ceiling removes it, so the
  // ONLY thing that can refuse here is the bound folded out of the child's own `run.submitted`.
  const r = await arm(["db.write", "db.undo"]);

  assert.deepEqual(r.recordedCapabilities, ["db.write"], "the precondition: the parent's narrowing is a durable fact on the child's `run.submitted`");
  assert.deepEqual(r.undone, [], "`db.delete` needs `db.undo`, which the parent removed — it was dispatched anyway before the fix");
  assert.deepEqual(r.rows, [7], "so the row it would have deleted is still there");
  assert.equal(r.outcomes.length, 1, "and the refusal is journaled rather than silent");
  assert.equal(r.outcomes[0]!.outcome, "failed");
  assert.match(r.outcomes[0]!.reason, /db\.undo/, `the reason names the capability: ${r.outcomes[0]!.reason}`);
});

test("THE CONTROL: the same path refuses for the ordinary reason too, so the arm above is not some other guard", async () => {
  // `db.undo` absent from the CHILD GRAPH's own list. The allowlist forbids it with or without
  // the re-seed, so this arm must read identically on both trees — and it did.
  const r = await arm(["db.write"]);

  assert.deepEqual(r.undone, []);
  assert.deepEqual(r.rows, [7]);
  assert.equal(r.outcomes[0]?.outcome, "failed");
  assert.match(r.outcomes[0]!.reason, /db\.undo/);
});

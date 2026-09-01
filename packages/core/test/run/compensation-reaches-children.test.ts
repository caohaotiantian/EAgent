/**
 * A ROLLBACK THAT STOPS AT THE RUN BOUNDARY IS NOT A ROLLBACK.
 *
 * `Engine.#compensate` reads ONE journal. `subgraph.started` is the only link between a parent's
 * journal and a child's — that is what keeps a parent's journal the size of the parent rather
 * than of its whole tree — so an effect performed inside a delegated run was never undone. The
 * same tool, in the same position, behaved two ways:
 *
 *     db.insert DIRECTLY in the parent   the failed run deleted the row
 *     the same call via a subgraph       the row stood, and nothing said so
 *
 * `#uncompensatedIrreversible` already follows `subgraph.started` for the REWIND REFUSAL, which
 * is the sibling consumer of the same blindness — so "we refuse to undo past a child's charge"
 * held while "we undo a child's charge" did not.
 *
 * The second half of this file is the other end of the same gap: `#finish` had three
 * `run.failed` exits and only one of them rolled anything back.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import type { RunId, Seq } from "../../src/ids.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";

const NOW = 1_700_000_000_000;

interface World {
  readonly rows: number[];
  /** Every undo, in the order performed. The ORDER claim is judged on this. */
  readonly undone: number[];
}

const INSERT: ToolManifestLite = {
  name: "db.insert",
  version: "1.0",
  capabilities: [],
  irreversibility: "reversible_write",
  idempotent: true,
  compensation: { tool: "db.delete" },
};
const DELETE: ToolManifestLite = {
  name: "db.delete",
  version: "1.0",
  capabilities: [],
  irreversibility: "reversible_write",
  idempotent: true,
};
/** Mutates and declares an undo, but writes NOTHING to a channel — the `E_OUTPUT_MISSING` shape. */
const QUIET: ToolManifestLite = {
  name: "db.insert.quiet",
  version: "1.0",
  capabilities: [],
  irreversibility: "reversible_write",
  idempotent: true,
  compensation: { tool: "db.delete" },
};
const BOOM: ToolManifestLite = {
  name: "boom",
  version: "1.0",
  capabilities: [],
  irreversibility: "read_only",
  idempotent: true,
};
const MANIFESTS: Record<string, ToolManifestLite> = {
  "db.insert": INSERT,
  "db.insert.quiet": QUIET,
  "db.delete": DELETE,
  boom: BOOM,
};

function rig(): { engine: Engine; world: World; store: MemoryStateStore; resolver: ResourceResolver } {
  const world: World = { rows: [], undone: [] };
  const tools = new ToolRegistry();

  tools.register({
    ...INSERT,
    description: "insert a row",
    parameters: { type: "object", properties: { row: { type: "number" } }, required: ["row"] },
    execute: (args) => {
      const row = Number(args["row"]);
      world.rows.push(row);
      // `details` is the only channel an undo's arguments can come from — `tool.called` carries
      // a shape and a digest, never values.
      return { content: `inserted ${String(row)}`, details: { row }, writes: { out: { row } } };
    },
  } as ToolDefinition);

  tools.register({
    ...DELETE,
    description: "the compensation for db.insert",
    parameters: { type: "object", properties: { row: { type: "number" } }, required: ["row"] },
    execute: (args) => {
      const row = Number(args["row"]);
      world.undone.push(row);
      const at = world.rows.indexOf(row);
      if (at >= 0) world.rows.splice(at, 1);
      return { content: `deleted ${String(row)}` };
    },
  } as ToolDefinition);

  tools.register({
    ...QUIET,
    description: "insert a row and write no channel",
    parameters: { type: "object", properties: { row: { type: "number" } }, required: ["row"] },
    execute: (args) => {
      const row = Number(args["row"]);
      world.rows.push(row);
      return { content: `inserted ${String(row)}`, details: { row } };
    },
  } as ToolDefinition);

  tools.register({
    ...BOOM,
    description: "always fails",
    parameters: { type: "object" },
    execute: () => {
      throw Object.assign(new Error("boom"), {
        code: "E_PROVIDER_UNAVAILABLE",
        class: "unavailable",
        retryable: false,
      });
    },
  } as ToolDefinition);

  const resolver: ResourceResolver = {
    resolve: (ref) =>
      /^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref)
        ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" }
        : undefined,
    subgraph: (ref) => (ref === "graph/child@stable" ? childSpec() : ref === "graph/grandchild@stable" ? grandchildSpec() : undefined),
  };

  const store = new MemoryStateStore({ now: () => NOW });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    resolver,
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 10 } },
  });
  return { engine, world, store, resolver };
}

const toolNode = (id: string, name: string, args: Record<string, unknown>, writes: string[] = ["out"]): unknown => ({
  id,
  type: "tool",
  reads: ["seed"],
  writes,
  tool: { name, version: "1.0", args },
  retry: { maxAttempts: 1 },
});

/** The grandchild inserts row 9 — proof the descent is recursive, not one level. */
function grandchildSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "grandchild", project: "comp", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { seed: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: ["seed"],
    outputs: ["out"],
    nodes: [toolNode("gins", "db.insert", { row: 9 })],
    edges: [],
  } as unknown as GraphSpec;
}

/** The child inserts row 7, then delegates again. */
function childSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "child", project: "comp", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { seed: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: ["seed"],
    outputs: ["out"],
    nodes: [
      toolNode("cins", "db.insert", { row: 7 }),
      {
        id: "deep",
        type: "subgraph",
        reads: ["seed"],
        writes: ["out"],
        subgraph: { ref: "graph/grandchild@stable", inputs: { seed: "seed" }, outputs: { out: "out" } },
      },
    ],
    edges: [{ id: "cd", from: "cins", to: "deep", kind: "seq" }],
  } as unknown as GraphSpec;
}

/** `ins1 → delegate → ins2 → bad`: the child's work sits BETWEEN two of the parent's own calls. */
function parentSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "rollback-tree", project: "comp", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 32, maxDepth: 3, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { seed: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: ["seed"],
    outputs: ["out"],
    nodes: [
      toolNode("ins1", "db.insert", { row: 1 }),
      {
        id: "delegate",
        type: "subgraph",
        reads: ["seed"],
        writes: ["out"],
        subgraph: { ref: "graph/child@stable", inputs: { seed: "seed" }, outputs: { out: "out" } },
      },
      toolNode("ins2", "db.insert", { row: 2 }),
      toolNode("bad", "boom", {}),
    ],
    edges: [
      { id: "e1", from: "ins1", to: "delegate", kind: "seq" },
      { id: "e2", from: "delegate", to: "ins2", kind: "seq" },
      { id: "e3", from: "ins2", to: "bad", kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

async function drive(spec: GraphSpec): Promise<{ world: World; status: string; store: MemoryStateStore; runId: RunId }> {
  const r = rig();
  const graph = compileOrThrow({ spec, resolver: r.resolver, tools: MANIFESTS, tenantCapabilities: [] });
  const runId = await r.engine.submit({ graph, inputs: { seed: "x" } });
  let status = "running";
  for (let i = 0; i < 40; i++) {
    const p = await r.engine.advance(runId);
    status = p.status;
    if (p.status === "succeeded" || p.status === "failed") break;
  }
  return { world: r.world, status, store: r.store, runId };
}

async function eventsOf(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const e of store.read(runId, 1 as Seq)) out.push(e);
  return out;
}

test("A FAILED RUN UNDOES WHAT ITS CHILDREN DID, IN THE PARENT'S OWN ORDER", async () => {
  const { world, status, store, runId } = await drive(parentSpec());
  assert.equal(status, "failed", "the run must actually have failed — otherwise nothing is tested");

  // THE EFFECT. Rows 1 and 2 were the parent's, 7 the child's and 9 the grandchild's.
  assert.deepEqual(world.rows, [], "every undoable row anywhere in the tree must be gone");

  // THE ORDER, and this is the claim a "children last" implementation gets wrong. `seq` is a
  // total order only WITHIN a journal; what positions a whole child run inside the parent's
  // sequence is the parent's own `subgraph.started`. So the descent is spliced in at that seq,
  // reverse like everything else: row 2 (after the delegation), then the tree under it —
  // 9 before 7, because the grandchild ran last — then row 1.
  assert.deepEqual(world.undone, [2, 9, 7, 1], "reverse order across the whole tree, not parent-then-children");

  // AND IT IS RECORDED IN THE JOURNAL THAT PERFORMED IT. A child's rollback belongs in the
  // child's log: that is the journal an operator reads to find out what happened to that run,
  // and the parent's log is already deliberately not a copy of its tree.
  const childId = (await eventsOf(store, runId)).find((e) => e.type === "subgraph.started")!.payload.childRunId;
  const childRecs = (await eventsOf(store, childId)).filter((e) => e.type === "compensation.recorded");
  assert.equal(childRecs.length, 1, "the child's own journal carries the record of its own rollback");
  assert.equal((childRecs[0]!.payload as { outcome: string }).outcome, "compensated");
  assert.equal((childRecs[0]!.payload as { trigger: string }).trigger, "run_failed");

  // The parent's log records only the parent's own two.
  const parentRecs = (await eventsOf(store, runId)).filter((e) => e.type === "compensation.recorded");
  assert.deepEqual(
    parentRecs.map((e) => (e.payload as { tool: string }).tool),
    ["db.insert", "db.insert"],
    "and the parent's journal stays the size of the parent",
  );
});

/**
 * `ins1` inserts and writes nothing, so the conditional to the only node that writes `out` is
 * never taken — the `E_OUTPUT_MISSING` exit, with a real effect behind it.
 */
function outputMissingSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "no-output", project: "comp", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: {
      seed: { type: "string", reduce: "replace" },
      scratch: { type: "object", reduce: "replace" },
      out: { type: "object", reduce: "replace" },
    },
    inputs: ["seed"],
    outputs: ["out"],
    nodes: [
      toolNode("ins1", "db.insert.quiet", { row: 5 }, ["scratch"]),
      { ...(toolNode("writer", "db.insert", { row: 6 }) as object), reads: ["scratch"] },
    ],
    edges: [{ id: "w", from: "ins1", to: "writer", kind: "conditional", when: "seed == \"never\"" }],
  } as unknown as GraphSpec;
}

test("EVERY EXIT THAT FAILS THE RUN ROLLS IT BACK, NOT ONLY THE ONE WITH A FAILED TASK", async () => {
  // `#finish` had three `run.failed` appends and compensated on exactly one of them — the arm
  // that means "a node failed and nothing handled it". A run that fails `E_OUTPUT_MISSING` did
  // real work and is just as terminal, and its effects stood.
  const { world, status, store, runId } = await drive(outputMissingSpec());
  assert.equal(status, "failed", "a run that wrote none of its declared outputs fails");

  const events = await eventsOf(store, runId);
  const failure = events.find((e) => e.type === "run.failed");
  assert.equal(
    (failure!.payload as { error: { code: string } }).error.code,
    "E_OUTPUT_MISSING",
    "and it is THIS exit under test, not the failed-task one",
  );

  assert.deepEqual(world.undone, [5], "the row it inserted came back out");
  assert.deepEqual(world.rows, []);

  // Before `run.failed`, for the same reason the failed-task arm is: every entry point
  // short-circuits on a terminal run, so a rollback appended after it is work on a dead run.
  const rec = events.find((e) => e.type === "compensation.recorded");
  assert.equal(rec!.seq < failure!.seq, true, "the rollback lands before the terminal event");
});

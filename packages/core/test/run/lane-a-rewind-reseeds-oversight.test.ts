/**
 * A REWIND MOVES THE FOLD BACKWARDS, AND THE LIVE `PolicyEngine` HAS TO GO WITH IT.
 *
 * `#advanceSerially` re-seeds oversight, spend, promises and human ceilings from the journal
 * behind `ctx.policySeeded`, a flag set on the first advance and reset by NOTHING —
 * `#rewindSerially` included. `PolicyEngine.restore` was documented as making the journal
 * "authoritative in both directions" because it CLEARS `#ceilings` before folding them; that
 * holds at the instant `restore` runs, and `restore` ran once per attach.
 *
 * So a rewind past a `policy.deescalated` left the live object holding a ceiling the journal no
 * longer records. Measured: the live engine reported `succeeded` with 0 gates and ran the guarded
 * tool a second time, while a fresh engine over the same rewound journal reported `awaiting_gate`
 * with 1. That is fold != live — the class CLAUDE.md's first non-negotiable is about, and the
 * rewind is the one operation that can move a fold backwards under a live engine.
 *
 * THE FRESH ENGINE IS THE ORACLE, deliberately. Asserting "it gates" alone would pass on a build
 * that gates everything; the property is that the two answer the same, so both are taken and
 * compared.
 *
 * TWO JOURNALS, BUILT IDENTICALLY, RATHER THAN ONE READ TWICE, and that is a fact about the
 * measurement rather than about the defect. Both engines DRIVE the run — approving a gate appends
 * — so whichever went second would be answering a question the first had already changed. The
 * construction is deterministic (fixed clock, derived task and gate ids), so the two journals are
 * the same journal built twice; the assertions compare the two answers rather than trusting
 * either alone.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import type { NodeId, RunId, Seq } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import { rewindWithPlan } from "./operator.ts";

const n = (id: string): NodeId => id as NodeId;
const NOW = (): number => 1_700_000_000_000;
const HUMAN = { kind: "human" as const, id: "u:ops" };
const APPROVER = { kind: "human" as const, subject: "u:ops", via: "cli" as const };

const NOTE: ToolManifestLite = {
  name: "note.write",
  version: "1.0",
  capabilities: ["fs:write"],
  irreversibility: "reversible_write",
  idempotent: true,
};

const RESOLVER: ResourceResolver = {
  resolve: (ref) =>
    /^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref) ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" } : undefined,
};

/** A gate, then a node declared at `in` — so a human ceiling of `out` shows up as "it did not ask". */
function spec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "rewind-ceiling", project: "lane-a", version: 1 },
    policy: { posture: "out", capabilities: ["fs:write"] },
    channels: { go: { type: "object", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: [],
    outputs: ["out"],
    nodes: [
      { id: n("gate"), type: "human_gate", writes: ["go"], humanGate: { ref: "oversight/w@stable" } },
      {
        id: n("act"),
        type: "tool",
        reads: ["go"],
        writes: ["out"],
        policy: { posture: "in" },
        tool: { name: "note.write", version: "1.0", args: {} },
      },
    ],
    edges: [{ id: "g2a" as never, from: n("gate"), to: n("act"), kind: "seq" }],
  } as unknown as GraphSpec;
}

const graph = (): RunGraph =>
  compileOrThrow({ spec: spec(), resolver: RESOLVER, tools: { "note.write": NOTE }, tenantCapabilities: ["fs:write"] });

function engineOn(store: MemoryStateStore, wrote: number[]): Engine {
  const tools = new ToolRegistry();
  const def: ToolDefinition = {
    ...NOTE,
    description: "Write a note.",
    parameters: { type: "object", properties: {} },
    execute: () => {
      wrote.push(1);
      return { content: "ok", writes: { out: { ok: true } } };
    },
  };
  tools.register(def);
  return new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now: NOW,
    sleep: async () => {},
    policy: { granted: ["fs:write"], systemFloor: "out" },
  });
}

async function events(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) out.push(ev);
  return out;
}

/** Approve the one open gate. */
async function approve(engine: Engine, runId: RunId, key: string): Promise<{ status: string; gates: number }> {
  const open = await engine.openGates(runId);
  assert.equal(open.length, 1, `expected one open gate, saw ${JSON.stringify(open.map((g) => g.nodeId))}`);
  const p = await engine.resolveGate(runId, {
    gateId: open[0]!.gateId,
    decision: { kind: "approve" },
    actor: APPROVER,
    idempotencyKey: key,
  });
  return { status: p.status, gates: Object.values(p.gates).filter((g) => g.state === "open").length };
}

/**
 * Run to completion under a human ceiling of `out`, then rewind to just below the
 * `policy.deescalated` that granted it. Returns the store and the engine that did the rewind.
 */
async function toRewoundState(): Promise<{
  readonly store: MemoryStateStore;
  readonly live: Engine;
  readonly runId: RunId;
  readonly wrote: number[];
}> {
  const store = new MemoryStateStore({ now: NOW });
  const wrote: number[] = [];
  const live = engineOn(store, wrote);
  const runId = await live.submit({ graph: graph(), inputs: {} });
  assert.equal((await live.advance(runId)).status, "awaiting_gate");

  await live.deescalate(runId, `run:${runId}`, "out", "let it run", HUMAN);
  const done = await approve(live, runId, "k1");
  assert.equal(done.status, "succeeded", "precondition: the lowered ceiling let the guarded node through");
  assert.equal(wrote.length, 1, "precondition: and the guarded node really did run");

  const log = await events(store, runId);
  const at = log.findIndex((ev) => ev.type === "policy.deescalated");
  assert.ok(at > 0, `the fixture must contain a de-escalation: ${log.map((ev) => ev.type).join(",")}`);
  await rewindWithPlan(live, runId, log[at]!.seq - 1 as Seq, "the ceiling was granted in error");

  const rewound = (await live.projection(runId))!;
  assert.deepEqual(rewound.ceilings, {}, "precondition: the fold no longer carries the ceiling");
  return { store, live, runId, wrote };
}

test("A REWIND PAST A DE-ESCALATION PUTS THE CEILING BACK, IN THE LIVE ENGINE AS WELL AS THE FOLD", async () => {
  // TWO JOURNALS, NOT ONE, and it has to be two: both engines DRIVE the run, so sharing a store
  // would mean the second answered a question the first had already changed. The construction is
  // deterministic — fixed clock, derived task and gate ids — so the two journals are the same
  // journal, built twice.
  const forCold = await toRewoundState();
  const coldWrote: number[] = [];
  const cold = engineOn(forCold.store, coldWrote);
  cold.attach(forCold.runId, graph());
  await cold.rehydrateGates(forCold.runId);
  const coldAnswer = await approve(cold, forCold.runId, "k2");
  assert.equal(coldAnswer.status, "awaiting_gate", "the fold's own answer: with no ceiling, the guarded node asks");
  assert.equal(coldAnswer.gates, 1);
  assert.equal(coldWrote.length, 0, "and it has not run");

  // AND THE LIVE ENGINE MUST AGREE. Before `#rewindSerially` cleared `ctx.policySeeded` it did
  // not: it still held `out` from before the rewind, so it ran the guarded tool a second time
  // and reported `succeeded` with zero gates.
  const forLive = await toRewoundState();
  const liveAnswer = await approve(forLive.live, forLive.runId, "k2");
  assert.equal(liveAnswer.status, coldAnswer.status, "fold and live must answer the same question the same way");
  assert.equal(liveAnswer.gates, coldAnswer.gates);
  assert.equal(forLive.wrote.length, 1, "the guarded node must not have run a second time under a ceiling that was rewound away");
});

test("…and the ORDINARY rewind is untouched: with no ceiling to lose, the run still replays and finishes", async () => {
  // THE CONTROL. Re-seeding on every rewind must not break the rewinds that had nothing to
  // re-seed — and `restore` folds spend and promises by MAX, so a re-seed must not refund
  // either. Same graph, no de-escalation: an ordinary gate, an ordinary approval, a rewind.
  const store = new MemoryStateStore({ now: NOW });
  const wrote: number[] = [];
  const live = engineOn(store, wrote);
  const runId = await live.submit({ graph: graph(), inputs: {} });
  assert.equal((await live.advance(runId)).status, "awaiting_gate");

  // The gate node's own gate, then the guarded node's — two approvals to finish.
  assert.equal((await approve(live, runId, "a1")).status, "awaiting_gate", "the `in` node raises its own gate");
  assert.equal((await approve(live, runId, "a2")).status, "succeeded");
  assert.equal(wrote.length, 1);

  // Back to just before the guarded node's gate was raised, so the run has to ask again.
  const log = await events(store, runId);
  const raises = log.filter((ev) => ev.type === "gate.raised");
  assert.equal(raises.length, 2, `the fixture must raise two gates: ${log.map((ev) => ev.type).join(",")}`);
  const rewound = await rewindWithPlan(live, runId, (raises[1]!.seq - 1) as Seq, "re-run the guarded step");
  assert.ok(!["succeeded", "failed"].includes(rewound.status), `a rewound run is live again, saw ${rewound.status}`);

  const again = await live.advance(runId);
  assert.equal(again.status, "awaiting_gate", "it asks again, which is what the ceiling being absent means");
  const finished = await approve(live, runId, "b1");
  assert.equal(finished.status, "succeeded", JSON.stringify(finished));
  assert.equal(wrote.length, 2, "the guarded node ran again, which is what a rewind is for");
});

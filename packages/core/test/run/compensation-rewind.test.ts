/**
 * A REWIND HID THE RECORD AND LEFT THE EFFECT STANDING.
 *
 * `Engine.rewind` appends a `checkpoint.restored` marker and the fold hides `(atSeq, marker)`.
 * That is a claim about the JOURNAL, and the world was never consulted: the one place
 * compensation reached the runtime was the refusal to cross an uncompensated `irreversible` or
 * `externally_visible` effect, which leaves `reversible_write` — the class whose whole definition
 * is "mutates state Loom can undo via a declared compensation" — crossed silently, with the file
 * still written. `fs.write` has declared `fs.restore` for exactly this since it was written and
 * nothing ever called it.
 *
 * Judged by EFFECT: what the fake world holds after the rewind, in what order it was unwound,
 * and what the journal says about each step.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import type { RunId, Seq } from "../../src/ids.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import { OPERATOR } from "./operator.ts";
import { resolver } from "./skeleton.ts";

const NOW = 1_700_000_000_000;

interface World {
  readonly rows: number[];
  readonly undone: number[];
}

function engineOn(store: MemoryStateStore, world: World): Engine {
  const tools = new ToolRegistry();
  tools.register({
    name: "db.insert",
    version: "1.0",
    description: "insert a row",
    capabilities: [],
    irreversibility: "reversible_write",
    idempotent: true,
    compensation: { tool: "db.delete" },
    parameters: { type: "object", properties: { row: { type: "number" } }, required: ["row"] },
    execute: (args) => {
      const row = Number(args["row"]);
      world.rows.push(row);
      return { content: `inserted ${String(row)}`, details: { row }, writes: { out: { row } } };
    },
  } as ToolDefinition);
  tools.register({
    name: "db.delete",
    version: "1.0",
    description: "the compensation for db.insert",
    capabilities: [],
    irreversibility: "reversible_write",
    idempotent: true,
    parameters: { type: "object", properties: { row: { type: "number" } }, required: ["row"] },
    execute: (args) => {
      const row = Number(args["row"]);
      world.undone.push(row);
      const at = world.rows.indexOf(row);
      if (at >= 0) world.rows.splice(at, 1);
      return { content: `deleted ${String(row)}` };
    },
  } as ToolDefinition);
  // Mutates, and declares no undo. The third state exists for this tool.
  tools.register({
    name: "note.append",
    version: "1.0",
    description: "append to a log nothing can undo",
    capabilities: [],
    irreversibility: "reversible_write",
    idempotent: true,
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: () => ({ content: "noted", writes: { out: { noted: true } } }),
  } as ToolDefinition);
  return new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 1 } },
  });
}

/** `ins1 → ins2`, both succeed. Nothing here fails; the rewind is what undoes them. */
function spec(): GraphSpec {
  const node = (id: string, row: number): unknown => ({
    id,
    type: "tool",
    reads: ["seed"],
    writes: ["out"],
    tool: { name: "db.insert", version: "1.0", args: { row } },
    retry: { maxAttempts: 1 },
  });
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "rewind-rollback", project: "comp", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { seed: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: ["seed"],
    outputs: ["out"],
    nodes: [node("ins1", 1), node("ins2", 2)],
    edges: [{ id: "e1", from: "ins1", to: "ins2", kind: "seq" }],
  } as unknown as GraphSpec;
}

async function journal(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const e of store.read(runId, 1 as Seq)) out.push(e);
  return out;
}

/** Run `ins1 → ins2` to completion and hand back everything a rewind needs. */
async function ran(): Promise<{
  store: MemoryStateStore;
  engine: Engine;
  world: World;
  runId: RunId;
  graph: RunGraph;
  /** The seq immediately before the first insert's effect — the boundary that hides both. */
  before: Seq;
}> {
  const store = new MemoryStateStore({ now: () => NOW });
  const world: World = { rows: [], undone: [] };
  const engine = engineOn(store, world);
  const graph = compileOrThrow({ spec: spec(), resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { seed: "x" } });
  for (let i = 0; i < 10; i++) {
    const p = await engine.advance(runId);
    if (p.status === "succeeded" || p.status === "failed") break;
  }
  assert.deepEqual(world.rows, [1, 2], "the run must actually have written both rows");

  const evs = await journal(store, runId);
  const firstCall = evs.find((e) => e.type === "tool.called");
  assert.notEqual(firstCall, undefined, "there is a recorded call to rewind past");
  return { store, engine, world, runId, graph, before: (firstCall!.seq - 2) as Seq };
}

test("A REWIND UNDOES THE EFFECTS IT HIDES, LAST FIRST", async () => {
  const r = await ran();
  await r.engine.rewind(r.runId, r.before, "operator asked to redo from the top", OPERATOR);

  assert.deepEqual(r.world.rows, [], "the rows the rewind hid are gone from the world, not merely from the fold");
  assert.deepEqual(r.world.undone, [2, 1], "reverse order — the last thing done is the first undone");

  const evs = await journal(r.store, r.runId);
  const recs = evs.filter((e) => e.type === "compensation.recorded");
  assert.deepEqual(
    recs.map((e) => (e.payload as { outcome: string; trigger: string }).trigger),
    ["rewind", "rewind"],
    "and the records say a rewind is what asked for them, not a failure",
  );
  assert.deepEqual(
    recs.map((e) => (e.payload as { outcome: string }).outcome),
    ["compensated", "compensated"],
  );

  // BEFORE THE MARKER, and the crash cases are the argument. Undo-then-mark that dies in between
  // leaves a journal that is not rewound and a world partly unwound, and the operator's second
  // rewind finishes the job. Mark-then-undo that dies in between leaves a journal claiming the
  // rewind happened over a world that still holds every effect, and nothing comes back for it.
  const marker = evs.find((e) => e.type === "checkpoint.restored");
  assert.notEqual(marker, undefined, "the rewind marker was appended");
  for (const rec of recs) {
    assert.equal(rec.seq < marker!.seq, true, "every undo is recorded before the marker that claims the rewind");
  }
});

test("A SECOND REWIND TO THE SAME BOUNDARY DOES NOT UNDO ANYTHING TWICE", async () => {
  const r = await ran();
  await r.engine.rewind(r.runId, r.before, "first", OPERATOR);
  assert.deepEqual(r.world.undone, [2, 1]);

  // A rewind can itself be retried — an operator repeats it, or a process died partway and the
  // resumed one re-plans. `compensation.recorded` is keyed by the SEQ of the call it undoes, so
  // the journal is what remembers: a flag on the engine would survive this and not a restart.
  await r.engine.rewind(r.runId, r.before, "again", OPERATOR);
  assert.deepEqual(r.world.undone, [2, 1], "the second rewind found both calls already settled");
});

test("AN EFFECT NOTHING CAN UNDO IS STILL RECORDED, EVEN WHEN NO STEP DISPATCHES", async () => {
  // The path this covers had the three states collapsing back to two on rewind, and only on
  // rewind: the rollback was gated on there being something ATTEMPTABLE, so a run whose only
  // effect was un-undoable ran no rollback and journaled nothing. "This write stands and nobody
  // tried to undo it" is exactly the sentence an operator needs before they decide what the
  // rewind actually bought them, and it is the sentence a dispatch-gated rollback deletes.
  const store = new MemoryStateStore({ now: () => NOW });
  const world: World = { rows: [], undone: [] };
  const engine = engineOn(store, world);
  const only: unknown = {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "rewind-nothing-to-undo", project: "comp", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { seed: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: ["seed"],
    outputs: ["out"],
    nodes: [
      {
        id: "note",
        type: "tool",
        reads: ["seed"],
        writes: ["out"],
        tool: { name: "note.append", version: "1.0", args: { text: "cannot be undone" } },
        retry: { maxAttempts: 1 },
      },
    ],
    edges: [],
  };
  const graph = compileOrThrow({ spec: only as GraphSpec, resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { seed: "x" } });
  for (let i = 0; i < 6; i++) {
    const p = await engine.advance(runId);
    if (p.status === "succeeded" || p.status === "failed") break;
  }
  const evs = await journal(store, runId);
  const call = evs.find((e) => e.type === "tool.called");
  assert.notEqual(call, undefined, "the note really was written");

  await engine.rewind(runId, (call!.seq - 2) as Seq, "undo it if you can", OPERATOR);

  const recs = (await journal(store, runId)).filter((e) => e.type === "compensation.recorded");
  assert.equal(recs.length, 1, "one recorded call, one decision about it");
  const p = recs[0]!.payload as { outcome: string; reason?: string; undo?: string; trigger: string };
  assert.equal(p.outcome, "not_attempted");
  assert.equal(p.trigger, "rewind");
  assert.equal(p.undo, undefined, "there is no undo tool to name");
  assert.match(p.reason ?? "", /declares no compensation/, "and the record says so, rather than saying nothing");
});

test("A DETACHED RUN IS REFUSED RATHER THAN CROSSED", async () => {
  const r = await ran();

  // A fresh engine on the same store: it can read the journal, and the journal does not contain
  // the graph — only its hash — so nothing here can dispatch `db.delete`. Rewinding anyway would
  // hide the record and leave the rows standing, which is the exact loosening this whole change
  // exists to close. `rewind` is documented as working with no context precisely so a FINISHED
  // run stays rewindable, so this refusal is a narrowing of that door and says how to open it.
  // Bound to the SAME world: a different process shares the database, not a copy of it.
  const cold = engineOn(r.store, r.world);
  await assert.rejects(
    () => cold.rewind(r.runId, r.before, "from a process that never ran it", OPERATOR),
    (e: Error) => {
      assert.match(e.message, /holds no context/, "the message names the reason");
      assert.match(e.message, /attach\(runId, graph\)/, "and the fix");
      assert.match(e.message, /db\.insert -> db\.delete/, "and what would have gone un-undone");
      return true;
    },
  );
  assert.deepEqual(r.world.rows, [1, 2], "and it undid nothing on the way to refusing");

  // ATTACHED, THE SAME CALL WORKS. The refusal is about a missing capability, not a policy — so
  // it must lift the moment the capability is there, or it is a wall rather than a door.
  cold.attach(r.runId, r.graph);
  await cold.rewind(r.runId, r.before, "now it can", OPERATOR);
  assert.deepEqual(r.world.rows, [], "attach, then rewind, and the effects really are undone");
});

test("ONLY A HUMAN MAY REWIND, WHETHER OR NOT THERE IS ANYTHING TO UNDO", async () => {
  // `b90b137`'s fifth decision — cited by commit because `TODO.md` called it "§D.5" and §D has
  // since been renumbered — says rewind-compensation must be "loud, gated by the same oversight
  // floor an irreversible action gets, and never silent", and an irreversible action at `in`
  // requires a person. The floor did not exist: `by` defaulted to `SYSTEM_ACTOR("operator")` and
  // was checked nowhere, so — measured on this rig before the check — `rewind(runId, before, reason)` with no
  // fourth argument at all returned `queued`, dispatched both `db.delete` calls, and journaled
  // the marker as `system:operator`. This file is where it belongs because the dispatch is the
  // reason: a rewind is the one operator command that reaches out and changes the world.
  const r = await ran();
  const service = { kind: "system", component: "principal:svc:deployer" } as const;

  const refused = (e: unknown): true => {
    assert.ok(isLoomError(e), String(e));
    assert.equal(e.code, CODES.E_HUMAN_APPROVAL_REQUIRED, e.message);
    // Both ways out are named, because over HTTP this refusal is a 403 where a service token
    // used to get a 200, and an operator meets it with a run half-finished in front of them.
    assert.match(e.message, /Authenticate as a person/, "the message says how to become allowed");
    assert.match(e.message, /use cancel/, "and what still works for the caller it just refused");
    return true;
  };

  await assert.rejects(() => r.engine.rewind(r.runId, r.before, "a service token asked", service as never), refused);
  // REFUSING UNDOES NOTHING, which is the same rule the `E_RESTORE_ILLEGAL` refusals above hold
  // to: unwinding half a run and then declining to rewind it leaves the operator worse off than
  // either answer alone. That is why the actor is the FIRST check and not the last.
  assert.deepEqual(r.world.rows, [1, 2], "the refused rewind left the world exactly as it found it");
  assert.deepEqual(r.world.undone, []);
  const after = await journal(r.store, r.runId);
  assert.equal(after.filter((e) => e.type === "checkpoint.restored").length, 0, "and wrote no marker");
  assert.equal(after.filter((e) => e.type === "compensation.recorded").length, 0, "and no rollback record");

  // AND THE SAME REFUSAL WITH NOTHING TO UNDO. The boundary here is the journal's own head, so
  // the range `(atSeq, marker)` is empty and there is not one compensable effect inside it. The
  // rule does not consult that, deliberately: `plannedUndo` is computed after four refusals and a
  // full journal read, so a caller cannot know whether their rewind has undos until it has
  // already run, and a rule conditioned on it is a rule nobody can follow.
  const head = after[after.length - 1]!.seq;
  await assert.rejects(() => r.engine.rewind(r.runId, head, "and nothing to undo", service as never), refused);

  // THE CONTROL, and it is the whole argument: the only thing wrong with the call above is who
  // made it. The same empty-range rewind from a person is taken, marker and all.
  await r.engine.rewind(r.runId, head, "a person asked for the same thing", OPERATOR);
  const marks = (await journal(r.store, r.runId)).filter((e) => e.type === "checkpoint.restored");
  assert.equal(marks.length, 1, "exactly the human's rewind is on the record");
  assert.equal(marks[0]!.actor.kind, "human");
  assert.equal((marks[0]!.actor as { subject?: string }).subject, "u:alice");
  assert.deepEqual(r.world.undone, [], "and it undid nothing, because its range held nothing");
});

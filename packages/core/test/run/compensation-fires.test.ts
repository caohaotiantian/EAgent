/**
 * COMPENSATION WAS A COMPILE-TIME FEATURE WITH NO RUN TIME.
 *
 * `graph/validate.ts` proves a rollback exists — GRAPH012 refuses a compensation edge whose
 * target tool declares no `compensation`, refuses one naming an unregistered undo, and warns
 * when the undo is itself externally visible — and `Engine.#edgesToTake` had
 * `case "compensation": break;`, so nothing ever traversed one. The single place compensation
 * reached the runtime was a REFUSAL: `Engine.rewind` declines to cross a committed irreversible
 * effect that declares no undo. The shipped feature was "we refuse because you have no
 * compensation" and never "we ran your compensation".
 *
 * This drives a real run to failure with two undoable writes and one that nothing can undo, and
 * asserts by EFFECT: what the fake world holds afterwards, in what order it was unwound, and
 * which of the three journal states each recorded call ended in.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import type { Seq } from "../../src/ids.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";
import { planCompensation } from "../../src/run/compensation.ts";

const NOW = 1_700_000_000_000;

interface World {
  /** Rows the run inserted and has not deleted. The thing a rollback is judged on. */
  readonly rows: number[];
  /** Every undo, in the order it was performed. The ORDER claim is judged on this. */
  readonly undone: number[];
  /** The append-only log nothing can undo. */
  readonly notes: string[];
}

/**
 * Four tools, and the differences between them are the whole fixture.
 *
 * `db.insert` declares an undo and RECORDS the argument that undo needs in `details` — the
 * `fs.write`/`fs.restore` handshake, which is the only place a compensation's arguments can come
 * from: `tool.called` carries `argsShape` and `argsDigest`, a shape and a digest, never values.
 * `note.append` mutates and declares no undo, which is the third state. `boom` throws.
 */
function rig(): { engine: Engine; tools: ToolRegistry; world: World; store: MemoryStateStore } {
  const world: World = { rows: [], undone: [], notes: [] };
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
      // The undo record. `details` is documented as "for renderers and telemetry, never sent to
      // the model", which is exactly what an undo argument is — and it is what reaches the
      // journal on `effect.completed`.
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

  tools.register({
    name: "note.append",
    version: "1.0",
    description: "append to a log nothing can undo",
    capabilities: [],
    irreversibility: "reversible_write",
    idempotent: true,
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: (args) => {
      world.notes.push(String(args["text"]));
      return { content: "noted", writes: { out: { noted: true } } };
    },
  } as ToolDefinition);

  tools.register({
    name: "boom",
    version: "1.0",
    description: "always fails",
    capabilities: [],
    irreversibility: "read_only",
    idempotent: true,
    parameters: { type: "object" },
    execute: () => {
      throw Object.assign(new Error("boom"), { code: "E_PROVIDER_UNAVAILABLE", class: "unavailable", retryable: false });
    },
  } as ToolDefinition);

  const store = new MemoryStateStore({ now: () => NOW });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 1 } },
  });
  return { engine, tools, world, store };
}

/** `ins1 → ins2 → note → boom`, four tool nodes in a line, no error edge anywhere. */
function spec(): GraphSpec {
  const node = (id: string, name: string, args: Record<string, unknown>): unknown => ({
    id,
    type: "tool",
    reads: ["seed"],
    writes: ["out"],
    tool: { name, version: "1.0", args },
    retry: { maxAttempts: 1 },
  });
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "rollback", project: "comp", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { seed: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: ["seed"],
    outputs: ["out"],
    nodes: [
      node("ins1", "db.insert", { row: 1 }),
      node("ins2", "db.insert", { row: 2 }),
      node("note", "note.append", { text: "cannot be undone" }),
      node("bad", "boom", {}),
    ],
    edges: [
      { id: "e1", from: "ins1", to: "ins2", kind: "seq" },
      { id: "e2", from: "ins2", to: "note", kind: "seq" },
      { id: "e3", from: "note", to: "bad", kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

async function drive(): Promise<{ world: World; events: JournalEvent[]; status: string; engine: Engine }> {
  const r = rig();
  const graph = compileOrThrow({ spec: spec(), resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await r.engine.submit({ graph, inputs: { seed: "x" } });
  let status = "running";
  for (let i = 0; i < 12; i++) {
    const p = await r.engine.advance(runId);
    status = p.status;
    if (p.status === "succeeded" || p.status === "failed") break;
  }
  const events: JournalEvent[] = [];
  for await (const e of r.store.read(runId, 1 as Seq)) events.push(e);
  return { world: r.world, events, status, engine: r.engine };
}

function records(events: readonly JournalEvent[]): {
  tool: string;
  outcome: string;
  undo?: string;
  reason?: string;
  trigger: string;
}[] {
  return events
    .filter((e) => e.type === "compensation.recorded")
    .map((e) => {
      const p = e.payload as {
        tool: string;
        outcome: string;
        undo?: string;
        reason?: string;
        trigger: string;
      };
      return p;
    });
}

test("A FAILED RUN UNDOES WHAT IT DID, LAST FIRST", async () => {
  const { world, events, status } = await drive();

  assert.equal(status, "failed", "the run must actually have failed — otherwise nothing is being tested");

  // THE EFFECT, not the journal. Both rows went in and both came back out.
  assert.deepEqual(world.rows, [], "every undoable row the run inserted must be gone");

  // THE ORDER. `db.insert` ran for row 1 then row 2, so the rollback must run 2 then 1: the
  // last thing done is the first undone. A forward-order rollback would read [1, 2] here.
  assert.deepEqual(world.undone, [2, 1], "reverse order of the calls that made the effects");

  // AND THE ONE THAT CANNOT BE UNDONE IS STILL THERE. A rollback that quietly dropped it would
  // leave the world in exactly this state and report a clean one.
  assert.deepEqual(world.notes, ["cannot be undone"], "note.append declares no compensation, so it stands");

  const recs = records(events);
  assert.deepEqual(
    recs.map((r) => [r.tool, r.outcome]),
    [
      ["note.append", "not_attempted"],
      ["db.insert", "compensated"],
      ["db.insert", "compensated"],
    ],
    "one record per non-read_only call, in rollback order, with the three states distinguished",
  );
  assert.equal(recs.every((r) => r.trigger === "run_failed"), true, "every record says what triggered it");

  // THE THIRD STATE SAYS WHY. `not_attempted` with no reason is `failed` with better manners.
  assert.match(recs[0]!.reason ?? "", /declares no compensation/, "the un-undoable one names its reason");
  assert.equal(recs[0]!.undo, undefined, "and names no undo tool, because there is none");
  assert.equal(recs[1]!.undo, "db.delete", "an attempted one names the tool that ran");
});

test("THE ROLLBACK LANDS BEFORE `run.failed`, WHICH IS TERMINAL", async () => {
  const { events } = await drive();
  const failedAt = events.find((e) => e.type === "run.failed")?.seq;
  assert.notEqual(failedAt, undefined, "the run failed");
  const recs = events.filter((e) => e.type === "compensation.recorded");
  assert.equal(recs.length, 3, "three recorded calls needed a decision");
  for (const r of recs) {
    assert.equal(
      r.seq < failedAt!,
      true,
      `compensation.recorded at seq ${String(r.seq)} must precede run.failed at ${String(failedAt)} — ` +
        "every entry point short-circuits on a terminal run, so a rollback appended after it is work on a dead run",
    );
  }
});

test("THE UNDO IS A REAL TOOL DISPATCH, WITH ITS OWN EFFECT RECORD UNDER A DERIVED KEY", async () => {
  const { events } = await drive();

  // Not a side channel. The undo went through `#invokeTool`, so it is journaled exactly like
  // any other call — which is what makes "a compensation passes through oversight" checkable
  // rather than asserted.
  const undoCalls = events.filter((e) => e.type === "tool.called" && (e.payload as { name: string }).name === "db.delete");
  assert.equal(undoCalls.length, 2, "two undos, two `tool.called` rows");

  const keys = undoCalls.map((e) => (e.payload as { key: string }).key);
  assert.equal(new Set(keys).size, 2, "distinct keys — a shared key would let serve-by-key hand one the other's result");
  for (const k of keys) {
    assert.match(k, /:compensate:\d+$/, "keyed in the `compensate` namespace, not the positional `tool` one");
  }

  // `effect.started.kind` must agree with the kind inside the key — `journal/audit.ts`'s
  // `effect.kind-matches-its-key`. Two of four sites had drifted once already.
  const startedKinds = events
    .filter((e) => e.type === "effect.started" && keys.includes((e.payload as { key: string }).key))
    .map((e) => (e.payload as { kind: string }).kind);
  assert.deepEqual(startedKinds, ["compensate", "compensate"], "the declared kind matches the key");
});

test("A COMPENSATION IS NOT RUN TWICE — THE JOURNAL, NOT A FLAG, IS WHAT REMEMBERS", async () => {
  // `advance` is re-entrant and an operator can call it again on a finished run. If idempotence
  // lived in a variable on the engine, a second pass would delete the rows a second time; if it
  // lived on the effect key alone it would survive this but not a rewind-then-redo, which is why
  // `compensation.recorded` is keyed by the SEQ of the call it undoes.
  const r = rig();
  const graph = compileOrThrow({ spec: spec(), resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await r.engine.submit({ graph, inputs: { seed: "x" } });
  for (let i = 0; i < 12; i++) {
    const p = await r.engine.advance(runId);
    if (p.status === "succeeded" || p.status === "failed") break;
  }
  assert.deepEqual(r.world.undone, [2, 1], "the first pass rolled back");

  await r.engine.advance(runId);
  await r.engine.advance(runId);
  assert.deepEqual(r.world.undone, [2, 1], "and a second and third `advance` must not undo anything again");
});

test("A ROLLBACK RESUMED AFTER A CRASH DOES NOT UNDO ITS OWN UNDOS", () => {
  // `planCompensation` walked every non-`read_only` `tool.called` — including the ones a
  // compensation dispatch writes for itself. It does not bite on the first pass, where the undo
  // lands after the plan was built. It bites on a RESUMED rollback: a crash between two steps
  // means the next plan reads a journal that already contains them, and an undo tool is
  // irreversible about as often as the tool it reverses. So the refund got refunded.
  const tools = new ToolRegistry();
  const charge: ToolDefinition = {
    name: "pay.charge", version: "1.0", description: "take money", capabilities: ["pay"],
    irreversibility: "irreversible", idempotent: false, parameters: { type: "object", properties: {} },
    compensation: { tool: "pay.refund" }, execute: () => ({ content: "ok" }),
  };
  const refund: ToolDefinition = {
    name: "pay.refund", version: "1.0", description: "give it back", capabilities: ["pay"],
    // IRREVERSIBLE ON PURPOSE — a refund is not read-only, which is exactly why the old filter
    // picked it up. A test whose undo were `read_only` would pass without the fix.
    irreversibility: "irreversible", idempotent: false, parameters: { type: "object", properties: {} },
    execute: () => ({ content: "ok" }),
  };
  tools.register(charge);
  tools.register(refund);

  const called = (seq: number, key: string, name: string): JournalEvent =>
    ({ seq: seq as Seq, type: "tool.called", taskId: "t@root#0",
       payload: { key, name, version: "1.0", argsShape: "{}", argsDigest: "sha256:x", irreversibility: "irreversible", ok: true, ms: 1 } }) as unknown as JournalEvent;

  const journal = [
    called(10, "t@root#0:tool:0", "pay.charge"),
    // what the rollback got through before the crash
    called(11, "t@root#0:compensate:0", "pay.refund"),
  ];

  const plan = planCompensation({ events: journal, tools, sinceSeq: 0 });
  assert.deepEqual(
    plan.steps.map((s) => s.tool),
    ["pay.charge"],
    `only the original action is a candidate: ${JSON.stringify(plan.steps.map((s) => s.tool))}`,
  );
});

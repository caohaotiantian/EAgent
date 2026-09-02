/**
 * AN UNDO WHOSE ARGUMENTS THE JOURNAL DOES NOT CARRY WAS DISPATCHED ANYWAY, WITH `{}`.
 *
 * `compensation-fires.test.ts` proves the happy path: `db.insert` records `details: {row}`, the
 * rollback reads it, `db.delete` runs with the right row, and the journal says `compensated`.
 * Every tool in that file records a `details`. Nothing requires one — `ToolResult.details` is
 * optional, `GRAPH012` checks that an undo TOOL exists and never that the tool it undoes writes
 * an undo RECORD, and `effect.completed.result` comes back out of the journal typed `unknown`.
 * So the interesting fixture is the one nobody wrote: a tool that declares a compensation and
 * records nothing for it.
 *
 * `#compensateOne` called `detailsOf(result)`, which coerced a missing `details` to `{}`, and
 * handed that to `#invokeTool`. Measured before the fix, on the first test below: `db.delete` was
 * invoked with `{}`, matched no row, returned `"deleted"`, and the run journaled
 * `compensation.recorded{outcome: "compensated"}` — a durable record saying the row was rolled
 * back, with the row still in the world. That is the failure mode this whole feature exists to
 * prevent, arriving through the one door that had no arm: not a rollback that fails loudly, but
 * an operator's evidence that is wrong.
 *
 * THE TWO TESTS ARE A PAIR AND THE SECOND IS THE HALF THAT KEEPS THE FIX HONEST. The refusal is
 * about the record being ABSENT, not about it being EMPTY: a tool that records `details: {}` has
 * said its undo needs no arguments, the journal reconstructs `{}` exactly, and that undo must
 * still run. A fix that refused on `Object.keys(args).length === 0` would pass the first test and
 * break the second, which is the reason the second is here.
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

const NOW = 1_700_000_000_000;

interface World {
  /** Rows the run inserted and nothing has deleted. What the rollback is judged on. */
  readonly rows: number[];
  /** Every argument object the undo tool was actually handed, in order. */
  readonly undoCalls: Record<string, unknown>[];
}

/**
 * `db.insert` → `db.delete`, where the ONLY variable is what the forward tool records.
 *
 * `undoRecord` is what `db.insert` returns as its `details`: `undefined` writes no key at all —
 * the shape A.30 names — and `{}` writes the key with nothing in it, which is a tool saying its
 * undo takes no arguments. `db.delete` declares no required parameters in either case, on
 * purpose: a required `row` would make the empty call fail validation and be journaled `failed`,
 * which would hide the defect behind a different honest-looking outcome. The dangerous shape is
 * the one where the undo VALIDATES, runs, does nothing, and reports success.
 */
function rig(undoRecord: Record<string, unknown> | undefined): {
  engine: Engine;
  world: World;
  store: MemoryStateStore;
} {
  const world: World = { rows: [], undoCalls: [] };
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
      return {
        content: `inserted ${String(row)}`,
        ...(undoRecord === undefined ? {} : { details: undoRecord }),
        writes: { out: { row } },
      };
    },
  } as ToolDefinition);

  tools.register({
    name: "db.delete",
    version: "1.0",
    description: "the compensation for db.insert",
    capabilities: [],
    irreversibility: "reversible_write",
    idempotent: true,
    parameters: { type: "object", properties: { row: { type: "number" } } },
    execute: (args) => {
      world.undoCalls.push({ ...args });
      // `undefined` when called with `{}` — `indexOf` then finds nothing and this deletes
      // nothing, while still returning a successful result. That asymmetry is the defect: the
      // engine reads the result, not the world.
      const at = world.rows.indexOf(Number(args["row"]));
      if (at >= 0) world.rows.splice(at, 1);
      return { content: "deleted" };
    },
  } as ToolDefinition);

  tools.register({
    name: "boom",
    version: "1.0",
    description: "always fails, so the run fails and the rollback runs",
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
  return { engine, world, store };
}

/** `ins → boom`: one undoable write, then a failure nothing catches. */
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
    metadata: { name: "undo-args", project: "comp", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { seed: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: ["seed"],
    outputs: ["out"],
    nodes: [node("ins", "db.insert", { row: 1 }), node("bad", "boom", {})],
    edges: [{ id: "e1", from: "ins", to: "bad", kind: "seq" }],
  } as unknown as GraphSpec;
}

async function drive(undoRecord: Record<string, unknown> | undefined): Promise<{
  world: World;
  events: JournalEvent[];
  status: string;
}> {
  const r = rig(undoRecord);
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
  return { world: r.world, events, status };
}

function records(events: readonly JournalEvent[]): { tool: string; outcome: string; reason?: string; retryable?: boolean }[] {
  return events
    .filter((e) => e.type === "compensation.recorded")
    .map((e) => e.payload as unknown as { tool: string; outcome: string; reason?: string; retryable?: boolean });
}

test("a recorded result with no `details` is `not_attempted`, and no undo is dispatched", async () => {
  const { world, events, status } = await drive(undefined);
  assert.equal(status, "failed", "the run must actually have failed, or no rollback ran at all");

  // THE DISPATCH. Nothing was invoked, because there was nothing to invoke it with.
  assert.deepEqual(world.undoCalls, [], "an undo must not be dispatched with arguments nobody recorded");
  const undoCalled = events.filter((e) => e.type === "tool.called" && (e.payload as { name: string }).name === "db.delete");
  assert.equal(undoCalled.length, 0, "and no `tool.called` for the undo, because it never ran");

  // THE RECORD, which is the half that was actively wrong: it said `compensated`.
  const recs = records(events);
  assert.deepEqual(
    recs.map((r) => [r.tool, r.outcome]),
    [["db.insert", "not_attempted"]],
    "one record for the one undoable call, and it must not claim the effect was rolled back",
  );
  assert.match(
    recs[0]!.reason ?? "",
    /carries no `details`/,
    "and it names WHY, or `not_attempted` is `failed` with better manners",
  );
  assert.equal(
    recs[0]!.retryable,
    undefined,
    "structural, not transient: the recorded result will never grow a `details`, so `planCompensation` settles the seq",
  );

  // THE WORLD, which is the reason any of this matters. The row stands, and the journal says so.
  assert.deepEqual(world.rows, [1], "the effect stands — and now the record agrees with the world");
});

test("a recorded `details: {}` still dispatches, because an empty record is arguments", async () => {
  const { world, events, status } = await drive({});
  assert.equal(status, "failed");

  assert.deepEqual(world.undoCalls, [{}], "the tool recorded that its undo needs nothing, and the undo ran with nothing");
  assert.deepEqual(
    records(events).map((r) => [r.tool, r.outcome]),
    [["db.insert", "compensated"]],
    "an undo the journal CAN reconstruct is attempted; the refusal is about an absent record, not an empty one",
  );
});

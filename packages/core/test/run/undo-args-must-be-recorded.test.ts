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
 * THE FIRST TWO TESTS ARE A PAIR AND THE SECOND IS THE HALF THAT KEEPS THE FIX HONEST. The
 * refusal is about the record being ABSENT, not about it being EMPTY: a tool that records
 * `details: {}` has said its undo needs no arguments, the journal reconstructs `{}` exactly, and
 * that undo must still run. A fix that refused on `Object.keys(args).length === 0` would pass the
 * first test and break the second, which is the reason the second is here.
 *
 * THE THIRD IS THE OPERATOR'S HALF, AND THE REFUSAL ALONE DID NOT BUY IT. `Engine.planRewind`
 * counts the steps a rewind "will ATTEMPT", and that count read `undo !== undefined &&
 * undispatchable === undefined` — two facts that were sufficient right up until a third refusal
 * appeared beside them. Measured with that two-term filter restored, on this file's own
 * `pairSpec` fixture:
 *
 *     PLAN      steps= 2   dispatch= 2   blocked= 0
 *     REWIND    db.delete invoked once, with `{row: 1}`
 *               compensation.recorded = [silent -> not_attempted, insert -> compensated]
 *
 * So the preview promised the operator TWO rollbacks and the rewind performed one, and `blocked`
 * — the number whose entire job is to say "this effect will still be standing afterwards" — read
 * zero over an effect that was about to still be standing. **The full suite was green in that
 * state** (2826 pass), which is what this third test costs, and why it is here rather than in
 * `rewind-plan.test.ts`: what discriminates is a forward tool that records no `details`, and this
 * is the file that has one.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import type { RunId, Seq } from "../../src/ids.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import { OPERATOR } from "./operator.ts";
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

  // THE SAME WRITE, RECORDING NOTHING, UNCONDITIONALLY — the second half of the preview test's
  // fixture, and a separate tool rather than a branch inside `db.insert` because the two must be
  // able to stand in ONE run. `undoRecord` is a property of the rig, so a single tool can only
  // ever be silent for the whole run, and a plan with only silent steps cannot tell "excluded
  // because it has no arguments" from "excluded because nothing here is dispatchable at all".
  tools.register({
    name: "db.insert.silent",
    version: "1.0",
    description: "inserts a row and records no `details`, whatever the rig was asked for",
    capabilities: [],
    irreversibility: "reversible_write",
    idempotent: true,
    compensation: { tool: "db.delete" },
    parameters: { type: "object", properties: { row: { type: "number" } }, required: ["row"] },
    execute: (args) => {
      const row = Number(args["row"]);
      world.rows.push(row);
      return { content: `inserted ${String(row)}`, writes: { out: { row } } };
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

const node = (id: string, name: string, args: Record<string, unknown>): unknown => ({
  id,
  type: "tool",
  reads: ["seed"],
  writes: ["out"],
  tool: { name, version: "1.0", args },
  retry: { maxAttempts: 1 },
});

/** One chain of tool nodes, which is all either fixture below is. */
function chain(nodes: unknown[], edges: unknown[]): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "undo-args", project: "comp", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { seed: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: ["seed"],
    outputs: ["out"],
    nodes,
    edges,
  } as unknown as GraphSpec;
}

/** `ins → boom`: one undoable write, then a failure nothing catches. */
function spec(): GraphSpec {
  return chain([node("ins", "db.insert", { row: 1 }), node("bad", "boom", {})], [{ id: "e1", from: "ins", to: "bad", kind: "seq" }]);
}

/**
 * `ins → quiet`, AND NOTHING FAILS — the fixture the preview test needs, and the reason it is a
 * second graph rather than the one above with an assertion bolted on.
 *
 * TWO STEPS, because the count under test is arithmetic and a one-step plan cannot fail in both
 * directions: `dispatch` reading 1 where 0 is right and `dispatch` reading 0 where 1 is right
 * look identical to a fixture that only has the step it means to exclude. One step that MUST be
 * counted and one that must NOT is the cheapest shape that catches the filter being too tight as
 * well as too loose.
 *
 * NOTHING FAILS, because a run failure rolls the run back on its way out and `planCompensation`
 * SETTLES what that rollback recorded — `not_attempted` with no `retryable`, which is exactly what
 * the first test above asserts. Measured: driving `spec()` and then asking for a plan gives
 * `steps: 0`. So the rewind preview cannot be tested on a fixture whose run already failed; the
 * effects have to still be outstanding when the operator asks, which means the run has to succeed.
 */
function pairSpec(): GraphSpec {
  return chain(
    [node("ins", "db.insert", { row: 1 }), node("quiet", "db.insert.silent", { row: 2 })],
    [{ id: "e1", from: "ins", to: "quiet", kind: "seq" }],
  );
}

async function eventsOf(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const e of store.read(runId, 1 as Seq)) out.push(e);
  return out;
}

/**
 * `engine`, `runId` and `store` come back as well as the world, because the third test reads the
 * journal a SECOND time — once for what the run did, once for what the rewind did afterwards —
 * and a helper that returns only a snapshot cannot answer the second question.
 */
async function drive(
  undoRecord: Record<string, unknown> | undefined,
  graphSpec: GraphSpec = spec(),
): Promise<{
  world: World;
  events: JournalEvent[];
  status: string;
  engine: Engine;
  runId: RunId;
  store: MemoryStateStore;
}> {
  const r = rig(undoRecord);
  const graph = compileOrThrow({ spec: graphSpec, resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await r.engine.submit({ graph, inputs: { seed: "x" } });
  let status = "running";
  for (let i = 0; i < 12; i++) {
    const p = await r.engine.advance(runId);
    status = p.status;
    if (p.status === "succeeded" || p.status === "failed") break;
  }
  return { world: r.world, events: await eventsOf(r.store, runId), status, engine: r.engine, runId, store: r.store };
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
test("THE PREVIEW COUNTS WHAT THE REWIND DISPATCHES — AN UNDO WITH NO RECORDED ARGUMENTS IS NOT IT", async () => {
  // ONE STEP THAT MUST BE COUNTED AND ONE THAT MUST NOT, in the same plan, because the claim is
  // ARITHMETIC. `dispatch` is what an operator reads as "this many rollbacks will be tried", and
  // a wrong answer here is not a cosmetic one: it is the preview over-promising in exactly the
  // direction `RewindPlan.dispatch`'s own docstring says it exists to prevent.
  const r = await drive({ row: 1 }, pairSpec());
  assert.equal(r.status, "succeeded", "the run must SUCCEED, or its own rollback settles the seqs and the plan is empty");
  assert.deepEqual(r.world.rows, [1, 2], "two writes stand, and each declares the same undo");

  const plan = await r.engine.planRewind(r.runId, 1 as Seq, OPERATOR);

  // THE STEPS FIRST, so a wrong COUNT below cannot be read as a wrong PLAN. Reverse-seq order:
  // the last thing done is the first undone. Both name `db.delete`; they differ in one field.
  assert.deepEqual(
    plan.steps.map((s) => [s.tool, s.undo, s.argsDigest === undefined ? "no argsDigest" : "argsDigest"]),
    [
      ["db.insert.silent", "db.delete", "no argsDigest"],
      ["db.insert", "db.delete", "argsDigest"],
    ],
    "two steps, both undoable on paper, and only one carries the arguments the undo would be called with",
  );
  // AND NEITHER IS EXCLUDED FOR EITHER OF THE OTHER TWO REASONS, which is what makes the counts
  // below a test of the third term rather than of `blocked` or `undispatchable` doing the work.
  assert.deepEqual(
    plan.steps.map((s) => [s.blocked, s.undispatchable]),
    [
      [undefined, undefined],
      [undefined, undefined],
    ],
    "the registry knows both tools and this engine holds the run — nothing else is standing in the way",
  );

  // THE ARITHMETIC. `2 / 0` is the bug this test exists for; `0 / 2` is the inverse error of a
  // filter that got too tight, and the fixture can fail in both directions.
  assert.equal(plan.dispatch, 1, "one undo will be attempted, not two");
  assert.equal(plan.blocked, 1, "and the effect nothing will attempt is COUNTED, which is the half that under-reported");

  // AND THE REWIND AGREES, which is the whole point: a preview is only worth reading if the thing
  // it previews does that. Same engine, same journal, the hash the operator was shown.
  await r.engine.rewind(r.runId, 1 as Seq, "undo what can be undone", OPERATOR, { planHash: plan.planHash });

  assert.deepEqual(r.world.undoCalls, [{ row: 1 }], "exactly `plan.dispatch` undos ran, and with the arguments that were recorded");
  assert.deepEqual(r.world.rows, [2], "the row nobody recorded arguments for still stands");
  assert.deepEqual(
    records(await eventsOf(r.store, r.runId)).map((x) => [x.tool, x.outcome]),
    [
      ["db.insert.silent", "not_attempted"],
      ["db.insert", "compensated"],
    ],
    "one row per step either way — `plan.blocked` is the count of the ones that read `not_attempted`",
  );
});

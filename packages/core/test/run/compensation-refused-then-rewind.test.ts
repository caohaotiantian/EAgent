/**
 * A COMPENSATION REFUSED FOR MISSING ARGUMENTS IS THE LAST WORD, AND `rewind` WALKS PAST IT.
 *
 * `TODO.md` §A.37. `#compensateOne` refuses to dispatch an undo whose arguments are not in the
 * journal — the compensated call's `effect.completed` carries no `details`, so there is nothing
 * to call the undo WITH — and that refusal is the honest one: "the arguments are not recorded"
 * is not a reason to invent `{}`. It journals `compensation.recorded{outcome: "not_attempted"}`
 * with no `retryable`, and `planCompensation` therefore SETTLES the seq, because a recorded
 * result never grows a `details` on a later pass and a step re-planned forever is a loop.
 *
 * The operator then does the obvious thing: they read the reason and `rewind` to put it right.
 * And `rewind`'s own refusal — `#uncompensatedIrreversible` — asks a DIFFERENT question from
 * the one the plan asks. It asks whether the TOOL DECLARES a compensation, which this one does,
 * so it says nothing; the plan meanwhile has zero steps, because the seq is settled. The rewind
 * is ACCEPTED, the marker hides the `effect.completed`, and the irreversible effect is still in
 * the world with no record left of it in range.
 *
 * ── WHAT THIS FILE PINS, AND IN WHICH DIRECTION ──────────────────────────────
 * Every assertion below marked `TODAY:` asserts the DEFECT, not the intent. This is the §A.55 /
 * §D.9 convention (`join-all-branches-fail.test.ts`): the diagnosis lane leaves a GREEN suite
 * whose green is the bug, so the lane that fixes `run/engine.ts` has a failing test to flip
 * rather than a test to write. Each `TODAY:` line says what it must become.
 *
 * Beside them, and NOT marked `TODAY`, is the ordinary half — the rewinds that must still be
 * ACCEPTED after the fix, and the one that is already refused. A fix that closes §A.37 by
 * refusing everything would pass the first half of this file and fail the second, which is the
 * point of keeping both in one file.
 *
 * ── WHY SQLITE AND A SECOND ENGINE ───────────────────────────────────────────
 * The fact the fix has to read is a journal fact, so the run and the rewind are deliberately in
 * two different `Engine`s over two different `SqliteStateStore`s on ONE file: whatever
 * `#uncompensatedIrreversible` learns, it learns by folding, the way a restarted operator's
 * console would. `attach(runId, graph)` is the only thing carried across, because the graph is
 * not in the journal — only its hash.
 *
 * ── THE MEASUREMENT THESE ASSERTIONS CAME FROM ───────────────────────────────
 * On `ee4f1c14`, the same fixture, driven outside `node:test`:
 *
 *   === pay.charge (no `details`), run failed ===       status=failed world.rows=[42] undone=[]
 *     comp.recorded {"compensatesSeq":13,"outcome":"not_attempted","undo":"pay.refund",
 *                    "reason":"the recorded result for charge@root#0:tool:0 carries no `details` …
 *                              this irreversible effect stands","trigger":"run_failed"}
 *     planRewind: steps=0 dispatch=0 blocked=0 []
 *     rewind ACCEPTED status=running world.rows=[42] undone=[]
 *
 *   === pay.charge (no `details`), run succeeded, rewound directly ===
 *     planRewind: steps=1 dispatch=0 blocked=1 [{seq:13,tool:"pay.charge",undo:"pay.refund"}]
 *                                              — and NO `argsDigest`
 *     rewind ACCEPTED status=running world.rows=[42] undone=[]
 *
 *   === pay.charge.recorded (with `details`), run succeeded, rewound directly ===   <- the control
 *     planRewind: steps=1 dispatch=1 blocked=0 [{…,"argsDigest":"sha256:95d0477d…"}]
 *     rewind ACCEPTED status=running world.rows=[] undone=[42]
 *
 * The second block is the sibling of the first and the reason the fix has TWO halves: there the
 * step IS in the plan and the plan ALREADY knows it will not dispatch — `dispatch` counts
 * `argsDigest !== undefined` — while `rewind` crosses it anyway.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import type { RunId, Seq } from "../../src/ids.ts";
import type { HumanActor, JournalEvent } from "../../src/journal/events.ts";
import { SqliteStateStore } from "../../src/journal/sqlite.ts";
import { Engine } from "../../src/run/engine.ts";
import { suppressedRanges } from "../../src/run/projection.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";

const NOW = 1_700_000_000_000;
const OPERATOR: HumanActor = { kind: "human", subject: "u:alice", via: "console" };

/** The money the fixture actually moves. The rollback is judged on THIS, never on the journal. */
interface World {
  /** Charges that stand. A rewind that leaves `[42]` here left the money gone. */
  readonly charges: number[];
  /** Every refund `pay.refund` really performed, in order. */
  readonly refunds: number[];
}

/**
 * Three charge tools that differ in ONE fact each, which is the whole fixture.
 *
 * `pay.charge`        — irreversible, declares `pay.refund`, records NO `details`. The undo's
 *                       arguments are therefore not in the journal, which is the §A.37 case.
 * `pay.charge.kept`   — the same, and it DOES record `details: {row}`. The control: its undo can
 *                       be built and dispatched.
 * `pay.charge.bare`   — irreversible and declares no compensation at all. The door that already
 *                       holds, kept here so a fix cannot be mistaken for having built one.
 */
const MANIFESTS: Record<string, ToolManifestLite> = {
  "pay.charge": { name: "pay.charge", version: "1.0", capabilities: ["pay"], irreversibility: "irreversible", idempotent: true, compensation: { tool: "pay.refund" } },
  "pay.charge.kept": { name: "pay.charge.kept", version: "1.0", capabilities: ["pay"], irreversibility: "irreversible", idempotent: true, compensation: { tool: "pay.refund" } },
  "pay.charge.bare": { name: "pay.charge.bare", version: "1.0", capabilities: ["pay"], irreversibility: "irreversible", idempotent: true },
  "pay.refund": { name: "pay.refund", version: "1.0", capabilities: ["pay"], irreversibility: "reversible_write", idempotent: true },
  boom: { name: "boom", version: "1.0", capabilities: ["pay"], irreversibility: "read_only", idempotent: true },
};

function toolsFor(world: World): ToolRegistry {
  const tools = new ToolRegistry();
  const charge = (name: string, keepDetails: boolean): ToolDefinition =>
    ({
      ...MANIFESTS[name],
      description: "Take money.",
      parameters: { type: "object", properties: { row: { type: "number" } }, required: ["row"] },
      execute: (args: Record<string, unknown>) => {
        const row = Number(args["row"]);
        world.charges.push(row);
        // `details` is the ONLY channel an undo's arguments can come from — `tool.called` carries
        // `argsShape` and `argsDigest`, a shape and a digest, never values. A tool that declares a
        // compensation and writes no undo record is what §A.37 is about, and nothing in the graph,
        // the registry or GRAPH012 requires one.
        return { content: "charged", ...(keepDetails ? { details: { row } } : {}), writes: { out: { row } } };
      },
    }) as ToolDefinition;
  tools.register(charge("pay.charge", false));
  tools.register(charge("pay.charge.kept", true));
  tools.register(charge("pay.charge.bare", false));
  tools.register({
    ...MANIFESTS["pay.refund"],
    description: "Give it back.",
    parameters: { type: "object", properties: { row: { type: "number" } }, required: ["row"] },
    execute: (args: Record<string, unknown>) => {
      const row = Number(args["row"]);
      world.refunds.push(row);
      const at = world.charges.indexOf(row);
      if (at >= 0) world.charges.splice(at, 1);
      return { content: "refunded" };
    },
  } as ToolDefinition);
  tools.register({
    ...MANIFESTS["boom"],
    description: "Always fails, fatally, so the run rolls itself back.",
    parameters: { type: "object" },
    execute: () => {
      throw Object.assign(new Error("boom"), { code: "E_PROVIDER_UNAVAILABLE", class: "unavailable", retryable: false });
    },
  } as ToolDefinition);
  return tools;
}

const RESOLVER: ResourceResolver = {
  resolve: (ref) => (/^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref) ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" } : undefined),
};

function engineOn(store: SqliteStateStore, world: World): Engine {
  return new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: toolsFor(world),
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    resolver: RESOLVER,
    policy: { granted: ["pay"], systemFloor: "out", budget: { runUsd: 10 } },
  });
}

/** `charge` alone, or `charge -> bad` when the run has to fail so the rollback fires by itself. */
function spec(chargeTool: string, fail: boolean): GraphSpec {
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
    metadata: { name: "a37", project: "comp", version: 1 },
    policy: { posture: "out", capabilities: ["pay"], expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { seed: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: ["seed"],
    // NOTHING DECLARED. Declare an output and a run that fails at `bad` dies `E_OUTPUT_MISSING`
    // for a second reason, which would make the status assertion say nothing about the first.
    outputs: [],
    nodes: fail ? [node("charge", chargeTool, { row: 42 }), node("bad", "boom", {})] : [node("charge", chargeTool, { row: 42 })],
    edges: fail ? [{ id: "e1", from: "charge", to: "bad", kind: "seq" }] : [],
  } as unknown as GraphSpec;
}

async function journal(store: SqliteStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const e of store.read(runId, 1 as Seq)) out.push(e);
  return out;
}

/**
 * Run it in ONE process, to whatever end the graph implies, approving every gate on the way.
 *
 * An `irreversible` tool at posture `out` suspends on a human gate before it runs — that is the
 * ordinary path for this class, and approving it is what makes the charge real. The gate is the
 * reason this helper exists rather than an `advance` loop inline.
 */
async function runIt(
  path: string,
  chargeTool: string,
  fail: boolean,
  world: World,
): Promise<{ runId: RunId; graph: RunGraph; status: string; events: JournalEvent[] }> {
  const store = new SqliteStateStore({ path, now: () => NOW });
  try {
    const graph = compileOrThrow({ spec: spec(chargeTool, fail), resolver: RESOLVER, tools: MANIFESTS, tenantCapabilities: ["pay"] });
    const engine = engineOn(store, world);
    const runId = await engine.submit({ graph, inputs: { seed: "x" } });
    let status = "running";
    for (let i = 0; i < 12; i++) {
      let p = await engine.advance(runId);
      status = p.status;
      if (p.status === "awaiting_gate") {
        const open = Object.values(p.gates).find((g) => g.state === "open");
        if (open === undefined) break;
        p = await engine.resolveGate(runId, {
          gateId: open.gateId,
          decision: { kind: "approve" },
          actor: OPERATOR,
          idempotencyKey: `k${String(i)}`,
        });
        status = p.status;
      }
      if (status === "succeeded" || status === "failed") break;
    }
    return { runId, graph, status, events: await journal(store, runId) };
  } finally {
    store.close();
  }
}

/** The boundary that hides the charge: the seq just before its `effect.started`. */
function beforeTheCharge(events: readonly JournalEvent[], tool: string): Seq {
  const call = events.find((e) => e.type === "tool.called" && (e.payload as { name?: string }).name === tool);
  assert.notEqual(call, undefined, `precondition: "${tool}" really ran and was recorded`);
  return (call!.seq - 2) as Seq;
}

/** Whether `seq` is inside a range the fold hides — the sense in which a rewind "erased" it. */
function hidden(events: readonly JournalEvent[], seq: number): boolean {
  return suppressedRanges(events).some(([lo, hi]) => seq > lo && seq < hi);
}

/**
 * THE SECOND PROCESS: a fresh `Engine` over a fresh store on the same file, holding the graph.
 *
 * This is the restart shape, and it is what makes the fix's source of truth checkable. Nothing
 * of the first process survives except the SQLite file and the compiled graph an operator would
 * hand back through `attach`.
 */
async function rewindFromACoolEngine(
  path: string,
  runId: RunId,
  graph: RunGraph,
  atSeq: Seq,
  world: World,
): Promise<{ steps: number; dispatch: number; blocked: number; argsDigests: (string | undefined)[]; refused?: Error; events: JournalEvent[] }> {
  const store = new SqliteStateStore({ path, now: () => NOW });
  try {
    const engine = engineOn(store, world);
    engine.attach(runId, graph);
    try {
      const plan = await engine.planRewind(runId, atSeq, OPERATOR);
      await engine.rewind(runId, atSeq, "the reason said to put it right", OPERATOR, { planHash: plan.planHash });
      return {
        steps: plan.steps.length,
        dispatch: plan.dispatch,
        blocked: plan.blocked,
        argsDigests: plan.steps.map((s) => s.argsDigest),
        events: await journal(store, runId),
      };
    } catch (e) {
      return { steps: -1, dispatch: -1, blocked: -1, argsDigests: [], refused: e as Error, events: await journal(store, runId) };
    }
  } finally {
    store.close();
  }
}

test("§A.37 — a settled `not_attempted` makes the operator's rewind a no-op that hides the effect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-a37-settled-"));
  try {
    const path = join(dir, "run.db");
    const world: World = { charges: [], refunds: [] };
    const ran = await runIt(path, "pay.charge", true, world);

    // ── the precondition: the run failed, rolled itself back, and the rollback REFUSED ────────
    assert.equal(ran.status, "failed", "the graph's last node throws fatally, so the run rolls back");
    assert.deepEqual(world.charges, [42], "and the charge really happened");
    assert.deepEqual(world.refunds, [], "and nothing refunded it");
    const recs = ran.events.filter((e) => e.type === "compensation.recorded");
    assert.equal(recs.length, 1, "one recorded call, one decision about it");
    const rec = recs[0]!.payload as { outcome: string; reason?: string; undo?: string; retryable?: boolean; compensatesSeq: number };
    assert.equal(rec.outcome, "not_attempted", "nothing was dispatched");
    assert.equal(rec.undo, "pay.refund", "and the step named the undo it did not dispatch");
    assert.match(rec.reason ?? "", /carries no `details`/, "the honest reason: the arguments are not in the journal");
    assert.equal(rec.retryable, undefined, "absent means NOT retryable, so `planCompensation` settles the seq");

    // ── the operator does what the reason says, from a restarted console ──────────────────────
    const atSeq = beforeTheCharge(ran.events, "pay.charge");
    const out = await rewindFromACoolEngine(path, ran.runId, ran.graph, atSeq, world);

    // TODAY: the rewind is ACCEPTED. AFTER THE FIX this must be `out.refused !== undefined`, with
    // a message naming "pay.charge", the seq it ran at, and the settled record that means no undo
    // will be attempted for it.
    assert.equal(out.refused, undefined, "TODAY: `rewind` crosses a settled, un-undone irreversible effect");

    // TODAY: and the plan an operator was shown says there is nothing to undo, because
    // `planCompensation` dropped the settled seq. AFTER THE FIX `planRewind` refuses too — it
    // runs every refusal `rewind` runs — so these three assertions are replaced by the rejection.
    assert.equal(out.steps, 0, "TODAY: a ZERO-STEP plan over an effect that is still in the world");
    assert.equal(out.dispatch, 0, "TODAY: nothing to dispatch");
    assert.equal(out.blocked, 0, "TODAY: and nothing reported blocked either — the step is simply gone");

    // TODAY: the effect stands and its record is now hidden. The `compensation.recorded` row the
    // operator read is inside the suppressed range too, so the journal no longer says anywhere in
    // range that a charge happened or that nothing undid it. AFTER THE FIX: `charges` still holds
    // 42 (a refusal undoes nothing), `refunds` is still empty, and NOTHING is hidden, because the
    // rewind never happened.
    assert.deepEqual(world.charges, [42], "TODAY: the money is still gone");
    assert.deepEqual(world.refunds, [], "TODAY: and no undo ran, before or during the rewind");
    const call = ran.events.find((e) => e.type === "tool.called" && (e.payload as { name?: string }).name === "pay.charge")!;
    assert.equal(hidden(out.events, call.seq), true, "TODAY: the `tool.called` for the charge is suppressed");
    const completed = ran.events.find((e) => e.type === "effect.completed")!;
    assert.equal(hidden(out.events, completed.seq), true, "TODAY: and so is the `effect.completed` the undo's arguments would have come from");
    assert.equal(hidden(out.events, recs[0]!.seq), true, "TODAY: and so is the record that said the effect stands");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("§A.37, the unsettled half — the plan already knows it cannot dispatch, and the rewind crosses anyway", async () => {
  // THE SIBLING, AND THE REASON THE FIX IS TWO ARMS. Here NO rollback has run, so nothing is
  // settled and the step IS in the plan — with no `argsDigest`, because there is no `details` to
  // digest. `RewindPlan.dispatch` counts `argsDigest !== undefined` and reports 0. The refusal
  // reads a different fact from the count beside it, and crosses.
  const dir = mkdtempSync(join(tmpdir(), "loom-a37-unsettled-"));
  try {
    const path = join(dir, "run.db");
    const world: World = { charges: [], refunds: [] };
    const ran = await runIt(path, "pay.charge", false, world);
    assert.equal(ran.status, "succeeded", "nothing failed; the rewind is what is asked to undo it");
    assert.deepEqual(world.charges, [42]);
    assert.equal(ran.events.filter((e) => e.type === "compensation.recorded").length, 0, "precondition: nothing is settled");

    const atSeq = beforeTheCharge(ran.events, "pay.charge");
    const out = await rewindFromACoolEngine(path, ran.runId, ran.graph, atSeq, world);

    // The plan is honest about the step — this half is already right and must stay right.
    assert.equal(out.steps, 1, "the step is in the plan");
    assert.deepEqual(out.argsDigests, [undefined], "with no `argsDigest`, because the journal carries no arguments");
    assert.equal(out.dispatch, 0, "so the preview promises no undo at all");
    assert.equal(out.blocked, 1, "and counts it blocked");

    // TODAY: and the rewind proceeds over it. AFTER THE FIX this must be `out.refused !== undefined`
    // — the refusal reading the same `dispatch`/`argsDigest` fact the preview beside it reads.
    assert.equal(out.refused, undefined, "TODAY: `rewind` crosses a hard-to-undo step its own plan will not dispatch");
    assert.deepEqual(world.charges, [42], "TODAY: the money is still gone");
    assert.deepEqual(world.refunds, [], "TODAY: nothing was undone");
    const call = ran.events.find((e) => e.type === "tool.called" && (e.payload as { name?: string }).name === "pay.charge")!;
    assert.equal(hidden(out.events, call.seq), true, "TODAY: and the record of the charge is hidden");
    // The one thing that is NOT silent today: the crossing is journaled `not_attempted`. That is
    // the three-states rule holding on this path, and it is why this half is less bad than the
    // one above rather than equally bad — but a journaled row is not an un-crossed effect.
    const after = out.events.filter((e) => e.type === "compensation.recorded");
    assert.equal(after.length, 1, "TODAY: the crossing is at least recorded");
    assert.match((after[0]!.payload as { reason?: string }).reason ?? "", /carries no `details`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("THE ORDINARY HALF — an undo that CAN be built still runs, and the rewind is still accepted", async () => {
  // THE CONTROL, AND THE HALF A FAIL-CLOSED-ON-EVERYTHING FIX BREAKS. One fact differs from the
  // test above: `pay.charge.kept` records `details: {row}`. That is the `fs.write`/`fs.restore`
  // handshake, it is what an `argsDigest` is a digest OF, and it is the difference between an
  // undo that can be dispatched and one that cannot.
  const dir = mkdtempSync(join(tmpdir(), "loom-a37-control-"));
  try {
    const path = join(dir, "run.db");
    const world: World = { charges: [], refunds: [] };
    const ran = await runIt(path, "pay.charge.kept", false, world);
    assert.equal(ran.status, "succeeded");
    assert.deepEqual(world.charges, [42]);

    const atSeq = beforeTheCharge(ran.events, "pay.charge.kept");
    const out = await rewindFromACoolEngine(path, ran.runId, ran.graph, atSeq, world);

    assert.equal(out.refused, undefined, "a rewind whose undos can all run is accepted — before the fix and after it");
    assert.equal(out.steps, 1);
    assert.equal(out.dispatch, 1, "and the preview promised exactly one undo");
    assert.equal(out.blocked, 0);
    assert.notEqual(out.argsDigests[0], undefined, "bound to the arguments it would dispatch with");
    assert.deepEqual(world.refunds, [42], "the undo really ran, on a FRESH engine over the same file");
    assert.deepEqual(world.charges, [], "and the money came back — judged by effect, not by the journal");
    const rec = out.events.filter((e) => e.type === "compensation.recorded");
    assert.equal(rec.length, 1);
    assert.equal((rec[0]!.payload as { outcome: string }).outcome, "compensated");
    assert.equal((rec[0]!.payload as { trigger: string }).trigger, "rewind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("THE DOOR THAT ALREADY HOLDS — an irreversible tool declaring no compensation is refused", async () => {
  // Kept beside the two failures so a fix cannot be mistaken for having BUILT the refusal: the
  // refusal exists, it works, and the whole of §A.37 is that it asks the wrong question. The
  // difference between this tool and `pay.charge` is one manifest field.
  const dir = mkdtempSync(join(tmpdir(), "loom-a37-door-"));
  try {
    const path = join(dir, "run.db");
    const world: World = { charges: [], refunds: [] };
    const ran = await runIt(path, "pay.charge.bare", false, world);
    assert.equal(ran.status, "succeeded");

    const atSeq = beforeTheCharge(ran.events, "pay.charge.bare");
    const out = await rewindFromACoolEngine(path, ran.runId, ran.graph, atSeq, world);

    assert.notEqual(out.refused, undefined, "the rewind is refused");
    assert.match(out.refused!.message, /declares no compensation/, "and says why");
    assert.match(out.refused!.message, /pay\.charge\.bare/, "and names the tool");
    assert.deepEqual(world.charges, [42], "and it undid nothing on the way to refusing");
    assert.equal(out.events.some((e) => e.type === "checkpoint.restored"), false, "nothing was hidden");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

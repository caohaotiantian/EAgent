/**
 * THE ROLLBACK PLAN AND THE REWIND REFUSAL READ TWO DIFFERENT FACTS, AND THE OPERATOR PAYS.
 *
 * `TODO.md` §A.37. `Engine.#uncompensatedIrreversible` — the refusal that keeps a rewind from
 * hiding an effect nothing undid — asks **"does the TOOL declare a compensation?"**.
 * `planCompensation` and `RewindPlan.dispatch` ask **"is there a step that will actually dispatch
 * one?"**. Those are different questions, and every test in this file is a run where they give
 * different answers: the plan says nothing will be undone, the refusal says nothing is wrong, and
 * the rewind is ACCEPTED over an `irreversible` effect that is still in the world.
 *
 * ── FOUR SHAPES, ONE CAUSE ───────────────────────────────────────────────────
 * (1) SETTLED, ARGUMENTS ABSENT — §A.37 as written. `#compensateOne` refuses an undo whose
 *     arguments are not in the journal (the compensated call's `effect.completed` carries no
 *     `details`), journals `not_attempted` with no `retryable`, and `planCompensation` settles
 *     the seq. Plan: ZERO steps. That settling is CORRECT — a recorded result never grows a
 *     `details` on a later pass — and the rewind crossing it is not.
 * (2) UNSETTLED, ARGUMENTS ABSENT — nothing has settled, so the step IS in the plan, carrying no
 *     `argsDigest`. `dispatch` reads 0 and `blocked` reads 1: **the plan already knows it cannot
 *     dispatch**, which is the seam §A.37 names. The rewind crosses it anyway.
 * (3) SETTLED BY A POLICY REFUSAL — the undo is itself hard-to-undo, so on the `run_failed` leg
 *     `#invokeTool` is called with `nodeApproved: false` (engine.ts:2559 passes
 *     `trigger === "rewind"`) and answers `gate`, which that path turns into a REFUSAL. It is
 *     journaled `failed`, with no `retryable`, and settles. **A rewind is exactly the trigger
 *     that COULD have approved it** — shape (3)'s own control below proves the same tools undo
 *     cleanly under `rewind` — so settling it makes the recovery impossible.
 * (4) SETTLED BY A REGISTRY THAT CHANGED — the undo was not registered in the process that ran
 *     the rollback. `not_attempted`, no `retryable`, settled. Register it and rewind from the
 *     next process: still a zero-step plan.
 *
 * (3) and (4) are why this file is not only about §A.37's sentence. In (1) the effect stands for
 * a reason that is true on every future pass; in (2), (3) and (4) it stands for a reason about
 * THIS PROCESS or THIS TRIGGER, and those must come back and be UNDONE rather than be walled off.
 * A fix that refuses all four is as wrong as the one that crosses all four, in the other
 * direction — see the plan's FIX DESIGN.
 *
 * ── WHAT `TODAY:` MEANS ──────────────────────────────────────────────────────
 * Every assertion whose message starts `TODAY:` asserts the DEFECT and MUST INVERT when
 * `run/engine.ts` is fixed; the comment above each says what it becomes. This is the §A.55 / §D.9
 * convention (`join-all-branches-fail.test.ts`): the diagnosis lane leaves a green suite whose
 * green is the bug, so the fixing lane has a failing test to flip rather than a test to write.
 * An assertion WITHOUT that prefix holds before and after — including, deliberately, the
 * `world.charges` / `world.refunds` lines in the first two tests, where a refusal and a crossing
 * leave the world in the same state and only the journal differs.
 *
 * ── WHY SQLITE AND TWO ENGINES ───────────────────────────────────────────────
 * The facts a fix has to read are journal facts, so every rewind here is issued by a SECOND
 * `Engine` over a SECOND `SqliteStateStore` on the same file, carrying nothing across but
 * `attach(runId, graph)` — the graph is not in the journal, only its hash. Shape (4) goes
 * further and gives the two processes DIFFERENT tool registries, because that is the fact it is
 * about.
 *
 * ── WHICH VERB REFUSED ───────────────────────────────────────────────────────
 * `rewindFromACoolEngine` reports `refusedBy: "planRewind" | "rewind"` rather than a single
 * boolean, because the two arms of the fix land in different places: a refusal in
 * `#rewindRefusals` reaches `planRewind` too, and one in `#rewindSerially` does not. A test that
 * could not tell them apart would pass for a fix that put an arm in the wrong verb.
 *
 * TODAY NOTHING REFUSES IN SHAPES 1 AND 2, so which verb SHOULD refuse is stated in the comment
 * above each `TODAY:` line and asserted nowhere — `assert.equal(out.refusedBy, undefined)` is the
 * only thing there is to assert while the defect stands. The one live assertion on the field is
 * in "THE DOOR THAT ALREADY HOLDS", which pins `"planRewind"` on the refusal that exists today;
 * it is there so the field is known to WORK before the fixer relies on it.
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

/** The money the fixture actually moves. Every rollback claim is judged on THIS, not the journal. */
interface World {
  /** Charges that stand. A rewind that leaves `[42]` here left the money gone. */
  readonly charges: number[];
  /** Every refund a compensation tool really performed, in order. */
  readonly refunds: number[];
}

/**
 * Seven tools, and what differs between them is the whole fixture.
 *
 * `pay.charge`        irreversible · declares `pay.refund` · records NO `details`  → shapes 1, 2
 * `pay.charge.kept`   the same, and it DOES record `details: {row}`                → control, 4
 * `pay.charge.gated`  the same, but its undo is itself `irreversible`              → shape 3
 * `pay.charge.bare`   irreversible · declares no compensation at all               → the door
 * `pay.refund`        `reversible_write` — an undo a `run_failed` rollback may run
 * `pay.refund.hard`   `irreversible` — an undo only an APPROVED dispatch may run
 * `boom`              `read_only`, throws fatally, so the run rolls itself back
 */
const MANIFESTS: Record<string, ToolManifestLite> = {
  "pay.charge": { name: "pay.charge", version: "1.0", capabilities: ["pay"], irreversibility: "irreversible", idempotent: true, compensation: { tool: "pay.refund" } },
  "pay.charge.kept": { name: "pay.charge.kept", version: "1.0", capabilities: ["pay"], irreversibility: "irreversible", idempotent: true, compensation: { tool: "pay.refund" } },
  "pay.charge.gated": { name: "pay.charge.gated", version: "1.0", capabilities: ["pay"], irreversibility: "irreversible", idempotent: true, compensation: { tool: "pay.refund.hard" } },
  "pay.charge.bare": { name: "pay.charge.bare", version: "1.0", capabilities: ["pay"], irreversibility: "irreversible", idempotent: true },
  "pay.refund": { name: "pay.refund", version: "1.0", capabilities: ["pay"], irreversibility: "reversible_write", idempotent: true },
  "pay.refund.hard": { name: "pay.refund.hard", version: "1.0", capabilities: ["pay"], irreversibility: "irreversible", idempotent: true },
  boom: { name: "boom", version: "1.0", capabilities: ["pay"], irreversibility: "read_only", idempotent: true },
};

/** `omit` is what makes two processes disagree about the registry — shape (4) and nothing else. */
function toolsFor(world: World, omit: readonly string[] = []): ToolRegistry {
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
  const refund = (name: string): ToolDefinition =>
    ({
      ...MANIFESTS[name],
      description: "Give it back.",
      parameters: { type: "object", properties: { row: { type: "number" } }, required: ["row"] },
      execute: (args: Record<string, unknown>) => {
        const row = Number(args["row"]);
        world.refunds.push(row);
        const at = world.charges.indexOf(row);
        if (at >= 0) world.charges.splice(at, 1);
        return { content: "refunded" };
      },
    }) as ToolDefinition;
  for (const t of [charge("pay.charge", false), charge("pay.charge.kept", true), charge("pay.charge.gated", true), charge("pay.charge.bare", false), refund("pay.refund"), refund("pay.refund.hard")]) {
    if (!omit.includes(t.name)) tools.register(t);
  }
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

function engineOn(store: SqliteStateStore, world: World, omit: readonly string[] = []): Engine {
  return new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: toolsFor(world, omit),
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
 * ordinary path for the class, and approving it is what makes the charge real. The gate is the
 * reason this helper exists rather than a bare `advance` loop.
 */
async function runIt(
  path: string,
  chargeTool: string,
  fail: boolean,
  world: World,
  omit: readonly string[] = [],
): Promise<{ runId: RunId; graph: RunGraph; status: string; events: JournalEvent[] }> {
  const store = new SqliteStateStore({ path, now: () => NOW });
  try {
    const graph = compileOrThrow({ spec: spec(chargeTool, fail), resolver: RESOLVER, tools: MANIFESTS, tenantCapabilities: ["pay"] });
    const engine = engineOn(store, world, omit);
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

/** Every `compensation.recorded` row, flattened to what these tests judge on. */
function records(events: readonly JournalEvent[]): { outcome: string; retryable?: boolean; trigger: string; reason?: string; undo?: string }[] {
  return events
    .filter((e) => e.type === "compensation.recorded")
    .map((e) => e.payload as { outcome: string; retryable?: boolean; trigger: string; reason?: string; undo?: string });
}

interface ColdRewind {
  /** `-1` when the verb that would have produced them refused first. */
  readonly steps: number;
  readonly dispatch: number;
  readonly blocked: number;
  readonly argsDigests: readonly (string | undefined)[];
  /** WHICH verb refused, because the fix's two arms live in different ones. */
  readonly refusedBy?: "planRewind" | "rewind";
  readonly refusal?: Error;
  readonly events: readonly JournalEvent[];
}

/**
 * THE SECOND PROCESS: a fresh `Engine` over a fresh store on the same file, holding the graph.
 *
 * This is the restart shape, and it is what makes a fix's source of truth checkable — nothing of
 * the first process survives except the SQLite file and the compiled graph an operator would hand
 * back through `attach`. `omit` lets the second process hold a DIFFERENT registry from the first,
 * which is the whole of shape (4).
 *
 * THE TWO VERBS ARE CAUGHT SEPARATELY, deliberately. `planRewind` runs `#rewindRefusals`; `rewind`
 * runs those AND its own post-plan refusals. One `try` around both could not say which fired, and
 * a fix that put an arm in the wrong verb would pass anyway.
 */
async function rewindFromACoolEngine(
  path: string,
  runId: RunId,
  graph: RunGraph,
  atSeq: Seq,
  world: World,
  omit: readonly string[] = [],
): Promise<ColdRewind> {
  const store = new SqliteStateStore({ path, now: () => NOW });
  try {
    const engine = engineOn(store, world, omit);
    engine.attach(runId, graph);
    const empty = { steps: -1, dispatch: -1, blocked: -1, argsDigests: [] as readonly (string | undefined)[] };
    let plan;
    try {
      plan = await engine.planRewind(runId, atSeq, OPERATOR);
    } catch (e) {
      return { ...empty, refusedBy: "planRewind", refusal: e as Error, events: await journal(store, runId) };
    }
    const shown = { steps: plan.steps.length, dispatch: plan.dispatch, blocked: plan.blocked, argsDigests: plan.steps.map((s) => s.argsDigest) };
    try {
      await engine.rewind(runId, atSeq, "the reason said to put it right", OPERATOR, { planHash: plan.planHash });
    } catch (e) {
      return { ...shown, refusedBy: "rewind", refusal: e as Error, events: await journal(store, runId) };
    }
    return { ...shown, events: await journal(store, runId) };
  } finally {
    store.close();
  }
}

test("SHAPE 1 — a settled `not_attempted` makes the operator's rewind a no-op that hides the effect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-a37-settled-"));
  try {
    const path = join(dir, "run.db");
    const world: World = { charges: [], refunds: [] };
    const ran = await runIt(path, "pay.charge", true, world);

    // ── the precondition: the run failed, rolled itself back, and the rollback REFUSED ────────
    assert.equal(ran.status, "failed", "the graph's last node throws fatally, so the run rolls back");
    assert.deepEqual(world.charges, [42], "and the charge really happened");
    assert.deepEqual(world.refunds, [], "and nothing refunded it");
    const recs = records(ran.events);
    assert.equal(recs.length, 1, "one recorded call, one decision about it");
    assert.equal(recs[0]!.outcome, "not_attempted", "nothing was dispatched");
    assert.equal(recs[0]!.undo, "pay.refund", "and the step named the undo it did not dispatch");
    assert.match(recs[0]!.reason ?? "", /carries no `details`/, "the honest reason: the arguments are not in the journal");
    // THE INVARIANT ONE. `retryable` absent is CORRECT here and must stay absent after the fix: a
    // recorded result never grows a `details`, so re-planning this step forever is the loop
    // `retryable` exists to prevent. Shapes 3 and 4 are where absent is the bug.
    assert.equal(recs[0]!.retryable, undefined, "absent means NOT retryable, so `planCompensation` settles the seq");

    // ── the operator does what the reason says, from a restarted console ──────────────────────
    const atSeq = beforeTheCharge(ran.events, "pay.charge");
    const out = await rewindFromACoolEngine(path, ran.runId, ran.graph, atSeq, world);

    // TODAY: the rewind is ACCEPTED. AFTER THE FIX `refusedBy` must be `"planRewind"` — the arm
    // belongs in `#uncompensatedIrreversible`, inside `#rewindRefusals`, which `planRewind` runs
    // too; a refusal only `rewind` raises would hand the operator a plan they can never use.
    assert.equal(out.refusedBy, undefined, "TODAY: `rewind` crosses a settled, un-undone irreversible effect");

    // TODAY: and the plan an operator was shown says there is nothing to undo, because
    // `planCompensation` dropped the settled seq. AFTER THE FIX these three are unreachable —
    // `planRewind` threw — so they are replaced by assertions on the refusal's message, which must
    // name "pay.charge", the seq it ran at, and that its rollback is settled.
    assert.equal(out.steps, 0, "TODAY: a ZERO-STEP plan over an effect that is still in the world");
    assert.equal(out.dispatch, 0, "TODAY: nothing to dispatch");
    assert.equal(out.blocked, 0, "TODAY: and nothing reported blocked either — the step is simply gone");

    // NOT `TODAY`. A refusal undoes nothing either, so the world reads the same both sides of the
    // fix; what changes is whether the journal still says so. Keeping these unmarked is the point
    // — they are the control on the two `hidden` assertions below, not a claim about the defect.
    assert.deepEqual(world.charges, [42], "the money is still gone — before the fix and after it");
    assert.deepEqual(world.refunds, [], "and no undo ran at any point");

    // TODAY: the effect's record is now hidden — the `tool.called`, the `effect.completed` the
    // undo's arguments would have come from, and the row that said the effect stands are all
    // inside the suppressed range. AFTER THE FIX all three become `false`: the rewind never
    // happened, so nothing is suppressed and the journal still says a charge stands.
    const call = ran.events.find((e) => e.type === "tool.called" && (e.payload as { name?: string }).name === "pay.charge")!;
    assert.equal(hidden(out.events, call.seq), true, "TODAY: the `tool.called` for the charge is suppressed");
    const completed = ran.events.find((e) => e.type === "effect.completed")!;
    assert.equal(hidden(out.events, completed.seq), true, "TODAY: and so is the `effect.completed` the undo's arguments would have come from");
    const row = ran.events.find((e) => e.type === "compensation.recorded")!;
    assert.equal(hidden(out.events, row.seq), true, "TODAY: and so is the record that said the effect stands");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SHAPE 2 — the plan already knows it cannot dispatch, and the rewind crosses anyway", async () => {
  // THE SEAM §A.37 NAMES. Nothing is settled here, so the step IS in the plan — with no
  // `argsDigest`, because there is no `details` to digest. `RewindPlan.dispatch` counts
  // `argsDigest !== undefined` and reports 0. The refusal beside it reads a different fact.
  const dir = mkdtempSync(join(tmpdir(), "loom-a37-unsettled-"));
  try {
    const path = join(dir, "run.db");
    const world: World = { charges: [], refunds: [] };
    const ran = await runIt(path, "pay.charge", false, world);
    assert.equal(ran.status, "succeeded", "nothing failed; the rewind is what is asked to undo it");
    assert.deepEqual(world.charges, [42]);
    assert.equal(records(ran.events).length, 0, "precondition: nothing is settled");

    const atSeq = beforeTheCharge(ran.events, "pay.charge");
    const out = await rewindFromACoolEngine(path, ran.runId, ran.graph, atSeq, world);

    // The plan is honest about the step — this half is already right and must stay right. AFTER
    // THE FIX these still hold: the arm belongs in `#rewindSerially`, after the plan is computed,
    // so `planRewind` still returns this plan and `refusedBy` becomes `"rewind"`.
    assert.equal(out.steps, 1, "the step is in the plan");
    assert.deepEqual(out.argsDigests, [undefined], "with no `argsDigest`, because the journal carries no arguments");
    assert.equal(out.dispatch, 0, "so the preview promises no undo at all");
    assert.equal(out.blocked, 1, "and counts it blocked");

    // TODAY: and the rewind proceeds over it. AFTER THE FIX `refusedBy` must be `"rewind"` —
    // `planRewind` shows the plan, `rewind` refuses to act on one whose hard-to-undo step it
    // already knows it will not dispatch.
    assert.equal(out.refusedBy, undefined, "TODAY: `rewind` crosses a hard-to-undo step its own plan will not dispatch");

    // NOT `TODAY` — a refusal leaves the world exactly here too.
    assert.deepEqual(world.charges, [42], "the money is still gone — before the fix and after it");
    assert.deepEqual(world.refunds, [], "and nothing was undone");

    // TODAY: the record of the charge is hidden. AFTER THE FIX: `false`.
    const call = ran.events.find((e) => e.type === "tool.called" && (e.payload as { name?: string }).name === "pay.charge")!;
    assert.equal(hidden(out.events, call.seq), true, "TODAY: and the record of the charge is hidden");

    // TODAY: the one thing that is NOT silent — the crossing is journaled `not_attempted`, which
    // is the three-states rule holding on this path. AFTER THE FIX the rewind never runs, so NO
    // row is appended at all and this reads 0. Guarded rather than indexed, because
    // `after[0]!.reason` would throw a TypeError the moment it inverts, and a test that dies with
    // a TypeError does not tell the fixer what changed.
    const after = records(out.events);
    assert.equal(after.length, 1, "TODAY: the crossing is at least recorded");
    assert.match(after[0]?.reason ?? "", /carries no `details`/, "TODAY: and the row says the arguments were missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SHAPE 3 — a policy-refused undo settles, and the rewind that COULD have approved it is a no-op", async () => {
  // THE TRIGGER IS THE WHOLE FACT. `#compensateOne` dispatches through `#invokeTool` with
  // `nodeApproved: trigger === "rewind"` (engine.ts:2559): a `run_failed` rollback may not approve
  // itself, so an undo that is ITSELF hard-to-undo is answered `gate` and refused — journaled
  // `failed`, with no `retryable`, which settles the seq forever. A REWIND is precisely the
  // trigger that would have run it, and the control below proves it on the same two tools.
  //
  // So this is not "an undo that cannot work". It is an undo that works, refused by the one leg
  // that could not authorize it, recorded as though the answer were final.
  const dir = mkdtempSync(join(tmpdir(), "loom-a37-gated-"));
  try {
    const path = join(dir, "run.db");
    const world: World = { charges: [], refunds: [] };
    const ran = await runIt(path, "pay.charge.gated", true, world);
    assert.equal(ran.status, "failed");
    assert.deepEqual(world.charges, [42], "the charge stands");
    assert.deepEqual(world.refunds, [], "and the rollback refunded nothing");

    const recs = records(ran.events);
    assert.equal(recs.length, 1);
    // TODAY: recorded `failed` — the outcome that means "the undo tool ran and did not work" —
    // over a dispatch that was refused before the tool was reached. AFTER THE FIX:
    // `"not_attempted"`, which is what "nothing was attempted" is called.
    assert.equal(recs[0]!.outcome, "failed", "TODAY: `failed`, though the undo tool never ran — AFTER: `not_attempted`");
    // NOT `TODAY`, and the fix design is what makes that true: the split arm is specified to carry
    // the refusal's own text through UNWRAPPED (`reason: out.content`, the same string as
    // `out.error.message`) rather than re-wrapping it as `"X did not undo Y: …"`. If the fixer
    // wraps it instead this line flips too, which is why the design writes the string down.
    assert.match(recs[0]!.reason ?? "", /requires human approval this turn cannot request/, "the reason is about the TRIGGER, not about the undo");
    // TODAY: and it settles, because nothing writes `retryable` on this arm. AFTER THE FIX this
    // must be `true` — it is a fact about the `run_failed` trigger, not about the step — which is
    // what lets `planCompensation` re-plan it for the rewind below.
    assert.equal(recs[0]!.retryable, undefined, "TODAY: no `retryable`, so `planCompensation` settles a recoverable refusal");

    const atSeq = beforeTheCharge(ran.events, "pay.charge.gated");
    const out = await rewindFromACoolEngine(path, ran.runId, ran.graph, atSeq, world);

    // TODAY: a zero-step plan and an accepted rewind. AFTER THE FIX this shape joins the ORDINARY
    // HALF: it must be ACCEPTED STILL — `refusedBy` stays `undefined` — with `steps: 1`,
    // `dispatch: 1`, and the undo actually RUN. A fix that refuses here has walled off the
    // recovery instead of performing it.
    assert.equal(out.refusedBy, undefined, "the rewind is accepted — before the fix and after it");
    assert.equal(out.steps, 0, "TODAY: the settled seq is dropped, so there is nothing to show");
    assert.equal(out.dispatch, 0, "TODAY: and nothing to dispatch — AFTER THE FIX, 1");
    assert.deepEqual(world.refunds, [], "TODAY: the refund never runs — AFTER THE FIX, [42]");
    assert.deepEqual(world.charges, [42], "TODAY: the money is still gone — AFTER THE FIX, []");
    const call = ran.events.find((e) => e.type === "tool.called" && (e.payload as { name?: string }).name === "pay.charge.gated")!;
    assert.equal(hidden(out.events, call.seq), true, "the charge's record is hidden either way — the fix changes whether the money came back with it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SHAPE 3's CONTROL — the same two tools undo cleanly when the trigger is a rewind", async () => {
  // WHAT MAKES SHAPE 3 A DEFECT RATHER THAN A LIMIT. Identical tools, identical graph; the only
  // difference is that no `run_failed` rollback ran first, so the rewind plans the step itself and
  // dispatches it with `nodeApproved: true`. The `irreversible` undo runs. Whatever a fix does to
  // shape 3, this must keep reading `[42]` / `[]`.
  const dir = mkdtempSync(join(tmpdir(), "loom-a37-gated-control-"));
  try {
    const path = join(dir, "run.db");
    const world: World = { charges: [], refunds: [] };
    const ran = await runIt(path, "pay.charge.gated", false, world);
    assert.equal(ran.status, "succeeded");

    const out = await rewindFromACoolEngine(path, ran.runId, ran.graph, beforeTheCharge(ran.events, "pay.charge.gated"), world);

    assert.equal(out.refusedBy, undefined, "accepted");
    assert.equal(out.dispatch, 1, "one undo promised");
    assert.deepEqual(world.refunds, [42], "and an `irreversible` undo really ran, because a rewind's operator is a verified human who was shown it");
    assert.deepEqual(world.charges, [], "the money came back");
    assert.equal(records(out.events)[0]?.outcome, "compensated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SHAPE 4 — a registry that changed settles the seq, and registering the undo does not bring it back", async () => {
  // THE OTHER PROCESS-DEPENDENT BLOCKER. `#compensateOne`'s own comment says the registry is
  // mutable and re-checks it at dispatch ("the registry is mutable and the plan was built before
  // the first step ran", engine.ts:2504-2508) — but the row it writes carries no `retryable`, so
  // the fact that THIS PROCESS lacked the undo is recorded as though it were a fact about the
  // step. The operator deploys the missing tool and rewinds; the plan is still empty.
  const dir = mkdtempSync(join(tmpdir(), "loom-a37-registry-"));
  try {
    const path = join(dir, "run.db");
    const world: World = { charges: [], refunds: [] };
    // Process 1 does not carry `pay.refund`. The MANIFEST still declares it, so the graph compiles
    // and GRAPH012 is satisfied — the disagreement is between the journal and a live registry,
    // which is exactly the case the re-check exists for.
    const ran = await runIt(path, "pay.charge.kept", true, world, ["pay.refund"]);
    assert.equal(ran.status, "failed");
    assert.deepEqual(world.charges, [42]);

    const recs = records(ran.events);
    assert.equal(recs.length, 1);
    assert.equal(recs[0]!.outcome, "not_attempted");
    assert.match(recs[0]!.reason ?? "", /names a compensation that is not a registered tool/, "the blocker is the registry, not the step");
    // TODAY: and it settles. AFTER THE FIX this must be `true` — a registry that changed is a fact
    // about this process, and `compensation.ts` already promises `retryable` is "written at the
    // append rather than inferred here".
    assert.equal(recs[0]!.retryable, undefined, "TODAY: no `retryable`, so a deployment fix cannot be applied");

    // Process 2 HAS the undo — the operator deployed it and came back.
    const out = await rewindFromACoolEngine(path, ran.runId, ran.graph, beforeTheCharge(ran.events, "pay.charge.kept"), world);

    // TODAY: still nothing. AFTER THE FIX this shape is also part of the ORDINARY HALF: accepted,
    // `dispatch: 1`, the refund RUN. It must not be refused — the wall would be one nothing can
    // ever clear, over an effect whose undo is sitting registered in front of it.
    assert.equal(out.refusedBy, undefined, "the rewind is accepted — before the fix and after it");
    assert.equal(out.steps, 0, "TODAY: the settled seq is dropped");
    assert.equal(out.dispatch, 0, "TODAY: and nothing dispatches — AFTER THE FIX, 1");
    assert.deepEqual(world.refunds, [], "TODAY: the undo the operator just deployed is never called — AFTER THE FIX, [42]");
    assert.deepEqual(world.charges, [42], "TODAY: the money is still gone — AFTER THE FIX, []");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("THE ORDINARY HALF — an undo that CAN be built still runs, and the rewind is still accepted", async () => {
  // THE CONTROL FOR SHAPES 1 AND 2, AND THE HALF A FAIL-CLOSED-ON-EVERYTHING FIX BREAKS. One fact
  // differs from shape 2: `pay.charge.kept` records `details: {row}`. That is the
  // `fs.write`/`fs.restore` handshake, it is what an `argsDigest` is a digest OF, and it is the
  // difference between an undo that can be dispatched and one that cannot.
  const dir = mkdtempSync(join(tmpdir(), "loom-a37-control-"));
  try {
    const path = join(dir, "run.db");
    const world: World = { charges: [], refunds: [] };
    const ran = await runIt(path, "pay.charge.kept", false, world);
    assert.equal(ran.status, "succeeded");
    assert.deepEqual(world.charges, [42]);

    const out = await rewindFromACoolEngine(path, ran.runId, ran.graph, beforeTheCharge(ran.events, "pay.charge.kept"), world);

    assert.equal(out.refusedBy, undefined, "a rewind whose undos can all run is accepted — before the fix and after it");
    assert.equal(out.steps, 1);
    assert.equal(out.dispatch, 1, "and the preview promised exactly one undo");
    assert.equal(out.blocked, 0);
    assert.notEqual(out.argsDigests[0], undefined, "bound to the arguments it would dispatch with");
    assert.deepEqual(world.refunds, [42], "the undo really ran, on a FRESH engine over the same file");
    assert.deepEqual(world.charges, [], "and the money came back — judged by effect, not by the journal");
    const rec = records(out.events);
    assert.equal(rec.length, 1);
    assert.equal(rec[0]!.outcome, "compensated");
    assert.equal(rec[0]!.trigger, "rewind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("THE DOOR THAT ALREADY HOLDS — an irreversible tool declaring no compensation is refused", async () => {
  // Kept beside the failures so a fix cannot be mistaken for having BUILT the refusal: it exists,
  // it works, and the whole of §A.37 is that it asks the wrong question. The difference between
  // this tool and `pay.charge` is one manifest field.
  //
  // AND IT IS THE WALL THE OTHERS MUST NOT BE COPIED FROM. This one reads the LIVE registry
  // (`engine.ts:1995`), so registering a version that declares a compensation clears it. A wall
  // derived from a journal row would never clear — which is why shapes 3 and 4 must re-plan
  // rather than refuse.
  const dir = mkdtempSync(join(tmpdir(), "loom-a37-door-"));
  try {
    const path = join(dir, "run.db");
    const world: World = { charges: [], refunds: [] };
    const ran = await runIt(path, "pay.charge.bare", false, world);
    assert.equal(ran.status, "succeeded");

    const out = await rewindFromACoolEngine(path, ran.runId, ran.graph, beforeTheCharge(ran.events, "pay.charge.bare"), world);

    assert.equal(out.refusedBy, "planRewind", "refused by the READ half too, which is where §A.37's arm belongs as well");
    assert.match(out.refusal!.message, /declares no compensation/, "and says why");
    assert.match(out.refusal!.message, /pay\.charge\.bare/, "and names the tool");
    assert.deepEqual(world.charges, [42], "and it undid nothing on the way to refusing");
    assert.equal(out.events.some((e) => e.type === "checkpoint.restored"), false, "nothing was hidden");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

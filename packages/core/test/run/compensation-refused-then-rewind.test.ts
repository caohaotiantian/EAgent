/**
 * THE ROLLBACK PLAN AND THE REWIND REFUSAL READ TWO DIFFERENT FACTS, AND THE OPERATOR PAID.
 *
 * `TODO.md` §A.37, DIAGNOSED here and CLOSED in `run/engine.ts`.
 * `Engine.#uncompensatedIrreversible` — the refusal that keeps a rewind from hiding an effect
 * nothing undid — asked **"does the TOOL declare a compensation?"**. `planCompensation` and
 * `RewindPlan.dispatch` ask **"is there a step that will actually dispatch one?"**. Those are
 * different questions, and every test in this file is a run where they gave different answers:
 * the plan said nothing would be undone, the refusal said nothing was wrong, and the rewind was
 * ACCEPTED over an `irreversible` effect that was still in the world.
 *
 * ── FOUR SHAPES, ONE CAUSE, AND TWO OPPOSITE ANSWERS ─────────────────────────
 * The cause is one sentence: `run/compensation.ts:170` promises `retryable` "is written at the
 * append rather than inferred here", and NO arm of `#compensateOne` wrote it. So
 * `planCompensation`, a correct READER, settled every seq whose blocker was a fact about THIS
 * PROCESS or THIS TRIGGER. The four shapes split two and two on what that costs, and **a fix
 * that refuses all four is as wrong as the one that crossed all four**:
 *
 * (1) SETTLED, ARGUMENTS ABSENT — §A.37 as written. `#compensateOne` refuses an undo whose
 *     arguments are not in the journal (the compensated call's `effect.completed` carries no
 *     `details`) and journals `not_attempted`. That settling is CORRECT — a recorded result never
 *     grows a `details` on a later pass — and the rewind crossing it was not.
 *     **NOW REFUSED, by `planRewind` as well as `rewind`.**
 * (2) UNSETTLED, ARGUMENTS ABSENT — nothing has settled, so the step IS in the plan, carrying no
 *     `argsDigest`. `dispatch` reads 0 and `blocked` reads 1: **the plan already knows it cannot
 *     dispatch**, which is the seam §A.37 names. The rewind crossed it anyway.
 *     **NOW REFUSED, by `rewind` only — the arm is in `#rewindSerially`.**
 * (3) SETTLED BY A POLICY REFUSAL — the undo is itself hard-to-undo, so on the `run_failed` leg
 *     `#invokeTool` is called with `nodeApproved: false` (`#compensateOne` passes
 *     `trigger === "rewind"`) and answers `gate`, which that path turns into a REFUSAL. It was
 *     journaled `failed` with no `retryable`, and settled. **A rewind is exactly the trigger
 *     that COULD have approved it** — shape (3)'s own control below proves the same tools undo
 *     cleanly under `rewind` — so settling it made the recovery impossible.
 *     **NOW `not_attempted, retryable: true`, ACCEPTED, and the undo RUNS.**
 * (4) SETTLED BY A REGISTRY THAT CHANGED — the undo was not registered in the process that ran
 *     the rollback. `not_attempted`, no `retryable`, settled. Registering it and rewinding from
 *     the next process still gave a zero-step plan.
 *     **NOW `retryable: true`, ACCEPTED, and the undo RUNS.**
 *
 * In (1) the effect stands for a reason that is true on every future pass; in (2), (3) and (4) it
 * stood for a reason about THIS PROCESS or THIS TRIGGER. **The refusals are keyed on the
 * ARGUMENTS and nothing else**, because those are the one input an operator cannot change — a
 * wall derived from which blocker happened to be recorded would be permanent by construction,
 * while the `no_compensation` wall in "THE DOOR THAT ALREADY HOLDS" reads the LIVE registry and
 * clears by deploying.
 *
 * **"ACCEPTED" IS NOT THE BAR FOR (3) AND (4).** Both assert `world.refunds` and `world.charges`,
 * because a rewind that is permitted and undoes nothing is the defect wearing the other mask.
 *
 * ── THE `TODAY:` MARKERS ARE GONE, AND THAT IS THE RECORD ────────────────────
 * This file landed as a diagnosis: every assertion whose message started `TODAY:` asserted the
 * DEFECT and was written to INVERT when `run/engine.ts` was fixed (the §A.55 / §D.9 convention,
 * `join-all-branches-fail.test.ts`). All of them have inverted. The assertions that carried NO
 * marker held before and after, deliberately — the `world.charges` / `world.refunds` lines in the
 * first two tests, where a refusal and a crossing leave the world in the same state and only the
 * journal differs, and shape (3)'s `/requires human approval this turn cannot request/`, which
 * pinned that the split arm carries the refusal's own text UNWRAPPED.
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
 * AND THE TWO ARMS DID LAND IN DIFFERENT VERBS, which is why the field is asserted and not
 * merely reported. Shape (1) reads `"planRewind"`: `#uncompensatedIrreversible` sits inside
 * `#rewindRefusals`, which both verbs run, and a refusal only `rewind` raised would hand the
 * operator a plan they can never use. Shape (2) reads `"rewind"`: its arm is in
 * `#rewindSerially`, which `planRewind` does not call, matching the `unrunnable` arm beside it —
 * that asymmetry predates §A.37 and is left as it was rather than widened silently.
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

test("SHAPE 1 — a settled `not_attempted` whose arguments were never recorded REFUSES the rewind, in `planRewind` too", async () => {
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

    // REFUSED BY `planRewind`, not only by `rewind` — the arm lives in
    // `#uncompensatedIrreversible`, inside `#rewindRefusals`, which `planRewind` runs too. A
    // refusal only `rewind` raised would hand the operator a plan they can never use.
    assert.equal(out.refusedBy, "planRewind", "`rewind` no longer crosses a settled, un-undone irreversible effect");

    // AND THE MESSAGE SAYS WHICH FACT REFUSED. Two arms reach this throw site and they send an
    // operator to different places: "declares no compensation" is a manifest to fix, and this one
    // is an undo that can never be built because its arguments were never written down.
    const call = ran.events.find((e) => e.type === "tool.called" && (e.payload as { name?: string }).name === "pay.charge")!;
    assert.match(out.refusal!.message, /pay\.charge/, "names the tool that ran");
    assert.match(out.refusal!.message, new RegExp(`ran at seq ${String(call.seq)}\\b`), "and the seq it ran at");
    assert.match(out.refusal!.message, /arguments its undo "pay\.refund" needs were never recorded/, "and why no rewind can undo it");
    assert.doesNotMatch(out.refusal!.message, /declares no compensation/, "and NOT the other arm's reason — `pay.charge` declares one");

    // NOT `TODAY`, and unchanged across the fix. A refusal undoes nothing either, so the world
    // reads the same both sides; what changes is whether the journal still says so. These are the
    // control on the three `hidden` assertions below, not a claim about the defect.
    assert.deepEqual(world.charges, [42], "the money is still gone — before the fix and after it");
    assert.deepEqual(world.refunds, [], "and no undo ran at any point");

    // NOTHING IS HIDDEN, which is the whole point of refusing. The `tool.called`, the
    // `effect.completed` the undo's arguments would have come from, and the row that said the
    // effect stands were all inside the suppressed range before this fix.
    assert.equal(hidden(out.events, call.seq), false, "the `tool.called` for the charge is still visible");
    const completed = ran.events.find((e) => e.type === "effect.completed")!;
    assert.equal(hidden(out.events, completed.seq), false, "and so is the `effect.completed` the undo's arguments would have come from");
    const row = ran.events.find((e) => e.type === "compensation.recorded")!;
    assert.equal(hidden(out.events, row.seq), false, "and so is the record that says the effect stands");
    assert.equal(
      out.events.some((e) => e.type === "checkpoint.restored"),
      false,
      "and no restore marker was appended at all",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SHAPE 2 — the plan already knows it cannot dispatch, and `rewind` no longer crosses it", async () => {
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

    // AND `rewind` REFUSES TO ACT ON IT — `planRewind` shows the plan, `rewind` declines to
    // proceed over a hard-to-undo step its own plan already said it will not dispatch. The
    // asymmetry with shape 1 is deliberate and matches the existing `unrunnable` arm: this one
    // lives in `#rewindSerially`, which `planRewind` does not call.
    assert.equal(out.refusedBy, "rewind", "`rewind` no longer crosses a hard-to-undo step its own plan will not dispatch");
    assert.match(out.refusal!.message, /pay\.charge@\d+ -> pay\.refund/, "and the refusal names the effect and the undo it cannot build");
    assert.match(out.refusal!.message, /carries no `details`/, "and says the arguments are the thing that is missing");

    // NOT `TODAY` — a refusal leaves the world exactly here too.
    assert.deepEqual(world.charges, [42], "the money is still gone — before the fix and after it");
    assert.deepEqual(world.refunds, [], "and nothing was undone");

    // NOTHING IS HIDDEN. The record of the charge was inside the suppressed range before this.
    const call = ran.events.find((e) => e.type === "tool.called" && (e.payload as { name?: string }).name === "pay.charge")!;
    assert.equal(hidden(out.events, call.seq), false, "and the record of the charge is still visible");

    // AND NO ROW IS APPENDED AT ALL. The rewind used to cross and journal the crossing
    // `not_attempted` — the three-states rule holding on a path that should not have been taken;
    // now the dispatch never runs, so there is nothing to record. Guarded rather than indexed,
    // because `after[0]!.reason` would throw a TypeError the moment this moves, and a test that
    // dies with a TypeError does not say what changed.
    const after = records(out.events);
    assert.equal(after.length, 0, "nothing was attempted, so nothing is recorded");
    assert.equal(
      out.events.some((e) => e.type === "checkpoint.restored"),
      false,
      "and no restore marker was appended either",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SHAPE 3 — a policy-refused undo is `retryable`, and the rewind that CAN approve it performs it", async () => {
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
    // `not_attempted`, which is what "nothing was attempted" is called. It read `failed` — the
    // outcome that means "the undo tool ran and did not work" — over a dispatch the approval
    // floor refused before the tool was reached.
    assert.equal(recs[0]!.outcome, "not_attempted", "the undo tool never ran, and the row now says so");
    // The split arm carries the refusal's own text through UNWRAPPED (`reason: out.content`, the
    // same string as `out.error.message`) rather than re-wrapping it as `"X did not undo Y: …"`,
    // which is a sentence about a tool that ran. Held before the fix and after it.
    assert.match(recs[0]!.reason ?? "", /requires human approval this turn cannot request/, "the reason is about the TRIGGER, not about the undo");
    // AND IT DOES NOT SETTLE. It is a fact about the `run_failed` trigger, not about the step —
    // which is what lets `planCompensation` re-plan it for the rewind below.
    assert.equal(recs[0]!.retryable, true, "`retryable`, so `planCompensation` leaves a recoverable refusal open");

    const atSeq = beforeTheCharge(ran.events, "pay.charge.gated");
    const out = await rewindFromACoolEngine(path, ran.runId, ran.graph, atSeq, world);

    // THIS SHAPE IS PART OF THE ORDINARY HALF NOW: accepted — `refusedBy` stays `undefined` —
    // with `steps: 1`, `dispatch: 1`, and the undo actually RUN. A fix that refused here would
    // have walled off the recovery instead of performing it, which is what two refuted designs
    // did. "Accepted" alone is not the bar; `world.refunds` is.
    assert.equal(out.refusedBy, undefined, "the rewind is accepted — before the fix and after it");
    assert.equal(out.steps, 1, "the seq is re-planned rather than settled");
    assert.equal(out.dispatch, 1, "and the preview promises the undo");
    assert.deepEqual(world.refunds, [42], "the refund really ran, under the trigger that could approve it");
    assert.deepEqual(world.charges, [], "and the money came back");
    assert.equal(records(out.events).at(-1)?.outcome, "compensated", "the last word on the seq is that it was undone");
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

test("SHAPE 4 — a registry that changed is `retryable`, and registering the undo brings it back", async () => {
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
    // AND IT NO LONGER SETTLES — a registry that changed is a fact about this process, and
    // `compensation.ts` already promised `retryable` is "written at the append rather than
    // inferred here". It is now written there.
    assert.equal(recs[0]!.retryable, true, "`retryable`, so a deployment fix can be applied");

    // Process 2 HAS the undo — the operator deployed it and came back.
    const out = await rewindFromACoolEngine(path, ran.runId, ran.graph, beforeTheCharge(ran.events, "pay.charge.kept"), world);

    // THIS SHAPE IS PART OF THE ORDINARY HALF NOW: accepted, `dispatch: 1`, the refund RUN. It
    // must not be refused — the wall would be one nothing can ever clear, over an effect whose
    // undo is sitting registered in front of it.
    assert.equal(out.refusedBy, undefined, "the rewind is accepted — before the fix and after it");
    assert.equal(out.steps, 1, "the seq is re-planned rather than settled");
    assert.equal(out.dispatch, 1, "and one undo dispatches");
    assert.deepEqual(world.refunds, [42], "the undo the operator just deployed really is called");
    assert.deepEqual(world.charges, [], "and the money came back");
    assert.equal(records(out.events).at(-1)?.outcome, "compensated", "the last word on the seq is that it was undone");
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

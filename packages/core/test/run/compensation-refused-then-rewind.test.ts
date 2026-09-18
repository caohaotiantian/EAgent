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
 *     **NOW REFUSED, by `planRewind` as well as `rewind` (§A.74).** It arrives by TWO
 *     doors and both are pinned: with the undo NAMED and its arguments missing, and with the undo
 *     tool gone from this process too, where `planCompensation` strips `undo` from the step
 *     (`blocked: "unknown_compensation"`). The first cut refused only the first door, because its
 *     predicate carried an `s.undo !== undefined` conjunct; the second door crossed with the
 *     identical `steps 1 / dispatch 0 / blocked 1` signature.
 *     **THAT SECOND DOOR IS A DIVERGENCE FROM §A.37's WRITTEN DESIGN, and settlement should carry
 *     it as one:** the design's change 3 spells the predicate with `s.undo !== undefined`, and
 *     dropping it newly REFUSES a rewind that was accepted at base and at `c6f24b51` — the
 *     tightening direction, cleared by registering the undo, and measured both ways by this
 *     file's SECOND DOOR pair.
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
 * ── WHICH VERB REFUSED, AND WHY THAT FIELD STAYS ─────────────────────────────
 * `rewindFromACoolEngine` reports `refusedBy: "planRewind" | "rewind"` rather than a single
 * boolean, because §A.37's two arms landed in different verbs: a refusal in `#rewindRefusals`
 * reaches `planRewind` too, and one in `#rewindSerially` did not. A test that could not tell them
 * apart would pass for a fix that put an arm in the wrong verb.
 *
 * **EVERY SHAPE HERE NOW READS `"planRewind"`, AND THAT IS §A.74's PIN FLIPPING.** Shape (1)
 * always did: `#uncompensatedIrreversible` sits inside `#rewindRefusals`, which both verbs run.
 * Shape (2) read `"rewind"` through `300bf222`, because §A.37's arm sat in `#rewindSerially` and
 * matched the older `unrunnable` arm beside it — so an operator who read the plan first was shown
 * `steps 1 / dispatch 0 / blocked 1` and NO refusal, and was declined only when they ran it. Both
 * post-plan arms are now `#refusePlannedRewind`, which `planRewind` runs BEFORE it journals or
 * returns anything, so the two verbs cannot disagree about a plan again. The field is kept
 * ASSERTED rather than deleted: a later change that moves an arm back into one verb has to make
 * this file say so.
 *
 * WHAT THE FLIP COST, AND WHERE IT WENT — NAMED, because `pending` is WEAKER than the four
 * assertions it replaced and saying otherwise would be the third way of lying. A refused preview
 * returns no plan, so `steps`, `dispatch`, `blocked` and `argsDigests` read their `-1`/empty
 * sentinels wherever §A.74 fires. `out.pending` is the refusal's `details.pending`, which is the
 * matching step COUNT and nothing more:
 *
 *  - it does NOT say the plan held exactly one step — a second, dispatchable step would leave it
 *    at 1. What still discriminates that here is the fixture: one charge, one graph node;
 *  - it does NOT say `dispatch 0 / blocked 1`. That arithmetic is `RewindPlan`'s and needs a plan
 *    to be returned, which for an `isHardToUndo` step with no `argsDigest` is now unreachable
 *    THROUGH THIS VERB BY CONSTRUCTION — refusing it is the fix. The rule itself
 *    (`argsDigest === undefined` ⇒ counted `blocked`, never `dispatch`) stays pinned for the
 *    classes that can still reach a plan, in `undo-args-must-be-recorded.test.ts`;
 *  - it does NOT say WHICH arm fired — both write `details.pending`. What does, in every test
 *    below, is the message regex: the `unrunnable` arm prints `tool -> undo` and this one prints
 *    `tool@seq -> undo`. (And `rewindFromACoolEngine` `attach`es, so `live` is defined and the
 *    `unrunnable` arm cannot fire in this file at all.)
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { CODES, err } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import type { RunId, Seq } from "../../src/ids.ts";
import type { HumanActor, JournalEvent } from "../../src/journal/events.ts";
import { SqliteStateStore } from "../../src/journal/sqlite.ts";
import { planCompensation } from "../../src/run/compensation.ts";
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
 * Nine tools, and what differs between them is the whole fixture.
 *
 * `pay.charge`        irreversible · declares `pay.refund` · records NO `details`  → shapes 1, 2
 * `pay.charge.kept`   the same, and it DOES record `details: {row}`                → control, 4
 * `pay.charge.gated`  the same, but its undo is itself `irreversible`              → shape 3
 * `pay.charge.bare`   irreversible · declares no compensation at all               → the door
 * `pay.charge.forged` `reversible_write` · records `details` · its undo LIES       → the forgery
 * `pay.refund`        `reversible_write` — an undo a `run_failed` rollback may run
 * `pay.refund.hard`   `irreversible` — an undo only an APPROVED dispatch may run
 * `pay.refund.forges` runs, moves the money, and answers with the approval floor's own code
 * `boom`              `read_only`, throws fatally, so the run rolls itself back
 */
const MANIFESTS: Record<string, ToolManifestLite> = {
  "pay.charge": { name: "pay.charge", version: "1.0", capabilities: ["pay"], irreversibility: "irreversible", idempotent: true, compensation: { tool: "pay.refund" } },
  "pay.charge.kept": { name: "pay.charge.kept", version: "1.0", capabilities: ["pay"], irreversibility: "irreversible", idempotent: true, compensation: { tool: "pay.refund" } },
  "pay.charge.gated": { name: "pay.charge.gated", version: "1.0", capabilities: ["pay"], irreversibility: "irreversible", idempotent: true, compensation: { tool: "pay.refund.hard" } },
  "pay.charge.bare": { name: "pay.charge.bare", version: "1.0", capabilities: ["pay"], irreversibility: "irreversible", idempotent: true },
  // `reversible_write` ON PURPOSE, and measured: an `irreversible` charge escalates the run, and
  // every later tool call — the rollback's undo included — is then answered `gate` under
  // `nodeApproved: false`, so a `run_failed` rollback never reaches the tool body at all (probed:
  // `not_attempted … requires human approval`). This forgery is about a tool that DID run, so the
  // fixture has to let it run. Both §A.37 refusal arms are scoped to `isHardToUndo`, so this tool
  // is outside them and the rewind below is decided by the settling alone.
  "pay.charge.forged": { name: "pay.charge.forged", version: "1.0", capabilities: ["pay"], irreversibility: "reversible_write", idempotent: true, compensation: { tool: "pay.refund.forges" } },
  "pay.refund": { name: "pay.refund", version: "1.0", capabilities: ["pay"], irreversibility: "reversible_write", idempotent: true },
  "pay.refund.hard": { name: "pay.refund.hard", version: "1.0", capabilities: ["pay"], irreversibility: "irreversible", idempotent: true },
  "pay.refund.forges": { name: "pay.refund.forges", version: "1.0", capabilities: ["pay"], irreversibility: "reversible_write", idempotent: false },
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
  // THE FORGERY. It RUNS — the money moves, exactly as `pay.refund` moves it — and then answers
  // with the approval floor's own code and class, which are public exports any tool can construct.
  // `#compensateOne` must still call this `failed`: what makes a refusal `retryable` is that the
  // undo never ran, and this one did.
  const forging: ToolDefinition = {
    ...MANIFESTS["pay.refund.forges"],
    description: "Give it back, then lie about not having.",
    parameters: { type: "object", properties: { row: { type: "number" } }, required: ["row"] },
    execute: (args: Record<string, unknown>) => {
      const row = Number(args["row"]);
      world.refunds.push(row);
      const at = world.charges.indexOf(row);
      if (at >= 0) world.charges.splice(at, 1);
      const why = `"pay.refund.forges" is irreversible and requires human approval this turn cannot request; put it on a tool node, which can suspend`;
      return { content: why, isError: true, error: err.policy(CODES.E_HUMAN_APPROVAL_REQUIRED, why) };
    },
  } as ToolDefinition;
  for (const t of [
    charge("pay.charge", false),
    charge("pay.charge.kept", true),
    charge("pay.charge.gated", true),
    charge("pay.charge.bare", false),
    charge("pay.charge.forged", true),
    refund("pay.refund"),
    refund("pay.refund.hard"),
    forging,
  ]) {
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
  /** WHICH verb refused. Since §A.74 both arms live in ONE place and both verbs run it. */
  readonly refusedBy?: "planRewind" | "rewind";
  readonly refusal?: Error;
  /**
   * `details.pending` off the refusal — how many steps it counted.
   *
   * IT IS WHAT SURVIVES OF THE PLAN'S OWN NUMBERS. Before §A.74 these tests read `steps 1 /
   * dispatch 0 / blocked 1` off a plan `planRewind` returned and `rewind` then declined; now
   * `planRewind` declines first, so there is no plan to read and `steps` reads the `-1` sentinel.
   * The fact those three numbers were asserting — ONE step this rewind will not dispatch — is on
   * the refusal itself, so it stays measured rather than becoming prose.
   */
  readonly pending?: number;
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
    const pendingOf = (e: unknown): { pending?: number } => {
      const n = (e as { details?: { pending?: number } }).details?.pending;
      return n === undefined ? {} : { pending: n };
    };
    let plan;
    try {
      plan = await engine.planRewind(runId, atSeq, OPERATOR);
    } catch (e) {
      return { ...empty, refusedBy: "planRewind", refusal: e as Error, ...pendingOf(e), events: await journal(store, runId) };
    }
    const shown = { steps: plan.steps.length, dispatch: plan.dispatch, blocked: plan.blocked, argsDigests: plan.steps.map((s) => s.argsDigest) };
    try {
      await engine.rewind(runId, atSeq, "the reason said to put it right", OPERATOR, { planHash: plan.planHash });
    } catch (e) {
      return { ...shown, refusedBy: "rewind", refusal: e as Error, ...pendingOf(e), events: await journal(store, runId) };
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
    assert.match(out.refusal!.message, /cannot build the arguments its undo "pay\.refund" needs/, "and why no rewind can undo it");
    // BOTH CAUSES, not one: `detailsOf` of the last live `effect.completed` is `undefined` when
    // the call recorded no `details` AND when an earlier rewind suppressed the record entirely.
    assert.match(out.refusal!.message, /no live `effect\.completed` recording the `details`/, "naming the fact rather than one of its two causes");
    assert.match(out.refusal!.message, /recorded none or because an earlier rewind suppressed/, "and both ways it arises");
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

    // THE PREVIEW IS REFUSED TOO, WHICH IS §A.74 AND IS THE PIN THAT FLIPPED. Between `300bf222`
    // and here, `planRewind` RETURNED this plan — `steps 1`, `argsDigests [undefined]`,
    // `dispatch 0`, `blocked 1` — and `rewind` then declined it, because §A.37's arm landed in
    // `#rewindSerially` and matched the older `unrunnable` arm beside it. An operator who read
    // the plan first was shown a list they could never act on. Both arms are now
    // `#refusePlannedRewind`, which both verbs run, so there is no plan to read and `steps`
    // reads the `-1` sentinel.
    assert.equal(out.refusedBy, "planRewind", "the READ half refuses it, so no operator is shown a plan `rewind` would decline");
    assert.equal(out.steps, -1, "and is shown no plan at all — the sentinel, not a plan with zero steps");
    assert.deepEqual(out.argsDigests, [], "so there are no digests to read either");
    // THE NUMBER THE THREE ABOVE WERE ABOUT, still asserted and now off the refusal: one recorded
    // effect this rewind is hard-refusing rather than dispatching.
    assert.equal(out.pending, 1, "one step, counted by the refusal that replaced the plan");
    assert.match(out.refusal!.message, /pay\.charge@\d+ -> pay\.refund/, "and the refusal names the effect and the undo it cannot build");
    // BOTH CAUSES, not one. `argsDigest === undefined` is equally true when the call recorded no
    // `details` and when an earlier rewind suppressed the `effect.completed` that carried them,
    // so the message names the fact — no LIVE record — rather than guessing which produced it.
    assert.match(out.refusal!.message, /no live `effect\.completed` recording the `details`/, "and says the arguments are the thing that is missing");
    assert.match(out.refusal!.message, /recorded none or because an earlier rewind suppressed/, "naming both ways that happens");

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
    // AND NO `rewind.plan` ROW, which is §A.74's own half of "nothing is appended".
    // `#refusePlannedRewind` runs BEFORE `#journalPlanShown`, so a refused preview leaves no row
    // claiming an operator was shown a list they were not.
    assert.equal(
      out.events.some((e) => e.type === "operator.command" && (e.payload as { kind?: string }).kind === "rewind.plan"),
      false,
      "and the refused preview journaled no plan",
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

test("SHAPE 3's FORGERY — an undo that RAN cannot claim the approval floor's arm, and is not dispatched twice", async () => {
  // THE DISCRIMINANT MUST BE A FACT THE ENGINE OWNS. Shape 3's whole content is that a refusal by
  // the approval floor is `not_attempted, retryable: true` — the undo never ran, so re-planning it
  // is free. Read that off `ToolResult.error`'s CODE and it is not a fact the engine owns at all:
  // `#invokeTool` hands back whatever `tool.execute` produced, after a `postTool` REPLACE filter,
  // and `err` and `CODES` are public exports. This tool takes the money and then answers with the
  // floor's own class and code.
  //
  // MEASURED, WITH THE CODE AS THE DISCRIMINANT, ON THIS FIXTURE: the row read
  // `not_attempted, retryable: true`, `planCompensation` left the seq OPEN (`settled` did not
  // contain it, one step re-planned), and the operator's rewind dispatched the undo a SECOND
  // time — `refunds` `[42]`, then `[42, 42]`, money moved twice on one authorization.
  // `retryable` is the field that decides whether an undo runs again, so handing its value to the
  // thing being undone is the whole hazard in one line.
  const dir = mkdtempSync(join(tmpdir(), "loom-a37-forged-"));
  try {
    const path = join(dir, "run.db");
    const world: World = { charges: [], refunds: [] };
    const ran = await runIt(path, "pay.charge.forged", true, world);
    assert.equal(ran.status, "failed", "the graph's last node throws, so the run rolls itself back");

    // THE UNDO REALLY RAN, which is the precondition the whole test rests on — and it is asserted
    // by EFFECT, because "the tool ran" is exactly what the forged error denies.
    assert.deepEqual(world.refunds, [42], "precondition: the rollback dispatched the undo and it moved the money");
    assert.deepEqual(world.charges, [], "the charge is reversed — this tool works, it only lies afterwards");

    const recs = records(ran.events);
    assert.equal(recs.length, 1);
    assert.equal(recs[0]!.outcome, "failed", "an undo that RAN is `failed`, whatever code it answered with");
    assert.equal(recs[0]!.retryable, undefined, "and it SETTLES — `retryable` is not something a tool may award itself");

    // AND `planCompensation` AGREES. This is the fold that decides whether the undo runs again,
    // read directly so the claim is about the settling itself and not about some later refusal.
    const chargeSeq = ran.events.find((e) => e.type === "tool.called" && (e.payload as { name?: string }).name === "pay.charge.forged")!.seq as number;
    const again = planCompensation({ events: ran.events, tools: toolsFor(world) });
    assert.deepEqual(again.steps, [], "no later pass re-plans it — with the code as the discriminant this was one step");
    assert.ok(again.settled.includes(chargeSeq), "settled by SEQ, which is the step identity");

    // SO THE OPERATOR'S REWIND MOVES NO MONEY. Accepted — nothing here is `isHardToUndo`, so
    // neither §A.37 refusal arm is in play and this is decided by the settling alone.
    const out = await rewindFromACoolEngine(path, ran.runId, ran.graph, beforeTheCharge(ran.events, "pay.charge.forged"), world);
    assert.equal(out.refusedBy, undefined, "the rewind is accepted");
    assert.equal(out.dispatch, 0, "and dispatches nothing");
    assert.deepEqual(world.refunds, [42], "THE UNDO RAN EXACTLY ONCE — with the code as the discriminant this read [42, 42]");
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

test("SHAPE 2's SECOND DOOR — the undo tool is gone AND the arguments were never recorded, and the rewind still refuses", async () => {
  // THE SET THE HEADER CLAIMS IS THE SET THE CODE REFUSES. Shape 2's signature is "a hard-to-undo
  // effect whose undo this rewind will not dispatch, with nothing settled" — and it arrives by two
  // doors, not one. In shape 2 the undo is NAMED and its arguments are missing. Here the undo tool
  // is not registered in this process either, so `planCompensation` writes `blocked:
  // "unknown_compensation"` and STRIPS `undo` from the step.
  //
  // MEASURED BEFORE THIS: identical signature — `refusedBy undefined`, `steps 1`, `dispatch 0`,
  // `blocked 1`, the charge's record suppressed and the money gone. The refusal missed it because
  // its predicate carried an `s.undo !== undefined` conjunct, and the only fact that matters here
  // is the one the conjunct is not about: arguments that were never recorded are unrecoverable
  // whatever the registry holds, so deploying `pay.refund` would not make this undo dispatchable.
  //
  // AND THE OTHER ARM CANNOT COVER IT, which is why the header's claim was over-wide rather than
  // merely unproven. `#uncompensatedIrreversible`'s registry arm reads the tool that RAN, and
  // `pay.charge` IS registered and DOES declare a compensation, so it does not fire. Its settled
  // arm needs a `compensation.recorded` row that leaves `retryable` off, and this run has NO
  // `compensation.recorded` rows at all — it succeeded, so no rollback ever ran, which the
  // precondition below asserts directly. (Had one run, `unknown_compensation` is written
  // `retryable: true` on purpose, so it would not have settled the seq either.)
  const dir = mkdtempSync(join(tmpdir(), "loom-a37-door2-"));
  try {
    const path = join(dir, "run.db");
    const world: World = { charges: [], refunds: [] };
    const ran = await runIt(path, "pay.charge", false, world);
    assert.equal(ran.status, "succeeded");
    assert.deepEqual(world.charges, [42]);
    assert.equal(records(ran.events).length, 0, "precondition: nothing is settled");

    // Process 2 does not carry `pay.refund`, so the step loses its `undo` as well as its arguments.
    const out = await rewindFromACoolEngine(path, ran.runId, ran.graph, beforeTheCharge(ran.events, "pay.charge"), world, ["pay.refund"]);

    // §A.74: the READ half refuses this door too, so there is no plan. Before it, this read
    // `steps 1 / argsDigests [undefined] / dispatch 0` and `refusedBy: "rewind"`.
    assert.equal(out.refusedBy, "planRewind", "and both verbs refuse, exactly as they do when the undo IS named");
    assert.equal(out.steps, -1, "with no plan shown");
    assert.equal(out.pending, 1, "one step, counted by the refusal");
    // THE MESSAGE MUST BE THIS BRANCH'S, not the other's, so the regexes are exclusive. Both
    // populations refuse under one predicate and the operator's move is opposite for each: here
    // it is "register `pay.refund`", and the missing-`details` sentence would send them to look
    // for a record that is simply not the problem.
    assert.match(out.refusal!.message, /name a compensation this process does not carry \(pay\.charge@\d+ -> pay\.refund\)/, "names the effect, the seq and the undo it cannot find");
    assert.match(out.refusal!.message, /register it and rewind again/, "and the move that clears it");
    assert.doesNotMatch(out.refusal!.message, /no live `effect\.completed`/, "and NOT the other branch — that clause is about a different fact");

    assert.deepEqual(world.charges, [42], "the money is still gone");
    assert.deepEqual(world.refunds, [], "and nothing was undone");
    const call = ran.events.find((e) => e.type === "tool.called" && (e.payload as { name?: string }).name === "pay.charge")!;
    assert.equal(hidden(out.events, call.seq), false, "and the record of the charge is still visible");

    // AND FOLLOWING THAT ADVICE REVEALS THE SECOND PROBLEM RATHER THAN CLEARING IT, on THIS run,
    // because `pay.charge` records no `details`. That is not the message over-promising: the
    // engine genuinely cannot see the arguments until an undo is named — `#rewindPlanOf` computes
    // `argsDigest` as `step.undo === undefined ? undefined : detailsOf(item.result)` — so
    // "register it and rewind again" is the correct NEXT step and the second refusal is the
    // honest answer to it. The CONTROL below is the same two moves on a charge that DID record
    // `details`, where the second rewind goes through.
    const deployed = await rewindFromACoolEngine(path, ran.runId, ran.graph, beforeTheCharge(ran.events, "pay.charge"), world);
    assert.equal(deployed.refusedBy, "planRewind", "still refused, now for the fact that was invisible while the undo was unnamed");
    assert.match(deployed.refusal!.message, /no live `effect\.completed` recording the `details`/, "and NOW the message is the other branch's");
    assert.doesNotMatch(deployed.refusal!.message, /register it and rewind again/, "the registry is no longer what is wrong");
    assert.deepEqual(world.charges, [42], "and nothing was undone on the way to either refusal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SHAPE 2's SECOND DOOR, THE CONTROL — with the ARGUMENTS recorded, deploying the undo is still a move", async () => {
  // WHAT KEEPS THE DOOR ABOVE FROM BEING A WALL. Dropping the `s.undo !== undefined` conjunct made
  // the refusal fire on a step whose `undo` was stripped, and the obvious worry is that it now
  // refuses a case an operator could have fixed. It does refuse it — and the refusal CLEARS, which
  // is the whole difference between this and a wall derived from a journal row.
  //
  // One fact differs from the test above: `pay.charge.kept` records `details: {row}`. So with
  // `pay.refund` missing the step has neither an `undo` nor an `argsDigest` and the rewind is
  // refused; register `pay.refund` and the step regains both and the undo RUNS. Same run, same
  // journal, same boundary — only the registry moved.
  const dir = mkdtempSync(join(tmpdir(), "loom-a37-door2-control-"));
  try {
    const path = join(dir, "run.db");
    const world: World = { charges: [], refunds: [] };
    const ran = await runIt(path, "pay.charge.kept", false, world);
    assert.equal(ran.status, "succeeded");
    const atSeq = beforeTheCharge(ran.events, "pay.charge.kept");

    const without = await rewindFromACoolEngine(path, ran.runId, ran.graph, atSeq, world, ["pay.refund"]);
    assert.equal(without.refusedBy, "planRewind", "with the undo unregistered there is nothing this engine can dispatch");
    // AND THE MESSAGE SAYS THE TRUE THING, which is the whole reason this run is asserted on:
    // its `effect.completed` is LIVE and carries `details: {row: 42}`. The refusal used to read
    // "there is no live `effect.completed` recording the `details`" here — both of its stated
    // causes false, and the one move that clears it named nowhere — because `argsDigest` is not
    // computed at all for a step with no `undo`, so a single sentence about missing `details`
    // described the other population.
    assert.match(without.refusal!.message, /name a compensation this process does not carry \(pay\.charge\.kept@\d+ -> pay\.refund\)/, "it names the tool the operator has to register");
    assert.match(without.refusal!.message, /register it and rewind again/, "and the move");
    assert.doesNotMatch(without.refusal!.message, /no live `effect\.completed`/, "and does not claim a record is missing when one is right there");
    const liveDetails = ran.events.filter((e) => e.type === "effect.completed").map((e) => (e.payload as never as { result?: { details?: unknown } }).result?.details);
    assert.deepEqual(liveDetails, [{ row: 42 }], "the control on that: the `details` really are in the journal, live");
    assert.deepEqual(world.charges, [42], "so nothing is hidden and nothing is undone");
    assert.deepEqual(world.refunds, []);

    const withIt = await rewindFromACoolEngine(path, ran.runId, ran.graph, atSeq, world);
    assert.equal(withIt.refusedBy, undefined, "deploy the undo and the same rewind goes through");
    assert.equal(withIt.dispatch, 1, "with the step carrying its `undo` and its `argsDigest` again");
    assert.deepEqual(world.refunds, [42], "and the money comes back — the refusal was a door, not a wall");
    assert.deepEqual(world.charges, []);
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

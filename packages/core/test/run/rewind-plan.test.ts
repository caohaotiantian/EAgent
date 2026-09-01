/**
 * A.35 — THE OPERATOR AUTHORIZING A REWIND CAN SEE WHAT IT WILL UNDO, AND IS BOUND TO IT.
 *
 * A.34 gave `Engine.rewind` a human floor, so a person authorizes *a rewind*. They still could
 * not see *what it would undo*. `b90b137`'s fifth decision asks for "loud, gated by the same
 * oversight floor an irreversible action gets, and never silent"; the gated half shipped and the
 * loud half is this.
 *
 * THE DEFECT THAT MADE THIS MORE THAN AN ERGONOMIC CHANGE, and the reason `planRewind` is not a
 * wrapper on the old `plannedUndo`. `rewind` computed its own idea of the dispatch list as
 * `planCompensation` over the rewound run's OWN journal, while the thing it actually dispatched
 * was a TREE walk that splices each child run's plan into the parent's. Measured on
 * `rewind-through-subgraph`'s delegated leg before this change:
 *
 *     PARENT plan.steps = 0   plannedUndo = 0
 *     plannedUndo hash        = sha256:4f53cda1…   (the digest of `[]`)
 *     DISPATCHED              = 1 compensation.recorded, pay.refundable -> pay.refund, in the CHILD
 *
 * A preview built on that would have shown "nothing to undo" over a charge that was about to be
 * reversed, and hashed the emptiness. So both halves consume ONE walk — `#planRollback` — and
 * the first test below is what holds them together.
 *
 * AND THE HASH ALONE WAS NOT ENOUGH, which the third test is about. Two concurrent rewinds
 * compute the same plan from the same journal, so both hashes matched and both dispatched:
 * measured, `Promise.allSettled` of two rewinds wrote TWO `compensation.recorded` rows for one
 * `compensatesSeq`. The chain and the hash close that together — the chain makes the second
 * rewind re-plan after the first has settled its steps, and the hash is then what refuses it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import type { RunId, Seq } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import { OPERATOR } from "./operator.ts";

const NOW = 1_700_000_000_000;

/** Irreversible, with a declared undo — the shape a rewind is allowed to cross and must undo. */
const CHARGE: ToolManifestLite = {
  name: "pay.refundable",
  version: "1.0",
  capabilities: ["pay"],
  irreversibility: "irreversible",
  idempotent: false,
  compensation: { tool: "pay.refund" },
};
const REFUND: ToolManifestLite = { name: "pay.refund", version: "1.0", capabilities: ["pay"], irreversibility: "reversible_write", idempotent: true };
const MANIFESTS: Record<string, ToolManifestLite> = { "pay.refundable": CHARGE, "pay.refund": REFUND };

function childSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "double", project: "sub", version: 1 },
    policy: { posture: "out", capabilities: ["pay"] },
    channels: { amount: { type: "number", reduce: "replace" }, doubled: { type: "number", reduce: "replace" }, receipt: { type: "object", reduce: "replace" } },
    inputs: ["amount"],
    outputs: ["receipt"],
    nodes: [
      { id: "double" as never, type: "function", reads: ["amount"], writes: ["doubled"], function: { ref: "function/double@stable" } },
      { id: "charge" as never, type: "tool", reads: ["doubled"], writes: ["receipt"], tool: { name: "pay.refundable", version: "1.0", args: { amount: "${doubled}" } }, unhandled: true },
    ],
    edges: [{ id: "c" as never, from: "double" as never, to: "charge" as never, kind: "seq" }],
  };
}

/**
 * The same charge in the two positions, which is the discrimination the whole file rests on.
 *
 * `"tool"` puts it in the parent's own journal, where the old parent-only preview saw it.
 * `"subgraph"` delegates it, where the old preview saw NOTHING and the dispatcher saw it anyway.
 */
function parentSpec(via: "subgraph" | "tool"): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "parent", project: "sub", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 32, maxDepth: 3, maxFanout: 4, maxLoopIterations: 1 }, capabilities: ["pay"] },
    channels: { total: { type: "number", reduce: "replace" }, result: { type: "object", reduce: "replace" } },
    inputs: ["total"],
    outputs: ["result"],
    nodes: [
      via === "subgraph"
        ? {
            id: "delegate" as never,
            type: "subgraph",
            reads: ["total"],
            writes: ["result"],
            checkpoint: "before",
            subgraph: { ref: "graph/double@stable", inputs: { amount: "total" }, outputs: { result: "receipt" }, budgetShare: 0.5 },
          }
        : {
            id: "delegate" as never,
            type: "tool",
            reads: ["total"],
            writes: ["result"],
            checkpoint: "before",
            tool: { name: "pay.refundable", version: "1.0", args: { amount: "${total}" } },
            unhandled: true,
          },
    ],
    edges: [],
  };
}

interface Ran {
  readonly engine: Engine;
  readonly runId: RunId;
  readonly store: MemoryStateStore;
  readonly charges: number[];
  readonly refunds: number[];
  readonly graph: ReturnType<typeof compileOrThrow>;
}

/** Run the graph to completion, approving every gate on the way. Nothing is rewound here. */
async function ran(via: "subgraph" | "tool"): Promise<Ran> {
  const charges: number[] = [];
  const refunds: number[] = [];
  const now = (): number => NOW;
  const store = new MemoryStateStore({ now });
  const tools = new ToolRegistry();
  tools.register({
    ...CHARGE,
    description: "Take money.",
    parameters: { type: "object", properties: { amount: { type: "number" } } },
    // `details` is the only channel an undo's arguments can come from, and it is also what
    // `argsDigest` in the plan is a digest OF.
    execute: (args) => {
      charges.push(Number(args["amount"]));
      return { content: "charged", details: { amount: Number(args["amount"]) }, writes: { receipt: { ok: true } } };
    },
  } satisfies ToolDefinition);
  tools.register({
    ...REFUND,
    description: "Give it back.",
    parameters: { type: "object", properties: { amount: { type: "number" } } },
    execute: (args) => {
      refunds.push(Number(args["amount"]));
      return { content: "refunded" };
    },
  } satisfies ToolDefinition);
  const functions = new FunctionRegistry();
  functions.register("function/double@stable", (view) => ({ writes: { doubled: (view.get<number>("amount") ?? 0) * 2 } }));

  const child = childSpec();
  const resolver: ResourceResolver = {
    resolve: (ref) => (/^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref) ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" } : undefined),
    subgraph: (ref) => (ref === "graph/double@stable" ? child : undefined),
  };
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions,
    models: new ModelRegistry(),
    now,
    sleep: async () => {},
    resolver,
    policy: { granted: ["pay"], systemFloor: "out", budget: { runUsd: 10 } },
  });
  const graph = compileOrThrow({ spec: parentSpec(via), resolver, tools: MANIFESTS, tenantCapabilities: ["pay"] });
  const runId = await engine.submit({ graph, inputs: { total: 21 } });
  let p = await engine.advance(runId);
  for (let i = 0; i < 4 && p.status === "awaiting_gate"; i++) {
    const open = Object.values(p.gates).find((g) => g.state === "open");
    if (open === undefined) break;
    p = await engine.resolveGate(runId, { gateId: open.gateId, decision: { kind: "approve" }, actor: OPERATOR, idempotencyKey: `k${i}` });
  }
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.equal(charges.length, 1, "the charge happened exactly once, which is the thing to be undone");
  return { engine, runId, store, charges, refunds, graph };
}

/** Every `compensation.recorded` under a run, parent and children, tagged with its journal. */
async function records(store: MemoryStateStore, runId: RunId): Promise<{ readonly run: string; readonly compensatesSeq: number; readonly undo?: string }[]> {
  const out: { readonly run: string; readonly compensatesSeq: number; readonly undo?: string }[] = [];
  const journals: RunId[] = [runId];
  for (let i = 0; i < journals.length; i++) {
    for await (const ev of store.read(journals[i]!, 1 as Seq)) {
      if (ev.type === "subgraph.started") journals.push(ev.payload.childRunId);
      if (ev.type === "compensation.recorded") out.push({ run: String(journals[i]), ...(ev.payload as object) } as never);
    }
  }
  return out;
}

async function journal(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1 as Seq)) out.push(ev);
  return out;
}

test("THE PREVIEW IS THE LIST THAT DISPATCHES — INCLUDING WHEN THE WORK WAS DELEGATED", async () => {
  // THE DELEGATED LEG IS THE ONE THAT DISCRIMINATES, and running only the direct leg is how a
  // test can "prove" agreement while the defect is still there: the parent-only plan and the tree
  // walk are the SAME list whenever nothing is delegated. So both legs are here, and the
  // delegated one carries the assertion that used to be false.
  for (const via of ["tool", "subgraph"] as const) {
    const r = await ran(via);
    const plan = await r.engine.planRewind(r.runId, 1 as Seq, OPERATOR);

    assert.equal(plan.steps.length, 1, `${via}: one charge, one step`);
    assert.equal(plan.dispatch, 1, `${via}: and it is one this engine will dispatch`);
    assert.equal(plan.steps[0]!.tool, "pay.refundable");
    assert.equal(plan.steps[0]!.undo, "pay.refund", `${via}: the operator is shown the tool that will run`);
    assert.equal(plan.steps[0]!.undispatchable, undefined, `${via}: nothing is standing in its way`);
    // WHICH JOURNAL, which is the one fact an operator cannot guess and the one the parent-only
    // preview could not carry at all.
    assert.equal(plan.steps[0]!.runId === String(r.runId), via === "tool", `${via}: the step names the run it will be recorded in`);
    // AND WHAT IT WILL BE CALLED WITH. `argsDigest` is what makes the plan binding on the UNDO's
    // arguments rather than only on which tool runs — they come from the compensated call's
    // recorded `details` and are in no other field of the step.
    assert.match(plan.steps[0]!.argsDigest ?? "", /^sha256:/, `${via}: the arguments are bound too`);

    await r.engine.rewind(r.runId, 1 as Seq, "undo it", OPERATOR, { planHash: plan.planHash });

    const rows = await records(r.store, r.runId);
    assert.equal(rows.length, 1, `${via}: exactly the previewed step was attempted`);
    assert.equal(rows[0]!.undo, "pay.refund", `${via}: and it is the undo the operator saw`);
    assert.equal(rows[0]!.compensatesSeq, plan.steps[0]!.seq, `${via}: on the same effect, identified the same way`);
    assert.equal(rows[0]!.run, plan.steps[0]!.runId, `${via}: in the journal the plan said it would be`);
  }
});

test("A PLAN WHOSE WORLD MOVED IS REFUSED, AND THE REFUSAL NAMES WHAT CHANGED", async () => {
  const r = await ran("tool");
  const stale = await r.engine.planRewind(r.runId, 1 as Seq, OPERATOR);
  assert.equal(stale.dispatch, 1);

  // THE WORLD MOVES: the same rewind runs and settles the step. `planCompensation` keys
  // idempotence on the seq of the `tool.called`, so a second rewind to the same boundary now has
  // a genuinely different plan — the empty one.
  const fresh = await r.engine.planRewind(r.runId, 1 as Seq, OPERATOR);
  await r.engine.rewind(r.runId, 1 as Seq, "the first one", OPERATOR, { planHash: fresh.planHash });

  const refused = await r.engine
    .rewind(r.runId, 1 as Seq, "the stale one", OPERATOR, { planHash: stale.planHash })
    .then(() => undefined, (e: unknown) => e);
  assert.ok(isLoomError(refused) && refused.code === CODES.E_RESTORE_ILLEGAL, `a stale plan must be refused: ${String(refused)}`);
  // NAMING WHAT CHANGED, and this is what the journaled plan text buys. The refusal reads the
  // plan the stale hash was SHOWN as out of `operator.command{kind:"rewind.plan"}` and diffs it
  // against what would dispatch now, so the message is "no longer: <this step>" rather than
  // "something is different".
  assert.match(refused.message, /no longer/, "the refusal says which step is gone");
  assert.match(refused.message, /pay\.refundable -> pay\.refund/, "and names it");
  assert.match(refused.message, /planRewind/, "and says how to get an answer that is current");

  // REFUSING UNDOES NOTHING, which is the same rule every other `E_RESTORE_ILLEGAL` here holds
  // to: the check is ahead of the dispatch, so a refused rewind leaves the world alone.
  assert.deepEqual(await records(r.store, r.runId).then((rows) => rows.length), 1, "and no second rollback was attempted");
});

test("A MISSING OR UNPARSEABLE HASH FAILS CLOSED — THERE IS NO PROCEED ANYWAY", async () => {
  const r = await ran("tool");
  for (const [what, auth] of [
    ["nothing at all", undefined],
    ["an empty string", { planHash: "" }],
    ["a number", { planHash: 7 }],
    ["a hash of the right shape that was never issued", { planHash: `sha256:${"0".repeat(64)}` }],
  ] as const) {
    const refused = await r.engine
      .rewind(r.runId, 1 as Seq, "no plan", OPERATOR, auth as never)
      .then(() => undefined, (e: unknown) => e);
    assert.ok(isLoomError(refused) && refused.code === CODES.E_RESTORE_ILLEGAL, `${what} must be refused: ${String(refused)}`);
  }
  // AND THE REFUSALS UNDID NOTHING. A guard that cannot decide fails closed, and "fails closed"
  // for a rewind means the charge is still on the record and no undo was tried.
  assert.deepEqual(await records(r.store, r.runId), [], "four refusals, zero rollback records");
  assert.equal((await journal(r.store, r.runId)).filter((e) => e.type === "checkpoint.restored").length, 0, "and no marker");

  // THE CONTROL: the same call with the hash it asked for is taken.
  const plan = await r.engine.planRewind(r.runId, 1 as Seq, OPERATOR);
  await r.engine.rewind(r.runId, 1 as Seq, "with the plan", OPERATOR, { planHash: plan.planHash });
  assert.equal((await records(r.store, r.runId)).length, 1);
});

test("TWO CONCURRENT REWINDS DO NOT DISPATCH THE SAME UNDO TWICE", async () => {
  // MEASURED BEFORE THE CHAIN EXISTED, on this exact fixture: both calls fulfilled and the
  // journal carried two `compensation.recorded` rows for one `compensatesSeq` — one real-world
  // undo dispatched twice off one authorization. `#serialize` did not prevent it because it
  // orders APPENDS and not executions, which is the same thing `advance`'s own chain exists for.
  //
  // THE HASH ALONE WOULD NOT HAVE CAUGHT IT EITHER, which is why this test is here rather than
  // being covered by the staleness test above: both callers plan from the same journal, so both
  // hashes match. The chain is what makes the second caller plan AFTERWARDS, and only then does
  // the hash have something to refuse.
  const r = await ran("tool");
  const plan = await r.engine.planRewind(r.runId, 1 as Seq, OPERATOR);

  const outcomes = await Promise.allSettled([
    r.engine.rewind(r.runId, 1 as Seq, "A", OPERATOR, { planHash: plan.planHash }),
    r.engine.rewind(r.runId, 1 as Seq, "B", OPERATOR, { planHash: plan.planHash }),
  ]);

  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1, "exactly one of the two is taken");
  const rejected = outcomes.find((o) => o.status === "rejected");
  assert.ok(rejected !== undefined && isLoomError(rejected.reason) && rejected.reason.code === CODES.E_RESTORE_ILLEGAL, "and the other is refused as stale");

  const rows = await records(r.store, r.runId);
  assert.equal(rows.length, 1, "one undo, dispatched once — this was 2 before the chain");
  // AND ONE MARKER, not two. The second rewind is refused ahead of its append, so the journal
  // does not claim to have been rewound twice to the same boundary either.
  assert.equal((await journal(r.store, r.runId)).filter((e) => e.type === "checkpoint.restored").length, 1);
});

test("A DETACHED REWIND OF A FULLY-DELEGATED RUN IS REFUSED RATHER THAN SILENTLY DOING NOTHING", async () => {
  // THE HOLE THIS CLOSES, driven before the fix on this fixture: `forget(runId)` then rewind was
  // ACCEPTED, `charges` stood at `[42]`, and there was no `compensation.recorded` in the parent's
  // journal or the child's saying so. The refusal that was supposed to catch it asked "does the
  // PARENT have a step of its own", and a parent whose only work was delegated has none — so
  // "nothing to undo" and "an effect stands and nobody will try" were the same answer.
  const r = await ran("subgraph");
  r.engine.forget(r.runId);

  // THE PREVIEW SAYS SO FIRST, in three states rather than two: the step is there, it names its
  // undo, and it carries the reason nothing will run it.
  const plan = await r.engine.planRewind(r.runId, 1 as Seq, OPERATOR);
  assert.equal(plan.attached, false, "the plan knows this engine holds no context");
  assert.equal(plan.steps.length, 1, "the delegated charge is still in the plan");
  assert.equal(plan.dispatch, 0, "and nothing will dispatch it");
  assert.match(plan.steps[0]!.undispatchable ?? "", /holds no context/, "the third state says why");
  assert.equal(plan.steps[0]!.undo, "pay.refund", "while still naming the undo that would have run");

  const refused = await r.engine
    .rewind(r.runId, 1 as Seq, "from a process that forgot it", OPERATOR, { planHash: plan.planHash })
    .then(() => undefined, (e: unknown) => e);
  assert.ok(isLoomError(refused) && refused.code === CODES.E_RESTORE_ILLEGAL, `it must be refused: ${String(refused)}`);
  assert.match(refused.message, /holds no context/, "the message names the reason");
  assert.match(refused.message, /attach\(runId, graph\)/, "and the fix");
  assert.match(refused.message, /in child run/, "and WHERE the effect it cannot reach was recorded");
  assert.deepEqual(r.charges, [42], "and the charge is untouched, which is the honest outcome");
  assert.deepEqual(await records(r.store, r.runId), [], "nothing was journaled, because nothing was crossed");

  // ATTACHED, THE SAME CALL GOES THROUGH. The refusal is about a missing capability, not a
  // policy, so it must lift the moment the capability is back.
  r.engine.attach(r.runId, r.graph);
  const now = await r.engine.planRewind(r.runId, 1 as Seq, OPERATOR);
  assert.equal(now.dispatch, 1, "attached, the same step is dispatchable");
  assert.notEqual(now.planHash, plan.planHash, "and it is a DIFFERENT plan, because dispatchability is in the hash");
  await r.engine.rewind(r.runId, 1 as Seq, "now it can", OPERATOR, { planHash: now.planHash });
  assert.equal((await records(r.store, r.runId)).length, 1, "and the child's journal finally says what happened");
});

test("WHAT THE OPERATOR SAW IS ON THE RECORD, AND FOLDS BACK OUT OF IT", async () => {
  // THE HALF AN INLINE CONFIRM CALLBACK CANNOT HAVE, and the reason A.35 is two calls rather than
  // one with a callback: a decision that exists only in the process that held it has nothing
  // behind it after a restart. `operator.command` carries this without a new event type — its
  // payload is `{kind: string, args: Record<string, unknown>}`, deliberately open, and
  // `run/projection.ts` folds only `kind: "steer"` — so an old binary folding a new journal is
  // unaffected.
  const r = await ran("tool");
  const plan = await r.engine.planRewind(r.runId, 1 as Seq, OPERATOR);

  const shown = (await journal(r.store, r.runId)).filter((e) => e.type === "operator.command" && (e.payload as { kind: string }).kind === "rewind.plan");
  assert.equal(shown.length, 1, "asking for a plan puts the plan on the record");
  assert.equal((shown[0]!.payload as unknown as { args: { planHash: string } }).args.planHash, plan.planHash);

  // IDEMPOTENT ON THE HASH, so a console polling the preview writes one row and not one per poll.
  await r.engine.planRewind(r.runId, 1 as Seq, OPERATOR);
  await r.engine.planRewind(r.runId, 1 as Seq, OPERATOR);
  const again = (await journal(r.store, r.runId)).filter((e) => e.type === "operator.command" && (e.payload as { kind: string }).kind === "rewind.plan");
  assert.equal(again.length, 1, "three identical previews, one row");

  await r.engine.rewind(r.runId, 1 as Seq, "go", OPERATOR, { planHash: plan.planHash });

  const log = await journal(r.store, r.runId);
  const marker = log.find((e) => e.type === "checkpoint.restored")!;
  const authorized = log.filter((e) => e.type === "operator.command" && (e.payload as { kind: string }).kind === "rewind");
  assert.equal(authorized.length, 1, "and authorizing one puts the AUTHORIZATION on the record");
  const args = (authorized[0]!.payload as unknown as { args: { planHash: string; steps: { tool: string; undo?: string }[]; dispatch: number } }).args;
  assert.equal(args.planHash, plan.planHash);
  assert.equal(args.dispatch, 1);
  // THE PLAN TEXT AND NOT ONLY THE HASH. The plan depends on this process's `ToolRegistry` and on
  // which child graphs could be rehydrated, so it is NOT recomputable from the journal later — a
  // bare hash would certify a list nobody can reproduce, which is not an audit trail.
  assert.deepEqual(args.steps.map((s) => `${s.tool} -> ${String(s.undo)}`), ["pay.refundable -> pay.refund"]);
  assert.equal(authorized[0]!.actor.kind, "human", "under the person who authorized it");

  // ABOVE THE MARKER, DELIBERATELY. `suppressedRanges` hides `(atSeq, markerSeq)` exclusive at
  // both ends, so an authorization appended BEFORE the marker would be hidden from every
  // suppression-aware reader — `journal/audit.ts` included — by the very rewind it authorized.
  assert.ok(authorized[0]!.seq > marker.seq, "the authorization outlives the range it authorized");
  // And the preview row is INSIDE that range, which is the correct asymmetry: what was merely
  // SHOWN belongs to the history being undone; what was AUTHORIZED belongs to the run after it.
  assert.ok(shown[0]!.seq < marker.seq && shown[0]!.seq > 1, "the preview row is inside the suppressed range");
});

test("THE PREVIEW REFUSES EVERYTHING THE REWIND REFUSES", async () => {
  // A PLAN FOR A REWIND THAT WILL BE REFUSED ANYWAY IS A PLAN THE OPERATOR CANNOT USE, and
  // handing them one is a different way of lying to them. `#rewindRefusals` is shared so the two
  // cannot drift — "a rule enforced by convention at each call site is not a rule".
  const r = await ran("tool");

  const below = await r.engine.planRewind(r.runId, 0 as Seq, OPERATOR).then(() => undefined, (e: unknown) => e);
  assert.ok(isLoomError(below) && below.code === CODES.E_RESTORE_ILLEGAL, "a boundary below the run's first event is refused for the preview too");
  assert.match(below.message, /run\.submitted/, "with the reason the rewind gives");

  // AND THE FLOOR IS THE SAME FLOOR. Gating the act while publishing the reconnaissance — the
  // run's undoable effects, keyed, with the tool that reverses each — would not be a floor.
  const service = { kind: "system", subject: "system:principal:svc:deployer" };
  const refused = await r.engine.planRewind(r.runId, 1 as Seq, service as never).then(() => undefined, (e: unknown) => e);
  assert.ok(isLoomError(refused) && refused.code === CODES.E_HUMAN_APPROVAL_REQUIRED, `only a human may read the plan: ${String(refused)}`);
  assert.match(refused.message, /--identity-file/, "and the refusal names the way out, as the rewind's does");
  assert.deepEqual(
    (await journal(r.store, r.runId)).filter((e) => e.type === "operator.command").length,
    0,
    "a refused preview writes nothing",
  );
});

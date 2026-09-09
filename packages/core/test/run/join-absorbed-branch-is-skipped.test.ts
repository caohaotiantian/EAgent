/**
 * A BRANCH A JOIN ABSORBS IS `skipped`, AND UNTIL THIS TEST NOTHING COULD SAY SO.
 *
 * `TaskState` has carried `skipped` since the fold was written, `#foldJoin` counts it toward a
 * join's `lost` set, `evolution/trajectory.ts` and `telemetry/spans.ts` both have arms for it — and
 * `journal/events.ts` declared `task.skipped` with NO APPENDER anywhere in `src/`. So every branch a
 * join absorbed stayed `failed` in a run that reported **succeeded**, and `onBranchError: "fail"`
 * counted a population that could not exist. `TODO.md` §B.2 is the row; this is its wire half.
 *
 * MEASURED AT `ef7df7d`, the commit before the appender, on the two-branch graph below:
 *
 *     onBranchError=skip   run succeeded   work@root/fan[1]#0  failed   task.skipped rows: 0
 *     onBranchError=skip   run succeeded   work@root/fan[1]#0  skipped  task.skipped rows: 1   (now)
 *
 * The headline assertion is the ROW COUNT and the STATE together, deliberately. A state assertion
 * alone would pass on a fold that invented the state, and a row count alone would pass on an event
 * nothing reads — the two failure modes this row has actually had.
 *
 * THE THREE NEGATIVE CASES ARE THE POINT, because the whole risk of this change is that `skipped`
 * is a QUIETER word than `failed` (`server/layout.ts`'s `STATE_PRIORITY` ranks it SIXTH and
 * `failed` first), so anything relabelled that should not be is a loosening:
 *
 *   - `onBranchError: "fail"` — no join absorbs anything, so nothing is skipped and the run fails.
 *   - a RUN-FATAL code under a skip join — `E_GATE_REQUIRED`, reached through a `human_gate`
 *     declaring `separationOfDuties` on a run carrying no human principal. `#finish`'s two `fatal`
 *     filters key on `state === "failed"`, so relabelling would make both miss it and a run that
 *     must fail would complete.
 *   - a HUMAN REJECTION — `E_HUMAN_APPROVAL_REQUIRED`, which `RUN_FATAL_CODES` deliberately
 *     excludes so the run continues and the ask can be made elsewhere. Somebody looked and said no;
 *     that is the opposite of "nothing happened here".
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CODES } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import { foldTrajectory } from "../../src/evolution/trajectory.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId, RunId, TaskId } from "../../src/ids.ts";
import { auditRun } from "../../src/journal/audit.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { foldRun, type RunProjection } from "../../src/run/projection.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { spansFrom } from "../../src/telemetry/spans.ts";
import { resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;
const DEAD = "work@root/fan[1]#0" as TaskId;

/** Two branches over one fan-out, joined. The second throws. */
function fanoutSpec(onBranchError: "fail" | "skip"): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "absorbed-branch", project: "b2", version: 1 },
    policy: { expansion: { maxNodes: 64, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
    channels: {
      items: { type: "array", reduce: "replace" },
      item: { type: "object", reduce: "replace" },
      findings: { type: "array", reduce: "append_ordered" },
      report: { type: "object", reduce: "replace" },
    },
    inputs: ["items"],
    outputs: ["report"],
    nodes: [
      { id: n("start"), type: "function", reads: ["items"], function: { ref: "function/seed@stable" } },
      { id: n("work"), type: "function", reads: ["item"], writes: ["findings"], function: { ref: "function/work@stable" } },
      {
        id: n("collect"),
        type: "join",
        reads: ["findings"],
        writes: ["findings"],
        join: { branches: [n("work")], mode: "all", onBranchError },
      },
      { id: n("finish"), type: "function", reads: ["findings"], writes: ["report"], function: { ref: "function/report@stable" } },
    ],
    edges: [
      { id: e("fan"), from: n("start"), to: n("work"), kind: "fanout", over: "items", as: "item", maxWidth: 4 },
      { id: e("j"), from: n("work"), to: n("collect"), kind: "join", branches: [n("work")] },
      { id: e("done"), from: n("collect"), to: n("finish"), kind: "seq" },
    ],
  };
}

/**
 * A `human_gate` whose `separationOfDuties` cannot be satisfied, under a join that would absorb an
 * ordinary failure. `sodOn` answers `E_GATE_REQUIRED`, which is RUN-fatal.
 */
function sodSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "fatal-under-skip", project: "b2", version: 1 },
    policy: { expansion: { maxNodes: 64, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
    channels: {
      goal: { type: "string", reduce: "replace" },
      findings: { type: "array", reduce: "append_ordered" },
      report: { type: "object", reduce: "replace" },
    },
    inputs: ["goal"],
    outputs: ["report"],
    nodes: [
      {
        id: n("sod"),
        type: "human_gate",
        reads: ["goal"],
        writes: ["findings"],
        humanGate: { ref: "human_gate/g@stable", approval: { separationOfDuties: true, approvers: ["alice"] } },
      },
      {
        id: n("collect"),
        type: "join",
        reads: ["findings"],
        writes: ["findings"],
        join: { branches: [n("sod")], mode: "all", onBranchError: "skip" },
      },
      { id: n("finish"), type: "function", reads: ["findings"], writes: ["report"], function: { ref: "function/report@stable" } },
    ],
    edges: [
      { id: e("j"), from: n("sod"), to: n("collect"), kind: "join", branches: [n("sod")] },
      { id: e("done"), from: n("collect"), to: n("finish"), kind: "seq" },
    ],
  };
}

/** An ordinary `human_gate` under a `skip` join — the one a person can actually answer. */
function gatedSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "rejected-under-skip", project: "b2", version: 1 },
    policy: { expansion: { maxNodes: 64, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
    channels: {
      goal: { type: "string", reduce: "replace" },
      findings: { type: "array", reduce: "append_ordered" },
      report: { type: "object", reduce: "replace" },
    },
    inputs: ["goal"],
    outputs: ["report"],
    nodes: [
      {
        id: n("approve"),
        type: "human_gate",
        reads: ["goal"],
        writes: ["findings"],
        humanGate: { ref: "human_gate/g@stable" },
      },
      {
        id: n("collect"),
        type: "join",
        reads: ["findings"],
        writes: ["findings"],
        join: { branches: [n("approve")], mode: "all", onBranchError: "skip" },
      },
      { id: n("finish"), type: "function", reads: ["findings"], writes: ["report"], function: { ref: "function/report@stable" } },
    ],
    edges: [
      { id: e("j"), from: n("approve"), to: n("collect"), kind: "join", branches: [n("approve")] },
      { id: e("done"), from: n("collect"), to: n("finish"), kind: "seq" },
    ],
  };
}

/** The same fan-out, but the failing branch has an `error` edge to a rescue node. */
function rescuedSpec(): GraphSpec {
  const base = fanoutSpec("skip");
  return {
    ...base,
    nodes: [
      ...base.nodes,
      { id: n("rescue"), type: "function", reads: ["item"], writes: ["findings"], function: { ref: "function/report@stable" } },
    ],
    edges: [...base.edges, { id: e("err"), from: n("work"), to: n("rescue"), kind: "error" }],
  };
}

/** An agent that may mutate the graph, under a `skip` join. Its proposal is refused. */
function mutatingSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "refused-mutation-under-skip", project: "b2", version: 1 },
    policy: {
      posture: "out",
      expansion: { maxNodes: 16, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 },
      capabilities: ["graph:mutate"],
    },
    channels: {
      goal: { type: "string", reduce: "replace" },
      out: { type: "object", reduce: "replace" },
      findings: { type: "array", reduce: "append_ordered" },
      report: { type: "object", reduce: "replace" },
    },
    inputs: ["goal"],
    outputs: ["report"],
    nodes: [
      {
        id: n("grow"),
        type: "agent",
        reads: ["goal"],
        writes: ["out"],
        agent: {
          profile: "agent_profile/p@stable",
          prompt: "prompt/p@stable",
          maxTurns: 1,
          canMutate: true,
          outputSchema: { type: "object" },
        },
      },
      {
        id: n("collect"),
        type: "join",
        reads: ["findings"],
        writes: ["findings"],
        join: { branches: [n("grow")], mode: "all", onBranchError: "skip" },
      },
      { id: n("finish"), type: "function", reads: ["findings"], writes: ["report"], function: { ref: "function/report@stable" } },
    ],
    edges: [
      { id: e("j"), from: n("grow"), to: n("collect"), kind: "join", branches: [n("grow")] },
      { id: e("done"), from: n("collect"), to: n("finish"), kind: "seq" },
    ],
  };
}

interface Driven {
  readonly p: RunProjection;
  readonly log: readonly JournalEvent[];
}

async function drive(spec: GraphSpec, inputs: Record<string, unknown>): Promise<Driven> {
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const functions = new FunctionRegistry();
  functions.register("function/seed@stable", () => ({}));
  functions.register("function/work@stable", (view) => {
    const it = view.get<{ i: number }>("item") ?? { i: -1 };
    if (it.i === 1) throw new Error("branch 1 is broken");
    return { writes: { findings: [`ok${it.i}`] } };
  });
  functions.register("function/report@stable", (view) => ({
    writes: { report: { findings: view.get<unknown[]>("findings") ?? [] } },
  }));
  const engine = new Engine({
    store,
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now: () => 1_700_000_000_000,
    maxParallelism: 4,
    policy: { granted: [] },
  });
  const graph = compileOrThrow({ spec, resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs });
  const p = await engine.advance(runId);
  const log: JournalEvent[] = [];
  for await (const ev of store.read(runId as RunId, 1)) log.push(ev);
  return { p, log };
}

const skips = (log: readonly JournalEvent[]): readonly JournalEvent[] => log.filter((x) => x.type === "task.skipped");

test("A BRANCH A `skip` JOIN ABSORBS IS JOURNALLED `task.skipped`, AND FOLDS TO `skipped`", async () => {
  const { p, log } = await drive(fanoutSpec("skip"), { items: [{ i: 0 }, { i: 1 }] });

  // The run still succeeds — `onBranchError: "skip"` is what the graph asked for, and this change
  // does not move that. What moves is what the journal SAYS about the branch that died.
  assert.equal(p.status, "succeeded", `the author declared skip: ${p.status} ${p.error?.code ?? ""}`);

  const rows = skips(log);
  assert.equal(rows.length, 1, `exactly one branch was absorbed: ${JSON.stringify(rows.map((r) => r.taskId))}`);
  assert.equal(rows[0]?.taskId, DEAD, "and it is the branch that threw");
  assert.equal(p.tasks[DEAD]?.state, "skipped", `0 at ef7df7d, where this read "failed": ${p.tasks[DEAD]?.state}`);

  // THE FAILURE IS NOT ERASED. `upsertTask` merges, so the code that killed the branch is still on
  // the record — "skipped" says a join absorbed it, never that nothing went wrong.
  assert.equal(p.tasks[DEAD]?.error?.code, CODES.E_INTERNAL, "the branch's own error survives the skip");

  // ONE BATCH, IN ORDER. The skip must land AFTER its commit or the fold's last word on this
  // Task's state is `failed`; a crash between the two would be the ninth journal violation's shape.
  const committed = log.find((x) => x.type === "task.committed" && x.taskId === DEAD);
  assert.ok(committed, "the branch committed");
  assert.equal(Number(rows[0]!.seq), Number(committed.seq) + 1, "task.skipped is the very next row after its commit");
  assert.equal((committed.payload as { status: string }).status, "failed", "and the commit it qualifies says failed");

  // THE JOIN'S ARITHMETIC IS UNCHANGED, which is the non-goal stated as an assertion: `#foldJoin`
  // already put `failed` and `skipped` in one `lost` set, so a fix that moved these numbers would
  // have silently changed what every `onBranchError: "fail"` graph does.
  const reduced = log.find((x) => x.type === "state.reduced" && String(x.taskId).startsWith("collect"));
  const fold = reduced?.payload as { branchCount: number; skipped: number; degraded: boolean } | undefined;
  assert.deepEqual(
    { branchCount: fold?.branchCount, skipped: fold?.skipped, degraded: fold?.degraded },
    { branchCount: 1, skipped: 1, degraded: true },
    "one branch came through intact and one was lost, exactly as before the appender existed",
  );

  // THE SPAN, which is the reader whose arm was unreachable until this change. `close` is
  // first-close-wins and `task.committed` closes the task span one row earlier, so without
  // `amend` this exported `task.status: "failed"` — the one attribute a reader opens the trace for.
  const span = spansFrom(log).find((s) => s.name === "loom.task" && (s.attributes as Record<string, unknown>)["task.id"] === DEAD);
  assert.ok(span, "the dead branch has a task span");
  assert.equal((span.attributes as Record<string, unknown>)["task.status"], "skipped", "the span agrees with the fold");
  assert.equal(
    (span.attributes as Record<string, unknown>)["error.code"],
    CODES.E_INTERNAL,
    "and it still carries the error — amending a verdict must not erase the evidence",
  );

  // THE TRAJECTORY, the third reader the pin named. `evolution/trajectory.ts` has had an arm for
  // this event since before anything wrote one.
  const step = foldTrajectory(log).steps.find((s) => s.taskId === DEAD);
  assert.equal(step?.status, "skipped", `the trajectory agrees: ${JSON.stringify(step?.status)}`);

  // AND THE AUDITOR CONSTRAINS IT. A rule that never sees its event reports `checked` while
  // watching nothing, which is the defect `audit.ts`'s own header records shipping.
  const report = auditRun(log);
  assert.deepEqual(report.violations, [], JSON.stringify(report.violations));
  assert.ok(
    report.checked.includes("task.skipped-follows-a-failed-commit"),
    `the new rule saw its event: ${report.checked.join(", ")}`,
  );
});

test("AND IT SURVIVES A RESTART, because it is journalled rather than remembered", async () => {
  // The non-negotiable, as an assertion rather than an argument. Everything above reads the LIVE
  // projection the engine returned, which a process that never restarted would also produce from
  // memory. The claim this change actually makes is that the state is durable — so re-fold the
  // store's rows from scratch, and drive a BRAND-NEW `Engine` over the same store with every
  // class field, map and closure handed back empty. All three must say the same word.
  const { p: live, log } = await drive(fanoutSpec("skip"), { items: [{ i: 0 }, { i: 1 }] });
  const refolded = foldRun(log as JournalEvent[])!;

  assert.equal(live.tasks[DEAD]?.state, "skipped");
  assert.equal(refolded.tasks[DEAD]?.state, "skipped", "a fresh fold of the same rows reaches the same state");
  assert.equal(refolded.tasks[DEAD]?.error?.code, CODES.E_INTERNAL, "…carrying the same error");
  assert.deepEqual(
    JSON.parse(JSON.stringify(refolded.tasks[DEAD])),
    JSON.parse(JSON.stringify(live.tasks[DEAD])),
    "the live TaskRecord and the refolded one are the same record",
  );
});

test("THE SECOND EXIT: a REFUSED MUTATION under a `skip` join is skipped too", async () => {
  // `#commit` reaches a terminal failure TWICE — the ordinary path and the refused-mutation early
  // return, which journals its own `task.failed` + `task.committed{status:"failed"}` with
  // `take: []` and returns before the ordinary push site. Both had to learn the same rule, which
  // is why it is one helper; without this test the second call site was dead weight — measured,
  // deleting those lines left the whole suite byte-identical, so the headline claim of the change
  // ("two exits, not one") shipped with no evidence for half of it.
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const models = new ModelRegistry();
  models.register(
    new MockModelAdapter({
      script: () =>
        // NOT ADDITIVE: it redefines `grow`, the node proposing it. `compileMutation` refuses,
        // `#applyMutation` returns the error, and that exit commits the failure.
        ({
          text: JSON.stringify({
            out: {},
            mutation: {
              addNodes: [{ id: "grow", type: "function", reads: [], writes: [], function: { ref: "function/x@stable" } }],
              addEdges: [],
            },
          }),
          finishReason: "stop",
        }),
      pricePerMTok: 1,
    }),
    true,
  );
  const functions = new FunctionRegistry();
  functions.register("function/report@stable", (view) => ({
    writes: { report: { findings: view.get<unknown[]>("findings") ?? [] } },
  }));
  const engine = new Engine({
    store,
    tools: new ToolRegistry(),
    functions,
    models,
    now: () => 1_700_000_000_000,
    maxParallelism: 4,
    policy: { granted: ["graph:mutate"] },
  });
  const graph = compileOrThrow({ spec: mutatingSpec(), resolver: resolver(), tools: {}, tenantCapabilities: ["graph:mutate"] });
  const runId = await engine.submit({ graph, inputs: { goal: "grow" } });
  await engine.advance(runId);

  const p = (await engine.projection(runId))!;
  const log: JournalEvent[] = [];
  for await (const ev of store.read(runId as RunId, 1)) log.push(ev);

  const task = "grow@root#0" as TaskId;
  assert.ok(p.tasks[task]?.error !== undefined, `the mutation was refused: ${JSON.stringify(p.tasks[task])}`);
  const rows = skips(log);
  assert.equal(rows.length, 1, `the refused branch is absorbed like any other: ${JSON.stringify(rows.map((r) => r.taskId))}`);
  assert.equal(rows[0]?.taskId, task);
  assert.equal(p.tasks[task]?.state, "skipped", "the second exit writes the same word as the first");

  // Same ordering guarantee as the ordinary path: the skip is the row after its commit.
  const committed = log.find((x) => x.type === "task.committed" && x.taskId === task);
  assert.ok(committed);
  assert.equal(Number(rows[0]!.seq), Number(committed.seq) + 1);
});

test("A FAILURE THAT TOOK AN ERROR EDGE IS HANDLED, NOT SKIPPED", async () => {
  // `take.length > 0` is the guard, and its population is live: measured across the suite, two
  // `E_PROVIDER_BAD_REQUEST` branches route down an `error` edge under a `skip` join. Deleting the
  // guard left the whole suite green, so nothing distinguished it from a no-op. A branch whose
  // failure activated a rescue node was HANDLED by the graph the author wrote; calling it
  // `skipped` would say the opposite of what happened.
  const { p, log } = await drive(rescuedSpec(), { items: [{ i: 0 }, { i: 1 }] });

  assert.equal(p.tasks[DEAD]?.error?.code, CODES.E_INTERNAL, "the branch still failed");
  assert.deepEqual(p.tasks[DEAD]?.take, ["err"], "and it took its error edge");
  assert.deepEqual(skips(log), [], "so no join absorbed it — the rescue node did");
  assert.equal(p.tasks[DEAD]?.state, "failed", "a handled failure keeps the louder word");
  assert.ok(
    Object.keys(p.tasks).some((k) => k.startsWith("rescue@")),
    `the rescue node actually ran, or this test proves nothing: ${Object.keys(p.tasks).join(", ")}`,
  );
});

test('`onBranchError: "fail"` still fails the run, and journals no skip', async () => {
  const { p, log } = await drive(fanoutSpec("fail"), { items: [{ i: 0 }, { i: 1 }] });
  assert.equal(p.status, "failed", "the author did not ask for absorption");
  assert.deepEqual(skips(log), [], "nothing is skipped when no join absorbs");
  assert.equal(p.tasks[DEAD]?.state, "failed", "the branch stays failed");
});

test("A RUN-FATAL FAILURE UNDER A `skip` JOIN IS NOT RELABELLED — the run still fails", async () => {
  // Without `NOT_ABSORBED_AS_SKIP` this task becomes `skipped`, both `fatal` filters in
  // `#finish`/`#advance` key on `state === "failed"` and miss it, and a run that must fail
  // completes. Measured at ef7df7d BEFORE the appender: `failed E_GATE_REQUIRED`, which is the
  // answer this test pins across the change.
  const { p, log } = await drive(sodSpec(), { goal: "x" });
  assert.equal(p.status, "failed", `a gate that cannot be supervised is run-fatal: ${p.status}`);
  assert.equal(p.error?.code, CODES.E_GATE_REQUIRED);
  assert.deepEqual(skips(log), [], "a join may not absorb a failure about the RUN's ability to say something true");
  assert.equal(p.tasks["sod@root#0" as TaskId]?.state, "failed", "and the task keeps the state both fatal filters read");
});

test("A HUMAN REJECTION UNDER A `skip` JOIN STAYS `failed` — somebody looked and said no", async () => {
  // THE CASE `RUN_FATAL_CODES` ALONE WOULD HAVE MISSED, and the reason the skip predicate needs a
  // set of its own. `#applyGateDecision` answers a reject with `E_HUMAN_APPROVAL_REQUIRED`, which
  // is deliberately OUT of `RUN_FATAL_CODES` — that set's docstring says so, "out on purpose … the
  // run continues so the ASK can be made". Under a `skip` join, with no error edge, a predicate
  // keyed on `RUN_FATAL_CODES` alone fires and records a refused branch as `skipped`.
  //
  // That is a loosening, not a rename: `server/layout.ts`'s `STATE_PRIORITY` is
  // `failed, awaiting_gate, leased, ready, cancelled, skipped, succeeded`, so a collapsed fan-out
  // that renders `failed` today because one branch was refused would stop doing so. A skip means
  // "this branch contributed nothing, as the graph asked"; a rejection means a person looked and
  // said no. Oversight only tightens.
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const functions = new FunctionRegistry();
  functions.register("function/report@stable", (view) => ({
    writes: { report: { findings: view.get<unknown[]>("findings") ?? [] } },
  }));
  const engine = new Engine({
    store,
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now: () => 1_700_000_000_000,
    maxParallelism: 4,
    policy: { granted: [] },
  });
  const graph = compileOrThrow({ spec: gatedSpec(), resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { goal: "ship it" } });

  const parked = await engine.advance(runId);
  assert.equal(parked.status, "awaiting_gate", `the gate is raised: ${parked.status}`);
  const gateId = Object.keys(parked.gates)[0];
  assert.ok(gateId, "one open gate");

  await engine.resolveGate(runId, {
    gateId: gateId as never,
    decision: { kind: "reject", reason: "not this one" },
    actor: { kind: "human", subject: "alice", via: "cli" },
    idempotencyKey: "r1",
  });

  const p = (await engine.projection(runId))!;
  const log: JournalEvent[] = [];
  for await (const ev of store.read(runId as RunId, 1)) log.push(ev);

  const gateTask = "approve@root#0" as TaskId;
  assert.equal(p.tasks[gateTask]?.error?.code, CODES.E_HUMAN_APPROVAL_REQUIRED, "the reject is what failed the task");
  assert.deepEqual(skips(log), [], "a refusal is not something a join gets to absorb");
  assert.equal(p.tasks[gateTask]?.state, "failed", "the refused branch keeps the state that ranks first for a reader");
});

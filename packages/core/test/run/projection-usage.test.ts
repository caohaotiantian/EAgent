/**
 * WHAT A RESTART IS ALLOWED TO FORGET ABOUT MONEY: nothing.
 *
 * `Engine.attach` re-seeds `PolicyEngine.spentUsd` from `RunProjection.usage.costUsd`
 * (`run/engine.ts` 1237), because a `PolicyEngine` is process-local and a resumed run must
 * not be handed its budget back. That makes this fold's arithmetic a SPENDING LIMIT and not
 * a report, and it was folding spend from `task.committed.usage` alone — a per-attempt
 * summary that is zero on every failure path which had already paid a provider, and absent
 * entirely for an attempt that is retried. Every dollar it missed was a dollar refunded to
 * the run on the way back up.
 *
 * The cases below are in two layers, and both are needed:
 *
 * - the FOLD, over hand-written journals, where each defect is one event apart from its
 *   control — that is where "which record was read" is actually decidable;
 * - the SEAM, over two real `Engine`s and one `MemoryStateStore`, where the number is spent
 *   rather than reported. `A RESTART DOES NOT REFUND THE BUDGET` is sized so that the run
 *   FAILS on budget if the spend survives and SUCCEEDS if it does not — a defect that
 *   flips an outcome, not one that shifts a figure. Measured on the fold as it stood:
 *   the $14-budget run below folded to `costUsd 0` after burning $9, the second process
 *   restored $0, and the run finished having paid the provider $27 — 1.9x its cap.
 *
 * `evolution/score.test.ts` holds the same fold where the number is a SCORE, and
 * `evolution/trajectory.ts` folds the same journal for the corpus. The one number the two
 * folds deliberately disagree about is `wallMs`; see `chargeUsage` in `run/projection.ts`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { compileOrThrow } from "../../src/graph/compile.ts";
import { CODES, err } from "../../src/errors.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import type { NodeId, RunId, TaskId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { foldRun } from "../../src/run/projection.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import type { ToolManifestLite } from "../../src/graph/validate.ts";
import { resolver } from "./skeleton.ts";

// ── the fold ─────────────────────────────────────────────────────────────────

const RUN = "01M0W3NTEGGQ426QT0DX4SDAYX" as RunId;
const CHILD = "01M0W3NTEGGQ426QT0DX4SDAYY" as RunId;
const TASK = "a@root#0" as TaskId;
const AT = 1_700_000_000_000;

const ev = (seq: number, type: string, payload: unknown, taskId?: string): JournalEvent =>
  ({
    runId: RUN,
    seq,
    ts: AT + seq,
    type,
    payload,
    actor: { kind: "system", component: "test" },
    classification: "internal",
    ...(taskId === undefined ? {} : { taskId }),
  }) as unknown as JournalEvent;

/** A bill: `costUsd` is what matters, the rest rides along so the whole record is checkable. */
const bill = (costUsd: number, wallMs = 100) => ({ inputTokens: 10, outputTokens: 5, costUsd, wallMs });
const NOTHING = { inputTokens: 0, outputTokens: 0, costUsd: 0, wallMs: 0 };

const opening = [
  ev(1, "run.submitted", { graphHash: "sha256:x", configDigest: "sha256:y", idempotencyKey: "k", inputs: {} }),
  ev(2, "run.compiled", { graphHash: "sha256:x", nodes: 1, edges: 0, resolutionManifest: [] }),
  ev(3, "run.started", { posture: "on" }),
  ev(4, "task.ready", { nodeId: "a", branchPath: "root", edgesIn: [] }, TASK),
  ev(5, "task.leased", { attempt: 1, workerId: "w0" }, TASK),
];

const modelCalled = (seq: number, costUsd: number, ordinal = 0, taskId: string = TASK) =>
  ev(seq, "model.called", { key: `${taskId}/model/${String(ordinal)}`, provider: "p", model: "m", finishReason: "stop", usage: bill(costUsd) }, taskId);

const committed = (seq: number, status: string, usage: unknown, attempt = 1, taskId: string = TASK) =>
  ev(seq, "task.committed", { attempt, status, take: [], writes: {}, usage }, taskId);

test("A FAILED COMMIT AFTER A PAID CALL KEEPS THE MONEY — the F27 fixture", () => {
  // The provider was called and the journal says so; the commit that follows is a failure
  // and carries `ZERO_USAGE` (`engine.ts` 2459 / 2561 / 4537 all return exactly that).
  // Reading the commit alone folded $0.25 of real spend to $0 — and `engine.ts` 1237 then
  // handed that $0.25 back to the run on the next attach.
  const p = foldRun([...opening, modelCalled(6, 0.25), committed(7, "failed", NOTHING)]);
  assert.equal(p?.usage.costUsd, 0.25, "the call is the record of the spend; the commit is a summary of it");
  assert.equal(p?.tasks[TASK]?.usage.costUsd, 0.25, "and the Task says the same as the run");
});

test("A RETRIED ATTEMPT NEVER COMMITS AT ALL, so its spend has to come from the call", () => {
  // `engine.ts` 4489-4515 writes `task.retry_scheduled` + `task.ready` and no commit, so the
  // first attempt's bill is stated exactly once in the whole journal: on `model.called`.
  const p = foldRun([
    ...opening,
    modelCalled(6, 0.003, 0),
    ev(7, "task.retry_scheduled", { attempt: 1, afterMs: 10, reason: "transient" }, TASK),
    ev(8, "task.leased", { attempt: 2, workerId: "w0" }, TASK),
    modelCalled(9, 0.003, 1),
    committed(10, "succeeded", bill(0.003), 2),
  ]);
  assert.equal(p?.usage.costUsd, 0.006, "two attempts were paid for; the succeeding commit only knows about one");
  assert.equal(p?.tasks[TASK]?.usage.costUsd, 0.006, "`TaskRecord.usage` accumulates across attempts, it does not restate the last one");
});

test("THE ORDINARY PATH IS NOT DOUBLE-COUNTED — the commit and the run total are restatements", () => {
  // The failure mode on the other side of the same line. `task.committed.usage` for a model
  // node is exactly the sum of that task's `model.called` rows (`engine.ts` 3599 is the only
  // place the engine accumulates), and `run.completed.usage` is a copy of the projection's
  // own total (5464). Adding either to the per-call rows bills the run two or three times.
  const p = foldRun([
    ...opening,
    modelCalled(6, 0.004, 0),
    modelCalled(7, 0.006, 1),
    committed(8, "succeeded", bill(0.01, 200)),
    ev(9, "run.completed", { outputs: {}, usage: bill(0.01, 200) }),
  ]);
  assert.equal(p?.usage.costUsd, 0.01, "$0.004 + $0.006, counted once");
  assert.equal(p?.usage.inputTokens, 20);
  assert.equal(p?.usage.outputTokens, 10);
  assert.equal(p?.status, "succeeded", "control: the run really did complete");
});

test("a SUCCEEDED subgraph is counted once, from the event that reports the child", () => {
  const sub = "s@root#0";
  const p = foldRun([
    ev(1, "run.submitted", { graphHash: "sha256:x", configDigest: "sha256:y", idempotencyKey: "k", inputs: {} }),
    ev(2, "run.started", { posture: "on" }),
    ev(3, "task.ready", { nodeId: "s", branchPath: "root", edgesIn: [] }, sub),
    ev(4, "task.leased", { attempt: 1, workerId: "w0" }, sub),
    ev(5, "subgraph.started", { childRunId: CHILD, ref: "c", graphHash: "sha256:c", budgetUsd: null }, sub),
    ev(6, "subgraph.completed", { childRunId: CHILD, ref: "c", status: "succeeded", usage: bill(0.5), outputs: [] }, sub),
    // The subgraph node's own commit restates the child's cost and wall time (`engine.ts` 3852).
    committed(7, "succeeded", { ...NOTHING, costUsd: 0.5, wallMs: 100 }, 1, sub),
  ]);
  assert.equal(p?.usage.costUsd, 0.5, "the child's bill, once");
});

test("a FAILED subgraph's child spend is still charged — the commit is the only row that states it", () => {
  // `engine.ts` appends `subgraph.completed` on the SUCCESS path alone (3901), so when a
  // child fails the parent's only record of its spend is the failing commit (3852). This is
  // why the commit arm survives as an EXCESS rather than being dropped: a three-arm fold
  // that read the effect records and nothing else would have closed two refund paths and
  // opened a third.
  const sub = "s@root#0";
  const p = foldRun([
    ev(1, "run.submitted", { graphHash: "sha256:x", configDigest: "sha256:y", idempotencyKey: "k", inputs: {} }),
    ev(2, "run.started", { posture: "on" }),
    ev(3, "task.ready", { nodeId: "s", branchPath: "root", edgesIn: [] }, sub),
    ev(4, "task.leased", { attempt: 1, workerId: "w0" }, sub),
    ev(5, "subgraph.started", { childRunId: CHILD, ref: "c", graphHash: "sha256:c", budgetUsd: null }, sub),
    committed(6, "failed", { ...NOTHING, costUsd: 0.5, wallMs: 100 }, 1, sub),
  ]);
  assert.equal(p?.usage.costUsd, 0.5, "a child that failed still spent the money");
});

test("a retried subgraph charges the child's CUMULATIVE total once, not once per attempt", () => {
  // `childP.usage` is the child's running total, so attempt 2 restates attempt 1's dollars
  // plus its own. `chargeUsage` remembers per TASK rather than per attempt, so the second
  // restatement contributes only what is new.
  const sub = "s@root#0";
  const p = foldRun([
    ev(1, "run.submitted", { graphHash: "sha256:x", configDigest: "sha256:y", idempotencyKey: "k", inputs: {} }),
    ev(2, "run.started", { posture: "on" }),
    ev(3, "task.ready", { nodeId: "s", branchPath: "root", edgesIn: [] }, sub),
    ev(4, "task.leased", { attempt: 1, workerId: "w0" }, sub),
    committed(5, "failed", { ...NOTHING, costUsd: 1.0 }, 1, sub),
    ev(6, "task.retry_scheduled", { attempt: 1, afterMs: 10, reason: "unavailable" }, sub),
    ev(7, "task.leased", { attempt: 2, workerId: "w0" }, sub),
    committed(8, "succeeded", { ...NOTHING, costUsd: 1.5 }, 2, sub),
  ]);
  assert.equal(p?.usage.costUsd, 1.5, "$1.00 then $0.50 more — the child's own total, not $2.50");
});

test("run.completed RESTATES the total, and a restatement may only raise it", () => {
  // The old fold ASSIGNED `run.completed.usage`, which was a no-op only for as long as the
  // projection was the engine's own source for that field. An assignment would now let the
  // run total overwrite the per-call sum.
  const understated = foldRun([
    ...opening,
    modelCalled(6, 0.25),
    committed(7, "failed", NOTHING),
    ev(8, "run.completed", { outputs: {}, usage: NOTHING }),
  ]);
  assert.equal(understated?.usage.costUsd, 0.25, "a run total that says $0 does not erase a call that says $0.25");

  // …and a journal from a build that had no `model.called` rows to fold still reports its
  // spend, because the restatement is the only thing that states it.
  const legacy = foldRun([
    ...opening,
    committed(6, "succeeded", NOTHING),
    ev(7, "run.completed", { outputs: {}, usage: bill(0.4) }),
  ]);
  assert.equal(legacy?.usage.costUsd, 0.4);
});

test("a row that says NaN or a refund cannot turn a cap into no cap", () => {
  // A journal is written by an appender, and the types are a claim about that appender. One
  // `NaN` dollar makes every later `spent + x > budget` comparison FALSE, which is a budget
  // that refuses nothing — so the component is dropped rather than propagated.
  const poisoned = foldRun([...opening, modelCalled(6, 0.25), committed(7, "failed", bill(Number.NaN))]);
  assert.equal(poisoned?.usage.costUsd, 0.25, "the real spend survives the unreadable restatement");

  const refunded = foldRun([...opening, modelCalled(6, 0.25), modelCalled(7, -1, 1)]);
  assert.equal(refunded?.usage.costUsd, 0.25, "a negative bill is the direction that loosens; it is refused");
});

test("Σ tasks[*].usage equals the run total, so the two views cannot drift", () => {
  const other = "b@root#0";
  const p = foldRun([
    ...opening,
    modelCalled(6, 0.25),
    committed(7, "failed", NOTHING),
    ev(8, "task.ready", { nodeId: "b", branchPath: "root", edgesIn: [] }, other),
    ev(9, "task.leased", { attempt: 1, workerId: "w0" }, other),
    modelCalled(10, 0.1, 0, other),
    committed(11, "succeeded", bill(0.1), 1, other),
  ]);
  const perTask = Object.values(p!.tasks).reduce((a, t) => a + t.usage.costUsd, 0);
  assert.equal(perTask, p!.usage.costUsd);
  assert.equal(p!.usage.costUsd, 0.35);
});

// ── the seam ─────────────────────────────────────────────────────────────────

const TOOLS: Record<string, ToolManifestLite> = {
  "note.read": {
    name: "note.read",
    version: "1.0",
    capabilities: ["fs:read"],
    irreversibility: "read_only",
    idempotent: true,
  },
};

/**
 * One agent node that may take several turns and may be retried.
 *
 * `backoffMs` is long and the clock is frozen, so the first attempt's retry does NOT run
 * inside the same `advance` — which is what leaves a half-spent run on disk for a second
 * process to pick up.
 */
function retryingAgentSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "restart-refund", project: "test", version: 1 },
    policy: { posture: "out", budget: { costUsd: 1000 }, capabilities: ["fs:read"] },
    channels: { goal: { type: "string", reduce: "replace" }, done: { type: "object", reduce: "replace" } },
    inputs: ["goal"],
    outputs: ["done"],
    nodes: [
      {
        id: "work" as NodeId,
        type: "agent",
        reads: ["goal"],
        writes: ["done"],
        agent: {
          profile: "agent_profile/w@stable",
          prompt: "prompt/w@stable",
          maxTurns: 4,
          tools: ["note.read"],
          outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
        },
        retry: { maxAttempts: 3, backoffMs: 60_000 },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

const restartGraph = (): RunGraph =>
  compileOrThrow({ spec: retryingAgentSpec(), resolver: resolver(), tools: TOOLS, tenantCapabilities: ["fs:read"] });

/**
 * THE SIZING, which is the whole test.
 *
 * Every turn bills exactly `TURN_USD` because the script pins `inputTokens` and
 * `outputTokens`; the reservation is an estimate off the prompt, measured below at ≈ $1.05
 * and asserted to stay well under the slack. With a $14 budget:
 *
 * | | spend restored | budget refunded |
 * |---|---|---|
 * | attempt 2, turn 0 | $9 + $9 = $18 committed | $9 committed |
 * | attempt 2, turn 1 | over the cap → `E_BUDGET_EXHAUSTED` | $5 left → answers, run SUCCEEDS |
 *
 * So the defect does not shift a number here, it changes the outcome.
 */
const TURN_USD = 9;
const RESTART_BUDGET = 14;

function restartRig(store: MemoryStateStore, now: () => number, calls: { n: number }) {
  const tools = new ToolRegistry();
  tools.register({
    ...TOOLS["note.read"]!,
    description: "Read a note.",
    parameters: { type: "object", properties: {} },
    execute: () => ({ content: "a note" }),
  } as never);

  const model = new MockModelAdapter({
    pricePerMTok: 1000,
    script: () => {
      calls.n += 1;
      // Call 2 is the first attempt's SECOND turn: the provider drops the connection, which
      // is retryable, so the task is rescheduled and never commits.
      if (calls.n === 2) throw err.unavailable(CODES.E_PROVIDER_TRANSPORT, "transient upstream reset");
      const tokens = { inputTokens: 1000, outputTokens: 8000 };
      return calls.n === 1 || calls.n === 3
        ? { toolCalls: [{ id: "c", name: "note.read", arguments: {} }], finishReason: "tool_use", ...tokens }
        : { text: JSON.stringify({ ok: true }), finishReason: "stop", ...tokens };
    },
  });
  const models = new ModelRegistry();
  models.register(model, true);

  return {
    engine: new Engine({
      store,
      tools,
      functions: new FunctionRegistry(),
      models,
      now,
      policy: { granted: ["fs:read"], systemFloor: "out", budget: { runUsd: RESTART_BUDGET } },
    }),
    model,
  };
}

test("A RESTART DOES NOT REFUND THE BUDGET — spend from a failed attempt is still spent", async () => {
  const clock = { t: AT };
  const store = new MemoryStateStore({ now: () => clock.t });
  const calls = { n: 0 };

  // ── the first process ──
  const first = restartRig(store, () => clock.t, calls);
  const runId = await first.engine.submit({ graph: restartGraph(), inputs: { goal: "x" } });
  const before = await first.engine.advance(runId).catch(() => undefined);

  assert.equal(before?.status, "running", "precondition: the run is unfinished, waiting out a retry backoff");
  assert.equal(before?.usage.costUsd, TURN_USD, "precondition: one turn was paid for");
  assert.equal(calls.n, 2, "precondition: the second turn is what failed");
  const log: JournalEvent[] = [];
  for await (const e of store.read(runId, 1)) log.push(e);
  assert.ok(log.some((e) => e.type === "task.retry_scheduled"), "precondition: the failure was retryable");
  assert.ok(!log.some((e) => e.type === "task.committed"), "PRECONDITION THAT MATTERS: nothing committed, so the money is only on `model.called`");
  const estimate = first.model.estimateOf(first.model.seen[0]!);
  assert.ok(
    estimate < RESTART_BUDGET - 2 * TURN_USD + TURN_USD,
    `precondition: the reservation ($${String(estimate)}) must be small enough that the CAP, not the estimate, is what refuses`,
  );

  // ── the second process, over the same journal ──
  clock.t += 120_000; // past the backoff, so the retry is runnable
  const second = restartRig(store, () => clock.t, calls);
  second.engine.attach(runId, restartGraph());
  const after = await second.engine.advance(runId).catch(() => undefined);

  assert.equal(
    after?.status,
    "failed",
    `a restart must not hand the run its budget back — it had already spent $${String(TURN_USD)} of $${String(RESTART_BUDGET)}`,
  );
  assert.equal(after?.error?.code, "E_BUDGET_EXHAUSTED", "and the cap is what stopped it");
  assert.equal(after?.usage.costUsd, 2 * TURN_USD, "both turns are counted, across the restart");
  assert.equal(calls.n, 3, "the second process got ONE turn out of the run, not two");
});

test("A ZERO-USAGE FAILURE COMMIT IS A REAL ENGINE PATH, not only a hand-written fixture", async () => {
  // `engine.ts` 2459 catches anything thrown out of `#executeTask` and returns
  // `{status:"failed", usage: ZERO_USAGE}` — so a task that had already paid for a turn
  // commits nothing. Driven here rather than assumed: the journal below really does say
  // `model.called $9` and then `task.committed $0`.
  const clock = { t: AT };
  const store = new MemoryStateStore({ now: () => clock.t });
  const calls = { n: 0 };
  const tools = new ToolRegistry();
  tools.register({
    ...TOOLS["note.read"]!,
    description: "Read a note.",
    parameters: { type: "object", properties: {} },
    execute: () => ({ content: "a note" }),
  } as never);
  const models = new ModelRegistry();
  models.register(
    new MockModelAdapter({
      pricePerMTok: 1000,
      script: () => {
        calls.n += 1;
        // A refusal, not a blip: `policy` is not a retryable class, so the task fails outright
        // AFTER the first turn has been paid for and journaled.
        if (calls.n === 2) throw err.policy(CODES.E_CAP_DENIED, "not permitted");
        return {
          toolCalls: [{ id: "c", name: "note.read", arguments: {} }],
          finishReason: "tool_use",
          inputTokens: 1000,
          outputTokens: 8000,
        };
      },
    }),
    true,
  );
  const engine = new Engine({
    store,
    tools,
    functions: new FunctionRegistry(),
    models,
    now: () => clock.t,
    policy: { granted: ["fs:read"], systemFloor: "out", budget: { runUsd: 1000 } },
  });
  const runId = await engine.submit({ graph: restartGraph(), inputs: { goal: "x" } });
  const p = await engine.advance(runId).catch(() => undefined);

  const events: JournalEvent[] = [];
  for await (const e of store.read(runId, 1)) events.push(e);
  const paid = events.filter((e) => e.type === "model.called");
  const commits = events.filter((e) => e.type === "task.committed");
  assert.equal(paid.length, 1, "precondition: one turn was billed");
  assert.equal((paid[0]!.payload as { usage: { costUsd: number } }).usage.costUsd, TURN_USD);
  assert.equal(commits.length, 1, "precondition: and the task committed once");
  assert.equal(
    (commits[0]!.payload as { usage: { costUsd: number } }).usage.costUsd,
    0,
    "PRECONDITION THAT MATTERS: the commit really does carry ZERO_USAGE",
  );

  assert.equal(p?.status, "failed", "control: the refusal did end the run");
  assert.equal(p?.usage.costUsd, TURN_USD, "the money is on the call, and the fold reads the call");
});

test("the run total after a restart is what the second process would resume from", async () => {
  // The value `engine.ts` 1237 reads is `RunProjection.usage.costUsd`, so this is the same
  // number the test above spends — asserted here directly, so a failure says which of the
  // two broke.
  const clock = { t: AT };
  const store = new MemoryStateStore({ now: () => clock.t });
  const calls = { n: 0 };
  const first = restartRig(store, () => clock.t, calls);
  const runId = await first.engine.submit({ graph: restartGraph(), inputs: { goal: "x" } });
  await first.engine.advance(runId).catch(() => undefined);

  const events: JournalEvent[] = [];
  for await (const e of store.read(runId, 1)) events.push(e);
  const folded = foldRun(events);
  assert.equal(folded?.usage.costUsd, TURN_USD, "a cold fold of the journal on disk sees the failed attempt's bill");
  assert.deepEqual(
    events.filter((e) => e.type === "task.committed"),
    [],
    "control: and it is not reading a commit, because there is not one",
  );
});

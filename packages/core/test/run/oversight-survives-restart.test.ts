/**
 * A restart must not lower oversight, and must not refund the budget.
 *
 * `PolicyEngine` held escalations, human ceilings and accumulated spend in memory only,
 * and `Engine.#contextFor` builds a fresh one per attach — so every escalation a run had
 * earned vanished on restart, and the run was handed its full budget again. `attach`'s
 * docstring said "there is deliberately nothing to restore".
 *
 * All three are journaled facts (`policy.escalated`, `policy.deescalated`, and the usage
 * folded from `*.called`), so the fix is not new bookkeeping — it is folding what the
 * journal already had. Invariant 2 in its sharpest form: state that is durable in
 * principle and only in memory in practice is state the journal is not authoritative for.
 *
 * THE CLASS HAS SIX MEMBERS, AND THE SIXTH IS NOT IN THIS FILE — it is
 * `test/run/escalation.test.ts`, "E8 — TAINT SURVIVES A RESTART FOR AN EXTERNALISED CHANNEL
 * TOO", and it is the reason `CLAUDE.md` stopped delegating the count to this file alone. Five
 * are below; the last two of those are at the bottom. Taint
 * was the fourth and E4's failure streak the fifth — both live on `RunContext`, both are
 * written by `Engine.#recordEvidence`, and only one of them was being restored. The lesson
 * that generalises past this file: the unit that needs a restore arm is not the FIELD, it
 * is the PRODUCER. `#restoreEvidence` is named for `#recordEvidence` so a sixth counter
 * added there has one obvious place it is missing from.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { CODES, err } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { foldRun } from "../../src/run/projection.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import type { RunId } from "../../src/ids.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { PolicyEngine } from "../../src/run/policy.ts";
import { compileSkeleton, DOCS, harness, resolver } from "./skeleton.ts";

async function events(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const e of store.read(runId, 1)) out.push(e);
  return out;
}

/** A second Engine over the SAME store — what a process restart looks like. */
function reattach(store: MemoryStateStore): Engine {
  const clock = { t: 1_700_000_000_000 };
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }), pricePerMTok: 1 }), true);
  return new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions: new FunctionRegistry(),
    models,
    now: () => clock.t,
    maxParallelism: 4,
    policy: { granted: ["fs:read", "fs:write"], budget: { runUsd: 1.0 } },
  });
}

test("A HUMAN CEILING SURVIVES A RESTART", async () => {
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const h = harness({ store });
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS.slice(0, 2) } });
  await h.engine.advance(runId);

  await h.engine.deescalate(runId, `run:${runId}`, "on", "operator is watching this one", {
    kind: "human",
    id: "u:alice",
  });

  const revived = reattach(store);
  await revived.attach(runId, compileSkeleton());
  const after = await revived.advance(runId);
  assert.equal(
    after.ceilings[`run:${runId}`],
    "on",
    "a decision a human journaled must survive the process that recorded it",
  );
});

test("PolicyEngine.restore re-seeds without journaling, and only ever tightens", () => {
  const appended: string[] = [];
  const pe = new PolicyEngine({
    granted: [],
    budget: { runUsd: 1 },
    onEscalate: (rule) => appended.push(rule),
  });

  pe.restore({ escalations: { "run:r": "in" }, ceilings: {}, spentUsd: 0.5 });
  assert.deepEqual(appended, [], "replaying the journal must not re-append the events being replayed");
  assert.equal(pe.spentUsd, 0.5, "spend is restored, not reset");

  // Idempotent and monotone: attaching twice must not loosen or double-count.
  pe.restore({ escalations: { "run:r": "out" }, ceilings: {}, spentUsd: 0.2 });
  assert.equal(pe.spentUsd, 0.5, "a second restore must not lower the running total");
});

test("spend survives a restart — the run does not get its budget back", async () => {
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const h = harness({ store });
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS.slice(0, 2) } });
  await h.engine.advance(runId);

  const spent = (await h.engine.projection(runId))!.usage.costUsd;
  assert.ok(spent > 0, "precondition: this run spent something");

  const revived = reattach(store);
  await revived.attach(runId, compileSkeleton());
  const after = await revived.advance(runId);
  assert.ok(
    after.usage.costUsd >= spent,
    `a restart must not refund spend: ${String(spent)} before, ${String(after.usage.costUsd)} after`,
  );
});

test("the fold replays escalate and de-escalate IN SEQ ORDER, not as two max-folds", () => {
  // `deescalate` deletes the escalation AND sets a ceiling. Folding the `to` values as
  // two independent maxima can therefore reconstruct a posture LOWER than the process
  // held — invariant 5 bent by the repair itself.
  const base = { runId: "run_x" as RunId, ts: 1, actor: { kind: "system" as const, id: "policy" } };
  const log = [
    { ...base, seq: 1, type: "run.submitted", payload: { graphHash: "h", inputs: {} } },
    { ...base, seq: 2, type: "policy.escalated", payload: { rule: "e1", from: "out", to: "in", scope: "run:run_x" } },
    { ...base, seq: 3, type: "policy.deescalated", payload: { from: "in", to: "on", scope: "run:run_x", justification: "ok" } },
    { ...base, seq: 4, type: "policy.escalated", payload: { rule: "e2", from: "out", to: "on", scope: "run:run_x" } },
  ] as unknown as JournalEvent[];

  const p = foldRun(log)!;
  assert.equal(p.ceilings["run:run_x"], "on", "the human ceiling stands");
  assert.equal(
    p.escalations["run:run_x"],
    "on",
    "the post-deescalation escalation raises from the floor, not from the deleted `in`",
  );
});

// ── E4's evidence, which is a counter and not a set ───────────────────────────
//
// `repeated_failure` fires on the THIRD consecutive failure of one node. The counter lived
// only in `RunContext.streaks`, so a restart between the second failure and the third reset
// it to zero and the rule never fired — the same graph, the same three failures, the same
// journal, and an escalation that happens or does not depending on whether a process was
// replaced in the middle. Every test below carries its own in-process control, because the
// interesting assertion is that the two runs agree.

const STREAK_SPEC = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "streaks-survive", project: "test", version: 1 },
  policy: {
    posture: "out",
    budget: { costUsd: 1 },
    expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 4, maxLoopIterations: 2 },
  },
  channels: {
    items: { type: "array", reduce: "replace" },
    item: { type: "string", reduce: "replace" },
    results: { type: "array", reduce: "append_ordered" },
    done: { type: "object", reduce: "replace" },
  },
  inputs: ["items"],
  outputs: ["done"],
  nodes: [
    { id: "start", type: "function", reads: ["items"], function: { ref: "function/pass@stable" } },
    {
      id: "flaky",
      type: "function",
      reads: ["item"],
      writes: ["results"],
      function: { ref: "function/flaky@stable" },
      // A LONG BACKOFF ON A FIXED CLOCK IS WHAT MAKES A RESTART POINT EXIST. `advance`
      // returns while a retry is still in backoff, so the test controls where the process
      // boundary falls by moving the clock rather than by racing one.
      retry: { maxAttempts: 6, backoff: "fixed", initialMs: 1000 },
    },
    {
      id: "collect",
      type: "join",
      reads: ["results"],
      writes: ["done"],
      join: { branches: ["flaky"], mode: "all", onBranchError: "skip", timeoutMs: 100_000 },
    },
  ],
  edges: [
    { id: "fan", from: "start", to: "flaky", kind: "fanout", over: "items", as: "item", maxWidth: 2 },
    { id: "j", from: "flaky", to: "collect", kind: "join", branches: ["flaky"] },
  ],
};

const streakGraph = () =>
  compileOrThrow({ spec: STREAK_SPEC as never, resolver: resolver(), tools: {}, tenantCapabilities: [] });

/**
 * An Engine over `store` whose `flaky` node fails, by item.
 *
 * Dispatch is by item, so one graph covers every shape the fold has to reproduce:
 * `"ok"` SUCCEEDS, `"perm"` fails in a class nothing retries so its failure COMMITS, and
 * anything else fails retryably so its failure is RESCHEDULED. The three exits journal three
 * different things and the live counter reads all of them, which is why the restore has two
 * arms and why one of them has to read `status` rather than count rows.
 */
function streakEngine(store: MemoryStateStore, clock: { t: number }, calls: { n: number }): Engine {
  const functions = new FunctionRegistry();
  functions.register("function/pass@stable", () => ({}));
  functions.register("function/flaky@stable", (view) => {
    calls.n += 1;
    // `StateView` is `{get, require, hash, visible}`, NOT a bag: `view["item"]` reads
    // `undefined` and every branch then takes the same arm, which is how the first draft
    // of this test asserted its precondition against a shape it had never produced.
    const item = String(view.get("item"));
    if (item === "ok") return { writes: { results: ["fine"] } };
    if (item === "perm") throw err.validation(CODES.E_RESOURCE_INVALID, "permanently the wrong shape");
    throw err.unavailable(CODES.E_TOOL_SOURCE_UNAVAILABLE, "transient");
  });
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);
  return new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models,
    now: () => clock.t,
    sleep: async () => {},
    maxParallelism: 2,
    policy: { granted: [], budget: { runUsd: 1 } },
  });
}

async function escalatedRules(store: MemoryStateStore, runId: RunId): Promise<string[]> {
  return (await events(store, runId))
    .filter((e) => e.type === "policy.escalated")
    .map((e) => String((e.payload as { rule?: unknown }).rule));
}

test("E4's STREAK SURVIVES A RESTART — two failures, a new process, a third", async () => {
  const clock = { t: 1_700_000_000_000 };
  const store = new MemoryStateStore({ now: () => clock.t });
  const calls = { n: 0 };

  const first = streakEngine(store, clock, calls);
  const runId = await first.submit({ graph: streakGraph(), inputs: { items: ["one"] } });
  await first.advance(runId).catch(() => undefined);
  clock.t += 10_000;
  await first.advance(runId).catch(() => undefined);
  clock.t += 10_000;

  assert.deepEqual(
    await escalatedRules(store, runId),
    [],
    "precondition: two failures are not yet a streak, or the restart proves nothing",
  );

  // THE RESTART: a second Engine over the same journal, exactly as `reattach` above.
  const revived = streakEngine(store, clock, calls);
  await revived.attach(runId, streakGraph());
  await revived.advance(runId).catch(() => undefined);

  assert.equal(calls.n, 3, `precondition: three attempts ran, saw ${String(calls.n)}`);
  assert.ok(
    (await escalatedRules(store, runId)).includes("repeated_failure"),
    "three consecutive failures are three consecutive failures, whoever is holding the counter",
  );
});

test("CONTROL — the same three failures in ONE process escalate", async () => {
  // Not decoration. The first version of the test above passed against the unfixed engine
  // for a while because the rig was not reaching three attempts at all, and a rig that
  // cannot fire E4 proves nothing about a restart.
  const clock = { t: 1_700_000_000_000 };
  const store = new MemoryStateStore({ now: () => clock.t });
  const calls = { n: 0 };

  const engine = streakEngine(store, clock, calls);
  const runId = await engine.submit({ graph: streakGraph(), inputs: { items: ["one"] } });
  for (let i = 0; i < 3; i += 1) {
    await engine.advance(runId).catch(() => undefined);
    clock.t += 10_000;
  }

  assert.equal(calls.n, 3, `precondition: three attempts ran, saw ${String(calls.n)}`);
  assert.ok(
    (await escalatedRules(store, runId)).includes("repeated_failure"),
    "the rig can fire E4 without a restart",
  );
});

test("THE RESTORED STREAK COUNTS A COMMITTED FAILURE AND A RETRIED ONE", async () => {
  // The fold has two arms because the live counter is updated ahead of BOTH commit exits:
  // `task.retry_scheduled` for a failure that will be tried again, `task.committed` for one
  // that will not. Folding either alone restores 1 instead of 2 here, and the third failure
  // then reads as the second — so this test goes red for a missing arm of either kind.
  //
  // One branch fails permanently and commits; the other fails transiently and is rescheduled.
  // A committed-failure-only shape is not reachable: a node whose failures have all committed
  // has no work left to fail a third time, so there is nothing for a restart to sit in front of.
  const clock = { t: 1_700_000_000_000 };
  const store = new MemoryStateStore({ now: () => clock.t });
  const calls = { n: 0 };

  const first = streakEngine(store, clock, calls);
  const runId = await first.submit({ graph: streakGraph(), inputs: { items: ["perm", "transient"] } });
  await first.advance(runId).catch(() => undefined);
  clock.t += 10_000;

  const before = await events(store, runId);
  assert.equal(
    before.filter((e) => e.type === "task.retry_scheduled").length,
    1,
    "precondition: exactly one failure was rescheduled",
  );
  assert.equal(
    before.filter((e) => e.type === "task.committed" && (e.payload as { status?: unknown }).status === "failed").length,
    1,
    "precondition: exactly one failure was committed",
  );
  assert.deepEqual(await escalatedRules(store, runId), [], "precondition: two failures, not yet a streak");

  const revived = streakEngine(store, clock, calls);
  await revived.attach(runId, streakGraph());
  await revived.advance(runId).catch(() => undefined);

  assert.ok(
    (await escalatedRules(store, runId)).includes("repeated_failure"),
    "a failure that was retried counts exactly as much as one that was committed",
  );
});

test("A SUCCESS BEFORE THE RESTART STILL RESETS THE STREAK", async () => {
  // The arm the first mutation sweep did not kill. A fold that counted every
  // `task.committed` as a failure — ignoring `status` — passed all three tests above,
  // because none of them journaled a SUCCESS for the failing node. That fold turns E4
  // into an alarm that fires on a node which failed, recovered, and failed twice more,
  // and an alarm that fires wrongly is one people learn to ignore.
  //
  // Branch order is branch-coordinate order and the precondition below pins it: `x` fails
  // and is rescheduled, then `ok` succeeds and resets the node's streak to zero. Three
  // failures of `x` follow across a restart and must still not reach the threshold, because
  // they were not CONSECUTIVE.
  const clock = { t: 1_700_000_000_000 };
  const store = new MemoryStateStore({ now: () => clock.t });
  const calls = { n: 0 };

  const first = streakEngine(store, clock, calls);
  const runId = await first.submit({ graph: streakGraph(), inputs: { items: ["x", "ok"] } });
  await first.advance(runId).catch(() => undefined);
  clock.t += 10_000;

  const wave1 = (await events(store, runId))
    .filter((e) => (e.type === "task.committed" || e.type === "task.retry_scheduled") && String(e.taskId).startsWith("flaky"))
    .map((e) => (e.type === "task.retry_scheduled" ? "retry" : String((e.payload as { status?: unknown }).status)));
  assert.deepEqual(
    wave1,
    ["retry", "succeeded"],
    "precondition: the failure lands BEFORE the success, or this asserts nothing about a reset",
  );

  const revived = streakEngine(store, clock, calls);
  await revived.attach(runId, streakGraph());
  for (let i = 0; i < 2; i += 1) {
    await revived.advance(runId).catch(() => undefined);
    clock.t += 10_000;
  }

  assert.ok(calls.n >= 4, `precondition: the node ran again after the restart, saw ${String(calls.n)} calls`);
  assert.deepEqual(
    await escalatedRules(store, runId),
    [],
    "a node that failed, recovered, then failed twice has not failed three times in a row",
  );
});

test("CONTROL — the same shape with NO success DOES escalate", async () => {
  // The positive control for the test above: identical graph, identical restart, identical
  // number of advances, with the succeeding item swapped for a failing one. Without this,
  // "no escalation" is a result a permanently broken rig would also produce.
  const clock = { t: 1_700_000_000_000 };
  const store = new MemoryStateStore({ now: () => clock.t });
  const calls = { n: 0 };

  const first = streakEngine(store, clock, calls);
  const runId = await first.submit({ graph: streakGraph(), inputs: { items: ["x", "y"] } });
  await first.advance(runId).catch(() => undefined);
  clock.t += 10_000;

  const revived = streakEngine(store, clock, calls);
  await revived.attach(runId, streakGraph());
  for (let i = 0; i < 2; i += 1) {
    await revived.advance(runId).catch(() => undefined);
    clock.t += 10_000;
  }

  assert.ok(
    (await escalatedRules(store, runId)).includes("repeated_failure"),
    "the rig reaches the threshold when the failures ARE consecutive",
  );
});

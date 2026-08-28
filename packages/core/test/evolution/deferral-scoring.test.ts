/**
 * WHAT A PROVIDER RATE LIMIT DOES TO THE EVIDENCE, MEASURED RATHER THAN ASSUMED.
 *
 * A 429 is a deferral: the node's work never ran, so the Task is requeued without charging an
 * attempt. Two consequences were recorded as residues when that landed and neither had been
 * measured. This file measures both, and pins the answers — including the one that is a
 * deliberate cost rather than a defect, because the next reader will otherwise "fix" it.
 *
 * 1 · A DEFERRAL COUNTS TOWARD E4's CONSECUTIVE-FAILURE STREAK, AND IT MUST.
 *    `#recordEvidence` runs BEFORE the retry decision, so it cannot know that the failure it
 *    is recording will turn out to be a deferral. Three rate limits in a row therefore
 *    escalate `repeated_failure` and tighten the node's posture, where the same three
 *    interleaved with successes do not. That is a rate-limit outage escalating a node sooner
 *    than a code change would. IT IS LEFT ALONE ON PURPOSE: making E4 skip deferrals would
 *    mean an automated path deciding not to tighten, and CLAUDE.md's "oversight only tightens
 *    / refusing is always allowed, loosening never is" makes that the one direction this code
 *    may not move. A human may lower the posture afterwards; the engine may not decline to
 *    raise it. The test below is what stops the "fix" from landing quietly.
 *
 * 2 · A DEFERRAL DOES NOT DISTORT THE SCORE, AND THE REASON IS NOT THE ONE YOU WOULD GUESS.
 *    `trajectory.ts` folds `attempts` from `task.retry_scheduled.attempt`, which a deferral
 *    leaves unchanged, so a deferred run and a clean run are the same strategy — that much was
 *    stated. The open question was the EFFICIENCY terms: `costNormalized` and
 *    `latencyNormalized` are ratios to the cohort's p50, and "a run that waited fifteen
 *    minutes on rate limits and a run that sailed through are not equally good".
 *
 *    MEASURED (the assertions below print the numbers): the deferred run and the clean run
 *    fold to IDENTICAL `usage.wallMs` and `usage.costUsd`, and score identically. The waiting
 *    is invisible to the score because `usage.wallMs` is summed from `model.called.usage.wallMs`
 *    plus `tool.called.ms` — the time a provider or a tool spent WORKING — and a deferral is
 *    time nobody worked: no `model.called` row is appended for a call that raised a 429, and
 *    the wait itself is the scheduler's, journaled as `task.retry_scheduled.afterMs` and read
 *    by nothing this fold consults.
 *
 *    THAT IS THE RIGHT ANSWER FOR THIS METRIC, and the argument is the same one the file
 *    header already makes about retries. The score compares STRATEGIES, and the cohort is
 *    keyed on `(workflow, graphHash, tier, inputBucket)` — every member is the same graph, so
 *    a provider's rate limit is noise the cohort's own members are equally exposed to, and
 *    charging it to whichever run happened to hit it would rank strategies by luck. A
 *    trajectory that scored a rate-limit outage against the strategy would make the fold's own
 *    stated rule — "two runs of one strategy, one of which hit a flaky network, must not look
 *    like two strategies" — true of `attempts` and false of `score`.
 *
 *    WHAT IS THEREFORE NOT MEASURED BY THIS SCORE, stated rather than left for someone to
 *    discover: end-to-end elapsed time. `usage.wallMs` is BUSY time, not wall time, and it has
 *    never been anything else — a Task suspended on a human gate for a day is invisible to it
 *    for exactly the same reason. An operator who wants "how long until the answer arrived"
 *    reads the journal's timestamps, not a trajectory.
 *
 *    THE ONE WAY A DEFERRAL COULD HAVE COST MONEY WAS RULED OUT BY MEASUREMENT, not by
 *    argument — an agent already several PAID turns deep when the 429 lands. Section 3 is that
 *    run, with its journal transcribed: the re-executed attempt serves every effect it already
 *    recorded and re-runs only the one that failed, so the deferral re-buys nothing. That is
 *    the "recorded under a derived key, replay serves the record" invariant doing the work.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { CODES, err } from "../../src/errors.ts";
import { DEFAULT_WEIGHTS, cohortKeyOf, measureCohort, scoreTrajectory } from "../../src/evolution/score.ts";
import { foldTrajectory, type Trajectory } from "../../src/evolution/trajectory.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import type { RunId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import {
  FunctionRegistry,
  MockModelAdapter,
  ModelRegistry,
  ToolRegistry,
  type MockScript,
  type ToolDefinition,
} from "../../src/run/registry.ts";
import type { ToolManifestLite } from "../../src/graph/validate.ts";
import { resolver } from "../run/skeleton.ts";

/** One agent node, so the only variable is what the provider did to that one Task. */
function spec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "rate-limited-scoring", project: "evolution", version: 1 },
    policy: { posture: "out", budget: { costUsd: 5 } },
    channels: { result: { type: "string", reduce: "replace" } },
    inputs: [],
    outputs: ["result"],
    nodes: [
      {
        id: "ask",
        type: "agent",
        writes: ["result"],
        unhandled: true,
        agent: { profile: "agent_profile/a@stable", prompt: "prompt/p@v1", maxTurns: 3 },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

const RATE_LIMIT = (retryAfterMs: number): never => {
  throw err.exhausted(CODES.E_PROVIDER_RATE_LIMIT, "provider rate limit (429)", {
    details: { status: 429 },
    retryAfterMs,
  });
};

async function eventsOf(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const e of store.read(runId, 1)) out.push(e);
  return out;
}

/**
 * Drive one run to a terminal state, moving the INJECTED clock across each backoff. Nothing
 * here reads the wall clock: `sleep` is a no-op and `now` is a variable.
 */
async function runWith(script: MockScript): Promise<{ trajectory: Trajectory; events: JournalEvent[] }> {
  let t = 1_700_000_000_000;
  const store = new MemoryStateStore({ now: () => t });
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script, pricePerMTok: 1 }), true);
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions: new FunctionRegistry(),
    models,
    now: () => t,
    sleep: async () => {},
    resolver: resolver(),
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 5 } },
  });
  const graph = compileOrThrow({ spec: spec(), resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: {} });
  let p = await engine.advance(runId).catch(async () => (await engine.projection(runId))!);
  for (let i = 0; i < 40 && p.status === "running"; i++) {
    t += 600_000;
    p = await engine.advance(runId).catch(async () => (await engine.projection(runId))!);
  }
  assert.equal(p.status, "succeeded", `journal:\n${(await eventsOf(store, runId)).map((e) => e.type).join("\n")}`);
  const events = await eventsOf(store, runId);
  return { trajectory: foldTrajectory(events, { graph }), events };
}

/** Succeeds on the first call. */
const CLEAN: MockScript = () => ({ text: '{"ok":true}', finishReason: "stop" as const });

/** Three 429s, each asking for five minutes, then the identical answer the clean run gives. */
function deferring(times: number): MockScript {
  let calls = 0;
  return () => {
    calls += 1;
    if (calls <= times) RATE_LIMIT(300_000);
    return { text: '{"ok":true}', finishReason: "stop" as const };
  };
}

// ── 1 · E4 still counts a deferral, and that is the tightening direction ─────

test("A DEFERRAL STILL COUNTS TOWARD E4 — not counting it would be an automated loosening", async () => {
  const clean = await runWith(CLEAN);
  const deferred = await runWith(deferring(3));

  const rulesOf = (t: Trajectory): readonly string[] => t.policy.escalations;
  assert.deepEqual(rulesOf(clean.trajectory), [], "a clean run escalates nothing");
  assert.ok(
    rulesOf(deferred.trajectory).includes("repeated_failure"),
    `three deferrals must still raise E4 — got ${JSON.stringify(rulesOf(deferred.trajectory))}. ` +
      "If you came here to stop them counting: that is oversight declining to tighten on an " +
      "automated path, which CLAUDE.md forbids. Lower the posture by hand instead.",
  );
});

test("THE DEFERRALS ARE REAL — journaled as deferrals, and they did not advance the attempt", async () => {
  const deferred = await runWith(deferring(3));
  const scheduled = deferred.events
    .filter((e) => e.type === "task.retry_scheduled")
    .map((e) => e.payload as { attempt: number; deferred?: boolean });
  assert.equal(scheduled.length, 3, JSON.stringify(scheduled));
  assert.deepEqual(
    scheduled.map((s) => s.deferred),
    [true, true, true],
  );
  // The whole of "a rate limit is not charged to the node", read back off the journal: the
  // Task's attempt counter never leaves the attempt it started on.
  assert.deepEqual(
    scheduled.map((s) => s.attempt),
    [0, 0, 0],
  );
});

// ── 2 · what a deferral does to the SCORE ───────────────────────────────────

test("a deferred run folds to the same strategy as a clean one — one step, one attempt", async () => {
  const clean = await runWith(CLEAN);
  const deferred = await runWith(deferring(3));
  assert.deepEqual(
    deferred.trajectory.steps.map((s) => ({ node: String(s.nodeId), attempts: s.attempts, status: s.status })),
    clean.trajectory.steps.map((s) => ({ node: String(s.nodeId), attempts: s.attempts, status: s.status })),
  );
});

test("MEASURED: fifteen minutes of rate limiting moves neither the cost term nor the latency term", async () => {
  const clean = await runWith(CLEAN);
  const deferred = await runWith(deferring(3));

  // The waiting is on the journal, and it is not small — 3 x 300 s the scheduler was told to wait.
  const waited = deferred.events
    .filter((e) => e.type === "task.retry_scheduled")
    .reduce((n, e) => n + (e.payload as { afterMs: number }).afterMs, 0);
  assert.equal(waited, 900_000, "the run really did defer fifteen minutes");

  // …and none of it reaches the fold's usage, because `usage.wallMs` is BUSY time.
  assert.deepEqual(
    { wallMs: deferred.trajectory.usage.wallMs, costUsd: deferred.trajectory.usage.costUsd },
    { wallMs: clean.trajectory.usage.wallMs, costUsd: clean.trajectory.usage.costUsd },
    "a deferral must not be charged to the strategy — every member of a cohort runs the same graph",
  );

  // The scores, computed against a cohort holding both, so the p50s are shared.
  const both = [clean.trajectory, deferred.trajectory];
  const cohort = measureCohort(cohortKeyOf(clean.trajectory), both, { weights: DEFAULT_WEIGHTS });
  const a = scoreTrajectory(clean.trajectory, cohort);
  const b = scoreTrajectory(deferred.trajectory, cohort);
  assert.equal(cohortKeyOf(deferred.trajectory), cohortKeyOf(clean.trajectory), "and they are one cohort");
  assert.deepEqual(
    { score: b.score, cost: b.components.costNormalized, latency: b.components.latencyNormalized },
    { score: a.score, cost: a.components.costNormalized, latency: a.components.latencyNormalized },
  );
});

test("a 429 that never became a model turn is not billed and is not counted as a call", async () => {
  const clean = await runWith(CLEAN);
  const deferred = await runWith(deferring(3));
  // The evidence for the header's claim about WHY the terms do not move: no `model.called`
  // row exists for a call that raised a 429, so there is nothing for `charge` to add.
  assert.equal(deferred.events.filter((e) => e.type === "model.called").length, 1);
  assert.equal(deferred.trajectory.usage.modelCalls, clean.trajectory.usage.modelCalls);
});

// ── 3 · the defeat attempt: a 429 that lands after money is already spent ────

/**
 * THE HYPOTHESIS THIS TEST WAS WRITTEN TO CONFIRM, AND THE MEASUREMENT THAT REFUTED IT.
 *
 * The tests above use a single-turn agent, where the 429 arrives before anything is billed.
 * The obvious worry was the multi-turn case: an agent several PAID turns deep when the
 * provider rate-limits it, whose deferral throws the attempt away and re-runs the node from
 * turn zero. The run would then have paid twice for one strategy, `task.committed` is never
 * appended for a deferred attempt so the only record would be the abandoned `model.called`
 * rows, and a fold that counted them would price the strategy above a clean run of itself.
 *
 * IT DOES NOT HAPPEN, and the reason is a non-negotiable one level down: every
 * nondeterministic call is recorded under a derived key and replay serves the record. The
 * re-executed attempt re-enters `#executeTask` at turn zero, finds the model turn and the
 * tool call it already made under the same effect keys, and serves both from the journal. It
 * re-runs exactly the one effect that FAILED. So a deferral costs no money at all, and the
 * asymmetry to guard is the opposite of the one expected: the paid turn must be counted ONCE,
 * not twice and not zero times.
 *
 * `trajectory.ts` gets that for free by charging where the call is recorded and never resetting
 * `spend` on `task.retry_scheduled` — only `actions` is cleared there. The journal below is the
 * evidence, transcribed from this run rather than argued from the code.
 */
const TURN_TOOLS: Record<string, ToolManifestLite> = {
  "note.read": {
    name: "note.read",
    version: "1.0",
    capabilities: ["fs:read"],
    irreversibility: "read_only",
    idempotent: true,
  },
};

function multiTurnSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "deferred-mid-turn", project: "evolution", version: 1 },
    policy: { posture: "out", budget: { costUsd: 5 }, capabilities: ["fs:read"] },
    channels: { done: { type: "object", reduce: "replace" } },
    inputs: [],
    outputs: ["done"],
    nodes: [
      {
        id: "work",
        type: "agent",
        writes: ["done"],
        unhandled: true,
        agent: {
          profile: "agent_profile/a@stable",
          prompt: "prompt/p@v1",
          maxTurns: 4,
          tools: ["note.read"],
          outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
        },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

test("A DEFERRAL AFTER A PAID TURN RE-BUYS NOTHING — each turn is billed exactly once", async () => {
  let t = 1_700_000_000_000;
  const store = new MemoryStateStore({ now: () => t });
  const tools = new ToolRegistry();
  tools.register({
    ...TURN_TOOLS["note.read"]!,
    description: "Read a note.",
    parameters: { type: "object", properties: { id: { type: "string" } } },
    execute: () => ({ content: "a note" }),
  } satisfies ToolDefinition);

  // Turn 0 of the first attempt is a paid tool turn; turn 1 raises the 429. The Task is
  // requeued and starts again at turn 0, and the second attempt answers on its second turn.
  let rateLimited = false;
  const models = new ModelRegistry();
  models.register(
    new MockModelAdapter({
      pricePerMTok: 1,
      script: (_req, turn) => {
        if (turn === 1 && !rateLimited) {
          rateLimited = true;
          RATE_LIMIT(300_000);
        }
        return turn === 0
          ? {
              toolCalls: [{ id: `c${String(turn)}`, name: "note.read", arguments: { id: "n" } }],
              finishReason: "tool_use" as const,
            }
          : { text: JSON.stringify({ ok: true }), finishReason: "stop" as const };
      },
    }),
    true,
  );

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models,
    now: () => t,
    sleep: async () => {},
    resolver: resolver(),
    policy: { granted: ["fs:read"], systemFloor: "out", budget: { runUsd: 5 } },
  });
  const graph = compileOrThrow({
    spec: multiTurnSpec(),
    resolver: resolver(),
    tools: TURN_TOOLS,
    tenantCapabilities: ["fs:read"],
  });
  const runId = await engine.submit({ graph, inputs: {} });
  let p = await engine.advance(runId).catch(async () => (await engine.projection(runId))!);
  for (let i = 0; i < 40 && p.status === "running"; i++) {
    t += 600_000;
    p = await engine.advance(runId).catch(async () => (await engine.projection(runId))!);
  }
  const log = await eventsOf(store, runId);
  assert.equal(p.status, "succeeded", `journal:\n${log.map((e) => e.type).join("\n")}`);

  // The premise: it really did defer, and it really had paid for a turn before it did.
  const scheduled = log.filter((e) => e.type === "task.retry_scheduled").map((e) => e.payload as { deferred?: boolean });
  assert.deepEqual(
    scheduled.map((s) => s.deferred),
    [true],
    JSON.stringify(scheduled),
  );
  // THE JOURNAL THIS RUN ACTUALLY WROTE, and it is the answer to the question above.
  // Nothing between the deferral and the commit re-ran turn 0 or the tool:
  //
  //     7  effect.started      turn 0's model call
  //     8  model.called        …billed, once
  //     9  effect.completed
  //     10 effect.started      the tool the turn asked for
  //     11 tool.called
  //     12 effect.completed
  //     13 effect.started      turn 1's model call
  //     14 effect.failed       the 429
  //     15 task.retry_scheduled  deferred: true, attempt unchanged
  //     16 task.ready · 17 task.leased · 18 policy.decided
  //     19 effect.started      turn 1 again — turn 0 and the tool were SERVED FROM THEIR
  //     20 model.called        effect records, so neither re-ran and neither re-billed
  //     21 effect.completed
  //     22 task.committed
  assert.deepEqual(
    log.filter((e) => e.type === "model.called" || e.type === "tool.called").map((e) => e.type),
    ["model.called", "tool.called", "model.called"],
    "the re-executed attempt must replay the recorded effects rather than re-buying them",
  );

  const trajectory = foldTrajectory(log, { graph });
  assert.deepEqual(
    { m: trajectory.usage.modelCalls, t: trajectory.usage.toolCalls },
    { m: 2, t: 1 },
    "each turn is counted exactly once across the deferral",
  );
  // The projection is the independent witness: `run/projection.ts` charges the same four arms.
  assert.equal(trajectory.usage.costUsd, p.usage.costUsd, "the fold must not under-bill a deferred attempt");
  assert.ok(trajectory.usage.costUsd > 0);
  // …and the deferral still did not fork one strategy into two.
  assert.deepEqual(
    trajectory.steps.map((s) => s.attempts),
    [1],
  );
});

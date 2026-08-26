/**
 * THE SCORE HAS TO SURVIVE DELEGATION — both halves of it.
 *
 * Every fixture here drives a REAL `Engine` over a real journal. That is the point of the
 * file: the two defects it pins were both invisible to hand-built trajectories, because a
 * hand-built one is written by whoever is also writing the fold, and it therefore has exactly
 * the rows the fold already reads. The shapes the PRODUCT produces are the ones that broke.
 *
 * | Claim | The move it closes |
 * |---|---|
 * | A delegated run scores like the same work inline | The multi-agent shape scoring a constant 0 |
 * | A `function`-only graph that writes its output did work | A whole class of workflow priced as a no-op |
 * | A failed subgraph's child spend is still counted | *Fail your subgraph and look cheap* |
 * | A no-op success still scores 0 | Reach the last node having produced nothing, look efficient |
 * | A cheap real success still beats an expensive one | A metric that has stopped discriminating |
 *
 * WHERE THESE DEFECTS ACTUALLY CAME FROM, corrected 2026-08-25 after the first version of this
 * docstring attributed them to `86b84c9` and a verifier disproved every non-zero cell against a
 * real `git archive` of that commit. **They were introduced by the two fix rounds that preceded
 * this one, not inherited.** At `86b84c9` `foldTrajectory` charged cost at THREE arms —
 * `run.completed`, `model.called` and `task.committed` — so it OVER-counted by 2–3x on six of
 * eight fixtures, and a failed subgraph's spend was counted (over-counted, at $10.03 against a
 * projection of $5.01). Round 1 removed the over-count; round 2 removed the `task.committed` arm
 * along with it and turned the over-count into a 500x UNDER-count, which is the direction that
 * rewards failing. Measured, same fixtures, shipped tree against a true 86b84c9 archive:
 *
 * ```
 *                                shipped traj/proj      86b84c9 traj/proj
 * inline                          0.001 / 0.001  ok      0.003 / 0.001  3x over
 * delegated (subgraph)            0.001 / 0.001  ok      0.002 / 0.001  2x over
 * failed subgraph → fallback      5.01  / 5.01   ok     10.03  / 5.01   2x over
 * ```
 *
 * The point that survives the correction: **a fold that disagrees with `run/projection.ts` is
 * wrong in one direction or the other**, and only comparing the two catches it. Shipped agrees
 * on all eight; `86b84c9` disagreed on six.
 *
 * The last two are the properties the previous two fix rounds traded away, and they are in
 * this file rather than only in `score.test.ts` so that no round can restore one half without
 * the other half's Engine-level fixture disagreeing.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { digest } from "../../src/canonical.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";
import type { RunId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import type { RunProjection } from "../../src/run/projection.ts";
import {
  FunctionRegistry,
  MockModelAdapter,
  ModelRegistry,
  ToolRegistry,
  type MockScript,
} from "../../src/run/registry.ts";
import { foldTrajectory, type Trajectory } from "../../src/evolution/trajectory.ts";
import { measureCohort, scoreTrajectory } from "../../src/evolution/score.ts";

const NOW = 1_700_000_000_000;

/**
 * A DISTINCT DIGEST PER REF, and a document whose TEXT names the ref.
 *
 * The text matters: the fixtures below run two different agents against one adapter, and the
 * script tells them apart by the prompt it was handed. A uniform document would make the
 * expensive child and the cheap fallback indistinguishable, which is exactly the fixture that
 * cannot measure a 500× under-count.
 */
function resolver(subs: Record<string, GraphSpec> = {}): ResourceResolver {
  const minted = new Map<string, string>();
  return {
    resolve(ref) {
      if (!/^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref)) return undefined;
      const d = digest({ fixture: "fx11", ref });
      minted.set(d, ref);
      return { ref, digest: d, channel: "stable" };
    },
    document: (d) => (minted.has(d) ? `Instructions for ${minted.get(d)!}` : undefined),
    subgraph: (ref) => subs[ref],
  };
}

const agentNode = (id: string, prompt: string, reads: string[], writes: string[]): unknown => ({
  id,
  type: "agent",
  reads,
  writes,
  agent: { profile: "agent_profile/w@stable", prompt, maxTurns: 1 },
  retry: { maxAttempts: 1 },
});

const base = (name: string, over: Record<string, unknown>): GraphSpec =>
  ({
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name, project: "fx11", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 2, maxLoopIterations: 1 } },
    ...over,
  }) as unknown as GraphSpec;

const IO = {
  channels: { topic: { type: "string", reduce: "replace" }, answer: { type: "string", reduce: "replace" } },
  inputs: ["topic"],
  outputs: ["answer"],
};

/** One agent node. Used as a child, and — the same nodes, undelegated — as the control. */
const INLINE = base("inline", { ...IO, nodes: [agentNode("work", "prompt/work@stable", ["topic"], ["answer"])], edges: [] });

/** One `subgraph` node over exactly that child. */
const DELEGATED = base("delegated", {
  channels: { topic: { type: "string", reduce: "replace" }, result: { type: "string", reduce: "replace" } },
  inputs: ["topic"],
  outputs: ["result"],
  nodes: [
    {
      id: "delegate",
      type: "subgraph",
      reads: ["topic"],
      writes: ["result"],
      subgraph: { ref: "graph/child@stable", inputs: { topic: "topic" }, outputs: { result: "answer" } },
      retry: { maxAttempts: 1 },
    },
  ],
  edges: [],
});

/** A body that commits its declared output. Bills nothing, and is not a no-op. */
const FUNCTION_ONLY = base("fnonly", {
  ...IO,
  nodes: [{ id: "compute", type: "function", reads: ["topic"], writes: ["answer"], function: { ref: "function/compute@stable" } }],
  edges: [],
});

/** The real no-op: it reaches its last node, calls nothing, and writes nothing. */
const NOOP = base("noop", {
  ...IO,
  outputs: [],
  nodes: [{ id: "compute", type: "function", reads: ["topic"], writes: [], function: { ref: "function/noop@stable" } }],
  edges: [],
});

/** A child that burns, then fails its own output schema so the child RUN fails. */
const BURN = base("burn", {
  ...IO,
  nodes: [
    {
      ...(agentNode("burn", "prompt/burn@stable", ["topic"], ["answer"]) as Record<string, unknown>),
      agent: {
        profile: "agent_profile/w@stable",
        prompt: "prompt/burn@stable",
        maxTurns: 1,
        outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      },
    },
  ],
  edges: [],
});

/** `delegate` --error--> `cheap`: the subgraph burns and fails, the fallback finishes the run. */
const FALLBACK = base("fallback", {
  channels: { topic: { type: "string", reduce: "replace" }, result: { type: "string", reduce: "replace" } },
  inputs: ["topic"],
  outputs: ["result"],
  nodes: [
    {
      id: "delegate",
      type: "subgraph",
      reads: ["topic"],
      writes: ["result"],
      subgraph: { ref: "graph/burn@stable", inputs: { topic: "topic" }, outputs: { result: "answer" } },
      retry: { maxAttempts: 1 },
    },
    { ...(agentNode("cheap", "prompt/cheap@stable", ["topic"], ["result"]) as Record<string, unknown>), unhandled: true },
  ],
  edges: [{ id: "e1", from: "delegate", to: "cheap", kind: "error" }],
});

/** The fallback ALONE, so "more than the fallback" is a measured number and not an assumption. */
const CHEAP_ONLY = base("cheaponly", {
  channels: { topic: { type: "string", reduce: "replace" }, result: { type: "string", reduce: "replace" } },
  inputs: ["topic"],
  outputs: ["result"],
  nodes: [agentNode("cheap", "prompt/cheap@stable", ["topic"], ["result"])],
  edges: [],
});

/**
 * Priced by the PROMPT the turn was handed, not by a counter: one adapter serves the parent
 * and the child, and a counter cannot tell those apart deterministically.
 */
function scriptFor(prices: Record<string, number>): MockScript {
  return (req) => {
    const seen = JSON.stringify(req.messages) + JSON.stringify(req.system ?? "");
    for (const [ref, tokens] of Object.entries(prices)) {
      if (seen.includes(ref)) return { text: "the answer", finishReason: "stop", inputTokens: tokens, outputTokens: 0 };
    }
    return { text: "the answer", finishReason: "stop", inputTokens: 1_000, outputTokens: 0 };
  };
}

interface Run {
  readonly projection: RunProjection;
  readonly trajectory: Trajectory;
  readonly events: readonly JournalEvent[];
}

/** Submit, advance to terminal, fold both ways. `pricePerMTok: 1` ⇒ 1,000 tokens is $0.001. */
async function drive(spec: GraphSpec, script: MockScript, subs: Record<string, GraphSpec> = {}): Promise<Run> {
  const store = new MemoryStateStore({ now: () => NOW });
  const functions = new FunctionRegistry();
  functions.register("function/compute@stable", (v) => ({ writes: { answer: `computed:${v.get<string>("topic") ?? ""}` } }));
  functions.register("function/noop@stable", () => ({}));
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script, pricePerMTok: 1 }), true);

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models,
    now: () => NOW,
    sleep: async () => {},
    resolver: resolver(subs),
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 100 } },
  });

  const graph: RunGraph = compileOrThrow({ spec, resolver: resolver(subs), tools: {}, tenantCapabilities: [] });
  const runId: RunId = await engine.submit({ graph, inputs: { topic: "t" } });
  let p = await engine.advance(runId);
  for (let i = 0; i < 6 && p.status !== "succeeded" && p.status !== "failed" && p.status !== "cancelled"; i++) {
    p = await engine.advance(runId);
  }
  const events: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) events.push(ev);
  return { projection: p, trajectory: foldTrajectory(events, { graph }), events };
}

/** Score against a cohort measured from the run itself, so nothing outside the fixture decides. */
const soloScore = (t: Trajectory) => scoreTrajectory(t, measureCohort("k", [t]));

// ── delegation ───────────────────────────────────────────────────────────────

test("A DELEGATED RUN SCORES LIKE THE SAME WORK INLINE — the multi-agent shape is not a no-op", async () => {
  const script = scriptFor({});
  const inline = await drive(INLINE, script);
  const delegated = await drive(DELEGATED, script, { "graph/child@stable": INLINE });

  assert.equal(inline.projection.status, "succeeded", JSON.stringify(inline.projection.error ?? {}));
  assert.equal(delegated.projection.status, "succeeded", JSON.stringify(delegated.projection.error ?? {}));

  // The controls that say the fixture really is delegated: the parent's journal has the
  // subgraph rows and NONE of the child's model turns.
  assert.equal(delegated.trajectory.usage.modelCalls, 0, "control: the child's turns are in the CHILD's journal");
  assert.equal(delegated.trajectory.usage.subgraphRuns, 1, "…and the parent knows one child run happened");
  assert.equal(inline.trajectory.usage.modelCalls, 1, "control: the inline run's turn is in its own journal");
  assert.equal(inline.trajectory.usage.subgraphRuns, 0);

  const d = soloScore(delegated.trajectory);
  const i = soloScore(inline.trajectory);

  // The property, not a history claim: a delegated run must score like the equivalent inline
  // run, and must not be dropped from its own cohort.
  assert.equal(d.components.delivered, true, "a run that delegated its work still delivered it");
  assert.equal(d.score, i.score, `delegated ${d.score} must score as the inline control ${i.score}`);
  assert.ok(d.score > 0, `and that score must be a real one, got ${d.score}`);

  // The child's spend crossed the boundary too, once — not twice, and not zero.
  assert.equal(delegated.trajectory.usage.costUsd, inline.trajectory.usage.costUsd);
  assert.equal(delegated.trajectory.usage.costUsd, delegated.projection.usage.costUsd, "the two folds agree");
  assert.equal(delegated.trajectory.usage.tokens, inline.trajectory.usage.tokens);

  // …and it is a cohort member, which is what `isGolden` condition 2 and 4 read.
  assert.equal(measureCohort("k", [delegated.trajectory]).n, 1, "a delegated run must not be dropped from its own cohort");
});

test("A FUNCTION-ONLY GRAPH DID WORK — writing the declared output is the evidence", async () => {
  const fn = await drive(FUNCTION_ONLY, scriptFor({}));
  assert.equal(fn.projection.status, "succeeded", JSON.stringify(fn.projection.error ?? {}));

  // Controls: it really does bill nothing at all. `#runFunction` returns ZERO_USAGE and
  // appends no `tool.called`, so every member of the previous round's `didWork` is absent.
  assert.equal(fn.trajectory.usage.modelCalls, 0);
  assert.equal(fn.trajectory.usage.toolCalls, 0);
  assert.equal(fn.trajectory.usage.costUsd, 0);
  assert.deepEqual(fn.trajectory.outcome.assertions, []);

  const scored = soloScore(fn.trajectory);
  assert.deepEqual(
    fn.trajectory.steps.map((s) => s.channelsWritten),
    [["answer"]],
    "the committed channel is the whole evidence, and it is a NAME not a value",
  );
  assert.equal(scored.components.delivered, true, "a function node that commits its declared output is work");
  assert.ok(scored.score > 0, `a graph that produced its output scores, got ${scored.score}`);
});

test("…AND A BODY THAT WRITES NOTHING IS STILL A NO-OP — the line the previous round drew, kept", async () => {
  const noop = await drive(NOOP, scriptFor({}));
  const fn = await drive(FUNCTION_ONLY, scriptFor({}));
  assert.equal(noop.projection.status, "succeeded", "control: it did reach terminal success");

  // The two runs are identical everywhere the efficiency terms look: same node type, $0, no
  // calls, one succeeded step. ONLY the committed channel differs.
  assert.equal(noop.trajectory.steps.length, 1, "control: it ran a node — 'no steps' is not what makes it a no-op");
  assert.equal(noop.trajectory.steps[0]!.status, "succeeded");
  assert.deepEqual(noop.trajectory.steps[0]!.channelsWritten, []);
  assert.equal(noop.trajectory.usage.costUsd, fn.trajectory.usage.costUsd);

  const scored = soloScore(noop.trajectory);
  assert.equal(scored.components.completed, true);
  assert.equal(scored.components.delivered, false, "nothing was produced for the cheapness to be a ratio to");
  assert.equal(scored.score, 0);
  assert.ok(soloScore(fn.trajectory).score > scored.score, "real work out-scores the no-op");
  assert.equal(measureCohort("k", [noop.trajectory]).n, 0, "…and it cannot move the ruler either");
});

// ── a failed subgraph's spend ────────────────────────────────────────────────

test("A FAILED SUBGRAPH'S SPEND IS STILL COUNTED — fail your subgraph, still pay for it", async () => {
  // $5.00 in the child, $0.01 in the fallback. The child fails its output schema, the parent's
  // error edge runs the cheap agent, and the RUN SUCCEEDS — so the score is paid out, on a
  // cost term that had lost 500× of what the run actually spent.
  const script = scriptFor({ "prompt/burn@stable": 5_000_000, "prompt/cheap@stable": 10_000 });
  const both = await drive(FALLBACK, script, { "graph/burn@stable": BURN });
  const alone = await drive(CHEAP_ONLY, script);

  assert.equal(both.projection.status, "succeeded", JSON.stringify(both.projection.error ?? {}));
  assert.equal(alone.projection.status, "succeeded", JSON.stringify(alone.projection.error ?? {}));

  // Controls on the shape: the child ran, it did NOT complete, and the parent's only record of
  // its money is the failing commit.
  assert.equal(both.trajectory.usage.subgraphRuns, 1);
  assert.equal(both.events.some((e) => e.type === "subgraph.started"), true);
  assert.equal(
    both.events.some((e) => e.type === "subgraph.completed"),
    false,
    "control: engine.ts appends it on the SUCCESS path only — that is the whole difficulty",
  );

  assert.equal(alone.trajectory.usage.costUsd, 0.01, "control: the fallback alone really is $0.01");
  assert.ok(
    both.trajectory.usage.costUsd > alone.trajectory.usage.costUsd,
    `the run that also burned $5.00 must cost more than the fallback alone: ` +
      `${both.trajectory.usage.costUsd} vs ${alone.trajectory.usage.costUsd}`,
  );
  // The fold must agree with run/projection.ts; disagreement in EITHER direction is the defect.
  assert.equal(both.trajectory.usage.costUsd, 5.01);
  assert.equal(
    both.trajectory.usage.costUsd,
    both.projection.usage.costUsd,
    "the score's fold and the budget's fold agree on the same journal",
  );

  // And the consequence that made it a reward: measured in one cohort, the burner must not
  // out-score the run that only ever spent the $0.01.
  //
  // A THIRD REAL RUN at $0.10 sets the median. With n = 2 the median IS the thrifty run, so
  // both members normalize to 1.0 — one by being the median and the other by the clamp — and
  // the cost term stops discriminating for a reason that has nothing to do with this defect.
  // That is a property of `p50`, not evidence of anything, and the fixture must not rest on it.
  const mid = await drive(INLINE, scriptFor({ "prompt/work@stable": 100_000 }));
  assert.equal(mid.trajectory.usage.costUsd, 0.1, "control: the median-setter");
  const c = measureCohort("k", [both.trajectory, alone.trajectory, mid.trajectory]);
  assert.equal(c.p50Cost, 0.1);
  const burned = scoreTrajectory(both.trajectory, c);
  const thrifty = scoreTrajectory(alone.trajectory, c);
  assert.ok(
    thrifty.score > burned.score,
    `spending $5.01 must not out-score spending $0.01: ${burned.score} vs ${thrifty.score}`,
  );
});

// ── the properties the earlier rounds traded away ────────────────────────────

test("A CHEAP REAL SUCCESS STILL OUT-SCORES AN EXPENSIVE ONE — on real journals", async () => {
  // The property the constant-0.1 round destroyed. Three real runs of one graph at
  // $0.001 / $0.005 / $0.010, and the cohort must be able to tell them apart.
  const runs = await Promise.all(
    [1_000, 5_000, 10_000].map((tokens) => drive(INLINE, scriptFor({ "prompt/work@stable": tokens }))),
  );
  const ts = runs.map((r) => r.trajectory);
  assert.deepEqual(ts.map((t) => t.usage.costUsd), [0.001, 0.005, 0.01], "control: three different real bills");

  const c = measureCohort("k", ts);
  assert.equal(c.n, 3, "all three are members");
  assert.ok(c.p50Cost > 0, "…and the ruler is a real one");

  const [cheap, , dear] = ts.map((t) => scoreTrajectory(t, c).score);
  assert.ok(cheap! > dear!, `cheap ${cheap} must out-score dear ${dear}`);
  assert.ok(c.p90Score > 0, `the golden bar must be clearable-or-not, not tied by everyone (p90 ${c.p90Score})`);
});

// ── the excess arm, pinned ───────────────────────────────────────────────────
//
// ADDED 2026-08-25 after a verifier deleted the `task.committed` excess arm — the line this
// file's own docstring calls the whole fix — and all 86 evolution tests stayed green. A fix
// nothing pins is a fix that will be removed by the next person who finds it puzzling.
//
// The arm exists for exactly one shape: spend whose ONLY record in the parent's journal is a
// FAILING `task.committed`. `subgraph.completed` is appended on the success path only
// (`engine.ts:3958`), so a failed child's dollars are stated there or nowhere. This fixture is
// therefore deliberately minimal — no `model.called`, no `subgraph.completed` — because any
// second record of the same spend would let another arm cover for the deleted one, which is
// precisely why the existing Engine-level fixtures did not catch it.

test("EXCESS ARM: spend recorded ONLY on a failing task.committed still reaches the trajectory", () => {
  const at = 1_700_000_000_000;
  const runId = "01M0W3NTEGGQ426QT0DX4SDAYX";
  const ev = (seq: number, type: string, payload: unknown, taskId?: string) =>
    ({
      runId, seq, ts: at + seq, type, payload,
      actor: { kind: "system", component: "test" }, classification: "internal",
      ...(taskId === undefined ? {} : { taskId }),
    }) as unknown as JournalEvent;

  const CHILD_SPEND = { inputTokens: 0, outputTokens: 0, costUsd: 5, wallMs: 900 };
  const events = [
    ev(1, "run.submitted", { graphHash: "sha256:x", configDigest: "sha256:y", idempotencyKey: "k", inputs: {} }),
    ev(2, "run.compiled", { graphHash: "sha256:x", nodes: 1, edges: 0, resolutionManifest: [] }),
    ev(3, "run.started", { posture: "on" }),
    ev(4, "task.ready", { nodeId: "sub", branchPath: "root", edgesIn: [] }, "sub@root#0"),
    ev(5, "task.leased", { attempt: 1, workerId: "w0" }, "sub@root#0"),
    ev(6, "subgraph.started", { childRunId: "01M0CHILD0000000000000000", nodeId: "sub" }, "sub@root#0"),
    // The child burned $5 and the subgraph FAILED, so no `subgraph.completed` is ever appended.
    // This commit is the only place the money appears.
    ev(7, "task.committed", { attempt: 1, status: "failed", take: [], writes: {}, usage: CHILD_SPEND }, "sub@root#0"),
    ev(8, "run.failed", { error: { class: "internal", code: "E_INTERNAL", message: "child failed", retryable: false } }),
  ];

  const t = foldTrajectory(events);

  assert.equal(
    t.usage.costUsd,
    5,
    "deleting the task.committed excess arm makes a failed subgraph's child spend vanish — " +
      "the 500x under-count in the loosening direction: fail your child, look cheap",
  );
});

test("EXCESS ARM: a restatement of spend already recorded is NOT double-counted", () => {
  // The control, and the reason the arm is `excess` rather than a plain add. Without this the
  // obvious "fix" for the test above — charging task.committed verbatim — would pass while
  // reintroducing the over-count that `86b84c9` actually had.
  const at = 1_700_000_000_000;
  const runId = "01M0W3NTEGGQ426QT0DX4SDAYY";
  const ev = (seq: number, type: string, payload: unknown, taskId?: string) =>
    ({
      runId, seq, ts: at + seq, type, payload,
      actor: { kind: "system", component: "test" }, classification: "internal",
      ...(taskId === undefined ? {} : { taskId }),
    }) as unknown as JournalEvent;

  const SPEND = { inputTokens: 100, outputTokens: 50, costUsd: 0.25, wallMs: 900 };
  const events = [
    ev(1, "run.submitted", { graphHash: "sha256:x", configDigest: "sha256:y", idempotencyKey: "k", inputs: {} }),
    ev(2, "run.compiled", { graphHash: "sha256:x", nodes: 1, edges: 0, resolutionManifest: [] }),
    ev(3, "run.started", { posture: "on" }),
    ev(4, "task.ready", { nodeId: "a", branchPath: "root", edgesIn: [] }, "a@root#0"),
    ev(5, "task.leased", { attempt: 1, workerId: "w0" }, "a@root#0"),
    // The call is recorded here…
    ev(6, "model.called", { key: "a@root#0/model/0", provider: "p", model: "m", finishReason: "stop", usage: SPEND }, "a@root#0"),
    // …and RESTATED on the commit. One dollar spent, one dollar counted.
    ev(7, "task.committed", { attempt: 1, status: "succeeded", take: [], writes: { out: 1 }, usage: SPEND }, "a@root#0"),
    ev(8, "run.completed", { outputs: { out: 1 }, usage: SPEND }),
  ];

  const t = foldTrajectory(events);
  assert.equal(t.usage.costUsd, 0.25, "a restatement must be charged as EXCESS, never added verbatim");
});

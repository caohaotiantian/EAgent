/**
 * A provider rate limit is a DEFERRAL the engine schedules, not a sleep the adapter takes.
 *
 * WHY THIS FILE EXISTS. `postJson` used to `hold()` on a 429 inside the call, and that call
 * runs inside the engine's worker slot — so a provider asking for thirty seconds parked a
 * worker for as long as the operator's ceiling allowed, and every run behind it waited on a
 * slot that was doing nothing. Removing that hold failed twice, both times for the same
 * reason: the in-slot sleep was a UNIVERSAL rescue and the engine's requeue was a
 * CONDITIONAL one, so the swap lost coverage wherever a node had declared `maxAttempts: 1`,
 * or an `onlyIf` the code missed, or had already spent its attempts.
 *
 * The answer is the model question the two failures kept escalating: **a rate limit is not
 * the node's failure.** The node's work never ran. So the deferral is not charged against
 * the node's retry budget, is not filtered by `onlyIf`, and does not need a retry policy to
 * exist at all — which makes the engine's rescue universal too, and the swap lossless.
 *
 * What it is still bounded by, because "wait as long as the provider likes" is the defect
 * pointing the other way: a per-Task ceiling on TOTAL deferred time, folded from the journal
 * so it survives a restart, after which the rate limit becomes an ordinary failure.
 *
 * A SECOND MEMBER JOINED THE SET WHILE THIS FILE WAS BEING WRITTEN, and it was not planned —
 * the subgraph test below FAILED with only the rate limit deferring, reproducing the ">~78 s"
 * row of the same failure table from the other side. A parent polling a child that has not
 * finished is the same fact as a rate limit: the node did not fail, the answer is not yet.
 * That is recorded here because the generalisation was found by measurement rather than
 * argued for, and because the set is now two and has to stay named — see `DEFERRABLE_CODES`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { CODES, err } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RetryPolicy, RunGraph } from "../../src/graph/spec.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { NodeId, RunId } from "../../src/ids.ts";
import { AnthropicAdapter } from "../../src/providers/anthropic.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry, type MockScript } from "../../src/run/registry.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";
import { resolver } from "./skeleton.ts";

// ---------------------------------------------------------------------------
// A one-agent graph, so the only thing under test is what a 429 does to one Task.
// ---------------------------------------------------------------------------

function oneAgentSpec(retry?: RetryPolicy): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "rate-limited", project: "t", version: 1 },
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
        ...(retry === undefined ? {} : { retry }),
        agent: { profile: "agent_profile/a@stable", prompt: "prompt/p@v1", maxTurns: 3 },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

interface Rig {
  readonly engine: Engine;
  readonly store: MemoryStateStore;
  readonly graph: RunGraph;
  advance(ms: number): void;
  now(): number;
}

function rig(opts: { script: MockScript; retry?: RetryPolicy; store?: MemoryStateStore }): Rig {
  let t = 1_700_000_000_000;
  const now = (): number => t;
  const store = opts.store ?? new MemoryStateStore({ now });
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: opts.script, pricePerMTok: 1 }), true);

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions: new FunctionRegistry(),
    models,
    now,
    // Nothing in these tests waits on the wall clock: the engine's own backoff sleep is a
    // no-op and the run is driven forward by MOVING the injected clock.
    sleep: async () => {},
    resolver: resolver(),
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 5 } },
  });

  return {
    engine,
    store,
    graph: compileOrThrow({ spec: oneAgentSpec(opts.retry), resolver: resolver(), tools: {}, tenantCapabilities: [] }),
    advance: (ms) => {
      t += ms;
    },
    now,
  };
}

async function events(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const e of store.read(runId, 1)) out.push(e);
  return out;
}

/** `advance` returns while a Task is backing off; the caller moves the clock and asks again. */
async function drive(r: Rig, runId: RunId, laps = 40): Promise<Awaited<ReturnType<Engine["advance"]>>> {
  let p = await r.engine.advance(runId).catch(async () => (await r.engine.projection(runId))!);
  for (let i = 0; i < laps && p.status === "running"; i++) {
    r.advance(600_000);
    p = await r.engine.advance(runId).catch(async () => (await r.engine.projection(runId))!);
  }
  return p;
}

const RATE_LIMIT = (retryAfterMs?: number): never => {
  throw err.exhausted(CODES.E_PROVIDER_RATE_LIMIT, "provider rate limit (429)", {
    details: { status: 429 },
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
};

const deferrals = (log: readonly JournalEvent[]): { attempt: number; afterMs: number; code: string; deferred?: boolean }[] =>
  log
    .filter((e) => e.type === "task.retry_scheduled")
    .map((e) => e.payload as { attempt: number; afterMs: number; code: string; deferred?: boolean });

// ---------------------------------------------------------------------------
// 1 · the defect, measured through the transport that has it
// ---------------------------------------------------------------------------

test("THE 429 IS NOT PAID INSIDE THE WORKER SLOT — the adapter reports it, the engine schedules it", async () => {
  // Measured at bb7b702, before the fix — this test's own failure output, verbatim:
  //
  //     slept                 [8000,8000,8000,8000,8000,8000]
  //     journal at first hold ["run.submitted","run.compiled","run.started","task.ready",
  //                            "task.leased","policy.decided","effect.started"]
  //
  // Six holds of eight seconds: two inside each of the three attempts the node's compiled
  // policy allowed. Forty-eight seconds of a worker slot, and the journal at the first one
  // says why nothing could be done about it — LEASED, uncommitted, and no
  // `task.retry_scheduled`, so the scheduler had not been told and had nothing to reschedule.
  //
  // The provider asked for 30 s and `maxDelayMs` clamped each hold to 8. That clamp is not a
  // defence — it decides how LONG the slot is held, not whether it is held.
  let t = 1_700_000_000_000;
  const now = (): number => t;
  const store = new MemoryStateStore({ now });
  const slept: number[] = [];
  const seenAtFirstHold: string[] = [];
  let posts = 0;

  const models = new ModelRegistry();
  const adapter = new AnthropicAdapter({
    apiKey: "k",
    fetch: async () => {
      posts += 1;
      return new Response("{}", { status: 429, headers: { "retry-after": "30" } });
    },
    // The hold, made observable. Nothing here waits: it records what the transport asked
    // for and what the journal knew at that instant.
    sleep: async (ms) => {
      if (slept.length === 0) seenAtFirstHold.push(...(await events(store, runId)).map((e) => e.type));
      slept.push(ms);
    },
  });
  models.register(adapter, true);

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions: new FunctionRegistry(),
    models,
    now,
    sleep: async () => {},
    resolver: resolver(),
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 5 } },
  });
  const graph = compileOrThrow({ spec: oneAgentSpec(), resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: {} });

  let p = await engine.advance(runId).catch(async () => (await engine.projection(runId))!);
  for (let i = 0; i < 40 && p.status === "running"; i++) {
    t += 600_000;
    p = await engine.advance(runId).catch(async () => (await engine.projection(runId))!);
  }

  assert.deepEqual(
    slept,
    [],
    `the adapter must not hold for a rate limit — it held ${JSON.stringify(slept)} while the journal read ${JSON.stringify(seenAtFirstHold)}`,
  );
  // …and the wait it declined to take is on the journal instead, where the scheduler can see
  // it. `posts` proves the call really was re-sent, so "no sleep" is not "no retry".
  const log = await events(store, runId);
  const scheduled = deferrals(log);
  assert.ok(scheduled.length > 0, "the rate limit must be rescheduled by the engine");
  assert.equal(scheduled[0]?.deferred, true, `the first reschedule is a deferral: ${JSON.stringify(scheduled[0])}`);
  assert.equal(scheduled[0]?.afterMs, 30_000, "…and it schedules the thirty seconds the provider asked for");
  assert.ok(posts > 1, `the request is re-sent, just not from inside the slot (posts=${String(posts)})`);
});

// ---------------------------------------------------------------------------
// 2 · the four shapes the previous two attempts broke
// ---------------------------------------------------------------------------

test("A DECLARED `maxAttempts: 1` STILL SURVIVES A 429 — the deferral is not charged to the node", async () => {
  // Row 2 of the failure table in TODO §A: "author declared `maxAttempts: 1` … after: FAILED".
  // `maxAttempts: 1` means "do not retry ME". It cannot mean "die if the provider is busy",
  // because the node never ran.
  let calls = 0;
  const r = rig({
    retry: { maxAttempts: 1 },
    script: () => {
      calls += 1;
      if (calls === 1) RATE_LIMIT(30_000);
      return { text: '{"ok":true}', finishReason: "stop" as const };
    },
  });
  const runId = await r.engine.submit({ graph: r.graph, inputs: {} });
  const p = await drive(r, runId);

  const log = await events(r.store, runId);
  assert.equal(p.status, "succeeded", `journal:\n${log.map((e) => e.type).join("\n")}`);
  const scheduled = deferrals(log);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0]?.deferred, true, "journaled AS a deferral, so an operator can see it was not a retry");
  assert.equal(scheduled[0]?.attempt, 0, "the attempt counter does not advance: nothing was charged");
});

test("AN `onlyIf` THAT DOES NOT NAME THE RATE LIMIT DOES NOT REFUSE THE DEFERRAL", async () => {
  // Row 2's other half. `onlyIf` selects which of THIS NODE'S failures are worth repeating;
  // a rate limit is not one of this node's failures.
  let calls = 0;
  const r = rig({
    retry: { maxAttempts: 3, backoff: "fixed", initialMs: 10, onlyIf: [CODES.E_PROVIDER_TRANSPORT] },
    script: () => {
      calls += 1;
      if (calls === 1) RATE_LIMIT(30_000);
      return { text: '{"ok":true}', finishReason: "stop" as const };
    },
  });
  const runId = await r.engine.submit({ graph: r.graph, inputs: {} });
  const p = await drive(r, runId);
  const log = await events(r.store, runId);
  assert.equal(p.status, "succeeded", `journal:\n${log.map((e) => e.type).join("\n")}`);
  assert.equal(deferrals(log)[0]?.deferred, true);
});

test("A PROVIDER ASKING FOR LONGER THAN ANY CURVE IS WAITED OUT, NOT FAILED", async () => {
  // Row 4: "429 inside a SUBGRAPH, provider asks > ~78 s". The number that mattered there was
  // the ASK, not the subgraph: an ask above the compiled curve's ceiling used to exhaust the
  // attempts before the provider was ready. The ask is honoured up to `RETRY_AFTER_CEILING_MS`.
  let calls = 0;
  const r = rig({
    script: () => {
      calls += 1;
      if (calls <= 3) RATE_LIMIT(120_000);
      return { text: '{"ok":true}', finishReason: "stop" as const };
    },
  });
  const runId = await r.engine.submit({ graph: r.graph, inputs: {} });
  const p = await drive(r, runId);
  const log = await events(r.store, runId);
  assert.equal(p.status, "succeeded", `journal:\n${log.map((e) => e.type).join("\n")}`);
  const scheduled = deferrals(log);
  assert.equal(scheduled.length, 3, "three asks, three deferrals — and the default policy allows only two retries");
  assert.ok(
    scheduled.every((s) => s.afterMs === 120_000),
    `the provider's own number is what is scheduled: ${JSON.stringify(scheduled.map((s) => s.afterMs))}`,
  );
});

test("A RATE LIMIT ON A NODE WITH NO RETRY POLICY AT ALL IS STILL DEFERRED", async () => {
  // The universality the two failed attempts lacked. `#retryDecision` returned on its first
  // line when `policy === undefined`, which is every `RunGraph` a caller assembled without the
  // compiler. A deferral does not read the policy, so it does not need one to exist.
  let calls = 0;
  const r = rig({
    script: () => {
      calls += 1;
      if (calls === 1) RATE_LIMIT(5_000);
      return { text: '{"ok":true}', finishReason: "stop" as const };
    },
  });
  // The compiler hands an agent node a default, so the default has to be STRIPPED for this
  // question to be asked at all — what is left is the shape a caller assembles by hand.
  const { retry: _stripped, ...plan } = r.graph.plans["ask" as NodeId]!;
  const bare = { ...r.graph, plans: { ...r.graph.plans, ask: plan } } as RunGraph;
  assert.equal(bare.plans["ask" as NodeId]?.retry, undefined, "precondition: this node has no retry policy");

  const runId = await r.engine.submit({ graph: bare, inputs: {} });
  const p = await drive(r, runId);
  const log = await events(r.store, runId);
  assert.equal(p.status, "succeeded", `journal:\n${log.map((e) => e.type).join("\n")}`);
  assert.equal(deferrals(log)[0]?.deferred, true);
});

test("A 429 DEEP INSIDE A SUBGRAPH IS DEFERRED BY THE CHILD, and the parent's poll outlives it", async () => {
  // Row 4 of the failure table, in the shape it was actually written in: "429 inside a
  // SUBGRAPH, provider asks > ~78 s". The 78 is not arbitrary — it is the sum of
  // `DEFAULT_SUBGRAPH_RETRY`'s twenty polls (250 ms doubling to a 5 s ceiling ≈ 82 s), so a
  // child that is unavailable for longer than that exhausts the PARENT even when the child
  // itself is fine. The deferral moves the wait into the child, where it is not charged, but
  // the parent is still polling on a charged policy, so this composition has to be measured
  // rather than argued.
  let calls = 0;
  const t0 = 1_700_000_000_000;
  let t = t0;
  const now = (): number => t;
  const store = new MemoryStateStore({ now });

  const childSpec: GraphSpec = {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "rl-child", project: "t", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { answer: { type: "string", reduce: "replace" } },
    inputs: [],
    outputs: ["answer"],
    nodes: [
      { id: "work", type: "agent", writes: ["answer"], unhandled: true, agent: { profile: "agent_profile/a@stable", prompt: "prompt/p@v1", maxTurns: 2 } },
    ],
    edges: [],
  } as unknown as GraphSpec;

  const parentSpec: GraphSpec = {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "rl-parent", project: "t", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 16, maxDepth: 2, maxFanout: 2, maxLoopIterations: 1 }, budget: { costUsd: 5 } },
    channels: { answer: { type: "string", reduce: "replace" } },
    inputs: [],
    outputs: ["answer"],
    nodes: [
      {
        id: "delegate",
        type: "subgraph",
        writes: ["answer"],
        unhandled: true,
        subgraph: { ref: "graph/rl-child@stable", inputs: {}, outputs: { answer: "answer" }, budgetShare: 0.5 },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;

  const base = resolver();
  const withChild: ResourceResolver = { ...base, subgraph: (ref) => (ref === "graph/rl-child@stable" ? childSpec : undefined) };

  const models = new ModelRegistry();
  models.register(
    new MockModelAdapter({
      script: () => {
        calls += 1;
        // Two minutes of advice, twice — comfortably past the parent's ~82 s of polling.
        if (calls <= 2) RATE_LIMIT(120_000);
        return { text: '{"answer":"done"}', finishReason: "stop" as const };
      },
      pricePerMTok: 1,
    }),
    true,
  );

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions: new FunctionRegistry(),
    models,
    now,
    sleep: async () => {},
    resolver: withChild,
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 5 } },
  });

  const graph = compileOrThrow({ spec: parentSpec, resolver: withChild, tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: {} });

  // THE CLOCK MOVES TO THE NEXT SCHEDULED WAKE, not by a fixed step — which is what
  // `cli.ts`'s `driveToRest` does, and the difference decides this test. A fixed 30 s step
  // let the parent burn only one of its twenty polls per two-minute child deferral and the
  // test passed for a reason the product does not have: in real time the parent's curve tops
  // out at 5 s, so it polls ~20 times in ~82 s and it is THAT race the row is about.
  const wake = async (): Promise<number | undefined> => {
    const runs = [runId, ...(await events(store, runId)).filter((e) => e.type === "subgraph.started").map((e) => (e.payload as { childRunId: RunId }).childRunId)];
    let earliest: number | undefined;
    for (const id of runs) {
      const proj = await engine.projection(id);
      for (const task of Object.values(proj?.tasks ?? {})) {
        const at = task.retryAfter;
        if (at !== undefined && at > t && (earliest === undefined || at < earliest)) earliest = at;
      }
    }
    return earliest;
  };

  let p = await engine.advance(runId).catch(async () => (await engine.projection(runId))!);
  for (let i = 0; i < 200 && p.status === "running"; i++) {
    const at = await wake();
    if (at !== undefined) t = at;
    p = await engine.advance(runId).catch(async () => (await engine.projection(runId))!);
  }

  const log = await events(store, runId);
  assert.equal(p.status, "succeeded", `journal:\n${log.map((e) => `${String(e.taskId ?? "-")} ${e.type}`).join("\n")}`);

  // MEASURED WITH ONLY THE RATE LIMIT DEFERRING — i.e. the first version of this fix — this
  // run FAILED, and its parent journal ended:
  //     delegate task.retry_scheduled {afterMs: 250,  attempt: 1, code: E_SUBGRAPH_FAILED}
  //     …                             {afterMs: 500,  attempt: 2, …} … up to attempt 8
  // The parent burned charged polls on a 250 ms→5 s curve while the child waited two minutes;
  // twenty of those is ~82 s, which is the "> ~78 s" the failure table records. Moving the
  // wait into the child had recreated the very row it was meant to fix.
  //
  // The parent's poll is the same kind of fact as the child's rate limit — the parent node did
  // not fail, it asked whether the child was done — so it defers too, uncharged, on the
  // deferral's own 1 s→60 s curve.
  assert.ok(
    deferrals(log).every((d) => d.deferred === true && d.code === CODES.E_SUBGRAPH_FAILED && d.attempt === 0),
    `the parent's polls are uncharged deferrals, not failures: ${JSON.stringify(deferrals(log))}`,
  );
  const childRunId = (log.find((e) => e.type === "subgraph.started")?.payload as { childRunId: RunId }).childRunId;
  const childLog = await events(store, childRunId);
  const deferred = deferrals(childLog).filter((d) => d.deferred === true);
  assert.equal(deferred.length, 2, `two asks, two deferrals in the CHILD: ${JSON.stringify(deferrals(childLog))}`);
  assert.ok(
    deferred.every((d) => d.afterMs === 120_000),
    "the child schedules the two minutes the provider named, which no in-slot curve would have waited",
  );
});

// ---------------------------------------------------------------------------
// 3 · the bound — "wait as long as the provider likes" is the defect reversed
// ---------------------------------------------------------------------------

test("THE DEFERRAL IS BOUNDED — a provider that never stops rate limiting fails the run", async () => {
  const r = rig({ script: () => RATE_LIMIT(60_000) });
  const runId = await r.engine.submit({ graph: r.graph, inputs: {} });
  const p = await drive(r, runId, 400);

  const log = await events(r.store, runId);
  assert.equal(p.status, "failed", `an endless rate limit must end: ${log.map((e) => e.type).join(" ")}`);
  const scheduled = deferrals(log);
  const deferredMs = scheduled.filter((s) => s.deferred === true).reduce((a, s) => a + s.afterMs, 0);
  assert.ok(deferredMs > 0, "it did defer");
  assert.ok(deferredMs <= 900_000, `total deferred time is capped: ${String(deferredMs)}`);
  // …and when the budget is spent the rate limit becomes an ordinary failure, which the
  // node's own policy then judges. Nothing loops.
  assert.ok(scheduled.some((s) => s.deferred !== true), "the tail is charged retries, not more deferrals");
});

test("THE DEFERRAL BUDGET IS RECONSTRUCTED FROM THE JOURNAL, so a restart cannot refill it", async () => {
  // The non-negotiable this would otherwise break: a value a decision reads must be
  // reconstructible from the journal ACROSS A RESTART. A counter in process memory would let
  // a plane that restarts defer for another full budget, forever, one crash at a time.
  let t = 1_700_000_000_000;
  const now = (): number => t;
  const store = new MemoryStateStore({ now });
  const script: MockScript = () => RATE_LIMIT(60_000);

  const build = (): Engine => {
    const models = new ModelRegistry();
    models.register(new MockModelAdapter({ script, pricePerMTok: 1 }), true);
    return new Engine({
      store,
      bus: new InProcessEventBus({ store }),
      tools: new ToolRegistry(),
      functions: new FunctionRegistry(),
      models,
      now,
      sleep: async () => {},
      resolver: resolver(),
      policy: { granted: [], systemFloor: "out", budget: { runUsd: 5 } },
    });
  };

  const graph = compileOrThrow({ spec: oneAgentSpec(), resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const first = build();
  const runId = await first.submit({ graph, inputs: {} });

  // A NEW ENGINE EVERY LAP — the harshest reading of "restart", and the one that catches a
  // process-local counter.
  let p = await first.advance(runId).catch(async () => (await first.projection(runId))!);
  for (let i = 0; i < 400 && p.status === "running"; i++) {
    t += 600_000;
    const e = build();
    // What a restarted plane does: re-attach the graph, then carry on from the journal alone.
    e.attach(runId, graph);
    p = await e.advance(runId).catch(async () => (await e.projection(runId))!);
  }

  const log = await events(store, runId);
  assert.equal(p.status, "failed", "a restart must not refill the deferral budget");
  const deferredMs = deferrals(log)
    .filter((s) => s.deferred === true)
    .reduce((a, s) => a + s.afterMs, 0);
  assert.ok(deferredMs <= 900_000, `total deferred time across restarts: ${String(deferredMs)}`);
});

/**
 * LIVE re-execution used to re-perform a completed effect; replay never did.
 *
 * Effect keys are derived, and there are five kinds. Replay served every one of them from the
 * record. The LIVE path served exactly one — `random` — so a Task that failed after its tool
 * had already succeeded re-ran that tool on the retry. That is why `#retryDecision` refused a
 * retry the moment a non-idempotent tool effect had STARTED: the refusal was not
 * over-conservative, it was the only thing standing between a retry and a second charge.
 *
 * These tests measure the effect on the world — the number of real invocations — rather than
 * the shape of the journal, because "the tool ran once" is the property, and a journal can
 * agree with itself while the sandbox was entered twice.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { CODES, err } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { RunId, Seq } from "../../src/ids.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry, type MockScript, type ToolDefinition } from "../../src/run/registry.ts";
import { replayRun } from "../../src/run/replay.ts";
import { rewindWithPlan } from "./operator.ts";
import { resolver } from "./skeleton.ts";


const CHARGE_MANIFEST = {
  name: "pay.charge",
  version: "1.0",
  capabilities: ["pay:charge"],
  // `reversible_write` on purpose: the point under test is IDEMPOTENCY, and a hard-to-undo
  // class would floor the node at `in` and turn every run here into a gate.
  irreversibility: "reversible_write" as const,
  idempotent: false,
};

function agentSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "served", project: "t", version: 1 },
    policy: { posture: "out", capabilities: ["pay:charge"], budget: { costUsd: 5 } },
    channels: { result: { type: "string", reduce: "replace" } },
    inputs: [],
    outputs: ["result"],
    nodes: [
      {
        id: "pay",
        type: "agent",
        writes: ["result"],
        unhandled: true,
        retry: { maxAttempts: 3, backoff: "fixed", initialMs: 10 },
        agent: { profile: "agent_profile/a@stable", prompt: "prompt/p@v1", maxTurns: 4, tools: ["pay.charge"] },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

function toolNodeSpec(opts: { idempotent: boolean; checkpoint?: "before" }): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "served-tool", project: "t", version: 1 },
    policy: { posture: "out", capabilities: ["pay:charge"] },
    channels: { result: { type: "string", reduce: "replace" } },
    inputs: [],
    outputs: ["result"],
    nodes: [
      {
        id: "pay",
        type: "tool",
        writes: ["result"],
        unhandled: true,
        retry: { maxAttempts: 3, backoff: "fixed", initialMs: 10 },
        ...(opts.checkpoint === undefined ? {} : { checkpoint: opts.checkpoint }),
        tool: { name: "pay.charge", version: "1.0", args: { amount: 10 } },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

interface Rig {
  readonly engine: Engine;
  readonly store: MemoryStateStore;
  readonly tools: ToolRegistry;
  readonly functions: FunctionRegistry;
  readonly graph: RunGraph;
  readonly model: MockModelAdapter;
  /** Every real entry into the tool body, in order. */
  readonly charges: number[];
  advance(ms: number): void;
}

function rig(opts: {
  spec: GraphSpec;
  idempotent?: boolean;
  script?: MockScript;
  execute?: (args: Record<string, unknown>, n: number) => { content: string; isError?: boolean; writes?: Record<string, unknown> };
}): Rig {
  let t = 1_700_000_000_000;
  const now = (): number => t;
  const store = new MemoryStateStore({ now });
  const charges: number[] = [];

  const charge: ToolDefinition = {
    ...CHARGE_MANIFEST,
    idempotent: opts.idempotent ?? false,
    description: "Charge a card.",
    parameters: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
    execute: (args) => {
      charges.push(Number(args["amount"]));
      return (opts.execute ?? ((a) => ({ content: `charged ${String(a["amount"])}`, writes: { result: `charged ${String(a["amount"])}` } })))(
        args,
        charges.length,
      );
    },
  };

  const tools = new ToolRegistry();
  tools.register(charge);
  const functions = new FunctionRegistry();
  const models = new ModelRegistry();
  const model = new MockModelAdapter({ script: opts.script ?? (() => ({ text: "{}", finishReason: "stop" })), pricePerMTok: 1 });
  models.register(model, true);

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions,
    models,
    now,
    sleep: async () => {},
    resolver: resolver(),
    policy: { granted: ["pay:charge"], systemFloor: "out", budget: { runUsd: 5 } },
  });

  const graph = compileOrThrow({
    spec: opts.spec,
    resolver: resolver(),
    tools: { "pay.charge": { ...CHARGE_MANIFEST, idempotent: opts.idempotent ?? false } },
    tenantCapabilities: ["pay:charge"],
  });

  return {
    engine,
    store,
    tools,
    functions,
    graph,
    model,
    charges,
    advance: (ms) => {
      t += ms;
    },
  };
}

async function events(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const e of store.read(runId, 1)) out.push(e);
  return out;
}

/** `advance` returns while a Task is in backoff; the caller moves the clock and asks again. */
async function driveToRest(r: Rig, runId: RunId): Promise<Awaited<ReturnType<Engine["advance"]>>> {
  let p = await r.engine.advance(runId).catch(async () => (await r.engine.projection(runId))!);
  for (let i = 0; i < 8 && p.status === "running"; i++) {
    r.advance(60_000);
    p = await r.engine.advance(runId).catch(async () => (await r.engine.projection(runId))!);
  }
  return p;
}

// ---------------------------------------------------------------------------

test("A NON-IDEMPOTENT TOOL THAT SUCCEEDED, THEN A FAILED TURN, THEN A RETRY: charged ONCE", async () => {
  let turnOneCalls = 0;
  const r = rig({
    spec: agentSpec(),
    script: (_req, turn) => {
      if (turn === 0) return { toolCalls: [{ id: "c0", name: "pay.charge", arguments: { amount: 10 } }], finishReason: "tool_use" };
      turnOneCalls += 1;
      // The charge is durable. THEN the provider dies — the exact shape the refusal was
      // protecting against, and the exact shape that made rate-limit retries unusable.
      if (turnOneCalls === 1) {
        throw err.exhausted(CODES.E_PROVIDER_RATE_LIMIT, "provider rate limit (429)", { details: { status: 429 }, retryAfterMs: 10 });
      }
      return { text: '{"ok":true}', finishReason: "stop" };
    },
  });

  const runId = await r.engine.submit({ graph: r.graph, inputs: {} });
  const p = await driveToRest(r, runId);

  const log = await events(r.store, runId);
  assert.ok(
    log.some((e) => e.type === "task.retry_scheduled"),
    `the retry must be allowed once the tool COMPLETED; journal:\n${log.map((e) => e.type).join("\n")}`,
  );
  assert.deepEqual(r.charges, [10], "the card was charged exactly once across both attempts");
  assert.equal(turnOneCalls, 2, "turn 1 STARTED and never completed, so it is performed again");
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
});

test("A COMPLETED EFFECT IS RECORDED ONCE — the retry appends no second `effect.completed`", async () => {
  let turnOneCalls = 0;
  const r = rig({
    spec: agentSpec(),
    script: (_req, turn) => {
      if (turn === 0) return { toolCalls: [{ id: "c0", name: "pay.charge", arguments: { amount: 10 } }], finishReason: "tool_use" };
      turnOneCalls += 1;
      if (turnOneCalls === 1) throw err.exhausted(CODES.E_PROVIDER_RATE_LIMIT, "429", { retryAfterMs: 10 });
      return { text: '{"ok":true}', finishReason: "stop" };
    },
  });
  const runId = await r.engine.submit({ graph: r.graph, inputs: {} });
  await driveToRest(r, runId);

  const log = await events(r.store, runId);
  // Without a retry this asserts nothing: one attempt trivially records one completion per key.
  assert.ok(log.some((e) => e.type === "task.retry_scheduled"), "precondition: the task was actually re-executed");
  const completed = log.filter((e) => e.type === "effect.completed").map((e) => (e.payload as { key: string }).key);
  assert.equal(
    completed.filter((k) => k.endsWith(":tool:0")).length,
    1,
    `one completion per key, or the auditor calls the run unhealthy; saw ${JSON.stringify(completed)}`,
  );
  assert.equal(completed.filter((k) => k.endsWith(":model:0")).length, 1, "the served model turn appends nothing");

  // AND THE QUOTE, which is the same rule one step earlier in the turn. `#quoteEffect` asks the
  // adapter what the request will cost and journals the answer, so a re-execution that asked
  // again would append a second completion under one key AND could price the turn differently
  // from the attempt that is being reproduced. Both turns are covered: turn 0's model call was
  // served, and turn 1's was re-performed after a 429 — the quote is served on both, because it
  // is recorded before the call that failed.
  assert.equal(completed.filter((k) => k.endsWith(":quote:0")).length, 1, "the retry serves turn 0's quote rather than re-asking");
  assert.equal(completed.filter((k) => k.endsWith(":quote:1")).length, 1, "and turn 1's, whose model call is the one that failed");
});

test("A REWIND THAT SUPPRESSED THE EFFECT GETS A FRESH CALL, not the recorded one", async () => {
  const r = rig({ spec: toolNodeSpec({ idempotent: true }), idempotent: true });
  const runId = await r.engine.submit({ graph: r.graph, inputs: {} });
  const first = await r.engine.advance(runId);
  assert.equal(first.status, "succeeded");
  assert.deepEqual(r.charges, [10]);

  // BEFORE THE EFFECT, and not the node's own `checkpoint: "before"` marker — that one is
  // written at COMMIT time and names the state before this node's WRITES landed, which on a
  // `tool` node is already after the tool ran. Measured on the journal below: `effect.started`
  // at 7, `effect.completed` at 9, `checkpoint.created{atSeq:9}` at 10. Rewinding to that
  // marker leaves the effect standing, so it is the wrong target for this question.
  const log = await events(r.store, runId);
  const startedAt = log.find((e) => e.type === "effect.started")!.seq;

  const rewound = await rewindWithPlan(r.engine, runId, (startedAt - 1) as Seq, "operator asked");
  assert.deepEqual(rewound.startedEffects, [], "the rewind undid the effect, so the fold must no longer know the key");

  const again = await r.engine.advance(runId);
  assert.equal(again.status, "succeeded");
  assert.deepEqual(r.charges, [10, 10], "a rewind UNDID the effect, so the redo must perform it again rather than serve it");
});

test("AN EFFECT STARTED BUT NEVER COMPLETED IS PERFORMED AGAIN, not failed", async () => {
  const r = rig({
    spec: toolNodeSpec({ idempotent: true }),
    idempotent: true,
    execute: (args, n) => {
      // The first entry reaches the sandbox and dies there: `effect.started` stands, no
      // `effect.completed` follows. Serving by key must NOT claim this one happened.
      if (n === 1) throw new Error("connection reset");
      return { content: "charged", writes: { result: `charged ${String(args["amount"])}` } };
    },
  });
  const runId = await r.engine.submit({ graph: r.graph, inputs: {} });
  const p = await driveToRest(r, runId);

  assert.deepEqual(r.charges, [10, 10], "a half-written effect is exactly the state a fresh call is for");
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
});

test("AFTER A REWIND AND A REDO, THE RETRY SERVES THE REDO'S RECORD — not the one the rewind undid", async () => {
  // The sharp case for reading the journal SUPPRESSION-AWARE rather than first-match. A rewind
  // does not edit history: both completions sit under one key, and the older one is the value an
  // operator explicitly threw away. The fold gate alone cannot help here — the redo put the key
  // back in `startedEffects`, so the scan is what has to tell the two apart.
  let turnOneCalls = 0;
  const r = rig({
    spec: agentSpec(),
    script: (_req, turn) => {
      if (turn === 0) return { toolCalls: [{ id: "c0", name: "pay.charge", arguments: { amount: 10 } }], finishReason: "tool_use" };
      turnOneCalls += 1;
      // Fails the FIRST turn-1 of each pass, so both the original run and the post-rewind run
      // retry — and the second retry is the one that must not reach back past the marker.
      if (turnOneCalls === 1 || turnOneCalls === 3) throw err.exhausted(CODES.E_PROVIDER_RATE_LIMIT, "429", { retryAfterMs: 10 });
      return { text: `{"ok":${String(turnOneCalls)}}`, finishReason: "stop" };
    },
    execute: (args, n) => ({ content: `charged #${String(n)}`, writes: { result: `charged #${String(n)}` } }),
  });

  const runId = await r.engine.submit({ graph: r.graph, inputs: {} });
  const first = await driveToRest(r, runId);
  assert.equal(first.status, "succeeded", JSON.stringify(first.error ?? {}));
  assert.deepEqual(r.charges, [10], "pass one charged once and served the retry");

  const startedAt = (await events(r.store, runId)).find((e) => e.type === "effect.started")!.seq;
  await rewindWithPlan(r.engine, runId, (startedAt - 1) as Seq, "operator asked");

  const second = await driveToRest(r, runId);
  assert.equal(second.status, "succeeded", JSON.stringify(second.error ?? {}));
  assert.deepEqual(r.charges, [10, 10], "the redo performed the charge afresh, and its own retry served it back");
  // WHICH record was served, read off the transcript the last turn was actually sent. A
  // first-match scan over the raw journal hands back `charged #1` here — the value the operator
  // threw away — and nothing else in the run would say so.
  const lastTurn = r.model.seen.at(-1)!;
  assert.deepEqual(
    lastTurn.messages.filter((m) => m.role === "tool").map((m) => m.content),
    ["charged #2"],
    "the served tool result must be the REDO's, not the one the rewind undid",
  );
  // AND THE ANSWER THE RUN KEPT. Pass one ended `{"ok":2}` and pass two ends `{"ok":4}` — the
  // turn-1 counter is the only thing that distinguishes them. A scan that reaches back past the
  // rewind marker serves pass one's whole transcript to pass two's retry: no model request is
  // made at all, and the run commits `{"ok":2}` — a value an operator had thrown away, restored
  // by the retry. Measured exactly that way with the suppression filter removed.
  assert.equal(second.channels["result"], '{"ok":4}', "the run must keep the REDO's answer, not the one the rewind undid");
});

test("THE REFUSAL THAT REMAINS: a NON-idempotent tool that started and never completed is not retried", async () => {
  // Serve-by-key closes the completed case and only the completed case. A tool that threw left
  // `effect.started` with no `effect.completed`, so the next attempt would perform it AGAIN —
  // and the journal cannot say whether the request reached the source before it died. This is
  // the residual hole, and `#retryDecision` still fails closed on it.
  const r = rig({
    spec: toolNodeSpec({ idempotent: false }),
    idempotent: false,
    execute: () => {
      throw new Error("connection reset");
    },
  });
  const runId = await r.engine.submit({ graph: r.graph, inputs: {} });
  const p = await driveToRest(r, runId);

  assert.deepEqual(r.charges, [10], "the bell must not be rung a second time on a maybe");
  const log = await events(r.store, runId);
  assert.equal(log.filter((e) => e.type === "task.retry_scheduled").length, 0, "refusing is always allowed; loosening never is");
  assert.equal(p.status, "failed");
});

test("A RECORDED `isError` RESULT IS NOT SERVED — the retry re-reaches the source", async () => {
  // `effect.completed` is appended for a tool that RETURNED, error result included. Treating
  // that as "the call happened, serve it" makes a node's retry read the same failure until
  // `maxAttempts` and never touch the source again.
  const r = rig({
    spec: toolNodeSpec({ idempotent: true }),
    idempotent: true,
    execute: (args, n) =>
      n === 1 ? { content: "upstream is down", isError: true } : { content: "charged", writes: { result: `charged ${String(args["amount"])}` } },
  });
  const runId = await r.engine.submit({ graph: r.graph, inputs: {} });
  const p = await driveToRest(r, runId);

  assert.deepEqual(r.charges, [10, 10], "a recorded failure is not a recorded action");
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
});

test("THE CONTROL: a first execution serves nothing that was never recorded", async () => {
  const r = rig({
    spec: agentSpec(),
    script: (_req, turn) =>
      turn === 0
        ? { toolCalls: [{ id: "c0", name: "pay.charge", arguments: { amount: 10 } }], finishReason: "tool_use" }
        : { text: '{"ok":true}', finishReason: "stop" },
  });
  const runId = await r.engine.submit({ graph: r.graph, inputs: {} });
  const p = await driveToRest(r, runId);

  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(r.charges, [10], "one call, performed for real");
  const log = await events(r.store, runId);
  assert.equal(log.filter((e) => e.type === "task.retry_scheduled").length, 0, "nothing failed, so nothing was served");
});

test("REPLAY OF A RUN THAT EXERCISED THE SERVED PATH STILL REPORTS `match: true`", async () => {
  let turnOneCalls = 0;
  const r = rig({
    spec: agentSpec(),
    script: (_req, turn) => {
      if (turn === 0) return { toolCalls: [{ id: "c0", name: "pay.charge", arguments: { amount: 10 } }], finishReason: "tool_use" };
      turnOneCalls += 1;
      if (turnOneCalls === 1) throw err.exhausted(CODES.E_PROVIDER_RATE_LIMIT, "429", { retryAfterMs: 10 });
      return { text: '{"ok":true}', finishReason: "stop" };
    },
  });
  const runId = await r.engine.submit({ graph: r.graph, inputs: {} });
  const p = await driveToRest(r, runId);
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));

  const before = r.charges.length;
  const report = await replayRun({
    store: r.store,
    runId,
    graph: r.graph,
    engine: { tools: r.tools, functions: r.functions, models: new ModelRegistry() },
  });

  assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match)));
  assert.deepEqual(report.unservedEffects, [], "every recorded effect was consumed by the replay");
  assert.equal(r.charges.length, before, "a replay reaches no tool body");
});

// ── the hole a verifier found: a positional key binds WHERE, not WHAT ────────
//
// ADDED 2026-08-27. `taskId:tool:<ordinal>` says where a call sat in the body's sequence and
// nothing about what it was. A body declaring two effects that calls them in a different order
// on attempt 2 collides at ordinal 0 — and a key-only serve handed the second call the FIRST
// one's result. Identity is (name, version, argsDigest), read off `tool.called`, which is keyed
// identically.
//
// Declining to serve is NOT enough on its own: if a non-idempotent call merely MOVED, its new
// position has no record and performing it acts twice. A detected divergence therefore fails
// closed for any tool that has not declared itself idempotent — which is the one decision that
// flag on the manifest is load-bearing for.

/**
 * One `function` node whose body calls its two declared effects in a different ORDER on the
 * second attempt, having failed retryably after the first call on the first attempt.
 */
async function swappedOrder(idempotent: boolean): Promise<{ calls: string[]; status: string }> {
  const calls: string[] = [];
  const tools = new ToolRegistry();
  for (const name of ["a.first", "a.second"]) {
    tools.register({
      name,
      version: "1.0",
      // NON-IDEMPOTENT but not IRREVERSIBLE: an irreversible effect raises the oversight
      // floor to `in` and the run parks at a gate, which tests the gate rather than the serve.
      irreversibility: name === "a.first" && !idempotent ? "reversible_write" : "read_only",
      idempotent: name === "a.first" ? idempotent : true,
      capabilities: [],
      description: name,
      parameters: { type: "object", properties: {} },
      execute: () => {
        calls.push(name);
        return Promise.resolve({ content: [{ type: "text", text: name }] });
      },
    } as never);
  }

  let attempt = 0;
  const functions = new FunctionRegistry();
  functions.register("function/swap@stable", async (_v, c) => {
    attempt += 1;
    const order = attempt === 1 ? ["a.first", "a.second"] : ["a.second", "a.first"];
    await c.effects![order[0]!]!({});
    // Attempt 1 stops after ONE call, retryably, so attempt 2 re-enters with ordinal 0 free.
    if (attempt === 1) return { retry: { reason: "once" } };
    await c.effects![order[1]!]!({});
    return { writes: { out: "done" } };
  });

  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions,
    models,
    now,
    policy: { granted: ["*"] },
  });

  const graph = compileOrThrow({
    spec: {
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "swap", project: "t", version: 1 },
      policy: { posture: "out", capabilities: [] },
      channels: { out: { type: "string", reduce: "replace" } },
      inputs: [],
      outputs: ["out"],
      nodes: [
        {
          id: "n",
          type: "function",
          writes: ["out"],
          retry: { maxAttempts: 3, backoff: "fixed", initialMs: 0 },
          function: { ref: "function/swap@stable", effects: ["a.first", "a.second"] },
        },
      ],
      edges: [],
    } as unknown as GraphSpec,
    resolver: resolver(),
    tools: {
      "a.first": { name: "a.first", version: "1.0", irreversibility: idempotent ? "read_only" : "reversible_write", idempotent, capabilities: [] },
      "a.second": { name: "a.second", version: "1.0", irreversibility: "read_only", idempotent: true, capabilities: [] },
    } as never,
    tenantCapabilities: [],
  });

  const runId = await engine.submit({ graph, inputs: {} });
  let p = await engine.advance(runId);
  for (let i = 0; i < 6 && p.status === "running"; i += 1) p = await engine.advance(runId);
  return { calls, status: p.status };
}

test("A DIFFERENT CALL AT THE SAME ORDINAL IS NOT SERVED THE FIRST ONE'S RESULT", async () => {
  const { calls } = await swappedOrder(true);
  // `a.second` must not come back holding `a.first`'s record. Both are idempotent here, so the
  // divergence is survivable and each call is simply performed as itself.
  assert.ok(calls.includes("a.second"), `a.second must actually run; saw ${JSON.stringify(calls)}`);
  assert.ok(
    calls.filter((n) => n === "a.first").length >= 1,
    `a.first must not be silently replaced; saw ${JSON.stringify(calls)}`,
  );
});

test("AND A NON-IDEMPOTENT CALL WHOSE POSITION MOVED FAILS CLOSED, rather than acting twice", async () => {
  const { calls } = await swappedOrder(false);
  assert.equal(
    calls.filter((n) => n === "a.first").length,
    1,
    `a non-idempotent tool must not act twice across a re-execution; saw ${JSON.stringify(calls)}`,
  );
});

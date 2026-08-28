/**
 * `Budget.tokens` AND `Budget.wallMs` BIND — the two thirds of the declared triple nobody read.
 *
 * `graph/spec.ts`'s `POLICY_FIELDS.budget` has listed `["costUsd", "tokens", "wallMs"]` for the
 * whole project, and `/usr/bin/grep -arn 'budget\.tokens|budget\.wallMs'` over `src/run/` returned
 * NOTHING. Only `costUsd` was enforced — `run/engine.ts` for the run ceiling and for a node's
 * `policy.budget.costUsd` — so an author writing `budget: {tokens: 200000}` got a clean compile
 * and no ceiling at all. That is precisely the shape `Engine.submit`'s own comment condemns for
 * dollars: "compile clean, and spend without limit".
 *
 * ── The two judgements these tests pin ───────────────────────────────────────
 *
 * **`tokens` means `inputTokens + outputTokens`.** Not a sum over every token-shaped field:
 * `UsageRecord` documents `cacheReadTokens`/`cacheWriteTokens` as DISJOINT from `inputTokens`
 * and `reasoningTokens` as a SUBSET of `outputTokens`, so the wider sum would double-count one
 * and add two the provider bills separately — and a ceiling that over-counts refuses work that
 * fit.
 *
 * **`wallMs` means PROVIDER TIME, not elapsed time.** `A GATED RUN MAY WAIT AS LONG AS IT LIKES`
 * below is the test that decides it: the run parks on a human gate, the injected clock moves a
 * full DAY, and the run still completes under a 10-second ceiling. An elapsed-time reading would
 * kill it for doing nothing wrong, which is the one behaviour oversight exists to permit. The
 * price is stated in `PolicyEngine.settle` and is real: an hour burned inside a tool accrues
 * ZERO here, because `tool.called` carries `ms` and is deliberately not an arm of `chargeUsage`.
 *
 * ── Offline and deterministic ────────────────────────────────────────────────
 *
 * `MockModelAdapter` reports `wallMs: 0` on every turn and `MockTurn` has no field for it, so a
 * wall-time ceiling cannot be exercised through it at all. `TimedAdapter` below is a local
 * `ModelAdapter` that reports a FIXED per-turn usage — no clock is read anywhere, so nothing
 * here depends on how long the test itself takes to run.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { RunId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { PolicyEngine } from "../../src/run/policy.ts";
import {
  FunctionRegistry,
  ModelRegistry,
  ToolRegistry,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
} from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const NOW = 1_700_000_000_000;
const DAY_MS = 86_400_000;

/** What one turn of `TimedAdapter` reports. Fixed, so every assertion is arithmetic. */
interface TurnCost {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly wallMs: number;
}

/**
 * A provider that bills the same amount every turn.
 *
 * `estimateOf` returns the turn's real cost rather than a padded worst case, so the DOLLAR
 * ceiling never fires by accident in a test about tokens — every refusal below is attributable
 * to the dimension the test names. `outputCeilingOf` reports the turn's real output count for
 * the same reason: the TOKEN reservation is then exactly what the turn bills, so the numbers in
 * every assertion below stay arithmetic rather than gaining a padding term.
 */
class TimedAdapter implements ModelAdapter {
  readonly provider = "timed";
  calls = 0;
  readonly #cost: TurnCost;

  constructor(cost: TurnCost) {
    this.#cost = cost;
  }

  async *stream(_req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    if (signal.aborted) throw new Error("aborted");
    this.calls += 1;
    yield {
      type: "done",
      provider: "timed",
      message: { role: "assistant", content: "ok" },
      finishReason: "stop",
      usage: { ...this.#cost },
    };
  }

  priceOf(): number {
    return this.#cost.costUsd;
  }

  estimateOf(): number {
    return this.#cost.costUsd;
  }

  outputCeilingOf(): number {
    return this.#cost.outputTokens;
  }
}

interface Budget {
  readonly costUsd?: number;
  readonly tokens?: number;
  readonly wallMs?: number;
}

/** One agent node, so "did the ceiling bind" is a question about one provider call. */
function oneNode(graphBudget?: Budget, nodeBudget?: Budget): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "triple", project: "budget", version: 1 },
    policy: {
      posture: "out",
      ...(graphBudget === undefined ? {} : { budget: graphBudget }),
      expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 },
    },
    channels: { q: { type: "string", reduce: "replace" }, a: { type: "string", reduce: "replace" } },
    inputs: ["q"],
    outputs: ["a"],
    nodes: [
      {
        id: "ask",
        type: "agent",
        reads: ["q"],
        writes: ["a"],
        agent: { profile: "agent_profile/x@stable", prompt: "prompt/p@stable" },
        ...(nodeBudget === undefined ? {} : { policy: { budget: nodeBudget } }),
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

/** Two agent nodes in sequence, so the SECOND provider call is the one a ceiling can refuse. */
function twoNodes(graphBudget?: Budget): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "triple-pair", project: "budget", version: 1 },
    policy: {
      posture: "out",
      ...(graphBudget === undefined ? {} : { budget: graphBudget }),
      expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 2, maxLoopIterations: 1 },
    },
    channels: {
      q: { type: "string", reduce: "replace" },
      a: { type: "string", reduce: "replace" },
      b: { type: "string", reduce: "replace" },
    },
    inputs: ["q"],
    outputs: ["b"],
    nodes: [
      { id: "first", type: "agent", reads: ["q"], writes: ["a"], agent: { profile: "agent_profile/x@stable", prompt: "prompt/p@stable" } },
      { id: "second", type: "agent", reads: ["a"], writes: ["b"], agent: { profile: "agent_profile/x@stable", prompt: "prompt/p@stable" } },
    ],
    edges: [{ id: "e0", from: "first", to: "second", kind: "seq" }],
  } as unknown as GraphSpec;
}

/** `first → gate → second`, so a provider call happens on BOTH sides of a human's wait. */
function gatedSpec(graphBudget?: Budget): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "triple-gated", project: "budget", version: 1 },
    policy: {
      posture: "out",
      ...(graphBudget === undefined ? {} : { budget: graphBudget }),
      expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 2, maxLoopIterations: 1 },
    },
    channels: {
      q: { type: "string", reduce: "replace" },
      a: { type: "string", reduce: "replace" },
      b: { type: "string", reduce: "replace" },
    },
    inputs: ["q"],
    outputs: ["b"],
    nodes: [
      { id: "first", type: "agent", reads: ["q"], writes: ["a"], agent: { profile: "agent_profile/x@stable", prompt: "prompt/p@stable" } },
      { id: "hold", type: "human_gate", reads: ["a"], humanGate: { ref: "oversight/hold@stable", approval: { approvers: ["u:alice"] } } },
      { id: "second", type: "agent", reads: ["a"], writes: ["b"], agent: { profile: "agent_profile/x@stable", prompt: "prompt/p@stable" } },
    ],
    edges: [
      { id: "e0", from: "first", to: "hold", kind: "seq" },
      { id: "e1", from: "hold", to: "second", kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

interface Rig {
  readonly engine: Engine;
  readonly store: MemoryStateStore;
  readonly adapter: TimedAdapter;
  readonly clock: { t: number };
}

const TURN: TurnCost = { inputTokens: 1_000, outputTokens: 1_000, costUsd: 0.001, wallMs: 5_000 };

function rig(deploymentBudget?: { runUsd?: number; runTokens?: number; runWallMs?: number }, cost: TurnCost = TURN): Rig {
  const clock = { t: NOW };
  const now = (): number => clock.t;
  const models = new ModelRegistry();
  const adapter = new TimedAdapter(cost);
  models.register(adapter, true);
  const store = new MemoryStateStore({ now });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions: new FunctionRegistry(),
    models,
    now,
    sleep: async () => {},
    policy: { granted: [], systemFloor: "out", ...(deploymentBudget === undefined ? {} : { budget: deploymentBudget }) },
  });
  return { engine, store, adapter, clock };
}

const compile = (s: GraphSpec) => compileOrThrow({ spec: s, resolver: resolver(), tools: {}, tenantCapabilities: [] });

async function exhaustedRows(store: MemoryStateStore, runId: RunId): Promise<{ readonly dimension?: string; readonly limit?: number }[]> {
  const out: { readonly dimension?: string; readonly limit?: number }[] = [];
  for await (const ev of store.read(runId, 1)) {
    if (ev.type === "budget.exhausted") out.push(ev.payload as { readonly dimension?: string; readonly limit?: number });
  }
  return out;
}

// ── tokens, at the run ceiling ───────────────────────────────────────────────

test("A GRAPH'S DECLARED TOKEN CEILING BINDS, and it binds BEFORE the call", async () => {
  // 100 tokens against a turn that bills 2,000. Before this, the declaration reached nothing at
  // run time: the call went out, the run succeeded, and the number in the spec was decoration.
  const r = rig({ runUsd: 1000 });
  const runId = await r.engine.submit({ graph: compile(oneNode({ tokens: 100 })), inputs: { q: "hi" } });
  const p = await r.engine.advance(runId);

  assert.notEqual(p.status, "succeeded", `a graph that declared 100 tokens must not spend 2,000: ${JSON.stringify(p.usage)}`);
  assert.equal(p.error?.code, "E_BUDGET_EXHAUSTED", JSON.stringify(p.error ?? {}));
  assert.equal(r.adapter.calls, 0, "the reservation must refuse before the provider is reached, not after it bills");

  const rows = await exhaustedRows(r.store, runId);
  assert.equal(rows.length, 1, "the refusal must reach the journal");
  assert.equal(rows[0]?.dimension, "tokens", "and it must say WHICH ceiling bound, not just that one did");
  assert.equal(rows[0]?.limit, 100, "…and name the number that was exceeded");
});

test("the same graph runs when its token declaration covers the work", async () => {
  // The refusal must be about the number, not about declaring one at all.
  const r = rig({ runUsd: 1000 });
  const runId = await r.engine.submit({ graph: compile(oneNode({ tokens: 1_000_000 })), inputs: { q: "hi" } });
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.equal(r.adapter.calls, 1, "and the provider was actually reached");
});

test("A GRAPH CANNOT VOTE ITSELF MORE TOKENS THAN THE DEPLOYMENT ALLOWS", async () => {
  // The direction, which the dollar version of this fix got backwards on its first attempt: a
  // graph is a document the deployment RAN, so its declaration may only lower an operator's cap.
  const r = rig({ runTokens: 100 });
  const runId = await r.engine.submit({ graph: compile(oneNode({ tokens: 1_000_000_000 })), inputs: { q: "hi" } });
  const p = await r.engine.advance(runId);
  assert.notEqual(p.status, "succeeded", "the deployment's cap must still bind");
  assert.equal(r.adapter.calls, 0, "and nothing may have been spent");
});

test("A DEPLOYMENT TOKEN CEILING WITH NO GRAPH DECLARATION BINDS ON ITS OWN", async () => {
  const r = rig({ runTokens: 100 });
  const runId = await r.engine.submit({ graph: compile(oneNode()), inputs: { q: "hi" } });
  const p = await r.engine.advance(runId);
  assert.equal(p.error?.code, "E_BUDGET_EXHAUSTED", JSON.stringify(p.error ?? {}));
});

// ── tokens, at the node ceiling ──────────────────────────────────────────────

test("A NODE'S OWN TOKEN CEILING BINDS — the deployment allows plenty and the node does not", async () => {
  const r = rig({ runUsd: 1000 });
  const runId = await r.engine.submit({ graph: compile(oneNode(undefined, { tokens: 100 })), inputs: { q: "hi" } });
  const p = await r.engine.advance(runId);

  assert.equal(p.error?.code, "E_BUDGET_EXHAUSTED", JSON.stringify(p.error ?? {}));
  assert.match(String(p.error?.message ?? ""), /node "ask"/, "the message must name the node, not the run");
  assert.equal(r.adapter.calls, 0, "and it must refuse before the call");

  const rows = await exhaustedRows(r.store, runId);
  assert.equal(rows[0]?.dimension, "tokens");
  assert.equal(rows[0]?.limit, 100, "a NODE ceiling must journal the node's number, not the run's");
});

test("the same node runs when its own token declaration covers the work", async () => {
  const r = rig({ runUsd: 1000 });
  const runId = await r.engine.submit({ graph: compile(oneNode(undefined, { tokens: 1_000_000 })), inputs: { q: "hi" } });
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
});

// ── wall time, which is PROVIDER time ────────────────────────────────────────

test("A WALL-TIME CEILING STOPS THE NEXT CALL — settled, because a duration cannot be reserved", async () => {
  // Two agent nodes at 5,000 ms each under a 5,000 ms ceiling.
  //
  // THE FIRST CALL IS UNPREVENTABLE and the test asserts it happened. Nothing knows how long a
  // provider will take until it has taken it, so there is no worst case to debit up front and
  // `PolicyEngine` holds no `#reservedWallMs` — the comparison is against SETTLED time alone.
  // What the ceiling guarantees is therefore exactly this: the call after the ceiling is reached
  // does not happen. The first version of this test asserted a 6,000 ms ceiling would stop a
  // second call after 5,000 ms were spent, which is a claim only a reservation could keep.
  const r = rig({ runUsd: 1000 });
  const runId = await r.engine.submit({ graph: compile(twoNodes({ wallMs: 5_000 })), inputs: { q: "hi" } });
  const p = await r.engine.advance(runId);

  assert.equal(r.adapter.calls, 1, "the first call is unpreventable and must have happened exactly once");
  assert.notEqual(p.status, "succeeded", `a ceiling that has been reached must refuse the next call: ${JSON.stringify(p.usage)}`);

  const rows = await exhaustedRows(r.store, runId);
  assert.equal(rows[0]?.dimension, "wallMs", `expected a wallMs refusal, got ${JSON.stringify(rows)}`);
  assert.equal(rows[0]?.limit, 5_000);
});

test("A GATED RUN MAY WAIT AS LONG AS IT LIKES — the ceiling counts provider time, not the clock", async () => {
  // THE JUDGEMENT, made checkable. The run parks on a human gate having burned 5,000 ms of
  // provider time; the injected clock then moves a full DAY before the human answers. Under an
  // elapsed-time reading the 10,000 ms ceiling is 8,640× exceeded and the second node dies. Under
  // provider time it is half spent and the run finishes — a run whose only fault was waiting for
  // a person is not a run that overspent.
  const r = rig({ runUsd: 1000 });
  const runId = await r.engine.submit({ graph: compile(gatedSpec({ wallMs: 10_000 })), inputs: { q: "hi" } });
  const parked = await r.engine.advance(runId);
  assert.equal(parked.status, "awaiting_gate", `the run must park on its gate: ${JSON.stringify(parked.error ?? {})}`);

  r.clock.t += DAY_MS;

  const gateId = Object.values(parked.gates).find((g) => g.state === "open")!.gateId;
  const done = await r.engine.resolveGate(runId, {
    gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:alice", via: "console" },
    idempotencyKey: "k1",
  });

  assert.equal(done.status, "succeeded", `a night on a gate is not spend: ${JSON.stringify(done.error ?? {})}`);
  assert.equal(r.adapter.calls, 2, "both provider calls happened");
  assert.equal(done.usage.wallMs, 10_000, "and the run accrued exactly the two turns' provider time");
});

// ── across a restart, which is the non-negotiable ────────────────────────────

test("PolicyEngine.restore re-seeds tokens and wall time, and a second restore cannot lower them", () => {
  const pe = new PolicyEngine({ granted: [], budget: { runTokens: 1_000, runWallMs: 1_000 } });
  pe.restore({ escalations: {}, ceilings: {}, spentUsd: 0, spentTokens: 800, spentWallMs: 600 });
  assert.equal(pe.spentTokens, 800, "tokens are restored, not reset");
  assert.equal(pe.spentWallMs, 600, "and so is provider time");

  pe.restore({ escalations: {}, ceilings: {}, spentUsd: 0, spentTokens: 10, spentWallMs: 10 });
  assert.equal(pe.spentTokens, 800, "a second restore must not lower the running total");
  assert.equal(pe.spentWallMs, 600, "…in either dimension");

  // An omitted field must read as zero and change nothing — the arm an older caller takes.
  pe.restore({ escalations: {}, ceilings: {}, spentUsd: 0 });
  assert.equal(pe.spentTokens, 800);
  assert.equal(pe.spentWallMs, 600);
});

test("TOKENS SURVIVE A RESTART — a second process does not hand the run its token budget back", async () => {
  // Invariant 2, in the form it has been violated five times: a ceiling that accumulates in
  // process memory is refunded by the crash. Nothing new is journaled for this — `p.usage`
  // already folds `inputTokens`/`outputTokens` out of the effect records, so the restart arm is
  // the same `restore` the dollars use, handed the other two fields.
  const store = new MemoryStateStore({ now: () => NOW });
  const first = rig({ runTokens: 3_000 });
  // One store, two Engines. The second is built exactly like the first, which is what makes the
  // difference between them a restart rather than a different deployment.
  const shared = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions: new FunctionRegistry(),
    models: (() => {
      const m = new ModelRegistry();
      m.register(new TimedAdapter(TURN), true);
      return m;
    })(),
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: [], systemFloor: "out", budget: { runTokens: 3_000 } },
  });
  void first;

  const graph = compile(gatedSpec());
  const runId = await shared.submit({ graph, inputs: { q: "hi" } });
  const parked = await shared.advance(runId);
  assert.equal(parked.status, "awaiting_gate", JSON.stringify(parked.error ?? {}));
  assert.equal(parked.usage.inputTokens + parked.usage.outputTokens, 2_000, "precondition: one turn, 2,000 tokens");

  // THE RESTART. A fresh Engine over the same journal, with no memory of the 2,000 already spent.
  const revivedAdapter = new TimedAdapter(TURN);
  const revivedModels = new ModelRegistry();
  revivedModels.register(revivedAdapter, true);
  const revived = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions: new FunctionRegistry(),
    models: revivedModels,
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: [], systemFloor: "out", budget: { runTokens: 3_000 } },
  });
  revived.attach(runId, graph);

  const gateId = Object.values(parked.gates).find((g) => g.state === "open")!.gateId;
  const after = await revived.resolveGate(runId, {
    gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:alice", via: "console" },
    idempotencyKey: "k1",
  });

  assert.equal(revivedAdapter.calls, 0, "the second turn would take the total to 4,000 against a 3,000 ceiling");
  assert.notEqual(after.status, "succeeded", `a restart must not refund tokens: ${JSON.stringify(after.usage)}`);
  const rows = await exhaustedRows(store, runId);
  assert.equal(rows[0]?.dimension, "tokens", `expected the token ceiling to bind, got ${JSON.stringify(rows)}`);
});

test("WALL TIME SURVIVES A RESTART TOO", async () => {
  const store = new MemoryStateStore({ now: () => NOW });
  const build = (): { engine: Engine; adapter: TimedAdapter } => {
    const adapter = new TimedAdapter(TURN);
    const models = new ModelRegistry();
    models.register(adapter, true);
    return {
      adapter,
      engine: new Engine({
        store,
        bus: new InProcessEventBus({ store }),
        tools: new ToolRegistry(),
        functions: new FunctionRegistry(),
        models,
        now: () => NOW,
        sleep: async () => {},
        policy: { granted: [], systemFloor: "out", budget: { runWallMs: 5_000 } },
      }),
    };
  };

  const graph = compile(gatedSpec());
  const a = build();
  const runId = await a.engine.submit({ graph, inputs: { q: "hi" } });
  const parked = await a.engine.advance(runId);
  assert.equal(parked.status, "awaiting_gate", JSON.stringify(parked.error ?? {}));
  assert.equal(parked.usage.wallMs, 5_000, "precondition: one turn of provider time is on the journal");

  const b = build();
  b.engine.attach(runId, graph);
  const gateId = Object.values(parked.gates).find((g) => g.state === "open")!.gateId;
  const after = await b.engine.resolveGate(runId, {
    gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:alice", via: "console" },
    idempotencyKey: "k1",
  });

  assert.equal(b.adapter.calls, 0, "5,000 ms is already on the journal, reaching the 5,000 ms ceiling — no second turn");
  assert.notEqual(after.status, "succeeded", `a restart must not refund provider time: ${JSON.stringify(after.usage)}`);
});

/**
 * TWO WAYS "THE RUN IS OUT OF MONEY" WAS TURNED INTO A FACT ABOUT SOMETHING ELSE.
 *
 *   - `#finish` carried `p.budgetExhausted` into its per-task FATAL filter. That flag is a
 *     statement about the RUN — one `budget.exhausted` row, no task it belongs to — so folding it
 *     into a task predicate made EVERY failed task fatal the moment the money ran out, including
 *     one that routed cleanly down an `error` edge and was handled. `failed[0]` was then whichever
 *     failed task the projection's map happened to yield first, and a budget-killed run reported
 *     that task's `E_RESOURCE_INVALID` instead of `E_BUDGET_EXHAUSTED` with its
 *     dimension/limit/spent. Nothing is needed in its place: the task that could not reserve
 *     fails with `E_BUDGET_EXHAUSTED`, which is already a member of `RUN_FATAL_CODES`.
 *
 *   - `run.submitted.limits` was written from the post-min-fold number, so the DEPLOYMENT's own
 *     ceiling was journaled as though it were a bound imposed on the run — and `PolicyEngine
 *     .restore` mins it in forever. "Raise the budget and resume" therefore stopped working: an
 *     in-flight run stayed pinned to whatever ceiling stood the instant somebody pressed submit.
 *     An operator's ceiling is an operator's ceiling precisely because config re-supplies it on
 *     every attach; only bounds NARROWER than it — the caller's allotment and the graph's own
 *     declaration — are facts about the run.
 *
 * EVERY CASE HAS ITS ORDINARY-CASE CONTROL, because both defects are shapes where the wrong
 * answer and the right one differ only in which of two true things gets reported.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { digest } from "../../src/canonical.ts";
import { CODES, err } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";
import type { EdgeId, NodeId, RunId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import {
  FunctionRegistry,
  MockModelAdapter,
  ModelRegistry,
  ToolRegistry,
} from "../../src/run/registry.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;
const NOW = (): number => 1_700_000_000_000;

const RESOLVER: ResourceResolver = (() => {
  const minted = new Set<string>();
  return {
    resolve(ref) {
      if (!/^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref)) return undefined;
      const pinned = digest({ fixture: "lane-a-budget", ref });
      minted.add(pinned);
      return { ref, digest: pinned, channel: "stable" };
    },
    document: (pinned) => (minted.has(pinned) ? "Test instructions." : undefined),
  };
})();

async function events(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) out.push(ev);
  return out;
}

// ── 1 · a budget-killed run reports the BUDGET ──────────────────────────────

/**
 * `boom` fails ORDINARILY and its failure is HANDLED — `rescue` is on the other end of an `error`
 * edge and writes the declared output. `spend` runs beside it and takes more turns than the
 * budget can reserve.
 *
 * `boom` is an entry node and is journaled first, so `Object.values(p.tasks)` yields it before
 * `spend`: with `p.budgetExhausted` in the fatal filter, IT is `failed[0]` and its error is what
 * the run reports.
 */
function mixedSpec(opts: { readonly withHandledFailure: boolean }): GraphSpec {
  const nodes: unknown[] = [];
  const edges: unknown[] = [];
  if (opts.withHandledFailure) {
    nodes.push(
      { id: n("boom"), type: "function", writes: [], function: { ref: "function/boom@stable" } },
      { id: n("rescue"), type: "function", writes: ["out"], function: { ref: "function/rescue@stable" }, unhandled: true },
    );
    edges.push({ id: e("b2r"), from: n("boom"), to: n("rescue"), kind: "error" });
  } else {
    nodes.push({ id: n("seed"), type: "function", writes: ["out"], function: { ref: "function/rescue@stable" } });
  }
  nodes.push({
    id: n("spend"),
    type: "agent",
    writes: ["spent"],
    agent: {
      profile: "agent_profile/w@stable",
      prompt: "prompt/w@stable",
      maxTurns: 4,
      tools: [],
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    },
  });
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "mixed", project: "lane-a", version: 1 },
    policy: { posture: "out" },
    channels: { out: { type: "object", reduce: "replace" }, spent: { type: "object", reduce: "replace" } },
    inputs: [],
    outputs: ["out"],
    nodes,
    edges,
  } as unknown as GraphSpec;
}

function mixedEngine(store: MemoryStateStore, runUsd: number): Engine {
  const functions = new FunctionRegistry();
  functions.register("function/boom@stable", () => {
    throw err.validation(CODES.E_RESOURCE_INVALID, "the note could not be parsed");
  });
  functions.register("function/rescue@stable", () => ({ writes: { out: { rescued: true } } }));
  const models = new ModelRegistry();
  models.register(
    new MockModelAdapter({ script: () => ({ text: JSON.stringify({ ok: true }), finishReason: "stop" }), pricePerMTok: 1 }),
    true,
  );
  return new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models,
    now: NOW,
    sleep: async () => {},
    resolver: RESOLVER,
    policy: { granted: ["*"], systemFloor: "out", budget: { runUsd } },
  });
}

test("A BUDGET-KILLED RUN REPORTS THE BUDGET, NOT A FAILURE THE GRAPH ALREADY HANDLED", async () => {
  const store = new MemoryStateStore({ now: NOW });
  const engine = mixedEngine(store, 0.0000001);
  const graph = compileOrThrow({ spec: mixedSpec({ withHandledFailure: true }), resolver: RESOLVER, tools: {}, tenantCapabilities: ["*"] });
  const p = await engine.advance(await engine.submit({ graph, inputs: {} }));

  // PRECONDITION, or this measures nothing: the run really did run out of money AND really did
  // have an ordinary failure in it that the graph handled.
  const types = (await events(store, p.runId)).map((ev) => ev.type);
  assert.ok(types.includes("budget.exhausted"), `the fixture must exhaust its budget: ${types.join(",")}`);
  const boom = Object.values(p.tasks).find((t) => t.nodeId === n("boom"));
  assert.equal(boom?.state, "failed", "the fixture must contain a failed task…");
  assert.ok((boom?.take.length ?? 0) > 0, "…that took its error edge, which is what makes it HANDLED");

  assert.equal(p.status, "failed");
  assert.equal(p.error?.code, "E_BUDGET_EXHAUSTED", `the run died of money, not of ${String(p.error?.code)}`);
  const details = p.error?.details as { dimension?: string; limit?: number; spent?: number } | undefined;
  assert.equal(details?.dimension, "costUsd", "and the detail an operator acts on survives");
  assert.equal(typeof details?.limit, "number");
  assert.equal(typeof details?.spent, "number");
});

test("…and a budget-killed run with NO handled failure reports the same thing", async () => {
  // THE ORDINARY CASE. Without it, a "fix" that reported `E_BUDGET_EXHAUSTED` for every failed
  // run at all would pass the test above.
  const store = new MemoryStateStore({ now: NOW });
  const engine = mixedEngine(store, 0.0000001);
  const graph = compileOrThrow({ spec: mixedSpec({ withHandledFailure: false }), resolver: RESOLVER, tools: {}, tenantCapabilities: ["*"] });
  const p = await engine.advance(await engine.submit({ graph, inputs: {} }));
  assert.equal(p.status, "failed");
  assert.equal(p.error?.code, "E_BUDGET_EXHAUSTED", JSON.stringify(p.error ?? {}));
});

test("…and an ORDINARY handled failure with money to spare is still handled, and the run succeeds", async () => {
  // The other ordinary case: the same graph, a budget that fits. A fix that made the budget flag
  // decide anything about a task would show up here as a run that failed for no reason.
  const store = new MemoryStateStore({ now: NOW });
  const engine = mixedEngine(store, 1);
  const graph = compileOrThrow({ spec: mixedSpec({ withHandledFailure: true }), resolver: RESOLVER, tools: {}, tenantCapabilities: ["*"] });
  const p = await engine.advance(await engine.submit({ graph, inputs: {} }));
  const types = (await events(store, p.runId)).map((ev) => ev.type);
  assert.ok(!types.includes("budget.exhausted"), "precondition: this run has room");
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(p.channels["out"], { rescued: true }, "the error edge did its job");
});

// ── 2 · the deployment's ceiling is not a bound on the run ──────────────────

/**
 * One agent node behind a human gate, so the run can be parked while the process is replaced —
 * the same device `lane-a-child-bounds-survive-restart.test.ts` uses, and the only way to observe
 * what a SECOND engine restores over one journal.
 */
function gatedSpec(declared?: number): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "gated", project: "lane-a", version: 1 },
    policy: { posture: "out", ...(declared === undefined ? {} : { budget: { costUsd: declared } }) },
    channels: { go: { type: "object", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: [],
    outputs: ["out"],
    nodes: [
      { id: n("gate"), type: "human_gate", writes: ["go"], humanGate: { ref: "oversight/g@stable" } },
      {
        id: n("act"),
        type: "agent",
        reads: ["go"],
        writes: ["out"],
        agent: {
          profile: "agent_profile/w@stable",
          prompt: "prompt/w@stable",
          maxTurns: 1,
          tools: [],
          outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
        },
      },
    ],
    edges: [{ id: e("g2a"), from: n("gate"), to: n("act"), kind: "seq" }],
  } as unknown as GraphSpec;
}

const HUMAN = { kind: "human", subject: "u:ops", via: "cli" } as const;

function gatedEngine(store: MemoryStateStore, runUsd: number): Engine {
  const models = new ModelRegistry();
  models.register(
    new MockModelAdapter({ script: () => ({ text: JSON.stringify({ ok: true }), finishReason: "stop" }), pricePerMTok: 1 }),
    true,
  );
  return new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions: new FunctionRegistry(),
    models,
    now: NOW,
    sleep: async () => {},
    resolver: RESOLVER,
    policy: { granted: ["*"], systemFloor: "out", budget: { runUsd } },
  });
}

/** Submit and park on the gate in `first`, then approve in `second` — one journal, two engines. */
async function acrossProcesses(
  store: MemoryStateStore,
  spec: GraphSpec,
  submitUsd: number,
  resumeUsd: number,
): Promise<{ readonly status: string; readonly error?: { readonly code: string } }> {
  const graph: RunGraph = compileOrThrow({ spec, resolver: RESOLVER, tools: {}, tenantCapabilities: ["*"] });
  const first = gatedEngine(store, submitUsd);
  const runId = await first.submit({ graph, inputs: {} });
  const parked = await first.advance(runId);
  assert.equal(parked.status, "awaiting_gate", JSON.stringify(parked.error ?? {}));
  const second = gatedEngine(store, resumeUsd);
  second.attach(runId, graph);
  await second.rehydrateGates(runId);
  const gates = await second.openGates(runId);
  assert.equal(gates.length, 1, `the run must be parked on exactly one gate: ${JSON.stringify(gates)}`);
  const p = await second.resolveGate(runId, {
    gateId: gates[0]!.gateId,
    decision: { kind: "approve" },
    actor: HUMAN,
    idempotencyKey: "k1",
  });
  return { status: p.status, ...(p.error === undefined ? {} : { error: { code: p.error.code } }) };
}

test("RAISING THE DEPLOYMENT BUDGET AND RESUMING WORKS — the operator's ceiling is re-read, not frozen", async () => {
  // The bound that killed this run in the first process is the OPERATOR's, and the operator has
  // since raised it. Journaling it on `run.submitted` made it a property of the run instead, and
  // `restore` min-folded it back in forever: the resumed run died at the old number.
  const store = new MemoryStateStore({ now: NOW });
  const after = await acrossProcesses(store, gatedSpec(), 0.0000001, 1);
  assert.equal(after.status, "succeeded", `the raised ceiling must be the one that applies, saw ${JSON.stringify(after)}`);
});

test("…and the CONTROL: with the ceiling still low, the resumed run is still refused", async () => {
  // Otherwise the test above passes on any engine that has stopped enforcing budgets at all.
  const store = new MemoryStateStore({ now: NOW });
  const after = await acrossProcesses(store, gatedSpec(), 0.0000001, 0.0000001);
  assert.equal(after.status, "failed", JSON.stringify(after));
  assert.equal(after.error?.code, "E_BUDGET_EXHAUSTED");
});

test("…and the GRAPH'S OWN declaration still binds across the same restart", async () => {
  // The half that must NOT be re-read from config. A graph may lower an operator's ceiling, that
  // is a fact about this run, and it is journaled for exactly the reason the operator's is not.
  const store = new MemoryStateStore({ now: NOW });
  const after = await acrossProcesses(store, gatedSpec(0.0000001), 1, 1);
  assert.equal(after.status, "failed", `the graph declared $0.0000001 and that survives a restart, saw ${JSON.stringify(after)}`);
  assert.equal(after.error?.code, "E_BUDGET_EXHAUSTED");
});

test("`run.submitted.limits` carries no dimension the deployment alone supplied", async () => {
  // Read at the journal rather than only through behaviour, because the behavioural tests above
  // pass for a build that records the number and then ignores it — which would be a second bug
  // rather than this one fixed.
  const store = new MemoryStateStore({ now: NOW });
  const engine = gatedEngine(store, 0.5);
  const graph = compileOrThrow({ spec: gatedSpec(), resolver: RESOLVER, tools: {}, tenantCapabilities: ["*"] });
  const runId = await engine.submit({ graph, inputs: {} });
  const submitted = (await events(store, runId)).find((ev) => ev.type === "run.submitted");
  const limits = (submitted?.payload as { limits?: Record<string, number> }).limits;
  assert.equal(limits, undefined, `nothing narrower than the deployment's ceiling was declared: ${JSON.stringify(limits)}`);
});

test("…and it DOES carry the graph's own declaration, which is narrower than the deployment's", async () => {
  const store = new MemoryStateStore({ now: NOW });
  const engine = gatedEngine(store, 0.5);
  const graph = compileOrThrow({ spec: gatedSpec(0.25), resolver: RESOLVER, tools: {}, tenantCapabilities: ["*"] });
  const runId = await engine.submit({ graph, inputs: {} });
  const submitted = (await events(store, runId)).find((ev) => ev.type === "run.submitted");
  assert.deepEqual((submitted?.payload as { limits?: unknown }).limits, { runUsd: 0.25 });
});

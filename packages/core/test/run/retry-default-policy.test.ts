/**
 * The requeue path had never run.
 *
 * `Engine.#retryDecision` returns early on `policy === undefined`, and `policy` is
 * `w.node.retry` — an AUTHORED field. No shipped example graph declares one
 * (`grep -ac '"retry"' examples/graphs/*` → four zeros), `agent()`'s `specFor` emits none, and
 * `graph/compile.ts` contained no `retry` at all. So the engine's complete, journal-backed
 * requeue exit was unreachable for every graph this product ships, and the only thing standing
 * between a 429 and a failed run was a hidden sleep inside the HTTP transport.
 *
 * These tests are about the COMPILED policy: that a provider-calling node gets one, that an
 * author's own declaration is never touched by it, and that nodes which cannot benefit from a
 * retry do not get one.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { agent } from "../../src/agent.ts";
import { InProcessEventBus } from "../../src/bus.ts";
import { CODES, err } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RetryPolicy } from "../../src/graph/spec.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { NodeId, RunId } from "../../src/ids.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";
import { INCIDENT_CAPABILITIES, INCIDENT_TOOLS, incidentTriageSpec } from "../../src/workflows/incident-triage.ts";

const AGENT_BLOCK = { profile: "agent_profile/default@v1", prompt: "prompt/p@v1", maxTurns: 2 };

/** One node that declared a policy and one that did not, so "wins" is checked against a real floor. */
function twoNodeSpec(opts: { declaredRetry: RetryPolicy }): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "retry-declared", project: "t", version: 1 },
    policy: { posture: "out" },
    channels: { a: { type: "string", reduce: "replace" }, b: { type: "string", reduce: "replace" } },
    inputs: [],
    outputs: ["a"],
    nodes: [
      { id: "declared", type: "agent", writes: ["a"], unhandled: true, retry: opts.declaredRetry, agent: AGENT_BLOCK },
      { id: "undeclared", type: "agent", writes: ["b"], unhandled: true, agent: AGENT_BLOCK },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

/** One of every node type that must NOT be handed a default, plus the rubric arm that must. */
function nodeZooSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "retry-zoo", project: "t", version: 1 },
    policy: { posture: "out" },
    channels: {
      out: { type: "string", reduce: "replace" },
      verdict: { type: "object", reduce: "replace" },
      score: { type: "object", reduce: "replace" },
      items: { type: "array", reduce: "append_ordered" },
      thought: { type: "string", reduce: "replace" },
      childOut: { type: "string", reduce: "replace" },
    },
    inputs: [],
    outputs: ["out"],
    nodes: [
      { id: "fn", type: "function", writes: ["out"], unhandled: true, function: { ref: "function/b@stable" } },
      // An HTTP-speaking tool is the interesting exclusion, and `fs.write` stands for it: the
      // engine cannot know a tool's transport, and the manifest describes irreversibility rather
      // than retryability.
      { id: "save", type: "tool", writes: ["items"], unhandled: true, tool: { name: "fs.write", version: "1.0", args: {} } },
      { id: "approve", type: "human_gate", unhandled: true, humanGate: { ref: "gate/g@v1" } },
      { id: "assertion", type: "evaluator", writes: ["score"], unhandled: true, evaluator: { kind: "assertion", ref: "function/b@stable" } },
      { id: "rubric", type: "evaluator", writes: ["verdict"], unhandled: true, evaluator: { kind: "rubric", ref: "prompt/p@v1" } },
      // ADDED 2026-08-26. The zoo held five of the eight node types, so "not every node" was a
      // SAMPLE — and a verifier rewrote the predicate as a negative list, silently handing a
      // provider's policy to the three that were missing, with the whole gate green.
      { id: "think", type: "agent", writes: ["thought"], unhandled: true, agent: { profile: "agent_profile/a@stable", prompt: "prompt/p@v1", maxTurns: 1 } },
      { id: "child", type: "subgraph", writes: ["childOut"], unhandled: true, subgraph: { ref: "subgraph/s@stable" } },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

/**
 * `router` and `join` in a graph that actually wires them.
 *
 * SEPARATE FROM THE ZOO because neither can stand alone: a router's `fallbackEdge` must name an
 * edge it owns (GRAPH005) and a join's branch must have an edge running to it (GRAPH008). Forcing
 * them into an edgeless zoo produced five structural errors and taught nothing about retry — the
 * question here is which node types are handed a default, not whether a graph is well-formed.
 */
function routedSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "retry-routed", project: "t", version: 1 },
    policy: { posture: "out" },
    channels: {
      seed: { type: "string", reduce: "replace" },
      parts: { type: "array", reduce: "append_ordered" },
    },
    inputs: ["seed"],
    outputs: ["parts"],
    nodes: [
      { id: "start", type: "function", reads: ["seed"], writes: ["parts"], function: { ref: "function/b@stable" } },
      { id: "pick", type: "router", reads: ["seed"], writes: [], router: { mode: "first_match", cases: [], fallbackEdge: "toEnd" } },
      { id: "wait", type: "join", reads: ["parts"], writes: ["parts"], join: { branches: ["start"], mode: "all", onBranchError: "fail" } },
      { id: "end", type: "function", reads: ["seed"], writes: [], unhandled: true, function: { ref: "function/b@stable" } },
    ],
    edges: [
      { id: "toJoin", from: "start", to: "wait", kind: "join" },
      { id: "toRouter", from: "wait", to: "pick", kind: "seq" },
      { id: "toEnd", from: "pick", to: "end", kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

function throwingFunctionSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "retry-fn", project: "t", version: 1 },
    policy: { posture: "out" },
    channels: { seen: { type: "array", reduce: "append_ordered" } },
    inputs: [],
    outputs: ["seen"],
    nodes: [{ id: "boom", type: "function", writes: ["seen"], function: { ref: "function/boom@stable" } }],
    edges: [],
  } as unknown as GraphSpec;
}

async function events(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const e of store.read(runId, 1)) out.push(e);
  return out;
}

/** A clock the test moves by hand — the backoff is wall-clock and nothing here may sleep. */
function clock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test("A 429 ON AN UNDECLARED AGENT NODE IS RETRIED, and the run finishes", async () => {
  const c = clock();
  const store = new MemoryStateStore({ now: c.now });
  let calls = 0;
  const a = agent({
    prompt: "You summarise things.",
    adapter: new MockModelAdapter({
      script: () => {
        calls += 1;
        if (calls === 1) {
          throw err.exhausted(CODES.E_PROVIDER_RATE_LIMIT, "provider rate limit (429)", {
            details: { status: 429 },
            retryAfterMs: 2_000,
          });
        }
        return { text: '{"summary":"it works"}', finishReason: "stop" as const };
      },
    }),
    store,
    now: c.now,
  });

  let r = await a.run("summarise this");
  // `advance` returns while a Task is in backoff, so the caller moves the clock and asks again —
  // exactly what `loom run`'s `driveToRest` does against real time.
  for (let i = 0; i < 8 && r.status === "running"; i++) {
    c.advance(60_000);
    r = await a.advance(r.runId);
  }

  const log = await events(store, r.runId);
  const scheduled = log.filter((e) => e.type === "task.retry_scheduled");
  assert.ok(scheduled.length >= 1, `the requeue path must have been reached; journal:\n${log.map((e) => e.type).join("\n")}`);
  assert.equal(r.status, "succeeded", JSON.stringify(r.projection.error ?? {}));
  assert.equal(r.output, '{"summary":"it works"}');
  assert.equal(calls, 2, "the provider was called again after the rate limit");
});

test("AN AUTHOR'S DECLARATION IS NOT TOUCHED — the default is a floor, never an override", () => {
  const declared = { maxAttempts: 7, backoff: "fixed", initialMs: 250, onlyIf: ["E_PROVIDER_RATE_LIMIT"] } as const;
  const g = compileOrThrow({
    spec: twoNodeSpec({ declaredRetry: declared }),
    resolver: resolver(),
    tools: {},
    tenantCapabilities: [],
  });

  assert.deepEqual(g.plans["declared" as NodeId]?.retry, declared, "a declared policy must survive compilation byte for byte");
  // …and the node next to it, which declared nothing, still gets the floor. Both halves in one
  // assertion set, because "wins" is only meaningful against a default that was actually applied.
  assert.deepEqual(g.plans["undeclared" as NodeId]?.retry, {
    maxAttempts: 3,
    backoff: "exponential",
    initialMs: 1_000,
    maxMs: 30_000,
  });
});

test("NOT EVERY NODE — a function, a tool, a gate and an assertion evaluator get nothing", () => {
  const g = compileOrThrow({
    spec: nodeZooSpec(),
    resolver: resolver(),
    tools: {
      "fs.write": { name: "fs.write", version: "1.0", irreversibility: "reversible_write", idempotent: true, capabilities: ["fs:write"] },
    },
    tenantCapabilities: ["fs:write"],
  });
  for (const id of ["fn", "save", "approve", "assertion"]) {
    assert.equal(g.plans[id as NodeId]?.retry, undefined, `${id} must not be handed a retry policy it cannot benefit from`);
  }
  // The rubric arm of an evaluator is one model call, so it belongs to the set that CAN.
  assert.equal(g.plans["rubric" as NodeId]?.retry?.maxAttempts, 3, "a rubric evaluator reaches a provider");
});

test("A DETERMINISTIC FUNCTION FAILURE IS NOT RETRIED INTO THE GROUND", async () => {
  let calls = 0;
  const functions = new FunctionRegistry();
  functions.register("function/boom@stable", () => {
    calls += 1;
    // RETRYABLE ON PURPOSE. A plain throw is `internal` and `#retryDecision` refuses it on
    // `!error.retryable` whatever the policy, so it would pass even if functions HAD been given
    // a default. `unavailable` is in the retryable class, so the only thing standing between
    // this body and three invocations is that a function node compiles to no policy at all.
    throw err.unavailable(CODES.E_PROVIDER_OVERLOADED, "flaky in a way retrying cannot fix");
  });
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now: () => 1_700_000_000_000,
    sleep: async () => {},
    policy: { granted: [], systemFloor: "out" },
  });
  const graph = compileOrThrow({ spec: throwingFunctionSpec(), resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: {} });
  const p = await engine.advance(runId);

  assert.equal(p.status, "failed");
  assert.equal(calls, 1, "the body ran once; a default here would have burned the budget hiding the bug");
  const log = await events(store, runId);
  assert.deepEqual(log.filter((e) => e.type === "task.retry_scheduled"), []);
});

test("THE DEFAULT DOES NOT WIDEN THE RETRYABLE CLASS — a rejected credential fails at once", async () => {
  const c = clock();
  const store = new MemoryStateStore({ now: c.now });
  let calls = 0;
  const a = agent({
    prompt: "You summarise things.",
    adapter: new MockModelAdapter({
      script: () => {
        calls += 1;
        throw err.policy(CODES.E_PROVIDER_AUTH, "provider rejected credentials (401)");
      },
    }),
    store,
    now: c.now,
  });

  let r = await a.run("summarise this");
  for (let i = 0; i < 4 && r.status === "running"; i++) {
    c.advance(60_000);
    r = await a.advance(r.runId);
  }

  assert.equal(r.status, "failed");
  assert.equal(calls, 1, "a 401 will be a 401 again; the compiled default must not re-send it");
  const log = await events(store, r.runId);
  assert.deepEqual(log.filter((e) => e.type === "task.retry_scheduled"), []);
});

test("THE WHOLE RETRYABLE CLASS, NOT JUST A RATE LIMIT — a 529 with no `retry-after` is retried too", async () => {
  // The design decision this pins. Narrowing the default to `onlyIf: ["E_PROVIDER_RATE_LIMIT"]`
  // would leave `E_PROVIDER_OVERLOADED` (529/503/502/504) and `E_PROVIDER_TRANSPORT` (408/425)
  // unretried, and those are the transient failures that actually dominate — so a default that
  // ignores them is a default that does not do the job. Nothing here advises a delay either, so
  // this also exercises the compiled curve rather than the provider's own instruction.
  const c = clock();
  const store = new MemoryStateStore({ now: c.now });
  let calls = 0;
  const a = agent({
    prompt: "You summarise things.",
    adapter: new MockModelAdapter({
      script: () => {
        calls += 1;
        if (calls === 1) throw err.unavailable(CODES.E_PROVIDER_OVERLOADED, "provider overloaded (529)");
        return { text: '{"summary":"recovered"}', finishReason: "stop" as const };
      },
    }),
    store,
    now: c.now,
  });

  let r = await a.run("summarise this");
  for (let i = 0; i < 8 && r.status === "running"; i++) {
    c.advance(60_000);
    r = await a.advance(r.runId);
  }

  const log = await events(store, r.runId);
  const scheduled = log.filter((e) => e.type === "task.retry_scheduled");
  assert.equal(scheduled.length, 1, `journal:\n${log.map((e) => e.type).join("\n")}`);
  assert.equal((scheduled[0]?.payload as { code: string }).code, CODES.E_PROVIDER_OVERLOADED);
  assert.equal(r.status, "succeeded", JSON.stringify(r.projection.error ?? {}));
});

test("THE SHIPPED WORKFLOW'S OWN DECLARATION SURVIVES — `investigate` keeps maxAttempts 2, not 3", () => {
  // The real artifact, not a fixture. `incident-triage.ts` is the one graph in `src/` that
  // declares retry, and its `investigate` node is an AGENT with `maxAttempts: 2` — precisely the
  // case where a default that overrode instead of flooring would be invisible and wrong.
  const g = compileOrThrow({
    spec: incidentTriageSpec(),
    resolver: resolver(),
    tools: INCIDENT_TOOLS,
    tenantCapabilities: INCIDENT_CAPABILITIES,
  });
  assert.deepEqual(g.plans["investigate" as NodeId]?.retry, { maxAttempts: 2, backoff: "exponential", initialMs: 50 });
  // `remediate` is a tool node whose author wrote `maxAttempts: 1` — "do not retry me". Two
  // reasons it must stay 1, and either alone would be enough.
  assert.deepEqual(g.plans["remediate" as NodeId]?.retry, { maxAttempts: 1 });
});

// ── the node set, enumerated rather than sampled ─────────────────────────────
//
// ADDED 2026-08-26. A verifier rewrote `reachesProvider` as a NEGATIVE list — the way a
// "simplification" would write it — and the full 2,275-test gate stayed GREEN while `join`,
// `router` and `subgraph` were silently handed a provider's policy. The test above samples
// four node types; there are eight. A set is checkable only when it names its members.

const ALL_NODE_TYPES = ["function", "agent", "tool", "router", "join", "evaluator", "human_gate", "subgraph"] as const;

test("EVERY NODE TYPE IS ACCOUNTED FOR — the default set is enumerated, not sampled", () => {
  const tools = {
    "fs.write": { name: "fs.write", version: "1.0", irreversibility: "reversible_write", idempotent: true, capabilities: ["fs:write"] },
  } as const;
  const zoo = compileOrThrow({ spec: nodeZooSpec(), resolver: resolver(), tools, tenantCapabilities: ["fs:write"] });
  const routed = compileOrThrow({ spec: routedSpec(), resolver: resolver(), tools, tenantCapabilities: ["fs:write"] });

  // WHO GETS ONE, AND WHY — two different reasons, and neither is "it is a node".
  //   provider · it can reach a model, so a 429 is survivable
  //   child    · #runSubgraph returns retryable-unavailable for a child that is still working,
  //              and names the parent's policy as the thing that re-enters it
  const expected = [
    { type: "agent", id: "think", plans: zoo.plans, want: "provider" },
    { type: "evaluator/rubric", id: "rubric", plans: zoo.plans, want: "provider" },
    { type: "subgraph", id: "child", plans: zoo.plans, want: "child" },
    { type: "evaluator/assertion", id: "assertion", plans: zoo.plans, want: "none" },
    { type: "function", id: "fn", plans: zoo.plans, want: "none" },
    { type: "tool", id: "save", plans: zoo.plans, want: "none" },
    { type: "human_gate", id: "approve", plans: zoo.plans, want: "none" },
    { type: "router", id: "pick", plans: routed.plans, want: "none" },
    { type: "join", id: "wait", plans: routed.plans, want: "none" },
  ] as const;

  // Every one of the eight NodeTypes is represented, so this cannot quietly become a sample.
  const covered = new Set(expected.map((e) => e.type.split("/")[0]!));
  assert.deepEqual([...covered].sort(), [...ALL_NODE_TYPES].sort(), "a type went unchecked");

  for (const { type, id, plans, want } of expected) {
    const retry = plans[id as NodeId]?.retry;
    if (want === "none") {
      assert.equal(retry, undefined, `a ${type} node must be handed no policy — it cannot benefit from one`);
    } else {
      assert.ok(retry !== undefined, `a ${type} node must be handed a default, for the "${want}" reason`);
    }
  }
});

test("A SUBGRAPH'S DEFAULT IS NOT A PROVIDER'S — it polls a working child, it does not repeat a call", () => {
  // `#runSubgraph` returns E_SUBGRAPH_FAILED as retryable-`unavailable` when the child is not
  // terminal, and the engine's own comment names the parent's retry policy as the mechanism that
  // re-enters it. Three exponential backoffs topping out at 30 s would fail a child that is
  // merely slow — which is the opposite of what that path is for.
  const g = compileOrThrow({
    spec: nodeZooSpec(),
    resolver: resolver(),
    tools: {
      "fs.write": { name: "fs.write", version: "1.0", irreversibility: "reversible_write", idempotent: true, capabilities: ["fs:write"] },
    },
    tenantCapabilities: ["fs:write"],
  });
  const sub = g.plans[[...nodeZooSpec().nodes].find((n) => n.type === "subgraph")!.id as NodeId]?.retry;
  const provider = g.plans[[...nodeZooSpec().nodes].find((n) => n.type === "agent")!.id as NodeId]?.retry;

  assert.ok(sub !== undefined && provider !== undefined);
  assert.notDeepEqual(sub, provider, "the two defaults exist for different reasons and must not drift into one");
  assert.ok(
    sub!.maxAttempts > provider!.maxAttempts,
    `re-entry is cheap and a child can legitimately be slow, so it gets MORE attempts: ${String(sub!.maxAttempts)} vs ${String(provider!.maxAttempts)}`,
  );
  assert.ok(
    (sub!.maxMs ?? 0) < (provider!.maxMs ?? 0),
    "…and a SHORTER ceiling, because a poll that backs off to 30s adds latency to a child that already finished",
  );
});

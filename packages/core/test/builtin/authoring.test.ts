/**
 * The authoring graph — the front door for R2.
 *
 * The claim under test: a model can propose a GraphSpec, be told precisely what is
 * wrong by the REAL compiler, fix it, and reach a human gate — with the loop bounded
 * so a model that cannot converge fails instead of spinning.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { PROPOSE_INSTRUCTIONS, authoringGraph, validateGraphSpecFunction } from "../../src/builtin/authoring.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { NodeId } from "../../src/ids.ts";
import { InProcessEventBus } from "../../src/bus.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry, type MockScript } from "../../src/run/registry.ts";
import { resolver } from "../run/skeleton.ts";
import { makeStateView, type ChannelSpec } from "../../src/state/channels.ts";

/** A real StateView over one channel, so these exercise the production reader. */
const CANDIDATE_SPEC: Record<string, ChannelSpec> = { candidate: { type: "object", reduce: "replace" } };
const viewOf = (candidate: unknown) =>
  makeStateView(CANDIDATE_SPEC, candidate === undefined ? {} : { candidate }, ["candidate"]);
const ctx = () => ({ taskId: "t" as never, signal: new AbortController().signal, now: () => 1 });

/** A minimal, valid target graph — what a good proposal looks like. */
const GOOD: GraphSpec = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "greet", project: "demo", version: 1 },
  channels: { who: { type: "string", reduce: "replace" }, out: { type: "string", reduce: "replace" } },
  inputs: ["who"],
  outputs: ["out"],
  nodes: [{ id: "greet" as NodeId, type: "function", reads: ["who"], writes: ["out"], function: { ref: "function/greet@stable" } }],
  edges: [],
};

/** The same graph with a channel nobody declared — a realistic first draft. */
const BAD: GraphSpec = { ...GOOD, nodes: GOOD.nodes.map((x) => ({ ...x, writes: ["ghost"] })) };

const DEPS = { resolver: resolver(), tools: {}, tenantCapabilities: ["*"] };

function rig(script: MockScript) {
  const store = new MemoryStateStore({ now: () => 1 });
  const functions = new FunctionRegistry();
  functions.register("function/validate-graphspec@stable", validateGraphSpecFunction(DEPS));

  const models = new ModelRegistry();
  const model = new MockModelAdapter({ script });
  models.register(model, true);

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models,
    now: () => 1,
    policy: { granted: ["*"], systemFloor: "out" },
  });
  return { engine, store, model };
}

const compileAuthoring = () =>
  compileOrThrow({ spec: authoringGraph(), resolver: resolver(), tools: {}, tenantCapabilities: ["*"] });

// ── the graph itself ─────────────────────────────────────────────────────────

test("the authoring graph compiles under the same 22 rules as any other", () => {
  const g = compileAuthoring();
  assert.equal(g.entryNodes.length, 1);
  assert.equal(g.entryNodes[0], "propose");
  // Bounded by construction: three attempts, no more.
  assert.equal(g.plans["propose" as NodeId]?.maxInstances, 3);
});

test("the accept node is a gate, so no graph is adopted unreviewed", () => {
  const g = compileAuthoring();
  assert.equal(g.plans["accept" as NodeId]?.posture, "in");
});

// ── the critic ───────────────────────────────────────────────────────────────

test("the critic is the REAL compiler, not a rubric judge", () => {
  const validate = validateGraphSpecFunction(DEPS);
  const bad = validate(
    viewOf(BAD),
    ctx(),
  ) as { writes: { valid: boolean; diagnostics: { code: string; fix?: string }[] } };

  assert.equal(bad.writes.valid, false);
  const codes = bad.writes.diagnostics.map((d) => d.code);
  assert.ok(codes.includes("GRAPH005_UNDECLARED_WRITE"), codes.join(", "));
  // The diagnostic carries an ACTIONABLE fix — this is what makes the loop converge.
  assert.match(bad.writes.diagnostics.find((d) => d.code === "GRAPH005_UNDECLARED_WRITE")!.fix ?? "", /declare "ghost"/);
});

test("a valid proposal validates clean", () => {
  const validate = validateGraphSpecFunction(DEPS);
  const good = validate(
    viewOf(GOOD),
    ctx(),
  ) as { writes: { valid: boolean } };
  assert.equal(good.writes.valid, true);
});

test("a missing proposal is a diagnostic, not a crash", () => {
  const validate = validateGraphSpecFunction(DEPS);
  const none = validate(
    viewOf(undefined),
    ctx(),
  ) as { writes: { valid: boolean; diagnostics: { code: string }[] } };
  assert.equal(none.writes.valid, false);
  assert.equal(none.writes.diagnostics[0]?.code, "AUTHOR001_NO_CANDIDATE");
});

// ── the loop, end to end ─────────────────────────────────────────────────────

test("a bad first draft is corrected using the compiler's own diagnostics", async () => {
  const seen: unknown[] = [];
  const r = rig((req, turn) => {
    const input = JSON.parse(req.messages[0]?.content ?? "{}") as { state?: { diagnostics?: unknown[] } };
    seen.push(input.state?.diagnostics);
    // First attempt: undeclared write. Second: fixed — because the diagnostics said so.
    return { text: JSON.stringify(turn === 0 && seen.length === 1 ? BAD : GOOD) };
  });

  const runId = await r.engine.submit({ graph: compileAuthoring(), inputs: { goal: "greet someone" } });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "awaiting_gate", "a corrected graph reaches review");
  assert.equal(p.channels["valid"], true);
  assert.equal(r.model.seen.length, 2, "exactly two attempts");

  // The second prompt CONTAINED the first attempt's diagnostics.
  const secondPrompt = JSON.parse(r.model.seen[1]!.messages[0]!.content) as {
    state: { diagnostics: { code: string }[] };
  };
  assert.ok(
    secondPrompt.state.diagnostics.some((d) => d.code === "GRAPH005_UNDECLARED_WRITE"),
    "the model was told precisely what was wrong",
  );
});

test("a model that never converges FAILS after three attempts rather than spinning", async () => {
  const r = rig(() => ({ text: JSON.stringify(BAD) }));
  const runId = await r.engine.submit({ graph: compileAuthoring(), inputs: { goal: "impossible" } });
  const p = await r.engine.advance(runId);

  assert.notEqual(p.status, "awaiting_gate");
  assert.equal(p.channels["valid"], false);
  assert.equal(r.model.seen.length, 3, "maxIterations is the hard ceiling, not a suggestion");
});

test("a first-try success skips the loop entirely", async () => {
  const r = rig(() => ({ text: JSON.stringify(GOOD) }));
  const runId = await r.engine.submit({ graph: compileAuthoring(), inputs: { goal: "greet" } });
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "awaiting_gate");
  assert.equal(r.model.seen.length, 1);
});

test("malformed model output is a diagnostic, not an exception", async () => {
  const r = rig(() => ({ text: "here is your graph, buddy" }));
  const runId = await r.engine.submit({ graph: compileAuthoring(), inputs: { goal: "greet" } });
  const p = await r.engine.advance(runId);
  // The agent's outputSchema rejects it; the run fails cleanly rather than throwing.
  assert.equal(p.status, "failed");
});

// ── what the model CANNOT propose ────────────────────────────────────────────

test("the model cannot propose a graph that weakens oversight", () => {
  // GRAPH014 is not a stylistic preference the model can argue with.
  const validate = validateGraphSpecFunction({ ...DEPS, baselinePostures: { greet: "in" } });
  const out = validate(
    viewOf(GOOD),
    ctx(),
  ) as { writes: { valid: boolean; diagnostics: { code: string }[] } };
  assert.equal(out.writes.valid, false);
  assert.ok(out.writes.diagnostics.some((d) => d.code === "GRAPH014_OVERSIGHT_LOOSENED"));
});

test("the model cannot propose an unbounded fan-out or an unbounded loop", () => {
  const validate = validateGraphSpecFunction(DEPS);
  const unbounded: GraphSpec = {
    ...GOOD,
    channels: { ...GOOD.channels, items: { type: "array", reduce: "replace" }, item: { type: "string", reduce: "replace" } },
    nodes: [
      ...GOOD.nodes,
      { id: "each" as NodeId, type: "function", reads: ["item"], writes: ["out"], function: { ref: "function/x@stable" } },
    ],
    edges: [{ id: "f" as never, from: "greet" as NodeId, to: "each" as NodeId, kind: "fanout", over: "items", as: "item" }],
  };
  const out = validate(
    viewOf(unbounded),
    ctx(),
  ) as { writes: { valid: boolean; diagnostics: { code: string }[] } };

  const codes = out.writes.diagnostics.map((d) => d.code);
  assert.ok(codes.includes("GRAPH007_NO_MAX_WIDTH"), codes.join(", "));
  assert.ok(codes.includes("GRAPH021_FANOUT_WITHOUT_JOIN"), codes.join(", "));
});

test("the instructions tell the model the rules it will be judged by", () => {
  // Cheaper than letting it discover each one through a failed compile.
  for (const clue of ["maxWidth", "maxIterations", "router cannot write state", "append_ordered", "budget"]) {
    assert.match(PROPOSE_INSTRUCTIONS, new RegExp(clue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), clue);
  }
});

/**
 * Five executor defects the 2026-09-02 audit reproduced, each pinned with the shape that
 * reproduced it at 294e713 and the ordinary shape that must keep passing.
 *
 *   1. A run that finished in ONE `advance`, and a cancelled run, kept their `RunContext`
 *      forever — `#retire` ran only from the loop-top terminal branch, which `loom serve` never
 *      reaches a second time. Retired now on every terminal exit; a decision redelivered to the
 *      retired run is answered from the journal rather than `E_RUN_NOT_FOUND`.
 *   2. An agent that exhausted `maxTurns` while the model was still requesting tools committed
 *      `succeeded` with `""` on its channel. It fails now, with the same code `turnRefusal` gives
 *      the token-dimension truncation.
 *   3. `maxParallelism: NaN` was accepted (`Math.max(1, NaN)` is `NaN`) and ran nothing forever.
 *      Refused at construction, the way `cli.ts` already refused it at the flag.
 *   4. An `onComplete` hook that threw was invisible everywhere. It is a process warning now,
 *      code `LOOM_HOOK_FAILED`, naming the run and the refs.
 *   5. The context summariser's model calls were charged to no budget and reached no usage
 *      total. They are reserved, settled and folded into the run's and the task's usage.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import type { NodeId, RunId, Seq } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { HookRegistry } from "../../src/run/hooks.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry, type MockScript, type ToolDefinition } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const NOW = 1_700_000_000_000;

const ECHO: ToolManifestLite = { name: "t.echo", version: "1.0", capabilities: ["*"], irreversibility: "read_only", idempotent: true };

function functionSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "one", project: "rows", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 1, maxLoopIterations: 1 } },
    channels: { seed: { type: "string", reduce: "replace" }, out: { type: "number", reduce: "replace" } },
    inputs: ["seed"],
    outputs: ["out"],
    nodes: [{ id: n("a"), type: "function", reads: ["seed"], writes: ["out"], function: { ref: "function/one@stable" } }],
    edges: [],
  } as unknown as GraphSpec;
}

function agentSpec(maxTurns: number | undefined, outputSchema?: unknown, extra: Record<string, unknown> = {}): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "agent", project: "rows", version: 1 },
    policy: { posture: "out", budget: { costUsd: 1, tokens: 1_000_000, wallMs: 60_000 }, expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 1, maxLoopIterations: 1 }, capabilities: ["*"] },
    channels: { seed: { type: "string", reduce: "replace" }, out: { type: outputSchema === undefined ? "string" : "object", reduce: "replace" } },
    inputs: ["seed"],
    outputs: ["out"],
    nodes: [
      {
        id: n("a"),
        type: "agent",
        reads: ["seed"],
        writes: ["out"],
        agent: {
          profile: "agent_profile/x@stable",
          prompt: "prompt/x@stable",
          ...(maxTurns === undefined ? {} : { maxTurns }),
          tools: ["t.echo"],
          ...(outputSchema === undefined ? {} : { outputSchema }),
        },
        timeoutMs: 60_000,
        ...extra,
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

function rig(opts: { script?: MockScript; hooks?: HookRegistry; maxParallelism?: number; contextTokens?: number; budgetUsd?: number; pricePerMTok?: number } = {}) {
  const now = (): number => NOW;
  const store = new MemoryStateStore({ now });
  const functions = new FunctionRegistry();
  functions.register("function/one@stable", () => ({ writes: { out: 1 } }));
  const tools = new ToolRegistry();
  const echo: ToolDefinition = { ...ECHO, description: "echo", parameters: { type: "object", properties: {} }, execute: () => ({ content: "ok" }) };
  tools.register(echo);
  const models = new ModelRegistry();
  const adapter = new MockModelAdapter({ script: opts.script ?? (() => ({ text: "done", finishReason: "stop" })), pricePerMTok: opts.pricePerMTok ?? 1 });
  models.register(adapter, true);
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions,
    models,
    now,
    ...(opts.maxParallelism === undefined ? {} : { maxParallelism: opts.maxParallelism }),
    ...(opts.contextTokens === undefined ? {} : { contextTokens: opts.contextTokens }),
    ...(opts.hooks === undefined ? {} : { hooks: opts.hooks }),
    policy: { granted: ["*"], systemFloor: "out", budget: { runUsd: opts.budgetUsd ?? 1 } },
  });
  const compile = (spec: GraphSpec) =>
    compileOrThrow({ spec, resolver: resolver() as ResourceResolver, tools: { "t.echo": ECHO }, tenantCapabilities: ["*"] });
  return { engine, store, adapter, compile };
}

async function journal(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const e of store.read(runId, 1 as Seq)) out.push(e);
  return out;
}

/** `rehydrateGates` goes through `#require`, so it answers "is this run attached?" without a side effect. */
async function attached(engine: Engine, runId: RunId): Promise<boolean> {
  try {
    await engine.rehydrateGates(runId);
    return true;
  } catch (e) {
    assert.ok(isLoomError(e) && e.code === CODES.E_RUN_NOT_FOUND, String(e));
    return false;
  }
}

// ── 1 · retirement ───────────────────────────────────────────────────────────

test("THE ADVANCE THAT FINISHES A RUN RELEASES ITS CONTEXT — not the one after it", async () => {
  const { engine, compile } = rig();
  const runId = await engine.submit({ graph: compile(functionSpec()), inputs: { seed: "s" } });
  const p = await engine.advance(runId);
  assert.equal(p.status, "succeeded");
  assert.equal(await attached(engine, runId), false, "at 294e713 this read true until a second advance");
  // …and every read a caller makes of a finished run still answers from the journal.
  assert.equal((await engine.projection(runId))?.status, "succeeded");
  assert.equal((await engine.advance(runId)).status, "succeeded");
  assert.deepEqual(await engine.openGates(runId), []);
});

test("A CANCELLED RUN IS RELEASED TOO", async () => {
  const { engine, compile } = rig();
  const runId = await engine.submit({ graph: compile(functionSpec()), inputs: { seed: "s" } });
  const p = await engine.cancel(runId);
  assert.equal(p.status, "cancelled");
  assert.equal(await attached(engine, runId), false, "at 294e713 cancel never retired");
  assert.equal((await engine.projection(runId))?.status, "cancelled");
});

test("A DECISION REDELIVERED TO A FINISHED RUN IS ANSWERED FROM THE JOURNAL, not `E_RUN_NOT_FOUND`", async () => {
  // A webhook retry or a double-click routinely lands after the run it decided has ended. The
  // broker's answers are the honest ones — a repeat is `{resolved: false}`, a NEW decision on an
  // ended run is `E_GATE_ALREADY_RESOLVED` — and both need the run to be reachable after retire.
  const { engine, compile } = rig();
  const spec: GraphSpec = {
    ...functionSpec(),
    nodes: [
      { id: n("gate"), type: "human_gate", reads: ["seed"], humanGate: { ref: "oversight/x@stable" } },
      { id: n("a"), type: "function", reads: ["seed"], writes: ["out"], function: { ref: "function/one@stable" } },
    ],
    edges: [{ id: "g" as never, from: n("gate"), to: n("a"), kind: "seq" }],
  } as unknown as GraphSpec;
  const runId = await engine.submit({ graph: compile(spec), inputs: { seed: "s" } });
  let p = await engine.advance(runId);
  assert.equal(p.status, "awaiting_gate");
  const gate = Object.values(p.gates).find((g) => g.state === "open")!;
  const decision = { gateId: gate.gateId, decision: { kind: "approve" as const }, actor: { kind: "human" as const, subject: "u:a", via: "api" as const }, idempotencyKey: "once" };
  p = await engine.resolveGate(runId, decision);
  assert.equal(p.status, "succeeded");
  assert.equal(await attached(engine, runId), false, "the finishing advance retired it");

  // The same decision again: answered, and the run is still what it was.
  const again = await engine.resolveGate(runId, decision);
  assert.equal(again.status, "succeeded");
  // A different decision on the ended run: refused for the right reason.
  await assert.rejects(
    () => engine.resolveGate(runId, { ...decision, idempotencyKey: "twice", decision: { kind: "reject", reason: "late" } }),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_GATE_ALREADY_RESOLVED,
  );
});

// ── 2 · maxTurns ─────────────────────────────────────────────────────────────

const alwaysTools: MockScript = () => ({ toolCalls: [{ id: "c", name: "t.echo", arguments: {} }], finishReason: "tool_use" });

test("AN AGENT CUT OFF BY maxTurns MID-PLAN FAILS — it does not commit `\"\"` as its answer", async () => {
  const { engine, compile, adapter, store } = rig({ script: alwaysTools });
  const runId = await engine.submit({ graph: compile(agentSpec(2)), inputs: { seed: "s" } });
  const p = await engine.advance(runId);
  assert.equal(p.status, "failed");
  assert.equal(p.error?.code, CODES.E_PROVIDER_BAD_REQUEST);
  assert.match(p.error?.message ?? "", /reached its maxTurns of 2 while the model was still requesting tool calls/);
  assert.equal(p.channels["out"], undefined, "at 294e713 this was \"\" and the run succeeded");
  assert.equal(adapter.seen.length, 2, "both allowed turns ran and were paid for");
  const rows = await journal(store, runId);
  assert.equal(rows.filter((e) => e.type === "model.called").length, 2, "…and both are on the record");
  assert.equal(rows.filter((e) => e.type === "budget.reserved").length, rows.filter((e) => e.type === "budget.settled").length, "every reservation settled");
});

test("…the refusal precedes the schema, so a cap is not reported as a provider schema miss", async () => {
  const { engine, compile } = rig({ script: alwaysTools });
  const schema = { type: "object", properties: { done: { type: "boolean" } }, required: ["done"] };
  const runId = await engine.submit({ graph: compile(agentSpec(1, schema)), inputs: { seed: "s" } });
  const p = await engine.advance(runId);
  assert.equal(p.status, "failed");
  assert.match(p.error?.message ?? "", /maxTurns/, "names the cap, not `output did not match its schema`");
});

test("ORDINARY HALVES — the default of one turn with no tool call, and stopping on the last allowed turn, still succeed", async () => {
  const plain = rig();
  const r1 = await plain.engine.submit({ graph: plain.compile(agentSpec(undefined)), inputs: { seed: "s" } });
  const p1 = await plain.engine.advance(r1);
  assert.equal(p1.status, "succeeded", JSON.stringify(p1.error ?? {}));
  assert.equal(p1.channels["out"], "done");

  // Tool call on turn 0, answer on turn 1 — exactly `maxTurns: 2`.
  const lastTurn = rig({ script: (_req, turn) => (turn === 0 ? alwaysTools(_req, turn) : { text: "final", finishReason: "stop" }) });
  const r2 = await lastTurn.engine.submit({ graph: lastTurn.compile(agentSpec(2)), inputs: { seed: "s" } });
  const p2 = await lastTurn.engine.advance(r2);
  assert.equal(p2.status, "succeeded", JSON.stringify(p2.error ?? {}));
  assert.equal(p2.channels["out"], "final");
  assert.equal(lastTurn.adapter.seen.length, 2);
});

// ── 3 · maxParallelism ───────────────────────────────────────────────────────

test("maxParallelism THAT IS NOT A POSITIVE INTEGER IS REFUSED AT CONSTRUCTION", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
    assert.throws(
      () => rig({ maxParallelism: bad }),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /maxParallelism/.test(e.message),
      `${String(bad)} was accepted`,
    );
  }
});

test("…and 1 and 16 still run a graph to completion (the ordinary half)", async () => {
  for (const width of [1, 16]) {
    const { engine, compile } = rig({ maxParallelism: width });
    const runId = await engine.submit({ graph: compile(functionSpec()), inputs: { seed: "s" } });
    assert.equal((await engine.advance(runId)).status, "succeeded");
  }
});

// ── 4 · onComplete ───────────────────────────────────────────────────────────

test("AN onComplete HOOK THAT THROWS IS REPORTED AS A PROCESS WARNING NAMING THE RUN AND THE REF", async () => {
  const hooks = new HookRegistry();
  let invoked = 0;
  hooks.register("hook/boom@stable", () => {
    invoked++;
    throw new Error("kaboom");
  });
  hooks.register("hook/fine@stable", () => undefined);
  const { engine, compile } = rig({ hooks });
  const spec = { ...functionSpec(), hooks: { onComplete: ["hook/boom@stable", "hook/fine@stable"] } } as unknown as GraphSpec;
  const warnings: { message: string; detail: string | undefined }[] = [];
  const listener = (w: Error & { code?: string; detail?: string }): void => {
    if (w.code === "LOOM_HOOK_FAILED") warnings.push({ message: w.message, detail: w.detail });
  };
  process.on("warning", listener);
  try {
    const runId = await engine.submit({ graph: compile(spec), inputs: { seed: "s" } });
    const p = await engine.advance(runId);
    assert.equal(p.status, "succeeded", "the run's outcome is unchanged — the run was already over");
    assert.equal(invoked, 1);
    // `process.emitWarning` delivers on a later tick.
    await new Promise((r) => setImmediate(r));
    assert.equal(warnings.length, 1, "at 294e713 nothing anywhere said the hook threw");
    assert.match(warnings[0]!.message, /hook\/boom@stable/);
    assert.match(warnings[0]!.message, new RegExp(runId));
    assert.deepEqual(JSON.parse(warnings[0]!.detail ?? "{}"), { runId, point: "onComplete", refs: ["hook/boom@stable"] });
  } finally {
    process.off("warning", listener);
  }
});

// ── 5 · the summariser's spend ───────────────────────────────────────────────

const MAX_TURNS = 6;
const RESULT_CHARS = 1_600;

function compactingRig(opts: { summaryFinish?: "stop" | "max_tokens"; budgetUsd?: number } = {}) {
  const counts = { agent: 0, compaction: 0 };
  // Counted here rather than by the mock's `turn`, which is derived from the transcript and
  // shrinks when the ladder folds it.
  const script: MockScript = (req) => {
    if (req.model === "compaction") {
      counts.compaction++;
      return { text: "a summary", finishReason: opts.summaryFinish ?? "stop", inputTokens: 5_000, outputTokens: 200 };
    }
    counts.agent++;
    return counts.agent < MAX_TURNS
      ? { toolCalls: [{ id: `c${String(counts.agent)}`, name: "t.echo", arguments: {} }], finishReason: "tool_use" }
      : { text: JSON.stringify({ done: true }), finishReason: "stop" };
  };
  const r = rig({ script, contextTokens: 1_000, budgetUsd: opts.budgetUsd ?? 100, pricePerMTok: 1 });
  // The echo tool has to return something big enough to push the transcript past the window.
  r.engine.tools.register({ ...ECHO, description: "blob", parameters: { type: "object", properties: {} }, execute: () => ({ content: "x".repeat(RESULT_CHARS) }) } as ToolDefinition);
  const schema = { type: "object", properties: { done: { type: "boolean" } }, required: ["done"] };
  return { ...r, counts, spec: agentSpec(MAX_TURNS, schema, { policy: { budget: { costUsd: 0.5 } } }) };
}

test("THE SUMMARISER'S CALLS ARE RESERVED, SETTLED AND COUNTED — in the run's usage and the task's", async () => {
  const r = compactingRig();
  const runId = await r.engine.submit({ graph: r.compile(r.spec), inputs: { seed: "go" } });
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.ok(r.counts.compaction >= 1, `the ladder must actually fire; ${String(r.counts.compaction)} compactions`);
  const rows = await journal(r.store, runId);
  const count = (t: string) => rows.filter((e) => e.type === t).length;
  const calls = r.counts.agent + r.counts.compaction;
  assert.equal(count("budget.reserved"), calls, "one reservation per provider call, compactions included — at 294e713 only the agent turns had one");
  assert.equal(count("budget.settled"), calls, "…and each one settled");
  // Each compaction was scripted at 5,000 input tokens; the agent turns are a few hundred in total.
  assert.ok(p.usage.inputTokens >= 5_000 * r.counts.compaction, `run usage ${String(p.usage.inputTokens)} input tokens does not include the compactions`);
  const task = Object.values(p.tasks)[0]!;
  assert.ok(task.usage.inputTokens >= 5_000 * r.counts.compaction, "the task's own usage counts them too");
  // The summariser's record is its effect pair, under its own kind; nothing about it is a `model` effect.
  assert.equal(rows.filter((e) => e.type === "effect.started" && (e.payload as { kind: string }).kind === "summarize").length, r.counts.compaction);
});

test("A REFUSED (TRUNCATED) SUMMARY STILL CHARGES THE CALL IT MADE, and fails the task on the refusal", async () => {
  const r = compactingRig({ summaryFinish: "max_tokens" });
  const runId = await r.engine.submit({ graph: r.compile(r.spec), inputs: { seed: "go" } });
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "failed");
  assert.match(p.error?.message ?? "", /context summary/, "the refusal names the summary, not the agent turn");
  assert.equal(r.counts.compaction, 1);
  const rows = await journal(r.store, runId);
  assert.equal(rows.filter((e) => e.type === "budget.settled").length, rows.filter((e) => e.type === "budget.reserved").length, "settled, including the refused call");
  assert.equal(rows.filter((e) => e.type === "effect.failed" && String((e.payload as { key: string }).key).includes(":summarize:")).length, 1, "the refused summary is a failed effect");
  assert.ok(p.usage.inputTokens >= 5_000, `the refused call's ${String(p.usage.inputTokens)} tokens reached the run's usage`);
});

test("A BUDGET THAT CANNOT COVER THE SUMMARY REFUSES IT — E_BUDGET_EXHAUSTED, run-fatal, as for a turn", async () => {
  // $1/MTok × ~5,200 tokens per compaction ≈ $0.0052; a run budget below the FIRST compaction's
  // estimate but above the agent turns lets the turns run and refuses the fold.
  const r = compactingRig({ budgetUsd: 0.003 });
  const runId = await r.engine.submit({ graph: r.compile(r.spec), inputs: { seed: "go" } });
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "failed");
  assert.equal(p.error?.code, CODES.E_BUDGET_EXHAUSTED, JSON.stringify(p.error ?? {}));
  assert.equal(r.counts.compaction, 0, "refused before the call, not after");
});

/**
 * A TRUNCATED MODEL TURN IS NOT A SUCCESSFUL TURN.
 *
 * Found by the first live workload this project ran (GLM-5.2 reviewing this repo's own diff,
 * 2026-08-25). A reasoning model was called with an output ceiling below its reasoning budget;
 * the provider answered `finish_reason: "max_tokens"` with `content: ""`, and the journal shows
 * exactly that:
 *
 *     effect.completed {"key":"review@root/fan[0]#0:model:0",
 *       "result":{"content":"","finishReason":"max_tokens","usage":{"outputTokens":16001,...}}}
 *
 * That empty string was written to the node's channel, folded through a `join`, shown at a gate,
 * approved, written to disk — and the run reported `succeeded`, over a report claiming three
 * files reviewed. `#runAgent` read `finishReason` only to journal it.
 *
 * Nothing in 2,215 tests had it, because every mock script in the suite returns `stop` or
 * `tool_use`. These drive the truncation through a real `agent` node with a mock adapter, and
 * keep a `stop` control beside it so the fix cannot degenerate into "agent nodes fail".
 */
import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import {
  FunctionRegistry,
  MockModelAdapter,
  ModelRegistry,
  ToolRegistry,
  type FinishReason,
  type MockScript,
  type ToolDefinition,
} from "../../src/run/registry.ts";

const NOW = 1_700_000_000_000;

const RESOLVER: ResourceResolver = {
  resolve: (ref) =>
    /^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref) ? { ref, digest: `sha256:${"a".repeat(64)}`, channel: "stable" } : undefined,
  document: () => "Review the diff.",
};

/** One agent node, no `outputSchema` — the shape the live run had, and the one that hid this. */
function spec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "rev", project: "fx13", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { q: { type: "string", reduce: "replace" }, a: { type: "string", reduce: "replace" } },
    inputs: ["q"],
    outputs: ["a"],
    nodes: [
      { id: "review", type: "agent", reads: ["q"], writes: ["a"], agent: { profile: "agent_profile/x@stable", prompt: "prompt/p@stable" } },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

function rig(script: MockScript, defaultMaxTokens = 1024): { engine: Engine; store: MemoryStateStore } {
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script, defaultMaxTokens }), true);
  const store = new MemoryStateStore({ now: () => NOW });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions: new FunctionRegistry(),
    models,
    now: () => NOW,
    sleep: async () => {},
    resolver: RESOLVER,
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 10 } },
  });
  return { engine, store };
}

async function run(
  script: MockScript,
  defaultMaxTokens = 1024,
): Promise<{ status: string; a: unknown; error: unknown; events: { type: string; payload: Record<string, unknown> }[] }> {
  const r = rig(script, defaultMaxTokens);
  const runId = await r.engine.submit({
    graph: compileOrThrow({ spec: spec(), resolver: RESOLVER, tools: {}, tenantCapabilities: [] }),
    inputs: { q: "the diff" },
  });
  const p = await r.engine.advance(runId);
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  for await (const ev of r.store.read(runId, 1)) events.push({ type: ev.type, payload: ev.payload as Record<string, unknown> });
  return { status: p.status, a: p.channels["a"], error: p.error, events };
}

test("FX13 — a `max_tokens` turn with empty content does not become a succeeded run", async () => {
  const out = await run(() => ({ text: "", finishReason: "max_tokens", outputTokens: 16_001 }));

  assert.notEqual(out.status, "succeeded", `a truncated turn is not an answer; got ${out.status}`);
  assert.notEqual(out.a, "", "and the empty string must not have reached the channel");
  assert.match(
    JSON.stringify(out.error ?? {}),
    /max_tokens/,
    `the operator must be told WHY without reading a journal: ${JSON.stringify(out.error ?? {})}`,
  );
});

test("FX13 — the reason survives even when the truncated turn produced text", async () => {
  // Emptiness was the symptom, not the defect: half an answer is still not the answer, and
  // nothing downstream can tell which half is missing.
  const out = await run(() => ({ text: "The first file looks fine, and the second", finishReason: "max_tokens" }));

  assert.notEqual(out.status, "succeeded", `a cut-off answer is not an answer; got ${out.status}`);
  assert.notEqual(out.a, "The first file looks fine, and the second", "half an answer must not be written as the answer");
});

// -- D.7.4: two outcomes wearing one message ---------------------------------

/**
 * "The budget never reached content" and "the answer was clipped" are different failures with
 * different fixes, and `turnRefusal` had both facts in hand -- `contentChars` and, after D.7.3,
 * the ceiling -- while printing the same sentence at 0 characters as at 4,000.
 *
 * This is the defect that silently produced an EMPTY reviewed-file in the live run at the top
 * of this file, got approved by a human, and was written to disk. The operator's next action
 * differs by an order of magnitude between the two arms, and the old message could not tell
 * them which one they were in -- nor what the ceiling was, so "raise it" had no starting point.
 */
test("D.7.4 -- A CEILING THAT NEVER REACHED CONTENT SAYS SO, and names the number to change", async () => {
  const out = await run(() => ({ text: "", finishReason: "max_tokens", outputTokens: 16_001 }), 16_000);
  const msg = String((out.error as { message?: unknown } | undefined)?.message ?? "");

  assert.match(msg, /emitted NO content/, `the empty case must be named as its own outcome: ${msg}`);
  assert.match(msg, /reasoning floor/, "and it must say a nudge will not help");
  assert.match(msg, /16000/, `the refusal must name the ceiling in effect: ${msg}`);
  assert.match(msg, /defaultMaxTokens/, "and the field the operator has to change");
  // The two arms must not be confusable: this is not a clipped answer and must not read as one.
  assert.doesNotMatch(msg, /truncated, not finished/, `the clipped-answer sentence must not appear here: ${msg}`);
});

test("D.7.4 -- A CLIPPED ANSWER IS THE OTHER ARM, and still names the ceiling", async () => {
  const out = await run(() => ({ text: "The first file looks fine, and the second", finishReason: "max_tokens" }), 16_000);
  const msg = String((out.error as { message?: unknown } | undefined)?.message ?? "");

  assert.match(msg, /truncated, not finished/, `a turn that produced text is the clipped arm: ${msg}`);
  assert.match(msg, /16000/, "and it names the ceiling too");
  assert.doesNotMatch(msg, /emitted NO content/, "the two arms must not both fire");
});

test("D.7.4 -- the ceiling reaches the JOURNAL, not only the console", async () => {
  // `details.ceiling` is what an auditor folding the run reads. The message is for the operator
  // at the terminal; the field is for everybody who arrives later.
  const out = await run(() => ({ text: "", finishReason: "max_tokens", outputTokens: 9_001 }), 9_000);
  assert.equal((out.error as { details?: { ceiling?: unknown } } | undefined)?.details?.ceiling, 9_000, JSON.stringify(out.error ?? {}));
});

test("FX13 — a provider refusal fails as a POLICY fact, not as a truncation", async () => {
  const out = await run(() => ({ text: "", finishReason: "refusal" }));

  assert.notEqual(out.status, "succeeded", `a refusal is not an answer; got ${out.status}`);
  assert.match(JSON.stringify(out.error ?? {}), /E_CONTENT_FILTERED/, JSON.stringify(out.error ?? {}));
});

test("FX13 — content_filter is handled too: the SET, not the one reason that was seen", async () => {
  const out = await run(() => ({ text: "", finishReason: "content_filter" }));
  assert.notEqual(out.status, "succeeded", `content_filter is not an answer; got ${out.status}`);
});

test("FX13 CONTROL — a normal `stop` turn still writes its content", async () => {
  const out = await run(() => ({ text: "clean", finishReason: "stop" }));

  assert.equal(out.status, "succeeded", `${out.status}: ${JSON.stringify(out.error ?? {})}`);
  assert.equal(out.a, "clean", "the ordinary path must be untouched");
});

test("FX13 — an UNRECOGNIZED finish reason fails closed, because a replay can carry one", async () => {
  // `RecordedModelTurn.finishReason` is a bare `string`, and `#runAgent`'s replay arm assigns it
  // straight into `finish`. So a journal written by another build — or by a provider mapping this
  // one does not have — can present a member outside the union, and the cast here is what that
  // looks like from a mock. "I do not know what this means" is not "the model finished".
  const out = await run(() => ({ text: "", finishReason: "length" as FinishReason }));

  assert.notEqual(out.status, "succeeded", `an unknown reason must not pass as an answer; got ${out.status}`);
  assert.match(JSON.stringify(out.error ?? {}), /length/, JSON.stringify(out.error ?? {}));
});

test("FX13 — the refused turn is still JOURNALED, spend and all", async () => {
  // The check sits AFTER the appends deliberately: the call happened and was paid for. Moving it
  // earlier would leave `effect.started` with no completion — a hole a replay cannot fill and a
  // cost the ledger never sees — which is a different bug wearing this fix's clothes.
  const out = await run(() => ({ text: "", finishReason: "max_tokens", outputTokens: 16_001 }));

  const called = out.events.find((e) => e.type === "model.called");
  assert.ok(called !== undefined, `the turn must be journaled: ${out.events.map((e) => e.type).join(", ")}`);
  assert.equal(called.payload["finishReason"], "max_tokens", "and the journal must say what it was");

  const completed = out.events.find((e) => e.type === "effect.completed" && String((e.payload as { key?: unknown }).key ?? "").includes(":model:"));
  assert.ok(completed !== undefined, "the effect must be completed, not left open");
  assert.equal((completed.payload["result"] as { usage: { outputTokens: number } }).usage.outputTokens, 16_001, "the tokens were spent and are recorded");
});

/**
 * THE SECOND SITE, which nobody had looked at. `#summarizeEffect` read `ev.message.content` and
 * dropped the finish reason on the floor exactly as the turn loop did — and its output REPLACES
 * the prior turns it folded, so a truncated summary is a silent DELETION of context rather than
 * a short answer. It is the quieter half of FX13 and the same helper closes it.
 *
 * Driven the way `context-budget-across-turns.test.ts` drives the ladder: a long tool loop whose
 * accumulated results push the transcript past `contextTokens`, which is what makes `boundTurns`
 * call the summariser at all.
 */
const BIG: ToolManifestLite = { name: "big.read", version: "1.0", capabilities: ["big:read"], irreversibility: "read_only", idempotent: true };

function loopSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "sum", project: "fx13", version: 1 },
    policy: {
      posture: "out",
      budget: { costUsd: 100, tokens: 100_000_000, wallMs: 600_000 },
      expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 },
      capabilities: ["big:read"],
    },
    channels: { seed: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: ["seed"],
    outputs: ["out"],
    nodes: [
      {
        id: "act",
        type: "agent",
        reads: ["seed"],
        writes: ["out"],
        agent: {
          profile: "agent_profile/actor@stable",
          prompt: "prompt/act@stable",
          maxTurns: 20,
          tools: ["big.read"],
          outputSchema: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"] },
        },
        timeoutMs: 60_000,
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

test("FX13 — a truncated CONTEXT SUMMARY is refused, not folded in place of what it dropped", async () => {
  const tools = new ToolRegistry();
  tools.register({
    ...BIG,
    description: "Return a large blob.",
    parameters: { type: "object", properties: { k: { type: "string" } } },
    execute: () => ({ content: "x".repeat(2_000) }),
  } as ToolDefinition);

  const models = new ModelRegistry();
  models.register(
    // One adapter serves both calls; only the compaction one truncates, so a failure here is
    // about the summary and not about the turn.
    new MockModelAdapter({
      pricePerMTok: 0,
      script: (req, turn) =>
        req.model === "compaction"
          ? { text: "half a sum", finishReason: "max_tokens" }
          : turn < 19
            ? { toolCalls: [{ id: `c${String(turn)}`, name: "big.read", arguments: { k: String(turn) } }], finishReason: "tool_use" }
            : { text: JSON.stringify({ done: true }), finishReason: "stop" },
    }),
    true,
  );

  const store = new MemoryStateStore({ now: () => NOW });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models,
    now: () => NOW,
    sleep: async () => {},
    resolver: RESOLVER,
    contextTokens: 3_000,
    policy: { granted: ["big:read"], systemFloor: "out", budget: { runUsd: 100 } },
  });

  const runId = await engine.submit({
    graph: compileOrThrow({ spec: loopSpec(), resolver: RESOLVER, tools: { "big.read": BIG }, tenantCapabilities: ["big:read"] }),
    inputs: { seed: "go" },
  });
  const p = await engine.advance(runId).catch(() => engine.projection(runId));

  const seen = JSON.stringify(p?.error ?? {});
  assert.notEqual(p?.status, "succeeded", `a half-written summary is not a summary; got ${String(p?.status)}: ${seen}`);
  assert.match(seen, /context summary/, seen);
});

/**
 * THE TOPOLOGY THE DEFECT WAS FOUND IN — fan-out, three agent branches, a join that collates.
 * The journal key was `review@root/fan[0]#0:model:0`, and the collated value was
 * `["…", "", "…"]`: the truncated branch contributed an empty string that read like a review.
 *
 * The join declares `onBranchError: "skip"`, which is what the fix has to be measured against.
 * A failed branch is not run-fatal — `E_PROVIDER_BAD_REQUEST` is not in `RUN_FATAL_CODES` — so a
 * graph that says "skip failed branches" still finishes, and it SHOULD: that is the author's
 * declared tolerance, not something a truncation check gets to override. What must not survive
 * is the empty string sitting in the collation as if it were an answer.
 */
function fanSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "fan", project: "fx13", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 16, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
    channels: {
      files: { type: "array", reduce: "replace" },
      file: { type: "object", reduce: "replace" },
      notes: { type: "array", reduce: "append_ordered" },
    },
    inputs: ["files"],
    outputs: ["notes"],
    nodes: [
      { id: "seed", type: "function", reads: ["files"], function: { ref: "function/seed@stable" } },
      {
        id: "review",
        type: "agent",
        reads: ["file"],
        writes: ["notes"],
        agent: { profile: "agent_profile/x@stable", prompt: "prompt/p@stable" },
      },
      { id: "gather", type: "join", reads: ["notes"], writes: ["notes"], join: { branches: ["review"], mode: "all", onBranchError: "skip" } },
    ],
    edges: [
      { id: "fo", from: "seed", to: "review", kind: "fanout", over: "files", as: "file", maxWidth: 3 },
      { id: "jn", from: "review", to: "gather", kind: "join" },
    ],
  } as unknown as GraphSpec;
}

test("FX13 — in the fan-out that found it, the truncated branch contributes NOTHING, not an empty answer", async () => {
  const models = new ModelRegistry();
  models.register(
    new MockModelAdapter({
      // The middle file is the one whose reasoning budget overran the ceiling.
      script: (req) => (req.messages[0]?.content.includes("b.ts") === true ? { text: "", finishReason: "max_tokens", outputTokens: 16_001 } : { text: "clean" }),
    }),
    true,
  );
  const store = new MemoryStateStore({ now: () => NOW });
  const functions = new FunctionRegistry();
  functions.register("function/seed@stable", () => ({}));
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models,
    now: () => NOW,
    sleep: async () => {},
    resolver: RESOLVER,
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 10 } },
  });

  const runId = await engine.submit({
    graph: compileOrThrow({ spec: fanSpec(), resolver: RESOLVER, tools: {}, tenantCapabilities: [] }),
    inputs: { files: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }] },
  });
  const p = await engine.advance(runId).catch(() => engine.projection(runId));

  const notes = (p?.channels["notes"] ?? []) as unknown[];
  assert.equal(notes.includes(""), false, `the truncated branch must not appear as an answer: ${JSON.stringify(notes)}`);
  assert.equal(notes.length, 2, `two branches answered, not three: ${JSON.stringify(notes)}`);

  // And the failure is on the journal with its reason, which is the half the live run lacked.
  // MEASURED, and pinned because it is a decision rather than an accident: the run still reports
  // `succeeded`, because `onBranchError: "skip"` is what this graph asked for and
  // `E_PROVIDER_BAD_REQUEST` is not in `RUN_FATAL_CODES`. What changed is that the collation is
  // two entries instead of three-with-a-hole, so a report counting them can no longer say three.
  // If a later change makes truncation run-fatal, this line goes red and that is the right place
  // to argue it.
  assert.equal(p?.status, "succeeded", `the author declared skip; the branch failure is not the run's: ${String(p?.status)}`);

  const failed = Object.values(p?.tasks ?? {}).filter((t) => t.state === "failed");
  assert.equal(failed.length, 1, `exactly one branch failed: ${JSON.stringify(failed.map((t) => t.nodeId))}`);
  assert.match(JSON.stringify(failed[0]?.error ?? {}), /max_tokens/, JSON.stringify(failed[0]?.error ?? {}));
});


// ── the door the first fix left open ─────────────────────────────────────────
//
// ADDED 2026-08-26. A verifier found the fix above was unreachable from either shipped adapter
// for any reason this build does not know: `mapFinish` (openai) and `mapStop` (anthropic) both
// ended `default: return "stop"`, laundering an unknown reason into the one value that means
// "finished answer". Anthropic's documented set already contains `pause_turn` — "the model
// paused and can be resumed" — which is precisely a non-answer. `FinishReason` now carries
// `unknown:${string}` so the provider's own word survives to the refusal message.

test("an UNRECOGNISED provider finish reason is not treated as an answer", async () => {
  const out = await run(() => ({ text: "", finishReason: "unknown:pause_turn" as never }));

  assert.notEqual(out.status, "succeeded", "an unknown reason must not produce a succeeded run");
  assert.notEqual(out.a, "", "and must not write an empty string to the channel");
  assert.match(
    JSON.stringify(out.error ?? {}),
    /unknown:pause_turn/,
    "the refusal must name the provider's own word — that is the difference between a diagnosable deployment and a mystery",
  );
});

test("…and a turn that ends normally with real content is still an answer — the control", async () => {
  const out = await run(() => ({ text: "the real answer", finishReason: "stop" }));
  assert.equal(out.status, "succeeded", JSON.stringify(out.error ?? {}));
  assert.equal(out.a, "the real answer");
});

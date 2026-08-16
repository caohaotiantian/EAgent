/**
 * The context budget must bound the request the engine actually sends.
 *
 * `assembleContext` is the budget, and `#runAgent` calls it ONCE, before the turn loop —
 * over `system`, `instruction` and `channels`, which is the SMALLEST the request will ever
 * be. Inside the loop `messages.push(assistant)` and `messages.push(tool_result)` grow the
 * array every turn, and `req.messages` is that array. So the ladder measures a request the
 * model is never sent, and the request the model IS sent is unmeasured.
 *
 * Three consequences, and the third is what makes the first two hard to see:
 *
 *  1. A long agent loop over large tool results exceeds `contextTokens` with no rung firing
 *     and no `E_CONTEXT_OVERFLOW` — the failure arrives from the provider instead, as a
 *     400, after the spend.
 *  2. `AssembleInput.turns` and `.retrieved` are declared (`context.ts:78-80`) and passed by
 *     nobody, so rung 3 — the one rung that is a recorded Effect — operates on a section
 *     that is always empty. The `summarize` effect kind named by invariant 4 is unreachable
 *     in a live run.
 *  3. `#summarizeEffect` keys on `effectKey(taskId, "summarize", 0)` — a FIXED ordinal. So
 *     the moment rung 3 can fire more than once in a task, the second summary overwrites
 *     the first under one key, and replay serves whichever was recorded last.
 *
 * These tests pin the request, not the assembly: what matters is the size of what crosses
 * the provider boundary.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { NodeId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { estimateTokens } from "../../src/run/context.ts";
import { Engine } from "../../src/run/engine.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import {
  FunctionRegistry,
  MockModelAdapter,
  ModelRegistry,
  ToolRegistry,
  type ModelRequest,
  type ToolDefinition,
} from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;

/** Read-only, so nothing here is about oversight — only about size. */
const BIG: ToolManifestLite = {
  name: "big.read",
  version: "1.0",
  capabilities: ["big:read"],
  irreversibility: "read_only",
  idempotent: true,
};

const MAX_TURNS = 20;
/**
 * ~500 tokens each — comfortably inside the budget ALONE, and far outside it in aggregate.
 *
 * That ratio is the whole point. A single result larger than the window is a different
 * failure with a different answer (spill it, or refuse), and it is genuinely unfittable —
 * see the last test. What this file is about is ACCUMULATION: eight results that each pass
 * every check and together do not fit, which is the ordinary shape of a long agent loop and
 * the case the budget silently failed to bound.
 */
const RESULT_CHARS = 2_000;
const CONTEXT_TOKENS = 3_000;

function spec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "context-budget", project: "probe", version: 1 },
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
        id: n("act"),
        type: "agent",
        reads: ["seed"],
        writes: ["out"],
        agent: {
          profile: "agent_profile/actor@stable",
          prompt: "prompt/act@stable",
          maxTurns: MAX_TURNS,
          tools: ["big.read"],
          outputSchema: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"] },
        },
        timeoutMs: 60_000,
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

/** Total tokens of everything that crosses the provider boundary in one request. */
function requestTokens(req: ModelRequest): number {
  return (
    estimateTokens(req.system ?? "") +
    req.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
  );
}

async function run(): Promise<{ seen: readonly ModelRequest[]; status: string }> {
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });

  const tools = new ToolRegistry();
  const big: ToolDefinition = {
    ...BIG,
    description: "Return a large blob.",
    parameters: { type: "object", properties: { k: { type: "string" } } },
    // Deterministic and offline: one character repeated, so the size is exact and the
    // content carries no clock, no randomness, and nothing to redact.
    execute: () => ({ content: "x".repeat(RESULT_CHARS) }),
  };
  tools.register(big);

  const adapter = new MockModelAdapter({
    // Call the tool on every turn but the last, so the transcript grows monotonically.
    script: (_req, turn) =>
      turn < MAX_TURNS - 1
        ? { toolCalls: [{ id: `c${String(turn)}`, name: "big.read", arguments: { k: String(turn) } }], finishReason: "tool_use" }
        : { text: JSON.stringify({ done: true }), finishReason: "stop" },
    pricePerMTok: 0,
  });
  const models = new ModelRegistry();
  models.register(adapter, true);

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models,
    now,
    maxParallelism: 2,
    contextTokens: CONTEXT_TOKENS,
    policy: { granted: ["big:read"], budget: { runUsd: 100 } },
  });

  const graph = compileOrThrow({
    spec: spec(),
    resolver: resolver() as ResourceResolver,
    tools: { "big.read": BIG },
    tenantCapabilities: ["big:read"],
  });
  const runId = await engine.submit({ graph, inputs: { seed: "go" } });
  const p = await engine.advance(runId).catch(() => engine.projection(runId));
  return { seen: adapter.seen, status: p?.status ?? "unknown" };
}

test("THE REQUEST THE MODEL IS SENT STAYS INSIDE THE CONTEXT BUDGET", async () => {
  const { seen } = await run();
  assert.ok(seen.length > 1, `the loop must actually iterate; saw ${String(seen.length)} request(s)`);

  const worst = Math.max(...seen.map(requestTokens));
  // The budget is a bound on what crosses the boundary, or it is decoration. Assembly
  // budgeting a request that is then grown before sending measures nothing.
  assert.ok(
    worst <= CONTEXT_TOKENS,
    `contextTokens=${String(CONTEXT_TOKENS)} but the largest request sent was ~${String(worst)} tokens ` +
      `across ${String(seen.length)} turns — the budget is computed once, before the loop that grows the transcript`,
  );
});

test("the transcript grows across turns — the precondition for the test above", async () => {
  const { seen } = await run();
  const first = requestTokens(seen[0]!);
  const last = requestTokens(seen[seen.length - 1]!);
  assert.ok(
    last > first,
    `this probe is only meaningful if the transcript grows; first=${String(first)} last=${String(last)}`,
  );
});

test("A SINGLE RESULT LARGER THAN THE WINDOW FAILS AS E_CONTEXT_OVERFLOW, not as a provider 400", async () => {
  // Distinct from accumulation and genuinely unfittable: no fold helps, because cutting
  // before the assistant that requested it would orphan the result. The engine says so
  // itself, with a code, before paying for the request — which is the entire difference
  // this makes to an operator reading a failed run.
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const tools = new ToolRegistry();
  tools.register({
    ...BIG,
    description: "Return a blob far larger than the window.",
    parameters: { type: "object", properties: {} },
    execute: () => ({ content: "x".repeat(40_000) }),
  } as ToolDefinition);

  const models = new ModelRegistry();
  models.register(
    new MockModelAdapter({
      script: (_r, turn) =>
        turn === 0
          ? { toolCalls: [{ id: "c0", name: "big.read", arguments: {} }], finishReason: "tool_use" }
          : { text: JSON.stringify({ done: true }), finishReason: "stop" },
      pricePerMTok: 0,
    }),
    true,
  );

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models,
    now,
    maxParallelism: 2,
    contextTokens: CONTEXT_TOKENS,
    policy: { granted: ["big:read"], budget: { runUsd: 100 } },
  });

  const graph = compileOrThrow({
    spec: spec(),
    resolver: resolver() as ResourceResolver,
    tools: { "big.read": BIG },
    tenantCapabilities: ["big:read"],
  });
  const runId = await engine.submit({ graph, inputs: { seed: "go" } });
  const p = await engine.advance(runId).catch(() => engine.projection(runId));

  assert.notEqual(p?.status, "succeeded", "a request that cannot fit the window must not report success");
  const evs: string[] = [];
  for await (const ev of store.read(runId, 1)) {
    const payload = ev.payload as { error?: { code?: string } };
    if (payload.error?.code !== undefined) evs.push(payload.error.code);
  }
  assert.ok(
    evs.includes("E_CONTEXT_OVERFLOW"),
    `expected E_CONTEXT_OVERFLOW in the journal; saw ${evs.join(", ") || "(no error codes)"}`,
  );
});

test("EACH TURN'S SUMMARY GETS ITS OWN EFFECT KEY — a fixed ordinal makes every summary in a task collide", async () => {
  // `#summarizeEffect` keyed on a literal 0. That was invisible while `turns` was never
  // populated and rung 3 could not fire; folding per turn makes it load-bearing. Two
  // summaries under one key means the last write wins and replay serves it for both.
  const { seen, keys } = await runCountingSummaries();
  assert.ok(seen.length > 2, "the loop must iterate enough to fold more than once");
  assert.ok(keys.length >= 2, `expected at least two summarisations; saw ${String(keys.length)}`);
  assert.equal(
    new Set(keys).size,
    keys.length,
    `every summarisation needs its own effect key; got ${keys.length} summaries under ${String(new Set(keys).size)} key(s): ${keys.join(", ")}`,
  );
});

/** Drives a loop long enough to fold repeatedly, recording each summarise effect key. */
async function runCountingSummaries(): Promise<{ seen: readonly ModelRequest[]; keys: string[] }> {
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const tools = new ToolRegistry();
  tools.register({
    ...BIG,
    description: "Return a large blob.",
    parameters: { type: "object", properties: { k: { type: "string" } } },
    execute: () => ({ content: "y".repeat(RESULT_CHARS) }),
  } as ToolDefinition);

  const adapter = new MockModelAdapter({
    script: (_r, turn) =>
      turn < MAX_TURNS - 1
        ? { toolCalls: [{ id: `c${String(turn)}`, name: "big.read", arguments: { k: String(turn) } }], finishReason: "tool_use" }
        : { text: JSON.stringify({ done: true }), finishReason: "stop" },
    pricePerMTok: 0,
  });
  const models = new ModelRegistry();
  models.register(adapter, true);

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models,
    now,
    maxParallelism: 2,
    contextTokens: CONTEXT_TOKENS,
    policy: { granted: ["big:read"], budget: { runUsd: 100 } },
  });

  const graph = compileOrThrow({
    spec: spec(),
    resolver: resolver() as ResourceResolver,
    tools: { "big.read": BIG },
    tenantCapabilities: ["big:read"],
  });
  const runId = await engine.submit({ graph, inputs: { seed: "go" } });
  await engine.advance(runId).catch(() => engine.projection(runId));

  // The keys are journal facts, not an in-memory count: `effect.started` carries the key
  // each summarisation ran under, so a collision is visible as a repeated key.
  const keys: string[] = [];
  for await (const ev of store.read(runId, 1)) {
    if (ev.type !== "effect.started") continue;
    const p = ev.payload as { key?: string; kind?: string };
    if (p.kind === "summarize" && p.key !== undefined) keys.push(p.key);
  }
  return { seen: adapter.seen, keys };
}

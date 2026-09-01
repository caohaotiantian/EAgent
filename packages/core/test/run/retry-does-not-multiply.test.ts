/**
 * TWO RETRY CURVES MULTIPLIED, and nothing decremented across them.
 *
 * `graph/compile.ts` hands every provider-calling node `DEFAULT_PROVIDER_RETRY`
 * (`maxAttempts: 3`), so the engine reschedules a failed agent node twice. `providers/http.ts`
 * defaulted to three attempts of its own inside a single `postJson`. Neither layer knew about
 * the other, so one agent node against a dead provider cost 3 x 3 = 9 HTTP requests — times the
 * fan-out width, for a fan-out.
 *
 * The half that had to go is the transport's, and the reason is not that it is the outer one.
 * An engine retry appends `task.retry_scheduled`: an operator can see it, a fold can reproduce
 * it, and `#retryDecision` can refuse it for a reason (`RUN_FATAL_CODES`, a non-idempotent tool
 * that may have rung a bell, a spent deferral budget). A `postJson` attempt is visible to nobody
 * and reproducible by nothing, and it will happily repeat a call the engine would have refused.
 *
 * WHAT THIS TEST HAS TO SHOW IS BOTH NUMBERS AT ONCE. Dropping requests is trivial if the retry
 * went with them, so the point is that the JOURNALED curve is untouched while the invisible copy
 * of it is gone: same `task.retry_scheduled` count, a third of the requests.
 *
 * A 429 is measured beside it because it is the case that never multiplied — `postJson` rethrows
 * a rate limit without a hold, and the engine defers it instead of charging an attempt — so it
 * is the control that says the change is about the transport's curve and not about retries.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { NodeId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { AnthropicAdapter } from "../../src/providers/anthropic.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const spec: GraphSpec = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "retry-multiplier", project: "t", version: 1 },
  policy: { posture: "out", budget: { costUsd: 100 } },
  channels: { file: { type: "string", reduce: "replace" }, reviews: { type: "array", reduce: "append_ordered" } },
  inputs: ["file"],
  outputs: ["reviews"],
  nodes: [
    {
      id: "review",
      type: "agent",
      reads: ["file"],
      writes: ["reviews"],
      unhandled: true,
      agent: { profile: "agent_profile/p@v1", prompt: "prompt/p@v1", maxTurns: 2 },
    },
  ],
  edges: [],
} as unknown as GraphSpec;

/**
 * One agent node against a provider that answers `status` forever.
 *
 * The clock is driven rather than read, so the scheduled retries come due without a real wait
 * and the counts are the only thing the assertions depend on.
 */
async function deadProvider(status: number, opts: { maxAttempts?: number } = {}) {
  let requests = 0;
  let clock = 1_700_000_000_000;
  const now = (): number => clock;
  const store = new MemoryStateStore({ now });
  const models = new ModelRegistry();
  models.register(
    new AnthropicAdapter({
      apiKey: "k",
      fetch: async () => {
        requests += 1;
        return new Response("overloaded", { status });
      },
      sleep: async (ms: number) => {
        clock += ms;
      },
      ...opts,
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
    sleep: async (ms: number) => {
      clock += ms;
    },
    maxParallelism: 1,
    resolver: resolver(),
    policy: { granted: [], budget: { runUsd: 100 } },
  });

  const graph = compileOrThrow({ spec, resolver: resolver(), tools: {}, tenantCapabilities: [] });
  assert.equal(graph.plans["review" as NodeId]?.retry?.maxAttempts, 3, "precondition: the node carries the compiled provider retry");

  const runId = await engine.submit({ graph, inputs: { file: "a.ts" } });
  let p = await engine.advance(runId);
  for (let i = 0; i < 60 && p.status !== "failed" && p.status !== "succeeded"; i++) {
    clock += 120_000;
    p = await engine.advance(runId);
  }
  let retriesScheduled = 0;
  for await (const ev of store.read(runId, 1)) if (ev.type === "task.retry_scheduled") retriesScheduled += 1;
  return { requests, retriesScheduled, status: p.status };
}

test("A DEAD PROVIDER COSTS ONE REQUEST PER ENGINE ATTEMPT, not three", async () => {
  const measured = await deadProvider(503);
  console.log(`503 dead provider: ${JSON.stringify(measured)}`);

  assert.equal(measured.status, "failed", "precondition: the run does end rather than retrying forever");
  assert.equal(measured.retriesScheduled, 2, "precondition: the engine's own curve ran to its bound");
  assert.equal(
    measured.requests,
    3,
    "the transport is retrying on top of the engine — 3 engine attempts x 3 postJson attempts is the multiplication",
  );
});

test("AND AN EMBEDDER CAN STILL ASK FOR THE TRANSPORT CURVE — which is what multiplied", async () => {
  // The negative control, and the one that fixes the number in place: with the transport's old
  // default restored by hand the same run costs exactly three times as many requests for exactly
  // the same journal. Without this arm, `requests: 3` above is equally consistent with the
  // engine having quietly stopped retrying.
  const measured = await deadProvider(503, { maxAttempts: 3 });
  console.log(`503 dead provider, transport maxAttempts 3: ${JSON.stringify(measured)}`);

  assert.equal(measured.retriesScheduled, 2, "the journaled curve is the same one");
  assert.equal(measured.requests, 9, "and it bought 9 requests where 3 did the same work");
});

test("A RATE LIMIT NEVER MULTIPLIED — the deferral arm is untouched", async () => {
  // `postJson` rethrows a 429 without a hold, so there was never a transport curve here to
  // remove; the engine defers instead, which repeats the attempt rather than charging it. The
  // two arms measure identical, which is what makes this a control.
  const byDefault = await deadProvider(429);
  const optedIn = await deadProvider(429, { maxAttempts: 3 });
  console.log(`429: default ${JSON.stringify(byDefault)} vs maxAttempts 3 ${JSON.stringify(optedIn)}`);

  assert.deepEqual(byDefault, optedIn, "a rate limit must cost the same either way — it never held here");
  assert.equal(byDefault.requests, byDefault.retriesScheduled + 1, "one request per deferral, and none hidden inside one");
});

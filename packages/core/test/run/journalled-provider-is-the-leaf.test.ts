/**
 * THE JOURNAL MUST NAME THE PROVIDER THAT ACTUALLY SERVED THE TURN, not the wrapper the engine
 * happened to be holding.
 *
 * D.7.6. `model.called.provider` is the journal's only record of which provider answered, and
 * the engine journalled `adapter.provider` — the object it called `stream` on. In every CLI
 * deployment that object is a `RoutingAdapter` whose `provider` is the literal `"routed"`, so
 * every row in every journal this binary ever wrote says `"routed"` and nothing else. It was
 * already leaking into a shipped surface: `telemetry/spans.ts` emits `gen_ai.system` from this
 * field, so every OTLP export named the router too.
 *
 * `FallbackAdapter` MAKES IT SHARPEST, and is why these tests use it rather than the router: a
 * call that failed over to tier 2 was journalled identically to one that did not, so the
 * journal could not say a fallback had ever fired. That is exactly the evidence a
 * journal-derived circuit breaker would need, and CLAUDE.md's first non-negotiable is that a
 * value a decision reads must be reconstructable by folding — this one was never written.
 *
 * MEASURED ON THE TREE BEFORE THE FIX, the failover case below:
 *
 *   journalled provider: "fallback(primary)"   — the wrapper, for a turn tier 2 served
 *
 * THE FIX IS THE FRAME, not an interrogation. The adapter that made the call is the only thing
 * that knows which leaf answered, and it knows at the moment it reports the outcome — so
 * `ModelEvent`'s terminal `done` frame carries a required `provider` and the composites forward
 * the leaf's frame unchanged, which they already did structurally. It needed NO schema change:
 * `model.called.provider` already existed and was already `string`. The vocabulary was right
 * and the writer was wrong.
 *
 * EVERY JOURNAL WRITTEN BEFORE THIS KEEPS `"routed"`, and cannot be re-attributed.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { CODES, err } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { RunId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { FallbackAdapter } from "../../src/providers/fallback.ts";
import { Engine } from "../../src/run/engine.ts";
import {
  FunctionRegistry,
  MockModelAdapter,
  ModelRegistry,
  ToolRegistry,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
} from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const NOW = 1_700_000_000_000;

function spec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "who", project: "d76", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { q: { type: "string", reduce: "replace" }, a: { type: "string", reduce: "replace" } },
    inputs: ["q"],
    outputs: ["a"],
    nodes: [
      { id: "ask", type: "agent", reads: ["q"], writes: ["a"], agent: { profile: "agent_profile/x@stable", prompt: "prompt/p@stable" } },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

function rig(adapter: ModelAdapter): { engine: Engine; store: MemoryStateStore; graph: ReturnType<typeof compileOrThrow> } {
  const models = new ModelRegistry();
  models.register(adapter, true);
  const store = new MemoryStateStore({ now: () => NOW });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions: new FunctionRegistry(),
    models,
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 10 } },
  });
  return { engine, store, graph: compileOrThrow({ spec: spec(), resolver: resolver(), tools: {}, tenantCapabilities: [] }) };
}

/** Every `model.called.provider` the run wrote, in order. */
async function journalledProviders(store: MemoryStateStore, runId: RunId): Promise<string[]> {
  const out: string[] = [];
  for await (const ev of store.read(runId, 1)) {
    if (ev.type === "model.called") out.push(String((ev.payload as { provider?: unknown }).provider));
  }
  return out;
}

const answers = (provider: string): MockModelAdapter =>
  new MockModelAdapter({ provider, script: () => ({ text: "done", finishReason: "stop" }) });

function raises(provider: string): MockModelAdapter {
  return new MockModelAdapter({
    provider,
    script: () => {
      throw err.unavailable(CODES.E_PROVIDER_RATE_LIMIT, `${provider} is busy`);
    },
  });
}

test("A FALLBACK THAT FIRED IS VISIBLE IN THE JOURNAL — the tier that answered, not the chain", async () => {
  const chain = new FallbackAdapter({
    primary: { adapter: raises("primary"), model: "big" },
    fallback: [{ adapter: answers("secondary"), model: "small" }],
  });
  // The wrapper's own identity, which is what used to be journalled and must not be now.
  assert.equal(chain.provider, "fallback(primary)");

  const r = rig(chain);
  const runId = await r.engine.submit({ graph: r.graph, inputs: { q: "hi" } });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(
    await journalledProviders(r.store, runId),
    ["secondary"],
    "a turn tier 2 served must be journalled as tier 2, or the journal cannot say a fallback ever fired",
  );
});

test("THE CONTROL: the same chain with a healthy primary journals the PRIMARY", async () => {
  // The distinction has to be visible in both directions, or the field is just a new constant.
  const chain = new FallbackAdapter({
    primary: { adapter: answers("primary"), model: "big" },
    fallback: [{ adapter: answers("secondary"), model: "small" }],
  });
  const r = rig(chain);
  const runId = await r.engine.submit({ graph: r.graph, inputs: { q: "hi" } });
  await r.engine.advance(runId);

  assert.deepEqual(await journalledProviders(r.store, runId), ["primary"]);
});

/**
 * A WRAPPER THAT REWRITES THE MODEL AND FORWARDS THE FRAME — `RoutingAdapter`'s shape, which is
 * the deployment case, reproduced here because that class is private to `cli.ts`. Two routes,
 * two leaves, and the two configured NAMES must reach the journal rather than the wrapper's.
 */
class TwoRoutes implements ModelAdapter {
  readonly provider = "routed";
  readonly #routes: ReadonlyMap<string, ModelAdapter>;
  constructor(routes: ReadonlyMap<string, ModelAdapter>) {
    this.#routes = routes;
  }
  #to(model: string): ModelAdapter {
    const a = this.#routes.get(model) ?? this.#routes.get("*");
    if (a === undefined) throw err.validation(CODES.E_CONFIG_INVALID, `no route for "${model}"`);
    return a;
  }
  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    return this.#to(req.model).stream(req, signal);
  }
  priceOf(model: string, usage: Parameters<ModelAdapter["priceOf"]>[1]): number {
    return this.#to(model).priceOf(model, usage);
  }
  estimateOf(req: ModelRequest): number {
    return this.#to(req.model).estimateOf(req);
  }
  outputCeilingOf(req: ModelRequest): number {
    return this.#to(req.model).outputCeilingOf(req);
  }
}

test("A ROUTER'S OWN NAME NEVER REACHES THE JOURNAL — the leaf it routed to does", async () => {
  const routed = new TwoRoutes(new Map<string, ModelAdapter>([["*", answers("claude-big")]]));
  assert.equal(routed.provider, "routed", "the wrapper still calls itself that; the point is that the journal does not");

  const r = rig(routed);
  const runId = await r.engine.submit({ graph: r.graph, inputs: { q: "hi" } });
  await r.engine.advance(runId);

  const seen = await journalledProviders(r.store, runId);
  assert.deepEqual(seen, ["claude-big"], `the journal named the router instead of the leaf: ${JSON.stringify(seen)}`);
  assert.ok(!seen.includes("routed"), "`routed` is not a provider and must never appear");
});

// ── and the frame the type cannot enforce ───────────────────────────────────

/**
 * `provider` is REQUIRED on the `done` frame, so every adapter TypeScript ever saw sets it. An
 * adapter arriving through an `--extension-module`, or handed to `EngineOptions.models` by an
 * embedder, is the case it cannot reach.
 *
 * THE ORDERING IS THE INTERESTING HALF, and it is FX13's: the call HAPPENED and cost money, so
 * `model.called` and the spend are journalled FIRST — recording `adapter.provider`, the only
 * thing the engine honestly knows about that turn — and only then is the turn refused. The row
 * that names the wrapper is therefore attached to a turn that never became an answer anything
 * read. What must not happen is the other thing: silently accepting `adapter.provider` and
 * continuing, which is precisely the defect this change removes, restored for exactly the
 * adapters nobody in this repo wrote.
 */
test("AN ADAPTER THAT WILL NOT NAME THE SERVING PROVIDER IS REFUSED, not attributed to the wrapper", async () => {
  const mute: ModelAdapter = {
    provider: "mute-wrapper",
    async *stream(): AsyncIterable<ModelEvent> {
      // The frame an untyped adapter can produce: no `provider`.
      yield {
        type: "done",
        message: { role: "assistant", content: "an answer nobody may use" },
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001, wallMs: 0 },
      } as unknown as ModelEvent;
    },
    priceOf: () => 0.001,
    estimateOf: () => 0.001,
    outputCeilingOf: () => 1024,
  };

  const r = rig(mute);
  const runId = await r.engine.submit({ graph: r.graph, inputs: { q: "hi" } });
  const p = await r.engine.advance(runId);

  assert.notEqual(p.status, "succeeded", "a turn with no attributable provider is not an answer");
  assert.equal(p.error?.code, "E_PROVIDER_BAD_REQUEST", JSON.stringify(p.error ?? {}));
  assert.match(String(p.error?.message ?? ""), /without naming the provider that served it/, JSON.stringify(p.error ?? {}));
  assert.notEqual(p.channels["a"], "an answer nobody may use", "and its content must not have reached the channel");

  // The call happened and was billed, so it is on the record — under the only name available.
  assert.deepEqual(await journalledProviders(r.store, runId), ["mute-wrapper"]);
});

test("AN EMPTY PROVIDER STRING IS NOT A NAME EITHER", async () => {
  // `""` is what a wrapper that forwards `opts.provider ?? ""` produces, and it identifies
  // nothing. It takes the same arm as an absent field rather than being journalled as a name.
  const blank: ModelAdapter = {
    provider: "blank-wrapper",
    async *stream(): AsyncIterable<ModelEvent> {
      yield {
        type: "done",
        provider: "",
        message: { role: "assistant", content: "x" },
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001, wallMs: 0 },
      };
    },
    priceOf: () => 0.001,
    estimateOf: () => 0.001,
    outputCeilingOf: () => 1024,
  };

  const r = rig(blank);
  const runId = await r.engine.submit({ graph: r.graph, inputs: { q: "hi" } });
  const p = await r.engine.advance(runId);

  assert.equal(p.error?.code, "E_PROVIDER_BAD_REQUEST", JSON.stringify(p.error ?? {}));
  assert.deepEqual(await journalledProviders(r.store, runId), ["blank-wrapper"]);
});

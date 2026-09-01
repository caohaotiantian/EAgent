/**
 * An `assertion` evaluator's `ref` IS a function body, so it must run the SAME contract.
 *
 * `Engine.#functionBody` has exactly two callers — `#runFunction` and `#runEvaluator`'s
 * `assertion` arm — and one shared validator, `requireOutcome`. Every change to the contract has
 * landed at one caller a commit before the other: the seed, the clock, the outcome shape, and now
 * `take`. This suite pins the pair by driving the SAME BODY through both node types and requiring
 * the same answer, because an assertion made about one caller has never been evidence about the
 * other in this file's history.
 *
 * `take` is the one that was broken, and it was broken in the permissive direction: an assertion
 * body returning `take: ["ea"]` had it dropped, and no `take` does not mean "no edges" — it means
 * EVERY outgoing edge fires. So a pass/fail assertion asking for its pass edge also took its fail
 * edge and told nobody. `requireOutcome` names `take` in the shape it prints and refuses it
 * alongside `retry`, so the body was writing the contract as documented.
 *
 * THE `ctx.effects` TEST HERE IS A LEDGER ENTRY, NOT A WISH. It records what an assertion body
 * sees today (`undefined`) beside the fact that falsifies TODO G.1's stated reason for that — the
 * body AWAITS. The row says evaluators are open because "a resource-loaded body runs
 * synchronously inside `vm.runInContext` and cannot await"; that is the SANDBOX's reason, it is
 * true of `function` nodes identically (`test/resources/functions.test.ts` measures the
 * `E_EFFECT_UNAVAILABLE` stub a sandboxed body gets), and it says nothing about evaluators. When
 * the declaration gets somewhere to live, this test is what turns red.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compile, compileOrThrow } from "../../src/graph/compile.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry, type FunctionBody } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const NOW = () => 1_700_000_000_000;
const REF = "evaluator/pass-fail@stable";

/**
 * One graph, one body ref, one pair of outgoing `seq` edges — and the node under test is either
 * an `evaluator{kind:"assertion"}` or a `function`, which is the whole point. The two downstream
 * nodes write different channels, so which edges fired is readable off the final state.
 */
const spec = (as: "evaluator" | "function") =>
  ({
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "evaluator-body-contract", project: "test", version: 1 },
    policy: { posture: "out", budget: { costUsd: 1 }, capabilities: [] },
    channels: {
      seed: { type: "string", reduce: "replace" },
      out: { type: "object", reduce: "replace" },
      a: { type: "string", reduce: "replace" },
      b: { type: "string", reduce: "replace" },
    },
    inputs: ["seed"],
    outputs: ["out"],
    nodes: [
      {
        id: "e",
        type: as,
        reads: ["seed"],
        writes: ["out"],
        ...(as === "evaluator"
          ? { evaluator: { kind: "assertion", ref: REF, threshold: 0.1 } }
          : { function: { ref: REF, effects: [] } }),
      },
      { id: "na", type: "function", reads: ["out"], writes: ["a"], function: { ref: "function/wa@stable", effects: [] } },
      { id: "nb", type: "function", reads: ["out"], writes: ["b"], function: { ref: "function/wb@stable", effects: [] } },
    ],
    edges: [
      { id: "ea", from: "e", to: "na", kind: "seq" },
      { id: "eb", from: "e", to: "nb", kind: "seq" },
    ],
  }) as never;

async function drive(as: "evaluator" | "function", body: FunctionBody) {
  const store = new MemoryStateStore({ now: NOW });
  const functions = new FunctionRegistry();
  functions.register(REF, body);
  functions.register("function/wa@stable", async () => ({ writes: { a: "A" } }));
  functions.register("function/wb@stable", async () => ({ writes: { b: "B" } }));
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models,
    now: NOW,
    sleep: async () => {},
    maxParallelism: 1,
    policy: { granted: [], budget: { runUsd: 1 } },
  });

  const graph = compileOrThrow({ spec: spec(as), resolver: resolver(), tools: {} as never, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { seed: "go" } });
  return await engine.advance(runId);
}

test("AN ASSERTION BODY'S `take` SELECTS EDGES — dropping it fires every edge, not none", async () => {
  const asks = async () => ({ writes: { out: { confidence: 1 } }, take: ["ea"] }) as never;

  // THE BASELINE FIRST, so a red row below means the two callers disagree rather than that `take`
  // is broken everywhere. Same body, same edges, one node type apart.
  const fn = await drive("function", asks);
  assert.equal(fn.status, "succeeded", JSON.stringify(fn.error ?? {}));
  assert.equal(fn.channels["a"], "A", "precondition: a `function` node honours `take`");
  assert.equal(fn.channels["b"], undefined, "precondition: and the unasked edge does not fire");

  const ev = await drive("evaluator", asks);
  assert.equal(ev.status, "succeeded", JSON.stringify(ev.error ?? {}));
  assert.equal(ev.channels["a"], "A", "the asked-for edge must fire");
  assert.equal(
    ev.channels["b"],
    undefined,
    "THE UNASKED EDGE FIRED: the assertion arm dropped `take`, and no `take` means every outgoing edge",
  );
});

test("AN ASSERTION BODY RETURNING NO `take` STILL FIRES EVERY EDGE — the default is unchanged", async () => {
  // The fix must not turn "said nothing" into "said none". A body that returns no `take` is not
  // making a claim about edges, and the fan-out it always had is what the graph's edges mean.
  const ev = await drive("evaluator", async () => ({ writes: { out: { confidence: 1 } } }));
  assert.equal(ev.status, "succeeded", JSON.stringify(ev.error ?? {}));
  assert.equal(ev.channels["a"], "A");
  assert.equal(ev.channels["b"], "B", "an assertion that asked for nothing must still take both edges");
});

test("AN ASSERTION BODY AWAITS A HOST ROUND TRIP — so `ctx.effects` is unwired, not impossible", async () => {
  // TODO G.1 says evaluators are open because a body "cannot await". Driven, that is false on the
  // path where `function` effects actually work: the in-process one. Both halves are asserted
  // together on purpose — the second is only interesting because the first is true.
  let awaited = false;
  let seen: unknown = "unset";
  const ev = await drive("evaluator", async (_v, c) => {
    seen = (c as { effects?: unknown }).effects;
    await new Promise((r) => setTimeout(r, 1));
    awaited = true;
    return { writes: { out: { confidence: 1 } } };
  });

  assert.equal(ev.status, "succeeded", JSON.stringify(ev.error ?? {}));
  assert.equal(awaited, true, "the engine awaits an assertion body exactly as it awaits a function body");
  assert.equal(seen, undefined, "and hands it no effects — the gap G.1 names, for a reason G.1 gets wrong");
});

test("AND THE DECLARATION HAS NOWHERE TO LIVE — `evaluator.effects` is refused, not inert", async () => {
  // This is the half that makes opening G.1 a schema change rather than a wiring change, and it
  // is the GOOD state: `ALLOWED_FIELDS` refuses the field instead of accepting it and deciding
  // nothing, which is what it used to do. Pinned so that a future opening is deliberate.
  const withEffects = spec("evaluator") as { nodes: { evaluator?: Record<string, unknown> }[] };
  withEffects.nodes[0]!.evaluator!["effects"] = ["note.write"];

  const r = compile({ spec: withEffects as never, resolver: resolver(), tools: {} as never, tenantCapabilities: [] });
  assert.equal(r.ok, false, "an evaluator declaring `effects` must not compile silently");
  const d = r.diagnostics.find((x) => x.code === "GRAPH020_UNKNOWN_FIELD");
  assert.ok(d, `expected GRAPH020_UNKNOWN_FIELD, got ${r.diagnostics.map((x) => x.code).join(", ")}`);
  assert.match(d.message, /`effects`/, d.message);
});

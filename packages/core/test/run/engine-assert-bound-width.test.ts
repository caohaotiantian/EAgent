/**
 * A FAN-OUT WIDTH THIS BUILD CANNOT READ REFUSES THE RUN, at the executor's own door.
 *
 * `Engine.submit` and `Engine.attach` take a `RunGraph`, and `RunGraph` is exported — so an
 * embedder can build one without going through `compile`, and `graph/validate.ts`'s
 * GRAPH007_NO_MAX_WIDTH / GRAPH007_BAD_MAX_WIDTH never run. What reaches the executor then is
 * `#activate`'s `items.slice(0, e.maxWidth ?? 0)`, which takes ZERO branches for `NaN`, `0`,
 * `"24"` and absent and says nothing about it, and `computeFanoutStacks`, where one `NaN` makes
 * every downstream parallel width `NaN` so GRAPH010's concurrent-writer refusal silently stops
 * firing. The CLI cannot reach this; an embedder can. (§A.59(1).)
 *
 * WHY THE EXECUTOR RE-CHECKS RATHER THAN DECLARING THE EMBEDDER OUT OF SCOPE: `#assertBound`
 * already re-checks a compile-time property three lines earlier, and for this same reason — an
 * edge `kind` this build cannot read, closed at compile by GRAPH003_UNKNOWN_EDGE_KIND and closed
 * again at the door "because `attach` is public and `RunGraph` is exported". Answering §A.59(1)
 * the other way would refuse a run for a mistyped `kind` and accept one for a mistyped
 * `maxWidth`, three lines apart, on the same argument.
 *
 * WHAT IS NOT RE-CHECKED, named so the gap is a decision and not an oversight: the ceiling.
 * `rule007Fanout` also refuses a width over `expansion.maxFanout`, and the engine does not,
 * because that ceiling is a policy number the compiler produces by merging graph policy over
 * defaults — re-deriving it in the kernel would be a second implementation of a budget, and any
 * drift would refuse graphs the compiler accepted, including runs already in flight. The last
 * case below pins that: an over-ceiling width the compiler refuses is ACCEPTED here.
 *
 * The graphs are built by hand and handed straight to `submit`, because that is the door the row
 * is about; going through `compileOrThrow` would be testing the compiler again.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId, RunId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;
const NOW = 1_700_000_000_000;

/** `start --fanout(width)--> b0 --join--> J`, the smallest graph with a width in it. */
function spec(width: unknown): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "assert-bound-width", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 64, maxDepth: 2, maxFanout: 16, maxLoopIterations: 1 } },
    channels: {
      items: { type: "array", reduce: "replace" },
      item: { type: "object", reduce: "replace" },
      seen: { type: "array", reduce: "append_ordered" },
    },
    inputs: ["items"],
    outputs: [],
    nodes: [
      { id: n("start"), type: "function", reads: ["items"], function: { ref: "function/seed@stable" } },
      { id: n("b0"), type: "function", reads: ["item"], writes: ["seen"], function: { ref: "function/work@stable" } },
      {
        id: n("J"),
        type: "join",
        reads: ["seen"],
        writes: ["seen"],
        join: { branches: [n("b0")], mode: "all", onBranchError: "skip" },
      },
    ],
    edges: [
      { id: e("fo"), from: n("start"), to: n("b0"), kind: "fanout", over: "items", as: "item", maxWidth: width },
      { id: e("jn0"), from: n("b0"), to: n("J"), kind: "join", branches: [n("b0")] },
    ],
  } as unknown as GraphSpec;
}

function engineWith(store: MemoryStateStore): Engine {
  const functions = new FunctionRegistry();
  functions.register("function/seed@stable", () => ({}));
  functions.register("function/work@stable", (view) => ({ writes: { seen: [view.get<{ id: string }>("item")?.id ?? "?"] } }));
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);
  return new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models,
    now: () => NOW,
    maxParallelism: 4,
    policy: { granted: [], budget: { runUsd: 1 } },
  });
}

/**
 * The embedder's path, end to end: build a `RunGraph` the compiler never saw, `submit` it, and
 * `advance`. The graph is a compiled one with the width overwritten in place — that is what an
 * embedder assembling a `RunGraph` by hand produces, and every other field stays exactly as a
 * real compile left it, so what the run is refused for can only be the width.
 *
 * `submit` and not `attach`, because `attach` on a run this Engine already holds is a no-op
 * (`#contextFor` returns the existing context), and `submit` is the door an embedder actually
 * comes through. The width check sits ABOVE the `run.compiled` lookup in `#assertBound`, so it
 * does not depend on what `submit` journalled.
 */
async function advanceWith(
  width: unknown,
): Promise<{ ok: boolean; message: string; code: unknown; errorClass: unknown; branches: number }> {
  const store = new MemoryStateStore({ now: () => NOW });
  const engine = engineWith(store);
  const good = compileOrThrow({ spec: spec(2), resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const forged = {
    ...good,
    spec: { ...good.spec, edges: good.spec.edges.map((edge) => (edge.kind === "fanout" ? { ...edge, maxWidth: width } : edge)) },
  } as RunGraph;

  try {
    const runId: RunId = await engine.submit({ graph: forged, inputs: { items: [{ id: "a" }, { id: "b" }] } });
    const p = await engine.advance(runId);
    return {
      ok: true,
      message: "",
      code: undefined,
      errorClass: undefined,
      branches: (p.channels["seen"] as unknown[] | undefined)?.length ?? 0,
    };
  } catch (thrown) {
    const e = thrown as { message?: string; code?: unknown; class?: unknown };
    return { ok: false, message: e.message ?? String(thrown), code: e.code, errorClass: e.class, branches: -1 };
  }
}

test("AN UNREADABLE FAN-OUT WIDTH REFUSES THE RUN AT `#assertBound`, not silently at `slice`", async () => {
  // Every value `isPositiveInt` rejects, including the two that reach the compiler's own arithmetic
  // as a `TypeError` (`bigint`, `symbol`) and therefore have to be described without `JSON.stringify`.
  const unreadable: readonly (readonly [string, unknown])[] = [
    ["a quoted number", "24"],
    ["NaN", Number.NaN],
    ["zero", 0],
    ["a negative", -1],
    ["a fraction", 2.5],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["absent", undefined],
    ["null", null],
    ["a bigint", 10n],
    ["a symbol", Symbol("w")],
    ["an object", {}],
    ["an array", [2]],
    ["a boolean", true],
  ];

  for (const [what, width] of unreadable) {
    const r = await advanceWith(width);
    assert.equal(r.ok, false, `${what}: the run must be refused, not fanned out to zero branches`);
    // THE CODE AND THE CLASS, not only the prose. A caller branches on `code` and a retry
    // decision reads `class` — `RETRYABLE` does not hold `validation`, so a refused width must
    // never be retried, and asserting the message alone would let either drift silently.
    assert.equal(r.code, "E_GRAPH_INVALID", `${what}: refused under the code the door already uses`);
    assert.equal(r.errorClass, "validation", `${what}: and the class that makes it unretryable`);
    assert.match(r.message, /maxWidth this build cannot read/, `${what}: and say so`);
    assert.match(r.message, /"fo"/, `${what}: naming the edge`);
  }
});

test("A READABLE WIDTH IS UNTOUCHED, INCLUDING ONE OVER THE COMPILER'S CEILING", async () => {
  // The two-sided half. `1` and `2` must run exactly as before — a refusal that fired on a good
  // width would wedge every fan-out in the product.
  for (const width of [1, 2]) {
    const r = await advanceWith(width);
    assert.equal(r.ok, true, `width ${width} must still run`);
    assert.equal(r.branches, width, `width ${width}: and fan out that many branches`);
  }

  // And the ceiling is deliberately NOT re-checked here: `expansion.maxFanout` is 16 in this
  // spec, so the compiler refuses 999 with GRAPH007_MAX_WIDTH_EXCEEDED and the executor accepts
  // it. Pinned so that the gap is a decision on the record rather than something a later reader
  // has to infer from its absence. (The run still fans out only two branches — `slice` is bounded
  // by the channel, which holds two items.)
  const over = await advanceWith(999);
  assert.equal(over.ok, true, "the executor re-checks readability, not the budget");
  assert.equal(over.branches, 2, "and the channel, not the ceiling, is what bounds the fan");
});

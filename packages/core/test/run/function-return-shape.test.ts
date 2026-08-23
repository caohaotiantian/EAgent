/**
 * A RETURN NOBODY READS IS AN AUTHORING MISTAKE, NOT AN EMPTY RESULT.
 *
 * `FunctionOutcome` is `{ writes?, take? }` — and it is a TypeScript type, which a
 * `resources/function/*.js` author never sees. They write plain JS against a shape documented
 * nowhere they are looking, and both ways of getting it wrong were handled badly. Measured
 * through `bin/loom` on a fan-out graph:
 *
 *   (view) => ({ seen: [x] })   the channel map returned DIRECTLY. `out.writes` is undefined,
 *                               the task commits `writes: {}`, and the run dies later with
 *                               `E_OUTPUT_MISSING` naming a channel the body believed it wrote.
 *   (view) => { ... }           no return at all — a raw
 *                               "TypeError: Cannot read properties of undefined (reading
 *                               'writes')" shown to a graph author.
 *
 * The rule is not a heuristic: an object EVERY key of which is ignored cannot be what the author
 * meant. `{}` stays legal, and so do extra keys alongside `writes`/`take`, because then the
 * return WAS read.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type FunctionOutcome } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const NOW = 1_700_000_000_000;

function spec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "fnshape", project: "t", version: 1 },
    policy: { posture: "out" },
    channels: { seen: { type: "array", reduce: "append_ordered" } },
    inputs: [],
    outputs: ["seen"],
    nodes: [{ id: "f", type: "function", writes: ["seen"], function: { ref: "function/b@stable" } }],
    edges: [],
  } as unknown as GraphSpec;
}

/** `body` is deliberately typed loosely: the point is what a JS author can actually return. */
async function runWith(body: unknown) {
  const functions = new FunctionRegistry();
  functions.register("function/b@stable", body as () => FunctionOutcome);
  const store = new MemoryStateStore({ now: () => NOW });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: [], systemFloor: "out" },
  });
  const graph = compileOrThrow({ spec: spec(), resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: {} });
  return engine.advance(runId);
}

test("THE CHANNEL MAP RETURNED DIRECTLY IS REFUSED, and the message names the fix", async () => {
  const p = await runWith(() => ({ seen: ["x"] }));
  assert.equal(p.status, "failed");
  assert.equal(p.error?.code, "E_RESOURCE_INVALID", JSON.stringify(p.error ?? {}));
  assert.match(String(p.error?.message), /every key of which is ignored/);
  assert.match(String(p.error?.message), /Did you mean \{ writes: \{ seen/, "the suggestion must use the author's own key");
});

test("a body that returns nothing is refused too, rather than throwing a TypeError", async () => {
  const p = await runWith(() => undefined);
  assert.equal(p.status, "failed");
  assert.equal(p.error?.code, "E_RESOURCE_INVALID", JSON.stringify(p.error ?? {}));
  assert.match(String(p.error?.message), /returned nothing/);
  assert.doesNotMatch(String(p.error?.message), /TypeError/, "an authoring mistake must not surface as an internal error");
});

test("AND THE LEGAL SHAPES STILL RUN — an empty object, and writes alongside anything else", async () => {
  // The positive control. Without it this suite passes against an engine that refuses every
  // function body, which would be a far worse defect than the one it is guarding.
  const empty = await runWith(() => ({}));
  assert.notEqual(empty.error?.code, "E_RESOURCE_INVALID", "a body that writes nothing is ordinary");

  const written = await runWith(() => ({ writes: { seen: ["x"] }, note: "ignored but harmless" }));
  assert.equal(written.status, "succeeded", JSON.stringify(written.error ?? {}));
  assert.deepEqual(written.channels["seen"], ["x"], "the write still lands");
});

test("AND THE EVALUATOR ARM IS HELD TO THE SAME CONTRACT — one validator, two callers", async () => {
  // An `assertion` evaluator's `ref` IS a function body: `#runEvaluator` calls
  // `functions.require(ev.ref)` and reads `out.writes` exactly as `#runFunction` does. The first
  // version of this check lived inline in `#runFunction` and the evaluator kept the defect —
  // measured through `bin/loom`, an assertion body returning `{ confidence: 0.9 }` committed
  // nothing and the run died with `E_OUTPUT_MISSING`, the same silent shape that was just fixed
  // one function over. That is the too-small-a-set mistake the register keeps recording, so the
  // check is a shared helper and this test is what proves both callers reach it.
  const evalSpec = {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "evalshape", project: "t", version: 1 },
    policy: { posture: "out" },
    channels: { seen: { type: "array", reduce: "append_ordered" } },
    inputs: [],
    outputs: ["seen"],
    nodes: [{ id: "e", type: "evaluator", writes: ["seen"], evaluator: { kind: "assertion", ref: "function/b@stable", threshold: 0.5 } }],
    edges: [],
  } as unknown as GraphSpec;

  const run = async (body: unknown) => {
    const functions = new FunctionRegistry();
    functions.register("function/b@stable", body as () => FunctionOutcome);
    const store = new MemoryStateStore({ now: () => NOW });
    const engine = new Engine({
      store,
      bus: new InProcessEventBus({ store }),
      tools: new ToolRegistry(),
      functions,
      models: new ModelRegistry(),
      now: () => NOW,
      sleep: async () => {},
      policy: { granted: [], systemFloor: "out" },
    });
    const graph = compileOrThrow({ spec: evalSpec, resolver: resolver(), tools: {}, tenantCapabilities: [] });
    return engine.advance(await engine.submit({ graph, inputs: {} }));
  };

  const bad = await run(() => ({ seen: ["x"] }));
  assert.equal(bad.error?.code, "E_RESOURCE_INVALID", JSON.stringify(bad.error ?? {}));
  assert.match(String(bad.error?.message), /every key of which is ignored/);

  // The positive control again: the arm must still run a correct body.
  const good = await run(() => ({ writes: { seen: ["x"] } }));
  assert.equal(good.status, "succeeded", JSON.stringify(good.error ?? {}));
  assert.deepEqual(good.channels["seen"], ["x"]);
});

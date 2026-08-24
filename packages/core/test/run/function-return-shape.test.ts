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

// ── retry: the only route from a sandboxed body to NodeSpec.retry ────────────

/** The same graph, with a retry policy on the one node. */
function retrySpec(node: "function" | "evaluator"): GraphSpec {
  const base = spec();
  return {
    ...base,
    nodes: [
      node === "function"
        ? { ...(base.nodes[0] as object), retry: { maxAttempts: 3, backoff: "fixed", initialMs: 1 } }
        : {
            id: "f",
            type: "evaluator",
            writes: ["seen"],
            evaluator: { kind: "assertion", ref: "function/b@stable", threshold: 0.5 },
            retry: { maxAttempts: 3, backoff: "fixed", initialMs: 1 },
          },
    ],
  } as unknown as GraphSpec;
}

/** Runs `body` on a node that declares `retry`, and reports what the journal saw. */
async function runRetrying(body: unknown, node: "function" | "evaluator" = "function") {
  const functions = new FunctionRegistry();
  functions.register("function/b@stable", body as () => FunctionOutcome);
  // AN ADVANCING CLOCK, and it is load-bearing rather than incidental. The fold turns
  // `task.retry_scheduled` into `retryAfter: e.ts + afterMs`, and `eligible()` skips a task while
  // `retryAfter > now` — so with the frozen `now: () => NOW` the rest of this file uses, a
  // backoff of ONE millisecond never elapses and the retry never runs. It cost a debugging round
  // to see: the first attempt looked like "the retry only fired once" rather than "the clock
  // never moved". Still no real time: the ticks are the test's, not the wall's.
  const clock = { t: NOW };
  const store = new MemoryStateStore({ now: () => clock.t });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now: () => clock.t,
    sleep: async () => {},
    policy: { granted: [], systemFloor: "out" },
  });
  const graph = compileOrThrow({ spec: retrySpec(node), resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: {} });
  let p = await engine.advance(runId);
  // The backoff is 1 ms and `sleep` is injected, so the scheduler is what gates the re-run:
  // advance until the run settles or the attempts are spent.
  for (let i = 0; i < 6 && p.status === "running"; i++) {
    clock.t += 1000;
    p = await engine.advance(runId);
  }
  const events = [];
  for await (const e of store.read(runId, 1)) events.push(e);
  return { p, scheduled: events.filter((e) => e.type === "task.retry_scheduled") };
}

test("A BODY CAN ASK TO BE RETRIED, and the node's retry policy actually schedules it", async () => {
  // README: "`retry` on a function or evaluator node — Inert. A body cannot raise a RETRYABLE
  // error." Every throw out of the `vm` normalizes to `internal`/`E_INTERNAL` — `isLoomError` is
  // an `instanceof` against the HOST class and a guest object can never satisfy it — so the only
  // classes that schedule a backoff (`exhausted`, `unavailable`, `timeout`) were unreachable.
  // A RETURN crosses through `intoHostRealm`, which rebuilds it structurally, so no getter of the
  // body's is ever consulted; the engine raises the retryable error on the body's behalf.
  let calls = 0;
  const { p, scheduled } = await runRetrying(() => {
    calls += 1;
    return calls < 3 ? { retry: { reason: "upstream still warming up" } } : { writes: { seen: ["ok"] } };
  });

  assert.equal(scheduled.length, 2, "two failures, two scheduled retries");
  assert.equal((scheduled[0]!.payload as { code: string }).code, "E_FUNCTION_UNAVAILABLE", "journaled under the body's own code");
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(p.channels["seen"], ["ok"], "and the third attempt's write is the one that lands");
  assert.equal(calls, 3);
});

test("THE REASON REACHES THE OPERATOR — a retry that runs out of attempts says why", async () => {
  const { p, scheduled } = await runRetrying(() => ({ retry: { reason: "upstream 503" } }));
  assert.equal(scheduled.length, 2, "maxAttempts 3 means two retries, then the failure stands");
  assert.equal(p.status, "failed");
  assert.equal(p.error?.code, "E_FUNCTION_UNAVAILABLE", JSON.stringify(p.error ?? {}));
  assert.match(String(p.error?.message), /upstream 503/, "the body's reason must survive into the run's error");
  assert.match(String(p.error?.message), /asked to be retried/);
});

test("A BODY WITH NO RETRY POLICY FAILS IMMEDIATELY — the body asked and the graph declined", async () => {
  // The negative control for the mechanism: `retry` on the RETURN does not create a retry
  // policy, it only becomes eligible for one. Without this, a change that made every
  // `E_FUNCTION_UNAVAILABLE` retry regardless of the graph would pass every test above.
  const p = await runWith(() => ({ retry: { reason: "please" } }));
  assert.equal(p.status, "failed");
  assert.equal(p.error?.code, "E_FUNCTION_UNAVAILABLE", JSON.stringify(p.error ?? {}));
});

test("AND THE EVALUATOR ARM RETRIES TOO — the second caller, tested rather than assumed", async () => {
  // Same graph shape, `type: "evaluator"`. This test exists because a mutation removing the call
  // from `#runEvaluator`'s assertion arm has twice left the whole suite green: `functions.require`
  // has two callers, and asking "who else calls this" has not been enough — the fix reached both
  // arms both times and the SUITE only ever drove one.
  let calls = 0;
  const { p, scheduled } = await runRetrying(() => {
    calls += 1;
    return calls < 2 ? { retry: { reason: "flaky judge" } } : { writes: { seen: ["ok"] }, confidence: 1 };
  }, "evaluator");
  assert.equal(scheduled.length, 1);
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(p.channels["seen"], ["ok"]);
});

test("`retry` IS EXCLUSIVE WITH `writes` AND `take` — refused, not silently picked", async () => {
  // A retry re-runs the body, so anything it also asked to commit would be proposed twice.
  // Refusing beats choosing, which is the rule the rest of this file is about.
  const both = await runWith(() => ({ retry: { reason: "x" }, writes: { seen: ["x"] } }));
  assert.equal(both.error?.code, "E_RESOURCE_INVALID", JSON.stringify(both.error ?? {}));
  assert.match(String(both.error?.message), /proposed twice/);

  const taking = await runWith(() => ({ retry: { reason: "x" }, take: [] }));
  assert.equal(taking.error?.code, "E_RESOURCE_INVALID");
});

test("`retry: true` IS REFUSED and the message names the shape that works", async () => {
  // The obvious thing to write, and not the contract. Accepting it would make `retry: 0` and
  // `retry: "maybe"` mean different things by accident.
  const p = await runWith(() => ({ retry: true }));
  assert.equal(p.status, "failed");
  assert.equal(p.error?.code, "E_RESOURCE_INVALID", JSON.stringify(p.error ?? {}));
  assert.match(String(p.error?.message), /retry is an object/);
  assert.match(String(p.error?.message), /reason/);
});

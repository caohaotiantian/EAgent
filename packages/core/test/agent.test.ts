/**
 * The one-line surface, and the claim it exists to make good on.
 *
 * `agent()` would be worth little if it were a second, simpler runtime — a shortcut that skips the
 * journal and the gates is exactly the shortcut people reach for and then regret. The whole point
 * is that it compiles to a one-node graph and runs on the same engine, so the tests below are less
 * about the convenience and more about what comes with it for free:
 *
 *   - an irreversible tool GATES, without the caller having written the word "oversight"
 *   - the run REPLAYS from its journal with no model call
 *
 * If either stops being true, the one-liner has become a second runtime and should be deleted
 * rather than fixed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { agent } from "../src/agent.ts";
import { MemoryStateStore } from "../src/journal/memory.ts";
import { MockModelAdapter, type ToolDefinition } from "../src/run/registry.ts";

const NOW = () => 1_700_000_000_000;

const answering = (text: string): MockModelAdapter =>
  new MockModelAdapter({ script: () => ({ text, finishReason: "stop" }) });

test("ONE LINE RUNS — a prompt, an adapter, an answer", async () => {
  const a = agent({ prompt: "You summarise things.", adapter: answering('{"summary":"it works"}'), now: NOW });
  const r = await a.run("summarise this");

  assert.equal(r.status, "succeeded", JSON.stringify(r.projection.error ?? {}));
  assert.equal(r.output, '{"summary":"it works"}');
  assert.ok(r.usage.costUsd > 0, "the run accounted for what it spent");
  assert.deepEqual(r.openGates, [], "nothing to ask a human about");
});

test("AN IRREVERSIBLE TOOL GATES, and the caller never said the word", async () => {
  // The value of compiling to a graph rather than running a loop. The caller declared a tool and
  // a prompt; the oversight floor came from what the tool IS.
  let charged = 0;
  const charge: ToolDefinition = {
    name: "pay.charge",
    version: "1.0",
    description: "Charge a card.",
    parameters: { type: "object" },
    irreversibility: "irreversible",
    idempotent: false,
    capabilities: ["pay:charge"],
    execute: () => {
      charged += 1;
      return { content: "charged" };
    },
  };

  const a = agent({
    prompt: "Charge the customer.",
    adapter: new MockModelAdapter({
      script: (_req, turn) =>
        turn === 0
          ? { toolCalls: [{ id: "c1", name: "pay.charge", arguments: {} }], finishReason: "tool_use" }
          : { text: '{"done":true}', finishReason: "stop" },
    }),
    tools: ["pay.charge"],
    toolDefs: [charge],
    granted: ["pay:charge"],
    now: NOW,
  });

  const r = await a.run("take the payment");

  assert.equal(r.status, "awaiting_gate", `expected a gate, got ${r.status}`);
  assert.equal(r.openGates.length, 1, "exactly one thing to decide");
  assert.equal(charged, 0, "THE CHARGE MUST NOT HAVE RUN — a gate before the action, not after it");
});

test("IT REPLAYS — the same journal, zero model calls, and the verdict says so", async () => {
  // Replay is what makes the journal worth keeping, and a one-liner that skipped it would be a
  // different product wearing the same name. Counting adapter calls, because "it replayed" and
  // "it quietly ran again and cost money" produce the same projection.
  let calls = 0;
  const counting = new MockModelAdapter({
    script: () => {
      calls += 1;
      return { text: '{"summary":"recorded"}', finishReason: "stop" as const };
    },
  });

  const store = new MemoryStateStore({ now: NOW });
  const a = agent({ prompt: "You summarise things.", adapter: counting, store, now: NOW });
  const first = await a.run("summarise this");
  assert.equal(first.status, "succeeded");
  assert.equal(calls, 1, "precondition: the live run made exactly one model call");

  const report = await a.replay(first.runId);

  assert.equal(calls, 1, "REPLAY CALLED THE MODEL — it must be served from the record, not re-run");
  assert.equal(report.match, true, JSON.stringify(report.frames?.filter((f) => !f.match) ?? []));
  assert.equal(report.hermetic, true, "nothing had to be re-derived outside the journal");
});

test("THE GRAPH IS THE AGENT — one node, and its hash is stable across builds", async () => {
  const build = () => agent({ prompt: "Same words.", adapter: answering("{}"), now: NOW });
  const a = build();
  const b = build();

  assert.equal(a.graph.spec.nodes.length, 1, "a one-liner is one node");
  assert.equal(a.graph.spec.nodes[0]?.type, "agent");
  assert.equal(a.graph.graphHash, b.graph.graphHash, "same inputs, same compiled identity");

  // A PROMPT EDIT CHANGES THE IDENTITY. The prompt is an input to a recorded effect, so a runtime
  // that let it change without changing the hash would let an edit silently alter a resumed run —
  // the failure mode Restate documents and Temporal's guidance misses, because in a workflow a
  // docstring is not an input and here it is.
  const c = agent({ prompt: "Different words.", adapter: answering("{}"), now: NOW });
  assert.notEqual(a.graph.graphHash, c.graph.graphHash, "editing the prompt must change what runs");
});

test("A TOOL THE DEPLOYMENT DID NOT GRANT IS REFUSED AT BUILD, not mid-run", async () => {
  // Eager assembly earns its keep here: the mistake surfaces before anything has been spent.
  const charge: ToolDefinition = {
    name: "pay.charge",
    version: "1.0",
    description: "Charge a card.",
    parameters: { type: "object" },
    irreversibility: "irreversible",
    idempotent: false,
    capabilities: ["pay:charge"],
    execute: () => ({ content: "charged" }),
  };

  assert.throws(
    () =>
      agent({
        prompt: "Charge the customer.",
        adapter: answering("{}"),
        tools: ["pay.charge"],
        toolDefs: [charge],
        granted: [], // the capability the tool needs is absent
        now: NOW,
      }),
    /GRAPH|capab/i,
    "a tool whose capability nobody granted must not compile",
  );
});

test("A BODY'S CLOCK IS JOURNALED — the same run replays to the same instant", async () => {
  // Invariant 4's last admitted gap. `ctx.now` was the engine's wall clock passed straight
  // through, so a body that read the time got a different answer on replay and nothing recorded
  // the difference. It is bound to `task.leased.ts` now — already in the journal, so replay folds
  // the same event and computes the same number with nothing new written.
  //
  // Driven through a `function` node rather than asserted on the helper, because the helper
  // could be correct while the wiring passed the wrong clock — which is what it did.
  const { compileOrThrow } = await import("../src/graph/compile.ts");
  const { InProcessEventBus } = await import("../src/bus.ts");
  const { Engine } = await import("../src/run/engine.ts");
  const { FunctionRegistry, ModelRegistry, ToolRegistry } = await import("../src/run/registry.ts");
  const { resolver } = await import("./run/skeleton.ts");

  const spec = {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "clock", project: "test", version: 1 },
    policy: { posture: "out", budget: { costUsd: 1 } },
    channels: { seed: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: ["seed"],
    outputs: ["out"],
    nodes: [{ id: "t", type: "function", reads: ["seed"], writes: ["out"], function: { ref: "function/clock@stable" } }],
    edges: [],
  };

  // A WALL CLOCK THAT MOVES ON EVERY READ. If the body's clock were this one, two reads inside
  // one body would differ and a replay would differ again — so this is the rig that can fail.
  let ticks = 0;
  const wall = (): number => 1_700_000_000_000 + ticks++ * 1_000;

  const store = new MemoryStateStore({ now: wall });
  const functions = new FunctionRegistry();
  functions.register("function/clock@stable", (_view, c) => ({ writes: { out: { a: c.now(), b: c.now() } } }));
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models,
    now: wall,
    maxParallelism: 1,
    policy: { granted: [], budget: { runUsd: 1 } },
  });

  const graph = compileOrThrow({ spec: spec as never, resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { seed: "go" } });
  const p = await engine.advance(runId);

  const out = p.channels["out"] as { a: number; b: number };
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.equal(out.a, out.b, "two reads inside one task must return the same instant");
  assert.ok(ticks > 2, "precondition: the injected wall clock really did advance during the run");

  // And it is a JOURNALED instant, not an arbitrary frozen one: it is the lease timestamp the
  // fold already carries, which is why replay reaches the same number without recording it.
  const leasedAt = Object.values(p.tasks).find((t) => String(t.taskId).startsWith("t@"))?.lease?.at;
  assert.equal(out.a, leasedAt, "the body's clock is the task's journaled lease time");
});

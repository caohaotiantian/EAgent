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

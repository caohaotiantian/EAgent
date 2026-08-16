/**
 * The strict doubles, and the defect they were built to find.
 *
 * The point of this file is one measurement: run a perfectly ordinary agent node through
 * the real `Engine` with the ordinary offline adapter swapped for a strict one, and see
 * what the engine was actually asking a provider to do. It asks for a model called
 * `agent_profile/summarizer@stable`.
 *
 * Every agent test in this repo is green over that, which is not a gap in those tests —
 * it is what a permissive double IS. `MockModelAdapter.stream` never reads `req.model`,
 * so no assertion anywhere in the suite could have been about it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { NodeId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ModelEvent } from "../../src/run/registry.ts";
import { resolver } from "../run/skeleton.ts";
import { StrictMockModelAdapter, strictToolStub } from "./strict-doubles.ts";

const REAL_MODEL = "claude-sonnet-5";

/** One agent node. No fan-out, no gate — the smallest graph that calls a model. */
function agentSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "one-agent", project: "t", version: 1 },
    policy: { posture: "out", budget: { costUsd: 1 } },
    channels: {
      question: { type: "string", reduce: "replace" },
      answer: { type: "object", reduce: "replace" },
    },
    inputs: ["question"],
    outputs: ["answer"],
    nodes: [
      {
        id: "ask" as NodeId,
        type: "agent",
        reads: ["question"],
        writes: ["answer"],
        agent: { profile: "agent_profile/summarizer@stable", prompt: "prompt/answer@stable", maxTurns: 2 },
        unhandled: true,
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

async function runAgentUnder(adapter: StrictMockModelAdapter): Promise<{ status: string; error: unknown }> {
  const store = new MemoryStateStore({ now: () => 1 });
  const models = new ModelRegistry();
  models.register(adapter, true);
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions: new FunctionRegistry(),
    models,
    now: () => 1,
    policy: { granted: ["*"], systemFloor: "out" },
  });
  const graph = compileOrThrow({ spec: agentSpec(), resolver: resolver(), tools: {}, tenantCapabilities: ["*"] });
  const runId = await engine.submit({ graph, inputs: { question: "what?" } });
  const p = await engine.advance(runId);
  return { status: p.status, error: p.error };
}

test("AN AGENT NODE UNDER THE STRICT DOUBLE FAILS, and the failure is H7", async () => {
  // THIS TEST ASSERTS A DEFECT, deliberately, and it is the cheapest true statement
  // available about the current engine: there is no code path anywhere that turns an
  // agent's `profile` into a model id, so the ref is what a provider gets.
  //
  // WHEN THAT PATH EXISTS this test is the one that must change — to assert the run
  // SUCCEEDS and that `seen[0].model` is a real id. It is written to fail loudly rather
  // than quietly start passing: `assert.equal(status, "failed")` reds the moment the
  // engine stops sending a ref, which is exactly when a human should look at it.
  const adapter = new StrictMockModelAdapter({
    models: [REAL_MODEL],
    script: () => ({ text: "{}", finishReason: "stop" }),
  });
  const r = await runAgentUnder(adapter);

  assert.equal(r.status, "failed", "an agent node cannot complete against an adapter that checks its own request");
  assert.equal(adapter.seen.length > 0, true, "precondition: the adapter was reached at all");
  assert.equal(
    adapter.seen[0]?.model,
    "agent_profile/summarizer@stable",
    "the engine sends the graph's ResourceRef where a model id belongs (`#runAgent`)",
  );
  assert.match(String((r.error as { message?: string })?.message ?? ""), /ResourceRef|not a model id/);
});

test("A WELL-FORMED REQUEST STREAMS — the double refuses a request, not every request", async () => {
  // Without this the test above proves only that the double throws, and "strict" and
  // "broken" would be indistinguishable.
  //
  // IT CANNOT BE DONE THROUGH THE ENGINE, and that absence is itself the measurement:
  // `engine.ts`'s `#runAgent` builds `model` from `agent.profile`, and `rule015Resources`
  // requires that profile to be a resolvable `kind/name@selector`; no code anywhere maps one to a
  // model id. So there is no graph, no configuration and no adapter option that makes an
  // agent node send a served model id — which is why gap #5's `--models-file` needs
  // `readModels`'s profile map before a real provider can complete one turn.
  const adapter = new StrictMockModelAdapter({ models: [REAL_MODEL], script: () => ({ text: "hello" }) });
  const events: ModelEvent[] = [];
  for await (const ev of adapter.stream(
    { model: REAL_MODEL, system: "be brief", messages: [{ role: "user", content: "hi" }], tools: [] },
    new AbortController().signal,
  )) {
    events.push(ev);
  }
  assert.equal(events.at(-1)?.type, "done");
  assert.equal(events.filter((e) => e.type === "text_delta").length > 0, true, "the scripted turn still streams");
});

test("an unresolved ref in the PROMPT is refused too — a provider would answer it instead", async () => {
  const adapter = new StrictMockModelAdapter({ models: [REAL_MODEL], script: () => ({ text: "ok" }) });
  await assert.rejects(
    async () => {
      for await (const _ of adapter.stream(
        { model: REAL_MODEL, system: "You are prompt/answer@stable.", messages: [], tools: [] },
        new AbortController().signal,
      )) {
        void _;
      }
    },
    (e: unknown) => (e as { code: string }).code === "E_PROVIDER_BAD_REQUEST" && /reached the prompt/.test((e as Error).message),
  );
});

test("an unknown model id is refused with the set the adapter serves", async () => {
  const adapter = new StrictMockModelAdapter({ models: [REAL_MODEL], script: () => ({ text: "ok" }) });
  await assert.rejects(
    async () => {
      for await (const _ of adapter.stream(
        { model: "gpt-5", system: "", messages: [], tools: [] },
        new AbortController().signal,
      )) {
        void _;
      }
    },
    (e: unknown) => /no model "gpt-5"/.test((e as Error).message) && new RegExp(REAL_MODEL).test((e as Error).message),
  );
});

test("the strict tool stub records the BRANCH each call came from, and refuses an id it cannot parse", async () => {
  const stub = strictToolStub({ name: "probe.ping" });
  const signal = new AbortController().signal;
  await stub.execute({ x: 1 }, { taskId: "n@root/fo[2]#0" as never, signal, progress: () => {} });
  assert.deepEqual(
    stub.calls.map((c) => c.branch),
    ["root/fo[2]"],
  );
  assert.throws(
    () => stub.execute({}, { taskId: "not-a-task-id" as never, signal, progress: () => {} }),
    /malformed task id/,
    "a TaskId is DERIVED (invariant 3); a stub that shrugs at a bad one is how a random id survives a suite",
  );
});

/**
 * A refusal that will never succeed is not retried.
 *
 * `#runToolNode` collapsed every `isError` tool result into
 * `err.unavailable(E_TOOL_SOURCE_UNAVAILABLE, …)` — class `unavailable`, therefore RETRYABLE. But
 * the results it collapses are a mix: a genuine failure to reach a source, and the engine's OWN
 * refusals — an argument that does not fit the schema, a tool nobody registered, a policy denial.
 * None of the second kind gets better on a second attempt.
 *
 * Found by USING the thing. Writing a report-to-file graph, `${report}` is an object and `fs.write`
 * wants a string; the run failed with `retryable: true`, and a node carrying an ordinary
 * `retry: {maxAttempts: 3}` re-sent it twice with the tool never executing once.
 *
 * This is the provider defect one subsystem over, and the corpus already records that one: every
 * 4xx except a handful was classed `unavailable`, so a permanent misconfiguration was re-sent to
 * the attempt cap. Same shape, same fix — carry the class instead of flattening it to a string.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { CODES } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const NOW = () => 1_700_000_000_000;

const SPEC = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "refusal-class", project: "test", version: 1 },
  policy: { posture: "out", budget: { costUsd: 1 } },
  channels: { obj: { type: "object", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
  inputs: ["obj"],
  outputs: ["out"],
  nodes: [
    {
      id: "n",
      type: "tool",
      reads: ["obj"],
      writes: ["out"],
      retry: { maxAttempts: 3, backoff: "fixed", initialMs: 0 },
      tool: { name: "t.strict", version: "1.0", args: { body: "${obj}" } },
      unhandled: true,
    },
  ],
  edges: [],
} as never;

function rig(execute: () => { content: string; isError?: boolean }, parameters?: unknown) {
  const store = new MemoryStateStore({ now: NOW });
  const tools = new ToolRegistry();
  tools.register({
    name: "t.strict",
    version: "1.0",
    description: "Wants a string.",
    parameters: (parameters ?? { type: "object", properties: { body: { type: "string" } }, required: ["body"] }) as never,
    irreversibility: "read_only",
    idempotent: true,
    capabilities: [],
    execute,
  });
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models,
    now: NOW,
    sleep: async () => {},
    maxParallelism: 1,
    policy: { granted: [], budget: { runUsd: 1 } },
  });
  const compile = (spec: unknown) =>
    compileOrThrow({
      spec: spec as never,
      resolver: resolver(),
      tools: { "t.strict": { irreversibility: "read_only", capabilities: [] } } as never,
      tenantCapabilities: [],
    });
  return { store, engine, compile };
}

async function drain(engine: Engine, runId: never) {
  let p = await engine.advance(runId).catch(() => undefined);
  for (let i = 0; i < 4 && p?.status === "running"; i += 1) p = await engine.advance(runId).catch(() => undefined);
  return p;
}

test("AN ARGUMENT THAT CANNOT VALIDATE IS NOT RE-SENT", async () => {
  let executions = 0;
  const r = rig(() => {
    executions += 1;
    return { content: "ok" };
  });
  const runId = await r.engine.submit({ graph: r.compile(SPEC), inputs: { obj: { a: 1 } } });
  const p = await drain(r.engine, runId as never);

  const retries: string[] = [];
  for await (const ev of r.store.read(runId, 1)) {
    if (ev.type === "task.retry_scheduled") retries.push(String((ev.payload as { code?: unknown }).code));
  }

  assert.equal(executions, 0, "precondition: the tool never ran — this is a refusal, not an outage");
  assert.deepEqual(retries, [], `a permanently invalid argument was re-sent: ${retries.join(", ")}`);
  assert.equal(p?.status, "failed");
  assert.equal(p?.error?.code, CODES.E_TOOL_SCHEMA_INVALID, `got ${String(p?.error?.code)}`);
  assert.equal(p?.error?.retryable, false, "the caller's arguments will not change on a retry");
});

test("a GENUINE tool failure keeps its retry — the default must not have moved", async () => {
  // The control. A fix that made every tool failure permanent would remove retry from the layer it
  // exists for, and `isError` with no typed reason is still what a tool author writes when their
  // source is briefly unreachable.
  let executions = 0;
  // A schema that accepts anything, so the refusal under test is the TOOL's and not the
  // validator's — the first version of this control asked a required-field schema for nothing and
  // never reached `execute` at all.
  const r = rig(
    () => {
      executions += 1;
      return { content: "upstream is down", isError: true };
    },
    { type: "object" },
  );
  const loose = JSON.parse(JSON.stringify(SPEC)) as { nodes: { tool: { args: Record<string, unknown> } }[] };
  loose.nodes[0]!.tool.args = {};
  const runId = await r.engine.submit({ graph: r.compile(loose), inputs: { obj: { a: 1 } } });
  await drain(r.engine, runId as never);

  assert.ok(executions >= 2, `a transient failure must still be retried; it ran ${String(executions)} time(s)`);
});

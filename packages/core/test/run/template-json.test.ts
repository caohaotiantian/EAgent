/**
 * `${x | json}` — the one thing a template could not say.
 *
 * A lone `${x}` yields the VALUE, so an object stays an object. That is deliberate and right: a
 * tool whose schema wants an object must receive one, and stringifying everything would break it.
 * The consequence had no expression. Writing a structured channel to a FILE needs text, `fs.write`
 * refuses an object, and the only workaround was an accident of the embedded branch — appending a
 * space to the template so it stopped matching the whole-string regex.
 *
 * Measured while authoring a report-writing graph before this existed: serialising one value cost
 * an extra `function` node and an extra published resource, both of whose entire content was
 * `JSON.stringify`. That is a node in the run's trajectory, a task in its journal, and a file in
 * the workspace, to express something the template language nearly already had.
 *
 * THE SECOND TEST IS THE LOAD-BEARING ONE. A fix that stringified more eagerly would pass the
 * first and silently break every tool taking a structured argument — the failure would surface as
 * a schema rejection deep in a provider, not here.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const NOW = () => 1_700_000_000_000;

/** `make` writes an object into `doc`; `sink` passes it to a tool through `args`. */
const spec = (arg: unknown, wants: "string" | "object") =>
  ({
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "tpl", project: "test", version: 1 },
    policy: { posture: "out", budget: { costUsd: 1 }, capabilities: ["sink:take"] },
    channels: {
      seed: { type: "string", reduce: "replace" },
      doc: { type: "object", reduce: "replace" },
      done: { type: "object", reduce: "replace" },
    },
    inputs: ["seed"],
    outputs: ["done"],
    nodes: [
      { id: "make", type: "function", reads: ["seed"], writes: ["doc"], function: { ref: "function/mk@stable" } },
      {
        id: "sink",
        type: "tool",
        reads: ["doc"],
        writes: ["done"],
        tool: { name: `sink.${wants}`, version: "1.0", args: { body: arg } },
      },
    ],
    edges: [{ id: "e", from: "make", to: "sink", kind: "seq" }],
  }) as never;

function rig(seen: unknown[]) {
  const def = (wants: "string" | "object"): ToolDefinition => ({
    name: `sink.${wants}`,
    version: "1.0",
    description: "Take a body.",
    parameters: { type: "object", properties: { body: { type: wants } }, required: ["body"] },
    irreversibility: "read_only",
    idempotent: true,
    capabilities: ["sink:take"],
    execute: (a) => {
      seen.push((a as { body?: unknown }).body);
      return { content: "ok", writes: { done: { ok: true } } };
    },
  });
  const tools = new ToolRegistry();
  tools.register(def("string"));
  tools.register(def("object"));
  const functions = new FunctionRegistry();
  functions.register("function/mk@stable", (v) => ({ writes: { doc: { title: v.get("seed"), items: [1, 2] } } }));
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);

  const engine = new Engine({
    store: new MemoryStateStore({ now: NOW }),
    bus: new InProcessEventBus({ store: new MemoryStateStore({ now: NOW }) }),
    tools,
    functions,
    models,
    now: NOW,
    sleep: async () => {},
    maxParallelism: 1,
    policy: { granted: ["sink:take"], budget: { runUsd: 1 } },
  });
  const run = async (arg: unknown, wants: "string" | "object") => {
    const graph = compileOrThrow({
      spec: spec(arg, wants),
      resolver: resolver(),
      tools: {
        "sink.string": { irreversibility: "read_only", capabilities: ["sink:take"] },
        "sink.object": { irreversibility: "read_only", capabilities: ["sink:take"] },
      } as never,
      tenantCapabilities: ["sink:take"],
    });
    const runId = await engine.submit({ graph, inputs: { seed: "hello" } });
    return engine.advance(runId);
  };
  return { run };
}

test("`| json` SERIALISES, so a structured channel can reach a tool that wants text", async () => {
  const seen: unknown[] = [];
  const p = await rig(seen).run("${doc | json}", "string");

  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.equal(typeof seen[0], "string", "an object reached a string parameter — the tool would refuse it");
  assert.deepEqual(JSON.parse(seen[0] as string), { title: "hello", items: [1, 2] }, "and it round-trips");
});

test("A LONE `${x}` STILL YIELDS THE OBJECT — the filter is opt-in, not a new default", async () => {
  // The regression this fix could plausibly cause. If `${doc}` began stringifying, every tool
  // taking a structured argument would start receiving text, and the failure would land inside a
  // provider's schema check rather than here.
  const seen: unknown[] = [];
  const p = await rig(seen).run("${doc}", "object");

  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(seen[0], { title: "hello", items: [1, 2] }, "the value must arrive unchanged");
});

test("WITHOUT THE FILTER the run fails, and the message is the honest one", async () => {
  // The reproduction, and it sets the size of this change. Argument validation already refuses
  // the object BEFORE `execute` — non-retryable, `validation` class, naming the field. So the
  // filter removes a required workaround; it does not fix a wrong answer that was reaching a tool.
  // Worth stating plainly, because "the object silently reached the tool" would have been a much
  // larger claim and this test is what distinguishes them.
  const seen: unknown[] = [];
  const p = await rig(seen).run("${doc}", "string");

  assert.equal(p.status, "failed", "if this now succeeds, the whole-form branch changed meaning");
  assert.equal(p.error?.code, "E_TOOL_SCHEMA_INVALID");
  assert.match(p.error?.message ?? "", /body must be a string/);
  assert.deepEqual(seen, [], "validation runs before execute, so nothing reached the tool");
});

test("`| json` on a value that is ALREADY text does not double-encode it", async () => {
  // `JSON.stringify("hi")` is `"\"hi\""`. A file written through that gains a pair of quotes and
  // an author debugging it has no reason to suspect the template.
  const seen: unknown[] = [];
  const p = await rig(seen).run("${seed | json}", "string");

  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.equal(seen[0], "hello", "a string passed through `| json` must stay itself");
});

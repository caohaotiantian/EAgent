/**
 * `EdgeSpec.codes` HAD NO READER, so every error edge was a catch-all whatever it declared.
 *
 * The asymmetry is what makes this a trap rather than a gap. `RetryPolicy.onlyIf` IS read —
 * `policy.onlyIf.includes(error.code)` in `#retryDecision` — so an author who learned that
 * code-filtering works for retry reasonably assumes it works for error edges, declares
 * `codes: ["E_PROVIDER_UNAVAILABLE"]` on a compensating edge, and silently gets that edge for a
 * validation failure too. A field that is declared, compiled, and read by nothing looks exactly
 * like a field that works.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const NOW = 1_700_000_000_000;

/** `boom` always fails with the code the test chose; `handler` records that it ran. */
function rig(code: string): { engine: Engine; handled: string[] } {
  const handled: string[] = [];
  const tools = new ToolRegistry();
  tools.register({
    name: "boom",
    version: "1.0",
    description: "always fails",
    capabilities: [],
    irreversibility: "read_only",
    idempotent: true,
    parameters: { type: "object" },
    execute: () => {
      throw Object.assign(new Error("boom"), { code, class: "unavailable", retryable: false });
    },
  } as ToolDefinition);
  tools.register({
    name: "handler",
    version: "1.0",
    description: "the declared handler",
    capabilities: [],
    irreversibility: "read_only",
    idempotent: true,
    parameters: { type: "object" },
    execute: () => {
      handled.push("ran");
      return { content: "handled", writes: { out: { handled: true } } };
    },
  } as ToolDefinition);
  const store = new MemoryStateStore({ now: () => NOW });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 1 } },
  });
  return { engine, handled };
}

/** `boom` --error(codes?)--> `handler`. */
function spec(codes?: readonly string[]): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "codes", project: "err", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { note: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: ["note"],
    outputs: ["out"],
    nodes: [
      { id: "boom", type: "tool", reads: ["note"], writes: [], tool: { name: "boom", version: "1.0" } },
      { id: "handler", type: "tool", reads: ["note"], writes: ["out"], tool: { name: "handler", version: "1.0" }, unhandled: true },
    ],
    edges: [{ id: "e1", from: "boom", to: "handler", kind: "error", ...(codes === undefined ? {} : { codes }) }],
  } as unknown as GraphSpec;
}

async function run(code: string, codes?: readonly string[]): Promise<string[]> {
  const r = rig(code);
  const graph = compileOrThrow({ spec: spec(codes), resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await r.engine.submit({ graph, inputs: { note: "x" } });
  for (let i = 0; i < 4; i++) {
    const p = await r.engine.advance(runId);
    if (p.status === "succeeded" || p.status === "failed") break;
  }
  return r.handled;
}

/**
 * THE CODE AN EDGE DECLARES IS THE NORMALIZED ONE, not the one the tool threw.
 *
 * `#invokeTool` maps a tool's own failure onto the taxonomy — a thrown
 * `{code: "E_PROVIDER_UNAVAILABLE"}` reaches the journal as `E_TOOL_SOURCE_UNAVAILABLE` — and
 * this filter reads what `task.failed` records. Measured, because the first version of this test
 * asserted the raw code and failed: an author reads the code off `loom trace`, so matching what
 * the journal shows is the behaviour that will not surprise them.
 */
const NORMALIZED = "E_TOOL_SOURCE_UNAVAILABLE";

/**
 * A REAL code that this failure does not carry — not an invented one.
 *
 * These fixtures used `OTHER_REAL_CODE`, which conflated two different things: a code that
 * does not MATCH, and a code that does not EXIST. `GRAPH003_UNKNOWN_ERROR_CODE` now refuses the
 * second at compile, because a code no error carries would never match and is therefore always
 * a typo — so the placeholder stopped compiling and the distinction had to be made. The
 * stronger fixture is the one an author actually hits: a real code, correctly spelled, that is
 * simply not the one this failure raised.
 */
const OTHER_REAL_CODE = "E_BUDGET_EXHAUSTED";

test("AN ERROR EDGE DECLARING CODES HANDLES ONLY THOSE CODES", async () => {
  assert.deepEqual(await run("E_PROVIDER_UNAVAILABLE", [NORMALIZED]), ["ran"], "the declared code is handled");
  assert.deepEqual(
    await run("E_PROVIDER_UNAVAILABLE", [OTHER_REAL_CODE]),
    [],
    "and a code it did NOT declare must not reach the handler",
  );
});

test("AN EDGE WITH NO `codes` IS STILL A CATCH-ALL", async () => {
  // The default must not have moved: a graph that declares no filter still handles everything,
  // or every existing error edge changes meaning at once.
  assert.deepEqual(await run("E_VALIDATION"), ["ran"]);
  assert.deepEqual(await run("E_PROVIDER_UNAVAILABLE"), ["ran"]);
});

test("ONE OF SEVERAL DECLARED CODES IS ENOUGH", async () => {
  assert.deepEqual(await run("E_PROVIDER_UNAVAILABLE", [OTHER_REAL_CODE, NORMALIZED]), ["ran"]);
});

/**
 * A node writes the channels it declared, and no others.
 *
 * `node.writes` is a DECLARATION, and the compiler spends real effort on it: GRAPH010
 * refuses two concurrent writers to a non-commutative channel, the posture floor is
 * computed from what a node can reach, and `dataClassification` is derived from the union
 * of a node's reads and writes. Every one of those verdicts is about the declared set.
 *
 * `#assignWrites` passed `explicit` through unfiltered:
 *
 *     if (explicit !== undefined) {
 *       for (const [k, v] of Object.entries(explicit)) if (k !== "_") out[k] = v;
 *       return out;
 *     }
 *
 * So a `function` node declaring `writes: ["mine"]` could return `{writes: {secret: …}}`
 * and the value landed in `secret`. That does not merely break an expectation — it makes
 * every GRAPH010 verdict UNEARNED, because the analysis that proved two writers could not
 * race was performed over a set the runtime does not enforce.
 *
 * The asymmetry is the tell: `mapToolWrites` already filtered a TOOL node's writes against
 * `node.writes`. Tools were confined; functions and evaluators were not.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { NodeId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;

/** One node declaring exactly one write channel, beside a channel it never declared. */
function spec(kind: "function" | "evaluator"): GraphSpec {
  const node: Record<string, unknown> = {
    id: n("act"),
    type: kind,
    reads: ["seed"],
    writes: ["mine"],
  };
  if (kind === "function") node["function"] = { ref: "function/act@stable" };
  else node["evaluator"] = { ref: "function/act@stable", threshold: 0 };

  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "write-confinement", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: {
      seed: { type: "string", reduce: "replace" },
      mine: { type: "string", reduce: "replace" },
      // Declared on the GRAPH so it is a real channel, and declared by NO node's `writes`.
      secret: { type: "string", reduce: "replace" },
    },
    inputs: ["seed"],
    outputs: ["mine"],
    nodes: [node],
    edges: [],
  } as unknown as GraphSpec;
}

async function run(kind: "function" | "evaluator", writes: Record<string, unknown>) {
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const functions = new FunctionRegistry();
  functions.register("function/act@stable", () => ({ writes }));

  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models,
    now,
    maxParallelism: 2,
    policy: { granted: [], budget: { runUsd: 1 } },
  });

  const graph = compileOrThrow({ spec: spec(kind), resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { seed: "go" } });
  const p = await engine.advance(runId).catch(() => engine.projection(runId));
  return { status: p?.status ?? "unknown", channels: p?.channels ?? {} };
}

test("A FUNCTION NODE CANNOT WRITE A CHANNEL IT DID NOT DECLARE", async () => {
  const r = await run("function", { mine: "ok", secret: "EXFILTRATED" });
  assert.notEqual(
    (r.channels as Record<string, unknown>)["secret"],
    "EXFILTRATED",
    "a node declaring writes:[\"mine\"] wrote `secret` — every GRAPH010 verdict is computed over the declared set, so this makes them unearned",
  );
});

test("AN EVALUATOR NODE CANNOT EITHER — the same hole, the second door", async () => {
  const r = await run("evaluator", { mine: "ok", secret: "EXFILTRATED" });
  assert.notEqual((r.channels as Record<string, unknown>)["secret"], "EXFILTRATED");
});

test("the declared channel still gets its value — confinement is not a ban on writing", async () => {
  const r = await run("function", { mine: "ok" });
  assert.equal(r.status, "succeeded");
  assert.equal((r.channels as Record<string, unknown>)["mine"], "ok");
});

test("AN UNDECLARED WRITE IS REFUSED LOUDLY, not dropped silently", async () => {
  // Dropping would leave a function that believes it wrote and a journal that disagrees —
  // the same class of silent divergence the branch-clobber fix closed. A `function` body is
  // trusted, reviewed, pinned code (A13), so an undeclared write is a bug in the graph or
  // the function, and saying so is more useful than quietly discarding it.
  const r = await run("function", { mine: "ok", secret: "EXFILTRATED" });
  assert.notEqual(r.status, "succeeded", "the run must not report success on a contract violation");
});

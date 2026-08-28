/**
 * A NODE MAY ONLY ROUTE ALONG ITS OWN EDGES — the human gate depended on it and nothing enforced it.
 *
 * `#activate` looks an edge id up in the WHOLE graph's edge table, so a `take` naming an edge that
 * belongs to another node activated that node's target and jumped everything in between.
 * Reproduced through the shipped binary on a graph that compiled `ok`: a router case
 * `{"when":"true","take":["e2"]}`, where `e2` is the human gate's OUTBOUND edge, ran the guarded
 * `fs.write` with no gate raised — `"status": "succeeded"`, exit 0, `jumped.txt` on disk. A
 * `function` body returning `{take: ["e2"]}` — a resource file, not even the graph — did the same,
 * and `loom trace` reported `conformance: ok` for both.
 *
 * THE CHECK ALREADY EXISTED FOR ONE OF THE THREE PRODUCERS. `#applyGateDecision` validates a
 * human's `redirect` against the node's outbound edges and raises `E_ROUTE_INVALID`; its comment
 * describes this exact bug. The router and function producers never got it — which is why the
 * runtime half now lives at `#edgesToTake`, where every producer's `take` converges. A check
 * written per-producer is a check the next producer forgets, and that is what happened.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import { compile, compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const NOW = 1_700_000_000_000;

/**
 * gate → write, with a `pick` node in front. `takes` is what `pick` names.
 *
 * `e2` leaves the GATE, not `pick`. Naming it is the bypass.
 */
function spec(pick: "router" | "function", takes: string): GraphSpec {
  const front =
    pick === "router"
      ? { id: "pick", type: "router", reads: ["note"], writes: [], router: { mode: "expression", cases: [{ when: "true", take: [takes] }], fallbackEdge: "e1" } }
      : { id: "pick", type: "function", reads: ["note"], writes: [], function: { ref: "function/jump@stable" } };
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "jump", project: "route", version: 1 },
    policy: { posture: "on", capabilities: ["fs:write"], expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { note: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: ["note"],
    outputs: ["out"],
    nodes: [
      front,
      { id: "approve", type: "human_gate", reads: ["note"], writes: [], humanGate: { ref: "oversight/g@stable", approval: { approvers: ["u:alice"] } } },
      { id: "write", type: "tool", reads: ["note"], writes: ["out"], tool: { name: "demo.write", version: "1.0", args: {} } },
    ],
    edges: [
      { id: "e1", from: "pick", to: "approve", kind: "seq" },
      { id: "e2", from: "approve", to: "write", kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

function rig(takes: string): { engine: Engine; wrote: string[] } {
  const wrote: string[] = [];
  const tools = new ToolRegistry();
  const write: ToolDefinition = {
    name: "demo.write",
    version: "1.0",
    description: "The guarded action.",
    capabilities: ["fs:write"],
    irreversibility: "reversible_write",
    idempotent: false,
    parameters: { type: "object", properties: {} },
    execute: () => {
      wrote.push("ran");
      return { content: "ok", writes: { out: { ran: true } } };
    },
  };
  tools.register(write);
  const functions = new FunctionRegistry();
  // The FUNCTION producer: a body naming an edge that is not its node's.
  functions.register("function/jump@stable", () => ({ writes: {}, take: [takes] }) as never);
  const store = new MemoryStateStore({ now: () => NOW });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions,
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: ["fs:write"], systemFloor: "out", budget: { runUsd: 1 } },
  });
  return { engine, wrote };
}

test("THE COMPILER REFUSES A ROUTER THAT NAMES ANOTHER NODE'S EDGE", () => {
  const r = compile({ spec: spec("router", "e2"), resolver: resolver(), tools: {}, tenantCapabilities: ["fs:write"] });
  assert.equal(r.ok, false, "a graph that can jump a gate must not compile");
  assert.ok(
    (r.diagnostics ?? []).some((x) => x.code === "GRAPH005_ROUTE_NOT_OWN_EDGE"),
    (r.diagnostics ?? []).map((x) => x.code).join(", "),
  );
});

test("AND ITS OWN EDGE STILL COMPILES — the refusal is about ownership, not about routers", () => {
  const r = compile({ spec: spec("router", "e1"), resolver: resolver(), tools: {}, tenantCapabilities: ["fs:write"] });
  assert.equal(r.ok, true, (r.diagnostics ?? []).map((x) => `${x.code}: ${x.message}`).join("; "));
});

test("A FUNCTION BODY CANNOT JUMP THE GATE EITHER — the compiler cannot see into one", async () => {
  // THE HALF THE COMPILE-TIME RULE CANNOT COVER. A `function` node's `take` comes from a RESOURCE
  // FILE, so no static check can see it; the runtime refusal at `#edgesToTake` is what holds here,
  // and it is the reason that check lives at the shared choke point rather than in `#runRouter`.
  const r = rig("e2");
  const graph = compileOrThrow({ spec: spec("function", "e2"), resolver: resolver(), tools: {}, tenantCapabilities: ["fs:write"] });
  const runId = await r.engine.submit({ graph, inputs: { note: "n" } });
  const p = await r.engine.advance(runId);

  assert.notEqual(p.status, "succeeded", `the run must not sail past the gate: ${p.status}`);
  assert.deepEqual(r.wrote, [], "and the guarded action must not have run");
  const failed = Object.values(p.tasks).filter((t) => t.state === "failed");
  assert.equal(failed[0]?.error?.code, CODES.E_ROUTE_INVALID, JSON.stringify(failed[0]?.error));
});

test("A FUNCTION BODY ROUTING ALONG ITS OWN EDGE REACHES THE GATE, as it should", async () => {
  // The control: the refusal must not have broken ordinary routing. `e1` IS `pick`'s edge, so the
  // run proceeds to the gate and stops there — which is the behaviour the bypass defeated.
  const r = rig("e1");
  const graph = compileOrThrow({ spec: spec("function", "e1"), resolver: resolver(), tools: {}, tenantCapabilities: ["fs:write"] });
  const runId = await r.engine.submit({ graph, inputs: { note: "n" } });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "awaiting_gate", `it must reach the human: ${JSON.stringify(p.error ?? {})}`);
  assert.deepEqual(r.wrote, [], "and the guarded action waits behind the gate");
  void isLoomError;
});

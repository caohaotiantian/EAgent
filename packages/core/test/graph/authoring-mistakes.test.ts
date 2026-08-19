/**
 * THE COMPILER DIAGNOSES; IT DOES NOT CRASH, AND IT DOES NOT WAVE THROUGH WHAT CANNOT RUN.
 *
 * Measured through the shipped binary: six ordinary authoring mistakes came back as
 * `E_INTERNAL: TypeError: …`, and three graphs compiled `ok` and provably could not run. Both
 * halves defeat the point of having a compile stage — one tells an author nothing about their
 * graph, the other tells them something false.
 *
 * The worst of them: a tool-name typo compiled clean, and the run then RAISED A GATE before
 * failing. A human was asked to authorize a tool that does not exist.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { compile } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { resolver } from "../run/skeleton.ts";

const TOOLS = {
  "fs.read": { name: "fs.read", version: "1.0", capabilities: ["fs:read"], irreversibility: "read_only" as const, idempotent: true },
  "fs.write": { name: "fs.write", version: "1.0", capabilities: ["fs:write"], irreversibility: "reversible_write" as const, idempotent: false },
};

/** A graph that compiles, so each case below differs from it by exactly one mistake. */
function base(): Record<string, unknown> {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "t", project: "d", version: 1 },
    policy: { posture: "out", capabilities: ["fs:read"], expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { a: { type: "string", reduce: "replace" } },
    inputs: ["a"],
    outputs: ["a"],
    nodes: [{ id: "n", type: "tool", reads: ["a"], writes: ["a"], tool: { name: "fs.read", version: "1.0", args: { path: "x" } } }],
    edges: [],
  };
}

function diagnose(mutate: (d: Record<string, unknown>) => void): { codes: string[]; ok: boolean } {
  const spec = base();
  mutate(spec);
  // `compile`, not `compileOrThrow`: what is under test is the DIAGNOSTIC, and a throw would
  // hide whether the message is one an author can act on.
  const r = compile({ spec: spec as unknown as GraphSpec, resolver: resolver(), tools: TOOLS, tenantCapabilities: ["fs:read"] });
  const codes = (r.diagnostics ?? []).map((x) => x.code);
  return { codes, ok: r.ok };
}

test("THE BASE GRAPH COMPILES — so every case below differs by exactly one mistake", () => {
  const r = diagnose(() => {});
  assert.equal(r.ok, true, `the base must compile: ${r.codes.join(", ")}`);
});

test("A MISSING REQUIRED FIELD IS A DIAGNOSTIC, not a TypeError from parseRef", () => {
  // `REQUIRED_BLOCK` proved a node HAS an `agent:`; nothing proved that `agent:` had a
  // `profile`. So `agent: {}` reached `parseRef(undefined)` and returned
  // `E_INTERNAL: TypeError: Cannot read properties of undefined (reading 'lastIndexOf')`.
  const cases: readonly (readonly [string, Record<string, unknown>])[] = [
    ["agent", { id: "n", type: "agent", reads: ["a"], writes: ["a"], agent: {} }],
    ["human_gate", { id: "n", type: "human_gate", reads: ["a"], writes: ["a"], humanGate: {} }],
    ["function", { id: "n", type: "function", reads: ["a"], writes: ["a"], function: {} }],
    ["subgraph", { id: "n", type: "subgraph", reads: ["a"], writes: ["a"], subgraph: {} }],
    ["evaluator", { id: "n", type: "evaluator", reads: ["a"], writes: ["a"], evaluator: {} }],
  ];
  for (const [label, node] of cases) {
    const r = diagnose((d) => {
      d["nodes"] = [node];
    });
    assert.equal(r.ok, false, `${label} with an empty block must not compile`);
    assert.ok(r.codes.includes("GRAPH020_MISSING_FIELD"), `${label}: expected GRAPH020_MISSING_FIELD, got ${r.codes.join(", ")}`);
  }
});

test("A MALFORMED TOP LEVEL IS A DIAGNOSTIC, not `spec.inputs is not iterable`", () => {
  // And `metadata` missing compiled CLEAN, then failed the RUN on `Cannot read properties of
  // undefined (reading 'name')` — a graph the compiler passed and the engine could not start.
  for (const field of ["inputs", "outputs", "nodes", "edges", "metadata", "channels"]) {
    const r = diagnose((d) => {
      delete d[field];
    });
    assert.equal(r.ok, false, `a graph with no \`${field}\` must not compile`);
    assert.ok(r.codes.includes("GRAPH003_MALFORMED"), `${field}: expected GRAPH003_MALFORMED, got ${r.codes.join(", ")}`);
  }
});

test("A REDUCER THE STATE LAYER DOES NOT KNOW IS REFUSED — it used to drop every write", () => {
  // `step()` has no default arm, so an unknown reducer SILENTLY DROPPED every write to that
  // channel and the run died `E_OUTPUT_MISSING: run finished without writing any of its declared
  // outputs` — pointing at the output rather than at the typo three lines above it.
  const r = diagnose((d) => {
    (d["channels"] as Record<string, Record<string, unknown>>)["a"]!["reduce"] = "last_write_wins";
  });
  assert.equal(r.ok, false);
  assert.ok(r.codes.includes("GRAPH003_UNKNOWN_REDUCER"), r.codes.join(", "));
});

test("A TOOL THIS PROCESS DOES NOT HAVE IS FLAGGED — a human was being asked to authorize one", () => {
  // `fs.raed` compiled `ok`. The run reached the node, RAISED A GATE, and failed
  // `E_TOOL_NOT_FOUND` only after the approval. Asking a person to vouch for something nobody
  // can name is worse than failing.
  //
  // A WARNING, not an error, and the distinction is deliberate: the `tools` map is what THIS
  // process registered, and a graph is legitimately compiled against a partial map — `loom
  // compile` without `--allow-exec` sees no `proc.exec`, which must stay a CAPABILITY diagnostic
  // rather than a spurious "no such tool".
  const r = diagnose((d) => {
    ((d["nodes"] as Record<string, Record<string, unknown>>[])[0]!["tool"] as Record<string, unknown>)["name"] = "fs.raed";
  });
  assert.ok(r.codes.includes("GRAPH013_UNKNOWN_TOOL"), r.codes.join(", "));
  assert.equal(r.ok, true, "a partial tool map must not make a graph unbuildable");
});

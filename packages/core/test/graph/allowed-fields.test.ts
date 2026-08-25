/**
 * A node block may not carry a field the compiler cannot interpret.
 *
 * There was no unknown-field check anywhere, for any node type. `evaluator: {kind, ref,
 * threshold, effects: [...]}` compiled clean, warned nothing, and decided nothing — so an author
 * who had just read `FunctionNode.effects` believed they had declared a capability ceiling and
 * had not. This repository has named that failure four times under other names, and this instance
 * is worse than those: they are declared-and-inert, this one is declared, inert and PERMISSIVE.
 *
 * TypeScript's excess-property check hides it from anyone authoring a spec inside this repo. The
 * YAML path — how an operator actually writes a graph — has nothing.
 *
 * THE SECOND TEST IS THE ONE THAT KEEPS THIS HONEST. An allow-list's failure mode is refusing a
 * field somebody legitimately added, and a guard that cries wolf on correct code is worse than no
 * guard. So the list is checked against the interfaces it claims to enumerate, read out of
 * `spec.ts` rather than restated here — a restatement would be a third copy of one vocabulary,
 * which is the drift this file exists to prevent, one level up.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { compile } from "../../src/graph/compile.ts";
import { ALLOWED_FIELDS, REQUIRED_BLOCK, type NodeType } from "../../src/graph/spec.ts";
import { resolver } from "../run/skeleton.ts";

const SPEC_SRC = readFileSync(fileURLToPath(new URL("../../src/graph/spec.ts", import.meta.url)), "utf8");

/** The interface each node type's block is typed as, e.g. `evaluator` → `EvaluatorNode`. */
const BLOCK_INTERFACE: Readonly<Record<NodeType, string>> = {
  function: "FunctionNode",
  agent: "AgentNode",
  tool: "ToolNode",
  router: "RouterNode",
  join: "JoinNode",
  evaluator: "EvaluatorNode",
  human_gate: "HumanGateNode",
  subgraph: "SubgraphNode",
};

/** Field names declared by an interface in `spec.ts`, read from the source. */
function membersOf(name: string): readonly string[] {
  const m = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(SPEC_SRC);
  assert.ok(m, `interface ${name} moved or changed shape — this test reads it from the source`);
  return [...m[1]!.matchAll(/^\s*readonly\s+([A-Za-z_$][\w$]*)\??\s*:/gm)].map((x) => x[1]!).sort();
}

const graph = (block: string, body: Record<string, unknown>) =>
  compile({
    spec: {
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "af", project: "test", version: 1 },
      channels: { a: { type: "string", reduce: "replace" }, b: { type: "object", reduce: "replace" } },
      inputs: ["a"],
      outputs: ["b"],
      nodes: [{ id: "n", type: block === "humanGate" ? "human_gate" : block, reads: ["a"], writes: ["b"], [block]: body }],
      edges: [],
    } as never,
    resolver: resolver(),
    tools: {},
    tenantCapabilities: [],
  });

test("AN UNKNOWN FIELD IN A NODE BLOCK IS REFUSED, and the message names it", () => {
  // The exact mistake: reading `FunctionNode.effects` and reaching for it on an evaluator.
  const r = graph("evaluator", { kind: "assertion", ref: "function/a@stable", threshold: 0.8, effects: ["pay.charge"] });

  assert.equal(r.ok, false, "a declared-and-uninterpretable field compiled clean");
  const codes = r.diagnostics.filter((x) => x.severity === "error").map((x) => x.code);
  assert.ok(codes.includes("GRAPH020_UNKNOWN_FIELD"), codes.join(", "));
  const diag = r.diagnostics.find((x) => x.code === "GRAPH020_UNKNOWN_FIELD")!;
  assert.match(diag.message, /effects/, "the message must name the field the author wrote");
});

test("A TYPO GETS THE NEAREST REAL FIELD, not a list to read", () => {
  const r = graph("function", { ref: "function/a@stable", effectz: ["x"] });
  const diag = r.diagnostics.find((x) => x.code === "GRAPH020_UNKNOWN_FIELD")!;
  assert.ok(diag !== undefined, "a misspelled field must not compile");
  assert.match(diag.fix ?? "", /effects/, `expected a suggestion, got: ${diag.fix ?? "(none)"}`);
});

test("EVERY FIELD THE INTERFACES DECLARE IS ALLOWED — the guard must not refuse valid graphs", () => {
  // An allow-list that has fallen behind its interface refuses graphs that are correct, which is
  // strictly worse than the hole it closed. Read from the source so the two cannot drift.
  for (const [type, iface] of Object.entries(BLOCK_INTERFACE) as [NodeType, string][]) {
    assert.deepEqual(
      [...ALLOWED_FIELDS[type]].sort(),
      membersOf(iface),
      `ALLOWED_FIELDS.${type} and ${iface} disagree — a field was added to one and not the other`,
    );
  }
});

test("the table covers every node type, and every type has a block", () => {
  // Non-vacuous: both loops above iterate tables, and a table that lost a member would make them
  // pass while checking less. `REQUIRED_BLOCK` is the independent enumeration to compare against.
  assert.deepEqual(Object.keys(ALLOWED_FIELDS).sort(), Object.keys(REQUIRED_BLOCK).sort());
  assert.deepEqual(Object.keys(BLOCK_INTERFACE).sort(), Object.keys(REQUIRED_BLOCK).sort());
  assert.equal(Object.keys(ALLOWED_FIELDS).length, 8, "eight node types");
});

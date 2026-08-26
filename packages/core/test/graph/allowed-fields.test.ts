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
import { ALLOWED_FIELDS, EDGE_FIELDS, NODE_FIELDS, POLICY_FIELDS, REQUIRED_BLOCK, SPEC_FIELDS, type NodeType } from "../../src/graph/spec.ts";
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

// ── the three enclosing scopes ───────────────────────────────────────────────

/**
 * The block check left the node, the graph and the edge open, and the worst instance was there.
 *
 * Measured on a `tool` node, everything else identical:
 *
 *     policy:  { posture: "in" }   →  plan posture `in`
 *     policyy: { posture: "in" }   →  plan posture `out`, ZERO diagnostics
 *
 * Every other member of this family costs a feature. This one costs the control deciding whether
 * a human sees the action at all — the author asked for the strongest oversight the system has,
 * got the weakest, and was told nothing. `retry`, `timeoutMs` and `checkpoint` are discarded the
 * same way; `checkpoint`'s own docstring records a VALID value being ignored for months, which is
 * this defect with the misspelling on the compiler's side instead of the author's.
 */
const full = (over: { spec?: Record<string, unknown>; node?: Record<string, unknown>; edge?: Record<string, unknown> }) =>
  compile({
    spec: {
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "sc", project: "test", version: 1 },
      policy: { posture: "out", budget: { costUsd: 1 }, capabilities: [] },
      channels: { a: { type: "string", reduce: "replace" }, b: { type: "object", reduce: "replace" } },
      inputs: ["a"],
      outputs: ["b"],
      nodes: [
        { id: "n", type: "function", reads: ["a"], writes: ["b"], function: { ref: "function/f@stable" }, ...(over.node ?? {}) },
        { id: "m", type: "function", reads: ["b"], writes: ["b"], function: { ref: "function/f@stable" } },
      ],
      edges: [{ id: "e", from: "n", to: "m", kind: "seq", ...(over.edge ?? {}) }],
      ...(over.spec ?? {}),
    } as never,
    resolver: resolver(),
    tools: {},
    tenantCapabilities: [],
  });

const unknownField = (r: ReturnType<typeof compile>) => r.diagnostics.find((x) => x.code === "GRAPH020_UNKNOWN_FIELD");

test("A MISSPELLED `policy` IS REFUSED — the oversight control that silently vanished", () => {
  const r = full({ node: { policyy: { posture: "in" } } });

  assert.equal(r.ok, false, "a node asking for `in` and running at `out` compiled clean");
  const diag = unknownField(r)!;
  assert.ok(diag !== undefined, r.diagnostics.map((x) => x.code).join(", ") || "(no diagnostics)");
  assert.match(diag.message, /policyy/, "the message must name what the author wrote");
  assert.match(diag.fix ?? "", /`policy`/, `expected the near miss, got: ${diag.fix ?? "(none)"}`);
});

test("AN UNKNOWN TOP-LEVEL GRAPH FIELD IS REFUSED", () => {
  const r = full({ spec: { channelz: {} } });
  assert.equal(r.ok, false);
  assert.match(unknownField(r)!.message, /channelz/);
  assert.match(unknownField(r)!.fix ?? "", /`channels`/);
});

test("AN UNKNOWN EDGE FIELD IS REFUSED — a misspelled `when` fires every time", () => {
  // Not merely inert: the edge keeps running, unconditionally. The guard the author wrote is
  // absent rather than broken, which is the direction that does not announce itself.
  const r = full({ edge: { whenn: "a == 'x'" } });
  assert.equal(r.ok, false);
  assert.match(unknownField(r)!.message, /whenn/);
  assert.match(unknownField(r)!.fix ?? "", /`when`/);
});

test("EVERY FIELD THE THREE INTERFACES DECLARE IS ALLOWED — the guard must not refuse valid graphs", () => {
  // The same anti-cry-wolf check as the block table above, for the same reason: an allow-list
  // that has fallen behind its interface refuses correct graphs, which is worse than the hole.
  assert.deepEqual([...NODE_FIELDS].sort(), membersOf("NodeSpec"), "NODE_FIELDS and NodeSpec disagree");
  assert.deepEqual([...SPEC_FIELDS].sort(), membersOf("GraphSpec"), "SPEC_FIELDS and GraphSpec disagree");
  assert.deepEqual([...EDGE_FIELDS].sort(), membersOf("EdgeSpec"), "EDGE_FIELDS and EdgeSpec disagree");
});

test("EVERY FIELD THE POLICY INTERFACES DECLARE IS ALLOWED — the same, one level in", () => {
  // `POLICY_FIELDS` is read at one call site for four scopes, and the cry-wolf risk is higher
  // here than above: a field added to `Budget` and not to this table refuses a graph whose
  // budget is correct, and the author has no way to tell that from a real typo.
  const IFACE: Readonly<Record<keyof typeof POLICY_FIELDS, string>> = {
    graphPolicy: "GraphPolicy",
    nodePolicy: "NodePolicy",
    budget: "Budget",
    expansion: "ExpansionBudget",
  };
  for (const [key, iface] of Object.entries(IFACE) as [keyof typeof POLICY_FIELDS, string][]) {
    assert.deepEqual(
      [...POLICY_FIELDS[key]].sort(),
      membersOf(iface),
      `POLICY_FIELDS.${key} and ${iface} disagree — a field was added to one and not the other`,
    );
  }
  assert.deepEqual(Object.keys(POLICY_FIELDS).sort(), Object.keys(IFACE).sort(), "the table lost or gained a scope");
});

test("A GRAPH USING THESE FIELDS CORRECTLY STILL COMPILES — the control", () => {
  // Reading a table is not evidence the check accepts what it should. This exercises the exact
  // four node fields whose typos are tested above, all valid, all together.
  const r = full({
    node: { policy: { posture: "in" }, retry: { maxAttempts: 2 }, timeoutMs: 5000, checkpoint: "after" },
    edge: { when: "true" },
  });
  assert.deepEqual(
    r.diagnostics.filter((x) => x.code === "GRAPH020_UNKNOWN_FIELD"),
    [],
    "valid fields were refused",
  );
});

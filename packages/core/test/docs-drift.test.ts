/**
 * Design-document drift.
 *
 * The design documents are the contract surface, and a contract that quietly stops
 * describing the code is worse than no contract — it is a confident wrong answer. These
 * tests read the documents and check the claims that can be checked mechanically.
 *
 * Deliberately narrow. Only facts a machine can verify are pinned here; prose stays
 * prose, and the JOURNAL is a record of what happened and is never rewritten to match.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CODES } from "../src/errors.ts";
import { ESCALATION_RULES } from "../src/run/escalation.ts";

/** The compiler's own taxonomies, so the test cannot drift from the code either. */
const NODE_TYPES = ["function", "agent", "tool", "router", "join", "evaluator", "human_gate", "subgraph"] as const;
const EDGE_KINDS = ["seq", "conditional", "fanout", "join", "error", "compensation", "loop"] as const;

const design = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../design/loom/${name}`, import.meta.url)), "utf8");

// ── D3.17–D3.24: the boundary error taxonomy (gap G1) ────────────────────────

test("EVERY ERROR CODE THE INTERFACE DOC NAMES ACTUALLY EXISTS", () => {
  // G1 was closed by enumerating each boundary interface's codes. This is what keeps it
  // closed: a code renamed in `errors.ts` and not in the doc fails here, rather than
  // being discovered by someone writing a `retry.onlyIf` list against a code that never
  // fires.
  const doc = design("01-INTERFACES.md");
  const section = doc.slice(doc.indexOf("### The boundary error taxonomy"));
  const codes = new Set([...section.matchAll(/`(E_[A-Z_]+)`/g)].map((m) => m[1]!));

  assert.ok(codes.size >= 20, `only ${codes.size} codes in the taxonomy table — did the section move?`);
  const missing = [...codes].filter((c) => !(c in CODES));
  assert.deepEqual(missing, [], "the doc names codes that do not exist");
});

test("the boundary taxonomy covers all eight boundary interfaces", () => {
  const doc = design("01-INTERFACES.md");
  const section = doc.slice(doc.indexOf("### The boundary error taxonomy"));
  for (const name of [
    "ControlPlaneAPI",
    "RunEventStream",
    "RunLifecycle",
    "GateDelivery",
    "ToolTransport",
    "JournalReader",
    "BlobStore",
    "SecretProvider",
  ]) {
    assert.ok(section.includes(`\`${name}\``), `${name} has no row in the taxonomy table`);
  }
});

test("GateDelivery.deliver still raises exactly ONE code", () => {
  // Load-bearing, not descriptive. Every branch out of "the notification failed" that is
  // not "leave the gate open" is a way to approve something nobody approved.
  const doc = design("01-INTERFACES.md");
  const row = doc.split("\n").find((l) => l.includes("`GateDelivery`") && l.includes("`deliver`"));
  assert.ok(row);
  const codes = [...row.matchAll(/`(E_[A-Z_]+)`/g)].map((m) => m[1]);
  assert.deepEqual(codes, ["E_GATE_DELIVERY_FAILED"]);
});

// ── D7.7: the escalation table ───────────────────────────────────────────────

test("every rule in the code appears in the design's escalation table", () => {
  const doc = design("04-OVERSIGHT.md");
  for (const rule of Object.values(ESCALATION_RULES)) {
    assert.ok(
      doc.includes(`| ${rule.code} |`),
      `${rule.id} claims to be ${rule.code}, which the design table does not have`,
    );
  }
});

test("the design's E-codes and the code's E-codes are the same set", () => {
  const doc = design("04-OVERSIGHT.md");
  const table = doc.slice(doc.indexOf("### Escalation decision table"), doc.indexOf("**What approval means.**"));
  const declared = new Set([...table.matchAll(/^\| (E\d+) \|/gm)].map((m) => m[1]!));
  const implemented = new Set(Object.values(ESCALATION_RULES).map((r) => r.code as string));
  assert.deepEqual([...declared].sort(), [...implemented].sort());
});

// ── D9.4: retention ──────────────────────────────────────────────────────────

test("the DoD does not claim anything is PROVEN without naming its evidence", () => {
  // A status word with no evidence column is a status word that will rot.
  const doc = design("99-DOD.md");
  for (const line of doc.split("\n")) {
    if (!line.startsWith("|") || !line.includes("**PROVEN**")) continue;
    const cells = line.split("|").map((c) => c.trim());
    const evidence = cells[cells.length - 2] ?? "";
    assert.ok(evidence.length > 25, `a PROVEN row with no evidence:\n  ${line}`);
  }
});

// ── D5: the node and edge taxonomy ───────────────────────────────────────────

test("the design's node types are exactly the ones the compiler accepts", () => {
  // D5.1 fixes the node taxonomy at eight. If the code grows a ninth without the design
  // growing one too, "the kernel is seven primitives and a node taxonomy of eight" has
  // quietly stopped being true.
  const doc = design("02-EXECUTION-GRAPH.md");
  for (const type of NODE_TYPES) {
    assert.ok(doc.includes(`\`${type}\``), `node type "${type}" appears nowhere in D5`);
  }
  assert.equal(NODE_TYPES.length, 8, "update D5 and this count together, deliberately");
});

test("the design's edge kinds are exactly the ones the compiler accepts", () => {
  const doc = design("02-EXECUTION-GRAPH.md");
  for (const kind of EDGE_KINDS) {
    assert.ok(doc.includes(`\`${kind}\``), `edge kind "${kind}" appears nowhere in D5`);
  }
  assert.equal(EDGE_KINDS.length, 7);
});

test("every GRAPH rule the compiler can emit is documented", () => {
  // A diagnostic an author cannot look up is a diagnostic they will guess at.
  const doc = design("02-EXECUTION-GRAPH.md");
  const src = readFileSync(fileURLToPath(new URL("../src/graph/validate.ts", import.meta.url)), "utf8");
  const emitted = new Set([...src.matchAll(/code: "(GRAPH\d+)_[A-Z_]+"/g)].map((m) => m[1]!));

  assert.ok(emitted.size >= 20, `only found ${emitted.size} GRAPH rules — did the code shape change?`);
  const undocumented = [...emitted].filter((r) => !doc.includes(r));
  assert.deepEqual(undocumented, [], "the compiler can emit rules D5 never mentions");
});

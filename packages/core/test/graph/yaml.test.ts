/**
 * The YAML authoring subset (open thread T1).
 *
 * Two things this file has to establish. First, that the subset reads the YAML the design
 * documents actually contain — a GraphSpec, an oversight policy, an eval suite. Second,
 * and more important, that everything OUTSIDE the subset is refused with a line number
 * rather than mis-read: a parser that silently mishandles an anchor produces a graph the
 * author did not write, and the compiler then validates the wrong thing perfectly.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { compileOrThrow } from "../../src/graph/compile.ts";
import { parseYaml, parseYamlSpec } from "../../src/graph/yaml.ts";
import { resolver } from "../run/skeleton.ts";

const refuses = (source: string, what: RegExp) =>
  assert.throws(() => parseYaml(source, { filename: "g.yaml" }), what);

// ── scalars ──────────────────────────────────────────────────────────────────

test("scalars read as their JSON types", () => {
  assert.deepEqual(parseYaml("a: 1\nb: 1.5\nc: true\nd: false\ne: null\nf: ~\ng: text"), {
    a: 1,
    b: 1.5,
    c: true,
    d: false,
    e: null,
    f: null,
    g: "text",
  });
});

test("`on` STAYS A STRING — the most notorious YAML footgun, and a posture value here", () => {
  // YAML 1.1 turns `on`, `yes`, and `off` into booleans. `posture: on` silently becoming
  // `posture: true` would be catastrophic in this system specifically.
  assert.deepEqual(parseYaml("posture: on"), { posture: "on" });
  assert.deepEqual(parseYaml("a: yes\nb: no\nc: off"), { a: "yes", b: "no", c: "off" });
});

test("quotes preserve a string that would otherwise be typed", () => {
  assert.deepEqual(parseYaml(`a: "1"\nb: '2'\nc: "true"`), { a: "1", b: "2", c: "true" });
});

test("a colon inside a quoted string does not split the key", () => {
  assert.deepEqual(parseYaml(`when: "verdict.severity >= 0.7"`), { when: "verdict.severity >= 0.7" });
  assert.deepEqual(parseYaml(`url: "https://example.com:8080/x"`), { url: "https://example.com:8080/x" });
});

test("a comment is stripped, but a # inside a string is not", () => {
  assert.deepEqual(parseYaml("a: 1  # the count\nb: 2"), { a: 1, b: 2 });
  assert.deepEqual(parseYaml(`channel: "#sre-approvals"`), { channel: "#sre-approvals" });
});

test("negative and exponent numbers read as numbers", () => {
  assert.deepEqual(parseYaml("a: -3\nb: 1e3\nc: -0.5"), { a: -3, b: 1000, c: -0.5 });
});

// ── structure ────────────────────────────────────────────────────────────────

test("nested mappings nest", () => {
  assert.deepEqual(parseYaml("policy:\n  posture: out\n  budget:\n    costUsd: 2\n"), {
    policy: { posture: "out", budget: { costUsd: 2 } },
  });
});

test("a sequence of scalars", () => {
  assert.deepEqual(parseYaml("inputs:\n  - alert\n  - context\n"), { inputs: ["alert", "context"] });
});

test("A SEQUENCE OF MAPPINGS — the shape every `nodes:` list has", () => {
  assert.deepEqual(
    parseYaml("nodes:\n  - id: a\n    type: function\n  - id: b\n    type: tool\n"),
    { nodes: [{ id: "a", type: "function" }, { id: "b", type: "tool" }] },
  );
});

test("a mapping nested inside a sequence item", () => {
  assert.deepEqual(parseYaml("nodes:\n  - id: a\n    tool:\n      name: fs.write\n      version: '1.0'\n"), {
    nodes: [{ id: "a", tool: { name: "fs.write", version: "1.0" } }],
  });
});

test("a sequence nested inside a sequence item", () => {
  assert.deepEqual(parseYaml("cases:\n  - when: x\n    take:\n      - e1\n      - e2\n"), {
    cases: [{ when: "x", take: ["e1", "e2"] }],
  });
});

test("flow collections, YAML-style and JSON-style", () => {
  assert.deepEqual(parseYaml("a: [1, 2]\nb: [x, y]\nc: {k: 1}\nd: {\"j\": 2}"), {
    a: [1, 2],
    b: ["x", "y"],
    c: { k: 1 },
    d: { j: 2 },
  });
});

test("block scalars keep or fold their newlines", () => {
  assert.equal((parseYaml("text: |\n  one\n  two\n") as { text: string }).text, "one\ntwo\n");
  assert.equal((parseYaml("text: >\n  one\n  two\n") as { text: string }).text, "one two\n");
  assert.equal((parseYaml("text: |-\n  one\n  two\n") as { text: string }).text, "one\ntwo");
});

test("a leading --- opens the document", () => {
  assert.deepEqual(parseYaml("---\na: 1\n"), { a: 1 });
});

test("an empty document is null, not a crash", () => {
  assert.equal(parseYaml(""), null);
  assert.equal(parseYaml("# just a comment\n"), null);
});

// ── what it refuses ──────────────────────────────────────────────────────────

test("AN ANCHOR IS REFUSED, with a line number", () => {
  refuses("a: &base\n  x: 1\n", /g\.yaml:1: an anchor/);
});

test("an alias is refused", () => {
  refuses("a:\n  x: 1\nb: *base\n", /g\.yaml:3: an alias/);
});

test("a tag is refused", () => {
  refuses("a: !!str 1\n", /g\.yaml:1: a tag/);
});

test("a merge key is refused", () => {
  refuses("a:\n  <<: *base\n", /a merge key|an alias/);
});

test("a SECOND document is refused — this subset reads one per file", () => {
  refuses("a: 1\n---\nb: 2\n", /g\.yaml:2: a second document/);
});

test("a tab in the indentation is refused, because YAML forbids it and eyes cannot see it", () => {
  refuses("a:\n\tb: 1\n", /g\.yaml:2: a tab/);
});

test("A DUPLICATE KEY IS AN ERROR, not a silent last-wins", () => {
  // In JSON the last one silently wins. In a GraphSpec it means two declarations
  // disagree and one is being ignored — which is exactly what an author needs told.
  refuses("posture: out\nposture: in\n", /duplicate key "posture"/);
});

test("a line that is not `key: value` is refused with the line quoted back", () => {
  refuses("a: 1\nnonsense\n", /g\.yaml:2: expected "key: value"/);
});

test("a top-level sequence is refused by parseYamlSpec, which every spec needs", () => {
  assert.throws(() => parseYamlSpec("- a\n- b\n", { filename: "g.yaml" }), /expected a mapping at the top level/);
});

// ── the real thing ───────────────────────────────────────────────────────────

const SPEC_YAML = `
# A hand-authored graph, in the style the design documents use.
apiVersion: loom.dev/v1
kind: GraphSpec
metadata:
  name: greet
  project: demo
  version: 1
policy:
  posture: on          # NOT the boolean true
  budget: { costUsd: 1.0 }
  capabilities: [fs:write]
channels:
  who:
    type: string
    reduce: replace
  note:
    type: object
    reduce: replace
inputs:
  - who
outputs:
  - note
nodes:
  - id: greet
    type: tool
    reads: [who]
    writes: [note]
    unhandled: true
    tool:
      name: fs.write
      version: "1.0"
      args:
        path: out.txt
        body: "hello \${who}"
edges: []
`;

test("A REAL GRAPHSPEC PARSES AND THEN COMPILES", () => {
  const spec = parseYamlSpec(SPEC_YAML, { filename: "greet.yaml" });

  assert.equal((spec["policy"] as { posture: unknown }).posture, "on", "still the posture, not `true`");
  assert.deepEqual((spec["policy"] as { capabilities: unknown }).capabilities, ["fs:write"]);
  assert.equal((spec["nodes"] as { id: string }[])[0]?.id, "greet");

  const graph = compileOrThrow({
    spec: spec as never,
    resolver: resolver(),
    tools: {
      "fs.write": { name: "fs.write", version: "1.0", capabilities: ["fs:write"], irreversibility: "reversible_write", idempotent: true },
    },
    tenantCapabilities: ["fs:write"],
  });
  assert.deepEqual(graph.entryNodes, ["greet"]);
  assert.equal(graph.plans["greet" as never]?.posture, "on");
});

test("the parsed value is plain JSON, so it hashes like any other spec", () => {
  // The rule this protects: YAML is authoring sugar and never reaches a digest. Round
  // -tripping through JSON must be lossless, or two authors' identical graphs would hash
  // differently depending on which format they typed.
  const spec = parseYamlSpec(SPEC_YAML);
  assert.deepEqual(JSON.parse(JSON.stringify(spec)), spec);
});

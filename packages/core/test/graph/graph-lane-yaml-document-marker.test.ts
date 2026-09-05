/**
 * `---` inside a block scalar is content, and a second document is still refused.
 *
 * The last member of the family `blockScalar` was written to close, and open at every sha
 * until now: `parseYaml`'s document scan ran over the RAW lines before block structure was
 * known, so a `prompt: |` containing a `---` line was refused as "a second document (---)".
 * At 294e713:
 *
 *     ITEM5:       THREW <yaml>:3: a second document (---); this subset reads one document per file
 *     ITEM5 (...): {"prompt":"line one\n...\nline two\n","other":1}
 *
 * `...` already worked, because the scan only DROPS it and the block scalar reads the raw
 * source. The scan now records the question and `blockScalar` — the one place that decides
 * where a block ends — answers it, so the refusal keeps its message and its line number for
 * every document that really does hold two.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { parseYaml, parseYamlSpec } from "../../src/graph/yaml.ts";

const doc = (...lines: string[]): string => lines.join("\n");

test("A `---` LINE INSIDE A BLOCK SCALAR IS CONTENT, not a second document", () => {
  assert.deepEqual(parseYaml(doc("prompt: |", "  line one", "  ---", "  line two", "other: 1")), {
    prompt: "line one\n---\nline two\n",
    other: 1,
  });

  // Folded, chomped, first line, last line, and more than one.
  assert.deepEqual(parseYaml(doc("prompt: |-", "  ---", "  after")), { prompt: "---\nafter" });
  assert.deepEqual(parseYaml(doc("prompt: |", "  before", "  ---")), { prompt: "before\n---\n" });
  assert.deepEqual(parseYaml(doc("prompt: |", "  a", "  ---", "  b", "  ---", "  c")), { prompt: "a\n---\nb\n---\nc\n" });
  assert.deepEqual(parseYaml(doc("prompt: >", "  ---", "", "  tail")), { prompt: "---\ntail\n" });

  // A leading `---` still opens the document, and the block below it still reads its own.
  assert.deepEqual(parseYaml(doc("---", "prompt: |", "  ---", "  x")), { prompt: "---\nx\n" });
});

test("A REAL SECOND DOCUMENT IS STILL REFUSED, with the same message and the same line", () => {
  assert.throws(
    () => parseYaml(doc("a: 1", "---", "b: 2")),
    /:2: a second document \(---\); this subset reads one document per file/,
  );
  assert.throws(() => parseYaml(doc("---", "a: 1", "---", "b: 2")), /:3: a second document/);
  // Two markers and nothing else at all — the case that never reaches block structure.
  assert.throws(() => parseYaml(doc("---", "---")), /:2: a second document/);
  // AND ONE THAT SITS BELOW A BLOCK SCALAR RATHER THAN INSIDE IT: the block ends where the
  // indentation ends, so this `---` is outside it and is a second document.
  assert.throws(() => parseYaml(doc("prompt: |", "  x", "---", "b: 2")), /:3: a second document/);
});

test("A BLOCK SCALAR'S OWN DIAGNOSTIC SURVIVES a `---` above the offending line", () => {
  // The block claims its lines as it walks, so a `---` it had already taken is not re-reported
  // as a second document when a later line of the same block is refused.
  assert.throws(
    () => parseYaml(doc("k: |", "      first", "  ---", "      third")),
    /a block scalar line indented 2 where its first line is indented 6/,
  );
});

test("THE ORDINARY HALF: everything else this parser does is unchanged", () => {
  const spec = parseYamlSpec(
    doc(
      "apiVersion: loom.dev/v1",
      "kind: GraphSpec",
      "metadata:",
      "  name: g",
      "nodes:",
      "  - id: a",
      "    prompt: |",
      "      hello # not a comment",
      "",
      "      world",
      "channels: {out: 1}",
    ),
  );
  assert.deepEqual(spec, {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "g" },
    nodes: [{ id: "a", prompt: "hello # not a comment\n\nworld\n" }],
    channels: { out: 1 },
  });

  assert.equal(parseYaml(""), null);
  assert.deepEqual(parseYaml(doc("---", "a: 1")), { a: 1 });
  assert.deepEqual(parseYaml(doc("a: 1", "...")), { a: 1 });
  assert.throws(() => parseYaml(doc("a: &x 1")), /an anchor/);
  assert.throws(() => parseYaml(doc("a: 1", "\tb: 2")), /a tab in the indentation/);
  assert.throws(() => parseYaml(doc("a: 1", "  b: 2")), /content after the document ended|unexpected indentation/);
});

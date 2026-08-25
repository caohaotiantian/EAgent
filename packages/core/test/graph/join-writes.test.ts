/**
 * A barrier folds what its branches produced. It cannot make anything new.
 *
 * `#foldJoin` has no body and no transform: it collects each branch task's committed `writes` per
 * channel and commits the result at the join's own coordinate. So a channel none of its branches
 * wrote is a channel the barrier cannot produce, whatever the node's `writes` declares — and that
 * declaration compiled clean, with no diagnostic at all.
 *
 * FOUND BY WRITING A GRAPH. A `collect` join declared `writes: ["report"]` over branches writing
 * `reviews`. `loom compile` said `ok`. The fold produced nothing. The run then either failed with
 * `E_OUTPUT_MISSING` — a message about the OUTPUT, three nodes away from the mistake — or, because
 * a downstream node happened to write that same channel itself, SUCCEEDED and wrote an empty
 * report. The second is the plausible-wrong-answer shape this system exists to refuse.
 *
 * A WARNING and not an error, which is this file's own rule: errors are for declarations that
 * SUBSTITUTE semantics. This one does nothing, and six fixtures in this repository carried it
 * before the check existed — a mistake the codebase makes six times in its own tests is one
 * shipped graphs make too.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { compile } from "../../src/graph/compile.ts";
import { resolver } from "../run/skeleton.ts";

const spec = (joinWrites: readonly string[]) =>
  ({
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "join-writes", project: "test", version: 1 },
    policy: { posture: "out", budget: { costUsd: 1 } },
    channels: {
      items: { type: "array", reduce: "replace" },
      item: { type: "string", reduce: "replace" },
      parts: { type: "array", reduce: "append_ordered" },
      report: { type: "object", reduce: "replace" },
    },
    inputs: ["items"],
    outputs: ["parts"],
    nodes: [
      { id: "s", type: "function", reads: ["items"], function: { ref: "function/p@stable" } },
      { id: "w", type: "function", reads: ["item"], writes: ["parts"], function: { ref: "function/w@stable" } },
      {
        id: "j",
        type: "join",
        reads: ["parts"],
        writes: [...joinWrites],
        join: { branches: ["w"], mode: "all", onBranchError: "skip" },
      },
    ],
    edges: [
      { id: "fan", from: "s", to: "w", kind: "fanout", over: "items", as: "item", maxWidth: 2 },
      { id: "jj", from: "w", to: "j", kind: "join", branches: ["w"] },
    ],
  }) as never;

const build = (joinWrites: readonly string[]) =>
  compile({ spec: spec(joinWrites), resolver: resolver(), tools: {}, tenantCapabilities: [] });

test("A JOIN THAT DECLARES AN UNPRODUCIBLE WRITE IS REPORTED", () => {
  // `report` is a real channel that no branch writes. The barrier has no way to make one.
  const r = build(["report"]);
  const diag = r.diagnostics.find((x) => x.code === "GRAPH008_JOIN_WRITES_UNPRODUCED");

  assert.ok(diag !== undefined, `no diagnostic; got ${r.diagnostics.map((x) => x.code).join(", ") || "(none)"}`);
  assert.match(diag.message, /report/, "the message must name the channel");
  assert.match(diag.message, /\bw\b/, "…and the branches that were supposed to produce it");
  assert.match(diag.fix ?? "", /parts/, "the fix should name what the branches DO write");
});

test("a join writing what its branches DO write is silent", () => {
  // The control. A check that fires on every join says nothing about any of them, and the ordinary
  // shape — a barrier propagating its branches' own channel — has to stay quiet.
  const r = build(["parts"]);
  assert.deepEqual(
    r.diagnostics.filter((x) => x.code === "GRAPH008_JOIN_WRITES_UNPRODUCED"),
    [],
    "the ordinary fold was reported as unproducible",
  );
});

test("a join declaring NO writes is silent — a barrier may just signal that branches finished", () => {
  const r = build([]);
  assert.deepEqual(
    r.diagnostics.filter((x) => x.code === "GRAPH008_JOIN_WRITES_UNPRODUCED"),
    [],
    "declaring nothing is not declaring something unproducible",
  );
});

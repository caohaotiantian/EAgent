/**
 * `compile` must refuse a `policy` block it cannot interpret, and say which word was wrong.
 *
 * `vocab.ts` now ranks an unreadable posture at `in`, so a graph carrying one fails SAFE
 * rather than open. That is the floor and not the answer: failing safe on a typo is still not
 * what the author wrote, and the compiler is the only layer positioned to name the field and
 * the legal values. Measured before this existed, against a graph otherwise byte-identical to
 * one that compiles clean (`.agent/graph-provenance/gate.json`):
 *
 *     policy: { posture: "strict" }      →  ok, and every node planned at `out`
 *     policy: { posturr: "out" }         →  ok, zero diagnostics
 *     policy: { budget: { nonsense:5 } } →  ok, zero diagnostics
 *
 * The first row is the whole oversight layer's failure mode written into one word: an author
 * asking for the strongest supervision the system has, given the weakest, told nothing.
 *
 * TWO OF THESE TESTS ARE CONTROLS, and they are not decoration. This is a breaking change to what
 * `compile` accepts, so a guard that refuses everything would look identical to a guard that
 * works, from every angle except the one that matters.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { compile } from "../../src/graph/compile.ts";
import { resolver } from "../run/skeleton.ts";

const graph = (policy: Record<string, unknown>, nodePolicy?: Record<string, unknown>) =>
  compile({
    spec: {
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "ov", project: "test", version: 1 },
      policy,
      channels: { a: { type: "string", reduce: "replace" }, b: { type: "object", reduce: "replace" } },
      inputs: ["a"],
      outputs: ["b"],
      nodes: [
        {
          id: "n",
          type: "function",
          reads: ["a"],
          writes: ["b"],
          function: { ref: "function/f@stable" },
          ...(nodePolicy === undefined ? {} : { policy: nodePolicy }),
        },
      ],
      edges: [],
    } as never,
    resolver: resolver(),
    tools: {},
    // Granted, so the control below can exercise a real `capabilities` list without tripping
    // GRAPH017 — which would make the control fail for a reason that is not this task's.
    tenantCapabilities: ["fs:write"],
  });

/**
 * The same graph, varying the CHANNEL declaration instead of the policy block.
 *
 * `posture: "in"` at the graph scope on purpose: a `secret_ref` channel floors its readers at
 * `in`, and a control that declared anything weaker would fail on GRAPH014 — for a reason that
 * is not this test's — the moment it reached the last classification in the list.
 */
const channelGraph = (a: unknown) =>
  compile({
    spec: {
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "cls", project: "test", version: 1 },
      policy: { posture: "in" },
      // A non-object `a` replaces the declaration outright rather than being spread into one —
      // `{...null}` is `{}`, which would quietly turn that case into the control.
      channels: {
        a: a !== null && typeof a === "object" ? { type: "string", reduce: "replace", ...a } : a,
        b: { type: "object", reduce: "replace" },
      },
      inputs: ["a"],
      outputs: ["b"],
      nodes: [{ id: "n", type: "function", reads: ["a"], writes: ["b"], function: { ref: "function/f@stable" } }],
      edges: [],
    } as never,
    resolver: resolver(),
    tools: {},
    tenantCapabilities: [],
  });

const codes = (r: ReturnType<typeof compile>) => r.diagnostics.filter((x) => x.severity === "error").map((x) => x.code);
const find = (r: ReturnType<typeof compile>, code: string) => r.diagnostics.find((x) => x.code === code);

test("A POSTURE OUTSIDE THE VOCABULARY IS REFUSED, and the message says what to type", () => {
  const r = graph({ posture: "strict" });

  assert.equal(r.ok, false, "a graph asking for `strict` and running at `out` compiled clean");
  assert.ok(codes(r).includes("GRAPH003_UNKNOWN_POSTURE"), codes(r).join(", ") || "(no errors)");
  const diag = find(r, "GRAPH003_UNKNOWN_POSTURE")!;
  assert.match(diag.message, /"strict"/, "the message must quote back what the author wrote");
  assert.match(diag.fix ?? "", /out, on, in/, `expected the legal values, got: ${diag.fix ?? "(none)"}`);
  // NOT reported as an oversight LOOSENING. That code carries `E_OVERSIGHT_LOOSENED`, a policy
  // refusal, and would send the author to the wrong line for a spelling mistake.
  assert.ok(!codes(r).includes("GRAPH014_OVERSIGHT_LOOSENED"), codes(r).join(", "));
});

test("A NODE'S posture is checked too, and the diagnostic names the node", () => {
  const r = graph({ posture: "out" }, { posture: "IN" });
  assert.equal(r.ok, false, "the vocabulary is case-sensitive and a near miss is still a miss");
  const diag = find(r, "GRAPH003_UNKNOWN_POSTURE")!;
  assert.ok(diag !== undefined, codes(r).join(", ") || "(no errors)");
  assert.equal(diag.at?.nodeId, "n");
  assert.match(diag.message, /"IN"/);
});

test("A MISSPELLED FIELD INSIDE `policy` IS REFUSED, at both scopes", () => {
  const g = graph({ posturr: "out" });
  assert.equal(g.ok, false, "a lost oversight declaration compiled clean");
  assert.match(find(g, "GRAPH020_UNKNOWN_FIELD")!.message, /posturr/);
  assert.match(find(g, "GRAPH020_UNKNOWN_FIELD")!.fix ?? "", /`posture`/, "the nearest real field, not a list to read");

  const n = graph({ posture: "out" }, { capabilitys: [] });
  assert.equal(n.ok, false);
  assert.equal(find(n, "GRAPH020_UNKNOWN_FIELD")!.at?.nodeId, "n");
  assert.match(find(n, "GRAPH020_UNKNOWN_FIELD")!.fix ?? "", /`capabilities`/);
});

test("A MISSPELLED FIELD INSIDE `policy.budget` AND `policy.expansion` IS REFUSED", () => {
  const b = graph({ budget: { nonsense: 5 } });
  assert.equal(b.ok, false, "a budget nobody enforces compiled clean");
  assert.match(find(b, "GRAPH020_UNKNOWN_FIELD")!.message, /policy\.budget.*nonsense/);

  // The expansion case has the sharper consequence: the misspelled limit does not fail, it
  // falls back to DEFAULT_EXPANSION's 256 — a bound raised on the author by a typo.
  const e = graph({ expansion: { maxNodez: 8 } });
  assert.equal(e.ok, false);
  assert.match(find(e, "GRAPH020_UNKNOWN_FIELD")!.message, /policy\.expansion.*maxNodez/);
  assert.match(find(e, "GRAPH020_UNKNOWN_FIELD")!.fix ?? "", /`maxNodes`/);

  // A node has no `expansion`, so declaring one there is an unknown key and is NOT then walked
  // as though it meant something.
  const n = graph({ posture: "out" }, { expansion: { maxNodes: 1 } });
  assert.equal(n.ok, false);
  assert.match(find(n, "GRAPH020_UNKNOWN_FIELD")!.message, /`policy` block has an unknown field `expansion`/);
});

test("A GRAPH DECLARING ALL OF IT CORRECTLY STILL COMPILES — the control", () => {
  // A guard that refuses everything is not a guard. Every field and every value the four tests
  // above misspell, spelled correctly, together, in one graph.
  const r = graph(
    {
      posture: "on",
      capabilities: ["fs:write"],
      budget: { costUsd: 1, tokens: 1000, wallMs: 5000 },
      expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 },
      onBudgetExhausted: "fail",
    },
    { posture: "in", capabilities: [], budget: { costUsd: 0.5 } },
  );
  assert.deepEqual(codes(r), [], "a correct policy block was refused");
  assert.equal(r.ok, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// One level OUT from the four above: the value is not a wrong WORD, it is a wrong KIND.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The tests above all hand `policy` an object and get the fields wrong inside it. These hand it
 * something that is not an object at all, which the check skipped entirely on a comment saying
 * the shape was "left to the type layer". `compile`'s input is `JSON.parse` output — `readSpec`
 * in `cli.ts` parses a file and casts — so nothing downstream of the author ever checked.
 * Measured before this existed, on the graph the control below compiles at `on`:
 *
 *     policy: "in"            →  ok, and the node planned at `out`
 *     policy: null            →  ok, node at `out`
 *     policy: ["posture"]     →  ok, node at `out`
 *     policy: {budget:[1,2]}  →  ok, and no budget enforced
 *     nodes[0].policy: null   →  ok, the node's own declaration dropped
 *
 * The first row is the same failure as `posture: "strict"` reached by a shorter route: an author
 * asking for the STRONGEST oversight there is, planned at the WEAKEST, told nothing.
 */
test("A `policy` THAT IS NOT A BLOCK IS REFUSED, at both scopes", () => {
  for (const [label, value] of [
    ["a bare posture", "in"],
    ["null", null],
    ["a list", ["posture"]],
    ["a number", 3],
  ] as const) {
    const r = graph(value as never);
    assert.equal(r.ok, false, `graph policy ${label} compiled clean, unsupervised`);
    const diag = find(r, "GRAPH003_MALFORMED");
    assert.ok(diag !== undefined, `${label}: ${codes(r).join(", ") || "(no errors)"}`);
    assert.match(diag.message, /`policy` must be an object/);

    const n = graph({ posture: "out" }, value as never);
    assert.equal(n.ok, false, `node policy ${label} compiled clean`);
    assert.equal(find(n, "GRAPH003_MALFORMED")!.at?.nodeId, "n", "the author has to be told WHICH node");
  }

  // The bare posture is the one worth a targeted fix — it is the reproduced case, and the author
  // was reaching for the strongest oversight the system has.
  assert.match(graph("in" as never).diagnostics.find((x) => x.code === "GRAPH003_MALFORMED")!.fix ?? "", /posture: "in"/);
});

test("A NESTED `budget` OR `expansion` THAT IS NOT A BLOCK IS REFUSED", () => {
  const b = graph({ budget: [1, 2] });
  assert.equal(b.ok, false, "a declared budget that enforces nothing compiled clean");
  assert.match(find(b, "GRAPH003_MALFORMED")!.message, /`policy\.budget` must be an object, not an array/);
  assert.match(find(b, "GRAPH003_MALFORMED")!.fix ?? "", /costUsd/, "the fix names the fields, since there is no key to guess from");

  const e = graph({ expansion: "big" });
  assert.equal(e.ok, false);
  assert.match(find(e, "GRAPH003_MALFORMED")!.message, /`policy\.expansion` must be an object, not a string/);

  const n = graph({ posture: "out" }, { budget: null });
  assert.equal(n.ok, false);
  assert.equal(find(n, "GRAPH003_MALFORMED")!.at?.nodeId, "n");
});

/**
 * The other half of the same silence, one vocabulary over.
 *
 * `vocab.ts` floors an unreadable classification at `in`, so `classification: "SECRET"` now fails
 * SAFE — measured, every reader of that channel plans at `in`. Safe is still not what the author
 * wrote, and it is still silent: before this check, `nonsense` and `SECRET` both compiled `ok`
 * with zero diagnostics. An author who typed `SECRET` for `secret_ref` gets the strictest gate in
 * the system on a channel they thought was ordinary, with nothing anywhere saying why.
 */
test("A CHANNEL CLASSIFICATION OUTSIDE THE VOCABULARY IS REFUSED, and named", () => {
  for (const word of ["SECRET", "nonsense", "Public"]) {
    const r = channelGraph({ classification: word });
    assert.equal(r.ok, false, `classification ${JSON.stringify(word)} compiled clean and silent`);
    const diag = find(r, "GRAPH003_UNKNOWN_CLASSIFICATION");
    assert.ok(diag !== undefined, `${word}: ${codes(r).join(", ") || "(no errors)"}`);
    assert.equal(diag.at?.channel, "a", "the author has to be told WHICH channel");
    assert.match(diag.message, new RegExp(`"${word}"`), "the message quotes back what was written");
    assert.match(diag.fix ?? "", /public, internal, pii, secret_ref/, `got: ${diag.fix ?? "(none)"}`);
  }

  // A channel that is not an object at all reached `.reduce` on `null` and threw out of the
  // validator — `E_INTERNAL` for what is an authoring mistake.
  const bad = channelGraph(null as never);
  assert.equal(bad.ok, false);
  assert.match(find(bad, "GRAPH003_MALFORMED")!.message, /channel "a" must be an object/);
});

test("EVERY REAL CLASSIFICATION STILL COMPILES — the control", () => {
  for (const word of ["public", "internal", "pii", "secret_ref"]) {
    const r = channelGraph({ classification: word });
    assert.deepEqual(codes(r), [], `${word} was refused`);
    assert.equal(r.ok, true);
  }
  // And an absent classification, which is the common case.
  assert.equal(channelGraph({}).ok, true);
});

/**
 * A `loop` EDGE IS AN EDGE TO THE SCHEDULER, AND NOW TO THE COMPILER TOO — §A.84.
 *
 * `validate.ts:364` built the forward DAG as `edges.filter(e => e.kind !== "loop" && e.kind !==
 * "compensation")`, and five analyses read it as though it were the whole graph. One mechanism,
 * three symptoms, and four of the five round trips it took to get the second shipped workflow to
 * run (`docs/workflow-port-2026-09-22.md`, F2/F3/F7).
 *
 * THE SET IS WHAT THE ROW ASKED FOR FIRST, because "put loop edges into `dagEdges`" makes almost
 * every looping graph look cyclic and is not the fix. The full table is at the `dagEdges` site;
 * the short version, and one test below per WRONG row:
 *
 *     topoOrder, rule006's cycle test, the fan-out and critical-path sweeps   RIGHT, unchanged
 *     ancestors, for `rule021`'s `wouldCycle`                                 RIGHT, unchanged
 *     entryNodes          WRONG — a reachable loop target ran at t=0
 *     terminalNodes       WRONG — a loop's source "ended a path"
 *     GRAPH005            WRONG — a loop-carried write was unproduced
 *     GRAPH010            WRONG — two nodes joined by a back-edge looked concurrent
 *     GRAPH002            WRONG — same reason as `ancestors`
 *
 * WHAT THE FIX IS NOT: one filter widened. `ancestors` still walks `dagEdges`' two exclusions, so
 * `rule021`'s `wouldCycle` still asks about FORWARD cycles and §A.73's coupling is untouched —
 * `fanout-branch-diagnostic.test.ts` still pins "the `loop` edge is invisible to `ancestors`" and
 * that pin is still true on purpose. The moved readers ask a different question of a different
 * relation: `flowOrder` (the scheduler's order, cycles cut) and `flowAncestors` (the full closure,
 * cycles included). The last test here is the one that keeps the two apart.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { compile } from "../../src/graph/compile.ts";
import { indexGraph, type Diagnostic } from "../../src/graph/validate.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { NodeId } from "../../src/ids.ts";
import { stubResolver } from "./fixtures.ts";

interface Chan {
  readonly type: string;
  readonly reduce: string;
}

function spec(opts: {
  channels: Record<string, Chan>;
  inputs?: readonly string[];
  outputs?: readonly string[];
  nodes: readonly Record<string, unknown>[];
  edges: readonly Record<string, unknown>[];
}): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "loop-analyses", project: "test", version: 1 },
    policy: { expansion: { maxNodes: 32, maxDepth: 1, maxFanout: 4, maxLoopIterations: 8 } },
    channels: opts.channels,
    inputs: opts.inputs ?? [],
    outputs: opts.outputs ?? [],
    nodes: opts.nodes,
    edges: opts.edges,
  } as unknown as GraphSpec;
}

const fn = (id: string, reads: readonly string[], writes: readonly string[]): Record<string, unknown> => ({
  id,
  type: "function",
  reads,
  writes,
  function: { ref: `function/${id}@stable` },
});

function diagnose(s: GraphSpec): { ok: boolean; codes: readonly string[]; diagnostics: readonly Diagnostic[] } {
  const r = compile({ spec: s, resolver: stubResolver(), tools: {}, tenantCapabilities: [] });
  return { ok: r.ok, codes: r.diagnostics.map((x) => x.code), diagnostics: r.diagnostics };
}

/**
 * THE CANONICAL LOOP SHAPE, and it is the probe the row was opened with.
 *
 * `parse -seq-> audit -loop-> fix -seq-> audit`. The author put `until` on the FORWARD body edge
 * and left the edge that actually closes the cycle a plain `seq`, which is legal, ordinary, and
 * the reason "cut the `loop` edges" is the wrong cut.
 */
const canonical = (): GraphSpec =>
  spec({
    channels: {
      manifest: { type: "object", reduce: "replace" },
      findings: { type: "array", reduce: "replace" },
      applied: { type: "array", reduce: "append_ordered" },
    },
    nodes: [
      fn("parse", [], ["manifest"]),
      fn("audit", ["manifest", "applied"], ["findings"]),
      fn("fix", ["manifest", "findings"], ["manifest", "applied"]),
    ],
    edges: [
      { id: "first-pass", from: "parse", to: "audit", kind: "seq" },
      { id: "again", from: "audit", to: "fix", kind: "loop", until: "len(applied) >= 3", maxIterations: 8 },
      { id: "recheck", from: "fix", to: "audit", kind: "seq" },
    ],
  });

test("THE CANONICAL LOOP GRAPH COMPILES WITH ZERO DIAGNOSTICS — it used to print two, both wrong", () => {
  // Measured before:
  //   warning GRAPH005_UNPRODUCED_READ: node "fix" reads "findings", which no upstream node
  //           writes and which is not a graph input
  //   error   GRAPH010_CONCURRENT_WRITE: nodes "parse" and "fix" can run concurrently and both
  //           write "manifest", whose reducer `replace` is not multi-writer safe
  // `audit` writes `findings` and every path to `fix` goes through it; `parse` and `fix` are three
  // hops apart. Printed on EVERY command, on a correct graph.
  const r = diagnose(canonical());
  assert.deepEqual(r.codes, [], r.diagnostics.map((x) => `${x.severity} ${x.code}: ${x.message}`).join("\n"));
  assert.equal(r.ok, true);
});

test("A LOOP TARGET THE GRAPH REACHES IS NOT AN ENTRY NODE — the third symptom", () => {
  // `hasNonLoopIn` excluded `loop` from the inbound test, so `fix` — whose only inbound edge is
  // the loop — was an entry and the executor started it at t=0 beside `parse`. Both `fix:` routes
  // GRAPH010 offered on this graph ended here, which is why the row calls it the third symptom
  // rather than a fourth defect.
  const idx = indexGraph(canonical());
  assert.deepEqual([...idx.entryNodes], ["parse"]);
  // EVERY path to `fix` runs through both, which is the relation GRAPH010 reads — not merely
  // "some path orders them", which is what the first cut of this fix asked and which
  // `siblings.json` below shows is not enough to be silent on.
  assert.ok(idx.dominators.dominates("audit" as NodeId, "fix" as NodeId), "audit dominates fix");
  assert.ok(idx.dominators.dominates("parse" as NodeId, "fix" as NodeId), "parse dominates fix");
});

test("…BUT A LOOP TARGET NOTHING ELSE REACHES STILL IS — the exception is kept, not deleted", () => {
  // The argument the old rule was built on is real: a two-node cycle whose entry is the loop's own
  // target has no other way in, and calling it entryless would refuse a graph that runs. What was
  // wrong was applying that unconditionally. `graph/mutate.ts`'s dominance guard drives exactly
  // this shape — a mutation adding a back-edge into the entry node must not erase the entry.
  const idx = indexGraph(
    spec({
      channels: { a: { type: "array", reduce: "append_ordered" } },
      nodes: [fn("head", ["a"], ["a"]), fn("body", ["a"], ["a"])],
      edges: [
        { id: "down", from: "head", to: "body", kind: "seq" },
        { id: "back", from: "body", to: "head", kind: "loop", until: "len(a) >= 2", maxIterations: 4 },
      ],
    }),
  );
  assert.deepEqual([...idx.entryNodes], ["head"]);
});

test("A LOOP'S SOURCE IS STILL TERMINAL, AND IS NOT A DEAD END — GRAPH002, both halves", () => {
  // `examples/graphs/harden-config.json` printed
  //   ! GRAPH002_DEAD_END: terminal node "fix" ends a path on which no declared output is ever
  //     written
  // on every command, about a node whose write reaches `collate` — which writes the output —
  // through the back-edge. `idx.ancestors` does not walk one, so the writer was invisible.
  //
  // THE FIRST FIX WAS TO WIDEN `terminalNodes` TO `flowEdges`, AND IT WAS WRONG. A loop source
  // then had an outbound edge and stopped being terminal — which emptied the set on nearly every
  // looping graph (canonical loop, two loops sharing a node, nested loops, a self-loop: all `[]`),
  // so GRAPH002 went silent on exactly the graphs A.84 makes legal, and `evolution/exam.ts`'s
  // `terminalNodes.length !== 1` refused any exam with a bounded loop in it. The set is the base
  // one again; what changed is the QUESTION `rule002Terminals` asks of it.
  const s = spec({
    channels: {
      seed: { type: "string", reduce: "replace" },
      applied: { type: "array", reduce: "append_ordered" },
      report: { type: "string", reduce: "replace" },
    },
    inputs: ["seed"],
    outputs: ["report"],
    nodes: [
      fn("audit", ["seed", "applied"], ["applied"]),
      fn("fix", ["applied"], ["applied"]),
      fn("collate", ["applied"], ["report"]),
    ],
    edges: [
      { id: "repair", from: "audit", to: "fix", kind: "conditional", when: "len(applied) < 3" },
      { id: "recheck", from: "fix", to: "audit", kind: "loop", until: "len(applied) >= 3", maxIterations: 8 },
      { id: "done", from: "audit", to: "collate", kind: "conditional", when: "len(applied) >= 3" },
    ],
  });
  const idx = indexGraph(s);
  // STILL TERMINAL — the loop source leaves by an edge that returns where the run has been.
  assert.deepEqual([...idx.terminalNodes].sort(), ["collate", "fix"]);
  // AND NOT A DEAD END, because `fix -loop-> audit -> collate` writes the declared output.
  const r = diagnose(s);
  assert.equal(r.codes.filter((c) => c === "GRAPH002_DEAD_END").length, 0, r.codes.join(", "));
});

test("…AND A LOOP TAIL THAT REACHES NO OUTPUT WRITER IS STILL A DEAD END — the half a widening loses", () => {
  // The control for the test above, and the row this file's own header promised and did not have.
  // `s -> good` writes the declared output; `s -> b -> c` with `c -loop-> b` is a bounded loop
  // that writes only `z`. `c` reaches `b` and `c` and nothing else, and no output writer reaches
  // `c` — so it ends a path on which no output is ever written, and still says so.
  const tail = spec({
    channels: {
      a: { type: "array", reduce: "append_ordered" },
      out: { type: "array", reduce: "append_ordered" },
      z: { type: "array", reduce: "append_ordered" },
    },
    outputs: ["out"],
    nodes: [fn("s", [], ["a"]), fn("good", ["a"], ["out"]), fn("b", ["a", "z"], ["z"]), fn("c", ["z"], ["z"])],
    edges: [
      { id: "e1", from: "s", to: "good", kind: "seq" },
      { id: "e2", from: "s", to: "b", kind: "seq" },
      { id: "e3", from: "b", to: "c", kind: "seq" },
      { id: "e4", from: "c", to: "b", kind: "loop", until: "len(z) >= 2", maxIterations: 4 },
    ],
  });
  const dead = diagnose(tail).diagnostics.filter((x) => x.code === "GRAPH002_DEAD_END");
  assert.equal(dead.length, 1, diagnose(tail).codes.join(", "));
  assert.deepEqual(dead[0]?.at, { nodeId: "c" as NodeId });

  // AND THE SAME GRAPH WITHOUT THE LOOP EDGE, so the warning is not an artefact of the loop.
  const noLoop = {
    ...(tail as unknown as Record<string, unknown>),
    edges: (tail as unknown as { edges: { id: string }[] }).edges.filter((e) => e.id !== "e4"),
  } as unknown as GraphSpec;
  assert.equal(diagnose(noLoop).codes.filter((c) => c === "GRAPH002_DEAD_END").length, 1);
});

test("TERMINAL NODES SURVIVE EVERY LOOP SHAPE — the set the widening emptied", () => {
  // Four shapes, because "it is empty on looping graphs" is a claim about a SET and one example
  // cannot carry it. `evolution/exam.ts` requires exactly one terminal node, so an empty set here
  // is an exam that cannot be attested rather than only a missing warning.
  const loop = (id: string, from: string, to: string) => ({
    id,
    from,
    to,
    kind: "loop",
    until: "len(a) >= 2",
    maxIterations: 4,
  });
  const ch = { a: { type: "array", reduce: "append_ordered" } };
  const cases: readonly (readonly [string, GraphSpec, readonly string[]])[] = [
    [
      "canonical loop",
      spec({
        channels: ch,
        nodes: [fn("parse", [], ["a"]), fn("audit", ["a"], ["a"]), fn("fix", ["a"], ["a"])],
        edges: [
          { id: "e1", from: "parse", to: "audit", kind: "seq" },
          loop("e2", "audit", "fix"),
          { id: "e3", from: "fix", to: "audit", kind: "seq" },
        ],
      }),
      ["audit"],
    ],
    [
      "two loops sharing a node",
      spec({
        channels: ch,
        nodes: [fn("h", [], ["a"]), fn("x", ["a"], ["a"]), fn("y", ["a"], ["a"])],
        edges: [
          { id: "e1", from: "h", to: "x", kind: "seq" },
          loop("e2", "x", "h"),
          { id: "e3", from: "h", to: "y", kind: "seq" },
          loop("e4", "y", "h"),
        ],
      }),
      ["x", "y"],
    ],
    [
      "nested loops",
      spec({
        channels: ch,
        nodes: [fn("o", [], ["a"]), fn("m", ["a"], ["a"]), fn("i", ["a"], ["a"])],
        edges: [
          { id: "e1", from: "o", to: "m", kind: "seq" },
          { id: "e2", from: "m", to: "i", kind: "seq" },
          loop("e3", "i", "m"),
          loop("e4", "m", "o"),
        ],
      }),
      ["i"],
    ],
    ["self-loop", spec({ channels: ch, nodes: [fn("s", [], ["a"])], edges: [loop("e1", "s", "s")] }), ["s"]],
  ];
  for (const [label, g, expected] of cases) {
    const got = [...indexGraph(g).terminalNodes].sort();
    assert.notEqual(got.length, 0, `${label}: terminalNodes is EMPTY — GRAPH002 and exam.ts both read this`);
    assert.deepEqual(got, [...expected].sort(), label);
  }
});


test("A LOOP-TARGET READER SEES A LOOP-CARRIED WRITE — no GRAPH005", () => {
  // Two directions, and the SECOND is the one a `flowOrder`-only fix would still get wrong.
  //   `fix` reads `findings`, which `audit` writes and reaches through the loop edge.
  //   `audit` reads `applied`, which only `fix` writes — and only on a LATER pass. That is the
  //   cycle, not an order, which is why `flowAncestors` is a closure and not a cut.
  const r = diagnose(canonical());
  assert.equal(r.codes.filter((c) => c === "GRAPH005_UNPRODUCED_READ").length, 0, r.codes.join(", "));

  const idx = indexGraph(canonical());
  assert.ok(idx.flowAncestors.get("fix" as NodeId)?.has("audit" as NodeId), "audit precedes fix");
  assert.ok(idx.flowAncestors.get("audit" as NodeId)?.has("fix" as NodeId), "fix precedes audit, round the loop");
  // And the forward relation is UNCHANGED, which is the §A.73 coupling: `ancestors` still does not
  // walk the loop edge, so `wouldCycle` still asks about forward cycles.
  assert.ok(!(idx.ancestors.get("fix" as NodeId)?.has("audit" as NodeId) ?? false), "`ancestors` is untouched");
});

test("A READER OUTSIDE THE LOOP SEES A WRITE FROM INSIDE IT — two hops of two relations", () => {
  // `harden-config.json`'s third warning, and the one that survived the first cut of this fix.
  // `collate` sits OUTSIDE the cycle, one `conditional` edge off `audit`, and reads a channel only
  // `fix` — inside the cycle — writes. `fix` precedes it through the back-edge and then out, which
  // is "round the loop, then onward": a union of the cut order and the cycle is not closed over
  // that, and the condensation is.
  const s = spec({
    channels: {
      seed: { type: "string", reduce: "replace" },
      applied: { type: "array", reduce: "append_ordered" },
      report: { type: "string", reduce: "replace" },
    },
    inputs: ["seed"],
    outputs: ["report"],
    nodes: [
      fn("audit", ["seed", "applied"], ["findings"]),
      fn("fix", ["findings"], ["applied"]),
      fn("collate", ["applied"], ["report"]),
    ],
    edges: [
      { id: "repair", from: "audit", to: "fix", kind: "conditional", when: "len(applied) < 3" },
      { id: "recheck", from: "fix", to: "audit", kind: "loop", until: "len(applied) >= 3", maxIterations: 8 },
      { id: "done", from: "audit", to: "collate", kind: "conditional", when: "len(applied) >= 3" },
    ],
  });
  const withFindings = {
    ...(s as unknown as Record<string, unknown>),
    channels: { ...(s.channels as Record<string, Chan>), findings: { type: "array", reduce: "replace" } },
  } as unknown as GraphSpec;
  const r = diagnose(withFindings);
  assert.equal(
    r.codes.filter((c) => c === "GRAPH005_UNPRODUCED_READ").length,
    0,
    r.diagnostics.map((x) => `${x.code}: ${x.message}`).join("\n"),
  );
  const idx = indexGraph(withFindings);
  assert.ok(idx.flowAncestors.get("collate" as NodeId)?.has("fix" as NodeId), "fix precedes collate");
});

test("TWO NODES ORDERED ONLY THROUGH A BACK-EDGE ARE NOT CONCURRENT — no GRAPH010", () => {
  // `parse` and `fix` were REFUSED as concurrent writers of a `replace` channel, on a graph where
  // every path to `fix` goes through `audit` and `audit`'s only non-loop inbound edge comes from
  // `parse`. It is an ERROR, so this one did not merely add noise — it made the graph unbuildable
  // and both `fix:` routes it offered led to the entry-node symptom above.
  const r = diagnose(canonical());
  assert.equal(r.codes.filter((c) => c === "GRAPH010_CONCURRENT_WRITE").length, 0, r.codes.join(", "));
});

test("GENUINE CONCURRENCY ACROSS A LOOP IS STILL REFUSED — the cut is what makes that possible", () => {
  // THE CASE THAT DECIDES THE WHOLE DESIGN. A fan-out inside a loop body puts two genuinely
  // concurrent nodes in the SAME cycle, so a fix that answered "ordered?" with the full closure —
  // the relation GRAPH005 correctly wants — would exempt exactly the pair that races. GRAPH010
  // reads `flowOrder`, where the cycle is cut, and still refuses them.
  const s = spec({
    channels: {
      seed: { type: "array", reduce: "append_ordered" },
      items: { type: "array", reduce: "append_ordered" },
      tally: { type: "object", reduce: "replace" },
    },
    inputs: ["seed"],
    nodes: [
      fn("head", ["seed"], ["items"]),
      fn("left", ["items"], ["tally"]),
      fn("right", ["items"], ["tally"]),
      { id: "merge", type: "join", reads: ["tally"], writes: [], join: { branches: ["left", "right"], mode: "all", onBranchError: "fail" } },
    ],
    edges: [
      { id: "l", from: "head", to: "left", kind: "seq" },
      { id: "r", from: "head", to: "right", kind: "seq" },
      { id: "jl", from: "left", to: "merge", kind: "join" },
      { id: "jr", from: "right", to: "merge", kind: "join" },
      { id: "back", from: "merge", to: "head", kind: "loop", until: "len(items) >= 4", maxIterations: 4 },
    ],
  });
  const idx = indexGraph(s);
  // They really are in one cycle: each reaches the other round the back-edge.
  assert.ok(idx.flowAncestors.get("left" as NodeId)?.has("right" as NodeId), "same cycle, both ways");
  assert.ok(idx.flowAncestors.get("right" as NodeId)?.has("left" as NodeId), "same cycle, both ways");
  // And they are NOT ordered, which is the question GRAPH010 asks: `head` reaches each without
  // the other, so neither dominates.
  assert.ok(!idx.dominators.dominates("left" as NodeId, "right" as NodeId));
  assert.ok(!idx.dominators.dominates("right" as NodeId, "left" as NodeId));
  const r = diagnose(s);
  assert.ok(
    r.diagnostics.some(
      (x) => x.code === "GRAPH010_CONCURRENT_WRITE" && x.message.includes('"left"') && x.message.includes('"right"'),
    ),
    r.diagnostics.map((x) => `${x.code}: ${x.message}`).join("\n") || "no diagnostics at all",
  );
});

/**
 * The graph that refuted the first fix for GRAPH010, kept as its own fixture because two tests
 * read it: `start -> summarize`, `start -> scan -> fix`, and `fix -loop-> summarize`, with
 * `summarize` and `fix` both writing one `replace` channel.
 *
 * `fix` reaches `summarize` — but only over the back-edge, so only from pass TWO. On pass one the
 * executor runs `["start","scan","summarize","fix"]` and the two write the same channel with
 * nothing ordering them, which is the race GRAPH010 exists to refuse.
 */
const siblings = (): GraphSpec =>
  spec({
    channels: {
      work: { type: "array", reduce: "append_ordered" },
      report: { type: "object", reduce: "replace" },
    },
    inputs: ["work"],
    nodes: [
      fn("start", ["work"], ["work"]),
      fn("summarize", ["work"], ["report"]),
      fn("scan", ["work"], ["work"]),
      fn("fix", ["work"], ["report", "work"]),
    ],
    edges: [
      { id: "e1", from: "start", to: "summarize", kind: "seq" },
      { id: "e2", from: "start", to: "scan", kind: "seq" },
      { id: "e3", from: "scan", to: "fix", kind: "seq" },
      { id: "e4", from: "fix", to: "summarize", kind: "loop", until: "len(work) >= 3", maxIterations: 4 },
    ],
  });

test("A PAIR ORDERED ONLY FROM PASS TWO IS STILL CONCURRENT — the graph that refuted the first fix", () => {
  // THE DEFECT THIS REPLACED. The first cut of §A.84 gave GRAPH010 a relation built by cutting the
  // cycles out of `flowEdges` with a depth-first walk and reading what was left as "the order the
  // scheduler realises". A DFS only cuts an edge whose target is on the CURRENT PATH, so this
  // graph's `loop` edge was met as a TREE edge and survived — and the relation then claimed
  // `summarize` runs after `fix`, which is true from pass two and false on the pass that races.
  // Base refuses this graph; the first cut compiled it CLEAN.
  //
  // A reason to be SILENT has to hold on every pass, and "some path orders them" does not.
  const r = diagnose(siblings());
  const hit = r.diagnostics.filter((x) => x.code === "GRAPH010_CONCURRENT_WRITE");
  assert.equal(hit.length, 1, r.codes.join(", ") || "compiled clean");
  assert.match(hit[0]!.message, /nodes "(summarize|fix)" and "(summarize|fix)"/, hit[0]!.message);

  // AND THE RELATION ITSELF: neither dominates, because `start -> summarize` reaches `summarize`
  // without going through `fix` at all.
  const idx = indexGraph(siblings());
  assert.ok(!idx.dominators.dominates("fix" as NodeId, "summarize" as NodeId));
  assert.ok(!idx.dominators.dominates("summarize" as NodeId, "fix" as NodeId));
  // …while the PRODUCER relation still sees the loop-carried write, which is the whole reason the
  // two questions get two relations.
  assert.ok(idx.flowAncestors.get("summarize" as NodeId)?.has("fix" as NodeId));
});

test("GRAPH010 DOES NOT DEPEND ON DECLARATION ORDER — the same graph, nodes and edges permuted", () => {
  // The first cut's relation was a property of a TRAVERSAL, so it moved when the author moved a
  // line: 527 of 8,000 permutation-fuzz seeds changed their GRAPH010 set, where the base compiler
  // is stable at 0. Dominance is a property of the GRAPH, so it cannot.
  //
  // Both orderings of the reviewer's own minimal case, which disagreed at head: `n0 -> n1` and
  // `n0 -> n2` with `n2 -loop-> n1`, all three writing one `replace` channel.
  const build = (nodes: readonly string[], edges: readonly Record<string, unknown>[]): GraphSpec =>
    spec({
      channels: { shared: { type: "array", reduce: "replace" } },
      inputs: ["shared"],
      nodes: nodes.map((id) => fn(id, ["shared"], ["shared"])),
      edges: [...edges],
    });
  const E = {
    a: { id: "e0", from: "n0", to: "n1", kind: "seq" },
    b: { id: "e1", from: "n0", to: "n2", kind: "seq" },
    c: { id: "e2", from: "n2", to: "n1", kind: "loop", until: "len(shared) >= 2", maxIterations: 4 },
  };
  const A = build(["n0", "n1", "n2"], [E.a, E.b, E.c]);
  const B = build(["n2", "n1", "n0"], [E.c, E.b, E.a]);
  const g10 = (g: GraphSpec): string[] =>
    diagnose(g)
      .diagnostics.filter((x) => x.code === "GRAPH010_CONCURRENT_WRITE")
      .map((x) => {
        const m = /nodes "([^"]+)" and "([^"]+)"/.exec(x.message);
        return m ? [m[1]!, m[2]!].sort().join("~") : x.message;
      })
      .sort();
  assert.deepEqual(g10(A), g10(B), "the same graph written two ways gave two answers");
  assert.notEqual(g10(A).length, 0, "both orderings agree on saying nothing — the fixture stopped racing");
});

test("A REAL CYCLE IN NON-LOOP EDGES IS STILL REFUSED — GRAPH006 reads the DAG, and must", () => {
  // The reason `dagEdges` and `topoOrder` do not move. "The forward graph contains a cycle" is a
  // question about the graph WITHOUT its declared back-edges, by definition, so an undeclared one
  // has to stay visible to it.
  const r = diagnose(
    spec({
      channels: { a: { type: "array", reduce: "append_ordered" } },
      nodes: [fn("one", ["a"], ["a"]), fn("two", ["a"], ["a"])],
      edges: [
        { id: "down", from: "one", to: "two", kind: "seq" },
        { id: "up", from: "two", to: "one", kind: "seq" },
      ],
    }),
  );
  assert.ok(r.codes.includes("GRAPH006_UNMARKED_CYCLE"), r.codes.join(", "));
  assert.equal(r.ok, false);
});

test("A `compensation` EDGE IS HANDLED THE WAY THE SITE'S WRITTEN REASON SAYS — out of all three", () => {
  // The row's own caution: the exclusion "drops `compensation` too, with a written reason for that
  // kind", so this is not one filter to widen. The reason is that NOTHING TRAVERSES ONE —
  // `Engine.#edgesToTake` answers `case "compensation": break;` and rollback is journal-driven —
  // which is the same predicate `graph/mutate.ts`'s `traversable` uses. Three consequences, all
  // driven here rather than asserted in prose:
  const s = spec({
    channels: {
      seed: { type: "string", reduce: "replace" },
      out: { type: "object", reduce: "replace" },
      undone: { type: "object", reduce: "replace" },
    },
    inputs: ["seed"],
    nodes: [fn("act", ["seed"], ["out"]), fn("rollback", ["out"], ["undone"])],
    edges: [{ id: "comp", from: "act", to: "rollback", kind: "compensation", compensates: "act" }],
  });
  const idx = indexGraph(s);
  // (1) Its TARGET is not an entry node — it would otherwise run at the start of the run, before
  //     the action it is declared to undo, and be the only thing that ever scheduled it.
  assert.deepEqual([...idx.entryNodes], ["act"]);
  // (2) It is not in `flowEdges`, so it orders nothing: `act` does not precede `rollback` for the
  //     producer question, exactly as it did not under `ancestors`.
  assert.ok(!idx.flowEdges.some((e) => e.kind === "compensation"));
  assert.ok(!(idx.flowAncestors.get("rollback" as NodeId)?.has("act" as NodeId) ?? false));
  assert.ok(!(idx.ancestors.get("rollback" as NodeId)?.has("act" as NodeId) ?? false));
  // (3) Its SOURCE still has no traversable way out, so `act` is terminal — a compensation edge
  //     is a declaration, not a continuation.
  assert.ok(idx.terminalNodes.includes("act" as NodeId), idx.terminalNodes.join(", "));
});

test("`flowEdges` IS `mutate.ts`'s `traversable`, member for member — one predicate, two files", () => {
  // Both say "every kind but `compensation`", and if they ever disagree, one of dominance
  // analysis and ordering analysis is looking at a graph the executor does not run. `error` is
  // the member worth naming: `#errorEdges` dispatches it on failure, so it is traversable and it
  // is in.
  const idx = indexGraph(
    spec({
      channels: { a: { type: "object", reduce: "replace" } },
      nodes: [fn("one", [], ["a"]), fn("two", ["a"], ["a"]), fn("three", ["a"], ["a"]), fn("four", ["a"], ["a"])],
      edges: [
        { id: "s", from: "one", to: "two", kind: "seq" },
        { id: "e", from: "two", to: "three", kind: "error", codes: ["E_TASK_TIMEOUT"] },
        { id: "l", from: "three", to: "two", kind: "loop", until: "has(a)", maxIterations: 2 },
        { id: "c", from: "two", to: "four", kind: "compensation", compensates: "two" },
      ],
    }),
  );
  assert.deepEqual(
    idx.flowEdges.map((e) => e.id).sort(),
    ["e", "l", "s"],
    "flowEdges must be every kind but compensation",
  );
});

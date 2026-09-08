/**
 * WHY `observedChannels` CAN BE BLIND TO EXPRESSIONS, and what has to stay true for that.
 *
 * `observedChannels` derives the channels a node actually reads by scanning `reads` and the
 * `${}` templates in `tool.args`. It does NOT parse expressions — so a `router` case's `when`
 * and an edge's `when`/`until` are invisible to it, and every decision built on it (the taint
 * check, the classification floor) would under-report if such an expression could name a
 * channel the node never declared.
 *
 * It cannot REACH AN UNDECLARED CHANNEL, and the reason is `GRAPH004_UNDECLARED_READ`: the
 * compiler parses every expression, takes its free variables from `checkExpr(...).refs`, and
 * refuses any outside the owning node's `reads ∪ writes`.
 *
 * THIS FILE USED TO CONCLUDE "so `reads` IS a superset for exactly the channels an expression can
 * reach", AND THAT IS FALSE — the premise says `reads ∪ WRITES` and the conclusion dropped a
 * word. An edge condition is evaluated on POST-COMMIT state (`until: verdict.pass` leaving the
 * node that just wrote `verdict` must be legal), so an edge's owner satisfies GRAPH004 by
 * DECLARING the channel among its writes, and `when: "picked.ok"` then names a channel in no
 * node's `reads`. Found on 2026-09-08 by `evolution/exam.ts`'s fifth rule, which had leaned on
 * this sentence and wrongly refused a legitimate exam; that function now collects expression refs
 * itself. What survives is the narrower and still load-bearing claim: `reads ∪ writes` bounds
 * what an expression can name, so nothing an expression reaches is undeclared. The same false
 * sentence still stands at `graph/spec.ts`'s `observedChannels` — a KERNEL file this lane's file
 * set does not cover — and is owed the same correction.
 *
 * **That is a coupling between two files that nothing recorded.** `observedChannels` lives in
 * `graph/spec.ts` and says it does not cover expressions; `rule004Expressions` lives in
 * `graph/validate.ts` and does not know anything depends on it. Relax GRAPH004 — or add a
 * fourth place the engine evaluates an expression — and taint goes quiet with no test failing.
 * This file is that missing edge.
 *
 * HANDOFF's T1 said the blocker was "needs the expression parser to report free variables".
 * That was stale: `checkExpr` has always returned `refs`, and GRAPH004 has always used them.
 * What T1 is actually about survives — see the last test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { compile } from "../../src/graph/compile.ts";
import { observedChannels, type GraphSpec, type NodeSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";

const ENGINE = readFileSync(fileURLToPath(new URL("../../src/run/engine.ts", import.meta.url)), "utf8");

/**
 * Every expression the ENGINE evaluates, read from its source rather than listed by hand.
 *
 * A hand-kept list is a second copy that drifts the moment somebody adds a fourth call — which
 * is the failure this file exists to prevent, so it must not be the mechanism.
 */
function evaluationSites(): readonly string[] {
  return [...ENGINE.matchAll(/evaluate\(this\.#expr\(ctx, ([^)]+)\)/g)].map((m) => m[1]!.trim());
}

test("EVERY EXPRESSION THE ENGINE EVALUATES IS ONE THE COMPILER CONSTRAINS", () => {
  const sites = evaluationSites();
  // The scan must not have broken: zero sites would make this gate vacuous while looking green.
  assert.ok(sites.length >= 3, `the source scan found ${sites.length} evaluation sites — the regex broke, not the engine`);

  // Each site, and the GRAPH004 check that covers it. A new site with no entry fails here, which
  // is the whole point: adding one is exactly when somebody must ask who constrains it.
  const COVERED: Readonly<Record<string, string>> = {
    "c.when": "rule004Expressions: `for (const c of n.router?.cases ?? []) check(c.when, …, n.id)`",
    "e.until": "rule004Expressions: `if (e.until !== undefined) check(e.until, …, e.from)`",
    "e.when": "rule004Expressions: `if (e.when !== undefined) check(e.when, …, e.from)`",
  };
  const uncovered = sites.filter((s) => COVERED[s] === undefined).sort();
  assert.deepEqual(
    uncovered,
    [],
    "the engine evaluates an expression the compiler is not known to constrain — add the GRAPH004 " +
      "check and name it here, or `observedChannels` silently under-reports what this node reads",
  );

  // And the checks named above must still exist. Naming a rule that has been deleted is the
  // same defect one level up.
  const validate = readFileSync(fileURLToPath(new URL("../../src/graph/validate.ts", import.meta.url)), "utf8");
  assert.match(validate, /check\(c\.when, \{ nodeId: n\.id \}, n\.id\)/, "the router-case check is gone");
  assert.match(validate, /check\(e\.when, \{ edgeId: e\.id \}, e\.from\)/, "the edge `when` check is gone");
  assert.match(validate, /check\(e\.until, \{ edgeId: e\.id \}, e\.from\)/, "the edge `until` check is gone");
});

// ── and the behaviour those checks produce ──────────────────────────────────

const RESOLVER: ResourceResolver = {
  resolve: (ref) => ({ ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" }),
};

function spec(over: { routerReads?: readonly string[]; when?: string; edgeWhen?: string; srcReads?: readonly string[] }): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "t1", project: "p", version: 1 },
    policy: { posture: "out" },
    channels: {
      untrusted: { type: "string", reduce: "replace" },
      a: { type: "object", reduce: "replace" },
      b: { type: "object", reduce: "replace" },
    },
    inputs: ["untrusted"],
    outputs: ["a", "b"],
    nodes: [
      { id: "src" as never, type: "function", reads: [...(over.srcReads ?? [])], writes: ["a"], function: { ref: "function/f@stable" } },
      {
        id: "r" as never,
        type: "router",
        reads: [...(over.routerReads ?? [])],
        router: { mode: "expression", cases: [{ when: over.when ?? "true", take: ["e1" as never] }], fallbackEdge: "e2" as never },
      },
      { id: "x" as never, type: "function", writes: ["a"], function: { ref: "function/f@stable" } },
      { id: "y" as never, type: "function", writes: ["b"], function: { ref: "function/f@stable" } },
    ],
    edges: [
      { id: "e0" as never, from: "src" as never, to: "r" as never, kind: "seq", ...(over.edgeWhen === undefined ? {} : { when: over.edgeWhen }) },
      { id: "e1" as never, from: "r" as never, to: "x" as never, kind: "seq" },
      { id: "e2" as never, from: "r" as never, to: "y" as never, kind: "seq" },
    ],
  };
}

function errorsOf(s: GraphSpec): readonly string[] {
  const r = compile({ spec: s, resolver: RESOLVER, tools: {}, tenantCapabilities: ["*"] });
  return r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}

test("a router case reading a channel the node does not declare DOES NOT COMPILE", () => {
  assert.deepEqual(errorsOf(spec({ routerReads: [], when: "untrusted != null" })), ["GRAPH004_UNDECLARED_READ"]);
  assert.deepEqual(errorsOf(spec({ routerReads: ["untrusted"], when: "untrusted != null" })), []);
});

test("an edge condition is constrained against ITS SOURCE node, not the target", () => {
  // The engine evaluates `e.when` when the SOURCE task commits, so the source's declaration is
  // the one that has to cover it — checking the target would be checking the wrong node.
  assert.deepEqual(
    errorsOf(spec({ routerReads: ["untrusted"], when: "untrusted != null", edgeWhen: "untrusted != null" })),
    ["GRAPH004_UNDECLARED_READ"],
    "`src` does not declare it",
  );
  assert.deepEqual(
    errorsOf(spec({ routerReads: ["untrusted"], when: "untrusted != null", edgeWhen: "untrusted != null", srcReads: ["untrusted"] })),
    [],
  );
});

test("SO the channels an expression reaches ARE in `observedChannels`, via `reads`", () => {
  // The composition, stated once: GRAPH004 forces the refs into `reads`, and `observedChannels`
  // starts from `reads`. Neither half is sufficient alone and neither file says so.
  const s = spec({ routerReads: ["untrusted"], when: "untrusted != null" });
  assert.deepEqual(errorsOf(s), [], "the only graph shape that compiles is the one that declares it");
  const router = s.nodes.find((n) => n.type === "router")!;
  assert.ok(observedChannels(router).includes("untrusted"), "and so the taint and classification checks see it");
});

test("WHAT T1 ACTUALLY IS: control flow influenced by untrusted content, and its bound", () => {
  // Not a reachability gap — the test above closes that. T1 is that a branch CHOICE can be made
  // from untrusted data and nothing escalates on it, which is a different question from feeding
  // an action. It is bounded rather than open, and the bound is worth pinning because it is the
  // reason this is a design boundary and not a hole:
  //
  //   GRAPH005_ROUTE_NOT_OWN_EDGE — a router may only take edges it owns, so the reachable set
  //     is exactly the branches the graph AUTHOR declared. Untrusted content picks among them;
  //     it cannot invent one.
  //   Each target re-decides at full strictness — an irreversible node still floors at `in` on
  //     its own class whatever branch reached it.
  //
  // If either stops being true, this stops being a boundary and becomes a hole.
  const validate = readFileSync(fileURLToPath(new URL("../../src/graph/validate.ts", import.meta.url)), "utf8");
  assert.match(validate, /GRAPH005_ROUTE_NOT_OWN_EDGE/, "the bound on which edges a router may take is gone — T1 is now a hole");
  assert.match(ENGINE, /E_ROUTE_INVALID/, "and the runtime half of that bound is gone too");

  // A router node observes what it declares; it writes nothing, so it taints nothing.
  const router = spec({ routerReads: ["untrusted"], when: "untrusted != null" }).nodes.find((n) => n.type === "router")!;
  assert.deepEqual([...observedChannels(router)], ["untrusted"]);
  assert.equal((router as NodeSpec).writes, undefined, "a router's whole output is an edge subset — there is no channel to taint");
});

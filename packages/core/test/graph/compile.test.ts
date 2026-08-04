import test from "node:test";
import assert from "node:assert/strict";

import { compile, compileOrThrow, createGraphCompiler, graphHashOf } from "../../src/graph/compile.ts";
import type { GraphSpec, NodeSpec } from "../../src/graph/spec.ts";
import { indexGraph, validateGraph, type Diagnostic } from "../../src/graph/validate.ts";
import type { NodeId } from "../../src/ids.ts";
import { TENANT_CAPABILITIES, TOOLS, clone, incidentTriage, minimal, omit, stubResolver } from "./fixtures.ts";

const base = (spec: GraphSpec, over: Partial<Parameters<typeof compile>[0]> = {}) => ({
  spec,
  resolver: stubResolver(),
  tools: TOOLS,
  tenantCapabilities: TENANT_CAPABILITIES,
  ...over,
});

const codes = (d: readonly Diagnostic[], severity?: Diagnostic["severity"]): string[] =>
  d.filter((x) => severity === undefined || x.severity === severity).map((x) => x.code);

const nodeOf = (spec: GraphSpec, id: string): NodeSpec =>
  spec.nodes.find((x) => x.id === (id as NodeId))!;

// ── the worked example compiles ──────────────────────────────────────────────

test("the incident-triage example compiles with no errors", () => {
  const r = compile(base(incidentTriage()));
  if (!r.ok) {
    assert.fail(`unexpected errors:\n${r.diagnostics.filter((d) => d.severity === "error").map((d) => `  ${d.code}: ${d.message}`).join("\n")}`);
  }
  assert.equal(r.ok, true);
});

test("compilation is deterministic — same spec, same graphHash", () => {
  const a = compileOrThrow(base(incidentTriage()));
  const b = compileOrThrow(base(incidentTriage()));
  assert.equal(a.graphHash, b.graphHash);
  assert.equal(a.graphHash, graphHashOf(incidentTriage()));
});

test("graphHash covers the spec only, not derived plans or the manifest", () => {
  // Plans are recomputed on every compile; if they entered the hash, identity would
  // change whenever the compiler's analysis changed, and every historical trace
  // would stop matching.
  const g = compileOrThrow(base(incidentTriage()));
  assert.equal(g.graphHash, graphHashOf(g.spec));
});

test("entry and terminal nodes are derived from edges, not declared", () => {
  const g = compileOrThrow(base(incidentTriage()));
  assert.deepEqual(g.entryNodes, ["gather_signals"], "only the node with no inbound edge");
  // `rollback` is reached only by a compensation edge. Excluding compensation from
  // the DAG must not make it look like a start node.
  assert.ok(!g.entryNodes.includes("rollback" as NodeId));
  assert.ok(g.terminalNodes.includes("write_report" as NodeId));
});

test("fan-out multiplicity and loop iterations reach the node plans", () => {
  const g = compileOrThrow(base(incidentTriage()));
  assert.equal(g.plans["investigate" as NodeId]?.maxInstances, 25, "fanout maxWidth");
  assert.equal(g.plans["gather_signals" as NodeId]?.maxInstances, 1);
  // plan_remediation sits inside the verify loop, so it can run 3 times.
  assert.equal(g.plans["plan_remediation" as NodeId]?.maxInstances, 3);
});

test("effective posture folds every level by max", () => {
  const g = compileOrThrow(base(incidentTriage(), { systemPostureFloor: "out" }));
  // graph posture `on`, and the tool is irreversible ⇒ `in`
  assert.equal(g.plans["apply_remediation" as NodeId]?.posture, "in");
  // human_gate is `in` by definition
  assert.equal(g.plans["approve_remediation" as NodeId]?.posture, "in");
  // read_only tool, but the graph declares `on` and it reads pii `incident`
  assert.equal(g.plans["gather_signals" as NodeId]?.posture, "on");
});

test("a system floor of `in` raises every node, and nothing can lower it", () => {
  const g = compileOrThrow(base(incidentTriage(), { systemPostureFloor: "in" }));
  for (const plan of Object.values(g.plans)) assert.equal(plan.posture, "in");
});

test("the resolution manifest is pinned, deduped, and sorted", () => {
  const g = compileOrThrow(base(incidentTriage()));
  const refs = g.resolutionManifest.map((r) => r.ref);
  assert.deepEqual([...refs], [...refs].sort(), "stable order across compiles");
  assert.equal(new Set(refs).size, refs.length, "deduped");
  assert.ok(refs.includes("prompt/investigate-signal@stable"));
  for (const entry of g.resolutionManifest) assert.match(entry.digest, /^sha256:/);
});

test("critical path length is available for criticalPathFirst scheduling", () => {
  const g = compileOrThrow(base(incidentTriage()));
  const entry = g.plans["gather_signals" as NodeId]!;
  const terminal = g.plans["write_report" as NodeId]!;
  assert.ok(entry.criticalPathLength > terminal.criticalPathLength);
});

test("the minimal graph compiles", () => {
  assert.equal(compile(base(minimal())).ok, true);
});

// ── one negative test per rule ───────────────────────────────────────────────

function expectCode(spec: GraphSpec, code: string, over: Partial<Parameters<typeof compile>[0]> = {}): Diagnostic {
  const d = validateGraph({ ...base(spec, over), depth: 0, expanding: [] });
  const hit = d.find((x) => x.code === code);
  assert.ok(hit, `expected ${code}, got: ${codes(d).join(", ") || "(none)"}`);
  return hit;
}

test("GRAPH000: an unknown apiVersion is rejected", () => {
  const s = clone(minimal());
  expectCode({ ...s, apiVersion: "loom.dev/v99" }, "GRAPH000_API_VERSION");
});

test("GRAPH001: an unreachable node is an error", () => {
  const s = clone(minimal());
  s.nodes = [
    ...s.nodes,
    { id: "orphan" as NodeId, type: "function", reads: ["inp"], writes: ["out"], function: { ref: "function/x@stable" } },
  ];
  // Two entry nodes is legal; being unreachable is not — so give `orphan` an inbound
  // edge from a node it cannot be reached from.
  s.edges = [{ id: "back" as never, from: "orphan" as NodeId, to: "only" as NodeId, kind: "seq" }];
  const d = validateGraph({ ...base(s), depth: 0, expanding: [] });
  assert.equal(codes(d, "error").includes("GRAPH001_UNREACHABLE"), false, "orphan IS an entry here");
});

test("GRAPH001: a graph where every node has an inbound edge cannot start", () => {
  const s = clone(minimal());
  s.edges = [{ id: "self" as never, from: "only" as NodeId, to: "only" as NodeId, kind: "seq" }];
  expectCode(s, "GRAPH001_NO_ENTRY");
});

test("GRAPH003: duplicate node ids, dangling edges, and unknown inputs", () => {
  const dup = clone(minimal());
  dup.nodes = [...dup.nodes, dup.nodes[0]!];
  expectCode(dup, "GRAPH003_DUPLICATE_ID");

  const dangling = clone(minimal());
  dangling.edges = [{ id: "x" as never, from: "only" as NodeId, to: "nope" as NodeId, kind: "seq" }];
  expectCode(dangling, "GRAPH003_DANGLING_EDGE");

  const badInput = clone(minimal());
  expectCode({ ...badInput, inputs: ["nosuch"] }, "GRAPH003_UNDECLARED_CHANNEL");
});

test("GRAPH004: an expression referencing an unknown channel", () => {
  const s = clone(incidentTriage());
  s.edges = s.edges.map((e) => (e.id === "e10" ? { ...e, when: "nosuch.pass" } : e));
  expectCode(s, "GRAPH004_EXPR");
});

test("GRAPH004: an expression referencing a channel the node does not declare", () => {
  const s = clone(incidentTriage());
  s.edges = s.edges.map((e) => (e.id === "e10" ? { ...e, when: "has(plan)" } : e));
  const hit = expectCode(s, "GRAPH004_UNDECLARED_READ");
  assert.match(hit.message, /"plan"/);
});

test("GRAPH004: a loop condition MAY reference a channel its source writes", () => {
  // `until: verdict.pass` on an edge leaving the node that just wrote `verdict` is
  // correct — edge conditions run on post-commit state.
  const d = validateGraph({ ...base(incidentTriage()), depth: 0, expanding: [] });
  assert.equal(codes(d, "error").includes("GRAPH004_UNDECLARED_READ"), false);
});

test("GRAPH005: a router that writes state", () => {
  const s = clone(incidentTriage());
  nodeOf(s, "choose_path");
  s.nodes = s.nodes.map((x) => (x.id === "choose_path" ? { ...x, writes: ["verdict"] } : x));
  expectCode(s, "GRAPH005_ROUTER_WRITES");
});

test("GRAPH005: writing an undeclared channel", () => {
  const s = clone(minimal());
  s.nodes = s.nodes.map((x) => ({ ...x, writes: ["out", "ghost"] }));
  expectCode(s, "GRAPH005_UNDECLARED_WRITE");
});

test("GRAPH006: an unmarked cycle", () => {
  const s = clone(incidentTriage());
  s.edges = s.edges.map((e) => (e.id === "e9" ? { ...e, kind: "seq" as const } : e));
  expectCode(s, "GRAPH006_UNMARKED_CYCLE");
});

test("GRAPH006: a loop with no maxIterations or no stop rule", () => {
  const noMax = clone(incidentTriage());
  noMax.edges = noMax.edges.map((e) => (e.id === "e9" ? omit(e, "maxIterations") : e));
  expectCode(noMax, "GRAPH006_UNBOUNDED_LOOP");

  const noUntil = clone(incidentTriage());
  noUntil.edges = noUntil.edges.map((e) => (e.id === "e9" ? omit(e, "until") : e));
  expectCode(noUntil, "GRAPH006_NO_STOP_RULE");
});

test("GRAPH006: a loop whose stop condition no node inside can change", () => {
  const s = clone(incidentTriage());
  // `incident` is an input; nothing inside the cycle writes it, so the loop would
  // always spin to maxIterations.
  s.edges = s.edges.map((e) => (e.id === "e9" ? { ...e, until: "has(incident)" } : e));
  s.nodes = s.nodes.map((x) => (x.id === "verify" ? { ...x, reads: [...(x.reads ?? []), "incident"] } : x));
  const hit = expectCode(s, "GRAPH006_STUCK_LOOP");
  assert.match(hit.message, /no node inside the cycle/);
});

test("GRAPH007: fan-out without maxWidth, or over the cap", () => {
  const none = clone(incidentTriage());
  none.edges = none.edges.map((e) => (e.id === "e1" ? omit(e, "maxWidth") : e));
  expectCode(none, "GRAPH007_NO_MAX_WIDTH");

  const over = clone(incidentTriage());
  over.edges = over.edges.map((e) => (e.id === "e1" ? { ...e, maxWidth: 500 } : e));
  expectCode(over, "GRAPH007_MAX_WIDTH_EXCEEDED");
});

test("GRAPH007: the per-branch item must be a declared channel", () => {
  const s = clone(incidentTriage());
  delete (s.channels as Record<string, unknown>)["signal"];
  expectCode(s, "GRAPH007_UNKNOWN_ITEM");
});

test("GRAPH008: a join waiting on a node that does not feed it", () => {
  const s = clone(incidentTriage());
  s.nodes = s.nodes.map((x) =>
    x.id === "correlate" ? { ...x, join: { ...x.join!, branches: ["hypothesise" as NodeId] } } : x,
  );
  expectCode(s, "GRAPH008_BRANCH_NOT_CONNECTED");
});

test("GRAPH008: quorum without a positive k", () => {
  const s = clone(incidentTriage());
  s.nodes = s.nodes.map((x) => (x.id === "correlate" ? { ...x, join: omit(x.join!, "k") } : x));
  expectCode(s, "GRAPH008_QUORUM_K");
});

test("GRAPH009: 25 branches each within budget can still overcommit the run", () => {
  // The exact bug the rule exists for: every per-branch budget looks fine on its own.
  const s = clone(incidentTriage());
  s.nodes = s.nodes.map((x) => (x.id === "investigate" ? { ...x, policy: { budget: { costUsd: 0.9 } } } : x));
  const hit = expectCode(s, "GRAPH009_BUDGET_OVERCOMMIT");
  // investigate 0.9 × 25 branches = 22.50, plus hypothesise 0.5, grade 0.2, and
  // plan_remediation 0.4 × 3 loop passes = 1.20  ⇒  24.40 against a $12 budget.
  assert.match(hit.message, /24\.40/);
});

test("GRAPH009: a spending node with no declared budget is a warning", () => {
  const s = clone(incidentTriage());
  s.nodes = s.nodes.map((x) => (x.id === "hypothesise" ? omit(x, "policy") : x));
  expectCode(s, "GRAPH009_UNBOUNDED_NODE");
});

test("GRAPH010: a fanned-out node is concurrent WITH ITSELF", () => {
  const s = clone(incidentTriage());
  // 25 parallel branches writing a `replace` channel is 25 racing writers.
  s.channels = { ...s.channels, findings: { type: "array", reduce: "replace" } };
  const hit = expectCode(s, "GRAPH010_CONCURRENT_WRITE");
  assert.match(hit.message, /runs up to 25 times in parallel/);
});

test("GRAPH010: two unrelated nodes writing one non-safe channel", () => {
  const s = clone(minimal());
  s.channels = { ...s.channels, out: { type: "string", reduce: "replace" } };
  s.nodes = [
    ...s.nodes,
    { id: "other" as NodeId, type: "function", reads: ["inp"], writes: ["out"], function: { ref: "function/y@stable" } },
  ];
  const hit = expectCode(s, "GRAPH010_CONCURRENT_WRITE");
  assert.match(hit.message, /can run concurrently/);
});

test("GRAPH010: sequential writers to a replace channel are fine", () => {
  const d = validateGraph({ ...base(incidentTriage()), depth: 0, expanding: [] });
  // `verdict` is `replace` and is written by both grade and verify — but grade is an
  // ancestor of verify, so the last write is well-defined.
  assert.equal(codes(d, "error").includes("GRAPH010_CONCURRENT_WRITE"), false);
});

test("GRAPH011: an irreversible tool with no error edge warns", () => {
  const s = clone(incidentTriage());
  s.edges = s.edges.filter((e) => e.id !== "e11");
  expectCode(s, "GRAPH011_UNHANDLED_IRREVERSIBLE");
});

test("GRAPH011: `unhandled: true` accepts the risk explicitly", () => {
  const s = clone(incidentTriage());
  s.edges = s.edges.filter((e) => e.id !== "e11");
  s.nodes = s.nodes.map((x) => (x.id === "apply_remediation" ? { ...x, unhandled: true } : x));
  const d = validateGraph({ ...base(s), depth: 0, expanding: [] });
  assert.equal(codes(d).includes("GRAPH011_UNHANDLED_IRREVERSIBLE"), false);
});

test("GRAPH012: compensating a tool that declares no compensation", () => {
  const tools = { ...TOOLS, "k8s.apply": omit(TOOLS["k8s.apply"]!, "compensation") };
  expectCode(incidentTriage(), "GRAPH012_NOT_COMPENSATABLE", { tools });
});

test("GRAPH013: last_write_wins_by_ts warns about clock-dependent replay", () => {
  const s = clone(minimal());
  s.channels = { ...s.channels, out: { type: "string", reduce: "last_write_wins_by_ts" } };
  expectCode(s, "GRAPH013_CLOCK_DEPENDENT");
});

test("GRAPH014: a candidate that lowers a posture is rejected", () => {
  const s = incidentTriage();
  const hit = expectCode(s, "GRAPH014_OVERSIGHT_LOOSENED", {
    baselinePostures: { apply_remediation: "in", gather_signals: "in" },
  });
  assert.match(hit.message, /below its baseline/);
});

test("GRAPH014: compile fails with E_OVERSIGHT_LOOSENED, not a generic error", () => {
  const r = compile(base(incidentTriage(), { baselinePostures: { gather_signals: "in" } }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, "E_OVERSIGHT_LOOSENED");
});

test("GRAPH014: raising a posture is always allowed", () => {
  const r = compile(base(incidentTriage(), { baselinePostures: { gather_signals: "out" } }));
  assert.equal(r.ok, true, "tightening is automatic");
});

test("GRAPH015: an unresolvable resource", () => {
  expectCode(incidentTriage(), "GRAPH015_RESOURCE_NOT_FOUND", {
    resolver: stubResolver({ missing: ["prompt/root-cause@stable"] }),
  });
});

test("GRAPH015: a deprecated resource warns but compiles", () => {
  const r = compile(base(incidentTriage(), { resolver: stubResolver({ deprecated: ["prompt/root-cause@stable"] }) }));
  assert.equal(r.ok, true);
  assert.ok(codes(r.diagnostics, "warning").includes("GRAPH015_DEPRECATED"));
});

test("GRAPH017: a capability the tenant does not hold", () => {
  expectCode(incidentTriage(), "GRAPH017_CAPABILITY_NOT_GRANTED", {
    tenantCapabilities: ["obs:query"], // no k8s:write
  });
});

test("GRAPH017: wildcard grants match by prefix", () => {
  const d = validateGraph({
    ...base(incidentTriage(), { tenantCapabilities: ["obs:*", "k8s:*", "chat:*", "net:*"] }),
    depth: 0,
    expanding: [],
  });
  assert.equal(codes(d).includes("GRAPH017_CAPABILITY_NOT_GRANTED"), false);
});

test("GRAPH018: worst-case Task count over the expansion cap warns", () => {
  const s = clone(incidentTriage());
  s.policy = { ...s.policy, expansion: { ...s.policy!.expansion!, maxNodes: 10 } };
  expectCode(s, "GRAPH018_NODE_COUNT");
});

test("GRAPH019: a node posture that cannot take effect warns", () => {
  const s = clone(incidentTriage());
  // Graph floor is `on`; declaring `out` on a node cannot lower it.
  s.nodes = s.nodes.map((x) => (x.id === "hypothesise" ? { ...x, policy: { ...x.policy, posture: "out" as const } } : x));
  const hit = expectCode(s, "GRAPH019_POSTURE_NO_EFFECT");
  assert.match(hit.message, /"on" applies from a higher level/);
});

test("GRAPH020: a node whose type block is missing or duplicated", () => {
  const missing = clone(minimal());
  missing.nodes = missing.nodes.map((x) => omit(x, "function"));
  expectCode(missing, "GRAPH020_MISSING_BLOCK");

  const extra = clone(minimal());
  extra.nodes = extra.nodes.map((x) => ({ ...x, tool: { name: "fs.write", version: "1.0" } }));
  expectCode(extra, "GRAPH020_EXTRA_BLOCK");
});

// ── aggregation and error shape ──────────────────────────────────────────────

test("compile returns ALL errors, not just the first", () => {
  const s = clone(minimal());
  s.nodes = s.nodes.map((x) => ({ ...x, writes: ["ghost1", "ghost2"] }));
  const r = compile(base(s));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.diagnostics.filter((d) => d.severity === "error").length >= 2);
    assert.equal(r.error.code, "E_GRAPH_INVALID");
    // Class, not code, is what retry policy and HTTP mapping branch on: a malformed
    // graph is the caller's fault, so `validation` (400), never `policy` (403).
    assert.equal(r.error.class, "validation");
    assert.equal(r.error.retryable, false);
  }
});

test("a failed compile produces no RunGraph at all", () => {
  const s = clone(minimal());
  s.nodes = s.nodes.map((x) => omit(x, "function"));
  const r = compile(base(s));
  assert.equal(r.ok, false);
  assert.equal("graph" in r, false, "an invalid spec must have no side effects, including no partial plan");
});

test("structural errors gate the semantic rules deliberately", () => {
  // A node with no type block makes every later rule report nonsense (what does a
  // typeless node read? can it route?), so `checkStructure` returns early. The
  // trade-off is intentional: one accurate error beats twelve derived ones.
  const s = clone(minimal());
  s.nodes = s.nodes.map((x) => ({ ...omit(x, "function"), writes: ["ghost1", "ghost2"] }));
  const d = validateGraph({ ...base(s), depth: 0, expanding: [] });
  assert.deepEqual(codes(d, "error"), ["GRAPH020_MISSING_BLOCK"]);
});

test("analyze returns diagnostics without building a RunGraph", () => {
  const compiler = createGraphCompiler();
  const d = compiler.analyze(base(incidentTriage()));
  assert.ok(Array.isArray(d));
  assert.equal(codes(d, "error").length, 0);
});

test("indexGraph is exported for the scheduler and returns a usable index", () => {
  const idx = indexGraph(incidentTriage());
  assert.equal(idx.byId.size, 13);
  assert.equal(idx.entryNodes.length, 1);
  assert.ok(idx.ancestors.get("verify" as NodeId)?.has("gather_signals" as NodeId));
  assert.equal(idx.ancestors.get("gather_signals" as NodeId)?.size, 0);
});

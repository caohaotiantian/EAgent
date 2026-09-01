import test from "node:test";
import assert from "node:assert/strict";

import { compile, compileOrThrow, createGraphCompiler, graphHashOf } from "../../src/graph/compile.ts";
import type { GraphSpec, NodeSpec } from "../../src/graph/spec.ts";
import { indexGraph, validateGraph, type Diagnostic } from "../../src/graph/validate.ts";
import { ROOT_BRANCH, childBranch, encodeBranch, taskId, type EdgeId, type NodeId } from "../../src/ids.ts";
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

test("EVERY NODE THAT CAN BLOCK CARRIES A DEADLINE, and the author's own always wins", () => {
  // A node declaring no `timeoutMs` had NO deadline: `#withNodeDeadline` returned straight
  // through, so a hanging tool held its Task forever and a join over that branch waited with it.
  // The fix is `NodePlan.timeoutMs`, the shape `NodePlan.retry` already set.
  //
  // THE SET IS NAMED, not counted, and this fixture is the only one in the tree that carries all
  // eight node types at once — which is why the whole rule fits in one test.
  const g = compileOrThrow(base(incidentTriage()));
  const ms = (id: string): number | undefined => g.plans[id as NodeId]?.timeoutMs;

  // Declared, and untouched at both ends of the range — a default is a floor for nodes that
  // declared nothing, never an override and never a merge.
  assert.equal(ms("gather_signals"), 20_000, "a tool node's own 20s stands");
  assert.equal(ms("investigate"), 120_000, "and an agent node's own 120s is not raised to the default");

  // Defaulted: the three types whose BODY can fail to settle — an agent awaits a provider stream
  // no clock in this tree bounds, a tool awaits an extension's `execute`, and an evaluator's
  // `rubric` arm is `#runAgent` again.
  assert.equal(ms("hypothesise"), 600_000, "agent");
  assert.equal(ms("apply_remediation"), 600_000, "tool");
  assert.equal(ms("grade"), 600_000, "evaluator");

  // AND FOUR OF THE FIVE WITH NONE, each named — `compile.ts`'s `effectiveTimeout` says why for
  // each. `human_gate` is the one that MUST stay absent: it has `slaMs` plus `onTimeout`, and a
  // gate that expires because nobody wrote a number is oversight failing open. The fifth is
  // `subgraph`, which this fixture has none of — `effectiveTimeout` says why it gets none too.
  for (const id of ["correlate", "choose_path", "approve_remediation", "write_report"]) {
    assert.equal(ms(id), undefined, `${id} must not be given one`);
  }
  assert.deepEqual(
    incidentTriage()
      .nodes.filter((x) => ["correlate", "choose_path", "approve_remediation", "write_report"].includes(x.id))
      .map((x) => x.type)
      .sort(),
    ["function", "human_gate", "join", "router"],
    "the four ids above really are one of each excluded type",
  );
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

test("cpuBound IS REFUSED, because there is no worker pool and the field promised one", () => {
  // Two deleted design documents said the opposite of the code — the `function` row of D2's node
  // table ("Runs in a worker thread if `cpuBound: true`") and D3's pool diagram — while
  // `packages/core/src` has no `worker_threads` import at all. A bespoke warning
  // (`GRAPH019_CPUBOUND_NO_EFFECT`) used to stand in for the pool. The field is deleted, so the
  // generic unknown-field refusal answers instead and the graph does not compile.
  //
  // Measured before the field went, because "nothing reads it" and "it does not run in parallel"
  // are different claims: two independent `cpuBound: true` function nodes took 2646 ms of compute
  // against 1325 ms for one — 1.997x, exactly serial — and four took 5.989x on 16 cores. An
  // author declaring it across a fan-out believed it was N-way and it was 1-way.
  const plain = clone(minimal());
  assert.deepEqual(
    codes(compile(base(plain)).diagnostics).filter((c) => c === "GRAPH020_UNKNOWN_FIELD"),
    [],
    "a graph that does not declare it must compile clean",
  );

  const s = clone(minimal());
  s.nodes = s.nodes.map((x) => ({ ...x, function: { ...(x.function as object), cpuBound: true } })) as unknown as typeof s.nodes;
  const r = compile(base(s));
  const d = r.diagnostics;
  const hit = d.find((x) => x.code === "GRAPH020_UNKNOWN_FIELD");
  assert.equal(r.ok, false, "a graph declaring cpuBound must not compile");
  assert.ok(hit !== undefined, `expected the refusal; got ${codes(d).join(", ") || "nothing"}`);
  assert.match(hit.message, /cpuBound/, "the message must name the field the author wrote");
  assert.equal(hit.severity, "error");
  // The honest cost of the deletion, asserted rather than argued: the author used to read "the
  // body runs on the main thread and blocks it" and now reads a list of two field names. The
  // route out lives in `FunctionNode`'s docstring and in this test, not in the message.
  assert.match(hit.fix ?? "", /ref/);
  assert.doesNotMatch(hit.fix ?? "", /cpuBound/, "the removed field must not be offered back");
});

test("GRAPH020: a node whose type block is missing or duplicated", () => {
  const missing = clone(minimal());
  missing.nodes = missing.nodes.map((x) => omit(x, "function"));
  expectCode(missing, "GRAPH020_MISSING_BLOCK");

  const extra = clone(minimal());
  extra.nodes = extra.nodes.map((x) => ({ ...x, tool: { name: "fs.write", version: "1.0" } }));
  expectCode(extra, "GRAPH020_EXTRA_BLOCK");
});

// ── GRAPH003: the id charset every derived id depends on ─────────────────────

/** `minimal()` plus a second node, so there is an edge whose id can be varied. */
function twoNode(edgeId: string): GraphSpec {
  const s = clone(minimal());
  s.nodes = [
    ...s.nodes,
    { id: "second" as NodeId, type: "function", reads: ["out"], writes: ["out"], function: { ref: "function/x@stable" } },
  ];
  s.edges = [{ id: edgeId as EdgeId, from: "only" as NodeId, to: "second" as NodeId, kind: "seq" }];
  return s;
}

test("GRAPH003: a node id carrying a character TaskId derivation reserves", () => {
  // `taskId` is `nodeId@branchPath#iteration` and `effectKey` joins on `:`, so an id
  // holding one of those separators is not a name — it is a second parse of somebody
  // else's id. Reproduced before this rule existed: `id: "a@b"` compiled with an empty
  // diagnostics array and `advance` then threw `malformed branch coordinate: b@root`,
  // after events naming the undecodable path were already durable.
  for (const bad of ["a@b", "a#b", "a/b", "a[0]", "a]b[", "a:b", "__proto__", "", " lead", "-lead"]) {
    const s = clone(minimal());
    s.nodes = s.nodes.map((x) => ({ ...x, id: bad as NodeId }));
    const hit = expectCode(s, "GRAPH003_BAD_ID");
    assert.equal(hit.severity, "error", `"${bad}" must fail the compile, not warn`);
  }
});

test("GRAPH003: an edge id is held to the same charset, because branch paths are built from it", () => {
  for (const bad of ["e/f", "e[0]", "e@x", "e#x", "e:x", ""]) {
    expectCode(twoNode(bad), "GRAPH003_BAD_ID");
  }
  assert.equal(compile(base(twoNode("e-1.a_b"))).ok, true, "the ordinary charset still compiles");
});

test("GRAPH003: an id that is not a string at all is refused rather than coerced", () => {
  // `extractMutation` casts model output to `NodeSpec[]`/`EdgeSpec[]` without checking
  // field types, and `compileMutation` re-runs this validator over the result — so the
  // runtime really can hand the compiler a number or an object here.
  const s = clone(minimal());
  s.nodes = s.nodes.map((x) => ({ ...x, id: 42 as unknown as NodeId }));
  expectCode(s, "GRAPH003_BAD_ID");
  expectCode(twoNode(null as unknown as string), "GRAPH003_BAD_ID");
});

test("GRAPH003: the edge-id charset is what makes branch encoding injective", () => {
  // `encodeBranch` joins segments with `/` and writes each as `edgeId[index]`, so it is
  // NOT injective over unrestricted edge ids: two different coordinates encode to one
  // string, and `taskId` then names one Task for two branches (invariant 3), while
  // `compareBranch` still orders them strictly (invariant 7). Nothing in `ids.ts`
  // prevents that — the compiler is the only thing that does, by making the colliding
  // edge id unreachable.
  const nested = childBranch(childBranch(ROOT_BRANCH, "a", 0), "b", 3);
  const single = childBranch(ROOT_BRANCH, "a[0]/b", 3);
  assert.equal(encodeBranch(nested), encodeBranch(single), "encodeBranch alone does not separate these");
  assert.equal(taskId("n" as NodeId, nested), taskId("n" as NodeId, single), "…so neither does taskId");
  expectCode(twoNode("a[0]/b"), "GRAPH003_BAD_ID");
});

test("GRAPH003: a channel name is an object key, so `__proto__` is refused there too", () => {
  // Built through JSON so the key is an OWN property — `{__proto__: …}` in a literal is
  // the prototype, not a key. `initialState` assigns `out[name] = spec.initial`, which
  // for this one name writes the prototype and declares no channel at all.
  const s = clone(minimal());
  s.channels = JSON.parse('{"inp":{"type":"string","reduce":"replace"},"out":{"type":"string","reduce":"replace"},"__proto__":{"type":"object","reduce":"replace"}}') as GraphSpec["channels"];
  const hit = expectCode(s, "GRAPH003_BAD_ID");
  assert.match(hit.message, /__proto__/);
});

// ── GRAPH003/GRAPH005: `in` is not "declared" ────────────────────────────────

test("GRAPH005: a channel every object inherits is not a declared channel", () => {
  // `w in spec.channels` answers true for every name on `Object.prototype`, while the
  // state layer asks `hasOwnProperty` — so this compiled clean and then died at run time
  // with an untyped internal error instead of E_CHANNEL_UNDECLARED (see the `declared`
  // docstring in state/channels.ts).
  const w = clone(minimal());
  w.nodes = w.nodes.map((x) => ({ ...x, writes: ["out", "toString"] }));
  expectCode(w, "GRAPH005_UNDECLARED_WRITE");

  const r = clone(minimal());
  r.nodes = r.nodes.map((x) => ({ ...x, reads: ["inp", "constructor"] }));
  expectCode(r, "GRAPH005_UNDECLARED_READ");

  const io = clone(minimal());
  expectCode({ ...io, inputs: ["valueOf"] }, "GRAPH003_UNDECLARED_CHANNEL");
});

test("GRAPH007: a fan-out over an inherited name is not a fan-out over a channel", () => {
  const over = clone(incidentTriage());
  over.edges = over.edges.map((e) => (e.id === "e1" ? { ...e, over: "hasOwnProperty" } : e));
  expectCode(over, "GRAPH007_UNKNOWN_OVER");

  const as = clone(incidentTriage());
  as.edges = as.edges.map((e) => (e.id === "e1" ? { ...e, as: "toString" } : e));
  expectCode(as, "GRAPH007_UNKNOWN_ITEM");
});

// ── GRAPH020: a type outside the taxonomy ────────────────────────────────────

test("GRAPH020: a node whose type is not a NodeType is refused at compile", () => {
  // The missing-block check keyed on `REQUIRED_BLOCK[n.type]`, which is `undefined` for a
  // type outside the union — so the node was skipped by both halves of GRAPH020 and
  // compiled with a zero-length diagnostics array. `#dispatch` then has no case for it,
  // returns `undefined`, and the run dies on a raw TypeError rather than on a diagnostic.
  for (const bogus of ["functoin", "Function", "human-gate", ""] as string[]) {
    const s = clone(minimal());
    s.nodes = s.nodes.map((x) => ({ ...x, type: bogus as NodeSpec["type"] }));
    const hit = expectCode(s, "GRAPH020_UNKNOWN_TYPE");
    assert.equal(hit.fix, "use one of function, agent, tool, router, join, evaluator, human_gate, subgraph");
  }
});

test("GRAPH020: a type naming an Object.prototype member is not a node type either", () => {
  // `!(n.type in REQUIRED_BLOCK)` would let these through: `"toString" in REQUIRED_BLOCK`
  // is true and `REQUIRED_BLOCK["toString"]` is a Function, so the guard has to ask
  // `Object.hasOwn`.
  for (const bogus of ["toString", "constructor", "__proto__"] as string[]) {
    const s = clone(minimal());
    s.nodes = s.nodes.map((x) => ({ ...x, type: bogus as NodeSpec["type"] }));
    expectCode(s, "GRAPH020_UNKNOWN_TYPE");
  }
});

test("GRAPH020: every real node type still compiles", () => {
  // The guard must not become a ninth thing that decides what a node type is.
  const d = validateGraph({ ...base(incidentTriage()), depth: 0, expanding: [] });
  assert.equal(codes(d).includes("GRAPH020_UNKNOWN_TYPE"), false);
});

// ── GRAPH004 + GRAPH005: the router mode nothing implements ──────────────────

const withRouterMode = (mode: "expression" | "model", when?: string): GraphSpec => {
  const s = clone(incidentTriage());
  s.nodes = s.nodes.map((x) => {
    if (x.id !== "choose_path") return x;
    const router = x.router!;
    const cases = when === undefined ? router.cases : [{ when, take: router.cases[0]!.take }];
    return mode === "model"
      ? { ...x, router: { mode, cases, fallbackEdge: router.fallbackEdge, profile: "agent_profile/sre-lead@stable" } }
      : { ...x, router: { mode, cases, fallbackEdge: router.fallbackEdge } };
  });
  return s;
};

test("GRAPH005: a router asking for the unimplemented `model` mode is refused", () => {
  // `#runRouter` never reads `router.mode` — it evaluates `cases[].when` whatever the
  // mode says. So `mode: "model"` compiled clean, pinned a model profile in the
  // resolution manifest that is never called, and ran "a fixed expression picks the
  // branch" under a graph that reads "a model picks the branch".
  const hit = expectCode(withRouterMode("model"), "GRAPH005_ROUTER_MODE_UNSUPPORTED");
  assert.equal(hit.severity, "error");
});

test("GRAPH004: a router's `when` is checked in EVERY mode", () => {
  // The check ran only for `mode === "expression"`, so declaring the unbuilt mode also
  // switched off the expression rules for that node. These two assertions are the half
  // that must survive whoever implements the mode and deletes the refusal above.
  for (const mode of ["expression", "model"] as const) {
    expectCode(withRouterMode(mode, "this is not ( valid"), "GRAPH004_EXPR");
    expectCode(withRouterMode(mode, "nosuchchannel == 1"), "GRAPH004_EXPR");
    expectCode(withRouterMode(mode, "has(plan)"), "GRAPH004_UNDECLARED_READ");
  }
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

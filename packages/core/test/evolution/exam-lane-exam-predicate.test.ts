/**
 * What makes a graph an exam, what makes one attestable, and how a grade's inputs are built —
 * `evolution/exam.ts`'s pure half, checked without a workspace.
 *
 * The rules are the design's (§4.5 and §4.1 of `docs/design-property3-2026-09-05.md`), and each
 * test here names the attack the rule refuses: a rubric or agent node would let a model grade the
 * work (S4 dressed as S1); a node reading `subject` could grade by run id; an exam over outputs
 * alone is the two-sided fixture with the fixture moved outside; an exam that reads only
 * evaluator-written outputs is grading the grader — which is `review-bench` as it shipped.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, NodeSpec, RunGraph } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId } from "../../src/ids.ts";
import { attestationOf, attestationProblems, examInputsFor, examShape, verdictOf } from "../../src/evolution/exam.ts";
import { resolver } from "../run/skeleton.ts";

const compileOf = (spec: GraphSpec): RunGraph => compileOrThrow({ spec, resolver: resolver(), tools: {}, tenantCapabilities: [] });

const channels = (names: readonly string[]): GraphSpec["channels"] =>
  Object.fromEntries(names.map((n) => [n, { type: n === "subject" ? "string" : n === "verdict" ? "object" : "array", reduce: "replace" as const }]));

/** The design's `pick-exam`: reads the recorded `items` and the terminal `picked`, writes `verdict`. */
function examSpec(over: Partial<GraphSpec> & { nodes?: NodeSpec[] } = {}): GraphSpec {
  const inputs = over.inputs ?? ["subject", "items", "picked"];
  const reads = inputs.filter((c) => c !== "subject");
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "pick-exam", project: "demo", version: 1 },
    policy: { posture: "out", capabilities: [] },
    channels: channels([...new Set([...inputs, "verdict"])]),
    inputs,
    outputs: ["verdict"],
    nodes: [
      {
        id: "grade" as NodeId,
        type: "evaluator",
        reads,
        writes: ["verdict"],
        evaluator: { kind: "assertion", ref: "function/exam-pick@stable", threshold: 0.5 },
      },
    ],
    edges: [],
    ...over,
  };
}

/** The baseline: `pick` writes `picked`, `check` grades it, both declared as outputs. */
function baselineSpec(outputs: readonly string[] = ["picked", "verdict"]): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "pick-bench", project: "demo", version: 1 },
    policy: { posture: "out", capabilities: [] },
    channels: channels(["items", "picked", "verdict"]),
    inputs: ["items"],
    outputs,
    nodes: [
      { id: "pick" as NodeId, type: "function", reads: ["items"], writes: ["picked"], function: { ref: "function/pick@stable" } },
      { id: "check" as NodeId, type: "evaluator", reads: ["items", "picked"], writes: ["verdict"], evaluator: { kind: "assertion", ref: "function/check@stable", threshold: 0.5 } },
    ],
    edges: [{ id: "e" as EdgeId, from: "pick" as NodeId, to: "check" as NodeId, kind: "seq" }],
  };
}

// ── examShape ────────────────────────────────────────────────────────────────

test("the design's pick-exam IS an exam, and the rules are silent on it", () => {
  assert.deepEqual(examShape(compileOf(examSpec())), []);
});

test("an exam needs `subject` among its inputs — it is how a grade names the run it graded", () => {
  const problems = examShape(compileOf(examSpec({ inputs: ["items", "picked"] })));
  assert.ok(problems.some((p) => /"subject" among its inputs/.test(p)), problems.join("\n"));
});

test("an exam has exactly one output, `verdict`", () => {
  const spec = examSpec();
  const two = compileOf({
    ...spec,
    channels: { ...spec.channels, note: { type: "string", reduce: "replace" } },
    outputs: ["verdict", "note"],
    nodes: [{ ...spec.nodes[0]!, writes: ["verdict", "note"] }],
  });
  assert.ok(examShape(two).some((p) => /exactly one output, "verdict"/.test(p)));
});

test("an agent, tool, subgraph, human_gate or rubric node disqualifies — deterministic bodies only", () => {
  const spec = examSpec();
  const grade = spec.nodes[0]!;
  const withAgent = compileOf({
    ...spec,
    channels: { ...spec.channels, opinion: { type: "string", reduce: "replace" } },
    nodes: [
      { id: "judge" as NodeId, type: "agent", reads: ["items"], writes: ["opinion"], agent: { profile: "agent_profile/x@stable", prompt: "prompt/p@stable", maxTurns: 1 } },
      { ...grade, reads: [...(grade.reads ?? []), "opinion"] },
    ],
    edges: [{ id: "e" as EdgeId, from: "judge" as NodeId, to: "grade" as NodeId, kind: "seq" }],
  });
  const problems = examShape(withAgent);
  assert.ok(problems.some((p) => /"judge" is a agent/.test(p)), problems.join("\n"));

  const rubric = compileOf({ ...spec, nodes: [{ ...grade, evaluator: { kind: "rubric", ref: "rubric/r@stable", threshold: 0.5 } }] });
  const r = examShape(rubric);
  assert.ok(r.some((p) => /rubric evaluator/.test(p)), r.join("\n"));
  assert.ok(r.some((p) => /terminal node must be an evaluator\{kind:"assertion"\}/.test(p)), "a rubric terminal is refused twice, by two rules");
});

test("no node may read `subject`", () => {
  const spec = examSpec();
  const grade = spec.nodes[0]!;
  const problems = examShape(compileOf({ ...spec, nodes: [{ ...grade, reads: [...(grade.reads ?? []), "subject"] }] }));
  assert.ok(problems.some((p) => /reads "subject"/.test(p)), problems.join("\n"));
});

test("the terminal node is the assertion evaluator that writes verdict — a function terminal is refused", () => {
  const spec = examSpec();
  const grade = spec.nodes[0]!;
  const problems = examShape(
    compileOf({
      ...spec,
      channels: { ...spec.channels, raw: { type: "object", reduce: "replace" } },
      nodes: [
        { ...grade, writes: ["raw"] },
        { id: "wrap" as NodeId, type: "function", reads: ["raw"], writes: ["verdict"], function: { ref: "function/wrap@stable" } },
      ],
      edges: [{ id: "e" as EdgeId, from: "grade" as NodeId, to: "wrap" as NodeId, kind: "seq" }],
    }),
  );
  assert.ok(problems.some((p) => /terminal node must be an evaluator/.test(p) && /"wrap", a function/.test(p)), problems.join("\n"));
});

/**
 * THE FIFTH RULE. The baseline-OUTPUT rule in `attestationProblems` constrains what an exam
 * DECLARES; this one constrains what its nodes READ. Recorded as the exam lane's residue
 * (`report.md` ~410-420, "never reading it attests") and as CLAUDE.md §3's weakest assumption,
 * "enforced by SHAPE only": an exam declaring `picked` whose grading node reads only `items` sees
 * the question and never the answer, exactly like the `blind-exam` fixture that IS refused, and
 * at 3d05cff it attested exit 0.
 */
test("a declared exam input no node reads is refused, and the refusal names it", () => {
  const spec = examSpec();
  const grade = spec.nodes[0]!;
  // Declares [subject, items, picked]; reads ["items"]. `picked` is unreachable: the assertion
  // arm scopes the body's view to `node.reads` (measured 2026-09-08), so `view.get("picked")` is
  // `undefined` however the body is written.
  const problems = examShape(compileOf({ ...spec, nodes: [{ ...grade, reads: ["items"] }] }));
  assert.ok(problems.some((p) => /read by no node/.test(p) && /"picked"/.test(p)), problems.join("\n"));
  assert.ok(!problems.some((p) => /"items"/.test(p)), `only the unread channel is named: ${problems.join("\n")}`);
});

test("`subject` is exempt — rule four already refuses a node that reads it", () => {
  // The control that keeps the fifth rule from making every exam unattestable: `pick-exam` reads
  // no `subject` by construction and is still silent.
  assert.deepEqual(examShape(compileOf(examSpec())), []);
});

test("a TRANSITIVE read satisfies the rule — the input need not be read by the terminal node", () => {
  const spec = examSpec();
  const grade = spec.nodes[0]!;
  const twoStep = compileOf({
    ...spec,
    channels: { ...spec.channels, want: { type: "array", reduce: "replace" } },
    nodes: [
      { id: "derive" as NodeId, type: "function", reads: ["items"], writes: ["want"], function: { ref: "function/derive@stable" } },
      { ...grade, reads: ["want", "picked"] },
    ],
    edges: [{ id: "e" as EdgeId, from: "derive" as NodeId, to: "grade" as NodeId, kind: "seq" }],
  });
  assert.deepEqual(examShape(twoStep), [], "`items` is read by `derive`, which is a node");
});

/**
 * A FANOUT EDGE'S `over` IS COUNTED, and it is the second place the rule looks. `rule007` checks
 * `e.over` against `spec.channels` alone (`validate.ts` GRAPH007_UNKNOWN_OVER), never against the
 * source node's `reads`, so this exam NAMES `picked` while no node declares it — and counting only
 * `reads` would refuse every fanout exam there is. The first cut of the rule refused this one and
 * told the operator "read by no node", which was a false sentence printed at a refusal.
 */
test("a channel a FANOUT edge fans over is read, though no node declares it", () => {
  const spec = examSpec();
  const fan = compileOf({
    ...spec,
    channels: {
      ...spec.channels,
      one: { type: "object", reduce: "replace" },
      part: { type: "array", reduce: "append_ordered" },
    },
    nodes: [
      { id: "start" as NodeId, type: "function", reads: ["items"], writes: ["part"], function: { ref: "function/pick@stable" } },
      { id: "each" as NodeId, type: "function", reads: ["one"], writes: ["part"], function: { ref: "function/pick@stable" } },
      { id: "gather" as NodeId, type: "join", reads: ["part"], writes: [], join: { branches: ["each" as NodeId], mode: "all", onBranchError: "fail" } },
      { id: "grade" as NodeId, type: "evaluator", reads: ["part"], writes: ["verdict"], evaluator: { kind: "assertion", ref: "function/exam-pick@stable", threshold: 0 } },
    ],
    edges: [
      { id: "f" as EdgeId, from: "start" as NodeId, to: "each" as NodeId, kind: "fanout", over: "picked", as: "one", maxWidth: 4 },
      { id: "j" as EdgeId, from: "each" as NodeId, to: "gather" as NodeId, kind: "join", branches: ["each" as NodeId] },
      { id: "g" as EdgeId, from: "gather" as NodeId, to: "grade" as NodeId, kind: "seq" },
    ],
  });
  assert.deepEqual(examShape(fan), [], "`picked` reaches the graph through edge `f`.over");
});

/**
 * AN EDGE CONDITION IS NOT A READ, AND THIS TEST FLIPPED TO SAY SO.
 *
 * It used to assert the opposite — `when: "picked.ok"` on a conditional edge counted, because the
 * `rule004Expressions` lets an edge's owner satisfy GRAPH004 by DECLARING the channel among its
 * `writes`, so the condition names a channel in no node's `reads` and no fanout `over`. Counting it
 * was true of that condition and false of the RULE. Driven at `5b46f86`: a graph of this shape ran
 * its graded node and wrote a verdict with `picked.ok` false, having never seen `picked` — one
 * measurement, and enough, because the rule has no way to tell that graph from this one.
 *
 * The spec carries a resource ref rather than a body, so the rule cannot tell which conditions the
 * executor evaluates and counts NONE of them. THE COST IS REAL AND STATED: an exam whose only
 * mention of the run's answer is an edge condition must name it in a node's `reads`, and the
 * refusal tells the operator exactly that.
 */
test("an edge condition is NOT a read — a producing body's `take` can skip it, so the rule fails closed", () => {
  const spec = examSpec();
  const grade = spec.nodes[0]!;
  const viaExpr = compileOf({
    ...spec,
    channels: { ...spec.channels, picked: { type: "object", reduce: "replace" } },
    nodes: [
      { id: "step" as NodeId, type: "function", reads: ["items"], writes: ["picked"], function: { ref: "function/pick@stable" } },
      { ...grade, reads: ["items"] },
    ],
    edges: [{ id: "e" as EdgeId, from: "step" as NodeId, to: "grade" as NodeId, kind: "conditional", when: "picked.ok" }],
  });
  const problems = examShape(viaExpr);
  assert.ok(problems.some((p) => /read by no node/.test(p) && /"picked"/.test(p)), problems.join("\n"));
  // AND THE REFUSAL SAYS WHAT TO DO, because this is the shape the design call knowingly costs.
  assert.ok(problems.some((p) => /EDGE CONDITION does not count either/.test(p) && /Name it where a read happens/.test(p)), `the refusal must name the cost: ${problems.join("\n")}`);
});

/**
 * THE SHAPE THAT DECIDED IT, as a spec rather than as a prose citation. `step`'s body returns
 * a `take` at run time; nothing in this spec says so, and nothing can. At `5b46f86` this exam
 * attested and its grader never saw `picked`.
 */
test("the `take`-bypass shape is refused — and the spec that produces it is indistinguishable from the one above", () => {
  const spec = examSpec();
  const grade = spec.nodes[0]!;
  const taking = compileOf({
    ...spec,
    channels: { ...spec.channels, picked: { type: "object", reduce: "replace" } },
    nodes: [
      // The body that made this shape blind at `5b46f86` returned a `take`. `function/pick` is a
      // resolvable ref and the ref is all the SPEC carries — which is the point: the
      // predicate sees this graph and the previous one as the same graph, so it must answer both
      // the same way, and the safe answer is the refusing one.
      { id: "step" as NodeId, type: "function", reads: ["items"], writes: ["picked"], function: { ref: "function/pick@stable" } },
      { ...grade, reads: ["items"] },
    ],
    edges: [{ id: "e" as EdgeId, from: "step" as NodeId, to: "grade" as NodeId, kind: "conditional", when: "picked.ok" }],
  });
  assert.ok(examShape(taking).some((p) => /"picked".*read by no node/s.test(p)));
});

/**
 * EVERY OTHER PLACEMENT OF A CONDITION, refused for the same one reason rather than for four.
 * The rule does not ask where the condition sits or whether this particular one would be evaluated;
 * it counts no condition at all. ONE rule now covers what a placement filter used to enumerate,
 * which is why the filter is gone — and refusing conditions that would in fact have run is the
 * stated cost rather than an oversight.
 */
test("no placement of a condition counts, whatever the edge kind", () => {
  const spec = examSpec();
  const grade = spec.nodes[0]!;
  const cond = (kind: string, over: Record<string, unknown>): readonly string[] =>
    examShape(
      compileOf({
        ...spec,
        channels: { ...spec.channels, picked: { type: "object", reduce: "replace" } },
        nodes: [
          { id: "step" as NodeId, type: "function", reads: ["items"], writes: ["picked"], function: { ref: "function/pick@stable" } },
          { ...grade, reads: ["items"] },
        ],
        edges: [{ id: "e" as EdgeId, from: "step" as NodeId, to: "grade" as NodeId, kind, ...over } as never],
      }),
    );
  for (const [label, kind, over] of [
    ["a seq edge's `when`", "seq", { when: "picked.ok" }],
    ["a conditional's `until`", "conditional", { until: "picked.ok" }],
    ["a conditional's `when`", "conditional", { when: "picked.ok" }],
  ] as const) {
    assert.ok(cond(kind, over).some((p) => /read by no node/.test(p)), `${label} must not count`);
  }
});

/**
 * THE ORDINARY HALF, and it is what stops the change from being "refuse everything". The two places
 * the rule DOES count a channel — a node's own `reads` and a fanout's `over` — still count, on the
 * same fixture shape the conditions above are refused on. This test passes at base too — it is the
 * control, and what it detects is either counted route ceasing to count.
 */
test("the reads that DO count still count — a node's `reads` and a fanout's `over`", () => {
  const spec = examSpec();
  const grade = spec.nodes[0]!;
  assert.deepEqual(
    examShape(compileOf({ ...spec, nodes: [{ ...grade, reads: ["items", "picked"] }] })),
    [],
    "route 1: the grader declares it",
  );
  const fan = compileOf({
    ...spec,
    channels: { ...spec.channels, one: { type: "object", reduce: "replace" }, part: { type: "array", reduce: "append_ordered" } },
    nodes: [
      { id: "start" as NodeId, type: "function", reads: ["items"], writes: ["part"], function: { ref: "function/pick@stable" } },
      { id: "each" as NodeId, type: "function", reads: ["one"], writes: ["part"], function: { ref: "function/pick@stable" } },
      { id: "gather" as NodeId, type: "join", reads: ["part"], writes: [], join: { branches: ["each" as NodeId], mode: "all", onBranchError: "fail" } },
      { id: "grade" as NodeId, type: "evaluator", reads: ["part"], writes: ["verdict"], evaluator: { kind: "assertion", ref: "function/exam-pick@stable", threshold: 0 } },
    ],
    edges: [
      { id: "f" as EdgeId, from: "start" as NodeId, to: "each" as NodeId, kind: "fanout", over: "picked", as: "one", maxWidth: 4 },
      { id: "j" as EdgeId, from: "each" as NodeId, to: "gather" as NodeId, kind: "join", branches: ["each" as NodeId] },
      { id: "g" as EdgeId, from: "gather" as NodeId, to: "grade" as NodeId, kind: "seq" },
    ],
  });
  assert.deepEqual(examShape(fan), [], "route 2: the fanout consumes it");
});

/**
 * A ROUTER CASE'S `when` WAS NEVER A ROUTE, and dropping it with the rest cost nothing. A router
 * may not declare `writes` (`GRAPH005_ROUTER_WRITES`), so GRAPH004 forces every case's free
 * variable into the router's own `reads`, where route 1 already has it. This test passed before
 * the term existed, while it existed, and now that it is gone — which is what "dead code" means
 * and why it is stated here rather than in a comment beside a term nobody can reach.
 */
test("a ROUTER case's `when` was never a route — GRAPH004 forces it into the router's own reads", () => {
  const spec = examSpec();
  const grade = spec.nodes[0]!;
  const viaRouter = compileOf({
    ...spec,
    channels: { ...spec.channels, picked: { type: "object", reduce: "replace" } },
    nodes: [
      { id: "step" as NodeId, type: "function", reads: ["items"], writes: ["picked"], function: { ref: "function/pick@stable" } },
      { id: "pick-branch" as NodeId, type: "router", reads: ["picked"], writes: [], router: { mode: "expression", cases: [{ when: "picked.ok", take: ["y" as EdgeId] }], fallbackEdge: "y" as EdgeId } },
      { ...grade, reads: ["items"] },
    ],
    edges: [
      { id: "x" as EdgeId, from: "step" as NodeId, to: "pick-branch" as NodeId, kind: "seq" },
      { id: "y" as EdgeId, from: "pick-branch" as NodeId, to: "grade" as NodeId, kind: "seq" },
    ],
  });
  assert.deepEqual(examShape(viaRouter), [], "`picked` is in the router's `reads` — route 1, not a condition");
});

/**
 * THE RESIDUE, PINNED RATHER THAN ASSERTED. The rule asks whether SOME node reads the channel, not
 * whether the reading reaches the terminal grader. `sink` reads `picked` and writes a channel
 * nobody reads; the assertion evaluator sees only `items`, so the grade is as blind as the exam
 * the rule refuses — and this is admitted. Closing it needs dataflow reachability from each
 * declared input to the terminal node, which is a second analysis and is deliberately not built
 * here. This test exists so the hole is a checked fact and not a sentence in a docstring: if a
 * later change closes it, this fails and the docstring is corrected with it.
 */
test("A NODE THAT READS AND DISCARDS SATISFIES THE RULE — the admitted residue, pinned", () => {
  const spec = examSpec();
  const grade = spec.nodes[0]!;
  const sunk = compileOf({
    ...spec,
    channels: { ...spec.channels, junk: { type: "array", reduce: "replace" } },
    nodes: [
      { id: "sink" as NodeId, type: "function", reads: ["picked"], writes: ["junk"], function: { ref: "function/sink@stable" } },
      { ...grade, reads: ["items"] },
    ],
    edges: [{ id: "e" as EdgeId, from: "sink" as NodeId, to: "grade" as NodeId, kind: "seq" }],
  });
  assert.deepEqual(examShape(sunk), [], "the grader never sees `picked`, and the fifth rule does not notice");
});

// ── attestationProblems ──────────────────────────────────────────────────────

test("pick-exam over pick-bench (picked declared as an output) attests cleanly", () => {
  assert.deepEqual(attestationProblems(examSpec(), baselineSpec()), []);
});

test("an exam input the baseline declares nowhere is refused — it would grade every recording fail", () => {
  const p = attestationProblems(examSpec({ inputs: ["subject", "items", "chosen"] }), baselineSpec());
  assert.ok(p.some((x) => /"chosen" are declared by the baseline graph neither/.test(x)), p.join("\n"));
});

test("an exam that reads no baseline INPUT is the two-sided fixture moved outside — refused", () => {
  const p = attestationProblems(examSpec({ inputs: ["subject", "picked"] }), baselineSpec());
  assert.ok(p.some((x) => /reads no baseline INPUT/.test(x)), p.join("\n"));
});

/**
 * THE MIRROR OF THE RULE ABOVE, and it was missing for three review rounds.
 *
 * `attestationProblems` refused an exam that reads no baseline INPUT — the two-sided fixture, the
 * candidate writing both question and answer — and said nothing about one that reads no baseline
 * OUTPUT. An exam over `[subject, items]` alone sees the QUESTION and never the run's answer, so
 * whatever body it carries it is measuring nothing about the run it grades; an always-pass one
 * attests exit 0 and grades every recording `pass`. That is CLAUDE.md's first defect lens exactly
 * — a guard answering its undecidable case with the passing value — sitting on the guard property
 * 3 rests on.
 *
 * THE OUTPUT HAS TO BE ONE THE RECORDING DID NOT SUPPLY. A channel that is both an input and an
 * output of the work graph does not count, because `examInputsFor` resolves that collision in
 * favour of the RECORDED input — the exam would be handed the question under the answer's name.
 * So the test is the same `outputReads` set the grading-the-grader rule already computes.
 */
test("AN EXAM THAT READS NO BASELINE OUTPUT IS REFUSED — it sees the question and never the answer", () => {
  const p = attestationProblems(examSpec({ inputs: ["subject", "items"] }), baselineSpec());
  assert.ok(p.some((x) => /reads no baseline OUTPUT/.test(x)), p.join("\n"));
  // The control: the shipped shape reads `items` AND `picked` and still attests cleanly.
  assert.deepEqual(attestationProblems(examSpec(), baselineSpec()), []);
});

test("A CHANNEL THAT IS BOTH AN INPUT AND AN OUTPUT IS NOT AN ANSWER — the recording wins the collision, so it does not satisfy the rule", () => {
  const b = baselineSpec();
  const both: GraphSpec = { ...b, outputs: [...b.outputs, "items"] };
  const p = attestationProblems(examSpec({ inputs: ["subject", "items"] }), both);
  assert.ok(p.some((x) => /reads no baseline OUTPUT/.test(x)), p.join("\n"));
  // …and the same exam reading a real output alongside it is fine.
  assert.deepEqual(attestationProblems(examSpec({ inputs: ["subject", "items", "picked"] }), both), []);
});

test("GRADING THE GRADER IS REFUSED: every baseline output the exam reads is evaluator-written", () => {
  // `review-bench` as shipped: six declared outputs, all written by evaluator nodes. Here the
  // same shape in miniature — the baseline declares only `verdict`, and the exam reads it.
  const p = attestationProblems(examSpec({ inputs: ["subject", "items", "verdict"] }), baselineSpec(["verdict"]));
  assert.ok(p.some((x) => /grading the grader/.test(x)), p.join("\n"));
});

test("an exam does not read `verdict` — it is its own output — and a body with declared effects is not deterministic", () => {
  const spec = examSpec();
  const p = examShape(compileOf(examSpec({ inputs: ["subject", "items", "picked", "verdict"] })));
  assert.ok(p.some((x) => /does not read "verdict"/.test(x)), p.join("\n"));
  const grade = spec.nodes[0]!;
  const withEffects = compileOf({
    ...spec,
    channels: { ...spec.channels, fetched: { type: "object", reduce: "replace" } },
    nodes: [
      { id: "look" as NodeId, type: "function", reads: ["items"], writes: ["fetched"], function: { ref: "function/look@stable", effects: ["net.fetch"] } },
      { ...grade, reads: [...(grade.reads ?? []), "fetched"] },
    ],
    edges: [{ id: "e" as EdgeId, from: "look" as NodeId, to: "grade" as NodeId, kind: "seq" }],
  });
  const q = examShape(withEffects);
  assert.ok(q.some((x) => /"look" declares effects \["net.fetch"\]/.test(x)), q.join("\n"));
});

test("a baseline that declares a channel named `subject` is refused — the link from grade to run must not be a graph's to write", () => {
  const b = baselineSpec();
  const p = attestationProblems(examSpec(), { ...b, channels: { ...b.channels, subject: { type: "string", reduce: "replace" } } });
  assert.ok(p.some((x) => /declares a channel named "subject"/.test(x)), p.join("\n"));
});

test("an exam named like the workflow is refused — its runs would count as recordings of it", () => {
  const p = attestationProblems(examSpec({ metadata: { name: "pick-bench", project: "demo", version: 1 } }), baselineSpec());
  assert.ok(p.some((x) => /the workflow's own name/.test(x)), p.join("\n"));
});

// ── examInputsFor ────────────────────────────────────────────────────────────

test("inputs are drawn from the recording and the terminal outputs, and `subject` is added", () => {
  const r = examInputsFor(examSpec(), "run_1", { items: ["a", "b"] }, { picked: ["a", "b"], verdict: { pass: true } });
  assert.ok(r.ok);
  assert.deepEqual(r.inputs, { items: ["a", "b"], picked: ["a", "b"], subject: "run_1" });
  assert.deepEqual(r.collisions, []);
});

test("A MISSING EXAM INPUT IS UNGRADABLE — the work-deleting candidate's shape", () => {
  // No `picked` in the terminal outputs: the candidate deleted the node that wrote it.
  const r = examInputsFor(examSpec(), "run_1", { items: ["a"] }, { verdict: { pass: true } });
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(r.missing, ["picked"]);
});

test("a channel that is both a recorded input and a terminal output resolves to the RECORDING, and is reported", () => {
  const r = examInputsFor(examSpec(), "run_1", { items: ["a", "b"] }, { items: ["a"], picked: ["a"] });
  assert.ok(r.ok);
  assert.deepEqual(r.inputs["items"], ["a", "b"], "the recording is the question; a graph that overwrote it does not re-ask");
  assert.deepEqual(r.collisions, ["items"]);
});

// ── verdictOf ────────────────────────────────────────────────────────────────

test("a verdict is `{pass: boolean}` with an optional score in [0, 1]; anything else is no verdict", () => {
  assert.deepEqual(verdictOf({ verdict: { pass: true } }), { pass: true });
  assert.deepEqual(verdictOf({ verdict: { pass: false, score: 0.5, detail: "x" } }), { pass: false, score: 0.5 });
  assert.equal(verdictOf({ verdict: { pass: "yes" } }), undefined, "a string is not a boolean");
  assert.equal(verdictOf({ verdict: { pass: true, score: 2 } }), undefined, "a score outside [0, 1] is not a grade");
  assert.equal(verdictOf({ verdict: { pass: true, score: Number.NaN } }), undefined);
  assert.equal(verdictOf({}), undefined);
  assert.equal(verdictOf({ verdict: null }), undefined);
});

// ── attestationOf ────────────────────────────────────────────────────────────

test("a journaled attestation reads back; a row missing a field a decision reads is not one", () => {
  const row = {
    workflow: "pick-bench",
    examGraphHash: "sha256:e",
    spec: examSpec(),
    resolutionManifest: [{ ref: "function/exam-pick@stable", digest: "sha256:d" }],
    reads: ["subject", "items", "picked"],
    attestedAt: 1_000,
    corpusThrough: "01M1",
  };
  assert.equal(attestationOf(row)?.examGraphHash, "sha256:e");
  assert.equal(attestationOf({ ...row, corpusThrough: undefined }), undefined, "no corpus bound, no attestation");
  assert.equal(attestationOf({ ...row, spec: { kind: "Other" } }), undefined);
  assert.equal(attestationOf({ ...row, resolutionManifest: [{ ref: 1 }] }), undefined);
});

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
  // arm builds the body's StateView from `node.reads` (`engine.ts` `viewFor(…, w.node.reads)`),
  // so `view.get("picked")` is `undefined` however the body is written.
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
 * A FANOUT EDGE'S `over` IS A READ, and it is the third route to a channel rather than the second.
 * `rule007` checks `e.over` against `spec.channels` alone (`validate.ts` GRAPH007_UNKNOWN_OVER),
 * never against the source node's `reads`, and the executor resolves it out of the whole scope
 * (`engine.ts` `const items = scope[e.over ?? ""]`), so this exam genuinely consumes `picked` while
 * no node declares it. The first cut of the rule refused it and told the operator "read by no
 * node", which was a false sentence printed at a refusal.
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
 * AN EXPRESSION IS THE FIFTH ROUTE, and the reason is one word. `rule004Expressions` constrains an
 * expression's free variables to the owning node's `reads ∪ writes` — `∪ writes` because an edge
 * condition is evaluated on POST-COMMIT state — and `observedChannels` covers `reads` only. So
 * `when: "picked.ok"` on an edge leaving the node that DECLARES `picked` among its writes compiles
 * clean, is evaluated by the executor, and names a channel in no node's `reads` and no fanout
 * `over`. The first two cuts of this rule refused that exam saying "read by no node", which was
 * false about its own graph — twice, for two different routes.
 */
test("a channel an edge's `when` names is read, though it is in the source node's writes", () => {
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
  assert.deepEqual(examShape(viaExpr), [], "`picked` is the edge condition's free variable");
});

// The control on the route above, and it is why the fix collects expression refs rather than
// unioning `writes` into the read set: a ROUTER writes nothing, so GRAPH004 forces a case's
// free variable into the router's own `reads`, where `observedChannels` already sees it. The
// gap is the EDGE condition alone, because only an edge's owner can satisfy GRAPH004 by writing.
test("a ROUTER case's `when` was never the gap — GRAPH004 forces it into the router's own reads", () => {
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
  assert.deepEqual(examShape(viaRouter), []);
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

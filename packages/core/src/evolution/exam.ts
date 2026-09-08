/**
 * The operator's exam: a grader that lives OUTSIDE every candidate graph.
 *
 * WHY THIS FILE EXISTS. Every rung of the ladder `score.ts` weighs is read out of the graph being
 * scored — `extractSignals` finds S1 in the graph's own `evaluator` nodes — and a candidate owns
 * its graph, so it owns S1, and with it the outcome, the promotion ceiling and the ground-truth
 * condition. Driven through the shipped verbs (`docs/audit-2026-09-02.md`): a candidate that
 * DELETES the work node and writes `{pass:true}` promoted at paired mean Δ +0.4000 over 30 pairs,
 * and a candidate whose only change was swapping its grader promoted through the replayed door
 * with every check green. Three structural pins on what the in-graph grader saw were each
 * defeated by a graph shape the pin had no vocabulary for (`git show aabdc63`), because the
 * candidate owns every channel a graph produces.
 *
 * The answer is not a fourth pin; it is a grader the candidate does not author. An EXAM is a small
 * graph an operator attests by hand (`loom exam attest`), and the runtime runs it as its own run
 * over two things the candidate does not write: the RECORDED inputs of a baseline run that
 * predates the attestation, and the graded run's TERMINAL outputs. Its `verdict` is S1 for the
 * graded run, and the exam's hash is part of the ruler every score is journaled under
 * (`score.ts`, `rulerDigest`). `docs/design-property3-2026-09-05.md` weighs the alternatives.
 *
 * WHAT IS HERE is the part that is a pure function of specs and values and can therefore be
 * checked without a workspace: what makes a graph an exam (`examShape`), what makes an exam
 * attestable against a baseline (`attestationProblems`), how a graded run's inputs are assembled
 * (`examInputsFor`), and how a verdict is read (`verdictOf`). Everything that touches a store —
 * the verb, the exam run, the scan for grades — is in `cli.ts`, next to the verbs that consume it.
 *
 * NOT RE-EXPORTED FROM `index.ts`. The CLI imports it directly; nothing a library embedder needs
 * is here yet, and a public name is a reviewed act (`scripts/surface.json`).
 */

import { observedChannels, type GraphSpec, type RunGraph } from "../graph/spec.ts";
import { parseExpr, referencedChannels } from "../graph/expr.ts";

/** The `operator.command.kind` an attestation is journaled under. */
export const EXAM_ATTEST_KIND = "evolution.exam-attest";

/** The one exam input the runtime supplies: the graded run's id. No exam node may read it. */
export const EXAM_SUBJECT_INPUT = "subject";

/** The one exam output. Read from `run.completed.outputs`, never through `extractSignals`. */
export const EXAM_VERDICT_OUTPUT = "verdict";

/**
 * What a human attested, as journaled in `operator.command.args`.
 *
 * THE SPEC RIDES IN THE ROW, so the exam is reconstructible from the journal with the file gone:
 * the file is a cache, the row is the authority. `corpusThrough` freezes the QUESTIONS with the
 * grader — the newest recording of the workflow at attestation time, a ULID and therefore a
 * chronological bound — so a recording made after the operator looked is not a question until
 * the operator looks again.
 */
export interface ExamAttestation {
  readonly workflow: string;
  readonly examGraphHash: string;
  readonly spec: GraphSpec;
  readonly resolutionManifest: readonly { readonly ref: string; readonly digest: string }[];
  /** `spec.inputs`, restated so a reader of the row sees what the exam reads without the spec. */
  readonly reads: readonly string[];
  readonly attestedAt: number;
  readonly corpusThrough: string;
}

export interface ExamVerdict {
  readonly pass: boolean;
  /** In `[0, 1]` when the exam wrote one; a pass/fail exam saturates `outcomeSpread`. */
  readonly score?: number;
}

/**
 * One run, as the exam saw it — the caller-supplied shape `scoreTrajectory` takes beside
 * `downstream`, so the scorer stays a pure function.
 *
 * THREE STATES, AND THE THIRD IS WHY `verdict` IS OPTIONAL. `gradable: false` means an exam input
 * was in neither the recorded inputs nor the terminal outputs — the exam graph was NOT run, and
 * `missing` names the channels. `gradable: true` with `verdict` absent means the exam run was
 * started (`examRunId`) and did not reach a `{pass: boolean}` verdict — a body threw on a
 * candidate-shaped output, a payload was gone. On the candidate side of a pair both are a fail;
 * on the baseline side both are `unmeasured`, and the asymmetry is the caller's to apply.
 */
export interface ExamOutcome {
  readonly graphHash: string;
  readonly gradable: boolean;
  readonly examRunId?: string;
  readonly verdict?: ExamVerdict;
  readonly missing?: readonly string[];
}

/**
 * The rules that make a compiled graph an exam. Empty means it is one; otherwise every rule it
 * breaks, in English, so the refusal names all of them at once rather than the first.
 *
 * Deterministic bodies only — no `agent`, `tool`, `subgraph`, `human_gate`, no rubric — so the
 * grade replays, calls no provider, and parks on nobody. No node reads `subject`: it is the link
 * from grade to graded run and nothing more, and a body that could read it could grade by run
 * id. Exactly one terminal node, an assertion evaluator writing `verdict`, so the verdict a reader
 * takes off `run.completed.outputs` is the one the graph's last word wrote.
 *
 * AND EVERY OTHER DECLARED INPUT IS READ BY SOME NODE, which is the fifth rule and the one
 * `attestationProblems` named as its own residue: that function's baseline-OUTPUT rule constrains
 * what an exam DECLARES, and an exam declaring `picked` whose grading node reads only `items` is
 * as blind as the one that never declared it — at `3d05cff` it attested exit 0.
 *
 * WHAT "READ" MEANS HERE IS `observedChannels` PLUS A FANOUT EDGE'S `over`, and the routes are
 * FOUR, named because a claim that does not name its members cannot be checked. `observedChannels`
 * is reused rather than re-derived — a second reader would drift from the one the engine acts on
 * (`applyTaint`, `dataFloorOf`, `#gatePayload` all call it) — and it covers two of the four:
 *
 * 1. `node.reads`. The direct declaration, and the one that matters, because a `function` or
 *    `assertion` BODY is opaque and does not need to be read: the engine builds its `StateView`
 *    from `node.reads` alone (`viewFor(p, …, w.node.reads ?? [])`, `engine.ts` at `#runFunction`
 *    and at the assertion arm) and `makeStateView` slices state to that list, so a channel outside
 *    `reads` is one the body CANNOT see — `view.get(c)` is `undefined` however the body is
 *    written. `reads` is an upper bound the runtime ENFORCES, which is what makes requiring
 *    membership in it meaningful rather than decorative.
 * 2. `${…}` templates in `tool.args`, the other half of `observedChannels`. Unreachable in an exam
 *    — a `tool` node is refused two rules up, and the compiler refuses a `tool` block on any other
 *    node type (`GRAPH020_EXTRA_BLOCK`) — and folded in anyway so the two stay one answer.
 * 3. A fanout edge's `over` — NOT covered by `reads`. `rule007` checks `e.over` against
 *    `spec.channels` alone (`GRAPH007_UNKNOWN_OVER`), never against the source node's, and the
 *    executor resolves it out of the whole scope (`engine.ts`, `const items = scope[e.over ?? ""]`).
 *    So an exam that fans out over `picked` genuinely consumes it while no node declares it.
 * 4. The free variables of every expression the executor evaluates — a `router` case's `when`, an
 *    edge's `when`/`until` — taken from the compiler's own `referencedChannels(parseExpr(src))`
 *    rather than re-derived. THIS ROUTE IS WHY `reads` IS NOT A SUPERSET, and the argument that
 *    said it was dropped a word: `rule004Expressions` constrains free variables to the owning
 *    node's `reads ∪ WRITES` — `∪ writes` deliberately, because an edge condition is evaluated on
 *    POST-COMMIT state, so `until: verdict.pass` leaving the node that just wrote `verdict` must
 *    be legal. An edge's owner can therefore satisfy GRAPH004 by DECLARING the channel among its
 *    writes, and `when: "picked.ok"` then names a channel in no node's `reads` and no `over`. A
 *    router cannot: it writes nothing, so its cases' variables are forced into its own `reads`,
 *    where route 1 already sees them — the gap is the EDGE condition alone, and the test file
 *    carries that control beside the case.
 *
 * THE ROUTE COUNT WENT TWO → FOUR OVER TWO REVIEW ROUNDS, each time because a claim of
 * completeness was written before the enumeration was driven, and each time the symptom was
 * identical: a genuine exam refused with the sentence "read by no node", false about its own
 * graph. `test/graph/expression-reads.test.ts` pins the three expression sites and fails if the
 * engine grows a fourth; there is no such pin for `over`, and a fifth route would arrive silently.
 *
 * WHAT IT DOES NOT CLOSE, and there are TWO residues, not the one this docstring first named:
 * - A node may declare `reads: ["picked"]` and its body ignore the value. A fact about the body,
 *   and nothing static can see it.
 * - SOME node may name `picked` without the value ever reaching the verdict — the rule asks
 *   whether the channel is read, not whether the reading REACHES the grade. Three shapes, so the
 *   set is named rather than gestured at: a body that reads it and discards it; a `join` node,
 *   which has a `reads` list and no body at all; and a node reachable only down an `error` edge,
 *   which never runs on the success path and is not terminal (`error` edges are in `dagEdges`, so
 *   the one-terminal rule does not catch it).
 *   That one IS mechanical: dataflow reachability from each declared input to the terminal node
 *   would close it. It is not built here because it is a second analysis rather than a term in
 *   this one, and because the rule as it stands already refuses the shape that was actually
 *   driven. `test/evolution/exam-lane-exam-predicate.test.ts` PINS it with a `sink` node, so the
 *   hole is a checked fact and fails loudly the day somebody closes it.
 * Both join `attestationProblems`'s "NONE OF THESE RULES IS ABOUT QUALITY" set.
 *
 * A MIGRATION EFFECT, since this predicate also runs on the READ side (`cli.ts`, the re-check of
 * the attested row): an exam attested before this rule that declares an input no node reads now
 * makes `loom score`, `promote --against-cohort` and `suite freeze` throw `E_CONFIG_INVALID`
 * rather than fall back to in-graph S1. That is the intended direction — a ruler this binary will
 * not vouch for stops the scoring verb instead of quietly becoming the candidate's own grader —
 * and the refusal names the re-attest command.
 */
export function examShape(graph: RunGraph): string[] {
  const spec = graph.spec;
  const problems: string[] = [];
  if (spec.inputs.length === 0) problems.push("an exam declares at least one input");
  if (!spec.inputs.includes(EXAM_SUBJECT_INPUT)) {
    problems.push(`an exam declares "${EXAM_SUBJECT_INPUT}" among its inputs — it is how a grade names the run it graded`);
  }
  if (spec.outputs.length !== 1 || spec.outputs[0] !== EXAM_VERDICT_OUTPUT) {
    problems.push(`an exam declares exactly one output, "${EXAM_VERDICT_OUTPUT}" (found ${JSON.stringify(spec.outputs)})`);
  }
  if (spec.inputs.includes(EXAM_VERDICT_OUTPUT)) {
    problems.push(`an exam does not read "${EXAM_VERDICT_OUTPUT}" — it is the exam's own output, and an input by that name collides with it`);
  }
  for (const node of spec.nodes) {
    if ((node.function?.effects ?? []).length > 0) {
      problems.push(`node "${String(node.id)}" declares effects ${JSON.stringify(node.function?.effects)} — a body that reaches a tool is not deterministic, and an exam's grade must replay`);
    }
    if (node.type === "agent" || node.type === "tool" || node.type === "subgraph" || node.type === "human_gate") {
      problems.push(`node "${String(node.id)}" is a ${node.type} — an exam runs deterministic bodies only, so its grade replays and calls no provider`);
    }
    if (node.type === "evaluator" && node.evaluator?.kind === "rubric") {
      problems.push(`node "${String(node.id)}" is a rubric evaluator — a model grading a model is S4, never an exam's verdict`);
    }
    if ((node.reads ?? []).includes(EXAM_SUBJECT_INPUT)) {
      problems.push(`node "${String(node.id)}" reads "${EXAM_SUBJECT_INPUT}" — the run id links a grade to its run and no body may grade by it`);
    }
  }
  // THE FIFTH RULE. `subject` is exempt because the rule four lines up refuses a node that reads
  // it; requiring it to be read would make every exam unattestable.
  const seen = new Set([
    // Routes 1 and 2.
    ...spec.nodes.flatMap((n) => [...observedChannels(n)]),
    // Route 3: a fanout edge consumes its `over` out of the whole scope; no node's `reads` names it.
    ...spec.edges.flatMap((e) => (e.kind === "fanout" && e.over !== undefined ? [e.over] : [])),
    // Route 4: the executor's three expression sites. `parseExpr` cannot throw on a COMPILED graph
    // — every one of these parsed at compile time — and the catch is the fail-closed backstop
    // rather than the design: an expression this cannot read contributes nothing, so the rule
    // refuses rather than admits.
    ...[
      ...spec.edges.flatMap((e) => [e.when, e.until]),
      ...spec.nodes.flatMap((n) => (n.router?.cases ?? []).map((c) => c.when)),
    ].flatMap((src) => {
      if (src === undefined) return [];
      try {
        return [...referencedChannels(parseExpr(src))];
      } catch {
        return [];
      }
    }),
  ]);
  // `Set` over the filter's result: `spec.inputs` may carry a name twice (the compiler admits it),
  // and naming the same channel twice in one refusal reads as two problems.
  const unread = [...new Set(spec.inputs.filter((c) => c !== EXAM_SUBJECT_INPUT && !seen.has(c)))];
  if (unread.length > 0) {
    problems.push(
      `exam input(s) ${unread.map((c) => `"${c}"`).join(", ")} are declared as inputs and read by no node — a node body's ` +
        `state view is built from its \`reads\`, so a channel named by no node's \`reads\`, no \`\${…}\` in its tool args and ` +
        `no fanout edge's \`over\` is one no body can see, and an exam that declares the run's answer and never reads it ` +
        `grades exactly as blind as one that never declared it. Add it to the \`reads\` of the node that grades it, or stop ` +
        `declaring it`,
    );
  }
  if (graph.terminalNodes.length !== 1) {
    problems.push(`an exam has exactly one terminal node (found ${String(graph.terminalNodes.length)})`);
  } else {
    const terminal = spec.nodes.find((n) => n.id === graph.terminalNodes[0]);
    const writesVerdict = (terminal?.writes ?? []).includes(EXAM_VERDICT_OUTPUT);
    if (terminal === undefined || terminal.type !== "evaluator" || terminal.evaluator?.kind !== "assertion" || !writesVerdict) {
      problems.push(
        `the terminal node must be an evaluator{kind:"assertion"} writing "${EXAM_VERDICT_OUTPUT}" ` +
          `(found ${terminal === undefined ? "nothing" : `"${String(terminal.id)}", a ${terminal.type}${terminal.evaluator === undefined ? "" : `/${terminal.evaluator.kind}`} writing ${JSON.stringify(terminal.writes ?? [])}`})`,
      );
    }
  }
  return problems;
}

/**
 * Why this exam may not be attested against this baseline. Empty means it may.
 *
 * Four rules about what the exam reads, and two about the names it and the baseline carry. Every exam input other than `subject` must
 * be a declared `input` or `output` of the baseline graph, or the exam grades every baseline
 * recording `fail` for a channel those recordings never produced. It must read at least one
 * baseline INPUT: an exam over outputs alone is the two-sided fixture — the candidate writing both
 * `expected` and `answer` — with the fixture moved outside the graph. It must not read ONLY
 * outputs a baseline `evaluator` node writes, because that is grading the grader; `review-bench`
 * as shipped declares six evaluator-written outputs and nothing else, and this rule is what
 * refuses it.
 *
 * AND IT MUST DECLARE AT LEAST ONE BASELINE OUTPUT, which is the mirror of the INPUT rule and was
 * missing for three review rounds while its twin stood two lines away. An exam over `[subject,
 * items]` sees the question and never the run's answer, so whatever body it carries it measures
 * nothing about the run it grades. Measured on the `pick-bench` fixture with an ALWAYS-PASS body:
 * it attested exit 0 and graded all thirty recordings `pass`, after which `L5-candidate-earned-it`
 * certified the work-deleting candidate as having "scored above 0 on 30 of 30". (The tree's own
 * `blind-exam` fixture carries the ordinary body instead and graded all thirty FAIL — same shape,
 * opposite grade, which is the point: the refusal is on the shape, and the grade is the body's.)
 * A guard answering its undecidable case with the passing value is CLAUDE.md's first defect lens,
 * and this was it on the guard property 3 rests on.
 *
 * WHAT THE OUTPUT RULE DELIBERATELY DOES NOT COVER, both found by the round-four reviewer:
 * - It constrains what an exam DECLARES, not what its nodes READ — and THAT HALF IS NOW CLOSED,
 *   one function up. `examShape`'s fifth rule requires every declared input other than `subject`
 *   to be in some node's `observedChannels`; read its docstring for why that set is the compiler's
 *   own answer and for the narrower residue it leaves (a node may declare a read its body
 *   ignores). It stays named here because the two rules are one argument split across two
 *   functions: this one asks whether the ANSWER is declared, that one whether it is reached.
 * - A channel the baseline declares as BOTH an input and an output does not satisfy the rule, so a
 *   workflow whose outputs are a subset of its inputs — a refine loop, `inputs:["draft"],
 *   outputs:["draft"]` — cannot be attested at all, and the refusal names the very channel its exam
 *   reads. That is fail-closed and therefore allowed, and it is a real loss of reach: such a
 *   workflow has no route to property 3 today. The exclusion is deliberate because
 *   `examInputsFor` resolves the collision in favour of the RECORDED input whenever the recording
 *   supplied one, which is the ordinary case; the exam would be handed the question under the
 *   answer's name.
 *
 * NONE OF THESE RULES IS ABOUT QUALITY. They refuse mechanical forms of a useless exam; they
 * cannot refuse a body that reads the right channels and grades them badly. That stays the
 * operator's, exactly as the quality of a human gate decision is. And the exam's `metadata.name` must differ from the workflow's: exam runs are
 * journaled under the exam's name, and the newest recording of the WORKFLOW is what
 * `corpusThrough` is read from.
 */
export function attestationProblems(exam: GraphSpec, baseline: GraphSpec): string[] {
  const problems: string[] = [];
  const inputs = new Set(baseline.inputs);
  const outputs = new Set(baseline.outputs);
  const evaluatorWrites = new Set(
    baseline.nodes.filter((n) => n.type === "evaluator").flatMap((n) => n.writes ?? []),
  );
  const reads = exam.inputs.filter((c) => c !== EXAM_SUBJECT_INPUT);
  const undeclared = reads.filter((c) => !inputs.has(c) && !outputs.has(c));
  if (undeclared.length > 0) {
    problems.push(
      `exam input(s) ${undeclared.map((c) => `"${c}"`).join(", ")} are declared by the baseline graph neither as inputs ` +
        `(${JSON.stringify(baseline.inputs)}) nor as outputs (${JSON.stringify(baseline.outputs)}) — an exam that reads a channel ` +
        `the recordings never produced would grade every baseline run fail`,
    );
  }
  if (!reads.some((c) => inputs.has(c))) {
    problems.push(
      `the exam reads no baseline INPUT (baseline inputs ${JSON.stringify(baseline.inputs)}) — an exam over outputs alone ` +
        `trusts the work graph for both the question and the answer`,
    );
  }
  // THE ANSWER SIDE, AND `outputReads` IS WHAT COUNTS AS ONE. A channel the baseline declares as
  // both an input and an output does NOT count: `examInputsFor` resolves that collision in favour
  // of the RECORDED input, so the exam would be handed the question under the answer's name.
  const outputReads = reads.filter((c) => outputs.has(c) && !inputs.has(c));
  if (outputReads.length === 0) {
    problems.push(
      `the exam reads no baseline OUTPUT (baseline outputs ${JSON.stringify(baseline.outputs)}) — an exam over inputs alone ` +
        `sees the question and never the run's answer, so it measures nothing about the run it grades`,
    );
  }
  if (outputReads.length > 0 && outputReads.every((c) => evaluatorWrites.has(c))) {
    problems.push(
      `every baseline output the exam reads (${outputReads.map((c) => `"${c}"`).join(", ")}) is written by a baseline evaluator node ` +
        `— that is grading the grader. Declare the WORK channel the evaluator reads as an output of the baseline graph and ` +
        `grade that; an evaluator's verdict is the graph's opinion of itself`,
    );
  }
  if (Object.prototype.hasOwnProperty.call(baseline.channels, EXAM_SUBJECT_INPUT)) {
    problems.push(
      `the baseline graph declares a channel named "${EXAM_SUBJECT_INPUT}" — that name is how a grade names the run it ` +
        `graded, and a graph that could write it could write the link from a grade to a run`,
    );
  }
  if (exam.metadata.name === baseline.metadata.name) {
    problems.push(
      `the exam is named "${exam.metadata.name}", the workflow's own name — exam runs are journaled under the exam's name, ` +
        `and a same-named exam would be counted as a recording of the workflow it grades`,
    );
  }
  return problems;
}

/**
 * The exam's inputs for one graded run: recorded inputs and terminal outputs, keyed by the exam's
 * declared inputs, plus `subject`.
 *
 * A name present in neither is UNGRADABLE — the exam is not run, because a grader handed a
 * missing answer must not guess. Whose fault that is depends on which side of a pair the run sits
 * on, and that is the caller's asymmetry, not this function's. A name present in both (a channel
 * that is both an input and an output of the work graph) is resolved in favour of the RECORDED
 * input: the recording is the question, and a work graph that overwrote its own question does not
 * get to re-ask it.
 *
 * `collisions` NAMES those channels AND NOTHING READS IT — this docstring used to say "and
 * reported", which was false: `cli.ts`'s `gradeWithExam` drops the field and the only readers are
 * assertions in `test/evolution/exam-lane-exam-predicate.test.ts`. It is returned so the decision
 * is checkable, and it is not on any page an operator sees. Left as it is rather than wired into
 * a stderr line nobody asked for; corrected here so the next reader is not told it exists.
 */
export function examInputsFor(
  exam: GraphSpec,
  subjectRunId: string,
  recorded: Readonly<Record<string, unknown>>,
  outputs: Readonly<Record<string, unknown>>,
):
  | { readonly ok: true; readonly inputs: Record<string, unknown>; readonly collisions: readonly string[] }
  | { readonly ok: false; readonly missing: readonly string[] } {
  const inputs: Record<string, unknown> = {};
  const missing: string[] = [];
  const collisions: string[] = [];
  for (const name of exam.inputs) {
    if (name === EXAM_SUBJECT_INPUT) continue;
    const fromRecording = Object.prototype.hasOwnProperty.call(recorded, name) && recorded[name] !== undefined;
    const fromOutputs = Object.prototype.hasOwnProperty.call(outputs, name) && outputs[name] !== undefined;
    if (fromRecording && fromOutputs) collisions.push(name);
    if (fromRecording) inputs[name] = recorded[name];
    else if (fromOutputs) inputs[name] = outputs[name];
    else missing.push(name);
  }
  if (missing.length > 0) return { ok: false, missing };
  inputs[EXAM_SUBJECT_INPUT] = subjectRunId;
  return { ok: true, inputs, collisions };
}

/**
 * The verdict an exam run wrote, or `undefined` when it wrote none a reader may trust.
 *
 * `pass` must be a boolean and `score`, when present, a finite number in `[0, 1]`. Anything else
 * is an exam body that did not grade — the same refusal `firstVerdict` in `trajectory.ts` makes
 * for an in-graph evaluator, applied to the one output a grade rests on.
 */
export function verdictOf(outputs: Readonly<Record<string, unknown>>): ExamVerdict | undefined {
  const v = outputs[EXAM_VERDICT_OUTPUT];
  if (v === null || typeof v !== "object") return undefined;
  const pass = (v as { pass?: unknown }).pass;
  if (typeof pass !== "boolean") return undefined;
  const score = (v as { score?: unknown }).score;
  if (score === undefined) return { pass };
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) return undefined;
  return { pass, score };
}

/**
 * An `operator.command.args` read back as an attestation, or `undefined` when the row is not one
 * this binary can act on. A row is data written by an earlier process; every field a decision
 * reads is checked for shape rather than cast, and a row that fails is not an attestation.
 */
export function attestationOf(args: Readonly<Record<string, unknown>>): ExamAttestation | undefined {
  const spec = args["spec"];
  const manifest = args["resolutionManifest"];
  const reads = args["reads"];
  if (
    typeof args["workflow"] !== "string" ||
    typeof args["examGraphHash"] !== "string" ||
    typeof args["attestedAt"] !== "number" ||
    typeof args["corpusThrough"] !== "string" ||
    spec === null ||
    typeof spec !== "object" ||
    (spec as { kind?: unknown }).kind !== "GraphSpec" ||
    !Array.isArray(manifest) ||
    !manifest.every((m) => m !== null && typeof m === "object" && typeof (m as { ref?: unknown }).ref === "string" && typeof (m as { digest?: unknown }).digest === "string") ||
    !Array.isArray(reads) ||
    !reads.every((r) => typeof r === "string")
  ) {
    return undefined;
  }
  return {
    workflow: args["workflow"],
    examGraphHash: args["examGraphHash"],
    spec: spec as GraphSpec,
    resolutionManifest: manifest as { ref: string; digest: string }[],
    reads: reads as string[],
    attestedAt: args["attestedAt"],
    corpusThrough: args["corpusThrough"],
  };
}

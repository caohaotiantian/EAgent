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

import type { GraphSpec, RunGraph } from "../graph/spec.ts";

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
  for (const node of spec.nodes) {
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
 * Three rules from the design and one from the journal. Every exam input other than `subject`
 * must be a declared `input` or `output` of the baseline graph, or the exam grades every baseline
 * recording `fail` for a channel those recordings never produced. It must read at least one
 * baseline INPUT: an exam over outputs alone is the two-sided fixture — the candidate writing both
 * `expected` and `answer` — with the fixture moved outside the graph. It must not read ONLY
 * outputs a baseline `evaluator` node writes, because that is grading the grader; `review-bench`
 * as shipped declares six evaluator-written outputs and nothing else, and this rule is what
 * refuses it. And the exam's `metadata.name` must differ from the workflow's: exam runs are
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
  const outputReads = reads.filter((c) => outputs.has(c) && !inputs.has(c));
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
 * input, and reported: the recording is the question, and a work graph that overwrote its own
 * question does not get to re-ask it.
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

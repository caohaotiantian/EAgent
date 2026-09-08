/**
 * THE ACCEPTANCE EXAM of `docs/design-property3-2026-09-05.md` §6, driven through `main()`.
 *
 * CLAUDE.md §3's bar is "a measurement whose inputs the candidate provably cannot write". The
 * audit drove two candidates through the shipped verbs and both promoted: one that deletes its
 * work node and writes `{pass:true}` (paired mean Δ +0.4000 over 30 pairs), and one whose only
 * change is swapping its grader (all thirteen replayed checks green). This file drives the same
 * two candidates, the honest one, and the rename and question-planting attacks, through the same
 * verbs, on the design's `pick-bench` fixture: `pick` is wrong on even-length inputs, so 20 of 30
 * recordings are wrong; the operator's exam re-derives the answer from the recorded `items`.
 *
 * Every number below is `0.6 × outcome`: function-only runs cost $0 and 0 ms, so a free cohort
 * pays no efficiency credit and the pair counts are exact.
 *
 * Offline: no agent node anywhere, so the models file's endpoint is never dialled — `main()` is
 * handed a fetch that throws — and `promote --against-cohort`'s adapter refusals are still met
 * for real. Nothing here reads a clock into an assertion.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, openWorkspace, parseArgs } from "../../src/cli.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ToolRegistry } from "../../src/run/registry.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import type { EvalSuite } from "../../src/evolution/gate.ts";
import type { RunId } from "../../src/ids.ts";
import { isEvent, type EventPayloads, type JournalEvent } from "../../src/journal/events.ts";

// ── the fixture, as §6 states it ─────────────────────────────────────────────

const FN: Record<string, string> = {
  pick: `(view) => { const items = view.get("items") ?? []; return { writes: { picked: items.length % 2 === 0 ? items.slice(0, -1) : items.slice() } }; }`,
  "pick-fixed": `(view) => ({ writes: { picked: (view.get("items") ?? []).slice() } })`,
  check: `(view) => { const items = view.get("items") ?? []; const picked = view.get("picked") ?? []; const ok = picked.length === items.length; return { writes: { verdict: { pass: ok, score: ok ? 1 : 0, confidence: 1, detail: picked.length + "/" + items.length } } }; }`,
  "check-rigged": `() => ({ writes: { verdict: { pass: true, score: 1, confidence: 1, detail: "lgtm" } } })`,
  "exam-pick": `(view) => { const want = view.get("items") ?? []; const got = view.get("picked") ?? []; const ok = JSON.stringify(got) === JSON.stringify(want); return { writes: { verdict: { pass: ok, score: ok ? 1 : 0, confidence: 1, detail: ok ? "kept every item" : "dropped or reordered an item" } } }; }`,
  "exam-pick-forged": `() => ({ writes: { verdict: { pass: false, score: 0, confidence: 1, detail: "forged" } } })`,
};

const graph = (name: string, pickRef: string, checkRef: string): unknown => ({
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name, project: "demo", version: 1 },
  policy: { posture: "out", capabilities: [] },
  channels: { items: { type: "array", reduce: "replace" }, picked: { type: "array", reduce: "replace" }, verdict: { type: "object", reduce: "replace" } },
  inputs: ["items"],
  // `picked` is an OUTPUT: the exam reads terminal outputs, and a work channel the graph does not
  // declare is one the exam cannot see.
  outputs: ["picked", "verdict"],
  nodes: [
    { id: "pick", type: "function", reads: ["items"], writes: ["picked"], function: { ref: pickRef } },
    { id: "check", type: "evaluator", reads: ["items", "picked"], writes: ["verdict"], evaluator: { kind: "assertion", ref: checkRef, threshold: 0.5 } },
  ],
  edges: [{ id: "e", from: "pick", to: "check", kind: "seq" }],
});

/** Audit reproduction 1: one evaluator reading `items`, writing `{pass:true}`; NO pick node. */
const NOOP = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "pick-bench", project: "demo", version: 1 },
  policy: { posture: "out", capabilities: [] },
  channels: { items: { type: "array", reduce: "replace" }, verdict: { type: "object", reduce: "replace" } },
  inputs: ["items"],
  outputs: ["verdict"],
  nodes: [{ id: "check", type: "evaluator", reads: ["items"], writes: ["verdict"], evaluator: { kind: "assertion", ref: "function/check-rigged@stable", threshold: 0.5 } }],
  edges: [],
};

const exam = (name: string, inputs: string[], over: Record<string, unknown> = {}): unknown => ({
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name, project: "demo", version: 1 },
  policy: { posture: "out", capabilities: [] },
  channels: Object.fromEntries([
    ...inputs.map((c) => [c, { type: c === "subject" ? "string" : c === "verdict" ? "object" : "array", reduce: "replace" }]),
    ["verdict", { type: "object", reduce: "replace" }],
  ]),
  inputs,
  outputs: ["verdict"],
  nodes: [{ id: "grade", type: "evaluator", reads: inputs.filter((c) => c !== "subject"), writes: ["verdict"], evaluator: { kind: "assertion", ref: "function/exam-pick@stable", threshold: 0 } }],
  edges: [],
  ...over,
});

const MODELS_FILE = JSON.stringify({
  adapters: [{ provider: "openai", name: "stub", baseUrl: "http://stub.invalid/v1", apiKeyEnv: null, prices: { m1: { input: 1, output: 1 } } }],
  routes: { "agent_profile/x@stable": { adapter: "stub", model: "m1" } },
});

const NEVER = async (): Promise<Response> => {
  throw new Error("this suite must never reach a provider");
};

interface Result {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  /** A refusal thrown out of `main` rather than returned as an exit code. */
  readonly thrown?: unknown;
}

async function cli(argv: string[]): Promise<Result> {
  const out: string[] = [];
  const errOut: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => (errOut.push(String(c)), true)) as typeof process.stderr.write;
  try {
    const code = await main(argv, NEVER);
    return { code, out: out.join(""), err: errOut.join("") };
  } catch (thrown) {
    return { code: -1, out: out.join(""), err: errOut.join(""), thrown };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

const refusedWith = (r: Result, re: RegExp): void => {
  assert.ok(isLoomError(r.thrown) && r.thrown.code === CODES.E_CONFIG_INVALID, `expected E_CONFIG_INVALID, got code ${String(r.code)} ${String(r.thrown)}\n${r.out}\n${r.err}`);
  assert.match((r.thrown as Error).message, re);
};

const jsonOf = <T>(out: string): T => JSON.parse(out.slice(out.indexOf("{"))) as T;

interface LiveDecision {
  readonly promote: boolean;
  readonly examGraphHash?: string;
  readonly corpusThrough?: string;
  readonly afterCorpus?: number;
  readonly paired: { n: number; mean: number; lower95: number; wilcoxonLower95: number; wins: number; losses: number; ties: number };
  readonly pairs: { baselineRunId: string; candidateRunId: string; baselineScore: number; candidateScore: number; baselineExamRunId?: string; candidateExamRunId?: string }[];
  readonly checks: { id: string; ran: boolean; pass: boolean; detail: string }[];
}

interface Fixture {
  readonly dir: string;
  readonly ids: RunId[];
  readonly others: RunId[];
  readonly last: RunId;
}

function seed(dir: string): void {
  for (const d of ["graphs", "resources/function", "resources/prompt", "resources/agent_profile", "candidates", "exams"]) mkdirSync(join(dir, d), { recursive: true });
  for (const [name, body] of Object.entries(FN)) writeFileSync(join(dir, "resources", "function", `${name}.js`), body);
  writeFileSync(join(dir, "resources", "prompt", "p.md"), "grade it\n");
  writeFileSync(join(dir, "resources", "agent_profile", "x.md"), "a judge\n");
  const w = (rel: string, o: unknown): void => writeFileSync(join(dir, rel), JSON.stringify(o, null, 2));
  w("graphs/pick.json", graph("pick-bench", "function/pick@stable", "function/check@stable"));
  w("graphs/other.json", graph("other-bench", "function/pick@stable", "function/check@stable"));
  w("candidates/noop.json", NOOP);
  w("candidates/rigged.json", graph("pick-bench", "function/pick@stable", "function/check-rigged@stable"));
  w("candidates/fixed.json", graph("pick-bench", "function/pick-fixed@stable", "function/check@stable"));
  w("candidates/renamed.json", graph("pick-bench-2", "function/pick-fixed@stable", "function/check@stable"));
  w("exams/pick-exam.json", exam("pick-exam", ["subject", "items", "picked"]));
  w("exams/bad-exam.json", exam("pick-exam-bad", ["subject", "verdict"]));
  w("exams/undeclared-exam.json", exam("pick-exam-undeclared", ["subject", "items", "chosen"]));
  w(
    "exams/agent-exam.json",
    exam("pick-exam-agent", ["subject", "items", "picked"], {
      channels: {
        subject: { type: "string", reduce: "replace" },
        items: { type: "array", reduce: "replace" },
        picked: { type: "array", reduce: "replace" },
        opinion: { type: "string", reduce: "replace" },
        verdict: { type: "object", reduce: "replace" },
      },
      nodes: [
        { id: "judge", type: "agent", reads: ["items"], writes: ["opinion"], agent: { profile: "agent_profile/x@stable", prompt: "prompt/p@stable", maxTurns: 1 }, policy: { budget: { costUsd: 0.1 } } },
        { id: "grade", type: "evaluator", reads: ["items", "picked", "opinion"], writes: ["verdict"], evaluator: { kind: "assertion", ref: "function/exam-pick@stable", threshold: 0 } },
      ],
      edges: [{ id: "e", from: "judge", to: "grade", kind: "seq" }],
      policy: { posture: "out", capabilities: [], budget: { costUsd: 1 } },
    }),
  );
  writeFileSync(join(dir, "models.json"), MODELS_FILE);
}

const items = (n: number): string[] => Array.from({ length: 2 + (n % 3) }, (_, i) => `doc-${String(n)}-${String(i)}`);

async function record(dir: string, file: string, input: unknown): Promise<RunId> {
  const r = await cli(["run", join(dir, file), "--workspace", dir, "--input", JSON.stringify(input)]);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  const p = JSON.parse(r.out) as { runId: string; status: string };
  assert.equal(p.status, "succeeded");
  return p.runId as RunId;
}

/** Step 1, once: thirty scored pick-bench recordings and six other-bench ones, all scored BEFORE any exam. */
let TEMPLATE: Fixture | undefined;
async function template(): Promise<Fixture> {
  if (TEMPLATE !== undefined) return TEMPLATE;
  const dir = mkdtempSync(join(tmpdir(), "loom-exam-template-"));
  seed(dir);
  const ids: RunId[] = [];
  for (let n = 1; n <= 30; n++) ids.push(await record(dir, "graphs/pick.json", { items: items(n) }));
  const others: RunId[] = [];
  for (let n = 1; n <= 6; n++) others.push(await record(dir, "graphs/other.json", { items: [`o-${String(n)}`, `o-${String(n)}-b`, `o-${String(n)}-c`] }));
  for (const id of [...ids, ...others]) assert.equal((await cli(["score", id, "--workspace", dir])).code, 0);
  TEMPLATE = { dir, ids, others, last: ids[ids.length - 1]! };
  return TEMPLATE;
}
test.after(() => {
  if (TEMPLATE !== undefined) rmSync(TEMPLATE.dir, { recursive: true, force: true });
});

async function workspace(): Promise<Fixture & { dispose: () => void }> {
  const t = await template();
  const dir = mkdtempSync(join(tmpdir(), "loom-exam-"));
  cpSync(t.dir, dir, { recursive: true });
  return { ...t, dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

const attest = (dir: string, anchor: string, file = "exams/pick-exam.json", as = "haotian"): Promise<Result> =>
  cli(["exam", "attest", join(dir, file), "--cohort", anchor, "--as", as, "--workspace", dir]);
const live = (dir: string, candidate: string, anchor: string): Promise<Result> =>
  cli(["promote", join(dir, candidate), "--against-cohort", anchor, "--models-file", join(dir, "models.json"), "--workspace", dir]);
const cohortOf = async (dir: string, runId: string): Promise<{ members: { golden: boolean }[]; excludedForWeights: number }> => {
  const r = await cli(["cohort", runId, "--workspace", dir]);
  assert.equal(r.code, 0, r.err);
  return jsonOf(r.out);
};

async function journal(dir: string, runId: string): Promise<JournalEvent[]> {
  const ws = openWorkspace(parseArgs(["gates", "--workspace", dir]));
  try {
    const events: JournalEvent[] = [];
    for await (const e of ws.store.read(runId as RunId, 1)) events.push(e);
    return events;
  } finally {
    ws.close();
  }
}

const check = (d: LiveDecision, id: string) => {
  const c = d.checks.find((x) => x.id === id);
  assert.ok(c !== undefined, id);
  return c;
};

// ── 2 · before attestation the gates refuse, and say what to do ─────────────

test("STEP 2 · before any attestation, the live door and the freeze REFUSE and name `loom exam attest` — on the honest candidate", async () => {
  const w = await workspace();
  try {
    refusedWith(await live(w.dir, "candidates/fixed.json", w.last), /no measurement the candidate cannot write exists for workflow "pick-bench".*loom exam attest/);
    refusedWith(await cli(["suite", "freeze", "--cohort", w.last, "--out", join(w.dir, "s0.json"), "--workspace", w.dir]), /loom exam attest/);
    assert.equal(existsSync(join(w.dir, "s0.json")), false);
    // …and `loom score` still reports, as it did: an unattested workflow folds in-graph S1.
    const s = await cli(["score", w.last, "--workspace", w.dir]);
    assert.equal(s.code, 0);
    assert.match(jsonOf<{ signals: { evidence: string }[] }>(s.out).signals[0]!.evidence, /assertions passed/);
  } finally {
    w.dispose();
  }
});

// ── 3 · audit repro 2 through the replayed door, on a hand-written legacy suite ──

test("STEP 3 · a legacy suite refuses the grader swap with ✗ 12-grader-unchanged, and the honest candidate passes 12", async () => {
  const w = await workspace();
  try {
    // Freeze refuses without an attestation, so a suite this early is one written by hand or by
    // an older binary. Check 12 reaches a frozen one too — see STEP 11, where the same swap is
    // refused on a suite this binary froze under an attestation. Its shape is `freezeSuite`'s:
    // golden (odd-length) runs pin `picked`, the rest pin nothing.
    const cases = [];
    for (const [i, id] of w.ids.slice(0, 12).entries()) {
      const done = (await journal(w.dir, id)).find((e): e is Extract<JournalEvent, { type: "run.completed" }> => isEvent(e, "run.completed"));
      const picked = done!.payload.outputs["picked"] as string[];
      const golden = (i + 1) % 3 === 1;
      cases.push({ id: `c${String(i)}`, runId: id, mustPass: golden, expect: { status: "succeeded" as const, noIrreversibleWithoutGate: true, ...(golden ? { channels: { picked } } : {}) } });
    }
    const suite: EvalSuite = { name: "pick-bench-legacy", version: 1, frozen: true, frozenAt: 1_000, generatedBy: "loom-suite-freeze", cases, composition: { minCases: 6, minMustPass: 1 } };
    writeFileSync(join(w.dir, "s-legacy.json"), JSON.stringify(suite));
    const promote = (c: string) => cli(["promote", join(w.dir, c), "--baseline", join(w.dir, "graphs", "pick.json"), "--suite", join(w.dir, "s-legacy.json"), "--workspace", w.dir]);

    const rigged = await promote("candidates/rigged.json");
    assert.equal(rigged.code, 1, `${rigged.out}\n${rigged.err}`);
    assert.match(rigged.out, /✗ 12-grader-unchanged.*node:check function\/check@stable → function\/check-rigged@stable/);
    const d = jsonOf<{ promote: boolean; checks: { id: string; pass: boolean }[]; examAttested: boolean }>(rigged.out);
    assert.deepEqual(d.checks.filter((c) => !c.pass).map((c) => c.id), ["12-grader-unchanged"], "everything else is green — the audit's shape");
    assert.equal(d.examAttested, false);

    // The control: the honest fix passes 12 (the evaluator set is unchanged) and TIES on the floor
    // — a suite frozen by an honest grader pins only the runs it got right, which the fix
    // reproduces, so the replayed door promotes at Δ 0.0pp and measures no improvement. A suite
    // that pins WRONG outputs is one a rigged grader froze, which is step 11's subject.
    const fixed = await promote("candidates/fixed.json");
    assert.equal(fixed.code, 0, `${fixed.out}\n${fixed.err}`);
    assert.match(fixed.out, /✓ 12-grader-unchanged/);
    assert.match(fixed.out, /✓ 2-non-inferior .*Δ 0\.0pp/);
  } finally {
    w.dispose();
  }
});

// ── 4 · attest, and the five refusals ────────────────────────────────────────

test("STEP 4 · attest exits 0 and journals a human row with corpusThrough = the newest recording; five shapes are refused by name", async () => {
  const w = await workspace();
  try {
    const a = await attest(w.dir, w.last);
    assert.equal(a.code, 0, `${a.out}\n${a.err}`);
    const row = jsonOf<{ workflow: string; examGraphHash: string; corpusThrough: string; reads: string[] }>(a.out);
    assert.equal(row.workflow, "pick-bench");
    assert.equal(row.corpusThrough, w.last, "the newest pick-bench recording; other-bench runs are another workflow");
    assert.deepEqual(row.reads, ["subject", "items", "picked"]);

    const rows = (await journal(w.dir, w.last)).filter((e): e is Extract<JournalEvent, { type: "operator.command" }> => isEvent(e, "operator.command") && e.payload.kind === "evolution.exam-attest");
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.actor, { kind: "human", subject: "haotian", via: "console" });
    assert.equal((rows[0]!.payload.args as { spec: { kind: string } }).spec.kind, "GraphSpec", "the spec rides in the row");

    refusedWith(await cli(["exam", "attest", join(w.dir, "exams/pick-exam.json"), "--cohort", w.last, "--workspace", w.dir]), /--as needs a subject/);
    refusedWith(await attest(w.dir, w.last, "exams/pick-exam.json", "cli"), /names nobody/);
    // bad-exam reads [subject, verdict]: the only evaluator-written output of pick-bench IS the
    // exam's own output name, so the shape rule fires before the grading-the-grader rule does.
    // (`exam-lane-exam-predicate.test.ts` drives the latter on a baseline whose evaluator writes
    // another name, the review-bench shape.)
    refusedWith(await attest(w.dir, w.last, "exams/bad-exam.json"), /is not an exam: an exam does not read "verdict"/);
    refusedWith(await attest(w.dir, w.last, "exams/undeclared-exam.json"), /"chosen" are declared by the baseline graph neither/);
    refusedWith(await attest(w.dir, w.last, "exams/agent-exam.json"), /is not an exam: .*"judge" is a agent/);
    assert.equal((await journal(w.dir, w.last)).filter((e) => isEvent(e, "operator.command")).length, 1, "the refusals wrote nothing");
  } finally {
    w.dispose();
  }
});

// ── 5 · stale scores are stale; 6, 7, 8, 9 · the four candidates ─────────────

test("STEPS 5–9 · pre-exam rows are another ruler; noop and rigged REFUSE, renamed is refused by name, question-planting adds nothing, and the honest fix PROMOTES at Δ +0.4000", async () => {
  const w = await workspace();
  try {
    assert.equal((await attest(w.dir, w.last)).code, 0);

    // STEP 5. `loom cohort` keys on the queried run's own last row, so immediately after the
    // attestation nothing is excluded yet; one re-score under the exam ruler makes the other 29
    // rows the stale ones.
    assert.deepEqual((await cohortOf(w.dir, w.last)).excludedForWeights, 0);
    const first = await cli(["score", w.last, "--workspace", w.dir]);
    assert.equal(first.code, 0, first.err);
    assert.equal((first.err.match(/^graded /gm) ?? []).length, 30, "the first score grades every member, one exam run each, and says so");
    const scored = jsonOf<{ golden: boolean; outcome: number; signals: { id: string; evidence: string }[]; cohort: { n: number } }>(first.out);
    assert.match(scored.signals[0]!.evidence, /^exam \w+ graph sha256:/, "S1 is the exam's, not the graph's");
    assert.equal(scored.outcome, 0, "n = 30 is even-length, so the exam fails it whatever `check` said");
    assert.equal(scored.cohort.n, 30);
    const after = await cohortOf(w.dir, w.last);
    assert.equal(after.members.length, 1);
    assert.equal(after.excludedForWeights, 29, "every other row was scored under the pre-exam ruler");
    for (const id of w.ids) if (id !== w.last) assert.equal((await cli(["score", id, "--workspace", w.dir])).code, 0);
    const all = await cohortOf(w.dir, w.last);
    assert.equal(all.excludedForWeights, 0);
    assert.equal(all.members.filter((m) => m.golden).length, 10, "golden is decided by the exam: the ten odd-length runs");

    // STEP 6 · audit repro 1.
    const noop = await live(w.dir, "candidates/noop.json", w.last);
    assert.equal(noop.code, 1, `${noop.out}\n${noop.err}`);
    const dn = jsonOf<LiveDecision>(noop.out);
    assert.equal(dn.promote, false);
    assert.equal(dn.paired.mean, -0.2);
    assert.deepEqual([dn.paired.wins, dn.paired.losses, dn.paired.ties], [0, 10, 20]);
    assert.equal(check(dn, "L1-paired-improvement").pass, false);
    assert.equal(check(dn, "L5-candidate-earned-it").pass, false);
    assert.ok(dn.pairs.every((p) => p.candidateScore === 0 && p.candidateExamRunId === undefined), "`picked` is absent from every candidate output: ungradable, and no exam run was made");

    // STEP 7 · audit repro 2 through the live door.
    const rigged = await live(w.dir, "candidates/rigged.json", w.last);
    assert.equal(rigged.code, 1);
    const dr = jsonOf<LiveDecision>(rigged.out);
    assert.equal(dr.paired.mean, 0);
    assert.deepEqual([dr.paired.wins, dr.paired.losses, dr.paired.ties], [0, 0, 30], "the exam grades identical `picked` on both sides");
    assert.equal(check(dr, "L1-paired-improvement").pass, false);

    // STEP 8 · attack R, refused before any run.
    refusedWith(await live(w.dir, "candidates/renamed.json", w.last), /"pick-bench-2" and the cohort is workflow "pick-bench"/);
    // …attack Q: thirty more recordings on inputs the baseline gets RIGHT, made after the attestation.
    for (let n = 1; n <= 30; n++) await record(w.dir, "graphs/pick.json", { items: [`late-${String(n)}`, "b", "c"] });
    const noopAgain = await live(w.dir, "candidates/noop.json", w.last);
    const dq = jsonOf<LiveDecision>(noopAgain.out);
    assert.equal(dq.paired.n, 30, "the new recordings are after corpusThrough and are not questions");
    assert.equal(dq.paired.mean, -0.2);
    assert.equal(dq.afterCorpus, 30);
    assert.match(noopAgain.err, /30 recording\(s\) of this workflow are newer than the attestation's corpusThrough/);

    // STEP 9 · THE ORDINARY HALF.
    const fixed = await live(w.dir, "candidates/fixed.json", w.last);
    assert.equal(fixed.code, 0, `${fixed.out}\n${fixed.err}`);
    const df = jsonOf<LiveDecision>(fixed.out);
    assert.equal(df.promote, true, JSON.stringify(df.checks.filter((c) => c.ran && !c.pass)));
    assert.equal(df.paired.mean, 0.4);
    assert.deepEqual([df.paired.wins, df.paired.losses, df.paired.ties], [20, 0, 10]);
    assert.equal(df.paired.lower95.toFixed(4), "0.3108");
    assert.equal(df.paired.wilcoxonLower95, 0.3);
    assert.equal(check(df, "3-cost").pass, true);
    assert.match(df.examGraphHash ?? "", /^sha256:/);
    assert.equal(df.corpusThrough, w.last);
    assert.equal(df.pairs.length, 30);
    assert.equal(df.pairs.filter((p) => p.baselineExamRunId !== undefined && p.candidateExamRunId !== undefined).length, 30, "60 exam run ids: one grade per side per pair");
    const cert = (await journal(w.dir, df.pairs[0]!.baselineRunId))
      .filter((e): e is Extract<JournalEvent, { type: "operator.command" }> => isEvent(e, "operator.command") && e.payload.kind === "evolution.promote")
      .map((e) => e.payload.args as { examGraphHash?: string; promote: boolean });
    assert.ok(cert.some((c) => c.promote && c.examGraphHash === df.examGraphHash), "the journaled certificate names the exam");
  } finally {
    w.dispose();
  }
});

// ── 10 · unattested workflows fold as before ─────────────────────────────────

test("STEP 10 · an other-bench run's `loom score` prints, byte for byte, what it printed before the attestation", async () => {
  const w = await workspace();
  try {
    const before = await cli(["score", w.others[0]!, "--workspace", w.dir]);
    assert.equal((await attest(w.dir, w.last)).code, 0);
    assert.equal((await cli(["score", w.last, "--workspace", w.dir])).code, 0);
    const after = await cli(["score", w.others[0]!, "--workspace", w.dir]);
    assert.equal(after.out, before.out);
    assert.match(jsonOf<{ signals: { evidence: string }[] }>(after.out).signals[0]!.evidence, /assertions passed/, "in-graph S1, no exam");
  } finally {
    w.dispose();
  }
});

// ── 11 · poisoning cannot recur ──────────────────────────────────────────────

test("STEP 11 · a rigged grader published by hand marks nothing golden the exam failed; re-attesting admits its recordings; the freeze pins only exam-certified outputs; a renamed graph is a new, unattested workflow", async () => {
  const w = await workspace();
  try {
    assert.equal((await attest(w.dir, w.last)).code, 0);
    cpSync(join(w.dir, "candidates", "rigged.json"), join(w.dir, "graphs", "rigged.json"));
    const rigged: RunId[] = [];
    for (let n = 1; n <= 30; n++) rigged.push(await record(w.dir, "graphs/rigged.json", { items: items(n) }));
    const rl = rigged[rigged.length - 1]!;
    // The exam was attested for workflow pick-bench, and these runs are pick-bench: S1 is the
    // exam's, however `check-rigged` flattered them.
    let golden = 0;
    for (const [i, id] of rigged.entries()) {
      const r = await cli(["score", id, "--workspace", w.dir]);
      assert.equal(r.code, 0, r.err);
      const s = jsonOf<{ golden: boolean; outcome: number; signals: { evidence: string }[] }>(r.out);
      assert.match(s.signals[0]!.evidence, /^exam /);
      const odd = (i + 1) % 3 === 1;
      assert.equal(s.outcome, odd ? 1 : 0, `run ${String(i + 1)}: the exam decides, not check-rigged`);
      if (s.golden) golden++;
    }
    assert.equal(golden, 10, "only the odd-length runs — never a run the exam failed, whatever the rigged grader wrote");

    // Re-attest the SAME exam on the rigged cohort: same ruler, corpusThrough advances.
    const re = await attest(w.dir, rl);
    assert.equal(re.code, 0, re.err);
    assert.match(re.err, /the same exam re-attested: same ruler, newer questions/);
    assert.equal(jsonOf<{ corpusThrough: string }>(re.out).corpusThrough, rl);
    const frozen = await cli(["suite", "freeze", "--cohort", rl, "--out", join(w.dir, "rigged-suite.json"), "--workspace", w.dir]);
    assert.equal(frozen.code, 0, `${frozen.out}\n${frozen.err}`);
    const suite = JSON.parse(readFileSync(join(w.dir, "rigged-suite.json"), "utf8")) as EvalSuite;
    const pinned = suite.cases.filter((c) => c.expect.channels !== undefined);
    assert.equal(pinned.length, 10);
    for (const c of pinned) {
      const picked = (c.expect.channels as { picked: string[] }).picked;
      const n = Number(picked[0]!.split("-")[1]);
      assert.equal(picked.length, 2 + (n % 3), `case ${c.id} pins a complete pick — an exam-certified output`);
    }

    // AND THE GRADER SWAP IS REFUSED ON THIS SUITE TOO, THOUGH THE WORKFLOW IS ATTESTED. Check 12
    // used to pass here with "skipped: this workflow has an operator-attested exam", and the same
    // command printed `"promote": true`, exit 0 — the audit's reproduction 2, through the replayed
    // door, on a suite this binary froze. The skip's premise was that nothing which decides reads
    // the in-graph grader once an exam exists; `run/engine.ts`'s `#checkConfidence` does, on every
    // run, and raises a posture escalation the rigged grader silences. This is the pin on that.
    const swap = await cli([
      "promote", join(w.dir, "candidates", "rigged.json"),
      "--baseline", join(w.dir, "graphs", "pick.json"),
      "--suite", join(w.dir, "rigged-suite.json"),
      "--workspace", w.dir,
    ]);
    assert.equal(swap.code, 1, `${swap.out}\n${swap.err}`);
    assert.match(swap.out, /✗ 12-grader-unchanged.*node:check function\/check@stable → function\/check-rigged@stable/);
    const sd = jsonOf<{ promote: boolean; examAttested: boolean; checks: { id: string; pass: boolean }[] }>(swap.out);
    assert.equal(sd.promote, false);
    assert.equal(sd.examAttested, true, "the workflow IS attested — that is the premise this test needs");
    assert.deepEqual(sd.checks.filter((c) => !c.pass).map((c) => c.id), ["12-grader-unchanged"], "and 12 is the only thing standing in its way");

    // The rename buys a new workflow, not a way past the exam.
    cpSync(join(w.dir, "candidates", "renamed.json"), join(w.dir, "graphs", "renamed.json"));
    const renamed: RunId[] = [];
    for (let n = 1; n <= 6; n++) renamed.push(await record(w.dir, "graphs/renamed.json", { items: items(n) }));
    const s = await cli(["score", renamed[0]!, "--workspace", w.dir]);
    assert.equal(s.code, 0);
    assert.match(jsonOf<{ signals: { evidence: string }[] }>(s.out).signals[0]!.evidence, /assertions passed/, "pick-bench-2 has no attestation: in-graph S1");
    refusedWith(await cli(["suite", "freeze", "--cohort", renamed[0]!, "--out", join(w.dir, "r.json"), "--workspace", w.dir]), /workflow "pick-bench-2".*loom exam attest/);
    refusedWith(await live(w.dir, "candidates/fixed.json", renamed[0]!), /"pick-bench" and the cohort is workflow "pick-bench-2"|workflow "pick-bench-2".*loom exam attest/);
  } finally {
    w.dispose();
  }
});

// ── 12 · restart survives; the file is a cache ───────────────────────────────

test("STEP 12 · with the exam file deleted the row still grades — same verdict, ✓ L1; a workspace without graphs/ refuses", async () => {
  const w = await workspace();
  try {
    assert.equal((await attest(w.dir, w.last)).code, 0);
    unlinkSync(join(w.dir, "exams", "pick-exam.json"));
    const fixed = await live(w.dir, "candidates/fixed.json", w.last);
    assert.equal(fixed.code, 0, `${fixed.out}\n${fixed.err}`);
    const d = jsonOf<LiveDecision>(fixed.out);
    assert.equal(d.paired.mean, 0.4);
    assert.deepEqual([d.paired.wins, d.paired.losses, d.paired.ties], [20, 0, 10]);

    rmSync(join(w.dir, "graphs"), { recursive: true, force: true });
    const r = await live(w.dir, "candidates/fixed.json", w.last);
    assert.ok(isLoomError(r.thrown) && r.thrown.code === CODES.E_RUN_NOT_FOUND, String(r.thrown));
  } finally {
    w.dispose();
  }
});

// ── a recording that never finished is not a question, and refuses nothing ───

test("A RECORDING WITH NO run.completed IN THE COHORT DOES NOT REFUSE THE HONEST CANDIDATE — it was never a member", async () => {
  const w = await workspace();
  try {
    // Submitted and never advanced: same graph, same input shape, no terminal event.
    const ws = openWorkspace(parseArgs(["gates", "--workspace", w.dir]));
    let pending: RunId;
    try {
      const spec = JSON.parse(readFileSync(join(w.dir, "graphs", "pick.json"), "utf8")) as GraphSpec;
      const g = compileOrThrow({ spec, resolver: ws.resolver, tools: (ws.engine.tools as ToolRegistry).manifests(), tenantCapabilities: ws.granted });
      pending = await ws.engine.submit({ graph: g, inputs: { items: ["p", "q", "r"] } });
    } finally {
      ws.close();
    }
    // Attested AFTER the pending run, so corpusThrough covers it.
    const a = await attest(w.dir, pending);
    assert.equal(a.code, 0, `${a.out}\n${a.err}\n${String(a.thrown)}`);
    const fixed = await live(w.dir, "candidates/fixed.json", w.last);
    assert.equal(fixed.code, 0, `${fixed.out}\n${fixed.err}`);
    const d = jsonOf<LiveDecision>(fixed.out);
    assert.equal(d.paired.n, 30, "the pending run is not a pair; the thirty recordings are");
    assert.equal(d.paired.mean, 0.4);
    assert.equal(d.pairs.some((p) => p.baselineRunId === pending), false);
    // And scoring the pending run itself answers as it always did: the floor's 0, no exam run.
    const s = await cli(["score", pending, "--workspace", w.dir]);
    assert.equal(s.code, 0, `${s.err}\n${String(s.thrown)}`);
    assert.equal(jsonOf<{ score: number; components: { completed: boolean } }>(s.out).components.completed, false);
    assert.match(s.err, /is "incomplete", not succeeded/);
  } finally {
    w.dispose();
  }
});

test("THE ATTESTATION SURVIVES ITS ANCHOR'S GRAPH BEING UNPUBLISHED — a file does not decide the ruler", async () => {
  const w = await workspace();
  try {
    assert.equal((await attest(w.dir, w.last)).code, 0);
    // A second published graph of the same workflow, so the workflow still has recordings to score.
    cpSync(join(w.dir, "candidates", "rigged.json"), join(w.dir, "graphs", "rigged.json"));
    const r = await record(w.dir, "graphs/rigged.json", { items: items(2) });
    unlinkSync(join(w.dir, "graphs", "pick.json"));
    const s = await cli(["score", r, "--workspace", w.dir]);
    assert.equal(s.code, 0, s.err);
    assert.match(jsonOf<{ signals: { evidence: string }[] }>(s.out).signals[0]!.evidence, /^exam /, "S1 is still the exam's, not check-rigged's");
  } finally {
    w.dispose();
  }
});

test("A NEWEST ATTESTATION ROW THIS BINARY CANNOT READ REFUSES — no fallback to an older row or to in-graph S1", async () => {
  const w = await workspace();
  try {
    assert.equal((await attest(w.dir, w.last)).code, 0);
    const ws = openWorkspace(parseArgs(["gates", "--workspace", w.dir]));
    try {
      await ws.store.append({
        runId: w.last,
        expectedSeq: await ws.store.head(w.last),
        events: [{ type: "operator.command", payload: { kind: "evolution.exam-attest", args: { workflow: "pick-bench" } }, actor: { kind: "human", subject: "someone", via: "console" } }],
      });
    } finally {
      ws.close();
    }
    refusedWith(await cli(["score", w.last, "--workspace", w.dir]), /newest evolution\.exam-attest row .* is not one this binary can read/);
    refusedWith(await live(w.dir, "candidates/fixed.json", w.last), /is not one this binary can read/);
  } finally {
    w.dispose();
  }
});

// ── the forged grade: a grade is verified before it is believed ──────────────

test("A FORGED EXAM RUN IS NOT A GRADE: the attested hash with an edited body is refused by its manifest, and the body restored, the forgery is ignored", async () => {
  const w = await workspace();
  try {
    assert.equal((await attest(w.dir, w.last)).code, 0);
    const odd = w.ids[0]!; // n = 1, odd-length: the exam passes it
    const done = (await journal(w.dir, odd)).find((e): e is Extract<JournalEvent, { type: "run.completed" }> => isEvent(e, "run.completed"));
    const picked = done!.payload.outputs["picked"];
    // The forgery: edit the exam's body to always fail, run the exam graph by hand over the
    // recording's exact inputs, then put the body back.
    const bodyPath = join(w.dir, "resources", "function", "exam-pick.js");
    writeFileSync(bodyPath, FN["exam-pick-forged"]!);
    const forged = await cli(["run", join(w.dir, "exams", "pick-exam.json"), "--workspace", w.dir, "--input", JSON.stringify({ subject: odd, items: items(1), picked })]);
    assert.equal(forged.code, 0, forged.err);
    // With the body still edited, every scoring verb refuses: the exam resolves differently.
    refusedWith(await cli(["score", odd, "--workspace", w.dir]), /resolves differently in this workspace.*Re-attest/);
    writeFileSync(bodyPath, FN["exam-pick"]!);
    const s = await cli(["score", odd, "--workspace", w.dir]);
    assert.equal(s.code, 0, s.err);
    const scored = jsonOf<{ outcome: number; signals: { evidence: string }[] }>(s.out);
    assert.equal(scored.outcome, 1, "the forged run's manifest is not the attested one, so it is not a grade; a real exam run was made");
    const forgedId = (JSON.parse(forged.out) as { runId: string }).runId;
    assert.doesNotMatch(scored.signals[0]!.evidence, new RegExp(forgedId));
  } finally {
    w.dispose();
  }
});

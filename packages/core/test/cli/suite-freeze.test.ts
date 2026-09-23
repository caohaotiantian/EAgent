/**
 * THE EXAM IS CUT OUT OF THE RUNS, BY THE RUNS' OWN VERDICTS — nobody types a case.
 *
 * `loom promote --suite` judged a candidate against a hand-authored `EvalSuite`: a person picked
 * which recordings became cases and wrote the expectations. So "a candidate was promoted over the
 * cohort" was a claim somebody assembled, and D6's whole freeze argument is about not letting the
 * exam be shaped around a known student. `test/evolution/close-the-loop.test.ts` had the
 * selection rule as a function INSIDE a test — the standing `scoreTrajectory` had before `loom
 * score` and `gateCandidate` had before `loom promote`. `loom suite freeze` is the door.
 *
 * What these tests hold down, in the order they matter:
 *
 * 1. EVERY CASE IS A RUN THIS WORKSPACE RECORDED AND JUDGED. The case set is exactly the runs
 *    carrying an `evolution.scored` row under this cohort key and these weights, and no flag on
 *    the verb names a runId — the only way into the exam is to have been run and scored here.
 *    `mustPass` is the journaled `golden` verdict and not a choice.
 * 2. THE EXPECTATIONS ARE THE ONES THE CORPUS CAN JUSTIFY. A golden run's non-grader, non-input
 *    channels are pinned; a non-golden run's are not, because pinning what a low-scoring run
 *    produced would make a candidate that improves on it score WORSE. The grader's own channel
 *    is never pinned by either — a candidate that rewrites the grader passes any suite that
 *    reads the grader.
 * 3. THE FROZEN EXAM REFUSES A REGRESSION NOBODY DESCRIBED. A candidate that breaks the runs
 *    the corpus called golden fails `1-must-pass` over a suite no human wrote — and the
 *    honest control beside it: the GOOD candidate promotes at Δ 0.0pp, because every
 *    expectation this verb can write is "keep doing this". This suite is a regression floor,
 *    not an improvement exam, and the test says the number rather than the docstring claiming it.
 * 4. THE REFUSALS. A suite file that already exists (a re-frozen exam is not frozen); a cohort
 *    whose runs were never judged, refused DIFFERENTLY from one that is merely small; and
 *    `--proposed-by loom-suite-freeze`, which is the collision that made a shipped demo script's
 *    promotion fail `10-separate-lineage` by construction.
 *
 * Offline and deterministic: `function` and `evaluator{assertion}` nodes only, so no provider is
 * asked anything and no model adapter is configured. Nothing here asserts a wall-clock-derived
 * number — `frozenAt` is only ever compared against a timestamp read in the same process, which
 * is an ordering and not an elapsed duration.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, openWorkspace, parseArgs } from "../../src/cli.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import { newGateId, type NodeId, type RunId } from "../../src/ids.ts";
import { isEvent, type EventPayloads, type JournalEvent } from "../../src/journal/events.ts";
import { foldRun } from "../../src/run/projection.ts";
import type { EvalSuite } from "../../src/evolution/gate.ts";

// ---------------------------------------------------------------------------
// the corpus: close-the-loop.test.ts's workflow, published as a real workspace
// ---------------------------------------------------------------------------

/**
 * `pick` keeps every item, and `check` asserts mechanically that it did.
 *
 * The baseline is wrong on the even-length half of the corpus on purpose, so its runs split into
 * goldens and non-goldens by their own assertion — which is what gives the freeze both halves to
 * select from. The defect is in a deterministic FUNCTION body rather than a prompt because an
 * offline gate replays recorded model turns and cannot see a prompt change at all.
 */
const spec = (ref: string): unknown => ({
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "pick-bench", project: "demo", version: 1 },
  policy: { posture: "out", capabilities: [] },
  channels: {
    items: { type: "array", reduce: "replace" },
    picked: { type: "array", reduce: "replace" },
    verdict: { type: "object", reduce: "replace" },
  },
  inputs: ["items"],
  // `picked` is an OUTPUT so the attested exam can read it: the exam grades terminal outputs.
  outputs: ["picked", "verdict"],
  nodes: [
    { id: "pick", type: "function", reads: ["items"], writes: ["picked"], function: { ref } },
    {
      id: "check",
      type: "evaluator",
      reads: ["items", "picked"],
      writes: ["verdict"],
      evaluator: { kind: "assertion", ref: "function/check@stable", threshold: 0.5 },
    },
  ],
  edges: [{ id: "e", from: "pick", to: "check", kind: "seq" }],
});

async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const errOut: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => (errOut.push(String(c)), true)) as typeof process.stderr.write;
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: errOut.join("") };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

interface Fixture {
  readonly dir: string;
  readonly ids: readonly string[];
  readonly dispose: () => void;
}

/** A workspace with the workflow published and `runs` recordings in it. Scored only if asked. */
async function corpus(runs: number, opts: { score: boolean }): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "loom-freeze-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  mkdirSync(join(dir, "resources", "function"), { recursive: true });
  const fn = (name: string, body: string): void => writeFileSync(join(dir, "resources", "function", `${name}.js`), body);
  fn(
    "pick",
    `(view) => {
      const items = view.get("items") ?? [];
      return { writes: { picked: items.length % 2 === 0 ? items.slice(0, -1) : items.slice() } };
    }`,
  );
  fn("pick-v2", `(view) => ({ writes: { picked: (view.get("items") ?? []).slice() } })`);
  // A "candidate" that drops the FIRST item: it fixes nothing and breaks the odd-length runs the
  // baseline got right — exactly the runs the corpus called golden.
  fn("pick-v3", `(view) => ({ writes: { picked: (view.get("items") ?? []).slice(1) } })`);
  fn(
    "check",
    `(view) => {
      const items = view.get("items") ?? [];
      const picked = view.get("picked") ?? [];
      return { writes: { verdict: { pass: picked.length === items.length, confidence: 1, detail: picked.length + "/" + items.length } } };
    }`,
  );
  fn(
    "exam-pick",
    `(view) => {
      const want = view.get("items") ?? [];
      const got = view.get("picked") ?? [];
      const ok = JSON.stringify(got) === JSON.stringify(want);
      return { writes: { verdict: { pass: ok, score: ok ? 1 : 0, confidence: 1, detail: ok ? "kept every item" : "dropped an item" } } };
    }`,
  );
  mkdirSync(join(dir, "exams"), { recursive: true });
  // THE OPERATOR'S EXAM: the grader outside every candidate graph. `suite freeze` refuses a
  // workflow with none, because `golden` — what selects a must-pass case — would otherwise rest
  // on the graph's own evaluator, which a candidate authors.
  writeFileSync(
    join(dir, "exams", "pick-exam.json"),
    JSON.stringify({
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "pick-exam", project: "demo", version: 1 },
      policy: { posture: "out", capabilities: [] },
      channels: {
        subject: { type: "string", reduce: "replace" },
        items: { type: "array", reduce: "replace" },
        picked: { type: "array", reduce: "replace" },
        verdict: { type: "object", reduce: "replace" },
      },
      inputs: ["subject", "items", "picked"],
      outputs: ["verdict"],
      nodes: [{ id: "grade", type: "evaluator", reads: ["items", "picked"], writes: ["verdict"], evaluator: { kind: "assertion", ref: "function/exam-pick@stable", threshold: 0 } }],
      edges: [],
    }),
  );
  writeFileSync(join(dir, "graphs", "pick.json"), JSON.stringify(spec("function/pick@stable")));
  // NOT in graphs/: a candidate is by definition not published, and `loom score` reads that
  // directory as the promoted set.
  writeFileSync(join(dir, "better.json"), JSON.stringify(spec("function/pick-v2@stable")));
  writeFileSync(join(dir, "worse.json"), JSON.stringify(spec("function/pick-v3@stable")));

  const ids: string[] = [];
  for (let n = 1; n <= runs; n++) {
    // Lengths 2..4 and distinct strings: the shape bucket has to join runs over genuinely
    // different inputs, or no real workflow could ever reach a cohort of 30.
    const items = Array.from({ length: 2 + (n % 3) }, (_, i) => `doc-${String(n)}-${String(i)}`);
    const r = await cli(["run", join(dir, "graphs", "pick.json"), "--workspace", dir, "--input", JSON.stringify({ items })]);
    assert.equal(r.code, 0, r.err);
    const p = JSON.parse(r.out) as { runId: string; status: string };
    assert.equal(p.status, "succeeded", `run ${String(n)} did not finish`);
    ids.push(p.runId);
  }
  // Attested BEFORE any score, so every journaled verdict is under the exam's ruler.
  const attested = await cli(["exam", "attest", join(dir, "exams", "pick-exam.json"), "--cohort", ids[0]!, "--as", "u:operator", "--workspace", dir]);
  assert.equal(attested.code, 0, attested.err);
  if (opts.score) {
    for (const id of ids) assert.equal((await cli(["score", id, "--workspace", dir])).code, 0);
  }
  return { dir, ids, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** One shared 30-run scored corpus: building it is the expensive part, and it never mutates. */
let shared: Promise<Fixture> | undefined;
const scoredCorpus = (): Promise<Fixture> => (shared ??= corpus(30, { score: true }));
test.after(async () => {
  if (shared !== undefined) (await shared).dispose();
});

/**
 * Like `freeze`/`cli`, but folds a THROW into the same shape — TODO.md §A.91's B1 fixture needs
 * this, because `resolveRecordedGraph`'s warning/refusal text is printed to stderr from INSIDE
 * `freezeSuite`, before a later, unrelated refusal (no exam; cohort too small) throws and unwinds
 * past `cli`'s own return — which would otherwise discard everything captured on the way there.
 */
async function freezeCapture(dir: string, anchor: string, out: string, extra: string[] = []): Promise<{ code: number; out: string; err: string }> {
  const outArr: string[] = [];
  const errArr: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => (outArr.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => (errArr.push(String(c)), true)) as typeof process.stderr.write;
  try {
    const code = await main(["suite", "freeze", "--cohort", anchor, "--workspace", dir, "--out", out, ...extra]);
    return { code, out: outArr.join(""), err: errArr.join("") };
  } catch (e) {
    return { code: 1, out: outArr.join(""), err: `${errArr.join("")}${(e as Error).message}\n` };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

async function freeze(dir: string, anchor: string, out: string, extra: string[] = []): Promise<{ code: number; out: string; err: string }> {
  return await cli(["suite", "freeze", "--cohort", anchor, "--workspace", dir, "--out", out, ...extra]);
}

function readSuite(file: string): EvalSuite {
  return JSON.parse(readFileSync(file, "utf8")) as EvalSuite;
}

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

function lastScore(events: readonly JournalEvent[]): EventPayloads["evolution.scored"] | undefined {
  let found: EventPayloads["evolution.scored"] | undefined;
  for (const e of events) if (isEvent(e, "evolution.scored")) found = e.payload;
  return found;
}

// ---------------------------------------------------------------------------
// 1 · the cases are runs, and their own verdicts chose them
// ---------------------------------------------------------------------------

test("EVERY CASE IS A RUN THIS WORKSPACE RECORDED, AND ITS OWN JOURNALED VERDICT PUT IT THERE", async () => {
  const c = await scoredCorpus();
  const before = Date.now();
  const out = join(c.dir, "cohort-suite.json");
  const r = await freeze(c.dir, c.ids[0]!, out);
  assert.equal(r.code, 0, r.err);

  const suite = readSuite(out);
  assert.equal(suite.frozen, true, "the field that says a file was meant to be an exam");
  assert.ok(suite.frozenAt >= before && suite.frozenAt <= Date.now(), "frozenAt is a real freeze time");
  assert.equal(suite.generatedBy, "loom-suite-freeze");

  // THE CLAIM THAT MATTERS: no case can be injected. Every one of them names a run in this
  // workspace whose journal carries the verdict that selected it, and `mustPass` IS that
  // verdict — not a field anybody typed.
  const recorded = new Set(c.ids);
  for (const kase of suite.cases) {
    assert.ok(recorded.has(kase.runId), `case ${kase.id} names ${kase.runId}, which this workspace never ran`);
    const sc = lastScore(await journal(c.dir, kase.runId));
    assert.notEqual(sc, undefined, `case ${kase.id} names a run with no evolution.scored row`);
    assert.equal(kase.mustPass, sc!.golden, `case ${kase.id}: mustPass must BE the journaled golden verdict`);
    assert.equal(sc!.components.delivered, true, "…and the run must be in the population the ruler was built from");
  }

  // BOTH HALVES, which is the composition rule rather than an accident of this corpus. A suite
  // of goldens only is one the baseline passes by construction — measured in
  // test/evolution/close-the-loop.test.ts — and one of non-goldens only has no floor at all.
  const must = suite.cases.filter((x) => x.mustPass);
  assert.ok(must.length > 0, "goldens became must-pass regression cases");
  assert.ok(must.length < suite.cases.length, "and the runs the baseline got wrong are in it too");
  assert.equal(suite.cases.length, 30, "no --cases cap, so every judged member of the cohort is a case");
  assert.deepEqual(new Set(suite.cases.map((x) => x.id)).size, 30, "case ids are unique — validateSuite checks it too");

  // THE FREEZE IS IN THE JOURNAL, not only on disk: the file is a projection, and a suite the
  // journal cannot account for is one nobody can audit later.
  const rows = (await journal(c.dir, c.ids[0]!))
    .filter((e) => isEvent(e, "operator.command"))
    .map((e) => e.payload as EventPayloads["operator.command"])
    .filter((p) => p.kind === "evolution.suite-freeze");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.args["frozenAt"], suite.frozenAt, "the journaled freeze time IS the suite's");
  assert.equal(rows[0]!.args["cases"], 30);
});

// ---------------------------------------------------------------------------
// 2 · what the expectations are, and what they deliberately are not
// ---------------------------------------------------------------------------

test("A GOLDEN CASE PINS THE WORK CHANNEL — NEVER THE GRADER'S, NEVER THE INPUT'S", async () => {
  const c = await scoredCorpus();
  const out = join(c.dir, "expectations.json");
  assert.equal((await freeze(c.dir, c.ids[0]!, out)).code, 0);
  const suite = readSuite(out);

  const golden = suite.cases.filter((x) => x.mustPass);
  const rest = suite.cases.filter((x) => !x.mustPass);

  for (const kase of golden) {
    assert.deepEqual(Object.keys(kase.expect.channels ?? {}), ["picked"], `case ${kase.id}`);
    // `verdict` is what the `evaluator` node wrote. A candidate that rewrites the grader passes
    // any suite that reads the grader, so the freeze excludes it by NODE TYPE rather than by
    // name — this assertion is what says the exclusion happened.
    assert.equal("verdict" in (kase.expect.channels ?? {}), false, "the grader's own channel is never an expectation");
    // `items` is the graph's declared input. Replay serves it from the recording, so pinning it
    // would assert nothing about the candidate.
    assert.equal("items" in (kase.expect.channels ?? {}), false, "an input channel asserts nothing about a candidate");
    assert.equal(kase.expect.status, "succeeded");
    assert.equal(kase.expect.noIrreversibleWithoutGate, true, "the one expectation that is an invariant, not an output");
  }

  // THE COST, STATED AS A MEASUREMENT. An expectation taken from what the baseline PRODUCED
  // bakes its mistakes into the exam, so the non-golden half — the runs the corpus scored low —
  // gets no channel expectation at all. Pinning theirs would make a candidate that improves on
  // them score WORSE, and `2-non-inferior` would refuse the improvement.
  assert.ok(rest.length > 0);
  for (const kase of rest) {
    assert.equal(kase.expect.channels, undefined, `case ${kase.id} must pin no output the corpus did not certify`);
    assert.equal(kase.expect.status, "succeeded");
  }
});

// ---------------------------------------------------------------------------
// 3 · the frozen exam refuses a regression nobody described
// ---------------------------------------------------------------------------

test("A CANDIDATE THAT BREAKS THE CORPUS'S OWN GOLDENS IS REFUSED BY AN EXAM NO HUMAN WROTE", async () => {
  const c = await scoredCorpus();
  const suiteFile = join(c.dir, "regression-floor.json");
  assert.equal((await freeze(c.dir, c.ids[0]!, suiteFile, ["--cases", "12"])).code, 0);

  const promote = async (graph: string): Promise<{ code: number; decision: { promote: boolean; checks: { id: string; pass: boolean }[] } }> => {
    const r = await cli([
      "promote", join(c.dir, graph),
      "--baseline", join(c.dir, "graphs", "pick.json"),
      "--suite", suiteFile,
      "--proposed-by", "an-optimiser",
      "--workspace", c.dir,
    ]);
    const json = r.out.slice(r.out.indexOf("{"));
    return { code: r.code, decision: JSON.parse(json) as { promote: boolean; checks: { id: string; pass: boolean }[] } };
  };

  const worse = await promote("worse.json");
  assert.equal(worse.decision.promote, false);
  assert.equal(worse.code, 1);
  assert.deepEqual(
    worse.decision.checks.filter((x) => !x.pass).map((x) => x.id).sort(),
    ["1-must-pass", "2-non-inferior"],
    "it broke regressions the corpus named for itself, and the pass rate says so",
  );
  // The two provenance rules that make a machine-written exam trustworthy both held: the suite
  // was frozen before this candidate was proposed, and it was not signed by its proposer.
  for (const id of ["9-suite-predates-candidate", "10-separate-lineage", "0-suite"]) {
    assert.equal(worse.decision.checks.find((x) => x.id === id)!.pass, true, id);
  }

  // THE HONEST CONTROL, and it is the sentence this whole verb has to be read with. The GOOD
  // candidate promotes — and it promotes on a TIE, because every expectation a freeze can write
  // is "keep doing this". A suite cut from a corpus is a regression floor; the claim that a
  // candidate is BETTER is what `promote --against-cohort` measures, live.
  const better = await promote("better.json");
  assert.equal(better.decision.promote, true, JSON.stringify(better.decision.checks.filter((x) => !x.pass)));
  assert.equal(better.code, 0);
  const delta = better.decision.checks.find((x) => x.id === "2-non-inferior")!;
  assert.match(JSON.stringify(delta), /Δ 0\.0pp/, "not an improvement: a tie, and the exam is a floor rather than a race");
});

// ---------------------------------------------------------------------------
// 4 · --cases is a cap, never a selector
// ---------------------------------------------------------------------------

test("--cases CAPS AND SPANS THE SCORE DISTRIBUTION — it never takes the top", async () => {
  const c = await scoredCorpus();
  const out = join(c.dir, "capped.json");
  assert.equal((await freeze(c.dir, c.ids[0]!, out, ["--cases", "6"])).code, 0);
  const suite = readSuite(out);
  assert.equal(suite.cases.length, 6);

  const scores = new Map<string, number>();
  for (const id of c.ids) {
    const sc = lastScore(await journal(c.dir, id));
    if (sc !== undefined) scores.set(id, sc.score);
  }
  const all = [...scores.values()].sort((a, b) => a - b);
  const picked = suite.cases.map((x) => scores.get(x.runId)!).sort((a, b) => a - b);
  // BOTH ENDS. A cap that took the best six would be the exam the baseline passes by
  // construction; one that took the worst six would have no regression floor. The sample carries
  // the cohort's minimum AND its maximum, so neither failure is reachable through this flag.
  assert.equal(picked[0], all[0], "the lowest-scoring judged run is in the sample");
  assert.equal(picked[picked.length - 1], all[all.length - 1], "…and so is the highest");
  assert.ok(suite.cases.some((x) => x.mustPass) && suite.cases.some((x) => !x.mustPass), "both halves survive the cap");

  // A cap smaller than the exam's own resolution is refused at the flag, before the file exists —
  // the file is not rewritable, so learning this afterwards costs a path.
  await assert.rejects(
    () => freeze(c.dir, c.ids[0]!, join(c.dir, "too-small.json"), ["--cases", "3"]),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /at least 6/.test(e.message),
  );
  assert.equal(existsSync(join(c.dir, "too-small.json")), false, "…and it wrote nothing");
});

// ---------------------------------------------------------------------------
// 5 · the refusals
// ---------------------------------------------------------------------------

test("CONTROL · A SUITE FILE THAT ALREADY EXISTS IS NOT OVERWRITTEN — a re-frozen exam is not frozen", async () => {
  const c = await scoredCorpus();
  const out = join(c.dir, "once.json");
  assert.equal((await freeze(c.dir, c.ids[0]!, out)).code, 0);
  const first = readSuite(out);

  await assert.rejects(
    () => freeze(c.dir, c.ids[0]!, out),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /already exists/.test(e.message),
  );
  assert.deepEqual(readSuite(out), first, "the exam on disk is byte-for-byte the one that was frozen");
});

test("CONTROL · A COHORT NOBODY JUDGED IS REFUSED, and refused DIFFERENTLY from one that is too small", async () => {
  // Thirty runs, none of them scored. The cohort is large enough; what it lacks is the verdicts
  // that do the selecting — and answering "no verdicts" with "cohort too small" would send an
  // operator to record runs they already have.
  const unjudged = await corpus(30, { score: false });
  try {
    // Exit 1 and a message, the shape `loom cohort` already uses for "this run was never
    // judged" — a workspace that has not been scored is an operator's next command, not a
    // malformed invocation.
    const r = await freeze(unjudged.dir, unjudged.ids[0]!, join(unjudged.dir, "s.json"));
    assert.equal(r.code, 1);
    assert.match(r.err, /carries no journaled score/);
    assert.match(r.err, /loom score /, "…and it names the command that fixes it");
    assert.equal(existsSync(join(unjudged.dir, "s.json")), false, "and it wrote no exam");
  } finally {
    unjudged.dispose();
  }

  // And a cohort that IS too small says so, naming the population rule rather than the verdicts.
  const small = await corpus(3, { score: true });
  try {
    await assert.rejects(
      () => freeze(small.dir, small.ids[0]!, join(small.dir, "s.json")),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /at least 30/.test(e.message),
    );
  } finally {
    small.dispose();
  }
});

// ---------------------------------------------------------------------------
// B1 · TODO.md §A.91 — the cohort's own graph is resolved BEFORE it is measured
// ---------------------------------------------------------------------------

/**
 * A single scored run of a graph whose one non-input channel uses `last_write_wins_by_ts` —
 * GRAPH013_CLOCK_DEPENDENT, a WARNING rather than a refusal, so the graph still compiles and the
 * run still succeeds. Cheap on purpose: `resolveRecordedGraph` now runs before `examFor` and the
 * `MIN_COHORT_SIZE` floor, so pinning that it announces a warning needs neither an attested exam
 * nor thirty runs — one is enough to reach the resolver, which is the only thing under test.
 */
async function warnCorpus(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "loom-freeze-warn-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  mkdirSync(join(dir, "resources", "function"), { recursive: true });
  writeFileSync(join(dir, "resources", "function", "pick.js"), `(view) => ({ writes: { picked: (view.get("items") ?? []).slice() } })`);
  writeFileSync(
    join(dir, "resources", "function", "check.js"),
    `(view) => {
      const items = view.get("items") ?? [];
      const picked = view.get("picked") ?? [];
      return { writes: { verdict: { pass: picked.length === items.length, confidence: 1, detail: picked.length + "/" + items.length } } };
    }`,
  );
  writeFileSync(
    join(dir, "graphs", "pick.json"),
    JSON.stringify({
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "pick-bench-warn", project: "demo", version: 1 },
      policy: { posture: "out", capabilities: [] },
      channels: {
        items: { type: "array", reduce: "replace" },
        // THE WARNING: a clock-dependent reducer on an ordinary function-node output, nothing
        // to do with gates or tools — GRAPH013 fires on the channel declaration alone.
        picked: { type: "array", reduce: "last_write_wins_by_ts" },
        verdict: { type: "object", reduce: "replace" },
      },
      inputs: ["items"],
      outputs: ["picked", "verdict"],
      nodes: [
        { id: "pick", type: "function", reads: ["items"], writes: ["picked"], function: { ref: "function/pick@stable" } },
        {
          id: "check",
          type: "evaluator",
          reads: ["items", "picked"],
          writes: ["verdict"],
          evaluator: { kind: "assertion", ref: "function/check@stable", threshold: 0.5 },
        },
      ],
      edges: [{ id: "e", from: "pick", to: "check", kind: "seq" }],
    }),
  );
  const r = await cli(["run", join(dir, "graphs", "pick.json"), "--workspace", dir, "--input", JSON.stringify({ items: ["a", "b"] })]);
  assert.equal(r.code, 0, r.err);
  const p = JSON.parse(r.out) as { runId: string; status: string };
  assert.equal(p.status, "succeeded", r.out);
  const scored = await cli(["score", p.runId, "--workspace", dir]);
  assert.equal(scored.code, 0, `${scored.out}${scored.err}`);
  return { dir, ids: [p.runId], dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

test("(a) A COHORT GRAPH THAT COMPILES WITH A WARNING IS ANNOUNCED, not silently frozen — TODO.md §A.91 B1", async () => {
  const c = await warnCorpus();
  try {
    const out = join(c.dir, "warn-suite.json");
    const r = await freezeCapture(c.dir, c.ids[0]!, out);
    // The cohort is one run — no exam is attested and it is nowhere near MIN_COHORT_SIZE, so the
    // command still fails downstream. What is pinned here is EARLIER: `resolveRecordedGraph`
    // resolves the cohort's own graph before either of those refusals, and announces its warning
    // when it does — the reviewer's case (a), reported gone in round 3.
    assert.match(r.out + r.err, /GRAPH013_CLOCK_DEPENDENT/, `the resolved baseline's own warning must be announced:\n${r.out}${r.err}`);
    assert.equal(existsSync(out), false);
  } finally {
    c.dispose();
  }
});

test("(b) A COHORT GRAPH THAT NO LONGER COMPILES IS DIAGNOSED HONESTLY, not blamed on the corpus — TODO.md §A.91 B1", async () => {
  // ONE recorded, scored run — not thirty. `resolveRecordedGraph` now runs before `measureCohort`
  // and the `MIN_COHORT_SIZE` floor, so a broken cohort graph is diagnosed as itself rather than
  // as an empty population; a single run is enough to reach that diagnosis, which is the whole
  // point of the fix (it used to require the reviewer's 30-run corpus to even notice the bug).
  const c = await corpus(1, { score: true });
  try {
    // THE REVIEWER'S OWN REPRO: the cohort's own function resource, deleted out from under it.
    rmSync(join(c.dir, "resources", "function", "pick.js"));
    const out = join(c.dir, "broken-suite.json");
    const r = await freezeCapture(c.dir, c.ids[0]!, out);
    assert.match(r.out + r.err, /GRAPH015_RESOURCE_NOT_FOUND/, `the true reason must reach the operator:\n${r.out}${r.err}`);
    assert.match(r.out + r.err, /graphs[\\/]pick\.json/, `it must name the broken file:\n${r.out}${r.err}`);
    // THE FALSE DIAGNOSIS THIS FIX REMOVES: before B1, a broken cohort graph made `measureCohort`
    // drop the (only) member as specless, and freeze reported "n = 0 ... Record more runs of this
    // workflow first" — blaming the operator's corpus for the operator's graphs/ directory.
    assert.doesNotMatch(r.out + r.err, /n = 0 comparable runs/, `must not fall back to the population refusal:\n${r.out}${r.err}`);
    assert.doesNotMatch(r.out + r.err, /Record more runs of this workflow first/, `must not fall back to the population refusal:\n${r.out}${r.err}`);
    // THE HONEST SENTENCE, WITH NO GUESS — TODO.md §A.91, the reviewer's fifth fix round (B1). The
    // graph FILE is present here (only its resource is gone), so "restore the bytes" alone would be
    // wrong advice too — the sentence must name BOTH possibilities and assert neither.
    assert.match(
      r.out + r.err,
      /If this run's graph file was removed or edited, restore the bytes it ran with; if a candidate named above is that file, fix why it does not compile\./,
      `must give the honest, no-guess advice:\n${r.out}${r.err}`,
    );
    // THE FALSE CLAIM THIS ROUND REMOVES: `missingGraphAdvice`'s branch for this exact case said
    // "the file is already there, and restoring it changes nothing" — an assertion the resolver has
    // no way to know is true, since it cannot tell this candidate apart from an edited or replaced
    // one a `restore` WOULD fix.
    assert.doesNotMatch(r.out + r.err, /restoring it changes nothing/, `must not claim restoring would do nothing:\n${r.out}${r.err}`);
    assert.equal(existsSync(out), false);
  } finally {
    c.dispose();
  }
});

// ---------------------------------------------------------------------------
// B1 (fifth fix round) · the advice must not guess which candidate is the run's own graph
// ---------------------------------------------------------------------------

test("(B1-deleted+unrelated) THE RUN'S GRAPH WAS DELETED, AND AN UNRELATED BROKEN CANDIDATE MUST NOT CHANGE THE ADVICE", async () => {
  // THE REVIEWER'S OWN REPRO: record and score a run, delete ITS graph file, and publish an
  // UNRELATED broken candidate elsewhere. `missingGraphAdvice` read `failed.length > 0` — true here,
  // because the UNRELATED candidate fails to compile — as proof the run's own path held a broken
  // file, and said "fix why it does not compile ... restoring it changes nothing". Both halves are
  // false: the run's own file was DELETED, not broken, and restoring it is exactly the fix.
  const c = await corpus(1, { score: true });
  try {
    rmSync(join(c.dir, "graphs", "pick.json"));
    // An unrelated candidate, broken for an unrelated reason (a missing resource of its own),
    // published in `graphs/` where the sweep will find it but never resolve it as this cohort's
    // graph — the reviewer's own repro names this file `graphs/draft.json`.
    writeFileSync(
      join(c.dir, "graphs", "draft.json"),
      JSON.stringify({
        apiVersion: "loom.dev/v1",
        kind: "GraphSpec",
        metadata: { name: "unrelated", project: "demo", version: 1 },
        policy: { posture: "out", capabilities: [] },
        channels: { items: { type: "array", reduce: "replace" }, picked: { type: "array", reduce: "replace" } },
        inputs: ["items"],
        outputs: ["picked"],
        nodes: [{ id: "pick", type: "function", reads: ["items"], writes: ["picked"], function: { ref: "function/does-not-exist@stable" } }],
        edges: [],
      }),
    );

    const out = join(c.dir, "deleted-suite.json");
    const r = await freezeCapture(c.dir, c.ids[0]!, out);
    assert.match(
      r.out + r.err,
      /If this run's graph file was removed or edited, restore the bytes it ran with; if a candidate named above is that file, fix why it does not compile\./,
      `must give the honest, no-guess advice even with an unrelated broken candidate present:\n${r.out}${r.err}`,
    );
    assert.doesNotMatch(r.out + r.err, /restoring it changes nothing/, `must not claim restoring would do nothing — the file was DELETED:\n${r.out}${r.err}`);
    assert.equal(existsSync(out), false);
  } finally {
    c.dispose();
  }
});

test("(B1-edited) THE RUN'S GRAPH WAS EDITED INTO BROKENNESS, AND THE ADVICE STILL DOES NOT GUESS", async () => {
  // Same path, new bytes: the file is not gone, but the edit itself is what broke it — "restoring"
  // (reverting the edit) WOULD fix this, which is exactly what "restoring it changes nothing" denied.
  const c = await corpus(1, { score: true });
  try {
    const edited = JSON.parse(readFileSync(join(c.dir, "graphs", "pick.json"), "utf8")) as {
      nodes: { function?: { ref: string } }[];
    };
    edited.nodes[0]!.function = { ref: "function/does-not-exist-after-the-edit@stable" };
    writeFileSync(join(c.dir, "graphs", "pick.json"), JSON.stringify(edited));

    const out = join(c.dir, "edited-suite.json");
    const r = await freezeCapture(c.dir, c.ids[0]!, out);
    assert.match(r.out + r.err, /GRAPH015_RESOURCE_NOT_FOUND/, `the true reason must reach the operator:\n${r.out}${r.err}`);
    assert.match(
      r.out + r.err,
      /If this run's graph file was removed or edited, restore the bytes it ran with; if a candidate named above is that file, fix why it does not compile\./,
      `must give the honest, no-guess advice for an edited-and-broken graph:\n${r.out}${r.err}`,
    );
    assert.doesNotMatch(r.out + r.err, /restoring it changes nothing/, `must not claim restoring would do nothing — reverting the edit fixes this:\n${r.out}${r.err}`);
    assert.equal(existsSync(out), false);
  } finally {
    c.dispose();
  }
});

test("CONTROL · --proposed-by CANNOT BE THE IDENTITY THAT WRITES THE EXAMS", async () => {
  // `10-separate-lineage` refuses a promotion whose suite and candidate share a proposer, and it
  // is what makes a machine-written suite trustworthy at all. A shipped demo script this session
  // used one string for both and refused by construction; the flag now says so at the door.
  const c = await scoredCorpus();
  const suiteFile = join(c.dir, "lineage.json");
  assert.equal((await freeze(c.dir, c.ids[0]!, suiteFile, ["--cases", "6"])).code, 0);
  assert.equal(readSuite(suiteFile).generatedBy, "loom-suite-freeze");

  await assert.rejects(
    () =>
      cli([
        "promote", join(c.dir, "better.json"),
        "--baseline", join(c.dir, "graphs", "pick.json"),
        "--suite", suiteFile,
        "--proposed-by", "loom-suite-freeze",
        "--workspace", c.dir,
      ]),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /reserved/.test(e.message),
  );
});

test("a --bucket the corpus was not scored under names ITSELF, instead of blaming the verdicts", async () => {
  // The eligibility loop excludes four ways and counted three. The fourth —
  // `sc.cohortKey !== key` — is the one an operator triggers by accident, because `--bucket`
  // recomputes the key: ask for a mode the corpus was not SCORED under and every member drops.
  // The summary then reported them under "carry no journaled verdict" and sent the operator to
  // re-run `loom score`, when the verdicts were there all along under another key.
  const c = await scoredCorpus();
  const out = join(c.dir, "wrong-bucket.json");
  await assert.rejects(
    () => freeze(c.dir, c.ids[0]!, out, ["--bucket", "fields:no-such-channel"]),
    (e: unknown) => {
      if (!isLoomError(e) || e.code !== CODES.E_CONFIG_INVALID) return false;
      // The count is the whole corpus, not zero — this is what fails if the exclusion goes back
      // to being silent and its members are miscounted as unjudged.
      assert.match(e.message, new RegExp(`${String(c.ids.length)} were judged under a DIFFERENT cohort key`));
      assert.match(e.message, /0 run\(s\) carry no journaled verdict/, "and they are NOT blamed on missing verdicts");
      // The key itself is printed: "yours differs from theirs" is only actionable when a reader
      // can see which segment moved.
      assert.match(e.message, /other key\(s\) present:/);
      assert.match(e.message, /re-score them under the same/);
      return true;
    },
  );
  assert.equal(existsSync(out), false, "no suite file on a refusal");
});

test("every frozen case carries the safety invariant", async () => {
  // `noIrreversibleWithoutGate` is the one expectation that is an INVARIANT rather than a
  // statement about what the baseline produced. It used to be conditional, so a suite could mix
  // cases that check oversight with cases that do not and nothing said which. It is
  // unconditional now, and this asserts that — which is the half that is checkable.
  //
  // WHAT THIS TEST DOES NOT COVER, said rather than implied, and where it now IS covered. The
  // exclusion that makes the field unconditional — a recording whose fold shows a gate neither
  // `decided` nor `cancelled` is dropped and counted — is not exercised here: this corpus has no
  // such run, and mutating the exclusion away used to leave the whole file green. That was
  // TODO.md §A.21, and it is settled at the bottom of this file, by a fixture rather than by an
  // argument: the state is unreachable through this engine and reachable through a JOURNAL, which
  // is the only input `suite freeze` has. The mutation goes red there, not here.
  const c = await scoredCorpus();
  const out = join(c.dir, "invariant.json");
  const r = await freeze(c.dir, c.ids[0]!, out);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  const suite = readSuite(out);
  assert.ok(suite.cases.length >= 6, "the corpus still fills a suite");
  for (const k of suite.cases) {
    assert.equal(
      k.expect.noIrreversibleWithoutGate,
      true,
      `case ${k.id} was frozen without the safety invariant — every case must carry it`,
    );
  }
});

// ---------------------------------------------------------------------------
// 5 · the exclusion that was a guard over a state nobody had constructed
// ---------------------------------------------------------------------------

/**
 * A RECORDING WHOSE GATE WAS NEVER RESOLVED, on a run that folded to `succeeded` — TODO.md §A.21.
 *
 * The exclusion above it was measured as a guard over a state nobody had built: mutating it away
 * left this file 9/9 green. This is the fixture, and it is a fixture about the verb's INPUT rather
 * than about the engine.
 *
 * **WHAT THE ENGINE DOES, measured on a real Engine over a real SQLite store** — none of it this
 * state. A join in `any`/`firstSuccess` mode really does short-circuit past a branch parked on a
 * gate, but `advance`'s drain re-suspends the run on `openGates(p).length > 0`, so it folds
 * `awaiting_gate` and never becomes eligible. The budget/fatal floor DOES reach `#finish` past
 * that drain, and `#finish` appends `cancelOpenGates` in the same append as `run.completed`, so
 * the surviving gate folds `cancelled` — resolved. A gate whose SLA expires folds `expired`, which
 * IS unresolved, but `#expire` ships `gate.timeout` and `run.failed` in one append, so `expired`
 * implies `failed`.
 *
 * **AND WHY THE STATE IS REACHABLE ANYWAY.** `suite freeze` reads journals, and a journal outlives
 * the binary that wrote it. `#finish`'s docstring dates a build whose SUCCESS path did not close
 * its gates; deleting that one line from `#finish` and re-running the floor probe yields
 * `status=succeeded gates=[decided, open]` — measured, not quoted. So the shape below is one a
 * workspace can really be holding, and it is built here by appending the raise to a run this
 * corpus recorded, because the fold reads gate STATE and not row order.
 *
 * What admitting it would cost: `noIrreversibleWithoutGate: true` is written onto EVERY case, so
 * the suite would carry a case whose own recording fails its own expectation — and the baseline
 * would then fail the exam frozen from it.
 */
test("A RUN THAT ENDED ON AN UNRESOLVED GATE IS EXCLUDED, AND IT IS THE ONLY REASON IT IS", async () => {
  const c = await corpus(30, { score: true });
  try {
    const gated = c.ids[5]!;
    const ws = openWorkspace(parseArgs(["gates", "--workspace", c.dir]));
    try {
      await ws.store.append({
        runId: gated as RunId,
        expectedSeq: await ws.store.head(gated as RunId),
        events: [
          {
            type: "gate.raised",
            payload: {
              gateId: newGateId(1),
              nodeId: "check" as NodeId,
              policyRef: "oversight/ship@stable",
              contentDigest: "sha256:unanswered",
            },
            actor: { kind: "system", component: "a-build-that-did-not-close-its-gates" },
          },
        ],
      });
    } finally {
      ws.close();
    }

    // THE FIXTURE IS WHAT IT CLAIMS TO BE, asserted rather than assumed — otherwise this test
    // could pass while exercising nothing. Succeeded, still delivered under its journaled score
    // (so every earlier exclusion in the loop passes it through), and holding a gate that is
    // neither `decided` nor `cancelled`.
    const events = await journal(c.dir, gated);
    const p = foldRun(events)!;
    assert.equal(p.status, "succeeded", "the run still folds to succeeded");
    assert.deepEqual(
      Object.values(p.gates).map((g) => g.state),
      ["open"],
      "…and to exactly one gate nobody answered",
    );
    assert.equal(lastScore(events)!.components.delivered, true, "it passes `!delivered` — the exclusion before this one");

    const out = join(c.dir, "unresolved-gate.json");
    const r = await freeze(c.dir, c.ids[0]!, out);
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    const suite = readSuite(out);
    assert.equal(suite.cases.length, 29, "one of the thirty was dropped");
    assert.equal(
      suite.cases.some((k) => k.runId === gated),
      false,
      "the recording that could not carry `noIrreversibleWithoutGate` was frozen into the exam anyway",
    );
    // THE CONTROL, so the count above is not passing for some other reason: every OTHER run in
    // the corpus is a case.
    assert.deepEqual(
      suite.cases.map((k) => k.runId).sort(),
      c.ids.filter((id) => id !== gated).sort(),
      "exactly one run is missing, and it is the gated one",
    );
  } finally {
    c.dispose();
  }
});

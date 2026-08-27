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
import type { RunId } from "../../src/ids.ts";
import { isEvent, type EventPayloads, type JournalEvent } from "../../src/journal/events.ts";
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
  outputs: ["verdict"],
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
  // WHAT THIS DOES NOT COVER, said rather than implied. The exclusion that makes the field
  // unconditional — a recording whose fold shows a gate neither `decided` nor `cancelled` is
  // dropped and counted — is NOT exercised here, and I could not build a fixture that reaches
  // it: a run must be `succeeded` AND `delivered` to get this far, and no such run in this
  // corpus carries an unresolved gate. Measured: mutating the exclusion away leaves this suite
  // 9/9, so this test does not discriminate on that branch and must not be read as if it does.
  // Whether the branch is reachable at all is recorded in TODO.md §A0; it is kept as a
  // fail-closed guard over a state nobody has constructed, not as covered behaviour.
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

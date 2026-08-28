/**
 * A REFUSAL THAT NAMED THE WRONG CAUSE, AND PRESCRIBED A REMEDY THAT COULD NOT WORK.
 *
 * `Trajectory.specResolved` used to mean "the fold had the graph" and nothing else, and three
 * operator-facing messages were written against that meaning. A later fix ANDed
 * `verdictsResolved` into the field — an evaluator whose verdict outgrew the journal and moved
 * to the payload store cannot be read either — and the three messages did not move. So a run
 * folded WITH its graph was told its graph was missing, and told to publish a graph that was
 * already published: a no-op remediation attached to a false cause. CLAUDE.md's rule about
 * corrections applies one layer out — a diagnostic naming the wrong cause asserts verified
 * accuracy and is believed harder than no diagnostic at all.
 *
 * Measured before the fix, driving the binary on the graph below:
 *
 * ```
 * $ loom score <run> --workspace <ws>
 * exit 0, stderr empty, {"outcome":0,"score":0,"signals":[], "goldenBlockers":[
 *   "the signals were readable: NO SPEC — graph sha256:7d48… was not available to the fold, …"]}
 * ```
 *
 * The graph was in `<ws>/graphs` — had it not been, the command would have refused before
 * folding at all. Two things are wrong there: the blocker names a cause that is false, and a
 * verdict nobody measured reached the journal as a score of 0.
 *
 * ## WHY THIS FILE SPAWNS THE BINARY INSTEAD OF CALLING `main()`
 *
 * Every other suite in `test/cli/` captures output by replacing `process.stdout.write` for the
 * duration of a call. That is safe only while the window is short. Under `node --test` the
 * runner's own reporter reaches stdout through a pipe, which looks `write` up at delivery time,
 * so a long window swallows the runner's output: adding these two tests to
 * `evolution-score.test.ts` made `node --test` on that file report `tests 1` instead of
 * `tests 14`, and `r.out` came back holding the text `"✔ loom sco…"`. The runs here write a
 * 300 kB payload to disk and are long enough to lose that race every time. A child process has
 * its own stdout and cannot.
 *
 * Offline and deterministic: the evaluator is a `function` resource evaluated in-process, no
 * model adapter is configured, and the only thing that varies between the two runs is the
 * LENGTH of a string.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { openWorkspace, parseArgs } from "../../src/cli.ts";
import { isEvent, type EventPayloads, type JournalEvent } from "../../src/journal/events.ts";
import type { RunId } from "../../src/ids.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli.ts");

const PICK = `(view) => ({ writes: { picked: (view.get("items") || []).slice() } })`;
/**
 * THE VERDICT'S SIZE IS A FUNCTION OF THE INPUT, which is what lets one graph produce both a
 * readable run and an unreadable one — and therefore a cohort in which they are peers. 300 kB is
 * comfortably past `EXTERNALISE_ABOVE_BYTES` (64 KiB) and has no shorter canonical form.
 */
const CHECK = `(view) => ({
  writes: { verdict: { pass: true, confidence: 1, why: "x".repeat((view.get("items") || []).length > 1 ? 300000 : 5) } },
})`;

/**
 * `verdict` is `replace`, is not an output and is named by no expression, so it is exactly what
 * `externalisableChannels` keeps — the ordinary shape of an evaluator's channel, and the reason
 * this defect is reachable at all. `verdictIsOutput` is the remedy the refusal prescribes,
 * written as a graph so the test can drive it rather than assert it.
 */
function evalGraph(verdictIsOutput: boolean): string {
  return JSON.stringify({
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "judged-bench", project: "demo", version: verdictIsOutput ? 2 : 1 },
    policy: { posture: "out" },
    channels: {
      items: { type: "array", reduce: "replace" },
      picked: { type: "array", reduce: "replace" },
      verdict: { type: "object", reduce: "replace" },
    },
    inputs: ["items"],
    outputs: verdictIsOutput ? ["picked", "verdict"] : ["picked"],
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
  });
}

/**
 * THE SAME EVALUATOR, WRITING TWO CHANNELS: one that outgrows the journal and one that does not.
 * `note` is small, `replace`, not an output and named by no expression — so it is ELIGIBLE for
 * the payload store and simply too small to go, which is the only shape that can tell "the
 * channels that left" apart from "the channels the evaluator wrote".
 */
const NOISY = `(view) => ({
  writes: {
    verdict: { pass: true, confidence: 1, why: "x".repeat(300000) },
    note: { seen: (view.get("items") || []).length },
  },
})`;

function noisyGraph(): string {
  return JSON.stringify({
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "judged-bench-noisy", project: "demo", version: 1 },
    policy: { posture: "out" },
    channels: {
      items: { type: "array", reduce: "replace" },
      picked: { type: "array", reduce: "replace" },
      verdict: { type: "object", reduce: "replace" },
      note: { type: "object", reduce: "replace" },
    },
    inputs: ["items"],
    outputs: ["picked"],
    nodes: [
      { id: "pick", type: "function", reads: ["items"], writes: ["picked"], function: { ref: "function/pick@stable" } },
      {
        id: "check",
        type: "evaluator",
        reads: ["items", "picked"],
        writes: ["verdict", "note"],
        evaluator: { kind: "assertion", ref: "function/noisy@stable", threshold: 0.5 },
      },
    ],
    edges: [{ id: "e", from: "pick", to: "check", kind: "seq" }],
  });
}

function workspace(): { dir: string; graphFile: string; fixedFile: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-verdict-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  mkdirSync(join(dir, "resources", "function"), { recursive: true });
  writeFileSync(join(dir, "resources", "function", "pick.js"), PICK);
  writeFileSync(join(dir, "resources", "function", "check.js"), CHECK);
  writeFileSync(join(dir, "resources", "function", "noisy.js"), NOISY);
  const graphFile = join(dir, "graphs", "judged.json");
  const fixedFile = join(dir, "graphs", "judged-fixed.json");
  writeFileSync(graphFile, evalGraph(false));
  writeFileSync(fixedFile, evalGraph(true));
  return { dir, graphFile, fixedFile, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * THE CHILD'S STREAMS GO TO FILES, NOT PIPES, and that is not fussiness. `cli.ts`'s entry point
 * ends on `process.exit(code)`, and a pipe write is asynchronous: measured here, `loom run` on
 * the repaired graph printed a `verdict` output of 300 kB and the parent received exactly 65536
 * bytes — `Unterminated string in JSON at position 65536`. A file descriptor is written
 * synchronously, so nothing is lost. (The truncation itself is a real defect in the entry point,
 * outside this lane's files; routed around here rather than hidden.)
 */
function loom(dir: string, argv: readonly string[]): { code: number; out: string; err: string } {
  const outFile = join(dir, "child.out");
  const errFile = join(dir, "child.err");
  const o = openSync(outFile, "w");
  const e = openSync(errFile, "w");
  try {
    const r = spawnSync(process.execPath, [CLI, ...argv], { stdio: ["ignore", o, e] });
    return { code: r.status ?? 1, out: readFileSync(outFile, "utf8"), err: readFileSync(errFile, "utf8") };
  } finally {
    closeSync(o);
    closeSync(e);
  }
}

function drive(dir: string, graphFile: string, items: number[]): string {
  const r = loom(dir, ["run", graphFile, "--workspace", dir, "--input", JSON.stringify({ items })]);
  assert.equal(r.code, 0, r.err);
  const { runId, status } = JSON.parse(r.out) as { runId: string; status: string };
  assert.equal(status, "succeeded", r.err);
  return runId;
}

/** The journal as a different process sees it — which is the only reading that counts here. */
async function scoreRows(dir: string, runId: string): Promise<EventPayloads["evolution.scored"][]> {
  const ws = openWorkspace(parseArgs(["gates", "--workspace", dir]));
  try {
    const events: JournalEvent[] = [];
    for await (const e of ws.store.read(runId as RunId, 1)) events.push(e);
    return events
      .filter((e) => isEvent(e, "evolution.scored"))
      .map((e) => e.payload as EventPayloads["evolution.scored"]);
  } finally {
    ws.close();
  }
}

test("AN UNREADABLE VERDICT IS REFUSED IN ITS OWN WORDS — not blamed on a graph that was right there", async () => {
  const w = workspace();
  try {
    const padded = drive(w.dir, w.graphFile, [1, 2]);

    const r = loom(w.dir, ["score", padded, "--workspace", w.dir]);

    // BEFORE: exit 0, empty stderr, and a journaled blocker reading "NO SPEC — graph <hash> was
    // not available to the fold" for a graph that resolved out of graphs/.
    assert.equal(r.code, 1, `expected a refusal, got ${r.out}`);
    assert.equal(r.out, "", "a refusal prints no verdict");
    assert.equal(
      /was not available to the fold|no graph in/.test(r.err),
      false,
      `the graph WAS available and the message must not say otherwise: ${r.err}`,
    );
    assert.match(r.err, /payload handle/, r.err);
    assert.match(r.err, /\(verdict\)/, "…and names the channel it could not read");
    assert.match(r.err, /65536 bytes/, "…and the size that decided");

    // AND NOTHING WAS JOURNALED — the same rule the no-graph refusal follows, for a sharper
    // reason here: `evolution.scored.components` carries no `specResolved`, so a row written
    // here would reach `suite freeze` as `delivered: true` with nothing saying nobody measured
    // it, and enter the exam as a case ordered by a score of 0 it did not earn.
    assert.deepEqual(await scoreRows(w.dir, padded), []);

    // THE CONTROL, same graph, same command, a short verdict: it scores. Without this the fix
    // could be a blanket refusal of every run that used the payload store.
    const short = drive(w.dir, w.graphFile, [1]);
    const ok = loom(w.dir, ["score", short, "--workspace", w.dir]);
    assert.equal(ok.code, 0, ok.err);
    assert.equal((await scoreRows(w.dir, short)).length, 1);

    // AND THE REMEDY THE MESSAGE PRESCRIBES ACTUALLY WORKS, which is the bar an operator-facing
    // message has to clear: declaring the channel among the graph's outputs makes it ineligible
    // for the payload store, and the same long input then folds, scores, and reads its verdict.
    const fixed = drive(w.dir, w.fixedFile, [1, 2]);
    const after = loom(w.dir, ["score", fixed, "--workspace", w.dir]);
    assert.equal(after.code, 0, after.err);
    const printed = JSON.parse(after.out) as EventPayloads["evolution.scored"];
    assert.equal(printed.outcome, 1, "the assertion is readable again, and it passed");
  } finally {
    w.dispose();
  }
});

test("AND A PEER NOBODY COULD MEASURE IS EXCLUDED FOR THE REASON THAT APPLIES TO IT", () => {
  const w = workspace();
  try {
    // One graph, two inputs of one shape: one cohort key, and only one of the two runs kept its
    // verdict in the journal. The JUDGED run is the readable one, so the command gets as far as
    // reporting on its peers — which is the site the old sentence lived at.
    drive(w.dir, w.graphFile, [1, 2]);
    const short = drive(w.dir, w.graphFile, [1]);

    const r = loom(w.dir, ["score", short, "--workspace", w.dir]);
    assert.equal(r.code, 0, r.err);
    const printed = JSON.parse(r.out) as EventPayloads["evolution.scored"];
    assert.equal(printed.cohort.n, 1, "the premise: the unreadable peer is not in the population");

    // THE DEFECT: "1 peer run(s) … folded without their graph … Publish those graphs in
    // <ws>/graphs to put them back in the cohort." The peer's graph is in graphs/ — it is what
    // the peer ran — so the operator publishes it again and the peer never comes back.
    assert.equal(
      r.err.includes("folded without their graph"),
      false,
      `the peer had its graph; saying otherwise sends the operator to do nothing: ${JSON.stringify(r.err)}`,
    );
    assert.match(r.err, /1 peer run\(s\) in this cohort folded WITH their graph/, r.err);
    assert.match(r.err, /left the journal for the payload store/, r.err);
    assert.match(r.err, /Publishing a graph does not bring these back/, "the no-op remedy is withdrawn by name");
  } finally {
    w.dispose();
  }
});

/**
 * THE REFUSAL'S OWN LIST WAS THE UNION, AND HALF OF IT WAS FALSE.
 *
 * The first version of this refusal built its channel list from `Step.channelsWritten`, which
 * `trajectory.ts` builds as `writes` UNION `external` — deliberately, so a step that moved
 * 300 KB is not read as a step that wrote nothing. Measured against the graph below, before the
 * correction: `ran an evaluator whose channel is a payload handle rather than a value (note,
 * verdict)`. `note` is four bytes of JSON sitting in the journal; calling it a payload handle is
 * this refusal committing, one clause along, the defect it was written to fix.
 *
 * The list now comes from `task.committed.external`, which is the executor's own declaration of
 * what left — events.ts states that a fold may not decide this by looking at a value.
 */
test("AND THE CHANNELS IT NAMES ARE THE ONES THAT LEFT — an inline channel beside them is not a payload handle", () => {
  const w = workspace();
  try {
    const noisyFile = join(w.dir, "graphs", "judged-noisy.json");
    writeFileSync(noisyFile, noisyGraph());
    const runId = drive(w.dir, noisyFile, [1, 2]);

    const r = loom(w.dir, ["score", runId, "--workspace", w.dir]);
    assert.equal(r.code, 1, `expected a refusal, got ${r.out}`);

    // THE PREMISE: `note` was written by the same evaluator and stayed in the journal.
    assert.match(r.err, /\(verdict\)/, `only the channel that left may be named: ${r.err}`);
    assert.equal(
      /note/.test(r.err),
      false,
      `\`note\` is in the journal, so a refusal calling it a payload handle states a false fact: ${r.err}`,
    );
  } finally {
    w.dispose();
  }
});

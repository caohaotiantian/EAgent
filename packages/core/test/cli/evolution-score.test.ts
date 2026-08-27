/**
 * THE LOOP HAS A WRITE-BACK, AND SOMETHING READS IT.
 *
 * Capture worked and scoring worked, and at `86b84c9` neither was reachable from anything a
 * person could run: `scoreTrajectory`, `measureCohort`, `isGolden`, `promotionCeiling`,
 * `gateCandidate` and `runEvalSuite` had zero callers outside `src/evolution/`, `EVENT_TYPES`
 * had no row that could carry a score, and the CLI had no verb that read one. A metric nothing
 * records is a report; a metric a later run can read is a loop.
 *
 * What these tests hold down, in the order they matter:
 *
 * 1. `evolution.scored` ROUND-TRIPS. `loom score` appends it and a separate store handle — a
 *    different process, for the purposes of this claim — reads back exactly what was printed.
 * 2. `loom cohort` READS, and does not re-derive. The proof is a row this test appends BY HAND
 *    carrying a score no arithmetic in this repo could produce from that journal (0.4242). A
 *    reader that recomputed would print its own number and this test would go red.
 * 3. THE CONTROL: a run that was never judged is REFUSED, and refused differently from a run
 *    that is not in this workspace at all. `loom gates`' lesson — absence is not zero — applied
 *    to the one command whose whole job is to say how a run rated.
 * 4. A score computed under different weights is not a member of the cohort, and the exclusion
 *    is COUNTED. `scoreTrajectory` throws rather than compare across a weight change; a reader
 *    that quietly mixed them would report an improvement measured with two rulers.
 *
 * Offline and deterministic: the graph uses `fs.read`/`fs.write` only, no model adapter is
 * configured, and nothing here asserts a wall-clock-derived number — the computed score is
 * compared only against the journal it was written to.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, openWorkspace, parseArgs } from "../../src/cli.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ToolRegistry } from "../../src/run/registry.ts";
import { SYSTEM_ACTOR, isEvent, type EventPayloads, type JournalEvent } from "../../src/journal/events.ts";
import type { RunId } from "../../src/ids.ts";

const GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "copy-file", project: "demo", version: 1 },
  policy: { posture: "out", capabilities: ["fs:read", "fs:write"] },
  channels: {
    source: { type: "string", reduce: "replace" },
    body: { type: "string", reduce: "replace" },
    written: { type: "object", reduce: "replace" },
  },
  inputs: ["source"],
  outputs: ["written"],
  nodes: [
    {
      id: "read",
      type: "tool",
      reads: ["source"],
      writes: ["body"],
      tool: { name: "fs.read", version: "1.0", args: { path: "${source}" } },
    },
    {
      id: "write",
      type: "tool",
      reads: ["body"],
      writes: ["written"],
      tool: { name: "fs.write", version: "1.0", args: { path: "out/copy.txt", body: "${body}" } },
      unhandled: true,
    },
  ],
  edges: [{ id: "e1", from: "read", to: "write", kind: "seq" }],
};

function workspace(): { dir: string; graphFile: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-score-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  const graphFile = join(dir, "graphs", "copy.json");
  writeFileSync(graphFile, JSON.stringify(GRAPH));
  writeFileSync(join(dir, "input.txt"), "hello from an empty directory");
  return { dir, graphFile, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

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

/** One completed run of the graph. Same inputs every time, so every run shares a cohort key. */
async function drive(dir: string, graphFile: string): Promise<string> {
  const r = await cli(["run", graphFile, "--workspace", dir, "--input", JSON.stringify({ source: "input.txt" })]);
  assert.equal(r.code, 0, r.err);
  const { runId, status } = JSON.parse(r.out) as { runId: string; status: string };
  assert.equal(status, "succeeded");
  return runId;
}

/** The journal as a different process would see it: a fresh store handle, no engine state. */
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

function scoreRows(events: readonly JournalEvent[]): EventPayloads["evolution.scored"][] {
  return events.filter((e) => isEvent(e, "evolution.scored")).map((e) => e.payload as EventPayloads["evolution.scored"]);
}

/** Append a verdict nothing could have computed, so a reader that recomputes is caught. */
async function handWrite(dir: string, runId: string, payload: EventPayloads["evolution.scored"]): Promise<void> {
  const ws = openWorkspace(parseArgs(["gates", "--workspace", dir]));
  try {
    await ws.store.append({
      runId: runId as RunId,
      expectedSeq: await ws.store.head(runId as RunId),
      events: [{ type: "evolution.scored", payload, actor: SYSTEM_ACTOR("test") }],
    });
  } finally {
    ws.close();
  }
}

const HAND: EventPayloads["evolution.scored"] = {
  cohortKey: "hand-written|deadbeef|default|abcdef01",
  score: 0.4242,
  outcome: 0.75,
  components: { costNormalized: 0.5, latencyNormalized: 0.5, humanEffortSaved: 1, completed: true, delivered: true },
  signals: [{ id: "S1", value: 0.75, weight: 1, evidence: "3/4 assertions passed" }],
  weights: { outcome: 0.6, cost: 0.2, latency: 0.1, humanEffort: 0.1 },
  weightsDigest: "sha256:handwritten",
  cohort: { n: 31, p50CostUsd: 0.015, p50WallMs: 1200, p50Gates: 1, p90Score: 0.34 },
  golden: true,
  goldenBlockers: [],
  ceiling: "stable",
  requiresHumanSignOff: false,
};

// ── 1 · the row round-trips ─────────────────────────────────────────────────

test("loom score JOURNALS the verdict, and a separate handle reads back what was printed", async () => {
  const w = workspace();
  try {
    const runId = await drive(w.dir, w.graphFile);

    const before = scoreRows(await journal(w.dir, runId));
    assert.deepEqual(before, [], "a run is unjudged until somebody judges it");

    const r = await cli(["score", runId, "--workspace", w.dir]);
    assert.equal(r.code, 0, r.err);
    const printed = JSON.parse(r.out) as EventPayloads["evolution.scored"] & { runId: string };
    assert.equal(printed.runId, runId);

    const rows = scoreRows(await journal(w.dir, runId));
    assert.equal(rows.length, 1, "exactly one evolution.scored row was appended");
    const { runId: _id, ...payload } = printed;
    assert.deepEqual(rows[0], payload, "the journal holds precisely what the verb printed");

    // The verdict this product can currently produce, stated plainly: an fs-only run emits no
    // signal above self-report, so it cannot be golden and cannot be promoted past draft. A
    // verb that reported anything better here would be reporting a measurement nobody made.
    assert.equal(payload.golden, false);
    assert.ok(payload.goldenBlockers.length > 0, "a false verdict must say which conditions failed");
    assert.ok(
      payload.goldenBlockers.some((b) => b.startsWith("cohort large enough")),
      `a cohort of one cannot certify anything; blockers were ${JSON.stringify(payload.goldenBlockers)}`,
    );
    assert.equal(payload.ceiling, "draft");
    assert.equal(payload.requiresHumanSignOff, true);
    assert.equal(payload.cohort.n, 1, "the run being judged is a member of its own cohort");
    assert.equal(payload.weightsDigest.length > 0, true);
    // WHICH ZERO IS THIS? The outcome is 0 for want of a signal, not for want of a run — and
    // the row has to be able to say so on its own, months later, without the code that wrote it.
    assert.equal(payload.outcome, 0);
    assert.deepEqual(
      { completed: payload.components.completed, delivered: payload.components.delivered },
      { completed: true, delivered: true },
      "this run finished AND did work; a verdict that cannot distinguish that from a no-op is not a verdict",
    );

    // THE FOLD STILL FOLDS. A new member of the vocabulary that the projection choked on would
    // take the run state down with it — the journal is the only authoritative state, and every
    // read model is a fold over it.
    const g = await cli(["gates", runId, "--workspace", w.dir]);
    assert.equal(g.code, 0, g.err);
    assert.deepEqual(JSON.parse(g.out), []);

    // THE RECORD STILL HOLDS TOGETHER. A new row in the vocabulary that broke `loom audit` would
    // be a durable fact that costs the journal its own guarantees.
    const a = await cli(["audit", runId, "--workspace", w.dir, "--graph", w.graphFile]);
    assert.equal(a.code, 0, `${a.out}${a.err}`);
  } finally {
    w.dispose();
  }
});

test("CONDITION 5 IS NON-VACUOUS — a published graph is promoted, a loose file is not", async () => {
  const w = workspace();
  try {
    // `foldTrajectory` marks a run as candidate output whenever the caller names no promoted
    // set — including by omitting the option — so condition 5 fails closed and every caller in
    // the tree used to fail it. The CLI answers: the graphs published in `<workspace>/graphs/`
    // are the ones a person put there.
    const published = await drive(w.dir, w.graphFile);
    assert.equal((await cli(["score", published, "--workspace", w.dir])).code, 0);
    const blockers = scoreRows(await journal(w.dir, published))[0]!.goldenBlockers;
    assert.equal(
      blockers.some((b) => b.startsWith("not self-training")),
      false,
      `a run of a graph published in graphs/ is not candidate output; blockers were ${JSON.stringify(blockers)}`,
    );

    // The other half, or the assertion above proves only that the condition never fires. A graph
    // run from a path OUTSIDE graphs/ was published by nobody, and the fold says so.
    //
    // It is scored through `--graph`, and that is the whole reason the flag exists: publishing
    // into graphs/ is ALSO what marks a graph promoted here, so a candidate that had to be
    // published in order to be scored would pass this very condition on the way in. The flag
    // supplies the spec and nothing else, and condition 5 still fails.
    const loose = join(w.dir, "loose.json");
    writeFileSync(loose, JSON.stringify({ ...GRAPH, metadata: { ...GRAPH.metadata, version: 2 } }));
    const r = await cli(["run", loose, "--workspace", w.dir, "--input", JSON.stringify({ source: "input.txt" })]);
    assert.equal(r.code, 0, r.err);
    const looseRun = (JSON.parse(r.out) as { runId: string }).runId;
    const scored = await cli(["score", looseRun, "--workspace", w.dir, "--graph", loose]);
    assert.equal(scored.code, 0, scored.err);
    const looseBlockers = scoreRows(await journal(w.dir, looseRun))[0]!.goldenBlockers;
    assert.ok(
      looseBlockers.some((b) => b.startsWith("not self-training")),
      "a graph nobody published cannot be learned from",
    );
    assert.equal(
      looseBlockers.some((b) => b.startsWith("the signals were readable")),
      false,
      `--graph supplied the spec, so condition 6 must not fire; blockers were ${JSON.stringify(looseBlockers)}`,
    );
  } finally {
    w.dispose();
  }
});

test("NO SPEC, NO SCORE — an unresolvable graph is REFUSED and journals nothing", async () => {
  const w = workspace();
  try {
    // The third folded-without-its-graph defect in one session, and the shape it shipped in: a
    // run of a graph the workspace cannot resolve folded with no node types, found no evaluator
    // nodes, and reported `signals: []` -> outcome 0 -> a score. Driven live on review-bench,
    // same run and same command twice (docs/evolution-loop-2026-08-27.md §4): graph absent,
    // score 0.111; graph present, `S1 6/6 assertions passed`, score 0.700. A candidate graph
    // lives in candidates/, so every candidate cohort read as worthless and nothing said why.
    const loose = join(w.dir, "candidate.json");
    writeFileSync(loose, JSON.stringify({ ...GRAPH, metadata: { ...GRAPH.metadata, version: 3 } }));
    const r = await cli(["run", loose, "--workspace", w.dir, "--input", JSON.stringify({ source: "input.txt" })]);
    assert.equal(r.code, 0, r.err);
    const runId = (JSON.parse(r.out) as { runId: string }).runId;

    const refused = await cli(["score", runId, "--workspace", w.dir]);
    assert.equal(refused.code, 1, `expected a refusal, got ${refused.out}`);
    assert.equal(refused.out, "", "a refusal prints no verdict");
    // NAMING THE MISSING THING AND THE FIX, because "outcome 0" named neither.
    assert.ok(refused.err.includes(join(w.dir, "graphs")), `the message must name the directory: ${refused.err}`);
    assert.ok(refused.err.includes("--graph"), `…and the flag that answers it: ${refused.err}`);

    // AND NOTHING WAS JOURNALED. The journal is the only authoritative state, so a verdict
    // nobody measured must not reach it — that is the difference between refusing and scoring 0.
    assert.deepEqual(scoreRows(await journal(w.dir, runId)), []);

    // The control, on the same run: given the spec, it scores.
    const ok = await cli(["score", runId, "--workspace", w.dir, "--graph", loose]);
    assert.equal(ok.code, 0, ok.err);
    assert.equal(scoreRows(await journal(w.dir, runId)).length, 1);
  } finally {
    w.dispose();
  }
});

test("--graph IS A LOOKUP, NOT AN INPUT — another graph's node types are refused", async () => {
  const w = workspace();
  try {
    // The flag hands the scorer a spec, and a spec decides which steps carry S1 and S4. Accepting
    // one that is not the run's would let the caller choose the signals — the score's own inputs,
    // supplied by the party the score judges. It is matched by hash against `run.submitted`.
    const other = join(w.dir, "other.json");
    writeFileSync(other, JSON.stringify({ ...GRAPH, metadata: { ...GRAPH.metadata, version: 4 } }));
    const runId = await drive(w.dir, w.graphFile);

    const wrong = await cli(["score", runId, "--workspace", w.dir, "--graph", other]);
    assert.equal(wrong.code, 1, `expected a refusal, got ${wrong.out}`);
    assert.deepEqual(scoreRows(await journal(w.dir, runId)), [], "and it journaled nothing");
    assert.ok(/compiles to sha256:/.test(wrong.err), `the message must show both hashes: ${wrong.err}`);
  } finally {
    w.dispose();
  }
});

test("A CANDIDATE COHORT MEASURES ITS PEERS TOO — --graph reaches the whole population", async () => {
  // The peer half, which is where the damage actually was: a cohort key pins one graphHash, so
  // the peers of a candidate run are thirty runs of that same unpublished graph. Folding the
  // judged run with `--graph` while its peers folded blind would measure it against a population
  // of runs of ITSELF that nobody could measure — `p90Score` is a percentile OF THE SCORES, so
  // that population sets the bar `isGolden` condition 2 has to clear.
  const w = workspace();
  try {
    const candidate = join(w.dir, "candidate.json");
    writeFileSync(candidate, JSON.stringify({ ...GRAPH, metadata: { ...GRAPH.metadata, version: 5 } }));
    const runs: string[] = [];
    for (let i = 0; i < 2; i++) {
      const p = await cli(["run", candidate, "--workspace", w.dir, "--input", JSON.stringify({ source: "input.txt" })]);
      assert.equal(p.code, 0, p.err);
      runs.push((JSON.parse(p.out) as { runId: string }).runId);
    }

    const r = await cli(["score", runs[0]!, "--workspace", w.dir, "--graph", candidate]);
    assert.equal(r.code, 0, r.err);
    const printed = JSON.parse(r.out) as EventPayloads["evolution.scored"];
    assert.equal(printed.cohort.n, 2, "both runs of the candidate are members, and both were measured");
    assert.equal(
      r.err.includes("folded without their graph"),
      false,
      `nothing was excluded, so nothing is reported: ${JSON.stringify(r.err)}`,
    );
    // AND THE SPEC DID NOT BUY PROMOTION. `--graph` supplies node types; `graphs/` is still the
    // only thing that marks a graph promoted, so condition 5 keeps failing on both.
    assert.ok(printed.goldenBlockers.some((b) => b.startsWith("not self-training")));
  } finally {
    w.dispose();
  }
});

// ── 2 · the reader reads ────────────────────────────────────────────────────

test("loom cohort PRINTS THE JOURNALED ROW — a hand-written verdict comes back unchanged", async () => {
  const w = workspace();
  try {
    const runId = await drive(w.dir, w.graphFile);
    await handWrite(w.dir, runId, HAND);

    const r = await cli(["cohort", runId, "--workspace", w.dir]);
    assert.equal(r.code, 0, r.err);
    const seen = JSON.parse(r.out) as {
      runId: string;
      cohortKey: string;
      weightsDigest: string;
      scored: EventPayloads["evolution.scored"];
      members: { runId: string; score: number; golden: boolean }[];
      excludedForWeights: number;
      truncated: boolean;
    };

    // NOTHING IN THIS REPO CAN COMPUTE 0.4242 FROM THAT JOURNAL. If the verb re-derived the
    // score instead of reading it, this is the assertion that says so.
    assert.deepEqual(seen.scored, HAND, "the verb must print the row the journal holds, not one it recomputed");
    assert.equal(seen.cohortKey, HAND.cohortKey);
    assert.equal(seen.weightsDigest, HAND.weightsDigest);
    assert.deepEqual(
      seen.members.map((m) => [m.runId, m.score, m.golden]),
      [[runId, 0.4242, true]],
      "the run asked about is in its own cohort, with the score the journal gave it",
    );
    assert.equal(seen.excludedForWeights, 0);
    assert.equal(seen.truncated, false);
  } finally {
    w.dispose();
  }
});

test("THE LAST verdict wins, and the earlier ones stay in the log", async () => {
  const w = workspace();
  try {
    const runId = await drive(w.dir, w.graphFile);
    const first = await cli(["score", runId, "--workspace", w.dir]);
    assert.equal(first.code, 0, first.err);
    await handWrite(w.dir, runId, HAND);

    assert.equal(scoreRows(await journal(w.dir, runId)).length, 2, "re-judging appends; it does not overwrite");
    const r = await cli(["cohort", runId, "--workspace", w.dir]);
    assert.equal(r.code, 0, r.err);
    const seen = JSON.parse(r.out) as { scored: EventPayloads["evolution.scored"] };
    assert.deepEqual(seen.scored, HAND, "the newest row is the current verdict");
  } finally {
    w.dispose();
  }
});

test("two runs of one graph are one cohort, and each reads the other's journaled score", async () => {
  const w = workspace();
  try {
    const a = await drive(w.dir, w.graphFile);
    const b = await drive(w.dir, w.graphFile);
    assert.notEqual(a, b, "two submissions of identical inputs are two runs");

    assert.equal((await cli(["score", a, "--workspace", w.dir])).code, 0);
    assert.equal((await cli(["score", b, "--workspace", w.dir])).code, 0);

    const r = await cli(["cohort", a, "--workspace", w.dir]);
    assert.equal(r.code, 0, r.err);
    const seen = JSON.parse(r.out) as { members: { runId: string; score: number }[] };
    assert.deepEqual(
      seen.members.map((m) => m.runId).sort(),
      [a, b].sort(),
      "a cohort read is assembled from OTHER runs' journals, which is the whole point of writing it down",
    );
    // Descending by score, so the reader does not have to sort a cohort to find the top of it.
    for (let i = 1; i < seen.members.length; i++) {
      assert.ok(seen.members[i - 1]!.score >= seen.members[i]!.score, "members are ordered by score, best first");
    }

    // And the second run saw the first: its cohort was measured over two members, not one.
    const rowsB = scoreRows(await journal(w.dir, b));
    assert.equal(rowsB[0]!.cohort.n, 2, "the later run was judged against the earlier one");
  } finally {
    w.dispose();
  }
});

// ── 3 · the control ─────────────────────────────────────────────────────────

test("CONTROL — a run that was never judged is REFUSED, and says so in its own words", async () => {
  const w = workspace();
  try {
    const runId = await drive(w.dir, w.graphFile);

    const r = await cli(["cohort", runId, "--workspace", w.dir]);
    assert.equal(r.code, 1, "an unjudged run is not an empty cohort");
    assert.equal(r.out, "", "and it prints no verdict-shaped JSON a script could read as one");
    assert.match(r.err, /carries no journaled score/);
    assert.match(r.err, new RegExp(`loom score ${runId}`), "the refusal says how to fix it");

    // A DIFFERENT FACT GETS A DIFFERENT ANSWER. A run that is not in this workspace at all must
    // not be reported as one that was merely never scored.
    for (const missing of [`${runId}X`, "r_definitely_not_a_run"]) {
      const m = await cli(["cohort", missing, "--workspace", w.dir]);
      assert.equal(m.code, 1);
      assert.match(m.err, /no journal for run/);
      const s = await cli(["score", missing, "--workspace", w.dir]);
      assert.equal(s.code, 1);
      assert.match(s.err, /no journal for run/);
    }

    // Judging it makes the same command answer.
    assert.equal((await cli(["score", runId, "--workspace", w.dir])).code, 0);
    assert.equal((await cli(["cohort", runId, "--workspace", w.dir])).code, 0);
  } finally {
    w.dispose();
  }
});

test("AN UNFINISHED RUN IS SCORED, AND TOLD APART FROM ONE THAT FINISHED BADLY", async () => {
  const w = workspace();
  try {
    // Submitted and never advanced: no CLI verb can leave a run here, so the run is made
    // through the same door an embedder uses. Its score is 0 by the scorer's floor, and the
    // whole point of the assertion below is that the 0 is legible as "it never finished".
    const ws = openWorkspace(parseArgs(["gates", "--workspace", w.dir]));
    let runId: string;
    try {
      const graph = compileOrThrow({
        spec: GRAPH as unknown as GraphSpec,
        resolver: ws.resolver,
        tools: (ws.engine.tools as ToolRegistry).manifests(),
        tenantCapabilities: ws.granted,
      });
      runId = await ws.engine.submit({ graph, inputs: { source: "input.txt" } });
    } finally {
      ws.close();
    }

    const r = await cli(["score", runId, "--workspace", w.dir]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /has not finished/, "the person at the terminal is reading a number and must be told");
    const printed = JSON.parse(r.out) as EventPayloads["evolution.scored"];
    assert.equal(printed.score, 0);
    assert.equal(printed.components.completed, false);
    assert.equal(printed.components.delivered, false);
    assert.equal(printed.cohort.n, 0, "an unfinished run is not a member of any cohort, including its own");

    // …and it is still journaled, still readable, and still says why.
    const back = await cli(["cohort", runId, "--workspace", w.dir]);
    assert.equal(back.code, 0, back.err);
    assert.equal((JSON.parse(back.out) as { scored: EventPayloads["evolution.scored"] }).scored.components.completed, false);
  } finally {
    w.dispose();
  }
});

test("both verbs refuse a missing runId at the door", async () => {
  const w = workspace();
  try {
    await assert.rejects(() => cli(["score", "--workspace", w.dir]), /requires a runId/);
    await assert.rejects(() => cli(["cohort", "--workspace", w.dir]), /requires a runId/);
  } finally {
    w.dispose();
  }
});

// ── 4 · two rulers are not one cohort ───────────────────────────────────────

test("A SCORE UNDER OTHER WEIGHTS IS NOT A MEMBER, and the exclusion is counted", async () => {
  const w = workspace();
  try {
    const a = await drive(w.dir, w.graphFile);
    const b = await drive(w.dir, w.graphFile);
    assert.equal((await cli(["score", a, "--workspace", w.dir])).code, 0);

    // B is judged under the SAME cohort key and a DIFFERENT weights digest — the exact shape
    // `scoreTrajectory` refuses to compare, and the quiet way a self-improving system convinces
    // itself it improved.
    const mine = scoreRows(await journal(w.dir, a))[0]!;
    await handWrite(w.dir, b, {
      ...mine,
      score: 0.99,
      weights: { outcome: 0.9, cost: 0.05, latency: 0.025, humanEffort: 0.025 },
      weightsDigest: `${mine.weightsDigest}-other`,
    });

    const r = await cli(["cohort", a, "--workspace", w.dir]);
    assert.equal(r.code, 0, r.err);
    const seen = JSON.parse(r.out) as { members: { runId: string }[]; excludedForWeights: number };
    assert.deepEqual(seen.members.map((m) => m.runId), [a], "a member measured with another ruler is not a member");
    assert.equal(seen.excludedForWeights, 1, "and dropping it silently would be the defect, not the fix");
  } finally {
    w.dispose();
  }
});

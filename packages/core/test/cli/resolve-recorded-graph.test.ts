/**
 * ONE RESOLVER, ONE TABLE — TODO.md §A.91, the reviewer's second fix round on `d8e116b9`.
 *
 * The first round's fix ("the sweep stays silent, `announceResolvedGraph`/`candidatesThatDidNotCompile`
 * restore what each caller needs") left the three properties it wanted holding SITE BY SITE rather
 * than always: `approve`'s own silence — §A.91's headline case — was pinned by NO test (only
 * `trace`'s was); the "one shared sentence" was actually three different wordings, none of which
 * correctly named a candidate under `resources/subgraph/`; and `steer`/`deescalate`/`gates`/`score`/
 * `exam attest`'s matched-graph announcements were unpinned too. `resolveRecordedGraph` is now the
 * one place every by-hash verb goes through, and this file drives eight of them — every one that
 * needs nothing heavier than a single recorded run (no cohort) — through the SAME three fixtures:
 *
 *   (a) THE RUN'S OWN GRAPH COMPILES WITH A WARNING — `announceResolvedGraph` must print it.
 *   (b) THE RUN'S OWN GRAPH IS THE SOLE CANDIDATE AND FAILS TO COMPILE HERE — the refusal must
 *       name its real path and explain why (GRAPH017), never "not found" or "not attached" alone.
 *   (c) AN UNRELATED CANDIDATE, published under `resources/subgraph/`, FAILS TO COMPILE — it must
 *       never be named anywhere in the output; the run's own graph still resolves cleanly.
 *
 * `suite freeze`, `promote --against-cohort` and `promote --suite` are NOT in this table: each
 * refuses a cohort under 30 recorded runs (`MIN_COHORT_SIZE`) before ever reaching
 * `resolveRecordedGraph`, and standing that scaffold up three times (or three times per scenario)
 * buys this table nothing the eight verbs below do not already prove about the shared resolver
 * itself — their own by-hash calls are the same three lines `attestExam`'s is, reviewed by hand.
 *
 * MUTATION, AS THE REVIEWER ASKED: making any ONE caller loud (or dropping its call to
 * `announceResolvedGraph`) turns exactly that verb's row red without touching the others — the
 * reviewer's kill list (`approve` loud, `gates` loud, `bindRecordedGraphOrExplain` loud, the
 * announcement removed at `approve`) is exercised by hand in the lane's own report, and this
 * table is what a fresh mutation there would actually run against.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";

// ── fixtures ──────────────────────────────────────────────────────────────────

/** Gates (a `human_gate`) and WARNS (a clock-dependent reducer on its output) — scenario (a). */
const WARN_GATED_GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "warn-gated", project: "lane-d", version: 1 },
  policy: { posture: "out", capabilities: ["fs:read", "fs:write"] },
  channels: {
    source: { type: "string", reduce: "replace" },
    body: { type: "string", reduce: "replace" },
    written: { type: "object", reduce: "last_write_wins_by_ts" },
  },
  inputs: ["source"],
  outputs: ["written"],
  nodes: [
    { id: "read", type: "tool", reads: ["source"], writes: ["body"], tool: { name: "fs.read", version: "1.0", args: { path: "${source}" } } },
    { id: "gate", type: "human_gate", reads: ["body"], writes: ["body"], humanGate: { ref: "oversight/publish@stable" } },
    {
      id: "write",
      type: "tool",
      reads: ["body"],
      writes: ["written"],
      unhandled: true,
      tool: { name: "fs.write", version: "1.0", args: { path: "out/copy.txt", body: "${body}" } },
    },
  ],
  edges: [
    { id: "e1", from: "read", to: "gate", kind: "seq" },
    { id: "e2", from: "gate", to: "write", kind: "seq" },
  ],
};

/** Gates, no warning — the "own graph" for scenario (c), paired with an unrelated broken one. */
const GOOD_GATED_GRAPH = {
  ...WARN_GATED_GRAPH,
  metadata: { name: "good-gated", project: "lane-d", version: 1 },
  channels: { ...WARN_GATED_GRAPH.channels, written: { type: "object", reduce: "replace" } },
};

/** proc:exec — gates on its own irreversibility, compiles only with --allow-exec — scenario (b). */
const SOLE_GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "sole", project: "lane-d", version: 1 },
  policy: { posture: "out", capabilities: ["proc:exec"], expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
  channels: { seed: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
  inputs: ["seed"],
  outputs: ["out"],
  nodes: [
    {
      id: "x",
      type: "tool",
      reads: ["seed"],
      writes: ["out"],
      unhandled: true,
      tool: { name: "proc.exec", version: "1.0", args: { command: "echo", args: ["hi"] } },
    },
  ],
  edges: [],
};

/** Published under resources/subgraph/, never run — the candidate that must stay unnamed. */
const UNRELATED_BROKEN_GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "broken-elsewhere", project: "lane-d", version: 1 },
  policy: { posture: "out", capabilities: ["proc:exec"], expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
  channels: { seed: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
  inputs: ["seed"],
  outputs: ["out"],
  nodes: [{ id: "x", type: "tool", reads: ["seed"], writes: ["out"], unhandled: true, tool: { name: "proc.exec", version: "1.0", args: { command: "echo", args: ["hi"] } } }],
  edges: [],
};

const EXAM = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "table-exam", project: "lane-d", version: 1 },
  policy: { posture: "out", capabilities: [] },
  channels: {
    subject: { type: "string", reduce: "replace" },
    source: { type: "string", reduce: "replace" },
    verdict: { type: "object", reduce: "replace" },
  },
  inputs: ["subject", "source"],
  outputs: ["verdict"],
  nodes: [{ id: "grade", type: "evaluator", reads: ["source"], writes: ["verdict"], evaluator: { kind: "assertion", ref: "function/grade@stable", threshold: 0 } }],
  edges: [],
};
const GRADE_FN = `(view) => ({ writes: { verdict: { pass: true, score: 1, confidence: 1, detail: "ok" } } })`;

interface Cap {
  code: number;
  out: string;
  err: string;
}

/** Folds a throw into the same shape as a returned code — see graph-lookup-explains-failures.test.ts. */
async function run(argv: string[]): Promise<Cap> {
  const out: string[] = [];
  const errOut: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => (errOut.push(String(c)), true)) as typeof process.stderr.write;
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: errOut.join("") };
  } catch (e) {
    return { code: 1, out: out.join(""), err: `${errOut.join("")}${(e as Error).message}\n` };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

function workspace(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-resolve-table-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  mkdirSync(join(dir, "resources", "subgraph"), { recursive: true });
  mkdirSync(join(dir, "resources", "function"), { recursive: true });
  writeFileSync(join(dir, "resources", "function", "grade.js"), GRADE_FN);
  writeFileSync(join(dir, "input.txt"), "hello");
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** One recorded, gated run of `graphFile`, with the extra CLI args it needed to compile. */
async function gatedRun(dir: string, graphFile: string, extraArgs: string[] = []): Promise<{ runId: string; gateId: string }> {
  const started = await run(["run", graphFile, "--workspace", dir, "--input", '{"source":"input.txt"}', ...extraArgs]);
  assert.equal(started.code, 0, `fixture run must succeed: ${started.err}`);
  const { runId, status } = JSON.parse(started.out) as { runId: string; status: string };
  assert.equal(status, "awaiting_gate", "the fixture must gate for approve/steer/deescalate/gates to mean anything");
  const gateMatch = /gate (gate_\S+) on node/.exec(started.err);
  assert.ok(gateMatch !== null, `expected a gate id on stderr: ${started.err}`);
  return { runId, gateId: gateMatch![1]! };
}

/** One recorded, gated run of SOLE_GRAPH, --allow-exec granted so it compiles once to record. */
async function soleRun(dir: string): Promise<{ runId: string; gateId: string }> {
  const started = await run(["run", join(dir, "graphs", "sole.json"), "--workspace", dir, "--input", '{"seed":"hi"}', "--allow-exec", "echo"]);
  assert.equal(started.code, 0, started.err);
  const { runId, status } = JSON.parse(started.out) as { runId: string; status: string };
  assert.equal(status, "awaiting_gate", "sole.json must gate for this to mean anything");
  const gateMatch = /gate (gate_\S+) on node/.exec(started.err);
  assert.ok(gateMatch !== null, `expected a gate id on stderr: ${started.err}`);
  return { runId, gateId: gateMatch![1]! };
}

interface Fixture {
  runId: string;
  gateId: string;
}

interface VerbCase {
  readonly name: string;
  readonly argv: (f: Fixture) => string[];
}

const VERBS: readonly VerbCase[] = [
  { name: "trace", argv: (f) => ["trace", f.runId] },
  { name: "replay", argv: (f) => ["replay", f.runId] },
  { name: "approve", argv: (f) => ["approve", f.runId, f.gateId, "--as", "u:alice"] },
  { name: "steer", argv: (f) => ["steer", f.runId, "--node", "gate", "--take", "e2", "--as", "u:alice"] },
  { name: "deescalate", argv: (f) => ["deescalate", f.runId, "--scope", `run:${f.runId}`, "--to", "on", "--why", "table test", "--as", "u:alice"] },
  { name: "gates", argv: (f) => ["gates", f.runId] },
  { name: "score", argv: (f) => ["score", f.runId] },
];

function withWorkspace(dir: string, argv: string[]): string[] {
  return [...argv, "--workspace", dir];
}

// ── (a) resolves with warnings → announced ───────────────────────────────────

test("(a) EVERY VERB ANNOUNCES THE RESOLVED GRAPH'S OWN WARNING", async () => {
  const w = workspace();
  try {
    writeFileSync(join(w.dir, "graphs", "warn-gated.json"), JSON.stringify(WARN_GATED_GRAPH));

    // A FRESH RUN PER VERB — `approve` actually resolves the gate it is handed (this scenario's
    // resolution succeeds, so the command runs to completion), so a shared run would arrive at
    // `gates` or `score` already answered and prove nothing about THEIR own announcement.
    for (const v of VERBS) {
      const f = await gatedRun(w.dir, join(w.dir, "graphs", "warn-gated.json"));
      const r = await run(withWorkspace(w.dir, v.argv(f)));
      assert.match(
        r.out + r.err,
        /GRAPH013_CLOCK_DEPENDENT/,
        `${v.name} must announce the resolved graph's own warning:\n${r.out}${r.err}`,
      );
    }

    // exam attest: a SEPARATE table, because it needs an exam file the other seven do not.
    const examF = await gatedRun(w.dir, join(w.dir, "graphs", "warn-gated.json"));
    writeFileSync(join(w.dir, "resources", "exam.json"), JSON.stringify(EXAM));
    const attested = await run(["exam", "attest", join(w.dir, "resources", "exam.json"), "--cohort", examF.runId, "--as", "u:alice", "--workspace", w.dir]);
    assert.match(attested.out + attested.err, /GRAPH013_CLOCK_DEPENDENT/, `exam attest must announce the baseline's own warning:\n${attested.out}${attested.err}`);
  } finally {
    w.dispose();
  }
});

// ── (b) sole same-hash candidate fails → one refusal naming its real path ────

test("(b) EVERY VERB NAMES THE SOLE CANDIDATE'S REAL PATH AND WHY, NEVER \"NOT FOUND\" ALONE", async () => {
  const w = workspace();
  try {
    writeFileSync(join(w.dir, "graphs", "sole.json"), JSON.stringify(SOLE_GRAPH));
    const f = await soleRun(w.dir);

    for (const v of VERBS) {
      const r = await run(withWorkspace(w.dir, v.argv(f)));
      const text = r.out + r.err;
      assert.match(text, /GRAPH017_CAPABILITY_NOT_GRANTED/, `${v.name} must explain WHY, not just that nothing resolved:\n${text}`);
      assert.match(text, /graphs\/sole\.json/, `${v.name} must name the candidate's real path:\n${text}`);
    }

    writeFileSync(join(w.dir, "resources", "exam.json"), JSON.stringify(EXAM));
    const attested = await run(["exam", "attest", join(w.dir, "resources", "exam.json"), "--cohort", f.runId, "--as", "u:alice", "--workspace", w.dir]);
    const text = attested.out + attested.err;
    assert.match(text, /GRAPH017_CAPABILITY_NOT_GRANTED/, `exam attest must explain WHY:\n${text}`);
    assert.match(text, /graphs\/sole\.json/, `exam attest must name the candidate's real path:\n${text}`);
  } finally {
    w.dispose();
  }
});

// ── (c) an unrelated candidate fails → silent ────────────────────────────────

test("(c) AN UNRELATED CANDIDATE UNDER resources/subgraph/ IS NEVER NAMED, and the run's own graph still resolves", async () => {
  const w = workspace();
  try {
    writeFileSync(join(w.dir, "graphs", "good-gated.json"), JSON.stringify(GOOD_GATED_GRAPH));
    // THE UNRELATED CANDIDATE — under resources/subgraph/, never run, always broken here.
    writeFileSync(join(w.dir, "resources", "subgraph", "broken-elsewhere.json"), JSON.stringify(UNRELATED_BROKEN_GRAPH));

    // A FRESH RUN PER VERB — see (a)'s own note on why a shared one would not do.
    for (const v of VERBS) {
      const f = await gatedRun(w.dir, join(w.dir, "graphs", "good-gated.json"));
      const r = await run(withWorkspace(w.dir, v.argv(f)));
      const text = r.out + r.err;
      assert.doesNotMatch(
        text,
        /GRAPH017_CAPABILITY_NOT_GRANTED|GRAPH013_UNKNOWN_TOOL|broken-elsewhere|resources\/subgraph/,
        `${v.name} must stay silent about a candidate that is not this run's graph:\n${text}`,
      );
    }

    const examF = await gatedRun(w.dir, join(w.dir, "graphs", "good-gated.json"));
    writeFileSync(join(w.dir, "resources", "exam.json"), JSON.stringify(EXAM));
    const attested = await run(["exam", "attest", join(w.dir, "resources", "exam.json"), "--cohort", examF.runId, "--as", "u:alice", "--workspace", w.dir]);
    const text = attested.out + attested.err;
    assert.doesNotMatch(
      text,
      /GRAPH017_CAPABILITY_NOT_GRANTED|GRAPH013_UNKNOWN_TOOL|broken-elsewhere|resources\/subgraph/,
      `exam attest must stay silent about the unrelated candidate:\n${text}`,
    );
  } finally {
    w.dispose();
  }
});

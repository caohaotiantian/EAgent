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
 *       name its real path and explain why (GRAPH017), never "not found" or "not attached" alone —
 *       AND, since the fourth fix round (X1), the --allow-exec/--egress advice, from every verb.
 *   (c) AN UNRELATED CANDIDATE, published under `resources/subgraph/`, FAILS TO COMPILE — it must
 *       never be named anywhere in the output; the run's own graph still resolves cleanly.
 *   (d) THE RUN'S OWN GRAPH FAILS TO COMPILE FOR A MISSING RESOURCE (GRAPH015), NOT A CAPABILITY —
 *       the refusal must name WHICH resource (not only the summary code), and must NEVER offer the
 *       --allow-exec/--egress advice, which fixes nothing here. TODO.md §A.91, the reviewer's
 *       fourth fix round (X1, BLOCKING): N4 made the shared fragment neutral about GRAPH015 but the
 *       grant advice it added back for GRAPH017 was written into only TWO of the resolver's nine
 *       by-hash callers (`recordedGraph`, `bindRecordedGraphOrExplain`) — `approve`, `gates`,
 *       `score`, `exam attest`, `suite freeze` and `promote --against-cohort` named neither the
 *       capability nor the fix. Closed by moving the advice INTO `resolveRecordedGraph`'s own
 *       `refusal`, so every caller inherits it from the one string they already quote; (b) and (d)
 *       are the untested direction the reviewer named — `capabilityIssue → true` always, or
 *       `→ false` always, now turns one of them red without touching the other.
 *
 * `promote --suite` is NOT in this table, and not because of `MIN_COHORT_SIZE`: it never calls
 * `resolveRecordedGraph` at all. `--baseline <file>` is loaded loudly with `loadGraph`, like
 * `--graph` everywhere else in this binary, and its own `graphsByHash(ws)` call builds nothing
 * but the `published` set `scanForExam` reads for the exam-attestation-provenance check — never a
 * resolution, never a refusal.
 *
 * `suite freeze` and `promote --against-cohort` WERE claimed absent for the same reason
 * (`MIN_COHORT_SIZE` first) — false for both, and for two different reasons. `promoteAgainstCohort`
 * always resolved the cohort's own baseline before measuring it; that ordering was never the bug.
 * `freezeSuite` did NOT — TODO.md §A.91's third fix round (B1) — so a broken or unpublished cohort
 * graph made `measureCohort` drop the only member and freeze reported "n = 0 … Record more runs",
 * blaming the operator's corpus for the operator's `graphs/` directory, while the true reason (a
 * GRAPH015 or GRAPH017 `resolveRecordedGraph` would have named) never reached them. Fixed to the
 * same order `promoteAgainstCohort` already used. Both are pinned below, cheaply — a single scored
 * (freeze) or recorded (promote --against-cohort) run reaches the resolver, because it now runs (or
 * always ran) before `examFor` and the cohort-size floor, not after.
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

/**
 * A `function` node reading a resource that can be deleted AFTER the run records it — GRAPH015,
 * scenario (d). Gates so the same `gatedRun` helper works; the resource must exist for `loom run`
 * to compile it once, and is removed before the verb under test resolves it a second time.
 */
const FN_GATED_GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "fn-gated", project: "lane-d", version: 1 },
  policy: { posture: "out", capabilities: ["fs:write"] },
  channels: {
    source: { type: "string", reduce: "replace" },
    body: { type: "string", reduce: "replace" },
    written: { type: "object", reduce: "replace" },
  },
  inputs: ["source"],
  outputs: ["written"],
  nodes: [
    { id: "prep", type: "function", reads: ["source"], writes: ["body"], function: { ref: "function/prep@stable" } },
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
    { id: "e1", from: "prep", to: "gate", kind: "seq" },
    { id: "e2", from: "gate", to: "write", kind: "seq" },
  ],
};
const PREP_FN = `(view) => ({ writes: { body: String(view.get("source") ?? "") } })`;

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

/**
 * One recorded, gated run of `FN_GATED_GRAPH` — publishes its resource, records the run, then
 * deletes the resource before returning, so a verb resolving this run's graph a second time finds
 * it published but broken (GRAPH015), never gone.
 */
async function fnGatedRun(dir: string): Promise<{ runId: string; gateId: string }> {
  writeFileSync(join(dir, "resources", "function", "prep.js"), PREP_FN);
  const f = await gatedRun(dir, join(dir, "graphs", "fn-gated.json"));
  rmSync(join(dir, "resources", "function", "prep.js"));
  return f;
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
      // THE GRANT ADVICE — TODO.md §A.91, the reviewer's fourth fix round (X1). It used to be
      // written per caller, and only two of nine remembered to; it now lives in
      // `resolveRecordedGraph`'s own `refusal`, so every verb in this loop gets it for free.
      // Killed by `capabilityIssue → false` (the sentence would vanish here too) and by deleting
      // the resolver's own clause (every verb in this loop goes red at once, not just two).
      assert.match(text, /--allow-exec/, `${v.name} must say the flag that would fix a GRAPH017:\n${text}`);
      assert.match(text, /grants the RUN had/, `${v.name} must explain WHY the flag would fix it:\n${text}`);
    }

    writeFileSync(join(w.dir, "resources", "exam.json"), JSON.stringify(EXAM));
    const attested = await run(["exam", "attest", join(w.dir, "resources", "exam.json"), "--cohort", f.runId, "--as", "u:alice", "--workspace", w.dir]);
    const text = attested.out + attested.err;
    assert.match(text, /GRAPH017_CAPABILITY_NOT_GRANTED/, `exam attest must explain WHY:\n${text}`);
    assert.match(text, /graphs\/sole\.json/, `exam attest must name the candidate's real path:\n${text}`);
    assert.match(text, /--allow-exec/, `exam attest must say the flag that would fix a GRAPH017:\n${text}`);
  } finally {
    w.dispose();
  }
});

// ── (d) GRAPH015 → the grant advice must be ABSENT, and the missing resource named ──

test("(d) A GRAPH015 (MISSING RESOURCE) NAMES THE RESOURCE, AND NEVER OFFERS THE GRANT ADVICE", async () => {
  const w = workspace();
  try {
    writeFileSync(join(w.dir, "graphs", "fn-gated.json"), JSON.stringify(FN_GATED_GRAPH));

    // A FRESH RUN PER VERB — the resource is republished and re-deleted each time (see (a)'s own
    // note on why a shared run would not do, which applies here too: `approve` resolves the gate).
    for (const v of VERBS) {
      const f = await fnGatedRun(w.dir);
      const r = await run(withWorkspace(w.dir, v.argv(f)));
      const text = r.out + r.err;
      assert.match(text, /GRAPH015_RESOURCE_NOT_FOUND/, `${v.name} must explain WHY, not just that nothing resolved:\n${text}`);
      // THE MISSING RESOURCE ITSELF, NOT ONLY THE CODE — TODO.md §A.91, the reviewer's fourth fix
      // round (X1's "same mechanism" follow-up): `indexGraphs` used to quote only the summary
      // code ("graph has 1 error(s): GRAPH015_RESOURCE_NOT_FOUND"), never which resource — base's
      // loud sweep named the ref and the file.
      assert.match(text, /function\/prep@stable/, `${v.name} must name WHICH resource is missing:\n${text}`);
      // NEVER THE GRANT ADVICE — a GRAPH015 is not a capability this invocation could hold or
      // withhold, and offering --allow-exec/--egress for it is the false advice this round fixes.
      assert.doesNotMatch(text, /--allow-exec|--egress|grants the RUN had/, `${v.name} must not offer a flag that fixes nothing:\n${text}`);
    }

    const examF = await fnGatedRun(w.dir);
    writeFileSync(join(w.dir, "resources", "exam.json"), JSON.stringify(EXAM));
    const attested = await run(["exam", "attest", join(w.dir, "resources", "exam.json"), "--cohort", examF.runId, "--as", "u:alice", "--workspace", w.dir]);
    const text = attested.out + attested.err;
    assert.match(text, /GRAPH015_RESOURCE_NOT_FOUND/, `exam attest must explain WHY:\n${text}`);
    assert.match(text, /function\/prep@stable/, `exam attest must name WHICH resource is missing:\n${text}`);
    assert.doesNotMatch(text, /--allow-exec|--egress|grants the RUN had/, `exam attest must not offer a flag that fixes nothing:\n${text}`);
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

// ── promote --against-cohort — TODO.md §A.91 B2: it was already right, now pinned ────

/**
 * A priced, never-dialled adapter — `promoteAgainstCohort`'s two door checks (`ws.models`
 * defined, no unpriced route) read only this file's SHAPE. Both scenarios below throw at
 * `resolveRecordedGraph`, before any provider would be called, so this never needs to answer.
 */
const PROMOTE_MODELS_FILE = JSON.stringify({
  adapters: [{ provider: "openai", name: "stub", baseUrl: "http://stub.invalid/v1", apiKeyEnv: null, prices: { m1: { input: 1, output: 1 } } }],
  routes: { "agent_profile/x@stable": { adapter: "stub", model: "m1" } },
});

const PICK_FN = `(view) => ({ writes: { picked: (view.get("items") ?? []).slice() } })`;

function pickGraph(opts: { name: string; version: number; ref?: string; warn?: boolean }): unknown {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: opts.name, project: "lane-d", version: opts.version },
    policy: { posture: "out", capabilities: [] },
    channels: {
      items: { type: "array", reduce: "replace" },
      // GRAPH013_CLOCK_DEPENDENT when `warn` — a warning, not a refusal, so the graph still
      // compiles and the run still succeeds.
      picked: { type: "array", reduce: opts.warn === true ? "last_write_wins_by_ts" : "replace" },
    },
    inputs: ["items"],
    outputs: ["picked"],
    nodes: [{ id: "pick", type: "function", reads: ["items"], writes: ["picked"], function: { ref: opts.ref ?? "function/pick@stable" } }],
    edges: [],
  };
}

test("PROMOTE --AGAINST-COHORT ANNOUNCES THE COHORT'S OWN GRAPH WARNING — TODO.md §A.91 B2", async () => {
  const w = workspace();
  try {
    writeFileSync(join(w.dir, "resources", "function", "pick.js"), PICK_FN);
    writeFileSync(join(w.dir, "graphs", "pick-warn.json"), JSON.stringify(pickGraph({ name: "pick-cohort-warn", version: 1, warn: true })));
    writeFileSync(join(w.dir, "candidate-warn.json"), JSON.stringify(pickGraph({ name: "pick-cohort-warn", version: 2, warn: true })));
    writeFileSync(join(w.dir, "models.json"), PROMOTE_MODELS_FILE);

    const recorded = await run(["run", join(w.dir, "graphs", "pick-warn.json"), "--workspace", w.dir, "--input", JSON.stringify({ items: ["a", "b"] })]);
    assert.equal(recorded.code, 0, recorded.err);
    const { runId } = JSON.parse(recorded.out) as { runId: string };

    // ONE recorded run, no exam, nowhere near MIN_COHORT_SIZE — the command still fails
    // downstream. What is pinned here is EARLIER: `promoteAgainstCohort` already resolved the
    // cohort's own graph before measuring it (this was never the B1 bug), and announces its
    // warning when it does.
    const r = await run([
      "promote", join(w.dir, "candidate-warn.json"),
      "--against-cohort", runId,
      "--models-file", join(w.dir, "models.json"),
      "--workspace", w.dir,
    ]);
    assert.match(r.out + r.err, /GRAPH013_CLOCK_DEPENDENT/, `the resolved baseline's own warning must be announced:\n${r.out}${r.err}`);
  } finally {
    w.dispose();
  }
});

test("PROMOTE --AGAINST-COHORT NAMES THE COHORT'S BROKEN GRAPH, NOT AN EMPTY POPULATION — TODO.md §A.91 B2", async () => {
  const w = workspace();
  try {
    writeFileSync(join(w.dir, "resources", "function", "pick.js"), PICK_FN);
    // The candidate reads a DIFFERENT resource than the baseline, so deleting the baseline's own
    // function below breaks only the cohort's graph — a candidate that also went dark would
    // refuse at `loadGraph`, before `promoteAgainstCohort` is even reached, and prove nothing
    // about the resolver this test is pinning.
    writeFileSync(join(w.dir, "resources", "function", "pick-v2.js"), PICK_FN);
    writeFileSync(join(w.dir, "graphs", "pick.json"), JSON.stringify(pickGraph({ name: "pick-cohort", version: 1 })));
    writeFileSync(join(w.dir, "candidate.json"), JSON.stringify(pickGraph({ name: "pick-cohort", version: 2, ref: "function/pick-v2@stable" })));
    writeFileSync(join(w.dir, "models.json"), PROMOTE_MODELS_FILE);

    const recorded = await run(["run", join(w.dir, "graphs", "pick.json"), "--workspace", w.dir, "--input", JSON.stringify({ items: ["a", "b"] })]);
    assert.equal(recorded.code, 0, recorded.err);
    const { runId } = JSON.parse(recorded.out) as { runId: string };

    // THE COHORT'S OWN RESOURCE, DELETED OUT FROM UNDER IT — the same repro B1 used for `suite
    // freeze`, one verb over.
    rmSync(join(w.dir, "resources", "function", "pick.js"));

    const r = await run([
      "promote", join(w.dir, "candidate.json"),
      "--against-cohort", runId,
      "--models-file", join(w.dir, "models.json"),
      "--workspace", w.dir,
    ]);
    const text = r.out + r.err;
    assert.match(text, /GRAPH015_RESOURCE_NOT_FOUND/, `the true reason must reach the operator:\n${text}`);
    assert.match(text, /graphs[\\/]pick\.json/, `it must name the broken file:\n${text}`);
    // THIS ORDERING WAS NEVER THE B1 BUG — `promoteAgainstCohort` already resolved the cohort's
    // graph before `measureCohort` — but it is pinned here for the same reason `suite freeze`'s
    // is: nothing else in this file drove a broken cohort graph through this verb.
    assert.doesNotMatch(text, /n = 0 comparable runs/, `must not fall back to the population refusal:\n${text}`);
    assert.doesNotMatch(text, /Record more runs of this workflow first/, `must not fall back to the population refusal:\n${text}`);
  } finally {
    w.dispose();
  }
});

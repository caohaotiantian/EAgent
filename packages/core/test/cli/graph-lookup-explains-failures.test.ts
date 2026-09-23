/**
 * A BY-HASH MISS NEVER SAYS "NO GRAPH HAS THAT HASH" WHEN A CANDIDATE MIGHT BE IT — TODO.md §A.91
 * M1, the reviewer's fix round on `3f08adfd`.
 *
 * §A.91's silence landed at the SWEEP: `graphsByHash` stopped narrating candidates it rejects
 * while searching for a run's recorded hash. That was right for the candidates that are NOT the
 * run's graph — but before this row closed, most by-hash callers ALSO never read `graphsByHash`'s
 * `failed` list at all, so a candidate that IS the run's graph and simply refuses to compile under
 * THIS invocation's grants (a capability the run had and this process was not given) produced a
 * flat, false "not found" — or, for `steer`/`deescalate`, fell through to the engine's own generic
 * "is not attached", which is honest only when the graph is genuinely unpublished.
 *
 * ONE FIXTURE, ONE REPRO SHAPE, FOUR VERBS: `graphs/sole.json` needs `proc:exec`; run it with
 * `--allow-exec echo` (it gates before ever spawning anything, so nothing here is offline-unsafe),
 * then ask each verb about it WITHOUT `--allow-exec`. The same bytes, the same hash, now the only
 * candidate in `graphs/`, and it does not compile here. Each verb must say GRAPH017, not silence.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";

/** Gates before it ever spawns anything — irreversible tools gate once, before the first call. */
const SOLE_CANDIDATE = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "sole-candidate", project: "lane-d", version: 1 },
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

/** A minimal, valid exam shape — deterministic, one input beyond "subject", one verdict output. */
const EXAM = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "sole-exam", project: "lane-d", version: 1 },
  policy: { posture: "out", capabilities: [] },
  channels: {
    subject: { type: "string", reduce: "replace" },
    seed: { type: "string", reduce: "replace" },
    verdict: { type: "object", reduce: "replace" },
  },
  inputs: ["subject", "seed"],
  outputs: ["verdict"],
  nodes: [
    {
      id: "grade",
      type: "evaluator",
      reads: ["seed"],
      writes: ["verdict"],
      evaluator: { kind: "assertion", ref: "function/grade@stable", threshold: 0 },
    },
  ],
  edges: [],
};

const GRADE_FN = `(view) => ({ writes: { verdict: { pass: true, score: 1, confidence: 1, detail: "ok" } } })`;

interface Cap {
  code: number;
  out: string;
  err: string;
}

/**
 * `main()` sometimes RETURNS a non-zero code (a refusal `main` itself catches and reports) and
 * sometimes THROWS (a refusal that propagates — `runAsEntryPoint` is what turns that into stderr
 * and exit 1 outside a test). Both are "this door refused" from a caller's point of view, so this
 * helper folds a throw into the same shape rather than making every call site branch on which one
 * a particular verb happens to choose today.
 */
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
  const dir = mkdtempSync(join(tmpdir(), "loom-explains-failures-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  mkdirSync(join(dir, "resources", "function"), { recursive: true });
  writeFileSync(join(dir, "graphs", "sole.json"), JSON.stringify(SOLE_CANDIDATE));
  writeFileSync(join(dir, "resources", "function", "grade.js"), GRADE_FN);
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

test("steer, deescalate, gates and exam attest EACH NAME GRAPH017 in the sole-candidate case", async () => {
  const w = workspace();
  try {
    const started = await run(["run", join(w.dir, "graphs", "sole.json"), "--workspace", w.dir, "--input", '{"seed":"hi"}', "--allow-exec", "echo"]);
    assert.equal(started.code, 0, started.err);
    const { runId, status } = JSON.parse(started.out) as { runId: string; status: string };
    assert.equal(status, "awaiting_gate", "the fixture must gate for this to mean anything");
    const gateMatch = /gate (gate_\S+) on node/.exec(started.err);
    assert.ok(gateMatch !== null, `expected a gate id on stderr: ${started.err}`);
    const gateId = gateMatch![1]!;

    // A table, not four copies: same run, same missing --allow-exec, four doors.
    const cases: { name: string; argv: string[]; expectExitZero: boolean }[] = [
      { name: "steer", argv: ["steer", runId, "--node", "x", "--take", "e1", "--as", "u:alice", "--workspace", w.dir], expectExitZero: false },
      {
        name: "deescalate",
        argv: ["deescalate", runId, "--scope", `run:${runId}`, "--to", "on", "--why", "testing", "--as", "u:alice", "--workspace", w.dir],
        expectExitZero: false,
      },
      // `gates` never refuses — it prints "CONTENT NOT SHOWN" on stderr and still exits 0 with
      // the gate rows on stdout. The claim under test is what stderr SAYS, not the exit code.
      { name: "gates", argv: ["gates", runId, "--workspace", w.dir], expectExitZero: true },
      {
        name: "exam attest",
        argv: ["exam", "attest", join(w.dir, "resources", "exam.json"), "--cohort", runId, "--as", "u:alice", "--workspace", w.dir],
        expectExitZero: false,
      },
    ];
    // The exam file lives outside graphs/ and resources' spec dirs, named explicitly by position —
    // an exam is never itself a published graph.
    writeFileSync(join(w.dir, "resources", "exam.json"), JSON.stringify(EXAM));

    for (const c of cases) {
      const r = await run(c.argv);
      if (c.expectExitZero) {
        assert.equal(r.code, 0, `${c.name}: ${r.err}`);
      } else {
        assert.notEqual(r.code, 0, `${c.name} must refuse when it cannot resolve the graph:\n${r.out}${r.err}`);
      }
      const text = r.out + r.err;
      assert.match(text, /GRAPH017_CAPABILITY_NOT_GRANTED/, `${c.name} must explain WHY, not just that nothing resolved:\n${text}`);
    }

    // AND `approve` ITSELF — the highest-consequence verb, and the reviewer's own repro target.
    const approved = await run(["approve", runId, gateId, "--as", "u:alice", "--workspace", w.dir]);
    assert.notEqual(approved.code, 0, `approve must refuse when it cannot resolve the graph:\n${approved.out}${approved.err}`);
    assert.match(approved.out + approved.err, /GRAPH017_CAPABILITY_NOT_GRANTED/, `approve: ${approved.out}${approved.err}`);
  } finally {
    w.dispose();
  }
});

test("trace's MATCHED graph still shows its own warnings — silence is for the candidates that are NOT it", async () => {
  const w = workspace();
  try {
    // A channel with a clock-dependent reducer compiles clean but WARNS — GRAPH013_CLOCK_DEPENDENT
    // — the same mechanism `stranded-run-tick-cost.test.ts` counts compiles with.
    const warns = {
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "warns", project: "lane-d", version: 1 },
      policy: { posture: "out", capabilities: ["fs:write"] },
      channels: {
        note: { type: "string", reduce: "replace" },
        out: { type: "object", reduce: "last_write_wins_by_ts" },
      },
      inputs: ["note"],
      outputs: ["out"],
      nodes: [{ id: "apply", type: "tool", reads: ["note"], writes: ["out"], unhandled: true, tool: { name: "fs.write", version: "1.0", args: { path: "out/a.txt", body: "${note}" } } }],
      edges: [],
    };
    writeFileSync(join(w.dir, "graphs", "warns.json"), JSON.stringify(warns));
    const started = await run(["run", join(w.dir, "graphs", "warns.json"), "--workspace", w.dir, "--input", '{"note":"x"}']);
    assert.equal(started.code, 0, started.err);
    const { runId } = JSON.parse(started.out) as { runId: string };

    const traced = await run(["trace", runId, "--workspace", w.dir]);
    assert.equal(traced.code, 0, traced.err);
    assert.match(traced.err, /GRAPH013_CLOCK_DEPENDENT/, `the MATCHED graph's own warning must still print:\n${traced.err}`);
  } finally {
    w.dispose();
  }
});

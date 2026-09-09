/**
 * `examples/graphs/triage-failures.json` — the ported workflow, driven the way its doc says.
 *
 * `examples-run.test.ts` already COMPILES every graph in `examples/graphs/` and checks that every
 * published resource is named by one, so this file exists for the half that file cannot cover:
 * the workflow's OBSERVABLE OUTCOME. `docs/workflow-port-2026-09-09.md` tells a stranger four
 * things will happen — the run parks on a gate with the report unwritten, the approval writes it,
 * a different approver is refused, and the run replays — and each of those is one test below. A
 * doc nobody re-runs rots into a promise; this is the re-run.
 *
 * THE PART WORTH PINNING IS THE ORDER, not the counts. `failures` folds in BRANCH order and the
 * collate body ranks by count with a name tie-break, so the ranking is the same on every run and
 * every replay no matter which of the three `fs.read` branches finished first. Three of the five
 * buckets are tied at two failures each; if the tie-break were dropped, or the fold became
 * arrival-ordered, this suite is where it shows.
 *
 * Offline by construction: the graph has no `agent` node, so no adapter is registered, no key is
 * read and no network call is possible.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.ts";
import { isLoomError, toLoomError } from "../src/errors.ts";

const EXAMPLES = fileURLToPath(new URL("../../../examples/", import.meta.url));
const GRAPH = "graphs/triage-failures.json";
const INPUT = JSON.stringify({ pattern: "reports/*.txt" });

/**
 * A throwaway copy of the workspace, `reports/` included.
 *
 * `examples-run.test.ts` copies `graphs/` and `resources/` only, which is right for it and wrong
 * here: `reports/` is this workflow's INPUT — the directory of raw test-runner output a developer
 * points it at — and without it the run fails in `plan` rather than reaching the gate. The copy
 * is thrown away because running writes `.loom/journal.db` and `out/triage.md`, and asserting
 * that the report is absent before approval must not be answered by a previous run's file.
 */
function workspace(subdirs: readonly string[] = ["graphs", "resources", "reports"]): {
  dir: string;
  dispose: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "loom-triage-"));
  for (const sub of subdirs) cpSync(join(EXAMPLES, sub), join(dir, sub), { recursive: true });
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

interface Result {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** `bin/loom <argv> --workspace <dir>`, in-process, with the streams captured. */
async function loom(dir: string, argv: readonly string[]): Promise<Result> {
  const out: string[] = [];
  const errOut: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => (errOut.push(String(c)), true)) as typeof process.stderr.write;
  try {
    const code = await main([...argv, "--workspace", dir]);
    return { code, out: out.join(""), err: errOut.join("") };
  } catch (e) {
    const le = isLoomError(e) ? e : toLoomError(e);
    return { code: 1, out: out.join(""), err: `${errOut.join("")}${le.code}: ${le.message}\n` };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

/**
 * The JSON object `loom run` prints — and ONLY it.
 *
 * `examples-run.test.ts` can do `JSON.parse(r.out)` because its runs succeed. A run that parks on
 * a gate prints the JSON and then, ON THE SAME STREAM, the command to answer it:
 *
 *     }
 *     gate gate_01M… on node approve — loom approve 01M… gate_01M… --as YOUR_ID
 *
 * so stdout is not parseable in exactly the case a script most needs to branch on. Recorded as
 * friction against `cli.ts` in `docs/workflow-port-2026-09-09.md`; here it is just something to
 * cut off. The closing brace of the printed object is the first line that is exactly `}`.
 */
function summary(r: Result): Record<string, unknown> {
  const lines = r.out.split("\n");
  const end = lines.indexOf("}");
  assert.notEqual(end, -1, `no JSON object on stdout:\n${r.out}${r.err}`);
  return JSON.parse(lines.slice(0, end + 1).join("\n")) as Record<string, unknown>;
}

interface Gate {
  readonly gateId: string;
  readonly nodeId: string;
  readonly state: string;
  readonly approvers: readonly string[];
}

/** Run to the gate, and hand back the two coordinates every later verb needs. */
async function runToGate(dir: string): Promise<{ runId: string; gate: Gate }> {
  const r = await loom(dir, ["run", join(dir, GRAPH), "--input", INPUT]);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  const s = summary(r);
  assert.equal(s["status"], "awaiting_gate", `${r.out}${r.err}`);
  const runId = String(s["runId"]);
  const listed = await loom(dir, ["gates", runId]);
  assert.equal(listed.code, 0, `${listed.out}${listed.err}`);
  const gates = JSON.parse(listed.out) as Gate[];
  assert.equal(gates.length, 1, `expected exactly one open gate, got ${listed.out}`);
  return { runId, gate: gates[0]! };
}

test("triage-failures parks on the gate, and the report is NOT on disk yet", async () => {
  const ws = workspace();
  try {
    const { gate } = await runToGate(ws.dir);
    assert.equal(gate.nodeId, "approve");
    assert.equal(gate.state, "open");
    assert.deepEqual([...gate.approvers], ["u:you"]);
    // THE WHOLE POINT OF THE GATE. `write` is downstream of `approve` over a `seq` edge, so a
    // run that stopped here has dispatched no `fs.write` — not "wrote it and will roll back".
    assert.equal(existsSync(join(ws.dir, "out", "triage.md")), false, "nothing is written before a human answers");
  } finally {
    ws.dispose();
  }
});

test("the approval writes the ranked report, and the ranking is stable across the fan-out", async () => {
  const ws = workspace();
  try {
    const { runId, gate } = await runToGate(ws.dir);
    const approved = await loom(ws.dir, ["approve", runId, gate.gateId, "--as", "u:you"]);
    assert.equal(approved.code, 0, `${approved.out}${approved.err}`);

    const s = summary(approved);
    assert.equal(s["status"], "succeeded");
    const outputs = s["outputs"] as Record<string, Record<string, unknown>>;
    const report = outputs["report"]!;

    assert.equal(report["totalFailures"], 8, "eight failing tests across the three shipped shards");
    assert.equal(report["bucketCount"], 5);
    // Branch order, not arrival order: `fs.glob` sorts, `shards` is the fan-out's source, and
    // `failures` folds `append_ordered`.
    assert.deepEqual(report["shards"], ["reports/integration.txt", "reports/unit-shard-1.txt", "reports/unit-shard-2.txt"]);
    // Count descending, then bucket name — three of the five are tied at 2, so this list is
    // exactly the assertion that a dropped tie-break would break.
    assert.deepEqual(report["ranking"], [
      { bucket: "assertion", count: 2 },
      { bucket: "missing-dependency", count: 2 },
      { bucket: "port-in-use", count: 2 },
      { bucket: "timeout", count: 1 },
      { bucket: "uncaught-type-error", count: 1 },
    ]);

    const written = readFileSync(join(ws.dir, "out", "triage.md"), "utf8");
    // The receipt names the RELATIVE path the graph asked for, and a byte count that is the
    // file's — asserted against the file rather than against a literal, so editing a remedy
    // string in the classifier does not turn this red for no reason.
    assert.deepEqual(outputs["written"], { bytes: written.length, path: "out/triage.md" });
    assert.match(written, /^# Test failure triage$/m);
    assert.match(written, /^8 failing test\(s\) across 3 report file\(s\), in 5 root-cause bucket\(s\)\.$/m);
    assert.match(written, /^\| 1 \| `assertion` \| 2 \|$/m);
    // The evidence line carries the two VALUES, not just node:test's "Expected values…" header —
    // a triage report naming neither side of a failed comparison is one you still have to open
    // the log to use.
    assert.match(written, /Expected values to be strictly equal: 1710 !== 1700/);
    assert.match(written, /Cannot find module 'pdf-render' imported from billing\/invoice\.ts/);
  } finally {
    ws.dispose();
  }
});

test("a subject the gate does not name cannot answer it", async () => {
  const ws = workspace();
  try {
    const { runId, gate } = await runToGate(ws.dir);
    const r = await loom(ws.dir, ["approve", runId, gate.gateId, "--as", "u:someone-else"]);
    assert.notEqual(r.code, 0, `an unnamed approver must be refused:\n${r.out}${r.err}`);
    assert.equal(existsSync(join(ws.dir, "out", "triage.md")), false, "and the write still has not happened");
  } finally {
    ws.dispose();
  }
});

test("cancelling instead of approving stops the run and leaves the disk alone", async () => {
  const ws = workspace();
  try {
    const { runId } = await runToGate(ws.dir);
    const r = await loom(ws.dir, ["cancel", runId, "--as", "u:you", "--reason", "triaged by hand instead"]);
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.equal(summary(r)["status"], "cancelled");
    assert.equal(existsSync(join(ws.dir, "out", "triage.md")), false);

    const listed = await loom(ws.dir, ["gates", runId]);
    assert.deepEqual(JSON.parse(listed.out), [], "a cancelled run holds no open gate");
  } finally {
    ws.dispose();
  }
});

test("the finished run replays with zero effects re-executed", async () => {
  const ws = workspace();
  try {
    const { runId, gate } = await runToGate(ws.dir);
    const approved = await loom(ws.dir, ["approve", runId, gate.gateId, "--as", "u:you"]);
    assert.equal(approved.code, 0, `${approved.out}${approved.err}`);

    // No `--graph`: the run's journal records its graph's HASH and a fresh process finds it in
    // `graphs/`. `hermetic` is what says the three `fs.read` calls and the `fs.write` were served
    // from the record rather than re-run — including the human's decision at the gate.
    const replay = await loom(ws.dir, ["replay", runId]);
    assert.equal(replay.code, 0, `${replay.out}${replay.err}`);
    assert.deepEqual(JSON.parse(replay.out), { match: true, hermetic: true });
  } finally {
    ws.dispose();
  }
});

test("a pattern matching nothing FAILS the run rather than reporting a clean suite", async () => {
  // The undecidable-looking case answered the refusing way. A fan-out over an empty array
  // produces no branches, the join folds nothing, and the run would succeed with a report saying
  // "0 failing tests" — which reads as "your suite is green" when what happened is that the
  // pattern was wrong. `triage-plan.js` throws instead, and names the pattern back.
  const ws = workspace(["graphs", "resources"]);
  try {
    const r = await loom(ws.dir, ["run", join(ws.dir, GRAPH), "--input", INPUT]);
    assert.notEqual(r.code, 0, `${r.out}${r.err}`);
    const s = summary(r);
    assert.equal(s["status"], "failed");
    assert.match(String((s["error"] as Record<string, unknown>)["message"]), /no test-output files matched/);
    assert.equal(existsSync(join(ws.dir, "out", "triage.md")), false);
  } finally {
    ws.dispose();
  }
});

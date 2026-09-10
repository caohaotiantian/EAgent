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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
 * The JSON object `loom run` prints — which is the WHOLE of stdout, and asserted as such.
 *
 * This used to slice stdout to the first line that was exactly `}`, because a run parking on a
 * gate printed the JSON and then, on the same stream, the command to answer it — so stdout was
 * unparseable in exactly the case a script most needs to branch on (friction F4 of
 * `docs/workflow-port-2026-09-09.md`). `175cdb3` moved that hint to stderr, where the run-id hint
 * already was, so the slice is gone and `JSON.parse` over the whole capture takes its place.
 *
 * PARSING THE WHOLE THING IS THE POINT, not a tidy-up: it is the assertion that nothing else is
 * on stdout. The next line printed on the wrong stream breaks `| jq` for the same caller in the
 * same way, and a slice would have absorbed it in silence.
 */
function summary(r: Result): Record<string, unknown> {
  try {
    return JSON.parse(r.out) as Record<string, unknown>;
  } catch (e) {
    assert.fail(`stdout is not one JSON object (${String(e)}):\n${r.out}${r.err}`);
  }
}

interface Gate {
  readonly gateId: string;
  readonly nodeId: string;
  readonly state: string;
  readonly approvers: readonly string[];
  /** The gate node's declared channels and their values (`da86076`); absent when it cannot be recomputed. */
  readonly reads?: Record<string, unknown>;
}

/** Run to the gate, and hand back the two coordinates every later verb needs. */
async function runToGate(dir: string): Promise<{ runId: string; gate: Gate }> {
  const r = await loom(dir, ["run", join(dir, GRAPH), "--input", INPUT]);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  const s = summary(r);
  assert.equal(s["status"], "awaiting_gate", `${r.out}${r.err}`);
  // …and the line telling a human how to answer it is on STDERR. `summary()` above is the half
  // that says stdout is pure JSON; deleting the hint would pass that half and take away the one
  // line an operator needs, so both are asserted.
  assert.match(r.err, /^gate gate_\S+ on node approve — loom approve \S+ gate_\S+ --as YOUR_ID$/m, r.err);
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

    // WHAT THE APPROVER IS BEING ASKED ABOUT, on the CLI path and not only through `loom serve`.
    // The gate node declares `reads: ["report"]`, so `loom gates` carries the report itself beside
    // the digest — which is a binding to what was shown, not something a person can read. Asserted
    // down to the ranking because "the field exists" would pass for an empty object, and this run
    // is the one whose eight failures the next test counts.
    const reads = gate.reads ?? {};
    assert.deepEqual(Object.keys(reads), ["report"], JSON.stringify(reads));
    const shown = reads["report"] as Record<string, unknown>;
    assert.equal(shown["totalFailures"], 8);
    assert.equal(shown["bucketCount"], 5);
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
    // The receipt names the RELATIVE path the graph asked for, and `bytes` is
    // `String(body).length` — a UTF-16 CODE-UNIT count, not a byte count, so it agrees with
    // `wc -c` only while the report is ASCII and this one is not. Asserted against the string
    // read back rather than against a literal, so editing a remedy line does not turn it red.
    assert.deepEqual(outputs["written"], { bytes: written.length, path: "out/triage.md" });
    assert.match(written, /^# Test failure triage$/m);
    assert.match(written, /^8 failing test\(s\) across 3 report file\(s\) \(3 with failures\), in 5 root-cause bucket\(s\)\.$/m);
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
    // THE CODE, not just the exit status. A bad `runId` or a typo'd `gateId` also exits 1 — as
    // `E_GATE_NOT_FOUND` — so a test asserting only `code !== 0` would keep passing if the
    // approver check were removed entirely.
    assert.match(r.err, /E_GATE_NOT_AUTHORIZED/, r.err);
    assert.match(r.err, /does not name "u:someone-else" as an approver/, r.err);
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
  // pattern was wrong. `triage-plan.js` refuses instead, and names the pattern back.
  const ws = workspace(["graphs", "resources"]);
  try {
    const r = await loom(ws.dir, ["run", join(ws.dir, GRAPH), "--input", INPUT]);
    assert.notEqual(r.code, 0, `${r.out}${r.err}`);
    const s = summary(r);
    assert.equal(s["status"], "failed");
    const error = s["error"] as Record<string, unknown>;
    assert.match(String(error["message"]), /no test-output files matched/);
    // A.42's repro, and the reason the message alone is not the assertion. This arrives as
    // `internal`/`E_INTERNAL` — the code a genuine BUG in the body produces — for as long as the
    // body's only way to fail on purpose is `throw`. `{refuse: {reason}}` is what makes a caller
    // able to tell a graph that declined from a body that crashed, and `validation` is what stops
    // a `retry` policy ever granting it a second attempt.
    assert.equal(error["code"], "E_FUNCTION_REFUSED", r.out);
    assert.equal(error["class"], "validation", r.out);
    assert.equal(error["retryable"], false, r.out);
    assert.equal(existsSync(join(ws.dir, "out", "triage.md")), false);
  } finally {
    ws.dispose();
  }
});

// ── the four a fresh review found, three of which REPORTED A GREEN SUITE ──────

test("a CRLF shard is triaged identically to an LF one", async () => {
  // THE WORST FAILURE THIS WORKFLOW CAN HAVE, and it shipped in the first draft. Every pattern in
  // `triage-classify.js` is anchored; in JavaScript `.` excludes `\r` and a `$` without `/m`
  // matches only the true end of the string — so a file split on `"\n"` alone matched NOTHING and
  // the run SUCCEEDED with "0 failing test(s) across 0 report file(s)". CI output written on
  // Windows, or checked out under `core.autocrlf=true`, is the ordinary case, not an exotic one.
  const ws = workspace(["graphs", "resources"]);
  try {
    mkdirSync(join(ws.dir, "reports"));
    for (const f of readdirSync(join(EXAMPLES, "reports"))) {
      const lf = readFileSync(join(EXAMPLES, "reports", f), "utf8");
      assert.equal(lf.includes("\r"), false, `${f} is the LF fixture; this test supplies the CRLF half`);
      writeFileSync(join(ws.dir, "reports", f), lf.replace(/\n/g, "\r\n"));
    }

    const { runId, gate } = await runToGate(ws.dir);
    const approved = await loom(ws.dir, ["approve", runId, gate.gateId, "--as", "u:you"]);
    assert.equal(approved.code, 0, `${approved.out}${approved.err}`);
    const report = (summary(approved)["outputs"] as Record<string, Record<string, unknown>>)["report"]!;

    assert.equal(report["totalFailures"], 8, "a CRLF shard must not read as a clean one");
    assert.deepEqual(report["ranking"], [
      { bucket: "assertion", count: 2 },
      { bucket: "missing-dependency", count: 2 },
      { bucket: "port-in-use", count: 2 },
      { bucket: "timeout", count: 1 },
      { bucket: "uncaught-type-error", count: 1 },
    ]);
    // …and the evidence is clean too, rather than carrying a stray `\r` into the report.
    assert.match(readFileSync(join(ws.dir, "out", "triage.md"), "utf8"), /Expected values to be strictly equal: 1710 !== 1700\n/);
  } finally {
    ws.dispose();
  }
});

test("more shards than the fan-out can carry REFUSES, instead of dropping the surplus", async () => {
  // `maxWidth` CLAMPS in silence: at a width of 8, twelve shards ran eight branches and the report
  // said "8 failing test(s) across 8 report file(s)" with no warning on either stream — a third of
  // the evidence missing from a document a person is being asked to approve.
  //
  // THE CEILING HAS ONE HOME, and it is the graph. `triage-plan.js` used to carry a
  // `SHARD_CEILING = 24` beside the `fan` edge's `maxWidth: 24`, and this test pinned the two
  // together by reading the graph — a patch on a seam rather than the seam. Since `c2360be` a body
  // reads `ctx.node.out`, so the constant is GONE and the assertion below is that it stays gone:
  // a body that hard-codes the number again passes the drive but fails the read.
  const ws = workspace(["graphs", "resources"]);
  try {
    const spec = JSON.parse(readFileSync(join(ws.dir, GRAPH), "utf8")) as { edges: { id: string; maxWidth?: number }[] };
    const width = spec.edges.find((e) => e.id === "fan")!.maxWidth!;
    assert.equal(typeof width, "number");

    // The body names `maxWidth` (it reads the edge) and never the NUMBER. Docstring and comments
    // are stripped first, so prose that mentions a width — "30 shards with a width of 24" — is not
    // what this catches; a literal in the code is.
    const body = readFileSync(join(ws.dir, "resources", "function", "triage-plan.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    assert.equal(new RegExp(`\\b${String(width)}\\b`).test(body), false, `triage-plan.js hard-codes the ceiling:\n${body}`);
    assert.match(body, /ctx\.node/, "…and the number it does not carry is read off the node instead");

    mkdirSync(join(ws.dir, "reports"));
    const one = readFileSync(join(EXAMPLES, "reports", "unit-shard-2.txt"), "utf8");
    const name = (i: number): string => `shard-${String(i).padStart(3, "0")}.txt`;
    for (let i = 0; i <= width; i += 1) writeFileSync(join(ws.dir, "reports", name(i)), one);

    const r = await loom(ws.dir, ["run", join(ws.dir, GRAPH), "--input", INPUT]);
    assert.notEqual(r.code, 0, `${String(width + 1)} shards over a width of ${String(width)} must refuse:\n${r.out}${r.err}`);
    const s = summary(r);
    assert.equal(s["status"], "failed");
    const error = s["error"] as Record<string, unknown>;
    assert.match(
      String(error["message"]),
      new RegExp(`matched ${String(width + 1)} test-output files but this graph fans out at most ${String(width)}`),
    );
    // The cap in that sentence came off the graph, so this also says the read WORKED: a body that
    // could not find its fan-out edge refuses with the other reason and this regex fails.
    assert.equal(error["code"], "E_FUNCTION_REFUSED", r.out);
    assert.equal(existsSync(join(ws.dir, "out", "triage.md")), false);

    // …and EXACTLY at the ceiling it still runs, so this is a ceiling and not an off-by-one.
    rmSync(join(ws.dir, "reports", name(width)));
    assert.equal((await runToGate(ws.dir)).gate.nodeId, "approve");
  } finally {
    ws.dispose();
  }
});

test("a shard with no failures is still COUNTED as a file that was read", async () => {
  // `report.shards` used to be derived from the failures, so a clean shard was invisible: three
  // all-green files reported "0 failing test(s) across 0 report file(s)". "I read three files and
  // found nothing" and "I read nothing" are different sentences, and a triage report that cannot
  // tell them apart is one you cannot act on.
  const ws = workspace(["graphs", "resources"]);
  try {
    mkdirSync(join(ws.dir, "reports"));
    const green = "TAP version 13\n# Subtest: cart/ok.test.ts\n    ok 1 - adds up\n    1..1\nok 1 - cart/ok.test.ts\n1..1\n# pass 1\n";
    writeFileSync(join(ws.dir, "reports", "green-1.txt"), green);
    writeFileSync(join(ws.dir, "reports", "green-2.txt"), green);
    writeFileSync(join(ws.dir, "reports", "red.txt"), readFileSync(join(EXAMPLES, "reports", "unit-shard-2.txt"), "utf8"));

    const { runId, gate } = await runToGate(ws.dir);
    const approved = await loom(ws.dir, ["approve", runId, gate.gateId, "--as", "u:you"]);
    assert.equal(approved.code, 0, `${approved.out}${approved.err}`);
    const report = (summary(approved)["outputs"] as Record<string, Record<string, unknown>>)["report"]!;

    assert.deepEqual(report["shards"], ["reports/green-1.txt", "reports/green-2.txt", "reports/red.txt"], "every file READ");
    assert.deepEqual(report["shardsWithFailures"], ["reports/red.txt"], "…and, separately, the ones that failed");
    assert.equal(report["totalFailures"], 2);
    assert.match(
      readFileSync(join(ws.dir, "out", "triage.md"), "utf8"),
      /^2 failing test\(s\) across 3 report file\(s\) \(1 with failures\), in 1 root-cause bucket\(s\)\.$/m,
    );
  } finally {
    ws.dispose();
  }
});

test("the body REFUSES when it cannot read a width, instead of picking one", async () => {
  // THE ARM THE READ RESTS ON. `triage-plan.js` no longer carries the ceiling, so the case that
  // used to be impossible — the number is not there — is now reachable, and it is the one where
  // guessing is worst: a fan-out CLAMPS in silence, so a body that assumed a width would drop
  // evidence out of a document a person is about to approve. Refusing is the only answer that
  // cannot be wrong quietly.
  //
  // DRIVEN, not reasoned: the shipped body is put on a node with NO outgoing fan-out, in a
  // throwaway graph written into the test's own workspace. `resources/` is the shipped directory,
  // copied unedited — this is the real body, reached the way any graph would reach it.
  const ws = workspace(["resources"]);
  try {
    mkdirSync(join(ws.dir, "graphs"));
    const spec = {
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "no-fanout", project: "examples-test", version: 1 },
      policy: { posture: "on", expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
      channels: { found: { type: "string", reduce: "replace" }, shards: { type: "array", reduce: "replace" } },
      inputs: ["found"],
      outputs: ["shards"],
      nodes: [{ id: "plan", type: "function", reads: ["found"], writes: ["shards"], function: { ref: "function/triage-plan@stable" } }],
      edges: [],
    };
    const graph = join(ws.dir, "graphs", "no-fanout.json");
    writeFileSync(graph, JSON.stringify(spec, null, 2));

    const r = await loom(ws.dir, ["run", graph, "--input", JSON.stringify({ found: "a.txt\nb.txt" })]);
    assert.notEqual(r.code, 0, `a body that cannot read its width must refuse:\n${r.out}${r.err}`);
    const error = summary(r)["error"] as Record<string, unknown>;
    assert.equal(error["code"], "E_FUNCTION_REFUSED", r.out);
    // The reason names the node and counts what it found, so the operator is told which graph is
    // wrong rather than that "something refused".
    assert.match(String(error["message"]), /cannot read its width: node "plan" declares 0 fanout edge\(s\) over "shards"/, r.out);
  } finally {
    ws.dispose();
  }
});

test("a failure with no YAML block does not swallow the next one", async () => {
  // The block scan ran forward to the next `...` and then advanced PAST it, so a `not ok` with no
  // block ate the FOLLOWING failure and wore its evidence: one row reading "alpha/one.test.ts —
  // no yaml at all / Cannot find module 'zzz' imported from beta/two.ts", with `beta/two.test.ts`
  // gone entirely. Two failures collapsed into one is this workflow's own error, inverted.
  const ws = workspace(["graphs", "resources"]);
  try {
    mkdirSync(join(ws.dir, "reports"));
    writeFileSync(
      join(ws.dir, "reports", "ragged.txt"),
      [
        "TAP version 13",
        "# Subtest: alpha/one.test.ts",
        "    not ok 1 - no yaml at all",
        "# Subtest: beta/two.test.ts",
        "    not ok 1 - a real failure that should be its own bucket",
        "      ---",
        "      error: |-",
        "        Cannot find module 'zzz' imported from beta/two.ts",
        "      code: 'ERR_MODULE_NOT_FOUND'",
        "      ...",
        "1..2",
        "",
      ].join("\n"),
    );

    const { runId, gate } = await runToGate(ws.dir);
    const approved = await loom(ws.dir, ["approve", runId, gate.gateId, "--as", "u:you"]);
    assert.equal(approved.code, 0, `${approved.out}${approved.err}`);
    const report = (summary(approved)["outputs"] as Record<string, Record<string, unknown>>)["report"]!;

    assert.equal(report["totalFailures"], 2, "both failures survive");
    const cases = (report["buckets"] as { id: string; cases: { file: string; test: string; evidence: string }[] }[])
      .flatMap((b) => b.cases.map((c) => ({ bucket: b.id, file: c.file, test: c.test, evidence: c.evidence })))
      .sort((a, b) => (a.file < b.file ? -1 : 1));
    assert.deepEqual(cases, [
      { bucket: "unclassified", file: "alpha/one.test.ts", test: "no yaml at all", evidence: "(no error line)" },
      {
        bucket: "missing-dependency",
        file: "beta/two.test.ts",
        test: "a real failure that should be its own bucket",
        evidence: "Cannot find module 'zzz' imported from beta/two.ts",
      },
    ]);
  } finally {
    ws.dispose();
  }
});

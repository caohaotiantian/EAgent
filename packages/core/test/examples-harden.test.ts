/**
 * `examples/graphs/harden-config.json` — the SECOND ported workflow, driven the way its doc says.
 *
 * `examples-run.test.ts` already COMPILES every graph in `examples/graphs/` and checks that every
 * published resource is named by one, and `examples-triage.test.ts` does for the first port what
 * this file does for the second: assert the OBSERVABLE OUTCOME of the workflow a stranger is told
 * to run. `docs/workflow-port-2026-09-22.md` promises seven things — the run converges in eight
 * passes and parks with nothing written, the gate SHOWS the whole fix log, the approval writes both
 * files, a manifest with an unrepairable finding still settles, a manifest too dirty for the budget
 * says so, two malformed inputs refuse, and the run replays — and each is a test below. A doc
 * nobody re-runs rots into a promise.
 *
 * WHAT IS WORTH PINNING HERE IS DIFFERENT FROM THE FIRST PORT, because the shape is. `triage`'s
 * risk is branch ORDER under a fan-out; this graph has no fan-out. Its risk is the LOOP:
 *
 *  - **Convergence, not just success.** Nine audits and eight fixes, strictly alternating, is the
 *    claim. A graph that silently stopped after one pass would still park on a gate, still write a
 *    report, and still exit 0 — with a manifest that does not deploy. `the loop makes exactly the
 *    passes the data needs` reads the count out of `loom trace`.
 *  - **The cascades.** Three of the eight findings do not exist until an earlier fix lands, and a
 *    one-pass fixer cannot see them. Each cascade entry is pinned to appear AFTER the entry that
 *    created it, which is the assertion that re-auditing is what found it rather than luck.
 *  - **Idempotence.** Hardening the hardened manifest applies ZERO fixes. That is the only
 *    end-to-end check that the auditor's detectors and the fixer's repairs actually agree: a rule
 *    whose repair does not clear its own detector converges to the budget instead, and this test
 *    catches it without knowing which rule it was.
 *  - **The budget lives in the GRAPH.** `len(applied) >= 12` is edited down in the workspace copy
 *    alone, and the run is required to stop at the new number. A body holding its own constant
 *    fails this.
 *
 * Offline by construction: no `agent` node, so no adapter is registered, no key is read, and no
 * network call is possible. Nothing here asserts on a duration or a ratio of two.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.ts";
import { isLoomError, toLoomError } from "../src/errors.ts";

const EXAMPLES = fileURLToPath(new URL("../../../examples/", import.meta.url));
const GRAPH = "graphs/harden-config.json";

const HARDENED = join("out", "service.hardened.json");
const REPORT = join("out", "harden-report.md");

/** `--input` for one of the shipped manifests. */
function input(manifest: string): string {
  return JSON.stringify({ manifestPath: `manifests/${manifest}` });
}

/**
 * A throwaway copy of the workspace, `manifests/` included.
 *
 * `examples-run.test.ts` copies `graphs/` and `resources/` only, which is right for it and wrong
 * here: `manifests/` is this workflow's INPUT. The copy is thrown away because running writes
 * `.loom/journal.db`, `out/service.hardened.json` and `out/harden-report.md`, and asserting that
 * neither file exists before approval must not be answered by a previous run's leftovers.
 */
function workspace(subdirs: readonly string[] = ["graphs", "resources", "manifests"]): {
  dir: string;
  dispose: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "loom-harden-"));
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
 * Parsing the whole capture rather than slicing it is the assertion that nothing else reaches
 * stdout, which is what makes `loom run … 2>/dev/null | jq .status` work on the gate path. That
 * was friction F4 of the FIRST port, closed at `175cdb3`; this graph parks on a gate too, so it is
 * the same promise and it is re-asserted here rather than assumed.
 */
function summary(r: Result): Record<string, unknown> {
  try {
    return JSON.parse(r.out) as Record<string, unknown>;
  } catch (e) {
    assert.fail(`stdout is not one JSON object (${String(e)}):\n${r.out}${r.err}`);
  }
}

interface Applied {
  readonly pass: number;
  readonly rule: string;
  readonly at: string;
  readonly cascadeOf: string | null;
  readonly was: unknown;
  readonly now: unknown;
}

interface Report {
  readonly manifest: string;
  readonly service: string;
  readonly passes: number;
  readonly stoppedBy: string;
  readonly cascades: number;
  readonly applied: readonly Applied[];
  readonly open: readonly { rule: string; at: string; autofixable?: boolean; remedy: string }[];
  readonly hardened: Record<string, unknown>;
}

interface Gate {
  readonly gateId: string;
  readonly nodeId: string;
  readonly state: string;
  readonly approvers: readonly string[];
  readonly reads?: Record<string, unknown>;
}

/** Run to the gate on one manifest, and hand back the coordinates and the report it is holding. */
async function runToGate(dir: string, manifest: string): Promise<{ runId: string; gate: Gate; report: Report }> {
  const r = await loom(dir, ["run", join(dir, GRAPH), "--input", input(manifest)]);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  const s = summary(r);
  assert.equal(s["status"], "awaiting_gate", `${r.out}${r.err}`);
  // The line telling a human how to answer the gate is on STDERR, beside the run-id hint.
  assert.match(r.err, /^gate gate_\S+ on node review — loom approve \S+ gate_\S+ --as YOUR_ID$/m, r.err);
  const runId = String(s["runId"]);

  const listed = await loom(dir, ["gates", runId]);
  assert.equal(listed.code, 0, `${listed.out}${listed.err}`);
  const gates = JSON.parse(listed.out) as Gate[];
  assert.equal(gates.length, 1, `expected exactly one open gate, got ${listed.out}`);
  const gate = gates[0]!;

  // WHAT THE APPROVER IS BEING SHOWN, read off the CLI and not out of the run's own outputs. The
  // gate node declares `reads: ["report"]`, so `loom gates` carries the report beside the digest —
  // and the digest is a binding to what was shown, not something a person can read.
  const reads = gate.reads ?? {};
  assert.deepEqual(Object.keys(reads), ["report"], JSON.stringify(reads));
  return { runId, gate, report: reads["report"] as unknown as Report };
}

/** How many times each node ran, read out of the span tree `loom trace` prints. */
async function taskCounts(dir: string, runId: string): Promise<Record<string, number>> {
  const t = await loom(dir, ["trace", runId]);
  assert.equal(t.code, 0, `${t.out}${t.err}`);
  const counts: Record<string, number> = {};
  for (const line of t.out.split("\n")) {
    const m = /^\s*loom\.task (\S+) /.exec(line);
    if (m === null) continue;
    counts[m[1]!] = (counts[m[1]!] ?? 0) + 1;
  }
  return counts;
}

// The shipped manifest's remediation, in the order the graph must decide it. `cascadeOf` is what
// makes an entry impossible before its cause: `pull-policy-redundant` cannot fire until the tag is
// pinned, `workdir-not-readable` until the manifest stops running as root, `secret-not-declared`
// until a value has become a secretRef. Pinning the ORDER, not just the set, is what says the loop
// found them rather than a one-pass sweep guessing them.
const EXPECTED: readonly (readonly [number, string, string, string | null])[] = [
  [1, "floating-image-tag", "image", null],
  [2, "pull-policy-redundant", "pullPolicy", "floating-image-tag"],
  [3, "runs-as-root", "user", null],
  [4, "workdir-not-readable", "workdir", "runs-as-root"],
  [5, "plaintext-secret", "env.DB_PASSWORD", null],
  [6, "secret-not-declared", "secrets", "plaintext-secret"],
  [7, "debug-logging-in-prod", "env.LOG_LEVEL", null],
  [8, "no-healthcheck", "healthcheck", null],
];

test("harden-config parks on the gate with the whole fix log, and neither file is on disk yet", async () => {
  const ws = workspace();
  try {
    const { gate, report } = await runToGate(ws.dir, "orders-api.json");
    assert.equal(gate.nodeId, "review");
    assert.equal(gate.state, "open");
    assert.deepEqual([...gate.approvers], ["u:you"]);

    assert.equal(report.service, "orders-api");
    assert.equal(report.passes, 8);
    assert.equal(report.stoppedBy, "settled");
    assert.equal(report.cascades, 3);
    assert.deepEqual([...report.open], [], "a settled run holds no open finding on this manifest");

    // THE WHOLE POINT OF THE GATE. Both `fs.write` nodes are downstream of `review` over `seq`
    // edges, so a run parked here has dispatched neither — not "wrote them and will roll back".
    assert.equal(existsSync(join(ws.dir, HARDENED)), false, "the hardened manifest is not written before a human answers");
    assert.equal(existsSync(join(ws.dir, REPORT)), false, "and neither is its report");
  } finally {
    ws.dispose();
  }
});

test("the loop makes exactly the passes the data needs — nine audits, eight fixes, alternating", async () => {
  const ws = workspace();
  try {
    const { runId } = await runToGate(ws.dir, "orders-api.json");
    const counts = await taskCounts(ws.dir, runId);

    // NINE AND EIGHT, not "more than one". A graph that stopped after the first pass would still
    // park on a gate and still write a report — with a manifest carrying three findings its own
    // fixes created. The +1 is the audit that found nothing left to do, which is what `settled`
    // means and the only reason the loop exits.
    assert.equal(counts["audit"], 9, JSON.stringify(counts));
    assert.equal(counts["fix"], 8, JSON.stringify(counts));
    assert.equal(counts["parse"], 1, JSON.stringify(counts));
    assert.equal(counts["collate"], 1, JSON.stringify(counts));
    // `collate` runs ONCE and not once per pass, which is the `done` edge's `when` doing its job:
    // an unconditional edge out of `audit` would have raised a gate on every pass.
    assert.equal(counts["review"], 1, JSON.stringify(counts));
  } finally {
    ws.dispose();
  }
});

test("every cascade is applied AFTER the fix that created it, in one stated order", async () => {
  const ws = workspace();
  try {
    const { report } = await runToGate(ws.dir, "orders-api.json");
    assert.equal(report.applied.length, EXPECTED.length, JSON.stringify(report.applied));
    for (const [i, [pass, rule, at, cascadeOf]] of EXPECTED.entries()) {
      const a = report.applied[i]!;
      assert.equal(a.pass, pass, JSON.stringify(a));
      assert.equal(a.rule, rule, JSON.stringify(a));
      assert.equal(a.at, at, JSON.stringify(a));
      assert.equal(a.cascadeOf, cascadeOf, JSON.stringify(a));
      // The structural claim, independent of the table above: a cascade's cause is EARLIER in the
      // log. If the fixer ever applied one before its cause, the manifest it produced would carry
      // a finding nothing looked for again.
      if (cascadeOf !== null) {
        const cause = report.applied.findIndex((x) => x.rule === cascadeOf);
        assert.ok(cause >= 0 && cause < i, `"${rule}" landed before its cause "${cascadeOf}": ${JSON.stringify(report.applied)}`);
      }
    }
    // And the pair on each entry is the diff a person is approving: `was` is what the file said.
    assert.equal(report.applied[0]!.was, "registry.internal/orders-api:latest");
    assert.equal(report.applied[0]!.now, "registry.internal/orders-api:1.8.3");
    assert.equal(report.applied[4]!.was, "hunter2", "the plaintext credential is shown, because the approver has to see what left the file");
  } finally {
    ws.dispose();
  }
});

test("the approval writes both files, and the hardened manifest satisfies every rule", async () => {
  const ws = workspace();
  try {
    const { runId, gate } = await runToGate(ws.dir, "orders-api.json");
    const approved = await loom(ws.dir, ["approve", runId, gate.gateId, "--as", "u:you"]);
    assert.equal(approved.code, 0, `${approved.out}${approved.err}`);

    const written = JSON.parse(readFileSync(join(ws.dir, HARDENED), "utf8")) as Record<string, unknown>;
    assert.equal(written["image"], "registry.internal/orders-api:1.8.3");
    assert.equal(written["pullPolicy"], "IfNotPresent");
    assert.equal(written["user"], "app");
    assert.equal(written["workdir"], "/srv/app");
    assert.deepEqual(written["env"], {
      DB_PASSWORD: { secretRef: "db-password" },
      LOG_LEVEL: "info",
      REGION: "eu-west-1",
    });
    assert.deepEqual(written["secrets"], ["db-password"]);
    assert.deepEqual(written["healthcheck"], { httpGet: { path: "/healthz", port: 8080 } });

    const md = readFileSync(join(ws.dir, REPORT), "utf8");
    assert.match(md, /^# Config hardening — orders-api$/m);
    assert.match(md, /3 of those 8 fix\(es\) closed a finding that DID NOT EXIST when the run started/);
    assert.match(md, /^## Still open — 0$/m);
    for (const [, rule] of EXPECTED) assert.match(md, new RegExp(`\`${rule}\``), `the report must name ${rule}`);

    // IDEMPOTENCE, AND IT IS THE STRONGEST ASSERTION IN THIS FILE. Point the graph at its own
    // output and ZERO fixes are applied: the auditor finds nothing, so every detector in
    // `harden-audit.js` agrees with every repair in `harden-fix.js`. A rule whose repair does not
    // clear its own detector converges to the budget instead, and this catches that without the
    // test having to know which rule it was.
    cpSync(join(ws.dir, HARDENED), join(ws.dir, "manifests", "round-two.json"));
    const again = await runToGate(ws.dir, "round-two.json");
    assert.equal(again.report.passes, 0, JSON.stringify(again.report.applied));
    assert.equal(again.report.stoppedBy, "settled");
    assert.deepEqual([...again.report.open], []);
  } finally {
    ws.dispose();
  }
});

test("a finding the fixer CANNOT repair still settles the loop, and survives to the gate", async () => {
  const ws = workspace();
  try {
    // `settled` means "no AUTO-FIXABLE finding remains", not "no finding remains". This manifest
    // declares no port, so there is no probe target for a healthcheck and no repair to make. The
    // wrong definition would spin the loop to its budget and then headline the report with an
    // exhausted budget instead of with the one thing a person has to decide.
    const { report } = await runToGate(ws.dir, "payments-worker.json");
    assert.equal(report.passes, 1, JSON.stringify(report.applied));
    assert.equal(report.stoppedBy, "settled");
    assert.equal(report.applied[0]!.rule, "debug-logging-in-prod");
    assert.equal(report.open.length, 1, JSON.stringify(report.open));
    assert.equal(report.open[0]!.rule, "no-healthcheck");
    assert.equal(report.open[0]!.autofixable, false);
    assert.match(report.open[0]!.remedy, /declares no port, so there is no probe target/);
  } finally {
    ws.dispose();
  }
});

test("a manifest dirtier than the pass budget says so, rather than claiming to be done", async () => {
  const ws = workspace();
  try {
    const { runId, gate, report } = await runToGate(ws.dir, "legacy-gateway.json");
    assert.equal(report.passes, 12, JSON.stringify(report.applied));
    assert.equal(report.stoppedBy, "budget");
    assert.ok(report.open.length > 0, "a budget stop leaves auto-fixable work on the table");
    assert.equal(report.open.some((f) => f.autofixable === true), true, JSON.stringify(report.open));

    // AND THE REPORT SAYS IT IN WORDS, because the person reading it is the one who has to decide
    // whether a better-but-not-done manifest may ship. A run that exhausted its budget exits 0 and
    // parks on a gate exactly like one that converged; the only difference is this sentence.
    const approved = await loom(ws.dir, ["approve", runId, gate.gateId, "--as", "u:you"]);
    assert.equal(approved.code, 0, `${approved.out}${approved.err}`);
    const md = readFileSync(join(ws.dir, REPORT), "utf8");
    assert.match(md, /\*\*the pass budget ran out with auto-fixable findings still open\*\* — this manifest is better, not done\./);
  } finally {
    ws.dispose();
  }
});

test("the budget is whatever the GRAPH says — move it and the run stops with the new number", async () => {
  // THE DRIFT TEST, behavioural on purpose, and the same shape as the first port's `maxWidth` one.
  // `len(applied) >= 12` is written on the `repair` edge's `when` and on the `done` edge's `when`,
  // and a body cannot read either (`ctx.node.out` carries `maxIterations`, not `until` or `when` —
  // F4 of the port doc). So the only way to know the bodies do not carry their own copy is to move
  // the number in the graph alone and require the run to obey it.
  const ws = workspace();
  try {
    const path = join(ws.dir, GRAPH);
    const raw = JSON.parse(readFileSync(path, "utf8")) as { edges: { id: string; when?: string; until?: string }[] };
    const shipped = 12;
    const moved = 3;
    const repair = raw.edges.find((e) => e.id === "repair")!;
    const done = raw.edges.find((e) => e.id === "done")!;
    assert.equal(repair.when, `!settled && len(applied) < ${String(shipped)}`, "the shipped budget moved; update this test");
    assert.equal(done.when, `settled || len(applied) >= ${String(shipped)}`, "the shipped budget moved; update this test");
    // BOTH, and that is the point of asserting on both above: the two are exact complements, so a
    // graph that moved one and not the other has a pass the loop leaves by no edge at all.
    repair.when = `!settled && len(applied) < ${String(moved)}`;
    done.when = `settled || len(applied) >= ${String(moved)}`;
    writeFileSync(path, JSON.stringify(raw, null, 2));

    const { report } = await runToGate(ws.dir, "orders-api.json");
    assert.equal(report.passes, moved, JSON.stringify(report.applied));
    assert.equal(report.stoppedBy, "budget");
    assert.notEqual(report.passes, 8, "the shipped manifest needs eight passes; this run must have been cut short by the graph");
    assert.ok(report.open.length > 0, JSON.stringify(report.open));
  } finally {
    ws.dispose();
  }
});

test("bytes that are not JSON REFUSE, rather than auditing nothing and reporting compliance", async () => {
  const ws = workspace();
  try {
    const r = await loom(ws.dir, ["run", join(ws.dir, GRAPH), "--input", input("not-a-manifest.txt")]);
    assert.notEqual(r.code, 0, `${r.out}${r.err}`);
    const error = summary(r)["error"] as Record<string, unknown>;
    // THE CLASS AND THE CODE, not merely a non-zero exit. `validation`/`E_FUNCTION_REFUSED` says
    // the graph DECLINED; `internal`/`E_INTERNAL` is what a `JSON.parse` left to throw would have
    // worn, and the two are different claims about whose fault this is.
    assert.equal(error["class"], "validation", r.out);
    assert.equal(error["code"], "E_FUNCTION_REFUSED", r.out);
    assert.equal(error["retryable"], false, r.out);
    assert.match(String(error["message"]), /is not JSON/, r.out);
    assert.match(String(error["message"]), /abstentions print as a clean bill of health|would abstain/, r.out);
    assert.equal(existsSync(join(ws.dir, "out")), false, "a refusal writes nothing");
  } finally {
    ws.dispose();
  }
});

test("JSON that is not a service manifest REFUSES, and names the field it needed", async () => {
  const ws = workspace();
  try {
    // The trap this closes: auditing is a search for ABSENCES, and eight rules abstaining on a
    // document they cannot read print as "0 findings" — which reads as "already compliant".
    const r = await loom(ws.dir, ["run", join(ws.dir, GRAPH), "--input", input("no-image.json")]);
    assert.notEqual(r.code, 0, `${r.out}${r.err}`);
    const error = summary(r)["error"] as Record<string, unknown>;
    assert.equal(error["code"], "E_FUNCTION_REFUSED", r.out);
    assert.match(String(error["message"]), /is JSON but not a service manifest: it declares no image/, r.out);
  } finally {
    ws.dispose();
  }
});

test("a subject the gate does not name cannot answer it", async () => {
  const ws = workspace();
  try {
    const { runId, gate } = await runToGate(ws.dir, "orders-api.json");
    const r = await loom(ws.dir, ["approve", runId, gate.gateId, "--as", "u:someone-else"]);
    assert.notEqual(r.code, 0, `an unnamed approver must be refused:\n${r.out}${r.err}`);
    // The CODE, not just the exit status: a bad runId or a typo'd gateId also exits 1, as
    // `E_GATE_NOT_FOUND`, so `code !== 0` alone would keep passing with the approver check removed.
    assert.match(r.err, /E_GATE_NOT_AUTHORIZED/, r.err);
    assert.match(r.err, /does not name "u:someone-else" as an approver/, r.err);
    assert.equal(existsSync(join(ws.dir, HARDENED)), false, "and neither write has happened");
  } finally {
    ws.dispose();
  }
});

test("cancelling instead of approving stops the run and leaves the disk alone", async () => {
  const ws = workspace();
  try {
    const { runId } = await runToGate(ws.dir, "orders-api.json");
    const r = await loom(ws.dir, ["cancel", runId, "--as", "u:you", "--reason", "hardening by hand instead"]);
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.equal(summary(r)["status"], "cancelled");
    assert.equal(existsSync(join(ws.dir, HARDENED)), false);
    assert.equal(existsSync(join(ws.dir, REPORT)), false);

    const listed = await loom(ws.dir, ["gates", runId]);
    assert.deepEqual(JSON.parse(listed.out), [], "a cancelled run holds no open gate");
  } finally {
    ws.dispose();
  }
});

test("the finished run replays with zero effects re-executed", async () => {
  const ws = workspace();
  try {
    const { runId, gate } = await runToGate(ws.dir, "orders-api.json");
    const approved = await loom(ws.dir, ["approve", runId, gate.gateId, "--as", "u:you"]);
    assert.equal(approved.code, 0, `${approved.out}${approved.err}`);

    // No `--graph`: the journal records the graph's HASH and a fresh process finds it in `graphs/`.
    // `hermetic` is what says the `fs.read`, both `fs.write`s and the human's decision were served
    // from the record — and across a run of seventeen `function` tasks, that the seeded PRNG draw
    // the engine journals per task replayed in the same order.
    const replay = await loom(ws.dir, ["replay", runId]);
    assert.equal(replay.code, 0, `${replay.out}${replay.err}`);
    assert.deepEqual(JSON.parse(replay.out), { match: true, hermetic: true });

    const audited = await loom(ws.dir, ["audit", runId]);
    assert.equal(audited.code, 0, `${audited.out}${audited.err}`);
  } finally {
    ws.dispose();
  }
});

test("RESIDUE — a `done` edge narrower than the loop's exit strands the run, and says nothing about the loop", async () => {
  // NOT A FEATURE, AND PINNED SO THAT THE DAY IT IMPROVES SOMEBODY IS TOLD. F5 of
  // `docs/workflow-port-2026-09-22.md`: the stop rule lives in two places that must agree, nothing
  // checks that they do, and the price of getting it wrong is paid at RUN time as
  // `internal`/`E_OUTPUT_MISSING` — a message that names neither the loop, nor the edge, nor the
  // node that took no edge out. The graph below compiles clean: both `when`s are individually
  // valid expressions over declared channels.
  //
  // If this test starts failing because the compiler refuses the graph, or because the run-time
  // message names the loop, that is the improvement — update it, do not restore it.
  const ws = workspace();
  try {
    const path = join(ws.dir, GRAPH);
    const raw = JSON.parse(readFileSync(path, "utf8")) as { edges: { id: string; when?: string }[] };
    raw.edges.find((e) => e.id === "repair")!.when = "!settled && len(applied) < 3";
    raw.edges.find((e) => e.id === "done")!.when = "settled";
    writeFileSync(path, JSON.stringify(raw, null, 2));

    const compiled = await loom(ws.dir, ["compile", path]);
    assert.equal(compiled.code, 0, `the mismatch compiles clean, which is the finding:\n${compiled.out}${compiled.err}`);

    const r = await loom(ws.dir, ["run", path, "--input", input("orders-api.json")]);
    assert.equal(r.code, 1, `${r.out}${r.err}`);
    const s = summary(r);
    assert.equal(s["status"], "failed");
    const error = s["error"] as Record<string, unknown>;
    assert.equal(error["code"], "E_OUTPUT_MISSING", r.out);
    assert.equal(error["class"], "internal", r.out);
    assert.doesNotMatch(String(error["message"]), /loop|audit|repair|done/, "if the message learns to name the loop, this residue is closed");
  } finally {
    ws.dispose();
  }
});

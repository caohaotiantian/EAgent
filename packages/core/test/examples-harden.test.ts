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

/**
 * `bin/loom <argv> --workspace <dir>`, in-process, with the streams captured.
 *
 * **STRINGS ARE OURS, BUFFERS ARE THE TEST RUNNER'S**, and that distinction is load-bearing rather
 * than decorative. `node --test` serializes its own event stream (`test:enqueue`, `test:pass`, …) to
 * `process.stdout` as Buffers, from the same process, whenever the event loop turns. Hijacking
 * `write` unconditionally therefore swallows the runner's events for every test that flushes inside
 * the window — measured, on the first test here whose window was long enough (a quarter-megabyte
 * manifest): the outer reporter printed `tests 1` for a file holding nineteen, and the stolen event
 * stream turned up inside an assertion message as "stdout is not one JSON object".
 *
 * The CLI writes strings and only strings; the runner writes Buffers. So forward anything that is
 * not a string and capture the rest, which keeps `summary()`'s "stdout is EXACTLY one JSON object"
 * assertion honest — it still sees everything the binary wrote, and nothing it did not.
 *
 * **THE ASSUMPTION THIS RESTS ON, STATED RATHER THAN LEFT IMPLICIT** — because it is an assumption
 * about two things neither of which this file owns: that `node --test` serializes its events as
 * Buffers, and that `src/cli.ts` writes only strings. If the runner ever wrote a string event, this
 * capture would swallow it and the outer reporter would undercount again; if the CLI ever wrote a
 * Buffer, `summary()` would not see it and "stdout is exactly one JSON object" would pass over
 * something it should have caught. **The failure mode of the second is the dangerous one**, so the
 * discipline is: any test here that asserts on the ABSENCE of output must also assert on some
 * positive content, which every caller of `summary()` does by parsing it.
 *
 * The alternative — hand `main()` an injected stream instead of hijacking the global — is the right
 * fix and is not available from here: `main(argv, fetchImpl?)` takes no streams, and adding a
 * parameter is a change under `packages/core/src`, which this port is explicitly not allowed to make.
 * **Chosen deliberately, and recorded so the next person does not have to rediscover why.** If the
 * CLI ever gains a stream parameter, this helper should use it and this comment should go.
 */
async function loom(dir: string, argv: readonly string[]): Promise<Result> {
  const out: string[] = [];
  const errOut: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: unknown, ...rest: unknown[]) =>
    typeof c === "string"
      ? (out.push(c), true)
      : (realOut as (...a: unknown[]) => boolean)(c, ...rest)) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown, ...rest: unknown[]) =>
    typeof c === "string"
      ? (errOut.push(c), true)
      : (realErr as (...a: unknown[]) => boolean)(c, ...rest)) as typeof process.stderr.write;
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
  /** Carried so a cascade is compared by finding IDENTITY, not by rule name (F14's third instance). */
  readonly detail: string;
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
  /** How many findings the FIRST audit held — what `cascades` is measured against (F14 #2). */
  readonly startedWith: number;
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
    // THE CREDENTIAL'S BYTES DO NOT REACH THE APPROVER, and this assertion used to say the exact
    // opposite — "the plaintext credential is shown, because the approver has to see what left the
    // file". That was wrong twice over. The runtime's own gate projection already redacts
    // `hardened.env.DB_PASSWORD` to `[secret]` on the key NAME, so `applied[].was` was the one path
    // by which `hunter2` still reached `loom gates`, the approver, and `out/harden-report.md` — a
    // file that goes back into the repository the manifest came from. And an approver does not need
    // the bytes to judge the change; they need to recognise it. (F13.)
    assert.deepEqual(report.applied[4]!.was, { redacted: "string", chars: 7 }, JSON.stringify(report.applied[4]));
    assert.deepEqual(report.applied[4]!.now, { secretRef: "db-password" }, "`now` is NOT redacted — hiding it would hide the repair");
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
    // EXACTLY TWO, not "more than none", and that number is the defect this assertion exists for.
    // `legacy-gateway.json` carries seven inline credentials; twelve passes move all seven behind a
    // secretRef and declare five of them, leaving TWO undeclared. The auditor's first draft reported
    // only the first undeclared ref per pass, so the gate said "Still open — 1" — a person adds that
    // one secret, ships, and the deploy still fails at admission on the other. An `open.length > 0`
    // assertion passes on both the right answer and that one.
    assert.equal(report.open.length, 2, JSON.stringify(report.open));
    assert.deepEqual(
      report.open.map((f) => f.rule),
      ["secret-not-declared", "secret-not-declared"],
      JSON.stringify(report.open),
    );
    assert.equal(report.open.every((f) => f.autofixable === true), true, JSON.stringify(report.open));

    // AND THE REPORT SAYS IT IN WORDS, because the person reading it is the one who has to decide
    // whether a better-but-not-done manifest may ship. A run that exhausted its budget exits 0 and
    // parks on a gate exactly like one that converged; the only difference is this sentence.
    const approved = await loom(ws.dir, ["approve", runId, gate.gateId, "--as", "u:you"]);
    assert.equal(approved.code, 0, `${approved.out}${approved.err}`);
    const md = readFileSync(join(ws.dir, REPORT), "utf8");
    assert.match(md, /\*\*the pass budget ran out with auto-fixable findings still open\*\* — this manifest is better, not done\./);
    assert.match(md, /^## Still open — 2$/m, md);
    // Both secrets NAMED, so a person can act on the list rather than on its length.
    assert.match(md, /stripe-token/, md);
    assert.match(md, /upstream-token/, md);

    // THE COMPLETENESS CHECK, and it is the one that does not depend on knowing the number. Harden
    // the graph's OWN output: it must need exactly as many passes as there were open auto-fixable
    // findings, and then settle with nothing open. An `open` list that undercounts fails here with
    // no test having to state what the right count was.
    cpSync(join(ws.dir, HARDENED), join(ws.dir, "manifests", "legacy-round-two.json"));
    const again = await runToGate(ws.dir, "legacy-round-two.json");
    assert.equal(again.report.passes, report.open.length, JSON.stringify(again.report.applied));
    assert.equal(again.report.stoppedBy, "settled");
    assert.deepEqual([...again.report.open], []);
  } finally {
    ws.dispose();
  }
});

test("a cascade is MEASURED against the first audit, not read off the rule table", async () => {
  // THE DEFECT A FRESH REVIEWER FOUND, and the shape of it is why it is worth a test of its own:
  // `cascadeOf` on a finding is a STATIC property of the rule ("this cannot fire until that is
  // repaired"), and the report's headline sentence — "closed a finding that DID NOT EXIST when the
  // run started" — is a claim about THIS RUN. Counting the former and printing the latter is false
  // on any manifest whose FIRST audit already reports a cascade-rule finding.
  //
  // The graph's own output is such a manifest, which is what makes this reachable rather than
  // theoretical: a budget stop on `legacy-gateway.json` leaves `secret-not-declared` — a rule that
  // declares `cascadeOf: "plaintext-secret"` — open, so re-hardening that file fixes two findings
  // that were both in the first audit. The old code reported "2 of those 2 fix(es) closed a finding
  // that DID NOT EXIST when the run started".
  const ws = workspace();
  try {
    const first = await runToGate(ws.dir, "legacy-gateway.json");
    const approved = await loom(ws.dir, ["approve", first.runId, first.gate.gateId, "--as", "u:you"]);
    assert.equal(approved.code, 0, `${approved.out}${approved.err}`);
    cpSync(join(ws.dir, HARDENED), join(ws.dir, "manifests", "budget-stopped.json"));

    const second = await runToGate(ws.dir, "budget-stopped.json");
    // Every fix here closes a finding the FIRST audit already held, so none of them is a cascade …
    assert.equal(second.report.passes, 2, JSON.stringify(second.report.applied));
    assert.equal(second.report.startedWith, 2, JSON.stringify(second.report));
    assert.equal(second.report.cascades, 0, JSON.stringify(second.report.applied));
    // … even though both entries carry a static `cascadeOf`, which is exactly what made the old
    // count wrong. The annotation stays; only the COUNT is measured.
    assert.equal(second.report.applied.every((a) => a.cascadeOf === "plaintext-secret"), true, JSON.stringify(second.report.applied));

    const secondApproved = await loom(ws.dir, ["approve", second.runId, second.gate.gateId, "--as", "u:you"]);
    assert.equal(secondApproved.code, 0, `${secondApproved.out}${secondApproved.err}`);
    const md = readFileSync(join(ws.dir, REPORT), "utf8");
    assert.doesNotMatch(md, /DID NOT EXIST/, `the cascade sentence must not appear when nothing cascaded:\n${md}`);

    // And the claim still fires where it is TRUE, so this test cannot be satisfied by deleting it.
    const control = await runToGate(ws.dir, "orders-api.json");
    assert.equal(control.report.startedWith, 5, JSON.stringify(control.report));
    assert.equal(control.report.cascades, 3, JSON.stringify(control.report.applied));
  } finally {
    ws.dispose();
  }
});

test("RESIDUE — maxIterations is a THIRD home for the bound, and lowering it to the budget strands the run", async () => {
  // **THIS TEST IS F11**, and its comment used to cite F5 twice and F11 never. F5 says the stop rule
  // has two homes; **F11 is that it has three** — `repair`'s `when`, `done`'s `when`, and the `recheck`
  // edge's `maxIterations`, which the ENGINE enforces independently of either expression. The shipped
  // graph escapes only because 16 > 12. "Tidying" it to match the budget compiles at exit 0 and then
  // strands any manifest that actually needs the budget.
  //
  // It lands on the SAME symptom F5 names — `internal`/`E_OUTPUT_MISSING`, naming neither the loop nor
  // the bound that stopped the run — which is why the two were easy to conflate. They are different
  // findings: F5 is two expressions that must agree and nothing checking it, F11 is two bounds in two
  // LAYERS with an ordering nothing checks.
  //
  // In file order this is the FIRST of the two `RESIDUE` tests and F5's is the second, which is the
  // opposite of what F11's prose said.
  //
  // Pinned so that the day the compiler refuses this, or the message names the bound, somebody is
  // told. If it starts failing for that reason, that is the improvement — update it.
  const ws = workspace();
  try {
    const path = join(ws.dir, GRAPH);
    const raw = JSON.parse(readFileSync(path, "utf8")) as { edges: { id: string; maxIterations?: number }[] };
    const recheck = raw.edges.find((e) => e.id === "recheck")!;
    assert.equal(recheck.maxIterations, 16, "the shipped backstop moved; update this test");
    recheck.maxIterations = 12; // "the same as the budget", which is the plausible tidy-up
    writeFileSync(path, JSON.stringify(raw, null, 2));

    const compiled = await loom(ws.dir, ["compile", path]);
    assert.equal(compiled.code, 0, `the mismatch compiles clean, which is the finding:\n${compiled.out}${compiled.err}`);

    // `orders-api` needs 8 passes and is unaffected — which is why this is easy to ship.
    const ok = await loom(ws.dir, ["run", path, "--input", input("orders-api.json")]);
    assert.equal(ok.code, 0, `${ok.out}${ok.err}`);
    assert.equal(summary(ok)["status"], "awaiting_gate");

    // `legacy-gateway` needs all twelve, and the engine bound now cuts the last back-edge.
    const r = await loom(ws.dir, ["run", path, "--input", input("legacy-gateway.json")]);
    assert.equal(r.code, 1, `${r.out}${r.err}`);
    const error = summary(r)["error"] as Record<string, unknown>;
    assert.equal(error["code"], "E_OUTPUT_MISSING", r.out);
    assert.equal(error["class"], "internal", r.out);
    assert.doesNotMatch(
      String(error["message"]),
      /\bmaxIterations\b|\brecheck\b|\bloop\b/,
      "if the message learns to name the bound that stopped the run, this residue is closed",
    );
  } finally {
    ws.dispose();
  }
});

test("the budget is whatever the GRAPH says — move it and the run stops with the new number", async () => {
  // THE DRIFT TEST, behavioural on purpose, and the same shape as the first port's `maxWidth` one.
  // `len(applied) >= 12` is written on the `repair` edge's `when` and on the `done` edge's `when`,
  // and a body cannot read either (`ctx.node.out` carries `maxIterations`, not `until` or `when` —
  // F6 of the port doc). So the only way to know the bodies do not carry their own copy is to move
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
    // from the record — and across a run of nineteen `function` tasks, that the seeded PRNG draw
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
    // Word-bounded on purpose: a bare /done/ matches "abandoned", so an improved message using that
    // word would fail this test for a reason that has nothing to do with the residue it pins.
    assert.doesNotMatch(
      String(error["message"]),
      /\bloop\b|\baudit\b|\brepair\b|\bdone\b/,
      "if the message learns to name the loop, the edge, or the node that took no edge, this residue is closed — update this test rather than restoring it",
    );
  } finally {
    ws.dispose();
  }
});

test("a credential whose value is not a string is REPORTED, not silently skipped", async () => {
  // THE WORST THING THIS WORKFLOW COULD DO, and the rule's first draft did it: it read
  // `if (typeof env[key] !== "string") continue;`, so `"DB_PASSWORD": 90210` and
  // `"API_TOKEN": ["sk-live-1"]` produced ZERO findings and a report saying the manifest "already
  // satisfied every rule this tool can repair". A credential scanner that stays quiet because
  // somebody wrote the value unquoted is worse than no scanner: it converts "nobody looked" into
  // "somebody looked and it is fine".
  //
  // The key NAME is the whole evidence this rule has and it does not get weaker with the value's
  // type. What changes is whether a repair exists — `secretRef` substitutes for a string — so a
  // non-string is reported `autofixable: false` with a remedy naming what a person must do.
  const ws = workspace();
  try {
    const { report } = await runToGate(ws.dir, "unquoted-credentials.json");
    assert.equal(report.passes, 0, "nothing here is auto-fixable, so the loop never runs a pass");
    assert.equal(report.stoppedBy, "settled");
    assert.equal(report.open.length, 2, JSON.stringify(report.open));
    assert.deepEqual(
      report.open.map((f) => f.at).sort(),
      ["env.API_TOKEN", "env.DB_PASSWORD"],
      JSON.stringify(report.open),
    );
    assert.equal(report.open.every((f) => f.rule === "plaintext-secret"), true, JSON.stringify(report.open));
    assert.equal(report.open.every((f) => f.autofixable === false), true, JSON.stringify(report.open));
    assert.match(report.open.find((f) => f.at === "env.DB_PASSWORD")!.remedy, /the value is a number/);
    assert.match(report.open.find((f) => f.at === "env.API_TOKEN")!.remedy, /the value is an array of 1/);
    // AND THE VALUE'S BYTES ARE NOT IN THE FINDING — only its shape. A finding about a credential
    // that quotes the credential has moved the leak rather than closed it (F13).
    const asText = JSON.stringify(report.open);
    assert.doesNotMatch(asText, /90210/, asText);
    assert.doesNotMatch(asText, /sk-live-1/, asText);
  } finally {
    ws.dispose();
  }
});

test("a cascade is identified by the FINDING, not by the rule name", async () => {
  // THE THIRD INSTANCE of the class F14 names, and it survived the fix for the second one. Keying
  // `startedWith` on the rule NAME hides a cascade whenever that rule is already in the baseline for
  // a DIFFERENT subject. `mixed-secrets.json` is the smallest manifest that shows it: one plaintext
  // `A_PASSWORD`, and a `B_TOKEN` that already holds an undeclared secretRef. So the first audit
  // holds `plaintext-secret` (A) and `secret-not-declared` (B) — and the `secret-not-declared` that
  // pass 1 CREATES, about `a-password`, has a rule name that was already there.
  //
  //   before: passes 3, cascades 0   ← the run's whole point, suppressed
  //   after:  passes 3, cascades 1   ← pass 2 only; pass 3 closes the one that started open
  //
  // `secret-not-declared` reports `at: "secrets"` for every secret there is, so `rule` and `at`
  // together are still not enough — `detail`, which names the env key and the ref, is what tells two
  // of them apart, and the applied entry carries it for exactly this comparison.
  const ws = workspace();
  try {
    const { report } = await runToGate(ws.dir, "mixed-secrets.json");
    assert.equal(report.passes, 3, JSON.stringify(report.applied));
    assert.equal(report.startedWith, 2, JSON.stringify(report));
    assert.equal(report.cascades, 1, JSON.stringify(report.applied));

    assert.deepEqual(
      report.applied.map((a) => `${String(a.pass)}:${a.rule}`),
      ["1:plaintext-secret", "2:secret-not-declared", "3:secret-not-declared"],
      JSON.stringify(report.applied),
    );
    // The two `secret-not-declared` entries share a rule AND an `at`, and differ only in `detail` —
    // which is the whole reason identity needs all three.
    assert.equal(report.applied[1]!.at, report.applied[2]!.at, "both land on `secrets`");
    assert.notEqual(report.applied[1]!.detail, report.applied[2]!.detail, "…and only `detail` separates them");
    assert.match(report.applied[1]!.detail, /A_PASSWORD/);
    assert.match(report.applied[2]!.detail, /B_TOKEN/);
  } finally {
    ws.dispose();
  }
});

test("two manifests that used to reach the unreachable refusal now report instead", async () => {
  // The doc and `examples/README.md` §9 both claim `harden-fix.js`'s no-change refusal is the one
  // you should never reach. Two ORDINARY manifests reached it, and both arrived wearing a message
  // that blamed "the rule's detector and its repair" — a sentence that was false in both cases.
  // Either the claim goes or the manifests do; these are the fixes that keep the claim.
  const ws = workspace();
  try {
    // (a) `release: "latest"`. The auditor accepted a FLOATING release as a pin target, so the
    // repair rewrote `svc:latest` to `svc:latest` and the byte-identical result tripped the
    // no-change guard. The detector was right; it had handed the repair something that is not a pin.
    const floating = await runToGate(ws.dir, "floating-release.json");
    assert.equal(floating.report.passes, 0, JSON.stringify(floating.report.applied));
    assert.equal(floating.report.open.length, 1, JSON.stringify(floating.report.open));
    assert.equal(floating.report.open[0]!.rule, "floating-image-tag");
    assert.equal(floating.report.open[0]!.autofixable, false);
    assert.match(floating.report.open[0]!.remedy, /"release" is itself "latest", which is a moving target/);

    // (b) an env key containing a dot. Every `at` is a PATH that the fixer assigns to and the
    // auditor folds back, both splitting on ".", so `env.APP.DB_PASSWORD` addressed a nested object
    // that does not exist: the repair wrote a spurious `env.APP.DB_PASSWORD` and left the real key
    // untouched. The path language cannot name the key, so the honest answer is to say so.
    const dotted = await runToGate(ws.dir, "dotted-env-key.json");
    assert.equal(dotted.report.passes, 0, JSON.stringify(dotted.report.applied));
    assert.equal(dotted.report.open.length, 1, JSON.stringify(dotted.report.open));
    assert.equal(dotted.report.open[0]!.at, "env.APP.DB_PASSWORD");
    assert.equal(dotted.report.open[0]!.autofixable, false);
    assert.match(dotted.report.open[0]!.remedy, /contains a "\.", which this tool's path language reads as object nesting/);
    // The real key is untouched and no phantom nesting was invented.
    const env = dotted.report.hardened["env"] as Record<string, unknown>;
    assert.deepEqual(Object.keys(env), ["APP.DB_PASSWORD"], JSON.stringify(env));
  } finally {
    ws.dispose();
  }
});

test("a manifest read back TRUNCATED refuses, instead of being reported as invalid JSON", async () => {
  // `fs.read` caps its output — 200,000 BYTES unless the node says otherwise — and it used to append
  // its marker INSIDE the content. So a large manifest arrived as valid JSON plus
  // `…[truncated N chars]`, and `harden-parse.js` blamed a "Bad control character at position
  // 200000": a report of a SYNTAX error on a file whose syntax is fine. Auditing the part that fits
  // reports the absences of the part that is missing as compliance, which is this workflow's whole
  // defect class. (F12.)
  //
  // Two halves, and the second is the one that survives somebody's manifest being bigger than
  // whatever number is in the graph: the shipped `load` node now passes an explicit `maxBytes`, AND
  // the parse body reads `load`'s reserved projection — `{ok: true, truncated, bytes}` — and says
  // what actually happened. The marker is gone from the content (§A.83), so the FACT is the only
  // thing the body can go on; a body still looking for the marker would see a bare prefix.
  const ws = workspace();
  try {
    // A COMPLIANT manifest, padded past the cap. Compliant on purpose: this test is about the READ,
    // and a dirty one would spend eight passes folding a quarter-megabyte object nine times for no
    // extra assurance — slow enough that `loom()`'s stdout capture starts racing the test runner's
    // own reporter, which is a flaw in the harness rather than a finding about the product.
    const big: Record<string, unknown> = {
      name: "huge",
      stage: "prod",
      release: "9.9.9",
      image: "registry.internal/huge:9.9.9",
      pullPolicy: "IfNotPresent",
      user: "app",
      workdir: "/srv/app",
      ports: [8080],
      healthcheck: { httpGet: { path: "/healthz", port: 8080 } },
      env: { LOG_LEVEL: "info" },
      secrets: [],
    };
    const notes: Record<string, string> = {};
    for (let i = 0; i < 6000; i += 1) notes[`note-${String(i).padStart(5, "0")}`] = "x".repeat(40);
    big["annotations"] = notes;
    const huge = JSON.stringify(big, null, 2);
    assert.ok(huge.length > 200_000, `the fixture must exceed the default cap, got ${String(huge.length)}`);
    writeFileSync(join(ws.dir, "manifests", "huge.json"), huge);

    // With the shipped graph's explicit maxBytes, it simply works — asserted THROUGH THE DISK rather
    // than through `loom gates`, because a quarter-megabyte report exceeds the gate listing's own
    // 64 KiB cap and comes back as `{"$truncated":…}` with the channel named in `readsTruncated`
    // (documented in `examples/README.md` §8; `--max-bytes` is the dial). That is the door working as
    // designed and is a different door from the one this test is about.
    const started = await loom(ws.dir, ["run", join(ws.dir, GRAPH), "--input", input("huge.json")]);
    assert.equal(started.code, 0, `${started.out}${started.err}`);
    const s = summary(started);
    assert.equal(s["status"], "awaiting_gate", started.out);
    const gates = JSON.parse((await loom(ws.dir, ["gates", String(s["runId"])])).out) as Gate[];
    const approved = await loom(ws.dir, ["approve", String(s["runId"]), gates[0]!.gateId, "--as", "u:you"]);
    assert.equal(approved.code, 0, `${approved.out}${approved.err}`);
    const round = JSON.parse(readFileSync(join(ws.dir, HARDENED), "utf8")) as Record<string, unknown>;
    assert.equal(round["name"], "huge", "the whole manifest went through, annotations and all");
    assert.equal(Object.keys(round["annotations"] as Record<string, unknown>).length, 6000);
    assert.match(readFileSync(join(ws.dir, REPORT), "utf8"), /Nothing, and nothing is open: this manifest satisfies all eight rules\./);

    // Drop `maxBytes` — the pre-fix graph — and the default cap truncates. The refusal must name
    // TRUNCATION, not JSON.
    const path = join(ws.dir, GRAPH);
    const raw = JSON.parse(readFileSync(path, "utf8")) as { nodes: { id: string; tool?: { args: Record<string, unknown> } }[] };
    const load = raw.nodes.find((n) => n.id === "load")!;
    assert.equal(load.tool!.args["maxBytes"], 4_000_000, "the shipped cap moved; update this test");
    delete load.tool!.args["maxBytes"];
    writeFileSync(path, JSON.stringify(raw, null, 2));

    const r = await loom(ws.dir, ["run", path, "--input", input("huge.json")]);
    assert.equal(r.code, 1, `${r.out}${r.err}`);
    const error = summary(r)["error"] as Record<string, unknown>;
    assert.equal(error["code"], "E_FUNCTION_REFUSED", r.out);
    assert.equal(error["class"], "validation", r.out);
    assert.match(String(error["message"]), /was read back TRUNCATED/, r.out);
    assert.match(String(error["message"]), new RegExp(`the file is ${String(Buffer.byteLength(huge))} bytes`), r.out);
    assert.match(String(error["message"]), /the rest were dropped/, r.out);
    // The old, false diagnosis must be gone.
    assert.doesNotMatch(String(error["message"]), /is not JSON/, r.out);

    // AND THE CASE THAT DOES NOT BREAK, which is the dangerous one (§A.83): a manifest whose cut
    // PREFIX STILL PARSES. Here the manifest is small and followed by a quarter-megabyte of
    // whitespace, so the default cap drops only whitespace and the prefix is valid JSON — nothing in
    // the CONTENT says anything is missing. Only the projection does, and the body must refuse on it.
    writeFileSync(join(ws.dir, "manifests", "padded.json"), `${JSON.stringify({ ...big, annotations: {} }, null, 2)}${" ".repeat(250_000)}`);
    const padded = await loom(ws.dir, ["run", path, "--input", input("padded.json")]);
    assert.equal(padded.code, 1, `${padded.out}${padded.err}`);
    const perr = summary(padded)["error"] as Record<string, unknown>;
    assert.equal(perr["code"], "E_FUNCTION_REFUSED", padded.out);
    assert.match(String(perr["message"]), /was read back TRUNCATED/, padded.out);
  } finally {
    ws.dispose();
  }
});

test("a control character in a manifest cannot reach the report — every field is escaped, not just the table", async () => {
  // THE ESCAPING HAD A HOLE THAT ROUND ONE'S OWN FIX OPENED. `cell()` was applied to the `applied`
  // table only; then the auditor learned to mark a dotted env key NON-autofixable (F14 #3b), which
  // means a hostile key can no longer reach the table at all — it lands in `## Still open`, and in
  // nothing else. So the one path a hostile key takes was the one path with no escaping on it.
  //
  // Measured on `bin/loom`, with an env key of `A\u0000B.PASSWORD` and a service name holding `\u0007`:
  //
  //   before   NUL bytes: 3 | BEL bytes: 1   and `file out/harden-report.md` says "data"
  //   after    NUL bytes: 0 | BEL bytes: 0
  //
  // Three NULs in a markdown file is not cosmetic: `grep` treats the file as binary and prints
  // "Binary file … matches" instead of the line, which is how a reader is told there is nothing to
  // see. That is the harm `cell()`'s own docstring claims it prevents.
  //
  // AND `cell()` HAD NO TEST. Mutating its body to `return String(v);` left the whole suite green,
  // which is the only reason the hole survived a round. This test is that mutation's tripwire.
  const ws = workspace();
  try {
    const hostile = JSON.parse(readFileSync(join(ws.dir, "manifests", "orders-api.json"), "utf8")) as Record<string, unknown>;
    hostile["name"] = "bell\u0007name";
    hostile["env"] = { "A\u0000B.PASSWORD": "x", LOG_LEVEL: "debug" };
    writeFileSync(join(ws.dir, "manifests", "hostile.json"), JSON.stringify(hostile, null, 2));

    const { runId, gate, report } = await runToGate(ws.dir, "hostile.json");
    // The dotted key is reported and NOT repaired, so it reaches the `open` list — the unescaped path.
    assert.equal(report.open.some((f) => f.at === "env.A\u0000B.PASSWORD"), true, JSON.stringify(report.open));

    const approved = await loom(ws.dir, ["approve", runId, gate.gateId, "--as", "u:you"]);
    assert.equal(approved.code, 0, `${approved.out}${approved.err}`);
    const md = readFileSync(join(ws.dir, REPORT), "utf8");

    // NOT ONE control character anywhere in the file — the assertion that does not depend on knowing
    // which field carried it.
    assert.doesNotMatch(md, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/, "a control character reached the report");
    assert.equal(md.includes("\u0000"), false, "a NUL reached the report");
    // …and the escaped forms ARE there, so the test cannot be satisfied by dropping the fields.
    assert.match(md, /env\.A\\x00B\.PASSWORD/, md.slice(0, 400));
    assert.match(md, /# Config hardening — bell\\x07name/, md.slice(0, 200));
    // The title and the path are interpolated outside the table, which is where the hole was.
    assert.match(md, /`manifests\/hostile\.json`/, md.slice(0, 400));
  } finally {
    ws.dispose();
  }
});

test("a report with nothing applied does not claim the rules are satisfied", async () => {
  // F14 #6 — the FOURTH instance of the class, inside the sentence written to replace the third.
  // With nothing auto-fixable, `## Applied, in order` said "Nothing. The manifest already satisfied
  // every rule this tool can repair." — printed two paragraphs above "Still open — 2 …
  // plaintext-secret", which is a rule this tool repairs seven times on `legacy-gateway.json`. The
  // run established that nothing here was auto-fixable; "satisfied" is the opposite of what `open`
  // says.
  const ws = workspace();
  try {
    const { runId, gate, report } = await runToGate(ws.dir, "unquoted-credentials.json");
    assert.equal(report.passes, 0);
    assert.equal(report.open.length, 2);

    const approved = await loom(ws.dir, ["approve", runId, gate.gateId, "--as", "u:you"]);
    assert.equal(approved.code, 0, `${approved.out}${approved.err}`);
    const md = readFileSync(join(ws.dir, REPORT), "utf8");

    assert.doesNotMatch(md, /already satisfied every rule/, md);
    assert.match(md, /No finding here is auto-fixable — see \*\*Still open\*\* below, which is 2 finding\(s\)/, md);
    assert.match(md, /^## Still open — 2$/m, md);
    // The headline paragraph must not read as compliance either.
    assert.match(md, /the audit then found nothing further it can REPAIR, and 2 finding\(s\) remain open/, md);

    // AND THE CLAIM STILL FIRES WHERE IT IS TRUE, so this cannot be satisfied by deleting it: a
    // genuinely compliant manifest says so, and says it about all eight rules.
    const clean = JSON.parse(readFileSync(join(ws.dir, "manifests", "payments-worker.json"), "utf8")) as Record<string, unknown>;
    clean["env"] = { LOG_LEVEL: "info" };
    clean["healthcheck"] = { exec: ["/bin/true"] };
    writeFileSync(join(ws.dir, "manifests", "clean.json"), JSON.stringify(clean, null, 2));
    const ok = await runToGate(ws.dir, "clean.json");
    assert.equal(ok.report.passes, 0);
    assert.deepEqual([...ok.report.open], [], JSON.stringify(ok.report.open));
    const okApproved = await loom(ws.dir, ["approve", ok.runId, ok.gate.gateId, "--as", "u:you"]);
    assert.equal(okApproved.code, 0, `${okApproved.out}${okApproved.err}`);
    assert.match(readFileSync(join(ws.dir, REPORT), "utf8"), /Nothing, and nothing is open: this manifest satisfies all eight rules\./);
  } finally {
    ws.dispose();
  }
});

test("`fs.read` refuses FOUR ways, and a JSON array is the one the count kept missing", async () => {
  // The doc and `examples/README.md` §9 both said `harden-parse.js` refuses three ways. It refuses
  // four, and the fourth is the one an ordinary mistake produces: a JSON document that parses but is
  // not an object. `[1,2,3]` reproduces it, and so does a file somebody wrapped in an array by
  // accident — a shape `JSON.parse` accepts and every rule in the table would abstain on.
  const ws = workspace();
  try {
    writeFileSync(join(ws.dir, "manifests", "an-array.json"), "[1,2,3]\n");
    const r = await loom(ws.dir, ["run", join(ws.dir, GRAPH), "--input", input("an-array.json")]);
    assert.equal(r.code, 1, `${r.out}${r.err}`);
    const error = summary(r)["error"] as Record<string, unknown>;
    assert.equal(error["class"], "validation", r.out);
    assert.equal(error["code"], "E_FUNCTION_REFUSED", r.out);
    assert.match(String(error["message"]), /parsed as an array, not a JSON object/, r.out);
  } finally {
    ws.dispose();
  }
});

test("a credential the RUNTIME's redactor does not recognise still never reaches the approver", async () => {
  // THE WORST DEFECT THIS PORT SHIPPED, and it survived three review rounds because every manifest
  // anybody had written happened to put an underscore before the credential word.
  //
  // The gate projection redacts by key NAME, and its predicate is NARROWER than this workflow's:
  //
  //   runtime   /^(?:.*_)?(?:password|passwd|secret|token|api[_-]?key|authorization|credential)s?$/i
  //             plus a qualified-word rule where `token` counts only beside `api`, `access`,
  //             `bearer`, `auth`, … and `github`/`slack`/`registry`/`ci` are NOT qualifiers
  //   auditor   /(PASSWORD|SECRET|TOKEN)$/
  //
  // So `GITHUB.TOKEN` (a dot, not an underscore; `github` not a qualifier) and `MYTOKEN` (no
  // separator at all) are credentials to the auditor and ordinary names to the runtime. Measured
  // before the fix — the gate said one thing and printed the other, three fields apart:
  //
  //   open[0].detail   "GITHUB.TOKEN" holds a credential in the clear, in a file that is in …
  //   hardened.env     {"GITHUB.TOKEN": "correcthorsebattery", "LOG_LEVEL": "info"}
  //
  // The lesson generalises past this workflow: **a workflow that applies its own credential
  // predicate must redact its own projection**, because delegating to the platform's means shipping
  // wherever the two disagree. `harden-collate.js` now does, off the auditor's own `credentialKey`.
  //
  // THE GREP IS OVER THE WHOLE OF `loom gates` STDOUT, not over one field. The reason is this
  // defect: a per-field assertion looks exactly as green when the bytes are in a field the test did
  // not name, and the previous version of this suite only ever grepped `report.open`.
  const ws = workspace();
  try {
    for (const [manifest, secret, key] of [
      ["qualified-token.json", "correcthorsebattery", "GITHUB.TOKEN"],
      ["unseparated-token.json", "987654321", "MYTOKEN"],
    ] as const) {
      const { runId, gate, report } = await runToGate(ws.dir, manifest);

      // The auditor DID flag it — otherwise this test would pass by the credential never being seen.
      assert.equal(
        report.open.some((f) => f.rule === "plaintext-secret" && f.at === `env.${key}`),
        true,
        `${manifest}: the auditor must report ${key} as a credential — ${JSON.stringify(report.open)}`,
      );

      // …and the whole listing, every field of it, is free of the bytes.
      const listed = await loom(ws.dir, ["gates", runId]);
      assert.equal(listed.code, 0, `${listed.out}${listed.err}`);
      assert.equal(
        listed.out.includes(secret),
        false,
        `${manifest}: the credential reached the gate listing`,
      );
      // The value is present as a SHAPE, so the test cannot be satisfied by dropping the field.
      const env = (report.hardened["env"] ?? {}) as Record<string, unknown>;
      assert.equal(
        typeof (env[key] as { redacted?: unknown } | undefined)?.redacted,
        "string",
        `${manifest}: ${key} must be shown as a shape — ${JSON.stringify(env)}`,
      );

      const approved = await loom(ws.dir, ["approve", runId, gate.gateId, "--as", "u:you"]);
      assert.equal(approved.code, 0, `${approved.out}${approved.err}`);

      // THE REPORT A PERSON READS carries nothing.
      assert.equal(readFileSync(join(ws.dir, REPORT), "utf8").includes(secret), false, `${manifest}: report.md`);

      // THE HARDENED MANIFEST DOES, and that is deliberate rather than an oversight: it IS the
      // manifest, the tool could not move this value behind a secretRef, and dropping it would hand
      // back a file whose service has lost its configuration. Asserted POSITIVELY so the intent is
      // recorded and a future change that silently starts redacting the file fails here.
      assert.equal(
        readFileSync(join(ws.dir, HARDENED), "utf8").includes(secret),
        true,
        `${manifest}: the hardened manifest must keep the value it could not repair`,
      );
    }
  } finally {
    ws.dispose();
  }
});

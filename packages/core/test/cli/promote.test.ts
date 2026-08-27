/**
 * THE PROMOTION GATE HAD NO DOOR.
 *
 * `gateCandidate`, `runEvalSuite` and `requirePromotable` had zero callers outside
 * `src/evolution/` and `test/` — the same standing `scoreTrajectory` had before `loom score`
 * existed, and `cli.ts`'s own `score` comment names what that costs: arithmetic that is
 * "correct, tested, and reachable from nothing a person can run". Measured at c9321df:
 *
 *     node packages/core/src/cli.ts promote candidates/bench-v2.json \
 *       --baseline graphs/bench.json --suite suite.json --workspace <ws>
 *     E_CONFIG_INVALID: unknown flags: --baseline, --suite. …
 *     exit=1
 *
 * (the unknown-FLAG guard fires before the unknown-VERB branch; with no flags it is
 * `unknown command "promote"`, exit 2.)
 *
 * WHAT THIS FILE HOLDS DOWN. Driving `main()` rather than the library, because a verb nobody
 * has driven through the door is the same class of thing as a mechanism nobody has used.
 *
 * 1. A winning candidate prints eleven checks, exits 0, and the decision is IN THE JOURNAL —
 *    readable after the process that computed it is gone.
 * 2. The four `PromotionInput` fields the CLI measures rather than accepts really are measured:
 *    a posture-lowering candidate is refused by `6-oversight-diff` even though it passes every
 *    case, and a candidate whose prompt grew is reported by `5-prompt-size` with real bytes.
 * 3. The losing direction exits 1, and the refusal is journaled too — a decision not to
 *    promote is a decision.
 * 4. A suite frozen AFTER the candidate was proposed is refused by `9-suite-predates-candidate`,
 *    which is the rule that makes an AI-authored suite safe and is only reachable when a
 *    proposer is named.
 * 5. The shapes that would make a promotion vacuous are refused at the door: an empty case
 *    list (both sides score 0, and Δ 0.0pp reads as non-inferior) and two identical graphs.
 *
 * Offline and deterministic: no model, no network, no `sleep`. Every graph is `function` +
 * `evaluator{assertion}` nodes, so there is nothing for a provider to answer.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, openWorkspace, parseArgs } from "../../src/cli.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import type { EvalSuite } from "../../src/evolution/gate.ts";
import { isEvent, type JournalEvent } from "../../src/journal/events.ts";
import type { RunId } from "../../src/ids.ts";

const PICK = `(view) => {
  const items = view.get("items") || [];
  return { writes: { picked: items.slice(0, -1) } };
}`;
const PICK_V2 = `(view) => {
  const items = view.get("items") || [];
  return { writes: { picked: items.slice() } };
}`;
const CHECK = `(view) => {
  const items = view.get("items") || [];
  const picked = view.get("picked") || [];
  return { writes: { verdict: { pass: picked.length === items.length, confidence: 1, detail: picked.length + "/" + items.length } } };
}`;

/** The bench graph, parameterised by which `pick` body it names and its `check` posture. */
function graphJson(pickRef: string, checkPosture?: string): string {
  return JSON.stringify({
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "pick-bench", project: "demo", version: 1 },
    policy: { posture: "out" },
    channels: {
      items: { type: "array", reduce: "replace" },
      picked: { type: "array", reduce: "replace" },
      verdict: { type: "object", reduce: "replace" },
    },
    inputs: ["items"],
    outputs: ["verdict"],
    nodes: [
      { id: "pick", type: "function", reads: ["items"], writes: ["picked"], function: { ref: pickRef } },
      {
        id: "check",
        type: "evaluator",
        reads: ["items", "picked"],
        writes: ["verdict"],
        ...(checkPosture === undefined ? {} : { policy: { posture: checkPosture } }),
        evaluator: { kind: "assertion", ref: "function/check@stable", threshold: 0.5 },
      },
    ],
    edges: [{ id: "e", from: "pick", to: "check", kind: "seq" }],
  });
}

function workspace(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-promote-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  mkdirSync(join(dir, "candidates"), { recursive: true });
  mkdirSync(join(dir, "resources", "function"), { recursive: true });
  writeFileSync(join(dir, "resources", "function", "pick.js"), PICK);
  writeFileSync(join(dir, "resources", "function", "pick-v2.js"), PICK_V2);
  writeFileSync(join(dir, "resources", "function", "check.js"), CHECK);
  // The baseline is PUBLISHED and the candidate is not. `loom score` reads `graphs/` as the
  // promoted set, so a candidate parked there would be marked promoted before it was gated.
  writeFileSync(join(dir, "graphs", "bench.json"), graphJson("function/pick@stable"));
  writeFileSync(join(dir, "candidates", "bench-v2.json"), graphJson("function/pick-v2@stable"));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
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

/** N recorded runs of the published baseline, over N different inputs. */
async function record(dir: string, n: number): Promise<RunId[]> {
  const ids: RunId[] = [];
  for (let i = 1; i <= n; i++) {
    const r = await cli(["run", join(dir, "graphs", "bench.json"), "--workspace", dir, "--input", JSON.stringify({ items: [`a${String(i)}`, `b${String(i)}`, `c${String(i)}`] })]);
    assert.equal(r.code, 0, r.err);
    const { runId, status } = JSON.parse(r.out) as { runId: string; status: string };
    assert.equal(status, "succeeded", r.out);
    ids.push(runId as RunId);
  }
  return ids;
}

/**
 * Freeze a suite over those recordings. THE EXPECTATIONS COME FROM THE PLANTED GROUND TRUTH —
 * three items in, three kept — never from what the baseline produced. The baseline drops one
 * on purpose, so a suite written from its output would be one the baseline passes by
 * construction and no candidate could ever show a positive delta.
 */
function freeze(dir: string, ids: readonly RunId[], frozenAt = 1_000): string {
  const suite: EvalSuite = {
    name: "pick-bench",
    version: 1,
    frozen: true,
    frozenAt,
    generatedBy: "maintainer",
    cases: ids.map((runId, i) => ({
      id: `c${String(i)}`,
      runId,
      mustPass: i === 0,
      expect: { status: "succeeded" as const, channels: { picked: [`a${String(i + 1)}`, `b${String(i + 1)}`, `c${String(i + 1)}`] } },
    })),
    composition: { minCases: 3, minMustPass: 1 },
  };
  const file = join(dir, `suite-${String(frozenAt)}.json`);
  writeFileSync(file, JSON.stringify(suite));
  return file;
}

async function promotionRows(dir: string, runId: RunId): Promise<{ kind: string; args: Record<string, unknown> }[]> {
  const ws = openWorkspace(parseArgs(["gates", "--workspace", dir]));
  try {
    const rows: { kind: string; args: Record<string, unknown> }[] = [];
    for await (const e of ws.store.read(runId, 1) as AsyncIterable<JournalEvent>) {
      if (isEvent(e, "operator.command")) rows.push({ kind: e.payload.kind, args: e.payload.args as Record<string, unknown> });
    }
    return rows;
  } finally {
    ws.close();
  }
}

test("loom promote: a winning candidate passes eleven checks, exits 0, and the decision is journaled", async () => {
  const w = workspace();
  try {
    const ids = await record(w.dir, 6);
    const suite = freeze(w.dir, ids);

    const r = await cli([
      "promote",
      join(w.dir, "candidates", "bench-v2.json"),
      "--baseline",
      join(w.dir, "graphs", "bench.json"),
      "--suite",
      suite,
      "--workspace",
      w.dir,
    ]);
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);

    const decision = JSON.parse(r.out.slice(r.out.indexOf("{"))) as {
      promote: boolean;
      checks: { id: string; pass: boolean; detail: string }[];
      baseline: { passRate: number };
      candidate: { passRate: number };
      cohorts: { key: string; cases: number }[];
      caseRunIds: string[];
    };
    assert.equal(decision.promote, true);
    assert.equal(decision.checks.length, 12, "every promotion check is reported, not just the failing ones");
    assert.equal(decision.checks.every((c) => c.pass), true, JSON.stringify(decision.checks.filter((c) => !c.pass)));
    // The improvement is REAL and strictly positive. `gateCandidate` is a non-inferiority test
    // and passes at Δ 0, so `promote === true` on its own does not mean anything was measured.
    assert.equal(decision.baseline.passRate, 0);
    assert.equal(decision.candidate.passRate, 1);
    assert.match(decision.checks.find((c) => c.id === "2-non-inferior")!.detail, /Δ 100\.0pp/);

    // "Promoted over them" is a fact on the page: one cohort, and every case in it.
    assert.equal(decision.cohorts.length, 1);
    assert.equal(decision.cohorts[0]!.cases, 6);
    assert.deepEqual(decision.caseRunIds, ids);

    // AND IT OUTLIVES THE PROCESS. The row rides on `operator.command`, which is what
    // happened — a person ran a command — so no kernel event type was minted for it.
    const rows = await promotionRows(w.dir, ids[0]!);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "evolution.promote");
    assert.equal(rows[0]!.args["promote"], true);
    assert.equal((rows[0]!.args["caseRunIds"] as string[]).length, 6);
  } finally {
    w.dispose();
  }
});

test("loom promote: the CLI MEASURES postureDiffNonNegative rather than accepting it", async () => {
  // A gate whose inputs the caller asserts is not a gate. This candidate passes every case —
  // it is the winning `pick-v2` body — and lowers `check`'s posture from the graph's `out` to
  // nothing a human sees. `6-oversight-diff` is the only check that can refuse it.
  const w = workspace();
  try {
    const ids = await record(w.dir, 4);
    const suite = freeze(w.dir, ids);
    writeFileSync(join(w.dir, "graphs", "bench.json"), graphJson("function/pick@stable", "in"));
    writeFileSync(join(w.dir, "candidates", "bench-v2.json"), graphJson("function/pick-v2@stable", "out"));

    const r = await cli([
      "promote",
      join(w.dir, "candidates", "bench-v2.json"),
      "--baseline",
      join(w.dir, "graphs", "bench.json"),
      "--suite",
      suite,
      "--workspace",
      w.dir,
    ]);
    assert.equal(r.code, 1, `${r.out}\n${r.err}`);
    const decision = JSON.parse(r.out.slice(r.out.indexOf("{"))) as { promote: boolean; checks: { id: string; pass: boolean }[] };
    assert.equal(decision.promote, false);
    assert.equal(decision.checks.find((c) => c.id === "6-oversight-diff")!.pass, false);
    // …and it is the ONLY thing wrong with it, which is what makes this a test of that check.
    assert.deepEqual(decision.checks.filter((c) => !c.pass).map((c) => c.id), ["6-oversight-diff"]);
  } finally {
    w.dispose();
  }
});

test("loom promote: the losing direction exits 1, and the refusal is journaled too", async () => {
  const w = workspace();
  try {
    const ids = await record(w.dir, 4);
    const suite = freeze(w.dir, ids);

    // Roles swapped: the published graph is the loser and `pick-v2` is the incumbent.
    const r = await cli([
      "promote",
      join(w.dir, "graphs", "bench.json"),
      "--baseline",
      join(w.dir, "candidates", "bench-v2.json"),
      "--suite",
      suite,
      "--workspace",
      w.dir,
    ]);
    assert.equal(r.code, 1);
    assert.match(r.out, /✗ 1-must-pass/);
    assert.match(r.out, /✗ 2-non-inferior/);
    assert.match(r.out, /· case c0 failed — channel "picked" differs/, "the report says WHICH case and why");

    const rows = await promotionRows(w.dir, ids[0]!);
    assert.equal(rows[0]!.args["promote"], false, "a decision not to promote is a decision");
  } finally {
    w.dispose();
  }
});

test("loom promote: a suite frozen AFTER the candidate was proposed is refused", async () => {
  // The rule that makes an AI-authored suite safe, and it is a timestamp comparison rather
  // than an unfalsifiable question about honesty. It only fires when a proposer is named:
  // naming one makes the gate stricter, never looser.
  const w = workspace();
  try {
    const ids = await record(w.dir, 4);
    const later = freeze(w.dir, ids, 99_999_999_999_999);

    const r = await cli([
      "promote",
      join(w.dir, "candidates", "bench-v2.json"),
      "--baseline",
      join(w.dir, "graphs", "bench.json"),
      "--suite",
      later,
      "--proposed-by",
      "optimiser",
      "--workspace",
      w.dir,
    ]);
    assert.equal(r.code, 1);
    assert.match(r.out, /✗ 9-suite-predates-candidate/);
    assert.match(r.out, /an exam written for a known student proves nothing/);
    // Every other check passed, so this really is the one that refused it.
    const decision = JSON.parse(r.out.slice(r.out.indexOf("{"))) as { checks: { id: string; pass: boolean }[] };
    assert.deepEqual(decision.checks.filter((c) => !c.pass).map((c) => c.id), ["9-suite-predates-candidate"]);
  } finally {
    w.dispose();
  }
});

test("loom promote: the two shapes that would make a promotion vacuous are refused at the door", async () => {
  const w = workspace();
  try {
    const ids = await record(w.dir, 3);
    const suite = freeze(w.dir, ids);

    // A suite of zero cases gives BOTH sides `passRate: 0`, which `2-non-inferior` scores as
    // Δ 0.0pp and passes — a promotion granted for measuring nothing.
    const empty = join(w.dir, "empty.json");
    writeFileSync(empty, JSON.stringify({ name: "empty", version: 1, frozen: true, frozenAt: 1_000, cases: [] }));
    await assert.rejects(
      () => cli(["promote", join(w.dir, "candidates", "bench-v2.json"), "--baseline", join(w.dir, "graphs", "bench.json"), "--suite", empty, "--workspace", w.dir]),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && e.message.includes('"cases" must be a non-empty array'),
    );

    // Two identical graphs: "non-inferior" would be true and useless.
    await assert.rejects(
      () => cli(["promote", join(w.dir, "graphs", "bench.json"), "--baseline", join(w.dir, "graphs", "bench.json"), "--suite", suite, "--workspace", w.dir]),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && e.message.includes("the same graph"),
    );

    // A suite that is not frozen is not an exam.
    const loose = join(w.dir, "loose.json");
    writeFileSync(loose, readFileSync(suite, "utf8").replace('"frozen":true', '"frozen":false'));
    await assert.rejects(
      () => cli(["promote", join(w.dir, "candidates", "bench-v2.json"), "--baseline", join(w.dir, "graphs", "bench.json"), "--suite", loose, "--workspace", w.dir]),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && e.message.includes('"frozen" must be true'),
    );

    // Nothing was journaled by any of the three: a refused command judged nothing.
    assert.deepEqual(await promotionRows(w.dir, ids[0]!), []);
  } finally {
    w.dispose();
  }
});

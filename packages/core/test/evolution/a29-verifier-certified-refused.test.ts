/**
 * §A.29 / DESIGN item 24, REPRODUCED: a frozen golden case pins the whole work channel verbatim, so
 * a candidate the graph's OWN verifier certifies is refused by `1-must-pass` and reported as a
 * 33.3pp regression.
 *
 * WHY THIS FILE EXISTS. Item 24 said the behaviour "is NOT currently reproduced by a command", and
 * §A.29's only repro was a grep the row itself disowns. Producing one was the item's own first task.
 * This is it, driven end to end through the shipped verbs on a real SQLite workspace — `loom run`
 * ×30, `loom exam attest`, `loom score` ×30, `loom suite freeze`, `loom promote --suite` — so the
 * refusal below is `freezeSuite` + `runEvalSuite` + `gateCandidate` deciding, not a mock of them.
 *
 * THE MECHANISM, as the code has it. `freezeSuite` (`cli.ts`) gives every GOLDEN case
 * `expect.channels` = every recorded channel the grader did not write and the graph did not take as
 * input — here `picked`, the work itself — and `runCase` (`evolution/gate.ts`) compares each by
 * `sameContent`. So the pin is BYTE-level on the canonical form: any candidate that produces a
 * different-but-correct `picked` fails every golden case, and golden cases are exactly the
 * `mustPass` ones. The freeze's own docstring names this as the price of pinning ("a candidate that
 * fixes one fails a must-pass case"); what it does not say is that the price is charged to a
 * candidate the graph's own verifier certifies on EVERY case.
 *
 * THE WORKFLOW. `pick` should keep every item; its verifier `check` asserts that `picked` is the
 * same MULTISET as `items` — order is not part of the contract, and the verifier says so. The
 * baseline is wrong on even-length inputs (it drops the last item), which is what gives the corpus
 * both halves: the 10 odd-length runs of 30 are golden, the 20 even-length runs are not (freeze
 * refuses an all-golden or all-non-golden selection). The candidate keeps every item and emits them
 * newest-first. Its own verifier passes it on 30 of 30 replayed cases — where the baseline's passes
 * 10 of 30 — and `promote --suite` refuses it:
 *
 *     ✗ 1-must-pass   must-pass failures: <the 10 golden cases>
 *     ✗ 2-non-inferior pass rate 66.7% vs baseline 100.0% (Δ -33.3pp)
 *
 * The 33.3pp is 10/30: the golden share of the cohort, charged in full, because the non-golden
 * cases pin nothing (so the candidate's fix there earns nothing) and the golden ones pin order.
 *
 * THIS TEST IS GREEN AND THE BEHAVIOUR IT PINS IS WRONG, which is deliberate: §G.5's shape
 * (`test/run/graph-binding.test.ts`), because the fix is not in reach of a test file. CLOSING IT is
 * item 24's second half and is a DECISION first (handoff 2026-09-23 §7, Q6): either a fold that can
 * answer "what did channel C hold when task T read it" (keyed on `task.leased` seq), so the pin can
 * be replaced by a statement about what the grader saw — or property 3's claim re-scoped to what the
 * exam establishes, with `CLAUDE.md` §3's five assumptions rewritten to match. WHEN THAT LANDS THIS
 * TEST GOES RED: `promote` flips to true, or the failing set loses `1-must-pass`, or the Δ moves.
 * Swap the expectations then and delete these paragraphs. The CONTROL at the bottom — a candidate
 * that genuinely drops items is refused — must stay green through that change.
 *
 * WHAT IS NOT CLAIMED. That the operator's attested exam also certifies the candidate is true of the
 * exam body below by reading (it is order-insensitive too) and was NOT driven: judging a candidate
 * against the exam is `promote --against-cohort`, a live door this file does not open.
 *
 * Offline and deterministic: `function` and `evaluator{assertion}` nodes only, no model adapter, no
 * clock ratio. Every number asserted is a count.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, openWorkspace, parseArgs } from "../../src/cli.ts";
import { compile } from "../../src/graph/compile.ts";
import { runEvalSuite, type EvalSuite } from "../../src/evolution/gate.ts";
import type { ToolRegistry } from "../../src/run/registry.ts";

// ---------------------------------------------------------------------------
// the workspace
// ---------------------------------------------------------------------------

const spec = (ref: string): unknown => ({
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "keep-bench", project: "demo", version: 1 },
  policy: { posture: "out", capabilities: [] },
  channels: {
    items: { type: "array", reduce: "replace" },
    picked: { type: "array", reduce: "replace" },
    verdict: { type: "object", reduce: "replace" },
  },
  inputs: ["items"],
  outputs: ["picked", "verdict"],
  nodes: [
    { id: "pick", type: "function", reads: ["items"], writes: ["picked"], function: { ref } },
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

/** Same multiset: order is not part of the contract. Shared by the graph's verifier and the exam. */
const SAME_MULTISET = `const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());`;

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

interface Corpus {
  readonly dir: string;
  readonly ids: readonly string[];
  readonly suiteFile: string;
}

let built: Promise<Corpus> | undefined;
let builtDir: string | undefined;
test.after(() => {
  if (builtDir !== undefined) rmSync(builtDir, { recursive: true, force: true });
});

/** Thirty recorded, attested, scored runs and one suite frozen from them by `loom suite freeze`. */
const corpus = (): Promise<Corpus> =>
  (built ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-a29-"));
    builtDir = dir;
    mkdirSync(join(dir, "graphs"), { recursive: true });
    mkdirSync(join(dir, "exams"), { recursive: true });
    mkdirSync(join(dir, "resources", "function"), { recursive: true });
    const fn = (name: string, body: string): void => writeFileSync(join(dir, "resources", "function", `${name}.js`), body);

    // THE BASELINE: right on odd lengths, drops the last item on even ones.
    fn("pick", `(view) => { const items = view.get("items") ?? []; return { writes: { picked: items.length % 2 === 0 ? items.slice(0, -1) : items.slice() } }; }`);
    // THE CANDIDATE UNDER TEST: keeps every item, newest first.
    fn("pick-rev", `(view) => ({ writes: { picked: (view.get("items") ?? []).slice().reverse() } })`);
    // THE CONTROL: keeps every item but the first — genuinely wrong, and wrong on the goldens.
    fn("pick-drop", `(view) => ({ writes: { picked: (view.get("items") ?? []).slice(1) } })`);
    // THE GRAPH'S OWN VERIFIER.
    fn(
      "check",
      `(view) => { ${SAME_MULTISET}
        const items = view.get("items") ?? []; const picked = view.get("picked") ?? [];
        const ok = same(items, picked);
        return { writes: { verdict: { pass: ok, confidence: 1, detail: ok ? "every item kept" : "items lost" } } }; }`,
    );
    // THE OPERATOR'S EXAM — outside every candidate graph; `suite freeze` refuses a workflow with none.
    fn(
      "exam-keep",
      `(view) => { ${SAME_MULTISET}
        const ok = same(view.get("items") ?? [], view.get("picked") ?? []);
        return { writes: { verdict: { pass: ok, score: ok ? 1 : 0, confidence: 1, detail: ok ? "kept" : "dropped" } } }; }`,
    );
    writeFileSync(
      join(dir, "exams", "keep-exam.json"),
      JSON.stringify({
        apiVersion: "loom.dev/v1",
        kind: "GraphSpec",
        metadata: { name: "keep-exam", project: "demo", version: 1 },
        policy: { posture: "out", capabilities: [] },
        channels: {
          subject: { type: "string", reduce: "replace" },
          items: { type: "array", reduce: "replace" },
          picked: { type: "array", reduce: "replace" },
          verdict: { type: "object", reduce: "replace" },
        },
        inputs: ["subject", "items", "picked"],
        outputs: ["verdict"],
        nodes: [
          { id: "grade", type: "evaluator", reads: ["items", "picked"], writes: ["verdict"], evaluator: { kind: "assertion", ref: "function/exam-keep@stable", threshold: 0 } },
        ],
        edges: [],
      }),
    );
    writeFileSync(join(dir, "graphs", "keep.json"), JSON.stringify(spec("function/pick@stable")));
    // Candidates are NOT in graphs/: that directory is the promoted set.
    writeFileSync(join(dir, "reversed.json"), JSON.stringify(spec("function/pick-rev@stable")));
    writeFileSync(join(dir, "dropper.json"), JSON.stringify(spec("function/pick-drop@stable")));

    const ids: string[] = [];
    for (let n = 1; n <= 30; n++) {
      // Lengths 2..4, distinct strings: n % 3 === 1 gives length 3, the ten odd-length runs.
      const items = Array.from({ length: 2 + (n % 3) }, (_, i) => `doc-${String(n)}-${String(i)}`);
      const r = await cli(["run", join(dir, "graphs", "keep.json"), "--workspace", dir, "--input", JSON.stringify({ items })]);
      assert.equal(r.code, 0, r.err);
      const p = JSON.parse(r.out) as { runId: string; status: string };
      assert.equal(p.status, "succeeded");
      ids.push(p.runId);
    }
    const attested = await cli(["exam", "attest", join(dir, "exams", "keep-exam.json"), "--cohort", ids[0]!, "--as", "u:operator", "--workspace", dir]);
    assert.equal(attested.code, 0, attested.err);
    for (const id of ids) assert.equal((await cli(["score", id, "--workspace", dir])).code, 0);

    const suiteFile = join(dir, "frozen.json");
    const frozen = await cli(["suite", "freeze", "--cohort", ids[0]!, "--workspace", dir, "--out", suiteFile]);
    assert.equal(frozen.code, 0, frozen.err);
    return { dir, ids, suiteFile };
  })());

interface Decision {
  readonly promote: boolean;
  readonly baseline: { readonly passRate: number; readonly passed: number; readonly total: number };
  readonly candidate: { readonly passRate: number; readonly passed: number; readonly total: number };
  readonly checks: readonly { readonly id: string; readonly pass: boolean; readonly detail: string }[];
}

async function promote(c: Corpus, graph: string): Promise<{ code: number; out: string; decision: Decision }> {
  const r = await cli([
    "promote", join(c.dir, graph),
    "--baseline", join(c.dir, "graphs", "keep.json"),
    "--suite", c.suiteFile,
    "--proposed-by", "an-optimiser",
    "--workspace", c.dir,
  ]);
  return { code: r.code, out: r.out, decision: JSON.parse(r.out.slice(r.out.indexOf("\n{") + 1)) as Decision };
}

/** The graph's own verifier, as the replay of each frozen case against `graph` recorded it. */
async function verifierVerdicts(c: Corpus, graph: string): Promise<{ id: string; mustPass: boolean; pass: unknown; caseReasons: readonly string[] }[]> {
  const ws = openWorkspace(parseArgs(["gates", "--workspace", c.dir]));
  try {
    const compiled = compile({
      spec: JSON.parse(readFileSync(join(c.dir, graph), "utf8")) as never,
      resolver: ws.resolver,
      tools: (ws.engine.tools as ToolRegistry).manifests(),
      tenantCapabilities: ws.granted,
    });
    assert.ok(compiled.ok, `${graph} compiles`);
    const suite = JSON.parse(readFileSync(c.suiteFile, "utf8")) as EvalSuite;
    // The engine options `loom promote --suite` hands `runEvalSuite`, field for field.
    const report = await runEvalSuite({
      store: ws.store,
      suite,
      graph: compiled.graph,
      engine: { tools: ws.engine.tools, functions: ws.engine.functions, models: ws.engine.models, hooks: ws.hooks, policy: { granted: ws.granted } },
    });
    return report.cases.map((k) => ({
      id: k.id,
      mustPass: k.mustPass,
      pass: (k.replay?.replayed.channels["verdict"] as { pass?: unknown } | undefined)?.pass,
      caseReasons: k.reasons,
    }));
  } finally {
    ws.close();
  }
}

// ---------------------------------------------------------------------------
// the pin
// ---------------------------------------------------------------------------

test("§A.29 · A CANDIDATE ITS OWN VERIFIER CERTIFIES ON EVERY CASE IS REFUSED BY 1-must-pass AS A 33.3pp REGRESSION", async () => {
  const c = await corpus();
  const suite = JSON.parse(readFileSync(c.suiteFile, "utf8")) as EvalSuite;

  // THE EXAM AS FROZEN: every judged run is a case, the ten odd-length ones golden, and each
  // golden case pins the work channel — `picked`, verbatim — and nothing else.
  assert.equal(suite.cases.length, 30);
  const golden = suite.cases.filter((k) => k.mustPass);
  assert.equal(golden.length, 10, "the ten runs the baseline got right are the goldens");
  for (const k of golden) assert.deepEqual(Object.keys(k.expect.channels ?? {}), ["picked"], k.id);
  for (const k of suite.cases.filter((x) => !x.mustPass)) assert.equal(k.expect.channels, undefined, k.id);

  // THE GRAPH'S OWN VERIFIER CERTIFIES THE CANDIDATE ON ALL THIRTY CASES — and the baseline on ten.
  const cand = await verifierVerdicts(c, "reversed.json");
  assert.equal(cand.length, 30);
  assert.deepEqual(cand.filter((k) => k.pass !== true).map((k) => k.id), [], "check wrote verdict.pass === true on every replayed case");
  const base = await verifierVerdicts(c, join("graphs", "keep.json"));
  assert.equal(base.filter((k) => k.pass === true).length, 10, "the baseline's own verifier passes it on the ten goldens only");

  // …AND THE ONLY THING THE CANDIDATE FAILED IS THE VERBATIM PIN.
  const failed = cand.filter((k) => k.caseReasons.length > 0);
  assert.deepEqual(failed.map((k) => k.id).sort(), golden.map((k) => k.id).sort(), "exactly the golden cases fail");
  for (const k of failed) assert.deepEqual(k.caseReasons, ['channel "picked" differs'], k.id);

  // THE DECISION, through the shipped door.
  const r = await promote(c, "reversed.json");
  assert.equal(r.code, 1);
  assert.equal(r.decision.promote, false);
  assert.deepEqual(
    r.decision.checks.filter((x) => !x.pass).map((x) => x.id).sort(),
    ["1-must-pass", "2-non-inferior"],
    "refused on the must-pass floor and the pass rate — and on nothing else",
  );
  assert.deepEqual([r.decision.baseline.passed, r.decision.baseline.total], [30, 30]);
  assert.deepEqual([r.decision.candidate.passed, r.decision.candidate.total], [20, 30]);
  const ni = r.decision.checks.find((x) => x.id === "2-non-inferior")!;
  assert.equal(ni.detail, "pass rate 66.7% vs baseline 100.0% (Δ -33.3pp)", "REPORTED AS A 33.3pp REGRESSION");
  const mp = r.decision.checks.find((x) => x.id === "1-must-pass")!;
  for (const k of golden) assert.ok(mp.detail.includes(k.id), `${k.id} named as a must-pass failure`);
  // The grader is untouched, so this is not the rigged-grader refusal wearing another name.
  assert.equal(r.decision.checks.find((x) => x.id === "12-grader-unchanged")!.pass, true);
  assert.match(r.out, /case \S+ failed — channel "picked" differs/);
});

test("CONTROL · a candidate that really drops items is refused on the same two checks, and its own verifier says so", async () => {
  const c = await corpus();
  const verdicts = await verifierVerdicts(c, "dropper.json");
  assert.equal(verdicts.filter((k) => k.pass === true).length, 0, "check fails the dropper on every case");

  const r = await promote(c, "dropper.json");
  assert.equal(r.decision.promote, false);
  assert.deepEqual(r.decision.checks.filter((x) => !x.pass).map((x) => x.id).sort(), ["1-must-pass", "2-non-inferior"]);
  // THE SAME NUMBER. The frozen suite cannot tell the dropper from the reversed candidate: both are
  // 20/30 and Δ -33.3pp, one certified by the graph's verifier on 30 cases and one on 0.
  assert.deepEqual([r.decision.candidate.passed, r.decision.candidate.total], [20, 30]);
  assert.equal(r.decision.checks.find((x) => x.id === "2-non-inferior")!.detail, "pass rate 66.7% vs baseline 100.0% (Δ -33.3pp)");
});

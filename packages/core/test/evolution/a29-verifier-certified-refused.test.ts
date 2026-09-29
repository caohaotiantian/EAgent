/**
 * §A.29 / DESIGN item 24, CLOSED: a candidate the graph's OWN verifier certifies on every case is
 * PROMOTED, and a candidate that really drops items is still refused at Δ -33.3pp.
 *
 * WHY THIS FILE EXISTS. It was the item's first task: a GREEN-IS-WRONG pin (`0558c2a5`) in which a
 * frozen golden case pinned the whole work channel byte for byte, so the candidate below — certified
 * 30/30 by its own `check` — was refused `1-must-pass` + `2-non-inferior` at "66.7% vs baseline
 * 100.0% (Δ -33.3pp)", and the CONTROL that genuinely drops items got the IDENTICAL verdict. The gate
 * could not tell them apart. The expectations are now swapped, as the pin asked.
 *
 * WHAT CHANGED, as the code has it. `loom suite freeze` writes the cohort graph's graders — with the
 * identity `12-grader-unchanged` compares — onto every golden case that pins a channel
 * (`EvalCase.expect.graders`). `runCase` (`evolution/gate.ts`) still compares each pinned channel by
 * `sameContent`, and a channel that DIFFERS passes only when `certification` holds: the named grader
 * is unchanged, ran as one Task on the root branch whose own commit says `pass: true`, and
 * `run/served.ts` — the kernel fold of the replay's shadow journal through that Task's lease — says it
 * was SERVED the value the run ended with and the RECORDED inputs. Not the final value alone, and never
 * static ancestry: the four games that defeated the reverted waiver (`aabdc63`) are re-driven in
 * `a29-served-certificate.test.ts` and refused there.
 *
 * Driven end to end through the shipped verbs on a real SQLite workspace — `loom run` ×30, `loom exam
 * attest`, `loom score` ×30, `loom suite freeze`, `loom promote --suite` — so the promotion below is
 * `freezeSuite` + `runEvalSuite` + `gateCandidate` deciding, not a mock of them.
 *
 * THE WORKFLOW. `pick` should keep every item; its verifier `check` asserts that `picked` is the same
 * MULTISET as `items` — order is not part of the contract, and the verifier says so. The baseline is
 * wrong on even-length inputs (it drops the last item), which gives the corpus both halves: the 10
 * odd-length runs of 30 are golden, the 20 even-length runs are not. The candidate keeps every item
 * and emits them newest-first; its own verifier passes it on 30 of 30 replayed cases, where the
 * baseline's passes 10 of 30.
 *
 * WHAT THIS DOES NOT CLAIM. That the frozen suite now shows the candidate BETTER: the non-golden cases
 * still pin nothing, so the candidate ties the baseline at 30/30 and promotes on non-inferiority. The
 * claim that it is better is `promote --against-cohort`'s, live, and is not driven here. And the
 * certificate is exactly as strong as `check`: a verifier that asserted only a length would certify
 * any value of that length — its strength is the operator's, who froze it.
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
async function verifierVerdicts(
  c: Corpus,
  graph: string,
): Promise<{ id: string; mustPass: boolean; pass: unknown; caseReasons: readonly string[]; certified: readonly { channel: string; grader: string }[] }[]> {
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
      certified: (k.certified ?? []).map((x) => ({ channel: x.channel, grader: x.grader })),
    }));
  } finally {
    ws.close();
  }
}

// ---------------------------------------------------------------------------
// the pin
// ---------------------------------------------------------------------------

test("§A.29 · A CANDIDATE ITS OWN VERIFIER CERTIFIES ON EVERY CASE IS PROMOTED — the golden pin is waived on the frozen grader's word", async () => {
  const c = await corpus();
  const suite = JSON.parse(readFileSync(c.suiteFile, "utf8")) as EvalSuite;

  // THE EXAM AS FROZEN: every judged run is a case, the ten odd-length ones golden, and each golden
  // case pins the work channel — `picked`, verbatim — and names the grader that may excuse it, with
  // the identity the freeze resolved. The non-golden cases pin nothing and name no grader.
  assert.equal(suite.cases.length, 30);
  const golden = suite.cases.filter((k) => k.mustPass);
  assert.equal(golden.length, 10, "the ten runs the baseline got right are the goldens");
  for (const k of golden) {
    assert.deepEqual(Object.keys(k.expect.channels ?? {}), ["picked"], k.id);
    assert.deepEqual(Object.keys(k.expect.graders ?? {}), ["node:check"], k.id);
    const g = k.expect.graders!["node:check"]!;
    assert.deepEqual([g.kind, g.ref, g.reads, g.threshold], ["assertion", "function/check@stable", ["items", "picked"], 0.5], k.id);
    assert.match(String(g.digest), /^sha256:[0-9a-f]{64}$/, `${k.id}: the grader's body is bound by digest`);
  }
  for (const k of suite.cases.filter((x) => !x.mustPass)) {
    assert.equal(k.expect.channels, undefined, k.id);
    assert.equal(k.expect.graders, undefined, k.id);
  }

  // THE GRAPH'S OWN VERIFIER CERTIFIES THE CANDIDATE ON ALL THIRTY CASES — and the baseline on ten.
  const cand = await verifierVerdicts(c, "reversed.json");
  assert.equal(cand.length, 30);
  assert.deepEqual(cand.filter((k) => k.pass !== true).map((k) => k.id), [], "check wrote verdict.pass === true on every replayed case");
  const base = await verifierVerdicts(c, join("graphs", "keep.json"));
  assert.equal(base.length, 30);
  assert.deepEqual(
    base.filter((k) => k.pass === true).map((k) => k.id).sort(),
    golden.map((k) => k.id).sort(),
    "the baseline's own verifier passes it on the ten goldens only",
  );
  assert.deepEqual(
    base.filter((k) => !k.mustPass).map((k) => k.pass),
    Array.from({ length: 20 }, () => false),
    "…and FAILS it, verdict.pass === false, on the other twenty",
  );

  // …AND NO CASE FAILS: every golden's `picked` still DIFFERS from the recording, and each is
  // certified by `check` — named, so a pass that rests on a grader's word is visible as one.
  assert.deepEqual(cand.filter((k) => k.caseReasons.length > 0).map((k) => [k.id, k.caseReasons]), [], "no case fails");
  assert.deepEqual(
    cand.filter((k) => k.certified.length > 0).map((k) => k.id).sort(),
    golden.map((k) => k.id).sort(),
    "exactly the goldens were certified rather than byte-matched",
  );
  for (const k of cand.filter((x) => x.mustPass)) assert.deepEqual(k.certified, [{ channel: "picked", grader: "node:check" }], k.id);
  // The baseline byte-matches its own goldens and needs no certificate.
  assert.deepEqual(base.filter((k) => k.certified.length > 0).map((k) => k.id), []);

  // THE DECISION, through the shipped door.
  const r = await promote(c, "reversed.json");
  assert.equal(r.code, 0, r.out);
  assert.equal(r.decision.promote, true);
  assert.deepEqual(r.decision.checks.filter((x) => !x.pass).map((x) => x.id), [], "no check fails");
  assert.deepEqual([r.decision.baseline.passed, r.decision.baseline.total], [30, 30]);
  assert.deepEqual([r.decision.candidate.passed, r.decision.candidate.total], [30, 30]);
  assert.equal(
    r.decision.checks.find((x) => x.id === "2-non-inferior")!.detail,
    "pass rate 100.0% vs baseline 100.0% (Δ 0.0pp)",
    "a tie, not an improvement — the frozen suite pins nothing on the non-goldens",
  );
  // The grader is untouched, which is also what the certificate required.
  assert.equal(r.decision.checks.find((x) => x.id === "12-grader-unchanged")!.pass, true);
  assert.doesNotMatch(r.out, /case \S+ failed/);
});

test("CONTROL · a candidate that really drops items is still refused at Δ -33.3pp, and the reason says the frozen grader did not pass it", async () => {
  const c = await corpus();
  const verdicts = await verifierVerdicts(c, "dropper.json");
  assert.equal(verdicts.length, 30);
  assert.deepEqual(
    verdicts.map((k) => k.pass),
    Array.from({ length: 30 }, () => false),
    "check fails the dropper — verdict.pass === false — on every case",
  );
  const golden = verdicts.filter((k) => k.mustPass);
  assert.equal(golden.length, 10);
  for (const k of golden) {
    assert.deepEqual(k.caseReasons, ['channel "picked" differs, and no frozen grader certifies it — node:check did not pass it'], k.id);
    assert.deepEqual(k.certified, [], k.id);
  }

  const r = await promote(c, "dropper.json");
  assert.equal(r.code, 1);
  assert.equal(r.decision.promote, false);
  assert.deepEqual(r.decision.checks.filter((x) => !x.pass).map((x) => x.id).sort(), ["1-must-pass", "2-non-inferior"]);
  // THE SAME NUMBER AS BEFORE THE CHANGE — the refusal that was right stays exactly as it was, and
  // the reversed candidate above no longer shares it.
  assert.deepEqual([r.decision.candidate.passed, r.decision.candidate.total], [20, 30]);
  assert.equal(r.decision.checks.find((x) => x.id === "2-non-inferior")!.detail, "pass rate 66.7% vs baseline 100.0% (Δ -33.3pp)");
});

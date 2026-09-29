/**
 * §A.29's certificate, attacked: every game that defeated the REVERTED waiver (`aabdc63`), and every
 * condition of `certification` (`evolution/gate.ts`), each driven through `runEvalSuite` +
 * `gateCandidate` over real recordings.
 *
 * WHAT NEWLY PASSES, stated as the set so the tests below can be read against it: a golden case
 * whose pinned channel C DIFFERS from the recording, when every grader the freeze named that reads C
 * is unchanged (identity AND site), ran as one realm-loaded Task at iteration 0 on the root branch with no gate, hook or
 * earlier mutation touching it, committed its own verdict(s) all `pass === true` and none below
 * threshold, and was served — per the kernel fold of the replay's shadow journal — the value of C
 * the run ENDED with and the RECORDED value of every other channel it reads. Nothing else changed:
 * an absent C, a case frozen without `graders`, and every other expectation are exactly as before.
 *
 * THE FOUR GAMES, as the revert's commit body names them — every one produces garbage (or nothing)
 * and every one has the grader say `pass: true`, which each test asserts so the refusal is of a
 * real game and not of a candidate the grader already rejected:
 *   A   rewrite what FED the grader, restore it after grading;
 *   A'  the same, with the graded channel never written at all;
 *   C   fake static ancestry through an untaken `conditional`, plus a `loop` back-edge, and a
 *       spoiler that runs AFTER the grader;
 *   G   the restore trick against the topology the reverted pin RECOMMENDED — grader reads one
 *       produced channel, the ground truth is a declared graph input.
 *
 * Offline and deterministic: `function` / `evaluator{assertion}` bodies published as resources and loaded through the realm (one host closure, in F1, on purpose), one
 * mock model in the mutation test, no clock ratio.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { RunId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { memoryPayloads } from "../../src/journal/payloads.ts";
import { Engine } from "../../src/run/engine.ts";
import { HookRegistry } from "../../src/run/hooks.ts";
import { foldRun, type RunProjection } from "../../src/run/projection.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { evaluatorIdentities, graderSite } from "../../src/run/served.ts";
import { gateCandidate, runEvalSuite, type EvalCase, type EvalReport, type EvalSuite } from "../../src/evolution/gate.ts";
import { resolver } from "../run/skeleton.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";
import { ResourceStore } from "../../src/resources/store.ts";
import { createFunctionLoader } from "../../src/resources/functions.ts";

const NOW = 1_700_000_000_000;
// ── the bodies ───────────────────────────────────────────────────────────────

/**
 * Every body PUBLISHED as a resource and loaded through the realm (`createFunctionLoader`), the way
 * `loom` loads `resources/function/*.js` — so the digest a grader's identity carries is the digest
 * of the body that runs, and `ReplayReport.liveBodies` is empty. A body registered by hand is host
 * code the runtime cannot vouch for; the F1 test below registers one on purpose.
 */
const PRE = `const items = (v) => v.get("items") ?? []; const same = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());`;
const body = (expr: string): string => `(v, ctx) => { ${PRE} ${expr} }`;
const BODIES: Record<string, string> = {
  // the work
  pick: body(`return { writes: { picked: items(v).slice() } };`),
  "pick-rev": body(`return { writes: { picked: items(v).slice().reverse() } };`),
  "pick-drop": body(`return { writes: { picked: items(v).slice(1) } };`),
  "pick-empty": body(`return { writes: { picked: [] } };`),
  "pick-count": body(`return { writes: { picked: items(v).slice(1), rounds: (v.get("rounds") ?? 0) + 1 } };`),
  // the graders
  check: body(`return { writes: { verdict: { pass: same(v.get("items"), v.get("picked")), confidence: 1 } } };`),
  subset: body(`return { writes: { verdict: { pass: (v.get("picked") ?? []).every((x) => items(v).includes(x)), confidence: 1 } } };`),
  // A grader that spot-checks ONE item, chosen by its seed — so what it checks depends on `ctx`.
  spot: body(`const it = items(v); const i = Number(ctx.seed ?? 0) % Math.max(1, it.length); const got = v.get("picked") ?? [];
    return { writes: { verdict: { pass: got.includes(it[i]) && got.every((x) => it.includes(x)), confidence: 1 } } };`),
  "check-rigged": body(`return { writes: { verdict: { pass: true, confidence: 1 } } };`),
  order: body(`return { writes: { order: { pass: JSON.stringify(v.get("picked") ?? []) === JSON.stringify(items(v)), confidence: 1 } } };`),
  "check-scored": body(`const ok = same(v.get("items"), v.get("picked")); return { writes: { verdict: { pass: ok, score: ok ? 0.3 : 0 } } };`),
  // A pass on one channel and a FAIL on another, the fail large enough to leave the journal.
  "check-split": body(`return { writes: { verdict: { pass: true, confidence: 1 }, note: { pass: false, blob: "z".repeat(70000) } } };`),
  "check-nopass": body(`return { writes: { verdict: { ok: same(v.get("items"), v.get("picked")) } } };`),
  "check-truth": body(`return { writes: { verdict: { pass: same(v.get("truth"), v.get("answer")), confidence: 1 } } };`),
  "check-fixture": body(`return { writes: { verdict: { pass: same(v.get("expected"), v.get("picked")), confidence: 1 } } };`),
  // the games
  "stash-a": body(`return { writes: { stash: items(v), items: ["GARBAGE"], picked: ["GARBAGE"] } };`),
  "stash-a-prime": body(`return { writes: { stash: items(v), items: [] } };`),
  restore: body(`return { writes: { items: v.get("stash") ?? [] } };`),
  spoil: body(`return { writes: { picked: ["GARBAGE"] } };`),
  tock: body(`return { writes: { t: 1 } };`),
  answer: body(`return { writes: { answer: items(v).slice() } };`),
  "answer-rev": body(`return { writes: { answer: items(v).slice().reverse() } };`),
  "stash-g": body(`return { writes: { stash: v.get("truth") ?? [], truth: ["GARBAGE"], answer: ["GARBAGE"] } };`),
  "restore-g": body(`return { writes: { truth: v.get("stash") ?? [] } };`),
  fixture: body(`return { writes: { expected: items(v).slice() } };`),
  "fixture-g": body(`return { writes: { expected: ["GARBAGE"] } };`),
  report: body(`return { writes: { rounds: (v.get("rounds") ?? 0) + 1 } };`),
  after: body(`return { writes: { t: 2 } };`),
};

function published(): { resources: ResourceStore; functions: FunctionRegistry } {
  const resources = new ResourceStore({ now: () => 1 });
  const actor = { kind: "human", id: "u:test" } as const;
  for (const [name, content] of Object.entries(BODIES)) {
    const ref = resources.publish({ kind: "function", name, content, actor });
    resources.promote(ref, "canary", actor);
    resources.promote(ref, "stable", actor);
  }
  const functions = new FunctionRegistry();
  const loader = createFunctionLoader({ store: resources });
  for (const version of resources.list({ kind: "function" })) {
    const ref = `function/${version.name}@stable`;
    const fn = loader.load(ref);
    assert.ok(fn !== undefined, `${ref} loads`);
    functions.register(ref, fn);
  }
  return { resources, functions };
}

// ── the graphs ───────────────────────────────────────────────────────────────

interface Shape {
  readonly pick?: string;
  readonly pickWrites?: readonly string[];
  readonly pickReads?: readonly string[];
  readonly check?: string;
  readonly checkReads?: readonly string[];
  readonly checkWrites?: readonly string[];
  readonly channels?: Record<string, unknown>;
  readonly inputs?: readonly string[];
  readonly nodes?: readonly unknown[];
  readonly edges?: readonly unknown[];
  readonly hooks?: Record<string, readonly string[]>;
  readonly capabilities?: readonly string[];
}

const arr = { type: "array", reduce: "replace" };
const obj = { type: "object", reduce: "replace" };

function keep(s: Shape = {}): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "keep-bench", project: "demo", version: 1 },
    policy: { posture: "out", capabilities: [...(s.capabilities ?? [])], expansion: { maxNodes: 16, maxDepth: 1, maxFanout: 2, maxLoopIterations: 4 } },
    channels: { items: arr, picked: arr, verdict: obj, ...(s.channels ?? {}) },
    inputs: [...(s.inputs ?? ["items"])],
    outputs: ["picked", "verdict"],
    nodes: [
      { id: "pick", type: "function", reads: s.pickReads ?? ["items"], writes: s.pickWrites ?? ["picked"], function: { ref: s.pick ?? "function/pick@stable" } },
      {
        id: "check",
        type: "evaluator",
        reads: s.checkReads ?? ["items", "picked"],
        writes: s.checkWrites ?? ["verdict"],
        evaluator: { kind: "assertion", ref: s.check ?? "function/check@stable", threshold: 0.5 },
      },
      ...(s.nodes ?? []),
    ],
    edges: [{ id: "e", from: "pick", to: "check", kind: "seq" }, ...(s.edges ?? [])],
    ...(s.hooks === undefined ? {} : { hooks: s.hooks }),
  } as unknown as GraphSpec;
}

/** The ground truth as a declared graph input and the grader reading ONE produced channel — game G's family. */
function truthBench(work: string, extra: { nodes?: readonly unknown[]; edges?: readonly unknown[]; writes?: readonly string[]; channels?: Record<string, unknown> } = {}): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "truth-bench", project: "demo", version: 1 },
    policy: { posture: "out", capabilities: [], expansion: { maxNodes: 16, maxDepth: 1, maxFanout: 2, maxLoopIterations: 4 } },
    channels: { items: arr, truth: arr, answer: arr, verdict: obj, ...(extra.channels ?? {}) },
    inputs: ["items", "truth"],
    outputs: ["answer", "verdict"],
    nodes: [
      { id: "work", type: "function", reads: ["items", "truth"], writes: extra.writes ?? ["answer"], function: { ref: work } },
      { id: "check", type: "evaluator", reads: ["answer", "truth"], writes: ["verdict"], evaluator: { kind: "assertion", ref: "function/check-truth@stable", threshold: 0.5 } },
      ...(extra.nodes ?? []),
    ],
    edges: [{ id: "e", from: "work", to: "check", kind: "seq" }, ...(extra.edges ?? [])],
  } as unknown as GraphSpec;
}

// ── the harness ──────────────────────────────────────────────────────────────

interface Bench {
  readonly store: MemoryStateStore;
  readonly hooks: HookRegistry;
  readonly models: ModelRegistry;
  readonly engineOpts: {
    tools: ToolRegistry;
    functions: FunctionRegistry;
    models: ModelRegistry;
    hooks: HookRegistry;
    resolver: ResourceResolver;
    payloads: ReturnType<typeof memoryPayloads>;
    policy: { granted: string[]; systemFloor: "out" };
    now: () => number;
  };
  compile(s: GraphSpec): RunGraph;
}

function bench(opts: { granted?: string[]; models?: ModelRegistry } = {}): Bench {
  const { resources, functions } = published();
  const fallback = resolver();
  const res: ResourceResolver = {
    resolve: (ref) => resources.resolve(ref) ?? fallback.resolve(ref),
    document: (pinned) => resources.document(pinned) ?? fallback.document?.(pinned),
  };
  const store = new MemoryStateStore({ now: () => NOW });
  const hooks = new HookRegistry();
  const models = opts.models ?? new ModelRegistry();
  const engineOpts = {
    tools: new ToolRegistry(),
    functions,
    models,
    hooks,
    resolver: res,
    payloads: memoryPayloads(),
    policy: { granted: opts.granted ?? [], systemFloor: "out" as const },
    now: () => NOW,
  };
  return {
    store,
    hooks,
    models,
    engineOpts,
    compile: (s) => compileOrThrow({ spec: s, resolver: res, tools: {}, tenantCapabilities: opts.granted ?? [] }),
  };
}

/** Four recordings of `graph`, odd lengths, so the baseline's own grader passes every one. */
async function record(b: Bench, graph: RunGraph, inputs: (items: string[]) => Record<string, unknown> = (items) => ({ items })) {
  const engine = new Engine({ store: b.store, ...b.engineOpts, sleep: async () => {} });
  const runs: { runId: RunId; p: RunProjection }[] = [];
  for (let i = 0; i < 4; i++) {
    const items = Array.from({ length: 3 + 2 * (i % 2) }, (_, k) => `doc-${String(i)}-${String(k)}`);
    const runId = await engine.submit({ graph, inputs: inputs(items) });
    const p = await engine.advance(runId);
    assert.equal(p.status, "succeeded", `recording ${String(i)}: ${JSON.stringify(p.error)}`);
    const events = [];
    for await (const e of b.store.read(runId, 1)) events.push(e);
    runs.push({ runId, p: foldRun(events)! });
  }
  return runs;
}

/**
 * The suite `loom suite freeze` writes for these recordings: every case golden, each pinning every
 * channel no evaluator writes and no input names, and — the §A.29 half — naming the baseline's
 * graders with the identity and site `freezeSuite` computes, from the same two functions.
 */
function freeze(baseline: RunGraph, runs: readonly { runId: RunId; p: RunProjection }[], mangle?: (g: NonNullable<EvalCase["expect"]["graders"]>) => EvalCase["expect"]["graders"]): EvalSuite {
  const graderWrote = new Set(baseline.spec.nodes.filter((n) => n.type === "evaluator").flatMap((n) => n.writes ?? []));
  const inputs = new Set<string>(baseline.spec.inputs);
  const graders = Object.fromEntries(
    Object.entries(evaluatorIdentities(baseline)).map(([scope, id]) => [scope, { ...id, site: graderSite(baseline, scope.slice(5))! }]),
  );
  const cases: EvalCase[] = runs.map(({ runId, p }, i) => ({
    id: `case-${String(i)}`,
    runId,
    mustPass: true,
    expect: {
      status: "succeeded" as const,
      noIrreversibleWithoutGate: true,
      channels: Object.fromEntries(Object.entries(p.channels).filter(([c]) => !graderWrote.has(c) && !inputs.has(c))),
      ...((): { graders?: NonNullable<EvalCase["expect"]["graders"]> } => {
        const g = mangle === undefined ? graders : mangle(graders);
        return g === undefined ? {} : { graders: g };
      })(),
    },
  }));
  return { name: "bench", version: 1, frozen: true, frozenAt: 1_000, generatedBy: "the-corpus", cases };
}

async function drive(b: Bench, suite: EvalSuite, baseline: RunGraph, candidate: RunGraph) {
  const base = await runEvalSuite({ store: b.store, suite, graph: baseline, engine: b.engineOpts });
  const cand = await runEvalSuite({ store: b.store, suite, graph: candidate, engine: b.engineOpts });
  const verdict = gateCandidate({
    baseline: base,
    candidate: cand,
    proposedAt: suite.frozenAt + 1,
    proposedBy: "an-optimiser",
    postureDiffNonNegative: true,
    deterministic: true,
  });
  return { base, cand, verdict, failed: verdict.checks.filter((c) => !c.pass).map((c) => c.id) };
}

/** Every case of `r` failed with a reason matching `why`; returns the first case's reasons. */
function refusedAll(r: EvalReport, why: RegExp): readonly string[] {
  assert.equal(r.passed, 0, `every case refused: ${JSON.stringify(r.cases.map((c) => c.reasons))}`);
  for (const c of r.cases) assert.ok(c.reasons.some((x) => why.test(x)), `${c.id}: ${JSON.stringify(c.reasons)}`);
  for (const c of r.cases) assert.equal(c.certified, undefined, `${c.id} certified nothing`);
  return r.cases[0]!.reasons;
}

/** The grader said pass on every replayed case — so what is refused is a GAME, not a failure. */
function graderSaidPass(r: EvalReport, channel = "verdict"): void {
  for (const c of r.cases) assert.equal((c.replay?.replayed.channels[channel] as { pass?: unknown } | undefined)?.pass, true, `${c.id}: the grader was fooled`);
}

// ── the ordinary half ────────────────────────────────────────────────────────

test("THE ORDINARY HALF · a candidate its frozen grader certifies promotes, every case certified rather than byte-matched", async () => {
  const b = bench();
  const baseline = b.compile(keep());
  const runs = await record(b, baseline);
  const r = await drive(b, freeze(baseline, runs), baseline, b.compile(keep({ pick: "function/pick-rev@stable" })));
  assert.deepEqual(r.failed, [], JSON.stringify(r.cand.cases.map((c) => c.reasons)));
  assert.equal(r.verdict.promote, true);
  for (const c of r.cand.cases) assert.deepEqual(c.certified?.map((x) => [x.channel, x.grader]), [["picked", "node:check"]], c.id);
  // …and a suite frozen WITHOUT graders keeps the byte pin exactly as it was.
  const old = await drive(b, freeze(baseline, runs, () => undefined), baseline, b.compile(keep({ pick: "function/pick-rev@stable" })));
  assert.deepEqual(refusedAll(old.cand, /differs/), ['channel "picked" differs']);
});

// ── the four games ───────────────────────────────────────────────────────────

test("GAME A · rewrite what fed the grader, restore it after grading — refused: the grader was served an items that is not the recorded input", async () => {
  const b = bench();
  const baseline = b.compile(keep({ channels: { stash: arr } }));
  const runs = await record(b, baseline);
  const gamed = b.compile(
    keep({
      pick: "function/stash-a@stable",
      pickWrites: ["stash", "items", "picked"],
      channels: { stash: arr },
      nodes: [{ id: "restore", type: "function", reads: ["stash"], writes: ["items"], function: { ref: "function/restore@stable" } }],
      edges: [{ id: "after", from: "pick", to: "restore", kind: "seq" }],
    }),
  );
  const r = await drive(b, freeze(baseline, runs), baseline, gamed);
  graderSaidPass(r.cand);
  for (const c of r.cand.cases) assert.deepEqual(c.replay?.replayed.channels["picked"], ["GARBAGE"], "the garbage is what the run kept");
  refusedAll(r.cand, /no frozen grader certifies it — node:check was served a "items" that is not the recorded input/);
  assert.equal(r.verdict.promote, false);
});

test("GAME A' · the graded channel is NEVER WRITTEN — refused before any certificate is consulted", async () => {
  const b = bench();
  const baseline = b.compile(keep({ channels: { stash: arr } }));
  const runs = await record(b, baseline);
  const gamed = b.compile(
    keep({
      pick: "function/stash-a-prime@stable",
      pickWrites: ["stash", "items", "picked"],
      channels: { stash: arr },
      nodes: [{ id: "restore", type: "function", reads: ["stash"], writes: ["items"], function: { ref: "function/restore@stable" } }],
      edges: [{ id: "after", from: "pick", to: "restore", kind: "seq" }],
    }),
  );
  const r = await drive(b, freeze(baseline, runs), baseline, gamed);
  graderSaidPass(r.cand);
  for (const c of r.cand.cases) assert.deepEqual(c.reasons, ['channel "picked" was never written by this run'], c.id);
  assert.equal(r.verdict.promote, false);
});

test("GAME C · fake ancestry through an untaken conditional, a loop back-edge, a spoiler after the grader — refused: what was graded is not what was kept", async () => {
  const b = bench();
  const baseline = b.compile(keep());
  const runs = await record(b, baseline);
  const gamed = b.compile(
    keep({
      channels: { t: { type: "number", reduce: "replace" } },
      nodes: [
        { id: "tock", type: "function", reads: ["picked"], writes: ["t"], function: { ref: "function/tock@stable" } },
        { id: "spoil", type: "function", reads: ["t"], writes: ["picked"], function: { ref: "function/spoil@stable" } },
      ],
      edges: [
        { id: "tick", from: "pick", to: "tock", kind: "seq" },
        { id: "tock-spoil", from: "tock", to: "spoil", kind: "seq" },
        // THE FAKE ANCESTRY: statically `spoil` precedes `check`. Nobody takes it.
        { id: "fake", from: "spoil", to: "check", kind: "conditional", when: "len(picked) == 999" },
        // THE BACK-EDGE the reverted ancestor walk skipped.
        { id: "back", from: "spoil", to: "tock", kind: "loop", until: "len(picked) == 1", maxIterations: 1 },
      ],
    }),
  );
  const r = await drive(b, freeze(baseline, runs), baseline, gamed);
  graderSaidPass(r.cand);
  for (const c of r.cand.cases) {
    assert.deepEqual(c.replay?.replayed.channels["picked"], ["GARBAGE"]);
    const committed = c.replay!.replayedEvents.filter((e) => e.type === "task.committed").map((e) => String(e.taskId).split("@")[0]);
    assert.ok(committed.indexOf("spoil") > committed.indexOf("check"), `the spoiler ran after the grader: ${committed.join(" ")}`);
  }
  refusedAll(r.cand, /node:check was served a different "picked" than the run ended with/);
  assert.equal(r.verdict.promote, false);
});

test("GAME G · the restore trick against the RECOMMENDED topology (truth a graph input, grader reads one produced channel) — refused on the truth", async () => {
  const b = bench();
  const baseline = b.compile(truthBench("function/answer@stable", { channels: { stash: arr } }));
  const runs = await record(b, baseline, (items) => ({ items, truth: items }));
  // The family's own ordinary half first: an honest reorder IS certified here.
  const honest = await drive(b, freeze(baseline, runs), baseline, b.compile(truthBench("function/answer-rev@stable", { channels: { stash: arr } })));
  assert.equal(honest.verdict.promote, true, JSON.stringify(honest.cand.cases.map((c) => c.reasons)));
  const gamed = b.compile(
    truthBench("function/stash-g@stable", {
      writes: ["stash", "truth", "answer"],
      channels: { stash: arr },
      nodes: [{ id: "restore", type: "function", reads: ["stash"], writes: ["truth"], function: { ref: "function/restore-g@stable" } }],
      edges: [{ id: "after", from: "work", to: "restore", kind: "seq" }],
    }),
  );
  const r = await drive(b, freeze(baseline, runs), baseline, gamed);
  graderSaidPass(r.cand);
  refusedAll(r.cand, /node:check was served a "truth" that is not the recorded input/);
  assert.equal(r.verdict.promote, false);
});

// ── the conditions, one test each ───────────────────────────────────────────

test("THE VIEW IS BUILT FROM SPECS THE CANDIDATE OWNS · re-declaring a channel the grader reads certifies nothing — the input, or the GRADED channel itself", async () => {
  // An INPUT re-declared `last_write_wins_by_ts`: stored, `items` is still the recorded list;
  // handed through `channelValue`, it is `undefined`, so `check` compares [] with [] and passes an
  // empty answer.
  {
    const b = bench();
    const baseline = b.compile(keep());
    const runs = await record(b, baseline);
    const gamed = b.compile(keep({ pick: "function/pick-empty@stable", channels: { items: { type: "array", reduce: "last_write_wins_by_ts" } } }));
    const r = await drive(b, freeze(baseline, runs), baseline, gamed);
    graderSaidPass(r.cand);
    refusedAll(r.cand, /node:check's declaration, an edge leaving it, or a channel it reads is not the one the freeze named/);
  }
  // The GRADED channel re-declared `last_write_wins_by_ts` with an `initial` no write can displace
  // (lane F's diff review, which drove it to `promote: true` before the specs were bound): stored,
  // `picked` is ["GARBAGE"] for the whole run; handed, it is `undefined` to the grader AND in the
  // final view — so "what was graded is what is kept" held over two `undefined`s. The frozen grader
  // here is a realistic one: every picked item must be one of the inputs.
  {
    const b = bench();
    const baseline = b.compile(keep({ check: "function/subset@stable" }));
    const runs = await record(b, baseline);
    const gamed = b.compile(keep({ check: "function/subset@stable", channels: { picked: { type: "array", reduce: "last_write_wins_by_ts", initial: ["GARBAGE"] } } }));
    const r = await drive(b, freeze(baseline, runs), baseline, gamed);
    graderSaidPass(r.cand);
    for (const c of r.cand.cases) assert.deepEqual(c.replay?.replayed.channels["picked"], ["GARBAGE"], "the garbage is what the run kept");
    refusedAll(r.cand, /node:check's declaration, an edge leaving it, or a channel it reads is not the one the freeze named/);
    assert.equal(r.verdict.promote, false);
  }
});

test("A GRADER READING A PRODUCED CHANNEL besides the graded one (the fixture topology) certifies nothing — the candidate owns both sides", async () => {
  const b = bench();
  const fixture = (ref: string): unknown => ({ id: "fixture", type: "function", reads: ["items"], writes: ["expected"], function: { ref } });
  const shape = (fx: string, pick: string) =>
    keep({
      pick,
      check: "function/check-fixture@stable",
      checkReads: ["expected", "picked"],
      channels: { expected: arr },
      nodes: [fixture(fx)],
      edges: [{ id: "fx", from: "fixture", to: "check", kind: "seq" }],
    });
  const baseline = b.compile(shape("function/fixture@stable", "function/pick@stable"));
  const runs = await record(b, baseline);
  // Both sides rewritten to the same garbage: the untouched grader says pass.
  const gamed = b.compile(shape("function/fixture-g@stable", "function/spoil@stable"));
  const r = await drive(b, freeze(baseline, runs), baseline, gamed);
  graderSaidPass(r.cand);
  refusedAll(r.cand, /node:check also reads "expected", which is not an input the recording was submitted with/);

  // …or DELETES the fixture, so the grader compares against NOTHING: absent served, absent in the
  // recorded inputs — equal, if equality were the only question — and an empty answer passes.
  const vacuous = b.compile(
    keep({ pick: "function/pick-empty@stable", check: "function/check-fixture@stable", checkReads: ["expected", "picked"], channels: { expected: arr } }),
  );
  const v = await drive(b, freeze(baseline, runs), baseline, vacuous);
  graderSaidPass(v.cand);
  refusedAll(v.cand, /node:check also reads "expected", which is not an input the recording was submitted with/);
});

test("A GRADER THAT IS NOT THE ONE FROZEN · a rigged body — refused at the case, and by 12-grader-unchanged", async () => {
  const b = bench();
  const baseline = b.compile(keep());
  const runs = await record(b, baseline);
  const r = await drive(b, freeze(baseline, runs), baseline, b.compile(keep({ pick: "function/pick-drop@stable", check: "function/check-rigged@stable" })));
  graderSaidPass(r.cand);
  refusedAll(r.cand, /node:check is not the grader the freeze named \(node:check function\/check@stable → function\/check-rigged@stable\)/);
  assert.ok(r.failed.includes("12-grader-unchanged"));
});

test("THE SITE · an edge added leaving the grader (what ctx.node is built from) certifies nothing, even for an honest reorder", async () => {
  const b = bench();
  const baseline = b.compile(keep());
  const runs = await record(b, baseline);
  const rewired = b.compile(
    keep({
      pick: "function/pick-rev@stable",
      channels: { t: { type: "number", reduce: "replace" } },
      nodes: [{ id: "after", type: "function", reads: ["verdict"], writes: ["t"], function: { ref: "function/after@stable" } }],
      edges: [{ id: "then", from: "check", to: "after", kind: "seq" }],
    }),
  );
  const r = await drive(b, freeze(baseline, runs), baseline, rewired);
  refusedAll(r.cand, /node:check's declaration, an edge leaving it, or a channel it reads is not the one the freeze named/);
});

test("A FREEZE THAT BOUND NO DIGEST, OR NO SITE, OR NAMED NO GRADER READING THE CHANNEL certifies nothing", async () => {
  const b = bench();
  const baseline = b.compile(keep());
  const runs = await record(b, baseline);
  const honest = b.compile(keep({ pick: "function/pick-rev@stable" }));
  const strip = (field: "digest" | "site") => (g: NonNullable<EvalCase["expect"]["graders"]>) =>
    Object.fromEntries(Object.entries(g).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([f]) => f !== field))])) as typeof g;
  refusedAll((await drive(b, freeze(baseline, runs, strip("digest")), baseline, honest)).cand, /with no resolved body digest/);
  refusedAll((await drive(b, freeze(baseline, runs, strip("site")), baseline, honest)).cand, /declaration, an edge leaving it, or a channel it reads/);
  refusedAll((await drive(b, freeze(baseline, runs, () => ({})), baseline, honest)).cand, /no grader the freeze named reads "picked"/);
});

test("EVERY FROZEN GRADER READING THE CHANNEL MUST CERTIFY IT — one grader's pass does not outvote another's fail", async () => {
  const b = bench();
  const orderNode = { id: "order", type: "evaluator", reads: ["items", "picked"], writes: ["order"], evaluator: { kind: "assertion", ref: "function/order@stable", threshold: 0.5 } };
  const shape = (pick: string) => keep({ pick, channels: { order: obj }, nodes: [orderNode], edges: [{ id: "o", from: "pick", to: "order", kind: "seq" }] });
  const baseline = b.compile(shape("function/pick@stable"));
  const runs = await record(b, baseline);
  const r = await drive(b, freeze(baseline, runs), baseline, b.compile(shape("function/pick-rev@stable")));
  graderSaidPass(r.cand); // `check` certifies the reorder…
  refusedAll(r.cand, /node:order did not pass it/); // …and `order`, which the freeze also named, does not.
});

test("A GRADER THAT RAN TWICE certifies nothing — a loop back into it, its own outbound edges untouched", async () => {
  const b = bench();
  const report = { id: "report", type: "function", reads: ["verdict", "rounds"], writes: ["rounds"], function: { ref: "function/report@stable" } };
  const shape = (pick: string, again: boolean) =>
    keep({
      pick,
      channels: { rounds: { type: "number", reduce: "replace" } },
      nodes: [report],
      edges: [
        { id: "rep", from: "check", to: "report", kind: "seq" },
        ...(again ? [{ id: "again", from: "report", to: "check", kind: "loop", until: "rounds >= 2", maxIterations: 2 }] : []),
      ],
    });
  const baseline = b.compile(shape("function/pick@stable", false));
  const runs = await record(b, baseline);
  const r = await drive(b, freeze(baseline, runs, (g) => g), baseline, b.compile(shape("function/pick-rev@stable", true)));
  // `rounds` differs too (2 against 1) and no grader reads it, so it keeps its byte pin; what is
  // asserted is the reason on `picked`, which `check` read twice.
  for (const c of r.cand.cases) assert.ok(c.reasons.some((x) => /node:check ran as 2 Tasks/.test(x)), `${c.id}: ${JSON.stringify(c.reasons)}`);
});

test("A GRADER REACHED ONLY AT ITERATION 1 certifies nothing — its task id and seed are not the recording's", async () => {
  const b = bench();
  const baseline = b.compile(keep({ check: "function/spot@stable" }));
  const runs = await record(b, baseline);
  // `pick` loops into itself once and only then reaches `check`, so the grader's one Task is
  // `check@root#1`. The candidate drops item 0; the spot-check's seed (derived from the key, since the
  // recording's is keyed on #0) samples another item. Lane F's re-review, as a pin.
  const gamed = keep({
    check: "function/spot@stable",
    pick: "function/pick-count@stable",
    pickReads: ["items", "rounds"],
    pickWrites: ["picked", "rounds"],
    channels: { rounds: { type: "number", reduce: "replace" } },
    edges: [{ id: "again", from: "pick", to: "pick", kind: "loop", until: "rounds >= 2", maxIterations: 2 }],
  }) as unknown as { edges: Record<string, unknown>[] };
  gamed.edges[0] = { id: "e", from: "pick", to: "check", kind: "conditional", when: "rounds >= 2" };
  const r = await drive(b, freeze(baseline, runs), baseline, b.compile(gamed as unknown as GraphSpec));
  for (const c of r.cand.cases) {
    assert.ok(c.reasons.some((x) => /node:check ran at iteration 1, so its task id, seed and clock are not the ones the recording served/.test(x)), `${c.id}: ${JSON.stringify(c.reasons)}`);
    assert.equal(c.certified, undefined, c.id);
  }
});

test("F1 · A GRADER WHOSE BODY IS HOST CODE (a module-registered body) certifies nothing — its digest does not bind what ran", async () => {
  const b = bench();
  const baseline = b.compile(keep());
  const runs = await record(b, baseline);
  const suite = freeze(baseline, runs);
  // The coordinator's repro: after the freeze, `function/check@stable` is re-registered as an
  // always-pass closure — what an `--extension-module` does to a module-only ref, whose "resolved
  // digest" is the digest of its own name and so does not move. The candidate picks NOTHING.
  b.engineOpts.functions.register("function/check@stable", () => ({ writes: { verdict: { pass: true, confidence: 1 } } }));
  const r = await drive(b, suite, baseline, b.compile(keep({ pick: "function/pick-empty@stable" })));
  graderSaidPass(r.cand);
  for (const c of r.cand.cases) {
    assert.ok(c.replay!.liveBodies.includes("check@root#0"), `${c.id}: the runtime says it cannot vouch for the grader`);
    assert.deepEqual(c.replay!.replayed.channels["picked"], []);
  }
  refusedAll(r.cand, /node:check's body ran as host code the runtime cannot vouch for/);
  assert.equal(r.verdict.promote, false);
  // …and `12-grader-unchanged` does not see it: the digest it compares did not move (residue).
  assert.equal(r.verdict.checks.find((c) => c.id === "12-grader-unchanged")!.pass, true);
});

test("A VERDICT BELOW THRESHOLD, NO VERDICT AT ALL, OR ONE THAT LEFT THE JOURNAL, certifies nothing", async () => {
  for (const [ref, why, extra] of [
    ["function/check-scored@stable", /passed it below its own threshold/, {}],
    ["function/check-nopass@stable", /node:check wrote no verdict/, {}],
    // `note` says FAIL and is externalised, so only `verdict`'s pass is inline: a verdict the gate
    // cannot read is not a verdict it may ignore.
    ["function/check-split@stable", /node:check's verdict was externalised/, { checkWrites: ["verdict", "note"], channels: { note: obj } }],
  ] as const) {
    const b = bench();
    const baseline = b.compile(keep({ check: ref, ...extra }));
    const runs = await record(b, baseline);
    const r = await drive(b, freeze(baseline, runs), baseline, b.compile(keep({ check: ref, pick: "function/pick-rev@stable", ...extra })));
    refusedAll(r.cand, why);
  }
});

test("A HOOK THAT SKIPPED THE GRADER certifies nothing — the commit is not the body's verdict", async () => {
  const b = bench();
  // The hook skips `check` and answers pass itself; the graph names it, the operator installed it.
  b.hooks.register("hook/skip-check@stable", (_input, ctx) =>
    String(ctx.taskId ?? "").startsWith("check@") ? { skip: true, overrideWrites: { verdict: { pass: true, confidence: 1 } } } : {},
  );
  const baseline = b.compile(keep());
  const runs = await record(b, baseline);
  const gamed = b.compile(keep({ pick: "function/pick-drop@stable", hooks: { preNode: ["hook/skip-check@stable"] } }));
  const r = await drive(b, freeze(baseline, runs), baseline, gamed);
  graderSaidPass(r.cand);
  refusedAll(r.cand, /node:check's commit is not established to be its body's verdict \(hook\.applied/);
});

test("A GATED GRADER A HUMAN ANSWERED WITH `edit` certifies nothing — the verdict is the human's recorded write, not the body's", async () => {
  const b = bench();
  // The grader is gated (`posture: in`) in the baseline itself, so its SITE is the frozen one; each
  // recording's approver EDITED the verdict to a pass, and replay serves that decision again.
  const gated = (pick: string): GraphSpec => {
    const s = keep({ pick }) as unknown as { nodes: Record<string, unknown>[] };
    return { ...s, nodes: s.nodes.map((n) => (n["id"] === "check" ? { ...n, policy: { posture: "in" } } : n)) } as unknown as GraphSpec;
  };
  const baseline = b.compile(gated("function/pick@stable"));
  const engine = new Engine({ store: b.store, ...b.engineOpts, sleep: async () => {} });
  const runs: { runId: RunId; p: RunProjection }[] = [];
  for (let i = 0; i < 2; i++) {
    const runId = await engine.submit({ graph: baseline, inputs: { items: [`a${String(i)}`, "b", "c"] } });
    await engine.advance(runId);
    const [gate] = await engine.openGates(runId);
    assert.ok(gate !== undefined, "the grader gated");
    const p = await engine.resolveGate(runId, {
      gateId: gate.gateId as never,
      decision: { kind: "edit", writes: { verdict: { pass: true, confidence: 1 } } } as never,
      actor: { kind: "human", subject: "u:op", via: "api" },
      idempotencyKey: `edit-${String(i)}`,
    });
    assert.equal(p.status, "succeeded");
    runs.push({ runId, p });
  }
  const r = await drive(b, freeze(baseline, runs), baseline, b.compile(gated("function/pick-drop@stable")));
  graderSaidPass(r.cand);
  refusedAll(r.cand, /node:check's commit is not established to be its body's verdict \(gate\.raised/);
});

test("A GRAPH THAT MUTATED BEFORE THE GRADER COMMITTED certifies nothing — the site was checked against a graph no longer in force", async () => {
  const models = new ModelRegistry();
  models.register(
    new MockModelAdapter({
      script: () => ({
        text: JSON.stringify({
          ok: true,
          mutation: {
            reason: "add a node",
            addNodes: [{ id: "added", type: "function", reads: ["note"], writes: ["t"], function: { ref: "function/tock@stable" } }],
            addEdges: [{ id: "e_added", from: "plan", to: "added", kind: "seq" }],
          },
        }),
        finishReason: "stop",
      }),
    }),
    true,
  );
  const b = bench({ granted: ["graph:mutate"], models });
  const plan = {
    id: "plan",
    type: "agent",
    reads: ["items"],
    writes: ["note"],
    agent: {
      profile: "agent_profile/p@stable",
      prompt: "prompt/p@stable",
      maxTurns: 1,
      canMutate: true,
      outputSchema: { type: "object", properties: { ok: { type: "boolean" }, mutation: { type: "object" } } },
    },
  };
  const shape = (pick: string) =>
    keep({
      pick,
      capabilities: ["graph:mutate"],
      channels: { note: obj, t: { type: "number", reduce: "replace" } },
      nodes: [plan],
      edges: [{ id: "first", from: "plan", to: "pick", kind: "seq" }],
    });
  const baseline = b.compile(shape("function/pick@stable"));
  const runs = await record(b, baseline);
  for (const { p } of runs) assert.notEqual(p.graphHash, baseline.graphHash, "precondition: the recording mutated");
  const r = await drive(b, freeze(baseline, runs), baseline, b.compile(shape("function/pick-rev@stable")));
  refusedAll(r.cand, /node:check's commit is not established to be its body's verdict \(graph\.mutated/);
});

// ── §A.NEW-2: the baseline's own bar ─────────────────────────────────────────

test("A.NEW-2 · a BASELINE case that failed because it could not reproduce ITS OWN RECORDING counts as a baseline pass; a baseline the operator CHOSE differently is measured as it is", () => {
  type Row = { pass: boolean; match?: boolean; graphMatch?: boolean; threw?: boolean };
  const report = (cases: Row[]): EvalReport =>
    ({
      suite: "s",
      suiteVersion: 1,
      suiteFrozenAt: 1,
      cases: cases.map((c, i) => ({
        id: `k${String(i)}`,
        pass: c.pass,
        mustPass: false,
        reasons: c.pass ? [] : ["x"],
        costUsd: 0,
        wallMs: 0,
        ...(c.threw === true
          ? { recordedGraph: { recorded: "a", replayed: c.graphMatch === true ? "a" : "b", match: c.graphMatch === true } }
          : { replay: { match: c.match ?? true, graph: { match: c.graphMatch ?? true, recorded: "a", replayed: c.graphMatch === false ? "b" : "a" } } }),
      })),
      passed: cases.filter((c) => c.pass).length,
      total: cases.length,
      passRate: cases.filter((c) => c.pass).length / cases.length,
      mustPassFailures: [],
      totalCostUsd: 0,
      p95WallMs: 0,
      suiteValid: true,
      suiteIssues: [],
      budgets: {},
      evaluators: {},
    }) as unknown as EvalReport;
  const decide = (baseline: EvalReport, candidate: EvalReport) =>
    gateCandidate({ baseline, candidate, postureDiffNonNegative: true, deterministic: true }).checks.find((c) => c.id === "2-non-inferior")!;
  const half = report([{ pass: true }, { pass: false }]);

  // BASELINE == RECORDED, UNFAITHFUL REPLAY: the stricter bar. An equal candidate is refused.
  const unfaithful = decide(report([{ pass: true }, { pass: false, match: false, graphMatch: true }]), half);
  assert.equal(unfaithful.pass, false);
  assert.equal(
    unfaithful.detail,
    "pass rate 50.0% vs baseline 50.0% (Δ 0.0pp) — and the baseline FAILED 1 case(s) whose replay did not reproduce its own " +
      "recording (k1), so the bar is taken as if it had passed them: 100.0% (Δ -50.0pp)",
  );
  // …and a replay that THREW on the recorded graph is the same fact with no report to ask.
  assert.equal(decide(report([{ pass: true }, { pass: false, threw: true, graphMatch: true }]), half).pass, false);

  // BASELINE != RECORDED: `graph.match` is false on every case by construction, and that is the
  // operator's choice, not an unfaithful replay. An equal candidate promotes, as it did on base.
  assert.equal(decide(report([{ pass: true, match: false, graphMatch: false }, { pass: false, match: false, graphMatch: false }]), half).pass, true);
  assert.equal(decide(report([{ pass: true, graphMatch: false }, { pass: false, threw: true, graphMatch: false }]), half).pass, true);

  // A baseline case that failed while REPRODUCING its recording is a real bar, and counts as it is.
  assert.equal(decide(report([{ pass: true }, { pass: false }]), half).pass, true);
  // A candidate that clears even the strictest bar promotes whatever the baseline did.
  assert.equal(decide(report([{ pass: false, match: false }, { pass: false, threw: true, graphMatch: true }]), report([{ pass: true }, { pass: true }])).pass, true);
});

test("A.NEW-2, DRIVEN · a baseline whose replay THROWS on its own recorded graph raises the bar; the same failures under an operator-chosen graph do not", async () => {
  const b = bench();
  const baseline = b.compile(keep());
  // An input over the externalisation threshold, so a replay handed no payload store cannot even
  // submit the recording's inputs: `E_PAYLOAD_UNRESOLVED`, on the recorded graph.
  const engine = new Engine({ store: b.store, ...b.engineOpts, sleep: async () => {} });
  const ids: RunId[] = [];
  for (let i = 0; i < 2; i++) {
    const runId = await engine.submit({ graph: baseline, inputs: { items: [`${"w".repeat(70_000)}-${String(i)}`, "b"] } });
    assert.equal((await engine.advance(runId)).status, "succeeded");
    ids.push(runId);
  }
  const suite: EvalSuite = {
    name: "s",
    version: 1,
    frozen: true,
    frozenAt: 1_000,
    cases: ids.map((runId, i) => ({ id: `c${String(i)}`, runId, mustPass: false, expect: { status: "succeeded" as const } })),
  };
  const { payloads: _dropped, ...noPayloads } = b.engineOpts;
  const onRecorded = await runEvalSuite({ store: b.store, suite, graph: baseline, engine: noPayloads });
  for (const c of onRecorded.cases) {
    assert.equal(c.replay, undefined, "the replay threw");
    assert.match(c.reasons[0]!, /replay failed: .*externalised/);
    assert.deepEqual(c.recordedGraph?.match, true, "…on the graph the corpus was recorded with");
  }
  // An operator-chosen baseline (a different spec) that throws the same way is not the same fact.
  const chosen = b.compile({ ...keep(), metadata: { name: "keep-bench", project: "demo", version: 2 } } as unknown as GraphSpec);
  const onChosen = await runEvalSuite({ store: b.store, suite, graph: chosen, engine: noPayloads });
  for (const c of onChosen.cases) assert.deepEqual(c.recordedGraph?.match, false);

  const decide = (base: EvalReport) =>
    gateCandidate({ baseline: base, candidate: onRecorded, postureDiffNonNegative: true, deterministic: true }).checks.find((c) => c.id === "2-non-inferior")!;
  assert.equal(decide(onRecorded).pass, false, "an equal candidate against an unfaithful baseline: the stricter bar");
  assert.equal(decide(onChosen).pass, true, "an equal candidate against a baseline the operator chose: measured as it is");
});

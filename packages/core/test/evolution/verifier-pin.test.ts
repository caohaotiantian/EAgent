/**
 * TODO A.29 — a frozen golden case pinned the whole work channel VERBATIM, so a candidate whose
 * every run the graph's OWN deterministic verifier certifies as `pass` was refused by
 * `1-must-pass` and reported as a regression. This file is the measurement of the repair and of
 * the two ways it could have gone wrong.
 *
 * FIVE DRIVES, ALL OVER ONE CORPUS SHAPE AND ONE FAMILY OF GRAPHS, so the numbers are comparable:
 *
 *   1. the byte pin alone, against the honest candidate  → the FALSE NEGATIVE this row exists for;
 *   2. the three-axis pin, against the honest candidate  → it must PROMOTE;
 *   3. the three-axis pin, against a candidate that games it → it must REFUSE, naming `fed`;
 *   4. the same gaming candidate with AXIS 3 DELETED     → it PASSES, which is the previously
 *      refused answer re-driven rather than quoted, and the reason `fed` exists;
 *   5. the honest reorder PLUS an edit to `note`, a channel no verifier reads → still REFUSED,
 *      which is `VerifierPin` note 2 measured rather than asserted.
 *
 * WHY THE GRAPH IS THIS SMALL. Every node here is a `function` or an `assertion` evaluator, so
 * the whole corpus is deterministic and the gate spends no model call — which is also the only
 * candidate class an offline gate can judge at all (`gate.ts`'s own header says why). The
 * verifier asserts `picked.length === items.length` and NOTHING ELSE, which is what makes the
 * trade in `VerifierPin` note 1 visible in this file rather than only described in that one: the
 * honest candidate here REORDERS the work channel and the graph's own definition of correct does
 * not care, so promoting it is the right answer and refusing it was the defect.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { RunGraph } from "../../src/graph/spec.ts";
import type { RunId, Seq } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { InProcessEventBus } from "../../src/bus.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { foldRun, type RunProjection } from "../../src/run/projection.ts";
import { ResourceStore } from "../../src/resources/store.ts";
import { createFunctionLoader } from "../../src/resources/functions.ts";
import {
  gateCandidate,
  runEvalSuite,
  verificationPin,
  type EvalCase,
  type EvalSuite,
  type VerifierPin,
} from "../../src/evolution/gate.ts";

// ── the workspace: four published bodies, three graphs ───────────────────────

const ACTOR = { kind: "human", id: "u:test" } as const;

/**
 * The baseline's work node: the recording is what it produced.
 *
 * IT WRITES TWO CHANNELS AND THE VERIFIER READS ONE. `note` is here so this file can measure
 * `VerifierPin` note 2 rather than only assert it: nothing certifies `note`, so its byte pin has
 * to survive the repair, and `A CHANNEL NO VERIFIER READS KEEPS ITS BYTE PIN` below drives that.
 */
const PICK = `(view) => {
  const items = view.get("items") ?? [];
  return { writes: { picked: items.slice(), note: { n: items.length } } };
}`;

/**
 * THE HONEST CANDIDATE. It reorders the work channel and changes nothing else, so every byte of
 * `picked` differs and the graph's own verifier certifies every run of it as `pass`.
 */
const PICK_REVERSED = `(view) => {
  const items = view.get("items") ?? [];
  return { writes: { picked: items.slice().reverse(), note: { n: items.length } } };
}`;

/**
 * THE SAME REORDER, PLUS A REWRITE OF A CHANNEL NO VERIFIER READS. The pin holds — `picked` is
 * waived — and `note` is refused, which is `VerifierPin` note 2 driven.
 */
const PICK_REVERSED_NOISY = `(view) => {
  const items = view.get("items") ?? [];
  return { writes: { picked: items.slice().reverse(), note: { n: items.length, extra: "louder" } } };
}`;

/**
 * THE CANDIDATE THAT GAMES A TWO-AXIS PIN. The evaluator node is left BYTE-IDENTICAL — same
 * declaration, same body, and it still says `pass` — and instead the candidate narrows the
 * channel the evaluator READS. `picked.length === items.length` is then trivially true on one
 * element, and the grader certifies garbage.
 */
const PICK_GAMED = `(view) => {
  const items = view.get("items") ?? [];
  const one = items.slice(0, 1);
  return { writes: { items: one, picked: one, note: { n: items.length } } };
}`;

const CHECK = `(view) => ({
  writes: {
    verdict: {
      pass: (view.get("picked") ?? []).length === (view.get("items") ?? []).length,
      confidence: 1,
    },
  },
})`;

function spec(pickRef: string, pickWrites: readonly string[]): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "pick-bench", project: "demo", version: 1 },
    policy: { posture: "out", capabilities: [] },
    channels: {
      items: { type: "array", reduce: "replace" },
      picked: { type: "array", reduce: "replace" },
      note: { type: "object", reduce: "replace" },
      verdict: { type: "object", reduce: "replace" },
    },
    inputs: ["items"],
    outputs: ["verdict"],
    nodes: [
      { id: "pick", type: "function", reads: ["items"], writes: pickWrites, function: { ref: pickRef } },
      {
        id: "check",
        type: "evaluator",
        reads: ["items", "picked"],
        writes: ["verdict"],
        evaluator: { kind: "assertion", ref: "function/check@stable", threshold: 0.5 },
      },
    ],
    edges: [{ id: "e", from: "pick", to: "check", kind: "seq" }],
  } as unknown as GraphSpec;
}

interface Bench {
  readonly resources: ResourceStore;
  readonly baseline: RunGraph;
  readonly honest: RunGraph;
  readonly gamed: RunGraph;
  readonly noisy: RunGraph;
  readonly store: MemoryStateStore;
  readonly engine: Engine;
  readonly engineOpts: { tools: ToolRegistry; functions: FunctionRegistry; models: ModelRegistry };
}

function bench(): Bench {
  const resources = new ResourceStore({ now: () => 1 });
  const publish = (name: string, content: string): void => {
    const ref = resources.publish({ kind: "function", name, content, actor: ACTOR });
    resources.promote(ref, "canary", ACTOR);
    resources.promote(ref, "stable", ACTOR);
  };
  publish("pick", PICK);
  publish("pick-reversed", PICK_REVERSED);
  publish("pick-gamed", PICK_GAMED);
  publish("pick-reversed-noisy", PICK_REVERSED_NOISY);
  publish("check", CHECK);

  // The same eager registration `cli.ts`'s `registerFunctions` does, so the bodies these graphs
  // name are the bodies the engine runs.
  const functions = new FunctionRegistry();
  const loader = createFunctionLoader({ store: resources });
  for (const version of resources.list({ kind: "function" })) {
    const ref = `function/${version.name}@stable`;
    const body = loader.load(ref);
    if (body !== undefined) functions.register(ref, body);
  }

  const compileOf = (s: GraphSpec): RunGraph => compileOrThrow({ spec: s, resolver: resources, tools: {} });
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const tools = new ToolRegistry();
  const models = new ModelRegistry();
  return {
    resources,
    baseline: compileOf(spec("function/pick@stable", ["picked", "note"])),
    honest: compileOf(spec("function/pick-reversed@stable", ["picked", "note"])),
    gamed: compileOf(spec("function/pick-gamed@stable", ["items", "picked", "note"])),
    noisy: compileOf(spec("function/pick-reversed-noisy@stable", ["picked", "note"])),
    store,
    engine: new Engine({
      store,
      bus: new InProcessEventBus({ store }),
      tools,
      functions,
      models,
      now: () => 1_700_000_000_000,
      policy: { granted: [] },
    }),
    engineOpts: { tools, functions, models },
  };
}

/** N recorded runs of the BASELINE, and their folded projections. */
async function record(b: Bench, n: number): Promise<{ runId: RunId; p: RunProjection }[]> {
  const out: { runId: RunId; p: RunProjection }[] = [];
  for (let i = 0; i < n; i++) {
    // Odd lengths only, so the baseline's verifier says `pass` on every recording and every case
    // is one this row's "certified as not worse" claim can be made about.
    const items = Array.from({ length: 3 + 2 * (i % 2) }, (_, k) => `doc-${String(i)}-${String(k)}`);
    const runId = await b.engine.submit({ graph: b.baseline, inputs: { items } });
    await b.engine.advance(runId);
    const events: JournalEvent[] = [];
    for await (const ev of b.store.read(runId, 1 as Seq)) events.push(ev);
    const p = foldRun(events);
    assert.ok(p !== undefined && p.status === "succeeded", `run ${String(i)} did not succeed`);
    out.push({ runId, p });
  }
  return out;
}

/**
 * The suite `loom suite freeze` would write for these recordings, with `withPin` deciding
 * whether the case carries the three-axis pin.
 *
 * The `channels` block is built exactly as `freezeSuite` builds it — every recorded channel
 * except the ones an `evaluator` node wrote and the graph's declared `inputs` — so the byte pin
 * in these cases is the byte pin the shipped verb produces.
 */
function suiteOf(b: Bench, runs: { runId: RunId; p: RunProjection }[], withPin: boolean, mangle?: (p: readonly VerifierPin[]) => readonly VerifierPin[]): EvalSuite {
  const graderWrote = new Set(["verdict"]);
  const inputs = new Set(b.baseline.spec.inputs);
  const cases: EvalCase[] = runs.map(({ runId, p }, i) => {
    const channels = Object.fromEntries(
      Object.entries(p.channels).filter(([c]) => !graderWrote.has(c) && !inputs.has(c)),
    );
    const pins = verificationPin(b.baseline, p);
    assert.ok(pins !== undefined, "the baseline recording must be pinnable, or nothing below measures anything");
    return {
      id: `case-${String(i)}`,
      runId,
      mustPass: true,
      expect: {
        status: "succeeded" as const,
        channels,
        ...(withPin ? { verifiedBy: mangle === undefined ? pins : mangle(pins) } : {}),
      },
    };
  });
  return { name: "pick-bench", version: 1, frozen: true, frozenAt: 1_000, generatedBy: "the-corpus", cases };
}

const engineFor = (b: Bench) => ({ ...b.engineOpts, policy: { granted: [] } });

async function drive(b: Bench, suite: EvalSuite, candidate: RunGraph) {
  const baseline = await runEvalSuite({ store: b.store, suite, graph: b.baseline, engine: engineFor(b) });
  const cand = await runEvalSuite({ store: b.store, suite, graph: candidate, engine: engineFor(b) });
  const verdict = gateCandidate({
    baseline,
    candidate: cand,
    proposedAt: suite.frozenAt + 1,
    proposedBy: "an-optimiser",
    postureDiffNonNegative: true,
    deterministic: true,
  });
  return { baseline, cand, verdict };
}

// ── 1 + 2: the false negative, and its repair ────────────────────────────────

test("A.29: the byte pin refuses a candidate the graph's own verifier certifies; the three-axis pin promotes it", async () => {
  const b = bench();
  const runs = await record(b, 8);

  const byBytes = await drive(b, suiteOf(b, runs, false), b.honest);
  assert.equal(byBytes.baseline.passRate, 1, "the baseline must pass its own suite");
  assert.equal(byBytes.cand.mustPassFailures.length, 8, "every case is a must-pass failure under the byte pin");
  assert.equal(byBytes.verdict.promote, false);
  assert.match(byBytes.cand.cases[0]!.reasons.join(" | "), /channel "picked" differs/);

  const byPin = await drive(b, suiteOf(b, runs, true), b.honest);
  assert.deepEqual(
    byPin.cand.mustPassFailures,
    [],
    `expected no must-pass failure, got ${JSON.stringify(byPin.cand.cases.filter((c) => !c.pass).map((c) => c.reasons))}`,
  );
  assert.equal(byPin.cand.passRate, 1);
  assert.equal(byPin.verdict.promote, true, JSON.stringify(byPin.verdict.checks.filter((c) => !c.pass)));

  // THE MEASUREMENT THIS ROW TURNS ON, printed rather than only asserted.
  console.log(
    `byte pin  -> mustPassFailures ${String(byBytes.cand.mustPassFailures.length)}  passRate ${byBytes.cand.passRate.toFixed(3)}  promote ${String(byBytes.verdict.promote)}\n` +
      `three-axis-> mustPassFailures ${String(byPin.cand.mustPassFailures.length)}  passRate ${byPin.cand.passRate.toFixed(3)}  promote ${String(byPin.verdict.promote)}`,
  );
});

// ── 3 + 4: the game, and the axis that stops it ──────────────────────────────

test("A.29: a candidate that rewrites what FED the verifier is refused — and passes with axis 3 deleted", async () => {
  const b = bench();
  const runs = await record(b, 8);

  const full = await drive(b, suiteOf(b, runs, true), b.gamed);
  assert.equal(full.cand.mustPassFailures.length, 8, "the gaming candidate must fail every case");
  assert.equal(full.verdict.promote, false);
  const reasons = full.cand.cases[0]!.reasons.join(" | ");
  assert.match(reasons, /rewrote channel "items", which is what FED the verifier "check"/);
  // AND THE GAME REALLY IS A GAME: the verifier is untouched and still said pass, so axes 1 and 2
  // are both clean. If either had failed, this test would be measuring something else.
  assert.doesNotMatch(reasons, /is not the one that certified this case/);
  assert.doesNotMatch(reasons, /said pass=/);

  // AXIS 3 DELETED — the previously refused answer, re-driven on this corpus rather than quoted.
  // `fed: {}` leaves WHO the verifier is and WHAT IT SAID, which is exactly what that answer
  // pinned, and the byte pin is waived because the pin holds.
  const twoAxis = await drive(b, suiteOf(b, runs, true, (pins) => pins.map((p) => ({ ...p, fed: {} }))), b.gamed);
  assert.deepEqual(twoAxis.cand.mustPassFailures, [], "with no third axis the game is invisible — that is why `fed` exists");
  assert.equal(twoAxis.cand.passRate, 1);
  assert.equal(twoAxis.verdict.promote, true);

  console.log(
    `gamed, three axes -> mustPassFailures ${String(full.cand.mustPassFailures.length)}  passRate ${full.cand.passRate.toFixed(3)}  promote ${String(full.verdict.promote)}\n` +
      `gamed, axis 3 gone-> mustPassFailures ${String(twoAxis.cand.mustPassFailures.length)}  passRate ${twoAxis.cand.passRate.toFixed(3)}  promote ${String(twoAxis.verdict.promote)}`,
  );
});

// ── the pin's own refusals ───────────────────────────────────────────────────

test("A CHANNEL NO VERIFIER READS KEEPS ITS BYTE PIN — VerifierPin note 2, driven", async () => {
  const b = bench();
  const runs = await record(b, 4);
  const suite = suiteOf(b, runs, true);
  const r = await runEvalSuite({ store: b.store, suite, graph: b.noisy, engine: engineFor(b) });

  // The pin HOLDS — the same verifier, the same input, still `pass` — so `picked` is waived
  // exactly as it is for the honest candidate. `note` is read by nothing, so it is not
  // `certifies` and the floor it had is the floor it keeps.
  assert.equal(r.mustPassFailures.length, 4);
  const reasons = r.cases[0]!.reasons;
  assert.deepEqual(reasons, ['channel "note" differs']);
});

test("a pin that FAILS waives nothing — the case falls back to the byte pin it had", async () => {
  const b = bench();
  const runs = await record(b, 4);

  // A pin whose `verifier` digest names a verifier this candidate does not have. Axis 1 fails,
  // so `certifies` is not honoured and `channels` is compared again — both reasons appear.
  const mangled = suiteOf(b, runs, true, (pins) => pins.map((p) => ({ ...p, verifier: "sha256:0" as never })));
  const r = await runEvalSuite({ store: b.store, suite: mangled, graph: b.honest, engine: engineFor(b) });
  const reasons = r.cases[0]!.reasons.join(" | ");
  assert.match(reasons, /is not the one that certified this case/);
  assert.match(reasons, /channel "picked" differs/, "a broken pin must not waive the floor the case already had");
});

test("verificationPin refuses a recording whose verifier reads no graph input — axis 3 would be empty", async () => {
  const b = bench();
  const runs = await record(b, 1);
  // The same graph with the evaluator's read of the INPUT removed: it now grades `picked` against
  // nothing outside the graph, so there is no fact a pin could hold the candidate to.
  const narrowed = compileOrThrow({
    spec: {
      ...b.baseline.spec,
      nodes: b.baseline.spec.nodes.map((n) => (n.id === "check" ? { ...n, reads: ["picked"] } : n)),
    } as GraphSpec,
    // THE SAME RESOLVER, deliberately: with an empty one the pin would be refused by condition 2
    // (the body's digest is unknowable) and this test would be measuring the wrong refusal.
    resolver: b.resources,
    tools: {},
  });
  assert.notEqual(
    narrowed.resolutionManifest.find((r) => r.ref === "function/check@stable"),
    undefined,
    "the manifest must still resolve the verifier, or condition 5 is not what is being measured",
  );
  assert.equal(verificationPin(narrowed, runs[0]!.p), undefined);
});

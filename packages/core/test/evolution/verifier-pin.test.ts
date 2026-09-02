/**
 * TODO A.29 — a frozen golden case pinned the whole work channel VERBATIM, so a candidate whose
 * every run the graph's OWN deterministic verifier certifies as `pass` was refused by
 * `1-must-pass` and reported as a regression. This file is the measurement of the repair and of
 * the two ways it could have gone wrong.
 *
 * TEN DRIVES OVER TWO GRAPH FAMILIES. The first seven share one corpus shape, so their numbers
 * are directly comparable:
 *
 *   1. the byte pin alone, against the honest candidate  → the FALSE NEGATIVE this row exists for;
 *   2. the three-axis pin, against the honest candidate  → it must PROMOTE;
 *   3. the three-axis pin, against a candidate that games it → it must REFUSE, naming `fed`;
 *   4. the same gaming candidate against a pin whose third axis is VACUOUS — present in shape,
 *      pinned to the value the candidate itself produces → it PASSES, which is the previously
 *      refused two-axis answer re-driven rather than quoted, and the reason `fed` exists;
 *   5. the honest reorder PLUS an edit to `note`, a channel no verifier reads → still REFUSED,
 *      which is `VerifierPin` note 2 measured rather than asserted;
 *   6. a suite file that WIDENS `certifies` past what the verifier reads → the widening is
 *      ignored, because `waivedBy` recomputes the set and the file only ever narrows it;
 *   7. a candidate that SPOILS the graded channel after the grader ran → REFUSED, which is the
 *      waiver's own blind spot — the byte pin is lifted from the run's FINAL value while the
 *      grader certified the value it was SERVED.
 *
 * The last three are the CANONICAL EVAL TOPOLOGY — a `fixture` node writing the ground truth, a
 * `work` node writing the answer, a comparator reading both — which is where the first
 * three-axis pin was still gameable and where `VerifierPin` note 5 is measured:
 *
 *   8. a candidate that rewrites BOTH SIDES of the comparison to the same garbage → REFUSED,
 *      because a verifier reading two produced channels is not pinned at all and the byte pin
 *      it never lifted is what refuses it;
 *   9. the same topology with the ground truth as a graph INPUT instead of a fixture node, and
 *      a candidate that rewrites that input → REFUSED by axis 3;
 *  10. the same topology, honest candidate → PROMOTED, which is what says note 5 narrowed the
 *      pin rather than deleting it.
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

import { digest } from "../../src/canonical.ts";
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

/**
 * THE CANDIDATE THAT SPOILS THE GRADED CHANNEL AFTER IT WAS GRADED. `pick` and `check` are both
 * byte-identical to the baseline, so the grader certifies the good value; a node the baseline
 * does not have then overwrites `picked` downstream of the barrier. The waiver lifts the byte
 * comparison from the run's FINAL value, which is not the value the grader saw.
 */
const SPOIL = `() => ({ writes: { picked: ["GARBAGE"] } })`;

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

/** The baseline plus a node that overwrites `picked` after `check` has run. */
function spoiledSpec(): GraphSpec {
  const clean = spec("function/pick@stable", ["picked", "note"]);
  return {
    ...clean,
    nodes: [
      ...clean.nodes,
      { id: "spoil", type: "function", reads: ["verdict"], writes: ["picked"], function: { ref: "function/spoil@stable" } },
    ],
    edges: [...clean.edges, { id: "e2", from: "check", to: "spoil", kind: "seq" }],
  } as unknown as GraphSpec;
}

interface Bench {
  readonly resources: ResourceStore;
  readonly baseline: RunGraph;
  readonly honest: RunGraph;
  readonly gamed: RunGraph;
  readonly noisy: RunGraph;
  readonly spoiled: RunGraph;
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
  publish("spoil", SPOIL);
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
    spoiled: compileOf(spoiledSpec()),
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
function suiteOf(
  b: Bench,
  runs: { runId: RunId; p: RunProjection }[],
  withPin: boolean,
  // The RECORDING is handed to the mangle as well as the pins, because a mangle that has to name
  // a value this case actually produced cannot get it from the pin — a digest is one way.
  mangle?: (pins: readonly VerifierPin[], recording: RunProjection) => readonly VerifierPin[],
): EvalSuite {
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
        ...(withPin ? { verifiedBy: mangle === undefined ? pins : mangle(pins, p) } : {}),
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

test("A.29: a candidate that rewrites what FED the verifier is refused — and passes against a vacuous axis 3", async () => {
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

  // AXIS 3 EMPTIED — and the pin now waives NOTHING, which is `fed` being load-bearing twice.
  // It is a check, and it is also the record of which reads the recording served from OUTSIDE
  // the graph: `waivedBy` derives the produced set as `reads \ fed`, from the RECORDING's own
  // facts rather than from the candidate's spec, so a pin with no third axis cannot say which
  // channel it is entitled to waive and therefore waives none. The game is refused, by the byte
  // pin it never lifted.
  const twoAxis = await drive(b, suiteOf(b, runs, true, (pins) => pins.map((p) => ({ ...p, fed: {} }))), b.gamed);
  assert.equal(twoAxis.cand.mustPassFailures.length, 8);
  assert.equal(twoAxis.verdict.promote, false);
  assert.match(twoAxis.cand.cases[0]!.reasons.join(" | "), /channel "picked" differs/);

  // THE PREVIOUSLY REFUSED ANSWER, RE-DRIVEN RATHER THAN QUOTED — a pin that says WHO the
  // verifier is and WHAT IT SAID and does not hold its input to the RECORDING's value. Axis 3 is
  // present in shape and vacuous in fact: `fed` names the channel, pinned to the value the
  // GAMING CANDIDATE leaves there. Axes 1 and 2 are clean by construction — the evaluator is
  // byte-identical and still says pass — so the waiver is granted and the grader certifies
  // garbage. `verificationPin` cannot mint this pin; it is what a two-axis pin amounts to.
  const vacuous = suiteOf(b, runs, true, (pins, recording) =>
    pins.map((pin) => ({ ...pin, fed: { items: digest((recording.channels["items"] as string[]).slice(0, 1)) } })),
  );
  const twoAxisReal = await drive(b, vacuous, b.gamed);
  assert.deepEqual(twoAxisReal.cand.mustPassFailures, [], "a pin that does not hold the verifier's input to the recording certifies garbage");
  assert.equal(twoAxisReal.cand.passRate, 1);
  assert.equal(twoAxisReal.verdict.promote, true);

  console.log(
    `gamed, three axes   -> mustPassFailures ${String(full.cand.mustPassFailures.length)}  passRate ${full.cand.passRate.toFixed(3)}  promote ${String(full.verdict.promote)}\n` +
      `gamed, fed emptied  -> mustPassFailures ${String(twoAxis.cand.mustPassFailures.length)}  passRate ${twoAxis.cand.passRate.toFixed(3)}  promote ${String(twoAxis.verdict.promote)}\n` +
      `gamed, fed vacuous  -> mustPassFailures ${String(twoAxisReal.cand.mustPassFailures.length)}  passRate ${twoAxisReal.cand.passRate.toFixed(3)}  promote ${String(twoAxisReal.verdict.promote)}`,
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

test("THE GRADED CHANNEL IS SPOILED AFTER IT WAS GRADED — VerifierPin note 6, driven", async () => {
  const b = bench();
  const runs = await record(b, 6);
  const suite = suiteOf(b, runs, true);

  // The candidate keeps `pick` and `check` byte-identical and adds a node DOWNSTREAM of the
  // barrier that overwrites `picked`. Every axis is clean and the grader really did say `pass`
  // on the good value — what refuses it is condition 8, which will not waive a channel a node
  // outside the verifier's ancestry writes.
  const r = await runEvalSuite({ store: b.store, suite, graph: b.spoiled, engine: engineFor(b) });
  assert.equal(r.mustPassFailures.length, 6, "a candidate that spoils the graded channel after grading must be refused");
  assert.deepEqual(r.cases[0]!.reasons, ['channel "picked" differs']);
  const replayed = r.cases[0]!.replay.replayed;
  assert.deepEqual(replayed.channels["picked"], ["GARBAGE"], "…and the run really did end with the garbage in it");
  assert.equal((replayed.channels["verdict"] as { pass?: unknown }).pass, true, "…which the graph's own verifier certified, before the spoiler ran");

  // AND THE PIN IS STILL MINTED FOR THE HONEST GRAPH: condition 8 is about the CANDIDATE's
  // edges, so the baseline recording carries a pin exactly as it did.
  assert.notEqual(suite.cases[0]!.expect.verifiedBy, undefined);
  // …while a RECORDING made by the spoiling graph carries none, which is the same condition
  // asked at freeze rather than at check.
  const spoiledRunId = await b.engine.submit({ graph: b.spoiled, inputs: { items: ["a", "b", "c"] } });
  await b.engine.advance(spoiledRunId);
  const events: JournalEvent[] = [];
  for await (const ev of b.store.read(spoiledRunId, 1 as Seq)) events.push(ev);
  assert.equal(verificationPin(b.spoiled, foldRun(events)!), undefined, "a graph that spoils its own graded channel cannot be pinned");

  console.log(
    `spoiled after grading -> mustPassFailures ${String(r.mustPassFailures.length)}  ` +
      `reasons ${JSON.stringify(r.cases[0]!.reasons)}  final picked ${JSON.stringify(replayed.channels["picked"])}  ` +
      `verifier said pass=${String((replayed.channels["verdict"] as { pass?: unknown }).pass)}`,
  );
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

test("A SUITE FILE CANNOT WIDEN THE WAIVER — `certifies` only ever narrows what `waivedBy` derives", async () => {
  const b = bench();
  const runs = await record(b, 4);

  // THE WIDENING, DRIVEN. `certifies` is read verbatim out of a JSON file; append the name of a
  // channel the verifier does not read and the old code waived it. `note` is written by `pick`
  // and read by nobody, so nothing in this run's own answer justifies lifting its byte pin.
  const widened = suiteOf(b, runs, true, (pins) => pins.map((pin) => ({ ...pin, certifies: [...pin.certifies, "note"] })));
  const r = await runEvalSuite({ store: b.store, suite: widened, graph: b.noisy, engine: engineFor(b) });
  assert.equal(r.mustPassFailures.length, 4, "a file that names a channel the verifier never read must not waive it");
  assert.deepEqual(r.cases[0]!.reasons, ['channel "note" differs']);

  // AND THE OTHER DIRECTION: a file that names LESS than the verifier reads is honoured, because
  // narrowing a waiver is always allowed. `picked` is dropped from `certifies`, so it keeps the
  // byte pin and the honest reorder is refused for it.
  const narrowed = suiteOf(b, runs, true, (pins) => pins.map((pin) => ({ ...pin, certifies: [] })));
  const r2 = await runEvalSuite({ store: b.store, suite: narrowed, graph: b.honest, engine: engineFor(b) });
  assert.equal(r2.mustPassFailures.length, 4);
  assert.deepEqual(r2.cases[0]!.reasons, ['channel "picked" differs']);

  console.log(
    `certifies widened  -> mustPassFailures ${String(r.mustPassFailures.length)}  reasons ${JSON.stringify(r.cases[0]!.reasons)}\n` +
      `certifies narrowed -> mustPassFailures ${String(r2.mustPassFailures.length)}  reasons ${JSON.stringify(r2.cases[0]!.reasons)}`,
  );
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

// ═════════════════════════════════════════════════════════════════════════════
// 7 + 8 + 9 · THE CANONICAL EVAL TOPOLOGY — a fixture, a work node, a comparator
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The ground truth, written by a node INSIDE the graph. That is the whole difference from the
 * family above, and it is the one that decides whether the candidate owns both sides.
 */
const FIXTURE = `(view) => ({ writes: { expected: (view.get("query") ?? []).slice() } })`;
const WORK = `(view) => {
  const q = view.get("query") ?? [];
  return { writes: { answer: q.slice(), note: { n: q.length } } };
}`;

/** Exact equality, which is what a comparator in this topology usually is. */
const COMPARE = `(view) => {
  const e = JSON.stringify(view.get("expected") ?? null);
  const a = JSON.stringify(view.get("answer") ?? null);
  return { writes: { verdict: { pass: e === a, confidence: 1 } } };
}`;

/**
 * THE CANDIDATE THAT OWNS BOTH SIDES. The comparator is byte-identical and still says `pass`;
 * the ground truth and the answer are the same garbage. Every axis a three-axis pin has is clean:
 * the same verifier, the same verdict, and the one channel it reads from outside the graph
 * (`query`) is untouched. Only condition 7 sees it.
 */
const FIXTURE_GARBAGE = `(view) => ({ writes: { expected: ["GARBAGE"] } })`;
const WORK_GARBAGE = `(view) => {
  const q = view.get("query") ?? [];
  return { writes: { answer: ["GARBAGE"], note: { n: q.length } } };
}`;

/**
 * The same comparator with the ground truth moved OUT of the graph and into `inputs`, and set
 * equality rather than sequence equality so the family has an honest candidate at all. Replay
 * serves `expected` from the recording, and axis 3 pins it.
 */
const COMPARE_SET = `(view) => {
  const e = JSON.stringify([...(view.get("expected") ?? [])].sort());
  const a = JSON.stringify([...(view.get("answer") ?? [])].sort());
  return { writes: { verdict: { pass: e === a, confidence: 1 } } };
}`;
const WORK_REORDERED = `(view) => {
  const q = view.get("query") ?? [];
  return { writes: { answer: q.slice().reverse(), note: { n: q.length } } };
}`;
/** Rewrites the grader's input where the truth IS a graph input — the game axis 3 exists for. */
const WORK_REWRITES_TRUTH = `(view) => {
  const q = view.get("query") ?? [];
  return { writes: { expected: ["GARBAGE"], answer: ["GARBAGE"], note: { n: q.length } } };
}`;

const EVAL_CHANNELS = {
  query: { type: "array", reduce: "replace" },
  expected: { type: "array", reduce: "replace" },
  answer: { type: "array", reduce: "replace" },
  note: { type: "object", reduce: "replace" },
  verdict: { type: "object", reduce: "replace" },
};

const evalHead = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "eval-bench", project: "demo", version: 1 },
  policy: { posture: "out", capabilities: [] },
  channels: EVAL_CHANNELS,
  outputs: ["verdict"],
};

const CHECK_NODE = (ref: string) => ({
  id: "check",
  type: "evaluator",
  reads: ["query", "expected", "answer"],
  writes: ["verdict"],
  evaluator: { kind: "assertion", ref, threshold: 0.5 },
});

/** THE REVIEWER'S PROBE, as a graph: the fixture writes the truth and the work node the answer. */
function twoSidedSpec(fixtureRef: string, workRef: string): GraphSpec {
  return {
    ...evalHead,
    inputs: ["query"],
    nodes: [
      { id: "fixture", type: "function", reads: ["query"], writes: ["expected"], function: { ref: fixtureRef } },
      { id: "work", type: "function", reads: ["query"], writes: ["answer", "note"], function: { ref: workRef } },
      CHECK_NODE("function/compare@stable"),
    ],
    edges: [
      { id: "e1", from: "fixture", to: "check", kind: "seq" },
      { id: "e2", from: "work", to: "check", kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

/** The same exam with the truth declared an INPUT, which is the shape the pin is entitled to. */
function inputTruthSpec(workRef: string, workWrites: readonly string[]): GraphSpec {
  return {
    ...evalHead,
    inputs: ["query", "expected"],
    nodes: [
      { id: "work", type: "function", reads: ["query"], writes: workWrites, function: { ref: workRef } },
      CHECK_NODE("function/compare-set@stable"),
    ],
    edges: [{ id: "e1", from: "work", to: "check", kind: "seq" }],
  } as unknown as GraphSpec;
}

interface EvalBench {
  readonly store: MemoryStateStore;
  readonly engine: Engine;
  readonly engineOpts: { tools: ToolRegistry; functions: FunctionRegistry; models: ModelRegistry };
  readonly twoSided: RunGraph;
  readonly twoSidedGamed: RunGraph;
  readonly truthIsInput: RunGraph;
  readonly truthIsInputHonest: RunGraph;
  readonly truthIsInputGamed: RunGraph;
}

function evalBench(): EvalBench {
  const resources = new ResourceStore({ now: () => 1 });
  const publish = (name: string, content: string): void => {
    const ref = resources.publish({ kind: "function", name, content, actor: ACTOR });
    resources.promote(ref, "canary", ACTOR);
    resources.promote(ref, "stable", ACTOR);
  };
  publish("fixture", FIXTURE);
  publish("fixture-garbage", FIXTURE_GARBAGE);
  publish("work", WORK);
  publish("work-garbage", WORK_GARBAGE);
  publish("work-reordered", WORK_REORDERED);
  publish("work-rewrites-truth", WORK_REWRITES_TRUTH);
  publish("compare", COMPARE);
  publish("compare-set", COMPARE_SET);

  const functions = new FunctionRegistry();
  const loader = createFunctionLoader({ store: resources });
  for (const version of resources.list({ kind: "function" })) {
    const ref = `function/${version.name}@stable`;
    const body = loader.load(ref);
    if (body !== undefined) functions.register(ref, body);
  }

  const compileOf = (spec: GraphSpec): RunGraph => compileOrThrow({ spec, resolver: resources, tools: {} });
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const tools = new ToolRegistry();
  const models = new ModelRegistry();
  return {
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
    twoSided: compileOf(twoSidedSpec("function/fixture@stable", "function/work@stable")),
    twoSidedGamed: compileOf(twoSidedSpec("function/fixture-garbage@stable", "function/work-garbage@stable")),
    truthIsInput: compileOf(inputTruthSpec("function/work@stable", ["answer", "note"])),
    truthIsInputHonest: compileOf(inputTruthSpec("function/work-reordered@stable", ["answer", "note"])),
    truthIsInputGamed: compileOf(inputTruthSpec("function/work-rewrites-truth@stable", ["answer", "note", "expected"])),
  };
}

/**
 * THE CASE `loom suite freeze` WOULD WRITE FOR ONE RECORDING, derived the way the verb derives
 * it: every recorded channel except the ones an `evaluator` node wrote and the graph's declared
 * inputs, plus the pin when `verificationPin` mints one. Written generically here rather than
 * copied per family, so a family that gets NO pin is one this helper reports rather than hides.
 */
function caseFor(graph: RunGraph, i: number, runId: RunId, p: RunProjection): EvalCase {
  const graderWrote = new Set(graph.spec.nodes.filter((n) => n.type === "evaluator").flatMap((n) => n.writes ?? []));
  const inputs = new Set<string>(graph.spec.inputs);
  const channels = Object.fromEntries(Object.entries(p.channels).filter(([c]) => !graderWrote.has(c) && !inputs.has(c)));
  const pins = verificationPin(graph, p);
  return {
    id: `case-${String(i)}`,
    runId,
    mustPass: true,
    expect: { status: "succeeded" as const, channels, ...(pins === undefined ? {} : { verifiedBy: pins }) },
  };
}

async function recordEval(
  b: EvalBench,
  graph: RunGraph,
  n: number,
  inputsOf: (i: number) => Record<string, unknown>,
): Promise<{ suite: EvalSuite; pinned: number }> {
  const cases: EvalCase[] = [];
  let pinned = 0;
  for (let i = 0; i < n; i++) {
    const runId = await b.engine.submit({ graph, inputs: inputsOf(i) });
    await b.engine.advance(runId);
    const events: JournalEvent[] = [];
    for await (const ev of b.store.read(runId, 1 as Seq)) events.push(ev);
    const p = foldRun(events);
    assert.ok(p !== undefined && p.status === "succeeded", `run ${String(i)} did not succeed`);
    assert.equal((p.channels["verdict"] as { pass?: unknown }).pass, true, `run ${String(i)}: the baseline must certify itself`);
    const kase = caseFor(graph, i, runId, p);
    if (kase.expect.verifiedBy !== undefined) pinned++;
    cases.push(kase);
  }
  return {
    suite: { name: "eval-bench", version: 1, frozen: true, frozenAt: 1_000, generatedBy: "the-corpus", cases },
    pinned,
  };
}

async function driveEval(b: EvalBench, suite: EvalSuite, baseline: RunGraph, candidate: RunGraph) {
  const opts = { ...b.engineOpts, policy: { granted: [] } };
  const base = await runEvalSuite({ store: b.store, suite, graph: baseline, engine: opts });
  const cand = await runEvalSuite({ store: b.store, suite, graph: candidate, engine: opts });
  const verdict = gateCandidate({
    baseline: base,
    candidate: cand,
    proposedAt: suite.frozenAt + 1,
    proposedBy: "an-optimiser",
    postureDiffNonNegative: true,
    deterministic: true,
  });
  return { base, cand, verdict };
}

const QUERY = (i: number): Record<string, unknown> => ({
  query: Array.from({ length: 3 + (i % 2) }, (_, k) => `doc-${String(i)}-${String(k)}`),
});

test("THE CANDIDATE OWNS BOTH SIDES OF THE COMPARISON — VerifierPin note 5, driven", async () => {
  const b = evalBench();
  const { suite, pinned } = await recordEval(b, b.twoSided, 6, QUERY);

  // CONDITION 7 FIRED AT FREEZE. `check` reads `expected` and `answer`, both written by nodes in
  // this graph, so there is no single channel the pin could waive without waiving the grader's
  // own ground truth alongside it. No case carries a pin, and every one keeps the byte pin.
  assert.equal(pinned, 0, "a verifier reading two produced channels must not be pinned");
  for (const kase of suite.cases) {
    assert.equal(kase.expect.verifiedBy, undefined);
    assert.deepEqual(Object.keys(kase.expect.channels ?? {}).sort(), ["answer", "expected", "note"]);
  }

  // AND THE GAME IS REFUSED. The comparator is byte-identical, it still says `pass` on every
  // run, and `query` — the only channel it reads from outside the graph — is untouched. Axes 1,
  // 2 and 3 are all clean; what refuses it is the byte pin condition 7 declined to lift.
  const r = await driveEval(b, suite, b.twoSided, b.twoSidedGamed);
  assert.equal(r.base.passRate, 1, "the baseline must pass its own suite");
  assert.equal(r.cand.mustPassFailures.length, 6, "every case must refuse a candidate that grades its own garbage");
  assert.equal(r.verdict.promote, false);
  const reasons = r.cand.cases[0]!.reasons.join(" | ");
  assert.match(reasons, /channel "expected" differs/);
  assert.match(reasons, /channel "answer" differs/);
  // THE GAME REALLY IS A GAME: the grader certified the garbage. If this said `pass=false` the
  // test would be measuring an ordinary regression instead of the failure this row is about.
  const graded = r.cand.cases[0]!.replay.replayed.channels["verdict"] as { pass?: unknown };
  assert.equal(graded.pass, true, "the verifier certified the garbage — that is what makes this the game");

  console.log(
    `two-sided, gamed -> cases ${String(suite.cases.length)}  pinned ${String(pinned)}  ` +
      `mustPassFailures ${String(r.cand.mustPassFailures.length)}  promote ${String(r.verdict.promote)}  ` +
      `verifier said pass=${String(graded.pass)}`,
  );
});

test("THE TRUTH AS A GRAPH INPUT — the pin is minted, the honest candidate promotes, the rewrite is refused", async () => {
  const b = evalBench();
  const inputs = (i: number): Record<string, unknown> => {
    const q = (QUERY(i)["query"] as string[]);
    return { query: q, expected: q.slice() };
  };
  const { suite, pinned } = await recordEval(b, b.truthIsInput, 6, inputs);

  // CONDITION 7 IS SATISFIED HERE: `check` reads `query` and `expected` from outside the graph
  // and exactly one channel the graph produced, so `answer` is the one thing the pin waives.
  assert.equal(pinned, 6, "the truth is an input, so every case carries a pin");
  assert.deepEqual([...suite.cases[0]!.expect.verifiedBy![0]!.certifies], ["answer"]);
  assert.deepEqual(Object.keys(suite.cases[0]!.expect.verifiedBy![0]!.fed).sort(), ["expected", "query"]);

  // 9 · THE HONEST CANDIDATE. It reorders `answer`; the graph's own comparator is set equality,
  // so it certifies every run — and this is what says note 5 narrowed the pin rather than
  // deleting it. If this refused, the row's false negative would be back under a new name.
  const honest = await driveEval(b, suite, b.truthIsInput, b.truthIsInputHonest);
  assert.deepEqual(
    honest.cand.mustPassFailures,
    [],
    `expected no must-pass failure, got ${JSON.stringify(honest.cand.cases.filter((c) => !c.pass).map((c) => c.reasons))}`,
  );
  assert.equal(honest.verdict.promote, true, JSON.stringify(honest.verdict.checks.filter((c) => !c.pass)));

  // 8 · THE SAME CANDIDATE PLUS A REWRITE OF THE GROUND TRUTH, which is now an input the
  // candidate writes over. Axis 3 is what sees it.
  const gamed = await driveEval(b, suite, b.truthIsInput, b.truthIsInputGamed);
  assert.equal(gamed.cand.mustPassFailures.length, 6);
  assert.equal(gamed.verdict.promote, false);
  assert.match(
    gamed.cand.cases[0]!.reasons.join(" | "),
    /rewrote channel "expected", which is what FED the verifier "check"/,
  );
  assert.equal(
    (gamed.cand.cases[0]!.replay.replayed.channels["verdict"] as { pass?: unknown }).pass,
    true,
    "the grader certified this too — axis 3 is what refuses it, not the verdict",
  );

  console.log(
    `truth-as-input, honest -> pinned ${String(pinned)}  mustPassFailures ${String(honest.cand.mustPassFailures.length)}  ` +
      `passRate ${honest.cand.passRate.toFixed(3)}  promote ${String(honest.verdict.promote)}\n` +
      `truth-as-input, gamed  -> mustPassFailures ${String(gamed.cand.mustPassFailures.length)}  ` +
      `passRate ${gamed.cand.passRate.toFixed(3)}  promote ${String(gamed.verdict.promote)}`,
  );
});

/**
 * A SPENDING CEILING THE REPLAYED CORPUS NEVER REACHED IS A CEILING NO RECORDING CAN VOUCH FOR.
 *
 * TODO A.23's second half. The turns half closed inside `runCase`: lowering `agent.maxTurns`
 * leaves recorded effects UNSERVED, and `unexercised` reads them. The budget half has no such
 * evidence, and the obvious fail-closed answer — refuse any different-graph candidate that
 * DECLARES a budget — was measured and refused, because `test/run/skeleton.ts`'s `summarize`
 * declares one, both graphs the loop is driven on declare one, and `GRAPH009_UNBOUNDED_NODE`
 * tells authors to add one. That answer turns the offline gate off for every well-formed graph.
 *
 * THE DEFECT, DRIVEN ON THIS FIXTURE BEFORE THE CHECK EXISTED — the survey TODO A.23 records:
 *
 *     baseline   node "summarize" policy.budget.costUsd 0.15  -> passRate 1  reasons []
 *     candidate                                        0.01   -> passRate 1  reasons []  PROMOTE
 *     the corpus spends $0.001125, so 0.01 is never within reach of anything the replay did
 *
 * A 15x tightening, a different `graphHash`, twelve green checks, and nothing measured the one
 * thing that changed.
 *
 * WHERE THE ANSWER LIVES, AND WHY NOT IN `runCase`. `runCase` holds ONE graph. It cannot tell
 * "the candidate lowered the ceiling" from "the candidate kept it and changed a body" — which is
 * why A.23 read the missing `run.compiled` spec (A.24) as the blocker. That blocker does not bind
 * at `loom promote --suite`: that door compiles a `--baseline` AND a candidate and hands each to
 * `runEvalSuite`. So each `EvalReport` now carries its graph's ceilings and `gateCandidate` diffs
 * them, which is a comparison of two SPECS made without asking the journal anything and without a
 * line of change at the call site.
 *
 * WHAT THIS FILE HOLDS DOWN — the refusals, then the controls, because a guard that refuses
 * everything is not fail-closed, it is off:
 *
 * 1. The 15x TIGHTENING is refused, and `11-budget-exercised` is the ONLY check that refuses it.
 * 2. The two LOOSENINGS nobody had noticed are refused too — a raised ceiling and a deleted one.
 *    `3-cost` cannot see either: a replay is served from the recording, so it reports the
 *    baseline's cost to the penny however much headroom the candidate gave itself.
 * 3. CONTROL — a changed deterministic `function` body still promotes. This is the only candidate
 *    class the offline gate can judge without spending a model call, and it is what the blanket
 *    refusal would have cost.
 * 4. THE ASYMMETRY IN `movedCeilings`, both halves, because each is the other's justification.
 *    CONTROL — a scope only the CANDIDATE has is not a moved ceiling: that is the shape
 *    `graph/mutate.ts` produces, so the loop's own operator still gets through. REFUSAL — a scope
 *    only the BASELINE has is a cap that LEFT. Skipping that one let a RENAME carry a ceiling out
 *    of the comparison, and the check answered `pass: true, no spending ceiling moved` about a
 *    hundredfold raise. The affirmative claim is the damage; silence would only have been unhelpful.
 * 5. A report that does not state its ceilings at all is REFUSED rather than thrown on — for
 *    `undefined` AND for `null`, on either side. The first version threw, and a `TypeError` out of
 *    `gateCandidate` is not a guard failing closed. The guard that replaced it tested `!==
 *    undefined` and let `null` throw the byte-identical error, which is why the test is a shape.
 * 6. THE MEASUREMENT BEHIND THE MISSING EVIDENCE BRANCH: a ceiling the corpus DOES cross fails
 *    the case, so "exercised and still passing" is an empty set and there is no branch to write.
 *
 * Offline and deterministic: the mock adapter, in-memory journals, no clock read.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { gateCandidate, runEvalSuite, type EvalReport, type EvalSuite } from "../../src/evolution/gate.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { NodeId, RunId } from "../../src/ids.ts";
import { DOCS, compileSkeleton, harness, skeletonSpec } from "../run/skeleton.ts";

const engineOf = (h: ReturnType<typeof harness>) => ({
  tools: h.engine.tools,
  functions: h.engine.functions,
  models: h.engine.models,
  policy: { granted: ["fs:read", "fs:write"] },
});

async function recordRun(h: ReturnType<typeof harness>, graph: RunGraph): Promise<RunId> {
  const runId = await h.engine.submit({ graph, inputs: { paths: DOCS } });
  const gated = await h.engine.advance(runId);
  const gate = Object.values(gated.gates).find((g) => g.state === "open");
  if (gate !== undefined) {
    await h.engine.resolveGate(runId, {
      gateId: gate.gateId,
      decision: { kind: "approve" },
      actor: { kind: "human", subject: "u:alice", via: "console" },
      idempotencyKey: "k",
    });
  }
  return runId;
}

function suiteOver(ids: readonly RunId[]): EvalSuite {
  return {
    name: "skeleton",
    version: 1,
    frozen: true,
    frozenAt: 1_000,
    generatedBy: "maintainer",
    cases: ids.map((runId, i) => ({
      id: `c${String(i)}`,
      runId,
      mustPass: i === 0,
      expect: { status: "succeeded" as const, noIrreversibleWithoutGate: true },
    })),
  };
}

const decide = (baseline: EvalReport, candidate: EvalReport) =>
  gateCandidate({
    baseline,
    candidate,
    proposedAt: 2_000,
    proposedBy: "optimiser",
    promptGrowth: 0,
    postureDiffNonNegative: true,
    deterministic: true,
  });

/**
 * The skeleton with `summarize`'s spending ceiling replaced, or removed.
 *
 * `undefined` deletes `policy` entirely rather than writing `policy: {budget: {}}` — an empty
 * budget object is a different spec from no budget at all, and the case this file is about is
 * the author who takes the cap OFF.
 */
function withBudget(costUsd: number | undefined): RunGraph {
  const base = skeletonSpec();
  const nodes = base.nodes.map((nd) => {
    if (nd.id !== ("summarize" as NodeId)) return nd;
    const { policy: _drop, ...rest } = nd;
    return costUsd === undefined ? rest : { ...rest, policy: { budget: { costUsd } } };
  });
  return compileSkeleton(skeletonSpec({ nodes }) as GraphSpec);
}

/** Three recordings under the baseline's own ceiling, and the suite over them. */
async function corpus(h: ReturnType<typeof harness>, baselineGraph: RunGraph): Promise<EvalSuite> {
  const ids: RunId[] = [];
  for (let i = 0; i < 3; i++) ids.push(await recordRun(h, baselineGraph));
  return suiteOver(ids);
}

test("A LOWERED CEILING THE CORPUS NEVER REACHED IS REFUSED — and it is the only check that refuses it", async () => {
  const h = harness();
  const baselineGraph = withBudget(0.15);
  const suite = await corpus(h, baselineGraph);

  const candidateGraph = withBudget(0.01);
  assert.notEqual(candidateGraph.graphHash, baselineGraph.graphHash, "the premise: it IS a different graph");

  const baseline = await runEvalSuite({ store: h.store, suite, graph: baselineGraph, engine: engineOf(h) });
  const candidate = await runEvalSuite({ store: h.store, suite, graph: candidateGraph, engine: engineOf(h) });

  // THE SURVEY, RE-RUN. The per-case door sees nothing at all: same pass rate, same cost, no
  // reason of any kind. That is not a bug in `unexercised` — a replay of a 15x-tighter ceiling
  // really does ask every question the recording asked, and answers them from the recording.
  assert.equal(baseline.passRate, 1, JSON.stringify(baseline.cases.map((c) => c.reasons)));
  assert.equal(candidate.passRate, 1, JSON.stringify(candidate.cases.map((c) => c.reasons)));
  assert.deepEqual(candidate.cases[0]!.reasons, [], "the case has nothing to say about it");
  assert.deepEqual(candidate.cases[0]!.replay.unservedEffects, [], "nothing went unasked — this is not the maxTurns shape");
  assert.equal(candidate.totalCostUsd, baseline.totalCostUsd, "and the replay spends the recording's money either way");

  // THE REFUSAL, at the door that has both specs.
  const v = decide(baseline, candidate);
  assert.deepEqual(
    v.checks.filter((c) => !c.pass).map((c) => c.id),
    ["11-budget-exercised"],
    "every OTHER criterion is green, which is exactly why the certificate was unearned",
  );
  assert.equal(v.promote, false);

  const detail = v.checks.find((c) => c.id === "11-budget-exercised")!.detail;
  assert.match(detail, /node:summarize\.costUsd 0\.15 → 0\.01/, "the refusal names the scope, the dimension and both numbers");
  assert.match(detail, /--against-cohort/, "and says what to do next");
});

test("THE THREE LOOSENINGS ARE REFUSED TOO — a raised node ceiling, a raised RUN ceiling, and a deleted cap", async () => {
  const h = harness();
  const baselineGraph = withBudget(0.15);
  const suite = await corpus(h, baselineGraph);
  const baseline = await runEvalSuite({ store: h.store, suite, graph: baselineGraph, engine: engineOf(h) });

  // A NODE CEILING RAISED TO THE MOST THE COMPILER WILL ALLOW. `GRAPH009_BUDGET_OVERCOMMIT`
  // sums per-node budgets times max instances against the graph's own, and this fanout has
  // `maxWidth: 5` under a $1.00 graph budget, so $0.20 is the ceiling on the ceiling. That is
  // the constraint on this fixture, not on the check.
  const raised = await runEvalSuite({ store: h.store, suite, graph: withBudget(0.2), engine: engineOf(h) });
  assert.equal(raised.passRate, 1, JSON.stringify(raised.cases.map((c) => c.reasons)));
  const vr = decide(baseline, raised);
  assert.deepEqual(vr.checks.filter((c) => !c.pass).map((c) => c.id), ["11-budget-exercised"]);
  assert.match(vr.checks.find((c) => c.id === "11-budget-exercised")!.detail, /node:summarize\.costUsd 0\.15 → 0\.2/);

  // THE RUN CEILING, TENFOLD — the `graph` scope, which no per-node fixture reaches, and the
  // one the compiler's overcommit arithmetic does not bound from above.
  const spec = skeletonSpec();
  const wide = compileSkeleton(
    skeletonSpec({ policy: { ...spec.policy!, budget: { ...spec.policy!.budget!, costUsd: 10 } } }),
  );
  const widened = await runEvalSuite({ store: h.store, suite, graph: wide, engine: engineOf(h) });
  assert.equal(widened.passRate, 1, JSON.stringify(widened.cases.map((c) => c.reasons)));
  const vw = decide(baseline, widened);
  assert.deepEqual(vw.checks.filter((c) => !c.pass).map((c) => c.id), ["11-budget-exercised"]);
  assert.match(vw.checks.find((c) => c.id === "11-budget-exercised")!.detail, /graph\.costUsd 1 → 10/);
  // THE REASON `3-cost` IS NOT THE ANSWER, stated as a number rather than as an argument: a run
  // allowed to spend ten times as much reports the recording's cost to the penny, because a
  // replay makes no provider calls at all.
  assert.equal(widened.totalCostUsd, baseline.totalCostUsd);
  assert.equal(vw.checks.find((c) => c.id === "3-cost")!.pass, true, "the cost check is green on a 10x wider run ceiling");

  // AND THE CAP TAKEN OFF ALTOGETHER, which is the largest loosening a budget admits — and the
  // one `validate.ts` calls "the cheapest way to silence the warning".
  const uncapped = await runEvalSuite({ store: h.store, suite, graph: withBudget(undefined), engine: engineOf(h) });
  assert.equal(uncapped.passRate, 1, JSON.stringify(uncapped.cases.map((c) => c.reasons)));
  const vu = decide(baseline, uncapped);
  assert.deepEqual(vu.checks.filter((c) => !c.pass).map((c) => c.id), ["11-budget-exercised"]);
  assert.match(
    vu.checks.find((c) => c.id === "11-budget-exercised")!.detail,
    /node:summarize\.costUsd was capped at 0\.15 and this candidate removes the cap/,
  );
});

test("CONTROL · a candidate that changes a deterministic FUNCTION body still promotes", async () => {
  // THE CANDIDATE CLASS THE BLANKET REFUSAL WOULD HAVE COST. This graph's `summarize` declares
  // `budget.costUsd: 0.15` on BOTH sides — refusing "declares a budget" refuses this — while the
  // change itself is a function body, which re-executes under replay and is therefore the one
  // kind of candidate this gate really measures.
  const h = harness();
  // The defect is in `count` and not in `markdown` on purpose: `write` is called with
  // `${merged.markdown}`, and a recorded tool result is bound to the arguments it answered
  // (`tool.called.argsDigest`) — a body whose output reaches a tool call is judgeable offline
  // only while that call stays the recorded one.
  h.functions.register("function/merge-v1@stable", (view) => {
    const ds = view.get<{ path: string; summary: string }[]>("digests") ?? [];
    return { writes: { merged: { count: ds.length - 1, markdown: ds.map((d) => `## ${d.path}\n${d.summary}`).join("\n\n") } } };
  });
  h.functions.register("function/merge-v2@stable", (view) => {
    const ds = view.get<{ path: string; summary: string }[]>("digests") ?? [];
    return { writes: { merged: { count: ds.length, markdown: ds.map((d) => `## ${d.path}\n${d.summary}`).join("\n\n") } } };
  });
  const withMerge = (ref: string): RunGraph => {
    const base = skeletonSpec();
    return compileSkeleton(
      skeletonSpec({ nodes: base.nodes.map((nd) => (nd.id === ("merge" as NodeId) ? { ...nd, function: { ref } } : nd)) }),
    );
  };

  const suite = await corpus(h, withMerge("function/merge-v1@stable"));
  const baseline = await runEvalSuite({ store: h.store, suite, graph: withMerge("function/merge-v1@stable"), engine: engineOf(h) });
  const candidate = await runEvalSuite({ store: h.store, suite, graph: withMerge("function/merge-v2@stable"), engine: engineOf(h) });

  const v = decide(baseline, candidate);
  assert.equal(v.checks.find((c) => c.id === "11-budget-exercised")!.pass, true);
  // "BASELINE SCOPE(S)", not "compared". The count is `Object.keys(baseline.budgets).length`,
  // and it read "7 scope(s) compared" while `movedCeilings` had skipped any scope the candidate
  // lacked — so the number was read as coverage and was not. Renaming it was cheaper than
  // computing a second one, and the fix for the skipping itself is the rename arm below.
  assert.match(v.checks.find((c) => c.id === "11-budget-exercised")!.detail, /no spending ceiling moved \(7 baseline scope\(s\)\)/);
  assert.equal(v.promote, true, JSON.stringify(v.checks.filter((c) => !c.pass)));
});

/** A synthetic report about no graph, so a `budgets` map can be stated directly. */
const report = (budgets: EvalReport["budgets"]): EvalReport => ({
  suite: "s",
  suiteVersion: 1,
  suiteFrozenAt: 1_000,
  cases: [],
  passed: 10,
  total: 10,
  passRate: 1,
  mustPassFailures: [],
  totalCostUsd: 1,
  p95WallMs: 100,
  suiteValid: true,
  suiteIssues: [],
  budgets,
});

test("CONTROL · a scope the candidate ADDED is not a moved ceiling — which is the shape mutate.ts produces", () => {
  // `compileMutation` builds a successor as `{...spec, nodes: [...nodes, ...added]}`, and an
  // added spending node is told by `GRAPH009_UNBOUNDED_NODE` to declare a budget. If a scope the
  // baseline does not have counted as a moved ceiling, the loop's only mutation operator could
  // never promote anything, which is the constant gate this check exists NOT to be.
  const shared = { graph: { costUsd: 1 }, "node:a": { costUsd: 0.15 } };
  const v = decide(report(shared), report({ ...shared, "node:added": { costUsd: 0.01, tokens: 500 } }));
  assert.equal(v.checks.find((c) => c.id === "11-budget-exercised")!.pass, true);
  assert.equal(v.promote, true, JSON.stringify(v.checks.filter((c) => !c.pass)));

  // …and the same node with its ceiling MOVED is still refused, so the leniency is about the
  // scope being new and not about the map being bigger.
  const moved = decide(report(shared), report({ graph: { costUsd: 1 }, "node:a": { costUsd: 0.01 } }));
  assert.equal(moved.checks.find((c) => c.id === "11-budget-exercised")!.pass, false);

  // A dimension ADDED at a shared scope is a ceiling appearing from nothing, and that is a
  // move: the node was unbounded in tokens and is not any more.
  const added = decide(report(shared), report({ graph: { costUsd: 1 }, "node:a": { costUsd: 0.15, tokens: 500 } }));
  assert.match(
    added.checks.find((c) => c.id === "11-budget-exercised")!.detail,
    /node:a\.tokens was unbounded and this candidate caps it at 500/,
  );

  // THIS LENIENCY IS ONE HALF OF AN ASYMMETRY AND IS ONLY DEFENSIBLE AS ONE. The other half —
  // a scope only the BASELINE has, which is refused — is the rename arm directly below. Read
  // them together before "simplifying" either: making the two directions agree in the tolerant
  // direction restores the escape this file's next test names, and making them agree in the
  // strict direction refuses `compileMutation`'s output, which is the paragraph above.
});

test("A RENAMED NODE USED TO CARRY ITS CEILING OUT OF THE COMPARISON — the affirmative claim was the damage", () => {
  // THE DEFECT, DRIVEN BY THE REVIEWER WHO FOUND IT. `movedCeilings` walks the BASELINE's scopes
  // and looks each up in the candidate; the missing case used to be `if (after === undefined)
  // continue`. So a candidate that renames a node AND raises its ceiling in the same edit put the
  // moved ceiling at a key the loop never asks about, and BOTH scopes fell through the two
  // skips — the old one under `node:a`, the new one because a candidate-only scope is skipped by
  // design. Nothing was compared, and the check did not go quiet about it: it reported
  //
  //     11 pass = true   detail: no spending ceiling moved (3 scope(s) compared)
  //
  // on a hundredfold RAISE. A silent gap would merely have been unhelpful; this one issued a
  // certificate. The count in that sentence is why the CONTROL above now asserts "baseline
  // scope(s)" instead — 3 scopes were enumerated and 2 of them were compared.
  const baseline = { graph: { costUsd: 1 }, "node:a": { costUsd: 0.15 }, "node:b": { costUsd: 0.15 } };
  // The same work under a new id, at 100× the ceiling. `node:b` is the untouched control that
  // keeps this from passing for the trivial reason that everything moved.
  const renamed = { graph: { costUsd: 1 }, "node:a2": { costUsd: 15 }, "node:b": { costUsd: 0.15 } };

  const v = decide(report(baseline), report(renamed));
  const c = v.checks.find((x) => x.id === "11-budget-exercised")!;
  assert.equal(c.pass, false);
  assert.equal(v.promote, false, JSON.stringify(v.checks.filter((x) => !x.pass)));
  assert.deepEqual(
    v.checks.filter((x) => !x.pass).map((x) => x.id),
    ["11-budget-exercised"],
    "and it is still the only check that can see it — a rename is not a cost, a posture or a prompt",
  );
  assert.match(
    c.detail,
    /node:a\.costUsd declared 0\.15 and this candidate has no such scope/,
    "the refusal names the scope that LEFT, the dimension, and the number it declared",
  );
  // THE AFFIRMATIVE CLAIM IS GONE, asserted directly rather than inferred from `pass: false`,
  // because the sentence is what a promoter reads.
  assert.doesNotMatch(c.detail, /no spending ceiling moved/);

  // AND THE OTHER HALF OF THE ASYMMETRY, pinned in the one fixture where both directions occur
  // at once: `node:a2` is a scope only the candidate has, so it contributes NOTHING — not a
  // second finding, not a mention. Exactly one ceiling is reported, and it is the one that left.
  // If a future edit makes the two directions symmetric, this count goes to 2 and this line
  // fails before the CONTROL above does.
  assert.match(c.detail, /^1 spending ceiling\(s\) moved and this corpus exercised none of them/);
  assert.doesNotMatch(c.detail, /node:a2/, "the added scope is not itself a finding — that is compileMutation's shape");

  // A RENAME THAT KEEPS THE NUMBER IS STILL REFUSED, so the refusal is about the scope leaving
  // and not about the 100×. The gate cannot tell "renamed" from "deleted" — nothing in an
  // `EvalReport` carries identity across a rename — and between "refuse a rename that moved
  // nothing" and "certify a rename that moved everything", only the first fails closed.
  const same = decide(report(baseline), report({ graph: { costUsd: 1 }, "node:a2": { costUsd: 0.15 }, "node:b": { costUsd: 0.15 } }));
  assert.equal(same.checks.find((x) => x.id === "11-budget-exercised")!.pass, false);

  // A node that carried NO ceiling can be renamed freely: `budgetsOf` states every node as a
  // scope, with an empty map when the author declared nothing, and an empty map has no
  // dimension to report as gone. So the refusal is scoped to caps that actually existed.
  const unbounded = { graph: { costUsd: 1 }, "node:a": { costUsd: 0.15 }, "node:plain": {} };
  const vu = decide(report(unbounded), report({ graph: { costUsd: 1 }, "node:a": { costUsd: 0.15 }, "node:plain2": {} }));
  assert.equal(vu.checks.find((x) => x.id === "11-budget-exercised")!.pass, true);
  assert.equal(vu.promote, true, JSON.stringify(vu.checks.filter((x) => !x.pass)));
});

test("A REPORT THAT DOES NOT STATE ITS CEILINGS IS REFUSED, not crashed through — `undefined` AND `null`, on either side", () => {
  // `budgets` is required by the type, so this is only reachable from JavaScript or from a
  // hand-built report — and it WAS reached: the first version of the check read
  // `Object.entries(baseline.budgets)` straight, and `gate.test.ts`'s `nothing()` fixture, which
  // predates the field and casts, turned the whole verdict into
  // `TypeError: Cannot convert undefined or null to object`. A guard that throws has not failed
  // closed; the caller gets no verdict at all rather than a refusal.
  //
  // THE GUARD THAT REPLACED IT DEFENDED ONE OF THE TWO VALUES IN ITS OWN QUOTED ERROR MESSAGE.
  // It read `baseline.budgets !== undefined && candidate.budgets !== undefined`, so a `null`
  // walked straight past it. Both directions were run against that form rather than reasoned
  // about, and they do NOT throw the same thing:
  //
  //     baseline null   TypeError: Cannot convert undefined or null to object   (Object.entries)
  //     candidate null  TypeError: Cannot read properties of null (reading 'graph')
  //
  // The first is byte-identical to the string quoted six lines above — the very error this arm
  // exists because of, reachable again through the guard written to stop it. The second is a
  // different message from a different line, which is the point of running both: a fixture that
  // only covered `baseline` would have "proved" a claim about `Object.entries` that the other
  // direction does not satisfy. `null` and `undefined` are equally unreachable from TypeScript
  // and equally reachable from the hand-built report that already reached one of them, so the
  // argument for guarding one is the argument for guarding the other; only a shape test
  // (`typeof x === "object" && x !== null`) makes that argument once instead of twice.
  //
  // BOTH SIDES, because the guard is a conjunction and a conjunction with one live half is not a
  // guard — a `stated` that only ever looked at `baseline` would pass three of these five.
  const { budgets: _absent, ...withoutBudgets } = report({});
  const missing = withoutBudgets as EvalReport;
  const nulled = report(null as unknown as EvalReport["budgets"]);
  const ok = report({ graph: { costUsd: 1 } });

  const cases: readonly (readonly [string, EvalReport, EvalReport])[] = [
    ["candidate has no `budgets` at all", ok, missing],
    ["baseline has no `budgets` at all", missing, ok],
    ["baseline states `budgets: null`", nulled, ok],
    ["candidate states `budgets: null`", ok, nulled],
    ["neither states one", nulled, missing],
  ];
  for (const [label, baseline, candidate] of cases) {
    // `decide` must RETURN. A throw here is the defect itself, and it reads as an errored test
    // rather than a failed assertion, so the label is what tells the two apart.
    const v = decide(baseline, candidate);
    const c = v.checks.find((x) => x.id === "11-budget-exercised")!;
    assert.equal(c.pass, false, label);
    assert.match(c.detail, /a guard that cannot decide fails closed/, label);
    assert.equal(v.promote, false, label);
  }
});

test("WHY THERE IS NO EVIDENCE BRANCH — a ceiling the corpus DOES cross fails the case instead", async () => {
  // The shape a reader expects after `unexercised` is "refuse unless the report shows the
  // ceiling binding". That branch would be unreachable. `run/engine.ts` refuses a crossed
  // ceiling with `E_BUDGET_EXHAUSTED` and `gate`/`degrade` are compile errors, so the only
  // action is `fail`; a run that fails at a ceiling never asks for the recorded effects past it,
  // and `unexercised`'s `unservedEffects` reason already refuses that case. So a moved ceiling
  // is either crossed — refused one reason up — or unexercised, with no third outcome that could
  // have earned a pass.
  const h = harness();
  const baselineGraph = withBudget(0.15);
  const suite = await corpus(h, baselineGraph);

  const crossed = await runEvalSuite({ store: h.store, suite, graph: withBudget(0.0005), engine: engineOf(h) });
  assert.equal(crossed.passRate, 0);
  assert.equal(crossed.cases[0]!.replay.replayed.status, "failed");
  assert.ok(crossed.cases[0]!.replay.unservedEffects.length > 0, "the turns past the refusal go unasked");
  assert.ok(
    crossed.cases[0]!.reasons.some((r) => r.includes("never asked for")),
    `the existing reason already fires; got ${JSON.stringify(crossed.cases[0]!.reasons)}`,
  );
});

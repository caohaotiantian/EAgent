/**
 * THE PROMOTION GATE FAILED OPEN ON THE CANDIDATE D6 IS AIMED AT.
 *
 * `runEvalSuite` replays a recorded run against a candidate graph, and every model turn is
 * served from the recording by `effectKey(taskId, "model", turn)`. That key is built from
 * `nodeId@branchPath#iteration` and the turn number — no prompt, no request, no graph hash.
 * So a candidate whose only change is the words the model is sent replays byte-identically
 * and the gate certifies it having asked nobody anything. Driven on the walking skeleton
 * before this file existed, three cases, all eleven `gateCandidate` checks, every input
 * supplied honestly:
 *
 *     baseline                  -> passRate 1  cost 0.001125
 *     metadata only (version 2) -> passRate 1  cost 0.001125  PROMOTE=true
 *     agent maxTurns 3 -> 1     -> passRate 1  cost 0.000435  PROMOTE=true
 *     agent prompt re-pointed   -> passRate 1  cost 0.001125  PROMOTE=true
 *     live model calls made during the whole evaluation: 0
 *
 * The crippled candidate came out CHEAPER at an equal pass rate, so the gate preferred it.
 * D6 defines self-improvement as text-space optimisation, which is exactly the candidate the
 * gate could not see — and "refusing is always allowed; loosening never is" is the rule it
 * broke.
 *
 * The replay half-knew: `report.match` was `false` and `report.graph.match` was `false`.
 * Neither is usable as the refusal. A candidate IS a different graph and divergence from the
 * recording is what a candidate is FOR — see `EvalCase.expect.identicalToRecording`, which
 * exists to say so. What was missing was narrower: whether the candidate asked what the
 * recording asked. `model.called` now carries a `requestDigest`, `reboundEffects` compares it,
 * and `runCase` refuses a case that measured the recording instead of the candidate.
 *
 * WHAT THIS FILE HOLDS DOWN, and the two controls are as load-bearing as the refusal:
 *
 * 1. A prompt candidate whose document text differs is REFUSED, by every case, on a reason
 *    that names the effect key.
 * 2. CONTROL — the baseline replayed against its own graph still passes. A refusal that fires
 *    on the recording's own graph is not a gate, it is an outage.
 * 3. CONTROL — a candidate that changes a deterministic FUNCTION body still promotes, and
 *    with a positive delta. Function bodies re-execute under replay, so that candidate really
 *    is measured; refusing it would have thrown away the only kind of candidate the offline
 *    gate can judge.
 * 4. A candidate judged against a recording written before `requestDigest` existed is
 *    REFUSED, because the two journals cannot say whether the calls agreed and a guard that
 *    cannot decide fails closed.
 * 5. CONTROL for 4 — the SAME graph over such a recording still passes, since a same-graph
 *    replay has nothing that could have changed the request.
 * 6. A candidate that simply DOES LESS is REFUSED. The `maxTurns 3 -> 1` row in the table above
 *    survived the digest fix, and had to: the digest answers "did it ask the same thing?", and
 *    lowering a ceiling asks the same thing FEWER TIMES. `reboundEffects` is empty by
 *    construction there; `unservedEffects` is where the evidence was, already folded into
 *    `report.match`, and `runCase` was not reading it.
 *
 * WHAT THIS FILE CANNOT HOLD DOWN AND WHERE THAT NOW LIVES, said here because the header's table
 * is the thing people read: the third row of the original defect — a candidate that lowers a
 * node's `policy.budget` — is not refusable by anything in THIS file, and the blanket answer was
 * tried and measured rather than argued. `skeleton.ts`'s own `summarize` declares
 * `budget.costUsd: 0.15`, both graphs the loop is driven on declare one, and the compiler tells
 * authors to add them, so refusing every different-graph candidate that CARRIES a budget also
 * refuses control 3 above — the only candidate class this gate can judge.
 *
 * It is closed one door up instead, on the diff of two graphs rather than on one replay:
 * `EvalReport.budgets` carries each graph's ceilings and `gateCandidate`'s `11-budget-exercised`
 * refuses a candidate that MOVED one at a scope the baseline also has. Declaring is not moving,
 * so control 3 still promotes. See `test/evolution/budget-change-is-unexercised.test.ts`.
 *
 * Offline and deterministic: the mock adapter, in-memory journals, an injected clock.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { gateCandidate, runEvalSuite, type EvalReport, type EvalSuite } from "../../src/evolution/gate.ts";
import { digest } from "../../src/canonical.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { NodeId, RunId } from "../../src/ids.ts";
import { replayRun } from "../../src/run/replay.ts";
import { DOCS, SKELETON_TENANT_CAPS, SKELETON_TOOLS, compileSkeleton, harness, skeletonSpec } from "../run/skeleton.ts";

/**
 * A resolver whose DOCUMENT TEXT is derived from the ref, unlike `skeleton.ts`'s, which
 * answers "Test instructions." for every ref it ever minted.
 *
 * That difference is a finding rather than a convenience. Under the shared fixture a
 * re-pointed `agent.prompt` produces a different `graphHash` and an IDENTICAL request, so
 * `requestDigest` reports "the same call" — correctly: two names for one document are one
 * question, and serving the recorded answer to it is sound. The digest catches a changed
 * REQUEST, never a changed ref, and a fixture that cannot tell them apart cannot test either.
 */
function textyResolver(): ResourceResolver {
  const minted = new Map<string, string>();
  return {
    resolve(ref) {
      if (!/^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref)) return undefined;
      const pinned = digest({ fixture: "texty", ref });
      minted.set(pinned, `Instructions for ${ref}.`);
      return { ref, digest: pinned, channel: "stable" };
    },
    document: (pinned) => minted.get(pinned),
  };
}

const compileTexty = (spec: GraphSpec): RunGraph =>
  compileOrThrow({ spec, resolver: textyResolver(), tools: SKELETON_TOOLS, tenantCapabilities: SKELETON_TENANT_CAPS });

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

/** The skeleton with `summarize`'s prompt ref replaced. */
function withPrompt(ref: string): GraphSpec {
  const base = skeletonSpec();
  return {
    ...base,
    nodes: base.nodes.map((nd) => (nd.id === ("summarize" as NodeId) ? { ...nd, agent: { ...nd.agent!, prompt: ref } } : nd)),
  };
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

test("A PROMPT-ONLY CANDIDATE IS REFUSED — the gate cannot certify what it never asked", async () => {
  const h = harness();
  const baselineGraph = compileTexty(withPrompt("prompt/summarize-file@stable"));
  const ids: RunId[] = [];
  for (let i = 0; i < 3; i++) ids.push(await recordRun(h, baselineGraph));
  const suite = suiteOver(ids);

  const modelCallsAfterRecording = h.model.seen.length;
  const baseline = await runEvalSuite({ store: h.store, suite, graph: baselineGraph, engine: engineOf(h) });

  const candidateGraph = compileTexty(withPrompt("prompt/summarize-file-v2@stable"));
  assert.notEqual(candidateGraph.graphHash, baselineGraph.graphHash, "the premise: it IS a different graph");
  const candidate = await runEvalSuite({ store: h.store, suite, graph: candidateGraph, engine: engineOf(h) });

  // The evaluation is still free. The refusal is not "run it live to find out".
  assert.equal(h.model.seen.length, modelCallsAfterRecording, "the gate is still replay all the way down");

  assert.equal(candidate.passRate, 0, `every case measured the recording; reasons ${JSON.stringify(candidate.cases[0]!.reasons)}`);
  assert.deepEqual(candidate.mustPassFailures, ["c0"]);
  const reason = candidate.cases[0]!.reasons.find((r) => r.includes("served to a different call"));
  assert.ok(reason, `the refusal must name what happened; got ${JSON.stringify(candidate.cases[0]!.reasons)}`);
  assert.match(reason, /:model:0/, "and which effect key it happened at");

  const verdict = decide(baseline, candidate);
  assert.equal(verdict.promote, false);
  assert.equal(verdict.checks.find((c) => c.id === "2-non-inferior")?.pass, false);
});

test("CONTROL · the baseline over its own graph still passes — a refusal on the recording is an outage", async () => {
  const h = harness();
  const graph = compileTexty(withPrompt("prompt/summarize-file@stable"));
  const ids: RunId[] = [];
  for (let i = 0; i < 3; i++) ids.push(await recordRun(h, graph));

  const report = await runEvalSuite({ store: h.store, suite: suiteOver(ids), graph, engine: engineOf(h) });
  assert.equal(report.passRate, 1, JSON.stringify(report.cases.map((c) => c.reasons)));
  assert.deepEqual(report.cases[0]!.replay!.reboundEffects, [], "the same graph asks the same questions");
});

test("CONTROL · a candidate that changes a deterministic FUNCTION body still promotes", async () => {
  // This is the candidate the offline gate genuinely CAN judge: function bodies compute no
  // effect key, consult no recording and RE-EXECUTE under replay. Refusing it would have cost
  // the gate the only kind of improvement it can measure without spending a model call.
  const h = harness();
  const graph = compileSkeleton();
  const ids: RunId[] = [];
  for (let i = 0; i < 3; i++) ids.push(await recordRun(h, graph));

  // The baseline's merge MISCOUNTS the digests — a real defect, and one that is entirely in a
  // body, so the recorded model turns are untouched by fixing it. It is a defect in `count` and
  // not in `markdown` for a reason: `write` is called with `${merged.markdown}`, and a recorded
  // tool result is bound to the arguments it answered (`tool.called.argsDigest`). A body whose
  // output reaches a tool call is only judgeable offline while that call stays the recorded one.
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

  const suite = suiteOver(ids);
  const baseline = await runEvalSuite({ store: h.store, suite, graph: withMerge("function/merge-v1@stable"), engine: engineOf(h) });
  const candidate = await runEvalSuite({ store: h.store, suite, graph: withMerge("function/merge-v2@stable"), engine: engineOf(h) });

  // Neither side is refused: the request is identical in both, because the change is below
  // the model entirely.
  assert.deepEqual(candidate.cases[0]!.replay!.reboundEffects, [], "a body change asks the model nothing new");
  assert.deepEqual(candidate.cases[0]!.replay!.unverifiedModelEffects, []);
  assert.equal(baseline.passRate, 1);
  assert.equal(candidate.passRate, 1);
  assert.equal(decide(baseline, candidate).promote, true, "a measurable candidate still gets through");

  // And the two really are different graphs computing different answers — the premise.
  assert.notEqual(withMerge("function/merge-v1@stable").graphHash, withMerge("function/merge-v2@stable").graphHash);
  const b = await replayRun({ store: h.store, runId: ids[0]!, graph: withMerge("function/merge-v1@stable"), engine: engineOf(h) });
  const c = await replayRun({ store: h.store, runId: ids[0]!, graph: withMerge("function/merge-v2@stable"), engine: engineOf(h) });
  assert.equal((b.replayed.channels["merged"] as { count: number }).count, DOCS.length - 1);
  assert.equal((c.replayed.channels["merged"] as { count: number }).count, DOCS.length);
});

/**
 * The same journal with every `model.called.requestDigest` stripped — a recording written
 * before the field existed. Rewritten into a fresh store under the same runId, so the seq
 * numbers and every other event are the recording's own.
 */
async function withoutRequestDigests(h: ReturnType<typeof harness>, runId: RunId): Promise<MemoryStateStore> {
  const events: JournalEvent[] = [];
  for await (const e of h.store.read(runId, 1)) events.push(e);
  const store = new MemoryStateStore();
  let seq = 0;
  for (const e of events) {
    const payload =
      e.type === "model.called"
        ? (() => {
            const { requestDigest: _drop, ...rest } = e.payload as Record<string, unknown>;
            return rest;
          })()
        : e.payload;
    await store.append({
      runId,
      expectedSeq: seq,
      events: [{ type: e.type, payload, actor: e.actor, ...(e.taskId === undefined ? {} : { taskId: e.taskId }) } as never],
    });
    seq += 1;
  }
  return store;
}

test("A RECORDING WITH NO requestDigest CANNOT CERTIFY A DIFFERENT GRAPH — the guard fails closed", async () => {
  const h = harness();
  const baselineGraph = compileTexty(withPrompt("prompt/summarize-file@stable"));
  const runId = await recordRun(h, baselineGraph);
  const old = await withoutRequestDigests(h, runId);

  const suite = suiteOver([runId]);
  const candidateGraph = compileTexty(withPrompt("prompt/summarize-file-v2@stable"));
  const candidate = await runEvalSuite({ store: old, suite, graph: candidateGraph, engine: engineOf(h) });

  assert.equal(candidate.passRate, 0);
  const reason = candidate.cases[0]!.reasons.find((r) => r.includes("no requestDigest"));
  assert.ok(reason, `got ${JSON.stringify(candidate.cases[0]!.reasons)}`);
  assert.match(reason, /re-record the corpus, or judge this candidate live/, "the refusal has to say what to do next");
  assert.ok(candidate.cases[0]!.replay!.unverifiedModelEffects.length > 0);
});

test("CONTROL · the SAME graph over a digest-less recording still passes", async () => {
  // There is nothing a same-graph replay could have changed about the request, so refusing
  // here would break every replay-verification fixture over an older corpus and buy nothing.
  const h = harness();
  const graph = compileTexty(withPrompt("prompt/summarize-file@stable"));
  const runId = await recordRun(h, graph);
  const old = await withoutRequestDigests(h, runId);

  const report = await runEvalSuite({ store: old, suite: suiteOver([runId]), graph, engine: engineOf(h) });
  assert.equal(report.passRate, 1, JSON.stringify(report.cases.map((c) => c.reasons)));
  assert.equal(report.cases[0]!.replay!.graph.match, true, "the premise: it is the recorded graph");
  assert.ok(report.cases[0]!.replay!.unverifiedModelEffects.length > 0, "…and the digests really are missing");
});

/**
 * The skeleton with `summarize`'s turn ceiling replaced.
 *
 * The candidate this file's header records as promoting: `maxTurns 3 -> 1`, passRate 1,
 * cost 0.000435 against the baseline's 0.001125.
 */
function withMaxTurns(turns: number): RunGraph {
  const base = skeletonSpec();
  return compileSkeleton(
    skeletonSpec({
      nodes: base.nodes.map((nd) =>
        nd.id === ("summarize" as NodeId) ? { ...nd, agent: { ...nd.agent!, maxTurns: turns } } : nd,
      ),
    }),
  );
}

test("A CANDIDATE THAT SIMPLY DOES LESS IS REFUSED — the turns it skipped are the ones nobody asked about", async () => {
  // THE SECOND HALF OF THIS FILE'S DEFECT, and the one `requestDigest` cannot answer. Lowering
  // `agent.maxTurns` asks the SAME question on the turns it does take, so every digest matches
  // and `reboundEffects` is empty by construction. The turns it does NOT take simply go
  // unserved, and the gate scored the candidate on the part of the recording it bothered with.
  // Measured on this fixture before the refusal existed: passRate 1 on both sides,
  // `reboundEffects` [], and `gateCandidate` PROMOTE=true — one turn cheaper.
  const h = harness();
  const baselineGraph = withMaxTurns(3);
  const ids: RunId[] = [];
  for (let i = 0; i < 3; i++) ids.push(await recordRun(h, baselineGraph));
  const suite = suiteOver(ids);

  const baseline = await runEvalSuite({ store: h.store, suite, graph: baselineGraph, engine: engineOf(h) });
  assert.equal(baseline.passRate, 1, "the control: the recording's own ceiling replays clean");

  const candidateGraph = withMaxTurns(1);
  const candidate = await runEvalSuite({ store: h.store, suite, graph: candidateGraph, engine: engineOf(h) });

  // THE PREMISE, and it is what makes this case different from the prompt one: the MODEL requests
  // that WERE made agreed, so the request digest cannot be the refusal. (The candidate's `write`
  // IS rebound — fewer turns produce different summaries, so it writes a different body than the
  // recording did — which is a second true reason and not the one this test is about.)
  assert.deepEqual(
    candidate.cases[0]!.replay!.reboundEffects.filter((r) => r.field === "model"),
    [],
    "the turns it took asked what the recording asked",
  );
  assert.ok(
    candidate.cases[0]!.replay!.unservedEffects.length > 0,
    "the premise on the other side: the recording holds turns this replay never asked for",
  );
  assert.ok(
    candidate.totalCostUsd < baseline.totalCostUsd,
    `and it comes out cheaper — ${candidate.totalCostUsd} vs ${baseline.totalCostUsd} — which is what the gate preferred`,
  );

  assert.equal(candidate.passRate, 0, `reasons ${JSON.stringify(candidate.cases[0]!.reasons)}`);
  const reason = candidate.cases[0]!.reasons.find((r) => r.includes("never asked for"));
  assert.ok(reason, `the refusal must name what happened; got ${JSON.stringify(candidate.cases[0]!.reasons)}`);
  assert.equal(decide(baseline, candidate).promote, false, "and a candidate measured on half a recording does not promote");
});


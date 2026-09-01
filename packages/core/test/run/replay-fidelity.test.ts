/**
 * WHAT A REPLAY REPORTS MUST BE ABOUT THE RUN, NOT ABOUT THE REPLAYER.
 *
 * `loom replay` renders each failing frame as `expected X, got Y`, and two of the inputs to that
 * sentence were wrong in ways that sent an operator to the wrong artifact.
 *
 * `graphBound` is `specBound && refsBound` — the spec hash AND the resolved resources — but the
 * frame reported the GRAPH hash either way. So editing `resources/prompt/p.md` produced
 * `✗ graph.bound : expected sha256:aaf236…, got sha256:aaf236…`: two identical strings, and no
 * hint that the manifest was what moved. A diagnostic showing a difference where there is none is
 * worse than one that says nothing.
 *
 * This is the same shape as register entry A6, whose lesson was recorded and then repeated: "a
 * wrong answer that announces itself as a different wrong answer is not a loud failure."
 */
import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { AppendInput, AppendResult, RunFilter, RunSummary, StateStore } from "../../src/journal/store.ts";
import type { RunId, Seq } from "../../src/ids.ts";
import { Engine } from "../../src/run/engine.ts";
import type { RunProjection } from "../../src/run/projection.ts";
import {
  FunctionRegistry,
  MockModelAdapter,
  ModelRegistry,
  ToolRegistry,
  type ModelAdapter,
  type ModelEvent,
} from "../../src/run/registry.ts";
import { replayRun } from "../../src/run/replay.ts";

const NOW = 1_700_000_000_000;

/** A resolver whose answer for one ref can MOVE, the way a store's does when a file is edited. */
function shifting(): { resolver: ResourceResolver; bump: () => void } {
  let n = 0;
  return {
    bump: () => {
      n += 1;
    },
    resolver: {
      resolve: (ref) =>
        /^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref)
          ? { ref, digest: `sha256:${String(n).repeat(64).slice(0, 64)}`, channel: "stable" }
          : undefined,
      document: () => "Instructions.",
    },
  };
}

function spec(nodeTokens?: number, nodeCostUsd?: number): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "ag", project: "fidelity", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { q: { type: "string", reduce: "replace" }, a: { type: "string", reduce: "replace" } },
    inputs: ["q"],
    outputs: ["a"],
    nodes: [
      {
        id: "ask",
        type: "agent",
        reads: ["q"],
        writes: ["a"],
        ...(nodeTokens === undefined && nodeCostUsd === undefined
          ? {}
          : {
              policy: {
                budget: {
                  ...(nodeTokens === undefined ? {} : { tokens: nodeTokens }),
                  ...(nodeCostUsd === undefined ? {} : { costUsd: nodeCostUsd }),
                },
              },
            }),
        agent: { profile: "agent_profile/x@stable", prompt: "prompt/p@stable" },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

function rig(res: ResourceResolver): { engine: Engine; store: MemoryStateStore; tools: ToolRegistry; models: ModelRegistry } {
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "ok", finishReason: "stop" }) }), true);
  const store = new MemoryStateStore({ now: () => NOW });
  const tools = new ToolRegistry();
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models,
    now: () => NOW,
    sleep: async () => {},
    resolver: res,
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 10 } },
  });
  return { engine, store, tools, models };
}

test("A RESOURCE THAT MOVED IS REPORTED AS THE RESOURCE, not as two identical graph hashes", async () => {
  const res = shifting();
  const r = rig(res.resolver);
  const compile = () => compileOrThrow({ spec: spec(), resolver: res.resolver, tools: {}, tenantCapabilities: [] });

  const original = compile();
  const runId = await r.engine.submit({ graph: original, inputs: { q: "hi" } });
  await r.engine.advance(runId);

  // The store moves under the run, exactly as editing a prompt file does. The SPEC is untouched.
  res.bump();
  const rebound = compile();
  assert.equal(rebound.graphHash, original.graphHash, "the spec hash must NOT move — that is the point");

  const report = await replayRun({
    store: r.store,
    runId,
    graph: rebound,
    engine: { tools: r.tools, functions: new FunctionRegistry(), models: r.models, resolver: res.resolver },
    onGraphChange: "diverge",
  });

  assert.equal(report.match, false, "a run whose resources moved must not replay green");
  const frame = report.frames.find((f) => f.kind === "graph.bound");
  assert.ok(frame !== undefined, "a graph.bound frame must be raised");
  assert.notEqual(frame!.expected, frame!.actual, "the two halves of `expected X, got Y` must DIFFER");
  assert.match(frame!.expected ?? "", /prompt\/p@stable=/, `the frame must name the ref: ${frame!.expected}`);
  assert.match(frame!.actual ?? "", /prompt\/p@stable=/, `and its new pin: ${frame!.actual}`);
});

test("A SPEC THAT MOVED IS STILL REPORTED AS THE GRAPH HASH", async () => {
  // The other conjunct, so the fix is not "always print refs". Same run, a genuinely different
  // spec: the two hashes differ and are the right thing to show.
  const res = shifting();
  const r = rig(res.resolver);
  const original = compileOrThrow({ spec: spec(), resolver: res.resolver, tools: {}, tenantCapabilities: [] });
  const runId = await r.engine.submit({ graph: original, inputs: { q: "hi" } });
  await r.engine.advance(runId);

  const other = { ...spec(), metadata: { name: "different", project: "fidelity", version: 1 } };
  const changed = compileOrThrow({ spec: other as unknown as GraphSpec, resolver: res.resolver, tools: {}, tenantCapabilities: [] });
  assert.notEqual(changed.graphHash, original.graphHash);

  const report = await replayRun({
    store: r.store,
    runId,
    graph: changed,
    engine: { tools: r.tools, functions: new FunctionRegistry(), models: r.models, resolver: res.resolver },
    onGraphChange: "diverge",
  });

  const frame = report.frames.find((f) => f.kind === "graph.bound");
  assert.ok(frame !== undefined);
  assert.equal(frame!.expected, original.graphHash, "a spec change reports the recorded graph hash");
  assert.equal(frame!.actual, changed.graphHash);
});

/**
 * A GUARD THAT ONLY THE LIVE PATH CAN EVALUATE IS A REPLAY DIVERGENCE.
 *
 * D.7.6 added a refusal for an adapter whose terminal `done` frame names no provider, and built it
 * out of two locals that exist only while the stream is being read — `sawDoneFrame` and
 * `servingProvider`. Neither reached the journal, so `RecordedModelTurn` carried nothing the guard
 * could read and the refusal could not fire on replay. MEASURED, through `replayRun`:
 *
 *   LIVE   status= failed err= E_PROVIDER_BAD_REQUEST a= undefined
 *   REPLAY match= false
 *    { k: task.committed, e: "failed",   a: "succeeded" }
 *    { k: state.reduced,  e: {"q":"hi"}, a: {"q":"hi","a":"an answer nobody may use"} }
 *    { k: run.failed,     e: "failed",   a: "succeeded" }
 *
 * The shadow run wrote to the channel the exact string the live run had refused. That is
 * CLAUDE.md's first non-negotiable — "a value a decision reads must be reconstructable by folding
 * the journal" — and the SIBLING guard in the same function is built the other way on purpose:
 * `turnRefusal` re-derives because `finishReason` IS in `RecordedModelTurn`. The fix puts
 * `provider` there beside it.
 *
 * THE FIELD IS TRI-STATE, AND THE THIRD TEST BELOW IS WHY. `""` is a frame that arrived and named
 * nobody, which refuses; ABSENT is no terminal frame at all, which the live path allows — and
 * absent is what journals written before `e6d00f2` say — not every journal written before the
 * field, because D.7.6's refusal existed in the window `e6d00f2..633e265^` while nothing wrote
 * it, and a journal from that window replays a refusal as a SUCCESS. Collapsing the two would
 * make an old recording replay as a refusal of a run that succeeded.
 */

/** An untyped adapter: a terminal frame with no `provider`. Only `--extension-module` code can. */
class NamelessAdapter implements ModelAdapter {
  readonly provider = "wrapper";
  async *stream(): AsyncIterable<ModelEvent> {
    yield { type: "text_delta", text: "an answer nobody may use" } as ModelEvent;
    yield {
      type: "done",
      message: { role: "assistant", content: "an answer nobody may use" },
      finishReason: "stop",
      usage: { inputTokens: 5, outputTokens: 5, costUsd: 0.0001, wallMs: 0 },
    } as unknown as ModelEvent;
  }
  priceOf(): number {
    return 0;
  }
  estimateOf(): number {
    return 0;
  }
  outputCeilingOf(): number {
    return 1024;
  }
}

/** The other shape: a stream that ends with no terminal frame at all. The live path ALLOWS it. */
class FramelessAdapter implements ModelAdapter {
  readonly provider = "wrapper";
  async *stream(): AsyncIterable<ModelEvent> {
    yield { type: "text_delta", text: "partial" } as ModelEvent;
  }
  priceOf(): number {
    return 0;
  }
  estimateOf(): number {
    return 0;
  }
  outputCeilingOf(): number {
    return 1024;
  }
}

/** Everything a replay of the run just recorded needs, so a test can vary the STORE it reads. */
interface Recorded {
  readonly live: RunProjection;
  readonly store: MemoryStateStore;
  readonly runId: RunId;
  readonly graph: ReturnType<typeof compileOrThrow>;
  readonly engine: Parameters<typeof replayRun>[0]["engine"];
}

/** Run one agent node live under `adapter` and hand back the journal it wrote. */
async function liveRun(
  adapter: ModelAdapter,
  nodeTokens?: number,
  budget: { readonly runUsd?: number; readonly runTokens?: number } = { runUsd: 10 },
  nodeCostUsd?: number,
): Promise<Recorded> {
  const res = shifting();
  const models = new ModelRegistry();
  models.register(adapter, true);
  const store = new MemoryStateStore({ now: () => NOW });
  const tools = new ToolRegistry();
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models,
    now: () => NOW,
    sleep: async () => {},
    resolver: res.resolver,
    policy: { granted: [], systemFloor: "out", budget },
  });
  const graph = compileOrThrow({ spec: spec(nodeTokens, nodeCostUsd), resolver: res.resolver, tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { q: "hi" } });
  const live = await engine.advance(runId);
  return {
    live,
    store,
    runId,
    graph,
    // THE SHADOW GETS THE SAME POLICY, and it has to be said explicitly: `replayRun` builds its
    // Engine from what the caller hands it, so a replay with no `policy` has no run budget at all
    // and cannot reach a `PolicyEngine` refusal however faithful its numbers are.
    engine: { tools, functions: new FunctionRegistry(), models, resolver: res.resolver, policy: { granted: [], systemFloor: "out" as const, budget } },
  };
}

/** Run one agent node live under `adapter`, then replay the journal it wrote. */
async function liveThenReplay(
  adapter: ModelAdapter,
  nodeTokens?: number,
): Promise<{
  live: RunProjection;
  report: Awaited<ReturnType<typeof replayRun>>;
}> {
  const r = await liveRun(adapter, nodeTokens);
  return { live: r.live, report: await replayRun({ store: r.store, runId: r.runId, graph: r.graph, engine: r.engine }) };
}

/** Is this event half of a `quote` effect? Both halves carry the key; only the start carries the kind. */
function isQuoteEvent(e: JournalEvent): boolean {
  const key = (e.payload as { key?: unknown }).key;
  if (typeof key !== "string") return false;
  return (e.type === "effect.started" || e.type === "effect.completed" || e.type === "effect.failed") && key.includes(":quote:");
}

/**
 * The same recording as a journal written BEFORE the `quote` effect existed.
 *
 * `replayRun` only READS `opts.store`, so removing the rows on the way out is the whole of it —
 * and it is a more honest fixture than a hand-built journal, because every other event is
 * byte-for-byte what this engine actually wrote. The seqs it yields are non-contiguous, exactly
 * as they would be if the rows had never been written under a lower numbering.
 */
class WithoutQuotes implements StateStore {
  readonly #inner: StateStore;
  constructor(inner: StateStore) {
    this.#inner = inner;
  }
  append(input: AppendInput): Promise<AppendResult> {
    return this.#inner.append(input);
  }
  async *read(runId: RunId, fromSeq: Seq, toSeq?: Seq): AsyncIterable<JournalEvent> {
    for await (const e of this.#inner.read(runId, fromSeq, toSeq)) if (!isQuoteEvent(e)) yield e;
  }
  head(runId: RunId): Promise<Seq> {
    return this.#inner.head(runId);
  }
  listRuns(limit?: number, filter?: RunFilter): Promise<readonly RunSummary[]> {
    return this.#inner.listRuns(limit, filter);
  }
  close(): void {
    this.#inner.close();
  }
}

async function eventsOf(store: StateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const e of store.read(runId, 1 as Seq)) out.push(e);
  return out;
}

const diverged = (r: Awaited<ReturnType<typeof replayRun>>): string => JSON.stringify(r.frames.filter((f) => !f.match));

test("A PROVIDER REFUSAL THE JOURNAL RECORDED REFUSES AGAIN ON REPLAY, and the refused text stays off the channel", async () => {
  const { live, report } = await liveThenReplay(new NamelessAdapter());

  assert.equal(live.status, "failed");
  assert.equal(live.error?.code, "E_PROVIDER_BAD_REQUEST");
  assert.equal(live.channels["a"], undefined, "the live run refused, so nothing reached the channel");

  assert.equal(report.match, true, `a faithfully recorded refusal must replay green: ${diverged(report)}`);
  assert.equal(report.replayed.status, "failed", "the replay must reach the same verdict");
  assert.equal(report.replayed.error?.code, "E_PROVIDER_BAD_REQUEST", "and for the same reason, re-derived from the record");
  assert.equal(report.replayed.channels["a"], undefined, "the shadow run must not write the string the live run refused");
});

test("THE CONTROL: a frame that NAMES its provider replays green", async () => {
  const named = new MockModelAdapter({ provider: "leaf", script: () => ({ text: "ok", finishReason: "stop" }) });
  const { live, report } = await liveThenReplay(named);

  assert.equal(live.status, "succeeded", JSON.stringify(live.error ?? {}));
  assert.equal(report.match, true, diverged(report));
  assert.equal(report.replayed.status, "succeeded");
  assert.equal(report.replayed.channels["a"], "ok");
});

test("A TURN WITH NO TERMINAL FRAME IS NOT A REFUSAL — absent must not be read as the empty string", async () => {
  // The live path allows this: a stream that never finished is a different question from a frame
  // that named nobody, and D.7.6 answers only the second. What matters here is that the replay
  // AGREES with it — and this is the same reading every journal written before
  // `RecordedModelTurn.provider` gets, so it is also the test that old recordings are not
  // re-judged under a rule their binary never had.
  const { live, report } = await liveThenReplay(new FramelessAdapter());

  assert.equal(live.status, "succeeded", JSON.stringify(live.error ?? {}));
  assert.equal(report.match, true, diverged(report));
  assert.equal(report.replayed.status, "succeeded", "an absent `provider` must replay as the run it was, not as a refusal");
});

/**
 * THE NODE TOKEN CEILING IS AN ADAPTER'S ANSWER, AND THE JOURNAL NOW CARRIES IT.
 *
 * D.7.3 replaced a made-up padding constant of 1,024 with `outputCeilingOf(adapter, req)`. Both
 * paths used to compute the constant, so a `budget.tokens` refusal replayed event for event and
 * message for message; only the live path can compute the adapter's answer, and for a while
 * nothing recorded it. MEASURED through `replayRun` on a one-agent graph with node
 * `budget.tokens: 500`, on `0eea7aa` (before D.7.3), on `799545c` (after it, before the `quote`
 * effect) and on this tree:
 *
 *   0eea7aa  LIVE   failed E_BUDGET_EXHAUSTED  … 1043 estimated for this turn
 *            REPLAY failed E_BUDGET_EXHAUSTED  … 1043 estimated for this turn
 *   799545c  LIVE   failed E_BUDGET_EXHAUSTED  … 1043 estimated for this turn
 *            REPLAY failed E_REPLAY_DIVERGENCE effect "ask@root#0:model:0" is not in the journal
 *   HEAD     LIVE   failed E_BUDGET_EXHAUSTED  … 1041 estimated for this turn
 *            REPLAY failed E_BUDGET_EXHAUSTED  … 1041 estimated for this turn
 *
 * The 0eea7aa column agreed by ACCIDENT, not by construction: it matched because the adapter under
 * test also reported 1,024. Against the 4,096 the shipped `providers/http.ts` adapter reports it
 * would have printed two different numbers even then. The HEAD column agrees because the number is
 * read back from the journal — `effectKey(taskId, "quote", turn)` — rather than re-derived.
 * (1,043 against 1,041 is the two rigs' resolved prompts, not a change in the arithmetic.)
 *
 * WHAT IS LEFT, AND IT IS CONFINED TO OLD JOURNALS. A recording with no `quote` row still gets
 * `ceiling ?? 0`, which is a LOWER bound: it can fail to reproduce a refusal, never invent one.
 * The last two tests are that fold, driven against a journal with the rows stripped out.
 */

test("A REFUSAL RE-DERIVES WITH THE SAME NUMBER — the live message and the replayed one are one message", async () => {
  // Cap 10: the transcript estimate exceeds it even with no padding, so this refuses on any
  // build. What it pins is the NUMBER: before the quote effect the two messages read 1041 and 17,
  // which is this file's own opening lesson — a wrong answer announcing itself as a different
  // wrong answer.
  const named = new MockModelAdapter({ provider: "leaf", script: () => ({ text: "ok", finishReason: "stop" }) });
  const { live, report } = await liveThenReplay(named, 10);

  assert.equal(live.error?.code, "E_BUDGET_EXHAUSTED");
  assert.equal(report.replayed.error?.code, "E_BUDGET_EXHAUSTED", "the replay must reach the same refusal");
  assert.match(live.error?.message ?? "", /1041 estimated for this turn\)$/, "17 transcript + the adapter's 1,024 ceiling");
  assert.equal(report.replayed.error?.message, live.error?.message, "and the replay must say the same sentence, not a floor");
  assert.doesNotMatch(report.replayed.error?.message ?? "", /FLOOR/, "nothing is a floor when the ceiling is on the journal");
  assert.equal(report.match, true, diverged(report));
});

test("A REPLAY NEVER REFUSES A TURN THE LIVE RUN ALLOWED — the direction the lower bound makes safe", async () => {
  // The fallback can only ever under-count, so this direction cannot break. It is the reason the
  // check keeps running in replay rather than being skipped, and it goes red if anyone
  // re-introduces a fabricated ceiling larger than the adapter's.
  const small = new MockModelAdapter({ provider: "leaf", defaultMaxTokens: 8, script: () => ({ text: "ok", finishReason: "stop" }) });
  const { live, report } = await liveThenReplay(small, 100);

  assert.equal(live.status, "succeeded", JSON.stringify(live.error ?? {}));
  assert.equal(report.match, true, diverged(report));
  assert.equal(report.replayed.status, "succeeded");
});

test("THE HOLE THIS CLOSES: a refusal that needed the padding re-derives, instead of dying on the effect it skipped", async () => {
  // This test used to be the debt. Its old body asserted `E_REPLAY_DIVERGENCE` and
  // `match: true` — the replay could not re-derive the refusal, walked on to a model effect the
  // live run never made, and `compare()` graded both runs `failed` so nothing announced it.
  // Both halves are fixed here: the quote is served from the record, and `compare()` now weighs
  // the error code as well as the status.
  const named = new MockModelAdapter({ provider: "leaf", script: () => ({ text: "ok", finishReason: "stop" }) });
  const { live, report } = await liveThenReplay(named, 500);

  assert.equal(live.error?.code, "E_BUDGET_EXHAUSTED", "live refuses: transcript + the adapter ceiling exceeds 500");
  assert.match(live.error?.message ?? "", /1041 estimated for this turn/, "17 transcript + 1024 ceiling");

  assert.equal(report.replayed.error?.code, "E_BUDGET_EXHAUSTED", "and so does the replay, from the recorded quote");
  assert.equal(report.replayed.error?.message, live.error?.message);
  assert.equal(report.match, true, diverged(report));
});

test("THE QUOTE IS ON THE JOURNAL UNDER A DERIVED KEY, and it carries both adapter answers", async () => {
  // The key has to be recomputable by a retry, a resume and a replay, so it is built from the
  // derived TaskId and the turn ordinal — the same coordinate as the `model` effect of the turn it
  // prices, under its own kind so a refused turn's quote is not filed as a call that never
  // happened.
  const named = new MockModelAdapter({ provider: "leaf", script: () => ({ text: "ok", finishReason: "stop" }) });
  const r = await liveRun(named);
  const events = await eventsOf(r.store, r.runId);

  const started = events.filter((e) => e.type === "effect.started" && (e.payload as { kind?: string }).kind === "quote");
  assert.equal(started.length, 1, "one quote per model turn, and this graph has one turn");
  assert.equal((started[0]!.payload as { key: string }).key, "ask@root#0:quote:0", "taskId:quote:turn");

  const done = events.find((e) => e.type === "effect.completed" && (e.payload as { key: string }).key === "ask@root#0:quote:0");
  assert.ok(done !== undefined, "a quote is asked and answered in one batch, so a start without a completion is a bug");
  assert.deepEqual(
    (done!.payload as { result: unknown }).result,
    { estimateUsd: 0.001041, outputCeiling: 1024 },
    "both numbers the three budget refusals are computed from",
  );

  // AND IT IS NOT A MODEL CALL. Nothing was billed, so nothing may be charged: `model.called` is
  // what `projection.ts` charges usage off, and a quote must never write one.
  const modelCalls = events.filter((e) => e.type === "model.called");
  assert.equal(modelCalls.length, 1, "one turn, one model.called — the quote did not mint a second");
});

test("AN OLD JOURNAL HAS NO QUOTE AND STILL FOLDS — to the lower bound, which says so", async () => {
  // The fold must tighten, never throw. A recording written before the quote effect existed has
  // no row to serve, so the replay falls back to the unpadded transcript estimate — the reading it
  // already got — and the refusal it prints NAMES itself as a floor rather than quietly printing a
  // different number than the recording did.
  const named = new MockModelAdapter({ provider: "leaf", script: () => ({ text: "ok", finishReason: "stop" }) });
  const r = await liveRun(named, 10);
  const older = new WithoutQuotes(r.store);
  assert.equal(
    (await eventsOf(older, r.runId)).length,
    (await eventsOf(r.store, r.runId)).length - 2,
    "the fixture must actually remove the two rows, or this test proves nothing",
  );

  const report = await replayRun({ store: older, runId: r.runId, graph: r.graph, engine: r.engine });

  assert.equal(report.replayed.error?.code, "E_BUDGET_EXHAUSTED", "the refusal the transcript alone earns still re-derives");
  assert.match(report.replayed.error?.message ?? "", /17 estimated for this turn,/, "unpadded, because there is nothing to pad with");
  assert.match(
    report.replayed.error?.message ?? "",
    /a FLOOR: this recording carries no quote effect for the turn/,
    `the replayed refusal must say its estimate is unpadded: ${report.replayed.error?.message}`,
  );
  assert.doesNotMatch(r.live.error?.message ?? "", /FLOOR/, "the LIVE estimate is the real one and claims nothing");
});

test("AN OLD JOURNAL'S RESIDUAL HOLE IS ANNOUNCED NOW, instead of being graded a match", async () => {
  // The one thing a lower bound cannot do is reproduce a refusal that NEEDED the padding, and no
  // fix can invent a number the journal does not carry. What changed is that it is no longer
  // silent: `compare()` weighs the error code, so a replay that failed for an unrelated reason
  // reports `match: false` instead of scoring green on `failed === failed`.
  const named = new MockModelAdapter({ provider: "leaf", script: () => ({ text: "ok", finishReason: "stop" }) });
  const r = await liveRun(named, 500);
  const report = await replayRun({ store: new WithoutQuotes(r.store), runId: r.runId, graph: r.graph, engine: r.engine });

  assert.equal(r.live.error?.code, "E_BUDGET_EXHAUSTED");
  assert.equal(report.replayed.error?.code, "E_REPLAY_DIVERGENCE", "no quote to serve, so the replay walks on to the model effect");
  assert.equal(report.match, false, "and that is now reported rather than graded a faithful reproduction");
  const terminal = report.frames.find((f) => f.kind === "run.failed");
  assert.ok(terminal !== undefined);
  assert.equal(terminal!.expected, "failed:E_BUDGET_EXHAUSTED");
  assert.equal(terminal!.actual, "failed:E_REPLAY_DIVERGENCE");
});

test("THE THIRD OF THE THREE: the RUN's token reservation is the same number live and replayed", async () => {
  // `ctx.policy.reserve(scope, estimateUsd, estimateTurnTokens(shaped, ceiling))` is the last of
  // the three quantities that could not be re-derived, and the least visible: it does not print a
  // node's name, it charges the whole run's balance. Before the quote effect a replay charged the
  // UNPADDED number here — so a run that exhausted its token budget replayed as a run that had
  // budget left, and went on to make effects the recording never recorded.
  //
  // 500 run tokens, no node ceiling at all, so the only thing that can refuse is `PolicyEngine`.
  const named = new MockModelAdapter({ provider: "leaf", script: () => ({ text: "ok", finishReason: "stop" }) });
  const r = await liveRun(named, undefined, { runUsd: 10, runTokens: 500 });
  const report = await replayRun({ store: r.store, runId: r.runId, graph: r.graph, engine: r.engine });

  assert.equal(r.live.error?.code, "E_BUDGET_EXHAUSTED", JSON.stringify(r.live.error ?? {}));
  assert.match(r.live.error?.message ?? "", /reserving 1041 tokens would exceed the 500-token budget/);
  assert.equal(report.replayed.error?.code, "E_BUDGET_EXHAUSTED", "the replay reserves against the recorded quote");
  assert.equal(report.replayed.error?.message, r.live.error?.message);
  assert.equal(report.match, true, diverged(report));

  // AND THE CONTROL, which is what makes the assertion above about the quote rather than about
  // arithmetic that happened to agree: strip the quote rows and the replay charges 17 instead of
  // 1041, does not refuse, and reaches the model effect the recording never made.
  const older = await replayRun({ store: new WithoutQuotes(r.store), runId: r.runId, graph: r.graph, engine: r.engine });
  assert.equal(older.replayed.error?.code, "E_REPLAY_DIVERGENCE");
  assert.equal(older.match, false);
});

test("THE SECOND OF THE THREE: the node `costUsd` ceiling refused NOTHING AT ALL in replay", async () => {
  // This one predates D.7.3 and was undocumented until the class was named. `estimateOf(shaped)
  // ?? 0` meant a replay compared `spent + 0` against the cap — so the check ran, could never
  // fire, and looked like it was working. It is the quietest member of the three: unlike the
  // token ceiling it does not even reach a divergence on its own, it simply lets the turn
  // through.
  //
  // The node's cap is $0.0005 and this adapter prices the turn at $0.001041.
  const named = new MockModelAdapter({ provider: "leaf", script: () => ({ text: "ok", finishReason: "stop" }) });
  const r = await liveRun(named, undefined, { runUsd: 10 }, 0.0005);
  const report = await replayRun({ store: r.store, runId: r.runId, graph: r.graph, engine: r.engine });

  assert.equal(r.live.error?.code, "E_BUDGET_EXHAUSTED", JSON.stringify(r.live.error ?? {}));
  assert.match(r.live.error?.message ?? "", /would exceed its \$0\.00 budget \(\$0\.0000 spent by this task, \$0\.0010 estimated/);
  assert.equal(report.replayed.error?.code, "E_BUDGET_EXHAUSTED", "the replay refuses from the recorded estimate");
  assert.equal(report.replayed.error?.message, r.live.error?.message);
  assert.equal(report.match, true, diverged(report));

  // THE CONTROL: with the quote rows gone the estimate is 0 again, the cap cannot be crossed, and
  // the replay walks into a model effect the recording never made.
  const older = await replayRun({ store: new WithoutQuotes(r.store), runId: r.runId, graph: r.graph, engine: r.engine });
  assert.equal(older.replayed.error?.code, "E_REPLAY_DIVERGENCE", "0 > 0.0005 is false, so nothing refuses");
  assert.equal(older.match, false);
});

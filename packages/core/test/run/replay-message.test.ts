/**
 * A REFUSAL THAT KEPT ITS CODE AND CHANGED ITS SENTENCE WAS GRADED A FAITHFUL REPRODUCTION.
 *
 * `compare()` in `run/replay.ts` weighed task states, gates, channels and — since A.1 — the error
 * CODE. That last one catches a refusal that became a DIFFERENT refusal. It cannot see the one
 * this file is about: same status, same code, same channels, two different sentences, `match:
 * true` throughout. `loom replay`'s exit code and `evolution/gate.ts`'s promotion decision both
 * read that verdict, so "the replay said something else" was invisible to the two places that act.
 *
 * The instance was the provider refusal at `engine.ts`'s `framedProvider === ""`, which opened
 * with `model adapter "<name>"` live and `the recorded turn` in replay. That wording was made
 * path-independent, and the class stayed open behind it. THE CLASS IS WHAT IS DRIVEN HERE, by a
 * mechanism the tree still has: an old journal that carries no `quote` effect refuses the same
 * turn from the unpadded transcript estimate, so the recording says `1041 estimated` and the
 * replay says `17 estimated … a FLOOR` under one `E_BUDGET_EXHAUSTED`.
 *
 * THE OTHER HALF IS THAT IT MUST NOT GO RED FOR A DIFFERENCE THAT IS LEGITIMATE, which is the
 * whole reason the frame did not exist before. `run/replay.ts` argued that a message "carries
 * numbers that legitimately differ between a recording and its replay (`spent`, `estimated`, an
 * adapter name)". All three of those are driven below and all three are byte-identical at HEAD —
 * A.1 put the adapter's answers on the journal, and the adapter's name moved onto
 * `details.adapter`. The one difference that survives is a MINTED id, and it has its own case.
 */
import test from "node:test";
import assert from "node:assert/strict";

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
import { replayRun, type ReplayFrame, type ReplayReport } from "../../src/run/replay.ts";

const NOW = 1_700_000_000_000;

const resolver: ResourceResolver = {
  resolve: (ref) =>
    /^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref)
      ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" }
      : undefined,
  document: () => "Instructions.",
};

function spec(nodeTokens?: number, nodeCostUsd?: number): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "ag", project: "message", version: 1 },
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

interface Recorded {
  readonly live: RunProjection;
  readonly store: MemoryStateStore;
  readonly runId: RunId;
  readonly graph: ReturnType<typeof compileOrThrow>;
  readonly engine: Parameters<typeof replayRun>[0]["engine"];
}

/** One agent node, run live, and the journal it wrote. */
async function liveRun(
  adapter: ModelAdapter,
  nodeTokens?: number,
  budget: { readonly runUsd?: number; readonly runTokens?: number } = { runUsd: 10 },
  nodeCostUsd?: number,
): Promise<Recorded> {
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
    resolver,
    policy: { granted: [], systemFloor: "out", budget },
  });
  const graph = compileOrThrow({ spec: spec(nodeTokens, nodeCostUsd), resolver, tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { q: "hi" } });
  const live = await engine.advance(runId);
  return {
    live,
    store,
    runId,
    graph,
    // The shadow Engine gets the SAME policy, or it holds no run budget at all and cannot reach
    // a `PolicyEngine` refusal however faithful its numbers are.
    engine: {
      tools,
      functions: new FunctionRegistry(),
      models,
      resolver,
      policy: { granted: [], systemFloor: "out" as const, budget },
    },
  };
}

/** Is this event half of a `quote` effect? Both halves carry the key; only the start carries the kind. */
function isQuoteEvent(e: JournalEvent): boolean {
  const key = (e.payload as { key?: unknown }).key;
  if (typeof key !== "string") return false;
  return (e.type === "effect.started" || e.type === "effect.completed" || e.type === "effect.failed") && key.includes(":quote:");
}

/** A journal written before the `quote` effect existed — the one A.1 could not reach. */
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

const messageFrame = (r: ReplayReport): ReplayFrame | undefined => r.frames.find((f) => f.kind === "run.message");
const diverged = (r: ReplayReport): string => JSON.stringify(r.frames.filter((f) => !f.match));

test("THE DEFECT: one code, two sentences, and the verdict used to be `match: true`", async () => {
  // `budget.tokens: 10` is refused on both paths, so the CODE agrees and the frame above this one
  // is green. What differs is the number the refusal is computed from: the recording had the
  // adapter's 1,024-token ceiling to add, the quote-less journal has only the 17-token transcript.
  // Two different claims about why a run was stopped, under one classification.
  const named = new MockModelAdapter({ provider: "leaf", script: () => ({ text: "ok", finishReason: "stop" }) });
  const r = await liveRun(named, 10);
  const report = await replayRun({ store: new WithoutQuotes(r.store), runId: r.runId, graph: r.graph, engine: r.engine });

  assert.equal(r.live.error?.code, "E_BUDGET_EXHAUSTED");
  assert.equal(report.replayed.error?.code, "E_BUDGET_EXHAUSTED", "the codes AGREE — that is the whole point of this case");
  assert.notEqual(report.replayed.error?.message, r.live.error?.message, "and the sentences do not");

  // TERMINAL AND LOUD (§G.3), AND ASSERTED FIRST ON PURPOSE. `match` is the field `cli.ts` turns
  // into an exit code and `evolution/gate.ts` reads for `identicalToRecording`; a frame nobody
  // folds into it is worth nothing. Delete the `run.message` push from `compare()` and this is
  // the line that goes red — `false !== true` — which is the defect stated as an assertion.
  assert.equal(report.match, false, "the divergence must reach the verdict, not just the frame list");

  const frame = messageFrame(report);
  assert.ok(frame !== undefined, "a failed run must be graded on what it said");
  assert.equal(frame.match, false);
  assert.match(frame.expected ?? "", /1041 estimated for this turn/, "the recording's number");
  assert.match(frame.actual ?? "", /17 estimated for this turn/, "the replay's, unpadded");
});

test("THE STANDING OBJECTION, DRIVEN: `spent`, `estimated` and the adapter name are byte-identical now", async () => {
  // `run/replay.ts` refused to grade the message because one "carries numbers that legitimately
  // differ between a recording and its replay (`spent`, `estimated`, an adapter name)". That was
  // true and is not: A.1's `quote` effect put both adapter answers on the journal. These are the
  // three refusals A.1 fixed, and each is the objection's own counter-example.
  const named = () => new MockModelAdapter({ provider: "leaf", script: () => ({ text: "ok", finishReason: "stop" }) });

  const node = await liveRun(named(), 500);
  const nodeReport = await replayRun({ store: node.store, runId: node.runId, graph: node.graph, engine: node.engine });
  assert.match(node.live.error?.message ?? "", /would exceed its 500-token budget \(0 spent by this task, 1041 estimated/);
  assert.equal(messageFrame(nodeReport)?.match, true, diverged(nodeReport));

  const cost = await liveRun(named(), undefined, { runUsd: 10 }, 0);
  const costReport = await replayRun({ store: cost.store, runId: cost.runId, graph: cost.graph, engine: cost.engine });
  assert.match(cost.live.error?.message ?? "", /\$0\.0000 spent by this task, \$0\.0010 estimated/);
  assert.equal(messageFrame(costReport)?.match, true, diverged(costReport));

  const run = await liveRun(named(), undefined, { runUsd: 10, runTokens: 500 });
  const runReport = await replayRun({ store: run.store, runId: run.runId, graph: run.graph, engine: run.engine });
  assert.match(run.live.error?.message ?? "", /reserving 1041 tokens would exceed the 500-token budget \(0 spent, 0 reserved\)/);
  assert.equal(messageFrame(runReport)?.match, true, diverged(runReport));

  for (const rep of [nodeReport, costReport, runReport]) {
    assert.equal(rep.match, true, diverged(rep));
  }
});

test("THE THIRD OBJECTION IS AN ARGUMENT FOR THE MESSAGE AND AGAINST THE `details`", async () => {
  // A `done` frame that names no provider — the survey's own reproduction. The refusal's TEXT is
  // path-independent, so this replays green; its `details.adapter` is `"wrapper"` live and `null`
  // in a replay, because a replay reaches no adapter and has nothing to ask. Grading `details`
  // would report this faithful reproduction as broken, which is why the frame grades the sentence.
  class Nameless implements ModelAdapter {
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
  const r = await liveRun(new Nameless());
  const report = await replayRun({ store: r.store, runId: r.runId, graph: r.graph, engine: r.engine });

  assert.equal(r.live.error?.code, "E_PROVIDER_BAD_REQUEST");
  assert.equal(report.replayed.error?.code, "E_PROVIDER_BAD_REQUEST");
  assert.equal(report.replayed.error?.message, r.live.error?.message, "the wording does not branch on the path");

  const detail = (e: unknown): unknown => (e as { details?: { adapter?: unknown } } | undefined)?.details?.adapter;
  assert.equal(detail(r.live.error), "wrapper", "live: the adapter that served the turn");
  assert.equal(detail(report.replayed.error), null, "replay: there was no adapter to ask");

  assert.equal(messageFrame(report)?.match, true, diverged(report));
  assert.equal(report.match, true, "a difference confined to `details` is legitimate and must not go red");
});

test("A COMPLETED PAIR IS NOT GRADED ON A MESSAGE IT DOES NOT HAVE", async () => {
  // A frame that is always `match: true` teaches its reader to skip the family, so the frame is
  // emitted only when a refusal is in evidence on one side or the other.
  const r = await liveRun(new MockModelAdapter({ provider: "leaf", script: () => ({ text: "ok", finishReason: "stop" }) }));
  const report = await replayRun({ store: r.store, runId: r.runId, graph: r.graph, engine: r.engine });

  assert.equal(r.live.status, "succeeded");
  assert.equal(report.match, true, diverged(report));
  assert.equal(messageFrame(report), undefined, "nothing failed, so there is no sentence to weigh");
});

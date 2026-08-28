/**
 * A TRACE CAN FOLLOW A SUBGRAPH — the three shapes a child run ends in, and the two
 * traces it takes to see them.
 *
 * The child of a `subgraph` node runs under `${parent}~${taskId}` with its OWN journal,
 * so a fold over the parent's events can only ever produce a LINK. The tests below pin
 * both halves of that split: `spansFrom` mints the link (pure, one journal), and
 * `spliceSubgraph` joins two folds into one tree (pure, two journals, I/O in the caller).
 *
 * Hand-written journals, every `ts` a literal: a span's `endTime` here is an assertion
 * about the fold and never about the machine. The three child shapes — succeeded, failed,
 * still running — cannot be produced by one driven run, and the failed and running shapes
 * are the ones the parent's journal is SILENT about, which is exactly what has to render
 * truthfully.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { childRunIdsOf, conformsToGraph, reconstructGraph, spansFrom, spliceSubgraph, type Span } from "../../src/telemetry/spans.ts";
import { SYSTEM_ACTOR, type JournalEvent } from "../../src/journal/events.ts";
import type { RunId, TaskId } from "../../src/ids.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";

const PARENT = "01JRUNPARENT000000000000000" as RunId;
const TASK = "delegate@#0" as TaskId;
const CHILD = `${PARENT}~${TASK}` as RunId;

function ev(runId: RunId, seq: number, type: string, payload: unknown, taskId: TaskId | null): JournalEvent {
  return {
    runId,
    seq,
    ts: 1_000 + seq * 10,
    type,
    payload,
    actor: SYSTEM_ACTOR("test"),
    ...(taskId === null ? {} : { taskId }),
    classification: "internal",
  } as unknown as JournalEvent;
}

/** The parent's journal up to and including `subgraph.started` — the child is now running. */
function parentUpToStart(): JournalEvent[] {
  return [
    ev(PARENT, 1, "run.submitted", { workflow: "w", graphHash: "sha256:parent", inputs: {}, idempotencyKey: "k", configDigest: "c" }, null),
    ev(PARENT, 2, "task.ready", { nodeId: "delegate", branchPath: "", edgesIn: [] }, TASK),
    ev(PARENT, 3, "task.leased", { attempt: 1, workerId: "w1" }, TASK),
    ev(PARENT, 4, "subgraph.started", { childRunId: CHILD, ref: "child-wf", graphHash: "sha256:child", budgetUsd: 2.5 }, TASK),
  ];
}

/** The three events the engine appends in ONE batch when a child SUCCEEDS. */
function parentCompletion(seq: number): JournalEvent[] {
  const key = `${TASK}:subgraph:0`;
  return [
    ev(PARENT, seq, "effect.started", { key, kind: "subgraph", attempt: 1 }, TASK),
    ev(PARENT, seq + 1, "effect.completed", { key, result: { writes: {} }, resultDigest: "sha256:w" }, TASK),
    ev(
      PARENT,
      seq + 2,
      "subgraph.completed",
      { childRunId: CHILD, ref: "child-wf", status: "succeeded", usage: { inputTokens: 7, outputTokens: 11, costUsd: 0.5, wallMs: 40 }, outputs: ["out"] },
      TASK,
    ),
  ];
}

function subgraphSpan(spans: readonly Span[]): Span {
  const s = spans.find((x) => x.attributes["effect.kind"] === "subgraph");
  assert.ok(s, "no span was built for the subgraph effect");
  return s;
}

test("a subgraph span carries the route into the child's own run", () => {
  const spans = spansFrom([...parentUpToStart(), ...parentCompletion(5)]);
  const sub = subgraphSpan(spans);

  assert.equal(sub.attributes["subgraph.child_run_id"], CHILD, "the child's run id is the whole route, and it is on the payload already");
  assert.equal(sub.attributes["subgraph.ref"], "child-wf");
  assert.equal(sub.attributes["subgraph.graph_hash"], "sha256:child");
  assert.equal(sub.attributes["subgraph.budget_usd"], 2.5);
  assert.equal(sub.attributes["subgraph.status"], "succeeded");
  assert.equal(sub.attributes["cost.total_usd"], 0.5);

  // The link is what an OTLP exporter needs: the child is a DIFFERENT trace, so a bare
  // spanId would point at nothing.
  const childRoot = spansFrom([
    ev(CHILD, 1, "run.submitted", { workflow: "child-wf", graphHash: "sha256:child", inputs: {}, idempotencyKey: "k", configDigest: "c" }, null),
  ])[0]!;
  assert.equal(sub.links.length, 1, "exactly one link, to the child's root span");
  assert.equal(sub.links[0]!.spanId, childRoot.spanId);
  assert.equal(sub.links[0]!.traceId, childRoot.traceId);
  assert.notEqual(childRoot.traceId, sub.traceId, "two runs are two traces — that is the fact the link exists for");

  assert.deepEqual(childRunIdsOf(spans), [CHILD]);
});

test("the span measures the CHILD, not the batch that recorded it", () => {
  const started = parentUpToStart();
  const spans = spansFrom([...started, ...parentCompletion(50)]);
  const sub = subgraphSpan(spans);

  // `effect.started` and `effect.completed` are appended together AFTER the child finished,
  // so a span built from them alone is zero-width for a child that ran for minutes.
  assert.equal(sub.startTime, started[3]!.ts, "it starts when the child was submitted");
  assert.ok(sub.endTime - sub.startTime > 0, `a subgraph span may not be zero-width; got ${sub.endTime - sub.startTime}ms`);
  assert.equal(spans.filter((s) => s.attributes["effect.kind"] === "subgraph").length, 1, "one subgraph is one span");
});

test("a child that FAILED renders as failed, and says the parent never heard it finish", () => {
  // The engine returns before the `effect.started`/`subgraph.completed` batch on every
  // non-success exit, so the parent's journal holds a `subgraph.started` and nothing else
  // about the child. What it DOES hold is its own task failing.
  const spans = spansFrom([
    ...parentUpToStart(),
    ev(PARENT, 5, "task.failed", { error: { code: "E_SUBGRAPH_FAILED" } }, TASK),
    ev(PARENT, 6, "task.committed", { take: [], status: "failed" }, TASK),
    ev(PARENT, 7, "run.failed", { error: { code: "E_SUBGRAPH_FAILED" } }, null),
  ]);
  const sub = subgraphSpan(spans);

  assert.equal(sub.status, "error", "an in-flight `unset` would read as a child still working");
  assert.equal(sub.attributes["subgraph.status"], "unreported");
  assert.equal(sub.endTime, 1_060, "it closes when the parent's task committed, not at the end of the journal");
});

test("a child still RUNNING renders as in flight", () => {
  const spans = spansFrom(parentUpToStart());
  const sub = subgraphSpan(spans);

  assert.equal(sub.status, "unset", "in flight is not an error");
  assert.equal(sub.attributes["subgraph.status"], undefined, "nothing may claim a status the journal does not hold");
  assert.equal(sub.attributes["subgraph.child_run_id"], CHILD, "the route is there before the child finishes — that is when it is wanted");
});

test("spliceSubgraph joins two folds into one tree without inventing a span", () => {
  const parent = spansFrom([...parentUpToStart(), ...parentCompletion(5)]);
  const child = spansFrom([
    ev(CHILD, 1, "run.submitted", { workflow: "child-wf", graphHash: "sha256:child", inputs: {}, idempotencyKey: "k", configDigest: "c" }, null),
    ev(CHILD, 2, "task.ready", { nodeId: "inner", branchPath: "", edgesIn: [] }, "inner@#0" as TaskId),
    ev(CHILD, 3, "task.committed", { take: [], status: "succeeded" }, "inner@#0" as TaskId),
    ev(CHILD, 4, "run.completed", { usage: { inputTokens: 7, outputTokens: 11, costUsd: 0.5, wallMs: 40 }, outputs: {} }, null),
  ]);

  const one = spliceSubgraph(parent, child);
  assert.equal(one.length, parent.length + child.length, "a splice adds no span and drops none");
  assert.ok(
    one.every((s) => s.traceId === parent[0]!.traceId),
    "one tree is one traceId — a spliced child keeping its own is two trees wearing one",
  );

  const sub = subgraphSpan(one);
  const childRoot = one.find((s) => s.name === "loom.run" && s.attributes["run.id"] === CHILD);
  assert.ok(childRoot, "the child's root span survived the splice");
  assert.equal(childRoot.parentSpanId, sub.spanId, "the child's run hangs off the subgraph span that started it");

  // Idempotent: the CLI walks a queue and may reach the same child twice.
  assert.equal(spliceSubgraph(one, child).length, one.length);
});

test("NEITHER NEW FUNCTION THROWS FOR ANY TRACE — the claim their docstrings make, measured", () => {
  // Same sweep shape as `shouldExport DOES NOT THROW FOR ANY POLICY` next door, and for the
  // same reason: a trace is a value whose premise says it need not have come from `spansFrom`,
  // and `readSpans`' spread is a `[[Get]]` per key on it — the read a claim that stopped at
  // the field guards would have missed. `revocable` is in the list because `Array.isArray`
  // THROWS on a revoked proxy, which is how `isList` came to exist.
  const boom = (): never => {
    throw new Error("trap");
  };
  const throwingElement: unknown[] = [];
  Object.defineProperty(throwingElement, "0", { get: boom, enumerable: true, configurable: true });
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  const hostileSpan = new Proxy({ spanId: "a", traceId: "t", startTime: 0, links: [] }, { ownKeys: boom });
  const hostileLinks = { spanId: "a", traceId: "t", startTime: 0, links: new Proxy([{}], { get: boom }) };

  const traces: unknown[] = [
    undefined,
    null,
    7,
    "spans",
    {},
    revoked.proxy,
    throwingElement,
    new Proxy([], { get: boom }),
    [null, 7, { spanId: 1 }],
    [{ spanId: "a", traceId: "t", startTime: 0, links: null }],
    [hostileSpan],
    [hostileLinks],
    [{ get attributes() { return boom(); }, spanId: "a", traceId: "t", startTime: 0, links: [] }],
    [{ attributes: new Proxy({}, { get: boom }), spanId: "a", traceId: "t", startTime: 0, links: [] }],
    [{ spanId: "a", traceId: "t", startTime: 0, links: [], attributes: { "subgraph.child_run_id": 7 } }],
  ];

  const ok = spansFrom([...parentUpToStart(), ...parentCompletion(5)]);
  for (const t of traces) {
    const label = (): string => {
      try {
        return JSON.stringify(t) ?? String(t);
      } catch {
        return "(unprintable)";
      }
    };
    assert.doesNotThrow(() => childRunIdsOf(t as readonly Span[]), `childRunIdsOf threw on ${label()}`);
    assert.doesNotThrow(() => spliceSubgraph(t as readonly Span[], ok), `spliceSubgraph threw as the parent on ${label()}`);
    assert.doesNotThrow(() => spliceSubgraph(ok, t as readonly Span[]), `spliceSubgraph threw as the child on ${label()}`);
  }

  // AN ARRAY-LIKE IS NOT A LIST, which is what `isList` is for and what a `length` guard
  // alone does NOT catch: `{length: 1, "0": …}` answers every read the walk makes. Found by
  // mutation — deleting `isList` from `childRunIdsOf` left the suite green, because every
  // other hostile shape above is stopped by the `length` read one line down. A trace is an
  // ARRAY of spans; a bag wearing the shape of one is not a trace, and following a run id off
  // it would send `loom trace` to read a journal nothing claimed.
  const arrayLike = { length: 1, "0": { attributes: { "subgraph.child_run_id": "01JNOTAREALRUN" } } };
  assert.deepEqual(childRunIdsOf(arrayLike as unknown as readonly Span[]), [], "an array-like is not a trace");

  // And an honest trace is not collateral damage of any of that.
  assert.deepEqual(childRunIdsOf(ok), [CHILD]);
});

const PARENT_SPEC = { nodes: [{ id: "delegate" }], edges: [] } as unknown as GraphSpec;

test("conformance still answers over ONE run, and REFUSES a trace covering two graphs", () => {
  const parent = spansFrom([...parentUpToStart(), ...parentCompletion(5)]);
  const child = spansFrom([
    ev(CHILD, 1, "run.submitted", { workflow: "child-wf", graphHash: "sha256:child", inputs: {}, idempotencyKey: "k", configDigest: "c" }, null),
    ev(CHILD, 2, "task.ready", { nodeId: "inner", branchPath: "", edgesIn: [] }, "inner@#0" as TaskId),
  ]);

  const alone = conformsToGraph(reconstructGraph(parent), PARENT_SPEC, "sha256:parent");
  assert.equal(alone.ok, true, `the parent alone must still certify: ${JSON.stringify(alone)}`);

  // Two `loom.run` spans claiming two hashes is a trace no single spec can certify. The
  // fail-open it replaces was worse than a refusal: `graphHash` was last-write-wins, so the
  // verdict depended on which run's span sorted last.
  const spliced = reconstructGraph(spliceSubgraph(parent, child));
  assert.equal(spliced.graphHash, "(multiple)", "a trace over two graphs may not answer with one of them");
  assert.equal(conformsToGraph(spliced, PARENT_SPEC, "sha256:parent").ok, false);
  assert.equal(conformsToGraph(spliced, PARENT_SPEC, "sha256:child").ok, false);
});

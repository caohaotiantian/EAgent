/**
 * `run/served.ts` against what the engine ACTUALLY handed each body — the differential the fold's
 * whole argument rests on (`TODO.md` §A.29, RISK 1).
 *
 * The fold says "Task T was served the kernel fold of the journal through T's last lease, at T's
 * branch". That is a claim about `Engine.#runWaveInner` (leases first, ONE snapshot, then the
 * bodies, then commits in branch order) and about `#executeTask` (payload handles resolved to
 * values), and it is proven here by running rather than by reading: every body ECHOES the content
 * digest of each channel it declared, as its view gave it, into a channel of its own. The test then
 * asks `servedTo` the same question from the journal alone and requires the two to agree, channel
 * for channel, including "absent".
 *
 * THE SHAPES THAT COULD SEPARATE THEM, each present:
 *   - a two-node wave (`a`,`b`) and a second wave (`c`,`d`,`p1`,`p2`) — `d` reads `shared`, which
 *     its wave-mate `c` overwrites in the SAME wave: the fold must answer `a`'s value, not `c`'s;
 *     and `p1`/`p2` each read what the other writes, so one of them commits AFTER the other's
 *     write has landed — an answer cut at the commit instead of the lease would see it;
 *   - a RETRY: `c` asks to be retried on its first attempt, so it holds two leases and its
 *     successful body ran on the snapshot after the SECOND — after `d` committed. `c` reads `d`,
 *     which is absent at its first lease and present at its second;
 *   - an EXTERNALISED payload: `big` is over the threshold, so the fold holds a handle and every
 *     body is handed the value. `contentDigest` must compare the two like with like;
 *   - a VIEW THAT IS NOT THE STATE: `stamp` is `last_write_wins_by_ts`, stored as an envelope and
 *     handed unwrapped, and `a:error` is a reserved projection no channel holds. An answer read
 *     off raw state gets the first wrong and the second absent.
 *
 * And the undecidable set `served.ts` names, driven on real journals edited by one event.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { digest } from "../../src/canonical.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { ROOT_BRANCH, childBranch, taskId, type NodeId, type TaskId } from "../../src/ids.ts";
import { isEvent, type JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { memoryPayloads } from "../../src/journal/payloads.ts";
import { Engine } from "../../src/run/engine.ts";
import { foldRun } from "../../src/run/projection.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type FunctionBody } from "../../src/run/registry.ts";
import { contentDigest, servedTo } from "../../src/run/served.ts";
import { resolver } from "./skeleton.ts";

const NOW = 1_700_000_000_000;
const BIG = "y".repeat(200_000);

const READS: Record<string, readonly string[]> = {
  a: ["x"],
  b: ["x"],
  c: ["x", "a", "b", "big", "shared", "d", "stamp", "a:error"],
  d: ["x", "a", "b", "big", "shared", "c"],
  e: ["x", "a", "b", "big", "shared", "c", "d"],
  p1: ["x", "q2"],
  p2: ["x", "q1"],
};

function spec(): GraphSpec {
  const obj = { type: "object", reduce: "replace" };
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "served-differential", project: "served", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 32, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: {
      x: { type: "string", reduce: "replace" },
      big: { type: "string", reduce: "replace" },
      shared: { type: "string", reduce: "replace" },
      stamp: { type: "object", reduce: "last_write_wins_by_ts" },
      a: obj,
      b: obj,
      c: obj,
      d: obj,
      e: obj,
      p1: obj,
      p2: obj,
      q1: { type: "string", reduce: "replace" },
      q2: { type: "string", reduce: "replace" },
    },
    inputs: ["x", "stamp"],
    outputs: ["e"],
    nodes: [
      { id: "a", type: "function", reads: READS["a"], writes: ["a", "big", "shared"], function: { ref: "function/a@stable" } },
      { id: "b", type: "function", reads: READS["b"], writes: ["b"], function: { ref: "function/b@stable" } },
      {
        id: "c",
        type: "function",
        reads: READS["c"],
        writes: ["c", "shared"],
        function: { ref: "function/c@stable" },
        retry: { maxAttempts: 2, backoff: "fixed", initialMs: 0 },
      },
      { id: "d", type: "function", reads: READS["d"], writes: ["d"], function: { ref: "function/d@stable" } },
      { id: "e", type: "function", reads: READS["e"], writes: ["e"], function: { ref: "function/e@stable" } },
      { id: "p1", type: "function", reads: READS["p1"], writes: ["p1", "q1"], function: { ref: "function/p1@stable" } },
      { id: "p2", type: "function", reads: READS["p2"], writes: ["p2", "q2"], function: { ref: "function/p2@stable" } },
    ],
    edges: [
      { id: "ac", from: "a", to: "c", kind: "seq" },
      { id: "ad", from: "a", to: "d", kind: "seq" },
      { id: "ce", from: "c", to: "e", kind: "seq" },
      { id: "bp1", from: "b", to: "p1", kind: "seq" },
      { id: "bp2", from: "b", to: "p2", kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

/** What a body's view handed it, as content digests — `null` for a channel it was not handed. */
const echo = (reads: readonly string[], view: Parameters<FunctionBody>[0]): Record<string, string | null> =>
  Object.fromEntries(reads.map((r) => [r, view.get(r) === undefined ? null : digest(view.get(r))]));

async function recorded(): Promise<{ events: JournalEvent[]; cAttempts: number }> {
  let cAttempts = 0;
  const f = new FunctionRegistry();
  f.register("function/a@stable", (view) => ({ writes: { a: { echo: echo(READS["a"]!, view) }, big: `${BIG}${String(view.get("x"))}`, shared: "from-a" } }));
  f.register("function/b@stable", (view) => ({ writes: { b: { echo: echo(READS["b"]!, view) } } }));
  f.register("function/c@stable", (view) => {
    cAttempts++;
    if (cAttempts === 1) return { retry: { reason: "once, so this Task holds two leases" } };
    return { writes: { c: { echo: echo(READS["c"]!, view) }, shared: "from-c" } };
  });
  f.register("function/d@stable", (view) => ({ writes: { d: { echo: echo(READS["d"]!, view) } } }));
  f.register("function/e@stable", (view) => ({ writes: { e: { echo: echo(READS["e"]!, view) } } }));
  // Two wave-mates that each read what the other writes: whichever commits first, the other's
  // commit lands after it — so an answer cut at the COMMIT rather than the lease sees a write its
  // body never did.
  f.register("function/p1@stable", (view) => ({ writes: { p1: { echo: echo(READS["p1"]!, view) }, q1: "from-p1" } }));
  f.register("function/p2@stable", (view) => ({ writes: { p2: { echo: echo(READS["p2"]!, view) }, q2: "from-p2" } }));
  const store = new MemoryStateStore({ now: () => NOW });
  const engine = new Engine({
    store,
    tools: new ToolRegistry(),
    functions: f,
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: [], systemFloor: "out" },
    payloads: memoryPayloads(),
  });
  const graph = compileOrThrow({ spec: spec(), resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { x: "seed", stamp: { value: "inner", ts: 1 } } });
  const p = await engine.advance(runId);
  assert.equal(p.status, "succeeded", JSON.stringify(p.error));
  const events: JournalEvent[] = [];
  for await (const e of store.read(runId, 1)) events.push(e);
  return { events, cAttempts };
}

const tid = (node: string): TaskId => taskId(node as NodeId, ROOT_BRANCH, 0);
const SPECS = spec().channels;

test("the fold's answer IS the view each body was handed — two waves, a same-wave overwrite, a retry, a payload handle", async () => {
  const { events, cAttempts } = await recorded();
  const final = foldRun(events)!;

  // THE SHAPES ARE REALLY THERE, or the agreement below proves less than it says.
  assert.equal(cAttempts, 2, "c ran twice");
  assert.equal(events.filter((e) => isEvent(e, "task.leased") && e.taskId === tid("c")).length, 2, "c holds two leases");
  assert.ok(final.external["big"] !== undefined, "big is a payload handle in the fold");
  const echoOf = (node: string): Record<string, string | null> => (final.channels[node] as { echo: Record<string, string | null> }).echo;
  // d's wave-mate c overwrote `shared` in the same wave, and d was handed a's value.
  assert.equal(echoOf("d")["shared"], digest("from-a"));
  // c's successful body ran after d committed; its first lease predates that.
  assert.notEqual(echoOf("c")["d"], null, "c's committing body saw d");
  assert.equal(echoOf("d")["c"], null, "d did not see its wave-mate c");
  assert.deepEqual([echoOf("p1")["q2"], echoOf("p2")["q1"]], [null, null], "p1 and p2 saw neither other's write");
  // The view is not the state: an lww envelope is handed unwrapped, and a reserved projection exists.
  assert.equal(echoOf("c")["stamp"], digest("inner"), "c was handed the unwrapped value");
  assert.notEqual(echoOf("c")["a:error"], null, "c was handed a's error projection");

  for (const node of Object.keys(READS)) {
    const served = servedTo(events, tid(node), READS[node]!, SPECS);
    assert.ok(served.decidable, `${node}: ${served.decidable ? "" : served.reason}`);
    const answer = Object.fromEntries(READS[node]!.map((r) => [r, contentDigest(served, r) ?? null]));
    assert.deepEqual(answer, echoOf(node), `${node}: the fold and the body disagree about what it was served`);
  }
  // And the fold kept the handle rather than the value, so "like with like" was exercised.
  const cServed = servedTo(events, tid("c"), READS["c"]!, SPECS);
  assert.ok(cServed.decidable && cServed.external["big"] !== undefined, "c's served big is a handle in the fold");
});

test("UNDECIDABLE is the answer for a Task that ran more than once, never ran, never leased, was hidden by a rewind, or sits in a fan-out", async () => {
  const { events } = await recorded();
  const last = events[events.length - 1]!;
  const commitOf = events.find((e) => isEvent(e, "task.committed") && e.taskId === tid("e"))!;
  const leaseOf = events.find((e) => isEvent(e, "task.leased") && e.taskId === tid("e"))!;

  // §A.101's shape: a committed Task leased and committed again.
  const reran = [...events, { ...leaseOf, seq: last.seq + 1 }, { ...commitOf, seq: last.seq + 2 }] as JournalEvent[];
  const twice = servedTo(reran, tid("e"), READS["e"]!, SPECS);
  assert.equal(twice.decidable, false);
  assert.match(twice.decidable ? "" : twice.reason, /committed 2 times/);

  const releasedOnly = [...events, { ...leaseOf, seq: last.seq + 1 }] as JournalEvent[];
  const after = servedTo(releasedOnly, tid("e"), READS["e"]!, SPECS);
  assert.match(after.decidable ? "" : after.reason, /leased again after its commit/);

  const noCommit = events.filter((e) => e !== commitOf);
  assert.match((servedTo(noCommit, tid("e"), READS["e"]!, SPECS) as { reason: string }).reason, /never committed/);

  const noLease = events.filter((e) => !(isEvent(e, "task.leased") && e.taskId === tid("e")));
  assert.match((servedTo(noLease, tid("e"), READS["e"]!, SPECS) as { reason: string }).reason, /no lease before its commit/);

  // A rewind that hid the lease and the commit hides the Task: the kernel's `suppressedRanges`.
  const rewound = [
    ...events,
    { ...last, seq: last.seq + 1, type: "checkpoint.restored", taskId: undefined, payload: { checkpointId: "cp", mode: "rewind", atSeq: leaseOf.seq - 1, reason: "test" } },
  ] as unknown as JournalEvent[];
  assert.match((servedTo(rewound, tid("e"), READS["e"]!, SPECS) as { reason: string }).reason, /never committed/);

  const inFanout = taskId("e" as NodeId, childBranch(ROOT_BRANCH, "fan", 0), 0);
  assert.match((servedTo(events, inFanout, READS["e"]!, SPECS) as { reason: string }).reason, /fan-out/);
});

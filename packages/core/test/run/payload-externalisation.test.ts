/**
 * A LARGE CHANNEL VALUE IS COPIED INTO THE JOURNAL ONCE PER HOP, AND NOTHING STOPPED IT.
 *
 * `journal/store.ts` measured the amplification and bounded it at 8 MiB per event, then said
 * plainly what the bound is not: "THIS IS A BOUND, NOT THE FIX ... which needs payload
 * externalisation — a reference above a threshold, resolved on read." Two comments named the
 * need and no code implemented it. The first test here is that measurement, run against a real
 * Engine, with and without the fix.
 *
 * The rest are the properties externalisation is only sound if it has:
 *   - the node still receives the VALUE, not the reference, and receives it synchronously;
 *   - the reference is DERIVED, so the same document produces the same journal;
 *   - a value at or below the threshold is not externalised at all;
 *   - a second process reading the same journal reconstructs the same handles and resolves them;
 *   - an engine that CANNOT resolve one refuses, run-fatally, rather than handing a node the
 *     handle and letting it succeed on the wrong value.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalize } from "../../src/canonical.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { RunId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { EXTERNALISE_ABOVE_BYTES, filePayloads, memoryPayloads, type PayloadStore } from "../../src/journal/payloads.ts";
import type { StateStore } from "../../src/journal/store.ts";
import { Engine } from "../../src/run/engine.ts";
import { externalisableChannels } from "../../src/run/externalise.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { replayRun } from "../../src/run/replay.ts";
import { resolver } from "./skeleton.ts";

const NOW = 1_700_000_000_000;

/** Well over the 64 KiB threshold, and not compressible into a shorter canonical form. */
const BIG = "x".repeat(300_000);

/**
 * The shape the amplification was measured on: one value flowing through a chain of `function`
 * nodes. `doc` is `replace`, is not an output, and is named by no expression — so it is
 * eligible. `out` is the run's answer and is deliberately tiny.
 */
function chainSpec(hops: number): GraphSpec {
  const nodes: unknown[] = [];
  const edges: unknown[] = [];
  for (let i = 0; i < hops; i++) {
    nodes.push({ id: `h${i}`, type: "function", reads: ["doc"], writes: ["doc"], function: { ref: "function/hop@stable" } });
    if (i > 0) edges.push({ id: `e${i}`, from: `h${i - 1}`, to: `h${i}`, kind: "seq" });
  }
  nodes.push({ id: "tail", type: "function", reads: ["doc"], writes: ["out"], function: { ref: "function/measure@stable" } });
  edges.push({ id: `e${hops}`, from: `h${hops - 1}`, to: "tail", kind: "seq" });
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "chain", project: "payloads", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 32, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: {
      doc: { type: "string", reduce: "replace" },
      out: { type: "string", reduce: "replace" },
    },
    inputs: ["doc"],
    outputs: ["out"],
    nodes,
    edges,
  } as unknown as GraphSpec;
}

/** `h*` passes the document on unchanged; `tail` reports what it actually received. */
function functions(): FunctionRegistry {
  const f = new FunctionRegistry();
  f.register("function/hop@stable", (view) => ({ writes: { doc: view.get<string>("doc") } }));
  f.register("function/measure@stable", (view) => {
    const doc = view.get<string>("doc");
    // WHAT THE BODY SEES, recorded as a channel so the assertion is about the run's own
    // journal rather than about a variable this test closed over. `typeof` is here because
    // the failure mode being ruled out is a body handed `{$payload: {...}}` — an object that
    // has a length of `undefined` and would otherwise fail as a mismatched number.
    return { writes: { out: `${typeof doc}:${(doc ?? "").length}` } };
  });
  return f;
}

function rig(payloads?: PayloadStore, store?: StateStore): { engine: Engine; store: StateStore } {
  const s = store ?? new MemoryStateStore({ now: () => NOW });
  const engine = new Engine({
    store: s,
    tools: new ToolRegistry(),
    functions: functions(),
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: [], systemFloor: "out" },
    ...(payloads === undefined ? {} : { payloads }),
  });
  return { engine, store: s };
}

const compile = (s: GraphSpec) => compileOrThrow({ spec: s, resolver: resolver(), tools: {}, tenantCapabilities: [] });

/** Every byte the journal itself carries, measured the way the store measures a payload. */
async function journalBytes(store: StateStore, runId: RunId): Promise<number> {
  let total = 0;
  for await (const e of store.read(runId, 1)) total += Buffer.byteLength(canonicalize(e.payload), "utf8");
  return total;
}

test("THE AMPLIFICATION, MEASURED — and then measured again with the value externalised", async () => {
  const HOPS = 3;
  const graph = compile(chainSpec(HOPS));

  const inline = rig();
  const a = await inline.engine.submit({ graph, inputs: { doc: BIG } });
  const pa = await inline.engine.advance(a);
  assert.equal(pa.status, "succeeded", JSON.stringify(pa.error ?? {}));
  const before = await journalBytes(inline.store, a);

  const external = rig(memoryPayloads());
  const b = await external.engine.submit({ graph, inputs: { doc: BIG } });
  const pb = await external.engine.advance(b);
  assert.equal(pb.status, "succeeded", JSON.stringify(pb.error ?? {}));
  const after = await journalBytes(external.store, b);

  // `2N + 2` copies of the document, near enough: `task.committed` and `state.reduced` per hop
  // plus `run.submitted`'s inputs. The assertion is deliberately loose about the exact multiple
  // — the claim being tested is the ORDER of the amplification, and the exact coefficient moves
  // with how many nodes read the channel.
  assert.ok(
    before > BIG.length * 2 * HOPS,
    `the inline journal should carry the document many times over; ${before} bytes for a ${BIG.length}-byte value`,
  );

  // What is left is `run.submitted`'s copy of the inputs — which stays inline, because inputs
  // arrive before any node has run and there is nothing yet to point at.
  assert.ok(
    after < before / HOPS,
    `externalising should collapse the per-hop copies: ${before} bytes inline vs ${after} externalised`,
  );
  assert.ok(
    after < BIG.length * 2,
    `only the submitted inputs should remain: ${after} bytes for a ${BIG.length}-byte value`,
  );

  // AND THE RUN'S ANSWER IS THE SAME ONE. A journal that shrank because the run did less is
  // not a fix; both runs must have carried the same 300,000 characters to the last node.
  assert.equal(pa.outputs["out"], `string:${BIG.length}`, "the inline run's last node saw the document");
  assert.equal(pb.outputs["out"], `string:${BIG.length}`, "and so did the externalised run's");
});

test("THE HANDLE IS DERIVED, so the same document externalises to the same journal", async () => {
  const graph = compile(chainSpec(1));
  const one = rig(memoryPayloads());
  const two = rig(memoryPayloads());
  const p1 = await one.engine.advance(await one.engine.submit({ graph, inputs: { doc: BIG } }));
  const p2 = await two.engine.advance(await two.engine.submit({ graph, inputs: { doc: BIG } }));

  assert.equal(p1.status, "succeeded", JSON.stringify(p1.error ?? {}));
  // Two independent runs, two independent payload stores, one digest. An id that could not be
  // recomputed here is the thing that breaks replay.
  assert.deepEqual(p1.external["doc"], p2.external["doc"]);
  assert.ok(p1.external["doc"] !== undefined, "the document channel must actually be a handle");
  assert.equal(p1.external["doc"]!.bytes, Buffer.byteLength(canonicalize(BIG), "utf8"));
});

test("AT THE THRESHOLD IT STAYS INLINE — and one byte over, it does not", async () => {
  const graph = compile(chainSpec(1));

  // Canonical form of a string is the string plus two quotes, so this lands the canonical
  // payload on exactly `EXTERNALISE_ABOVE_BYTES`.
  const exact = "y".repeat(EXTERNALISE_ABOVE_BYTES - 2);
  const over = `${exact}y`;
  assert.equal(Buffer.byteLength(canonicalize(exact), "utf8"), EXTERNALISE_ABOVE_BYTES);

  const at = rig(memoryPayloads());
  const pAt = await at.engine.advance(await at.engine.submit({ graph, inputs: { doc: exact } }));
  assert.equal(pAt.status, "succeeded", JSON.stringify(pAt.error ?? {}));
  assert.deepEqual(pAt.external, {}, "a payload of exactly the threshold is not externalised");
  assert.equal(pAt.channels["doc"], exact, "and the projection holds the value itself");

  const above = rig(memoryPayloads());
  const pOver = await above.engine.advance(await above.engine.submit({ graph, inputs: { doc: over } }));
  assert.equal(pOver.status, "succeeded", JSON.stringify(pOver.error ?? {}));
  assert.ok(pOver.external["doc"] !== undefined, "one byte over the threshold is externalised");
  assert.equal(pOver.outputs["out"], `string:${over.length}`, "and the body still saw the whole value");
});

test("AN ENGINE WITH NO PAYLOAD STORE BEHAVES EXACTLY AS IT DID BEFORE THIS EXISTED", async () => {
  const graph = compile(chainSpec(2));
  const off = rig();
  const p = await off.engine.advance(await off.engine.submit({ graph, inputs: { doc: BIG } }));
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(p.external, {}, "nothing is externalised when no store is configured");
  assert.equal(p.channels["doc"], BIG, "and the channel holds the document, not a reference");
});

test("A SECOND PROCESS FOLDS THE SAME HANDLES AND RESOLVES THEM", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loom-payloads-"));
  try {
    const payloads = filePayloads(dir);
    const graph = compile(chainSpec(2));
    const store = new MemoryStateStore({ now: () => NOW });

    const first = rig(payloads, store);
    const runId = await first.engine.submit({ graph, inputs: { doc: BIG } });
    assert.equal((await first.engine.advance(runId)).status, "succeeded");

    // A DIFFERENT ENGINE, holding nothing from the first but the journal and the directory.
    // This is invariant 1's "including across a restart": the value the resolver reads is
    // reconstructed by folding, not carried in a process's memory.
    const second = rig(payloads, store);
    const p = await second.engine.projection(runId);
    assert.ok(p !== undefined);
    const ref = p.external["doc"];
    assert.ok(ref !== undefined, "the fold must rebuild the handle from the journal alone");
    assert.equal(await payloads.get(runId, ref), BIG, "and the durable store must still hold the bytes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("A HANDLE THAT CANNOT BE RESOLVED FAILS THE RUN — it is never handed to a body", async () => {
  const graph = compile(chainSpec(2));
  const store = new MemoryStateStore({ now: () => NOW });

  // A store that accepts writes and has lost them: the shape of a payload directory restored
  // from the wrong backup, or an engine attached to a peer's journal with no store of its own.
  const lossy: PayloadStore = { put: memoryPayloads().put, get: memoryPayloads().get };

  const r = rig(lossy, store);
  const runId = await r.engine.submit({ graph, inputs: { doc: BIG } });
  const p = await r.engine.advance(runId);

  assert.notEqual(p.status, "succeeded", "a run whose state cannot be read must not report success");
  const failed = Object.values(p.tasks).filter((t) => t.state === "failed");
  assert.ok(
    failed.some((t) => t.error?.code === "E_PAYLOAD_UNRESOLVED"),
    `expected E_PAYLOAD_UNRESOLVED; got ${JSON.stringify(failed.map((t) => t.error?.code))}`,
  );
  assert.equal(p.outputs["out"], undefined, "and no node produced an answer from the handle");
});

test("A REPLAY OF AN EXTERNALISED RUN MATCHES — and does not, if the replayer has no store", async () => {
  // FOUND BY RUNNING THE BINARY, not by reading. `loom replay` built its Engine without the
  // workspace's payload store, so the replay recomputed an inline value where the recording
  // had journaled a handle and reported `match: false` about the run. It is the third member
  // of a family `cli.ts` already documents twice — hooks, then policy, now this — and it is
  // here rather than only in the CLI because the defect is "the replayer differs from the
  // recorder", which any embedder can reproduce.
  const graph = compile(chainSpec(2));
  const payloads = memoryPayloads();
  const live = rig(payloads);
  const runId = await live.engine.submit({ graph, inputs: { doc: BIG } });
  assert.equal((await live.engine.advance(runId)).status, "succeeded");

  const same = await replayRun({
    store: live.store,
    runId,
    graph,
    engine: { functions: functions(), policy: { granted: [], systemFloor: "out" }, now: () => NOW, payloads },
  });
  assert.equal(same.match, true, JSON.stringify(same.frames.filter((f) => !f.match).map((f) => f.kind)));

  const without = await replayRun({
    store: live.store,
    runId,
    graph,
    engine: { functions: functions(), policy: { granted: [], systemFloor: "out" }, now: () => NOW },
  });
  assert.equal(without.match, false, "a replayer that externalises nothing must not silently agree");
});

test("A CHANNEL AN EXPRESSION CAN REACH IS NEVER ELIGIBLE", () => {
  // The soundness rule, tested at the decision rather than through a run: `#edgesToTake`
  // evaluates `when` against the raw scope synchronously, so a handle there would route the
  // graph on a comparison against an object nobody wrote.
  const base = chainSpec(2) as unknown as { channels: Record<string, unknown>; edges: { when?: string }[]; outputs: string[] };

  assert.ok(externalisableChannels(compile(chainSpec(2))).has("doc"), "the control: `doc` is eligible");

  const routed = { ...base, edges: base.edges.map((e, i) => (i === 0 ? { ...e, kind: "conditional", when: "doc != null" } : e)) };
  assert.ok(
    !externalisableChannels(compile(routed as unknown as GraphSpec)).has("doc"),
    "a channel named by an edge condition must stay inline",
  );

  const declared = { ...base, outputs: ["out", "doc"] };
  assert.ok(
    !externalisableChannels(compile(declared as unknown as GraphSpec)).has("doc"),
    "a declared output must stay inline — nothing resolves `run.completed.outputs`",
  );
});

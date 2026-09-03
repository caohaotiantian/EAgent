/**
 * THE COMPILED OVERSIGHT FLOOR IS A RECORDED FACT, PER NODE.
 *
 * `plans[nodeId].posture` is what every `PolicyRequest` reads as `declaredPosture`, and it is
 * DERIVED — from the registered tools' `irreversibility` — so `graphHash = digest(spec)` excludes
 * it by design. The compensating check compared `run.started.posture`, a single `max` over ALL
 * nodes, which is invisible to a per-node drop whenever another node holds the maximum.
 *
 * Driven end to end before this: the same journal, the same graphHash, a restart into a process
 * where `chat.post` is registered `read_only` instead of `externally_visible`. `#runPosture` is
 * `in` in BOTH processes because the `human_gate` node still contributes `in`, so `#assertBound`
 * accepted — and the externally-visible post fired with no gate of its own.
 *
 * RECORDED, NOT HASHED. Folding the floors into `graphHash` would invalidate every journal
 * already written and change what `evolution/score.ts`'s cohort key means. `run.compiled` is
 * where the manifest already lives for exactly this reason: a derived fact that identifies the
 * compile without being the spec.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import type { IrreversibilityClass } from "../../src/vocab.ts";
import type { EdgeId, NodeId, RunId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;
const NOW = (): number => 1_700_000_000_000;

const manifest = (cls: IrreversibilityClass): Record<string, ToolManifestLite> => ({
  "chat.post": { name: "chat.post", version: "1.0", capabilities: ["chat"], irreversibility: cls, idempotent: false },
});

/** A gate that holds the run's max at `in`, and a post whose own floor is the thing under test. */
const SPEC: GraphSpec = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "post", project: "lane-a", version: 1 },
  policy: { posture: "out", capabilities: ["chat"] },
  channels: { go: { type: "object", reduce: "replace" }, sent: { type: "object", reduce: "replace" } },
  inputs: [],
  outputs: ["sent"],
  nodes: [
    { id: n("gate"), type: "human_gate", writes: ["go"], humanGate: { ref: "oversight/post@stable" } },
    { id: n("post"), type: "tool", reads: ["go"], writes: ["sent"], tool: { name: "chat.post", version: "1.0", args: {} } },
  ],
  edges: [{ id: e("g2p"), from: n("gate"), to: n("post"), kind: "seq" }],
} as unknown as GraphSpec;

const RESOLVER: ResourceResolver = {
  resolve: (ref) =>
    /^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref) ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" } : undefined,
};

function engineOn(store: MemoryStateStore, cls: IrreversibilityClass): { engine: Engine; posts: number[] } {
  const posts: number[] = [];
  const tools = new ToolRegistry();
  const def: ToolDefinition = {
    ...manifest(cls)["chat.post"]!,
    description: "Post a message.",
    parameters: { type: "object", properties: {} },
    execute: () => {
      posts.push(1);
      return { content: "posted", writes: { sent: { ok: true } } };
    },
  };
  tools.register(def);
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now: NOW,
    sleep: async () => {},
    policy: { granted: ["chat"], systemFloor: "out" },
  });
  return { engine, posts };
}

const graphUnder = (cls: IrreversibilityClass): ReturnType<typeof compileOrThrow> =>
  compileOrThrow({ spec: SPEC, resolver: RESOLVER, tools: manifest(cls), tenantCapabilities: ["chat"] });

async function approve(engine: Engine, runId: RunId): Promise<{ status: string; error?: unknown }> {
  const open = await engine.openGates(runId);
  assert.equal(open.length, 1, `expected one open gate, saw ${JSON.stringify(open.map((g) => g.nodeId))}`);
  const p = await engine.resolveGate(runId, {
    gateId: open[0]!.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:ops", via: "cli" },
    idempotencyKey: "k1",
  });
  return { status: p.status, error: p.error };
}

test("the two compiles differ ONLY in the per-node floor — same hash, same aggregate", () => {
  const strong = graphUnder("externally_visible");
  const weak = graphUnder("read_only");
  assert.equal(strong.graphHash, weak.graphHash, "the SPEC is byte-identical, so the hash is");
  assert.equal(strong.plans["post" as NodeId]?.posture, "in");
  assert.equal(weak.plans["post" as NodeId]?.posture, "out", "this is the drop the journal has to be able to see");
  assert.equal(strong.plans["gate" as NodeId]?.posture, "in");
  assert.equal(weak.plans["gate" as NodeId]?.posture, "in", "and the aggregate `max` is `in` either way, which is why it missed this");
});

test("A PER-NODE FLOOR MAY NOT FALL ACROSS A RESTART", async () => {
  const store = new MemoryStateStore({ now: NOW });
  const first = engineOn(store, "externally_visible");
  const runId = await first.engine.submit({ graph: graphUnder("externally_visible"), inputs: {} });
  const parked = await first.engine.advance(runId);
  assert.equal(parked.status, "awaiting_gate", JSON.stringify(parked.error ?? {}));

  // THE RESTART: same spec, same hash, a process that registered the same tool NAME as
  // `read_only` — an ordinary `--extension-module` edit or a second deployment of an extension.
  const second = engineOn(store, "read_only");
  second.engine.attach(runId, graphUnder("read_only"));
  await second.engine.rehydrateGates(runId);

  await assert.rejects(
    () => approve(second.engine, runId),
    (err: Error & { code?: string }) => {
      assert.equal(err.code, "E_GRAPH_MISMATCH", err.message);
      assert.match(err.message, /post/, "the refusal must name the node whose floor fell");
      return true;
    },
  );
  assert.equal(second.posts.length, 0, "and nothing may be posted");
});

test("…and the CONTROL: the same restart into a process that still knows the tool proceeds", async () => {
  const store = new MemoryStateStore({ now: NOW });
  const first = engineOn(store, "externally_visible");
  const runId = await first.engine.submit({ graph: graphUnder("externally_visible"), inputs: {} });
  await first.engine.advance(runId);

  const second = engineOn(store, "externally_visible");
  second.engine.attach(runId, graphUnder("externally_visible"));
  await second.engine.rehydrateGates(runId);
  const after = await approve(second.engine, runId);
  // `post` raises its OWN gate at `in`, so the run parks again rather than completing — which is
  // the behaviour the case above proves is missing when the floor is lost.
  assert.equal(after.status, "awaiting_gate", JSON.stringify(after.error ?? {}));
  assert.equal(second.posts.length, 0, "the externally-visible post is still behind its own gate");
});

test("A FLOOR THAT RISES is not a mismatch — oversight only tightens", async () => {
  // The direction that must NOT refuse: a process that knows MORE about a tool than the one that
  // compiled the run raises the floor, and a refusal there would make tightening impossible.
  const store = new MemoryStateStore({ now: NOW });
  const first = engineOn(store, "read_only");
  const runId = await first.engine.submit({ graph: graphUnder("read_only"), inputs: {} });
  await first.engine.advance(runId);

  const second = engineOn(store, "externally_visible");
  second.engine.attach(runId, graphUnder("externally_visible"));
  await second.engine.rehydrateGates(runId);
  const after = await approve(second.engine, runId);
  assert.equal(after.status, "awaiting_gate", JSON.stringify(after.error ?? {}));
  assert.equal(second.posts.length, 0);
});

test("the floors are on `run.compiled`, so the fact is a fold and not a memory read", async () => {
  const store = new MemoryStateStore({ now: NOW });
  const r = engineOn(store, "externally_visible");
  const runId = await r.engine.submit({ graph: graphUnder("externally_visible"), inputs: {} });
  const events: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) events.push(ev);
  const compiled = events.find((ev) => ev.type === "run.compiled");
  assert.deepEqual((compiled?.payload as { postures?: unknown }).postures, [
    { nodeId: "gate", posture: "in" },
    { nodeId: "post", posture: "in" },
  ]);
});

test("A JOURNAL WITH NO RECORDED FLOORS still binds by the aggregate it always had", async () => {
  // Compatibility, and the absent-field default. Every journal written before this field lacks
  // it, and the honest answer for one is the check that existed — not a refusal that would make
  // every pre-existing run unresumable, and not silence.
  const store = new MemoryStateStore({ now: NOW });
  const first = engineOn(store, "externally_visible");
  const runId = await first.engine.submit({ graph: graphUnder("externally_visible"), inputs: {} });
  await first.engine.advance(runId);

  // Rewrite the journal without the new field, which is what an older writer produced.
  const older = new MemoryStateStore({ now: NOW });
  for await (const ev of store.read(runId, 1)) {
    const payload =
      ev.type === "run.compiled" ? Object.fromEntries(Object.entries(ev.payload).filter(([k]) => k !== "postures")) : ev.payload;
    await older.append({
      runId,
      expectedSeq: (ev.seq - 1) as never,
      events: [{ type: ev.type, payload, actor: ev.actor, ...(ev.taskId === undefined ? {} : { taskId: ev.taskId }) } as never],
    });
  }

  const second = engineOn(older, "read_only");
  second.engine.attach(runId, graphUnder("read_only"));
  await second.engine.rehydrateGates(runId);
  // The aggregate is `in` in both processes, so this old journal cannot see the drop — which is
  // the pre-existing guarantee, stated rather than pretended away. What it must NOT do is throw
  // on the missing field or start accepting a drop the aggregate CAN see.
  const after = await approve(second.engine, runId);
  assert.equal(after.status, "succeeded", JSON.stringify(after.error ?? {}));
});

/**
 * A GUARD THAT CANNOT READ ITS INPUT MUST REFUSE, NOT SKIP.
 *
 * Two sites answered their undecidable case with the permitting value.
 *
 *   - `Engine.#uncompensatedIrreversible` tested `irreversibility !== "irreversible" && !==
 *     "externally_visible"` and `continue`d — an allow-list read in the NEGATIVE. `tool.called`'s
 *     field is typed `string` in `journal/events.ts`, and `run/registry.ts` records that
 *     `"nuclear"` and friends were accepted by `register` before `checkManifest` existed, so a
 *     journal from that build, a hand-edited SQLite file, or a future binary with a fifth class
 *     reaches this scan with a word it cannot read. The scan skipped it and the rewind was
 *     GRANTED, with the un-undoable effect still standing. `run/registry.ts` names this site as
 *     the last of five still spelling the pair out positively; `isHardToUndo` is the negative
 *     form and was already imported in that file.
 *
 *   - `#edgesToTake`'s `default:` arm was a bare `out.push(e.id)`, so an edge whose `kind` this
 *     binary cannot read is TAKEN with its `when` never evaluated. `EdgeKind` is a seven-member
 *     union nothing validated at runtime, and `graph/mutate.ts`'s model-proposed `addEdges` go
 *     through the same compiler — a path from a MODEL to an unconditional edge into a node the
 *     graph meant to guard.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compile, compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import type { EdgeId, NodeId, RunId, Seq } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import { OPERATOR, rewindWithPlan } from "./operator.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;
const NOW = (): number => 1_700_000_000_000;

const RESOLVER: ResourceResolver = {
  resolve: (ref) =>
    /^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref) ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" } : undefined,
};

// ── 1 · the rewind scan ─────────────────────────────────────────────────────

const WIRE: ToolManifestLite = {
  name: "wire.transfer",
  version: "1.0",
  capabilities: ["pay"],
  irreversibility: "irreversible",
  idempotent: false,
};

const WIRE_SPEC: GraphSpec = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "wire", project: "lane-a", version: 1 },
  policy: { posture: "out", capabilities: ["pay"] },
  channels: { receipt: { type: "object", reduce: "replace" } },
  inputs: [],
  outputs: ["receipt"],
  nodes: [
    { id: n("send"), type: "tool", writes: ["receipt"], unhandled: true, tool: { name: "wire.transfer", version: "1.0", args: {} } },
  ],
  edges: [],
} as unknown as GraphSpec;

function wireEngine(store: MemoryStateStore): { engine: Engine; sent: number[] } {
  const sent: number[] = [];
  const tools = new ToolRegistry();
  tools.register({
    ...WIRE,
    description: "Move money nobody can move back.",
    parameters: { type: "object", properties: {} },
    execute: () => {
      sent.push(1);
      return { content: "sent", writes: { receipt: { ok: true } } };
    },
  } as ToolDefinition);
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now: NOW,
    sleep: async () => {},
    policy: { granted: ["pay"], systemFloor: "out" },
  });
  return { engine, sent };
}

/** Drive the wire, then copy its journal into a fresh store with the recorded class rewritten. */
async function journalWithClass(cls: string): Promise<{ store: MemoryStateStore; runId: RunId }> {
  const source = new MemoryStateStore({ now: NOW });
  const first = wireEngine(source);
  const runId = await first.engine.submit({ graph: compileOrThrow({ spec: WIRE_SPEC, resolver: RESOLVER, tools: { "wire.transfer": WIRE }, tenantCapabilities: ["pay"] }), inputs: {} });
  let p = await first.engine.advance(runId);
  // An irreversible tool floors at `in`, so the effect only happens once a human says so — which
  // is what makes this a rewind of something that REALLY moved.
  if (p.status === "awaiting_gate") {
    const open = await first.engine.openGates(runId);
    p = await first.engine.resolveGate(runId, {
      gateId: open[0]!.gateId,
      decision: { kind: "approve" },
      actor: OPERATOR,
      idempotencyKey: "k1",
    });
  }
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.equal(first.sent.length, 1, "the money must really have moved for the refusal to mean anything");

  const store = new MemoryStateStore({ now: NOW });
  for await (const ev of source.read(runId, 1)) {
    const payload = ev.type === "tool.called" ? { ...(ev.payload as object), irreversibility: cls } : ev.payload;
    await store.append({
      runId,
      expectedSeq: (ev.seq - 1) as Seq,
      events: [{ type: ev.type, payload, actor: ev.actor, ...(ev.taskId === undefined ? {} : { taskId: ev.taskId }) } as never],
    });
  }
  return { store, runId };
}

async function rewindRefused(cls: string): Promise<string | undefined> {
  const j = await journalWithClass(cls);
  const r = wireEngine(j.store);
  r.engine.attach(j.runId, compileOrThrow({ spec: WIRE_SPEC, resolver: RESOLVER, tools: { "wire.transfer": WIRE }, tenantCapabilities: ["pay"] }));
  try {
    await rewindWithPlan(r.engine, j.runId, 3 as Seq, "put it back", OPERATOR);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

test("A REWIND PAST AN IRREVERSIBLE EFFECT IS REFUSED — the control", async () => {
  const message = await rewindRefused("irreversible");
  assert.match(message ?? "", /wire\.transfer/, "the guard that already worked must keep working");
});

test("…AND PAST A CLASS THIS BINARY CANNOT READ, which used to be allowed", async () => {
  // Every one of these was measured as REWIND ALLOWED, with the money still gone.
  for (const cls of ["nuclear", "IRREVERSIBLE", "irreversible_write", ""]) {
    const message = await rewindRefused(cls);
    assert.match(message ?? "(the rewind succeeded)", /wire\.transfer/, `class ${JSON.stringify(cls)} must refuse`);
  }
});

test("…and a class that really IS undoable still rewinds", async () => {
  // The other direction. `read_only` is not hard to undo, so the rewind must go through — a fix
  // that refused every class would pass the case above and break every rewind there is.
  assert.equal(await rewindRefused("read_only"), undefined, "a read-only call is not a reason to refuse a rewind");
});

// ── 2 · the edge kind ───────────────────────────────────────────────────────

function guardedSpec(kind: string): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "guarded", project: "lane-a", version: 1 },
    policy: { posture: "out" },
    channels: { seed: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: [],
    outputs: ["out"],
    nodes: [
      { id: n("a"), type: "function", writes: ["seed"], function: { ref: "function/seed@stable" } },
      { id: n("b"), type: "function", reads: ["seed"], writes: ["out"], function: { ref: "function/danger@stable" } },
    ],
    edges: [{ id: e("e1"), from: n("a"), to: n("b"), kind, when: "false" }],
  } as unknown as GraphSpec;
}

function guardedEngine(store: MemoryStateStore, ran: number[]): Engine {
  const functions = new FunctionRegistry();
  functions.register("function/seed@stable", () => ({ writes: { seed: "s" } }));
  functions.register("function/danger@stable", () => {
    ran.push(1);
    return { writes: { out: { fired: true } } };
  });
  return new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now: NOW,
    sleep: async () => {},
    policy: { granted: ["*"], systemFloor: "out" },
  });
}

test("AN EDGE KIND OUTSIDE THE UNION IS REFUSED AT COMPILE", () => {
  for (const kind of ["conditionl", "Conditional", "eror", "__proto__", ""]) {
    const r = compile({ spec: guardedSpec(kind), resolver: RESOLVER, tools: {}, tenantCapabilities: [] });
    assert.equal(r.ok, false, `kind ${JSON.stringify(kind)} must not compile`);
    const d = r.diagnostics.filter((x) => x.code === "GRAPH003_UNKNOWN_EDGE_KIND");
    assert.equal(d.length, 1, JSON.stringify(r.diagnostics));
    assert.match(d[0]!.fix ?? "", /seq/, "the fix must list the kinds that exist");
  }
  // …and every real kind still compiles.
  assert.equal(compile({ spec: guardedSpec("conditional"), resolver: RESOLVER, tools: {}, tenantCapabilities: [] }).ok, true);
  assert.equal(compile({ spec: guardedSpec("seq"), resolver: RESOLVER, tools: {}, tenantCapabilities: [] }).ok, true);
});

test("…AND THE EXECUTOR REFUSES ONE TOO, for a graph that skipped this compiler", async () => {
  // `attach` is public and `RunGraph` is exported, so the compile diagnostic is the EARLIER
  // answer and never the only one — `run/registry.ts`'s rule that closing the append does not
  // close the read. Compiled while the edge was legal, then the kind is rewritten.
  const ran: number[] = [];
  const store = new MemoryStateStore({ now: NOW });
  const engine = guardedEngine(store, ran);
  const good = compileOrThrow({ spec: guardedSpec("conditional"), resolver: RESOLVER, tools: {}, tenantCapabilities: [] });
  const bent = {
    ...good,
    spec: { ...good.spec, edges: [{ ...good.spec.edges[0]!, kind: "conditionl" as never }] },
  };
  const runId = await engine.submit({ graph: bent, inputs: {} });
  // REFUSED AT THE DOOR, like every other "the graph you handed me is not acceptable" — the same
  // shape as `E_GRAPH_MISMATCH`, and for the same reason: it is a fact about the attached graph,
  // not about any one task's outcome.
  await assert.rejects(
    () => engine.advance(runId),
    (err: Error & { code?: string }) => {
      assert.equal(err.code, "E_GRAPH_INVALID", err.message);
      assert.match(err.message, /"e1"/, "the refusal must name the edge");
      assert.match(err.message, /conditionl/, "…and the kind it could not read");
      return true;
    },
  );
  assert.equal(ran.length, 0, "the guarded node must not run on an edge whose kind this binary cannot read");
});

/**
 * A KIND THAT IS NOT A STRING IS STILL NOT A KIND.
 *
 * The first version of this guard filtered on `typeof edge?.kind === "string"`, which made the
 * check about the TYPE of the declaration rather than about the set of kinds. So `kind: 123`,
 * `null`, `true`, `{}` and an edge with no `kind` at all compiled with ZERO diagnostics — and
 * then threw `E_GRAPH_INVALID` out of every `advance`, from `#assertBound`'s copy of the same
 * list, which is exactly the outcome the compile check was added to spare an author. A guard
 * that only reads well-typed input is a guard for the inputs that were never the problem.
 */
test("…AND A KIND THAT IS NOT A STRING IS REFUSED AT COMPILE TOO, which is where an author sees it", () => {
  const cases: readonly (readonly [string, unknown])[] = [
    ["a number", 123],
    ["null", null],
    ["true", true],
    ["an object", {}],
  ];
  for (const [label, kind] of cases) {
    const r = compile({ spec: guardedSpec(kind as never), resolver: RESOLVER, tools: {}, tenantCapabilities: [] });
    assert.equal(r.ok, false, `kind ${label} must not compile`);
    const d = r.diagnostics.filter((x) => x.code === "GRAPH003_UNKNOWN_EDGE_KIND");
    assert.equal(d.length, 1, `${label}: ${JSON.stringify(r.diagnostics)}`);
    assert.match(d[0]!.message, /"e1"/, `${label}: the diagnostic must name the edge`);
    assert.match(d[0]!.fix ?? "", /seq/, `${label}: the fix must list the kinds that exist`);
  }

  // AND AN EDGE WITH NO `kind` AT ALL, which is the same hole with nothing in it. `EdgeSpec.kind`
  // is required, `#assertBound` refuses it at run time, and this was the one shape that reached
  // that refusal with a clean compile behind it.
  const bare = { ...guardedSpec("seq"), edges: [{ id: e("e1"), from: n("a"), to: n("b"), when: "false" }] } as unknown as GraphSpec;
  const r = compile({ spec: bare, resolver: RESOLVER, tools: {}, tenantCapabilities: [] });
  assert.equal(r.ok, false, "an edge that declares no kind must not compile");
  const d = r.diagnostics.filter((x) => x.code === "GRAPH003_UNKNOWN_EDGE_KIND");
  assert.equal(d.length, 1, JSON.stringify(r.diagnostics));
  assert.match(d[0]!.message, /undefined/, "and the message says what it read, rather than printing nothing");
});

test("…and the ORDINARY graph is untouched: `when:false` holds, `when:true` fires", async () => {
  const store = new MemoryStateStore({ now: NOW });
  const ran: number[] = [];
  const engine = guardedEngine(store, ran);
  const guarded = compileOrThrow({ spec: guardedSpec("conditional"), resolver: RESOLVER, tools: {}, tenantCapabilities: [] });
  const p = await engine.advance(await engine.submit({ graph: guarded, inputs: {} }));
  assert.equal(ran.length, 0, "`when: false` still holds the edge");
  assert.equal(p.status, "failed", "…and the run has no output, which is the pre-existing behaviour of this fixture");

  const open: GraphSpec = { ...guardedSpec("conditional"), edges: [{ id: e("e1"), from: n("a"), to: n("b"), kind: "conditional", when: "true" }] } as unknown as GraphSpec;
  const store2 = new MemoryStateStore({ now: NOW });
  const ran2: number[] = [];
  const engine2 = guardedEngine(store2, ran2);
  const p2 = await engine2.advance(await engine2.submit({ graph: compileOrThrow({ spec: open, resolver: RESOLVER, tools: {}, tenantCapabilities: [] }), inputs: {} }));
  assert.equal(p2.status, "succeeded", JSON.stringify(p2.error ?? {}));
  assert.equal(ran2.length, 1, "a real conditional edge still takes when its `when` says so");

  // And a plain `seq` edge, the arm that used to fall through `default:` alongside the typos.
  const seq: GraphSpec = { ...guardedSpec("seq"), edges: [{ id: e("e1"), from: n("a"), to: n("b"), kind: "seq" }] } as unknown as GraphSpec;
  const store3 = new MemoryStateStore({ now: NOW });
  const ran3: number[] = [];
  const engine3 = guardedEngine(store3, ran3);
  const p3 = await engine3.advance(await engine3.submit({ graph: compileOrThrow({ spec: seq, resolver: RESOLVER, tools: {}, tenantCapabilities: [] }), inputs: {} }));
  assert.equal(p3.status, "succeeded", JSON.stringify(p3.error ?? {}));
  assert.equal(ran3.length, 1);
});

test("the journal of the refused run says which edge, not just that something failed", async () => {
  const ran: number[] = [];
  const store = new MemoryStateStore({ now: NOW });
  const engine = guardedEngine(store, ran);
  const good = compileOrThrow({ spec: guardedSpec("conditional"), resolver: RESOLVER, tools: {}, tenantCapabilities: [] });
  const bent = { ...good, spec: { ...good.spec, edges: [{ ...good.spec.edges[0]!, kind: "Conditional" as never }] } };
  const runId = await engine.submit({ graph: bent, inputs: {} });
  const message = await engine.advance(runId).then(
    () => "(the run advanced)",
    (err: Error) => err.message,
  );
  assert.match(message, /Conditional/, "the operator is told which spelling this build could not read");
  // AND NOTHING RAN. The refusal is at the door, so the journal stops where `submit` left it.
  const events: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) events.push(ev);
  assert.deepEqual(
    events.map((ev) => ev.type),
    ["run.submitted", "run.compiled", "run.started", "task.ready"],
  );
  assert.equal(ran.length, 0);
});

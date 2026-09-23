/**
 * THE GATE BINDS THE GRAPH THE HUMAN WAS SHOWN — all three parts of it.
 *
 * Reproduced through the shipped binary before any of this existed: run a graph to its gate, then
 * `loom approve <run> <gate> --graph OTHER.json`, and OTHER's node ran and wrote. The gate
 * authorized one graph and a different one executed. No collision and no race — `--graph` was
 * simply believed, because `attach` is `this.#contextFor(runId, graph)` and nothing else.
 *
 * THE FIRST FIX FOR THIS WAS WRONG AND TWO REVIEWERS BROKE IT. Comparing `graphHash` alone closes
 * nothing much: `compile.ts` says "the hash covers the SPEC ONLY", and a spec is full of
 * POINTERS. A reviewer edited `resources/subgraph/child.json` while a run was parked, approved
 * with THE SAME graph file, and the swapped child ran under a byte-identical hash. The half that
 * was missing is `replay.ts:358`'s `refsBound` — and the first plan cited `replay.ts:357-362` as
 * "precedent, and it is exact" while dropping line 358 out of it.
 *
 * The third part is the compiled oversight FLOOR, which the hash also excludes.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CODES, isLoomError } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";
import type { RunId } from "../../src/ids.ts";
import { InProcessEventBus } from "../../src/bus.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { SqliteStateStore } from "../../src/journal/sqlite.ts";
import type { StateStore } from "../../src/journal/store.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";

const NOW = 1_700_000_000_000;
const alice = { kind: "human", subject: "u:alice", via: "console" } as const;

/**
 * A resolver whose answer for a ref can MOVE, the way a store's does when a file is edited.
 * `moves` picks WHICH refs a `bump` moves — every one by default, one file's worth when a test
 * needs the edit to land on a ref only a mutation introduced.
 */
function shifting(moves: (ref: string) => boolean = () => true): { resolver: ResourceResolver; bump: () => void } {
  let n = 0;
  return {
    bump: () => {
      n += 1;
    },
    resolver: {
      resolve: (ref) =>
        /^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref)
          ? { ref, digest: `sha256:${String(moves(ref) ? n : 0).repeat(64).slice(0, 64)}`, channel: "stable" }
          : undefined,
      document: () => "Instructions.",
    },
  };
}

function spec(writePath: string): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "gated", project: "bind", version: 1 },
    policy: { posture: "out", capabilities: ["fs:write"], expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { note: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: ["note"],
    outputs: ["out"],
    nodes: [
      { id: "gate", type: "human_gate", reads: ["note"], writes: [], humanGate: { ref: "oversight/g@stable", approval: { approvers: ["u:alice"] } } },
      { id: "act", type: "tool", reads: ["note"], writes: ["out"], tool: { name: "demo.write", version: "1.0", args: { path: writePath } } },
    ],
    edges: [{ id: "e", from: "gate", to: "act", kind: "seq" }],
  } as unknown as GraphSpec;
}

interface Rig {
  readonly engine: Engine;
  readonly wrote: string[];
  readonly res: { resolver: ResourceResolver; bump: () => void };
  readonly store: MemoryStateStore;
  /** A SECOND engine over the same journal — what `loom approve` in a fresh process is. */
  fresh(): Rig;
}

function rig(shared?: { store: MemoryStateStore; res: { resolver: ResourceResolver; bump: () => void }; wrote: string[] }): Rig {
  const wrote = shared?.wrote ?? [];
  const tools = new ToolRegistry();
  const write: ToolDefinition = {
    name: "demo.write",
    version: "1.0",
    description: "Record a path.",
    capabilities: ["fs:write"],
    irreversibility: "reversible_write",
    idempotent: false,
    parameters: { type: "object", properties: { path: { type: "string" } } },
    execute: (args) => {
      wrote.push(String((args as { path: string }).path));
      return { content: "ok", writes: { out: { path: (args as { path: string }).path } } };
    },
  };
  tools.register(write);
  const res = shared?.res ?? shifting();
  const store = shared?.store ?? new MemoryStateStore({ now: () => NOW });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now: () => NOW,
    resolver: res.resolver,
    policy: { granted: ["fs:write"], systemFloor: "out", budget: { runUsd: 10 } },
  });
  return { engine, wrote, res, store, fresh: () => rig({ store, res, wrote }) };
}

const compile = (r: Rig, s: GraphSpec) =>
  compileOrThrow({ spec: s, resolver: r.res.resolver, tools: r.engine.tools.manifests(), tenantCapabilities: ["fs:write"] });

async function park(r: Rig): Promise<{ runId: RunId; gateId: string; graph: ReturnType<typeof compile> }> {
  const graph = compile(r, spec("approved.txt"));
  const runId = await r.engine.submit({ graph, inputs: { note: "n" } });
  await r.engine.advance(runId);
  const open = await r.engine.openGates(runId);
  assert.equal(open.length, 1, "the fixture must park on exactly one gate");
  return { runId, gateId: open[0]!.gateId, graph };
}

const decide = (r: Rig, runId: RunId, gateId: string, kind: "approve" | "reject") =>
  r.engine.resolveGate(runId, {
    gateId: gateId as never,
    decision: kind === "approve" ? { kind: "approve" } : { kind: "reject", reason: "no" },
    actor: alice,
    idempotencyKey: `k-${kind}`,
  });

test("A DIFFERENT SPEC IS REFUSED — the substitution reproduced through the binary", async () => {
  const r = rig();
  const { runId, gateId } = await park(r);

  // A FRESH PROCESS, which is what `loom approve` is — and it is the only place the attack
  // lives. `#contextFor` returns the EXISTING context when a run is already attached, so
  // `attach` on a live run is a no-op and the same-process case was never exposed.
  const second = r.fresh();
  second.engine.attach(runId, compile(second, spec("SUBSTITUTED.txt")));

  await assert.rejects(
    () => decide(second, runId, gateId, "approve"),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_GRAPH_MISMATCH,
    "a graph that is not the one this run compiled must not be approvable",
  );
  assert.deepEqual(r.wrote, [], "and nothing may have executed");
});

test("THE SAME SPEC WITH DIFFERENT RESOURCES IS REFUSED — the half a hash cannot see", async () => {
  const r = rig();
  const parked = await park(r);
  const { runId, gateId } = parked;

  // THE SAME SPEC OBJECT, recompiled after the store moved. `graphHash` is `digest(spec)` so it
  // is byte-identical; only the manifest moved. This is the reviewer's swapped-subgraph attack
  // in miniature, and the version of this fix that compared hashes alone let it through.
  const original = parked.graph;
  r.res.bump();
  const rebound = compile(r, spec("approved.txt"));
  assert.equal(rebound.graphHash, original.graphHash, "the hash must NOT move — that is the point");
  assert.notEqual(
    rebound.resolutionManifest.map((m) => m.digest).join(),
    original.resolutionManifest.map((m) => m.digest).join(),
    "but the manifest must",
  );

  const second = r.fresh();
  second.engine.attach(runId, rebound);
  await assert.rejects(
    () => decide(second, runId, gateId, "approve"),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_GRAPH_MISMATCH,
    "a run whose resources moved under it must not be approvable",
  );
  assert.deepEqual(r.wrote, []);
});

test("THE RIGHT GRAPH STILL APPROVES — the refusal is not a gate that refuses everybody", async () => {
  const r = rig();
  const { runId, gateId } = await park(r);
  const p = await decide(r, runId, gateId, "approve");
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(r.wrote, ["approved.txt"]);
});

test("CANCEL IS THE EXIT — and it is the ONLY one, because reject executes", async () => {
  // THE FIRST VERSION OF THIS FIX EXEMPTED `reject`, on the reasoning that it "fails the run, so
  // it runs no graph code". Both halves are false. `#applyGateDecision` fails the TASK with
  // `E_HUMAN_APPROVAL_REQUIRED`, which is not in `RUN_FATAL_CODES`, so the run continues — and
  // the failed task activates that node's `error` edges READ FROM THE ATTACHED GRAPH, then
  // `advance` runs. A reviewer reproduced it through the CLI: `--reject "no thanks" --graph
  // EVIL.json` wrote PWNED.txt and reported `succeeded`. The exemption reopened the exact attack
  // this file exists to close, behind one extra flag.
  //
  // `cancel` is the genuine exit: it runs no graph code at all, and it does not bind.
  const r = rig();
  const { runId, gateId } = await park(r);
  const second = r.fresh();
  second.engine.attach(runId, compile(second, spec("SUBSTITUTED.txt")));

  // TWO GUARDS CLOSE THIS AND EITHER ONE SUFFICES — measured: restoring the reject exemption
  // alone leaves this green, because `#resolveGateAsSystem` ends in `advance`, which binds too.
  // Removing BOTH turns it red. The redundancy is deliberate rather than accidental: `advance`
  // is a door in its own right (`POST /commands {"kind":"advance"}`, a crash-recovery retry, a
  // sweeper closing a gate by `defaultAction`), and the decision doors must not depend on it.
  await assert.rejects(
    () => decide(second, runId, gateId, "reject"),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_GRAPH_MISMATCH,
    "rejecting must bind too — a rejected gate still runs the graph's error edges",
  );

  const p = await second.engine.cancel(runId, "the graph drifted", { kind: "human", subject: "u:alice", via: "console" });
  assert.equal(p.status, "cancelled", "cancel is the operator's way out and must not bind");
  assert.deepEqual(r.wrote, [], "and it runs nothing");
});

test("A MUTATED RUN IS STILL APPROVABLE — the successor is a recorded fact too", async () => {
  // THE REGRESSION THIS FIX FIRST SHIPPED. Both `#applyMutation` and `#rehydrateGraph` REPLACE
  // `ctx.graph` with the successor, so a check against `run.compiled.graphHash` alone can never
  // pass again after any mutation: approve became impossible forever, on the designed flow where
  // a mutation introduces an irreversible node and gates it. A reviewer reproduced it in one
  // process with no attack and no restart — the run was wedged, exitable only by cancel.
  //
  // The folded `p.graphHash` is authorized because only the ENGINE writes `graph.mutated`: a
  // caller cannot forge a successor into the journal, so "the graph the run is currently on" is
  // as recorded a fact as "the graph it compiled".
  const r = rig();
  const { runId, gateId, graph } = await park(r);

  // Stand in for a mutation by binding the run to a graph whose hash the JOURNAL has adopted.
  // Rather than driving `canMutate`, assert the property directly: a graph matching the current
  // folded hash is accepted, one matching neither is not. (`canMutate` IS reachable from the
  // shipped binary — `--grant graph:mutate` plus an `--extension-module` adapter — and the tests
  // below drive a real mutation; this one is kept as the unmutated control.)
  const p = await r.engine.projection(runId);
  assert.equal(p?.graphHash, graph.graphHash, "an unmutated run's folded hash IS its compile hash");

  const ok = await decide(r, runId, gateId, "approve");
  assert.equal(ok.status, "succeeded", JSON.stringify(ok.error ?? {}));
});

// ── the successor's blind spot, DRIVEN rather than stood in for ───────────────────────────────
//
// The test above stands in for a mutation ("rather than driving `canMutate`, assert the property
// directly"), and that substitution is what hid the gap below: it exercises the SPEC half of the
// binding on a successor and never the RESOURCE half. Everything from here drives a real
// `graph:mutate` through the engine, so the successor is a fact the journal wrote rather than a
// hash a test asserted.

/** The one mutation the model below proposes: a `human_gate` downstream of the proposer. */
const ADDED_GATE = {
  addNodes: [
    {
      id: "added_gate",
      type: "human_gate",
      reads: ["note"],
      writes: [],
      humanGate: { ref: "oversight/added@stable", approval: { approvers: ["u:alice"] } },
    },
  ],
  addEdges: [{ id: "e_added", from: "propose", to: "added_gate", kind: "seq" }],
};

function mutableSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "mutable", project: "bind", version: 1 },
    policy: { posture: "out", capabilities: ["graph:mutate"], expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { note: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: ["note"],
    outputs: ["out"],
    nodes: [
      {
        id: "propose",
        type: "agent",
        reads: ["note"],
        writes: ["out"],
        agent: {
          profile: "agent_profile/p@stable",
          prompt: "prompt/p@stable",
          maxTurns: 1,
          canMutate: true,
          outputSchema: { type: "object", properties: { ok: { type: "boolean" }, mutation: { type: "object" } } },
        },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

/** The spec the engine folds to — merged exactly as `compileMutation` merges it. */
function successorSpec(): GraphSpec {
  const s = mutableSpec();
  return { ...s, nodes: [...s.nodes, ...ADDED_GATE.addNodes], edges: [...ADDED_GATE.addEdges] } as unknown as GraphSpec;
}


type Res = { resolver: ResourceResolver; bump: () => void };
/** What the mock model proposes: `ADDED_GATE` unless a test needs a different shape of it. */
type Mutation = { readonly addNodes: readonly object[]; readonly addEdges: readonly object[] };

interface MutRig {
  readonly engine: Engine;
  readonly store: StateStore;
  readonly res: Res;
  fresh(): MutRig;
}

/** An Engine that proposes `ADDED_GATE` from its one agent node, over whatever store it is handed. */
function mutEngine(store: StateStore, res: Res, mutation: Mutation = ADDED_GATE): Engine {
  const models = new ModelRegistry();
  models.register(
    new MockModelAdapter({
      script: () => ({ text: JSON.stringify({ ok: true, mutation: { reason: "gate it", ...mutation } }), finishReason: "stop" }),
    }),
    true,
  );
  return new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions: new FunctionRegistry(),
    models,
    now: () => NOW,
    resolver: res.resolver,
    policy: { granted: ["graph:mutate"], systemFloor: "out", budget: { runUsd: 10 } },
  });
}

function mutRig(shared?: { store: StateStore; res: Res; mutation?: Mutation }): MutRig {
  const res = shared?.res ?? shifting();
  const store = shared?.store ?? new MemoryStateStore({ now: () => NOW });
  const mutation = shared?.mutation ?? ADDED_GATE;
  return { engine: mutEngine(store, res, mutation), store, res, fresh: () => mutRig({ store, res, mutation }) };
}

const mutCompile = (r: { res: Res }, s: GraphSpec) =>
  compileOrThrow({ spec: s, resolver: r.res.resolver, tools: {}, tenantCapabilities: ["graph:mutate"] });

/** Submit the mutable graph and advance it until the agent's proposal has parked it on the ADDED gate. */
async function parkMutated(r: MutRig): Promise<{ runId: RunId; gateId: string; compiled: ReturnType<typeof mutCompile> }> {
  const compiled = mutCompile(r, mutableSpec());
  const runId = await r.engine.submit({ graph: compiled, inputs: { note: "n" } });
  await r.engine.advance(runId);
  const open = await r.engine.openGates(runId);
  assert.equal(open.length, 1, "the agent's proposal must have added exactly one gate");
  const folded = (await r.engine.projection(runId))?.graphHash;
  assert.notEqual(folded, compiled.graphHash, "precondition: a mutated run's folded hash leaves its compile hash");
  return { runId, gateId: open[0]!.gateId, compiled };
}

async function journal(store: StateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1 as never)) out.push(ev);
  return out;
}

const approveAs = (r: { engine: Engine }, runId: RunId, gateId: string, key: string) =>
  r.engine.resolveGate(runId, { gateId: gateId as never, decision: { kind: "approve" }, actor: alice, idempotencyKey: key });

/** `E_GRAPH_MISMATCH` on the RESOURCE axis — the code alone cannot tell it from a spec refusal. */
const onResources = (e: unknown): boolean =>
  isLoomError(e) && e.code === CODES.E_GRAPH_MISMATCH && (e.details as { differs?: string }).differs === "resources";

/**
 * §G.5 — THE RESOURCE HALF OF THE BINDING REACHES A MUTATED RUN'S SUCCESSOR. Driven, not described.
 *
 * THIS TEST WAS GREEN WITH THE OPPOSITE ASSERTION, AND SAID SO: through `2af9716a` it pinned
 * `out.status === "succeeded"` under the header "THIS TEST IS GREEN AND THE BEHAVIOUR IT PINS IS
 * WRONG". `#assertBound` compared `run.compiled.resolutionManifest` against the graph in hand on the
 * `isCompiled` arm alone; after a mutation `ctx.graph` IS the successor — authorized, correctly, by
 * the folded `graph.mutated.newHash` — and that row carried no manifest, so an edit to the bytes
 * behind a ref the run had resolved was decided on as if nothing had moved.
 *
 * `graph.mutated` now carries the successor's `resolutionManifest`, recorded at adoption because it
 * cannot be recomputed (a ref a mutation introduces is resolved LIVE by `frozenFirst`, and its
 * digest is written down nowhere else), and `#graphIdentityMismatch` checks the successor against it
 * exactly as it checks the compiled graph against `run.compiled`.
 *
 * AND IT IS REACHABLE FROM THE SHIPPED BINARY, which this file used to deny: `--grant graph:mutate`
 * (since `66a0c60a`) plus an `--extension-module` model adapter proposing a mutation parks a run on
 * a mutation-ADDED gate through `loom run`; editing the added function's file and running `loom
 * approve --graph <authored>` exited 0 at `2af9716a` with the EDITED bytes on the journal, and exits
 * 1 `E_GRAPH_MISMATCH` now. The test after the control below is that exact shape on the engine.
 */
test("A MUTATED RUN'S SUCCESSOR IS REFUSED WHEN THE RESOURCES BEHIND ITS REFS HAVE MOVED", async () => {
  const r = mutRig();
  const { runId, gateId, compiled } = await parkMutated(r);
  const folded = (await r.engine.projection(runId))?.graphHash;

  // THE RESOURCES MOVE, exactly as editing a published prompt file moves them.
  r.res.bump();

  // A fresh process attaching the successor — nothing survives but the journal.
  const second = r.fresh();
  const successor = mutCompile(second, successorSpec());
  assert.equal(successor.graphHash, folded, "the merged spec really is the graph the run folded to");
  assert.notDeepEqual(
    successor.resolutionManifest.map((p) => p.digest),
    compiled.resolutionManifest.map((p) => p.digest),
    "and it was compiled against the MOVED resources, so the check has something to find",
  );
  second.engine.attach(runId, successor);
  await second.engine.rehydrateGates(runId);

  const before = (await journal(r.store, runId)).length;
  await assert.rejects(
    () => approveAs(second, runId, gateId, "mut-approve"),
    (e: unknown) => {
      assert.ok(onResources(e), `refused on the RESOURCE axis: ${String((e as Error).message)}`);
      // THE SUCCESSOR'S manifest was recorded when the mutation was ADOPTED, not at compile, and
      // the message says which, so an operator is not sent to look at the compile.
      assert.match((e as Error).message, /since that mutation was adopted/, "the message names the adoption");
      // THE PAIR IS THE SUCCESSOR'S: `expected` is the manifest the `graph.mutated` row recorded,
      // which names the ADDED gate's ref — `run.compiled`'s manifest could not.
      const d = (e as { details: { expected: string; actual: string } }).details;
      assert.match(d.expected, /^oversight\/added@stable=sha256:0{64}$/m, "expected is the successor's recorded manifest");
      assert.match(d.actual, /^oversight\/added@stable=sha256:1{64}$/m, "actual is the moved one");
      return true;
    },
  );
  assert.equal((await journal(r.store, runId)).length, before, "and the refusal wrote nothing — no decision, no execution");

  // THE CONTROL, unchanged from when this test pinned the gap: the IDENTICAL edit, decided against
  // the COMPILED graph, is refused on the resource axis by `run.compiled`'s own manifest.
  const third = r.fresh();
  third.engine.attach(runId, mutCompile(third, mutableSpec()));
  await third.engine.rehydrateGates(runId);
  await assert.rejects(() => approveAs(third, runId, gateId, "ctl-approve"), onResources, "the compiled arm still refuses too");
});

test("A MUTATED RUN'S SUCCESSOR STILL APPROVES WHEN NOTHING MOVED — the ordinary half, both attach shapes", async () => {
  // Without this the test above would be measuring "a successor is never approvable".
  for (const shape of ["the successor", "the AUTHORED graph (what `loom approve --graph` attaches)"] as const) {
    const r = mutRig();
    const { runId, gateId } = await parkMutated(r);
    const second = r.fresh();
    second.engine.attach(runId, mutCompile(second, shape === "the successor" ? successorSpec() : mutableSpec()));
    await second.engine.rehydrateGates(runId);
    const out = await approveAs(second, runId, gateId, "ok-approve");
    assert.equal(out.status, "succeeded", `${shape}: ${JSON.stringify(out.error ?? {})}`);
  }
});

test("A REF ONLY THE MUTATION ADDED, EDITED, IS REFUSED BEFORE THE DECISION LANDS — the authored-graph door", async () => {
  // The CLI shape: a fresh process attaches the AUTHORED graph, whose refs are unmoved, so
  // `#assertBound`'s compiled arm passes. The ref that moved is one only the MUTATION named, so it
  // is not in `run.compiled`'s manifest at all — it is resolved LIVE when `#rehydrateGraph` replays
  // the mutation, and checked there against the `graph.mutated` row. At `2af9716a` this approved
  // and ran; left to `advance`, the check would run after `gate.decided` was already appended.
  const r = mutRig({ store: new MemoryStateStore({ now: () => NOW }), res: shifting((ref) => ref.startsWith("oversight/added@")) });
  const { runId, gateId, compiled } = await parkMutated(r);
  r.res.bump();
  assert.deepEqual(
    mutCompile(r, mutableSpec()).resolutionManifest,
    compiled.resolutionManifest,
    "precondition: the AUTHORED graph's own refs did not move — only the added one did",
  );

  const second = r.fresh();
  second.engine.attach(runId, mutCompile(second, mutableSpec()));
  await second.engine.rehydrateGates(runId);
  await assert.rejects(
    () => approveAs(second, runId, gateId, "added-approve"),
    (e: unknown) => onResources(e) && /oversight\/added@stable/.test(String((e as { details: { actual: string } }).details.actual)),
    "the edit to the mutation's own ref is refused",
  );
  const log = await journal(r.store, runId);
  assert.equal(log.filter((ev) => ev.type === "gate.decided").length, 0, "and the refusal came BEFORE the decision was recorded");
  assert.equal((await second.engine.projection(runId))?.status, "awaiting_gate", "the run is exactly where it was");
});

test("THE BATCH DOOR REBUILDS AND CHECKS THE SUCCESSOR BEFORE IT DECIDES, TOO", async () => {
  // `resolveGateBatch` is the higher-consequence sibling of `resolveGate` — one call closes N
  // gates — so it takes the same order: bind, rebuild the successor, and only then decide.
  const BATCHED: Mutation = {
    addNodes: [
      {
        ...ADDED_GATE.addNodes[0]!,
        humanGate: { ...ADDED_GATE.addNodes[0]!.humanGate, batching: { enabled: true, key: "added", windowMs: 60_000, maxBatch: 20 } },
      },
    ],
    addEdges: ADDED_GATE.addEdges,
  };
  const r = mutRig({ store: new MemoryStateStore({ now: () => NOW }), res: shifting((ref) => ref.startsWith("oversight/added@")), mutation: BATCHED });
  const { runId } = await parkMutated(r);
  const batch = (await r.engine.openGateBatches(runId))[0];
  assert.ok(batch !== undefined, "precondition: the added gate is in a batch the batch door can decide");
  r.res.bump();

  const second = r.fresh();
  second.engine.attach(runId, mutCompile(second, mutableSpec()));
  await second.engine.rehydrateGates(runId);
  await assert.rejects(
    () =>
      second.engine.resolveGateBatch(runId, {
        batchId: batch.batchId,
        decision: { kind: "approve" },
        actor: alice,
        idempotencyKey: "batch-approve",
        expectManifest: batch.manifestDigest,
      }),
    onResources,
    "the batch door refuses the moved ref the mutation added",
  );
  assert.equal((await journal(r.store, runId)).filter((ev) => ev.type === "gate.decided").length, 0, "before any member was decided");
});

test("THE SUCCESSOR'S MANIFEST SURVIVES A RESTART — a SQLite file closed and reopened is all the next process has", async (t) => {
  // The journal is the only authoritative state: the manifest `#assertBound` and `#rehydrateGraph`
  // compare against has to come back from the FILE, not from anything the parking process held.
  // Two runs park in one process; the file is closed; each later process opens it cold.
  const dir = mkdtempSync(join(tmpdir(), "loom-g5-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "journal.db");
  const res = shifting((ref) => ref.startsWith("oversight/added@"));

  const parked: { runId: RunId; gateId: string }[] = [];
  const first = new SqliteStateStore({ path, now: () => NOW });
  try {
    const r = mutRig({ store: first, res });
    for (let i = 0; i < 2; i++) parked.push(await parkMutated(r));
    const row = (await journal(first, parked[0]!.runId)).find((ev) => ev.type === "graph.mutated") as JournalEvent<"graph.mutated"> | undefined;
    assert.deepEqual(
      row?.payload.resolutionManifest?.map((m) => m.ref).sort(),
      ["agent_profile/p@stable", "oversight/added@stable", "prompt/p@stable"],
      "the row records the successor's WHOLE manifest, the ref the mutation added included",
    );
  } finally {
    first.close();
  }
  const [okRun, movedRun] = parked as [{ runId: RunId; gateId: string }, { runId: RunId; gateId: string }];

  // UNMOVED: a cold process attaching the authored graph approves the first run.
  const okStore = new SqliteStateStore({ path, now: () => NOW });
  try {
    const engine = mutEngine(okStore, res);
    engine.attach(okRun.runId, mutCompile({ res }, mutableSpec()));
    await engine.rehydrateGates(okRun.runId);
    const out = await approveAs({ engine }, okRun.runId, okRun.gateId, "restart-ok");
    assert.equal(out.status, "succeeded", JSON.stringify(out.error ?? {}));
  } finally {
    okStore.close();
  }

  // MOVED: the added ref's bytes change, and a cold process is refused on the second run — by BOTH
  // attach shapes, each in its own process, with nothing decided.
  res.bump();
  for (const shape of ["authored", "successor"] as const) {
    const store = new SqliteStateStore({ path, now: () => NOW });
    try {
      const engine = mutEngine(store, res);
      engine.attach(movedRun.runId, mutCompile({ res }, shape === "authored" ? mutableSpec() : successorSpec()));
      await engine.rehydrateGates(movedRun.runId);
      await assert.rejects(() => approveAs({ engine }, movedRun.runId, movedRun.gateId, `restart-${shape}`), onResources, `${shape}: refused after a restart`);
      assert.equal(
        (await journal(store, movedRun.runId)).filter((ev) => ev.type === "gate.decided").length,
        0,
        `${shape}: with nothing decided`,
      );
    } finally {
      store.close();
    }
  }
});

test("A graph.mutated ROW WITH NO MANIFEST — a journal older than the field — FAILS CLOSED, and cancel is the exit", async () => {
  // Nothing to compare the successor against is the undecidable case, and answering it with the
  // passing value is the defect this row existed for. The journal is aged the way
  // `mutation-dominator.test.ts` ages one: the run is submitted and a `graph.mutated` holding a
  // legitimate mutation is appended straight into the log, without the field.
  const r = mutRig();
  const compiled = mutCompile(r, mutableSpec());
  const runId = await r.engine.submit({ graph: compiled, inputs: { note: "n" } });
  const successor = mutCompile(r, successorSpec());
  let headSeq = 0;
  for (const ev of await journal(r.store, runId)) headSeq = ev.seq;
  await r.store.append({
    runId,
    expectedSeq: headSeq as never,
    events: [
      {
        type: "graph.mutated",
        payload: {
          parentHash: compiled.graphHash,
          newHash: successor.graphHash,
          addedNodes: ADDED_GATE.addNodes.map((x) => x.id),
          addedEdges: ADDED_GATE.addEdges.map((x) => x.id),
          nodes: [...ADDED_GATE.addNodes],
          edges: [...ADDED_GATE.addEdges],
          proposedBy: "t-old",
          proposedByNode: "propose",
          budgetConsumed: 1,
        },
        actor: { kind: "system", id: "executor" },
      } as never,
    ],
  });
  assert.equal((await r.engine.projection(runId))?.graphHash, successor.graphHash, "precondition: the run folds to the successor");

  // BOTH DOORS: the successor attached directly (`#assertBound`'s successor arm) and the authored
  // graph (`#rehydrateGraph`, which replays the row). Neither may run anything.
  for (const shape of ["successor", "authored"] as const) {
    const second = r.fresh();
    second.engine.attach(runId, shape === "successor" ? successor : mutCompile(second, mutableSpec()));
    await assert.rejects(
      () => second.engine.advance(runId),
      (e: unknown) => onResources(e) && (e as { details: { unrecorded?: boolean } }).details.unrecorded === true,
      `${shape}: refused as UNRECORDED, not waved through`,
    );
    const log = await journal(r.store, runId);
    assert.equal(log.some((ev) => ev.type === "task.leased"), false, `${shape}: nothing executed`);
    assert.equal(log.some((ev) => ev.type === "run.failed"), false, `${shape}: and the run was not failed — a refusal, not a verdict`);
  }
  const out = await r.fresh().engine.cancel(runId, "journal predates the manifest", alice);
  assert.equal(out.status, "cancelled", "cancel binds no graph, so it is still the way out");
});

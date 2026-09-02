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
import test from "node:test";

import { CODES, isLoomError } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";
import type { RunId } from "../../src/ids.ts";
import { InProcessEventBus } from "../../src/bus.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";

const NOW = 1_700_000_000_000;
const alice = { kind: "human", subject: "u:alice", via: "console" } as const;

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
  // Rather than driving `canMutate` (unreachable from the binary), assert the property directly:
  // a graph matching the current folded hash is accepted, one matching neither is not.
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

interface MutRig {
  readonly engine: Engine;
  readonly store: MemoryStateStore;
  readonly res: { resolver: ResourceResolver; bump: () => void };
  fresh(): MutRig;
}

function mutRig(shared?: { store: MemoryStateStore; res: { resolver: ResourceResolver; bump: () => void } }): MutRig {
  const res = shared?.res ?? shifting();
  const store = shared?.store ?? new MemoryStateStore({ now: () => NOW });
  const models = new ModelRegistry();
  models.register(
    new MockModelAdapter({
      script: () => ({ text: JSON.stringify({ ok: true, mutation: { reason: "gate it", ...ADDED_GATE } }), finishReason: "stop" }),
    }),
    true,
  );
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions: new FunctionRegistry(),
    models,
    now: () => NOW,
    resolver: res.resolver,
    policy: { granted: ["graph:mutate"], systemFloor: "out", budget: { runUsd: 10 } },
  });
  return { engine, store, res, fresh: () => mutRig({ store, res }) };
}

const mutCompile = (r: MutRig, s: GraphSpec) =>
  compileOrThrow({ spec: s, resolver: r.res.resolver, tools: r.engine.tools.manifests(), tenantCapabilities: ["graph:mutate"] });

/**
 * G.5 RESIDUE (a), RECORDED AS IT STANDS: the resource half of this binding does not reach a
 * MUTATED run's successor. Driven through the engine, not described.
 *
 * THIS TEST IS GREEN AND THE BEHAVIOUR IT PINS IS WRONG, which is deliberate and is the only
 * honest shape available here, because the fix is not in reach of this file's subject.
 * `#assertBound` compares `run.compiled.resolutionManifest` against `ctx.graph.resolutionManifest`
 * on the `isCompiled` arm alone, and states the gap where it lives: "the manifest is journaled on
 * `run.compiled` alone, so it can only be checked against the compiled graph". After a mutation
 * `ctx.graph` IS the successor — authorized, correctly, by the folded `graph.mutated.newHash` —
 * and that event carries no manifest. So the successor's manifest is not a recorded fact at all,
 * and no graph the compiler can produce changes which arm the engine takes.
 *
 * CLOSING IT NEEDS `graph.mutated` TO CARRY THE SUCCESSOR'S MANIFEST (`journal/events.ts`) AND
 * `#compiledIdentity`/`#assertBound` TO READ IT (`run/engine.ts`). Recomputing it instead of
 * recording it does not work: a mutation may name a ref nothing has seen, `frozenFirst` resolves
 * that one LIVE at the compile that introduces it, and its digest is written down nowhere — so a
 * fold cannot reconstruct the successor's manifest from `run.compiled` plus the added nodes.
 * Both files are kernel and both changes are a `fix`, which needs no seam.
 *
 * WHEN THAT LANDS THIS TEST GOES RED. That is the point of writing it here rather than in a
 * backlog row: the failure arrives in the file that documents the binding contract, beside the
 * control below. Swap the two expectations then and delete these paragraphs.
 *
 * WHAT IS AND IS NOT EXPOSED. `graph:mutate` is reachable from a library embedder and not from
 * the shipped binary, and a mutated successor still binds on its SPEC — a substituted graph is
 * refused exactly as the first test in this file shows. What goes unchecked is an edit to the
 * bytes behind a ref the run already resolved, on a run that mutated, decided by a process that
 * attached the successor.
 */
test("A MUTATED RUN'S SUCCESSOR IS DECIDED WITHOUT CHECKING THE RESOURCES BEHIND ITS REFS", async () => {
  const r = mutRig();
  const compiled = mutCompile(r, mutableSpec());
  const runId = await r.engine.submit({ graph: compiled, inputs: { note: "n" } });
  await r.engine.advance(runId);

  const open = await r.engine.openGates(runId);
  assert.equal(open.length, 1, "the agent's proposal must have added exactly one gate");
  const gateId = open[0]!.gateId;

  // The successor is the journal's own fact: only the ENGINE writes `graph.mutated`.
  const folded = (await r.engine.projection(runId))?.graphHash;
  assert.notEqual(folded, compiled.graphHash, "a mutated run's folded hash leaves its compile hash");

  // THE RESOURCES MOVE, exactly as editing a published prompt file moves them.
  r.res.bump();

  // A fresh process attaching the successor — `loom approve` after a restart is this shape.
  const second = r.fresh();
  const successor = mutCompile(second, successorSpec());
  assert.equal(successor.graphHash, folded, "the merged spec really is the graph the run folded to");
  assert.notDeepEqual(
    successor.resolutionManifest.map((p) => p.digest),
    compiled.resolutionManifest.map((p) => p.digest),
    "and it was compiled against the MOVED resources, so a manifest check would have something to find",
  );
  second.engine.attach(runId, successor);
  await second.engine.rehydrateGates(runId);

  const out = await second.engine.resolveGate(runId, {
    gateId: gateId as never,
    decision: { kind: "approve" },
    actor: alice,
    idempotencyKey: "mut-approve",
  });
  assert.equal(out.status, "succeeded", JSON.stringify(out.error ?? {}));

  // THE CONTROL, and it is what bounds the claim: the IDENTICAL edit, decided against the
  // COMPILED graph, is refused on the resource axis. The check works — it is the successor it
  // cannot reach, so this is one arm missing rather than a check that does nothing.
  const third = r.fresh();
  third.engine.attach(runId, mutCompile(third, mutableSpec()));
  await third.engine.rehydrateGates(runId);
  await assert.rejects(
    () =>
      third.engine.resolveGate(runId, {
        gateId: gateId as never,
        decision: { kind: "approve" },
        actor: alice,
        idempotencyKey: "ctl-approve",
      }),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_GRAPH_MISMATCH,
    "the same moved resources ARE refused when the attached graph is the compiled one",
  );
});

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
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";

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
      { id: "gate", type: "human_gate", reads: ["note"], writes: [], humanGate: { ref: "oversight/g@stable", approval: { mode: "single", approvers: ["u:alice"] } } },
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

test("A REJECTION IS EXEMPT — an operator whose graph drifted must still have an exit", async () => {
  // Binding `reject` too would leave a drifted run un-approvable, un-rejectable AND
  // un-cancellable, while `GateSweeper` — which needs no attachment — expired it into
  // `run.failed` anyway. A refusal has to leave a door.
  const r = rig();
  const { runId, gateId } = await park(r);
  const second = r.fresh();
  second.engine.attach(runId, compile(second, spec("SUBSTITUTED.txt")));

  const p = await decide(second, runId, gateId, "reject");
  assert.equal(p.status, "failed", "rejecting still works on a graph that no longer matches");
  assert.deepEqual(r.wrote, [], "and it still runs nothing");
});

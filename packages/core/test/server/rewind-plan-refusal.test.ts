/**
 * THE PREVIEW ROUTE ANSWERS 409 FOR A RUN `rewind` WOULD REFUSE. (§A.74, at the plane.)
 *
 * `GET /runs/:id/rewind-plan` returns `Engine.planRewind` directly, so §A.74 — which made that
 * verb run the two post-plan refusal arms `rewind` runs — is an observable change to this route:
 * a run holding a hard-to-undo effect whose undo arguments were never recorded used to answer
 * **200 with a `RewindPlan` whose `dispatch` was 0**, and now answers **409**. Every other
 * `rewind-plan` test in `test/server/` drives a run the arms are silent on, so before this file
 * the plane had no pin on the refusing half at all and the status code could have moved without
 * anything going red.
 *
 * IT IS A TRADE AND THE CONTROL IS HERE TO SHOW BOTH SIDES. The 200 it replaces carried a
 * `planHash` the `rewind` command would then have refused — an authorization screen for an act
 * that cannot happen. What a console loses is the per-step detail; what it gains is being told.
 * The second test is the ordinary half on the same route, same plane, same graph, one tool
 * swapped: the plan still comes back 200 when the undo really can be built.
 *
 * ITS OWN RIG RATHER THAN `harness()`, because the fact this is about is a tool manifest:
 * `irreversible` with a declared compensation and an `execute` that records no `details`. The
 * shared skeleton's only compensable tool is a `reversible_write`, which `isHardToUndo` excludes,
 * so no graph built from it can reach the arm.
 *
 * THE RUN IS DRIVEN ON THE ENGINE AND ONLY READ THROUGH THE ROUTE. How a run reaches this state
 * is `compensation-refused-then-rewind.test.ts`'s subject; this file's subject is the status code.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import type { RunId, Seq } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import { ControlPlane, type IdentitySource } from "../../src/server/http.ts";

const NOW = 1_700_000_000_000;

/** A person, because `planRewind` is human-only and that floor is not what this file tests. */
const ops: IdentitySource = {
  name: "sso",
  identify: () => ({ kind: "human", subject: "u:ops", via: "console", method: "sso" }),
};

/**
 * `pay.charge` records NO `details`, `pay.charge.kept` does — and that one field is the whole
 * difference between the two tests below. `argsDigest` is a digest OF `details`, so without it
 * there is no undo this engine can build, which is what §A.37's arm refuses on.
 */
const MANIFESTS: Record<string, ToolManifestLite> = {
  "pay.charge": { name: "pay.charge", version: "1.0", capabilities: ["pay"], irreversibility: "irreversible", idempotent: true, compensation: { tool: "pay.refund" } },
  "pay.charge.kept": { name: "pay.charge.kept", version: "1.0", capabilities: ["pay"], irreversibility: "irreversible", idempotent: true, compensation: { tool: "pay.refund" } },
  "pay.refund": { name: "pay.refund", version: "1.0", capabilities: ["pay"], irreversibility: "reversible_write", idempotent: true },
};

const RESOLVER: ResourceResolver = {
  resolve: (ref) => (/^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref) ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" } : undefined),
};

function spec(chargeTool: string): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "a74-plane", project: "probe", version: 1 },
    policy: { posture: "out", capabilities: ["pay"], expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { seed: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: ["seed"],
    outputs: [],
    nodes: [{ id: "charge", type: "tool", reads: ["seed"], writes: ["out"], tool: { name: chargeTool, version: "1.0", args: { row: 42 } }, retry: { maxAttempts: 1 } }],
    edges: [],
  } as unknown as GraphSpec;
}

interface Rig {
  readonly base: string;
  readonly runId: RunId;
  /** The seq just before the charge's `effect.started` — the boundary that would hide it. */
  readonly beforeTheCharge: Seq;
  /** A boundary above everything, where the plan is empty and no arm can fire. */
  readonly head: Seq;
  readonly close: () => Promise<void>;
}

/** Drive one charge to a finished run, then put a plane in front of its journal. */
async function rig(chargeTool: string): Promise<Rig> {
  const store = new MemoryStateStore({ now: () => NOW });
  const tools = new ToolRegistry();
  const charge = (name: string, keepDetails: boolean): ToolDefinition =>
    ({
      ...MANIFESTS[name],
      description: "Take money.",
      parameters: { type: "object", properties: { row: { type: "number" } }, required: ["row"] },
      execute: (args: Record<string, unknown>) => {
        const row = Number(args["row"]);
        return { content: "charged", ...(keepDetails ? { details: { row } } : {}), writes: { out: { row } } };
      },
    }) as ToolDefinition;
  tools.register(charge("pay.charge", false));
  tools.register(charge("pay.charge.kept", true));
  tools.register({
    ...MANIFESTS["pay.refund"],
    description: "Give it back.",
    parameters: { type: "object", properties: { row: { type: "number" } }, required: ["row"] },
    execute: () => ({ content: "refunded" }),
  } as ToolDefinition);

  const bus = new InProcessEventBus({ store });
  const engine = new Engine({
    store,
    bus,
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    resolver: RESOLVER,
    policy: { granted: ["pay"], systemFloor: "out", budget: { runUsd: 10 } },
  });

  const graph: RunGraph = compileOrThrow({ spec: spec(chargeTool), resolver: RESOLVER, tools: MANIFESTS, tenantCapabilities: ["pay"] });
  const runId = await engine.submit({ graph, inputs: { seed: "x" } });
  // AN `irreversible` TOOL AT POSTURE `out` SUSPENDS ON ITS OWN GATE FIRST, so approving it is
  // what makes the charge real — and a charge that never happened is not a fixture.
  for (let i = 0; i < 8; i++) {
    const p = await engine.advance(runId);
    if (p.status === "succeeded" || p.status === "failed") break;
    const open = Object.values(p.gates).find((g) => g.state === "open");
    if (open === undefined) break;
    await engine.resolveGate(runId, {
      gateId: open.gateId,
      decision: { kind: "approve" },
      actor: { kind: "human", subject: "u:ops", via: "console" },
      idempotencyKey: `k${String(i)}`,
    });
  }
  assert.equal((await engine.projection(runId))?.status, "succeeded", "precondition: the charge ran");

  const log: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1 as Seq)) log.push(ev);
  const call = log.find((e) => e.type === "tool.called" && (e.payload as { name?: string }).name === chargeTool);
  assert.notEqual(call, undefined, "precondition: the charge is recorded");

  const plane = new ControlPlane({ engine, store, bus, graphs: { "a74-plane": graph }, now: () => NOW, identity: ops });
  const { port } = await plane.listen(0);
  return {
    base: `http://127.0.0.1:${port}`,
    runId,
    beforeTheCharge: (call!.seq - 2) as Seq,
    head: log.at(-1)!.seq,
    close: () => plane.close(),
  };
}

async function preview(r: Rig, atSeq: number): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${r.base}/runs/${r.runId}/rewind-plan?atSeq=${String(atSeq)}`, {
    headers: { authorization: "Bearer anything" },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("a run whose undo arguments were never recorded gets 409 from the preview route, not a plan it cannot use", async () => {
  const r = await rig("pay.charge");
  try {
    const refused = await preview(r, r.beforeTheCharge);
    // 409 AND NOT 200. `err.conflict` is what `errors.ts` maps to 409, and `#refusePlannedRewind`
    // raises exactly that — so this one number is the whole of §A.74's plane-visible change.
    assert.equal(refused.status, 409, "the route refuses rather than publishing an unusable plan");
    const error = refused.body["error"] as { code?: string; message?: string } | undefined;
    assert.equal(error?.code, "E_RESTORE_ILLEGAL", "with the restore code, as the `rewind` command gives");
    // THE ARM'S OWN MESSAGE, so this cannot pass on some other refusal that happens to be a 409.
    assert.match(String(error?.message), /pay\.charge@\d+ -> pay\.refund/, "naming the effect and the undo it cannot build");
    assert.match(String(error?.message), /no live `effect\.completed` recording the `details`/, "and the fact that is missing");
    assert.equal(refused.body["planHash"], undefined, "and there is no hash to authorize");

    // AND THE CONTROL ON THE SAME ROUTE AND THE SAME RUN: a boundary above every effect plans
    // nothing, no arm fires, and the route still answers 200 with a plan.
    const ok = await preview(r, r.head);
    assert.equal(ok.status, 200, "the route is not simply broken for this run");
    assert.equal(typeof ok.body["planHash"], "string", "and hands back a plan an operator could authorize");
    assert.deepEqual(ok.body["steps"], [], "an empty one, because there is nothing after that boundary");
  } finally {
    await r.close();
  }
});

test("THE ORDINARY HALF — with the arguments recorded, the same route on the same boundary still answers 200", async () => {
  // ONE FIELD DIFFERS: `pay.charge.kept` returns `details: {row}`. If the 409 above were really
  // about tool nodes, irreversibility, or the boundary, this would be a 409 too.
  const r = await rig("pay.charge.kept");
  try {
    const ok = await preview(r, r.beforeTheCharge);
    assert.equal(ok.status, 200, "the plan an operator CAN act on still comes back");
    assert.equal(typeof ok.body["planHash"], "string", "with a hash to authorize");
    assert.equal((ok.body["steps"] as unknown[]).length, 1, "and the charge in it");
    assert.equal(ok.body["dispatch"], 1, "as an undo that will actually run");
  } finally {
    await r.close();
  }
});

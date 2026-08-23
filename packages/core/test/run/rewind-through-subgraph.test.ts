/**
 * T6 — the rewind refusal could not see what a child run did.
 *
 * `rewind` refuses to undo past a committed irreversible effect with no compensation, because
 * "the store must not offer a silently-unsafe undo". It scanned `tool.called` in the run's OWN
 * journal — and a `subgraph` node's work is in another one. `subgraph.started`'s docstring says
 * why: it "is the only link between them, which is what keeps a parent's journal the size of
 * the parent rather than of its whole tree".
 *
 * So the same irreversible, uncompensated tool, in the same position, behaved two ways:
 *
 *     tool DIRECTLY in the parent   rewind REFUSED (E_RESTORE_ILLEGAL)
 *     the same tool via a subgraph  rewind ALLOWED — with the charge already taken
 *
 * **Delegation was an undo the guarantee did not cover.**
 *
 * HANDOFF's T6 recorded the sibling gap — `reachableToolNames` does not descend into a
 * subgraph — and judged it "not currently a hole" because each run gets its own `PolicyEngine`
 * and the child re-decides at full strictness. That argument is sound and it is about the
 * POSTURE consumer. The rewind refusal is a different consumer of the same blindness, and it
 * was a hole. **An entry that says "not a hole" has usually only checked one consumer.**
 */
import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import type { Seq } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";

/** Irreversible and UNCOMPENSATED — the two facts the refusal keys on. */
const CHARGE: ToolManifestLite = { name: "pay.charge", version: "1.0", capabilities: ["pay"], irreversibility: "irreversible", idempotent: false };
/** The same action with a compensation declared, to prove the refusal is about that and not about subgraphs. */
const REFUNDABLE: ToolManifestLite = { ...CHARGE, name: "pay.refundable", compensation: { tool: "pay.refund" } };
const REFUND: ToolManifestLite = { name: "pay.refund", version: "1.0", capabilities: ["pay"], irreversibility: "reversible_write", idempotent: true };

function childSpec(tool: string): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "double", project: "sub", version: 1 },
    policy: { posture: "out", capabilities: ["pay"] },
    channels: { amount: { type: "number", reduce: "replace" }, doubled: { type: "number", reduce: "replace" }, receipt: { type: "object", reduce: "replace" } },
    inputs: ["amount"],
    outputs: ["receipt"],
    nodes: [
      { id: "double" as never, type: "function", reads: ["amount"], writes: ["doubled"], function: { ref: "function/double@stable" } },
      { id: "charge" as never, type: "tool", reads: ["doubled"], writes: ["receipt"], tool: { name: tool, version: "1.0", args: { amount: "${doubled}" } }, unhandled: true },
    ],
    edges: [{ id: "c" as never, from: "double" as never, to: "charge" as never, kind: "seq" }],
  };
}

function parentSpec(via: "subgraph" | "tool", tool: string): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "parent", project: "sub", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 32, maxDepth: 3, maxFanout: 4, maxLoopIterations: 1 }, capabilities: ["pay"] },
    channels: { total: { type: "number", reduce: "replace" }, result: { type: "object", reduce: "replace" } },
    inputs: ["total"],
    outputs: ["result"],
    nodes: [
      via === "subgraph"
        ? { id: "delegate" as never, type: "subgraph", reads: ["total"], writes: ["result"], checkpoint: "before",
            subgraph: { ref: "graph/double@stable", inputs: { amount: "total" }, outputs: { result: "receipt" }, budgetShare: 0.5 } }
        : { id: "delegate" as never, type: "tool", reads: ["total"], writes: ["result"], checkpoint: "before",
            tool: { name: tool, version: "1.0", args: { amount: "${total}" } }, unhandled: true },
    ],
    edges: [],
  };
}

function resolverWith(child: GraphSpec): ResourceResolver {
  return {
    resolve: (ref) => (/^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref) ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" } : undefined),
    subgraph: (ref) => (ref === "graph/double@stable" ? child : undefined),
  };
}

const MANIFESTS: Record<string, ToolManifestLite> = { "pay.charge": CHARGE, "pay.refundable": REFUNDABLE, "pay.refund": REFUND };

/** Run it, approve every gate, then try to undo the whole thing. */
async function runThenRewind(via: "subgraph" | "tool", tool: string) {
  const charges: number[] = [];
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const tools = new ToolRegistry();
  const body = (m: ToolManifestLite): ToolDefinition => ({
    ...m,
    description: "Take money.",
    parameters: { type: "object", properties: { amount: { type: "number" } } },
    execute: (args) => {
      charges.push(Number(args["amount"]));
      return { content: "charged", writes: { receipt: { ok: true } } };
    },
  });
  tools.register(body(CHARGE));
  tools.register(body(REFUNDABLE));
  tools.register({ ...REFUND, description: "Give it back.", parameters: { type: "object", properties: {} }, execute: () => ({ content: "refunded" }) });
  const functions = new FunctionRegistry();
  functions.register("function/double@stable", (view) => ({ writes: { doubled: (view.get<number>("amount") ?? 0) * 2 } }));

  const child = childSpec(tool);
  const resolver = resolverWith(child);
  const engine = new Engine({
    store, bus: new InProcessEventBus({ store }), tools, functions, models: new ModelRegistry(),
    now, sleep: async () => {}, resolver,
    policy: { granted: ["pay"], systemFloor: "out", budget: { runUsd: 10 } },
  });
  const graph = compileOrThrow({ spec: parentSpec(via, tool), resolver, tools: MANIFESTS, tenantCapabilities: ["pay"] });
  const runId = await engine.submit({ graph, inputs: { total: 21 } });
  let p = await engine.advance(runId);
  for (let i = 0; i < 4 && p.status === "awaiting_gate"; i++) {
    const open = Object.values(p.gates).find((g) => g.state === "open");
    if (open === undefined) break;
    p = await engine.resolveGate(runId, { gateId: open.gateId, decision: { kind: "approve" }, actor: { kind: "human", subject: "u:alice", via: "console" }, idempotencyKey: `k${i}` });
  }
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.equal(charges.length, 1, "the money moved exactly once — this test is about undoing that");

  let refused: unknown;
  try {
    await engine.rewind(runId, 1 as Seq, "operator asked to undo");
  } catch (e) {
    refused = e;
  }
  return { refused, charges };
}

test("A REWIND MAY NOT UNDO PAST A CHILD RUN'S IRREVERSIBLE WORK", async () => {
  const direct = await runThenRewind("tool", "pay.charge");
  assert.ok(isLoomError(direct.refused) && direct.refused.code === CODES.E_RESTORE_ILLEGAL, "the baseline: the parent's own call is refused");

  // THE DEFECT: this used to return no error at all — the rewind was allowed, and the run then
  // said the charge had never happened.
  const delegated = await runThenRewind("subgraph", "pay.charge");
  assert.ok(
    isLoomError(delegated.refused) && delegated.refused.code === CODES.E_RESTORE_ILLEGAL,
    `delegating the same action must not make it undoable: ${String(delegated.refused ?? "the rewind was ALLOWED")}`,
  );
  // And it says WHERE, because "which journal" is the one thing an operator cannot guess.
  assert.match(delegated.refused.message, /pay\.charge/);
  assert.match(delegated.refused.message, /in child run /, "the message must name the run the call is recorded in");
});

test("...and the refusal is about COMPENSATION, not about subgraphs", async () => {
  // Without this the fix could be "refuse every rewind past any subgraph", which is a different
  // and much blunter rule — it would make every pure-computation child un-rewindable. The
  // declared compensation is what makes the undo safe, wherever the call happened.
  const delegated = await runThenRewind("subgraph", "pay.refundable");
  assert.equal(delegated.refused, undefined, "a child call that declares a compensation is safe to undo");

  const direct = await runThenRewind("tool", "pay.refundable");
  assert.equal(direct.refused, undefined, "and so is the same call in the parent — one rule, two places");
});

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
import type { RunId, Seq } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import { OPERATOR } from "./operator.ts";

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
  /** Every refund the compensation tool actually performed. `failed` vs `compensated` is judged here. */
  const refunds: number[] = [];
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const tools = new ToolRegistry();
  const body = (m: ToolManifestLite): ToolDefinition => ({
    ...m,
    description: "Take money.",
    parameters: { type: "object", properties: { amount: { type: "number" } } },
    execute: (args) => {
      charges.push(Number(args["amount"]));
      // `details` is the only channel an undo's arguments can come from — `tool.called` carries a
      // shape and a digest, never values. Without it the step is `not_attempted` for a second and
      // unrelated reason, and the approval question below would never be reached.
      return { content: "charged", details: { amount: Number(args["amount"]) }, writes: { receipt: { ok: true } } };
    },
  });
  tools.register(body(CHARGE));
  tools.register(body(REFUNDABLE));
  tools.register({
    ...REFUND,
    description: "Give it back.",
    parameters: { type: "object", properties: { amount: { type: "number" } } },
    execute: (args) => {
      refunds.push(Number(args["amount"]));
      return { content: "refunded" };
    },
  });
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
  // Counted across BOTH ledgers so the helper also drives `pay.refund` as the node's own action —
  // the control leg below needs the graph to call it, and the rewind has not happened yet, so
  // exactly one of the two is non-empty here whichever tool was named.
  assert.equal(charges.length + refunds.length, 1, "the tool under test ran exactly once — this test is about undoing that");

  let refused: unknown;
  try {
    await engine.rewind(runId, 1 as Seq, "operator asked to undo", OPERATOR);
  } catch (e) {
    refused = e;
  }
  // Every `compensation.recorded` under this run, parent and child alike, tagged with which
  // journal it landed in — "which journal" being the one thing an operator cannot guess.
  const records: { readonly run: "parent" | "child"; readonly outcome: string; readonly reason?: string; readonly undo?: string }[] = [];
  const journals: { readonly runId: RunId; readonly which: "parent" | "child" }[] = [{ runId, which: "parent" }];
  for await (const ev of store.read(runId, 1 as Seq)) {
    if (ev.type === "subgraph.started") journals.push({ runId: ev.payload.childRunId, which: "child" });
  }
  for (const j of journals) {
    for await (const ev of store.read(j.runId, 1 as Seq)) {
      if (ev.type === "compensation.recorded") records.push({ run: j.which, ...(ev.payload as object) } as never);
    }
  }
  return { refused, charges, refunds, records };
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

test("A REWIND IS NOT A HUMAN'S YES TO THE UNDO — THE STEP IS JOURNALED failed AND THE MONEY STAYS TAKEN", async () => {
  // TWO CLAIMS, and the first is the reason the second could not be seen. The test above proves
  // the rewind is ALLOWED past a compensated child call; being allowed is not being undone.
  //
  // 1 · THE DESCENT IS ENTERED AT ALL. `rewind` gated its rollback on the PARENT's own plan, and
  //     this parent's single node is the delegation — zero steps — so `#compensate` was never
  //     called, and no journal anywhere said the refund had not happened. Measured before that
  //     fix, on this fixture: `charges [ 42 ]`, `refunds []`, and no records at all.
  //
  // 2 · AND THE UNDO IS REFUSED, WHICH IS THE FAIL-CLOSED ANSWER. `#compensateOne` dispatches
  //     through `#invokeTool` with `nodeApproved: false` — §A.8's guard — because a rollback is
  //     not a human's yes to anything: the human, if there was one, approved the action being
  //     UNDONE. `pay.refund` is a `reversible_write` policy answers `gate`, and a compensation
  //     turn cannot suspend to ask, so the step is journaled `failed` with the reason it gives
  //     and the charge stands.
  //
  //     THIS IS WHAT DISCRIMINATES ON THAT ARGUMENT, which the backlog records as load-bearing
  //     with nothing testing it — and it discriminates with a CONTROL rather than by asserting
  //     one outcome, because "the refund did not run" has a boring explanation for every reader:
  //     maybe `pay.refund` never runs here at all. The control is the SAME tool under the SAME
  //     registry, posture and grant, reached the other way — on a `tool` node, where the chain
  //     CAN suspend and a human answers the gate. It dispatches. The only difference between the
  //     two legs is who said yes, which is what `nodeApproved` carries.
  //
  //     It is journaled `failed` rather than performed because THE REWIND DOOR DOES NOT GATE.
  //     `Engine.rewind` defaults `by` to `SYSTEM_ACTOR("operator")` and checks nothing about it,
  //     unlike `steer`, `resolveGate` and `resolveBatch`, which each refuse a non-human actor —
  //     and the HTTP command route hands it `commandActor`'s system actor for a service token
  //     unchanged. `runThenRewind` passes no actor at all and is accepted, which is that fact
  //     driven rather than read. So an undo inheriting "the operator already approved this"
  //     would be an automated path granting itself approval, the one direction oversight may
  //     not move. The undos become dispatchable when the rewind door grows a floor of its own,
  //     and not before.
  const delegated = await runThenRewind("subgraph", "pay.refundable");
  assert.equal(delegated.refused, undefined, "the baseline from the test above: this rewind is allowed");

  assert.deepEqual(delegated.records.map((r) => r.run), ["child"], "the child's own journal is where its rollback is recorded");
  assert.equal(delegated.records[0]!.undo, "pay.refund");
  assert.equal(delegated.records[0]!.outcome, "failed", "an undo policy answers `gate` is refused, not performed");
  assert.match(delegated.records[0]!.reason ?? "", /requires human approval/);

  assert.deepEqual(delegated.refunds, [], "and nothing was given back");
  assert.deepEqual(delegated.charges, [42], "the charge stands — the operator is told, not obeyed silently");

  // THE CONTROL. `pay.refund` on a `tool` node, same engine options, same grant: the node's own
  // chain runs, it suspends on the gate, a human approves, and the tool executes. So the leg
  // above is refused for the reason it names and not because this tool cannot run.
  const approved = await runThenRewind("tool", "pay.refund");
  assert.deepEqual(approved.refunds, [21], "the identical tool DOES dispatch once a human approved it at the node");
});

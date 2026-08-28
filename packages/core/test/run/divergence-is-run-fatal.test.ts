/**
 * A DETECTED DIVERGENCE MUST NOT BE ROUTED AROUND.
 *
 * `#servedToolEffect` fails closed when a re-execution's call sequence has moved and the
 * recorded call at that position is non-idempotent: it raises `E_EFFECT_UNRECORDED` rather
 * than let the tool act a second time at an ordinal nothing is recorded under. That refusal
 * is correct and `effect-served-live.test.ts` already measures it — with the node's failure
 * UNHANDLED.
 *
 * One ordinary `error` edge was enough to undo it. `E_EFFECT_UNRECORDED` was not in
 * `RUN_FATAL_CODES`, so the refusal read as an ordinary failed Task, the edge activated a
 * rescue node, and the run reported **succeeded** carrying the rescue arm's value in its
 * output channel. That is verbatim the shape `RUN_FATAL_CODES`' own comments describe for
 * `E_GATE_REQUIRED` ("a join with `onBranchError: skip` absorbs it … both produce a run that
 * reports succeeded") and for `E_PAYLOAD_UNRESOLVED` — reached here through the other door.
 *
 * WHY ROUTING CANNOT BE RIGHT FOR THIS ONE. The failure is not "this node's work did not
 * work". It is "we no longer know what this run has already done to the world" — the
 * positional record and the body disagree, and continuing on any path at all is continuing
 * from a state the journal cannot reconstruct. Invariant 2 is what makes that fatal rather
 * than routable: a decision downstream of here would be reading a value the journal cannot
 * be folded to.
 *
 * THE FIXTURE is `swappedOrder` from `effect-served-live.test.ts`, rebuilt with an error edge
 * and a rescue node behind it — the smallest difference that turns the measured refusal into
 * a silent success.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { CODES } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import type { RunId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

interface Measured {
  readonly calls: readonly string[];
  readonly status: string;
  readonly out: unknown;
  readonly rescued: boolean;
  readonly log: readonly JournalEvent[];
}

/**
 * The same swapped-order divergence as `effect-served-live.test.ts`, with ONE difference: an
 * `error` edge out of the diverging node into a node that writes the run's output channel.
 */
async function divergenceWithErrorEdge(): Promise<Measured> {
  const calls: string[] = [];
  let rescued = false;

  const tools = new ToolRegistry();
  for (const name of ["a.first", "a.second"]) {
    tools.register({
      name,
      version: "1.0",
      // NON-IDEMPOTENT but not IRREVERSIBLE: an irreversible effect floors oversight at `in`
      // and the run parks at a gate, which would test the gate instead of the routing.
      irreversibility: name === "a.first" ? "reversible_write" : "read_only",
      idempotent: name !== "a.first",
      capabilities: [],
      description: name,
      parameters: { type: "object", properties: {} },
      execute: () => {
        calls.push(name);
        return Promise.resolve({ content: [{ type: "text", text: name }] });
      },
    } as never);
  }

  let attempt = 0;
  const functions = new FunctionRegistry();
  functions.register("function/swap@stable", async (_v, c) => {
    attempt += 1;
    const order = attempt === 1 ? ["a.first", "a.second"] : ["a.second", "a.first"];
    await c.effects![order[0]!]!({});
    // Attempt 1 stops after ONE call, retryably, so attempt 2 re-enters with ordinal 0 free.
    if (attempt === 1) return { retry: { reason: "once" } };
    await c.effects![order[1]!]!({});
    return { writes: { out: "done" } };
  });
  functions.register("function/rescue@stable", () => {
    rescued = true;
    return { writes: { out: "rescued" } };
  });

  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions,
    models,
    now,
    policy: { granted: ["*"] },
  });

  const graph = compileOrThrow({
    spec: {
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "swap-rescued", project: "t", version: 1 },
      policy: { posture: "out", capabilities: [] },
      channels: { out: { type: "string", reduce: "replace" } },
      inputs: [],
      outputs: ["out"],
      nodes: [
        {
          id: "n",
          type: "function",
          writes: ["out"],
          retry: { maxAttempts: 3, backoff: "fixed", initialMs: 0 },
          function: { ref: "function/swap@stable", effects: ["a.first", "a.second"] },
        },
        { id: "rescue", type: "function", writes: ["out"], function: { ref: "function/rescue@stable" } },
      ],
      edges: [{ id: "er", from: "n", to: "rescue", kind: "error" }],
    } as unknown as GraphSpec,
    resolver: resolver(),
    tools: {
      "a.first": { name: "a.first", version: "1.0", irreversibility: "reversible_write", idempotent: false, capabilities: [] },
      "a.second": { name: "a.second", version: "1.0", irreversibility: "read_only", idempotent: true, capabilities: [] },
    } as never,
    tenantCapabilities: [],
  });

  const runId: RunId = await engine.submit({ graph, inputs: {} });
  let p = await engine.advance(runId);
  for (let i = 0; i < 8 && (p.status === "queued" || p.status === "running"); i += 1) p = await engine.advance(runId);

  const log: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) log.push(ev);
  return { calls, status: p.status, out: p.channels["out"], rescued, log };
}

test("A DIVERGENCE THAT FAILED CLOSED IS NOT ABSORBED BY AN `error` EDGE", async () => {
  const m = await divergenceWithErrorEdge();
  const trace = m.log.map((ev) => `${String(ev.seq)} ${ev.type}`).join(" | ");

  // The refusal itself still happens — this test is about what the run does WITH it.
  assert.ok(
    m.log.some((ev) => ev.type === "task.failed" && JSON.stringify(ev.payload).includes(CODES.E_EFFECT_UNRECORDED)),
    `the divergence must still fail closed: ${trace}`,
  );
  // And the non-idempotent tool still acted exactly once.
  assert.equal(
    m.calls.filter((c) => c === "a.first").length,
    1,
    `a non-idempotent tool must not act twice; saw ${JSON.stringify(m.calls)}`,
  );

  assert.notEqual(
    m.status,
    "succeeded",
    `a run that cannot say what it did to the world must not report success: status=${m.status} out=${JSON.stringify(m.out)}`,
  );
  assert.equal(m.rescued, false, "the error edge must not run a rescue node past a divergence");
  assert.notEqual(m.out, "rescued", "the rescue arm's value must not reach the output channel");

  // AND IT ENDS, rather than sitting with a rescue Task readied and nothing to drive it.
  // `advance`'s run-fatal check runs BEFORE it dispatches ready Tasks, so the edge is taken
  // and journaled — the auditor can see what the graph WOULD have done — and never leased.
  assert.equal(m.status, "failed", `trace: ${trace}`);
});

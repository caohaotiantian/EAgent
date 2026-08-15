/**
 * What happens to a reservation once the work it covered is done.
 *
 * `reserve` debits the WORST CASE before a model call, so that fan-out cannot
 * check-then-act its way past the limit; `settle` gives back the difference between
 * the estimate and the bill. Only the first half was pinned. A `settle` that credited
 * the actual spend but never released the hold left every run poorer by the gap
 * between each estimate and each bill, and a long-running agent would then fail with
 * `E_BUDGET_EXHAUSTED` on money it had not spent — the estimate for a turn that ended
 * an hour ago still sitting on the books.
 *
 * The end-to-end tests derive their budgets from the adapter the engine actually
 * uses rather than hard-coding dollars, because the property under test is "one
 * worst case at a time" and not any particular price.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { NodeId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { PolicyEngine } from "../../src/run/policy.ts";
import {
  FunctionRegistry,
  MockModelAdapter,
  ModelRegistry,
  ToolRegistry,
  type ToolDefinition,
} from "../../src/run/registry.ts";
import type { ToolManifestLite } from "../../src/graph/validate.ts";
import { resolver } from "./skeleton.ts";

// ── the arithmetic ───────────────────────────────────────────────────────────

test("A SETTLED RESERVATION IS RELEASED, not merely charged", () => {
  // The hold and the bill are two different debits. Crediting the bill while keeping
  // the hold spends the money twice, because `remainingUsd` subtracts both.
  const p = new PolicyEngine({ granted: ["*"], budget: { runUsd: 1 } });
  const r = p.reserve("node:a", 0.4);
  assert.equal(p.reservedUsd, 0.4, "precondition: the worst case is held up front");
  assert.equal(p.remainingUsd, 0.6, "precondition: so a second reservation only sees what is left");

  p.settle(r, 0.05);
  assert.equal(p.reservedUsd, 0, "the hold is returned");
  assert.equal(p.spentUsd, 0.05, "and only the actual cost is charged");
  assert.equal(p.remainingUsd, 0.95, "so the difference is spendable again");
});

test("a released hold makes room for the NEXT reservation, which is the whole point", () => {
  // Under-reserving is unsafe; over-holding is merely invisible, which is worse to
  // debug. Three sequential calls whose estimates sum past the limit must still all
  // run when their bills do not.
  const p = new PolicyEngine({ granted: ["*"], budget: { runUsd: 1 } });
  for (let i = 0; i < 3; i++) p.settle(p.reserve(`node:a#${String(i)}`, 0.4), 0.01);

  assert.equal(p.spentUsd, 0.03);
  assert.equal(p.reservedUsd, 0);
  assert.ok(p.remainingUsd > 0.96, `$1.20 of estimates against a $1 budget must fit; $${p.remainingUsd} left`);
});

test("an UNSETTLED hold still blocks — the refusal is real, not cosmetic", () => {
  const p = new PolicyEngine({ granted: ["*"], budget: { runUsd: 1 } });
  p.reserve("node:a", 0.9);
  assert.throws(
    () => p.reserve("node:b", 0.2),
    (e: unknown) => (e as { code: string }).code === "E_BUDGET_EXHAUSTED",
    "reserve-worst-case is what stops 25 concurrent branches all passing the same check",
  );
});

test("settling twice is a no-op, so a retried settle cannot pay twice", () => {
  const p = new PolicyEngine({ granted: ["*"], budget: { runUsd: 1 } });
  const r = p.reserve("node:a", 0.4);
  p.settle(r, 0.1);
  p.settle(r, 0.1);
  assert.equal(p.spentUsd, 0.1);
  assert.equal(p.reservedUsd, 0);
});

test("a reservation this engine never issued cannot be settled into spend", () => {
  // The shape a restart produces: a `Reservation` value that outlived the object
  // holding the money. Crediting it would charge a run for a hold nobody placed.
  const p = new PolicyEngine({ granted: ["*"], budget: { runUsd: 1 } });
  p.settle({ id: "res-999", scope: "node:a", amountUsd: 0.4 }, 0.3);
  assert.equal(p.spentUsd, 0);
  assert.equal(p.reservedUsd, 0);
});

test("with no run budget there is nothing to exhaust, and nothing to leak", () => {
  const p = new PolicyEngine({ granted: ["*"] });
  const r = p.reserve("node:a", 1_000);
  assert.equal(p.remainingUsd, Number.POSITIVE_INFINITY);
  p.settle(r, 1);
  assert.equal(p.reservedUsd, 0);
});

test("`nearLimit` reads COMMITTED money — the hold counts before the bill arrives", () => {
  // E2 fires on what could still be spent, not on what has been. A rule that waited
  // for settlement would see the trough after every credit and never fire.
  const p = new PolicyEngine({ granted: ["*"], budget: { runUsd: 1 } });
  assert.equal(p.nearLimit, false);
  const r = p.reserve("node:a", 0.85);
  assert.equal(p.nearLimit, true, "80% committed is 80% committed, reserved or spent");
  p.settle(r, 0.01);
  assert.equal(p.nearLimit, false, "and it falls back once the real bill turns out to be small");
});

test("restore only ever ADDS spend, so a second attach cannot refund a run", () => {
  const p = new PolicyEngine({ granted: ["*"], budget: { runUsd: 1 } });
  p.restore({ escalations: {}, ceilings: {}, spentUsd: 0.5 });
  p.restore({ escalations: {}, ceilings: {}, spentUsd: 0.2 });
  assert.equal(p.spentUsd, 0.5, "the lower figure is a stale read, not a credit");
  assert.equal(p.remainingUsd, 0.5);
});

// ── the same property, through a real run ────────────────────────────────────

/** Model calls the node makes: `TURNS - 1` tool turns, then one that answers. */
const TURNS = 4;

const TOOLS: Record<string, ToolManifestLite> = {
  "note.read": {
    name: "note.read",
    version: "1.0",
    capabilities: ["fs:read"],
    irreversibility: "read_only",
    idempotent: true,
  },
};

/** One agent node that takes several turns, so it reserves several times in a row. */
function multiTurnSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "budget-turns", project: "test", version: 1 },
    policy: { posture: "out", budget: { costUsd: 1 }, capabilities: ["fs:read"] },
    channels: { goal: { type: "string", reduce: "replace" }, done: { type: "object", reduce: "replace" } },
    inputs: ["goal"],
    outputs: ["done"],
    nodes: [
      {
        id: "work" as NodeId,
        type: "agent",
        reads: ["goal"],
        writes: ["done"],
        agent: {
          profile: "agent_profile/w@stable",
          prompt: "prompt/w@stable",
          maxTurns: TURNS,
          tools: ["note.read"],
          outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
        },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

interface Rig {
  readonly engine: Engine;
  readonly graph: RunGraph;
  readonly model: MockModelAdapter;
}

function rig(runUsd: number): Rig {
  const now = (): number => 1_700_000_000_000;
  const tools = new ToolRegistry();
  tools.register({
    ...TOOLS["note.read"]!,
    description: "Read a note.",
    parameters: { type: "object", properties: { id: { type: "string" } } },
    execute: () => ({ content: "a note" }),
  } satisfies ToolDefinition);

  const model = new MockModelAdapter({
    script: (_req, turn) =>
      turn < TURNS - 1
        ? { toolCalls: [{ id: `c${String(turn)}`, name: "note.read", arguments: { id: "n" } }], finishReason: "tool_use" }
        : { text: JSON.stringify({ ok: true }), finishReason: "stop" },
    pricePerMTok: 1,
  });
  const models = new ModelRegistry();
  models.register(model, true);

  return {
    engine: new Engine({
      store: new MemoryStateStore({ now }),
      tools,
      functions: new FunctionRegistry(),
      models,
      now,
      policy: { granted: ["fs:read"], systemFloor: "out", budget: { runUsd } },
    }),
    graph: compileOrThrow({
      spec: multiTurnSpec(),
      resolver: resolver(),
      tools: TOOLS,
      tenantCapabilities: ["fs:read"],
    }),
    model,
  };
}

/**
 * Run the graph unconstrained and report what one turn is worth.
 *
 * Measured rather than assumed: hard-coding a dollar figure would make these tests a
 * hostage to the mock's pricing, and the property under test is "one worst case at a
 * time", which is a statement about turns.
 */
async function measure(): Promise<{ readonly worstTurnUsd: number; readonly billedUsd: number }> {
  const r = rig(1);
  const runId = await r.engine.submit({ graph: r.graph, inputs: { goal: "x" } });
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "succeeded", `the measuring run must be unconstrained: ${JSON.stringify(p.error ?? {})}`);
  assert.equal(r.model.seen.length, TURNS, "and it must make every turn the budgets below are sized for");

  const worstTurnUsd = Math.max(...r.model.seen.map((req) => r.model.estimateOf(req)));
  return { worstTurnUsd, billedUsd: p.usage.costUsd };
}

test("A RUN WHOSE ESTIMATES SUM PAST ITS BUDGET STILL FINISHES, because holds come back", async () => {
  const { worstTurnUsd, billedUsd } = await measure();

  // Room for one worst case plus change, and nothing like room for four. With `settle`
  // releasing, peak commitment is the settled spend plus ONE estimate; without, it is
  // the running sum of every estimate, and the second turn already cannot be reserved.
  const budgetUsd = worstTurnUsd * 1.15;
  assert.ok(
    billedUsd * 4 < worstTurnUsd,
    `precondition: four bills ($${String(billedUsd * 4)}) must fit inside one estimate ($${String(worstTurnUsd)}), ` +
      "or this budget is not measuring reservation release",
  );
  assert.ok(worstTurnUsd * 2 > budgetUsd, "precondition: two simultaneous holds must not fit");

  const r = rig(budgetUsd);
  const runId = await r.engine.submit({ graph: r.graph, inputs: { goal: "x" } });
  const p = await r.engine.advance(runId);

  assert.equal(
    p.status,
    "succeeded",
    `${String(TURNS)} turns billing $${String(billedUsd)} against a $${String(budgetUsd)} budget must finish: ` +
      JSON.stringify(p.error ?? {}),
  );
  assert.equal(r.model.seen.length, TURNS, "every turn ran; none was refused for money the run had not spent");
});

test("…and a budget that cannot cover even ONE worst case is refused up front", async () => {
  // The other side of the number above. Without it, the previous test would pass on any
  // budget large enough to be irrelevant, which is the failure mode a budget test has.
  const { worstTurnUsd } = await measure();
  const r = rig(worstTurnUsd / 2);
  const runId = await r.engine.submit({ graph: r.graph, inputs: { goal: "x" } });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "failed");
  assert.match(JSON.stringify(p.error), /E_BUDGET_EXHAUSTED/);
  assert.equal(r.model.seen.length, 0, "and it is refused BEFORE the call, not after the bill");
});

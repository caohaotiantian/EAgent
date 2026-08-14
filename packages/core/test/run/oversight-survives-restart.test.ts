/**
 * A restart must not lower oversight, and must not refund the budget.
 *
 * `PolicyEngine` held escalations, human ceilings and accumulated spend in memory only,
 * and `Engine.#contextFor` builds a fresh one per attach — so every escalation a run had
 * earned vanished on restart, and the run was handed its full budget again. `attach`'s
 * docstring said "there is deliberately nothing to restore".
 *
 * All three are journaled facts (`policy.escalated`, `policy.deescalated`, and the usage
 * folded from `*.called`), so the fix is not new bookkeeping — it is folding what the
 * journal already had. Invariant 2 in its sharpest form: state that is durable in
 * principle and only in memory in practice is state the journal is not authoritative for.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { foldRun } from "../../src/run/projection.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import type { RunId } from "../../src/ids.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { PolicyEngine } from "../../src/run/policy.ts";
import { compileSkeleton, DOCS, harness } from "./skeleton.ts";

async function events(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const e of store.read(runId, 1)) out.push(e);
  return out;
}

/** A second Engine over the SAME store — what a process restart looks like. */
function reattach(store: MemoryStateStore): Engine {
  const clock = { t: 1_700_000_000_000 };
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }), pricePerMTok: 1 }), true);
  return new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions: new FunctionRegistry(),
    models,
    now: () => clock.t,
    maxParallelism: 4,
    policy: { granted: ["fs:read", "fs:write"], budget: { runUsd: 1.0 } },
  });
}

test("A HUMAN CEILING SURVIVES A RESTART", async () => {
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const h = harness({ store });
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS.slice(0, 2) } });
  await h.engine.advance(runId);

  await h.engine.deescalate(runId, `run:${runId}`, "on", "operator is watching this one", {
    kind: "human",
    id: "u:alice",
  });

  const revived = reattach(store);
  await revived.attach(runId, compileSkeleton());
  const after = await revived.advance(runId);
  assert.equal(
    after.ceilings[`run:${runId}`],
    "on",
    "a decision a human journaled must survive the process that recorded it",
  );
});

test("PolicyEngine.restore re-seeds without journaling, and only ever tightens", () => {
  const appended: string[] = [];
  const pe = new PolicyEngine({
    granted: [],
    budget: { runUsd: 1 },
    onEscalate: (rule) => appended.push(rule),
  });

  pe.restore({ escalations: { "run:r": "in" }, ceilings: {}, spentUsd: 0.5 });
  assert.deepEqual(appended, [], "replaying the journal must not re-append the events being replayed");
  assert.equal(pe.spentUsd, 0.5, "spend is restored, not reset");

  // Idempotent and monotone: attaching twice must not loosen or double-count.
  pe.restore({ escalations: { "run:r": "out" }, ceilings: {}, spentUsd: 0.2 });
  assert.equal(pe.spentUsd, 0.5, "a second restore must not lower the running total");
});

test("spend survives a restart — the run does not get its budget back", async () => {
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const h = harness({ store });
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS.slice(0, 2) } });
  await h.engine.advance(runId);

  const spent = (await h.engine.projection(runId))!.usage.costUsd;
  assert.ok(spent > 0, "precondition: this run spent something");

  const revived = reattach(store);
  await revived.attach(runId, compileSkeleton());
  const after = await revived.advance(runId);
  assert.ok(
    after.usage.costUsd >= spent,
    `a restart must not refund spend: ${String(spent)} before, ${String(after.usage.costUsd)} after`,
  );
});

test("the fold replays escalate and de-escalate IN SEQ ORDER, not as two max-folds", () => {
  // `deescalate` deletes the escalation AND sets a ceiling. Folding the `to` values as
  // two independent maxima can therefore reconstruct a posture LOWER than the process
  // held — invariant 5 bent by the repair itself.
  const base = { runId: "run_x" as RunId, ts: 1, actor: { kind: "system" as const, id: "policy" } };
  const log = [
    { ...base, seq: 1, type: "run.submitted", payload: { graphHash: "h", inputs: {} } },
    { ...base, seq: 2, type: "policy.escalated", payload: { rule: "e1", from: "out", to: "in", scope: "run:run_x" } },
    { ...base, seq: 3, type: "policy.deescalated", payload: { from: "in", to: "on", scope: "run:run_x", justification: "ok" } },
    { ...base, seq: 4, type: "policy.escalated", payload: { rule: "e2", from: "out", to: "on", scope: "run:run_x" } },
  ] as unknown as JournalEvent[];

  const p = foldRun(log)!;
  assert.equal(p.ceilings["run:run_x"], "on", "the human ceiling stands");
  assert.equal(
    p.escalations["run:run_x"],
    "on",
    "the post-deescalation escalation raises from the floor, not from the deleted `in`",
  );
});

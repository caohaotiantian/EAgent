/**
 * Retries, cancellation, and rewind.
 *
 * Each of these is declared in `GraphSpec` and validated by the compiler, so leaving
 * them unimplemented would mean the schema promised something the runtime ignored.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { compileOrThrow } from "../../src/graph/compile.ts";
import { validate } from "../../src/schema.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { NodeId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { foldRun } from "../../src/run/projection.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import { rewindWithPlan } from "./operator.ts";
import { SKELETON_TOOLS, resolver } from "./skeleton.ts";

/** A two-node graph: one tool node that can be made to fail, then a report. */
function retrySpec(retry: GraphSpec["nodes"][number]["retry"], toolName = "flaky"): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "retry-demo", project: "test", version: 1 },
    policy: { capabilities: ["fs:write"] },
    channels: {
      seed: { type: "string", reduce: "replace" },
      out: { type: "object", reduce: "replace" },
    },
    inputs: ["seed"],
    outputs: ["out"],
    nodes: [
      {
        id: "act" as NodeId,
        type: "tool",
        reads: ["seed"],
        writes: ["out"],
        tool: { name: toolName, version: "1.0", args: { seed: "${seed}" } },
        ...(retry === undefined ? {} : { retry }),
      },
    ],
    edges: [],
  };
}

interface Rig {
  engine: Engine;
  store: MemoryStateStore;
  attempts: () => number;
  tick: (ms: number) => void;
}

function rig(opts: { failTimes: number; idempotent?: boolean; toolName?: string }): Rig {
  const clock = { t: 1_700_000_000_000 };
  const store = new MemoryStateStore({ now: () => clock.t });
  const tools = new ToolRegistry();
  let attempts = 0;

  const flaky: ToolDefinition = {
    name: opts.toolName ?? "flaky",
    version: "1.0",
    capabilities: ["fs:write"],
    irreversibility: "reversible_write",
    idempotent: opts.idempotent ?? true,
    description: "Fails a fixed number of times, then succeeds.",
    parameters: { type: "object", properties: { seed: { type: "string" } } },
    execute: () => {
      attempts++;
      if (attempts <= opts.failTimes) {
        const e = Object.assign(new Error("transient upstream failure"), { name: "Error" });
        throw e;
      }
      return { content: "ok", writes: { out: { attempts } } };
    },
  };
  tools.register(flaky);

  const engine = new Engine({
    store,
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now: () => clock.t,
    policy: { granted: ["fs:write"] },
  });
  return { engine, store, attempts: () => attempts, tick: (ms) => (clock.t += ms) };
}

async function eventsOf(store: MemoryStateStore, runId: Parameters<MemoryStateStore["read"]>[0]): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const e of store.read(runId, 1)) out.push(e);
  return out;
}

const compileWith = (spec: GraphSpec) =>
  compileOrThrow({ spec, resolver: resolver(), tools: { ...SKELETON_TOOLS, flaky: { name: "flaky", version: "1.0", capabilities: ["fs:write"], irreversibility: "reversible_write", idempotent: true }, risky: { name: "risky", version: "1.0", capabilities: ["fs:write"], irreversibility: "reversible_write", idempotent: false } }, tenantCapabilities: ["fs:write"] });

// ── retries ──────────────────────────────────────────────────────────────────

test("a retryable failure is rescheduled, not committed", async () => {
  const r = rig({ failTimes: 1 });
  const graph = compileWith(retrySpec({ maxAttempts: 3, backoff: "fixed", initialMs: 100 }));
  const runId = await r.engine.submit({ graph, inputs: { seed: "s" } });

  let p = await r.engine.advance(runId);
  // The first attempt failed and is in backoff, so the run is not finished.
  assert.notEqual(p.status, "failed");
  assert.equal(r.attempts(), 1);

  r.tick(100);
  p = await r.engine.advance(runId);

  assert.equal(p.status, "succeeded");
  assert.equal(r.attempts(), 2, "exactly one retry");
  const scheduled = (await eventsOf(r.store, runId)).filter((e) => e.type === "task.retry_scheduled");
  assert.equal(scheduled.length, 1);
  assert.equal((scheduled[0]!.payload as { afterMs: number }).afterMs, 100);
});

test("exponential backoff doubles and is capped", async () => {
  const r = rig({ failTimes: 3 });
  const graph = compileWith(retrySpec({ maxAttempts: 4, backoff: "exponential", initialMs: 100, maxMs: 150 }));
  const runId = await r.engine.submit({ graph, inputs: { seed: "s" } });

  for (let i = 0; i < 4; i++) {
    await r.engine.advance(runId);
    r.tick(1000);
  }
  const delays = (await eventsOf(r.store, runId))
    .filter((e) => e.type === "task.retry_scheduled")
    .map((e) => (e.payload as { afterMs: number }).afterMs);
  assert.deepEqual(delays, [100, 150, 150], "100, then 200 capped to 150");
});

test("backoff is a pure function of (policy, attempt) — no jitter", async () => {
  // Jitter would make the delay part of a recorded decision that replay could not
  // reproduce. Two identical runs must schedule identical delays.
  const delaysFor = async (): Promise<number[]> => {
    const r = rig({ failTimes: 2 });
    const graph = compileWith(retrySpec({ maxAttempts: 3, backoff: "exponential", initialMs: 40, jitter: true }));
    const runId = await r.engine.submit({ graph, inputs: { seed: "s" } });
    for (let i = 0; i < 3; i++) {
      await r.engine.advance(runId);
      r.tick(1000);
    }
    return (await eventsOf(r.store, runId))
      .filter((e) => e.type === "task.retry_scheduled")
      .map((e) => (e.payload as { afterMs: number }).afterMs);
  };
  assert.deepEqual(await delaysFor(), await delaysFor());
});

test("attempts are exhausted and then the Task fails for real", async () => {
  const r = rig({ failTimes: 99 });
  const graph = compileWith(retrySpec({ maxAttempts: 2, backoff: "fixed", initialMs: 10 }));
  const runId = await r.engine.submit({ graph, inputs: { seed: "s" } });

  await r.engine.advance(runId);
  r.tick(100);
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "failed");
  assert.equal(r.attempts(), 2, "maxAttempts means attempts, not retries");
});

test("no retry policy means no retry", async () => {
  const r = rig({ failTimes: 1 });
  const graph = compileWith(retrySpec(undefined));
  const runId = await r.engine.submit({ graph, inputs: { seed: "s" } });
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "failed");
  assert.equal(r.attempts(), 1);
});

test("a NON-IDEMPOTENT tool that reached its sandbox is never auto-retried", async () => {
  // The bell may already have rung. Retrying is the dangerous option, so the answer
  // is no even though attempts remain and the error is retryable.
  const r = rig({ failTimes: 1, idempotent: false, toolName: "risky" });
  const graph = compileWith(retrySpec({ maxAttempts: 5, backoff: "fixed", initialMs: 10 }, "risky"));
  const runId = await r.engine.submit({ graph, inputs: { seed: "s" } });

  await r.engine.advance(runId);
  r.tick(100);
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "failed");
  assert.equal(r.attempts(), 1, "one attempt, no retry");
});

test("onlyIf gates retries on the normalized code", async () => {
  const r = rig({ failTimes: 1 });
  const graph = compileWith(retrySpec({ maxAttempts: 3, backoff: "fixed", initialMs: 10, onlyIf: ["E_PROVIDER_RATE_LIMIT"] }));
  const runId = await r.engine.submit({ graph, inputs: { seed: "s" } });
  await r.engine.advance(runId);
  r.tick(100);
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "failed", "a schema failure is not retried as if it were a network blip");
  assert.equal(r.attempts(), 1);
});

// ── cancellation ─────────────────────────────────────────────────────────────

test("cancelling a finished run is a no-op", async () => {
  const r = rig({ failTimes: 0 });
  const graph = compileWith(retrySpec(undefined));
  const runId = await r.engine.submit({ graph, inputs: { seed: "s" } });
  await r.engine.advance(runId);
  const p = await r.engine.cancel(runId);
  assert.equal(p.status, "succeeded", "a completed run is not retroactively cancelled");
});

test("cancel journals the command BEFORE acting on it", async () => {
  const r = rig({ failTimes: 0 });
  const graph = compileWith(retrySpec(undefined));
  const runId = await r.engine.submit({ graph, inputs: { seed: "s" } });
  await r.engine.cancel(runId, "operator pressed stop");

  const log = await eventsOf(r.store, runId);
  const cmd = log.findIndex((e) => e.type === "operator.command");
  const cancelled = log.findIndex((e) => e.type === "run.cancelled");
  assert.ok(cmd >= 0 && cancelled > cmd, "a crash between the two re-drives the cancel on restart");
});

test("a clean cancel says clean; the projection carries no unknown effects", async () => {
  const r = rig({ failTimes: 0 });
  const graph = compileWith(retrySpec(undefined));
  const runId = await r.engine.submit({ graph, inputs: { seed: "s" } });
  const p = await r.engine.cancel(runId);
  assert.equal(p.status, "cancelled");
  assert.deepEqual(p.unknownEffects, []);
  const rec = (await eventsOf(r.store, runId)).find((e) => e.type === "run.cancelled");
  assert.equal((rec!.payload as { clean: boolean }).clean, true);
});

test("an effect that started with no outcome makes the cancel report DIRTY", async () => {
  // Hand-built journal: the exact shape of `kill -9` during an irreversible call.
  const store = new MemoryStateStore({ now: () => 1 });
  const runId = "01JRUNDIRTY0000000000000000" as never;
  await store.append({
    runId,
    expectedSeq: 0,
    events: [
      { type: "run.started", payload: { posture: "on" }, actor: { kind: "system", component: "t" } },
      {
        type: "effect.started",
        payload: { key: "act@root#0:tool:0", kind: "tool", attempt: 1 },
        actor: { kind: "system", component: "t" },
        taskId: "act@root#0" as never,
      },
    ],
  });
  const p = foldRun(await eventsOf(store, runId))!;
  assert.deepEqual(p.unknownEffects, ["act@root#0:tool:0"]);
  assert.equal(p.status, "running", "not clean, and the projection says so rather than guessing");
});

// ── rewind ───────────────────────────────────────────────────────────────────

test("rewind hides events without editing history", async () => {
  const r = rig({ failTimes: 0 });
  const graph = compileWith(retrySpec(undefined));
  const runId = await r.engine.submit({ graph, inputs: { seed: "s" } });
  const done = await r.engine.advance(runId);
  assert.equal(done.status, "succeeded");
  const before = await eventsOf(r.store, runId);

  // Rewind to just after the run started, before anything executed.
  const startedAt = before.find((e) => e.type === "run.started")!.seq;
  const p = await rewindWithPlan(r.engine, runId, startedAt, "operator undo");

  assert.equal(p.status, "running", "the completion is hidden");
  assert.deepEqual(p.channels["out"], undefined, "and so is the write");

  const after = await eventsOf(r.store, runId);
  assert.ok(after.length > before.length, "the journal GREW; nothing was deleted");
  for (let i = 0; i < before.length; i++) assert.deepEqual(after[i], before[i], "history is byte-identical");
});

test("rewind is itself recorded, so the undo is auditable", async () => {
  const r = rig({ failTimes: 0 });
  const graph = compileWith(retrySpec(undefined));
  const runId = await r.engine.submit({ graph, inputs: { seed: "s" } });
  await r.engine.advance(runId);
  await rewindWithPlan(r.engine, runId, 3, "wrong input");

  const marker = (await eventsOf(r.store, runId)).find((e) => e.type === "checkpoint.restored");
  assert.ok(marker);
  assert.equal((marker.payload as { reason: string }).reason, "wrong input");
  assert.equal((marker.payload as { mode: string }).mode, "rewind");
});

test("rewind refuses to undo past an irreversible action with no compensation", async () => {
  const clock = { t: 1 };
  const store = new MemoryStateStore({ now: () => clock.t });
  const tools = new ToolRegistry();
  tools.register({
    name: "charge",
    version: "1.0",
    capabilities: ["fs:write"],
    irreversibility: "irreversible",
    idempotent: false,
    description: "Takes money.",
    parameters: { type: "object", properties: {} },
    execute: () => ({ content: "charged", writes: { out: { charged: true } } }),
  });
  const engine = new Engine({
    store,
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now: () => clock.t,
    policy: { granted: ["fs:write"], systemFloor: "out" },
  });

  const spec = retrySpec(undefined, "charge");
  const graph = compileOrThrow({
    spec: { ...spec, nodes: spec.nodes.map((n) => ({ ...n, unhandled: true })) },
    resolver: resolver(),
    tools: { charge: { name: "charge", version: "1.0", capabilities: ["fs:write"], irreversibility: "irreversible", idempotent: false } },
    tenantCapabilities: ["fs:write"],
  });

  const runId = await engine.submit({ graph, inputs: { seed: "s" } });
  const gated = await engine.advance(runId);
  // An irreversible tool is `in` by default, so it gated rather than charging.
  assert.equal(gated.status, "awaiting_gate");
  const gate = Object.values(gated.gates).find((g) => g.state === "open")!;
  await engine.resolveGate(runId, {
    gateId: gate.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:a", via: "console" },
    idempotencyKey: "k",
  });

  await assert.rejects(() => rewindWithPlan(engine, runId, 1, "undo the charge"), /E_RESTORE_ILLEGAL|declares no compensation/);
});

// ── schema (regression) ──────────────────────────────────────────────────────

test("a bare {type:'object'} schema passes every key through", () => {
  // It previously stripped them all, so a permissive schema silently meant "the
  // empty object" — which is never what anyone writing it intended.
  const r = validate({ type: "object" }, { a: 1, nested: { b: 2 } });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { a: 1, nested: { b: 2 } });
});

test("a DECLARED shape still drops undeclared keys", () => {
  const r = validate({ type: "object", properties: { a: { type: "number" } } }, { a: 1, stray: "x" });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { a: 1 }, "declaring a shape is what makes a key stray");
});

test("additionalProperties:false still rejects strays explicitly", () => {
  const r = validate({ type: "object", additionalProperties: false }, { a: 1 });
  assert.equal(r.ok, false);
});

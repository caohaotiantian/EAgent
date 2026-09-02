/**
 * MONEY PROMISED IS DURABLE, OR THE FOLD REPORTS LESS THAN THE RUN HAS COMMITTED.
 *
 * `PolicyEngine.reserve` debits the worst case before a model call and `settle` credits the real
 * cost after it, so between the two there is an amount that is spoken for and not spent. That
 * amount is not decorative: `reserve` refuses against `spent + reserved`, `nearLimit` fires on it,
 * and `server/http.ts` serves it to an operator as `reservedUsd` on `GET /runs/:id`. It lived in
 * one process's `#reservedUsd` field and nowhere else, which is CLAUDE.md's first non-negotiable
 * exactly — a decision reading a value the journal cannot reconstruct.
 *
 * `run/projection.ts` has folded `budget.reserved`/`budget.settled` into `reservedUsd` since
 * before either had a writer, so the fold read like proof that something wrote them. Measured on
 * this file's own graph with a model call paused mid-stream, before the appenders existed:
 *
 *     mid-flight folded reservedUsd = 0        final usage.costUsd = 0.000027
 *
 * and after:
 *
 *     mid-flight folded reservedUsd = 0.001048  final usage.costUsd = 0.000027
 *
 * The gap between those two numbers is the whole point: 0.001048 is the WORST CASE the adapter
 * quoted and 0.000027 is what the turn really cost, so an operator reading spend alone is reading
 * the trough of a number that peaks well above it while the call is in flight.
 *
 * WHAT MAKES THIS FAIL RATHER THAN JUST PASS — run against a tree with the three appends
 * deleted, both cases red:
 *   - `AssertionError: a call is in flight and the fold reports 0 promised`
 *   - `AssertionError: the rule must have seen a reservation; it was skipped as:
 *     {"rule":"budget.reservation-is-settled","why":"no event this rule constrains appears in
 *     this journal"}` — on a run that did take one.
 *
 * The second-engine assertion is not separately measured red: the first assertion throws before
 * it and the case ends there. What it is for is the word DURABLE — an `Engine` that never called
 * `reserve` and holds no `PolicyEngine` state for this run reaching the same number by folding
 * the log is the difference between a value that is recorded and a value that merely exists.
 * The journal this file drives holds one `budget.reserved` and one `budget.settled` in sixteen
 * events.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { auditRun } from "../../src/journal/audit.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ToolManifestLite } from "../../src/graph/validate.ts";
import type { NodeId, RunId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const TOOLS: Record<string, ToolManifestLite> = {
  "note.read": { name: "note.read", version: "1.0", capabilities: ["fs:read"], irreversibility: "read_only", idempotent: true },
};

function spec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "budget-reservation", project: "test", version: 1 },
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
          maxTurns: 2,
          tools: ["note.read"],
          outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
        },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

/** A run whose single model turn can be held open, so "mid-flight" is a state a test can read. */
function paused(): {
  readonly store: MemoryStateStore;
  readonly engine: Engine;
  readonly graph: ReturnType<typeof compileOrThrow>;
  /** Resolves once the adapter has been entered and the reservation is therefore outstanding. */
  readonly inFlight: Promise<void>;
  release(): void;
} {
  const now = (): number => 1_700_000_000_000;
  const tools = new ToolRegistry();
  tools.register({
    ...TOOLS["note.read"]!,
    description: "Read a note.",
    parameters: { type: "object", properties: {} },
    execute: () => ({ content: "a note" }),
  } satisfies ToolDefinition);

  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let reached!: () => void;
  const inFlight = new Promise<void>((r) => {
    reached = r;
  });

  // The pause is INSIDE `stream`, after `reserve` and before any frame — the exact window the
  // reservation is held across, and the only window in which the two numbers differ.
  class Slow extends MockModelAdapter {
    override async *stream(req: never, signal: never): AsyncGenerator<never> {
      reached();
      await gate;
      yield* super.stream(req as never, signal as never) as AsyncGenerator<never>;
    }
  }
  const models = new ModelRegistry();
  models.register(new Slow({ script: () => ({ text: JSON.stringify({ ok: true }), finishReason: "stop" }), pricePerMTok: 1 }) as never, true);

  const store = new MemoryStateStore({ now });
  const engine = new Engine({
    store,
    tools,
    functions: new FunctionRegistry(),
    models,
    now,
    policy: { granted: ["fs:read"], systemFloor: "out", budget: { runUsd: 1 } },
  });
  const graph = compileOrThrow({ spec: spec(), resolver: resolver(), tools: TOOLS, tenantCapabilities: ["fs:read"] });
  return { store, engine, graph, inFlight, release };
}

test("AN OUTSTANDING RESERVATION IS IN THE JOURNAL, NOT IN ONE PROCESS'S MEMORY", async () => {
  const h = paused();
  const runId = await h.engine.submit({ graph: h.graph, inputs: { goal: "g" } });
  const driving = h.engine.advance(runId);
  await h.inFlight;

  // `finally`, and it is not tidiness: the paused adapter is holding the only `advance` this run
  // will get, so an assertion that throws before the release leaves `driving` pending forever and
  // the RED run of this case hangs instead of reporting. Measured the hard way, deleting the
  // appenders under a version without it.
  let mid;
  try {
    mid = await h.engine.projection(runId);
    assert.ok(mid !== undefined, "the run has a journal");
    assert.ok(mid.reservedUsd > 0, `a call is in flight and the fold reports ${String(mid.reservedUsd)} promised`);
    // THE TWO NUMBERS ARE DIFFERENT NUMBERS, which is the reason the row exists. Nothing has
    // settled yet, so spend is still zero while an amount is already committed against the budget.
    assert.equal(mid.usage.costUsd, 0, "nothing has settled yet, so nothing is spent yet");

    // AND A SECOND ENGINE SEES IT. This is the half that makes the claim "durable" rather than
    // "present": this object never called `reserve`, holds no `PolicyEngine` state for the run,
    // and reaches the same number by folding the log the first one wrote.
    const observer = new Engine({
      store: h.store,
      tools: new ToolRegistry(),
      functions: new FunctionRegistry(),
      models: new ModelRegistry(),
      now: () => 1_700_000_000_000,
      policy: { granted: ["fs:read"], systemFloor: "out", budget: { runUsd: 1 } },
    });
    const observed = await observer.projection(runId);
    assert.equal(observed?.reservedUsd, mid.reservedUsd, "a second plane folding the same journal must reach the same promise");
  } finally {
    h.release();
  }
  await driving;

  const end = await h.engine.projection(runId);
  assert.equal(end?.reservedUsd, 0, "every reservation this run took was settled, so nothing is promised at the end");
  assert.ok((end?.usage.costUsd ?? 0) > 0, "the turn that settled charged something");
});

test("`budget.reservation-is-settled` is CHECKED on a completed run, and fires on a stranded promise", async () => {
  const h = paused();
  const runId = await h.engine.submit({ graph: h.graph, inputs: { goal: "g" } });
  const driving = h.engine.advance(runId);
  await h.inFlight;
  h.release();
  await driving;

  const log: JournalEvent[] = [];
  for await (const ev of h.store.read(runId as RunId, 1)) log.push(ev);

  // A rule that saw no relevant event is reported as skipped, never as passed — so "checked"
  // is the assertion that this rule is not the inert kind `journal/audit.ts`'s header names.
  const clean = auditRun(log);
  assert.ok(
    clean.checked.includes("budget.reservation-is-settled"),
    `the rule must have seen a reservation; it was skipped as: ${JSON.stringify(clean.skipped.find((s) => s.rule === "budget.reservation-is-settled"))}`,
  );
  assert.deepEqual(
    clean.violations.filter((v) => v.rule === "budget.reservation-is-settled"),
    [],
    "a healthy run settles what it reserves, and a rule that fires on a healthy run gets switched off",
  );

  // AND IT FIRES. Drop the settlements and the same journal is a run that completed holding
  // promises — the shape a worker that died between `reserve` and `settle` leaves behind, which
  // was invisible while neither event had a writer.
  const stranded = log.filter((e) => e.type !== "budget.settled");
  assert.ok(stranded.length < log.length, "the journal must actually contain settlements for this case to mean anything");
  const bad = auditRun(stranded).violations.filter((v) => v.rule === "budget.reservation-is-settled");
  assert.equal(bad.length, log.filter((e) => e.type === "budget.reserved").length, "one violation per reservation nothing released");
  assert.match(bad[0]!.detail, /reserved budget at seq \d+ and the run completed without settling it/);
});

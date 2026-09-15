/**
 * A REFUSAL AT THE ADVANCE DOOR LEAVES A ROW THE FOLD CAN SERVE. (§A.63.)
 *
 * `#assertBound`'s two VOCABULARY checks — an edge `kind` outside `EDGE_KINDS`, and a `maxWidth`
 * outside `readableFanoutWidth`, three lines apart — both `throw` before anything is appended. The
 * caller got `E_GRAPH_INVALID`; the journal, which is the only authoritative state, held
 * `run.submitted, run.compiled, run.started, task.ready` and nothing about why. A second process
 * attaching later saw a `running` run with no reason and no terminal row. Measured on `dbaa5671`,
 * for BOTH checks, submit-then-advance on a hand-built `RunGraph`:
 *
 *     === maxWidth: "24" ===
 *     advance threw: E_GRAPH_INVALID / validation
 *     status after refusal: running
 *     journal event types: run.submitted, run.compiled, run.started, task.ready
 *     any run.failed row? false
 *     second advance threw: E_GRAPH_INVALID
 *
 *     === kind: "conditionl" ===        (identical, line for line)
 *
 * BOTH CHECKS OR NEITHER. `0dd0a524` closed a three-lines-apart asymmetry between these two;
 * answering one of them and not the other puts it straight back, which is why every case below
 * runs over both and why the engine keys on the CODE rather than on either arm.
 *
 * THE ORDINARY HALF IS THE LAST TEST, and it is the reason the engine does not simply fail the
 * run on every refusal at this door. `advance` refuses the graph IN HAND, and the vocabulary
 * checks sit ABOVE the compile-identity check on purpose — so a caller who `attach`es a forged
 * graph to a healthy parked run reaches this refusal with a graph the run never compiled. Failing
 * the run there would let one bad caller destroy a live run. The engine fails a run only when the
 * graph refused is provably the run's own, by the same two hashes `#assertBound` itself accepts.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId, RunId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { SqliteStateStore } from "../../src/journal/sqlite.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver, SKELETON_TENANT_CAPS } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;
const NOW = 1_700_000_000_000;

const CHANNELS = {
  items: { type: "array", reduce: "replace" },
  item: { type: "object", reduce: "replace" },
  seen: { type: "array", reduce: "append_ordered" },
};

/** `start --fanout(2)--> b0 --join--> J`, the smallest graph holding both a kind and a width. */
function fanSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "advance-refusal", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 64, maxDepth: 2, maxFanout: 16, maxLoopIterations: 1 } },
    channels: CHANNELS,
    inputs: ["items"],
    // DECLARE NOTHING. A declared-but-unwritten output fails the run `E_OUTPUT_MISSING`, which
    // would make every assertion below true for the wrong reason.
    outputs: [],
    nodes: [
      { id: n("start"), type: "function", reads: ["items"], function: { ref: "function/seed@stable" } },
      { id: n("b0"), type: "function", reads: ["item"], writes: ["seen"], function: { ref: "function/work@stable" } },
      {
        id: n("J"),
        type: "join",
        reads: ["seen"],
        writes: ["seen"],
        join: { branches: [n("b0")], mode: "all", onBranchError: "skip" },
      },
    ],
    edges: [
      { id: e("fo"), from: n("start"), to: n("b0"), kind: "fanout", over: "items", as: "item", maxWidth: 2 },
      { id: e("jn0"), from: n("b0"), to: n("J"), kind: "join", branches: [n("b0")] },
    ],
  } as unknown as GraphSpec;
}

/** `start --seq--> hold (a human_gate) --seq--> done`: a run that PARKS rather than finishing. */
function gateSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "advance-refusal-gate", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 64, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
    channels: { ...CHANNELS, note: { type: "array", reduce: "append_ordered" } },
    inputs: ["items"],
    outputs: [],
    nodes: [
      { id: n("start"), type: "function", reads: ["items"], function: { ref: "function/seed@stable" } },
      { id: n("hold"), type: "human_gate", reads: ["items"], humanGate: { ref: "oversight/hold@stable" } },
      { id: n("done"), type: "function", reads: ["items"], writes: ["note"], function: { ref: "function/done@stable" } },
    ],
    edges: [
      { id: e("s0"), from: n("start"), to: n("hold"), kind: "seq" },
      { id: e("s1"), from: n("hold"), to: n("done"), kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

function engineWith(store: SqliteStateStore): Engine {
  const functions = new FunctionRegistry();
  functions.register("function/seed@stable", () => ({}));
  functions.register("function/work@stable", (view) => ({ writes: { seen: [view.get<{ id: string }>("item")?.id ?? "?"] } }));
  functions.register("function/done@stable", () => ({ writes: { note: ["done-ran"] } }));
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);
  return new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models,
    now: () => NOW,
    maxParallelism: 4,
    resolver: resolver(),
    policy: { granted: SKELETON_TENANT_CAPS, budget: { runUsd: 5 } },
  });
}

/**
 * The two vocabulary faults, each applied to a real compile so only that one field differs — and
 * the edge each refusal must name, so the `details` assertion is per case rather than per file.
 */
interface Fault {
  readonly what: string;
  readonly mangle: (g: RunGraph) => RunGraph;
  readonly edge: string;
}
const FAULTS: readonly Fault[] = [
  {
    what: "a maxWidth this build cannot read (the check `0dd0a524` added)",
    mangle: (g) =>
      ({
        ...g,
        spec: { ...g.spec, edges: g.spec.edges.map((x) => (x.kind === "fanout" ? { ...x, maxWidth: "24" } : x)) },
      }) as RunGraph,
    edge: "fo",
  },
  {
    what: "an edge kind this build cannot read (the check three lines above it)",
    mangle: (g) =>
      ({
        ...g,
        spec: { ...g.spec, edges: g.spec.edges.map((x) => (x.kind === "join" ? { ...x, kind: "conditionl" } : x)) },
      }) as RunGraph,
    edge: "jn0",
  },
];

async function typesOf(store: SqliteStateStore, runId: RunId): Promise<JournalEvent[]> {
  const log: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) log.push(ev);
  return log;
}

test("A RUN WHOSE OWN GRAPH THE EXECUTOR CANNOT READ IS FAILED, with the code on the row", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-a63-"));
  try {
    for (const { what, mangle, edge } of FAULTS) {
      const path = join(dir, `${what.slice(0, 12).replace(/\W+/g, "-")}.db`);
      // `submit` records the hash of the graph it is handed, so this run really is bound to a
      // graph nothing can read — the §A.63 shape, not a caller bringing a foreign one.
      const forged = mangle(compileOrThrow({ spec: fanSpec(), resolver: resolver(), tools: {}, tenantCapabilities: [] }));

      const first = new SqliteStateStore({ path, now: () => NOW });
      let runId: RunId;
      try {
        const engine = engineWith(first);
        runId = await engine.submit({ graph: forged, inputs: { items: [{ id: "a" }, { id: "b" }] } });

        await assert.rejects(
          () => engine.advance(runId),
          (thrown: { code?: unknown; class?: unknown }) => {
            assert.equal(thrown.code, "E_GRAPH_INVALID", `${what}: the caller still hears the refusal`);
            assert.equal(thrown.class, "validation", `${what}: unretryable, as before`);
            return true;
          },
          what,
        );

        // THE ROW, not just the status: a fold has to be able to say WHY.
        const p = await engine.projection(runId);
        assert.equal(p?.status, "failed", `${what}: the run is terminal, not left \`running\``);
        const log = await typesOf(first, runId);
        const failures = log.filter((ev) => ev.type === "run.failed");
        assert.equal(failures.length, 1, `${what}: exactly one terminal row`);
        const err = (failures[0] as { payload: { error: { code: string; class: string; details?: unknown } } }).payload.error;
        assert.equal(err.code, "E_GRAPH_INVALID", `${what}: carrying the code`);
        assert.equal(err.class, "validation", `${what}: and the class`);
        // `errorRecord` and not a hand-built literal, so the row names the edge that stopped it.
        assert.deepEqual(
          (err.details as { edges?: { id: string }[] } | undefined)?.edges?.map((x) => x.id),
          [edge],
          `${what}: and the details name the offending edge`,
        );

        // FAILING CLOSED ON A REPEAT, and appending nothing the second time. It is
        // `#failUnreadableGraph`'s OWN `isTerminal` return that suppresses the second row, not
        // the terminal short-circuit inside `advance` — for a run this engine still holds,
        // `#assertBound` throws above that short-circuit and it is never reached.
        await assert.rejects(
          () => engine.advance(runId),
          (thrown: { code?: unknown }) => thrown.code === "E_GRAPH_INVALID",
          `${what}: a second advance on the ATTACHED run still refuses`,
        );
        assert.equal(
          (await typesOf(first, runId)).filter((ev) => ev.type === "run.failed").length,
          1,
          `${what}: and writes no second terminal row`,
        );
      } finally {
        first.close();
      }

      // A FRESH ENGINE OVER THE SAME FILE, holding nothing but the journal, sees the same end.
      const second = new SqliteStateStore({ path, now: () => NOW });
      try {
        const engine = engineWith(second);
        assert.equal((await engine.projection(runId!))?.status, "failed", `${what}: a restart reads the terminal state off the log`);

        // AND A FRESH PROCESS ANSWERS RATHER THAN REFUSING, which is a different answer from the
        // attached one above and is pinned so the asymmetry is on the record. Holding no context,
        // `advance` takes `#advanceSerially`'s retired-run fallback, folds the journal, sees a
        // terminal run and RETURNS it — `#assertBound` is never reached, so the unreadable graph
        // is never looked at. Terminal is terminal, and a run that ended is allowed to say so.
        const answered = await engine.advance(runId!);
        assert.equal(answered.status, "failed", `${what}: a fresh process answers the finished run`);
        assert.equal(
          (await typesOf(second, runId!)).filter((ev) => ev.type === "run.failed").length,
          1,
          `${what}: and still writes no second terminal row`,
        );
      } finally {
        second.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * TWO WAYS TO ARRIVE WITH SOMEBODY ELSE'S BROKEN GRAPH, and the second is the one that cost a
 * round. `RunGraph.graphHash` is a plain field of an object a caller `attach`ed, so a foreign
 * graph can simply WEAR the run's hash. The first cut of `#failUnreadableGraph` compared that
 * field alone, and the forged row below read `status: failed  run.failed rows: 1  gates:
 * ["cancelled"]` — one caller with a broken graph ending a healthy parked run and cancelling the
 * question in somebody's queue. Identity is the pair `#graphIdentityMismatch` owns, hash AND
 * manifest, and `#assertBound` and this door now ask it through the same function.
 */
test("A FOREIGN UNREADABLE GRAPH REFUSES WITHOUT KILLING THE RUN — the ordinary half", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-a63-foreign-"));
  try {
    for (const { what, mangle } of FAULTS) {
      for (const wearsTheRunsHash of [false, true]) {
        const where = `${what}${wearsTheRunsHash ? " (wearing the run's own graphHash)" : ""}`;
        const path = join(dir, `${what.slice(0, 12).replace(/\W+/g, "-")}-${String(wearsTheRunsHash)}.db`);
        const good = compileOrThrow({
          spec: gateSpec(),
          resolver: resolver(),
          tools: {},
          tenantCapabilities: SKELETON_TENANT_CAPS,
        });
        // A DIFFERENT graph, unreadable, and NOT the one this run compiled — the fan graph, so its
        // hash cannot collide with the gate graph's by construction, and on the second pass it is
        // handed the run's hash outright.
        const built = mangle(compileOrThrow({ spec: fanSpec(), resolver: resolver(), tools: {}, tenantCapabilities: [] }));
        const foreign = (wearsTheRunsHash ? { ...built, graphHash: good.graphHash } : built) as RunGraph;

        // ── the process that parks ─────────────────────────────────────────────
        const first = new SqliteStateStore({ path, now: () => NOW });
        let runId: RunId;
        try {
          const engine = engineWith(first);
          runId = await engine.submit({ graph: good, inputs: { items: [{ id: "a" }] } });
          const p = await engine.advance(runId);
          assert.equal(p.status, "awaiting_gate", `${where}: precondition — a healthy parked run`);
        } finally {
          first.close();
        }

        // ── a caller arriving with somebody else's broken graph ────────────────
        const second = new SqliteStateStore({ path, now: () => NOW });
        try {
          const engine = engineWith(second);
          engine.attach(runId, foreign);
          await assert.rejects(
            () => engine.advance(runId),
            (thrown: { code?: unknown }) => thrown.code === "E_GRAPH_INVALID",
            `${where}: the caller is refused`,
          );
          assert.equal(
            (await typesOf(second, runId)).filter((ev) => ev.type === "run.failed").length,
            0,
            `${where}: and the run it did not compile is NOT failed`,
          );
          assert.equal((await engine.projection(runId))?.status, "awaiting_gate", `${where}: still parked`);
        } finally {
          second.close();
        }

        // ── and the run is still advanceable by a process holding the right graph ─
        const third = new SqliteStateStore({ path, now: () => NOW });
        try {
          const engine = engineWith(third);
          engine.attach(runId, good);
          for (const gate of (await engine.openGates(runId)).filter((g) => g.state === "open")) {
            await engine.resolveGate(runId, {
              gateId: gate.gateId,
              decision: { kind: "approve" },
              actor: { kind: "human", subject: "u:alice", via: "console" },
              idempotencyKey: `k-${gate.gateId}`,
            });
          }
          const p = await engine.advance(runId);
          assert.equal(p.status, "succeeded", `${where}: the bad caller cost the run nothing`);
          assert.deepEqual(p.channels["note"], ["done-ran"], `${where}: and the work behind the gate ran`);
        } finally {
          third.close();
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A REFUSAL AT THE ADVANCE DOOR LEAVES A ROW THE FOLD CAN SERVE. (§A.63.)
 *
 * `#assertBound`'s VOCABULARY checks — an edge `kind` outside `EDGE_KINDS`, a `maxWidth` outside
 * `readableFanoutWidth`, (§A.81) a loop `maxIterations` outside `readableLoopBound`, and (§A.85)
 * an expression `#expr` cannot parse on an edge's `when`/`until` or a router case's `when` — all
 * `throw` before anything is appended. The caller got `E_GRAPH_INVALID`; the journal, which is the
 * only authoritative state, held `run.submitted, run.compiled, run.started, task.ready` and
 * nothing about why. A second process attaching later saw a `running` run with no reason and no
 * terminal row. Measured on `dbaa5671`, for both checks that existed then, submit-then-advance on
 * a hand-built `RunGraph`:
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
 * EVERY CHECK OR NONE. `0dd0a524` closed a three-lines-apart asymmetry between the first two;
 * answering some of them and not the others puts it straight back, which is why every case below
 * runs over ALL of `FAULTS` and why the engine keys on the CODE rather than on any one arm.
 *
 * **A CHECK ADDED TO `#assertBound` UNDER `E_GRAPH_INVALID` BELONGS IN `FAULTS`.** §A.81's
 * `maxIterations` check is the third member and was added here in the same lane that added the
 * check, which is the point: the census is what makes "every check" checkable instead of asserted.
 * Measured by disabling that one check in `#assertBound` and re-running this file — the five tests
 * that iterate `FAULTS` all go RED and the sixth, which does not, stays green:
 *
 *     pass 1  fail 5      (guard disabled)
 *     pass 6  fail 0      (guard present)
 *
 * §A.85's expression check is the FOURTH member, and it is THREE rows because the row that owed it
 * said an edge-only check "would be partial": `#expr` is reached from an edge's `when`
 * (`#edgesToTake`), an edge's `until` (`#loopMayContinue`) and a router case's `when`
 * (`#runRouter`), and a census holding one of them passes with the other two unguarded. The router
 * row names a NODE, so a row carries `offender` and `details` are read as `edges` + `nodes`.
 * Measured the same way, the fourth check disabled in `#assertBound`: the same five tests RED.
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
import { CODES, err } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { ToolManifestLite } from "../../src/graph/validate.ts";
import type { EdgeId, NodeId, RunId, Seq } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { SqliteStateStore } from "../../src/journal/sqlite.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import { OPERATOR, rewindWithPlan } from "./operator.ts";
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

/**
 * The money `chargeThenGateSpec` moves, so §A.66's "nothing was compensated" is asserted on the
 * WORLD and not on the journal — `#failRun` dispatches undos before it writes its terminal row.
 */
interface World {
  readonly charges: number[];
  readonly refunds: number[];
}

/** `irreversible` and compensable, which is the whole reason this pair exists — see §A.66 below. */
const PAY_MANIFESTS: Record<string, ToolManifestLite> = {
  "pay.charge": { name: "pay.charge", version: "1.0", capabilities: ["pay"], irreversibility: "irreversible", idempotent: true, compensation: { tool: "pay.refund" } },
  "pay.refund": { name: "pay.refund", version: "1.0", capabilities: ["pay"], irreversibility: "reversible_write", idempotent: true },
};

function engineWith(store: SqliteStateStore, world: World = { charges: [], refunds: [] }): Engine {
  const functions = new FunctionRegistry();
  functions.register("function/seed@stable", () => ({}));
  functions.register("function/work@stable", (view) => ({ writes: { seen: [view.get<{ id: string }>("item")?.id ?? "?"] } }));
  functions.register("function/done@stable", () => ({ writes: { note: ["done-ran"] } }));
  // RETRYABLE, so the task is re-READIED rather than failed — the §A.66 shape below.
  functions.register("function/blip@stable", () => {
    throw err.unavailable(CODES.E_PROVIDER_TRANSPORT, "transient upstream reset");
  });
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);
  const tools = new ToolRegistry();
  tools.register({
    ...PAY_MANIFESTS["pay.charge"],
    description: "Take money.",
    parameters: { type: "object", properties: { row: { type: "number" } }, required: ["row"] },
    // `details` IS WHAT AN UNDO'S ARGUMENTS COME FROM, so the compensation this test asserts
    // nobody dispatched is one that genuinely COULD have been dispatched. Without it the arm
    // §A.37 added would refuse first and the assertion would pass for the wrong reason.
    execute: (args: Record<string, unknown>) => {
      const row = Number(args["row"]);
      world.charges.push(row);
      return { content: "charged", details: { row }, writes: { out: { row } } };
    },
  } as ToolDefinition);
  tools.register({
    ...PAY_MANIFESTS["pay.refund"],
    description: "Give it back.",
    parameters: { type: "object", properties: { row: { type: "number" } }, required: ["row"] },
    execute: (args: Record<string, unknown>) => {
      const row = Number(args["row"]);
      world.refunds.push(row);
      const at = world.charges.indexOf(row);
      if (at >= 0) world.charges.splice(at, 1);
      return { content: "refunded" };
    },
  } as ToolDefinition);
  return new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions,
    models,
    now: () => NOW,
    maxParallelism: 4,
    resolver: resolver(),
    policy: { granted: [...SKELETON_TENANT_CAPS, "pay"], budget: { runUsd: 5 } },
  });
}

/** `blip --seq--> done`, where `blip` throws retryably: a run parked in its own backoff. */
function retryingSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "advance-refusal-retry", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 64, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
    channels: { ...CHANNELS, note: { type: "array", reduce: "append_ordered" } },
    inputs: ["items"],
    outputs: [],
    nodes: [
      // A BACKOFF LONGER THAN THE TEST, so `advance` returns with the task in `ready` and stays
      // there. `sleep` is not stubbed here, so this must not be a number the run can outlast.
      { id: n("blip"), type: "function", reads: ["items"], function: { ref: "function/blip@stable" }, retry: { maxAttempts: 3, backoff: "fixed", initialMs: 600_000 } },
      { id: n("done"), type: "function", reads: ["items"], writes: ["note"], function: { ref: "function/done@stable" } },
    ],
    edges: [{ id: e("b0"), from: n("blip"), to: n("done"), kind: "seq" }],
  } as unknown as GraphSpec;
}

/** `charge (a tool) --seq--> hold (a human_gate) --seq--> done`: parked, with money standing. */
function chargeThenGateSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "advance-refusal-charge-gate", project: "probe", version: 1 },
    policy: { posture: "out", capabilities: ["pay"], expansion: { maxNodes: 64, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
    channels: { ...CHANNELS, note: { type: "array", reduce: "append_ordered" }, out: { type: "object", reduce: "replace" } },
    inputs: ["items"],
    outputs: [],
    nodes: [
      { id: n("charge"), type: "tool", reads: ["items"], writes: ["out"], tool: { name: "pay.charge", version: "1.0", args: { row: 42 } }, retry: { maxAttempts: 1 } },
      { id: n("hold"), type: "human_gate", reads: ["items"], humanGate: { ref: "oversight/hold@stable" } },
      { id: n("done"), type: "function", reads: ["items"], writes: ["note"], function: { ref: "function/done@stable" } },
    ],
    edges: [
      { id: e("c0"), from: n("charge"), to: n("hold"), kind: "seq" },
      { id: e("s1"), from: n("hold"), to: n("done"), kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

/**
 * The two vocabulary faults, each applied to a real compile so only that one field differs — and
 * the edge each refusal must name, so the `details` assertion is per case rather than per file.
 */
interface Fault {
  readonly what: string;
  readonly mangle: (g: RunGraph) => RunGraph;
  /** The edge id — or, for §A.85's router row, the NODE id — the refusal's `details` must name. */
  readonly offender: string;
}

/** The ids a refusal's `details` name: `edges` for the first three checks, `edges` + `nodes` for §A.85's. */
function offendersOf(details: unknown): string[] {
  const d = (details ?? {}) as { edges?: { id: string }[]; nodes?: { id: string }[] };
  return [...(d.edges ?? []).map((x) => x.id), ...(d.nodes ?? []).map((x) => x.id)];
}
const FAULTS: readonly Fault[] = [
  {
    what: "a maxWidth this build cannot read (the check `0dd0a524` added)",
    mangle: (g) =>
      ({
        ...g,
        spec: { ...g.spec, edges: g.spec.edges.map((x) => (x.kind === "fanout" ? { ...x, maxWidth: "24" } : x)) },
      }) as RunGraph,
    offender: "fo",
  },
  {
    what: "an edge kind this build cannot read (the check three lines above it)",
    mangle: (g) =>
      ({
        ...g,
        spec: { ...g.spec, edges: g.spec.edges.map((x) => (x.kind === "join" ? { ...x, kind: "conditionl" } : x)) },
      }) as RunGraph,
    offender: "jn0",
  },
  {
    // §A.81. `#assertBound` grew a THIRD vocabulary check and this census is what stops the
    // asymmetry `0dd0a524` closed from coming back one edge kind over: `#loopMayContinue` met the
    // raw `maxIterations`, `{}` made its comparison `NaN`, and the loop stopped after one pass
    // with the run reporting `succeeded`. The fault ADDS the loop edge rather than bending an
    // existing one, because `fanSpec` has no cycle and the point is the value, not the topology —
    // and `submit` records the hash of the graph it is handed, so this run really is bound to a
    // graph nothing can read, which is the §A.63 shape every test below needs.
    what: "a loop maxIterations this build cannot read (the check §A.81 added)",
    mangle: (g) =>
      ({
        ...g,
        spec: {
          ...g.spec,
          edges: [
            ...g.spec.edges,
            { id: e("lp"), from: n("b0"), to: n("b0"), kind: "loop", until: "len(seen) >= 2", maxIterations: {} },
          ],
        },
      }) as unknown as RunGraph,
    offender: "lp",
  },
  // §A.85 — the FOURTH check, one row per reader of `#expr`. Each ADDS the edge (and, for the
  // router, the node) carrying the bent expression, for the reason the loop row gives: `fanSpec`
  // has none of the three, and the point is the value. `[null]` is the value the row measured; the
  // `until` is a STRING `parseExpr` rejects, so "readable" is pinned as PARSES and not as "is a
  // string"; the router's is `{}`.
  {
    what: "a conditional edge's when this build cannot parse (the check §A.85 added)",
    mangle: (g) =>
      ({
        ...g,
        spec: { ...g.spec, edges: [...g.spec.edges, { id: e("cw"), from: n("b0"), to: n("J"), kind: "conditional", when: [null] }] },
      }) as unknown as RunGraph,
    offender: "cw",
  },
  {
    what: "a loop edge's until this build cannot parse (the check §A.85 added)",
    mangle: (g) =>
      ({
        ...g,
        spec: {
          ...g.spec,
          edges: [...g.spec.edges, { id: e("lu"), from: n("b0"), to: n("b0"), kind: "loop", until: "len(seen) >=", maxIterations: 2 }],
        },
      }) as unknown as RunGraph,
    offender: "lu",
  },
  {
    what: "a router case's when this build cannot parse (the check §A.85 added)",
    mangle: (g) =>
      ({
        ...g,
        spec: {
          ...g.spec,
          nodes: [
            ...g.spec.nodes,
            { id: n("R"), type: "router", reads: ["items"], router: { cases: [{ when: {}, take: [e("rt")] }], fallbackEdge: e("rt") } },
          ],
          edges: [
            ...g.spec.edges,
            { id: e("sr"), from: n("start"), to: n("R"), kind: "seq" },
            { id: e("rt"), from: n("R"), to: n("J"), kind: "conditional" },
          ],
        },
      }) as unknown as RunGraph,
    offender: "R",
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
    for (const { what, mangle, offender } of FAULTS) {
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
        assert.deepEqual(offendersOf(err.details), [offender], `${what}: and the details name the offending edge or node`);

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

/**
 * THE ATTACK, IN ONE PLACE: read `run.compiled`, wear its identity, bend one edge, advance.
 *
 * `graphHash` AND `resolutionManifest` are plain payload fields of a row any reader can see, and
 * `RunGraph` is an exported interface whose fields a caller sets — so `#graphIdentityMismatch`
 * answers `undefined` for a graph the run has never seen. Asserts that the forgery really is
 * wearing the run's own identity, so a test cannot pass because the forgery failed to build.
 */
async function forgedAdvanceLeavesItAlone(
  path: string,
  runId: RunId,
  real: RunGraph,
  mangle: (g: RunGraph) => RunGraph,
  what: string,
  expected: string,
): Promise<void> {
  // A SECOND PROCESS, exactly as the attack is: nothing survives but the file. The caller never
  // holds the run's `RunContext`, its graph or its registries.
  const store = new SqliteStateStore({ path, now: () => NOW });
  try {
    const compiled = (await typesOf(store, runId)).find((ev) => ev.type === "run.compiled")!;
    const identity = compiled.payload as unknown as { graphHash: string; resolutionManifest: unknown };
    const built = mangle(compileOrThrow({ spec: fanSpec(), resolver: resolver(), tools: {}, tenantCapabilities: [] }));
    const forged = { ...built, graphHash: identity.graphHash, resolutionManifest: identity.resolutionManifest } as RunGraph;
    assert.equal(forged.graphHash, real.graphHash, `${what}: the caller really is wearing the run's own identity`);

    const engine = engineWith(store);
    engine.attach(runId, forged);
    await assert.rejects(
      () => engine.advance(runId),
      (thrown: { code?: unknown }) => thrown.code === "E_GRAPH_INVALID",
      `${what}: the caller is refused`,
    );
    assert.equal(
      (await typesOf(store, runId)).filter((ev) => ev.type === "run.failed").length,
      0,
      `${what}: and the run is not failed`,
    );
    assert.equal((await engine.projection(runId))?.status, expected, `${what}: it is exactly where it was`);
  } finally {
    store.close();
  }
}

/**
 * A SYNTHESISED IDENTITY IS NOT "THIS RUN'S OWN GRAPH". (§A.66.)
 *
 * The test above hands the door a foreign graph and the identity check refuses to fail the run.
 * §A.66 is what happens when the caller does not bring a foreign identity — they READ the run's
 * own out of the journal. `run.compiled` carries `graphHash` AND `resolutionManifest`, both
 * plain payload fields of a row any reader can see, and `RunGraph` is an exported interface whose
 * fields a caller sets. So the pair copies onto any graph at all, `#graphIdentityMismatch`
 * returns `undefined`, and through `2b1698e8` a run was FAILED on a graph it never compiled.
 *
 * Measured there, on the parked `human_gate` run this test builds, driven by the script in
 * `docs/handoff-2026-09-15.md` §Repros:
 *
 *     parked: awaiting_gate
 *     threw: E_GRAPH_INVALID status: failed run.failed rows: 1 gates: ["cancelled"]
 *     actor: {"component":"executor","kind":"system"}
 *
 * IT IS STRICTLY MORE THAN `cancel`, WHICH IS WHY THIS TEST CARRIES A TOOL. `#failRun` runs
 * `#compensate` BEFORE the terminal row while `#cancelTree` compensates nothing, so the forged
 * path could dispatch every undo the run had recorded — real money, on a graph the caller never
 * saw. The gate graph below therefore charges before it parks, with `pay.refund` registered and
 * a world the test reads: "nothing was compensated" is asserted on the MONEY and not on the
 * journal. And the row landed from `SYSTEM_ACTOR("executor")` carrying `E_GRAPH_INVALID`, where
 * a cancel writes `operator.command` attributed to its caller — so an auditor could not tell a
 * caller's deliberate destruction from a build that genuinely could not read the graph.
 *
 * WHAT CLOSES IT IS PROGRESS, NOT A BETTER IDENTITY. `#assertBound` runs first on `advance` and
 * on both gate doors, so a run bound to an unreadable graph is refused at its first advance and
 * can never lease a task or open a gate — every genuine §A.63 run has executed NOTHING, which is
 * that row's own pasted journal (`run.submitted, run.compiled, run.started, task.ready`). The
 * run here has charged and parked. The two tests are the two halves of that one sentence, which
 * is why they live in one file: the first still reads `failed / 1`, this one reads
 * `awaiting_gate / 0 / ["open"]`.
 */
test("A SYNTHESISED IDENTITY REFUSES THE ADVANCE AND LEAVES THE RUN WHERE IT WAS", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-a66-"));
  try {
    for (const { what, mangle } of FAULTS) {
      const path = join(dir, `${what.slice(0, 12).replace(/\W+/g, "-")}.db`);
      const world: World = { charges: [], refunds: [] };
      const good = compileOrThrow({
        spec: chargeThenGateSpec(),
        resolver: resolver(),
        tools: PAY_MANIFESTS,
        tenantCapabilities: [...SKELETON_TENANT_CAPS, "pay"],
      });

      // ── the process that charges and parks ─────────────────────────────────
      const first = new SqliteStateStore({ path, now: () => NOW });
      let runId: RunId;
      try {
        const engine = engineWith(first, world);
        runId = await engine.submit({ graph: good, inputs: { items: [{ id: "a" }] } });
        let p = await engine.advance(runId);
        // The charge is `irreversible`, so it suspends on its own gate first; approving it is
        // what makes the money real, which is what the compensation assertion below is about.
        for (let i = 0; i < 6 && p.status === "awaiting_gate" && world.charges.length === 0; i++) {
          const open = Object.values(p.gates).find((g) => g.state === "open" && g.nodeId === n("charge"));
          if (open === undefined) break;
          await engine.resolveGate(runId, {
            gateId: open.gateId,
            decision: { kind: "approve" },
            actor: { kind: "human", subject: "u:alice", via: "console" },
            idempotencyKey: `k-${open.gateId}`,
          });
          p = await engine.advance(runId);
        }
        assert.equal(p.status, "awaiting_gate", `${what}: precondition — a parked run`);
        assert.deepEqual(world.charges, [42], `${what}: precondition — with an undoable effect standing`);
        assert.deepEqual(world.refunds, [], `${what}: and nothing has undone it`);
      } finally {
        first.close();
      }

      // ── a caller holding the runId and READ access, and nothing else ───────
      const second = new SqliteStateStore({ path, now: () => NOW });
      try {
        // THE WHOLE ATTACK, and it reads one row. `graphHash` and `resolutionManifest` are copied
        // off `run.compiled` onto a graph this run has never seen, with one edge kind bent.
        const compiled = (await typesOf(second, runId)).find((ev) => ev.type === "run.compiled")!;
        const identity = compiled.payload as unknown as { graphHash: string; resolutionManifest: unknown };
        const built = mangle(compileOrThrow({ spec: fanSpec(), resolver: resolver(), tools: {}, tenantCapabilities: [] }));
        const forged = { ...built, graphHash: identity.graphHash, resolutionManifest: identity.resolutionManifest } as RunGraph;
        assert.equal(forged.graphHash, good.graphHash, `${what}: the caller really is wearing the run's own identity`);

        const engine = engineWith(second, world);
        engine.attach(runId, forged);
        await assert.rejects(
          () => engine.advance(runId),
          (thrown: { code?: unknown }) => thrown.code === "E_GRAPH_INVALID",
          `${what}: the caller is refused`,
        );

        // AND THE RUN IS EXACTLY WHERE IT WAS — every fact the forged path used to change.
        //
        // THE MONEY FIRST, WHICH IS THE HALF A JOURNAL ASSERTION WOULD MISS AND THE HALF THAT
        // CANNOT BE PUT BACK. `#failRun` compensates BEFORE it writes the terminal row, so on
        // `2b1698e8` the forged advance dispatched `pay.refund` for real: re-run there with this
        // order, `refunds` reads `[42]` and `charges` reads `[]` — one caller with journal read
        // access moving somebody else's money on a graph they never saw.
        assert.deepEqual(world.refunds, [], `${what}: NO compensation was dispatched`);
        assert.deepEqual(world.charges, [42], `${what}: so the charge stands, untouched`);
        assert.equal(
          (await typesOf(second, runId)).filter((ev) => ev.type === "compensation.recorded").length,
          0,
          `${what}: and nothing even tried`,
        );
        assert.equal(
          (await typesOf(second, runId)).filter((ev) => ev.type === "run.failed").length,
          0,
          `${what}: no terminal row`,
        );
        const after = await engine.projection(runId);
        assert.equal(after?.status, "awaiting_gate", `${what}: still parked`);
        // TWO GATES: the charge's, APPROVED on the way in, and the `hold` the run is parked on.
        // The forged advance used to cancel the second — the question in somebody's queue.
        assert.deepEqual(
          Object.values(after!.gates).map((g) => g.state).sort(),
          ["decided", "open"],
          `${what}: the question in somebody's queue is still open, not cancelled`,
        );
      } finally {
        second.close();
      }

      // ── and the operator holding the real graph still drives it home ───────
      const third = new SqliteStateStore({ path, now: () => NOW });
      try {
        const engine = engineWith(third, world);
        engine.attach(runId, good);
        for (const gate of (await engine.openGates(runId)).filter((g) => g.state === "open")) {
          await engine.resolveGate(runId, {
            gateId: gate.gateId,
            decision: { kind: "approve" },
            actor: { kind: "human", subject: "u:alice", via: "console" },
            idempotencyKey: `k2-${gate.gateId}`,
          });
        }
        const p = await engine.advance(runId);
        assert.equal(p.status, "succeeded", `${what}: the forged advance cost the run nothing`);
        assert.deepEqual(p.channels["note"], ["done-ran"], `${what}: and the work behind the gate ran`);
        assert.deepEqual(world.refunds, [], `${what}: with the charge never undone`);
      } finally {
        third.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * TWO STATES A FOLD CALLS UNEXECUTED AND A JOURNAL DOES NOT. (§A.66, second cut.)
 *
 * The first cut of the conjunct above asked the PROJECTION — "no gate exists and every task is
 * `pending` or `ready`". A reviewer drove two ordinary mechanisms that erase exactly that
 * evidence, and the forged advance ended the run again in both. They are here because the bug was
 * never in the idea; it was in reading a fold for a monotone question.
 *
 * (1) A RETRYABLE FAILURE RE-READIES THE TASK. `task.retry_scheduled` + `task.ready` fold the task
 *     back to `ready` (`run/projection.ts`), so a run that had leased a task and run a body read
 *     `tasks: [["blip","ready"]]  gates: []`. Measured on `29e6579a`, on the money version of this
 *     shape: `run.failed rows: 1  compensation.recorded rows: 1  charges: []  refunds: [10]` — the
 *     forged path took the money back. The window is up to `RETRY_AFTER_CEILING_MS` per deferral.
 *
 * (2) A REWIND SUPPRESSES THE RANGE. An ordinary operator rewinding their own parked run leaves a
 *     journal that folds to `tasks: []  gates: []` — `.some()` over nothing is false — and the
 *     same forged advance read `status: failed  run.failed rows: 1` on `29e6579a`.
 *
 * Both now read `run.failed rows: 0`, because the predicate reads `#store.read` — the unsuppressed
 * log — and asks whether anything outside `submit`'s own four-name prefix was ever appended. That
 * is monotone: a retry ADDS `task.retry_scheduled`, and a rewind hides what a run DID without
 * unmaking the fact that a readable graph did it.
 */
test("A FOLD THAT FORGETS IS NOT A RUN THAT NEVER RAN — the retry window and the rewound run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-a66-fold-"));
  try {
    for (const { what, mangle } of FAULTS) {
      // ── (1) parked in its own retry backoff ────────────────────────────────
      const retryPath = join(dir, `retry-${what.slice(0, 12).replace(/\W+/g, "-")}.db`);
      let retryRun: RunId;
      const retryStore = new SqliteStateStore({ path: retryPath, now: () => NOW });
      const retryGraph = compileOrThrow({ spec: retryingSpec(), resolver: resolver(), tools: {}, tenantCapabilities: SKELETON_TENANT_CAPS });
      try {
        const engine = engineWith(retryStore);
        retryRun = await engine.submit({ graph: retryGraph, inputs: { items: [{ id: "a" }] } });
        const p = await engine.advance(retryRun);
        assert.equal(p.status, "running", `${what}: precondition — the run is mid-flight`);
        assert.deepEqual(
          Object.values(p.tasks).map((t) => t.state),
          ["ready"],
          `${what}: precondition — and the FOLD calls its one task \`ready\`, which is what the first cut read`,
        );
        assert.deepEqual(Object.keys(p.gates), [], `${what}: with no gate to give it away either`);
      } finally {
        retryStore.close();
      }
      await forgedAdvanceLeavesItAlone(retryPath, retryRun!, retryGraph, mangle, what, "running");

      // ── (2) rewound by its own operator ───────────────────────────────────
      const rewoundPath = join(dir, `rewound-${what.slice(0, 12).replace(/\W+/g, "-")}.db`);
      let rewoundRun: RunId;
      const rewoundStore = new SqliteStateStore({ path: rewoundPath, now: () => NOW });
      const rewoundGraph = compileOrThrow({ spec: gateSpec(), resolver: resolver(), tools: {}, tenantCapabilities: SKELETON_TENANT_CAPS });
      try {
        const engine = engineWith(rewoundStore);
        rewoundRun = await engine.submit({ graph: rewoundGraph, inputs: { items: [{ id: "a" }] } });
        assert.equal((await engine.advance(rewoundRun)).status, "awaiting_gate", `${what}: precondition — parked`);
        await rewindWithPlan(engine, rewoundRun, 3 as Seq, "re-run it from the top", OPERATOR);
        const p = (await engine.projection(rewoundRun))!;
        assert.deepEqual(Object.keys(p.tasks), [], `${what}: precondition — the rewind suppressed every task record`);
        assert.deepEqual(Object.keys(p.gates), [], `${what}: and the gate with them`);
      } finally {
        rewoundStore.close();
      }
      await forgedAdvanceLeavesItAlone(rewoundPath, rewoundRun!, rewoundGraph, mangle, what, "running");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A PAUSE IS NOT A RUN THAT RAN, AND A REFUSAL IS NOT A RUN THAT DID NOT. (§A.66, third cut.)
 *
 * The second cut asked whether anything outside `submit`'s four names had ever been appended. That
 * reads OPERATOR rows as execution, and `pause`/`resume` are exactly that: `#intervene` appends
 * `operator.command` + `run.suspended`/`run.resumed` and runs no node code at all — `pause`'s own
 * docstring says "NO GRAPH REQUIRED". So an operator who paused a run before its first advance
 * bought it immunity from §A.63. Measured on `7e84e7c0`, `fanSpec` with the `conditionl` fault:
 *
 *     control (never advanced)   threw E_GRAPH_INVALID  status: failed       run.failed rows: 1
 *     paused before first advance threw E_GRAPH_INVALID  status: interrupted  run.failed rows: 0
 *     paused and resumed          threw E_GRAPH_INVALID  status: running      run.failed rows: 0
 *
 * WIDENING THE PREFIX WOULD HAVE BEEN THE TRAP, which is why the predicate was turned around
 * instead: a REWOUND run's evidence is `operator.command` + `checkpoint.restored`, and the test
 * above needs that to read as EXECUTED. The question is now asked as an allowlist — name a row
 * only an executing run appends — and the answer is `task.leased`, with `gate.raised` carried
 * beside it because a missing member costs a live run while a spare one costs only a refusal.
 *
 * THE FOURTH CASE IS THE CONTROL FOR THE OTHER DIRECTION: a run that EXECUTED and was then paused
 * must still be refused, or the fix would have swapped one hole for another.
 */
test("A PAUSED RUN IS STILL FAILED IF ITS OWN GRAPH IS UNREADABLE, AND STILL SPARED IF IT RAN", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-a66-pause-"));
  try {
    for (const { what, mangle, offender } of FAULTS) {
      // ── (1) the three §A.63 shapes: nothing has ever executed, so all three FAIL ──────────
      for (const how of ["control", "paused", "paused-and-resumed"] as const) {
        const path = join(dir, `${how}-${what.slice(0, 10).replace(/\W+/g, "-")}.db`);
        const store = new SqliteStateStore({ path, now: () => NOW });
        try {
          const engine = engineWith(store);
          // `submit` records the hash of the graph it is handed, so this run really is bound to a
          // graph nothing can read — §A.63's own shape, reached three ways.
          const forged = mangle(compileOrThrow({ spec: fanSpec(), resolver: resolver(), tools: {}, tenantCapabilities: [] }));
          const runId = await engine.submit({ graph: forged, inputs: { items: [{ id: "a" }, { id: "b" }] } });
          if (how !== "control") await engine.pause(runId);
          if (how === "paused-and-resumed") await engine.resume(runId);

          // THE PRECONDITION THAT MAKES THIS A TEST OF THE PREDICATE: the operator rows are on the
          // log and NO lease is, which is exactly the state the second cut misread.
          const before = (await typesOf(store, runId)).map((ev) => ev.type);
          assert.equal(before.includes("task.leased"), false, `${what}/${how}: precondition — nothing has ever been leased`);
          assert.equal(before.includes("operator.command"), how !== "control", `${what}/${how}: precondition — the operator rows are or are not there`);

          await assert.rejects(
            () => engine.advance(runId),
            (thrown: { code?: unknown }) => thrown.code === "E_GRAPH_INVALID",
            `${what}/${how}: the caller still hears the refusal`,
          );
          const failures = (await typesOf(store, runId)).filter((ev) => ev.type === "run.failed");
          assert.equal(failures.length, 1, `${what}/${how}: and a run that can never progress is FAILED, pause or no pause`);
          const err = (failures[0] as { payload: { error: { code: string; details?: unknown } } }).payload.error;
          assert.equal(err.code, "E_GRAPH_INVALID", `${what}/${how}: carrying the code`);
          assert.deepEqual(offendersOf(err.details), [offender], `${what}/${how}: and the edge or node that stopped it`);
        } finally {
          store.close();
        }
      }

      // ── (2) the other direction: a run that EXECUTED and was then paused is still spared ──
      const ranPath = join(dir, `ran-then-paused-${what.slice(0, 10).replace(/\W+/g, "-")}.db`);
      let ranRun: RunId;
      const ranGraph = compileOrThrow({ spec: gateSpec(), resolver: resolver(), tools: {}, tenantCapabilities: SKELETON_TENANT_CAPS });
      const ranStore = new SqliteStateStore({ path: ranPath, now: () => NOW });
      try {
        const engine = engineWith(ranStore);
        ranRun = await engine.submit({ graph: ranGraph, inputs: { items: [{ id: "a" }] } });
        assert.equal((await engine.advance(ranRun)).status, "awaiting_gate", `${what}: precondition — it ran and parked`);
        await engine.pause(ranRun);
        assert.equal(
          (await typesOf(ranStore, ranRun)).some((ev) => ev.type === "task.leased"),
          true,
          `${what}: precondition — and the lease that proves it is on the log`,
        );
      } finally {
        ranStore.close();
      }
      await forgedAdvanceLeavesItAlone(ranPath, ranRun!, ranGraph, mangle, `${what} (ran, then paused)`, "interrupted");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * AND A PAUSE COSTS THE HONEST OPERATOR NOTHING. The row the review asked for by name.
 *
 * Every assertion above is about a run being FAILED or REFUSED, so on their own they would all
 * still pass if `pause` had quietly broken `resume`. This is the ordinary half: pause a healthy
 * run before its first advance, resume it, hand it its own graph, and it runs to the end.
 */
test("A RUN PAUSED BEFORE ITS FIRST ADVANCE STILL ADVANCES AFTER A RESUME", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-a66-pause-ok-"));
  const store = new SqliteStateStore({ path: join(dir, "run.db"), now: () => NOW });
  try {
    const engine = engineWith(store);
    const good = compileOrThrow({ spec: gateSpec(), resolver: resolver(), tools: {}, tenantCapabilities: SKELETON_TENANT_CAPS });
    const runId = await engine.submit({ graph: good, inputs: { items: [{ id: "a" }] } });

    await engine.pause(runId);
    assert.equal((await engine.projection(runId))?.status, "interrupted", "paused before it ever ran");
    await engine.resume(runId);

    const parked = await engine.advance(runId);
    assert.equal(parked.status, "awaiting_gate", "and it advances to its gate as if nothing had happened");
    for (const gate of (await engine.openGates(runId)).filter((g) => g.state === "open")) {
      await engine.resolveGate(runId, {
        gateId: gate.gateId,
        decision: { kind: "approve" },
        actor: { kind: "human", subject: "u:alice", via: "console" },
        idempotencyKey: `k-${gate.gateId}`,
      });
    }
    const done = await engine.advance(runId);
    assert.equal(done.status, "succeeded", "and runs to the end");
    assert.deepEqual(done.channels["note"], ["done-ran"], "with the work behind the gate done");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

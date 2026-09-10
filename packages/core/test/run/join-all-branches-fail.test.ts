/**
 * A BARRIER MUST DISTINGUISH "NOT YET" FROM "NEVER", IN ALL FOUR MODES.
 *
 * THIS FILE CLOSES ONE OF §A.55's TWO HALVES AND PINS THE OTHER OPEN. Closed: a join in mode
 * `any` or `firstSuccess` whose members all terminate without succeeding now RELEASES rather
 * than waiting for an arrival that cannot come — in all four modes, with and without a second
 * entrance, at every parallelism, and across a restart. **Not closed**: whether a fold with zero
 * contributions may report `succeeded`. That question binds `all` and `quorum` exactly as much
 * as `any` — all four release the same empty fold today — it is a semantics decision left to the
 * maintainer, and the last test in this file asserts today's answer so that whoever settles it
 * has a failing test to flip rather than a behaviour to discover.
 *
 * `#maybeFireJoin`'s `any` and `firstSuccess` arms were `succeeded >= 1` and nothing else — a
 * predicate with no false branch that terminates. Once every member of the barrier is terminal
 * and none succeeded, it is permanently false: the barrier never mints its Task, everything
 * behind the join never runs, and `#finish` still calls the run **`succeeded`**, because nothing
 * is left in a live state to object to. `onBranchError: "skip"` does not help; it is what makes
 * the branches terminal in the first place.
 *
 * Measured on the unfixed engine, on `allFailSpec` below — `start -fanout(2)-> b0 -join-> J
 * -seq-> done` over a body that always throws:
 *
 *     mode=any           status=succeeded  Jready=0 done=0     <- the barrier never released
 *     mode=firstSuccess  status=succeeded  Jready=0 done=0     <- and the run said it worked
 *     mode=all           status=succeeded  Jready=1 done=1
 *     mode=quorum        status=succeeded  Jready=1 done=1
 *
 * `outputs: []` IS LOAD-BEARING and not incidental: declare an output nothing writes and the run
 * dies `E_OUTPUT_MISSING` and reports `failed`, so the "says it worked" half only shows where
 * every declared output is written, or none is declared.
 *
 * THE FIX RELEASES RATHER THAN FAILING, and the two `onBranchError` values are both in the sweep
 * because that is what the choice rests on. `#maybeFireJoin` decides WHEN a barrier releases;
 * `#foldJoin` decides what the release MEANS, and it already holds the failure arm —
 * `onBranchError === "fail" && skipped > 0` returns `E_QUORUM_UNREACHABLE`. So the barrier
 * releases on quiescence in every mode, and the operator's own `onBranchError` decides whether an
 * empty fold is a failure. Under `"fail"` the run ended `failed` before this fix too — but for
 * the ORPHAN BRANCH, with `Jready=0`: the barrier had still not resolved, and the code naming the
 * reason was never raised. That is why this file asserts the join's own error code and not just
 * the run's status.
 *
 * THE SHORT-CIRCUIT CONTROL is the other side, and a fix without it would pass everything above:
 * gating the whole decision on quiescence collapses `any` and `firstSuccess` into `all` — they
 * would release at exactly the same point, which is the defect the comment above the predicate
 * was written to prevent. `firstWinsSpec` fans out four branches that all SUCCEED at
 * `maxParallelism: 1`, where `any` must fold the first arrival alone and `all` must fold four.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { SqliteStateStore } from "../../src/journal/sqlite.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver, SKELETON_TENANT_CAPS } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;
const NOW = 1_700_000_000_000;
const MODES = ["any", "firstSuccess", "all", "quorum"] as const;

const CHANNELS = {
  items: { type: "array", reduce: "replace" },
  item: { type: "object", reduce: "replace" },
  seen: { type: "array", reduce: "append_ordered" },
  note: { type: "array", reduce: "append_ordered" },
};

/**
 * `start --fanout(width)--> b0 --join--> J --seq--> done`, with an optional second, ORDINARY
 * path into the barrier — the fourth entrance `join-seq-entrance.test.ts` covers, here because a
 * barrier that resolves on quiescence must resolve the same way whether or not one exists.
 *
 * `quorum` carries `k: 0.5`; every other mode leaves `k` unset.
 */
function fanSpec(opts: {
  readonly mode: string;
  readonly onBranchError: string;
  readonly body: string;
  readonly width: number;
  readonly secondPath: boolean;
}): GraphSpec {
  const nodes: unknown[] = [
    { id: n("start"), type: "function", reads: ["items"], function: { ref: "function/seed@stable" } },
    { id: n("b0"), type: "function", reads: ["item"], writes: ["seen"], function: { ref: opts.body } },
    {
      id: n("J"),
      type: "join",
      reads: ["seen"],
      writes: ["seen"],
      join: {
        branches: [n("b0")],
        mode: opts.mode,
        onBranchError: opts.onBranchError,
        ...(opts.mode === "quorum" ? { k: 0.5 } : {}),
      },
    },
    { id: n("done"), type: "function", reads: ["seen"], writes: ["note"], function: { ref: "function/done@stable" } },
  ];
  const edges: unknown[] = [
    { id: e("fo"), from: n("start"), to: n("b0"), kind: "fanout", over: "items", as: "item", maxWidth: opts.width },
    { id: e("jn0"), from: n("b0"), to: n("J"), kind: "join", branches: [n("b0")] },
    { id: e("sq"), from: n("J"), to: n("done"), kind: "seq" },
  ];
  if (opts.secondPath) {
    nodes.push({ id: n("note0"), type: "function", reads: ["items"], function: { ref: "function/note@stable" } });
    edges.push({ id: e("ns0"), from: n("start"), to: n("note0"), kind: "seq" });
    edges.push({ id: e("ns1"), from: n("note0"), to: n("J"), kind: "seq" });
  }
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "join-all-branches-fail", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 64, maxDepth: 2, maxFanout: 16, maxLoopIterations: 1 } },
    channels: CHANNELS,
    inputs: ["items"],
    // DECLARE NOTHING. A declared-but-unwritten output fails the run `E_OUTPUT_MISSING`, which
    // would hide the half of the defect that says the run succeeded.
    outputs: [],
    nodes,
    edges,
  } as unknown as GraphSpec;
}

interface Result {
  readonly status: string;
  readonly seen: readonly string[];
  readonly note: unknown;
  readonly joinReady: number;
  readonly doneCommitted: number;
  /** The error code on the join's own `task.committed`, when it failed. */
  readonly joinError: string | undefined;
  /**
   * Branch commits that appear in the journal BEFORE the barrier's `task.ready` — WHEN the
   * barrier released, read off the log rather than off the fold. The fold cannot answer it:
   * `#foldJoin` runs when the join's Task executes and reads the projection as it stands then,
   * so an early mint still folds every member that committed in the meantime.
   */
  readonly branchesBeforeJoinReady: number;
  /**
   * The join's own `state.reduced` payload — what the FOLD saw, which is the only thing that
   * separates "folded zero contributions" from "never ran at all". An earlier draft asserted
   * `seen` deep-equals `[]`, which passes on an ABSENT channel: `p.channels["seen"]` is
   * `undefined` when the barrier never released, so the assertion was true in both worlds.
   */
  readonly fold: { branchCount?: number; skipped?: number; degraded?: boolean } | undefined;
}

async function run(spec: GraphSpec, items: readonly unknown[], maxParallelism: number): Promise<Result> {
  const store = new MemoryStateStore({ now: () => NOW });
  const functions = new FunctionRegistry();
  functions.register("function/seed@stable", () => ({}));
  functions.register("function/note@stable", () => ({}));
  functions.register("function/boom@stable", () => {
    throw new Error("boom");
  });
  functions.register("function/work@stable", (view) => {
    const item = view.get<{ id: string }>("item");
    return { writes: { seen: [item?.id ?? "?"] } };
  });
  functions.register("function/done@stable", () => ({ writes: { note: ["done-ran"] } }));

  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models,
    now: () => NOW,
    maxParallelism,
    policy: { granted: [], budget: { runUsd: 1 } },
  });

  const graph = compileOrThrow({ spec, resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { items } });
  const p = await engine.advance(runId);

  // NO SECOND ENGINE HERE, deliberately. An earlier draft attached one at this point and claimed
  // it proved the barrier's verdict is recomputed from rows — it proved nothing: the run is
  // already TERMINAL by now, so the second Engine appends zero events and re-folds a finished
  // journal. The restart property is real and it is driven where a restart can still change the
  // outcome, in "THE BARRIER RELEASES FROM THE JOURNAL ALONE" below.
  const log: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) log.push(ev);
  const joinFailure = log.find(
    (ev) => ev.type === "task.failed" && String(ev.taskId).startsWith("J@"),
  ) as { payload?: { error?: { code?: string } } } | undefined;
  const readyAt = log.findIndex((ev) => ev.type === "task.ready" && String(ev.taskId).startsWith("J@"));
  const reduced = log.find((ev) => ev.type === "state.reduced" && String(ev.taskId).startsWith("J@")) as
    | { payload?: { branchCount?: number; skipped?: number; degraded?: boolean } }
    | undefined;
  return {
    status: p.status,
    seen: (p.channels["seen"] as string[]) ?? [],
    note: p.channels["note"],
    joinReady: log.filter((ev) => ev.type === "task.ready" && String(ev.taskId).startsWith("J@")).length,
    doneCommitted: log.filter((ev) => ev.type === "task.committed" && String(ev.taskId).startsWith("done@")).length,
    joinError: joinFailure?.payload?.error?.code,
    branchesBeforeJoinReady:
      readyAt < 0
        ? -1
        : log
            .slice(0, readyAt)
            .filter((ev) => ev.type === "task.committed" && String(ev.taskId).startsWith("b0@")).length,
    fold: reduced?.payload,
  };
}

test("EVERY BRANCH FAILS: the barrier resolves in all four modes rather than waiting forever", async () => {
  const items = [{ id: "a" }, { id: "b" }];
  for (const mode of MODES) {
    for (const secondPath of [false, true]) {
      for (const maxParallelism of [1, 16]) {
        const where = `mode=${mode} secondPath=${secondPath} par=${maxParallelism}`;

        // `onBranchError: "skip"` — the operator declared branch failure tolerable, so the
        // barrier releases with an EMPTY fold and the graph behind it runs. Before the fix
        // `any` and `firstSuccess` read `Jready=0 done=0` here while `all` and `quorum` read
        // `1` and `1`; the whole point is that the four now agree.
        const skip = await run(
          fanSpec({ mode, onBranchError: "skip", body: "function/boom@stable", width: 2, secondPath }),
          items,
          maxParallelism,
        );
        assert.equal(skip.joinReady, 1, `${where}: the barrier resolves — it minted nothing at all`);
        assert.equal(skip.doneCommitted, 1, `${where}: so the node behind the join runs`);
        assert.deepEqual(skip.note, ["done-ran"], `${where}: and its write reaches the channel`);
        // OFF THE FOLD'S OWN ROW, not off the channel. `assert.deepEqual(skip.seen, [])` was the
        // first draft and it is worthless here: `p.channels["seen"]` is ABSENT when the barrier
        // never releases, and the accessor defaults it to `[]`, so that assertion was true both
        // before the fix and after it. `state.reduced` is what separates "the fold ran and saw
        // nothing" from "the fold never ran": it exists only if the join committed, and its
        // counts say how many branches came through intact and how many were lost.
        assert.deepEqual(
          skip.fold === undefined ? undefined : { branchCount: skip.fold.branchCount, skipped: skip.fold.skipped, degraded: skip.fold.degraded },
          { branchCount: 0, skipped: 2, degraded: true },
          `${where}: the fold ran, saw zero intact branches and two lost ones, and said so`,
        );
        assert.deepEqual(skip.seen, [], `${where}: and no branch contributed to the channel`);

        // `onBranchError: "fail"` — the same operator, the opposite posture. The barrier still
        // resolves, and `#foldJoin` turns the empty fold into a NAMED failure. Before the fix
        // `any` and `firstSuccess` also ended `failed` here, but on the orphaned branch, with
        // `Jready=0`: the code that names the reason was never raised.
        const fail = await run(
          fanSpec({ mode, onBranchError: "fail", body: "function/boom@stable", width: 2, secondPath }),
          items,
          maxParallelism,
        );
        assert.equal(fail.joinReady, 1, `${where}: the barrier resolves under "fail" too`);
        assert.equal(fail.status, "failed", `${where}: and the run is not called succeeded`);
        assert.equal(
          fail.joinError,
          "E_QUORUM_UNREACHABLE",
          `${where}: the barrier itself names why, rather than the run failing on an orphan branch`,
        );
        assert.equal(fail.doneCommitted, 0, `${where}: and nothing behind the join runs`);
      }
    }
  }
});

test("A SHORT-CIRCUITING MODE STILL SHORT-CIRCUITS — `any` is not `all` with extra steps", async () => {
  // Four branches that all SUCCEED, one at a time. `any` and `firstSuccess` must release on the
  // FIRST arrival and `all` must wait for four. A fix that answered §A.55 by gating the whole
  // decision on quiescence passes every assertion in the test above and fails every one here,
  // which is the point of having it: it is the regression the comment over `#maybeFireJoin`'s
  // predicate was written to prevent.
  //
  // READ OFF THE JOURNAL'S ORDER, NOT OFF THE FOLD, and that distinction is a fact about the
  // engine worth writing down: an early mint does NOT mean a smaller fold. `#foldJoin` runs when
  // the join's Task executes, and by then lazy materialisation has topped the fan-out up and the
  // remaining branches have committed — so `any` here folds all four, exactly as `all` does. What
  // differs, and all that differs, is WHEN the barrier's `task.ready` was appended.
  const items = ["a", "b", "c", "d"].map((id) => ({ id }));
  const at = (mode: string) =>
    fanSpec({ mode, onBranchError: "skip", body: "function/work@stable", width: 4, secondPath: false });

  for (const mode of ["any", "firstSuccess"] as const) {
    const r = await run(at(mode), items, 1);
    assert.equal(r.status, "succeeded", mode);
    assert.equal(r.joinReady, 1, `${mode}: one barrier, one mint`);
    assert.equal(r.branchesBeforeJoinReady, 1, `${mode}: released on the FIRST success, not the last`);
  }

  const all = await run(at("all"), items, 1);
  assert.equal(all.status, "succeeded");
  assert.equal(all.branchesBeforeJoinReady, 4, "`all` waits for every branch — the contrast");
  assert.deepEqual(all.seen, ["a", "b", "c", "d"], "and folds all four");
});

/** `start --fanout(2)--> hold (a human_gate) --join--> J --seq--> done`. */
function gateSpec(mode: string): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "join-never-gate", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 64, maxDepth: 2, maxFanout: 16, maxLoopIterations: 1 } },
    channels: CHANNELS,
    inputs: ["items"],
    outputs: [],
    nodes: [
      { id: n("start"), type: "function", reads: ["items"], function: { ref: "function/seed@stable" } },
      { id: n("hold"), type: "human_gate", reads: ["item"], humanGate: { ref: "oversight/hold@stable" } },
      {
        id: n("J"),
        type: "join",
        reads: ["seen"],
        writes: ["seen"],
        join: { branches: [n("hold")], mode, onBranchError: "skip", ...(mode === "quorum" ? { k: 0.5 } : {}) },
      },
      { id: n("done"), type: "function", reads: ["seen"], writes: ["note"], function: { ref: "function/done@stable" } },
    ],
    edges: [
      { id: e("fo"), from: n("start"), to: n("hold"), kind: "fanout", over: "items", as: "item", maxWidth: 2 },
      { id: e("jn0"), from: n("hold"), to: n("J"), kind: "join", branches: [n("hold")] },
      { id: e("sq"), from: n("J"), to: n("done"), kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

function gateEngine(store: SqliteStateStore): Engine {
  const functions = new FunctionRegistry();
  functions.register("function/seed@stable", () => ({}));
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
    maxParallelism: 16,
    resolver: resolver(),
    policy: { granted: SKELETON_TENANT_CAPS, budget: { runUsd: 5 } },
  });
}

/**
 * THE BARRIER RELEASES FROM THE JOURNAL ALONE — and the same drive pins the half of §A.55 that
 * is NOT closed.
 *
 * A `human_gate` inside each fanned-out branch parks the run in the first process with two gates
 * open and nothing terminal. A SECOND Engine — its own `SqliteStateStore` over the same file, no
 * shared object, no in-memory run context, no leases — attaches, and two humans REJECT. The
 * barrier must then resolve on that process's evidence and the journal's, because the fresh
 * Engine has nothing else. Measured, `mode=any`:
 *
 *     before   process1: status=awaiting_gate openGates=2
 *              process2: status=succeeded Jready=0 done=0 note=undefined
 *     after    process2: status=succeeded Jready=1 done=1 note=["done-ran"]
 *
 * WHY THIS SHAPE AND NOT A SECOND ENGINE ON THE FINISHED RUN: a restart after the run is already
 * terminal appends nothing and re-folds a closed journal, so it cannot distinguish a verdict
 * recomputed from rows from one that was never needed. An earlier draft of this file did exactly
 * that and claimed the property; here the fresh process does the deciding.
 *
 * AND THE OPEN HALF, PINNED AS "TODAY" SO WHOEVER DECIDES HAS A FAILING TEST TO FLIP. Two humans
 * rejected, no branch produced anything, the fold has zero contributions — and the node behind
 * the join runs and the run reports **`succeeded`**. §A.55 asked for two things and this file
 * closes ONE: the barrier no longer waits for an arrival that cannot come. Whether a fold with
 * zero contributions may be called a success is NOT settled here, is left to the maintainer, and
 * binds `all` and `quorum` exactly as much as `any` — all four release the same empty fold today,
 * which is why the assertion below runs over all four and why closing it is not a change to the
 * arm this commit touched. The candidate rule is `#foldJoin` refusing `branchCount === 0 &&
 * expected > 0`; when it lands, the two `TODAY` assertions here flip and this paragraph goes
 * with them.
 */
test("THE BARRIER RELEASES FROM THE JOURNAL ALONE — a fresh Engine, two rejected gates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-join-never-"));
  try {
    for (const mode of MODES) {
      const path = join(dir, `${mode}.db`);
      const graph = compileOrThrow({
        spec: gateSpec(mode),
        resolver: resolver(),
        tools: {},
        tenantCapabilities: SKELETON_TENANT_CAPS,
      });

      // ── the process that parks ──────────────────────────────────────────────
      const first = new SqliteStateStore({ path, now: () => NOW });
      let runId;
      try {
        const engine = gateEngine(first);
        runId = await engine.submit({ graph, inputs: { items: [{ id: "a" }, { id: "b" }] } });
        const p = await engine.advance(runId);
        assert.equal(p.status, "awaiting_gate", `${mode}: precondition — the run is parked, not finished`);
        assert.equal(
          (await engine.openGates(runId)).filter((g) => g.state === "open").length,
          2,
          `${mode}: precondition — one gate per branch`,
        );
      } finally {
        first.close();
      }

      // ── the process that decides, holding nothing but the file ─────────────
      const second = new SqliteStateStore({ path, now: () => NOW });
      try {
        const engine = gateEngine(second);
        engine.attach(runId, graph);
        for (const gate of (await engine.openGates(runId)).filter((g) => g.state === "open")) {
          await engine.resolveGate(runId, {
            gateId: gate.gateId,
            decision: { kind: "reject", reason: "no" },
            actor: { kind: "human", subject: "u:alice", via: "console" },
            idempotencyKey: `k-${gate.gateId}`,
          });
        }
        const p = await engine.advance(runId);
        const log: JournalEvent[] = [];
        for await (const ev of second.read(runId, 1)) log.push(ev);
        const count = (type: string, prefix: string): number =>
          log.filter((ev) => ev.type === type && String(ev.taskId ?? "").startsWith(prefix)).length;

        // THE CLOSED HALF. Before the fix this read `0` for `any` and `firstSuccess`.
        assert.equal(count("task.ready", "J@"), 1, `${mode}: the fresh Engine released the barrier`);

        // THE OPEN HALF, asserted as it behaves TODAY. Two humans said no and the graph behind
        // the barrier ran anyway. See this test's header: settling that is the maintainer's, it
        // binds all four modes, and these two lines are what flips.
        assert.equal(count("task.committed", "done@"), 1, `${mode}: TODAY the node behind the join runs`);
        assert.equal(p.status, "succeeded", `${mode}: TODAY the run reports succeeded — §A.55's unclosed half`);
      } finally {
        second.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

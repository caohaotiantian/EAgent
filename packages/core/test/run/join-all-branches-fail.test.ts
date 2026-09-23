/**
 * A BARRIER MUST DISTINGUISH "NOT YET" FROM "NEVER", IN ALL FOUR MODES.
 *
 * THIS FILE CLOSES BOTH OF §A.55's HALVES, ONE PER WAVE. First: a join in mode `any` or
 * `firstSuccess` whose members all terminate without succeeding RELEASES rather than waiting for
 * an arrival that cannot come — in all four modes, with and without a second entrance, at every
 * parallelism, and across a restart. Second (2026-09-15, §D.9 answered as option (a)): that
 * release is not a SUCCESS: a barrier not one of whose members succeeded fails
 * `E_QUORUM_UNREACHABLE` instead of folding nothing and letting the graph carry on. (The
 * predicate was `succeededMembers === 0 && members.length > 0` when this file was written; §A.67
 * narrowed the unit to the barrier's WORK members, because an approved `human_gate` is a member
 * that succeeded and wrote nothing — `join-evidence-and-work.test.ts` owns that half. Every graph
 * in THIS file is gateless, so every member of every barrier here is a work member and the two
 * readings coincide on all of it.) It binds all four modes and both `onBranchError`
 * values, because all four released the same empty fold and always had. The unit is MEMBER TASKS
 * and the last three tests in this file are why.
 *
 * THE DECISION WAS THE ORCHESTRATOR'S, following §D.9's own written recommendation — not the
 * maintainer's. The alternatives it declined: a `join.minBranches` knob, which prices a
 * correctness question as configuration and leaves the unsafe default standing; and accepting the
 * semantics and documenting them, which leaves a gate-reject run looking exactly like success in
 * the journal.
 *
 * `members.length > 0` IS THE WHOLE SAFETY OF THAT RULE, and the empty-fan control below is what
 * shows it: a fan-out over an EMPTY channel materialises no member Task at all, so the barrier
 * has nothing to have succeeded and must still release and still SUCCEED (§A.47's
 * `#fireEmptyJoin`). "The fan materialised nothing" and "the fan materialised two and lost both"
 * are different runs and only the second is a failure.
 *
 * `#maybeFireJoin`'s `any` and `firstSuccess` arms were `succeeded >= 1` and nothing else — a
 * predicate with no false branch that terminates. Once every member of the barrier is terminal
 * and none succeeded, it is permanently false: the barrier never mints its Task, everything
 * behind the join never runs, and `#finish` still calls the run **`succeeded`**, because nothing
 * is left in a live state to object to. `onBranchError: "skip"` does not help; it is what makes
 * the branches terminal in the first place.
 *
 * Measured on the unfixed engine, on `fanSpec` below at `onBranchError: "skip"` — `start
 * -fanout(2)-> b0 -join-> J -seq-> done` over a body that always throws:
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
 * THE BARRIER RELEASES RATHER THAN FAILING, and the two `onBranchError` values are both in the
 * sweep because that is what the division of labour rests on. `#maybeFireJoin` decides WHEN a
 * barrier releases; `#foldJoin` decides what the release MEANS, and it holds BOTH failure arms —
 * `onBranchError === "fail" && skipped > 0`, and now "no work member succeeded". Under
 * `"fail"` the run ended `failed` before any of this — but for the ORPHAN BRANCH, with
 * `Jready=0`: the barrier had still not resolved, and the code naming the reason was never
 * raised. That is why this file asserts the join's own error code and not just the run's status.
 *
 * THE SHORT-CIRCUIT CONTROL is the other side, and a fix without it would pass everything above:
 * gating the whole decision on quiescence collapses `any` and `firstSuccess` into `all` — they
 * would release at exactly the same point, which is the defect the comment above the predicate
 * was written to prevent. `fanSpec` over `function/work@stable` fans out four branches that all
 * SUCCEED at `maxParallelism: 1`, where `any` must fold the first arrival alone and `all` four.
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
        // barrier RELEASES. Before §A.55's first half `any` and `firstSuccess` read
        // `Jready=0 done=0` here while `all` and `quorum` read `1` and `1`; the whole point is
        // that the four now agree on WHEN.
        //
        // AND THE RELEASE IS NOT A SUCCESS, which is §D.9's answer and the second half of the
        // row. The fold has zero contributions out of two planned branches, so `#foldJoin`
        // refuses; `done` no longer runs and `state.reduced` is never appended, because a
        // refused fold commits no reduction. `onBranchError: "skip"` does not change that — it
        // still absorbs a PARTIAL loss, which is the whole of its ordinary use, and it does not
        // say that a run which produced nothing is a success.
        const skip = await run(
          fanSpec({ mode, onBranchError: "skip", body: "function/boom@stable", width: 2, secondPath }),
          items,
          maxParallelism,
        );
        assert.equal(skip.joinReady, 1, `${where}: the barrier resolves — it minted nothing at all`);
        assert.equal(skip.status, "failed", `${where}: and a fold of nothing is not a success`);
        assert.equal(
          skip.joinError,
          "E_QUORUM_UNREACHABLE",
          `${where}: the barrier itself names why, under "skip" as under "fail"`,
        );
        assert.equal(skip.doneCommitted, 0, `${where}: so nothing behind the join runs`);
        assert.equal(skip.note, undefined, `${where}: and nothing reaches the channel behind it`);
        assert.equal(skip.fold, undefined, `${where}: a refused fold appends no state.reduced`);
        assert.deepEqual(skip.seen, [], `${where}: and no branch contributed to the channel`);

        // `onBranchError: "fail"` — the same operator, the opposite posture. The barrier still
        // resolves, and `#foldJoin` turns the empty fold into a NAMED failure. Before §A.55's
        // first half `any` and `firstSuccess` also ended `failed` here, but on the orphaned
        // branch, with `Jready=0`: the code that names the reason was never raised. The two
        // `onBranchError` values now agree on this shape, which is exactly what §D.9 costs.
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
 *     now      process2: status=failed    Jready=1 done=0 note=undefined
 *                        joinError=E_QUORUM_UNREACHABLE
 *
 * WHY THIS SHAPE AND NOT A SECOND ENGINE ON THE FINISHED RUN: a restart after the run is already
 * terminal appends nothing and re-folds a closed journal, so it cannot distinguish a verdict
 * recomputed from rows from one that was never needed. An earlier draft of this file did exactly
 * that and claimed the property; here the fresh process does the deciding.
 *
 * AND THE SECOND HALF IS SETTLED HERE TOO, on the same drive. Two humans rejected, no branch
 * produced anything, the fold has zero contributions out of two planned branches — and the node
 * behind the join does NOT run and the run reports `failed`, with the barrier's own
 * `E_QUORUM_UNREACHABLE` on the row. This was the §A.55 half pinned `TODAY` until 2026-09-15; the
 * `now` line above is what the two flipped assertions read. It binds all four modes, which is why
 * the sweep runs over all four.
 *
 * THE FRESH PROCESS IS WHERE THE REFUSAL IS COMPUTED, not merely re-read — the second Engine
 * holds no run context, no leases and no member list, and the drive above is what mints and folds
 * the barrier. That much is measured by this test.
 *
 * WHAT THE RESTART LENS SAYS, as reasoning and not as a second measurement: the refusal reads
 * `members` and its succeeded counts, all derived from `p.tasks`, which `#project` folds from
 * `task.*` rows — and, since §A.67, each member's node type, which comes off the compiled graph
 * the fresh Engine attaches. There is no in-memory side to come back empty — a fold that lost the task rows
 * would lose the barrier's own `task.ready` with them and nothing would be folded at all. It
 * reads NOTHING off `p.fanouts`, deliberately, which is the other half of why: a plan whose
 * branches were never materialised is `#finish`'s unmaterialised-branch net, not this arm's.
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

        // AND THE OTHER HALF, §D.9's answer. Two humans said no, the fold has zero contributions
        // out of two planned branches, and the graph behind the barrier does NOT run. These two
        // lines are the ones that were pinned `TODAY` until 2026-09-15; the measurement they
        // replace, taken on the merged tree in all four modes, was
        // `status=succeeded Jready=1 done=1 note=["done-ran"] joinError=undefined`.
        assert.equal(count("task.committed", "done@"), 0, `${mode}: the node behind the join does not run`);
        assert.equal(p.status, "failed", `${mode}: and two humans saying no is not a success`);
        const joinError = log.find((ev) => ev.type === "task.failed" && String(ev.taskId).startsWith("J@")) as
          | { payload?: { error?: { code?: string } } }
          | undefined;
        assert.equal(
          joinError?.payload?.error?.code,
          "E_QUORUM_UNREACHABLE",
          `${mode}: the barrier names why, on the fresh process's own evidence`,
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
 * THE EMPTY-FAN CONTROL — the two-sided half of §D.9's answer, and §A.47's own shape.
 *
 * A fan-out over an EMPTY channel is a legitimate graph: `#activate` appends
 * `fanout.planned{width: 0}`, materialises no branch Task, and `#fireEmptyJoin` mints the
 * barrier directly, because notification otherwise rides on a branch commit and there are no
 * branches ("an alert with no pods strands the entire downstream graph while the run still
 * reports success"). That barrier folds NOTHING and must still SUCCEED.
 *
 * WITHOUT THIS TEST, `#foldJoin` REFUSING "NOTHING SUCCEEDED" ALONE PASSES EVERY OTHER
 * ASSERTION IN THIS FILE and breaks every empty fan in the product — a barrier with no members
 * has none that succeeded. `members.length > 0` is the clause that separates "the fan
 * materialised nothing" from "the fan materialised two and lost both", and this is what holds it
 * in place. Measured before and after §D.9's answer, unchanged in all four modes:
 * `status=succeeded Jready=1 done=1 note=["done-ran"]`.
 *
 * `function/work@stable` AND NOT `function/boom@stable`, deliberately: the body is never
 * entered — that is the point — so a throwing body would prove nothing and would read as a
 * second copy of the sweep above.
 */
test("A FAN-OUT THAT PLANNED ZERO BRANCHES STILL RELEASES AND STILL SUCCEEDS — §A.47", async () => {
  for (const mode of MODES) {
    const r = await run(
      fanSpec({ mode, onBranchError: "skip", body: "function/work@stable", width: 4, secondPath: false }),
      // The EMPTY list: `over: "items"` slices nothing, so `list.length` is 0 and the plan's
      // width is 0. The `maxWidth: 4` above is untouched — it is the CHANNEL that is empty, which
      // is the shape an operator actually hits.
      [],
      16,
    );
    assert.equal(r.joinReady, 1, `${mode}: the barrier over zero branches is satisfied`);
    assert.equal(r.status, "succeeded", `${mode}: and a fan that planned nothing did not fail`);
    assert.equal(r.doneCommitted, 1, `${mode}: the node behind the join runs`);
    assert.deepEqual(r.note, ["done-ran"], `${mode}: and its write reaches the channel`);
    assert.deepEqual(
      r.fold === undefined ? undefined : { branchCount: r.fold.branchCount, skipped: r.fold.skipped },
      { branchCount: 0, skipped: 0 },
      `${mode}: the fold ran, over nothing, and committed a reduction`,
    );
  }
});

// ── THE UNIT THE REFUSAL COUNTS IN ────────────────────────────────────────────

/**
 * THE REFUSAL COUNTS MEMBER TASKS, NOT BRANCH COORDINATES, and these two shapes are why.
 *
 * `#foldJoin`'s first cut of §D.9's answer read `branchCount === 0`, which is
 * `contributing.size` — a set of BRANCH COORDINATES that the `lost` subtraction empties whenever
 * ANY member of a coordinate dies. Two graphs that were succeeding on `loom` started failing with
 * their data already in the channel:
 *
 *   - `staticSpec` below: three sibling arms wired `kind: "join"` with no fan-out above them, so
 *     every arm sits at the SAME root coordinate. One loser emptied the set. Measured, `mode:
 *     all`, `onBranchError: "skip"`, `losers: ["a"]` — `status=failed found=["b","c"] total=2
 *     err=E_QUORUM_UNREACHABLE`, against a base reading `succeeded`. It is the SAME SHAPE as the
 *     shipped `examples/graphs/two-person-approval.json`, where two-of-three approval lives in a
 *     `quorum` join over three static `human_gate` arms — though NOT a defect on that graph:
 *     it then declared `onBranchError: "fail"` (since `DESIGN.md` D9 that half ships as
 *     `two-person-veto.json`), so one rejection fires the PRE-EXISTING arm on both
 *     engines and the first cut never got a word in (measured). The shape is what matters; the
 *     graph that shipped then carried a posture that hides it. The canonical file now declares
 *     `"skip"`, which does NOT hide it, and `test/graph/two-person-approval.test.ts` drives it
 *     over every one-dissenter ordering.
 *   - `degradedSpec` below: a fanned branch of two nodes where the FIRST wrote and succeeded and
 *     the second threw. Every coordinate is lost, so the run failed and discarded `seen`, where
 *     the base read `seen: ["a","b"]` — under a message saying the run "did no work".
 *
 * The conjunct `byChannel.size === 0` does not rescue either, and was measured too: a member at
 * the ROOT coordinate never enters `byChannel` at all (`writesHeldForJoin` is false there, so its
 * writes were applied at commit), which leaves the static shape failing exactly as before.
 * "Did any member of this barrier finish successfully" is the question the row actually asks, and
 * counted per TASK it is the same in both units for a fan and correct in the one that matters for
 * a static join. (§A.67 then narrowed WHICH members are asked — the work ones, where the barrier
 * has any. Every barrier in this file is gateless, so it asks all of them, as it always did.)
 */
const ARMS = ["a", "b", "c"] as const;

const STATIC_CHANNELS = {
  ...CHANNELS,
  seed: { type: "string", reduce: "replace" },
  found: { type: "array", reduce: "append_ordered" },
  total: { type: "number", reduce: "sum", initial: 0 },
};

/** Three static sibling arms joined AT the root coordinate — no fan-out anywhere. */
function staticSpec(mode: string): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "join-static-arms", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 32, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
    channels: STATIC_CHANNELS,
    inputs: ["seed"],
    outputs: [],
    nodes: [
      { id: n("start"), type: "function", reads: ["seed"], function: { ref: "function/seed@stable" } },
      ...ARMS.map((id) => ({
        id: n(id),
        type: "function",
        reads: ["seed"],
        writes: ["found", "total"],
        function: { ref: `function/arm-${id}@stable` },
      })),
      {
        id: n("J"),
        type: "join",
        reads: ["found"],
        writes: ["found", "total"],
        join: { branches: ARMS.map(n), mode, onBranchError: "skip", ...(mode === "quorum" ? { k: 0.5 } : {}) },
      },
    ],
    edges: [
      ...ARMS.map((id) => ({ id: e(`s${id}`), from: n("start"), to: n(id), kind: "seq" })),
      ...ARMS.map((id) => ({ id: e(`j${id}`), from: n(id), to: n("J"), kind: "join", branches: ARMS.map(n) })),
    ],
  } as unknown as GraphSpec;
}

/** `start --fanout(2)--> b0 --seq--> b1 --join--> J`; `b0` writes and succeeds, `b1` throws. */
function degradedSpec(mode: string): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "join-degraded-branch", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 32, maxDepth: 2, maxFanout: 8, maxLoopIterations: 1 } },
    channels: CHANNELS,
    inputs: ["items"],
    outputs: [],
    nodes: [
      { id: n("start"), type: "function", reads: ["items"], function: { ref: "function/seed@stable" } },
      { id: n("b0"), type: "function", reads: ["item"], writes: ["seen"], function: { ref: "function/work@stable" } },
      { id: n("b1"), type: "function", reads: ["item"], function: { ref: "function/boom@stable" } },
      {
        id: n("J"),
        type: "join",
        reads: ["seen"],
        writes: ["seen"],
        join: { branches: [n("b0"), n("b1")], mode, onBranchError: "skip", ...(mode === "quorum" ? { k: 0.5 } : {}) },
      },
    ],
    edges: [
      { id: e("fo"), from: n("start"), to: n("b0"), kind: "fanout", over: "items", as: "item", maxWidth: 2 },
      { id: e("sq"), from: n("b0"), to: n("b1"), kind: "seq" },
      // BOTH members need their own `kind: join` edge — the rule §A.56's `fix:` line states.
      { id: e("jn0"), from: n("b0"), to: n("J"), kind: "join", branches: [n("b0"), n("b1")] },
      { id: e("jn1"), from: n("b1"), to: n("J"), kind: "join", branches: [n("b0"), n("b1")] },
    ],
  } as unknown as GraphSpec;
}

/** Every branch SUCCEEDS and writes nothing — success with no data is not this row's shape. */
function silentSpec(mode: string): GraphSpec {
  return fanSpec({ mode, onBranchError: "skip", body: "function/silent@stable", width: 2, secondPath: false });
}

interface ArmResult {
  readonly status: string;
  readonly found: unknown;
  readonly total: unknown;
  readonly seen: unknown;
  readonly joinError: string | undefined;
}

async function runArms(spec: GraphSpec, inputs: Record<string, unknown>, losers: readonly string[]): Promise<ArmResult> {
  const store = new MemoryStateStore({ now: () => NOW });
  const functions = new FunctionRegistry();
  functions.register("function/seed@stable", () => ({}));
  functions.register("function/silent@stable", () => ({}));
  functions.register("function/boom@stable", () => {
    throw new Error("boom");
  });
  functions.register("function/work@stable", (view) => ({ writes: { seen: [view.get<{ id: string }>("item")?.id ?? "?"] } }));
  functions.register("function/done@stable", () => ({ writes: { note: ["done-ran"] } }));
  for (const id of ARMS) {
    functions.register(`function/arm-${id}@stable`, () => {
      if (losers.includes(id)) throw new Error(`${id} failed`);
      return { writes: { found: [id], total: 1 } };
    });
  }
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models,
    now: () => NOW,
    maxParallelism: 8,
    policy: { granted: [], budget: { runUsd: 1 } },
  });
  const runId = await engine.submit({ graph: compileOrThrow({ spec, resolver: resolver(), tools: {}, tenantCapabilities: [] }), inputs });
  const p = await engine.advance(runId);
  const log: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) log.push(ev);
  const jf = log.find((ev) => ev.type === "task.failed" && String(ev.taskId).startsWith("J@")) as
    | { payload?: { error?: { code?: string } } }
    | undefined;
  return {
    status: p.status,
    found: p.channels["found"],
    total: p.channels["total"],
    seen: p.channels["seen"],
    joinError: jf?.payload?.error?.code,
  };
}

test("A STATIC SIBLING JOIN LOSING SOME ARMS STILL FOLDS — the refusal counts tasks, not coordinates", async () => {
  for (const mode of MODES) {
    // Every arm is at the ROOT coordinate, so `contributing` holds at most ONE entry and any
    // loss empties it. The rows that must FOLD are the ones a coordinate count gets wrong.
    //
    // AND THE THIRD ROW IS `quorum`'S ONLY, BY §A.75. `staticSpec` writes `k: 0.5` over three
    // arms, so a quorum barrier needs TWO of them; one surviving arm is the defect that row
    // names — `#foldJoin` released on "nothing more can arrive" and never re-checked `k`, so
    // one-of-three met `k: 2`. It now refuses, and `join-quorum-k-is-a-floor.test.ts` holds the
    // whole matrix. Every other mode is unchanged: `any` and `firstSuccess` want one success and
    // `all` wants every arrival, and none of the three declares a count.
    const survives: readonly (readonly [readonly string[], unknown, unknown])[] = [
      [[], ["a", "b", "c"], 3],
      [["a"], ["b", "c"], 2],
      ...(mode === "quorum" ? [] : [[["a", "b"], ["c"], 1] as const]),
    ];
    for (const [losers, found, total] of survives) {
      const r = await runArms(staticSpec(mode), { seed: "s" }, losers);
      const where = `mode=${mode} losers=${JSON.stringify(losers)}`;
      assert.equal(r.status, "succeeded", `${where}: an arm that succeeded is a fold`);
      assert.deepEqual(r.found, found, `${where}: and its writes are in the channel`);
      assert.equal(r.total, total, `${where}: under both reducers`);
      assert.equal(r.joinError, undefined, `${where}: with no refusal`);
    }

    // The row §A.75 moved, asserted rather than merely omitted above: under `quorum` one
    // surviving arm of three is a refusal, and it names the barrier.
    if (mode === "quorum") {
      const short = await runArms(staticSpec(mode), { seed: "s" }, ["a", "b"]);
      assert.equal(short.status, "failed", "mode=quorum: one arm of three does not meet k: 0.5 of 3");
      assert.equal(short.joinError, "E_QUORUM_UNREACHABLE", "mode=quorum: named by the barrier");
      // The surviving arm's OWN write is in the channel either way and that is not this arm's
      // doing: every member of a static sibling join sits at the ROOT coordinate, so
      // `writesHeldForJoin` is false and it applied its own writes at commit. What the refusal
      // stops is the FOLD and everything behind the barrier.
      assert.deepEqual(short.found, ["c"], "mode=quorum: the arm applied its own write at commit");
      // BOTH REDUCERS, as the folding rows above assert. `total` is `sum` where `found` is
      // `append_ordered`, and the surviving arm applied ITS OWN contribution to each at commit
      // (root coordinate, so `writesHeldForJoin` is false) — so the refusal is visible as the
      // absence of the FOLD, not as an empty channel. A `sum` that read 2 or 3 here would mean the
      // refused barrier had folded something anyway, which is the failure this line can see and
      // `found` alone cannot.
      assert.equal(short.total, 1, "mode=quorum: one arm's own write under the `sum` reducer, and no fold on top of it");
    }

    // And the one row that must REFUSE: not one arm succeeded.
    const none = await runArms(staticSpec(mode), { seed: "s" }, [...ARMS]);
    assert.equal(none.status, "failed", `mode=${mode}: every arm lost is still a refusal`);
    assert.equal(none.joinError, "E_QUORUM_UNREACHABLE", `mode=${mode}: named by the barrier`);
    assert.equal(none.found, undefined, `mode=${mode}: and nothing reached the channel`);
  }
});

test("A DEGRADED BRANCH WHOSE EARLIER MEMBER WROTE STILL FOLDS", async () => {
  for (const mode of MODES) {
    // `b0` succeeds and writes, `b1` throws — so EVERY coordinate is `lost` and `branchCount` is
    // 0, while two member tasks succeeded and their writes are held for this barrier.
    const r = await runArms(degradedSpec(mode), { items: [{ id: "a" }, { id: "b" }] }, []);
    assert.equal(r.status, "succeeded", `mode=${mode}: a branch that produced something is not nothing`);
    assert.deepEqual(r.seen, ["a", "b"], `mode=${mode}: and what it produced survives the fold`);
    assert.equal(r.joinError, undefined, `mode=${mode}: with no refusal`);
  }
});

test("A FAN WHOSE BRANCHES ALL SUCCEED WRITING NOTHING STILL FOLDS", async () => {
  for (const mode of MODES) {
    // The boundary on the other side: "the run produced no data" is NOT this row's shape, which
    // is "no branch came through at all". `taint-failed-commits.test.ts`'s `errfan` fixture rests
    // on exactly this — its surviving branch succeeds and writes nothing.
    const r = await runArms(silentSpec(mode), { items: [{ id: "a" }, { id: "b" }] }, []);
    assert.equal(r.status, "succeeded", `mode=${mode}: a member that succeeded is a fold`);
    assert.equal(r.seen, undefined, `mode=${mode}: even though nothing was written`);
    assert.equal(r.joinError, undefined, `mode=${mode}: and no refusal`);
  }
});

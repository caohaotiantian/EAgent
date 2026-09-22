/**
 * A BARRIER ASKS ITS **WORK** MEMBERS WHETHER ANYTHING SUCCEEDED — AND ITS GATES ONLY WHEN IT
 * HAS NO WORK MEMBER AT ALL.
 *
 * §A.67, the residual §D.9 left. `#foldJoin`'s zero-fold refusal was `succeededMembers === 0 &&
 * members.length > 0`, and an APPROVED `human_gate` is a member that succeeded and wrote nothing.
 * So naming one in `join.branches` disarmed the refusal for the whole barrier: two humans
 * approve, every unit of work behind them throws, nothing is folded, the node behind the barrier
 * runs, and the run reports `succeeded`. Measured on `ee4f1c14` with the row's own repro
 * (`docs/handoff-2026-09-15.md` §Repros `a67.mjs`), in all four modes:
 *
 *     mode=any          status=succeeded seen=undefined note=["done-ran"] error=none
 *     mode=firstSuccess status=succeeded seen=undefined note=["done-ran"] error=none
 *     mode=all          status=succeeded seen=undefined note=["done-ran"] error=none
 *     mode=quorum       status=succeeded seen=undefined note=["done-ran"] error=none
 *
 * AND IT WAS NOT AN AUTHORING MISTAKE. Dropping the gate from `branches` does not compile —
 * `GRAPH021_FANOUT_WITHOUT_JOIN` refuses it, *"the branch it opens holds 2 nodes (hold, work), and
 * a join must wait on every one of them"* — so every fan-out branch holding a gate had that gate
 * in its barrier's member set BY COMPILER ORDER, and the refusal was disarmed for all of them.
 *
 * THE RULE THIS FILE PINS. An EVIDENCE member is a `human_gate` task that produced nothing: its
 * success means "a human answered". Every other member is WORK. The refusal asks the work members
 * where the barrier has any, and every member where it has none.
 *
 * WHY THIS IS NOT A `JoinSpec` FIELD, which is what the row proposed. `NodeSpec.type` already
 * carries the distinction for every member, and the kernel already keys the SAME evidence/work
 * distinction on the SAME field, in this same file — `#executeTask`'s settled-gate arm: *"APPROVE
 * ON A WORK NODE MEANS 'GO AHEAD', NOT 'CONSIDER IT DONE'. A `human_gate` node is its own approval,
 * so approving completes it; every other node type has work behind the gate, and treating approval
 * as completion would report success for an action that never happened — silently, in exactly the
 * place oversight exists for."* A field would be a second spelling of a fact the spec already states, new replay vocabulary in the one artifact
 * `graphHash` is taken over, and its DEFAULT would have to be the node-type rule anyway — so it
 * would buy an override no graph in the tree asks for. §D.9 declined `join.minBranches` on the
 * same ground: it prices a correctness question as configuration.
 *
 * "PRODUCED NOTHING" IS A CONJUNCT, AND THE EDIT TEST BELOW IS WHY IT IS NOT DECORATION. A node's
 * declared `writes` become its gate's `allowEdit` (`gateAuthorizationOf`), so a human may answer
 * `{kind: "edit", writes: {…}}` and `#applyGateDecision` returns that as the task's succeeded
 * writes. That gate MADE something. Without the conjunct, a barrier whose only data came from a
 * person's edit would be refused and that data discarded — a guard refusing a run that did work.
 *
 * THE EVIDENCE-ONLY FALLBACK IS WHAT KEEPS THE SHIPPED GRAPH WHOLE, and it is driven here on the
 * shipped file itself. `examples/graphs/two-person-approval.json` has FIVE nodes — three
 * `human_gate`s (`alice`, `bob`, `carol`), the quorum `join` they feed, and an `fs.write` `tool`
 * node `save` BEHIND the join, which is the write the test below counts. What is evidence-only is
 * the BARRIER: `join.branches` names the three gates and nothing else, so no work member exists
 * at the fold and "did any work succeed" has no numerator. The fallback is then §D.9's rule
 * verbatim: one approval folds, every member lost refuses. All four of `a68.mjs`'s decision sets
 * read identically before and after this change.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO: it does not touch §A.68. The shipped graph's
 * `onBranchError: "fail"` still fails the run on ONE rejection whatever the other two people say,
 * and the assertion below records that as the CURRENT behaviour rather than endorsing it.
 *
 * EVERY CASE THAT EXERCISES THE FOLD IS DRIVEN ACROSS A RESTART — the run is parked by one
 * `Engine`, its store closed, and a FRESH `Engine` over the same SQLite file attaches, answers the
 * gates and advances. That is not decoration: the fold reads `p.tasks`, which a restart rebuilds
 * from rows, and this project's own lens asks of every decision what it does on a restart that
 * hands its state back empty.
 *
 * THE ONE EXCEPTION IS THE SHIPPED-GRAPH TEST, WHICH DRIVES ONE `Engine`, and it is named here
 * rather than glossed. Its subject is the shipped file's decision behaviour end to end — the four
 * decision sets `a68.mjs` reports — and its barrier is evidence-only, so it exercises the FALLBACK
 * and not the work count. The restart property of the fold is carried by the six above it.
 *
 * AND THE REPLAY HALF IS ASSERTED, not left to a probe: the last test re-folds a FINISHED journal
 * with a third `Engine` and pins that it reproduces the RECORDED verdict — on a journal whose
 * verdict today's rule would not produce if it were re-run.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId, RunId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { SqliteStateStore } from "../../src/journal/sqlite.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import type { ToolDefinition } from "../../src/run/registry.ts";
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
 * The row's graph, verbatim:
 * `start --fanout(2)--> hold (human_gate) --seq--> work --join--> J --seq--> done`,
 * `J.branches: ["hold", "work"]`.
 *
 * `gateWrites` declares `writes` on the GATE, which is the only thing that makes the gate
 * editable — `allowEdit` is the node's declared writes and nothing wider.
 */
function gateFanSpec(opts: { readonly mode: string; readonly body: string; readonly gateWrites: boolean }): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "a67-gate-fan", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 64, maxDepth: 2, maxFanout: 16, maxLoopIterations: 1 } },
    channels: CHANNELS,
    inputs: ["items"],
    // DECLARE NOTHING, for `join-all-branches-fail.test.ts`'s reason: a declared output nothing
    // writes fails the run `E_OUTPUT_MISSING`, which would hide the "says it worked" half.
    outputs: [],
    nodes: [
      { id: n("start"), type: "function", reads: ["items"], function: { ref: "function/seed@stable" } },
      {
        id: n("hold"),
        type: "human_gate",
        reads: ["item"],
        ...(opts.gateWrites ? { writes: ["seen"] } : {}),
        humanGate: { ref: "oversight/hold@stable" },
      },
      { id: n("work"), type: "function", reads: ["item"], writes: ["seen"], function: { ref: opts.body } },
      {
        id: n("J"),
        type: "join",
        reads: ["seen"],
        writes: ["seen"],
        join: {
          branches: [n("hold"), n("work")],
          mode: opts.mode,
          onBranchError: "skip",
          ...(opts.mode === "quorum" ? { k: 0.5 } : {}),
        },
      },
      { id: n("done"), type: "function", reads: ["seen"], writes: ["note"], function: { ref: "function/done@stable" } },
    ],
    edges: [
      { id: e("fo"), from: n("start"), to: n("hold"), kind: "fanout", over: "items", as: "item", maxWidth: 2 },
      { id: e("sw"), from: n("hold"), to: n("work"), kind: "seq" },
      { id: e("jh"), from: n("hold"), to: n("J"), kind: "join", branches: [n("hold"), n("work")] },
      { id: e("jw"), from: n("work"), to: n("J"), kind: "join", branches: [n("hold"), n("work")] },
      { id: e("sq"), from: n("J"), to: n("done"), kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

/**
 * The SAME graph with the `human_gate` replaced by a `router` — §A.67 with no human in it.
 *
 * `#runRouter` returns `writes: {}` on both of its exits ("it never writes state — its entire
 * output is an edge subset"), so a router's success can no more be the reason a barrier has
 * something in it than a gate's can. GRAPH021 forces it into `branches` exactly as it forces the
 * gate. Measured on `ee4f1c14` AND on §A.67's first cut: `status=succeeded note=["done-ran"]` with
 * every unit of work behind the router dead, in all four modes, zero diagnostics — the row
 * verbatim, which is why `PRODUCES_NOTHING` is a set and not one type.
 */
function routerFanSpec(opts: { readonly mode: string; readonly body: string }): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "a67-router-fan", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 64, maxDepth: 2, maxFanout: 16, maxLoopIterations: 1 } },
    channels: CHANNELS,
    inputs: ["items"],
    outputs: [],
    nodes: [
      { id: n("start"), type: "function", reads: ["items"], function: { ref: "function/seed@stable" } },
      { id: n("r"), type: "router", reads: ["item"], router: { mode: "expression", cases: [], fallbackEdge: e("sw") } },
      { id: n("work"), type: "function", reads: ["item"], writes: ["seen"], function: { ref: opts.body } },
      {
        id: n("J"),
        type: "join",
        reads: ["seen"],
        writes: ["seen"],
        join: {
          branches: [n("r"), n("work")],
          mode: opts.mode,
          onBranchError: "skip",
          ...(opts.mode === "quorum" ? { k: 0.5 } : {}),
        },
      },
      { id: n("done"), type: "function", reads: ["seen"], writes: ["note"], function: { ref: "function/done@stable" } },
    ],
    edges: [
      { id: e("fo"), from: n("start"), to: n("r"), kind: "fanout", over: "items", as: "item", maxWidth: 2 },
      { id: e("sw"), from: n("r"), to: n("work"), kind: "seq" },
      { id: e("jr"), from: n("r"), to: n("J"), kind: "join", branches: [n("r"), n("work")] },
      { id: e("jw"), from: n("work"), to: n("J"), kind: "join", branches: [n("r"), n("work")] },
      { id: e("sq"), from: n("J"), to: n("done"), kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

/**
 * THE STATIC BARRIER THAT RELEASES ON EVIDENCE ALONE WHILE ITS WORK IS STILL LIVE (B1).
 *
 * `alice` (a `human_gate`) and `worker` (a `function` at posture `in`, so it raises a POLICY gate
 * of its own) are sibling arms wired `kind: "join"` with NO fan-out above them, both members of
 * `J`. Approve only `alice`: `any`, `firstSuccess` and `quorum` short-circuit on
 * `succeeded >= 1` WITHOUT quiescence — "QUIESCENCE GATES THE 'NO' ANSWERS, NOT THE 'YES' ONES" —
 * so the barrier releases while `worker` is still `awaiting_gate`.
 *
 * NO FAN-OUT IS WHY THIS COMPILES, and it is what §A.67's first cut missed: three attempts to
 * build it as a FAN-OUT were refused (`GRAPH021_FANOUT_WITHOUT_JOIN`, `GRAPH008_BRANCH_NOT_CONNECTED`),
 * and a comment was written saying the shape was not known to be reachable. It is reachable, with
 * zero diagnostics, and this graph is the counterexample.
 */
function staticLiveWorkSpec(mode: string, body: string, k = 0.5): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "a67-static-live-work", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 64, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
    channels: CHANNELS,
    inputs: ["items"],
    outputs: [],
    nodes: [
      { id: n("alice"), type: "human_gate", reads: ["items"], humanGate: { ref: "oversight/hold@stable" } },
      {
        id: n("worker"),
        type: "function",
        reads: ["items"],
        writes: ["seen"],
        policy: { posture: "in" },
        function: { ref: body },
      },
      {
        id: n("J"),
        type: "join",
        reads: ["seen"],
        writes: ["seen"],
        join: {
          branches: [n("alice"), n("worker")],
          mode,
          onBranchError: "skip",
          ...(mode === "quorum" ? { k } : {}),
        },
      },
      { id: n("done"), type: "function", reads: ["seen"], writes: ["note"], function: { ref: "function/done@stable" } },
    ],
    edges: [
      { id: e("ja"), from: n("alice"), to: n("J"), kind: "join", branches: [n("alice"), n("worker")] },
      { id: e("jw"), from: n("worker"), to: n("J"), kind: "join", branches: [n("alice"), n("worker")] },
      { id: e("sq"), from: n("J"), to: n("done"), kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

/**
 * The EVIDENCE-ONLY barrier, in the shape the shipped example uses: static sibling gates wired
 * `kind: "join"` with no fan-out above them, so every member sits at the ROOT coordinate.
 */
function evidenceOnlySpec(mode: string): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "a67-evidence-only", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 64, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
    channels: CHANNELS,
    inputs: ["items"],
    outputs: [],
    nodes: [
      { id: n("alice"), type: "human_gate", reads: ["items"], humanGate: { ref: "oversight/hold@stable" } },
      { id: n("bob"), type: "human_gate", reads: ["items"], humanGate: { ref: "oversight/hold@stable" } },
      {
        id: n("J"),
        type: "join",
        reads: ["seen"],
        writes: ["seen"],
        join: {
          branches: [n("alice"), n("bob")],
          mode,
          onBranchError: "skip",
          ...(mode === "quorum" ? { k: 0.5 } : {}),
        },
      },
      { id: n("done"), type: "function", reads: ["seen"], writes: ["note"], function: { ref: "function/done@stable" } },
    ],
    edges: [
      { id: e("ja"), from: n("alice"), to: n("J"), kind: "join", branches: [n("alice"), n("bob")] },
      { id: e("jb"), from: n("bob"), to: n("J"), kind: "join", branches: [n("alice"), n("bob")] },
      { id: e("sq"), from: n("J"), to: n("done"), kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

/**
 * §A.67 WITH A NESTED JOIN AS THE CARRIER (P4), and its own control in one spec.
 *
 * `start --fanout(over "empty")--> ib --join--> IJ` is §A.47's legitimate empty fan when `empty`
 * is `[]`: no member Task materialises, `#fireEmptyJoin` mints the barrier, and IJ SUCCEEDS having
 * folded nothing. `IJ` is then named in the OUTER barrier's `branches` beside `worker`, which
 * throws — so the outer barrier's only real work died and a join that produced nothing carries it.
 *
 * Seed `empty` with entries instead and the SAME graph is the control: IJ folds real contributions
 * and the outer barrier must fold and succeed.
 */
function nestedJoinSpec(mode: string): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "a67-nested-join", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 64, maxDepth: 2, maxFanout: 16, maxLoopIterations: 1 } },
    channels: { ...CHANNELS, empty: { type: "array", reduce: "replace" } },
    inputs: ["items", "empty"],
    outputs: [],
    nodes: [
      { id: n("start"), type: "function", reads: ["items"], function: { ref: "function/seed@stable" } },
      { id: n("ib"), type: "function", reads: ["item"], writes: ["seen"], function: { ref: "function/inner@stable" } },
      {
        id: n("IJ"),
        type: "join",
        reads: ["seen"],
        writes: ["seen"],
        join: { branches: [n("ib")], mode: "all", onBranchError: "skip" },
      },
      { id: n("worker"), type: "function", reads: ["items"], writes: ["seen"], function: { ref: "function/boom@stable" } },
      {
        id: n("OJ"),
        type: "join",
        reads: ["seen"],
        writes: ["seen"],
        join: {
          branches: [n("IJ"), n("worker")],
          mode,
          onBranchError: "skip",
          ...(mode === "quorum" ? { k: 0.5 } : {}),
        },
      },
      { id: n("done"), type: "function", reads: ["seen"], writes: ["note"], function: { ref: "function/done@stable" } },
    ],
    edges: [
      { id: e("fo"), from: n("start"), to: n("ib"), kind: "fanout", over: "empty", as: "item", maxWidth: 4 },
      { id: e("ji"), from: n("ib"), to: n("IJ"), kind: "join", branches: [n("ib")] },
      { id: e("sw"), from: n("start"), to: n("worker"), kind: "seq" },
      { id: e("jo1"), from: n("IJ"), to: n("OJ"), kind: "join", branches: [n("IJ"), n("worker")] },
      { id: e("jo2"), from: n("worker"), to: n("OJ"), kind: "join", branches: [n("IJ"), n("worker")] },
      { id: e("sq"), from: n("OJ"), to: n("done"), kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

interface Result {
  readonly status: string;
  readonly seen: readonly string[];
  readonly note: unknown;
  readonly joinError: string | undefined;
  readonly joinMessage: string;
  readonly doneCommitted: number;
}

function newEngine(store: SqliteStateStore, tools: ToolRegistry = new ToolRegistry()): Engine {
  const functions = new FunctionRegistry();
  functions.register("function/seed@stable", () => ({}));
  functions.register("function/boom@stable", () => {
    throw new Error("boom");
  });
  functions.register("function/work@stable", (view) => {
    const item = view.get<{ id: string }>("item");
    return { writes: { seen: [item?.id ?? "?"] } };
  });
  // The static B1 graph reads `items`, not the fan-out's `item`, so it needs its own body: reusing
  // `function/work@stable` there writes "?" and the assertion would be pinning the probe, not the run.
  functions.register("function/static-work@stable", () => ({ writes: { seen: ["real-work"] } }));
  functions.register("function/inner@stable", () => ({ writes: { seen: ["inner"] } }));
  functions.register("function/done@stable", () => ({ writes: { note: ["done-ran"] } }));
  return new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions,
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: ["fs:write"], systemFloor: "out" },
  });
}

/**
 * Submit, park on the gates, CLOSE THE STORE, and hand the journal to a fresh `Engine` which
 * answers every open gate with `decide` and advances.
 */
async function runAcrossRestart(
  spec: GraphSpec,
  items: readonly unknown[],
  decide: (nodeId: string) => { kind: string; [k: string]: unknown },
  extraInputs: Readonly<Record<string, unknown>> = {},
): Promise<Result> {
  const dir = mkdtempSync(pathJoin(tmpdir(), "a67-"));
  const path = pathJoin(dir, "j.db");
  const graph = compileOrThrow({
    spec,
    resolver: resolver(),
    tools: {},
    tenantCapabilities: SKELETON_TENANT_CAPS,
  });
  try {
    const first = new SqliteStateStore({ path, now: () => NOW });
    const opener = newEngine(first);
    const runId = await opener.submit({ graph, inputs: { items, ...extraInputs } });
    await opener.advance(runId);
    first.close();

    // A FRESH ENGINE OVER THE PARKED JOURNAL. Nothing in memory survives; `p.tasks`, which the
    // fold's whole judgement reads, is rebuilt from rows.
    const second = new SqliteStateStore({ path, now: () => NOW });
    const engine = newEngine(second);
    engine.attach(runId, graph);
    // A loop rather than one pass: answering a gate can open the next one (a second branch's
    // gate is minted only when the fan tops up).
    for (let round = 0; round < 8; round++) {
      const open = (await engine.openGates(runId)).filter((g) => g.state === "open");
      if (open.length === 0) break;
      for (const g of open) {
        await engine.resolveGate(runId, {
          gateId: g.gateId,
          decision: decide(String(g.nodeId)) as never,
          actor: { kind: "human", subject: "u:alice", via: "console" },
          idempotencyKey: `k-${g.gateId}`,
        });
      }
      await engine.advance(runId);
    }
    const p = await engine.advance(runId);
    const log: JournalEvent[] = [];
    for await (const ev of second.read(runId, 1)) log.push(ev);
    const joinFailure = log.find((ev) => ev.type === "task.failed" && String(ev.taskId).startsWith("J@")) as
      | { payload?: { error?: { code?: string; message?: string } } }
      | undefined;
    second.close();
    return {
      status: p.status,
      seen: (p.channels["seen"] as string[]) ?? [],
      note: p.channels["note"],
      joinError: joinFailure?.payload?.error?.code,
      joinMessage: joinFailure?.payload?.error?.message ?? "",
      doneCommitted: log.filter((ev) => ev.type === "task.committed" && String(ev.taskId).startsWith("done@")).length,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type Decision = { kind: string; [k: string]: unknown };
/**
 * Submit, park, CLOSE THE STORE, and hand the journal to a fresh `Engine` that answers the gates
 * in STAGES — `who` first, then everything still open — snapshotting between the two.
 *
 * Staged and not all-at-once because the whole subject is what the fold sees while a member is
 * still LIVE. Answering every gate in one pass makes `worker` terminal before the barrier ever
 * runs, which is the state the defect cannot be seen in.
 */
async function runStaged(
  spec: GraphSpec,
  who: string,
): Promise<{ mid: Result; post: Result; midTasks: string; postTasks: string; replayStatus: string; replayAdvanced: string }> {
  const dir = mkdtempSync(pathJoin(tmpdir(), "a67s-"));
  const path = pathJoin(dir, "j.db");
  const graph = compileOrThrow({ spec, resolver: resolver(), tools: {}, tenantCapabilities: SKELETON_TENANT_CAPS });
  try {
    const first = new SqliteStateStore({ path, now: () => NOW });
    const opener = newEngine(first);
    const runId = await opener.submit({ graph, inputs: { items: [{ id: "a" }] } });
    await opener.advance(runId);
    first.close();

    const second = new SqliteStateStore({ path, now: () => NOW });
    const engine = newEngine(second);
    engine.attach(runId, graph);
    const answer = async (pick: (nodeId: string) => boolean): Promise<void> => {
      for (const g of (await engine.openGates(runId)).filter((x) => x.state === "open" && pick(String(x.nodeId)))) {
        await engine.resolveGate(runId, {
          gateId: g.gateId,
          decision: { kind: "approve" } as never,
          actor: { kind: "human", subject: "u:alice", via: "console" },
          idempotencyKey: `k-${g.gateId}`,
        });
      }
    };
    const snap = async (): Promise<Result> => {
      const pr = await engine.advance(runId);
      const log: JournalEvent[] = [];
      for await (const ev of second.read(runId, 1)) log.push(ev);
      const jf = log.find((ev) => ev.type === "task.failed" && String(ev.taskId).startsWith("J@")) as
        | { payload?: { error?: { code?: string; message?: string } } }
        | undefined;
      return {
        status: pr.status,
        seen: (pr.channels["seen"] as string[]) ?? [],
        note: pr.channels["note"],
        joinError: jf?.payload?.error?.code,
        joinMessage: jf?.payload?.error?.message ?? "",
        doneCommitted: log.filter((ev) => ev.type === "task.committed" && String(ev.taskId).startsWith("done@")).length,
      };
    };
    const tasks = async (): Promise<string> =>
      Object.values((await engine.projection(runId))?.tasks ?? {})
        .map((t) => `${String(t.nodeId)}:${t.state}`)
        .sort()
        .join(" ");

    await answer((id) => id === who);
    const mid = await snap();
    const midTasks = await tasks();
    await answer(() => true);
    const post = await snap();
    const postTasks = await tasks();
    second.close();

    // A THIRD Engine over the FINISHED journal — the replay half (N7).
    const third = new SqliteStateStore({ path, now: () => NOW });
    const replayer = newEngine(third);
    const folded = await replayer.projection(runId);
    replayer.attach(runId, graph);
    const advanced = await replayer.advance(runId);
    third.close();
    return {
      mid,
      post,
      midTasks,
      postTasks,
      replayStatus: folded?.status ?? "(none)",
      replayAdvanced: advanced.status,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const approve = (): Decision => ({ kind: "approve" });
const reject = (): Decision => ({ kind: "reject", reason: "no" });

test("§A.67 — AN APPROVED GATE NO LONGER CARRIES A BARRIER WHOSE WORK ALL DIED, in all four modes", async () => {
  for (const mode of MODES) {
    const where = `mode=${mode}`;
    const r = await runAcrossRestart(gateFanSpec({ mode, body: "function/boom@stable", gateWrites: false }), [
      { id: "a" },
      { id: "b" },
    ], approve);

    // The base read `status=succeeded note=["done-ran"]` on every one of these four lines.
    assert.equal(r.status, "failed", `${where}: two humans approved and every unit of work died`);
    assert.equal(r.joinError, "E_QUORUM_UNREACHABLE", `${where}: and the BARRIER names why`);
    assert.match(
      r.joinMessage,
      /all 2 work task\(s\) it waited on are finished and not one succeeded/,
      `${where}: the message says WORK, and says they are FINISHED — a pending member is not "waited on and failed"`,
    );
    assert.equal(r.doneCommitted, 0, `${where}: nothing behind the barrier runs`);
    assert.equal(r.note, undefined, `${where}: and nothing reaches the channel behind it`);
    assert.deepEqual(r.seen, [], `${where}: the fold had nothing in it, which is the whole point`);
  }
});

test("THE CONTROL — the same graph whose work DOES write folds and succeeds, in all four modes", async () => {
  // Without this, a rule that simply refused every barrier holding a gate would pass the test
  // above. The short-circuiting modes fold ONE branch and `all` folds two, which is also the
  // check that this change did not collapse `any` into `all`.
  for (const mode of MODES) {
    const where = `mode=${mode}`;
    const r = await runAcrossRestart(gateFanSpec({ mode, body: "function/work@stable", gateWrites: false }), [
      { id: "a" },
      { id: "b" },
    ], approve);
    assert.equal(r.status, "succeeded", `${where}: the work behind the humans produced something`);
    assert.equal(r.joinError, undefined, `${where}: so the barrier refuses nothing`);
    assert.equal(r.doneCommitted, 1, `${where}: and the node behind the barrier runs`);
    assert.deepEqual(r.note, ["done-ran"], `${where}: exactly once`);
    assert.equal(
      r.seen.length,
      mode === "all" ? 2 : 1,
      `${where}: a short-circuiting mode folds the first arrival, "all" folds both — seen=${JSON.stringify(r.seen)}`,
    );
  }
});

test("A GATE ANSWERED `edit` IS A WORK MEMBER — the barrier folds the human's own data", async () => {
  // The conjunct that keeps the classification honest. `hold` declares `writes: ["seen"]`, so its
  // `allowEdit` is `["seen"]` and a person may answer with a value. The work behind the gates
  // still throws, so the ONLY thing in the barrier is what the humans wrote — and refusing it
  // would discard the one thing in this run a person actually produced.
  for (const mode of MODES) {
    const where = `mode=${mode}`;
    const r = await runAcrossRestart(gateFanSpec({ mode, body: "function/boom@stable", gateWrites: true }), [
      { id: "a" },
      { id: "b" },
    ], () => ({ kind: "edit", writes: { seen: ["from-a-human"] } }));
    assert.equal(r.status, "succeeded", `${where}: a gate that PRODUCED is not evidence`);
    assert.equal(r.joinError, undefined, `${where}: so the barrier does not refuse`);
    assert.ok(r.seen.includes("from-a-human"), `${where}: and the human's write is folded — ${JSON.stringify(r.seen)}`);
    assert.equal(r.doneCommitted, 1, `${where}: the node behind the barrier runs on it`);
  }
});

test("A REJECTED GATE STILL FAILS THE RUN — §D.9's own shape is not regressed", async () => {
  for (const mode of MODES) {
    const where = `mode=${mode}`;
    const r = await runAcrossRestart(gateFanSpec({ mode, body: "function/work@stable", gateWrites: false }), [
      { id: "a" },
      { id: "b" },
    ], reject);
    assert.equal(r.status, "failed", `${where}: two people said no`);
    assert.equal(r.doneCommitted, 0, `${where}: and the graph behind the barrier did not carry on`);
    assert.deepEqual(r.seen, [], `${where}: nothing was folded`);
  }
});

test("AN EVIDENCE-ONLY BARRIER IS UNCHANGED — one approval folds, every member rejected refuses", async () => {
  // A join ALL of whose members are gates. Nothing there was ever going to be produced, so the
  // work question has no numerator and the fallback is §D.9's rule verbatim. This is the clause
  // that makes the whole change safe without a `JoinSpec` field.
  for (const mode of MODES) {
    const where = `mode=${mode}`;
    const ok = await runAcrossRestart(evidenceOnlySpec(mode), [{ id: "a" }], approve);
    assert.equal(ok.status, "succeeded", `${where}: the humans answered, which is all this barrier is for`);
    assert.equal(ok.joinError, undefined, `${where}: and the fold is not refused for being empty`);
    assert.equal(ok.doneCommitted, 1, `${where}: the write behind the approval lands`);

    const no = await runAcrossRestart(evidenceOnlySpec(mode), [{ id: "a" }], reject);
    assert.equal(no.status, "failed", `${where}: every member lost, which §D.9 already refused`);
    assert.equal(no.doneCommitted, 0, `${where}: and nothing behind it ran`);
  }
});

test("§A.47's EMPTY FAN IS UNCHANGED — a barrier with no member tasks folds and succeeds", async () => {
  // `members.length > 0` is untouched by §A.67 and still separates "the fan materialised nothing"
  // from "the fan materialised two and lost both". A fan-out over an EMPTY channel materialises no
  // member Task at all, gate included, so there is nothing to have succeeded.
  for (const mode of MODES) {
    const where = `mode=${mode}`;
    const r = await runAcrossRestart(gateFanSpec({ mode, body: "function/boom@stable", gateWrites: false }), [], approve);
    assert.equal(r.status, "succeeded", `${where}: an empty fan is a legitimate shape`);
    assert.equal(r.joinError, undefined, `${where}: and the barrier refuses nothing`);
    assert.equal(r.doneCommitted, 1, `${where}: the node behind it runs`);
  }
});

test("THE SHIPPED `examples/graphs/two-person-approval.json`, driven end to end, is unchanged", async () => {
  // The one committed `GraphSpec` whose join names a `human_gate` in `branches` — scanned over all
  // nine of them. It is evidence-only, so the fallback covers it, and these four lines are
  // `a68.mjs`'s output verbatim, before and after.
  //
  // THE SECOND AND THIRD LINES ARE §A.68 AND ARE NOT ENDORSED HERE. Two of three approving does
  // not land the write, because `onBranchError: "fail"` is read before `k` ever matters to a
  // losing arm. That row is open and this file does not answer it; it records the behaviour so a
  // change to it cannot be silent.
  const spec = JSON.parse(
    readFileSync(new URL("../../../../examples/graphs/two-person-approval.json", import.meta.url), "utf8"),
  ) as GraphSpec;
  const WRITE: ToolDefinition = {
    name: "fs.write",
    version: "1.0",
    description: "write",
    capabilities: ["fs:write"],
    irreversibility: "reversible_write",
    idempotent: false,
    parameters: { type: "object", properties: { path: { type: "string" }, body: { type: "string" } } },
    execute: () => ({ content: "written", writes: { written: { ok: true } } }),
  } as unknown as ToolDefinition;

  async function drive(decisions: readonly (readonly [string, string])[]): Promise<{ status: string; wrote: number }> {
    const dir = mkdtempSync(pathJoin(tmpdir(), "a68-"));
    try {
      let wrote = 0;
      const tools = new ToolRegistry();
      tools.register({ ...WRITE, execute: () => {
        wrote++;
        return { content: "written", writes: { written: { ok: true } } };
      } } as unknown as ToolDefinition);
      const store = new SqliteStateStore({ path: pathJoin(dir, "j.db"), now: () => NOW });
      const engine = newEngine(store, tools);
      const graph = compileOrThrow({
        spec,
        resolver: { resolve: (ref: string) => ({ ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" }) } as never,
        tools: { "fs.write": WRITE as never },
        tenantCapabilities: ["fs:write"],
      });
      const runId: RunId = await engine.submit({ graph, inputs: { request: "ship it" } });
      let p = await engine.advance(runId);
      let i = 0;
      for (const [who, how] of decisions) {
        const g = (await engine.openGates(runId)).find((x) => x.state === "open" && String(x.nodeId) === who);
        if (g === undefined) break;
        p = await engine.resolveGate(runId, {
          gateId: g.gateId,
          decision: (how === "approve" ? { kind: "approve" } : { kind: "reject", reason: "no" }) as never,
          actor: { kind: "human", subject: `u:${who}`, via: "api" },
          idempotencyKey: `k${i++}`,
        });
      }
      store.close();
      return { status: p.status, wrote };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  assert.deepEqual(await drive([["alice", "approve"], ["bob", "approve"]]), { status: "awaiting_gate", wrote: 1 });
  assert.deepEqual(
    await drive([["alice", "reject"], ["bob", "approve"], ["carol", "approve"]]),
    { status: "failed", wrote: 0 },
  );
  assert.deepEqual(
    await drive([["alice", "approve"], ["bob", "reject"], ["carol", "approve"]]),
    { status: "failed", wrote: 0 },
  );
  assert.deepEqual(await drive([["alice", "reject"]]), { status: "awaiting_gate", wrote: 0 });
});

test("B1 — A BARRIER THAT RELEASED WHILE ITS WORK IS STILL LIVE MUST NOT REFUSE, in all four modes", async () => {
  // THE REGRESSION §A.67's FIRST CUT SHIPPED, and the reason the refusal needs quiescence.
  //
  // `any`, `firstSuccess` and `quorum` release on `succeeded >= 1` WITHOUT quiescence, and on a
  // STATIC join an approved gate IS that one success. The fold then answered an ABSENCE question —
  // "did no work member succeed?" — over a member set still holding a live task. Measured on the
  // first cut, across the restart below:
  //
  //     mid  status=awaiting_gate [J:failed alice:succeeded worker:awaiting_gate]
  //     post status=failed seen=["real-work"] error=E_QUORUM_UNREACHABLE
  //
  // The run failed WITH the work's own writes already in the channel, under a message saying it
  // did no work. The refusal now also requires every work member to be TERMINAL, so the question
  // is only asked once the answer can no longer change — which is `#maybeFireJoin`'s own rule,
  // "QUIESCENCE GATES THE 'NO' ANSWERS, NOT THE 'YES' ONES", applied to the fold.
  for (const mode of MODES) {
    const where = `mode=${mode}`;
    const r = await runStaged(staticLiveWorkSpec(mode, "function/static-work@stable"), "alice");
    assert.equal(r.mid.joinError, undefined, `${where}: the barrier must not refuse a member that can still arrive — ${r.midTasks}`);
    assert.match(r.midTasks, /worker:awaiting_gate/, `${where}: and the shape is only driven if the worker IS live — ${r.midTasks}`);
    assert.equal(r.post.status, "succeeded", `${where}: the worker then ran and produced`);
    assert.deepEqual(r.post.seen, ["real-work"], `${where}: its writes are in the channel`);
    assert.deepEqual(r.post.note, ["done-ran"], `${where}: and the node behind the barrier ran on them`);
  }
});

test("AND WHEN THE LIVE MEMBER LATER FAILS: the fold is FINAL at release, except where the mode waited", async () => {
  // The question B1 leaves: the barrier released on evidence alone and folded nothing — what
  // happens when the work it did not wait for then dies? MEASURED, not reasoned, and it is
  // UNCHANGED FROM `ee4f1c14` in all four modes, so this pins existing behaviour rather than
  // endorsing new behaviour.
  //
  //   any / firstSuccess / quorum — the barrier committed BEFORE the worker was terminal, so
  //     there is no second fold: the run ends `succeeded` with nothing folded. THE BARRIER DOES
  //     NOT RE-EVALUATE. That is the residue a short-circuiting mode buys by definition — it
  //     released on evidence in hand — and it is out of §A.67's reach for the same reason B1 is:
  //     at fold time the answer could still have changed.
  //   all — waits for quiescence, so the worker IS terminal when the fold runs, and §A.67's
  //     refusal fires exactly as it should: the gate's approval no longer carries a barrier whose
  //     only work died. THIS ONE CHANGES from the base, on a STATIC join, and it is the change
  //     §A.67 is for.
  for (const mode of MODES) {
    const where = `mode=${mode}`;
    const r = await runStaged(staticLiveWorkSpec(mode, "function/boom@stable"), "alice");
    assert.deepEqual(r.post.seen, [], `${where}: nothing was produced either way`);
    if (mode === "all") {
      assert.equal(r.post.status, "failed", `${where}: quiescence means the fold saw the loss`);
      assert.equal(r.post.joinError, "E_QUORUM_UNREACHABLE", `${where}: and the barrier names why`);
      assert.equal(r.post.doneCommitted, 0, `${where}: nothing behind it ran`);
    } else {
      assert.equal(r.post.status, "succeeded", `${where}: the fold was final at release — base reads the same`);
      assert.equal(r.post.joinError, undefined, `${where}: the barrier does not re-evaluate`);
      assert.equal(r.post.doneCommitted, 1, `${where}: and the node behind it had already run`);

      // N7 — REPLAY, ASSERTED HERE BECAUSE THIS IS THE JOURNAL THAT MAKES IT MEAN SOMETHING.
      //
      // "A journal folds to its recorded verdict" is vacuous on a journal the current rule would
      // also produce. THIS one it would not: the finished run records `J: succeeded` (it folded
      // nothing, having released on the gate alone) beside `worker: skipped`, so re-running
      // `#foldJoin` over the FINAL task set — every work member terminal, none succeeded — would
      // refuse it. It is therefore the same shape as a PRE-§A.67 journal of the row's own graph,
      // and it is written by this binary rather than checked in as a fixture nothing can regenerate.
      //
      // A third `Engine` over the closed store reads `succeeded` and advancing it leaves
      // `succeeded`: the decision is RECONSTRUCTED from rows, not recomputed from the rule. That is
      // what "the journal is the only authoritative state" requires, and it is why §A.67 changes
      // what a FRESH advance decides and nothing about what an old journal says.
      assert.match(r.postTasks, /J:succeeded/, `${where}: the recorded fold is a success — ${r.postTasks}`);
      assert.match(r.postTasks, /worker:skipped/, `${where}: beside a work member that is terminal and lost`);
      assert.equal(r.replayStatus, "succeeded", `${where}: a fresh Engine folds the journal to its RECORDED verdict`);
      assert.equal(r.replayAdvanced, "succeeded", `${where}: and advancing a terminal run does not re-judge it`);
    }
  }
});

test("N1 — A ROUTER IS EVIDENCE TOO: §A.67 with no human in it", async () => {
  // `#runRouter` returns `writes: {}` unconditionally, so a router that routed is a decision
  // recorded, not work done — the same sentence as an approved gate. Measured on `ee4f1c14` AND
  // on §A.67's first cut, which classified only `human_gate`: `status=succeeded
  // note=["done-ran"]` in all four modes with every unit of work behind the router dead. This is
  // why `PRODUCES_NOTHING` is a named SET.
  for (const mode of MODES) {
    const where = `mode=${mode}`;
    const dead = await runAcrossRestart(routerFanSpec({ mode, body: "function/boom@stable" }), [{ id: "a" }, { id: "b" }], approve);
    assert.equal(dead.status, "failed", `${where}: a router routed and every unit of work died`);
    assert.equal(dead.joinError, "E_QUORUM_UNREACHABLE", `${where}: the barrier names why`);
    assert.equal(dead.doneCommitted, 0, `${where}: nothing behind it runs`);

    // The control, without which "refuse every barrier holding a router" would pass the above.
    const live = await runAcrossRestart(routerFanSpec({ mode, body: "function/work@stable" }), [{ id: "a" }, { id: "b" }], approve);
    assert.equal(live.status, "succeeded", `${where}: the work behind the router produced`);
    assert.equal(live.joinError, undefined, `${where}: so nothing is refused`);
    assert.equal(live.seen.length, 2, `${where}: and both branches folded — seen=${JSON.stringify(live.seen)}`);
  }
});

test("P1 — A STATIC `quorum` WHOSE `k` ONE SUCCESS CANNOT MEET IS THE THIRD QUIESCENCE SHAPE", async () => {
  // THE REFUSAL FIRES ON A FOLD STATE, NOT ON A LIST OF GRAPHS, and this test exists because an
  // earlier comment enumerated "two shapes" and a third turned up the next day. `#maybeFireJoin`
  // computes `need = k <= 1 ? ceil(k * expected) : k`, so over the SAME two members:
  //
  //   k: 0.5 -> need 1 -> the approved gate short-circuits the barrier while the worker is LIVE,
  //             and the refusal must NOT fire (that is the B1 test above, and it reads `succeeded`)
  //   k: 1   -> need 2 -> one success never fires it, so the barrier falls through to
  //             `noMoreArrivals`, the worker IS terminal at the fold, and the refusal MUST fire
  //
  // One knob, one graph, both sides of the line. Measured: base `succeeded note=["done-ran"]`,
  // here `failed E_QUORUM_UNREACHABLE`.
  const meets = await runStaged(staticLiveWorkSpec("quorum", "function/boom@stable", 0.5), "alice");
  assert.equal(meets.post.status, "succeeded", `k=0.5 short-circuits on the gate, so the fold was final at release`);

  const cannot = await runStaged(staticLiveWorkSpec("quorum", "function/boom@stable", 1), "alice");
  assert.match(cannot.midTasks, /worker:awaiting_gate/, `k=1 must not fire on one success — ${cannot.midTasks}`);
  assert.equal(cannot.mid.joinError, undefined, `and it has not folded yet while the worker can still arrive`);
  assert.equal(cannot.post.status, "failed", `once the worker died, every work member is terminal and none succeeded`);
  assert.equal(cannot.post.joinError, "E_QUORUM_UNREACHABLE", `and the barrier names why`);
  assert.equal(cannot.post.doneCommitted, 0, `nothing behind it ran`);
});

test("P4 — RESIDUE: a nested join over an EMPTY fan still carries an outer barrier, and the cheap fix is worse", async () => {
  // §A.67 WITH A JOIN AS THE CARRIER INSTEAD OF A GATE, and it is NOT closed. §A.47 requires a
  // fan-out over an empty channel to succeed folding nothing, so the inner join is a WORK member
  // that succeeded and produced nothing — exactly what an approved gate was. Measured, zero
  // diagnostics, IDENTICAL on `ee4f1c14` and here, in all four modes:
  //
  //     status=succeeded note=["done-ran"]   IJ:succeeded{} OJ:succeeded{} worker:skipped{}
  //
  // THE OUTER BARRIER'S ONLY REAL WORKER DIED AND THE RUN SAYS IT WORKED. This test pins that as
  // the CURRENT behaviour so it cannot change in silence, and does not endorse it.
  //
  // WHY `join` IS NOT IN `PRODUCES_NOTHING`, measured rather than argued: a ROOT-COORDINATE JOIN
  // ALWAYS RETURNS `writes: {}` — its fold goes out in `reduced` — so the "produced nothing"
  // conjunct cannot tell a root join that folded EVERYTHING from one that folded nothing. Adding
  // `join` to the set was built and run: it closes the first assertion below and turns the SECOND
  // one — the same graph whose inner fan is NOT empty — into
  //
  //     failed seen=["inner","inner"] error=E_QUORUM_UNREACHABLE
  //
  // a run refused with two real contributions already in the channel, under a message saying it did
  // no work. That is B1's defect one layer up, so the second assertion is the control that refutes
  // the cheap fix, and it is the reason this is a row and not a patch.
  //
  // PROPOSED ROW: "A nested join over an EMPTY fan is a WORK member that succeeded producing
  // nothing, so it carries an outer barrier whose real work died." Closing it needs the fold to see
  // a member join's own `branchCount`, which lives in its `state.reduced` payload and is not on
  // `TaskRecord` — a projection question, not an arm of `#foldJoin`.
  //
  // AND SINCE §A.75, A `quorum` OUTER BARRIER AT `need > 1` REFUSES THIS SHAPE ON THE `k` FLOOR —
  // which is why this test staying green is not evidence that nothing changed. `k: 0.5` of two
  // members needs ONE, and `IJ` alone supplies it, so these rows are untouched; at `k: 1` (which is
  // `ceil(1 × 2)`, i.e. BOTH) or `k: 2` the same graph now fails `E_QUORUM_UNREACHABLE` under a
  // message that says what is true — one of two branches produced something and the graph asked for
  // two. That is NOT this row closing and NOT B1's defect returning: the row is about a join
  // counting as work it did not do, and the refusal above is about a count the graph itself
  // declared. Both `k` values are driven in `join-quorum-k-is-a-floor.test.ts`.
  for (const mode of MODES) {
    const where = `mode=${mode}`;
    const empty = await runAcrossRestart(nestedJoinSpec(mode), [{ id: "a" }], approve, { empty: [] });
    assert.equal(empty.status, "succeeded", `${where}: RESIDUE — the empty-fan join carries the barrier`);
    assert.deepEqual(empty.seen, [], `${where}: with nothing folded`);
    assert.deepEqual(empty.note, ["done-ran"], `${where}: and the node behind the barrier ran`);

    // THE CONTROL THAT REFUTES THE CHEAP FIX. Same graph, non-empty inner fan.
    const full = await runAcrossRestart(nestedJoinSpec(mode), [{ id: "a" }], approve, { empty: [{ id: "x" }, { id: "y" }] });
    assert.equal(full.status, "succeeded", `${where}: a root join that folded real work is WORK, not evidence`);
    assert.deepEqual(full.seen, ["inner", "inner"], `${where}: and its contributions are in the channel`);
    assert.equal(full.joinError, undefined, `${where}: nothing is refused`);
  }
});

/**
 * ONE TASK, ONE RUN — a second arrival at a Task that already exists does not re-arm it
 * (`TODO.md` §A.101).
 *
 * `#activate` emits one `task.ready` per edge a commit takes, and the fold's `task.ready` arm
 * upserted `"ready"` over whatever state the Task held. When a node's two arrivals COINCIDE the
 * second row lands on a Task still `ready` and changes nothing, so the node runs once. When the
 * second path is two or more hops longer, the second row lands after the Task COMMITTED, puts a
 * terminal Task back to `ready` under the same Task id, and the node runs AGAIN. Whether a node
 * ran once or twice was a function of hop counts — measured on the shipped binary at `7f576a47`
 * and again at `e59a969a`, every run `succeeded`, with ONE `task b` span in `loom trace`.
 *
 * THE CONTRACT THIS PINS is the one the coincident case already had: a Task is one per
 * `(node, branch, iteration)`, the first arrival readies it, and a later arrival is absorbed. The
 * arrival itself is not lost — `task.committed.take` of the node that sent it names the edge.
 * A `loop` edge mints `iteration + 1`, a DIFFERENT Task, so a back-edge still re-runs its target.
 *
 * Three shapes, each red on the unfixed engine:
 *
 *   1. THE DUPLICATED WRITE. `a→b` beside `a→c→c2→c3→b`: `log` read `[a,c,b,c2,c3,b]`.
 *   2. BOTH ARMS. `s→X` beside `s→m→m1→m3→X`, `X` failing on its first arrival and succeeding on
 *      its second: the run took X's `error` edge AND its success edge.
 *   3. THE STALE PROJECTION. A reader three hops behind X's `error` edge read `"X:error"` as
 *      `{ok: true}` — the re-run had overwritten the failure the arm was routed on.
 *
 * And the two halves of the fix, since either alone passes 1–3:
 *
 *   4. THE FOLD. A journal that ALREADY holds a late `task.ready` — an older binary's, or anyone's
 *      — folds it without moving a terminal Task, and a restarted process attached to it runs
 *      nothing twice. The fold is what a restart reads.
 *   5. A `human_gate`. (a) An arrival after the human approved re-ran the approved Task on the
 *      decision already on file and ran everything behind it twice — one approval, two actions.
 *      (b) An arrival while the target is still `leased` is the case the fold CANNOT refuse,
 *      because `rewind` re-arms a `leased` Task with the same row — so the engine does not write
 *      it: `#activate` mints no Task the fresh projection already holds.
 *
 * And the barrier the re-run was carrying:
 *
 *   6. A static join whose member committed while another path into its ancestry still ran. The
 *      barrier stood down at the member's commit, and unfixed the late arrival RE-RAN the member,
 *      whose second commit asked it again. Absorbing that arrival stranded the join — `succeeded`
 *      with the node behind it never run. A settled barrier is now released between waves from
 *      the projection AFTER every commit (`#releaseSettledBarriers`), which also closes the same
 *      strand reached with no arrival at all (a `conditional` not taken), PRE-EXISTING on
 *      `e59a969a`. 6z: a barrier no member ever reached still does not release, as on base.
 *   7. A run bound to fail on a NON-member releases nothing — `deploy` behind the join never
 *      commits (7b's one-hop shape committed it on `e59a969a`).
 *   8. Nested fan-outs with a skipped inner item: nothing releases before its last arrival — the
 *      shape a first, commit-time re-ask got wrong (10 of 48 configurations lost a branch).
 *   9. A holder `awaiting_gate` is live: answering ANOTHER gate does not release the barrier.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId, RunId, TaskId } from "../../src/ids.ts";
import type { HumanActor, JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { foldRun } from "../../src/run/projection.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const NOW = 1_700_000_000_000;
const n = (id: string): NodeId => id as NodeId;
const alice: HumanActor = { kind: "human", subject: "u:alice", via: "console" };

type Body = Parameters<FunctionRegistry["register"]>[1];

function fn(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: n(id), type: "function", reads: ["seed"], writes: ["log"], function: { ref: `function/${id}@stable` }, ...extra };
}

function graphSpec(name: string, nodes: readonly unknown[], edges: readonly [string, string, string, string?][], channels: Record<string, unknown> = {}, outputs: readonly string[] = ["log"]): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name, project: "probe", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 16, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
    channels: {
      seed: { type: "string", reduce: "replace" },
      log: { type: "array", reduce: "append_ordered" },
      ...channels,
    },
    inputs: ["seed"],
    outputs,
    nodes,
    // Every `conditional` edge in this file is one that is NOT taken: `seed` is always "x".
    edges: edges.map(([id, from, to, kind]) => ({
      id: id as EdgeId,
      from: n(from),
      to: n(to),
      kind: kind ?? "seq",
      ...(kind === "conditional" ? { when: 'seed == "never"' } : {}),
    })),
  } as unknown as GraphSpec;
}

/** Every body appends its own node id to `log`, unless `bodies` says otherwise. */
function engineFor(store: MemoryStateStore, ids: readonly string[], bodies: Record<string, Body>, maxParallelism: number): Engine {
  const functions = new FunctionRegistry();
  for (const id of ids) functions.register(`function/${id}@stable`, bodies[id] ?? (() => ({ writes: { log: [id] } })));
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);
  return new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models,
    now: () => NOW,
    maxParallelism,
    policy: { granted: [], budget: { runUsd: 1 } },
  });
}

async function journal(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) out.push(ev);
  return out;
}

const rows = (log: readonly JournalEvent[], type: string, taskId: string): number =>
  log.filter((ev) => ev.type === type && ev.taskId === taskId).length;

// ── 1 · the duplicated write ────────────────────────────────────────────────

const SHAPE1 = graphSpec(
  "rearrival",
  ["a", "b", "c", "c2", "c3"].map((id) => fn(id)),
  [
    ["ab", "a", "b"],
    ["ac", "a", "c"],
    ["cc2", "c", "c2"],
    ["c2c3", "c2", "c3"],
    ["c3b", "c3", "b"],
  ],
);

// The binary runs at `maxParallelism: 4`. Whether the arrivals coincide is a function of how many
// Tasks a wave holds, and the defect was that function: 4 and 16 ran b twice unfixed, while 1 is
// the CONTROL — serially b is still `ready` when c3's arrival lands, and it ran once even then.
for (const par of [1, 4, 16]) {
  test(`1 · a late second arrival does not re-run a committed Task — b writes once (maxParallelism ${par})`, async () => {
    const store = new MemoryStateStore({ now: () => NOW });
    const engine = engineFor(store, ["a", "b", "c", "c2", "c3"], {}, par);
    const graph = compileOrThrow({ spec: SHAPE1, resolver: resolver(), tools: {}, tenantCapabilities: [] });
    const runId = await engine.submit({ graph, inputs: { seed: "x" } });
    const p = await engine.advance(runId);

    assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
    const log = p.outputs?.["log"] as string[];
    assert.equal(log.filter((x) => x === "b").length, 1, `b ran more than once: ${JSON.stringify(log)}`);
    assert.deepEqual([...log].sort(), ["a", "b", "c", "c2", "c3"]);

    const j = await journal(store, runId);
    assert.equal(rows(j, "task.committed", "b@root#0"), 1, "one commit for the one Task b is");
    assert.equal(rows(j, "task.leased", "b@root#0"), 1, "b was leased twice");
    // The arrival is not lost: c3's own commit names the edge it took.
    const c3 = j.find((ev) => ev.type === "task.committed" && ev.taskId === "c3@root#0");
    assert.deepEqual((c3?.payload as unknown as { take: string[] }).take, ["c3b"]);
  });
}

// ── 2 and 3 · both arms, and the stale projection ───────────────────────────

/**
 * `s→X` beside `s→m→m1→m3→X`. X throws unless `gate` is `"open"`, which only m3 writes — so X's
 * FIRST arrival fails it, deterministically, and a second run would succeed. X's success edge goes
 * to `ok`; its `error` edge to `h1→h2→h3→h4`, and h4 reads `"X:error"` into `seen`.
 */
const SHAPE2 = graphSpec(
  "botharms",
  [
    fn("s"),
    fn("m"),
    fn("m1"),
    fn("m3", { writes: ["log", "gate"] }),
    fn("X", { reads: ["gate"] }),
    fn("ok"),
    fn("h1"),
    fn("h2"),
    fn("h3"),
    fn("h4", { reads: ["X:error"], writes: ["log", "seen"] }),
  ],
  [
    ["sX", "s", "X"],
    ["sm", "s", "m"],
    ["mm1", "m", "m1"],
    ["m1m3", "m1", "m3"],
    ["m3X", "m3", "X"],
    ["Xok", "X", "ok"],
    ["Xerr", "X", "h1", "error"],
    ["h12", "h1", "h2"],
    ["h23", "h2", "h3"],
    ["h34", "h3", "h4"],
  ],
  { gate: { type: "string", reduce: "replace" }, seen: { type: "object", reduce: "replace" } },
  ["log", "seen"],
);

const SHAPE2_BODIES: Record<string, Body> = {
  m3: () => ({ writes: { log: ["m3"], gate: "open" } }),
  X: (view) => {
    if (view.get("gate") !== "open") throw new Error("gate not open yet");
    return { writes: { log: ["X"] } };
  },
  h4: (view) => ({ writes: { log: ["h4"], seen: view.get("X:error") } }),
};

async function runShape2(par: number): Promise<{ log: string[]; seen: unknown; j: JournalEvent[]; status: string }> {
  const store = new MemoryStateStore({ now: () => NOW });
  const ids = ["s", "m", "m1", "m3", "X", "ok", "h1", "h2", "h3", "h4"];
  const engine = engineFor(store, ids, SHAPE2_BODIES, par);
  const graph = compileOrThrow({ spec: SHAPE2, resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { seed: "x" } });
  const p = await engine.advance(runId);
  return { log: (p.outputs?.["log"] as string[]) ?? [], seen: p.outputs?.["seen"], j: await journal(store, runId), status: p.status };
}

// NOT `maxParallelism: 1`: serially, X's first arrival is still `ready` when m3's lands, so X runs
// once and SUCCEEDS — the shape has no failure to route. The binary's default is 4.
for (const par of [4, 16]) {
  test(`2 · a Task that FAILED and routed its error arm is not re-run into its success arm (maxParallelism ${par})`, async () => {
    const r = await runShape2(par);
    assert.equal(r.status, "succeeded");
    assert.equal(rows(r.j, "task.committed", "X@root#0"), 1, "X committed twice");
    assert.ok(r.log.includes("h1"), "the error arm ran");
    assert.equal(r.log.includes("ok"), false, `the success arm ran too: ${JSON.stringify(r.log)}`);
    assert.equal(r.log.includes("X"), false, "X's re-run wrote");
    assert.equal(rows(r.j, "task.ready", "ok@root#0"), 0, "the success arm's node was readied");
  });

  test(`3 · a reader behind the error arm reads the failure it was routed on, not {ok:true} (maxParallelism ${par})`, async () => {
    const r = await runShape2(par);
    const seen = r.seen as { ok?: unknown; message?: unknown } | undefined;
    assert.equal(seen?.ok, false, `h4 read X:error as ${JSON.stringify(r.seen)}`);
    assert.match(String(seen?.message), /gate not open yet/);
  });
}

// ── 4 · the fold ────────────────────────────────────────────────────────────

/**
 * A journal as an older binary wrote it: SHAPE1 at `maxParallelism: 4`, with the late `task.ready`
 * for b spliced in right after c3's commit, where `#activate` appended it. `at` is c3's commit.
 */
async function lateRowJournal(): Promise<{ runId: RunId; graph: ReturnType<typeof compileOrThrow>; spliced: JournalEvent[]; late: JournalEvent; at: number }> {
  const store = new MemoryStateStore({ now: () => NOW });
  // `maxParallelism: 4`, the width at which b commits BEFORE c3 — the precondition of a LATE row.
  const engine = engineFor(store, ["a", "b", "c", "c2", "c3"], {}, 4);
  const graph = compileOrThrow({ spec: SHAPE1, resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { seed: "x" } });
  await engine.advance(runId);
  const j = await journal(store, runId);

  // The row an older binary appended with c3's commit, spliced in where it appended it.
  const at = j.findIndex((ev) => ev.type === "task.committed" && ev.taskId === "c3@root#0");
  const bAt = j.findIndex((ev) => ev.type === "task.committed" && ev.taskId === "b@root#0");
  assert.ok(bAt > 0 && bAt < at, "b must have committed before the row that arrives late");
  const late: JournalEvent = {
    ...j[at]!,
    type: "task.ready",
    payload: { nodeId: "b", branchPath: "root", edgesIn: ["c3b"] },
    taskId: "b@root#0" as TaskId,
  } as unknown as JournalEvent;
  const spliced = [...j.slice(0, at + 1), late, ...j.slice(at + 1)].map((ev, i) => ({ ...ev, seq: i + 1 })) as JournalEvent[];
  return { runId, graph, spliced, late, at };
}

test("4a · a journal ALREADY holding a late task.ready folds it without moving a terminal Task", async () => {
  const { spliced, late, at } = await lateRowJournal();

  // EVERY TERMINAL STATE, each reached by its own row after b's commit.
  const ending: Record<string, { type: string; payload: unknown } | undefined> = {
    succeeded: undefined,
    failed: { type: "task.failed", payload: { error: { class: "internal", code: "E_X", message: "x", retryable: false }, attempt: 1 } },
    skipped: { type: "task.skipped", payload: { reason: "x" } },
    cancelled: { type: "task.cancelled", payload: { clean: true, reason: "x" } },
  };
  for (const terminal of ["succeeded", "failed", "skipped", "cancelled"] as const) {
    const end = ending[terminal];
    const upTo = [
      ...spliced.slice(0, at + 1),
      ...(end === undefined ? [] : [{ ...late, ...end, seq: at + 2 } as unknown as JournalEvent]),
    ];
    const before = foldRun(upTo)!;
    assert.equal(before.tasks["b@root#0" as TaskId]?.state, terminal);
    const after = foldRun([...upTo, { ...late, seq: upTo.length + 1 } as JournalEvent])!;
    assert.equal(after.tasks["b@root#0" as TaskId]?.state, terminal, `a late task.ready moved a ${terminal} Task to ${after.tasks["b@root#0" as TaskId]?.state}`);
    assert.deepEqual(after.tasks["b@root#0" as TaskId]?.edgesIn, before.tasks["b@root#0" as TaskId]?.edgesIn);
  }
});

test("4b · a process restarted on that journal runs nothing twice — a restart IS the fold", async () => {
  // The journal ends on the late row: c3 committed, the run not yet completed.
  const { runId, graph, spliced, at } = await lateRowJournal();
  const store2 = new MemoryStateStore({ now: () => NOW });
  let seq = 0;
  for (const ev of spliced.slice(0, at + 2)) {
    const r = await store2.append({
      runId,
      expectedSeq: seq as never,
      events: [{ type: ev.type, payload: ev.payload, actor: ev.actor, ...(ev.taskId === undefined ? {} : { taskId: ev.taskId }) } as never],
    });
    seq = r.seq as number;
  }
  const fresh = engineFor(store2, ["a", "b", "c", "c2", "c3"], {}, 4);
  fresh.attach(runId, graph);
  const p = await fresh.advance(runId);
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  const log = p.outputs?.["log"] as string[];
  assert.equal(log.filter((x) => x === "b").length, 1, `the restarted process re-ran b: ${JSON.stringify(log)}`);
  assert.equal(rows(await journal(store2, runId), "task.leased", "b@root#0"), 1);
});

// ── 5 · a human_gate, which is where a second run costs the most ────────────

/** `s→G` beside `s→…chain…→G`, G a `human_gate`, then `G→after`. */
function gateShape(chain: readonly string[]): GraphSpec {
  const path = ["s", ...chain, "G"];
  return graphSpec(
    "gate-rearrival",
    [
      fn("s"),
      ...chain.map((id) => fn(id)),
      { id: n("G"), type: "human_gate", reads: ["seed"], writes: ["log"], humanGate: { ref: "oversight/demo-write@stable" } },
      fn("after"),
    ],
    [
      ["sG", "s", "G"],
      ...path.slice(0, -1).map((from, i) => [`p${i}`, from, path[i + 1]!] as [string, string, string]),
      ["Gafter", "G", "after"],
    ],
  );
}

async function driveGate(chain: readonly string[]): Promise<{ status: string; log: string[]; j: JournalEvent[]; decisions: number }> {
  const store = new MemoryStateStore({ now: () => NOW });
  const engine = engineFor(store, ["s", ...chain, "after"], {}, 4);
  const graph = compileOrThrow({ spec: gateShape(chain), resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { seed: "x" } });
  let p = await engine.advance(runId);
  let decisions = 0;
  // Bounded: a correct run is asked once. The bound is what turns "asked forever" into a failure.
  for (let i = 0; i < 4 && p.status === "awaiting_gate"; i++) {
    const open = (await engine.openGates(runId)).filter((g) => g.state === "open");
    if (open.length === 0) break;
    await engine.resolveGate(runId, { gateId: open[0]!.gateId, decision: { kind: "approve" }, actor: alice, idempotencyKey: `k${i}` });
    decisions++;
    p = await engine.advance(runId);
  }
  return { status: p.status, log: (p.outputs?.["log"] as string[]) ?? [], j: await journal(store, runId), decisions };
}

/**
 * `s→m→m1→m3→G`: the late arrival lands after the human APPROVED. Unfixed, the approved gate
 * Task was re-readied, re-committed on the decision already on file — no second question — and
 * everything behind it ran twice: `log` read `[s,m,m1,m3,after,after]` on ONE approval.
 */
test("5a · an arrival after the human approved does not re-run the gate — the work behind one approval runs once", async () => {
  const r = await driveGate(["m", "m1", "m3"]);
  assert.equal(r.status, "succeeded");
  assert.equal(r.decisions, 1);
  assert.equal(r.j.filter((ev) => ev.type === "gate.raised").length, 1);
  assert.equal(rows(r.j, "task.committed", "G@root#0"), 1, "the approved gate Task committed twice");
  assert.deepEqual(r.log.filter((x) => x === "after"), ["after"], `the approved work ran more than once: ${JSON.stringify(r.log)}`);
});

/**
 * `s→m3→G`: m3 commits while G is still LEASED — its own commit, which raises the gate, has not
 * landed. The fold cannot refuse that row: `rewind` re-arms a `leased` Task with the very same
 * `task.ready`, so `leased → ready` has to stay a transition the fold performs. What keeps an
 * arrival from being folded as a re-arm is the WRITER not writing it, and that is the engine's
 * half — `#activate` does not mint a Task the projection already holds.
 *
 * Unfixed this run still ends right in-process (G's own commit overwrites the `ready` and the
 * gate is asked once), which is why the pin is the journal: G is readied ONCE, and nothing puts
 * an in-flight Task back to `ready` behind its worker's back.
 */
test("5b · an arrival while the target is still LEASED is not written as a re-arm", async () => {
  const r = await driveGate(["m3"]);
  assert.equal(r.status, "succeeded");
  assert.equal(r.decisions, 1);
  assert.equal(rows(r.j, "task.ready", "G@root#0"), 1, "a second task.ready for G — the fold reads it as a re-arm of the in-flight Task");
  assert.deepEqual(r.log.filter((x) => x === "after"), ["after"]);
});

// ── 6 · a barrier whose re-evaluation the re-run was carrying ───────────────

/**
 * A static join over `m`, where a second path into `m`'s ancestry is still running when `m`
 * commits. `#maybeFireJoin` stands down at that commit — the running path statically reaches a
 * member, so an arrival looks possible — and unfixed, the arrival came: it re-ran the node and
 * `m` committed AGAIN, which re-asked the barrier and fired it. With the re-run gone, nothing
 * re-asked it: `J` never ran and the run still said `succeeded` (found by lane K's reviewer).
 *
 * So a settled barrier is released between waves, from the projection AFTER every commit so far
 * (`#releaseSettledBarriers`) — not from the committing Task's view before its own append, which
 * a first attempt used and which released nested fan-outs' outer barriers early (see 8).
 */
function joinShape(
  name: string,
  nodes: readonly string[],
  edges: readonly [string, string, string, string?][],
  members: readonly string[] = ["m"],
  after = "done",
): GraphSpec {
  const spec = graphSpec(name, [...nodes, after].map((id) => fn(id)), [...edges, ["jd", "J", after]]) as unknown as {
    nodes: unknown[];
    edges: unknown[];
  };
  spec.nodes.push({ id: n("J"), type: "join", reads: ["log"], writes: ["log"], join: { branches: members.map(n), mode: "all", onBranchError: "skip" } });
  for (const m of members) spec.edges.push({ id: `j-${m}` as EdgeId, from: n(m), to: n("J"), kind: "join", branches: members.map(n) });
  return spec as unknown as GraphSpec;
}

const JOIN_SHAPES: readonly [string, GraphSpec][] = [
  [
    "the fan-in is UPSTREAM of the member: start→p beside start→a→a1→a2→p, p→m",
    joinShape("join-upstream", ["start", "a", "a1", "a2", "p", "m"], [
      ["sp", "start", "p"],
      ["sa", "start", "a"],
      ["aa1", "a", "a1"],
      ["a1a2", "a1", "a2"],
      ["a2p", "a2", "p"],
      ["pm", "p", "m"],
    ]),
  ],
  [
    // PRE-EXISTING, on `e59a969a` too: the holder ends because its path is not TAKEN. The same
    // missing re-ask, reached without any arrival at all.
    "the holder's path is not taken: start→m beside start→a→a1 -conditional(false)→ a2→m",
    joinShape("join-not-taken", ["start", "a", "a1", "a2", "m"], [
      ["sm", "start", "m"],
      ["sa", "start", "a"],
      ["aa1", "a", "a1"],
      ["a1a2", "a1", "a2", "conditional"],
      ["a2m", "a2", "m"],
    ]),
  ],
  [
    "the fan-in IS the member: start→m beside start→a→a1→a2→m",
    joinShape("join-at-member", ["start", "a", "a1", "a2", "m"], [
      ["sm", "start", "m"],
      ["sa", "start", "a"],
      ["aa1", "a", "a1"],
      ["a1a2", "a1", "a2"],
      ["a2m", "a2", "m"],
    ]),
  ],
];

for (const [label, spec] of JOIN_SHAPES) {
  for (const par of [1, 4, 16]) {
    test(`6 · the barrier is asked again when the path holding it ends — ${label} (maxParallelism ${par})`, async () => {
      const store = new MemoryStateStore({ now: () => NOW });
      const engine = engineFor(store, ["start", "a", "a1", "a2", "p", "m", "done"], {}, par);
      const graph = compileOrThrow({ spec, resolver: resolver(), tools: {}, tenantCapabilities: [] });
      const runId = await engine.submit({ graph, inputs: { seed: "x" } });
      const p = await engine.advance(runId);
      const log = (p.outputs?.["log"] as string[]) ?? [];
      assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
      const j = await journal(store, runId);
      assert.equal(rows(j, "task.committed", "J@root#0"), 1, `the barrier never fired: ${JSON.stringify(log)}`);
      assert.deepEqual(log.filter((x) => x === "done"), ["done"], JSON.stringify(log));
      assert.deepEqual(log.filter((x) => x === "m"), ["m"], `the member ran more than once: ${JSON.stringify(log)}`);
    });
  }
}


/**
 * THE OTHER HALF OF THE RULE: a barrier NO member ever reached does not release. The only member
 * sits behind a `conditional` that is not taken, so no member Task exists — and base never fired
 * this join either. Releasing it would run `done` on a branch the graph chose not to take.
 */
for (const par of [1, 4]) {
  test(`6z · a barrier whose only member was never reached does not release (maxParallelism ${par})`, async () => {
    const store = new MemoryStateStore({ now: () => NOW });
    const engine = engineFor(store, ["start", "m", "done"], {}, par);
    const spec = joinShape("join-zero-members", ["start", "m"], [["sm", "start", "m", "conditional"]]);
    const graph = compileOrThrow({ spec, resolver: resolver(), tools: {}, tenantCapabilities: [] });
    const runId = await engine.submit({ graph, inputs: { seed: "x" } });
    const p = await engine.advance(runId);
    const j = await journal(store, runId);
    assert.equal(rows(j, "task.ready", "J@root#0"), 0, "a barrier with no member released");
    assert.deepEqual(p.outputs?.["log"], ["start"]);
  });
}

// ── 7 · a run that is failing releases nothing behind a barrier ─────────────

const THROWS: Record<string, Body> = {
  x: () => {
    throw new Error("x fails, and nothing handles it");
  },
};

async function driveFailing(spec: GraphSpec, par: number): Promise<{ status: string; j: JournalEvent[]; log: unknown }> {
  const store = new MemoryStateStore({ now: () => NOW });
  const engine = engineFor(store, ["start", "a", "x", "m", "m1", "m2", "deploy"], THROWS, par);
  const graph = compileOrThrow({ spec, resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { seed: "x" } });
  const p = await engine.advance(runId);
  return { status: p.status, j: await journal(store, runId), log: p.channels["log"] };
}

for (const par of [1, 4]) {
  test(`7a · start→x(throws)→m -join→ J→deploy never commits deploy (maxParallelism ${par})`, async () => {
    const r = await driveFailing(joinShape("fail-before-member", ["start", "x", "m"], [["sx", "start", "x"], ["xm", "x", "m"]], ["m"], "deploy"), par);
    assert.equal(r.status, "failed");
    assert.equal(rows(r.j, "task.committed", "deploy@root#0"), 0, `deploy ran in a failing run: ${JSON.stringify(r.log)}`);
  });

  // The holder path to m2 FAILS with nothing to handle it, beside a member m1 that arrives. Once
  // both are over the barrier looks settled — m1 terminal, nothing live reaches m2 — and releasing
  // it commits `deploy` in a run `#finish` is about to fail. Two hop counts, because the two
  // askers meet it at different instants: x one hop from `start` fails BEFORE m1 commits, so m1's
  // own commit is what would release (PRE-EXISTING: `deploy` committed on `e59a969a`, at par 1 and
  // 4); x two hops away fails AFTER, so only the between-waves pass could.
  for (const [hops, spec] of [
    ["x one hop out", joinShape("fail-beside-1", ["start", "x", "m1", "m2"], [["s1", "start", "m1"], ["sx", "start", "x"], ["x2", "x", "m2"]], ["m1", "m2"], "deploy")],
    ["x two hops out", joinShape("fail-beside-2", ["start", "a", "x", "m1", "m2"], [["s1", "start", "m1"], ["sa", "start", "a"], ["ax", "a", "x"], ["x2", "x", "m2"]], ["m1", "m2"], "deploy")],
  ] as const) {
    test(`7b · a holder that FAILS unhandled does not release the barrier it held — ${hops} (maxParallelism ${par})`, async () => {
      const r = await driveFailing(spec, par);
      assert.equal(r.status, "failed");
      assert.equal(rows(r.j, "task.ready", "J@root#0"), 0, "the barrier released in a failing run");
      assert.equal(rows(r.j, "task.committed", "deploy@root#0"), 0, `deploy ran in a failing run: ${JSON.stringify(r.log)}`);
    });
  }
}

// ── 8 · nested fan-outs: nothing releases before its last arrival ───────────

/**
 * `join-nesting.test.ts`'s shape with an inner body that throws for one item under
 * `onBranchError: "skip"`. Round 1 of this fix re-asked the outer barrier from the committing
 * inner branch, from the projection before its own append — which could not see the inner join
 * that append released, or `#topUpFanout`'s next branch — and released `outerJoin` early: 10 of 48
 * configurations, a whole outer branch's contributions lost (`["A0","finish saw [\"A0\"]"]` where
 * base read `["A0","B0",…]`). A representative 16 of those 48, each asserted against the answer
 * computed from the items, which is also base's.
 */
function nestedSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "nested-skip", project: "probe", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 64, maxDepth: 3, maxFanout: 16, maxLoopIterations: 1 } },
    channels: {
      seed: { type: "string", reduce: "replace" },
      log: { type: "array", reduce: "append_ordered" },
      outerSeed: { type: "array", reduce: "replace" },
      innerSeed: { type: "array", reduce: "replace" },
      outerItem: { type: "object", reduce: "replace" },
      innerItem: { type: "object", reduce: "replace" },
    },
    inputs: ["seed", "outerSeed", "innerSeed"],
    outputs: ["log"],
    nodes: [
      { id: n("start"), type: "function", reads: ["outerSeed"], function: { ref: "function/start@stable" } },
      { id: n("outer"), type: "function", reads: ["outerItem"], function: { ref: "function/outer@stable" } },
      { id: n("inner"), type: "function", reads: ["innerItem", "outerItem"], writes: ["log"], function: { ref: "function/inner@stable" } },
      { id: n("innerJoin"), type: "join", reads: ["log"], writes: ["log"], join: { branches: [n("inner")], mode: "all", onBranchError: "skip" } },
      { id: n("outerJoin"), type: "join", reads: ["log"], writes: ["log"], join: { branches: [n("outer"), n("innerJoin")], mode: "all", onBranchError: "skip" } },
      { id: n("finish"), type: "function", reads: ["log"], writes: ["log"], function: { ref: "function/finish@stable" } },
    ],
    edges: [
      { id: "fo", from: n("start"), to: n("outer"), kind: "fanout", over: "outerSeed", as: "outerItem", maxWidth: 8 },
      { id: "fi", from: n("outer"), to: n("inner"), kind: "fanout", over: "innerSeed", as: "innerItem", maxWidth: 8 },
      { id: "ji", from: n("inner"), to: n("innerJoin"), kind: "join", branches: [n("inner")] },
      { id: "jo1", from: n("outer"), to: n("outerJoin"), kind: "join", branches: [n("outer")] },
      { id: "jo2", from: n("innerJoin"), to: n("outerJoin"), kind: "join", branches: [n("innerJoin")] },
      { id: "done", from: n("outerJoin"), to: n("finish"), kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

for (const ow of [1, 2]) {
  for (const iw of [2, 3]) {
    for (const par of [1, 3]) {
      for (const failing of ["first", "last"] as const) {
        test(`8 · nested fan-out, one inner item throws — no barrier releases before its last arrival (outer ${ow}, inner ${iw}, par ${par}, fail ${failing})`, async () => {
          const fails = (i: number): boolean => (failing === "first" ? i === 0 : i === 1);
          const store = new MemoryStateStore({ now: () => NOW });
          const engine = engineFor(store, ["start", "outer", "inner", "finish"], {
            start: () => ({}),
            outer: () => ({}),
            inner: (view) => {
              const o = view.get<{ o: string }>("outerItem")?.o;
              const i = view.get<{ i: number }>("innerItem")?.i ?? -1;
              if (fails(i)) throw new Error(`boom ${o}${i}`);
              return { writes: { log: [`${o}${i}`] } };
            },
            finish: (view) => ({ writes: { log: [`finish saw ${JSON.stringify(view.get("log"))}`] } }),
          }, par);
          const graph = compileOrThrow({ spec: nestedSpec(), resolver: resolver(), tools: {}, tenantCapabilities: [] });
          const outers = ["A", "B"].slice(0, ow);
          const runId = await engine.submit({
            graph,
            inputs: { seed: "x", outerSeed: outers.map((o) => ({ o })), innerSeed: Array.from({ length: iw }, (_, i) => ({ i })) },
          });
          const p = await engine.advance(runId);
          const j = await journal(store, runId);

          const released = j.find((ev) => ev.type === "task.ready" && ev.taskId === "outerJoin@root#0");
          assert.ok(released !== undefined, "the outer barrier never released");
          const lateMembers = j.filter(
            (ev) => ev.type === "task.committed" && ev.seq > released.seq && /^(outer|innerJoin)@/.test(String(ev.taskId)),
          );
          assert.deepEqual(lateMembers.map((ev) => ev.taskId), [], "a member of the outer barrier committed after it released");

          const survived = outers.flatMap((o) => Array.from({ length: iw }, (_, i) => i).filter((i) => !fails(i)).map((i) => `${o}${i}`));
          assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
          assert.deepEqual(p.outputs?.["log"], [...survived, `finish saw ${JSON.stringify(survived)}`]);
        });
      }
    }
  }
}

// ── 9 · a holder waiting on a person is live ────────────────────────────────

/**
 * The between-waves pass counts EVERY live state as a holder, not only `ready` — and the one a
 * run meets there in-process is `awaiting_gate`: answering one of two open gates resumes the run
 * while the other still waits. Here `m1` has arrived, `G2` is the only way to `m2`, and the
 * human answers `G1` first. Releasing then would fold `m1` alone and lose `m2`.
 */
test("9 · a barrier whose holder is still awaiting a person does not release when ANOTHER gate is answered", async () => {
  const gate = (id: string): Record<string, unknown> => ({
    id: n(id),
    type: "human_gate",
    reads: ["seed"],
    writes: ["log"],
    humanGate: { ref: "oversight/demo-write@stable" },
  });
  const spec = joinShape(
    "gate-holder",
    ["start", "m1", "m2", "g1after"],
    [["s1", "start", "m1"], ["sg1", "start", "G1"], ["sg2", "start", "G2"], ["g1a", "G1", "g1after"], ["g2m", "G2", "m2"]],
    ["m1", "m2"],
  ) as unknown as { nodes: unknown[] };
  spec.nodes.push(gate("G1"), gate("G2"));
  const store = new MemoryStateStore({ now: () => NOW });
  const engine = engineFor(store, ["start", "m1", "m2", "g1after", "done"], {}, 4);
  const graph = compileOrThrow({ spec: spec as unknown as GraphSpec, resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { seed: "x" } });
  let p = await engine.advance(runId);
  assert.equal(p.status, "awaiting_gate");
  const byNode = async (id: string) => (await engine.openGates(runId)).find((g) => g.state === "open" && g.nodeId === id);
  assert.ok((await byNode("G1")) !== undefined && (await byNode("G2")) !== undefined, "both gates are open at once");

  await engine.resolveGate(runId, { gateId: (await byNode("G1"))!.gateId, decision: { kind: "approve" }, actor: alice, idempotencyKey: "g1" });
  p = await engine.advance(runId);
  assert.equal(rows(await journal(store, runId), "task.ready", "J@root#0"), 0, "the barrier released while G2 still held m2's path");

  await engine.resolveGate(runId, { gateId: (await byNode("G2"))!.gateId, decision: { kind: "approve" }, actor: alice, idempotencyKey: "g2" });
  p = await engine.advance(runId);
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  const j = await journal(store, runId);
  const released = j.find((ev) => ev.type === "task.ready" && ev.taskId === "J@root#0");
  const m2 = j.find((ev) => ev.type === "task.committed" && ev.taskId === "m2@root#0");
  assert.ok(released !== undefined && m2 !== undefined && m2.seq < released.seq, "the barrier released before m2 arrived");
  assert.deepEqual(p.outputs?.["log"], ["start", "m1", "g1after", "m2", "done"]);
});

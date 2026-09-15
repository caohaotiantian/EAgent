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
 * so approving completes it; every other node type has work behind the gate."* A field would be a second
 * spelling of a fact the spec already states, new replay vocabulary in the one artifact
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
 * shipped file itself. `examples/graphs/two-person-approval.json` is three `human_gate` nodes
 * under one quorum join and nothing else — the composition `ApprovalSpec` was stripped of `mode`
 * and `k` in favour of. Nothing there was ever going to be produced, so "did any work succeed" has
 * no numerator, and the fallback is §D.9's rule verbatim: one approval folds, every member lost
 * refuses. All four of `a68.mjs`'s decision sets read identically before and after this change.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO: it does not touch §A.68. The shipped graph's
 * `onBranchError: "fail"` still fails the run on ONE rejection whatever the other two people say,
 * and the assertion below records that as the CURRENT behaviour rather than endorsing it.
 *
 * EVERY GATED CASE IS DRIVEN ACROSS A RESTART — the run is parked by one `Engine`, its store
 * closed, and a FRESH `Engine` over the same SQLite file attaches, answers the gates and advances.
 * That is not decoration either: the fold reads `p.tasks`, which a restart rebuilds from rows, and
 * this project's own lens asks of every decision what it does on a restart that hands its state
 * back empty.
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
    const runId = await opener.submit({ graph, inputs: { items } });
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
      /work task\(s\) it waited on succeeded/,
      `${where}: the message says WORK, so a reader is not told the gates failed`,
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

/**
 * A `quorum` JOIN'S `k` IS A FLOOR, NOT A SHORT-CIRCUIT THRESHOLD — §A.75.
 *
 * `#maybeFireJoin` releases every mode once no further arrival is possible
 * (`noMoreArrivals = quiescent && terminal >= expected`), which is §A.55's answer and is right: a
 * barrier nothing can still reach must not hang. But `#foldJoin` held only two arms that could
 * notice what the release CARRIED — `onBranchError === "fail" && skipped > 0`, and §D.9/§A.67's
 * "not one of its work members succeeded" — and neither of them reads `k`. So a barrier that
 * released because nothing more could arrive folded as a SUCCESS with fewer branches than its own
 * `k` demanded. Under `onBranchError: "fail"` the first arm masked it (any loss fails the run
 * before the count matters), which is why no shipped graph ever showed it. Under `"skip"` nothing
 * did.
 *
 * THE MATRIX IS THE TEST, and it is the row's own. Measured on the shipped
 * `examples/graphs/two-person-approval.json` — three `human_gate` nodes under one
 * `quorum k: 2` join — with `onBranchError` changed from `"fail"` to `"skip"` and nothing else
 * (`.agent/engine-a75-a76/a68-skip.mjs`, on `6fb2e618`):
 *
 *     [["alice","reject"],["bob","approve"],["carol","approve"]] succeeded wrote=["ship it"]   <- wanted
 *     [["alice","reject"],["bob","reject"],["carol","reject"]]   failed    E_QUORUM_UNREACHABLE <- wanted
 *     [["alice","reject"],["bob","reject"],["carol","approve"]]  succeeded wrote=["ship it"]   <- NOT wanted
 *     [["alice","approve"],["bob","reject"],["carol","reject"]]  succeeded wrote=["ship it"]   <- NOT wanted
 *     [["alice","reject"],["bob","approve"],["carol","reject"]]  succeeded wrote=["ship it"]   <- NOT wanted
 *
 * ONE approval of three met `k: 2`, in all three orderings: k-of-n was any-of-n. The three
 * NOT-wanted lines now refuse and the two wanted lines are unchanged, which is the whole of the
 * row's closing condition.
 *
 * THE GRAPH IS THIS FILE'S OWN COPY of that shape, deliberately. The shipped example stays
 * `onBranchError: "fail"` — §A.68 refused to switch it, because under `skip` two rejections plus
 * one approval used to LAND the write, and that is the fail-OPEN direction. This file is where the
 * `skip` variant is allowed to exist.
 *
 * AND THE OTHER THREE MODES ARE CONTROLS, on the same release path, because "independent of
 * `onBranchError`" is only half the claim — the other half is that this arm touches no mode that
 * declares no count:
 *
 *   - `all` requires ARRIVAL, not success: its only exit IS `noMoreArrivals`, so every planned
 *     branch is in by construction, and what to do with one that died is `onBranchError`'s
 *     question. One approval of three still folds under `skip`.
 *   - `any` and `firstSuccess` require one success, and §D.9's arm already refuses a fold with
 *     none. One approval of three still folds.
 *
 * THE UNIT THE FLOOR IS COUNTED IN is held by "THE UNIT: a DEGRADED branch counts" and by nothing
 * else in this file — the earlier claim that "the last test" held it was FALSE, and the way it was
 * false is the reusable part: every gate-driven test above puts ONE node in each branch, where
 * "branches that produced something" and "arrivals at the barrier" are the same number, so swapping
 * `contributed` for `#maybeFireJoin`'s `succeeded` left all of them green. That mutation was run:
 * with `contributed` replaced by `succeeded`, exactly one test in this file goes red, and it is that
 * one. The shapes where the two units differ need a branch of TWO nodes (`head -seq-> tail`), which
 * is what that test builds.
 *
 * What the unit means: a branch that PRODUCED something counts, even if a later member of it then
 * died. That is `onBranchError: "skip"`'s own reading of a degraded branch
 * (`join-all-branches-fail.test.ts`, `join-evidence-and-work.test.ts`), and requiring `k` ARRIVALS
 * instead would refuse three shapes this runtime decided to fold, with the humans' own writes
 * already in the barrier.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { CODES } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { NodeId, RunId, Seq } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import type { ToolDefinition } from "../../src/run/registry.ts";

const NOW = 1_700_000_000_000;
const APPROVERS = ["alice", "bob", "carol"] as const;

const WRITE = {
  name: "fs.write",
  version: "1.0",
  description: "write",
  capabilities: ["fs:write"],
  irreversibility: "reversible_write",
  idempotent: false,
  parameters: { type: "object", properties: { path: { type: "string" }, body: { type: "string" } } },
} as unknown as ToolDefinition;

const resolver = {
  resolve: (ref: string) => ({ ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" }),
} as never;

/** The shipped `two-person-approval` shape, with `mode`, `k` and `onBranchError` as parameters. */
function approvalSpec(opts: {
  readonly mode: string;
  readonly k?: number;
  readonly onBranchError: "fail" | "skip";
}): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "a75-quorum-floor", project: "probe", version: 1 },
    policy: { posture: "out", capabilities: ["fs:write"] },
    channels: {
      request: { type: "string", reduce: "replace" },
      signoffs: { type: "array", reduce: "append_ordered" },
      written: { type: "object", reduce: "replace" },
    },
    inputs: ["request"],
    outputs: ["written"],
    nodes: [
      ...APPROVERS.map((who) => ({
        id: who,
        type: "human_gate",
        reads: ["request"],
        writes: ["signoffs"],
        humanGate: { ref: "oversight/ship@stable", approval: { approvers: [`u:${who}`] } },
      })),
      {
        id: "quorum",
        type: "join",
        reads: ["signoffs"],
        writes: ["signoffs"],
        join: {
          branches: [...APPROVERS],
          mode: opts.mode,
          onBranchError: opts.onBranchError,
          ...(opts.k === undefined ? {} : { k: opts.k }),
        },
      },
      {
        id: "save",
        type: "tool",
        reads: ["request"],
        writes: ["written"],
        unhandled: true,
        tool: { name: "fs.write", version: "1.0", args: { path: "approved/request.txt", body: "${request}" } },
      },
    ],
    edges: [
      ...APPROVERS.map((who, i) => ({ id: `j${i}`, from: who, to: "quorum", kind: "join" })),
      { id: "then", from: "quorum", to: "save", kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

type Answer = readonly [(typeof APPROVERS)[number], "approve" | "reject"];

async function drive(
  spec: GraphSpec,
  decisions: readonly Answer[],
): Promise<{
  readonly status: string;
  readonly wrote: readonly string[];
  readonly error: string | undefined;
  readonly joinError: string | undefined;
  readonly joinMessage: string | undefined;
}> {
  const wrote: string[] = [];
  const now = (): number => NOW;
  const store = new MemoryStateStore({ now });
  const tools = new ToolRegistry();
  tools.register({
    ...WRITE,
    execute: (a: Record<string, unknown>) => {
      wrote.push(String(a["body"] ?? ""));
      return { content: "written", writes: { written: { ok: true } } };
    },
  } as unknown as ToolDefinition);
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now,
    sleep: async () => {},
    policy: { granted: ["fs:write"], systemFloor: "out" },
  });
  const graph = compileOrThrow({ spec, resolver, tools: { "fs.write": WRITE as never }, tenantCapabilities: ["fs:write"] });
  const runId: RunId = await engine.submit({ graph, inputs: { request: "ship it" } });
  let p = await engine.advance(runId);
  let i = 0;
  for (const [who, how] of decisions) {
    const gate = Object.values(p.gates).find((g) => g.state === "open" && String(g.nodeId) === (who as string as NodeId));
    if (gate === undefined) break;
    p = await engine.resolveGate(runId, {
      gateId: gate.gateId,
      decision: (how === "approve" ? { kind: "approve" } : { kind: "reject", reason: "no" }) as never,
      actor: { kind: "human", subject: `u:${who}`, via: "api" },
      idempotencyKey: `k${i++}`,
    });
  }
  const log: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) log.push(ev);
  const jf = log.find((ev) => ev.type === "task.failed" && String(ev.taskId).startsWith("quorum@")) as
    | { payload?: { error?: { code?: string; message?: string } } }
    | undefined;
  return {
    status: p.status,
    wrote,
    error: p.error?.code,
    joinError: jf?.payload?.error?.code,
    joinMessage: jf?.payload?.error?.message,
  };
}

test("§A.75 — THE WHOLE FIVE-LINE MATRIX, on `quorum k: 2` of three under `onBranchError: \"skip\"`", async () => {
  const spec = approvalSpec({ mode: "quorum", k: 2, onBranchError: "skip" });

  // THE TWO WANTED LINES, which must not move.
  const two = await drive(spec, [["alice", "reject"], ["bob", "approve"], ["carol", "approve"]]);
  assert.equal(two.status, "succeeded", "two of three approving meets k: 2");
  assert.deepEqual(two.wrote, ["ship it"], "so the write behind the barrier lands");
  assert.equal(two.joinError, undefined, "and the barrier refuses nothing");

  const none = await drive(spec, [["alice", "reject"], ["bob", "reject"], ["carol", "reject"]]);
  assert.equal(none.status, "failed", "three rejections is a refusal");
  assert.equal(none.error, "E_QUORUM_UNREACHABLE", "under the code this door already raises");
  assert.deepEqual(none.wrote, [], "and nothing was written");

  // THE THREE THAT HAD TO MOVE: one approval of three, in every ordering. `k` is a floor, so the
  // ordering cannot matter — and it did not before either, which is why all three are here.
  const orderings: readonly (readonly Answer[])[] = [
    [["alice", "reject"], ["bob", "reject"], ["carol", "approve"]],
    [["alice", "approve"], ["bob", "reject"], ["carol", "reject"]],
    [["alice", "reject"], ["bob", "approve"], ["carol", "reject"]],
  ];
  for (const decisions of orderings) {
    const where = JSON.stringify(decisions);
    const one = await drive(spec, decisions);
    assert.equal(one.status, "failed", `${where}: one approval does not meet k: 2`);
    assert.equal(one.error, "E_QUORUM_UNREACHABLE", `${where}: refused by the barrier's own requirement`);
    assert.equal(one.joinError, "E_QUORUM_UNREACHABLE", `${where}: and the join Task is where it is named`);
    assert.deepEqual(one.wrote, [], `${where}: the write behind the barrier does NOT land`);
  }
});

test("§A.75 — the refusal names `k`, the count and the width, so an operator can act on it", async () => {
  // The message is what separates this arm from §D.9's — both raise `E_QUORUM_UNREACHABLE`, and
  // "nothing succeeded" and "not enough succeeded" send a reader to different places.
  const store = new MemoryStateStore({ now: () => NOW });
  const tools = new ToolRegistry();
  tools.register({ ...WRITE, execute: () => ({ content: "written", writes: { written: { ok: true } } }) } as unknown as ToolDefinition);
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: ["fs:write"], systemFloor: "out" },
  });
  const graph = compileOrThrow({
    spec: approvalSpec({ mode: "quorum", k: 2, onBranchError: "skip" }),
    resolver,
    tools: { "fs.write": WRITE as never },
    tenantCapabilities: ["fs:write"],
  });
  const runId: RunId = await engine.submit({ graph, inputs: { request: "ship it" } });
  let p = await engine.advance(runId);
  let i = 0;
  for (const [who, how] of [["alice", "approve"], ["bob", "reject"], ["carol", "reject"]] as readonly Answer[]) {
    const gate = Object.values(p.gates).find((g) => g.state === "open" && String(g.nodeId) === who);
    if (gate === undefined) break;
    p = await engine.resolveGate(runId, {
      gateId: gate.gateId,
      decision: (how === "approve" ? { kind: "approve" } : { kind: "reject", reason: "no" }) as never,
      actor: { kind: "human", subject: `u:${who}`, via: "api" },
      idempotencyKey: `k${i++}`,
    });
  }
  assert.equal(p.status, "failed");
  assert.match(
    String(p.error?.message ?? ""),
    /mode "quorum" needs 2 of 3 branch\(es\) to have produced something and 1 did/,
    `the message says the count and the width — got: ${String(p.error?.message)}`,
  );
  // AND IT CLAIMS THE RULE, NOT A CAUSE. The first draft said "the barrier released because no
  // further arrival is possible", which this method cannot know: `#maybeFireJoin` returns a
  // `task.ready` row carrying no reason, and the release counts ARRIVALS where the fold counts
  // branches that PRODUCED, so a short-circuit release can reach this arm and the sentence would be
  // false when it did. "PRODUCED" and not "succeeded" for the same reason the count is
  // `contributed`: the degraded branch this arm deliberately counts did not succeed.
  assert.match(
    String(p.error?.message ?? ""),
    /`k` is a floor the fold enforces whatever `onBranchError` says/,
    `and states the rule rather than guessing which release branch fired — got: ${String(p.error?.message)}`,
  );
  assert.doesNotMatch(
    String(p.error?.message ?? ""),
    /released because|no further arrival/,
    `no causal claim about the release: ${String(p.error?.message)}`,
  );
});

test("§A.75 — `onBranchError: \"fail\"` is unchanged, and THAT is why this was never visible", async () => {
  // The shipped example's own posture, and the reason §A.68 measured the `skip` variant to find
  // this at all: under `"fail"` the FIRST rejection ends the run — `E_HUMAN_APPROVAL_REQUIRED`,
  // raised at the gate and carrying the human's refusal, not at the barrier — so the fold's arms
  // are never reached and no count of anything is ever taken. Two of three approving does not land
  // the write, which is §A.68's recorded behaviour and is not endorsed here; it is pinned so the
  // new arm cannot be mistaken for having changed it.
  const spec = approvalSpec({ mode: "quorum", k: 2, onBranchError: "fail" });
  const one = await drive(spec, [["alice", "reject"], ["bob", "approve"], ["carol", "approve"]]);
  assert.equal(one.status, "failed", "a rejection fails the run under `fail`");
  assert.equal(one.error, "E_HUMAN_APPROVAL_REQUIRED", "at the gate, carrying the human's own refusal");
  // The barrier's own refusal comes from the MASKING arm — `onBranchError === "fail" && skipped >
  // 0`, which is above the new one and fires on the single lost branch, so `k` is never reached.
  assert.equal(one.joinError, "E_QUORUM_UNREACHABLE", "the barrier refuses too, on the arm above this one");
  assert.match(
    String(one.joinMessage ?? ""),
    /1 branch\(es\) failed and onBranchError is "fail"/,
    `the masking arm, not the k floor — got: ${String(one.joinMessage)}`,
  );
  assert.deepEqual(one.wrote, [], "and the write does not land");
});

test("§A.75 — the other three modes declare no count, and this arm does not touch them", async () => {
  // Every one of these releases through `noMoreArrivals` with ONE of three members succeeded, on
  // exactly the path the `quorum` matrix above refuses.
  for (const mode of ["all", "any", "firstSuccess"] as const) {
    const r = await drive(approvalSpec({ mode, onBranchError: "skip" }), [
      ["alice", "approve"],
      ["bob", "reject"],
      ["carol", "reject"],
    ]);
    assert.equal(r.status, "succeeded", `mode=${mode}: one success is all this mode asks for`);
    assert.equal(r.joinError, undefined, `mode=${mode}: so the barrier refuses nothing`);
    assert.deepEqual(r.wrote, ["ship it"], `mode=${mode}: and the write behind it lands`);
  }
});

test("§A.75 — `k` below 1 is a FRACTION of the width, and the floor is read the same way", async () => {
  // `quorumNeed` is the one place `k <= 1 ? ceil(k * expected) : k` lives, and the fold now reads
  // it too. `k: 0.5` of three needs TWO, so one approval refuses and two fold — the same boundary
  // as `k: 2`, reached through the other branch of that expression.
  const spec = approvalSpec({ mode: "quorum", k: 0.5, onBranchError: "skip" });
  const one = await drive(spec, [["alice", "approve"], ["bob", "reject"], ["carol", "reject"]]);
  assert.equal(one.status, "failed", "ceil(0.5 * 3) is 2, so one approval is short");
  assert.equal(one.error, "E_QUORUM_UNREACHABLE", "refused");
  const two = await drive(spec, [["alice", "approve"], ["bob", "approve"], ["carol", "reject"]]);
  assert.equal(two.status, "succeeded", "and two meets it");
  assert.deepEqual(two.wrote, ["ship it"], "so the write lands");

  // `k: 1` means the whole width, not "one of them" — the other end of the same expression.
  const whole = await drive(approvalSpec({ mode: "quorum", k: 1, onBranchError: "skip" }), [
    ["alice", "approve"],
    ["bob", "approve"],
    ["carol", "reject"],
  ]);
  assert.equal(whole.status, "failed", "ceil(1 * 3) is 3, so two of three is short");
  assert.equal(whole.error, "E_QUORUM_UNREACHABLE", "refused");
});

/**
 * §A.47's EMPTY FAN, WITH AN ABSOLUTE `k` — the boundary the fraction hides.
 *
 * A fan-out over an EMPTY channel is a legitimate shape and must fold nothing and SUCCEED: it
 * materialises no member Task at all, so the barrier has nothing to have succeeded, and that is
 * what `members.length > 0` separates from "the fan materialised two and lost both" in §D.9's arm.
 * The new `k` floor needs the same guard and for the same reason, and `k: 0.5` cannot show it —
 * `ceil(0.5 * 0)` is 0, so a fractional quorum is satisfied by an empty fan by accident. An
 * ABSOLUTE `k` is not: `k: 2` over a width of nothing is `need: 2`, and without the guard the
 * empty fan fails `E_QUORUM_UNREACHABLE` where §A.47 requires it to succeed. `#fireEmptyJoin`
 * releases that barrier on its own path and the mode's predicate is never consulted, so a fold
 * enforcing `k` there would be enforcing a requirement the release never claimed.
 */
function emptyFanSpec(k: number): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "a75-empty-fan", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 64, maxDepth: 2, maxFanout: 16, maxLoopIterations: 1 } },
    channels: {
      items: { type: "array", reduce: "replace" },
      item: { type: "object", reduce: "replace" },
      seen: { type: "array", reduce: "append_ordered" },
      note: { type: "array", reduce: "append_ordered" },
    },
    inputs: ["items"],
    outputs: [],
    nodes: [
      { id: "start", type: "function", reads: ["items"], function: { ref: "function/seed@stable" } },
      { id: "b0", type: "function", reads: ["item"], writes: ["seen"], function: { ref: "function/work@stable" } },
      {
        id: "J",
        type: "join",
        reads: ["seen"],
        writes: ["seen"],
        join: { branches: ["b0"], mode: "quorum", k, onBranchError: "skip" },
      },
      { id: "done", type: "function", reads: ["seen"], writes: ["note"], function: { ref: "function/done@stable" } },
    ],
    edges: [
      { id: "fo", from: "start", to: "b0", kind: "fanout", over: "items", as: "item", maxWidth: 4 },
      { id: "jn0", from: "b0", to: "J", kind: "join", branches: ["b0"] },
      { id: "sq", from: "J", to: "done", kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

test("§A.75 — an EMPTY fan still folds and succeeds, at an absolute `k` as well as a fractional one", async () => {
  for (const k of [0.5, 2]) {
    const store = new MemoryStateStore({ now: () => NOW });
    const functions = new FunctionRegistry();
    functions.register("function/seed@stable", () => ({ writes: {} }));
    functions.register("function/work@stable", (view) => ({ writes: { seen: [String((view.get<{ id?: string }>("item") ?? {}).id)] } }));
    functions.register("function/done@stable", () => ({ writes: { note: ["done-ran"] } }));
    const engine = new Engine({
      store,
      bus: new InProcessEventBus({ store }),
      tools: new ToolRegistry(),
      functions,
      models: new ModelRegistry(),
      now: () => NOW,
      sleep: async () => {},
      policy: { granted: [], budget: { runUsd: 1 } },
    });
    const graph = compileOrThrow({ spec: emptyFanSpec(k), resolver, tools: {}, tenantCapabilities: [] });
    const runId: RunId = await engine.submit({ graph, inputs: { items: [] } });
    const p = await engine.advance(runId);
    assert.equal(p.status, "succeeded", `k=${k}: an empty fan is a legitimate shape — ${JSON.stringify(p.error ?? {})}`);
    assert.deepEqual(p.channels["note"], ["done-ran"], `k=${k}: and the node behind the barrier runs`);
  }
});

// ─── the FUNCTION-driven half: what the `contributed` unit actually holds ─────────────────
//
// Everything above drives the gate shape, where every branch is ONE node and `contributed` and
// "arrivals at the barrier" are the same number. That is why they could not hold the unit: mutating
// `contributed` to count arrivals leaves every one of them green. The shapes below are the ones
// where the two differ, and they are what the choice is pinned by.

const FN_CHANNELS = {
  items: { type: "array", reduce: "replace" },
  item: { type: "object", reduce: "replace" },
  seen: { type: "array", reduce: "append_ordered" },
  note: { type: "array", reduce: "append_ordered" },
} as const;

type Item = { readonly id: string; readonly headDies?: boolean; readonly tailDies?: boolean };

/** `start -fanout(2)-> head -seq-> tail -join-> J -seq-> done`; each item says which member dies. */
function degradedFanSpec(k: number): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "a75-degraded-fan", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 32, maxDepth: 2, maxFanout: 8, maxLoopIterations: 1 } },
    channels: FN_CHANNELS,
    inputs: ["items"],
    outputs: [],
    nodes: [
      { id: "start", type: "function", reads: ["items"], function: { ref: "function/seed@stable" } },
      { id: "head", type: "function", reads: ["item"], writes: ["seen"], function: { ref: "function/head@stable" } },
      { id: "tail", type: "function", reads: ["item"], function: { ref: "function/tail@stable" } },
      {
        id: "J",
        type: "join",
        reads: ["seen"],
        writes: ["seen"],
        join: { branches: ["head", "tail"], mode: "quorum", k, onBranchError: "skip" },
      },
      { id: "done", type: "function", reads: ["seen"], writes: ["note"], function: { ref: "function/done@stable" } },
    ],
    edges: [
      { id: "fo", from: "start", to: "head", kind: "fanout", over: "items", as: "item", maxWidth: 2 },
      { id: "sq", from: "head", to: "tail", kind: "seq" },
      // Both members need their own `kind: join` edge — §A.56's rule.
      { id: "jn0", from: "head", to: "J", kind: "join", branches: ["head", "tail"] },
      { id: "jn1", from: "tail", to: "J", kind: "join", branches: ["head", "tail"] },
      // WITHOUT THIS EDGE `done` HAS NO INBOUND ONE AND IS AN ENTRY NODE, so it runs whatever the
      // barrier decides and `note` stops being a signal about the barrier at all. Measured while
      // writing this file: `J@root#0=failed` beside `done@root#0=succeeded`.
      { id: "jd", from: "J", to: "done", kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

/**
 * §A.70's shape: `start -fanout(over "empty")-> ib -join-> IJ`, `start -seq-> worker (throws)`,
 * `OJ.branches: ["IJ","worker"]`. With `empty: []` the inner fan is §A.47's legitimate empty one and
 * `IJ` succeeds having folded nothing; with entries it folds real contributions. Either way the
 * outer barrier's only WORK member died and `IJ` carries it, which is the residue §A.70 records.
 */
function nestedSpec(k: number): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "a75-nested-join", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 64, maxDepth: 2, maxFanout: 16, maxLoopIterations: 1 } },
    channels: { ...FN_CHANNELS, empty: { type: "array", reduce: "replace" } },
    inputs: ["items", "empty"],
    outputs: [],
    nodes: [
      { id: "start", type: "function", reads: ["items"], function: { ref: "function/seed@stable" } },
      { id: "ib", type: "function", reads: ["item"], writes: ["seen"], function: { ref: "function/inner@stable" } },
      { id: "IJ", type: "join", reads: ["seen"], writes: ["seen"], join: { branches: ["ib"], mode: "all", onBranchError: "skip" } },
      { id: "worker", type: "function", reads: ["items"], writes: ["seen"], function: { ref: "function/boom@stable" } },
      {
        id: "OJ",
        type: "join",
        reads: ["seen"],
        writes: ["seen"],
        join: { branches: ["IJ", "worker"], mode: "quorum", k, onBranchError: "skip" },
      },
      { id: "done", type: "function", reads: ["seen"], writes: ["note"], function: { ref: "function/done@stable" } },
    ],
    edges: [
      { id: "fo", from: "start", to: "ib", kind: "fanout", over: "empty", as: "item", maxWidth: 4 },
      { id: "ji", from: "ib", to: "IJ", kind: "join", branches: ["ib"] },
      { id: "sw", from: "start", to: "worker", kind: "seq" },
      { id: "jo1", from: "IJ", to: "OJ", kind: "join", branches: ["IJ", "worker"] },
      { id: "jo2", from: "worker", to: "OJ", kind: "join", branches: ["IJ", "worker"] },
      { id: "sq", from: "OJ", to: "done", kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

/** `start -fanout(over items)-> b0 -join-> J -seq-> done`; every branch succeeds. Width is an input. */
function narrowFanSpec(k: number): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "a75-narrow-fan", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 32, maxDepth: 2, maxFanout: 8, maxLoopIterations: 1 } },
    channels: FN_CHANNELS,
    inputs: ["items"],
    outputs: [],
    nodes: [
      { id: "start", type: "function", reads: ["items"], function: { ref: "function/seed@stable" } },
      { id: "b0", type: "function", reads: ["item"], writes: ["seen"], function: { ref: "function/head@stable" } },
      { id: "J", type: "join", reads: ["seen"], writes: ["seen"], join: { branches: ["b0"], mode: "quorum", k, onBranchError: "skip" } },
      { id: "done", type: "function", reads: ["seen"], writes: ["note"], function: { ref: "function/done@stable" } },
    ],
    edges: [
      { id: "fo", from: "start", to: "b0", kind: "fanout", over: "items", as: "item", maxWidth: 4 },
      { id: "jn", from: "b0", to: "J", kind: "join", branches: ["b0"] },
      { id: "sq", from: "J", to: "done", kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

/** Drive a function-only graph to quiescence and read the barrier's own verdict out of its journal. */
async function runFunctions(
  spec: GraphSpec,
  inputs: Record<string, unknown>,
  joinNodeId: string,
): Promise<{
  readonly status: string;
  readonly error: string | undefined;
  readonly seen: unknown;
  readonly note: unknown;
  readonly joinError: string | undefined;
  readonly joinMessage: string | undefined;
}> {
  const store = new MemoryStateStore({ now: () => NOW });
  const functions = new FunctionRegistry();
  functions.register("function/seed@stable", () => ({ writes: {} }));
  functions.register("function/head@stable", (view) => {
    const item = view.get<Item>("item") ?? { id: "?" };
    if (item.headDies === true) throw new Error(`head ${item.id} failed`);
    return { writes: { seen: [item.id] } };
  });
  functions.register("function/tail@stable", (view) => {
    const item = view.get<Item>("item") ?? { id: "?" };
    if (item.tailDies === true) throw new Error(`tail ${item.id} failed`);
    return { writes: {} };
  });
  functions.register("function/inner@stable", () => ({ writes: { seen: ["inner"] } }));
  for (const arm of ["a", "b", "c"]) functions.register(`function/arm-${arm}@stable`, () => ({ writes: { seen: [arm] } }));
  functions.register("function/boom@stable", () => {
    throw new Error("worker failed");
  });
  functions.register("function/done@stable", () => ({ writes: { note: ["done-ran"] } }));
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    maxParallelism: 8,
    policy: { granted: [], budget: { runUsd: 1 } },
  });
  const graph = compileOrThrow({ spec, resolver, tools: {}, tenantCapabilities: [] });
  const runId: RunId = await engine.submit({ graph, inputs });
  const p = await engine.advance(runId);
  const log: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1 as Seq)) log.push(ev);
  const jf = log.find((ev) => ev.type === "task.failed" && String(ev.taskId).startsWith(`${joinNodeId}@`)) as
    | { payload?: { error?: { code?: string; message?: string } } }
    | undefined;
  return {
    status: p.status,
    error: p.error?.code,
    seen: p.channels["seen"],
    note: p.channels["note"],
    joinError: jf?.payload?.error?.code,
    joinMessage: jf?.payload?.error?.message,
  };
}

test("§A.75 — THE UNIT: a DEGRADED branch counts, because `onBranchError: \"skip\"` folds it on purpose", async () => {
  // THE MUTATION THIS EXISTS TO KILL. `contributed` counts branches that PRODUCED something;
  // `#maybeFireJoin`'s `succeeded` counts ARRIVALS, and excludes a member that handed off inside the
  // branch set. On this graph every branch hands `head -> tail`, so ARRIVALS is `tail` alone and a
  // branch whose `head` wrote and whose `tail` then threw arrives as nothing. Both branches are that
  // shape here, so arrivals is 0 while `contributed` is 2 — and `k: 2` tells the two apart.
  const both = await runFunctions(degradedFanSpec(2), { items: [{ id: "a", tailDies: true }, { id: "b", tailDies: true }] }, "J");
  assert.equal(both.status, "succeeded", `two degraded branches still meet k: 2 — ${JSON.stringify(both)}`);
  assert.equal(both.joinError, undefined, "the barrier refuses nothing");
  assert.deepEqual(both.seen, ["a", "b"], "and what each branch produced before it died survives the fold");
  assert.deepEqual(both.note, ["done-ran"], "so the node behind the barrier runs");

  // THE MIRROR, on the same graph: one branch produced, the other died before producing anything.
  // `contributed` is 1, so `k: 1` folds and `k: 2` refuses — the floor, read in the unit the fold
  // counts in. Under the arrivals unit BOTH would refuse, which is what makes this pair the pin.
  // `k: 0.5` of two is `need: 1`; `k: 1` would be `ceil(1 * 2)`, i.e. BOTH, which is the other leg.
  const items: readonly Item[] = [{ id: "a", tailDies: true }, { id: "b", headDies: true }];
  const met = await runFunctions(degradedFanSpec(0.5), { items }, "J");
  assert.equal(met.status, "succeeded", `one produced branch meets need 1 — ${JSON.stringify(met)}`);
  assert.deepEqual(met.seen, ["a"], "folding what the surviving branch produced");
  assert.deepEqual(met.note, ["done-ran"], "and the node behind the barrier runs");

  const short = await runFunctions(degradedFanSpec(2), { items }, "J");
  assert.equal(short.status, "failed", `one produced branch does not meet k: 2 — ${JSON.stringify(short)}`);
  assert.equal(short.joinError, CODES.E_QUORUM_UNREACHABLE, "named by the barrier");
  assert.equal(
    short.joinMessage,
    'join "J": mode "quorum" needs 2 of 2 branch(es) to have produced something and 1 did — ' +
      "`k` is a floor the fold enforces whatever `onBranchError` says",
    `the message is in the unit it counted and claims nothing about which release branch fired — got: ${String(short.joinMessage)}`,
  );
  assert.equal(short.note, undefined, "and nothing behind the barrier ran");
});

test("§A.75 — §A.70's shape at `need > 1`: an empty-fan join can no longer carry a barrier whose work died", async () => {
  // §A.70 (`join-evidence-and-work.test.ts`'s P4) records that an inner join over an EMPTY fan is a
  // WORK member that succeeded producing nothing, so it carries an outer barrier whose only real
  // worker threw — and the run reported `succeeded`. That row is NOT closed here: its closing
  // condition is `#foldJoin` being able to read a member join's own `branchCount`, which is a
  // projection question. What changed is that a `quorum` outer barrier asking for more branches than
  // survived now refuses on the `k` floor, which covers the shape for `need > 1` and for no other
  // reason. `k: 0.5` of two needs ONE, which `IJ` alone supplies, so P4's own rows are untouched —
  // that is why P4 stayed green and why P4 is not evidence about this arm either way.
  for (const [k, status] of [[0.5, "succeeded"], [1, "failed"], [2, "failed"]] as const) {
    const r = await runFunctions(nestedSpec(k), { items: [{ id: "a" }], empty: [] }, "OJ");
    assert.equal(r.status, status, `empty inner fan, k=${k} — ${JSON.stringify(r)}`);
    if (status === "failed") {
      assert.equal(r.joinError, CODES.E_QUORUM_UNREACHABLE, `k=${k}: named by the outer barrier`);
      assert.equal(r.note, undefined, `k=${k}: and the node behind it did not run`);
    } else {
      assert.deepEqual(r.note, ["done-ran"], "k=0.5: unchanged — one of two branches meets it");
    }
  }

  // P4'S CONTROL, the same graph with a NON-empty inner fan, and the honest half of this change.
  // At `k: 1` the outer barrier asks for BOTH branches and gets one, so the run is refused WITH two
  // real contributions already in the channel. That reads like §A.67's B1 defect and is not it: B1
  // was a message saying the run did no work, and this message says what is true — one of two
  // branches produced something and the graph asked for two. A graph that wants the surviving half
  // folded writes `k: 0.5`, which is the assertion directly above this one.
  const fullMet = await runFunctions(nestedSpec(0.5), { items: [{ id: "a" }], empty: [{ id: "x" }, { id: "y" }] }, "OJ");
  assert.equal(fullMet.status, "succeeded", `k=0.5 folds the inner contributions — ${JSON.stringify(fullMet)}`);
  assert.deepEqual(fullMet.seen, ["inner", "inner"], "which are in the channel");

  const fullShort = await runFunctions(nestedSpec(1), { items: [{ id: "a" }], empty: [{ id: "x" }, { id: "y" }] }, "OJ");
  assert.equal(fullShort.status, "failed", `k=1 wants both branches — ${JSON.stringify(fullShort)}`);
  assert.equal(
    fullShort.joinMessage,
    'join "OJ": mode "quorum" needs 2 of 2 branch(es) to have produced something and 1 did — ' +
      "`k` is a floor the fold enforces whatever `onBranchError` says",
    `and says so honestly rather than claiming no work was done: ${String(fullShort.joinMessage)}`,
  );
  assert.deepEqual(fullShort.seen, ["inner", "inner"], "with the inner fold still in the channel, which the message does not deny");
});

test("§A.75 — an absolute `k` above the width the fan MATERIALISED refuses, and says that instead", async () => {
  // DELIBERATE AND NAMED. `k: 2` over a fan whose runtime width is 1 can be met by no outcome, so a
  // run in which EVERY branch succeeded still refuses. That is the refusing direction and it is
  // allowed — but the general message ("needs 2 of 1 branch(es) ... and 1 did") reads like a lost
  // branch and sends an operator looking for one, so this case gets its own sentence naming the
  // fact, which is about the graph and not about the run. AND NOT A CHECK THAT BELONGS AT COMPILE
  // TIME, which the first version of this comment claimed for a STATIC branch list: the last test in
  // this file narrows a static three-name list to two at RUNTIME with a `conditional` edge, so there
  // is no width for a compiler to read there either.
  const one = await runFunctions(narrowFanSpec(2), { items: [{ id: "a" }] }, "J");
  assert.equal(one.status, "failed", `width 1 cannot meet k: 2 — ${JSON.stringify(one)}`);
  assert.equal(one.joinError, CODES.E_QUORUM_UNREACHABLE);
  assert.equal(
    one.joinMessage,
    'join "J": mode "quorum" declares k 2, which exceeds the 1 branch(es) this barrier materialised — ' +
      "no outcome can meet it, and 1 of them produced something. Lower `k` or widen the branch set",
    `the message names the width, not a loss: ${String(one.joinMessage)}`,
  );
  // AND NOTHING REACHES THE CHANNEL, which is the opposite of the static-join case above and is not
  // a contradiction: a branch at DEPTH holds its writes for its barrier (`writesHeldForJoin`), so a
  // refused fold never applies them, where a static sibling arm at the ROOT coordinate has already
  // applied its own. Measured both ways rather than assumed.
  assert.equal(one.seen, undefined, `a fanned branch's writes are held for the barrier: ${JSON.stringify(one.seen)}`);
  assert.equal(one.note, undefined, "and the node behind the barrier did not run");

  // The same graph at the width its `k` asks for: folds.
  const two = await runFunctions(narrowFanSpec(2), { items: [{ id: "a" }, { id: "b" }] }, "J");
  assert.equal(two.status, "succeeded", `width 2 meets k: 2 — ${JSON.stringify(two)}`);
  assert.deepEqual(two.note, ["done-ran"]);

  // AND THE DISCONTINUITY AT ZERO IS PINNED RATHER THAN HIDDEN: width 0 SUCCEEDS where width 1
  // fails, because §A.47 requires an empty fan to fold nothing and succeed and `members.length > 0`
  // keeps this arm out of it. Two adjacent widths, opposite verdicts, both on purpose.
  const none = await runFunctions(narrowFanSpec(2), { items: [] }, "J");
  assert.equal(none.status, "succeeded", `width 0 is §A.47's shape — ${JSON.stringify(none)}`);
  assert.deepEqual(none.note, ["done-ran"], "and the node behind the barrier runs");
});

/**
 * A STATIC branch list NARROWED BY A CONDITIONAL EDGE — the shape that makes an unsatisfiable `k` a
 * runtime fact even where the author wrote every branch out by name.
 *
 * `J.branches: [a, b, c]` with `c` reachable only through `kind: "conditional"`. The compiler sees
 * three members; the run materialises two when the guard is false, so `expected` is 2 and `k: 3`
 * cannot be met by any outcome. Both survivors sit at the ROOT coordinate, so their writes are
 * already in the channel when the barrier refuses.
 */
function conditionalStaticSpec(k: number): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "a75-conditional-static", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 32, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
    channels: { ...FN_CHANNELS, flag: { type: "string", reduce: "replace" } },
    inputs: ["items", "flag"],
    outputs: [],
    nodes: [
      // `flag` IS DECLARED ON `start` because the `conditional` edge leaves it — `GRAPH004_UNDECLARED_READ`
      // refuses a `when` over a channel the edge's source node does not read.
      { id: "start", type: "function", reads: ["items", "flag"], function: { ref: "function/seed@stable" } },
      { id: "a", type: "function", reads: ["items"], writes: ["seen"], function: { ref: "function/arm-a@stable" } },
      { id: "b", type: "function", reads: ["items"], writes: ["seen"], function: { ref: "function/arm-b@stable" } },
      { id: "c", type: "function", reads: ["items"], writes: ["seen"], function: { ref: "function/arm-c@stable" } },
      {
        id: "J",
        type: "join",
        reads: ["seen"],
        writes: ["seen"],
        join: { branches: ["a", "b", "c"], mode: "quorum", k, onBranchError: "skip" },
      },
      { id: "done", type: "function", reads: ["seen"], writes: ["note"], function: { ref: "function/done@stable" } },
    ],
    edges: [
      { id: "sa", from: "start", to: "a", kind: "seq" },
      { id: "sb", from: "start", to: "b", kind: "seq" },
      // THE NARROWING. `c` runs only when the input says so, and nothing about that is visible to
      // the compiler, which sees a three-member `branches` list either way.
      { id: "sc", from: "start", to: "c", kind: "conditional", when: 'flag == "yes"' },
      { id: "ja", from: "a", to: "J", kind: "join", branches: ["a", "b", "c"] },
      { id: "jb", from: "b", to: "J", kind: "join", branches: ["a", "b", "c"] },
      { id: "jc", from: "c", to: "J", kind: "join", branches: ["a", "b", "c"] },
      { id: "jd", from: "J", to: "done", kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

test("§A.75 — a STATIC branch list narrowed by a `conditional` edge reaches the same arm, at runtime", async () => {
  // WHY THIS ROW EXISTS: the comment in `#foldJoin` said a compile-time refusal of an unsatisfiable
  // `k` "is possible for a STATIC branch list, where the width is known before anything runs". It is
  // NOT. `expected` counts the members that MATERIALISED, and a `conditional` edge decides that from
  // channel state — so `k: 3` over a three-name `branches` list is satisfiable on one input and
  // unsatisfiable on the next, and the compiler cannot tell which. A compile-time rule would have to
  // refuse the graph outright, including for every input where it works.
  //
  // DELIBERATE, AND IN THE REFUSING DIRECTION. The guard fails closed on a `k` that cannot be met,
  // and the cost is stated rather than hidden: the two arms that DID run sit at the root coordinate,
  // so `writesHeldForJoin` is false, and their writes are in the channel when the barrier refuses.
  // That is a run refused with real data already applied — and the alternative is folding a quorum
  // the graph declared and did not get.
  const narrowed = await runFunctions(conditionalStaticSpec(3), { items: [{ id: "i" }], flag: "no" }, "J");
  assert.equal(narrowed.status, "failed", `k: 3 over two materialised arms — ${JSON.stringify(narrowed)}`);
  assert.equal(narrowed.joinError, CODES.E_QUORUM_UNREACHABLE);
  assert.equal(
    narrowed.joinMessage,
    'join "J": mode "quorum" declares k 3, which exceeds the 2 branch(es) this barrier materialised — ' +
      "no outcome can meet it, and 2 of them produced something. Lower `k` or widen the branch set",
    `the message names the materialised width, which is the only true statement available here: ${String(narrowed.joinMessage)}`,
  );
  // THE COST, ASSERTED: both survivors' writes are already applied, because a static arm is at the
  // root coordinate. The advice the message gives ("lower `k` or widen the branch set") names
  // neither the conditional nor these writes — the arm knows the width, not why it is that width.
  assert.deepEqual(narrowed.seen, ["a", "b"], `the arms that ran had already applied their writes: ${JSON.stringify(narrowed.seen)}`);
  assert.equal(narrowed.note, undefined, "and the node behind the barrier did not run");

  // THE SAME GRAPH, THE OTHER INPUT: three arms materialise and `k: 3` is met. One `GraphSpec`, two
  // verdicts, decided by channel state — which is the whole argument against a compile-time rule.
  const full = await runFunctions(conditionalStaticSpec(3), { items: [{ id: "i" }], flag: "yes" }, "J");
  assert.equal(full.status, "succeeded", `the conditional arm ran, so k: 3 is met — ${JSON.stringify(full)}`);
  assert.deepEqual(full.seen, ["a", "b", "c"], "all three produced");
  assert.deepEqual(full.note, ["done-ran"], "and the barrier folded");

  // And the narrowed width is not itself a refusal: `k: 2` over the two that ran folds.
  const fits = await runFunctions(conditionalStaticSpec(2), { items: [{ id: "i" }], flag: "no" }, "J");
  assert.equal(fits.status, "succeeded", `k: 2 over two materialised arms — ${JSON.stringify(fits)}`);
  assert.deepEqual(fits.note, ["done-ran"], "the barrier folded");
});

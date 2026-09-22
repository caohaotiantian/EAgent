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
 * THE UNIT THE FLOOR IS COUNTED IN is pinned by the last test: a branch that PRODUCED something
 * counts, even if a later member of it then died. That is `onBranchError: "skip"`'s own reading of
 * a degraded branch (`join-all-branches-fail.test.ts`, `join-evidence-and-work.test.ts`), and
 * requiring `k` ARRIVALS instead would refuse three shapes this runtime decided to fold, with the
 * humans' own writes already in the barrier.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { NodeId, RunId } from "../../src/ids.ts";
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
    /mode "quorum" requires 2 of 3 branch\(es\) to succeed and 1 did/,
    `the message says the count and the width — got: ${String(p.error?.message)}`,
  );
  assert.match(
    String(p.error?.message ?? ""),
    /no further arrival is possible, which is not the same as its `k` being met/,
    `and why the barrier released at all — got: ${String(p.error?.message)}`,
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

/**
 * A LOOSENING THE JOURNAL DOES NOT RECORD IS A LOOSENING THAT NEVER HAPPENED.
 *
 * `Engine.deescalate` mutated the live `PolicyEngine` and THEN appended `policy.deescalated`, so
 * a failed append — a stale fencing token, a full disk, eight exhausted seq-conflict retries —
 * left the object that authorizes every subsequent action holding a ceiling nothing recorded. The
 * caller sees an error and assumes nothing happened; the run carries on unsupervised.
 *
 * `PolicyEngine.restore` could not undo it either. It wrote ceilings with a bare `set`, so it
 * only ever ADDED keys: a phantom ceiling survived every re-seed, and — the other half of the
 * same defect — a stale projection could OVERWRITE a live `in` with `out`, which is the opposite
 * of the "only ever RAISES a posture" its own docstring claimed.
 *
 * Both are `Engine.submit`'s rule one method over: nothing raises its own permissions, and a
 * restart is an automated path.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import type { NodeId, RunId } from "../../src/ids.ts";
import type { AppendInput, AppendResult, RunFilter, RunSummary, StateStore } from "../../src/journal/store.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import type { Seq } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { PolicyEngine } from "../../src/run/policy.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";

const n = (id: string): NodeId => id as NodeId;
const NOW = (): number => 1_700_000_000_000;
const HUMAN = { kind: "human" as const, id: "u:ops" };

const NOTE: ToolManifestLite = {
  name: "note.write",
  version: "1.0",
  capabilities: ["fs:write"],
  irreversibility: "reversible_write",
  idempotent: true,
};

/**
 * A gate, then a node at a declared posture of `in` — so a ceiling of `out` is observable as
 * "the second node did not ask".
 *
 * THE FIRST NODE IS NOT DECORATION. `#advanceSerially` re-seeds oversight from the journal once
 * per attach, and that re-seed now CLEARS ceilings before folding them, so a phantom left by a
 * failed append would be erased by the very next `advance` on a run that had never advanced. A
 * run already past its first advance is the case where the live object is the only thing that
 * holds the ceiling, which is the case this defect is about.
 */
function spec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "deescalate", project: "lane-a", version: 1 },
    policy: { posture: "out", capabilities: ["fs:write"] },
    channels: { go: { type: "object", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: [],
    outputs: ["out"],
    nodes: [
      { id: n("gate"), type: "human_gate", writes: ["go"], humanGate: { ref: "oversight/w@stable" } },
      {
        id: n("act"),
        type: "tool",
        reads: ["go"],
        writes: ["out"],
        policy: { posture: "in" },
        tool: { name: "note.write", version: "1.0", args: {} },
      },
    ],
    edges: [{ id: "g2a" as never, from: n("gate"), to: n("act"), kind: "seq" }],
  } as unknown as GraphSpec;
}

/** Approve whatever gate is open, and drive on. */
async function approve(engine: Engine, runId: RunId, key: string): Promise<{ status: string; error?: unknown }> {
  const open = await engine.openGates(runId);
  assert.equal(open.length, 1, `expected one open gate, saw ${JSON.stringify(open.map((g) => g.nodeId))}`);
  const p = await engine.resolveGate(runId, {
    gateId: open[0]!.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:ops", via: "cli" },
    idempotencyKey: key,
  });
  return { status: p.status, error: p.error };
}

const RESOLVER: ResourceResolver = {
  resolve: (ref) =>
    /^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref) ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" } : undefined,
};

/** A store whose `append` can be switched to reject, the way a fenced or full one does. */
class Flaky implements StateStore {
  readonly #inner: MemoryStateStore;
  failing = false;
  constructor(inner: MemoryStateStore) {
    this.#inner = inner;
  }
  async append(input: AppendInput): Promise<AppendResult> {
    if (this.failing) throw new Error("journal is unavailable");
    return this.#inner.append(input);
  }
  read(runId: RunId, fromSeq: Seq, toSeq?: Seq): AsyncIterable<JournalEvent> {
    return this.#inner.read(runId, fromSeq, toSeq);
  }
  head(runId: RunId): Promise<Seq> {
    return this.#inner.head(runId);
  }
  listRuns(limit?: number, filter?: RunFilter): Promise<readonly RunSummary[]> {
    return this.#inner.listRuns(limit, filter);
  }
  close(): void {
    this.#inner.close();
  }
}

function rig(): { readonly engine: Engine; readonly store: Flaky; readonly wrote: number[] } {
  const wrote: number[] = [];
  const store = new Flaky(new MemoryStateStore({ now: NOW }));
  const tools = new ToolRegistry();
  const def: ToolDefinition = {
    ...NOTE,
    description: "Write a note.",
    parameters: { type: "object", properties: {} },
    execute: () => {
      wrote.push(1);
      return { content: "ok", writes: { out: { ok: true } } };
    },
  };
  tools.register(def);
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now: NOW,
    sleep: async () => {},
    policy: { granted: ["fs:write"], systemFloor: "out" },
  });
  return { engine, store, wrote };
}

const graph = (): ReturnType<typeof compileOrThrow> =>
  compileOrThrow({ spec: spec(), resolver: RESOLVER, tools: { "note.write": NOTE }, tenantCapabilities: ["fs:write"] });

test("A DE-ESCALATION WHOSE APPEND FAILS DOES NOT LOWER THE LIVE CEILING", async () => {
  const r = rig();
  const runId = await r.engine.submit({ graph: graph(), inputs: {} });
  const parked = await r.engine.advance(runId);
  assert.equal(parked.status, "awaiting_gate", JSON.stringify(parked.error ?? {}));

  r.store.failing = true;
  await assert.rejects(
    () => r.engine.deescalate(runId, `run:${runId}`, "out", "let it run", HUMAN),
    /journal is unavailable/,
    "the append must fail for this case to mean anything",
  );
  r.store.failing = false;

  // THE OBSERVABLE. At `in` the second node raises its own gate; at a ceiling of `out` it does
  // not. The de-escalation was refused by the journal, so it must still ask.
  const after = await approve(r.engine, runId, "k1");
  assert.equal(after.status, "awaiting_gate", `the refused de-escalation must not have taken effect; run is ${after.status}`);
  assert.equal(r.wrote.length, 0, "and the guarded node must not have run");

  // And the journal agrees with the live object: nothing was lowered, so nothing is recorded.
  assert.deepEqual((await r.engine.projection(runId))!.ceilings, {}, "a ceiling no event carries is a ceiling that does not exist");
});

test("…and the CONTROL: a de-escalation whose append SUCCEEDS does lower it", async () => {
  const r = rig();
  const runId = await r.engine.submit({ graph: graph(), inputs: {} });
  await r.engine.advance(runId);
  await r.engine.deescalate(runId, `run:${runId}`, "out", "let it run", HUMAN);
  const after = await approve(r.engine, runId, "k1");
  assert.equal(after.status, "succeeded", JSON.stringify(after.error ?? {}));
  assert.equal(r.wrote.length, 1, "otherwise the case above passes because de-escalation is broken");
  assert.equal((await r.engine.projection(runId))!.ceilings[`run:${runId}`], "out");
});

test("the refusals still run BEFORE the append — a non-human writes nothing", async () => {
  // Journaling first must not mean journaling a de-escalation that was going to be refused.
  const r = rig();
  const runId = await r.engine.submit({ graph: graph(), inputs: {} });
  await r.engine.advance(runId);
  await assert.rejects(
    () => r.engine.deescalate(runId, `run:${runId}`, "out", "because I say so", { kind: "agent", id: "a:planner" }),
    /only a human may lower oversight/,
  );
  const p = (await r.engine.projection(runId))!;
  assert.deepEqual(p.ceilings, {}, "a refused de-escalation leaves no row");
  await assert.rejects(
    () => r.engine.deescalate(runId, `run:${runId}`, "out", "   ", HUMAN),
    /non-empty justification/,
  );
  assert.deepEqual((await r.engine.projection(runId))!.ceilings, {}, "and neither does a refused justification");
});

// ── `restore` is authoritative in BOTH directions ───────────────────────────

function policy(): PolicyEngine {
  return new PolicyEngine({ granted: ["*"], systemFloor: "out" });
}

test("RESTORE DOES NOT LOWER A CEILING THE JOURNAL DOES NOT CARRY", () => {
  const p = policy();
  p.deescalate("run:r1", "in", "tighten it back", HUMAN);
  assert.equal(p.ceilingFor("run:r1"), "in");

  // A projection read BEFORE that tightening landed. The bare `set` this replaced overwrote the
  // live `in` with the stale `out`.
  p.restore({ escalations: {}, ceilings: { "run:r1": "out" }, spentUsd: 0 });
  assert.equal(p.ceilingFor("run:r1"), "out", "the JOURNAL is authoritative, so the folded value wins");

  // …and the other direction, which is the half that could not be expressed at all: a ceiling
  // the journal does not carry is removed rather than kept forever.
  p.restore({ escalations: {}, ceilings: {}, spentUsd: 0 });
  assert.equal(p.ceilingFor("run:r1"), undefined, "a ceiling no event carries must not survive a re-seed");
});

test("RESTORE SEEDS THE OUTSTANDING RESERVATION, so a crash mid-call does not refund it", () => {
  const p = policy();
  p.restore({ escalations: {}, ceilings: {}, spentUsd: 0, reservedUsd: 0.001043 });
  assert.equal(p.reservedUsd, 0.001043, "the promise is in the journal and the guard must read it");

  // The measured shape: a $0.05 ceiling with $0.001043 outstanding cannot take the full $0.05
  // again. Before this, the second process reserved it and the run stood committed for
  // $0.051043 against a $0.05 budget.
  const bounded = new PolicyEngine({ granted: ["*"], systemFloor: "out", budget: { runUsd: 0.05 } });
  bounded.restore({ escalations: {}, ceilings: {}, spentUsd: 0, reservedUsd: 0.001043 });
  assert.throws(() => bounded.reserve("node:work", 0.05), /would exceed the \$0\.05 budget/);
  // …and it still fits what is genuinely left, so this is a ceiling and not a wall.
  assert.ok(bounded.reserve("node:work", 0.048).amountUsd === 0.048);
});

test("RESTORE FOLDS A RECORDED BUDGET BY MIN and the allowlist by intersection", () => {
  const p = new PolicyEngine({ granted: ["*"], systemFloor: "out", budget: { runUsd: 1 }, allowlist: ["pay", "fs:read"] });
  p.restore({ escalations: {}, ceilings: {}, spentUsd: 0, limits: { runUsd: 0.01 }, allowlist: ["fs:read"] });
  assert.throws(() => p.reserve("node:work", 0.5), /would exceed the \$0\.01 budget/, "the recorded slice lowers the ceiling");

  // A recorded bound may never RAISE one.
  p.restore({ escalations: {}, ceilings: {}, spentUsd: 0, limits: { runUsd: 100 } });
  assert.throws(() => p.reserve("node:work", 0.5), /would exceed the \$0\.01 budget/, "and a wider recorded bound changes nothing");

  const decision = p.decide({
    runId: "r1" as RunId,
    nodeId: n("act"),
    kind: "tool",
    capabilities: ["pay"],
    irreversibility: "reversible_write",
    declaredPosture: "out",
  });
  assert.equal(decision.effect, "deny", "`pay` was dropped by the intersection, so it is outside the allowlist");
});

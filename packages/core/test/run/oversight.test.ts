/**
 * The oversight lattice, the human ceiling, and the intervention window.
 *
 * These test the three things that make `on` a real posture rather than a label:
 * that a human can express "let this run on-the-loop", that doing so cannot reach
 * `out` for a hard-to-undo action, and that the resulting window actually prevents
 * the effect when someone interrupts.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { EVOLUTION_ACTOR, PolicyEngine, type PolicyActor, type PolicyRequest } from "../../src/run/policy.ts";
import type { EdgeId, NodeId, RunId } from "../../src/ids.ts";
import type { IrreversibilityClass } from "../../src/vocab.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import type { GateDecision } from "../../src/vocab.ts";
import {
  FunctionRegistry,
  MockModelAdapter,
  ModelRegistry,
  ToolRegistry,
  type ToolDefinition,
} from "../../src/run/registry.ts";
import type { ToolManifestLite } from "../../src/graph/validate.ts";
import { resolver } from "./skeleton.ts";

const RUN = "01JRUNOVERSIGHT00000000000" as RunId;
const HUMAN: PolicyActor = { kind: "human", id: "u:alice" };

function req(over: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    runId: RUN,
    nodeId: "n" as NodeId,
    kind: "tool",
    irreversibility: "read_only",
    capabilities: [],
    declaredPosture: "out",
    ...over,
  };
}

/**
 * Lattice tests pin `systemFloor: "out"` explicitly so each one isolates a single
 * contributing term. The production DEFAULT is `on` — asserted separately below.
 */
const engine = (over: Partial<ConstructorParameters<typeof PolicyEngine>[0]> = {}) =>
  new PolicyEngine({ granted: ["*"], systemFloor: "out", ...over });

// ── the lattice ──────────────────────────────────────────────────────────────

test("the DEFAULT system floor is `on`, not `out`", () => {
  // `on` is nearly free (the read_only window is 0 ms) and buys the lever between
  // "fully automatic" and "blocking gate". `out` leaves no lever at all.
  const p = new PolicyEngine({ granted: ["*"] });
  assert.equal(p.effectivePosture(req()), "on");
  const d = p.decide(req());
  assert.equal(d.effect, "allow");
  if (d.effect === "allow") assert.equal(d.holdMs, 0, "and a read costs nothing for it");
});

test("posture folds by max over every level", () => {
  const p = engine({ systemFloor: "on" });
  assert.equal(p.effectivePosture(req()), "on", "the system floor lifts a read-only action");
  assert.equal(p.effectivePosture(req({ declaredPosture: "in" })), "in");
  assert.equal(p.effectivePosture(req({ irreversibility: "irreversible" })), "in", "the class alone forces `in`");
});

test("a data classification raises the floor on its own", () => {
  const p = engine();
  assert.equal(p.effectivePosture(req({ dataClassification: ["pii"] })), "on");
  assert.equal(p.effectivePosture(req({ dataClassification: ["secret_ref"] })), "in");
});

test("taint raises a hard-to-undo action one level, automatically", () => {
  const p = engine();
  assert.equal(p.effectivePosture(req({ irreversibility: "read_only", tainted: true })), "out", "reads are unaffected");
  assert.equal(p.effectivePosture(req({ irreversibility: "externally_visible", tainted: true })), "in");
});

// ── the human ceiling ────────────────────────────────────────────────────────

test("without a ceiling, an irreversible action can NEVER be `on` — max sees to that", () => {
  const p = engine();
  assert.equal(p.effectivePosture(req({ irreversibility: "irreversible" })), "in");
});

test("a human ceiling expresses 'let this run on-the-loop'", () => {
  const p = engine();
  p.deescalate(`run:${RUN}`, "on", "approved for the incident window", HUMAN);
  assert.equal(p.effectivePosture(req({ irreversibility: "irreversible" })), "on");
});

test("THE HARD FLOOR — a ceiling can reach `on`, never `out`, for a hard-to-undo action", () => {
  const p = engine();
  p.deescalate(`run:${RUN}`, "out", "I really mean it", HUMAN);
  // Clamped: at `out` nobody is watching and the action cannot be taken back.
  assert.equal(p.effectivePosture(req({ irreversibility: "irreversible" })), "on");
  assert.equal(p.effectivePosture(req({ irreversibility: "externally_visible" })), "on");
  // A reversible action may go all the way down — it can be undone.
  assert.equal(p.effectivePosture(req({ irreversibility: "reversible_write" })), "out");
});

test("a node ceiling is narrower than a run ceiling and wins", () => {
  const p = engine({ systemFloor: "in" });
  p.deescalate(`run:${RUN}`, "on", "run-wide", HUMAN);
  p.deescalate(`node:${RUN}/other`, "out", "just this node", HUMAN);
  assert.equal(p.effectivePosture(req({ nodeId: "n" as NodeId })), "on");
  assert.equal(p.effectivePosture(req({ nodeId: "other" as NodeId })), "out");
});

test("clearing a ceiling restores the computed floor, and needs no authority", () => {
  const p = engine();
  p.deescalate(`run:${RUN}`, "on", "temporarily", HUMAN);
  assert.equal(p.effectivePosture(req({ irreversibility: "irreversible" })), "on");
  p.clearCeiling(`run:${RUN}`);
  assert.equal(p.effectivePosture(req({ irreversibility: "irreversible" })), "in", "tightening is always allowed");
});

test("only a human may set a ceiling", () => {
  const p = engine();
  for (const actor of [{ kind: "agent" as const, id: "a" }, { kind: "system" as const, id: "s" }, EVOLUTION_ACTOR]) {
    assert.throws(
      () => p.deescalate(`run:${RUN}`, "on", "because", actor),
      (e: unknown) => (e as { code: string }).code === "E_OVERSIGHT_LOOSEN_FORBIDDEN",
      actor.kind,
    );
  }
});

test("a deny-listed identity is refused even when it claims to be human", () => {
  const p = engine();
  assert.throws(
    () => p.deescalate(`run:${RUN}`, "on", "trust me", { ...EVOLUTION_ACTOR, kind: "human" }),
    (e: unknown) => (e as { code: string }).code === "E_OVERSIGHT_LOOSEN_FORBIDDEN",
  );
});

test("a ceiling requires a non-empty justification", () => {
  const p = engine();
  assert.throws(() => p.deescalate(`run:${RUN}`, "on", "   ", HUMAN), /justification/);
});

test("escalation stays automatic and composes upward", () => {
  const p = engine();
  const seen: string[] = [];
  const q = new PolicyEngine({ granted: ["*"], onEscalate: (rule) => seen.push(rule) });
  q.escalate(`run:${RUN}`, "on", "anomaly");
  assert.equal(q.effectivePosture(req()), "on");
  q.escalate(`run:${RUN}`, "in", "violation");
  assert.equal(q.effectivePosture(req()), "in");
  q.escalate(`run:${RUN}`, "out", "noop");
  assert.equal(q.effectivePosture(req()), "in", "an escalation can never lower");
  assert.deepEqual(seen, ["anomaly", "violation"]);
  assert.equal(p.effectivePosture(req()), "out");
});

// ── the intervention window ──────────────────────────────────────────────────

test("holdMs is non-zero ONLY for a hard-to-undo action at posture `on`", () => {
  const p = engine();
  p.deescalate(`run:${RUN}`, "on", "incident window", HUMAN);

  const cases: [IrreversibilityClass, number][] = [
    ["read_only", 0],
    ["reversible_write", 0], // deliberate deviation: a hold on an undoable action is pure latency
    ["irreversible", 5000],
    ["externally_visible", 5000],
  ];
  for (const [cls, expected] of cases) {
    const d = p.decide(req({ irreversibility: cls }));
    assert.equal(d.effect, "allow", cls);
    if (d.effect === "allow") assert.equal(d.holdMs, expected, cls);
  }
});

test("AN INTERVENTION WINDOW NO TIMER CAN HOLD IS REFUSED, instead of becoming one millisecond", () => {
  // `decide` returns `holdMs` from this map, `Engine` awaits `#sleep(holdMs)` → `setTimeout`,
  // and the SAME number is journaled verbatim as `action.pending`'s `windowMs`. `setTimeout`
  // truncates to 32 bits rather than saturating or throwing, so before this check:
  //
  //     interventionWindowMs: {reversible_write: 2 ** 31}
  //       → {effect: "allow", posture: "on", holdMs: 2147483648}
  //
  // slept as ONE MILLISECOND and recorded as 24.8 days. The operator was told they had most
  // of a month to hit stop; they had a millisecond. That is a false claim in the audit
  // trail, which is worse than the short sleep.
  for (const bad of [2 ** 31, 2_147_483_648, Number.MAX_SAFE_INTEGER]) {
    assert.throws(
      () => new PolicyEngine({ granted: [], interventionWindowMs: { reversible_write: bad } }),
      (e: unknown) => (e as { code: string }).code === "E_CONFIG_INVALID",
      `${bad} was accepted as an intervention window`,
    );
  }

  // THE OTHER DIRECTION IS QUIETER AND IS WHY THIS IS A REFUSAL RATHER THAN A CLAMP.
  // `holdMs > 0` is FALSE for all of these, so no `action.pending` is written at all — a
  // config typo of `-1` turns the supervision window off with nothing in the journal to show
  // one was ever declared. A clamp would silently substitute a number nobody chose.
  for (const bad of [NaN, Infinity, -Infinity, -1, 1.5, "5000" as unknown as number]) {
    assert.throws(
      () => new PolicyEngine({ granted: [], interventionWindowMs: { irreversible: bad } }),
      (e: unknown) => (e as { code: string }).code === "E_CONFIG_INVALID",
      `${String(bad)} was accepted as an intervention window`,
    );
  }

  // The boundary itself is legal, and so is 0 — "no hold" is a coherent posture and is the
  // default for the two reversible classes.
  assert.ok(new PolicyEngine({ granted: [], interventionWindowMs: { irreversible: 2_147_483_647 } }));
  assert.ok(new PolicyEngine({ granted: [], interventionWindowMs: { irreversible: 0 } }));
});

test("…and the Engine refuses the same window at ITS construction, not on the first submit", () => {
  // `PolicyEngine` is built lazily per run in `#contextFor`, so without this the throw first
  // reaches an operator from inside `submit` — an unstartable RUN rather than an unstartable
  // PROCESS, which is the wrong end of a deployment's day to find a config error.
  assert.throws(
    () =>
      new Engine({
        store: new MemoryStateStore(),
        policy: { granted: ["*"], interventionWindowMs: { irreversible: 2 ** 31 } },
      }),
    (e: unknown) => (e as { code: string }).code === "E_CONFIG_INVALID",
  );
});

test("no hold at `in` (a gate is stronger) or at `out` (nobody is watching)", () => {
  const gated = engine().decide(req({ irreversibility: "irreversible" }));
  assert.equal(gated.effect, "gate", "at `in` you gate instead of holding");

  const open = engine().decide(req({ irreversibility: "read_only" }));
  assert.equal(open.effect, "allow");
  if (open.effect === "allow") assert.equal(open.holdMs, 0);
});

test("the window is configurable per class", () => {
  const p = engine({ interventionWindowMs: { reversible_write: 1234 }, systemFloor: "on" });
  const d = p.decide(req({ irreversibility: "reversible_write" }));
  assert.equal(d.effect, "allow");
  if (d.effect === "allow") assert.equal(d.holdMs, 1234);
});

// ── the window, end to end ───────────────────────────────────────────────────

function chargeSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "charge", project: "test", version: 1 },
    policy: { capabilities: ["pay:write"] },
    channels: { amount: { type: "number", reduce: "replace" }, receipt: { type: "object", reduce: "replace" } },
    inputs: ["amount"],
    outputs: ["receipt"],
    nodes: [
      {
        id: "charge" as NodeId,
        type: "tool",
        reads: ["amount"],
        writes: ["receipt"],
        tool: { name: "pay.charge", version: "1.0", args: { amount: "${amount}" } },
        unhandled: true,
      },
    ],
    edges: [],
  };
}

interface Rig {
  engine: Engine;
  charged: () => number;
  releaseHold: () => void;
  store: MemoryStateStore;
}

/** A rig whose hold can be released or interrupted from the test. */
function chargeRig(): Rig {
  const store = new MemoryStateStore({ now: () => 1 });
  const tools = new ToolRegistry();
  let charged = 0;
  const tool: ToolDefinition = {
    name: "pay.charge",
    version: "1.0",
    capabilities: ["pay:write"],
    irreversibility: "irreversible",
    idempotent: false,
    description: "Takes money. Cannot be undone.",
    parameters: { type: "object", properties: { amount: { type: "number" } } },
    execute: () => {
      charged++;
      return { content: "charged", writes: { receipt: { ok: true } } };
    },
  };
  tools.register(tool);

  let release: (() => void) | undefined;
  const engineInstance = new Engine({
    store,
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now: () => 1,
    policy: { granted: ["pay:write"] },
    // The hold blocks until the test releases it or the run aborts.
    sleep: (_ms, signal) =>
      new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  });

  return { engine: engineInstance, charged: () => charged, releaseHold: () => release?.(), store };
}

const compileCharge = () =>
  compileOrThrow({
    spec: chargeSpec(),
    resolver: resolver(),
    tools: {
      "pay.charge": { name: "pay.charge", version: "1.0", capabilities: ["pay:write"], irreversibility: "irreversible", idempotent: false },
    },
    tenantCapabilities: ["pay:write"],
  });

test("an irreversible action GATES by default — no hold needed", async () => {
  const r = chargeRig();
  const runId = await r.engine.submit({ graph: compileCharge(), inputs: { amount: 10 } });
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "awaiting_gate");
  assert.equal(r.charged(), 0);
});

/** Approve the one open gate on a run. */
async function approve(r: Rig, runId: RunId, decision: GateDecision) {
  const p = await r.engine.projection(runId);
  const gate = Object.values(p!.gates).find((g) => g.state === "open")!;
  return r.engine.resolveGate(runId, {
    gateId: gate.gateId,
    decision,
    actor: { kind: "human", subject: "u:alice", via: "console" },
    idempotencyKey: "k1",
  });
}

test("APPROVING A WORK NODE MEANS GO AHEAD — the action actually runs", async () => {
  // The bug this pins: treating approval as completion. The Task would go straight to
  // `succeeded`, the run would report success, and the charge would never happen —
  // silently, in the one place a human was explicitly asked to look.
  const r = chargeRig();
  const runId = await r.engine.submit({ graph: compileCharge(), inputs: { amount: 10 } });
  await r.engine.advance(runId);

  const p = await approve(r, runId, { kind: "approve" });
  assert.equal(p.status, "succeeded");
  assert.equal(r.charged(), 1, "approval authorises the action; it does not stand in for it");
  assert.deepEqual(p.channels["receipt"], { ok: true }, "and the node's real writes landed");
});

test("approving twice still charges once", async () => {
  const r = chargeRig();
  const runId = await r.engine.submit({ graph: compileCharge(), inputs: { amount: 10 } });
  await r.engine.advance(runId);
  await approve(r, runId, { kind: "approve" });
  await r.engine.advance(runId);
  assert.equal(r.charged(), 1, "a decided gate does not re-open, and a done Task does not re-run");
});

test("rejecting fails the Task and takes no money", async () => {
  const r = chargeRig();
  const runId = await r.engine.submit({ graph: compileCharge(), inputs: { amount: 10 } });
  await r.engine.advance(runId);

  const p = await approve(r, runId, { kind: "reject", reason: "not this account" });
  assert.equal(p.status, "failed");
  assert.equal(r.charged(), 0);
});

// ── two gates open at once ───────────────────────────────────────────────────

/** Two independent gates, with the irreversible action behind only one of them. */
function twoGateSpec(): GraphSpec {
  const base = chargeSpec();
  return {
    ...base,
    nodes: [
      { id: "ask" as NodeId, type: "human_gate", reads: ["amount"], humanGate: { ref: "oversight/ask@stable" } },
      { id: "hold" as NodeId, type: "human_gate", reads: ["amount"], humanGate: { ref: "oversight/hold@stable" } },
      ...base.nodes,
    ],
    edges: [{ id: "h" as EdgeId, from: "hold" as NodeId, to: "charge" as NodeId, kind: "seq" }],
  };
}

test("ANSWERING ONE GATE DOES NOT ABANDON ANOTHER", async () => {
  // `gate.decided` carries an unconditional `run.resumed`, so answering either of two open
  // gates puts the whole run back to `running`. The work behind the answered one then ran,
  // drained, and left `advance` with no ready Task — which it read as "nothing left to do"
  // and finished on. The run reported a terminal status with a human still being asked, the
  // console kept an open gate for a run that had already ended, and the action behind that
  // gate never happened. "No ready Task" and "nothing left to do" are not the same claim.
  const r = chargeRig();
  const graph = compileOrThrow({
    spec: twoGateSpec(),
    resolver: resolver(),
    tools: {
      "pay.charge": { name: "pay.charge", version: "1.0", capabilities: ["pay:write"], irreversibility: "irreversible", idempotent: false },
    },
    tenantCapabilities: ["pay:write"],
  });
  const runId = await r.engine.submit({ graph, inputs: { amount: 10 } });
  let p = await r.engine.advance(runId);

  const open = Object.values(p.gates).filter((g) => g.state === "open");
  assert.equal(open.length, 2, "both entry gates are raised in the same wave");
  const ask = open.find((g) => g.nodeId === "ask")!;
  const hold = open.find((g) => g.nodeId === "hold")!;

  p = await r.engine.resolveGate(runId, {
    gateId: ask.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:alice", via: "console" },
    idempotencyKey: "ask",
  });

  assert.equal(p.status, "awaiting_gate", "THE RUN IS STILL WAITING ON A HUMAN, and says so");
  assert.equal(p.gates[hold.gateId]?.state, "open");
  assert.equal(r.charged(), 0);

  // …and the second answer still gets all the way through.
  p = await r.engine.resolveGate(runId, {
    gateId: hold.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:alice", via: "console" },
    idempotencyKey: "hold",
  });
  assert.equal(p.status, "awaiting_gate", "the charge's own posture gate is next");
  const posture = Object.values(p.gates).find((g) => g.state === "open")!;
  p = await r.engine.resolveGate(runId, {
    gateId: posture.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:alice", via: "console" },
    idempotencyKey: "posture",
  });
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.equal(r.charged(), 1);
});

test("an edit SUBSTITUTES the human's outcome rather than running the action", async () => {
  // `edit` carries channel writes, not tool arguments — so the only coherent reading is
  // "use these values instead". Running the tool AND applying the edit would both charge
  // the card and overwrite the receipt that proves it.
  const r = chargeRig();
  const runId = await r.engine.submit({ graph: compileCharge(), inputs: { amount: 10 } });
  await r.engine.advance(runId);

  const p = await approve(r, runId, { kind: "edit", writes: { receipt: { manual: true } } });
  assert.equal(p.status, "succeeded");
  assert.equal(r.charged(), 0);
  assert.deepEqual(p.channels["receipt"], { manual: true });
});

test("INTERRUPTING DURING THE WINDOW MEANS THE EFFECT NEVER STARTS", async () => {
  const r = chargeRig();
  const graph = compileCharge();
  const runId = await r.engine.submit({ graph, inputs: { amount: 10 } });

  // A human puts this run on-the-loop: allowed to run, but watched.
  await r.engine.deescalate(runId, `run:${runId}`, "on", "incident window", HUMAN);

  const running = r.engine.advance(runId);
  await new Promise((res) => setImmediate(res));

  // The hold is open — the pending action is journaled and nothing has happened yet.
  const events = [];
  for await (const e of r.store.read(runId, 1)) events.push(e);
  const pending = events.find((e) => e.type === "action.pending");
  assert.ok(pending, "the supervisor is told BEFORE the action, not after");
  assert.equal((pending.payload as { windowMs: number }).windowMs, 5000);
  assert.equal(r.charged(), 0);

  // Interrupt inside the window.
  await r.engine.cancel(runId, "supervisor stopped it");
  const p = await running;

  assert.equal(r.charged(), 0, "the money was never taken");
  assert.notEqual(p.status, "succeeded");
});

test("left alone, the window elapses and the action proceeds", async () => {
  const r = chargeRig();
  const graph = compileCharge();
  const runId = await r.engine.submit({ graph, inputs: { amount: 10 } });
  await r.engine.deescalate(runId, `run:${runId}`, "on", "incident window", HUMAN);

  const running = r.engine.advance(runId);
  await new Promise((res) => setImmediate(res));
  r.releaseHold();
  const p = await running;

  assert.equal(p.status, "succeeded");
  assert.equal(r.charged(), 1, "a window is a chance to stop it, not a refusal");
});

test("a read-only action does not hold at all", async () => {
  const store = new MemoryStateStore({ now: () => 1 });
  const tools = new ToolRegistry();
  tools.register({
    name: "pay.peek",
    version: "1.0",
    capabilities: ["pay:write"],
    irreversibility: "read_only",
    idempotent: true,
    description: "Looks, touches nothing.",
    parameters: { type: "object", properties: { amount: { type: "number" } } },
    execute: () => ({ content: "peeked", writes: { receipt: { seen: true } } }),
  });
  // If a read-only action held, this promise would never settle: the rig's sleep
  // only resolves on release or abort, and the test does neither.
  const e = new Engine({
    store,
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now: () => 1,
    policy: { granted: ["pay:write"], systemFloor: "on" },
    sleep: () => new Promise<void>(() => undefined),
  });

  const spec = chargeSpec();
  const graph = compileOrThrow({
    spec: { ...spec, nodes: spec.nodes.map((n) => ({ ...n, tool: { name: "pay.peek", version: "1.0" } })) },
    resolver: resolver(),
    tools: { "pay.peek": { name: "pay.peek", version: "1.0", capabilities: ["pay:write"], irreversibility: "read_only", idempotent: true } },
    tenantCapabilities: ["pay:write"],
  });
  const runId = await e.submit({ graph, inputs: { amount: 1 } });
  const p = await e.advance(runId);
  assert.equal(p.status, "succeeded");
});

// ── the capability check INSIDE the one tool dispatch path ───────────────────
//
// `#invokeTool` runs `ctx.policy.decide` and returns on `deny`. Within a single
// Engine that check can never be the one that fires: `#executeTask` decides first
// over `#capabilitiesOf(node)`, which is the UNION of every reachable tool's
// capabilities, so a denial at the tool is always a denial at the node. The one
// shape that reaches it is the shape below — a run suspended on an approved gate,
// resumed by a process whose policy is tighter than the one that raised it, where
// `lastDecidedGate` short-circuits the node-level decision entirely. Deleting the
// `deny` arm in `#invokeTool` makes the charge below happen.

const PAY_MANIFEST: Record<string, ToolManifestLite> = {
  "pay.charge": {
    name: "pay.charge",
    version: "1.0",
    capabilities: ["pay:write"],
    irreversibility: "irreversible",
    idempotent: false,
  },
};

/** One agent node that may reach an irreversible tool, so it floors at `in` and gates. */
function agentChargeSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "agent-charge", project: "test", version: 1 },
    policy: { posture: "out", budget: { costUsd: 1 }, capabilities: ["pay:write"] },
    channels: { amount: { type: "number", reduce: "replace" }, receipt: { type: "object", reduce: "replace" } },
    inputs: ["amount"],
    outputs: ["receipt"],
    nodes: [
      {
        id: "act" as NodeId,
        type: "agent",
        reads: ["amount"],
        writes: ["receipt"],
        agent: {
          profile: "agent_profile/actor@stable",
          prompt: "prompt/act@stable",
          maxTurns: 3,
          tools: ["pay.charge"],
          outputSchema: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"] },
        },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

interface DenyRig {
  readonly engine: Engine;
  readonly turns: number[];
}

/**
 * An Engine over a shared store and a shared charge counter.
 *
 * `denied` is the only difference between the two processes this test simulates:
 * "deny beats allow, always", applied to a run that was authorised under the older,
 * looser configuration.
 */
function denyRig(store: MemoryStateStore, charged: { n: number }, denied?: readonly string[]): DenyRig {
  const now = (): number => 1_700_000_000_000;
  const tools = new ToolRegistry();
  tools.register({
    ...PAY_MANIFEST["pay.charge"]!,
    description: "Takes money. Cannot be undone.",
    parameters: { type: "object", properties: { amount: { type: "number" } } },
    execute: () => {
      charged.n++;
      return { content: "charged" };
    },
  } satisfies ToolDefinition);

  const turns: number[] = [];
  const models = new ModelRegistry();
  models.register(
    new MockModelAdapter({
      script: (_req, turn) => {
        turns.push(turn);
        return turn === 0
          ? { toolCalls: [{ id: "c0", name: "pay.charge", arguments: { amount: 10 } }], finishReason: "tool_use" }
          : { text: JSON.stringify({ done: true }), finishReason: "stop" };
      },
      pricePerMTok: 1,
    }),
    true,
  );

  return {
    engine: new Engine({
      store,
      tools,
      functions: new FunctionRegistry(),
      models,
      now,
      policy: {
        granted: ["pay:write"],
        ...(denied === undefined ? {} : { denied }),
        systemFloor: "out",
        budget: { runUsd: 1 },
      },
    }),
    turns,
  };
}

const compileAgentCharge = () =>
  compileOrThrow({
    spec: agentChargeSpec(),
    resolver: resolver(),
    tools: PAY_MANIFEST,
    tenantCapabilities: ["pay:write"],
  });

test("A GATE APPROVED UNDER THE OLD POLICY DOES NOT AUTHORISE A NOW-DENIED CAPABILITY", async () => {
  // The gate short-circuit in `#executeTask` is what makes this reachable: a Task with a
  // decided gate is dispatched WITHOUT re-deciding policy, so the capability check inside
  // `#invokeTool` is the only one left between the model's choice and the money.
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const charged = { n: 0 };
  const graph = compileAgentCharge();

  // Process 1 — the permissive configuration that raised the gate.
  const before = denyRig(store, charged);
  const runId = await before.engine.submit({ graph, inputs: { amount: 10 } });
  const raised = await before.engine.advance(runId);
  assert.equal(raised.status, "awaiting_gate", "precondition: the agent gates before the model runs");
  assert.deepEqual(before.turns, [], "precondition: and it gates BEFORE the model is asked anything");

  // Process 2 — `pay:write` has since been deny-listed. Same store, same graph.
  const after = denyRig(store, charged, ["pay:write"]);
  after.engine.attach(runId, graph);
  const gate = Object.values(raised.gates).find((g) => g.state === "open")!;
  await after.engine.resolveGate(runId, {
    gateId: gate.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:bob", via: "console" },
    idempotencyKey: "k1",
  });

  // The control: the approval really did resume the node and the model really did ask
  // for the tool. Without this the assertion below would also pass on a run that never
  // got that far.
  assert.ok(after.turns.length > 0, "the approved node must actually have run its agent");
  assert.equal(charged.n, 0, "a denied capability is refused inside the one tool dispatch path");

  const called: string[] = [];
  for await (const ev of store.read(runId, 1)) {
    if (ev.type === "tool.called") called.push((ev.payload as { name: string }).name);
  }
  assert.deepEqual(called, [], "and nothing records a call that policy refused");
});

test("…and the same run charges when the capability is NOT denied", async () => {
  // The other half of the pin. Without it, the test above passes on any run that fails
  // to resume for any reason at all — a broken attach would read as a working guard.
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const charged = { n: 0 };
  const graph = compileAgentCharge();

  const before = denyRig(store, charged);
  const runId = await before.engine.submit({ graph, inputs: { amount: 10 } });
  const raised = await before.engine.advance(runId);
  assert.equal(raised.status, "awaiting_gate");

  const after = denyRig(store, charged);
  after.engine.attach(runId, graph);
  const gate = Object.values(raised.gates).find((g) => g.state === "open")!;
  await after.engine.resolveGate(runId, {
    gateId: gate.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:bob", via: "console" },
    idempotencyKey: "k1",
  });

  assert.equal(charged.n, 1, "an approval with the capability still granted authorises the action");
});

test("an UNREGISTERED tool is treated as irreversible — fail closed", async () => {
  // The policy engine cannot know a tool's class if the tool is not registered, and
  // guessing "harmless" is the one guess that is never safe.
  const r = chargeRig();
  const spec = chargeSpec();
  const graph = compileOrThrow({
    spec: { ...spec, nodes: spec.nodes.map((n) => ({ ...n, tool: { name: "pay.unknown", version: "1.0" } })) },
    resolver: resolver(),
    tools: { "pay.unknown": { name: "pay.unknown", version: "1.0", capabilities: ["pay:write"], irreversibility: "read_only", idempotent: true } },
    tenantCapabilities: ["pay:write"],
  });
  const runId = await r.engine.submit({ graph, inputs: { amount: 1 } });
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "awaiting_gate", "it gates rather than running something it cannot classify");
});

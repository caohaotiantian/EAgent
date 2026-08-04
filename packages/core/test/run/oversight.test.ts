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
import type { NodeId, RunId } from "../../src/ids.ts";
import type { IrreversibilityClass } from "../../src/vocab.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import type { GateDecision } from "../../src/run/gates.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
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

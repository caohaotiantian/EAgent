/**
 * Gate delivery and the escalation chain.
 *
 * One claim dominates: **delivery failure never auto-approves.** Every other test here
 * exists to make sure the paths around that rule cannot route past it — a dead webhook,
 * an unknown channel name, an exhausted escalation chain. None of them may end in an
 * approval nobody gave.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  ConsoleChannel,
  GateDispatcher,
  SignedWebhookChannel,
  WebhookChannel,
  formatRecipients,
  isChainExhausted,
  redactFields,
  nextTier,
  tierChannels,
  tierRecipients,
  type DeliveryChannel,
  type DeliverySpec,
  type DeliveryTarget,
  type Recipient,
} from "../../src/run/delivery.ts";
import { HumanGateBroker, type GateRequest, type GateSummary } from "../../src/run/gates.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { RunLog } from "../../src/run/log.ts";
import { errorRecord, type JournalEvent } from "../../src/journal/events.ts";
import { CODES, err, isLoomError, type LoomError } from "../../src/errors.ts";
import { SecretValue, maskLiterals } from "../../src/security/redact.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, HumanGateNode } from "../../src/graph/spec.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";
import { digest } from "../../src/canonical.ts";
import type { EdgeId, GateId, NodeId, RunId, TaskId } from "../../src/ids.ts";

const RUN = "run_delivery" as RunId;
const clock = { t: 1_000_000 };
const now = (): number => clock.t;

function rig(opts: { channels?: DeliveryChannel[]; fallback?: DeliveryChannel } = {}) {
  clock.t = 1_000_000;
  const store = new MemoryStateStore({ now });
  const log = new RunLog(RUN, { store, now });
  const console_ = new ConsoleChannel();
  const dispatcher = new GateDispatcher({
    channels: opts.channels ?? [console_],
    fallback: opts.fallback ?? console_,
  });
  const broker = new HumanGateBroker({ now, dispatcher });
  return { store, log, broker, dispatcher, console: console_ };
}

const request = (over: Partial<GateRequest> = {}): GateRequest => ({
  runId: RUN,
  taskId: "restart@root#0" as TaskId,
  nodeId: "restart" as NodeId,
  policyRef: "oversight/restart@stable",
  payload: { command: "kubectl rollout restart deploy/api", blastRadius: 12 },
  ...over,
});

async function events(store: MemoryStateStore): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const e of store.read(RUN, 1)) out.push(e);
  return out;
}

/** A channel that always fails, the way a real one does when the vendor is down. */
class DeadChannel implements DeliveryChannel {
  readonly name: string;
  attempts = 0;
  constructor(name = "dead") {
    this.name = name;
  }
  deliver(): Promise<string> {
    this.attempts++;
    return Promise.reject(new Error("connection refused"));
  }
}

/** A channel that records what it saw, for the redaction test. */
class SpyChannel implements DeliveryChannel {
  readonly name = "spy";
  readonly seen: DeliveryTarget[] = [];
  deliver(target: DeliveryTarget): Promise<string> {
    this.seen.push(target);
    return Promise.resolve(`spy:${this.seen.length}`);
  }
}

// ── the happy path ───────────────────────────────────────────────────────────

test("raising a gate delivers it and journals a receipt", async () => {
  const spy = new SpyChannel();
  const r = rig({ channels: [spy] });
  const gateId = await r.broker.raise(r.log, request({ delivery: { channels: ["spy"] } }));

  assert.equal(spy.seen.length, 1);
  assert.equal(spy.seen[0]?.gate.gateId, gateId);

  const delivered = (await events(r.store)).filter((e) => e.type === "gate.delivered");
  assert.equal(delivered.length, 1);
  assert.equal((delivered[0]?.payload as { receipt: string }).receipt, "spy:1");
});

test("a gate is DURABLE before it is delivered", async () => {
  const spy = new SpyChannel();
  const r = rig({ channels: [spy] });
  await r.broker.raise(r.log, request({ delivery: { channels: ["spy"] } }));

  const seq = await events(r.store);
  const raised = seq.findIndex((e) => e.type === "gate.raised");
  const shipped = seq.findIndex((e) => e.type === "gate.delivered");
  assert.ok(raised >= 0 && shipped > raised, "a crash between them must lose a notification, not a decision");
});

test("delivery goes to every declared channel in parallel", async () => {
  const a = new SpyChannel();
  const b = new ConsoleChannel();
  const r = rig({ channels: [a, b] });
  await r.broker.raise(r.log, request({ delivery: { channels: ["spy", "console"] } }));

  assert.equal(a.seen.length, 1);
  assert.equal(b.queued.length, 1, "telling Slack must not wait on a webhook that is timing out");
});

// ── the rule ─────────────────────────────────────────────────────────────────

test("EVERY CHANNEL FAILING DOES NOT APPROVE ANYTHING", async () => {
  const dead = new DeadChannel();
  const fallback = new ConsoleChannel();
  const r = rig({ channels: [dead], fallback });

  const gateId = await r.broker.raise(r.log, request({ delivery: { channels: ["dead"] } }));

  const open = await r.broker.list(r.log);
  assert.equal(open.length, 1, "the gate is still open");
  assert.equal(open[0]?.gateId, gateId);

  const seq = await events(r.store);
  assert.equal(seq.some((e) => e.type === "gate.decided"), false, "nothing was decided");
  assert.equal(seq.filter((e) => e.type === "gate.delivery_failed").length, 1);
  assert.equal((seq.find((e) => e.type === "gate.delivery_failed")?.payload as { fellBack: boolean }).fellBack, true);
  assert.equal(fallback.queued.length, 1, "…and it landed where a human will find it");
});

test("SEVERAL CHANNELS FAILING IN DIFFERENT WAYS AT ONCE STILL APPROVES NOTHING", async () => {
  // The rule the whole file is arranged around, re-read after the residuals: six channels
  // failing in six shapes, including the two that used to escape `Promise.all` and take
  // the whole dispatch with them. Every one of them is a NOTIFICATION problem.
  const hostile = err.cancelled("unreadable");
  Object.defineProperty(hostile, "message", {
    get(): string {
      throw new Error("hostile getter");
    },
    configurable: true,
  });

  const channels: DeliveryChannel[] = [
    { name: "unreadable-loom", deliver: () => Promise.reject(hostile) },
    { name: "shouty", deliver: () => Promise.reject(err.unavailable(CODES.E_PROVIDER_TRANSPORT, "z".repeat(9000))) },
    {
      name: "trapped",
      deliver: () =>
        Promise.reject(
          new Proxy(new Error("wrapped"), {
            get() {
              throw new Error("every trap throws");
            },
            getPrototypeOf() {
              throw new Error("every trap throws");
            },
          }),
        ),
    },
    { name: "nulls", deliver: () => Promise.reject(Object.create(null) as Error) },
    { name: "dead", deliver: () => Promise.reject(new Error("connection refused")) },
  ];
  const fallback = new ConsoleChannel();
  const r = rig({ channels, fallback });
  const names = [...channels.map((c) => c.name), "ghost"];
  const gateId = await r.broker.raise(r.log, request({ delivery: { channels: names } }));

  const open = await r.broker.list(r.log);
  assert.equal(open.length, 1, "THE GATE IS STILL OPEN");
  assert.equal(open[0]?.gateId, gateId);

  const seq = await events(r.store);
  assert.equal(seq.some((e) => e.type === "gate.decided"), false, "nothing was decided");
  assert.equal(seq.some((e) => e.type === "run.failed"), false, "and a dead notification is not a failed run");

  const failed = seq.filter((e) => e.type === "gate.delivery_failed");
  assert.deepEqual(
    failed.map((e) => (e.payload as { channel: string }).channel).sort(),
    [...names].sort(),
    "every channel that failed is on the record, including the one that does not exist",
  );
  for (const row of failed) {
    const payload = row.payload as { error: unknown; fellBack: boolean };
    assert.equal(typeof payload.error, "string", "a row nobody can read is not a record");
    assert.ok((payload.error as string).length <= 300);
    assert.equal(payload.fellBack, true);
  }
  assert.equal(fallback.queued.length, 1, "…and it landed where a human will find it");
});

test("EVEN THE FALLBACK FAILING LEAVES THE RECORD INTACT", async () => {
  // `DispatcherOptions.fallback` says it must not be able to fail, and `ConsoleChannel`
  // cannot. It is still injected code, and its `deliver` was awaited outside any try:
  // one throw there and `raise` itself rejected, before a single row was appended. The
  // gate stays open either way — that is never in question — but the record of WHY nobody
  // was told is the whole reason the fallback exists.
  const fallback: DeliveryChannel = {
    name: "broken-fallback",
    deliver: () => Promise.reject(new Error("the console queue is on fire")),
  };
  const dead = new DeadChannel();
  const r = rig({ channels: [dead], fallback });

  const gateId = await r.broker.raise(r.log, request({ delivery: { channels: ["dead"] } }));

  const open = await r.broker.list(r.log);
  assert.equal(open.length, 1, "the gate is still open");
  assert.equal(open[0]?.gateId, gateId);

  const seq = await events(r.store);
  assert.equal(seq.some((e) => e.type === "gate.decided"), false, "nothing was decided");
  assert.deepEqual(
    seq.filter((e) => e.type === "gate.delivery_failed").map((e) => (e.payload as { channel: string }).channel).sort(),
    ["broken-fallback", "dead"],
    "both failures are on the record, including the fallback's own",
  );
  assert.equal(
    (seq.find((e) => e.type === "gate.delivery_failed")?.payload as { fellBack: boolean }).fellBack,
    false,
    "a fallback that threw caught nothing, and the row says so",
  );
});

test("an unknown channel name is a delivery failure, not a crash", async () => {
  const fallback = new ConsoleChannel();
  const r = rig({ channels: [], fallback });
  await r.broker.raise(r.log, request({ delivery: { channels: ["slack"] } }));

  const failed = (await events(r.store)).filter((e) => e.type === "gate.delivery_failed");
  assert.equal(failed.length, 1);
  assert.match((failed[0]?.payload as { error: string }).error, /no delivery channel named "slack"/);
  assert.equal(fallback.queued.length, 1);
});

test("a channel name a graph author wrote does not become an audit row", async () => {
  // Not every message on this path comes from a channel: an unknown NAME is quoted into
  // the error, and the name is whatever the `DeliverySpec` says. The bound belongs at the
  // row, which is the one place every producer passes through.
  const fallback = new ConsoleChannel();
  const r = rig({ channels: [], fallback });
  await r.broker.raise(r.log, request({ delivery: { channels: ["s".repeat(5000)] } }));

  const failed = (await events(r.store)).find((e) => e.type === "gate.delivery_failed");
  const message = (failed?.payload as { error: string }).error;
  assert.ok(message.length <= 300, `the journal learned ${message.length} characters of a config typo`);
  assert.match(message, /no delivery channel named/, "…and still says what went wrong");
});

test("a partial failure still counts as delivered", async () => {
  const dead = new DeadChannel();
  const spy = new SpyChannel();
  const fallback = new ConsoleChannel();
  const r = rig({ channels: [dead, spy], fallback });
  await r.broker.raise(r.log, request({ delivery: { channels: ["dead", "spy"] } }));

  assert.equal(fallback.queued.length, 0, "one working channel is enough; the fallback is for zero");
  const seq = await events(r.store);
  assert.equal(seq.filter((e) => e.type === "gate.delivered").length, 1);
  assert.equal(seq.filter((e) => e.type === "gate.delivery_failed").length, 1);
});

test("REDACTION HAPPENS BEFORE THE CHANNEL SEES IT", async () => {
  const spy = new SpyChannel();
  const r = rig({ channels: [spy] });
  await r.broker.raise(
    r.log,
    request({
      payload: { email: "oncall@example.com", command: "restart" },
      delivery: { channels: ["spy"], redact: ["email"] },
    }),
  );

  const seen = JSON.stringify(spy.seen[0]?.payload);
  assert.equal(seen.includes("oncall@example.com"), false, "a channel is outside the trust boundary");
  assert.ok(seen.includes("restart"), "…but the thing being approved is still legible");
});

test("redaction reaches a NESTED field, and leaves its siblings alone", () => {
  const out = redactFields(
    { command: "restart", requester: { name: "Ada", email: "a@example.com" }, blastRadius: 12 },
    ["email"],
    "pii",
    RUN,
  ) as { command: string; requester: { name: string; email: string }; blastRadius: number };

  assert.equal(out.command, "restart");
  assert.equal(out.blastRadius, 12);
  assert.equal(out.requester.name, "Ada", "a path list would have missed this one either way");
  assert.match(out.requester.email, /^pii:/);
});

test("no redact list means the payload passes through untouched", () => {
  const v = { a: 1 };
  assert.equal(redactFields(v, [], "pii", RUN), v);
});

// ── a channel is outside the trust boundary ──────────────────────────────────
//
// `DeliveryTarget.payload` says "already redacted. A channel never sees what the
// classification said to hide" — and the same target handed a channel the UNREDACTED
// payload on `target.gate`, because `GateSummary` carries one and the dispatcher passed
// the summary through whole. `redactFields` returns a NEW tree, so the summary was still
// pointing at the original: not a copy of the secret, the secret itself, one property
// along from the redacted rendering of it.
//
// EVERYTHING HERE DRIVES A REAL `Engine` OVER A COMPILED GRAPH, and that is the point
// rather than thoroughness. Every redaction test above this line drives the broker
// directly, which is exactly the seam at which the mechanism worked. What changed is who
// the sentence is a promise TO: `HumanGateNode.delivery.redact` is declarable and
// `checkDelivery` validates it, so a graph author can now write `redact: ["email",
// "ssn"]`, read that sentence, and be wrong.

const EMAIL = "oncall@example.com";
const SSN = 123_456_789;

/** `start → approve → apply`, where `approve` declares what a channel may not see. */
function redactingSpec(humanGate: HumanGateNode): GraphSpec {
  const id = <T>(s: string): T => s as T;
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "gated-notify", project: "demo", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: {
      plan: { type: "string", reduce: "replace" },
      requester: { type: "object", reduce: "replace" },
      applied: { type: "object", reduce: "replace" },
    },
    inputs: ["plan", "requester"],
    outputs: ["applied"],
    nodes: [
      { id: id<NodeId>("start"), type: "function", reads: ["plan"], function: { ref: "function/noop@stable" } },
      { id: id<NodeId>("approve"), type: "human_gate", reads: ["plan", "requester"], humanGate },
      {
        id: id<NodeId>("apply"),
        type: "function",
        reads: ["plan"],
        writes: ["applied"],
        function: { ref: "function/apply@stable" },
      },
    ],
    edges: [
      { id: id<EdgeId>("e0"), from: id<NodeId>("start"), to: id<NodeId>("approve"), kind: "seq" },
      { id: id<EdgeId>("e1"), from: id<NodeId>("approve"), to: id<NodeId>("apply"), kind: "seq" },
    ],
  };
}

/** Submit that graph and let it park on its gate, with `spy` as its only channel. */
async function gatedRun(
  humanGate: HumanGateNode,
  opts: { channels?: readonly DeliveryChannel[]; requester?: Readonly<Record<string, unknown>> } = {},
): Promise<{
  readonly spy: SpyChannel;
  readonly fallback: ConsoleChannel;
  readonly engine: Engine;
  readonly store: MemoryStateStore;
  readonly runId: RunId;
}> {
  clock.t = 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const spy = new SpyChannel();
  const fallback = new ConsoleChannel();
  const broker = new HumanGateBroker({
    now,
    dispatcher: new GateDispatcher({ channels: opts.channels ?? [spy], fallback }),
  });
  const functions = new FunctionRegistry();
  functions.register("function/noop@stable", () => ({}));
  functions.register("function/apply@stable", () => ({ writes: { applied: {} } }));
  const engine = new Engine({ store, functions, now, gates: broker });

  const runId = await engine.submit({
    graph: compileOrThrow({ spec: redactingSpec(humanGate), resolver: resolver(), tools: {} }),
    inputs: {
      plan: "scale api to 12 replicas",
      requester: opts.requester ?? { name: "Ada", email: EMAIL, ssn: SSN },
    },
  });
  assert.equal((await engine.advance(runId)).status, "awaiting_gate", "the graph reached its gate");
  return { spy, fallback, engine, store, runId };
}

/** The gate block every test below starts from: one channel, two fields it may not see. */
const REDACTING: HumanGateNode = {
  ref: "oversight/apply-plan@stable",
  delivery: { channels: ["spy"], redact: ["email", "ssn"] },
};

/** Whatever a channel was handed, as the string an assertion can search. */
function asSeen(target: DeliveryTarget): string {
  const { values } = reachable(target, { protos: true });
  return values.map((v) => String(v)).join(" ");
}

/**
 * Everything a channel can GET TO from the object it was handed.
 *
 * Not `JSON.stringify`, which is what the older test used and which sees own enumerable
 * properties only. The three ways a value survives a redactor are all invisible to it: a
 * second field, a nested object still shared by reference with the original, and an
 * accessor inherited through the prototype chain. So this walks own property NAMES
 * (getters included, reads guarded), array elements, and `getPrototypeOf` at every level,
 * and returns both the leaves it found and the objects it went through.
 */
function reachable(root: unknown, opts: { protos?: boolean } = {}): { values: unknown[]; objects: object[] } {
  const values: unknown[] = [];
  const objects: object[] = [];
  const seen = new Set<unknown>();
  const visit = (v: unknown, depth: number): void => {
    if (depth > 12) return;
    if (v === null || (typeof v !== "object" && typeof v !== "function")) {
      values.push(v);
      return;
    }
    if (seen.has(v)) return;
    seen.add(v);
    objects.push(v as object);
    for (const k of Object.getOwnPropertyNames(v)) {
      let child: unknown;
      // `Function.prototype.caller` throws in strict mode; a channel reading it learns
      // nothing either way, and a probe that dies on it proves nothing.
      try {
        child = (v as Record<string, unknown>)[k];
      } catch {
        continue;
      }
      visit(child, depth + 1);
    }
    if (opts.protos === true) visit(Object.getPrototypeOf(v), depth + 1);
  };
  visit(root, 0);
  return { values, objects };
}

test("A GRAPH THAT DECLARES `redact` GETS A CHANNEL THAT CANNOT REACH THE VALUE", async () => {
  const { spy, engine, runId } = await gatedRun(REDACTING);

  assert.equal(spy.seen.length, 1, "the gate was DELIVERED, not merely queued");
  const target = spy.seen[0]!;

  // What the channel is SUPPOSED to have: the token, so two occurrences still correlate,
  // and the thing being approved still legible — a human cannot approve what they
  // cannot see.
  const state = (target.payload as { state: { requester: { email: string; name: string } } }).state;
  assert.match(state.requester.email, /^pii:/, "the channel got a token");
  assert.equal(state.requester.name, "Ada", "…and everything outside the redact list is still legible");

  // AND NOTHING ELSE. Not through a second field, not through a shared subtree, not
  // through the prototype chain.
  const got = reachable(target, { protos: true });
  assert.equal(got.values.includes(EMAIL), false, "a channel is outside the trust boundary");
  assert.equal(got.values.includes(SSN), false, "…and a number is a field like any other");

  // THE REFERENCE CHECK, which is the shape this bug actually had. The broker still holds
  // the real payload — it is inside the boundary, and `GET /runs/:id/gates` serves it to
  // an authenticated operator — so "no object of the real tree is reachable from the
  // target" is the property, not "the broker forgot".
  const real = (await engine.openGates(runId))[0]!.payload;
  assert.equal(
    (real as { state: { requester: { email: string } } }).state.requester.email,
    EMAIL,
    "the gate the broker holds is unredacted, on purpose",
  );
  const shared = new Set(reachable(real).objects);
  for (const o of got.objects) {
    assert.equal(shared.has(o), false, "the target shares a subtree with the unredacted payload by reference");
  }

  // The summary travels WITH its redacted payload rather than without one: a channel
  // reading `target.gate.payload` gets the question, not `undefined` and not the answer.
  assert.deepEqual(target.gate.payload, target.payload);
});

test("A CHANNEL CANNOT REWRITE THE QUESTION, AND THE DEFAULT GATE IS THE ONE THAT LET IT", async () => {
  // The test above establishes the INBOUND half of "hand out nothing that still points at
  // the original": the channel cannot read what was hidden. This is the same sentence read
  // OUTBOUND, and it had a hole shaped exactly like the common case.
  //
  // `redactFields` returns a new tree — except that it SHORT-CIRCUITS on an empty list and
  // returns the caller's own, and an empty list is the DEFAULT: most gates hide nothing. So
  // a channel was handed the broker's live payload object by reference, and a channel is
  // injected code outside the trust boundary. `deliver` now owns the tree in both branches.
  const seen: DeliveryTarget[] = [];
  class Vandal implements DeliveryChannel {
    readonly name = "vandal";
    deliver(t: DeliveryTarget): Promise<string> {
      seen.push(t);
      (t.payload as Record<string, unknown>)["command"] = "rm -rf /";
      return Promise.resolve("ok");
    }
  }
  const r = rig({ channels: [new Vandal()] });
  const asked = { command: "kubectl rollout restart deploy/api", blastRadius: 12 };
  // No `redact`, which is the whole point: the version that hides something was never
  // exposed, because `redact`'s walk rebuilds every container on the way down.
  await r.broker.raise(r.log, request({ payload: asked, delivery: { channels: ["vandal"] } }));

  assert.equal(seen.length, 1, "the gate was delivered — this is not a test about failing");
  assert.equal(asked.command, "kubectl rollout restart deploy/api", "the caller's own object was rewritten");

  // WHAT IT COSTS IF IT IS SHARED, which is why this is not merely untidy. The broker's
  // ephemeral payload is what `list` reports, what `GET /runs/:id/gates` serves an operator,
  // and what the NEXT escalation tier is delivered — while `gate.raised` and its
  // `contentDigest` still record the real one. A tier-0 channel could therefore change the
  // question tier 1 is asked, which is D7.8's "the approver was shown the wrong diff"
  // arriving from the channel side, and the digest that exists to settle it is the only
  // thing that would ever disagree.
  const summary = (await r.broker.list(r.log))[0]!;
  assert.deepEqual(summary.payload, asked, "the question a later tier and the operator API are shown");

  // A PAYLOAD THAT CANNOT BE COPIED IS STILL DELIVERED, and still the caller's tree. The
  // copy is a JSON round trip, so a bigint or a cycle has none — and a gate nobody was told
  // about is the outcome this whole file exists to prevent, so the fallback is today's
  // behaviour rather than a new failure.
  const spy = new SpyChannel();
  const dispatcher = new GateDispatcher({ channels: [spy], fallback: new ConsoleChannel() });
  const uncopyable = { command: "restart", seats: 7n };
  const outcome = await dispatcher.deliver(r.log, { ...summary, payload: uncopyable }, { channels: ["spy"] });
  assert.equal(outcome.delivered.length, 1);
  assert.equal(spy.seen[0]!.payload, uncopyable, "the original, because there is no copy to hand over");
});

test("A CHANNEL CANNOT WRITE ITSELF INTO THE NEXT GATE'S APPROVERS LIST", async () => {
  // The two tests above read `DeliveryTarget.payload`'s promise — "a claim about THIS WHOLE
  // OBJECT and not about this field, because a channel is handed the whole thing" — for the
  // payload. The whole object is `{...gate}`, a SHALLOW spread, and the two fields it copies
  // by reference are the two that DECIDE something: `approvers` and `allowEdit` arrive from
  // the compiled graph node (`engine.ts`'s `approvers: node.humanGate?.approval?.approvers ??
  // []`) and are the same arrays every later raise on that node reads. So a channel — which
  // this file's own boundary note calls the untrusted side — held the authorization list of
  // every future gate on that node, by reference, and `push` was the whole exploit.
  //
  // THIS RUN'S gate is safe either way: the append canonicalizes, so the journal already
  // holds a copy by the time delivery starts. The NEXT one is not, and that is the bug —
  // it is `gates.ts`'s "AUTHORIZATION IS READ FROM THE JOURNAL" met from the other end, by
  // editing what is about to BE the journal.
  const node = { approvers: ["sre-lead"], allowEdit: ["findings"] };
  const recipients = [{ kind: "role", id: "sre-oncall" }] as const;
  class Climber implements DeliveryChannel {
    readonly name = "climber";
    deliver(t: DeliveryTarget): Promise<string> {
      (t.gate.approvers as string[]).push("mallory");
      (t.gate.allowEdit as string[]).push("prod_state");
      (t.recipients as { kind: string; id: string }[]).push({ kind: "user", id: "mallory" });
      return Promise.resolve("climber:1");
    }
  }
  const store = new MemoryStateStore({ now });
  const dispatcher = new GateDispatcher({ channels: [new Climber()], fallback: new ConsoleChannel() });
  const broker = new HumanGateBroker({ now, dispatcher });
  const raiseOn = async (runId: RunId): Promise<GateSummary> => {
    const log = new RunLog(runId, { store, now });
    const gateId = await broker.raise(log, {
      ...request(),
      runId,
      approvers: node.approvers,
      allowEdit: node.allowEdit,
      delivery: { channels: ["climber"], recipients },
    });
    return (await broker.list(log)).find((g) => g.gateId === gateId)!;
  };

  const first = await raiseOn("run_climb_a" as RunId);
  assert.deepEqual(first.approvers, ["sre-lead"], "the gate that was being delivered");
  const second = await raiseOn("run_climb_b" as RunId);
  assert.deepEqual(second.approvers, ["sre-lead"], "…and the NEXT gate on the same node, which is where it landed");
  assert.deepEqual(second.allowEdit, ["findings"], "the edit allow-list is the same field one column over");
  assert.deepEqual(node, { approvers: ["sre-lead"], allowEdit: ["findings"] }, "the compiled graph itself");
  assert.deepEqual(recipients, [{ kind: "role", id: "sre-oncall" }], "and the route the next tier is delivered over");
});

/**
 * Every field of a `GateSummary` whose value is a CONTAINER — DERIVED, not listed.
 *
 * The test below is the one that is supposed to go red on the next container field "whether
 * or not anybody remembers `shownGate`". It did not, and the reason is that its fixture named
 * the four fields somebody remembered: `GateRecord.batch` arrived afterwards, `{...gate}`
 * shared it by reference, and the identity walk saw nothing because there was no `batch` on
 * the target to be shared. A structural rule pinned by a hand-written fixture is a rule about
 * that fixture.
 *
 * So the fixture is derived from the type. A new object-valued field on `GateRecord` with no
 * entry in `containers` below is a COMPILE error here, before it is an aliasing hole there.
 * Branded ids (`GateId`, `TaskId`, `Seq`) are `string & {…}` and DO satisfy `extends object`,
 * which is why the primitive arm is asked first and is not decoration.
 */
type ContainerField = {
  [K in keyof GateSummary]-?: NonNullable<GateSummary[K]> extends string | number | boolean
    ? never
    : NonNullable<GateSummary[K]> extends object
      ? K
      : never;
}[keyof GateSummary];

test("…AND THE RULE IS STRUCTURAL: NOTHING ON THE TARGET IS AN OBJECT THE ENGINE STILL HOLDS", async () => {
  // The test above names four fields. This one names none, so it goes red the day another
  // container field is added to `GateRecord` and copied by reference — which is how the
  // `approvers` hole arrived in the first place, as a field added to a type the dispatcher
  // spreads. "Hand out nothing that still points at the original" is an identity property,
  // so it is checked as one.
  const r = rig();
  const spy = new SpyChannel();
  const dispatcher = new GateDispatcher({ channels: [spy], fallback: new ConsoleChannel() });
  await r.broker.raise(r.log, request({ payload: { command: "restart" } }));
  const summary = (await r.broker.list(r.log))[0]!;
  // Every container a `GateSummary` can carry, three of them only a DECIDED or a BATCHED
  // gate has: `deliver` is public, so "an open gate never has them" is a claim about its
  // callers rather than about the type. The annotation is what makes the list exhaustive.
  const containers: { readonly [K in ContainerField]-?: NonNullable<GateSummary[K]> } = {
    payload: { command: "restart" },
    approvers: ["sre-lead"],
    excludedApprovers: ["u:alice"],
    allowEdit: ["findings"],
    writes: { findings: { note: "ok" } },
    take: ["e1"],
    batch: { id: "gate_first" as GateId, key: "policy:restart" },
  };
  const source: GateSummary = { ...summary, ...containers };
  const spec: DeliverySpec = { channels: ["spy"], recipients: [{ kind: "role", id: "sre" }] };
  await dispatcher.deliver(r.log, source, spec);

  const held = new Set(reachable({ source, spec }).objects);
  for (const o of reachable(spy.seen[0]!).objects) {
    assert.equal(held.has(o), false, `the target shares an object with what the engine holds: ${JSON.stringify(o).slice(0, 80)}`);
  }
  // …and the copy still SAYS what the original said, which is the half an identity walk
  // cannot check: a `batch` rebuilt as `{}` would pass the loop above and lose the fact.
  assert.deepEqual(spy.seen[0]!.gate.batch, containers.batch, "the batch a channel is shown is the batch the gate is in");
});

// ── the copy has to say what the original said, and the reads that build it are total ──
//
// The two tests above pin the IDENTITY half of `deliver`'s prelude: nothing on the target
// is an object the engine still holds. This block is the other half of the same rebuild,
// and the three ways it was wrong are three different failures of one rule — *a copy is a
// claim about the original*.
//
//   - it DROPPED what it did not know the name of (`{kind: r.kind, id: r.id}`);
//   - it EMPTIED what it could not render (`ownedJson(gate.writes) ?? {}`);
//   - and for anything that was not an array it made no copy at all.
//
// Every one of them is silent, and the prelude they live in sits outside every try in a
// file whose single rule is that delivery has one exit.

test("A RECIPIENT REACHES THE CHANNEL AS THE GRAPH DECLARED IT, EXTRA FIELDS AND ALL", async () => {
  // `graph/validate.ts`'s `checkRecipient` validates `kind` and `id` and ACCEPTS every
  // other key — it validates fields, like every check in that file, rather than closing the
  // shape — so a graph may legitimately carry vendor routing metadata on a recipient. That
  // is the one hop where such a field is useful: `Recipient` is "resolved by the channel,
  // not by the broker", and the dispatcher is the only thing standing between the two.
  //
  // `ownedRecipients` rebuilt each entry as `{kind, id}`, so the compiler admitted a
  // declaration the dispatcher then deleted — no diagnostic at either end, and a channel
  // that never routes where the graph said. THE TWO NOW AGREE, and this test is which way
  // round: the dispatcher carries everything the compiler admits.
  const routed = { kind: "role", id: "sre-oncall", slackChannel: "C024BE7LH", locale: { lang: "en" } };
  const r = await gatedRun({
    ref: "oversight/apply-plan@stable",
    delivery: { channels: ["spy"], recipients: [routed] as unknown as readonly Recipient[] },
  });

  const seen = r.spy.seen[0]!.recipients;
  assert.deepEqual(seen, [routed], "the compiler admitted these fields and the dispatcher deleted them");
  // …and it is still a COPY all the way down. Completeness is not bought with the identity
  // property above: the compiled graph holds the author's own recipient objects (measured —
  // `compileOrThrow` puts the very object from the spec on the plan), so a shared one is
  // the `approvers` exploit with a different field name.
  assert.notEqual(seen[0], routed, "the channel holds the compiled graph's own recipient");
  assert.notEqual((seen[0] as unknown as { locale: unknown }).locale, routed.locale, "…and one container deeper");
});

test("…AND A RECIPIENT THE GRAPH WROTE CANNOT MAKE `deliver` EXIT UNTYPED", async () => {
  // `r.kind` and `r.id` are property reads on a value assembled outside this module, in a
  // prelude that sits outside every try. The audit table that cleared them said "passed
  // through unchanged, no getter run … total by construction"; both halves were false, and
  // this is the second half. A gate is DURABLE before it is delivered, so the throw does
  // not lose the gate — it loses the delivery, the fallback, and both journal rows.
  const r = rig();
  const spy = new SpyChannel();
  const dispatcher = new GateDispatcher({ channels: [spy], fallback: new ConsoleChannel() });
  await r.broker.raise(r.log, request({ payload: { command: "restart" } }));
  const summary = (await r.broker.list(r.log))[0]!;
  const hostile = {
    get kind(): string {
      throw new Error("a recipient that will not say what it is");
    },
    id: "u:mallory",
  };

  const outcome = await dispatcher.deliver(r.log, summary, {
    channels: ["spy"],
    recipients: [hostile] as unknown as readonly Recipient[],
  });
  assert.equal(outcome.delivered.length, 1, "reading a recipient threw, and nobody was told about the gate");
  assert.equal((spy.seen[0]!.recipients[0] as unknown as { id: unknown }).id, "u:mallory", "the half that could be read still routes");
});

test("…AND NEITHER CAN THE LIST, WHICH IS THE READ THE DEGRADE PATH PUT BACK OUTSIDE THE TRY", async () => {
  // The fix above moved every recipient read inside `ownedJson`'s try — and then reached the
  // per-entry degrade through `recipients.map`, which READS THE ELEMENTS. The only way to
  // arrive there is for the whole-list copy to have failed, and a throwing element getter is
  // exactly how to make it fail, so the shape that sent us down the degrade path was re-run
  // one line below the fix, outside every try. Same defect, one level up, four lines apart.
  const r = rig();
  const spy = new SpyChannel();
  const dispatcher = new GateDispatcher({ channels: [spy], fallback: new ConsoleChannel() });
  await r.broker.raise(r.log, request({ payload: { command: "restart" } }));
  const summary = (await r.broker.list(r.log))[0]!;

  const recipients: unknown[] = [{ kind: "role", id: "sre-oncall" }];
  Object.defineProperty(recipients, "1", {
    get(): unknown {
      throw new Error("a recipient LIST whose element read throws");
    },
    enumerable: true,
    configurable: true,
  });

  const outcome = await dispatcher.deliver(r.log, summary, {
    channels: ["spy"],
    recipients: recipients as readonly Recipient[],
  });
  assert.equal(outcome.delivered.length, 1, "reading the LIST threw, and nobody was told about the gate");
  const seen = spy.seen[0]!.recipients;
  assert.equal(seen.length, 2, "degrading per entry keeps the list's shape");
  assert.deepEqual(seen[0], { kind: "role", id: "sre-oncall" }, "the entry that could be read still routes");
  // THIS ASSERTION USED TO READ `{kind: undefined, id: undefined}`, under the comment "…and
  // the one that could not is an address of nothing". An address of nothing routes NOWHERE,
  // and it is what a recipient DECLARING neither field also produces — see the test named
  // for that collision below.
  assert.deepEqual(seen[1], { kind: "(unrenderable)", id: "(unrenderable)" }, "…and the one that could not says so");
});

test("AN UNREADABLE RECIPIENT IS NOT A RECIPIENT WITH NO ADDRESS", async () => {
  // `ownedList` was given a per-index degrade in the same wave as `ownedRecipients` and
  // answered an unreadable element with an explicit marker; this one answered with
  // `addressOnly(<nothing>)` = `{kind: undefined, id: undefined}`, which `JSON.stringify`
  // renders `{}` — byte-identical to what a recipient that declares neither field produces
  // on the WHOLE-COPY path. Measured before the fix, both came out of the dispatcher as
  // `[{}]`. A channel could therefore not tell "this recipient could not be read" from "this
  // recipient names nobody", and only one of those is a fact about the graph.
  //
  // The two helpers differ FOR A REASON ABOUT THE ELEMENT TYPE, not about taste: `ownedList`
  // serves lists of STRINGS, so a bare marker is in shape; `recipients` is a list of RECORDS
  // that every reader indexes into, so the marker goes in the FIELD and the record survives.
  const r = rig();
  const spy = new SpyChannel();
  const dispatcher = new GateDispatcher({ channels: [spy], fallback: new ConsoleChannel() });
  await r.broker.raise(r.log, request({ payload: { command: "restart" } }));
  const summary = (await r.broker.list(r.log))[0]!;
  const sent = async (recipients: unknown): Promise<readonly Recipient[]> => {
    await dispatcher.deliver(r.log, summary, { channels: ["spy"], recipients: recipients as readonly Recipient[] });
    return spy.seen.at(-1)!.recipients;
  };

  // A revoked proxy defeats the whole-list copy AND every field read, so it is the entry
  // nothing at all can be learned from.
  const revoked = Proxy.revocable({ kind: "role", id: "sre-oncall" }, {});
  revoked.revoke();
  assert.deepEqual(await sent([revoked.proxy]), [{ kind: "(unrenderable)", id: "(unrenderable)" }], "an entry nothing could be read from");

  // THE FACT IT HAS TO STAY DISTINGUISHABLE FROM, asserted second so the marker above is not
  // merely what this path always returns.
  assert.deepEqual(await sent([{}]), [{}], "…and a recipient that really does name nothing");

  // AND THE DEGRADE IS PER FIELD, so half an address still routes.
  const halfRead: Record<string, unknown> = { kind: "role", id: "sre-oncall" };
  halfRead["self"] = halfRead; // a cycle, so the whole copy fails and the walk runs
  assert.deepEqual(await sent([halfRead]), [{ kind: "role", id: "sre-oncall" }], "an address the walk could read");

  // AND NOTHING ON THAT PATH IS AN OBJECT THE CALLER STILL HOLDS. `addressOnly` used to hand
  // the field on with a bare `readProp`, which is a total READ of a value it then SHARED:
  // measured, `recipients[0].kind === <the caller's own object>` was true, inside the
  // function whose docstring promises "no live code and no container shared at any depth".
  const live = { toString(): string { throw new Error("a live object on the routing list"); } };
  const shares: Record<string, unknown> = { kind: live, id: "sre" };
  shares["self"] = shares;
  const out = await sent([shares]);
  assert.equal((out[0] as unknown as { kind: unknown }).kind === live, false, "the channel holds nothing the caller does");
});

test("A `recipients` THAT IS NOT A LIST IS DELIVERED, NOT DIAGNOSED — AND THE FALLBACK SURVIVES IT", async () => {
  // `ownedRecipients` passes a non-list on rather than substituting `[]`, and justified it
  // with a consequence: "every channel then fails loudly on `recipients.map`, which is a
  // diagnosis". Neither half held. This is what actually happens, measured, because a
  // justification nobody executed is a justification nobody checked.
  const r = rig();
  const single = { kind: "role", id: "sre-oncall" } as unknown as readonly Recipient[];
  await r.broker.raise(r.log, request({ payload: { command: "restart" } }));
  const summary = (await r.broker.list(r.log))[0]!;

  // 1. `WebhookChannel` NEVER CALLS `.map`. It puts `recipients` in a JSON body, so it
  //    delivers, returns a receipt, and ships the malformed value to the receiver.
  const bodies: { recipients: unknown }[] = [];
  const hook = new WebhookChannel({
    url: "https://hooks.example.com/svc/T0/B0/xyz",
    fetch: ((_u: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as { recipients: unknown });
      return Promise.resolve(new Response("receipt-1", { status: 200 }));
    }) as unknown as typeof globalThis.fetch,
  });
  const viaHook = new GateDispatcher({ channels: [hook], fallback: new ConsoleChannel() });
  const posted = await viaHook.deliver(r.log, summary, { channels: ["webhook"], recipients: single });
  assert.equal(posted.failed.length, 0, "the file's own channel does not fail loudly on this");
  assert.deepEqual(bodies[0]!.recipients, { kind: "role", id: "sre-oncall" }, "it goes on the wire as it arrived");

  // 2. `ConsoleChannel` DOES call `.map` — and the loud failure was not a diagnosis, it was
  //    a delivery failure. Since the built-in FALLBACK is a `ConsoleChannel` too, it failed
  //    identically: measured before the fix, `delivered: 0, failed: 2, fellBack: false`. The
  //    one channel that exists so that "nobody was told" is never the outcome produced
  //    exactly that outcome, from a graph that compiles.
  const console_ = new ConsoleChannel();
  const viaConsole = new GateDispatcher({ channels: [console_], fallback: new ConsoleChannel() });
  const queued = await viaConsole.deliver(r.log, summary, { channels: ["console"], recipients: single });
  assert.equal(queued.failed.length, 0, "THE FALLBACK MAY NOT BE THE THING THAT FAILS");
  assert.equal(queued.delivered.length, 1);
  assert.equal(console_.queued.length, 1, "the gate is where a human will find it");

  // …and the marker is what a non-list renders as, deliberately not "anyone" — that is what
  // an EMPTY list renders as, and "the graph named nobody" is a different fact from "the
  // graph named something I cannot route".
  const lines: string[] = [];
  const sinkC = new ConsoleChannel({ sink: (line) => lines.push(line) });
  const viaSink = new GateDispatcher({ channels: [sinkC], fallback: new ConsoleChannel() });
  await viaSink.deliver(r.log, summary, { channels: ["console"], recipients: single });
  await viaSink.deliver(r.log, summary, { channels: ["console"], recipients: [] });
  assert.match(lines[0]!, /awaits \(unrenderable\)$/, "a list this channel cannot walk");
  assert.match(lines[1]!, /awaits anyone$/, "…and a list that names nobody");
});

test("THE FALLBACK CANNOT FAIL, AND EVERY READ LEFT IN IT WAS A WAY TO", async () => {
  // The previous wave replaced a bare `Array.isArray` here under the sentence "so the format
  // is total" — and the FORMAT went on reading the elements, `r.kind` and `r.id` bare, with
  // `${…}` coercing both. What resolving a receipt from this class ASSERTS is one thing:
  // this target is in the queue where a human will find it, and the sink was told. Every
  // other read in the method is a RENDERING, and a rendering may not decide whether a gate
  // was queued.
  //
  // Every row below THREW before the fix, measured on node v24.16.0. The sink is wired so
  // the line is actually built: with none, three of these would pass for the wrong reason.
  const lines: string[] = [];
  const ch = new ConsoleChannel({ sink: (line) => lines.push(line) });
  const gate = { gateId: "gate_1", nodeId: "restart" };
  const base = { gate, recipients: [], payload: {}, tier: 0 };

  const withAccessor: unknown[] = [];
  Object.defineProperty(withAccessor, "0", {
    get(): unknown { throw new Error("an element read that throws"); },
    enumerable: true,
    configurable: true,
  });
  const revoked = Proxy.revocable({ kind: "role", id: "sre" }, {});
  revoked.revoke();
  const mapTrap = new Proxy([{ kind: "role", id: "sre" }], {
    get(t, k, recv): unknown {
      if (k === "map") throw new Error("a `map` trap that throws");
      return Reflect.get(t, k, recv) as unknown;
    },
  });
  const thrower = { toString(): string { throw new Error("a value that will not be a string"); } };

  const cases: readonly [string, unknown][] = [
    ["an array with a throwing accessor at [0]", { ...base, recipients: withAccessor }],
    ["an entry with a throwing `kind` getter", { ...base, recipients: [{ get kind(): string { throw new Error("kind"); }, id: "sre" }] }],
    ["an entry whose `id` throws on ToString", { ...base, recipients: [{ kind: "role", id: thrower }] }],
    ["an entry that is a revoked proxy", { ...base, recipients: [revoked.proxy] }],
    ["a proxy over an array whose `map` trap throws", { ...base, recipients: mapTrap }],
    ["a `gateId` that throws on ToString", { ...base, gate: { gateId: thrower, nodeId: "restart" } }],
    ["a `nodeId` that throws on ToString", { ...base, gate: { gateId: "gate_1", nodeId: thrower } }],
    ["a `gateId` that is a throwing getter", { ...base, gate: { get gateId(): string { throw new Error("gateId"); }, nodeId: "n" } }],
    ["a `tier` that throws on ToString", { ...base, tier: thrower }],
    ["no `gate` on the target at all", { recipients: [], payload: {}, tier: 0 }],
    ["no target at all", null],
  ];

  for (const [what, target] of cases) {
    const before = ch.queued.length;
    const receipt = await ch.deliver(target as unknown as DeliveryTarget);
    assert.equal(typeof receipt, "string", `${what}: the fallback resolved a receipt`);
    assert.equal(ch.queued.length, before + 1, `${what}: …and the gate is where a human will find it`);
  }
  assert.equal(lines.length, cases.length, "every one of them built a line for a human, too");
  assert.match(lines[0]!, /^gate gate_1 on node restart awaits \(unrenderable\):\(unrenderable\)$/, "the unreadable entry is a position, not a gap");
  assert.match(lines[5]!, /^gate \(unknown\) on node restart awaits anyone$/, "an unusable gate id gets the marker every unusable gate id here gets");
  assert.match(lines[6]!, /^gate gate_1 on node \(unrenderable\) awaits anyone$/, "…and an unusable node id gets the prelude's");

  // THE SINK IS STILL NOT CAUGHT, which is the same sentence read against a different value.
  // Rendering a routing list is not the notification; the sink IS, for a deployment whose
  // console is a log line rather than `queued`. A receipt for a notification that did not
  // happen is worse than no channel — `DeliveryChannel.deliver`'s own rule.
  // (`throws` and not `rejects`: the sink is called before the receipt is resolved, so this
  // one leaves synchronously. The dispatcher `await`s inside a try, so it is a delivery
  // failure either way — see `NOTHING RUNS ABOVE THE TRY`.)
  const broken = new ConsoleChannel({ sink: () => { throw new Error("the console is the notification"); } });
  assert.throws(() => broken.deliver({ ...base } as unknown as DeliveryTarget), /the console is the notification/);
});

test("…AND THE ONE OF THOSE THE DISPATCHER REACHES ON ITS OWN", async () => {
  // Four of the rows above are not an embedder's own foot: `ownedRecipients`' degrade path
  // answers an entry it could not copy with `addressOnly`, which copied `kind` and `id`
  // UNCHECKED — so a live object with a throwing `toString` arrived at the fallback inside an
  // otherwise well-formed list. Reproduced end to end before the fix: `delivered: 0,
  // failed: 2, fellBack: false`, journal `gate.delivery_failed ×2`. The one channel that
  // exists so that "nobody was told" is never the outcome produced exactly that outcome.
  const r = rig();
  const console_ = new ConsoleChannel();
  const dispatcher = new GateDispatcher({ channels: [console_], fallback: console_ });
  await r.broker.raise(r.log, request({ payload: { command: "restart" } }));
  const summary = (await r.broker.list(r.log))[0]!;

  const hostile: Record<string, unknown> = { kind: { toString(): string { throw new Error("kind coercion"); } }, id: "sre" };
  hostile["self"] = hostile; // a cycle, so the whole-list copy fails and `addressOnly` runs
  const outcome = await dispatcher.deliver(r.log, summary, {
    channels: ["console"],
    recipients: [hostile] as unknown as readonly Recipient[],
  });

  assert.equal(outcome.failed.length, 0, "THE FALLBACK MAY NOT BE THE THING THAT FAILS");
  assert.equal(outcome.delivered.length, 1);
  assert.equal(console_.queued.length, 1, "the gate is where a human will find it");
  const rows = (await events(r.store)).filter((e) => e.type === "gate.delivery_failed");
  assert.equal(rows.length, 0, "and no `gate.delivery_failed` for a value nobody could render");
});

test("A WRITE-SET THAT COULD NOT BE RENDERED IS NOT AN EMPTY EDIT", async () => {
  const r = rig();
  const spy = new SpyChannel();
  const dispatcher = new GateDispatcher({ channels: [spy], fallback: new ConsoleChannel() });
  await r.broker.raise(r.log, request({ payload: { command: "restart" } }));
  const summary = (await r.broker.list(r.log))[0]!;

  // The reading a failure has to stay distinguishable FROM, so it is asserted first: `{}`
  // is what an edit that writes nothing looks like to an approver.
  await dispatcher.deliver(r.log, { ...summary, writes: {} }, { channels: ["spy"] });
  assert.deepEqual(spy.seen[0]!.gate.writes, {}, "an edit that writes nothing");

  // One field JSON cannot represent used to cost the WHOLE set — `ownedJson` fails for the
  // tree, and `?? {}` renders the failure as the sentence above. The approver is then shown
  // an empty edit, approves it, and the fields that were perfectly representable are the
  // ones they never saw.
  await dispatcher.deliver(r.log, { ...summary, writes: { findings: { note: "ok" }, seats: 7n } }, { channels: ["spy"] });
  assert.deepEqual(
    spy.seen[1]!.gate.writes,
    { findings: { note: "ok" }, seats: "(unrenderable)" },
    "degrade downward — the field that could not be rendered, never the set",
  );
});

test("…AND THE SHAPE CHECK THAT DECIDES THAT IS ON THE INPUT, NOT ON THE COPY", async () => {
  // `ownedJson(writes)` was asked whether IT was a record, and it answers `{}` for every
  // object whose data is not in own properties — so the empty-edit reading the function
  // exists to prevent was reachable through the check meant to prevent it. And the one
  // shape that did fail the result check fell to the per-key walk, where an array's keys
  // are its indices: an edit to a channel called `length`.
  const r = rig();
  const spy = new SpyChannel();
  const dispatcher = new GateDispatcher({ channels: [spy], fallback: new ConsoleChannel() });
  await r.broker.raise(r.log, request({ payload: { command: "restart" } }));
  const summary = (await r.broker.list(r.log))[0]!;

  const cases: readonly [string, unknown][] = [
    ["a Map with two entries", new Map([["findings", "ok"], ["prod_state", "drain"]])],
    ["a Set with two entries", new Set(["findings", "prod_state"])],
    ["a class instance holding private state", new (class { #v = 1; get v(): number { return this.#v; } })()],
    ["an array", ["findings", "prod_state"]],
  ];
  for (const [what, writes] of cases) {
    await dispatcher.deliver(r.log, { ...summary, writes: writes as Readonly<Record<string, unknown>> }, { channels: ["spy"] });
    assert.deepEqual(spy.seen.at(-1)!.gate.writes, { "(unrenderable)": true }, `${what} is not an empty edit`);
  }

  // THE READING THIS HAS TO STAY DISTINGUISHABLE FROM, asserted last so the marker above is
  // not merely "what this function always returns": `{}` may only ever mean `{}`.
  await dispatcher.deliver(r.log, { ...summary, writes: {} }, { channels: ["spy"] });
  assert.deepEqual(spy.seen.at(-1)!.gate.writes, {}, "an edit that writes nothing still writes nothing");
});

test("…AND ITS SIBLING, WRITTEN IN THE SAME WAVE, WENT ON ASKING THE COPY: `batch`", async () => {
  // `ownedWrites` was moved to the input check above. `ownedBatch` — added by the same
  // change, 170 lines up the file — kept `isPlainRecord(ownedJson(batch))`, which is the
  // spelling that was just removed. Same function, same argument, same answer: `ownedJson`
  // reports `{}` for every object whose data is not in own properties, and `isPlainRecord`
  // says yes to `{}` — so a batch the copy could not carry renders as `{}`, which is what a
  // gate in NO batch looks like to the channel reading `target.gate.batch`.
  //
  // A batch is not decoration: it is which OTHER gates this decision also answers (D7.9
  // row 2), folded onto the record from `gate.raised.batch`. "Answer these two together"
  // rendering as "answer this one" is the same class of quiet substitution as `{}` for an
  // edit that could not be rendered.
  const r = rig();
  const spy = new SpyChannel();
  const dispatcher = new GateDispatcher({ channels: [spy], fallback: new ConsoleChannel() });
  await r.broker.raise(r.log, request({ payload: { command: "restart" } }));
  const summary = (await r.broker.list(r.log))[0]!;
  const deliverWith = async (batch: unknown): Promise<unknown> => {
    await dispatcher.deliver(r.log, { ...summary, batch: batch as NonNullable<GateSummary["batch"]> }, { channels: ["spy"] });
    return spy.seen.at(-1)!.gate.batch;
  };

  // The marker pair: a batch was named and we could not say which one. `id` goes through
  // `safeGateId`, so its marker is the one every unusable gate id in this file gets.
  const unrenderable = { id: "(unknown)", key: "(unrenderable)" };
  assert.deepEqual(await deliverWith(new Map([["id", "gate_first"], ["key", "policy:restart"]])), unrenderable, "a Map");
  assert.deepEqual(await deliverWith(new (class { #v = 1; get v(): number { return this.#v; } })()), unrenderable, "private state");
  // The array is the shape that did NOT come back `{}` — it failed the result check and
  // fell to the per-key walk, where an array's own names are its indices and `length`. The
  // same lie one field over from "an edit to a channel called `length`".
  assert.deepEqual(await deliverWith(["gate_first", "policy:restart"]), unrenderable, "an array is not a batch");

  // AND THE FACTS THIS HAS TO STAY DISTINGUISHABLE FROM. The whole-copy path still carries
  // every field the record grew — this one has five — and the per-key degrade still keeps
  // the fields that CAN be rendered, which is what makes the marker above information.
  const whole = { id: "gate_first" as GateId, key: "policy:restart", windowMs: 60_000, maxBatch: 5, deliveryDigest: "abc" };
  assert.deepEqual(await deliverWith(whole), whole, "a real batch is carried whole, governance and all");
  assert.deepEqual(
    await deliverWith({ ...whole, maxBatch: 5n }),
    { ...whole, maxBatch: "(unrenderable)" },
    "degrade downward, per key — the field that could not be rendered, never the batch",
  );
  assert.equal(spy.seen.at(-1)!.gate.batch === undefined, false, "…and never into the absent reading");
});

test("…AND ONE FUNCTION MAY NOT ANSWER ONE QUESTION TWO WAYS: `ownedBatch` NORMALIZES ON BOTH PATHS", async () => {
  // The docstring said "`id` and `key` are then made to be the strings the type says they
  // are, `id` through `safeGateId` so it also names no prototype" — of a function whose
  // whole-copy path RETURNED before reaching either. So the claim described the slow branch
  // only, and the fast one handed a channel whatever the record held. What this function
  // ASSERTS is a property of its RETURN TYPE, and a claim about a return type cannot be
  // contingent on which branch built it.
  //
  // Every row is asserted against the SAME input made uncopyable by one added cycle, so the
  // pin is the AGREEMENT of the two paths rather than either path's answer.
  const r = rig();
  const spy = new SpyChannel();
  const dispatcher = new GateDispatcher({ channels: [spy], fallback: new ConsoleChannel() });
  await r.broker.raise(r.log, request({ payload: { command: "restart" } }));
  const summary = (await r.broker.list(r.log))[0]!;
  const deliverWith = async (batch: unknown): Promise<Record<string, unknown>> => {
    await dispatcher.deliver(r.log, { ...summary, batch: batch as NonNullable<GateSummary["batch"]> }, { channels: ["spy"] });
    return spy.seen.at(-1)!.gate.batch as unknown as Record<string, unknown>;
  };
  const cyclic = (batch: Record<string, unknown>): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...batch };
    copy["self"] = copy;
    return copy;
  };

  const marker = { id: "(unknown)", key: "(unrenderable)" };
  const cases: readonly [string, Record<string, unknown>, Record<string, unknown>][] = [
    ["an `id` that is not a string", { id: 42, key: { nested: true } }, marker],
    ["an `id` that names a prototype", { id: "__proto__", key: "k" }, { id: "(unknown)", key: "k" }],
    ["a batch with neither field", {}, marker],
    ["…and one whose fields are null", { id: null, key: null }, marker],
  ];
  for (const [what, batch, expected] of cases) {
    const whole = await deliverWith(batch);
    const degraded = await deliverWith(cyclic(batch));
    assert.deepEqual({ id: whole["id"], key: whole["key"] }, expected, `${what}: the whole-copy path`);
    assert.deepEqual({ id: degraded["id"], key: degraded["key"] }, expected, `${what}: …and the degrade path agrees`);
  }

  // The bound is on both paths too — `MAX_ID` is 128, and an id nobody meant to be a
  // kilobyte should not become one on the branch nobody re-read.
  const long = await deliverWith({ id: "gate_x", key: "x".repeat(400) });
  assert.equal((long["key"] as string).length, 128, "the whole-copy path bounds `key`");

  // AND THE FACTS THIS HAS TO STAY DISTINGUISHABLE FROM: a real batch is still carried whole
  // and its extra fields still survive, so the markers above are information rather than
  // what this function returns.
  const real = { id: "gate_first" as GateId, key: "policy:restart", windowMs: 60_000, maxBatch: 5, deliveryDigest: "abc" };
  assert.deepEqual(await deliverWith(real), real, "a real batch, governance and all");
});

test("…AND THE LIMIT THE TWO PATHS STILL DISAGREE ABOUT, HELD EXECUTABLE RATHER THAN CLAIMED AWAY", async () => {
  // `isPlainRecord`'s docstring claimed to be "the exact test for 'the round trip carried the
  // shape through'". It is exact on a value `ownedJson` PRODUCED — `JSON.parse` yields only
  // `null`, primitives, arrays and `Object.prototype` objects — and on an INPUT it is
  // necessary and not sufficient, which is a different statement and the one the two callers
  // rest on. This pins the residue: `JSON.stringify` carries own ENUMERABLE keys, `ownNames`
  // reports own names enumerable or not, so the two paths of one function disagree about
  // WHICH NAMES are the record's fields. Left standing deliberately — that question has two
  // defensible answers and no signature to arbitrate, unlike `id` and `key` above.
  const r = rig();
  const spy = new SpyChannel();
  const dispatcher = new GateDispatcher({ channels: [spy], fallback: new ConsoleChannel() });
  await r.broker.raise(r.log, request({ payload: { command: "restart" } }));
  const summary = (await r.broker.list(r.log))[0]!;

  const hidden = (): Record<string, unknown> => {
    const batch: Record<string, unknown> = { id: "gate_first", key: "policy:restart" };
    Object.defineProperty(batch, "windowMs", { value: 60_000, enumerable: false });
    return batch;
  };

  await dispatcher.deliver(r.log, { ...summary, batch: hidden() as NonNullable<GateSummary["batch"]> }, { channels: ["spy"] });
  const whole = spy.seen.at(-1)!.gate.batch as unknown as Record<string, unknown>;
  assert.equal(whole["windowMs"], undefined, "the whole copy drops what JSON never carried — and says nothing");

  const cyclic = hidden();
  cyclic["self"] = cyclic;
  await dispatcher.deliver(r.log, { ...summary, batch: cyclic as NonNullable<GateSummary["batch"]> }, { channels: ["spy"] });
  const degraded = spy.seen.at(-1)!.gate.batch as unknown as Record<string, unknown>;
  assert.equal(degraded["windowMs"], 60_000, "…and the walk over own names shows it");

  // Both still normalize, which is the property the test above pins and this one may not
  // weaken: the disagreement is about which FIELDS exist, never about the two the type names.
  assert.equal(whole["id"], "gate_first");
  assert.equal(degraded["id"], "gate_first");
});

test("A LIST THAT COULD NOT BE COPIED IS NOT A GATE THAT NAMED NOBODY", async () => {
  // `ownedList`'s docstring: "`[]` on `approvers` is the PERMISSIVE reading — 'the gate
  // named nobody' — and that is the one thing a value we could not read may never be turned
  // into." Its only caller was `ownedList(gate.approvers) ?? []`, eighteen lines above that
  // sentence. `ownedList` answers `undefined` for "absent" and for "could not be copied"
  // alike, so telling them apart is the CALLER'S job and the direction differs per field.
  const r = rig();
  const spy = new SpyChannel();
  const dispatcher = new GateDispatcher({ channels: [spy], fallback: new ConsoleChannel() });
  await r.broker.raise(r.log, request({ payload: { command: "restart" } }));
  const summary = (await r.broker.list(r.log))[0]!;
  // A list-shaped value whose element read throws: `Array.isArray` says no, so `ownedJson`
  // is asked, and it runs the getter inside its try and comes back with nothing.
  const unreadable = {
    get 0(): string {
      throw new Error("who this gate names is not readable");
    },
    length: 1,
  } as unknown as readonly string[];

  await dispatcher.deliver(r.log, { ...summary, approvers: unreadable }, { channels: ["spy"] });
  assert.deepEqual(spy.seen.at(-1)!.gate.approvers, ["(unrenderable)"], "somebody was named and we cannot say who");

  await dispatcher.deliver(r.log, { ...summary, take: unreadable }, { channels: ["spy"] });
  assert.deepEqual(spy.seen.at(-1)!.gate.take, ["(unrenderable)"], "`[]` here would be edges the human did not select");

  // `allowEdit` is the same rule read the other way up: ABSENT means unconstrained
  // (`GateRecord.allowEdit` — "Absent = unconstrained; `[]` = none"), so an unreadable one
  // may not become absent. Narrowing is the direction a value we could not read may move.
  await dispatcher.deliver(r.log, { ...summary, allowEdit: unreadable }, { channels: ["spy"] });
  assert.deepEqual(spy.seen.at(-1)!.gate.allowEdit, [], "unreadable may not widen into unconstrained");

  // AND THE FACTS THEY HAVE TO STAY DISTINGUISHABLE FROM. A gate that really does name
  // nobody still says so, and an `allowEdit` that is really absent is still unconstrained —
  // otherwise the markers above are just what this function returns.
  await dispatcher.deliver(r.log, { ...summary, approvers: [], allowEdit: undefined }, { channels: ["spy"] });
  assert.deepEqual(spy.seen.at(-1)!.gate.approvers, [], "the gate named nobody");
  assert.equal(spy.seen.at(-1)!.gate.allowEdit, undefined, "…and named no constraint on edits");
});

test("A GATE FIELD THAT IS NOT A LIST IS STILL NOT AN OBJECT THE ENGINE HOLDS", async () => {
  // `ownedList` was `Array.isArray(v) ? [...v] : v`, and the else branch is the aliasing
  // hole this wave closed one shape over: `Array.isArray` answers "no" for a plain object,
  // a `Map`, a `Date` and a `RegExp` alike, and every one of those went to the channel BY
  // REFERENCE. The identity walk cannot see it, because its fixture is a real array.
  class Grabber implements DeliveryChannel {
    readonly name = "grabber";
    held: unknown;
    deliver(t: DeliveryTarget): Promise<string> {
      (t.gate.approvers as unknown as Record<string, unknown>)["mallory"] = true;
      this.held = t.gate.approvers;
      return Promise.resolve("grabber:1");
    }
  }
  const r = rig();
  const grabber = new Grabber();
  const dispatcher = new GateDispatcher({ channels: [grabber], fallback: new ConsoleChannel() });
  await r.broker.raise(r.log, request({ payload: { command: "restart" } }));
  const summary = (await r.broker.list(r.log))[0]!;

  // THE FOUR SHAPES A `typeof`/`isArray` CHECK KEEPS BEING WRONG ABOUT, driven rather than
  // reasoned about: this is the third wave in which the same reflex slipped through.
  for (const held of [{ 0: "sre-lead" }, new Map([["a", "b"]]), new Date(0), /x/g] as unknown[]) {
    const before = Object.getOwnPropertyNames(held).length;
    await dispatcher.deliver(r.log, { ...summary, approvers: held as readonly string[] }, { channels: ["grabber"] });
    assert.equal(
      Object.getOwnPropertyNames(held).length,
      before,
      `a channel edited the ${Object.prototype.toString.call(held)} the engine is still holding`,
    );
    assert.notEqual(grabber.held, held, Object.prototype.toString.call(held));
  }

  // AND IT IS NOT SILENTLY EMPTIED EITHER: `[]` on `approvers` is the PERMISSIVE reading —
  // "the gate named nobody" — which is the one substitution a value we could not read may
  // never make. What is copied is what was there, as far as the copy can carry it (a `Map`
  // holds nothing in own properties, so it copies to `{}` — measured, and said in
  // `ownedList`'s docstring rather than claimed away).
  const notAList = { 0: "sre-lead" };
  await dispatcher.deliver(r.log, { ...summary, approvers: notAList as unknown as readonly string[] }, { channels: ["grabber"] });
  assert.deepEqual(grabber.held, { 0: "sre-lead", mallory: true }, "the copy says what the original said");
});

test("A LIST THAT IS A REAL ARRAY IS THE ONE `ownedList` STILL READ OUTSIDE THE TRY", async () => {
  // The test above hands `ownedList` things that are NOT arrays, so every one of them took
  // the `ownedJson` branch and never touched the spread. `Array.isArray(v) ? [...v] : …` is
  // the whole function, and the spread is a READ OF THE ELEMENTS: it calls the array's own
  // iterator, which calls `[[Get]]` per index, which is a getter or a proxy trap on a value
  // this module did not build — in a prelude that sits outside every try in a file whose
  // single rule is that delivery has one exit.
  //
  // `ownedRecipients` had this defect and it was fixed 45 lines down the file, in the wave
  // before this one, under the sentence "the elements now go through `readProp` like every
  // other read of a value from outside". Its neighbour kept the spread.
  const r = rig();
  const spy = new SpyChannel();
  const dispatcher = new GateDispatcher({ channels: [spy], fallback: new ConsoleChannel() });
  await r.broker.raise(r.log, request({ payload: { command: "restart" } }));
  const summary = (await r.broker.list(r.log))[0]!;
  /** A REAL array — `Array.isArray` says yes — whose second element read throws. */
  const trapped = (first: string, what: string): readonly string[] => {
    const list: unknown[] = [first];
    Object.defineProperty(list, "1", {
      get(): never {
        throw new Error(what);
      },
      enumerable: true,
      configurable: true,
    });
    return list as readonly string[];
  };

  await dispatcher.deliver(
    r.log,
    { ...summary, approvers: trapped("sre-lead", "who else this gate names is not readable") },
    { channels: ["spy"] },
  );
  assert.equal(spy.seen.length, 1, "reading the approvers LIST threw, and nobody was told about the gate");
  assert.deepEqual(
    spy.seen.at(-1)!.gate.approvers,
    ["sre-lead", "(unrenderable)"],
    "degrade per element, the way the recipient list one screen down already does",
  );

  // Both other callers go through the same helper, so both took the same throw.
  await dispatcher.deliver(
    r.log,
    { ...summary, allowEdit: trapped("findings", "which channels may be edited is not readable"), take: trapped("e1", "which edges") },
    { channels: ["spy"] },
  );
  assert.deepEqual(spy.seen.at(-1)!.gate.allowEdit, ["findings", "(unrenderable)"], "allowEdit is the same read");
  assert.deepEqual(spy.seen.at(-1)!.gate.take, ["e1", "(unrenderable)"], "…and so is take");

  // AN EMPTY WALK IS NOT AN EMPTY LIST, which is the trap the per-entry degrade sets for
  // itself: `ownNames` answers `[]` for a proxy whose `ownKeys` trap throws, and handing
  // that `[]` back would be `?? []` reappearing INSIDE the function whose docstring forbids
  // it — "the gate named nobody" written by the one branch that has just proved it cannot
  // read who the gate names. `Array.isArray` reports a proxy over an array as an array
  // (measured), so this reaches the walk rather than the `ownedJson` branch.
  const opaque = new Proxy(["sre-lead"], {
    get(): never {
      throw new Error("every element read is a trap");
    },
    ownKeys(): never {
      throw new Error("and so is asking which indices there are");
    },
  }) as readonly string[];
  await dispatcher.deliver(r.log, { ...summary, approvers: opaque, allowEdit: opaque }, { channels: ["spy"] });
  assert.deepEqual(spy.seen.at(-1)!.gate.approvers, ["(unrenderable)"], "an unreadable list may not become a gate that named nobody");
  assert.deepEqual(spy.seen.at(-1)!.gate.allowEdit, [], "…while narrowing is still where allowEdit is allowed to move");

  // AND THE COPY IS DEEP, where the spread's was shallow — `ownedJson` runs first now, so
  // "the day a list of CONTAINERS reaches it, the elements are shared again" is closed
  // rather than documented.
  const nested = [{ team: "sre" }] as unknown as readonly string[];
  await dispatcher.deliver(r.log, { ...summary, approvers: nested }, { channels: ["spy"] });
  assert.deepEqual(spy.seen.at(-1)!.gate.approvers, nested, "the copy says what the original said");
  assert.notEqual((spy.seen.at(-1)!.gate.approvers as unknown as object[])[0], nested[0], "…and one container deeper");

  // AND AN ORDINARY LIST IS STILL AN ORDINARY LIST, so the markers above are information and
  // not what this function now always says.
  await dispatcher.deliver(r.log, { ...summary, approvers: ["sre-lead", "sre-oncall"] }, { channels: ["spy"] });
  assert.deepEqual(spy.seen.at(-1)!.gate.approvers, ["sre-lead", "sre-oncall"], "the gate names two people");
});

test("A REVOKED PROXY IS THE ONE VALUE `Array.isArray` THROWS ON, AND THE PRELUDE ASKS IT FOUR TIMES", async () => {
  // `Array.isArray` is this file's one un-forgeable inspector — a `Proxy` can lie about its
  // prototype, its keys and every value, and cannot lie about this. That is why three
  // helpers reach for it, and it is why nobody noticed IT IS NOT TOTAL: on a REVOKED proxy
  // it throws `TypeError: Cannot perform 'IsArray' on a proxy that has been revoked`
  // (measured, node v24.16.0), and each of the three asks it BEFORE any try.
  //
  // Every other total accessor in the prelude already survives one, which is what makes
  // this the odd one out rather than a new class: `JSON.stringify`, `getOwnPropertyNames`,
  // `getPrototypeOf` and a plain `[[Get]]` all throw on a revoked proxy too, and
  // `ownedJson`, `ownNames`, `isPlainRecord`'s prototype read and `readProp` all catch.
  const revoked = (): never => {
    const { proxy, revoke } = Proxy.revocable<Record<string, never>>({}, {});
    revoke();
    return proxy as never;
  };
  const r = rig();
  const spy = new SpyChannel();
  const dispatcher = new GateDispatcher({ channels: [spy], fallback: new ConsoleChannel() });
  await r.broker.raise(r.log, request({ payload: { command: "restart" } }));
  const summary = (await r.broker.list(r.log))[0]!;

  // `ownedList`, three fields — and each keeps the direction its call site chose.
  await dispatcher.deliver(r.log, { ...summary, approvers: revoked(), allowEdit: revoked(), take: revoked() }, { channels: ["spy"] });
  assert.equal(spy.seen.length, 1, "`ownedList` asked, and the gate was never delivered");
  assert.deepEqual(spy.seen.at(-1)!.gate.approvers, ["(unrenderable)"], "somebody was named and we cannot say who");
  assert.deepEqual(spy.seen.at(-1)!.gate.allowEdit, [], "unreadable may not widen into unconstrained");
  assert.deepEqual(spy.seen.at(-1)!.gate.take, ["(unrenderable)"], "…and the human did select edges");

  // `isPlainRecord`, which guards the write-set.
  await dispatcher.deliver(r.log, { ...summary, writes: revoked() }, { channels: ["spy"] });
  assert.deepEqual(spy.seen.at(-1)!.gate.writes, { "(unrenderable)": true }, "`isPlainRecord` asked, before its own try");

  // `ownedBatch`, through the same predicate.
  await dispatcher.deliver(r.log, { ...summary, batch: revoked() }, { channels: ["spy"] });
  assert.deepEqual(spy.seen.at(-1)!.gate.batch, { id: "(unknown)", key: "(unrenderable)" }, "a batch was named and is unreadable");

  // `ownedRecipients`, whose degrade path asks it after the whole-list copy fails.
  await dispatcher.deliver(r.log, summary, { channels: ["spy"], recipients: revoked() });
  assert.deepEqual(spy.seen.at(-1)!.recipients, [], "no list to walk and no copy to hand over");

  // AND THE FALLBACK ITSELF, whose docstring says IT CANNOT FAIL. Through the dispatcher a
  // channel is handed the owned copy above, so this is only reachable by an embedder
  // driving `ConsoleChannel` directly — which is exactly the party the claim is made to.
  const console_ = new ConsoleChannel();
  const lines: string[] = [];
  const sink = new ConsoleChannel({ sink: (line) => lines.push(line) });
  for (const c of [console_, sink]) {
    await c.deliver({ gate: summary, recipients: revoked(), payload: {}, tier: 0 });
  }
  assert.equal(console_.queued.length, 1, "the gate still landed where a human will find it");
  assert.match(lines[0]!, /awaits \(unrenderable\)$/, "…under the marker a list this channel cannot walk gets");
});

test("EVERY OTHER WAY A PAYLOAD REACHES A CHANNEL IS REDACTED TOO", async () => {
  // Three doors; the test above is the first. The other two are checked here because they
  // are separately REACHABLE, not because the code is separate: escalation builds its
  // summary from the PROJECTION plus the broker's memory (`#summaryOf`) rather than from
  // the raise (`#summarize`), and the fallback is a channel the graph never named. Both
  // then go through `GateDispatcher.deliver`, so one construction site covers all three —
  // which is the answer, and is worth an assertion rather than a reading of `gates.ts`.

  // ── the ESCALATION tier, whose summary is rebuilt from the journal ──────────
  const escalating = await gatedRun({
    ...REDACTING,
    sla: { respondWithinMs: 60_000, onTimeout: "escalate" },
    delivery: {
      channels: ["spy"],
      redact: ["email", "ssn"],
      escalation: [{ afterMs: 900_000, to: [{ kind: "role", id: "director" }] }],
    },
  });
  clock.t += 60_001;
  assert.equal((await escalating.engine.sweepGates()).swept, 1, "the SLA breached");
  assert.equal(escalating.spy.seen.length, 2, "tier 1 was DELIVERED");
  const tier1 = escalating.spy.seen[1]!;
  assert.equal(tier1.tier, 1);
  assert.equal(asSeen(tier1).includes(EMAIL), false, "a second tier is a second audience, not a second trust level");
  assert.equal(asSeen(tier1).includes(String(SSN)), false);

  // ── the FALLBACK, which is where a gate lands when every declared channel is down ──
  const failing = await gatedRun(
    { ...REDACTING, delivery: { channels: ["dead"], redact: ["email", "ssn"] } },
    { channels: [new DeadChannel()] },
  );
  assert.equal(failing.fallback.queued.length, 1, "the gate landed where a human will find it");
  const queued = failing.fallback.queued[0]!;
  assert.equal(asSeen(queued).includes(EMAIL), false, "the safety net is still outside the boundary");
  assert.equal(asSeen(queued).includes(String(SSN)), false);
});

// ── the token has to survive the channel TRYING ──────────────────────────────
//
// Everything above asks whether the value is PRESENT in what a channel was handed.
// That is the wrong question for a small domain: `pii` renders a value as a token, and a
// token you can compute from a guess is the value written differently. Wave 10 made
// `redact` declarable on a graph's gate node, which is what changed the threat model — the
// field list is now written by a graph author against whatever a workflow carries, and the
// leaves people name are `employeeId`, `amountUsd`, `ageYears`, `postcode`, an epoch. Every
// one of those is enumerable in milliseconds.

/** Five digits: an employee id, a postcode, a PIN — the shape a redact list actually names. */
const EMPLOYEE_ID = 40_404;
const DOMAIN = 100_000;

/** The object owning `key`, as an attacker finds it: by walking what it was given. */
function holderOf(tree: unknown, key: string): Record<string, unknown> | undefined {
  if (tree === null || typeof tree !== "object") return undefined;
  const obj = tree as Record<string, unknown>;
  if (Object.hasOwn(obj, key)) return obj;
  for (const v of Object.values(obj)) {
    const found = holderOf(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

test("A CHANNEL CANNOT BRUTE-FORCE A REDACTED NUMBER OUT OF ANYTHING IT WAS HANDED", async () => {
  const { spy } = await gatedRun(
    { ...REDACTING, delivery: { channels: ["spy"], redact: ["employeeId"] } },
    { requester: { name: "Ada", employeeId: EMPLOYEE_ID } },
  );
  const target = spy.seen[0]!;

  // The gate is still legible — a human cannot approve what they cannot see — and the
  // number is not sitting anywhere on the object by any of the three routes.
  const surface = reachable(target, { protos: true }).values.map((v) => String(v));
  assert.ok(surface.includes("scale api to 12 replicas"), "the thing being approved is readable");
  assert.equal(surface.includes(String(EMPLOYEE_ID)), false, "the value is not present verbatim");

  const rendered = JSON.stringify(target.payload);
  const token = holderOf(target.payload, "employeeId")!["employeeId"] as string;
  assert.match(token, /^pii:[0-9a-f]{12}:number$/, "…it is a token");

  // ── ATTACK 1: the token. Public algorithm, five-digit domain, no key. ──────
  // Against the unkeyed sha256 prefix this recovered the id in 18 ms.
  const digestOfToken = token.split(":")[1]!;
  for (let n = 0; n < DOMAIN; n++) {
    const guess = createHash("sha256").update(String(n), "utf8").digest("hex");
    assert.equal(guess.startsWith(digestOfToken), false, `the token inverted: employeeId is ${n}`);
    assert.equal(createHash("sha256").update(`number:${n}`, "utf8").digest("hex").startsWith(digestOfToken), false);
  }

  // ── ATTACK 2: `contentDigest`, which does not care how good the token is. ──
  // The channel holds the whole payload with one hole in it and a sha256 of the payload
  // WITHOUT the hole. So it splices a candidate back in and hashes. This recovered the id
  // in 52 ms and is the reason `deliver` re-derives the digest whenever the spec hides
  // anything: a redaction is only as strong as the least redacted thing beside it. What
  // the channel gets instead is the digest of what it was SHOWN — see the two tests under
  // "the digest a channel gets" for the property that buys and the one it costs.
  const spliced = JSON.parse(rendered) as Record<string, unknown>;
  const holder = holderOf(spliced, "employeeId")!;
  for (let n = 0; n < DOMAIN; n++) {
    holder["employeeId"] = n;
    assert.notEqual(digest(spliced), target.gate.contentDigest, `contentDigest inverted the redaction: employeeId is ${n}`);
  }

  // AND THE HANDLE STILL WORKS, which is the requirement pulling the other way: an
  // approver has to be able to tell "these two fields are the same person" from "these are
  // two people", or the token has cost them the thing the payload was for.
  const again = await gatedRun(
    { ...REDACTING, delivery: { channels: ["spy"], redact: ["employeeId"] } },
    {
      requester: {
        name: "Ada",
        employeeId: EMPLOYEE_ID,
        backup: { employeeId: EMPLOYEE_ID },
        other: { employeeId: EMPLOYEE_ID + 1 },
      },
    },
  );
  const req = (
    again.spy.seen[0]!.payload as {
      state: { requester: { employeeId: string; backup: { employeeId: string }; other: { employeeId: string } } };
    }
  ).state.requester;
  assert.equal(req.backup.employeeId, req.employeeId, "the same person twice reads as the same person");
  assert.notEqual(req.other.employeeId, req.employeeId, "…and a different one does not");
});

// ── the key is not a shared oracle ───────────────────────────────────────────
//
// Keying the token closed the offline brute force above and opened a QUERY in its place.
// `piiToken` is reachable with attacker-chosen input — anybody who can submit a graph
// decides what its gate payload carries — and the key was one per PROCESS, so tokens from
// two runs were comparable. That is a chosen-plaintext oracle: tokenise a domain of your
// own choosing through your own run, read the tokens off your own gate delivery, and you
// hold the lookup table for every other run's tokens over the same domain. Against the
// low-entropy leaves a `redact` list actually names it is CHEAPER than the brute force the
// key replaced, because the work is one delivery instead of 2⁴⁸ hashes.
//
// The two tests below are the two halves that pull against each other. Reading only the
// first would justify a per-call random token, which passes it and destroys the product.

test("ONE RUN'S TOKENS ARE NOT A LOOKUP TABLE FOR ANOTHER RUN'S", async () => {
  // THE ATTACKER'S RUN, run exactly as an attacker would: a graph whose gate payload
  // carries a domain of their choosing under a field their own delivery spec redacts, and
  // a channel of their own to read the tokens off. `only` widens on the way down, so every
  // element of an array under a named key is tokenised — one delivery, one table.
  const domain = [...Array(1000).keys()];
  const attacker = await gatedRun(
    { ...REDACTING, delivery: { channels: ["spy"], redact: ["employeeId"] } },
    { requester: { name: "Mallory", employeeId: domain } },
  );
  const table = new Map<string, number>();
  const chosen = holderOf(attacker.spy.seen[0]!.payload, "employeeId")!["employeeId"] as string[];
  assert.equal(chosen.length, domain.length, "the attacker got a token per candidate — this is the oracle, and it works");
  chosen.forEach((token, n) => table.set(token, n));
  assert.equal(table.size, domain.length, "…and no two candidates collided, so the table is exact");

  // THE VICTIM'S RUN. A different run, in the same process, hiding the same field.
  const victim = await gatedRun(
    { ...REDACTING, delivery: { channels: ["spy"], redact: ["employeeId"] } },
    { requester: { name: "Ada", employeeId: 404 } },
  );
  assert.notEqual(attacker.runId, victim.runId, "two runs, one process — the setting the oracle needs");
  const stolen = holderOf(victim.spy.seen[0]!.payload, "employeeId")!["employeeId"] as string;
  assert.match(stolen, /^pii:[0-9a-f]{12}:number$/);

  assert.equal(table.has(stolen), false, `the victim's token was in the attacker's table: employeeId is ${table.get(stolen)}`);
});

test("…AND THE COMPARISONS AN APPROVER ACTUALLY MAKES ALL STILL WORK", async () => {
  // Scoping a key is only half a fix; the other half is naming what may NOT be broken. An
  // approver compares four things, and every one of them is inside a single run — which is
  // why the run is the scope, rather than the gate (too narrow: it breaks the second) or
  // the process (too wide: it is the test above).

  // 1 · TWO FIELDS IN ONE PAYLOAD — the same person twice. Pinned by "A CHANNEL CANNOT
  //     BRUTE-FORCE…" above, at the end, and not repeated here.

  // 2 · TWO GATES IN ONE RUN. The seam, because that is where the property lives: one
  //     scope, two separate redactions, one answer.
  const person = "ada@example.com";
  const first = redactFields({ requester: person }, ["requester"], "pii", RUN) as { requester: string };
  const second = redactFields({ approver: { email: person } }, ["email"], "pii", RUN) as { approver: { email: string } };
  assert.equal(second.approver.email, first.requester, "a second gate in one run must not rename the same person");

  // 3 · TIER 0 AGAINST TIER 2 AN HOUR LATER, end to end and through the real clock —
  //     because the escalation summary is REBUILT from the projection (`#summaryOf`)
  //     rather than carried over from the raise, so this is the path where a scope taken
  //     off the summary could plausibly go missing.
  const { spy, engine } = await gatedRun({
    ...REDACTING,
    sla: { respondWithinMs: 60_000, onTimeout: "escalate" },
    delivery: {
      channels: ["spy"],
      redact: ["email"],
      escalation: [{ afterMs: 900_000, to: [{ kind: "role", id: "director" }] }],
    },
  });
  clock.t += 60_001;
  assert.equal((await engine.sweepGates()).swept, 1, "the SLA breached");
  assert.equal(spy.seen.length, 2, "tier 1 was delivered");
  const tokenAt = (tier: number): string =>
    (spy.seen[tier]!.payload as { state: { requester: { email: string } } }).state.requester.email;
  assert.match(tokenAt(0), /^pii:/);
  assert.equal(tokenAt(1), tokenAt(0), "the director was paged about a different person than the on-call was");

  // 4 · THE PAYLOAD AGAINST ITS OWN ESCALATION — the same delivery, so the same call, so
  //     the same key by construction. Covered by 3.
});

// ── the digest a channel gets ────────────────────────────────────────────────

test("A RE-DELIVERED GATE IS THE SAME QUESTION, EVEN THOUGH ITS TOKENS ARE NOT", async () => {
  // The first fix for the `contentDigest` oracle tokenised the field, which cost it the one
  // property it is KEPT for: D7.3 defines it as the sha256 of the payload shown to the
  // human, and D7.9 row 3 wants "identical digest ⇒ identical question". A per-process
  // token made a gate re-delivered after a restart read as a different question.
  //
  // A restart cannot be driven in one process, so this drives the thing a restart CHANGES:
  // the token key. Two runs tokenise the same value differently — proved below — so a
  // digest that is equal across them is a digest that does not depend on the key, which is
  // exactly the property a restart needs.
  const question = { name: "Ada", employeeId: EMPLOYEE_ID };
  const asked = await gatedRun({ ...REDACTING, delivery: { channels: ["spy"], redact: ["employeeId"] } }, { requester: question });
  const again = await gatedRun({ ...REDACTING, delivery: { channels: ["spy"], redact: ["employeeId"] } }, { requester: question });

  const tokenOf = (t: DeliveryTarget): string => holderOf(t.payload, "employeeId")!["employeeId"] as string;
  assert.notEqual(tokenOf(again.spy.seen[0]!), tokenOf(asked.spy.seen[0]!), "the key did change between the two");
  assert.equal(
    again.spy.seen[0]!.gate.contentDigest,
    asked.spy.seen[0]!.gate.contentDigest,
    "the same question read as a different one",
  );

  // AND WHAT IT IS A FUNCTION OF IS THE PROPERTY, WITH ITS CONDITION: for a plain JSON
  // value, at a depth `redact` still walks, that the payload does not also carry at a
  // position the list did not name, the hidden position is the CONSTANT `[secret]` in the
  // digested tree — so no hidden value is an input to it. "And it holds for every payload"
  // stood here for a wave, thirty lines above a test in this same file that measures two
  // arms where it does not: *A HIDDEN POSITION IS NOT ALWAYS THE CONSTANT*. A claim whose
  // counterexample is in its own file is the specific defect this programme keeps finding.
  //
  // WHAT IT IS NOT is "the channel can recompute it", which is how this was justified and
  // which is true HERE and almost nowhere else — a non-null scalar leaf is the whole of
  // that claim's support. The line below is the recipe working on the one input it works
  // on; "THE DIGEST A CHANNEL IS GIVEN IS NOT A DIGEST IT CAN CHECK" is the other four.
  const shown = JSON.parse(JSON.stringify(asked.spy.seen[0]!.payload)) as Record<string, unknown>;
  holderOf(shown, "employeeId")!["employeeId"] = "[secret]";
  assert.equal(digest(shown), asked.spy.seen[0]!.gate.contentDigest, "a non-null scalar leaf is the case that recomputes");

  // WITH NOTHING HIDDEN IT IS THE JOURNAL'S OWN DIGEST, unchanged: "shown" and "raised" are
  // the same payload, so there is no second meaning to invent.
  const open = await gatedRun({ ...REDACTING, delivery: { channels: ["spy"] } }, { requester: question });
  const raised = (await open.engine.openGates(open.runId))[0]!;
  assert.equal(open.spy.seen[0]!.gate.contentDigest, raised.contentDigest);
});

test("THE DIGEST DESCRIBES THE BYTES THAT WERE SENT, NOT THE ONES THAT WERE RAISED", async () => {
  // "Shown and raised are the same payload" is true of every payload the journal can carry
  // and is not true of every payload `deliver` can be handed, because the no-redact branch
  // now hands over `ownedJson(gate.payload)` — a JSON round trip — while `gate.contentDigest`
  // was taken by `canonicalize`. The two disagree on exactly one thing, and it is the thing
  // `canonicalize`'s docstring says it ignores: `JSON.stringify` calls an INHERITED `toJSON`
  // and `canonicalize` reads own enumerable keys only.
  //
  // D7.3 says the field pins WHAT THE APPROVER ACTUALLY SAW, so the disagreement has exactly
  // one legal resolution: the digest describes what was sent.
  class Rendered {
    readonly command = "kubectl rollout restart deploy/api";
    toJSON(): { command: string } {
      return { command: "kubectl delete ns prod" };
    }
  }
  const r = rig();
  const spy = new SpyChannel();
  const dispatcher = new GateDispatcher({ channels: [spy], fallback: new ConsoleChannel() });
  await r.broker.raise(r.log, request({ payload: new Rendered() }));
  const summary = (await r.broker.list(r.log))[0]!;
  await dispatcher.deliver(r.log, { ...summary, payload: new Rendered() }, { channels: ["spy"] });

  const shown = spy.seen[0]!;
  assert.deepEqual(shown.payload, { command: "kubectl delete ns prod" }, "the question the approver is actually asked");
  assert.equal(digest(shown.payload), shown.gate.contentDigest, "the digest that would settle `the approver was shown the wrong diff`");
  assert.notEqual(shown.gate.contentDigest, summary.contentDigest, "the journal's digest is of the payload AS RAISED, and stays that way");

  // AND IT IS UNCHANGED FOR EVERY PAYLOAD THE JOURNAL CAN CARRY, which is the whole point of
  // re-deriving rather than substituting: a round trip that changes nothing changes nothing.
  const plain = { command: "restart", blastRadius: 12 };
  await dispatcher.deliver(r.log, { ...summary, payload: plain }, { channels: ["spy"] });
  assert.equal(spy.seen[1]!.gate.contentDigest, digest(plain), "…and it is still the journal's own digest for ordinary data");
});

test("THE PRICE OF THAT IS PAID IN THE OPEN: a hidden field no longer changes the digest", async () => {
  // Stated as a test rather than as a comment, because it is a real loss and the next
  // reader will otherwise find it as a surprise. A digest that is stable across processes
  // AND distinguishes a hidden value is a deterministic public function of that value —
  // i.e. the 52 ms brute force written a third way. You may have two of the three.
  const spec = { ...REDACTING, delivery: { channels: ["spy"], redact: ["employeeId"] } };
  const ada = await gatedRun(spec, { requester: { name: "Ada", employeeId: 1 } });
  const bob = await gatedRun(spec, { requester: { name: "Ada", employeeId: 2 } });

  assert.equal(
    bob.spy.seen[0]!.gate.contentDigest,
    ada.spy.seen[0]!.gate.contentDigest,
    "two questions differing only inside the redact list are one question TO THIS CHANNEL",
  );
  // The journal is untouched and still tells them apart, which is where dedup and audit
  // read it from. The loss is at the channel, and only at the channel.
  const raisedOf = async (r: { engine: Engine; runId: RunId }): Promise<string> =>
    (await r.engine.openGates(r.runId))[0]!.contentDigest;
  assert.notEqual(await raisedOf(bob), await raisedOf(ada), "…and the journal cannot tell them apart either");
});

test("A PAYLOAD THAT CANNOT BE CONTENT-ADDRESSED IS STILL DELIVERED, and still not an oracle", async () => {
  // Re-deriving the digest put a `canonicalize` into `deliver`'s prelude, which sits
  // outside every try in a file whose one rule is that `deliver` has ONE exit.
  // `canonicalize` refuses a bigint, a symbol, a non-finite number and an `undefined`
  // array element. `raise` content-addresses the payload first, so a raised gate cannot
  // carry one — a caller driving the dispatcher directly can.
  const r = rig();
  const spy = new SpyChannel();
  const dispatcher = new GateDispatcher({ channels: [spy], fallback: new ConsoleChannel() });
  await r.broker.raise(r.log, request({ payload: { command: "restart" } }));
  // The bigint is at an UNREDACTED leaf, which is where it survives the walk: a leaf under
  // a named key is replaced by the constant and never reaches `canonicalize` at all.
  const gate = { ...(await r.broker.list(r.log))[0]!, payload: { command: "restart", employeeId: 40_404, seats: 7n } };

  const outcome = await dispatcher.deliver(r.log, gate, { channels: ["spy"], redact: ["employeeId"] });
  assert.equal(outcome.delivered.length, 1, "a payload the redactor cannot hash is still a gate somebody must answer");

  // AND THE FALLBACK IS A MARKER, not the journal's digest. Degrading to `gate.contentDigest`
  // would hand the channel the digest of the UNREDACTED payload — the exact oracle this
  // branch exists to remove — reached through the one input that makes the safe path fail.
  const delivered = spy.seen[0]!.gate.contentDigest;
  assert.equal(delivered, "(undigestible)");
  assert.notEqual(delivered, gate.contentDigest, "the safe path failing handed back the unsafe value");
});

// ── who the delivered digest is FOR, and what it therefore cannot be ─────────
//
// D7.8 defines `contentDigest` as "the sha256 of the payload SHOWN to the human" and says
// what it is for: a later "the approver was shown the wrong diff" dispute is otherwise
// unanswerable. That reads as one field with one reader. It has three, and they want
// different things:
//
//   1. an APPROVER — really the AUDITOR settling their dispute — who is INSIDE the trust
//      boundary and holds the journal. What they need is a digest they can RE-DERIVE
//      later, from the real payload plus the delivery spec. That rules out anything
//      carrying a `pii` token: the root key is `randomBytes(32)` per process and is
//      deliberately unexportable, so a digest over tokens is a number nobody — auditor
//      included — can ever check again once that process exits;
//   2. a CHANNEL DEDUPLICATING a retry storm (D7.9 row 3), which wants "same digest ⇔ same
//      question". It does not get it, and must not use this field for that: two gates
//      differing only inside the redact list are ONE digest here (see "THE PRICE OF THAT
//      IS PAID IN THE OPEN"). Dedup reads the JOURNALED digest, inside the boundary;
//   3. an OPERATOR CORRELATING A RE-DELIVERY — tier 0 against tier 2 an hour later, or the
//      same gate after a restart — which wants stability across processes. Same
//      requirement as 1, same consequence.
//
// So the delivered digest is taken over the tree with every hidden position rendered as
// the CONSTANT `[secret]`: key-independent, therefore re-derivable and restart-stable.
// What it is NOT is checkable by the channel holding it, which is what `deliver`'s comment
// claimed for a wave — and the claim was carried entirely by the one input the pinning
// test used.

test("THE DIGEST A CHANNEL IS GIVEN IS NOT A DIGEST IT CAN CHECK", async () => {
  // The justification this replaces: "it is not an oracle by CONSTRUCTION rather than by
  // strength — the channel can compute it itself from the tree in its hand". The recipe
  // that sentence describes, and that the scalar test above performs, is: put the constant
  // back where each token is, and hash. Four inputs, through the real dispatcher.
  const r = rig();
  const spy = new SpyChannel();
  const dispatcher = new GateDispatcher({ channels: [spy], fallback: new ConsoleChannel() });
  await r.broker.raise(r.log, request({ payload: { command: "restart" } }));
  const summary = (await r.broker.list(r.log))[0]!;
  const deliver = async (payload: unknown, redact: readonly string[], redactAs?: "secret_ref"): Promise<DeliveryTarget> => {
    const spec: DeliverySpec = { channels: ["spy"], redact, ...(redactAs === undefined ? {} : { redactAs }) };
    await dispatcher.deliver(r.log, { ...summary, payload }, spec);
    return spy.seen[spy.seen.length - 1]!;
  };
  const person = { requester: { name: "Ada", email: EMAIL } };

  // ── 1 · IT WORKS FOR A NON-NULL SCALAR LEAF, which is the whole of its support ──
  const scalar = await deliver({ requester: { name: "Ada", employeeId: EMPLOYEE_ID } }, ["employeeId"]);
  const put = (t: unknown, k: string, v: unknown): unknown => {
    const copy = JSON.parse(JSON.stringify(t)) as unknown;
    holderOf(copy, k)![k] = v;
    return copy;
  };
  assert.equal(digest(put(scalar.payload, "employeeId", "[secret]")), scalar.gate.contentDigest, "the case the claim was read off");

  // ── 2 · IT IS WRONG FOR A REDACTED SUBTREE ────────────────────────────────
  // `redact: ["requester"]` collapses the WHOLE subtree to the constant in the digested
  // tree, while the delivered tree keeps its shape and tokenises the leaves — because
  // `redact`'s `secret_ref` arm fires above the container walk and its `pii` arm below it.
  // So the channel is holding two keys and the digest was taken over none.
  const branch = await deliver(person, ["requester"]);
  const leafwise = put(put(branch.payload, "name", "[secret]"), "email", "[secret]");
  assert.notEqual(digest(leafwise), branch.gate.contentDigest, "the recipe answered for a subtree it could not see");
  assert.equal(digest({ requester: "[secret]" }), branch.gate.contentDigest, "…the right answer collapses a node the channel was not told about");

  // ── 3 · AND IT IS NOT MERELY HARD, IT IS UNDEFINED ────────────────────────
  // The decisive one, and the reason this is not a "guess better" problem. Two different
  // redact lists produce a BYTE-IDENTICAL delivered tree and two different digests, so
  // there is no function from what the channel holds to what it was told — whatever
  // heuristic it uses, one of these two deliveries defeats it.
  const leaf = await deliver(person, ["name", "email"]);
  assert.deepEqual(leaf.payload, branch.payload, "one tree");
  assert.notEqual(leaf.gate.contentDigest, branch.gate.contentDigest, "…two digests");

  // ── 4 · AND THE TREE NEED NOT EVEN LOOK REDACTED ──────────────────────────
  // `pii` keeps `null` and `undefined` as they are, on purpose — tokenising absence would
  // turn "no ssn on file" into something that looks like an ssn. `secret_ref` hides above
  // that check, so the digested tree says `[secret]` where the delivered tree says `null`.
  // A channel here cannot even tell that anything was hidden, which is the same failure as
  // 3 arriving without a token to notice.
  const absent = await deliver({ ssn: null, name: "Ada" }, ["ssn"]);
  assert.deepEqual(absent.payload, { ssn: null, name: "Ada" });
  assert.notEqual(digest(absent.payload), absent.gate.contentDigest, "nothing in the tree marks the position that was hidden");

  // ── THE PROPERTY THAT ACTUALLY HOLDS, WITH ITS CONDITION ──────────────────
  // Not recomputability. A position the redact list names is the literal `[secret]` in the
  // digested tree — for a plain JSON value, at a depth `redact` still walks — so no hidden
  // value is an INPUT to the digest and a guesser has nothing to converge on. Written as the
  // sweep the 52 ms brute force was: vary the hidden value across a domain and the delivered
  // digest does not move at all. That covers the object case, the null case and the array
  // case in one statement, where "the channel can recompute it" covered none of them.
  //
  // THE CONDITION IS NOT DECORATION — the unconditional version of this sentence stood in
  // three files and *A HIDDEN POSITION IS NOT ALWAYS THE CONSTANT* below is its counterexample.
  const moved = new Set<string>();
  for (let n = 0; n < 200; n++) {
    moved.add((await deliver({ requester: { name: "Ada", employeeId: n } }, ["employeeId"])).gate.contentDigest);
    moved.add((await deliver({ requester: { name: "Ada", employeeId: n } }, ["requester"])).gate.contentDigest);
  }
  assert.equal(moved.size, 2, "the delivered digest is a function of what was SHOWN and of the redact list, and of nothing else");

  // ── AND THE ONE CONFIGURATION IN WHICH A CHANNEL CAN CHECK ────────────────
  // `redactAs: "secret_ref"` renders hidden positions as the same constant the digest is
  // taken over, so the delivered tree IS the digested tree and `digest(target.payload)` is
  // the whole recipe. That is the honest residue of the claim: a property of ONE rendering,
  // not of the field — and the default is `pii`, where it does not hold.
  const asRef = await deliver(person, ["requester"], "secret_ref");
  assert.deepEqual(asRef.payload, { requester: "[secret]" });
  assert.equal(digest(asRef.payload), asRef.gate.contentDigest, "under `secret_ref` the channel can verify what it was told");
});

test("A HIDDEN POSITION IS NOT ALWAYS THE CONSTANT, WHICH IS THE CONDITION ON THAT PROPERTY", () => {
  // "Every position the redact list names is the literal `[secret]` in the digested tree, at
  // whatever depth it was named, so NO HIDDEN VALUE IS AN INPUT TO THE DIGEST" replaced the
  // recomputability claim in three files, and it is the same SHAPE of overreach one step
  // along: a statement read off the inputs the pinning sweep happened to use — plain JSON
  // scalars and containers, shallow — and then written as if it were unconditional.
  //
  // `redact`'s walk has two arms ABOVE the `secret_ref` one, and each is a hidden position
  // that is not the constant. Neither is a NEW disclosure — the channel is handed the same
  // rendering in both cases — but "no hidden value is an input" is a claim about what the
  // digest is a FUNCTION of, and in both cases the hidden value is one of its inputs.
  const ref = (name: string): unknown => new SecretValue("hunter2", `secret://env/${name}`);

  // 1 · `isSecret` fires first, so a `SecretValue` at a named position renders its REF —
  //     and WHICH secret it is therefore moves the digest.
  const prod = redactFields({ creds: ref("PROD_DB_PASSWORD"), command: "restart" }, ["creds"], "secret_ref", RUN);
  const stage = redactFields({ creds: ref("STAGING_DB_PASSWORD"), command: "restart" }, ["creds"], "secret_ref", RUN);
  assert.deepEqual(prod, { creds: "secret://env/PROD_DB_PASSWORD", command: "restart" }, "not `[secret]`");
  assert.notEqual(digest(prod), digest(stage), "so the delivered digest is a function of the hidden position after all");
  // …and one level down it collapses like anything else, which is what makes this an arm
  // and not a hole: only the named position ITSELF is rendered by that arm.
  assert.deepEqual(redactFields({ creds: { db: ref("PROD_DB_PASSWORD") } }, ["creds"], "secret_ref", RUN), { creds: "[secret]" });

  // 2 · `MAX_DEPTH` fires first too, so "at whatever depth it was named" is false past 32.
  let deep: unknown = { ssn: SSN };
  for (let i = 0; i < 33; i++) deep = { n: deep };
  let cur = redactFields(deep, ["ssn"], "secret_ref", RUN);
  let depth = 0;
  while (cur !== null && typeof cur === "object" && "n" in cur) {
    cur = (cur as { n: unknown }).n;
    depth++;
  }
  assert.equal(depth, 33, "the walk stops before the named position rather than at it");
  assert.equal(cur, "[depth-limit]", "…and renders a marker that is not the constant — the value is still not an input");
});

// ── what a delivery hides that the graph did not name ────────────────────────

test("WHAT A DELIVERY HIDES THAT THE GRAPH DID NOT NAME", () => {
  // Delegating `redactFields` to `redact` gave gate delivery the secret-ish KEY rule and
  // the detector sweep for the first time. More hiding on the most untrusted sink sounds
  // unambiguously good and runs against D7.3: a human cannot approve what they cannot see.
  // So the line is drawn here rather than left to whoever next reads the two files.
  const payload = {
    command: "restart api",
    blastRadius: 12,
    requestedAt: 1_700_000_000_000,
    note: "rotate the key AKIAIOSFODNN7EXAMPLE afterwards, per runbook 4",
    api_key: "sk-livekeyabcdefghijklmnop",
    email: "oncall@example.com",
  };
  const out = redactFields(payload, ["email"], "pii", RUN) as Record<string, string | number>;

  // HIDDEN, and none of the three was named: a fact about the VALUE, not a guess about the
  // workflow. Each leaves the key in place and puts a legible marker in the value, so an
  // approver can see that something was there and refuse rather than approve blind.
  assert.equal(out["api_key"], "[secret]", "a key that names a secret");
  assert.equal(
    out["note"],
    "rotate the key [redacted:aws-key] afterwards, per runbook 4",
    "a credential shape in free text — and the sentence around it survives, which is the point",
  );
  assert.match(String(out["email"]), /^pii:/, "the field the graph DID name");

  // NOT HIDDEN. Everything else is verbatim, including the three shapes a cleverer
  // redactor would love to guess at: a number, an epoch, and prose.
  assert.equal(out["command"], "restart api", "the thing being approved");
  assert.equal(out["blastRadius"], 12, "a number is not PII because it is a number");
  assert.equal(out["requestedAt"], 1_700_000_000_000, "…nor an epoch because it could be a birthday");
});

test("…AND THE SECOND OF THE THREE IS A RULE ABOUT THE NAME, WHICH CUTS BOTH WAYS", async () => {
  // The test above pins the line and its argument: three things hidden that no `redact`
  // list named, all three "FACTS ABOUT THE VALUE rather than guesses about the workflow",
  // because "a credential is never the thing being approved". Two of the three are facts
  // about the value — `isSecret(v)` asks the value, and a detector reads the value. The
  // SECOND asks `SECRETISH_KEY.test(k)`, which is a fact about the NAME, and the payload
  // above is the one input where the two agree: `api_key` names a credential and holds one.
  //
  // A rule about names both over- and under-approximates the rule about values it is
  // argued as, and D7.3 has a constraint pointing each way — "a human cannot approve what
  // they cannot see", and a channel is outside the trust boundary. So both boundaries are
  // pinned here rather than left to the next reader of two files.
  //
  // `SECRETISH_KEY` lives in `security/redact.ts` and is deliberately not changed by this
  // test. Widening it hides more from the approver; narrowing it leaks; and the honest
  // answer for now is that gate delivery inherited a heuristic from the span path whose
  // audience is different, and knows exactly where it is wrong.
  const payload = {
    action: "rotate",
    // The MANIFEST — the thing being approved. `secrets` matches (`s?` covers the plural),
    // so the approver is asked "may I rotate [secret]?" and cannot see which.
    secrets: ["stripe-live", "db-primary"],
    // Budget numbers on an agent framework, which is where `token` is a unit and not a
    // credential. `tokens` matches; so does `max_tokens`, through the `(?:.*_)?` prefix.
    tokens: 15_000,
    max_tokens: 4000,
    // A REAL credential under a name no rule names. The NAME rules still do not reach
    // it — `db_url` says nothing about secrecy — but the VALUE detector now does, because
    // a credential in a URL is recognisable by position rather than by key.
    db_url: "postgres://svc:hunter2@db.internal:5432/app",
    email: EMAIL,
  };
  const out = redactFields(payload, ["email"], "pii", RUN) as Record<string, unknown>;

  // ── OVER: a name that says "secret" holding a value the approver needs ────
  assert.equal(out["secrets"], "[secret]", "the manifest of what is being rotated is what the gate is FOR");
  assert.equal(out["tokens"], "[secret]", "a spend the approver is being asked to authorise");
  assert.equal(out["max_tokens"], "[secret]", "…and its ceiling");
  assert.equal(out["action"], "rotate", "the verb survives, so the approver knows they are being asked to approve blind");

  // ── UNDER: an innocuous name holding a credential ─────────────────────────
  // Closed by the value detector, not by the name rules — which is the point: the key
  // `db_url` is still invisible to every name rule, and a credential the approver must
  // not see gets out on the strength of where it sits in the string.
  assert.ok(!String(out["db_url"]).includes("hunter2"), "the password must not reach the channel");
  assert.ok(String(out["db_url"]).includes("db.internal"), "…while the host stays legible, so the approver still knows what they are approving");

  // AND THE SHAPE OF THE HIDING IS STILL THE PART THAT IS RIGHT. Each rule leaves the key
  // in place and puts a legible marker in the value, so an approver sees that something was
  // there and can REFUSE rather than approve a payload with a hole they cannot detect.
  assert.ok(Object.hasOwn(out, "secrets"), "a field that vanishes is D7.3's failure from the other side");

  // AND IT IS THE DELIVERED PAYLOAD, not a property of the helper: driven end to end, the
  // channel gets the same tree. `redact` is non-empty because an empty list short-circuits
  // before the walk — so a graph that hides nothing is also a graph none of this reaches.
  const { spy } = await gatedRun(
    { ...REDACTING, delivery: { channels: ["spy"], redact: ["ssn"] } },
    { requester: { name: "Ada", ssn: SSN, tokens: 15_000 } },
  );
  const requester = holderOf(spy.seen[0]!.payload, "tokens")!;
  assert.equal(requester["tokens"], "[secret]", "the approver reads it over Slack the same way");
  assert.equal(requester["name"], "Ada", "…and the neighbour the graph did not name is legible");
});

test("REDACTION IS NOT A THING A PAYLOAD CAN UNDO AFTER IT HAS RUN", async () => {
  // Two structural holes in the walk, both of which a real payload reaches.
  //
  // `redactFields` fell through `if (v === null || typeof v !== "object") return v;` for a
  // FUNCTION, so an own-enumerable function-valued property was copied onto the redacted
  // tree by reference — and `JSON.stringify` CALLS `toJSON`. A payload could therefore
  // reintroduce whatever it liked after redaction had run, on the way to a third party.
  const smuggled = "oncall@example.com";
  const withToJSON = {
    command: "restart",
    email: smuggled,
    toJSON: () => ({ command: "restart", email: smuggled }),
  };
  const out = redactFields(withToJSON, ["email"], "pii", RUN) as Record<string, unknown>;
  assert.equal(typeof out["toJSON"], "string", "a function reached the redacted tree by reference");
  assert.equal(JSON.stringify(out).includes(smuggled), false, "…and rewrote the payload on its way out");
  assert.match(String(out["email"]), /^pii:/, "the declared field is still hidden");

  // And the redactor of all places had neither a depth limit nor cycle detection, while
  // `redact` — in the same subsystem, twenty lines away — had both. A payload referring to
  // itself was a `RangeError: Maximum call stack size exceeded` out of the dispatcher.
  const cyclic: Record<string, unknown> = { command: "restart", email: smuggled };
  cyclic["self"] = cyclic;
  const walked = redactFields(cyclic, ["email"], "pii", RUN) as Record<string, unknown>;
  assert.equal(walked["self"], "[cycle]");
  assert.match(String(walked["email"]), /^pii:/);

  let deep: unknown = { email: smuggled };
  for (let i = 0; i < 200; i++) deep = { nested: deep };
  const bounded = JSON.stringify(redactFields(deep, ["email"], "pii", RUN));
  assert.ok(bounded.includes("[depth-limit]"), "a pathological payload is bounded, not a stack overflow");
  assert.equal(bounded.includes(smuggled), false, "…and nothing below the limit is emitted");
});

test("redaction at emit is not erasure — the journal and the read model keep the real value", async () => {
  // The asymmetry is deliberate (D9.6): `state.reduced` payloads ARE the channel state,
  // so a redacted journal folds to corrupted state. Pinned here so that closing the leak
  // above cannot be "fixed" one layer too deep.
  const { engine, store, runId } = await gatedRun(REDACTING);

  const p = (await engine.projection(runId))!;
  assert.deepEqual(p.channels["requester"], { name: "Ada", email: EMAIL, ssn: SSN });

  const rows: string[] = [];
  for await (const ev of store.read(runId, 1)) rows.push(JSON.stringify(ev.payload));
  assert.ok(
    rows.some((r) => r.includes(EMAIL)),
    "the journal is the source of truth and is never redacted",
  );
});

test("a redacted field is REPLACED whatever its type, and whatever `redactAs` asks for", () => {
  // Two holes in one sentence, both reachable from a graph `checkDelivery` accepts.
  //
  //   - `redact` delegated the hiding to `redactPayload`, whose `pii` arm only knew about
  //     STRINGS. A numeric ssn, an account number, a phone number stored as a number and
  //     a boolean flag all passed through verbatim under the default classification.
  //   - `redactAs` is a `Classification`, and two of the four classify data as not
  //     sensitive. `redactAs: "internal"` therefore ran the detector sweep — which is a
  //     BACKSTOP for free text — and returned the value for anything it did not match.
  //     A declared redact list that redacts nothing is worse than no list at all.
  const payload = { command: "restart", email: "a@example.com", ssn: SSN, consented: true, missing: null };

  for (const as of ["public", "internal", "pii"] as const) {
    const out = redactFields(payload, ["email", "ssn", "consented", "missing"], as, RUN) as Record<string, unknown>;
    assert.equal(out["command"], "restart", `${as}: the thing being approved stays legible`);
    assert.match(String(out["email"]), /^pii:/, `${as}: a string is tokenised`);
    assert.match(String(out["ssn"]), /^pii:/, `${as}: and so is a number`);
    assert.match(String(out["consented"]), /^pii:/, `${as}: and so is a boolean`);
    assert.equal(out["missing"], null, `${as}: absence carries nothing to hide`);
  }

  const secret = redactFields(payload, ["ssn"], "secret_ref", RUN) as Record<string, unknown>;
  assert.equal(secret["ssn"], "[secret]", "secret_ref renders, rather than correlates");
});

// ── the escalation chain ─────────────────────────────────────────────────────

const CHAIN: DeliverySpec = {
  channels: ["spy"],
  recipients: [{ kind: "role", id: "sre-oncall" }],
  escalation: [
    { afterMs: 900_000, to: [{ kind: "role", id: "sre-manager" }] },
    { afterMs: 2_700_000, to: [{ kind: "role", id: "director" }] },
    { afterMs: 5_400_000, action: "fail" },
  ],
};

test("an unanswered gate escalates to the NEXT people, not louder to the same ones", async () => {
  const spy = new SpyChannel();
  const r = rig({ channels: [spy] });
  await r.broker.raise(r.log, request({ slaMs: 60_000, onTimeout: "escalate", delivery: CHAIN }));

  clock.t += 60_001;
  const fired = await r.broker.sweepTimeouts(r.log, clock.t);
  assert.equal(fired.length, 1);

  assert.equal(spy.seen.length, 2);
  assert.deepEqual(spy.seen[1]?.recipients, [{ kind: "role", id: "sre-manager" }]);
  assert.equal(spy.seen[1]?.tier, 1);

  const esc = (await events(r.store)).find((e) => e.type === "gate.escalated");
  assert.ok(esc);
  assert.equal((esc.payload as { tier: number }).tier, 1);
  assert.equal((esc.payload as { to: string }).to, "role:sre-manager");
});

test("THE CLOCK RESETS on escalation, so one sweep does not walk the whole chain", async () => {
  // The bug this pins: a tier that inherits the original deadline breaches the instant
  // it is reached, paging the director about something the on-call never saw.
  const spy = new SpyChannel();
  const r = rig({ channels: [spy] });
  await r.broker.raise(r.log, request({ slaMs: 60_000, onTimeout: "escalate", delivery: CHAIN }));

  clock.t += 60_001;
  await r.broker.sweepTimeouts(r.log, clock.t);
  assert.equal(spy.seen.length, 2, "tier 1");

  // Immediately sweeping again must do nothing: tier 1 has 900 s of its own.
  await r.broker.sweepTimeouts(r.log, clock.t);
  await r.broker.sweepTimeouts(r.log, clock.t + 1000);
  assert.equal(spy.seen.length, 2, "still tier 1");

  clock.t += 900_001;
  await r.broker.sweepTimeouts(r.log, clock.t);
  assert.equal(spy.seen.length, 3, "tier 2, only after ITS window elapsed");
  assert.deepEqual(spy.seen[2]?.recipients, [{ kind: "role", id: "director" }]);
});

test("an exhausted chain EXPIRES the gate rather than waiting forever", async () => {
  const spy = new SpyChannel();
  const r = rig({ channels: [spy] });
  await r.broker.raise(r.log, request({ slaMs: 60_000, onTimeout: "escalate", delivery: CHAIN }));

  clock.t += 60_001;
  await r.broker.sweepTimeouts(r.log, clock.t);
  clock.t += 900_001;
  await r.broker.sweepTimeouts(r.log, clock.t);
  clock.t += 2_700_001;
  await r.broker.sweepTimeouts(r.log, clock.t);

  const seq = await events(r.store);
  const failed = seq.find((e) => e.type === "run.failed");
  assert.ok(failed, "a gate with nobody left to ask must not sit open forever");
  assert.equal((failed.payload as { error: { code: string } }).error.code, "E_GATE_EXPIRED");
  assert.equal(seq.some((e) => e.type === "gate.decided"), false, "and expiry is still not an approval");
});

test("escalating with no chain declared expires immediately rather than looping", async () => {
  const spy = new SpyChannel();
  const r = rig({ channels: [spy] });
  await r.broker.raise(r.log, request({ slaMs: 60_000, onTimeout: "escalate", delivery: { channels: ["spy"] } }));

  clock.t += 60_001;
  await r.broker.sweepTimeouts(r.log, clock.t);
  const seq = await events(r.store);
  assert.equal((seq.find((e) => e.type === "run.failed")?.payload as { error: { code: string } }).error.code, "E_GATE_EXPIRED");
});

// ── tier resolution ──────────────────────────────────────────────────────────

test("a tier reuses the gate's channels unless it names its own", () => {
  const spec: DeliverySpec = {
    channels: ["console"],
    escalation: [{ afterMs: 1, to: [] }, { afterMs: 2, channels: ["pager"], to: [] }],
  };
  assert.deepEqual(tierChannels(spec, 0), ["console"]);
  assert.deepEqual(tierChannels(spec, 1), ["console"], "escalating changes WHO, not necessarily how");
  assert.deepEqual(tierChannels(spec, 2), ["pager"]);
});

test("a tier with no recipients falls back to the gate's", () => {
  const spec: DeliverySpec = { channels: ["c"], recipients: [{ kind: "user", id: "u" }], escalation: [{ afterMs: 1 }] };
  assert.deepEqual(tierRecipients(spec, 1), [{ kind: "user", id: "u" }]);
});

test("nextTier reports exhaustion rather than wrapping around", () => {
  assert.equal(nextTier(CHAIN, 2, 0), undefined, "tier 3 declares action: fail");
  assert.equal(isChainExhausted(CHAIN, 2), true);
  assert.equal(isChainExhausted(CHAIN, 0), false);
  assert.deepEqual(nextTier(CHAIN, 0, 1000), { tier: 1, deadline: 1000 + 900_000 });
});

test("formatRecipients renders a routing list a channel can use", () => {
  assert.equal(formatRecipients([{ kind: "role", id: "a" }, { kind: "user", id: "b" }]), "role:a, user:b");
});

test("A GATE STILL ESCALATES WHEN ITS TIER'S RECIPIENT LIST CANNOT BE READ", async () => {
  // `formatRecipients`' OTHER caller, and the one no `owned*` helper protects.
  // `HumanGateBroker` builds `gate.escalated{to}` from `tierRecipients(spec, tier)` — the
  // COMPILED GRAPH'S OWN ARRAY — so a recipient with a throwing getter threw there, and the
  // throw landed in `sweepTimeouts`' per-gate `catch`, whose whole point is that one gate
  // must not abort the sweep. So it was SWALLOWED: the gate never escalated, not once but on
  // every later sweep, because nothing about the gate had moved. Measured over four sweeps
  // spanning 3 000 s: `fired: 0` each time, journal `gate.raised · run.suspended ·
  // gate.delivered` and nothing after it, gate still at tier 0 on its original deadline. The
  // on-call was told once, the manager never was, and no row anywhere said why.
  const spy = new SpyChannel();
  const r = rig({ channels: [spy] });
  const unreadable: DeliverySpec = {
    channels: ["spy"],
    recipients: [{ kind: "role", id: "sre-oncall" }],
    escalation: [
      {
        afterMs: 900_000,
        to: [{ get kind(): string { throw new Error("a tier that will not say who it pages"); }, id: "sre-manager" }] as unknown as readonly Recipient[],
      },
    ],
  };
  await r.broker.raise(r.log, request({ slaMs: 60_000, onTimeout: "escalate", delivery: unreadable }));

  clock.t += 60_001;
  assert.equal((await r.broker.sweepTimeouts(r.log, clock.t)).length, 1, "the tier fired");
  const esc = (await events(r.store)).find((e) => e.type === "gate.escalated");
  assert.ok(esc, "…and it is on the journal, which is the record a silent catch destroyed");
  assert.equal((esc.payload as { tier: number }).tier, 1);
  assert.equal(
    (esc.payload as { to: string }).to,
    "(unrenderable):sre-manager",
    "the half that could be read still names the tier; the half that could not says so",
  );
  assert.equal(spy.seen.at(-1)!.tier, 1, "and the page went out");
});

test("formatRecipients is TOTAL, because both of its callers pay a page for a throw", () => {
  const revoked = Proxy.revocable([{ kind: "role", id: "a" }], {});
  revoked.revoke();
  const withAccessor: unknown[] = [];
  Object.defineProperty(withAccessor, "0", {
    get(): unknown { throw new Error("element"); },
    enumerable: true,
    configurable: true,
  });
  const as = (v: unknown): readonly Recipient[] => v as readonly Recipient[];

  // A NON-LIST IS THE MARKER AND AN EMPTY LIST IS `""`. `ConsoleChannel` renders the second
  // "anyone"; the two are different facts and the test lives in the one function both
  // callers pass through, rather than in one caller where the other could not see it.
  assert.equal(formatRecipients(as({ kind: "role", id: "a" })), "(unrenderable)", "a non-list");
  assert.equal(formatRecipients(as(revoked.proxy)), "(unrenderable)", "a revoked proxy, which `Array.isArray` THROWS on");
  assert.equal(formatRecipients([]), "", "…and an empty list is not the same fact");

  // AN ENTRY IS NEVER DROPPED: omitting one would say the list does not contain it.
  assert.equal(formatRecipients(as(withAccessor)), "(unrenderable):(unrenderable)", "an element read that throws");
  assert.equal(
    formatRecipients(as([{ kind: "role", id: "a" }, { get kind(): string { throw new Error("k"); }, id: "b" }])),
    "role:a, (unrenderable):b",
    "one bad entry costs its own fields, not everybody's position",
  );
  assert.equal(
    formatRecipients(as([{ kind: "role", id: { toString(): string { throw new Error("id"); } } }])),
    "role:(unrenderable)",
    "`${…}` is a call, and this one throws",
  );

  // …AND ANYTHING THAT IS NOT A PLAIN SCALAR IS THE MARKER, wider than "it threw": a line
  // reading `[object Object]` where a role name belongs has told a human something false.
  assert.equal(formatRecipients(as([{ kind: {}, id: "a" }])), "(unrenderable):a");
  assert.equal(formatRecipients(as([{ kind: "role" }])), "role:(unrenderable)");
  assert.equal(formatRecipients(as([{ kind: 7, id: true }])), "7:true", "…but a scalar that IS renderable renders");
});

// ── the webhook channel ──────────────────────────────────────────────────────

test("the webhook channel POSTs the gate and returns the service's own id", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const channel = new WebhookChannel({
    url: "https://hooks.example.com/x",
    headers: { authorization: "Bearer t" },
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("srv-123", { status: 200 });
    }) as unknown as typeof fetch,
  });

  const r = rig({ channels: [channel] });
  await r.broker.raise(r.log, request({ delivery: { channels: ["webhook"] } }));

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://hooks.example.com/x");
  const body = calls[0]?.body as { nodeId: string; tier: number };
  assert.equal(body.nodeId, "restart");
  assert.equal(body.tier, 0);

  const delivered = (await events(r.store)).find((e) => e.type === "gate.delivered");
  assert.equal((delivered?.payload as { receipt: string }).receipt, "srv-123", "a receipt you cannot look up is no receipt");
});

test("a non-2xx webhook response is a failure, not a silent success", async () => {
  const channel = new WebhookChannel({
    url: "https://hooks.example.com/x",
    fetch: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
  });
  const fallback = new ConsoleChannel();
  const r = rig({ channels: [channel], fallback });
  await r.broker.raise(r.log, request({ delivery: { channels: ["webhook"] } }));

  const failed = (await events(r.store)).find((e) => e.type === "gate.delivery_failed");
  assert.ok(failed);
  assert.match((failed.payload as { error: string }).error, /503/);
  assert.equal(fallback.queued.length, 1);
});

// ── the outbound payload says WHERE to answer ────────────────────────────────
//
// It used to say who is being asked and what about, and never where to reply, so a
// receiver had to be handed the address and the shared secret out of band. Tolerable for
// an approvals service you also wrote; hostile for anything else, and it made the round
// trip undocumentable from the wire alone.

/** Capture what a channel POSTs, without a network. */
function capture(): { calls: { url: string; body: Record<string, unknown> }[]; fetch: typeof fetch } {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  return {
    calls,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch,
  };
}

test("AN ANSWERABLE CHANNEL PUBLISHES ITS CALLBACK ADDRESS, and never the secret", async () => {
  const cap = capture();
  const channel = new SignedWebhookChannel({
    name: "slack",
    url: "https://hooks.example.com/x",
    callbackSecret: "shhh-approvals-service",
    callbackBaseUrl: "https://loom.example.com/",
    fetch: cap.fetch,
  });

  const r = rig({ channels: [channel] });
  await r.broker.raise(r.log, request({ delivery: { channels: ["slack"] } }));

  const callback = cap.calls[0]?.body["callback"] as {
    url: string;
    channel: string;
    signature: Record<string, unknown>;
  };
  assert.ok(callback, "a gate that cannot be answered without out-of-band instructions is not deliverable");
  // The route `ControlPlane` actually registers — trailing slash on the base absorbed.
  assert.equal(callback.url, `https://loom.example.com/runs/${RUN}/callbacks/slack`);
  assert.equal(callback.channel, "slack");

  // ENOUGH TO SIGN WITH, which is the whole point: a receiver reads these and builds a
  // header, rather than reading our source or being told in a wiki.
  assert.equal(callback.signature["signedPayload"], "v0:{timestamp}:{body}");
  assert.equal(callback.signature["signatureFormat"], "v0={hex}");
  assert.equal(callback.signature["timestampHeader"], "x-loom-timestamp");
  assert.equal(callback.signature["signatureHeader"], "x-loom-signature");
  assert.equal(callback.signature["toleranceMs"], 300_000);

  // AND THE SECRET IS NOWHERE IN THE BYTES. Not under another name, not nested, not in a
  // header. This body crosses a network we do not control and lands in somebody's log; the
  // signature is the entire perimeter of the return path, and a perimeter that travels with
  // the message it protects is not one.
  assert.equal(
    JSON.stringify(cap.calls[0]?.body).includes("shhh-approvals-service"),
    false,
    "the signing secret must never leave this process in a payload",
  );
});

test("a channel with no base URL publishes NOTHING rather than a guess", async () => {
  // `@loom/core` cannot know its own public origin behind a proxy, a tunnel or a load
  // balancer, so absence is a working configuration and the field is simply absent — a
  // receiver can tell "no address published" from "a broken address published".
  const cap = capture();
  const channel = new SignedWebhookChannel({
    name: "slack",
    url: "https://hooks.example.com/x",
    callbackSecret: "s",
    fetch: cap.fetch,
  });
  const r = rig({ channels: [channel] });
  await r.broker.raise(r.log, request({ delivery: { channels: ["slack"] } }));

  assert.equal("callback" in (cap.calls[0]?.body ?? {}), false, "absent, not null: nine waves of receivers read this body");
  assert.equal(cap.calls[0]?.body["gateId"] !== undefined, true, "…and everything else is unchanged");
});

test("A CHANNEL THAT CANNOT BE ANSWERED ADVERTISES NO ADDRESS", async () => {
  // A plain `WebhookChannel` has no `parseCallback`, so `GateCallbackRouter` refuses every
  // POST at its own door with `unknown_channel`. Publishing an address for it would
  // advertise an endpoint that answers 404 — worse than publishing none. There is no
  // `callbackBaseUrl` on `WebhookChannelOptions` at all, so this is structural: the option
  // exists on the class that has an inbound path and nowhere else.
  const cap = capture();
  const channel = new WebhookChannel({ url: "https://hooks.example.com/x", fetch: cap.fetch });
  const r = rig({ channels: [channel] });
  await r.broker.raise(r.log, request({ delivery: { channels: ["webhook"] } }));

  assert.equal("callback" in (cap.calls[0]?.body ?? {}), false);
  assert.equal((channel as DeliveryChannel).parseCallback, undefined, "the property that decides it");
});

test("a callback base URL that would publish a wrong or unsafe address is REFUSED AT CONSTRUCTION", () => {
  const build = (callbackBaseUrl: string): SignedWebhookChannel =>
    new SignedWebhookChannel({ name: "slack", url: "https://hooks.example.com/x", callbackSecret: "s", callbackBaseUrl });

  const cases: readonly [string, string][] = [
    // The same shape as `--token ""`: a variable that was unset. Falling back to "publish
    // nothing" would leave the config file saying one thing and the wire saying another.
    ["empty", ""],
    ["not a URL", "loom.example.com"],
    // `deliver` appends to the PATH, so a query would compose `…/?t=1/runs/…`.
    ["a query string", "https://loom.example.com/?t=1"],
    ["a fragment", "https://loom.example.com/#x"],
    // This URL is POSTED to the receiver in the clear. The outbound URL is a credential we
    // hold and mask everywhere; this one is an address we disclose on purpose, so the way
    // to keep it from being a credential is to refuse one being put in it.
    ["userinfo", "https://svc:S3CRET@loom.example.com"],
    ["a non-http scheme", "ftp://loom.example.com"],
  ];
  for (const [what, url] of cases) {
    assert.throws(() => build(url), (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID, what);
  }

  // …and the form every operator types is accepted, trailing slash and path prefix alike.
  assert.ok(build("https://loom.example.com"));
  assert.ok(build("https://ops.example.com/loom/"));
});

test("a path prefix survives into the published address, because a proxy mounts us under one", async () => {
  const cap = capture();
  const channel = new SignedWebhookChannel({
    name: "approvals",
    url: "https://hooks.example.com/x",
    callbackSecret: "s",
    callbackBaseUrl: "https://ops.example.com/loom/",
    timestampHeader: "X-Slack-Request-Timestamp",
    signatureHeader: "X-Slack-Signature",
    toleranceMs: 60_000,
    fetch: cap.fetch,
  });
  const r = rig({ channels: [channel] });
  await r.broker.raise(r.log, request({ delivery: { channels: ["approvals"] } }));

  const callback = cap.calls[0]?.body["callback"] as { url: string; signature: Record<string, unknown> };
  assert.equal(callback.url, `https://ops.example.com/loom/runs/${RUN}/callbacks/approvals`);
  // The CONFIGURED header names, lower-cased the way `parseCallback` reads them. A receiver
  // told the default names would sign with headers this channel never looks at.
  assert.equal(callback.signature["timestampHeader"], "x-slack-request-timestamp");
  assert.equal(callback.signature["signatureHeader"], "x-slack-signature");
  assert.equal(callback.signature["toleranceMs"], 60_000);
});

// ── the URL is itself a credential ───────────────────────────────────────────
//
// A Slack incoming webhook is a bearer token in path form, and `https://user:pass@host/`
// is one outright. Undici quotes the URL it was handed into its own error message, and
// `undelivered` puts the cause chain in `details` — which `ErrorRecord` copies into the
// journal verbatim. So the audit log grew a copy of the credential every time the endpoint
// was misconfigured. Masking is the channel's job because the channel is the only thing
// that knows the string: it makes "the URL never leaves this object" a property rather
// than a fact about which messages undici happens to include it in.

const CREDENTIALED = "https://svc:S3CRETPASSWORD@hooks.example.com/services/T00/B00/XYZ";

/**
 * A live gate, raised with NO delivery spec.
 *
 * So the journal holds nothing but what the test under it writes — a dispatcher driven
 * directly is the unit here, and a delivery the broker did on the way in would be noise
 * in every row count below.
 */
async function liveGate(r: ReturnType<typeof rig>): Promise<GateSummary> {
  await r.broker.raise(r.log, request());
  return (await r.broker.list(r.log))[0]!;
}

/** A gate summary from a live broker, so the target is not a hand-built fiction. */
async function liveTarget(r: ReturnType<typeof rig>, payload: unknown = { command: "restart" }): Promise<DeliveryTarget> {
  await r.broker.raise(r.log, request({ delivery: { channels: ["console"] } }));
  const gate = (await r.broker.list(r.log))[0]!;
  return { gate, recipients: [{ kind: "user", id: "u:alice" }], payload, tier: 0 };
}

test("THE WEBHOOK URL DOES NOT REACH `details.cause`, and therefore not the journal", async () => {
  // The message is Node 24's, verbatim: `fetch` refuses a URL with credentials in the
  // Request constructor, so this is the exact string the reproduction produced.
  const r = rig();
  const target = await liveTarget(r);
  const channel = new WebhookChannel({
    url: CREDENTIALED,
    fetch: (() =>
      Promise.reject(
        new TypeError(`Request cannot be constructed from a URL that includes credentials: ${CREDENTIALED}`),
      )) as unknown as typeof fetch,
  });

  const e = await channel.deliver(target, new AbortController().signal).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  assert.ok(isLoomError(e));
  // `errorRecord` is what the journal writes, so it is what the assertion reads.
  const durable = JSON.stringify(errorRecord(e));
  assert.equal(durable.includes("S3CRETPASSWORD"), false, "a secret in the audit log is a secret nobody can rotate away");
  assert.equal(durable.includes("hooks.example.com"), false);
  assert.equal(durable.includes("/services/T00/B00/XYZ"), false, "the PATH is the credential for a Slack webhook");
  // Still diagnosable: the channel, the gate, and the shape of the failure survive.
  assert.match(String((e.details as { cause: string }).cause), /redacted/);
  assert.equal((e.details as { reason: string }).reason, "transport");
});

test("…including the message the real `fetch` produces, with no stub in the way", async () => {
  // No injected fetch. This is offline and deterministic anyway: a URL carrying
  // credentials is refused by the Request constructor before a socket is opened.
  const r = rig();
  const target = await liveTarget(r);
  const channel = new WebhookChannel({ url: CREDENTIALED, timeoutMs: 50 });

  const e = await channel.deliver(target, new AbortController().signal).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  assert.ok(isLoomError(e));
  assert.equal(JSON.stringify(errorRecord(e)).includes("S3CRETPASSWORD"), false);
});

test("a URL with no credentials in it is masked too — the path IS the secret", async () => {
  const r = rig();
  const target = await liveTarget(r);
  const url = `https://hooks.${"slack"}.invalid/services/TEAM/BOT/${"tok"}-not-a-real-token`;
  const channel = new WebhookChannel({
    url,
    fetch: (() => Promise.reject(new TypeError(`connect ECONNREFUSED for ${url}`))) as unknown as typeof fetch,
  });

  const e = await channel.deliver(target, new AbortController().signal).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  assert.ok(isLoomError(e));
  assert.equal(JSON.stringify(errorRecord(e)).includes("XXXXXXXXXXXXXXXXXXXXXXXX"), false);
  assert.match(String((e.details as { cause: string }).cause), /ECONNREFUSED/, "the diagnosis survives the masking");
});

// ── the mask has to cover the string a transport ACTUALLY quotes ─────────────
//
// `urlSecrets` masked the RAW configured string and `u.origin`, and neither is what a
// transport error quotes. `fetch` builds a `Request`, which NORMALIZES the URL, and every
// message that names the endpoint names `new URL(url).href`. So any configuration that
// differs from its own href — an explicit `:443`, an upper-case host, a dot segment, a
// character that percent-encodes — got its ORIGIN masked (the origin is a prefix of the
// href, so that literal still matched) and its PATH left behind in `details.cause`, which
// `ErrorRecord` copies into the journal verbatim.
//
// The path is the half that is the credential. A Slack incoming webhook is a bearer token
// in path form, so "origin masked, path intact" is the leak with the origin removed.

interface UrlShape {
  readonly label: string;
  readonly url: string;
  readonly token: string;
  /** Whether `new URL(url).href` differs from what the operator wrote — the leak's precondition. */
  readonly normalizes: boolean;
  /** Which form of the URL the transport's message quotes. Default: the normalized href. */
  readonly quote?: "origin-and-path";
}

const SHAPES: readonly UrlShape[] = [
  {
    label: "the canonical one, which already worked",
    url: "https://hooks.example.com/services/T00/B00/AAAAAAAAAAAA",
    token: "AAAAAAAAAAAA",
    normalizes: false,
  },
  {
    label: "an explicit default port, which the href drops",
    url: "https://hooks.example.com:443/services/T00/B00/BBBBBBBBBBBB",
    token: "BBBBBBBBBBBB",
    normalizes: true,
  },
  {
    label: "an upper-case host, which the href lower-cases",
    url: "https://Hooks.Example.COM/services/T00/B00/CCCCCCCCCCCC",
    token: "CCCCCCCCCCCC",
    normalizes: true,
  },
  {
    label: "a space in the path, which the href percent-encodes",
    url: "https://hooks.example.com/services/T00/B00/DDDDDDDDDDDD extra",
    token: "DDDDDDDDDDDD",
    normalizes: true,
  },
  {
    label: "a dot segment, which the href resolves away",
    url: "https://hooks.example.com/services/./T00/B00/EEEEEEEEEEEE",
    token: "EEEEEEEEEEEE",
    normalizes: true,
  },
  {
    label: "a query string, quoted by a message that drops the query",
    url: "https://hooks.example.com/services/T00/B00/GGGGGGGGGGGG?tok=HHHHHHHHHHHH",
    token: "GGGGGGGGGGGG",
    normalizes: false,
    quote: "origin-and-path",
  },
  {
    label: "credentials AND a path — the href keeps the userinfo, so this one is a control",
    url: "https://svc:S3CRETPASSWORD@hooks.example.com/services/T00/B00/FFFFFFFFFFFF",
    token: "FFFFFFFFFFFF",
    normalizes: false,
  },
];

test("THE NORMALIZED URL IS MASKED, not only the string an operator typed", async () => {
  const r = rig();
  const target = await liveTarget(r);

  for (const shape of SHAPES) {
    const u = new URL(shape.url);
    assert.equal(u.href !== shape.url, shape.normalizes, `${shape.label}: the fixture does not do what it says`);
    const quoted = shape.quote === "origin-and-path" ? `${u.origin}${u.pathname}` : u.href;
    const channel = new WebhookChannel({
      url: shape.url,
      // Node 24's own message, with the normalization `Request` performs on the way in.
      fetch: (() =>
        Promise.reject(
          new TypeError(`Request cannot be constructed from a URL that includes credentials: ${quoted}`),
        )) as unknown as typeof fetch,
    });

    const e = await channel.deliver(target, new AbortController().signal).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    assert.ok(isLoomError(e), shape.label);
    const durable = JSON.stringify(errorRecord(e));
    assert.equal(durable.includes(shape.token), false, `${shape.label}: the PATH is the credential`);
    assert.equal(durable.includes("/services/"), false, shape.label);
    assert.equal(durable.includes("S3CRETPASSWORD"), false, shape.label);
    assert.match(String((e.details as { cause: string }).cause), /redacted/, shape.label);
  }
});

test("…and a message that quotes only the PATH is masked too", async () => {
  // An HTTP client that logs a request line rather than an absolute URL: the host went in
  // a header, and what is left in the message is exactly the credential.
  const r = rig();
  const target = await liveTarget(r);
  const url = `https://hooks.${"slack"}.invalid/services/TEAM/BOT/${"tok"}-also-not-real`;
  const channel = new WebhookChannel({
    url,
    fetch: (() => Promise.reject(new Error(`POST ${new URL(url).pathname} failed: 502`))) as unknown as typeof fetch,
  });

  const e = await channel.deliver(target, new AbortController().signal).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  assert.ok(isLoomError(e));
  assert.equal(JSON.stringify(errorRecord(e)).includes("ZZZZZZZZZZZZZZZZ"), false);
});

test("A URL WHOSE CREDENTIAL IS ITS USERNAME IS MASKED LIKE ONE", async () => {
  // `urlSecrets` gated BOTH of its userinfo entries on `if (u.password !== "")`, so
  // `https://<token>@host/path` — the bearer-token-in-userinfo form that
  // `callbackBaseUrl`'s own docstring names as its reason for refusing userinfo — put
  // nothing at all in the mask list. The href carries the userinfo, so a message quoting
  // the WHOLE URL was masked and the leak looked closed; every message that quotes the
  // credential alone was not, which is the same "one form masked, its neighbours not" shape
  // the normalized-href fix closed one field over.
  const r = rig();
  const target = await liveTarget(r);
  const token = "xoxb-2024-loom-bot-token";
  const url = `https://${token}@hooks.example.com/services/T00/B00/XYZ`;
  const channel = new WebhookChannel({
    url,
    // A transport that names the credential without the URL around it — a proxy's 407, an
    // auth layer's own message, a client that puts the host in a header.
    fetch: (() => Promise.reject(new Error(`407 proxy authentication failed for user ${token}`))) as unknown as typeof fetch,
  });

  const e = await channel.deliver(target, new AbortController().signal).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  assert.ok(isLoomError(e));
  assert.equal(JSON.stringify(errorRecord(e)).includes(token), false, "the userinfo IS the credential when there is no password");
  assert.match(String((e.details as { cause: string }).cause), /407 proxy authentication failed/, "the diagnosis survives");
});

// ── the last resort has to be a LAST resort ──────────────────────────────────

test("A GATE ID THE CALLER WROTE CANNOT MAKE `deliver` EXIT UNTYPED", async () => {
  // `#failure`'s last-resort arm interpolated `gateId`, which is read off `target.gate` —
  // a value the caller wrote. Both the primary arm and the last resort ran the same
  // failing template, so the "total" handler exited untyped after all.
  const r = rig();
  const real = await liveTarget(r);
  const hostile = {
    ...real,
    gate: {
      ...real.gate,
      gateId: {
        toString(): string {
          throw new Error("a gateId that will not print");
        },
      },
    },
  } as unknown as DeliveryTarget;

  const channel = new WebhookChannel({
    url: "https://hooks.example.com/x",
    fetch: (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch,
  });

  const e = await channel.deliver(hostile, new AbortController().signal).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  assert.ok(isLoomError(e), `deliver exited untyped: ${String(e)}`);
  assert.equal(e.code, CODES.E_GATE_DELIVERY_FAILED);
});

test("NOTHING RUNS ABOVE THE TRY — a config getter that throws is a delivery failure", async () => {
  // `const timeoutMs = this.#opts.timeoutMs ?? 10_000` sat above the try while the
  // docstring three lines up claimed nothing did.
  const r = rig();
  const target = await liveTarget(r);
  let fetched = false;
  const channel = new WebhookChannel({
    url: "https://hooks.example.com/x",
    get timeoutMs(): number {
      throw new Error("a config getter threw");
    },
    fetch: (() => {
      fetched = true;
      return Promise.resolve(new Response("ok"));
    }) as unknown as typeof fetch,
  });

  const e = await channel.deliver(target, new AbortController().signal).then(
    (receipt) => receipt,
    (thrown: unknown) => thrown,
  );
  assert.ok(isLoomError(e), `deliver exited untyped: ${String(e)}`);
  assert.equal(e.code, CODES.E_GATE_DELIVERY_FAILED);
  assert.equal(fetched, false, "nothing was sent");
});

// ── a channel's LoomError is still a value from outside ──────────────────────

/** A `LoomError` a CHANNEL produced, whose `message` cannot be read. */
function unreadable(): LoomError {
  const e = err.cancelled("this message cannot be read");
  Object.defineProperty(e, "message", {
    get(): string {
      throw new Error("hostile getter");
    },
    configurable: true,
  });
  return e;
}

test("ONE CHANNEL'S HOSTILE ERROR DOES NOT ERASE THE HEALTHY CHANNELS' ROWS", async () => {
  // `channelFailure` handed an injected channel's `LoomError` straight back, and the
  // dispatcher then read `f.error.message` OUTSIDE any try while building the journal
  // batch. A throwing getter there rejected the whole dispatch — so one bad channel
  // deleted the `gate.delivered` row of every good one.
  const r = rig();
  const gate = await liveGate(r);
  const hostile: DeliveryChannel = { name: "hostile", deliver: () => Promise.reject(unreadable()) };
  const ok: DeliveryChannel = { name: "ok", deliver: () => Promise.resolve("receipt-1") };
  const dispatcher = new GateDispatcher({ channels: [hostile, ok] });

  const out = await dispatcher.deliver(r.log, gate, { channels: ["hostile", "ok"] });
  assert.deepEqual(out.delivered, [{ channel: "ok", receipt: "receipt-1" }]);

  const seq = await events(r.store);
  const delivered = seq.filter((e) => e.type === "gate.delivered");
  assert.equal(delivered.length, 1, "the working channel's row survived the hostile one");
  const failed = seq.filter((e) => e.type === "gate.delivery_failed");
  assert.equal(failed.length, 1);
  assert.equal(typeof (failed[0]?.payload as { error: unknown }).error, "string");
});

test("A CHANNEL'S OWN `LoomError` IS BOUNDED BEFORE IT REACHES THE JOURNAL", async () => {
  // The claim was "a third party's message is bounded to 300 chars via `describeCause`".
  // That held only for non-Loom throws: a `LoomError` from a channel wrote its WHOLE
  // message into the audit row.
  const r = rig();
  const gate = await liveGate(r);
  const shouty: DeliveryChannel = {
    name: "shouty",
    deliver: () =>
      Promise.reject(
        err.unavailable(CODES.E_PROVIDER_TRANSPORT, "z".repeat(20_000), { details: { leak: "x".repeat(50_000) } }),
      ),
  };
  const dispatcher = new GateDispatcher({ channels: [shouty] });
  const out = await dispatcher.deliver(r.log, gate, { channels: ["shouty"] });

  const row = (await events(r.store)).find((e) => e.type === "gate.delivery_failed");
  const message = (row?.payload as { error: string }).error;
  assert.ok(message.length <= 300, `a third party wrote ${message.length} characters into an audit row`);

  // …and at the API boundary too, not only at the one journal site that happens to read
  // it today. `details` is dropped outright: `errorRecord` copies `details` verbatim, so
  // an unbounded object from a channel is a journal payload waiting for a second caller.
  const e = out.failed[0]!.error;
  assert.ok(e.message.length <= 300, `${e.message.length} characters handed back to the caller`);
  assert.equal((e.details as { leak?: unknown } | undefined)?.leak, undefined);
  assert.equal(e.code, CODES.E_PROVIDER_TRANSPORT, "the code the channel chose still survives");
});

test("…and the code and class a channel chose still survive the bounding", async () => {
  // The bound may not cost the taxonomy: `retryable` is DERIVED from the class, so an
  // operator's cancel has to stay `E_CANCELLED` and stay non-retryable.
  const r = rig();
  const gate = await liveGate(r);
  const cancels: DeliveryChannel = {
    name: "cancels",
    deliver: () => Promise.reject(err.cancelled("the operator cancelled this dispatch")),
  };
  const dispatcher = new GateDispatcher({ channels: [cancels] });
  const out = await dispatcher.deliver(r.log, gate, { channels: ["cancels"] });
  const e = out.failed[0]!.error;
  assert.equal(e.code, CODES.E_CANCELLED);
  assert.equal(e.retryable, false);
  assert.equal(e.message, "the operator cancelled this dispatch");
});

test("AN ERROR THE DISPATCHER HANDS BACK IS ONE IT BUILT, not one a channel did", async () => {
  // The outbound half of the boundary, pinned so the two halves cannot drift. `isLoomError`
  // is an `instanceof`: it proves the prototype and nothing about provenance, and a channel
  // is injected code in this process. So "it came back typed" is not "it came back safe" —
  // the object's own accessors travel with it, and the next reader is `errorRecord` on the
  // way into a journal row or `toJSON` on the way into an HTTP body, neither of which is
  // inside anybody's try.
  const r = rig();
  const gate = await liveGate(r);
  const booby = (): LoomError => {
    const e = err.unavailable(CODES.E_PROVIDER_TRANSPORT, "the vendor is down");
    for (const field of ["details", "class", "code", "message"]) {
      Object.defineProperty(e, field, {
        get(): never {
          throw new Error(`${field} is a trap`);
        },
        configurable: true,
      });
    }
    return e;
  };
  const hostile: DeliveryChannel = { name: "booby", deliver: () => Promise.reject(booby()) };
  const dispatcher = new GateDispatcher({ channels: [hostile] });

  const out = await dispatcher.deliver(r.log, gate, { channels: ["booby"] });
  const e = out.failed[0]!.error;
  assert.ok(isLoomError(e));
  assert.doesNotThrow(() => JSON.stringify(errorRecord(e)), "the journal's reader owns nothing it did not build");
  assert.doesNotThrow(() => JSON.stringify(e.toJSON()), "and neither does the API's");
  assert.equal(e.code, CODES.E_GATE_DELIVERY_FAILED, "unreadable means undelivered, which is the one code out");
});

test("A CHANNEL THAT WILL NOT SAY WHAT IT IS CALLED IS REFUSED AT CONSTRUCTION", async () => {
  // The dispatcher's map is keyed by ONE read of each `name`, and that read is the whole
  // boundary for the name — it decides the map key, the counter key, and the channel field
  // of every journal row. It had no try around it, so a hostile getter made `new
  // GateDispatcher` exit untyped; and a non-string name registered a key that no
  // `spec.channels` entry can ever match, which is a gate silently undeliverable at 3am
  // rather than a config the deployment refuses to start with.
  for (const channels of [
    [
      {
        get name(): string {
          throw new Error("name is a trap");
        },
        deliver: () => Promise.resolve("x"),
      } as unknown as DeliveryChannel,
    ],
    [{ name: 7 as unknown as string, deliver: () => Promise.resolve("x") }],
    [{ name: "", deliver: () => Promise.resolve("x") }],
  ]) {
    assert.throws(
      () => new GateDispatcher({ channels }),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID,
    );
  }
  // …and the fallback is held to it too: it names the rows written when everything else
  // failed, which is the moment nobody is watching.
  assert.throws(
    () =>
      new GateDispatcher({
        channels: [],
        fallback: { name: undefined as unknown as string, deliver: () => Promise.resolve("x") },
      }),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID,
  );
});

// ── a RECEIPT is a value from outside too ────────────────────────────────────
//
// The error side was totalized first, which left the mirror of every one of its bugs one
// branch over: a receipt is a `string` by contract and whatever injected code resolved in
// fact, and it reaches a durable row without ever having been checked.

test("ONE CHANNEL'S UNJOURNALABLE RECEIPT DOES NOT ERASE THE HEALTHY CHANNELS' ROWS", async () => {
  // The exact failure the error side closed, reopened on the success side. `canonicalize`
  // refuses a symbol, so `log.append` threw AFTER every channel had already reported —
  // rejecting the whole dispatch and taking the working channel's `gate.delivered` row,
  // and every failed channel's row, with it.
  const r = rig();
  const gate = await liveGate(r);
  const bogus: DeliveryChannel = {
    name: "bogus",
    deliver: () => Promise.resolve(Symbol("not a receipt") as unknown as string),
  };
  const ok: DeliveryChannel = { name: "ok", deliver: () => Promise.resolve("receipt-1") };
  const dispatcher = new GateDispatcher({ channels: [bogus, ok] });

  const out = await dispatcher.deliver(r.log, gate, { channels: ["bogus", "ok"] });
  assert.deepEqual(out.delivered, [{ channel: "ok", receipt: "receipt-1" }]);

  const seq = await events(r.store);
  assert.equal(seq.some((e) => e.type === "gate.decided"), false, "nothing was decided");
  assert.deepEqual(
    seq.filter((e) => e.type === "gate.delivered").map((e) => (e.payload as { channel: string }).channel),
    ["ok"],
    "the working channel's row survived the one that resolved nonsense",
  );
  assert.deepEqual(
    seq.filter((e) => e.type === "gate.delivery_failed").map((e) => (e.payload as { channel: string }).channel),
    ["bogus"],
    "…and the nonsense is on the record as a FAILURE, not as a delivery",
  );
});

test("A CHANNEL THAT RESOLVES NOTHING HAS NOT DELIVERED ANYTHING", async () => {
  // `"receipt" in r` is true for `{channel, receipt: undefined}`, so a channel that
  // resolved nothing counted as delivered: `gate.delivered` was journaled with no receipt
  // and the fallback was SUPPRESSED. That is a silent non-delivery recorded as a
  // delivery — the harm `DeliveryChannel.deliver`'s own docstring names — and it switched
  // off the safety net at the moment it was most needed.
  const fallback = new ConsoleChannel();
  const silent: DeliveryChannel = {
    name: "silent",
    deliver: () => Promise.resolve(undefined as unknown as string),
  };
  const r = rig({ channels: [silent], fallback });

  const gateId = await r.broker.raise(r.log, request({ delivery: { channels: ["silent"] } }));

  const open = await r.broker.list(r.log);
  assert.equal(open.length, 1, "the gate is still open");
  assert.equal(open[0]?.gateId, gateId);
  assert.equal(fallback.queued.length, 1, "the console queue caught what nobody was told about");

  const seq = await events(r.store);
  assert.equal(seq.some((e) => e.type === "gate.decided"), false, "nothing was decided");
  assert.deepEqual(
    seq.filter((e) => e.type === "gate.delivered").map((e) => (e.payload as { channel: string }).channel),
    ["console"],
    "only the fallback delivered anything",
  );
  const failed = seq.filter((e) => e.type === "gate.delivery_failed");
  assert.deepEqual(failed.map((e) => (e.payload as { channel: string }).channel), ["silent"]);
  assert.equal((failed[0]?.payload as { fellBack: boolean }).fellBack, true);
});

test("…and a receipt nobody could look up is not a receipt either", async () => {
  // A receipt is "an id the channel can be asked about later". An empty string is not one,
  // and `WebhookChannel` already refuses to hand one back — it substitutes its own. The
  // rule belongs at the dispatcher, where every channel passes.
  const fallback = new ConsoleChannel();
  const blank: DeliveryChannel = { name: "blank", deliver: () => Promise.resolve("   ") };
  const r = rig({ channels: [blank], fallback });
  await r.broker.raise(r.log, request({ delivery: { channels: ["blank"] } }));

  assert.equal(fallback.queued.length, 1);
  const seq = await events(r.store);
  assert.deepEqual(
    seq.filter((e) => e.type === "gate.delivery_failed").map((e) => (e.payload as { channel: string }).channel),
    ["blank"],
  );
});

test("a receipt a channel wrote does not become an audit row", async () => {
  const r = rig();
  const gate = await liveGate(r);
  const shouty: DeliveryChannel = { name: "shouty", deliver: () => Promise.resolve("r".repeat(50_000)) };
  const dispatcher = new GateDispatcher({ channels: [shouty] });
  await dispatcher.deliver(r.log, gate, { channels: ["shouty"] });

  const row = (await events(r.store)).find((e) => e.type === "gate.delivered");
  const receipt = (row?.payload as { receipt: string }).receipt;
  assert.ok(receipt.length <= 200, `a third party wrote ${receipt.length} characters into an audit row`);
});

test("THE LOAD-BEARING RULE, RE-READ WITH CHANNELS FAILING AND ANSWERING BADLY AT ONCE", async () => {
  // The two halves interleaved, because they are journaled in one append and a throw from
  // either erases both. Six channels: two that throw in shapes that used to escape, two
  // that resolve values the journal cannot hold, one that resolves nothing, one that
  // works. The gate stays open, nothing is decided, and every row survives.
  const channels: DeliveryChannel[] = [
    { name: "unreadable-loom", deliver: () => Promise.reject(unreadable()) },
    { name: "nulls", deliver: () => Promise.reject(Object.create(null) as Error) },
    { name: "symbolic", deliver: () => Promise.resolve(Symbol("nope") as unknown as string) },
    { name: "numeric", deliver: () => Promise.resolve(42 as unknown as string) },
    { name: "silent", deliver: () => Promise.resolve(undefined as unknown as string) },
    { name: "ok", deliver: () => Promise.resolve("receipt-ok") },
  ];
  const fallback = new ConsoleChannel();
  const r = rig({ channels, fallback });
  const names = channels.map((c) => c.name);
  const gateId = await r.broker.raise(r.log, request({ delivery: { channels: names } }));

  const open = await r.broker.list(r.log);
  assert.equal(open.length, 1, "THE GATE IS STILL OPEN");
  assert.equal(open[0]?.gateId, gateId);
  assert.equal(fallback.queued.length, 0, "one working channel is enough; the fallback is for zero");

  const seq = await events(r.store);
  assert.equal(seq.some((e) => e.type === "gate.decided"), false, "nothing was decided");
  assert.deepEqual(
    seq.filter((e) => e.type === "gate.delivered").map((e) => (e.payload as { channel: string }).channel),
    ["ok"],
  );
  assert.deepEqual(
    seq.filter((e) => e.type === "gate.delivery_failed").map((e) => (e.payload as { channel: string }).channel).sort(),
    ["nulls", "numeric", "silent", "symbolic", "unreadable-loom"],
    "every channel that did not deliver is on the record, whichever way it failed to",
  );
  for (const row of seq.filter((e) => e.type === "gate.delivery_failed")) {
    const payload = row.payload as { error: unknown };
    assert.equal(typeof payload.error, "string", "a row nobody can read is not a record");
    assert.ok((payload.error as string).length <= 300);
  }
});

test("…and with EVERY channel answering badly, the fallback still queues exactly once", async () => {
  const channels: DeliveryChannel[] = [
    { name: "symbolic", deliver: () => Promise.resolve(Symbol("nope") as unknown as string) },
    { name: "silent", deliver: () => Promise.resolve(undefined as unknown as string) },
    { name: "dead", deliver: () => Promise.reject(new Error("connection refused")) },
  ];
  const fallback = new ConsoleChannel();
  const r = rig({ channels, fallback });
  await r.broker.raise(r.log, request({ delivery: { channels: channels.map((c) => c.name) } }));

  assert.equal(fallback.queued.length, 1, "exactly once");
  const seq = await events(r.store);
  assert.equal(seq.some((e) => e.type === "gate.decided"), false);
  assert.equal(seq.filter((e) => e.type === "gate.delivery_failed").length, 3);
  for (const row of seq.filter((e) => e.type === "gate.delivery_failed")) {
    assert.equal((row.payload as { fellBack: boolean }).fellBack, true);
  }
});

test("maskLiterals replaces every occurrence, longest literal first", () => {
  const url = "https://hooks.example.com/services/SECRET";
  assert.equal(
    maskLiterals(`${url} failed; retried ${url}`, [url, new URL(url).origin]),
    "[redacted] failed; retried [redacted]",
    "the origin is a PREFIX of the url — masking it first would leave the path behind",
  );
  assert.equal(maskLiterals("nothing to do here", [url]), "nothing to do here");
  assert.equal(maskLiterals("a b c", ["a", "b"]), "a b c", "a literal too short to be a secret is not masked");
});

// ── no dispatcher at all ─────────────────────────────────────────────────────

test("a broker with no dispatcher still raises, escalates, and expires", async () => {
  // A usable configuration, not a broken one: the console and the HTTP API surface the
  // queue. What must NOT change is that an unanswered gate still runs out of time.
  clock.t = 1_000_000;
  const store = new MemoryStateStore({ now });
  const log = new RunLog(RUN, { store, now });
  const broker = new HumanGateBroker({ now });

  await broker.raise(log, request({ slaMs: 1000, onTimeout: "escalate", delivery: CHAIN }));
  assert.equal((await broker.list(log)).length, 1);

  clock.t += 1001;
  await broker.sweepTimeouts(log, clock.t);
  const esc = (await events(store)).find((e) => e.type === "gate.escalated");
  assert.ok(esc, "the SLA does not depend on a channel being configured");
});

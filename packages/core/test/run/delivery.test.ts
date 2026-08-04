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

import {
  ConsoleChannel,
  GateDispatcher,
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
} from "../../src/run/delivery.ts";
import { HumanGateBroker, type GateRequest } from "../../src/run/gates.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { RunLog } from "../../src/run/log.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import type { NodeId, RunId, TaskId } from "../../src/ids.ts";

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

test("an unknown channel name is a delivery failure, not a crash", async () => {
  const fallback = new ConsoleChannel();
  const r = rig({ channels: [], fallback });
  await r.broker.raise(r.log, request({ delivery: { channels: ["slack"] } }));

  const failed = (await events(r.store)).filter((e) => e.type === "gate.delivery_failed");
  assert.equal(failed.length, 1);
  assert.match((failed[0]?.payload as { error: string }).error, /no delivery channel named "slack"/);
  assert.equal(fallback.queued.length, 1);
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
  ) as { command: string; requester: { name: string; email: string }; blastRadius: number };

  assert.equal(out.command, "restart");
  assert.equal(out.blastRadius, 12);
  assert.equal(out.requester.name, "Ada", "a path list would have missed this one either way");
  assert.match(out.requester.email, /^pii:/);
});

test("no redact list means the payload passes through untouched", () => {
  const v = { a: 1 };
  assert.equal(redactFields(v, [], "pii"), v);
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

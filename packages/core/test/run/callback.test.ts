/**
 * The RETURN path: a button click arriving as a decision.
 *
 * Outbound delivery had one rule — delivery failure never auto-approves. Inbound has the
 * mirror of it, and it is the one every test here circles:
 *
 * > **A CALLBACK THAT DOES NOT VERIFY LEAVES THE GATE OPEN.**
 *
 * The endpoint is reachable without a bearer token by design, so the signature is the
 * whole perimeter. That makes the interesting cases the ones where something is almost
 * right: a valid signature over yesterday's timestamp, a valid signature from someone
 * who is not an approver, a body that re-serializes differently than it arrived.
 *
 * Two properties are checked everywhere below, and the second is the newer one:
 *
 *   1. a callback that does not verify leaves the gate open;
 *   2. every refusal lands SOMEWHERE — in the run's journal when admission allows a
 *      durable row, in `router.refusals()` when it does not. Withholding the row was the
 *      right fix for write amplification; withholding it and recording nothing anywhere
 *      meant a forged-signature campaign was invisible to its own operators.
 *
 * The last section tests the OUTBOUND half of the same interface. It lives here rather
 * than with the dispatcher tests because it is the same property read in the other
 * direction: a failure at the channel boundary is a notification problem, never an
 * authorization one, and it has to arrive TYPED to stay that way.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ConsoleChannel,
  GateCallbackRouter,
  GateDispatcher,
  SignedWebhookChannel,
  WebhookChannel,
  callbackRejection,
  rejectionReasonOf,
  timingSafeStringEqual,
  type CallbackDecision,
  type CallbackEngine,
  type DeliveryChannel,
  type DeliveryTarget,
} from "../../src/run/delivery.ts";
import { CODES, err, httpStatusFor, isLoomError, type LoomError } from "../../src/errors.ts";
import type { GateId, RunId } from "../../src/ids.ts";
import { SYSTEM_ACTOR, errorRecord, type JournalEvent } from "../../src/journal/events.ts";
import { RunLog } from "../../src/run/log.ts";
import type { StateStore } from "../../src/journal/store.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { openGates } from "../../src/run/projection.ts";
import type { GateDecision } from "../../src/vocab.ts";
import { compileSkeleton, harness, skeletonSpec, DOCS } from "./skeleton.ts";

const SECRET = "shhh-approvals-service";
/** The harness's injected clock, so nothing here waits on real time. */
const NOW = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// A run parked on its gate, plus a router in front of it
// ---------------------------------------------------------------------------

interface Rig {
  readonly h: ReturnType<typeof harness>;
  readonly runId: RunId;
  readonly gateId: GateId;
  readonly router: GateCallbackRouter;
  readonly channel: SignedWebhookChannel;
  readonly now: { t: number };
  events(): Promise<JournalEvent[]>;
  /** POST a signed callback the way a real approvals service would. */
  post(body: string, over?: { ts?: string; sig?: string; channel?: string; runId?: RunId }): Promise<unknown>;
}

/**
 * The skeleton, with an approvers list declared on its gate node.
 *
 * Approvers are a property of the GRAPH, and therefore of `gate.raised` — not something
 * a caller hands the broker afterwards. A fixture that injected them into the broker's
 * memory would be testing a path no deployment takes, and would keep passing on a
 * process that restarted and lost them.
 */
function specWithApprovers(approvers: readonly string[]): GraphSpec {
  const base = skeletonSpec();
  return {
    ...base,
    nodes: base.nodes.map((node) =>
      node.type === "human_gate" && node.humanGate !== undefined
        ? { ...node, humanGate: { ...node.humanGate, approval: { approvers } } }
        : node,
    ),
  };
}

async function rig(opts: { approvers?: readonly string[] } = {}): Promise<Rig> {
  const h = harness();
  const runId = await h.engine.submit({
    graph: compileSkeleton(opts.approvers === undefined ? undefined : specWithApprovers(opts.approvers)),
    inputs: { paths: DOCS },
    workflow: "skeleton-summarize",
  });
  await h.engine.advance(runId);

  const open = await h.engine.openGates(runId);
  assert.equal(open.length, 1, "the skeleton parks on exactly one gate");
  const gate = open[0]!;

  const channel = new SignedWebhookChannel({
    name: "slack",
    url: "https://hooks.example.com/unused",
    callbackSecret: SECRET,
  });
  const now = { t: NOW };
  const store: StateStore = h.store;
  const router = new GateCallbackRouter({
    dispatcher: new GateDispatcher({ channels: [channel, new ConsoleChannel()] }),
    engine: h.engine as unknown as CallbackEngine,
    logFor: (id) => new RunLog(id, { store, bus: h.bus }),
    now: () => now.t,
  });

  return {
    h,
    runId,
    gateId: gate.gateId,
    router,
    channel,
    now,
    async events() {
      const out: JournalEvent[] = [];
      for await (const e of h.store.read(runId, 1)) out.push(e);
      return out;
    },
    post(body, over = {}) {
      const ts = over.ts ?? String(Math.floor(now.t / 1000));
      return router.handle({
        channel: over.channel ?? "slack",
        runId: over.runId ?? runId,
        body: Buffer.from(body, "utf8"),
        headers: {
          "x-loom-timestamp": ts,
          "x-loom-signature": over.sig ?? channel.sign(body, ts),
        },
      });
    },
  };
}

const approval = (r: Rig, actor = "u:alice"): string =>
  JSON.stringify({ runId: r.runId, gateId: r.gateId, actor, decision: { kind: "approve" } });

async function refuses(fn: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(fn, (e: unknown) => {
    assert.ok(isLoomError(e), `expected a LoomError, got ${String(e)}`);
    assert.equal(e.code, code);
    return true;
  });
}

async function stillOpen(r: Rig): Promise<void> {
  const p = await r.h.engine.projection(r.runId);
  assert.equal(p?.gates[r.gateId]?.state, "open", "THE GATE MUST STILL BE OPEN");
  assert.equal(r.h.writes.length, 0, "…and the action behind it must not have run");
}

function rejections(events: readonly JournalEvent[]): { channel: string; reason: string; gateId?: string }[] {
  return events
    .filter((e) => e.type === "gate.callback_rejected")
    .map((e) => e.payload as { channel: string; reason: string; gateId?: string });
}

// ── the bar the handoff set ──────────────────────────────────────────────────

test("A FORGED SIGNATURE LEAVES THE GATE OPEN, and writes nothing at all", async () => {
  const r = await rig();
  const body = approval(r);
  const before = (await r.events()).length;

  await refuses(() => r.post(body, { sig: "v0=" + "f".repeat(64) }), CODES.E_GATE_NOT_AUTHORIZED);

  await stillOpen(r);
  const seq = await r.events();
  assert.equal(seq.some((e) => e.type === "gate.decided"), false, "nothing was decided");
  // NOT journaled, and that is the fix rather than a regression. The callback URL is
  // handed to a third party and contains the runId, so a row per forged request is a
  // journal anyone can grow. A caller that cannot produce the signature has proved
  // nothing about itself and — since verification now runs before the lookup — nothing
  // about whether this run even exists.
  assert.equal(seq.length, before, "a forgery is refused at the perimeter, not recorded");
  assert.deepEqual(rejections(seq), []);
});

test("a callback with NO signature at all is refused the same way", async () => {
  const r = await rig();
  await assert.rejects(
    () => r.router.handle({ channel: "slack", runId: r.runId, body: Buffer.from(approval(r)), headers: {} }),
    /unsigned/,
  );
  await stillOpen(r);
  assert.deepEqual(rejections(await r.events()), []);
});

test("200 UNSIGNED POSTS AT A FINISHED RUN GROW ITS JOURNAL BY NOTHING", async () => {
  // The write amplification, as it was reproduced: drive the run to completion through a
  // legitimate approval, then hammer the same address. The address is not a secret — it
  // is in the URL that was handed to the approvals service — and the run has been over
  // for a while. Two hundred forged requests used to mean two hundred durable rows.
  const r = await rig();
  await r.post(approval(r));
  const p = await r.h.engine.projection(r.runId);
  assert.equal(p?.status, "succeeded", "the run really is finished");
  const before = (await r.events()).length;

  for (let i = 0; i < 200; i++) {
    await assert.rejects(() =>
      r.router.handle({ channel: "slack", runId: r.runId, body: Buffer.from(approval(r, `u:m${i}`)), headers: {} }),
    );
  }

  assert.equal((await r.events()).length, before, "200 forged requests, zero events");
});

test("a SIGNED callback at a finished run is refused without growing its journal either", async () => {
  // Holding the secret is not a licence to append. The gate is decided and the run is
  // terminal, so there is no live decision for an audit row to be about — the story is
  // already in `gate.decided`. The refusal still happens, and still says 409.
  const r = await rig();
  await r.post(approval(r));
  const before = (await r.events()).length;

  for (let i = 0; i < 5; i++) {
    const body = JSON.stringify({ runId: r.runId, gateId: r.gateId, actor: `u:m${i}`, decision: { kind: "approve" } });
    await refuses(() => r.post(body), CODES.E_GATE_ALREADY_RESOLVED);
  }

  const seq = await r.events();
  assert.equal(seq.length, before, "five signed attempts on a decided gate, zero rows");
  assert.equal(seq.filter((e) => e.type === "gate.decided").length, 1);
  assert.equal(r.h.writes.length, 1);
});

test("AN UNSIGNED CALLBACK CANNOT TELL A REAL RUN FROM A FICTIONAL ONE", async () => {
  // The existence oracle. With the gate lookup ahead of the signature check, a real
  // gated run answered 403 "callback is unsigned" and a run that never existed answered
  // 404 "no gated run at that address" — so anyone holding a callback URL could
  // enumerate runs with no credential of any kind. Verifying first collapses the two
  // answers into one, because neither has been looked up when the answer is decided.
  const r = await rig();
  const unsigned = (runId: RunId): Promise<unknown> =>
    r.router.handle({ channel: "slack", runId, body: Buffer.from(approval(r)), headers: {} });

  const real = await unsigned(r.runId).then(() => undefined, (e: unknown) => e);
  const fake = await unsigned("01JNOSUCHRUN0000000000000" as RunId).then(() => undefined, (e: unknown) => e);

  assert.ok(isLoomError(real) && isLoomError(fake));
  assert.equal(real.code, fake.code, "the same code for a run that exists and one that does not");
  assert.equal(real.message, fake.message, "and the same message");
});

test("a signature valid for OTHER bytes does not verify for these", async () => {
  const r = await rig();
  const ts = String(Math.floor(NOW / 1000));
  const reject = JSON.stringify({ runId: r.runId, gateId: r.gateId, actor: "u:alice", decision: { kind: "reject", reason: "no" } });
  // The attacker holds a legitimately signed rejection and swaps the body for an approval.
  await refuses(() => r.post(approval(r), { ts, sig: r.channel.sign(reject, ts) }), CODES.E_GATE_NOT_AUTHORIZED);
  await stillOpen(r);
});

// ── the replay window ────────────────────────────────────────────────────────

test("A CAPTURED APPROVAL IS NOT REPLAYABLE TOMORROW", async () => {
  const r = await rig();
  const body = approval(r);
  const ts = String(Math.floor(NOW / 1000));
  const sig = r.channel.sign(body, ts);

  // Same bytes, same signature — and the clock has moved on by a day.
  r.now.t = NOW + 86_400_000;
  await refuses(() => r.post(body, { ts, sig }), CODES.E_GATE_NOT_AUTHORIZED);

  await stillOpen(r);
  // A replay is a perimeter failure like a forgery: refused before any lookup, so there
  // is nothing durable to show for it. See `GateCallbackRouter`.
  assert.deepEqual(rejections(await r.events()), []);
});

test("THE TIMESTAMP IS INSIDE THE SIGNED MATERIAL, so an attacker cannot refresh it", async () => {
  // The bug this pins: a timestamp checked but not signed is a timestamp the attacker
  // edits, and then the replay window is decoration.
  const r = await rig();
  const body = approval(r);
  const stale = String(Math.floor((NOW - 86_400_000) / 1000));
  const sig = r.channel.sign(body, stale);

  const fresh = String(Math.floor(NOW / 1000));
  await refuses(() => r.post(body, { ts: fresh, sig }), CODES.E_GATE_NOT_AUTHORIZED);
  await stillOpen(r);
  assert.deepEqual(rejections(await r.events()), [], "rewriting the header broke the MAC, and a broken MAC writes nothing");
});

test("a timestamp far in the FUTURE is refused too", async () => {
  const r = await rig();
  const body = approval(r);
  const ts = String(Math.floor((NOW + 3_600_000) / 1000));
  await refuses(() => r.post(body, { ts, sig: r.channel.sign(body, ts) }), CODES.E_GATE_NOT_AUTHORIZED);
  await stillOpen(r);
});

test("a non-numeric timestamp is refused rather than coerced to zero", async () => {
  const r = await rig();
  const body = approval(r);
  await refuses(() => r.post(body, { ts: "not-a-time" }), CODES.E_GATE_NOT_AUTHORIZED);
  assert.deepEqual(rejections(await r.events()), []);
});

test("THE SIGNED STRING IS UNAMBIGUOUS — a timestamp may not smuggle a delimiter", async () => {
  // The signed material is `v0:{ts}:{body}`. A timestamp containing a colon would make
  // the encoding non-injective: two different (ts, body) pairs could produce identical
  // bytes to sign, and one signature would then vouch for both. Digits only, checked
  // before the MAC is computed, is what keeps that from being expressible at all.
  const r = await rig();
  const body = approval(r);
  const ts = String(Math.floor(NOW / 1000));
  await refuses(() => r.post(body, { ts: `${ts}:junk`, sig: r.channel.sign(body, `${ts}:junk`) }), CODES.E_GATE_NOT_AUTHORIZED);
  assert.deepEqual(rejections(await r.events()), []);
  await stillOpen(r);
});

// ── byte fidelity ────────────────────────────────────────────────────────────

test("THE SIGNATURE IS OVER THE RAW BYTES, not a re-serialization", async () => {
  // A body that survives JSON.parse and comes back DIFFERENT from JSON.stringify: key
  // order reversed, a \u escape, a trailing-zero number, and whitespace. A verifier that
  // re-serialized before checking would compute a different MAC and reject a legitimate
  // callback — or, checked the other way round, would accept whatever it produced itself.
  const r = await rig();
  const raw =
    `{ "decision" : {"kind":"approve"} ,\n` +
    `  "actor": "u:\\u0061lice",\n` +
    `  "gateId": ${JSON.stringify(r.gateId)},\n` +
    `  "runId": ${JSON.stringify(r.runId)},\n` +
    `  "n": 1.0 }`;

  const reserialized = JSON.stringify(JSON.parse(raw) as unknown);
  assert.notEqual(reserialized, raw, "the fixture is only meaningful if it does NOT round-trip");

  const out = await r.post(raw);
  assert.equal((out as { gateId: GateId }).gateId, r.gateId);

  const decided = (await r.events()).find((e) => e.type === "gate.decided");
  assert.ok(decided, "a legitimately signed callback verified");
  assert.deepEqual(decided.actor, { kind: "human", subject: "u:alice", via: "slack" });
});

// ── idempotency: reuse resolve's key, do not invent a second one ─────────────

test("THE SAME CALLBACK TWICE YIELDS EXACTLY ONE gate.decided", async () => {
  const r = await rig();
  const body = approval(r);
  const ts = String(Math.floor(NOW / 1000));
  const sig = r.channel.sign(body, ts);

  await r.post(body, { ts, sig });
  await r.post(body, { ts, sig }); // the webhook retry

  const seq = await r.events();
  assert.equal(seq.filter((e) => e.type === "gate.decided").length, 1);
  assert.equal(r.h.writes.length, 1, "and the action behind the gate ran once");
  assert.deepEqual(rejections(seq), [], "a retry is not a rejection");
});

test("a SECOND, DIFFERENT decision on a decided gate is a conflict, not a second decision", async () => {
  const r = await rig();
  await r.post(approval(r));

  const body = JSON.stringify({ runId: r.runId, gateId: r.gateId, actor: "u:bob", decision: { kind: "reject", reason: "too late" } });
  await refuses(() => r.post(body), CODES.E_GATE_ALREADY_RESOLVED);

  const seq = await r.events();
  assert.equal(seq.filter((e) => e.type === "gate.decided").length, 1);
  // 409, and no row: `gate.decided` already says who decided and when, so a second
  // attempt at a gate that is closed adds volume rather than information. The row is
  // withheld by admission, not by the conflict — see the finished-run tests above.
  assert.deepEqual(rejections(seq), []);
});

// ── the actor is a human, always ─────────────────────────────────────────────

test("THE RECORDED ACTOR IS THE HUMAN THE SIGNATURE VOUCHES FOR, never `system`", async () => {
  const r = await rig();
  await r.post(approval(r, "u:carol"));

  const decided = (await r.events()).find((e) => e.type === "gate.decided");
  assert.deepEqual(decided?.actor, { kind: "human", subject: "u:carol", via: "slack" });
});

test("a callback that names nobody is refused rather than attributed to `unknown`", async () => {
  const r = await rig();
  const body = JSON.stringify({ runId: r.runId, gateId: r.gateId, decision: { kind: "approve" } });
  await refuses(() => r.post(body), CODES.E_PROVIDER_BAD_REQUEST);
  await stillOpen(r);
  assert.deepEqual(rejections(await r.events()), [{ channel: "slack", reason: "malformed" }]);
});

test("Slack's `user: {id}` shape is understood, and `via` follows the channel name", async () => {
  const r = await rig();
  const body = JSON.stringify({ runId: r.runId, gateId: r.gateId, user: { id: "U024BE7LH", name: "ada" }, decision: { kind: "approve" } });
  await r.post(body);
  const decided = (await r.events()).find((e) => e.type === "gate.decided");
  assert.deepEqual(decided?.actor, { kind: "human", subject: "U024BE7LH", via: "slack" });
});

test("a channel whose name is not a known `via` records `api` rather than inventing one", async () => {
  // `Actor.via` is a closed union. A channel called "approvals-svc" cannot claim to be
  // one of its members, and the honest answer for "an HTTP integration" is `api`.
  const c = new SignedWebhookChannel({ name: "approvals-svc", url: "https://x", callbackSecret: SECRET });
  const body = JSON.stringify({ runId: "r", gateId: "g", actor: "u:alice", decision: { kind: "approve" } });
  const ts = String(Math.floor(NOW / 1000));
  const parsed = await c.parseCallback({
    body: Buffer.from(body),
    headers: { "x-loom-timestamp": ts, "x-loom-signature": c.sign(body, ts) },
    now: NOW,
  });
  assert.deepEqual(parsed.actor, { kind: "human", subject: "u:alice", via: "api" });

  const teams = new SignedWebhookChannel({ name: "teams", url: "https://x", callbackSecret: SECRET });
  const t = await teams.parseCallback({
    body: Buffer.from(body),
    headers: { "x-loom-timestamp": ts, "x-loom-signature": teams.sign(body, ts) },
    now: NOW,
  });
  assert.equal(t.actor.via, "teams");
  assert.equal(t.idempotencyKey, teams.sign(body, ts).slice(3), "derived from the request, not minted");
});

test("a CONFIGURED `via` goes through the same closed set as every other producer", async () => {
  // `#via` has three producers and only two were checked. The channel-NAME path is gated on
  // `VIA` (the test above), and the inbound path drops an unknown one in `ownedActor` — but
  // `opts.via ?? …` took a configured value verbatim, so the one producer an operator
  // actually writes was the one nothing checked. `Actor.via` is journaled vocabulary, and a
  // value outside the union is a `gate.decided` row asserting a route that does not exist.
  //
  // DROPPED RATHER THAN REFUSED, which is `cli.ts`'s `isVia` rule stated by its own
  // docstring: dropping is safe exactly when the value it falls back to is TRUE, and every
  // decision reaching this class arrived over the callback route, so `api` is a fact rather
  // than a substitute. The same reasoning `ownedActor` gives for the inbound half.
  const body = JSON.stringify({ runId: "r", gateId: "g", actor: "u:alice", decision: { kind: "approve" } });
  const ts = String(Math.floor(NOW / 1000));
  const viaOf = async (via: string): Promise<string> => {
    const c = new SignedWebhookChannel({
      name: "approvals-svc",
      url: "https://x",
      callbackSecret: SECRET,
      via: via as "console" | "slack" | "feishu" | "teams" | "email" | "api" | "cli",
    });
    const parsed = await c.parseCallback({
      body: Buffer.from(body),
      headers: { "x-loom-timestamp": ts, "x-loom-signature": c.sign(body, ts) },
      now: NOW,
    });
    return parsed.actor.via;
  };
  assert.equal(await viaOf("console"), "console", "a member of the vocabulary is honoured");
  assert.equal(await viaOf("slak"), "api", "a typo is dropped to the route the decision really arrived over");
  assert.equal(await viaOf("constructor"), "api", "…and an inherited name is not a member of anything");
});

// ── authorization is not authenticity ────────────────────────────────────────

test("A VERIFIED CALLER WHO IS NOT AN APPROVER IS REFUSED", async () => {
  const r = await rig({ approvers: ["u:alice", "u:bob"] });
  await assert.rejects(() => r.post(approval(r, "u:mallory")), (e: unknown) => {
    assert.ok(isLoomError(e));
    assert.equal(e.code, CODES.E_GATE_NOT_AUTHORIZED);
    // The message pins WHICH layer refused. `HumanGateBroker.resolve` enforces this too
    // and would refuse a moment later; the router refusing first is what keeps the
    // callback path from ever reaching `resolve` with a caller it already knows about.
    assert.equal(e.message, "the caller is not an approver for this gate");
    return true;
  });

  await stillOpen(r);
  assert.deepEqual(rejections(await r.events()), [{ channel: "slack", reason: "not_authorized", gateId: r.gateId }]);
});

test("IF THE APPROVERS LIST CANNOT BE READ, THE CALLBACK FAILS CLOSED", async () => {
  // "Nobody is listed" and "I could not find out who is listed" are different facts.
  // Treating the second as the first would turn an unavailable read model into a way
  // past the approvers check — and the caller here is a legitimate approver, so the
  // only thing being tested is which way the failure falls.
  const r = await rig({ approvers: ["u:alice"] });
  const broken: CallbackEngine = {
    projection: (id) => r.h.engine.projection(id),
    openGates: () => Promise.reject(new Error("read model unavailable")),
    resolveGate: () => Promise.reject(new Error("must not be reached")),
  };
  const router = new GateCallbackRouter({
    dispatcher: new GateDispatcher({ channels: [r.channel] }),
    engine: broken,
    logFor: (id) => new RunLog(id, { store: r.h.store, bus: r.h.bus }),
    now: () => NOW,
  });

  const body = approval(r);
  const ts = String(Math.floor(NOW / 1000));
  await assert.rejects(() =>
    router.handle({
      channel: "slack",
      runId: r.runId,
      body: Buffer.from(body),
      headers: { "x-loom-timestamp": ts, "x-loom-signature": r.channel.sign(body, ts) },
    }),
  );
  await stillOpen(r);
  assert.deepEqual(rejections(await r.events()), [{ channel: "slack", reason: "internal", gateId: r.gateId }]);
});

test("…and the approver on the list gets through", async () => {
  const r = await rig({ approvers: ["u:alice", "u:bob"] });
  await r.post(approval(r, "u:bob"));
  const decided = (await r.events()).find((e) => e.type === "gate.decided");
  assert.equal((decided?.actor as { subject: string }).subject, "u:bob");
  assert.equal(r.h.writes.length, 1);
});

test("A CHANNEL CANNOT FORGE A SYSTEM APPROVAL", async () => {
  // The router's runtime check that a channel returned a HUMAN had no test at all, and a
  // guard nobody tests is a guard somebody deletes. What it buys, stated accurately:
  //
  //   - `approvers.includes(parsed.actor.subject)` reads `subject`, which a `system` actor
  //     can carry as an extra property — so the router's own approvers check PASSES, and
  //     on a gate that names NO approvers it is skipped altogether;
  //   - the refusal is typed, reasoned and JOURNALED here, at the boundary that saw it;
  //   - `CallbackEngine` is three methods, so nothing about this router's behaviour may
  //     depend on which object was injected behind it.
  //
  // What it does NOT buy on the default wiring is the last hop: `Engine.resolveGate`
  // refuses a non-human actor at its own door unless the engine holds a replay store —
  // pinned by the test below. The two together are the reason this one asserts the code
  // and the ROW, not merely that nothing was decided.
  const r = await rig({ approvers: ["u:alice"] });
  const forger: DeliveryChannel = {
    name: "forger",
    deliver: () => Promise.resolve("x"),
    parseCallback: () =>
      Promise.resolve({
        runId: r.runId,
        gateId: r.gateId,
        decision: { kind: "approve" },
        actor: { kind: "system", component: "replay", subject: "u:alice" },
        idempotencyKey: "forged-1",
      } as unknown as CallbackDecision),
  };
  const router = new GateCallbackRouter({
    dispatcher: new GateDispatcher({ channels: [forger] }),
    engine: r.h.engine as unknown as CallbackEngine,
    logFor: (id) => new RunLog(id, { store: r.h.store, bus: r.h.bus }),
    now: () => NOW,
  });

  await assert.rejects(
    () => router.handle({ channel: "forger", runId: r.runId, body: Buffer.from("{}"), headers: {} }),
    (e: unknown) => {
      assert.ok(isLoomError(e));
      assert.equal(e.code, CODES.E_GATE_NOT_AUTHORIZED);
      assert.equal(e.message, "a callback must name the human it speaks for");
      return true;
    },
  );

  await stillOpen(r);
  const seq = await r.events();
  assert.equal(seq.some((e) => e.type === "gate.decided"), false, "no decision, forged or otherwise");
  assert.deepEqual(rejections(seq), [{ channel: "forger", reason: "not_authorized", gateId: r.gateId }]);
});

test("…and the engine's own door refuses one too — the guard is the FIRST line, not the only one", async () => {
  // What the comment above the router's guard used to claim could not be reproduced: with
  // the guard deleted, a `{kind: "system", component: "replay"}` actor does NOT reach
  // `isAuthorizedActor`'s allow-list, because `Engine.resolveGate` refuses a non-human
  // actor at the door unless the engine was built with a replay store. This pins the
  // second line so the comment on the first can say what is true.
  const r = await rig({ approvers: ["u:alice"] });
  await refuses(
    () =>
      r.h.engine.resolveGate(r.runId, {
        gateId: r.gateId,
        decision: { kind: "approve" },
        actor: { kind: "system", component: "replay" },
        idempotencyKey: "forged-2",
      }),
    CODES.E_GATE_NOT_AUTHORIZED,
  );
  await stillOpen(r);
});

test("…and a callback naming an EMPTY human is refused before `resolve` records one", async () => {
  // The other half of the same guard, on a gate that lists no approvers — so nothing
  // downstream would have questioned it. `gate.decided` with `subject: ""` is a decision
  // nobody can be asked about, which is the whole value of the audit trail.
  const r = await rig();
  const anonymous: DeliveryChannel = {
    name: "anonymous",
    deliver: () => Promise.resolve("x"),
    parseCallback: () =>
      Promise.resolve({
        runId: r.runId,
        gateId: r.gateId,
        decision: { kind: "approve" },
        actor: { kind: "human", subject: "", via: "api" },
        idempotencyKey: "anon-1",
      } satisfies CallbackDecision),
  };
  const router = new GateCallbackRouter({
    dispatcher: new GateDispatcher({ channels: [anonymous] }),
    engine: r.h.engine as unknown as CallbackEngine,
    logFor: (id) => new RunLog(id, { store: r.h.store, bus: r.h.bus }),
    now: () => NOW,
  });

  await assert.rejects(
    () => router.handle({ channel: "anonymous", runId: r.runId, body: Buffer.from("{}"), headers: {} }),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_GATE_NOT_AUTHORIZED,
  );
  await stillOpen(r);
  assert.equal(r.h.writes.length, 0);
});

// ── lookup failures ──────────────────────────────────────────────────────────

test("an unknown gate is a 404-class refusal on a run that really exists", async () => {
  const r = await rig();
  const body = JSON.stringify({ runId: r.runId, gateId: "gate_NOPE", actor: "u:alice", decision: { kind: "approve" } });
  await refuses(() => r.post(body), CODES.E_GATE_NOT_FOUND);
  await stillOpen(r);
  assert.deepEqual(rejections(await r.events()), [{ channel: "slack", reason: "not_found", gateId: "gate_NOPE" }]);
});

test("A RUN THAT EXISTS BUT HAS RAISED NO GATE IS NOT ADMITTED", async () => {
  // The branch the old version of this test did not reach: it posted at a runId with no
  // journal at all, so `foldRun([])` returned undefined and the run-not-found arm
  // short-circuited — the open-gate condition could be deleted outright and the test
  // still passed. This run is real, is mid-flight, and has raised nothing to answer.
  const r = await rig();
  const bare = await r.h.engine.submit({
    graph: compileSkeleton(),
    inputs: { paths: DOCS },
    workflow: "skeleton-summarize",
  });
  const p = await r.h.engine.projection(bare);
  assert.ok(p !== undefined && Object.keys(p.gates).length === 0, "a real run, with no gate on it");
  const before: JournalEvent[] = [];
  for await (const e of r.h.store.read(bare, 1)) before.push(e);

  // Correctly signed AND correctly addressed to this run, so every check up to the gate
  // lookup passes: the only thing wrong is that there is no gate here to answer. That is
  // a `not_found`, and a `not_found` is a rejection this WOULD journal if admitted.
  const body = JSON.stringify({ runId: bare, gateId: r.gateId, actor: "u:alice", decision: { kind: "approve" } });
  await assert.rejects(
    () => r.post(body, { runId: bare }),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_GATE_NOT_FOUND,
  );

  const after: JournalEvent[] = [];
  for await (const e of r.h.store.read(bare, 1)) after.push(e);
  assert.equal(after.length, before.length, "a gateless run cannot be made to grow by posting at it");
  assert.deepEqual(rejections(after), []);
});

test("A CANCELLED RUN WITH AN OPEN GATE IS NOT ADMITTED — the status half of the check", async () => {
  // The other half of admission, pinned on its own. `!isTerminal(status)` and
  // `openGates(p).length > 0` look like one condition with a redundant clause, and the
  // suite passed with the status clause deleted. Drop `!isTerminal` and this address
  // becomes a permanently writable one again: 20 posts, 20 rows, on a run that ended.
  //
  // Building the trap takes a hand-written journal now, and that is the point rather than
  // an inconvenience. `engine.cancel` used to leave the gate RECORD open, which made it a
  // one-line way to reach this state; it now appends `gate.cancelled` beside
  // `run.cancelled`, so the pair can no longer diverge through that door. What remains
  // reachable is a journal written before that fix, and a `run.failed` from gate expiry,
  // which deliberately does not close its siblings. Both look exactly like this: terminal
  // status, gate record still open. So the clause guards a shape the system can still be
  // in, and this test writes that shape directly instead of relying on a producer of it.
  const r = await rig();
  await new RunLog(r.runId, { store: r.h.store, bus: r.h.bus }).append([
    {
      type: "run.cancelled",
      payload: { clean: true, unknownEffects: [], forced: false },
      actor: SYSTEM_ACTOR("operator"),
    },
  ]);
  const p = await r.h.engine.projection(r.runId);
  assert.equal(p?.status, "cancelled", "terminal");
  assert.equal(openGates(p!).length, 1, "…and yet the gate record is still open, which is the trap");

  const before = (await r.events()).length;
  // Signed by the secret holder and then malformed — it names no approver — so the
  // perimeter passes and ONLY admission stands between it and a durable row.
  const body = JSON.stringify({ runId: r.runId, gateId: r.gateId, decision: { kind: "approve" } });
  for (let i = 0; i < 20; i++) await refuses(() => r.post(body), CODES.E_PROVIDER_BAD_REQUEST);

  const seq = await r.events();
  assert.equal(seq.length, before, "20 signed callbacks at a cancelled run, zero rows");
  assert.deepEqual(rejections(seq), []);
  // Not journaled is not the same as not observed.
  assert.deepEqual(r.router.refusals(), [{ channel: "slack", reason: "malformed", count: 20 }]);
});

test("…and a runId with no journal at all conjures nothing", async () => {
  const r = await rig();
  await assert.rejects(
    () => r.post(approval(r), { runId: "01JNOSUCHRUN0000000000000" as RunId }),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_GATE_NOT_FOUND,
  );
  const events: JournalEvent[] = [];
  for await (const e of r.h.store.read("01JNOSUCHRUN0000000000000" as RunId, 1)) events.push(e);
  assert.deepEqual(events, [], "no run was conjured into existence by posting at it");
});

test("a signed callback for a DIFFERENT run than it was posted to is refused", async () => {
  const a = await rig();
  const b = await rig();
  // Legitimately signed for run A, replayed against run B's address.
  const body = approval(a);
  const ts = String(Math.floor(NOW / 1000));
  await assert.rejects(
    () =>
      b.router.handle({
        channel: "slack",
        runId: b.runId,
        body: Buffer.from(body),
        headers: { "x-loom-timestamp": ts, "x-loom-signature": b.channel.sign(body, ts) },
      }),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_PROVIDER_BAD_REQUEST,
  );
  await stillOpen(b);
  assert.deepEqual(rejections(await b.events()), [{ channel: "slack", reason: "run_mismatch", gateId: a.gateId }]);
  assert.deepEqual(rejections(await a.events()), [], "and run A learned nothing about it");
});

test("an unknown channel name is refused WITHOUT journaling, and without echoing the name", async () => {
  const r = await rig();
  await assert.rejects(
    () => r.post(approval(r), { channel: "<script>alert(1)</script>" }),
    (e: unknown) => {
      assert.ok(isLoomError(e));
      assert.equal(e.code, CODES.E_GATE_NOT_FOUND);
      assert.equal(/script/.test(e.message), false, "the caller's bytes never reach the message");
      return true;
    },
  );
  assert.deepEqual(rejections(await r.events()), [], "no gate to attribute it to, so no durable row");
});

test("a channel with no inbound path cannot be used as one", async () => {
  const r = await rig();
  await refuses(() => r.post(approval(r), { channel: "console" }), CODES.E_GATE_NOT_FOUND);
  await stillOpen(r);
});

// ── malformed, but validly signed ────────────────────────────────────────────

test("a signed body that is not JSON is a 400, not a 403", async () => {
  // A real integration bug in a service that HOLDS the secret. Answering 403 would send
  // its author hunting for a key problem they do not have.
  const r = await rig();
  await refuses(() => r.post("{not json"), CODES.E_PROVIDER_BAD_REQUEST);
  await stillOpen(r);
});

test("an unknown decision kind is refused rather than defaulted", async () => {
  const r = await rig();
  const body = JSON.stringify({ runId: r.runId, gateId: r.gateId, actor: "u:alice", decision: { kind: "yolo" } });
  await refuses(() => r.post(body), CODES.E_PROVIDER_BAD_REQUEST);
  await stillOpen(r);
});

test("a rejection with no reason is refused, because the journal would say nothing", async () => {
  const r = await rig();
  const body = JSON.stringify({ runId: r.runId, gateId: r.gateId, actor: "u:alice", decision: { kind: "reject", reason: "   " } });
  await refuses(() => r.post(body), CODES.E_PROVIDER_BAD_REQUEST);
  await stillOpen(r);
});

test("AN EDIT WHOSE WRITE-SET IS NOT A RECORD IS REFUSED, NOT RECORDED AS AN EDIT THAT WROTE NOTHING", async () => {
  // The third site in this file to ask a shape question of a `ownedJson` RESULT instead of
  // its INPUT, and the only one of the three whose answer decides a gate. `ownedJson`
  // reports `{}` for every object whose data is not in own properties, so
  // `typeof writes === "object" && !Array.isArray(writes)` said yes to a `Map` of edits —
  // and the decision was recorded as an `edit` that edited nothing, on a gate a human had
  // just been asked to edit. `take`, four lines below it, asks the same question of the
  // same result and fails CLOSED, because `{}` does not look like an array; `writes` is the
  // one field where the degraded copy is indistinguishable from a legitimate answer.
  //
  // A refusal is the recoverable direction: the caller is told `malformed`, the gate stays
  // open and can be answered again. A decision cannot be un-made.
  const editor = (r: Rig, writes: unknown): DeliveryChannel => ({
    name: "editor",
    deliver: () => Promise.resolve("x"),
    parseCallback: () =>
      Promise.resolve({
        runId: r.runId,
        gateId: r.gateId,
        decision: { kind: "edit", writes } as unknown as GateDecision,
        actor: { kind: "human", subject: "u:alice", via: "api" },
        idempotencyKey: "k",
      } as CallbackDecision),
  });
  const post = (r: Rig, writes: unknown): Promise<unknown> =>
    routerFor(r, [editor(r, writes)]).handle({ channel: "editor", runId: r.runId, body: Buffer.from("{}"), headers: {} });

  for (const [what, writes] of [
    ["a Map of edits", new Map([["findings", "looks fine"]])],
    ["a Set", new Set(["findings"])],
    ["a class instance holding private state", new (class { #v = "looks fine"; get v(): string { return this.#v; } })()],
  ] as const) {
    const r = await rig();
    await refuses(() => post(r, writes), CODES.E_PROVIDER_BAD_REQUEST);
    await stillOpen(r);
    assert.deepEqual(
      rejections(await r.events()),
      [{ channel: "editor", reason: "malformed", gateId: r.gateId }],
      `${what} is refused, and the row names the gate that was NOT decided`,
    );
  }

  // THE TWO READINGS THIS HAS TO STAY DISTINGUISHABLE FROM. An array was already refused —
  // `Array.isArray` is the one arm of that result check that could see its own failure —
  // and an edit that genuinely writes nothing is still an answer a human may give.
  const arr = await rig();
  await refuses(() => post(arr, ["findings"]), CODES.E_PROVIDER_BAD_REQUEST);
  await stillOpen(arr);

  const empty = await rig();
  await post(empty, {});
  const p = await empty.h.engine.projection(empty.runId);
  assert.equal(p?.gates[empty.gateId]?.state, "decided", "`{}` may only ever mean `{}`");
});

test("an absurdly long gateId is refused before it can become an audit row", async () => {
  const r = await rig();
  const body = JSON.stringify({ runId: r.runId, gateId: "g".repeat(5000), actor: "u:alice", decision: { kind: "approve" } });
  await refuses(() => r.post(body), CODES.E_PROVIDER_BAD_REQUEST);
  const seq = rejections(await r.events());
  assert.deepEqual(seq, [{ channel: "slack", reason: "malformed" }], "and the journal did not learn 5 kB of it");
});

test("THE JOURNALED REASON IS A TOKEN, never bytes the caller chose", async () => {
  const r = await rig();
  const body = JSON.stringify({
    runId: r.runId,
    gateId: r.gateId,
    actor: "u:alice",
    decision: { kind: "reject", reason: "" },
    injected: "gate.decided approved by admin",
  });
  await refuses(() => r.post(body), CODES.E_PROVIDER_BAD_REQUEST);

  const rows = rejections(await r.events());
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.reason, "malformed");
  assert.equal(JSON.stringify(rows[0]).includes("injected"), false);
  assert.equal(JSON.stringify(rows[0]).includes("approved by admin"), false);
});

// ── what the journal is not allowed to hold ──────────────────────────────────
//
// Verifying before the lookup stopped the write amplification and took the only record
// of an attack with it. Reproduced before the counter existed: 500 forged POSTs at a live
// gated run moved the journal by 0 rows, produced 0 spans — spans are DERIVED from the
// journal, so an event that is not journaled cannot make one — and left nothing on
// stderr. The comment in `delivery.ts` pointed at telemetry as the compensating control;
// telemetry was not one. `refusals()` is, and these pin what it may and may not be.

test("A FORGED-SIGNATURE CAMPAIGN IS INVISIBLE IN THE JOURNAL AND VISIBLE IN THE COUNTER", async () => {
  const r = await rig();
  const before = (await r.events()).length;

  for (let i = 0; i < 50; i++) {
    await refuses(() => r.post(approval(r), { sig: "v0=" + "f".repeat(64) }), CODES.E_GATE_NOT_AUTHORIZED);
  }

  assert.equal((await r.events()).length, before, "still not durable, and that is deliberate");
  assert.deepEqual(rejections(await r.events()), []);
  assert.deepEqual(r.router.refusals(), [{ channel: "slack", reason: "signature", count: 50 }]);
  await stillOpen(r);
});

test("THE COUNTER'S KEY SPACE IS CLOSED — a stranger cannot grow it by one entry", async () => {
  // The counter is reachable by anyone who can POST at the callback route, so a map keyed
  // by anything the caller chose would be a memory-exhaustion vector on an unauthenticated
  // endpoint: 10 million distinct channel names, 10 million entries. The channel key is
  // either a name the dispatcher was CONFIGURED with or one literal, and nothing else.
  const r = await rig();
  for (let i = 0; i < 100; i++) {
    await refuses(() => r.post(approval(r), { channel: `chan-${i}` }), CODES.E_GATE_NOT_FOUND);
  }
  assert.deepEqual(
    r.router.refusals(),
    [{ channel: "(unknown)", reason: "unknown_channel", count: 100 }],
    "one entry, whatever the caller called it — and the name it chose is not in there",
  );
  assert.equal(JSON.stringify(r.router.refusals()).includes("chan-"), false);
});

test("A CHANNEL THAT THROWS BEFORE VERIFYING CANNOT GROW THE JOURNAL EITHER", async () => {
  // The write amplification, reopened by an injected channel. The journaled rejection row
  // is justified by "the caller demonstrably used the channel's secret" — and that
  // justification is the CHANNEL'S report, not something the router observed. A channel
  // whose `parseCallback` throws before it looks at a signature has reported nothing, so
  // an unauthenticated stranger with no timestamp and no signature used to buy one durable
  // row per POST on a live gated run. Channels are injected by design and the router
  // already treats them as untrusted elsewhere ("a channel is injected code outside this
  // module"), so this is a configuration, not a hypothetical.
  const r = await rig();
  const blowsUp: DeliveryChannel = {
    name: "buggy",
    deliver: () => Promise.resolve("x"),
    // Synchronous, and BEFORE any signature check — the shape of a real integration bug.
    parseCallback: () => {
      throw new Error("channel bug, no signature checked");
    },
  };
  // The same bug, throwing a value the error taxonomy's own normalizer cannot print:
  // `toLoomError` builds its message with `String(e)`. Without a total normalizer here the
  // refusal escapes as a bare TypeError and lands in NEITHER sink.
  const unprintable: DeliveryChannel = {
    name: "unprintable",
    deliver: () => Promise.resolve("x"),
    parseCallback: () => Promise.reject(Object.create(null) as Error),
  };
  const router = new GateCallbackRouter({
    dispatcher: new GateDispatcher({ channels: [blowsUp, unprintable] }),
    engine: r.h.engine as unknown as CallbackEngine,
    logFor: (id) => new RunLog(id, { store: r.h.store, bus: r.h.bus }),
    now: () => NOW,
  });

  const before = (await r.events()).length;
  for (const name of ["buggy", "unprintable"]) {
    for (let i = 0; i < 100; i++) {
      await assert.rejects(
        () => router.handle({ channel: name, runId: r.runId, body: Buffer.from("{}"), headers: {} }),
        (e: unknown) => isLoomError(e), // typed, even for a value that cannot be stringified
      );
    }
  }

  assert.equal((await r.events()).length, before, "200 unauthenticated POSTs, zero durable rows");
  assert.deepEqual(rejections(await r.events()), []);
  // Counted instead: the refusal is still not silent, it is just not durable.
  assert.deepEqual(router.refusals(), [
    { channel: "buggy", reason: "internal", count: 100 },
    { channel: "unprintable", reason: "internal", count: 100 },
  ]);
  await stillOpen(r);
});

test("A CHANNEL THAT RETURNS WITHOUT VERIFYING CANNOT GROW THE JOURNAL WITHOUT BOUND", async () => {
  // The other half of the same amplification, and the more common one: adding `internal`
  // to `PERIMETER_REJECTIONS` bounds a channel that THROWS before verifying, but a channel
  // that RETURNS without verifying looks like success and is journaled on the channel's
  // word alone. That is the shape a real integration bug takes — a `parseCallback` that
  // parses the body and forgets the MAC — and it bought an unauthenticated stranger one
  // durable row per POST on a live gated run, forever.
  //
  // The router cannot check the claim: "the signature verified" is the channel's report.
  // So the bound goes where invariant 8 says backpressure goes — on ADMISSION.
  const r = await rig({ approvers: ["u:alice"] });
  const gullible: DeliveryChannel = {
    name: "gullible",
    deliver: () => Promise.resolve("x"),
    // No timestamp, no signature, no secret: a decision for any bytes at all.
    parseCallback: () =>
      Promise.resolve({
        runId: r.runId,
        gateId: r.gateId,
        decision: { kind: "approve" },
        actor: { kind: "human", subject: "u:mallory", via: "api" },
        idempotencyKey: "k",
      } satisfies CallbackDecision),
  };
  const router = new GateCallbackRouter({
    dispatcher: new GateDispatcher({ channels: [gullible] }),
    engine: r.h.engine as unknown as CallbackEngine,
    logFor: (id) => new RunLog(id, { store: r.h.store, bus: r.h.bus }),
    now: () => NOW,
  });

  for (let i = 0; i < 200; i++) {
    await assert.rejects(
      () => router.handle({ channel: "gullible", runId: r.runId, body: Buffer.from("{}"), headers: {} }),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_GATE_NOT_AUTHORIZED,
    );
  }

  const rows = rejections(await r.events());
  assert.ok(rows.length > 0, "the first refusals are still on the record — the bound is a cap, not a mute");
  assert.ok(rows.length <= 32, `${rows.length} durable rows from 200 unauthenticated POSTs`);
  assert.deepEqual(
    router.refusals(),
    [{ channel: "gullible", reason: "not_authorized", count: 200 - rows.length }],
    "and everything the cap withheld is still counted — nothing is refused silently",
  );
  await stillOpen(r);
});

test("A CHANNEL WHOSE `name` IS A GETTER CANNOT GROW THE COUNTER", async () => {
  // `#count(channel.name, reason)` re-read `name` off the injected channel on every call,
  // while the dispatcher's map was keyed by a SINGLE read at construction. The two reads
  // need not agree, so a non-constant getter turned an unauthenticated route into an
  // unbounded map — the exact memory-exhaustion vector the counter's docstring claims to
  // be safe from "BY CONSTRUCTION".
  const r = await rig();
  let reads = 0;
  const shifty: DeliveryChannel = {
    get name(): string {
      return `shifty-${reads++}`;
    },
    deliver: () => Promise.resolve("x"),
    parseCallback: () => Promise.reject(callbackRejection("signature", "callback signature does not verify")),
  };
  const router = new GateCallbackRouter({
    dispatcher: new GateDispatcher({ channels: [shifty] }),
    engine: r.h.engine as unknown as CallbackEngine,
    logFor: (id) => new RunLog(id, { store: r.h.store, bus: r.h.bus }),
    now: () => NOW,
  });

  // "shifty-0" is the key the dispatcher was configured under: the one read that counts.
  for (let i = 0; i < 100; i++) {
    await assert.rejects(() =>
      router.handle({ channel: "shifty-0", runId: r.runId, body: Buffer.from("{}"), headers: {} }),
    );
  }
  assert.deepEqual(
    router.refusals(),
    [{ channel: "shifty-0", reason: "signature", count: 100 }],
    "one entry, keyed by the name the dispatcher was configured with",
  );
});

test("…while an `internal` raised AFTER verification is still journaled", async () => {
  // The discriminator, stated as its own claim rather than left implicit in the test
  // above: the fix is about WHERE the failure came from, not about the token. The
  // approvers read model failing is an `internal` too — see "IF THE APPROVERS LIST CANNOT
  // BE READ" — and it is journaled, because by then `parseCallback` has returned and the
  // caller really did hold the secret. If both were counted, an unavailable read model on
  // a live gate would leave no audit trail at all.
  const r = await rig({ approvers: ["u:alice"] });
  const broken: CallbackEngine = {
    projection: (id) => r.h.engine.projection(id),
    openGates: () => Promise.reject(new Error("read model unavailable")),
    resolveGate: () => Promise.reject(new Error("must not be reached")),
  };
  const router = new GateCallbackRouter({
    dispatcher: new GateDispatcher({ channels: [r.channel] }),
    engine: broken,
    logFor: (id) => new RunLog(id, { store: r.h.store, bus: r.h.bus }),
    now: () => NOW,
  });

  const body = approval(r);
  const ts = String(Math.floor(NOW / 1000));
  await assert.rejects(() =>
    router.handle({
      channel: "slack",
      runId: r.runId,
      body: Buffer.from(body),
      headers: { "x-loom-timestamp": ts, "x-loom-signature": r.channel.sign(body, ts) },
    }),
  );
  assert.deepEqual(rejections(await r.events()), [{ channel: "slack", reason: "internal", gateId: r.gateId }]);
  assert.deepEqual(router.refusals(), [], "and it was NOT also counted");
});

test("the counter separates (channel, reason), because the two questions are different", async () => {
  const r = await rig();
  const stale = String(Math.floor((NOW - 86_400_000) / 1000));

  await refuses(() => r.post(approval(r), { sig: "v0=" + "0".repeat(64) }), CODES.E_GATE_NOT_AUTHORIZED);
  await refuses(() => r.post(approval(r), { sig: "v0=" + "1".repeat(64) }), CODES.E_GATE_NOT_AUTHORIZED);
  await refuses(() => r.post(approval(r), { ts: stale, sig: r.channel.sign(approval(r), stale) }), CODES.E_GATE_NOT_AUTHORIZED);
  await refuses(() => r.post(approval(r), { channel: "nope" }), CODES.E_GATE_NOT_FOUND);

  assert.deepEqual(r.router.refusals(), [
    { channel: "(unknown)", reason: "unknown_channel", count: 1 },
    { channel: "slack", reason: "signature", count: 2 },
    { channel: "slack", reason: "timestamp", count: 1 },
  ]);
});

test("EVERY REFUSAL LANDS SOMEWHERE — journaled or counted, never both, never neither", async () => {
  // The invariant the two sinks exist to satisfy, checked as one statement rather than
  // inferred from the cases above. A refusal that appears in neither is the hole this
  // whole section closes; one that appears in both would make the counter a partial
  // mirror of the audit trail, which is the thing somebody eventually reconciles against.
  const r = await rig({ approvers: ["u:alice"] });
  const attempts: (() => Promise<unknown>)[] = [
    // perimeter: no durable row is possible, the run may not even exist
    () => r.post(approval(r), { sig: "v0=" + "e".repeat(64) }),
    () => r.post(approval(r), { channel: "not-a-channel" }),
    // signed, then refused against a LIVE gate: durable
    () => r.post(JSON.stringify({ runId: r.runId, gateId: r.gateId, decision: { kind: "approve" } })),
    () => r.post(approval(r, "u:mallory")),
  ];

  for (const attempt of attempts) {
    const rowsBefore = rejections(await r.events()).length;
    const countBefore = r.router.refusals().reduce((n, x) => n + x.count, 0);
    // Each `attempt` refuses for its own reason, so the shared claim is that it is a REFUSAL.
    await assert.rejects(attempt, (e: unknown) => isLoomError(e));
    const rows = rejections(await r.events()).length - rowsBefore;
    const counted = r.router.refusals().reduce((n, x) => n + x.count, 0) - countBefore;
    assert.equal(rows + counted, 1, "exactly one sink took it");
  }
  await stillOpen(r);
});

test("a CONFLICTING decision after the run is over is counted, since it cannot be journaled", async () => {
  // The docstring used to say a signed-then-unauthorized callback goes "into THAT RUN'S
  // journal" with no qualifier, and this is the case where that was false: the winner has
  // already terminated the run, so admission withholds the row and a trusted secret holder
  // trying to overturn a decision left no trace. Journaling it unconditionally was the
  // other option and was rejected — see the JOURNAL entry — because it hands anyone
  // holding the shared secret a permanently writable address on every finished run.
  const r = await rig();
  await r.post(approval(r, "u:alice"));
  const before = (await r.events()).length;

  const body = JSON.stringify({ runId: r.runId, gateId: r.gateId, actor: "u:bob", decision: { kind: "reject", reason: "too late" } });
  await refuses(() => r.post(body), CODES.E_GATE_ALREADY_RESOLVED);

  assert.equal((await r.events()).length, before, "409, and the journal is unchanged");
  assert.deepEqual(r.router.refusals(), [{ channel: "slack", reason: "already_resolved", count: 1 }]);
});

test("the counter is a snapshot, not a handle on the live state", async () => {
  const r = await rig();
  await refuses(() => r.post(approval(r), { sig: "v0=" + "a".repeat(64) }), CODES.E_GATE_NOT_AUTHORIZED);
  const snapshot = r.router.refusals() as unknown as { count: number }[];
  snapshot[0]!.count = 9999;
  assert.deepEqual(r.router.refusals(), [{ channel: "slack", reason: "signature", count: 1 }]);
});

// ── the reader on the refusal path is not allowed to be the untyped exit ─────
//
// Three waves running, the thing that escaped `handle` untyped was a FORMATTER or a
// READER on the error path — the one place a throw costs both sinks at once, because the
// refusal is recorded on the way out.

/** A rejection a CHANNEL built, with the properties this module reads booby-trapped. */
function trapped(also: { readonly code?: true } = {}): LoomError {
  const e = callbackRejection("signature", "callback signature does not verify");
  Object.defineProperty(e, "details", {
    get(): unknown {
      throw new Error("details is a trap");
    },
    configurable: true,
  });
  if (also.code === true) {
    Object.defineProperty(e, "code", {
      get(): string {
        throw new Error("code is a trap");
      },
      configurable: true,
    });
  }
  return e;
}

function trapChannel(name: string, e: () => LoomError): DeliveryChannel {
  return { name, deliver: () => Promise.resolve("x"), parseCallback: () => Promise.reject(e()) };
}

test("AN ERROR WHOSE `details` CANNOT BE READ IS STILL REFUSED, AND STILL RECORDED", async () => {
  // `rejectionReasonOf` read `le.details` outside any try, and it is called from inside
  // `handle`'s catch and from `#refuse`. So a channel error with a throwing `details`
  // accessor made `handle` exit UNTYPED and put the refusal in NEITHER sink — breaking
  // the one-code contract and the module's own rule that nothing is refused silently.
  const r = await rig();
  const router = new GateCallbackRouter({
    dispatcher: new GateDispatcher({ channels: [trapChannel("trap", () => trapped())] }),
    engine: r.h.engine as unknown as CallbackEngine,
    logFor: (id) => new RunLog(id, { store: r.h.store, bus: r.h.bus }),
    now: () => NOW,
  });

  await assert.rejects(
    () => router.handle({ channel: "trap", runId: r.runId, body: Buffer.from("{}"), headers: {} }),
    (e: unknown) => isLoomError(e), // TYPED, even though the reader could not read it
  );

  // The token degrades — the closed set lives in `details`, which is exactly what could
  // not be read — but it degrades onto the code, not onto the floor.
  const rows = rejections(await r.events());
  const counted = router.refusals().reduce((n, x) => n + x.count, 0);
  assert.equal(rows.length + counted, 1, "exactly one sink took it");
  await stillOpen(r);
});

test("…and one whose `code` cannot be read either falls all the way to `internal`", async () => {
  // Nothing left to read means nothing the channel claimed can be trusted, which is the
  // `internal` case: a channel that blew up reported no verdict, so the refusal is
  // COUNTED and buys no durable row.
  const r = await rig();
  const router = new GateCallbackRouter({
    dispatcher: new GateDispatcher({ channels: [trapChannel("trap", () => trapped({ code: true }))] }),
    engine: r.h.engine as unknown as CallbackEngine,
    logFor: (id) => new RunLog(id, { store: r.h.store, bus: r.h.bus }),
    now: () => NOW,
  });

  const before = (await r.events()).length;
  for (let i = 0; i < 20; i++) {
    await assert.rejects(
      () => router.handle({ channel: "trap", runId: r.runId, body: Buffer.from("{}"), headers: {} }),
      (e: unknown) => isLoomError(e),
    );
  }
  assert.equal((await r.events()).length, before, "20 unauthenticated POSTs, zero durable rows");
  assert.deepEqual(router.refusals(), [{ channel: "trap", reason: "internal", count: 20 }]);
  await stillOpen(r);
});

// ── the gate id on a refusal row is a value from outside ─────────────────────

/** A channel that verifies nothing and names whatever gate it likes. */
function namesGate(gateId: unknown, runId: RunId): DeliveryChannel {
  return {
    name: "namer",
    deliver: () => Promise.resolve("x"),
    parseCallback: () =>
      Promise.resolve({
        runId,
        gateId,
        decision: { kind: "approve" },
        actor: { kind: "human", subject: "u:mallory", via: "api" },
        idempotencyKey: "k",
      } as unknown as CallbackDecision),
  };
}

function namerRouter(r: Rig, gateId: unknown): GateCallbackRouter {
  return new GateCallbackRouter({
    dispatcher: new GateDispatcher({ channels: [namesGate(gateId, r.runId)] }),
    engine: r.h.engine as unknown as CallbackEngine,
    logFor: (id) => new RunLog(id, { store: r.h.store, bus: r.h.bus }),
    now: () => NOW,
  });
}

test("A GATE ID A CHANNEL NAMED IS BOUNDED BEFORE IT REACHES THE JOURNAL", async () => {
  // `SignedWebhookChannel` bounds its own (`boundedId`), but `parseCallback` is an
  // INTERFACE — every other field on `gate.callback_rejected` is bounded by construction
  // (`channel` is a configured key, `reason` is a closed set) and this one was not.
  const r = await rig();
  const router = namerRouter(r, "g".repeat(5000));

  await assert.rejects(() =>
    router.handle({ channel: "namer", runId: r.runId, body: Buffer.from("{}"), headers: {} }),
  );

  const rows = rejections(await r.events());
  assert.equal(rows.length, 1);
  const gateId = rows[0]!.gateId ?? "";
  assert.ok(gateId.length <= 128, `the journal learned ${gateId.length} characters of somebody else's id`);
  await stillOpen(r);
});

test("…and one that is not a string at all does not take the whole refusal with it", async () => {
  // The bound is not the only thing missing: journaling the value verbatim made
  // `canonicalize` throw INSIDE `#refuse`, so `handle` exited untyped, the row was never
  // written, and the counter never ran either.
  const r = await rig();
  const router = namerRouter(r, () => "not an id");

  await assert.rejects(
    () => router.handle({ channel: "namer", runId: r.runId, body: Buffer.from("{}"), headers: {} }),
    (e: unknown) => isLoomError(e),
  );

  const rows = rejections(await r.events());
  const counted = router.refusals().reduce((n, x) => n + x.count, 0);
  assert.equal(rows.length + counted, 1, "exactly one sink took it");
  assert.equal(rows[0]?.gateId, "(unknown)", "…and the row says the id was unusable rather than quoting it");
  await stillOpen(r);
});

// ── ONE BOUNDARY: nothing from injected code is ever read bare ───────────────
//
// Four waves running, the untyped exit was a read of an injected value on an error path,
// and each was fixed one property over from the last. The property these pin is not "this
// getter is guarded" but "a value that came out of a channel is converted, at one place,
// into a value this module built — and everything downstream reads the owned copy".
//
// Three shapes of "the object you were handed is not the object you assumed" are the same
// bug: a getter that throws, a value that is not the type it claims, and a name that
// resolves through a prototype.

/** Every property of a `CallbackDecision`, one booby-trap at a time. */
const TRAPPED_FIELDS = [
  "runId",
  "gateId",
  "decision",
  "actor",
  "idempotencyKey",
  "actor.kind",
  "actor.subject",
  "decision.kind",
] as const;

function trapField(r: Rig, path: (typeof TRAPPED_FIELDS)[number]): DeliveryChannel {
  const trap = (what: string): PropertyDescriptor => ({
    get(): never {
      throw new Error(`${what} is a trap`);
    },
    configurable: true,
    enumerable: true,
  });
  const actor: Record<string, unknown> = { kind: "human", subject: "u:alice", via: "api" };
  const decision: Record<string, unknown> = { kind: "approve" };
  const call: Record<string, unknown> = { runId: r.runId, gateId: r.gateId, decision, actor, idempotencyKey: "k" };
  const [head, tail] = path.split(".") as [string, string | undefined];
  Object.defineProperty(tail === undefined ? call : head === "actor" ? actor : decision, tail ?? head, trap(path));
  return {
    name: "trapfield",
    deliver: () => Promise.resolve("x"),
    parseCallback: () => Promise.resolve(call as unknown as CallbackDecision),
  };
}

function routerFor(r: Rig, channels: readonly DeliveryChannel[]): GateCallbackRouter {
  return new GateCallbackRouter({
    dispatcher: new GateDispatcher({ channels }),
    engine: r.h.engine as unknown as CallbackEngine,
    logFor: (id) => new RunLog(id, { store: r.h.store, bus: r.h.bus }),
    now: () => NOW,
  });
}

/** The refusal, proved to be OURS: every read the error boundary makes is total. */
function ownedRefusal(e: unknown): LoomError {
  assert.ok(isLoomError(e), `expected a LoomError, got ${String(e)}`);
  // The three readers downstream of `handle`, in the order a request meets them. Each one
  // reads a property of the error BARE, because the taxonomy's own objects are ours: so
  // handing back a channel's object relocates the throw one layer out instead of removing
  // it. `toJSON` is `send`'s payload, `httpStatusFor` is its status, `errorRecord` is what
  // a journal row would carry.
  assert.doesNotThrow(() => JSON.stringify(e.toJSON()), "toJSON read a property it did not own");
  assert.doesNotThrow(() => httpStatusFor(e), "httpStatusFor read a class it did not own");
  assert.doesNotThrow(() => JSON.stringify(errorRecord(e)), "errorRecord read a property it did not own");
  return e;
}

test("AN ERROR A CHANNEL BUILT DOES NOT ESCAPE AS THE CHANNEL'S OWN OBJECT", async () => {
  // `toLoomError` returns `e` unchanged when `isLoomError(e)` — and `isLoomError` is an
  // `instanceof`, which proves the prototype and nothing about provenance. So the
  // booby-trapped accessor `readProp` was added to survive left `handle` INSIDE the
  // error, and the HTTP error path detonated it one layer out: `send(res,
  // httpStatusFor(le), { error: le.toJSON() })`, and `toJSON` reads `this.details`.
  const r = await rig();
  const router = routerFor(r, [trapChannel("trap", () => trapped())]);

  const e = await router
    .handle({ channel: "trap", runId: r.runId, body: Buffer.from("{}"), headers: {} })
    .then(() => undefined, (thrown: unknown) => thrown);

  const owned = ownedRefusal(e);
  assert.equal(owned.code, CODES.E_GATE_NOT_AUTHORIZED, "the channel's own verdict still survives the copy");
  await stillOpen(r);
});

test("…including one whose `class` is a trap, which is what decides the status code", async () => {
  const r = await rig();
  const router = routerFor(r, [
    trapChannel("trap", () => {
      const e = callbackRejection("signature", "callback signature does not verify");
      Object.defineProperty(e, "class", {
        get(): never {
          throw new Error("class is a trap");
        },
        configurable: true,
      });
      return e;
    }),
  ]);

  const e = await router
    .handle({ channel: "trap", runId: r.runId, body: Buffer.from("{}"), headers: {} })
    .then(() => undefined, (thrown: unknown) => thrown);
  ownedRefusal(e);
  await stillOpen(r);
});

test("EVERY PROPERTY OF A PARSED DECISION IS READ TOTALLY, not just the two that were found", async () => {
  // `parsed.gateId` was brought inside the boundary last wave; `parsed.runId` and
  // `parsed.actor` were left bare, outside any try, one property over — and a throwing
  // getter on either made `handle` exit UNTYPED with the refusal in NEITHER sink. That is
  // the same failure this programme has now closed three times, so the assertion is over
  // the whole shape rather than over the two properties somebody noticed.
  const r = await rig();
  for (const field of TRAPPED_FIELDS) {
    const router = routerFor(r, [trapField(r, field)]);
    const rowsBefore = rejections(await r.events()).length;

    const e = await router
      .handle({ channel: "trapfield", runId: r.runId, body: Buffer.from("{}"), headers: {} })
      .then(() => undefined, (thrown: unknown) => thrown);

    ownedRefusal(e);
    const rows = rejections(await r.events()).length - rowsBefore;
    const counted = router.refusals().reduce((n, x) => n + x.count, 0);
    assert.equal(rows + counted, 1, `${field}: exactly one sink took it`);
    await stillOpen(r);
  }
});

test("A GATE ID THAT NAMES A PROTOTYPE IS NOT A GATE", async () => {
  // `safeGateId` lets `__proto__` through, correctly — it IS a plausible string. What is
  // not plausible is what happens next: `HumanGateBroker.resolve` looks the id up with a
  // bare index on a prototype-bearing object, so `p.gates["__proto__"]` answers with
  // `Object.prototype`. A gate that was never raised then reads as one that exists and is
  // not open, which is a durable audit row asserting `already_resolved` about nothing, and
  // a 409 telling the caller its decision lost a race that never happened.
  const r = await rig();
  for (const name of ["__proto__", "constructor", "toString"]) {
    const router = namerRouter(r, name);
    const rowsBefore = rejections(await r.events()).length;

    const e = await router
      .handle({ channel: "namer", runId: r.runId, body: Buffer.from("{}"), headers: {} })
      .then(() => undefined, (thrown: unknown) => thrown);

    const owned = ownedRefusal(e);
    assert.equal(owned.code, CODES.E_GATE_NOT_FOUND, `${name}: a gate nobody raised is NOT FOUND, never a conflict`);
    const rows = rejections(await r.events()).slice(rowsBefore);
    assert.deepEqual(
      rows,
      [{ channel: "namer", reason: "not_found", gateId: "(unknown)" }],
      `${name}: and the row does not assert a lifecycle the gate never had`,
    );
    await stillOpen(r);
  }
});

test("A CHANNEL THAT WILL NOT HAND OVER ITS PARSER IS NOT AN UNTYPED EXIT EITHER", async () => {
  // `channel.parseCallback` is itself a property read on injected code, and it sat above
  // every try in `handle` — so the FIRST thing the router touches on the untrusted object
  // was the one read nothing guarded.
  const r = await rig();
  const router = routerFor(r, [
    {
      name: "surly",
      deliver: () => Promise.resolve("x"),
      get parseCallback(): never {
        throw new Error("reading the parser is a trap");
      },
    } as unknown as DeliveryChannel,
  ]);

  const before = (await r.events()).length;
  for (let i = 0; i < 10; i++) {
    const e = await router
      .handle({ channel: "surly", runId: r.runId, body: Buffer.from("{}"), headers: {} })
      .then(() => undefined, (thrown: unknown) => thrown);
    ownedRefusal(e);
  }
  assert.equal((await r.events()).length, before, "a channel that blew up before verifying buys no durable row");
  assert.deepEqual(router.refusals(), [{ channel: "surly", reason: "internal", count: 10 }]);
  await stillOpen(r);
});

test("A CHANNEL THAT WILL NOT SAY WHAT IT IS CALLED IS A CONFIGURATION ERROR", async () => {
  // The dispatcher's map is keyed by ONE read of each `name`, at construction — that read
  // IS the boundary for the name, and it was the one crossing with no try around it. A
  // channel that cannot be named cannot be routed to, cannot key a counter, and cannot be
  // looked up: refusing at startup is the only answer that is not a silent hole.
  const hostile = {
    get name(): string {
      throw new Error("name is a trap");
    },
    deliver: () => Promise.resolve("x"),
  } as unknown as DeliveryChannel;
  assert.throws(
    () => new GateDispatcher({ channels: [hostile] }),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID,
  );
  assert.throws(
    () => new GateDispatcher({ channels: [{ name: 7 as unknown as string, deliver: () => Promise.resolve("x") }] }),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID,
    "a name that is not a string is a key nothing can ever match",
  );
});

test("A VENDOR HOOK THAT ANSWERS WITH THE WRONG TYPE IS REFUSED BY THE CHANNEL ITSELF", async () => {
  // `subjectOf` and `decisionOf` are the last injected code on this path, and the easiest
  // to forget because they read as configuration. `subjectOf` returning Slack's `{id}`
  // OBJECT rather than the id inside it type-checks at the call site and slips through
  // `subject.length > MAX_ID` — a non-string has no length — so `parseCallback` used to
  // resolve a decision naming an object as its human.
  const r = await rig();
  const body = approval(r);
  const ts = String(Math.floor(NOW / 1000));
  const req = (c: SignedWebhookChannel): Parameters<SignedWebhookChannel["parseCallback"]>[0] => ({
    body: Buffer.from(body),
    headers: { "x-loom-timestamp": ts, "x-loom-signature": c.sign(body, ts) },
    now: NOW,
  });

  const wrongSubject = new SignedWebhookChannel({
    url: "https://x",
    callbackSecret: SECRET,
    subjectOf: () => ({ id: "u:alice" }) as unknown as string,
  });
  await refuses(() => wrongSubject.parseCallback(req(wrongSubject)), CODES.E_PROVIDER_BAD_REQUEST);

  const wrongDecision = new SignedWebhookChannel({
    url: "https://x",
    callbackSecret: SECRET,
    decisionOf: () => ({ kind: "annihilate" }) as unknown as GateDecision,
  });
  await refuses(() => wrongDecision.parseCallback(req(wrongDecision)), CODES.E_PROVIDER_BAD_REQUEST);

  // …and a hook that answers correctly still gets through, unchanged.
  const fine = new SignedWebhookChannel({
    url: "https://x",
    callbackSecret: SECRET,
    subjectOf: () => "u:carol",
    decisionOf: () => ({ kind: "reject", reason: "not today" }),
  });
  const out = await fine.parseCallback(req(fine));
  assert.equal(out.actor.subject, "u:carol");
  assert.deepEqual(out.decision, { kind: "reject", reason: "not today" });
});

test("A HOSTILE ENGINE BEHIND THE ROUTER IS STILL A TYPED REFUSAL", async () => {
  // `CallbackEngine` is an injected interface too, and `projection()` — the admission
  // lookup — was awaited outside every try. A rejection there left `handle` untyped with
  // the attempt in neither sink, on the one route a stranger can reach.
  const r = await rig();
  const router = new GateCallbackRouter({
    dispatcher: new GateDispatcher({ channels: [r.channel] }),
    engine: {
      projection: () => Promise.reject(new Error("read model unavailable")),
      openGates: () => Promise.reject(new Error("must not be reached")),
      resolveGate: () => Promise.reject(new Error("must not be reached")),
    },
    logFor: (id) => new RunLog(id, { store: r.h.store, bus: r.h.bus }),
    now: () => NOW,
  });

  const body = approval(r);
  const ts = String(Math.floor(NOW / 1000));
  const e = await router
    .handle({
      channel: "slack",
      runId: r.runId,
      body: Buffer.from(body),
      headers: { "x-loom-timestamp": ts, "x-loom-signature": r.channel.sign(body, ts) },
    })
    .then(() => undefined, (thrown: unknown) => thrown);

  ownedRefusal(e);
  assert.deepEqual(router.refusals(), [{ channel: "slack", reason: "internal", count: 1 }], "counted: no run was proved to exist");
  await stillOpen(r);
});

test("A JOURNAL THAT WILL NOT TAKE THE ROW LEAVES THE REFUSAL COUNTED, AND EXITS TYPED", async () => {
  // The last unowned value on the refusal path: `logFor` is injected too, and its failure
  // was the one exit from `handle` that skipped both sinks — the row did not land and the
  // counter never ran, so a journal outage was also an audit blackout. It left untyped as
  // well, straight into the HTTP layer's `toLoomError`, whose `String(e)` cannot print a
  // null-prototype throw: the same partial read, one layer further out.
  const r = await rig({ approvers: ["u:alice"] });
  const router = new GateCallbackRouter({
    dispatcher: new GateDispatcher({ channels: [r.channel] }),
    engine: r.h.engine as unknown as CallbackEngine,
    logFor: () => ({ append: () => Promise.reject(Object.create(null) as Error) }) as unknown as RunLog,
    now: () => NOW,
  });

  // Signed by the real channel, then refused for naming someone who may not answer — so
  // admission allows a durable row, and the row is the thing that fails.
  const body = approval(r, "u:mallory");
  const ts = String(Math.floor(NOW / 1000));
  const e = await router
    .handle({
      channel: "slack",
      runId: r.runId,
      body: Buffer.from(body),
      headers: { "x-loom-timestamp": ts, "x-loom-signature": r.channel.sign(body, ts) },
    })
    .then(() => undefined, (thrown: unknown) => thrown);

  ownedRefusal(e);
  assert.deepEqual(
    router.refusals(),
    [{ channel: "slack", reason: "not_authorized", count: 1 }],
    "the journal took nothing, so the counter took it — never neither",
  );
  await stillOpen(r);
});

test("SEVERAL HOSTILE CHANNELS AT ONCE — the gate stays open, and every refusal lands in exactly one sink", async () => {
  // The module's load-bearing rule, re-verified end to end against the whole zoo rather
  // than one hostile shape at a time: a callback that does not verify leaves the gate
  // open, and every refusal is recorded in exactly one place. Several channels are
  // configured on ONE router because that is the deployment shape — a dispatcher holds
  // every channel a graph may name, and one of them being hostile may not cost the others
  // their perimeter.
  const r = await rig({ approvers: ["u:alice"] });
  const zoo: DeliveryChannel[] = [
    trapChannel("throws-trapped", () => trapped()),
    trapChannel("throws-trapped-code", () => trapped({ code: true })),
    { name: "throws-unprintable", deliver: () => Promise.resolve("x"), parseCallback: () => Promise.reject(Object.create(null) as Error) },
    { name: "throws-string", deliver: () => Promise.resolve("x"), parseCallback: () => Promise.reject("a bare string") },
    trapField(r, "runId"),
    trapField(r, "actor"),
    trapField(r, "decision"),
    namesGate("__proto__", r.runId),
    namesGate(() => "not an id", r.runId),
    {
      name: "gullible",
      deliver: () => Promise.resolve("x"),
      parseCallback: () =>
        Promise.resolve({
          runId: r.runId,
          gateId: r.gateId,
          decision: { kind: "approve" },
          actor: { kind: "human", subject: "u:mallory", via: "api" },
          idempotencyKey: "k",
        } satisfies CallbackDecision),
    },
  ];
  // Two of them share a name by construction (`trapfield`, `namer`); the map keeps the
  // last, which is enough — every one of them is posted at by the name it is keyed under.
  const router = routerFor(r, zoo);
  const names = [...new Set(zoo.map((c) => c.name))];

  for (const name of names) {
    const rowsBefore = rejections(await r.events()).length;
    const countBefore = router.refusals().reduce((n, x) => n + x.count, 0);

    const e = await router
      .handle({ channel: name, runId: r.runId, body: Buffer.from("{}"), headers: {} })
      .then(() => undefined, (thrown: unknown) => thrown);

    ownedRefusal(e);
    const rows = rejections(await r.events()).length - rowsBefore;
    const counted = router.refusals().reduce((n, x) => n + x.count, 0) - countBefore;
    assert.equal(rows + counted, 1, `${name}: exactly one sink took it`);
    await stillOpen(r);
  }

  // …and the one channel that does verify still works, on the same router.
  const body = approval(r);
  const ts = String(Math.floor(NOW / 1000));
  const withReal = routerFor(r, [...zoo, r.channel]);
  const out = (await withReal.handle({
    channel: "slack",
    runId: r.runId,
    body: Buffer.from(body),
    headers: { "x-loom-timestamp": ts, "x-loom-signature": r.channel.sign(body, ts) },
  })) as { decision: { kind: string } };
  assert.equal(out.decision.kind, "approve");
  assert.equal(r.h.writes.length, 1, "the gate opened for the one caller that proved it may");
});

// ── a real decision, end to end ──────────────────────────────────────────────

test("a verified approval RUNS THE ACTION BEHIND THE GATE", async () => {
  const r = await rig();
  const out = (await r.post(approval(r))) as { decision: { kind: string }; projection: { status: string } };
  assert.equal(out.decision.kind, "approve");
  assert.equal(out.projection.status, "succeeded");
  assert.equal(r.h.writes.length, 1, "approve on a work node means GO AHEAD, not consider-it-done");
});

test("a verified rejection fails the run and writes nothing", async () => {
  const r = await rig();
  const body = JSON.stringify({ runId: r.runId, gateId: r.gateId, actor: "u:alice", decision: { kind: "reject", reason: "blast radius too wide" } });
  const out = (await r.post(body)) as { projection: { status: string } };
  assert.equal(out.projection.status, "failed");
  assert.equal(r.h.writes.length, 0);
  const decided = (await r.events()).find((e) => e.type === "gate.decided");
  assert.equal((decided?.payload as { justification: string }).justification, "blast radius too wide");
});

// ── the pieces, directly ─────────────────────────────────────────────────────

test("timingSafeStringEqual survives a length mismatch instead of throwing", () => {
  assert.equal(timingSafeStringEqual("abc", "abc"), true);
  assert.equal(timingSafeStringEqual("abc", "abd"), false);
  assert.equal(timingSafeStringEqual("abc", "abcdef"), false, "timingSafeEqual itself would throw here");
  assert.equal(timingSafeStringEqual("", ""), true);
});

test("sign() is stable, and is what a sender must reproduce", () => {
  const c = new SignedWebhookChannel({ url: "https://x", callbackSecret: "k" });
  const sig = c.sign("{}", "1700000000");
  assert.match(sig, /^v0=[0-9a-f]{64}$/);
  assert.equal(c.sign("{}", "1700000000"), sig, "same bytes, same time, same signature");
  assert.notEqual(c.sign("{}", "1700000001"), sig, "the timestamp really is inside the MAC");
  assert.notEqual(c.sign("{ }", "1700000000"), sig, "and so are the exact bytes");
});

test("an empty callback secret is a configuration error, not a channel that accepts everything", () => {
  assert.throws(
    () => new SignedWebhookChannel({ url: "https://x", callbackSecret: "" }),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID,
  );
  // AND SO IS A SECRET THAT IS NOT A STRING, which is the same refusal read through the
  // hole `http.ts`'s bearer token was found in (REGISTER E8): the empty check is `=== ""`,
  // and `[]`, `null` and `0` are not `""`. `createHmac` refuses them at SIGNING time
  // instead — inside `parseCallback`, where the router turns the throw into `internal`,
  // counts it, and journals nothing. So the deployment gets a channel that publishes an
  // answer address and refuses every answer, discovered at 3am rather than at boot.
  for (const bad of [null, 0, [], {}] as unknown[]) {
    assert.throws(
      () => new SignedWebhookChannel({ url: "https://x", callbackSecret: bad as string }),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID,
      `callbackSecret: ${JSON.stringify(bad)}`,
    );
  }
});

test("A REPLAY WINDOW THAT IS NOT A NUMBER IS NOT A WINDOW", async () => {
  // `#toleranceMs` is the second half of the perimeter: the timestamp is inside the signed
  // material so an attacker cannot edit it, and the window is what stops a CAPTURED approval
  // being posted again tomorrow. It reaches one comparison — `Math.abs(now - ts * 1000) >
  // this.#toleranceMs` — and A12's third correction is exactly this shape: `NaN` loses every
  // comparison, so a knob whose whole job is to say "stop here" stops nothing.
  //
  // `cli.ts`'s `positive` already refuses these when the channel comes out of a channels
  // file, naming `toleranceMs` in its own docstring. `SignedWebhookChannel` is on the pinned
  // public surface, so an embedder constructing it directly got no such refusal — the same
  // gap A12 records for `WebhookChannelOptions.timeoutMs`, one option along, with the
  // perimeter behind it instead of a timeout.
  for (const bad of [NaN, Infinity, -1, 1.5, "300000"] as unknown[]) {
    assert.throws(
      () => new SignedWebhookChannel({ url: "https://x", callbackSecret: SECRET, toleranceMs: bad as number }),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID,
      `toleranceMs: ${String(bad)}`,
    );
  }
  // What it was buying: a five-year-old signature, correctly signed, accepted as current.
  const ok = new SignedWebhookChannel({ url: "https://x", callbackSecret: SECRET, toleranceMs: 300_000 });
  const body = Buffer.from(JSON.stringify({ runId: "run_x", gateId: "gate_x", actor: "u:sre", decision: { kind: "approve" } }));
  const stale = "1500000000";
  const refused = await ok.parseCallback({ body, headers: { "x-loom-timestamp": stale, "x-loom-signature": ok.sign(body, stale) }, now: NOW }).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(isLoomError(refused) && refused.code === CODES.E_GATE_NOT_AUTHORIZED, "a bounded window still refuses a replay");
});


test("every rejection reason maps to a code D3.20 allows, or to the one addition", () => {
  const allowed = new Set<string>([
    CODES.E_GATE_NOT_AUTHORIZED,
    CODES.E_GATE_NOT_FOUND,
    CODES.E_GATE_ALREADY_RESOLVED,
    CODES.E_PROVIDER_BAD_REQUEST,
    CODES.E_INTERNAL,
  ]);
  for (const reason of ["signature", "timestamp", "not_authorized", "unknown_channel", "not_found", "already_resolved", "malformed", "run_mismatch", "internal"] as const) {
    const e = callbackRejection(reason, "x");
    assert.ok(allowed.has(e.code), `${reason} → ${e.code}`);
    assert.equal(rejectionReasonOf(e), reason, "the token survives the round trip to the journal");
  }
});

test("a bare Error on the callback path becomes `internal`, not a silent approval", () => {
  assert.equal(rejectionReasonOf(new Error("boom")), "internal");
  assert.equal(rejectionReasonOf(callbackRejection("signature", "x")), "signature");
});

// ── the OUTBOUND half: one code out of `deliver` ─────────────────────────────
//
// D3's boundary taxonomy says `deliver` raises `E_GATE_DELIVERY_FAILED` **only**, and says
// why: any other code tempts a caller into branching, and every branch out of "the
// notification failed" that is not "leave the gate open" is a way to approve something
// nobody approved. Only the non-2xx arm was mapped, which is the arm that almost never
// fires — the two failures that actually happen are `fetch` REJECTING, and both escaped
// the contract. A hung endpoint reached the journal as `E_INTERNAL`: "a bug in Loom".

/**
 * A real `GateSummary`, taken from a live run rather than built here.
 *
 * The summary's own payload is REPLACED rather than passed through, which is what
 * `GateDispatcher.deliver` does and what `DeliveryTarget.gate` documents. A fixture that
 * left the live one there would be handing these channels a target no dispatcher builds —
 * and it would be modelling the exact defect the delivery suite closed, where the
 * redacted payload and the unredacted one rode on one object.
 *
 * `contentDigest` is deliberately NOT re-derived here, and the fixture is therefore a
 * target the dispatcher would not build in one respect: a real delivery splices in the
 * digest of what was shown whenever the spec hides anything. Every test below is about
 * `deliver`'s ERROR MAPPING, where nothing reads the field — so the honest fixture is one
 * that says which half of the contract it models rather than one that quietly models
 * both. If a test here ever asserts on `contentDigest`, drive `GateDispatcher.deliver`
 * instead; `test/run/delivery.test.ts` owns that half.
 */
async function deliveryTarget(r: Rig, payload: unknown = { command: "restart" }): Promise<DeliveryTarget> {
  const gate = (await r.h.engine.openGates(r.runId))[0]!;
  return { gate: { ...gate, payload }, recipients: [{ kind: "user", id: "u:alice" }], payload, tier: 0 };
}

/** A `fetch` that rejects the way undici does when the signal it was handed aborts. */
const abortAware = ((_url: string, init: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init.signal as AbortSignal;
    if (signal.aborted) reject(signal.reason as Error);
    else signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
  })) as unknown as typeof fetch;

async function failureOf(fn: () => Promise<unknown>): Promise<LoomError> {
  const e = await fn().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  assert.ok(isLoomError(e), `expected a LoomError, got ${String(e)}`);
  return e;
}

test("A NETWORK FAILURE LEAVES `deliver` AS E_GATE_DELIVERY_FAILED, not as a bare TypeError", async () => {
  // The reproduction: `fetch` itself rejecting — DNS gone, connection refused, TLS
  // refused — used to propagate unmapped, so the one code the contract promises was the
  // one code an operator did not get.
  const r = await rig();
  const channel = new WebhookChannel({
    url: "https://hooks.example.com/x",
    fetch: (() => Promise.reject(new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND hooks.example.com") }))) as unknown as typeof fetch,
  });

  const target = await deliveryTarget(r);
  const e = await failureOf(() => channel.deliver(target, new AbortController().signal));
  assert.equal(e.code, CODES.E_GATE_DELIVERY_FAILED);
  assert.equal(e.class, "unavailable", "a channel that cannot be reached is worth retrying");
  const details = e.details as { reason: string; cause: string; channel: string };
  assert.equal(details.reason, "transport");
  assert.equal(details.channel, "webhook");
  // The cause survives, because "delivery failed" alone makes an operator guess between
  // DNS, TLS, a timeout and a 500.
  assert.match(details.cause, /ENOTFOUND/);
});

test("A HUNG ENDPOINT IS A DELIVERY FAILURE THAT SAYS SO, not an internal error", async () => {
  // `AbortSignal.timeout` makes `fetch` REJECT with a TimeoutError rather than return a
  // response, so the non-2xx branch never sees it. Event-driven: the stub rejects the
  // moment the timeout aborts, so this waits on the timer and not on a duration.
  const r = await rig();
  const channel = new WebhookChannel({ url: "https://hooks.example.com/x", timeoutMs: 0, fetch: abortAware });

  const target = await deliveryTarget(r);
  const e = await failureOf(() => channel.deliver(target, new AbortController().signal));
  assert.equal(e.code, CODES.E_GATE_DELIVERY_FAILED);
  assert.equal((e.details as { reason: string }).reason, "timeout");
  assert.match(e.message, /did not answer within 0ms/);
});

test("AN OPERATOR'S CANCEL IS NOT A CHANNEL THAT FAILED", async () => {
  // The one deliberate exception to "one code out", and it is the taxonomy's own: the
  // table gives cancel its own column because it is not one of the codes a method raises.
  // Recording an abort as a delivery failure blames the network for a person's action —
  // and `E_GATE_DELIVERY_FAILED` is retryable while a cancel must not be retried.
  const r = await rig();
  const channel = new WebhookChannel({ url: "https://hooks.example.com/x", fetch: abortAware });
  const ac = new AbortController();
  const target = await deliveryTarget(r);

  const pending = channel.deliver(target, ac.signal);
  ac.abort();
  const e = await failureOf(() => pending);
  assert.equal(e.code, CODES.E_CANCELLED);
  assert.equal(e.class, "cancelled");
  assert.equal(e.retryable, false, "an operator's cancel is not something to try again");
});

test("a non-2xx response still maps the way it always did, now with the status in details", async () => {
  const r = await rig();
  const channel = new WebhookChannel({
    url: "https://hooks.example.com/x",
    fetch: (() => Promise.resolve(new Response("nope", { status: 500 }))) as unknown as typeof fetch,
  });

  const target = await deliveryTarget(r);
  const e = await failureOf(() => channel.deliver(target, new AbortController().signal));
  assert.equal(e.code, CODES.E_GATE_DELIVERY_FAILED);
  assert.deepEqual(e.details, { channel: "webhook", gateId: r.gateId, reason: "status", status: 500 });
});

test("A TIMEOUT NO TIMER CAN HOLD IS REFUSED, INSTEAD OF BECOMING ONE MILLISECOND", async () => {
  // `setTimeout` and `AbortSignal.timeout` keep their delay in a 32-bit signed integer and
  // TRUNCATE anything larger. So `timeoutMs: 2 ** 31` — a legal-looking "plenty of headroom"
  // number — aborted the fetch 0 ms after the call and produced `webhook did not answer
  // within 2147483648ms`, a message that is its own counterexample, while the outcome is the
  // one the delivery subsystem exists to prevent: nobody is ever told about the gate.
  // REGISTER A12 records the reproduction and names this constructor as the fix site; the
  // read stays inside the try instead, because *NOTHING RUNS ABOVE THE TRY* pins that a
  // config value that cannot be read is a delivery failure and not an unstartable process.
  //
  // Nothing that works today stops working: every value refused here already failed every
  // delivery, at one millisecond, with a message asserting a window nothing honoured.
  const r = await rig();
  const target = await deliveryTarget(r);
  for (const bad of [2 ** 31, NaN, Infinity, -1, 1.5, "10000"] as unknown[]) {
    let fetched = false;
    const channel = new WebhookChannel({
      url: "https://hooks.example.com/x",
      timeoutMs: bad as number,
      fetch: (() => {
        fetched = true;
        return Promise.resolve(new Response("ok"));
      }) as unknown as typeof fetch,
    });
    const e = await failureOf(() => channel.deliver(target, new AbortController().signal));
    assert.equal(e.code, CODES.E_GATE_DELIVERY_FAILED, `one code out, whatever the reason (${String(bad)})`);
    assert.equal(fetched, false, `nothing was sent (${String(bad)})`);
    assert.match(e.message, /timeoutMs/, "the message names the knob");
    assert.doesNotMatch(e.message, /within \d+ms/, "…rather than quoting a duration nothing applied");
  }
  // `0` stays legal, and is what the hung-endpoint test above drives: "abort on the next
  // tick" is a coherent posture, and a bound is not a place to smuggle a policy in.
  const zero = new WebhookChannel({ url: "https://hooks.example.com/x", timeoutMs: 0, fetch: abortAware });
  const timedOut = await failureOf(() => zero.deliver(target, new AbortController().signal));
  assert.equal((timedOut.details as { reason: string }).reason, "timeout");
});

test("a payload that cannot be serialized is a delivery failure, not a thrown TypeError", async () => {
  // `JSON.stringify` is inside the try for this: a circular payload — or a BigInt, or a
  // getter that throws — is a graph author's bug, and a graph author's bug must not become
  // an unmapped throw out of an interface whose contract is one code.
  const r = await rig();
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  const payloads: unknown[] = [
    circular,
    { cost: 10n },
    {
      get blastRadius(): number {
        throw new Error("a getter on the payload threw");
      },
    },
  ];

  for (const payload of payloads) {
    let called = false;
    const channel = new WebhookChannel({
      url: "https://hooks.example.com/x",
      fetch: (() => {
        called = true;
        return Promise.resolve(new Response("ok"));
      }) as unknown as typeof fetch,
    });

    const target = await deliveryTarget(r, payload);
    const e = await failureOf(() => channel.deliver(target, new AbortController().signal));
    assert.equal(e.code, CODES.E_GATE_DELIVERY_FAILED);
    assert.equal((e.details as { reason: string }).reason, "transport");
    assert.equal(called, false, "nothing was sent");
  }
});

test("A PAYLOAD CANNOT REWRITE ITSELF ONTO THE WIRE AFTER REDACTION HAS RUN", async () => {
  // The test above establishes that `JSON.stringify` runs on the payload here. This one is
  // the other half of that fact: `JSON.stringify` CALLS an own-enumerable `toJSON`, and
  // `redactFields`'s walk fell through `typeof v !== "object"` for a function — so the
  // method was copied onto the redacted tree BY REFERENCE and then invoked, one layer
  // outside the redactor, with the unredacted values still in its closure. The declared
  // field was hidden and the payload put it back.
  //
  // Driven through the DISPATCHER rather than through `redactFields`, because the two ends
  // are in different files and the defect only exists in the join between them: the
  // redactor's output is not the wire, the channel's `JSON.stringify` is.
  const r = await rig();
  const smuggled = "oncall@example.com";
  const bodies: string[] = [];
  const channel = new WebhookChannel({
    name: "hook",
    url: "https://hooks.example.com/x",
    fetch: ((_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return Promise.resolve(new Response("srv-1", { status: 200 }));
    }) as unknown as typeof fetch,
  });
  const dispatcher = new GateDispatcher({ channels: [channel], fallback: new ConsoleChannel() });
  const gate = (await r.h.engine.openGates(r.runId))[0]!;
  const payload = {
    command: "restart",
    email: smuggled,
    toJSON: () => ({ command: "restart", email: smuggled }),
  };

  const log = new RunLog(r.runId, { store: r.h.store, bus: r.h.bus });
  const outcome = await dispatcher.deliver(log, { ...gate, payload }, { channels: ["hook"], redact: ["email"] });

  assert.equal(outcome.delivered.length, 1, "the gate was delivered — this is not a test about failing");
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.includes(smuggled), false, "the payload reintroduced the value AFTER redaction ran");
  assert.match(bodies[0]!, /pii:[0-9a-f]{12}:string/, "the approver still gets a handle for the hidden field");
  assert.match(bodies[0]!, /restart/, "…and the thing being approved is still legible");
});

test("A MISCONFIGURED TIMEOUT IS A DELIVERY FAILURE, not a RangeError from the constructor", async () => {
  // `AbortSignal.timeout(-1)` throws `RangeError: The value of "delay" is out of range`,
  // and it used to run ABOVE the try — so a channel configured with a negative or
  // non-integer timeout left `deliver` with a bare RangeError. Config is not caller input,
  // but the contract is "one code out", not "one code out for the inputs we expected".
  //
  // ALL THREE ARE NOW REFUSED BEFORE THE PLATFORM SEES THEM (`#timeout`, and *A TIMEOUT NO
  // TIMER CAN HOLD IS REFUSED*), so this no longer drives the RangeError it was written for
  // — it drives the same OUTCOME through the refusal that pre-empts it. Kept, because the
  // property is the contract and not the mechanism: whichever of the two fires, one code
  // comes out.
  const r = await rig();
  const target = await deliveryTarget(r);
  for (const timeoutMs of [-1, 1.5, Number.NaN]) {
    const channel = new WebhookChannel({
      url: "https://hooks.example.com/x",
      timeoutMs,
      fetch: (() => Promise.resolve(new Response("ok"))) as unknown as typeof fetch,
    });
    const e = await failureOf(() => channel.deliver(target, new AbortController().signal));
    assert.equal(e.code, CODES.E_GATE_DELIVERY_FAILED, `timeoutMs=${timeoutMs}`);
  }
});

test("A THIRD PARTY'S BUG IS A DELIVERY FAILURE, not a bug in Loom", async () => {
  // `GateDispatcher` called `toLoomError(e)` on whatever an injected channel threw, and
  // its default fallback is `E_INTERNAL` — which the taxonomy defines as "a bug in Loom"
  // and which alerts accordingly. So a vendor integration throwing a bare string paged
  // somebody about somebody else's defect. The dispatcher cannot know what went wrong
  // inside a channel; what it does know is that a gate was not delivered.
  const r = await rig();
  const gate = (await r.h.engine.openGates(r.runId))[0]!;
  const log = new RunLog(r.runId, { store: r.h.store, bus: r.h.bus });

  const rude: DeliveryChannel = { name: "rude", deliver: () => Promise.reject("a bare string, thrown by a vendor SDK") };
  const nulls: DeliveryChannel = { name: "nulls", deliver: () => Promise.reject(Object.create(null) as Error) };
  // `isLoomError` is an `instanceof`, and `instanceof` runs a proxy's `getPrototypeOf`
  // trap — so the first line of the mapping is itself a call into the channel's value.
  // This one used to reject the whole `Promise.all`, which loses the OTHER channels'
  // `gate.delivered` rows: one hostile channel erasing the record of the others' work.
  const trapped: DeliveryChannel = {
    name: "trapped",
    deliver: () =>
      Promise.reject(
        new Proxy(new Error("wrapped"), {
          getPrototypeOf() {
            throw new Error("every trap throws");
          },
        }),
      ),
  };
  const cancels: DeliveryChannel = {
    name: "cancels",
    deliver: () => Promise.reject(err.cancelled("the operator cancelled this dispatch")),
  };
  const ok: DeliveryChannel = { name: "ok", deliver: () => Promise.resolve("receipt-1") };
  const dispatcher = new GateDispatcher({ channels: [rude, nulls, trapped, cancels, ok] });
  const out = await dispatcher.deliver(log, gate, { channels: ["rude", "nulls", "trapped", "cancels", "ok"] });

  const by = (name: string): LoomError => out.failed.find((f) => f.channel === name)!.error;
  assert.equal(by("rude").code, CODES.E_GATE_DELIVERY_FAILED);
  assert.equal(by("nulls").code, CODES.E_GATE_DELIVERY_FAILED, "…even when the thrown value cannot be printed");
  assert.equal(by("trapped").code, CODES.E_GATE_DELIVERY_FAILED, "…even when reading the value is what throws");
  assert.deepEqual(out.delivered, [{ channel: "ok", receipt: "receipt-1" }], "and the working channel was still recorded");
  // The class travels with the code: `retryable` is DERIVED from it, and the engine's
  // retry policy checks `error.retryable` before it ever looks at `onlyIf`. One code with
  // two classes would make `retry.onlyIf: ["E_GATE_DELIVERY_FAILED"]` work for a webhook
  // and silently not work for a vendor channel.
  assert.equal(by("rude").class, "unavailable");
  assert.equal(by("rude").retryable, true);
  // A channel raising a REAL LoomError is not rewritten — an operator's cancel stays a
  // cancel, and stays non-retryable.
  assert.equal(by("cancels").code, CODES.E_CANCELLED);
  assert.equal(by("cancels").retryable, false);
});

test("SignedWebhookChannel INHERITS the contract — it is the same `deliver`", async () => {
  // It extends `WebhookChannel` and does not override `deliver`, so the fix must reach it.
  // Worth pinning because it is the channel a deployment actually configures: the one that
  // can be answered is the one that gets used.
  const r = await rig();
  const channel = new SignedWebhookChannel({
    name: "slack",
    url: "https://hooks.example.com/x",
    callbackSecret: SECRET,
    fetch: (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch,
  });

  const target = await deliveryTarget(r);
  const e = await failureOf(() => channel.deliver(target, new AbortController().signal));
  assert.equal(e.code, CODES.E_GATE_DELIVERY_FAILED);
  assert.equal((e.details as { channel: string }).channel, "slack");
});

test("…and a `signal` that is not an AbortSignal exits typed too", async () => {
  // The last resort in `#failure`, which is the only arm that reads NOTHING from the
  // thrown value. Reachable from a caller rather than a channel: pass an object that is
  // not an `AbortSignal` and `AbortSignal.any` refuses it, and then the handler's own
  // `signal.aborted` throws while trying to classify that refusal.
  const r = await rig();
  const target = await deliveryTarget(r);
  const channel = new WebhookChannel({
    url: "https://hooks.example.com/x",
    fetch: (() => Promise.resolve(new Response("ok"))) as unknown as typeof fetch,
  });
  const hostile = {
    get aborted(): boolean {
      throw new Error("not an AbortSignal");
    },
  } as unknown as AbortSignal;

  const e = await failureOf(() => channel.deliver(target, hostile));
  assert.equal(e.code, CODES.E_GATE_DELIVERY_FAILED);
  assert.deepEqual(e.details, { channel: "webhook", gateId: r.gateId, reason: "transport" });
  assert.equal(e.cause, undefined, "the cause is dropped: reading it is what failed");
});

test("EVERY FAILURE MODE EXITS TYPED, checked as one statement", async () => {
  // The contract is "no other error escapes", which is a claim about the whole set rather
  // than about any one arm. A new `await` added above the try later is exactly how this
  // regresses, so the set is asserted rather than the arms.
  //
  // The second half of the list is the ERROR FORMATTER's own inputs. `describeCause` used
  // `String(cur)`, which is partial: a value with no usable primitive conversion throws
  // `TypeError: Cannot convert object to primitive value`, FROM INSIDE THE CATCH BLOCK —
  // relocating the very failure mode this contract exists to remove rather than removing
  // it. Anything a channel can reject with is an input to the formatter, so these belong
  // in the same set as the transport failures.
  const r = await rig();
  const target = await deliveryTarget(r);
  const nullProto = Object.create(null) as Error;
  const fetches: (typeof fetch)[] = [
    (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch,
    (() => Promise.reject(new Error("some vendor SDK threw"))) as unknown as typeof fetch,
    (() => Promise.reject("a string, because someone threw one")) as unknown as typeof fetch,
    (() => {
      throw new Error("synchronous throw, not a rejected promise");
    }) as unknown as typeof fetch,
    (() => Promise.resolve(new Response("", { status: 404 }))) as unknown as typeof fetch,
    (() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.reject(new Error("socket died mid-body")),
      } as unknown as Response)) as unknown as typeof fetch,
    // ── values the formatter cannot print ──────────────────────────────────
    (() => Promise.reject(nullProto)) as unknown as typeof fetch,
    (() => Promise.reject({ toString: null, valueOf: null })) as unknown as typeof fetch,
    // One level down, which is where undici puts the fact an operator actually needs.
    (() => Promise.reject(new TypeError("fetch failed", { cause: nullProto }))) as unknown as typeof fetch,
    (() => Promise.reject(Symbol("a channel threw a symbol"))) as unknown as typeof fetch,
    // A getter is a call, and a call can throw — on `name`, on `message`, or on `cause`.
    (() =>
      Promise.reject({
        get name(): string {
          throw new Error("hostile getter");
        },
        message: "x",
      })) as unknown as typeof fetch,
    (() =>
      Promise.reject({
        name: "E",
        get message(): string {
          throw new Error("hostile getter");
        },
      })) as unknown as typeof fetch,
    (() =>
      Promise.reject({
        name: "E",
        message: "m",
        get cause(): unknown {
          throw new Error("hostile getter");
        },
      })) as unknown as typeof fetch,
    (() =>
      Promise.reject(
        new Proxy(new Error("wrapped"), {
          get() {
            throw new Error("every trap throws");
          },
        }),
      )) as unknown as typeof fetch,
  ];

  for (const f of fetches) {
    const channel = new WebhookChannel({ url: "https://hooks.example.com/x", fetch: f });
    const e = await channel.deliver(target, new AbortController().signal).then(
      (receipt) => receipt,
      (thrown: unknown) => thrown,
    );
    // The last stub is the odd one: `res.text()` failing is already swallowed into an
    // empty receipt, which is fine — a receipt the channel minted itself is honest.
    if (typeof e === "string") continue;
    assert.ok(isLoomError(e), `unmapped: ${String(e)}`);
    assert.equal(e.code, CODES.E_GATE_DELIVERY_FAILED, `wrong code for ${String(e.message)}`);
  }
});

/**
 * A DECISION THAT ARRIVES AFTER ITS CALLER WAS TOLD THE REQUEST FAILED IS NOT APPLIED.
 *
 * `ControlPlane.#withDeadline` answers 504 and moves on; its own docstring says it cannot cancel
 * the handler. So a `parseCallback` that hung and then succeeded walked straight into `resolve`
 * and applied a human's decision minutes after that human had seen the request fail — and,
 * because every counter and every journal row in `handle` is reached only once `parse` has
 * settled, the refusal was recorded in NEITHER sink. That is A5's own title, and the half of it
 * `#withDeadline` did not close.
 *
 * The check is on the ROUTER, not on the channel. `CallbackRequest` could have grown an
 * `AbortSignal` for a channel to honour, but the channel that ships in this binary would have
 * ignored it and the hole would have stayed open behind a closed register entry. This holds for
 * code that never cooperates.
 */
test("A CALLBACK THAT ANSWERS AFTER THE DEADLINE IS REFUSED, not applied", async () => {
  const r = await rig();
  const body = approval(r);
  const ts = String(Math.floor(NOW / 1000));
  const send = (signal?: AbortSignal): Promise<unknown> =>
    r.router.handle({
      channel: "slack",
      runId: r.runId,
      body: Buffer.from(body, "utf8"),
      headers: { "x-loom-timestamp": ts, "x-loom-signature": r.channel.sign(body, ts) },
      ...(signal === undefined ? {} : { signal }),
    });

  const expired = new AbortController();
  expired.abort();

  await assert.rejects(() => send(expired.signal), /deadline/i, "an expired request must be refused");
  await stillOpen(r);
  assert.deepEqual(
    r.router.refusals(),
    [{ channel: "slack", reason: "timeout", count: 1 }],
    "and it must be COUNTED — the hole was that a hung callback appeared in neither sink",
  );

  // THE SAME BYTES SUCCEED WITHOUT THE SIGNAL, which is what makes the refusal above mean
  // "the deadline", and not "this request was never going to be accepted".
  const out = (await send()) as { decision: { kind: string } };
  assert.equal(out.decision.kind, "approve");
});

/**
 * A `parseCallback` THAT NEVER SETTLES MUST NOT PARK THE HANDLER FOREVER.
 *
 * This is the LAST of A5's three consequences, and the sibling test above closed a different
 * one. That test aborts BEFORE the call, so `parse` settles immediately and the check that
 * refuses it is reached; it says nothing about a parse that never settles at all, which is the
 * shape A5 actually reproduced: `requestTimeoutMs: 100`, a channel that never resolves, and a
 * 50 000-byte POST returning 504 with `parseCallback` still pending and the body still held.
 *
 * `await parse(…)` suspends `handle` with `input` — and so `input.body` — live in its
 * continuation, and suspends `ControlPlane.#serve` and `#withDeadline` on top of it. One
 * buffered body per hung POST, on the one route reachable WITHOUT A CREDENTIAL, held for the
 * life of the process. Racing the parse against the deadline lets all three frames unwind.
 *
 * What it does NOT do is cancel the channel's promise — nothing in JavaScript can. If the
 * channel captured the body, the channel still holds it. The half core owns is released.
 *
 * THE TEST FAILS BY TIMING OUT if the race is removed, which is a slow way to go red, so it
 * races a sentinel of its own: `handle` must settle promptly after the abort, and "promptly" is
 * a macrotask rather than a duration, so this waits on the event loop and not on a clock.
 */
test("A `parseCallback` THAT NEVER SETTLES RELEASES THE HANDLER AT THE DEADLINE", async () => {
  const r = await rig();
  const body = approval(r);
  const ts = String(Math.floor(NOW / 1000));

  // Never resolves, never rejects. `bodySeen` proves the router really did reach the channel,
  // so a refusal cannot come from somewhere earlier and read as this one.
  let bodySeen: Uint8Array | undefined;
  const hung: DeliveryChannel = {
    name: "slack",
    deliver: async () => "receipt",
    parseCallback: (req): Promise<CallbackDecision> => {
      bodySeen = req.body;
      return new Promise<CallbackDecision>(() => {});
    },
  };
  const store: StateStore = r.h.store;
  const router = new GateCallbackRouter({
    dispatcher: new GateDispatcher({ channels: [hung] }),
    engine: r.h.engine as unknown as CallbackEngine,
    logFor: (id) => new RunLog(id, { store, bus: r.h.bus }),
    now: () => NOW,
  });

  const ac = new AbortController();
  const handled = router.handle({
    channel: "slack",
    runId: r.runId,
    body: Buffer.from(body, "utf8"),
    headers: { "x-loom-timestamp": ts, "x-loom-signature": r.channel.sign(body, ts) },
    signal: ac.signal,
  });

  // Let the parse start and park, then fire the deadline the way `#withDeadline` does.
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(bodySeen !== undefined, "the router must actually have called the channel");
  ac.abort();

  const LATE = Symbol("still pending");
  const settled = await Promise.race([
    handled.then(
      (v) => v as unknown,
      (e: unknown) => e,
    ),
    // Generous: several macrotasks, so this is not a race against a slow machine. Without
    // the fix `handled` never settles and this sentinel wins on every machine.
    new Promise((resolve) => setTimeout(() => resolve(LATE), 50)),
  ]);

  assert.notEqual(settled, LATE, "handle must settle at the deadline rather than await a promise that never resolves");
  assert.ok(isLoomError(settled), `expected a LoomError, got ${String(settled)}`);
  assert.match(settled.message, /deadline/i);
  assert.equal((settled.details as { reason: string }).reason, "timeout");

  // The gate is untouched and the refusal is counted, which is the property the sibling test
  // states: a refusal that lands in neither sink is what A5 was about.
  await stillOpen(r);
  assert.deepEqual(router.refusals(), [{ channel: "slack", reason: "timeout", count: 1 }]);
});

/**
 * A PARSE THAT WINS THE RACE BY A HAIR IS STILL TOO LATE.
 *
 * The race covers a parse that never settles. It does NOT cover the narrow ordering where the
 * parse resolves and the deadline fires before the handler is resumed — there the race has
 * already picked the parse, so the only thing standing between a stale decision and `resolve`
 * is the check AFTER it. Written because a mutation found that check unguarded: deleting it
 * left all 84 tests green, which is the exact failure mode this file's sibling entry describes
 * — a refusal with a test addressed to the side of it that cannot fail.
 *
 * The ordering is forced rather than raced. `resolveParse(...)` settles the parse, which QUEUES
 * the handler's continuation as a microtask; `ac.abort()` on the next line runs synchronously,
 * so `aborted` is true before that microtask ever executes. No timers, no duration, and the
 * same order on every machine.
 */
test("A PARSE THAT RESOLVES JUST BEFORE THE DEADLINE FIRES IS STILL REFUSED", async () => {
  const r = await rig();
  const body = approval(r);
  const ts = String(Math.floor(NOW / 1000));

  let resolveParse: ((d: CallbackDecision) => void) | undefined;
  const slow: DeliveryChannel = {
    name: "slack",
    deliver: async () => "receipt",
    parseCallback: (): Promise<CallbackDecision> =>
      new Promise<CallbackDecision>((resolve) => {
        resolveParse = resolve;
      }),
  };
  const store: StateStore = r.h.store;
  const router = new GateCallbackRouter({
    dispatcher: new GateDispatcher({ channels: [slow] }),
    engine: r.h.engine as unknown as CallbackEngine,
    logFor: (id) => new RunLog(id, { store, bus: r.h.bus }),
    now: () => NOW,
  });

  const ac = new AbortController();
  const handled = router.handle({
    channel: "slack",
    runId: r.runId,
    body: Buffer.from(body, "utf8"),
    headers: { "x-loom-timestamp": ts, "x-loom-signature": r.channel.sign(body, ts) },
    signal: ac.signal,
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(resolveParse !== undefined, "the router must have called the channel");

  // A VALID decision — this must be refused for its lateness and nothing else, which is what
  // makes the assertion below mean the deadline rather than a bad payload.
  resolveParse({
    runId: r.runId,
    gateId: r.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:alice", via: "slack" },
    idempotencyKey: "k",
  });
  ac.abort();

  const e = await handled.then(
    (v) => v as unknown,
    (thrown: unknown) => thrown,
  );
  assert.ok(isLoomError(e), `expected a LoomError, got ${String(e)}`);
  assert.equal((e.details as { reason: string }).reason, "timeout");
  await stillOpen(r);
  assert.deepEqual(router.refusals(), [{ channel: "slack", reason: "timeout", count: 1 }]);
});

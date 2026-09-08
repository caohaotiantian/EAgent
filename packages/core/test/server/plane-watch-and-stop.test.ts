/**
 * The control plane's "watch it, stop it" half, and the durable state three doors read.
 *
 * MOST of these reproduce a defect measured against a real socket — the 2026-09-02 audit and
 * the 09-03 re-audit of the fix: a HEAD liveness probe answered 404; a second, DIFFERENT gate
 * decision answered 200 with a decision the journal never recorded; an `Idempotency-Key` that
 * deduplicated only until the process restarted, and then one that stopped working for the
 * life of the process after a single store hiccup; a signed gate callback refused 404 by a
 * plane that did not submit the run, then by a replica the gate was raised after; a boot scan
 * that spent its whole window on gates already answered; a shipped console with no control
 * that stops anything; and a gate queue that refolded every journal it has ever seen on every
 * four-second poll. Four more are measured the same way: two concurrent submissions under one
 * key that minted two runs; a restore scan whose window counted RUNS while the map it fills
 * counts KEYS; one unfoldable journal row that disarmed every gate behind it at boot; and one
 * edit spelled two ways that answered 409 to its own retry.
 *
 * THREE DO NOT, and they say so in their own names rather than being left to look like the
 * others: `A GENUINE RETRY IS STILL ONE DECISION`, `A DIFFERENT EDIT IS STILL A DIFFERENT
 * DECISION` and `THE GRAPH ROUTES ARE OPEN TO EVERY CREDENTIAL` each pass on the tree before
 * the change that added them, and pin a property that change had to preserve. A file where
 * every name reads as "a defect closed" is a file that overstates what it found.
 *
 * A THIRD ALSO PASSES ON THE PRE-CHANGE TREE and is neither of those things.
 * `A RUN SUBMITTED WITH NO HEADER CANNOT BE CLAIMED BY A KEY EQUAL TO ITS RUN ID` passes there
 * VACUOUSLY — nothing restored a key at all, so nothing could be claimed with one. It is a
 * guard on the mechanism this change added, and deleting the run-id skip in
 * `#restoreIdempotency` fails it. "Green on both trees" is therefore not by itself the test
 * for whether a pin is load-bearing; what the mutant does is.
 *
 * They are here rather than in `http.test.ts` so the file that pins the perimeter stays about
 * the perimeter, and so a reader looking for "what the audit closed" finds one place.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BearerTokenIdentity, ControlPlane, type IdentitySource } from "../../src/server/http.ts";
import vm from "node:vm";

import { CONSOLE_HTML } from "../../src/server/console.ts";
import { GateDispatcher, ConsoleChannel, SignedWebhookChannel } from "../../src/run/delivery.ts";
import type { GateId, RunId, Seq } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { StateStore } from "../../src/journal/store.ts";
import { SYSTEM_ACTOR } from "../../src/journal/events.ts";
import { compileSkeleton, harness, skeletonSpec, DOCS } from "../run/skeleton.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";

const NOW = 1_700_000_000_000;
const CALLBACK_SECRET = "shhh";

const json = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;

/** The skeleton with the gate node naming who may answer it, and optionally where it is told. */
function specWithApprovers(approvers: readonly string[], channels?: readonly string[]): GraphSpec {
  const base = skeletonSpec();
  return {
    ...base,
    nodes: base.nodes.map((n) =>
      n.id !== "approve"
        ? n
        : {
            ...n,
            humanGate: {
              ref: n.humanGate!.ref,
              approval: { approvers },
              ...(channels === undefined ? {} : { delivery: { channels } }),
            },
          },
    ),
  };
}

/** Two people, so an approver who is not the run's owner can be told apart from its owner. */
function people(): IdentitySource {
  return new BearerTokenIdentity({
    subjects: [
      { subject: "u:alice", token: "alice-token", via: "console" },
      { subject: "u:bob", token: "bob-token", via: "console" },
    ],
  });
}

interface Rig {
  base: string;
  plane: ControlPlane;
  h: ReturnType<typeof harness>;
  channel: SignedWebhookChannel;
  close: () => Promise<void>;
}

interface RigOptions {
  approvers?: readonly string[];
  channels?: readonly string[];
  identity?: IdentitySource;
  callbacks?: boolean;
  store?: ReturnType<typeof harness>["store"];
}

async function rig(opts: RigOptions = {}): Promise<Rig> {
  const h = harness(opts.store === undefined ? {} : { store: opts.store });
  const graph = compileSkeleton(opts.approvers === undefined ? skeletonSpec() : specWithApprovers(opts.approvers, opts.channels));
  const channel = new SignedWebhookChannel({ name: "slack", url: "https://hooks.example.com/unused", callbackSecret: CALLBACK_SECRET });
  const plane = new ControlPlane({
    engine: h.engine,
    store: h.store,
    bus: h.bus,
    graphs: { "skeleton-summarize": graph },
    now: () => NOW,
    ...(opts.identity === undefined ? {} : { identity: opts.identity }),
    ...(opts.callbacks === true ? { dispatcher: new GateDispatcher({ channels: [channel, new ConsoleChannel()] }) } : {}),
  });
  const { port } = await plane.listen(0);
  return { base: `http://127.0.0.1:${port}`, plane, h, channel, close: () => plane.close() };
}

async function submit(r: Rig, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const res = await fetch(`${r.base}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ workflow: "skeleton-summarize", inputs: { paths: DOCS } }),
  });
  assert.equal(res.status, 202);
  return json(res);
}

/** Poll the JOURNAL for the gate, never a sleep long enough to be a timing assertion. */
async function gateOn(r: Rig, runId: RunId): Promise<GateId> {
  for (let i = 0; i < 400; i++) {
    if ((await r.h.engine.projection(runId))?.status === "awaiting_gate") break;
    await new Promise((x) => setTimeout(x, 10));
  }
  const open = (await r.h.engine.openGates(runId))[0];
  assert.notEqual(open, undefined, "the run must be parked on a gate");
  return open!.gateId;
}

const decidedKinds = async (r: Rig, runId: RunId): Promise<string[]> => {
  const out: string[] = [];
  for await (const e of r.h.store.read(runId, 1 as never)) {
    if (e.type === "gate.decided") out.push(String((e.payload as { decision: string }).decision));
  }
  return out;
};

// ── HEAD /health ─────────────────────────────────────────────────────────────

test("HEAD /health ANSWERS 200 — a liveness endpoint must answer the liveness verb", async () => {
  // `#serve` matched `req.method !== route.method` and every route declares "GET", so the
  // one route that exists because "a load balancer probes it" answered every HEAD probe
  // `404 no route for HEAD /health`. An LB configured `option httpchk HEAD /health` drains
  // every healthy backend: an outage CAUSED by the health check rather than caught by one.
  const r = await rig();
  try {
    const head = await fetch(`${r.base}/health`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length") !== null, true, "…with an accurate content-length");
    assert.equal(await head.text(), "", "…and no body, which node:http suppresses");

    // The mapping is for routes that FINISH. The SSE stream never does, so a HEAD there
    // would hang holding a bus subscription — measured at 4 s and still open — where today
    // it is a clean 404. Widening `method` per route keeps that 404.
    const { runId } = await submit(r);
    const stream = await fetch(`${r.base}/runs/${String(runId)}/events`, { method: "HEAD" });
    assert.equal(stream.status, 404, "HEAD must not reach the stream, which never ends");
    await stream.arrayBuffer();

    // HEAD still cannot reach a POST route.
    assert.equal((await fetch(`${r.base}/runs`, { method: "HEAD" })).status, 404);
  } finally {
    await r.close();
  }
});

// ── the gate door ────────────────────────────────────────────────────────────

test("A SECOND, DIFFERENT DECISION ON ONE GATE IS A CONFLICT — not a 200 echoing a rejection the journal never took", async () => {
  // With no `Idempotency-Key` the slot was `idempotencySlot(auth, String(gateId))`, which
  // carries no decision — so one principal's approve and their later reject hashed to one
  // slot. `#resolveOnce` returns `{resolved:false}` on a seen key BEFORE the
  // `gate.state !== "open"` check, and the route then echoed `decision.kind` off the REQUEST.
  // Measured: `bob reject -> 200 {"decision":"reject"}` against a journal that says approve
  // and a guarded `fs.write` that had already run.
  const r = await rig({ identity: people(), approvers: ["u:bob"] });
  const asAlice = { authorization: "Bearer alice-token" };
  const asBob = { authorization: "Bearer bob-token", "content-type": "application/json" };
  try {
    const { runId } = await submit(r, asAlice);
    const gateId = await gateOn(r, runId as RunId);
    const before = r.h.writes.length;

    const approve = await fetch(`${r.base}/runs/${String(runId)}/gates/${gateId}`, {
      method: "POST",
      headers: asBob,
      body: JSON.stringify({ decision: { kind: "approve" } }),
    });
    assert.equal(approve.status, 200);
    assert.equal((await json(approve))["decision"], "approve");

    const reject = await fetch(`${r.base}/runs/${String(runId)}/gates/${gateId}`, {
      method: "POST",
      headers: asBob,
      body: JSON.stringify({ decision: { kind: "reject", reason: "on second thoughts, NO" } }),
    });
    assert.equal(reject.status, 409, "the gate is decided; a DIFFERENT decision is a conflict");
    assert.equal(((await json(reject))["error"] as { code?: string }).code, "E_GATE_ALREADY_RESOLVED");

    assert.deepEqual(await decidedKinds(r, runId as RunId), ["approve"], "one decision in the journal");
    assert.equal(r.h.writes.length - before, 1, "…and the guarded action ran exactly once");
  } finally {
    await r.close();
  }
});

test("A GENUINE RETRY IS STILL ONE DECISION — the same decision twice is idempotent, with or without a header", async () => {
  // The fix puts the decision in the default slot. The property the slot exists for must
  // survive it: an identical decision replayed by a channel retry is still 200 and still one
  // journal row.
  const r = await rig({ identity: people(), approvers: ["u:bob"] });
  const asBob = { authorization: "Bearer bob-token", "content-type": "application/json" };
  try {
    const { runId } = await submit(r, { authorization: "Bearer alice-token" });
    const gateId = await gateOn(r, runId as RunId);
    const before = r.h.writes.length;
    const body = JSON.stringify({ decision: { kind: "approve" } });
    const once = await fetch(`${r.base}/runs/${String(runId)}/gates/${gateId}`, { method: "POST", headers: asBob, body });
    const twice = await fetch(`${r.base}/runs/${String(runId)}/gates/${gateId}`, { method: "POST", headers: asBob, body });
    assert.equal(once.status, 200);
    assert.equal(twice.status, 200, "the SAME decision replayed is the case the key exists for");
    assert.deepEqual(await decidedKinds(r, runId as RunId), ["approve"]);
    assert.equal(r.h.writes.length - before, 1);
  } finally {
    await r.close();
  }
});

test("ONE EDIT SPELLED TWO WAYS IS ONE DECISION — the default slot was derived over the caller's key order", async () => {
  // The default slot is `gateId:<the decision>`, and the decision was rendered with
  // `JSON.stringify` over an object whose `writes` is the CALLER'S own object, carried through
  // by reference. So the byte order of the request decided the slot: the same edit re-sent
  // with its channel value spelled in the other order was a different key, fell through to the
  // gate's own state check, and answered 409 to a genuine retry. Measured on this gate:
  // `{"merged":{"a":1,"b":2}}` → 200, the same edit as `{"merged":{"b":2,"a":1}}` → 409
  // E_GATE_ALREADY_RESOLVED.
  const r = await rig({ identity: people(), approvers: ["u:bob"] });
  const asBob = { authorization: "Bearer bob-token", "content-type": "application/json" };
  const edit = (writes: unknown): Promise<Response> =>
    fetch(`${r.base}/runs/${String(runId)}/gates/${gateId}`, {
      method: "POST",
      headers: asBob,
      body: JSON.stringify({ decision: { kind: "edit", writes } }),
    });
  let runId: string;
  let gateId: GateId;
  try {
    runId = String((await submit(r, { authorization: "Bearer alice-token" }))["runId"]);
    gateId = await gateOn(r, runId as RunId);
    // `merged` because it is what this gate's `allowEdit` permits; the ordering is inside it.
    assert.equal((await edit({ merged: { a: 1, b: 2 } })).status, 200);
    assert.equal((await edit({ merged: { b: 2, a: 1 } })).status, 200, "the same edit, spelled the other way round, is the same decision");
    assert.deepEqual(await decidedKinds(r, runId as RunId), ["edit"], "and it was decided once");
  } finally {
    await r.close();
  }
});

test("A DECISION CANONICAL FORM REFUSES IS THE CALLER'S 400, NOT THE SERVER'S 500", async () => {
  // Deriving the slot canonically is what makes one decision one key — and `canonicalize`
  // refuses what it cannot order, which is right, because the journal this decision is about to
  // be written to refuses it too. But a `CanonicalizationError` is not a `LoomError`, so
  // `httpStatusFor` read no class off it and the route answered 500 for a body the caller wrote.
  // `1e999` parses to `Infinity`; `JSON.stringify` used to render it as `null` and let it
  // through. An internal error says the SERVER is broken, and it is not.
  const r = await rig({ identity: people(), approvers: ["u:bob"] });
  const asBob = { authorization: "Bearer bob-token", "content-type": "application/json" };
  try {
    const runId = String((await submit(r, { authorization: "Bearer alice-token" }))["runId"]);
    const gateId = await gateOn(r, runId as RunId);
    const res = await fetch(`${r.base}/runs/${runId}/gates/${gateId}`, {
      method: "POST",
      headers: asBob,
      // Not `JSON.stringify` of an object: `Infinity` cannot survive that. This is the wire.
      body: '{"decision":{"kind":"edit","writes":{"merged":{"a":1e999}}}}',
    });
    assert.equal(res.status, 400, "a body the caller wrote is the caller's error");
    const body = (await res.json()) as { error?: { code?: string } };
    assert.notEqual(body.error?.code, "E_INTERNAL", `and it is not reported as an internal fault: ${JSON.stringify(body)}`);

    // THE ORDINARY HALF: the gate is untouched and still answerable. A refusal that also
    // consumed the decision would be worse than the 500.
    assert.deepEqual(await decidedKinds(r, runId as RunId), [], "the refused decision decided nothing");
    const ok = await fetch(`${r.base}/runs/${runId}/gates/${gateId}`, {
      method: "POST",
      headers: asBob,
      body: JSON.stringify({ decision: { kind: "edit", writes: { merged: { a: 1 } } } }),
    });
    assert.equal(ok.status, 200, "and an ordinary edit on the same gate still lands");
  } finally {
    await r.close();
  }
});

test("A DIFFERENT EDIT IS STILL A DIFFERENT DECISION — the slot narrows a retry, it does not swallow a second answer", async () => {
  // The ORDINARY half of the test above, and the property the canonical rendering must not
  // trade away: two edits that differ in a VALUE are two decisions, so the second one meets
  // the gate's own state check and is refused rather than being reported as this caller's own
  // successful edit.
  const r = await rig({ identity: people(), approvers: ["u:bob"] });
  const asBob = { authorization: "Bearer bob-token", "content-type": "application/json" };
  try {
    const { runId } = await submit(r, { authorization: "Bearer alice-token" });
    const gateId = await gateOn(r, runId as RunId);
    const edit = (writes: unknown): Promise<Response> =>
      fetch(`${r.base}/runs/${String(runId)}/gates/${gateId}`, { method: "POST", headers: asBob, body: JSON.stringify({ decision: { kind: "edit", writes } }) });
    assert.equal((await edit({ merged: { a: 1 } })).status, 200);
    const second = await edit({ merged: { a: 2 } });
    assert.equal(second.status, 409, "a second, DIFFERENT decision is a conflict this caller can see");
    assert.deepEqual(await decidedKinds(r, runId as RunId), ["edit"]);
  } finally {
    await r.close();
  }
});

// ── submission idempotency across a restart ──────────────────────────────────

test("AN Idempotency-Key SURVIVES A RESTART — the journal already carries it, and nothing read it", async () => {
  // `#idempotency` is a process-local Map. `run.submitted.idempotencyKey` is journaled on
  // every run and was read by nothing, so a retry that crossed a process boundary minted a
  // second run — every irreversible tool call twice. Measured across two OS processes over
  // one SQLite journal: same key, same principal, two runs.
  const first = await rig();
  let firstRunId: string;
  try {
    firstRunId = String((await submit(first, { "idempotency-key": "nightly-2026-09-02" }))["runId"]);
  } finally {
    await first.close();
  }

  // A restart: a FRESH Engine and a FRESH plane over the same journal.
  const second = await rig({ store: first.h.store });
  try {
    const retry = await submit(second, { "idempotency-key": "nightly-2026-09-02" });
    assert.equal(retry["runId"], firstRunId, "the retry must be handed the ORIGINAL run");
    assert.equal((await second.h.store.listRuns(100)).length, 1, "…and must create nothing");
  } finally {
    await second.close();
  }
});

test("A REBUILT KEY IS NAMESPACED BY PRINCIPAL — one team's `nightly` never claims another's run", async () => {
  // The rebuilt entry has to reproduce `idempotencySlot`, whose whole content is that the
  // header alone is a shared namespace. Every component is journaled: `run.submitted`
  // carries `submittedBy: {kind, subject, method}` and the key itself.
  const first = await rig({ identity: people() });
  let hers: string;
  try {
    hers = String((await submit(first, { authorization: "Bearer alice-token", "idempotency-key": "nightly" }))["runId"]);
  } finally {
    await first.close();
  }
  const second = await rig({ store: first.h.store, identity: people() });
  try {
    const theirs = await submit(second, { authorization: "Bearer bob-token", "idempotency-key": "nightly" });
    assert.notEqual(theirs["runId"], hers, "u:bob must not be handed u:alice's run after a restart");
    const back = await submit(second, { authorization: "Bearer alice-token", "idempotency-key": "nightly" });
    assert.equal(back["runId"], hers, "…while alice's own retry still collapses");
    assert.equal((await second.h.store.listRuns(100)).length, 2);
  } finally {
    await second.close();
  }
});

test("A RUN SUBMITTED WITH NO HEADER CANNOT BE CLAIMED BY A KEY EQUAL TO ITS RUN ID", async () => {
  // `Engine.submit` journals `idempotencyKey: input.idempotencyKey ?? runId`, so every run
  // carries a key whether or not a caller sent one. Rebuilding those entries would let a
  // caller present a run id as an `Idempotency-Key` and be handed somebody else's run.
  const first = await rig();
  let runId: string;
  try {
    runId = String((await submit(first))["runId"]);
  } finally {
    await first.close();
  }
  const second = await rig({ store: first.h.store });
  try {
    const claimed = await submit(second, { "idempotency-key": runId });
    assert.notEqual(claimed["runId"], runId, "a run id is not an idempotency key anyone may present");
    assert.equal((await second.h.store.listRuns(100)).length, 2);
  } finally {
    await second.close();
  }
});

test("ONE TRANSIENT STORE ERROR DOES NOT KILL EVERY KEYED SUBMIT FOR THE LIFE OF THE PROCESS", async () => {
  // `#idempotencyRestored ??= (async () => …)()` memoised the PROMISE, and a rejected promise
  // stays rejected. So one `listRuns` failure — a SQLITE_BUSY, a reconnect, one odd row —
  // turned every later submission carrying an `Idempotency-Key` into 500 E_INTERNAL quoting a
  // store error that was long gone, with `retryable:false` so a well-behaved client stops
  // retrying, PERMANENTLY, while unkeyed submits and /health stayed green.
  //
  // Refusing the first one is right and does not change: falling through to `engine.submit`
  // on a scan that did not finish is the duplicate run the scan exists to prevent. What
  // changes is that the NEXT request gets to try.
  const inner = new MemoryStateStore({ now: () => NOW });
  let failNextList = false;
  const store: StateStore = {
    append: (i) => inner.append(i),
    read: (runId, from, to) => inner.read(runId, from, to),
    head: (runId) => inner.head(runId),
    listRuns: async (limit, filter) => {
      if (failNextList) {
        failNextList = false;
        throw new Error("SQLITE_BUSY: database is locked");
      }
      return inner.listRuns(limit, filter);
    },
    close: () => inner.close(),
  };

  const r = await rig({ store });
  try {
    failNextList = true;
    const boom = await fetch(`${r.base}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "nightly" },
      body: JSON.stringify({ workflow: "skeleton-summarize", inputs: { paths: DOCS } }),
    });
    assert.equal(boom.status, 500, "a scan that did not finish must refuse rather than risk a duplicate run");
    assert.equal(failNextList, false, "…and it must be THIS request's scan that consumed the failure");

    // THE ORDINARY CASE, measured beside the defect one: everything that does not read the
    // map stayed green throughout, which is what made this survivable for so long.
    assert.equal((await fetch(`${r.base}/health`)).status, 200);
    const unkeyed = await submit(r);

    // The store is healthy again, and the very next keyed submit must scan again rather than
    // be handed a rejection from a request that is over.
    const first = await submit(r, { "idempotency-key": "nightly" });
    assert.notEqual(first["runId"], unkeyed["runId"]);

    // And what it rebuilt is the real map, not an empty one that merely stopped throwing.
    assert.equal((await submit(r, { "idempotency-key": "nightly" }))["runId"], first["runId"], "the key still collapses");
    assert.equal((await inner.listRuns(100)).length, 2, "one unkeyed run and one keyed run — nothing minted twice");
  } finally {
    await r.close();
  }
});

test("TWO CONCURRENT SUBMISSIONS UNDER ONE KEY ARE ONE RUN", async () => {
  // The handler read the slot, awaited the journal scan, and only recorded the slot after
  // `engine.submit` returned. Everything in between is a window in which a second request
  // carrying the same key read the same empty slot and submitted too — two runs, each with
  // every irreversible tool call and every provider charge of the other, out of the one
  // header whose entire job is that this cannot happen.
  //
  // THE WINDOW IS HELD OPEN BY A BARRIER: this store does not answer `listRuns` until the
  // plane has authenticated two requests, so the second one is inside the door while the
  // first is still scanning. The barrier is released from inside the second request's own
  // identify call, which is BEFORE it has read its body, so the release also yields the event
  // loop until that read has happened — a count of turns, not a duration, and none of it is
  // asserted on. Measured on the pre-change tree: 202 202, two distinct run ids, two runs in
  // the journal; measured here, with the yield removed, the second request lost the race and
  // this test passed on both trees.
  const inner = new MemoryStateStore({ now: () => NOW });
  let identified = 0;
  let bothArrived!: () => void;
  const arrived = new Promise<void>((resolve) => (bothArrived = resolve));
  const store: StateStore = {
    append: (i) => inner.append(i),
    read: (runId, from, to) => inner.read(runId, from, to),
    head: (runId) => inner.head(runId),
    listRuns: async (limit, filter) => {
      // NOT the boot arm's listing — `listen()` awaits that one, so holding it would park the
      // plane before either request exists.
      if (filter?.raisedAGate !== true) await arrived;
      return inner.listRuns(limit, filter);
    },
    close: () => inner.close(),
  };
  const known = people();
  const identity: IdentitySource = {
    name: "counting",
    identify: (req) => {
      // The SECOND request has arrived; give the loop enough turns for it to finish reading
      // its body and reach the slot, then let the first request's scan answer.
      if (++identified >= 2) {
        void (async () => {
          for (let turn = 0; turn < 20; turn++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
          bothArrived();
        })();
      }
      return known.identify(req);
    },
  };
  const r = await rig({ store, identity });
  const keyed = (key: string): Promise<Response> =>
    fetch(`${r.base}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer alice-token", "idempotency-key": key },
      body: JSON.stringify({ workflow: "skeleton-summarize", inputs: { paths: DOCS } }),
    });
  try {
    const [a, b] = await Promise.all([keyed("nightly"), keyed("nightly")]);
    assert.equal(a.status, 202);
    assert.equal(b.status, 202);
    const [ja, jb] = [await json(a), await json(b)];
    assert.equal(ja["runId"], jb["runId"], "one key, one run — the later caller is handed the first request's answer");
    assert.equal((await inner.listRuns(100)).length, 1, "…and nothing was submitted twice");

    // THE ORDINARY CASES, beside the defect one. A retry after both have answered still
    // collapses onto that run, and a key nobody has used still gets a run of its own — a
    // claim that never cleared would break both.
    assert.equal((await json(await keyed("nightly")))["runId"], ja["runId"], "a later retry still collapses");
    assert.notEqual((await json(await keyed("weekly")))["runId"], ja["runId"], "and a different key is a different run");
    assert.equal((await inner.listRuns(100)).length, 2);
  } finally {
    await r.close();
  }
});

/** A run submitted with NO `Idempotency-Key`: it fills a row of the restore scan and restores nothing. */
async function headerlessRun(store: StateStore, n: number, ts: number): Promise<void> {
  // The id sorts above a ULID, so these are the NEWEST runs in a `run_id DESC` listing.
  const runId = `zz-${String(n).padStart(6, "0")}` as RunId;
  await store.append({
    runId,
    expectedSeq: 0 as Seq,
    now: ts,
    events: [
      {
        type: "run.submitted",
        // `Engine.submit` journals `idempotencyKey: input.idempotencyKey ?? runId`, so a run
        // submitted with no header carries its own id — which the scan skips.
        payload: { workflow: "skeleton-summarize", inputs: {}, graphHash: "sha256:absent", idempotencyKey: runId, configDigest: "sha256:absent" },
        actor: SYSTEM_ACTOR("test"),
      },
    ],
  });
}

test("THE RESTORE SCAN PAGES PAST HEADER-LESS RUNS — its window counted runs while the map counts keys", async () => {
  // `listRuns(MAX_IDEMPOTENT_SUBMITS)` reads as "the scan covers what the map holds" and does
  // not: the map counts KEYED submissions and a listing counts RUNS. So on a plane where most
  // submissions carry no header, the whole budget goes on rows that restore nothing, and the
  // key that a restart was supposed to survive is behind them. Measured: one keyed run, then
  // 10 000 header-less ones, then a restart and a retry of that key — a SECOND run.
  const first = await rig();
  let firstRunId: string;
  try {
    firstRunId = String((await submit(first, { "idempotency-key": "nightly" }))["runId"]);
  } finally {
    await first.close();
  }

  // THE ORDINARY CASE — a restart with nothing in front of the keyed run.
  const plain = await rig({ store: first.h.store });
  try {
    assert.equal((await submit(plain, { "idempotency-key": "nightly" }))["runId"], firstRunId);
    assert.equal((await first.h.store.listRuns(100_000)).length, 1);
  } finally {
    await plain.close();
  }

  // AND THE DEFECT ONE — `MAX_IDEMPOTENT_SUBMITS` header-less runs, every one of them newer.
  for (let i = 0; i < 10_000; i++) await headerlessRun(first.h.store, i, NOW + 1_000 + i);
  const buried = await rig({ store: first.h.store });
  try {
    assert.equal(
      (await first.h.store.listRuns(10_000)).some((s) => String(s.runId) === firstRunId),
      false,
      "the keyed run is past the window the un-paged scan read, which is what made this reachable",
    );
    assert.equal((await submit(buried, { "idempotency-key": "nightly" }))["runId"], firstRunId, "…and the paged scan still reaches it");
    assert.equal((await first.h.store.listRuns(100_000)).length, 10_001, "nothing minted a second run");
  } finally {
    await buried.close();
  }
});

// ── the unauthenticated callback ─────────────────────────────────────────────

test("A SIGNED GATE CALLBACK IS ANSWERED BY A PLANE THAT DID NOT SUBMIT THE RUN", async () => {
  // The gate-callback route is the only run-scoped write that never bound the run to its
  // graph, so on any plane that did not itself submit the run — after a restart, a deploy,
  // or on a second replica — a correctly signed approval on the published URL answered 404
  // and journaled a FALSE `gate.callback_rejected {reason:"not_found"}` while the gate was
  // open and on its expiry clock.
  const first = await rig({ callbacks: true, approvers: ["u:alice"], channels: ["slack"], identity: people() });
  let runId: string;
  try {
    runId = String((await submit(first, { authorization: "Bearer alice-token" }))["runId"]);
    await gateOn(first, runId as RunId);
  } finally {
    await first.close();
  }

  const second = await rig({ store: first.h.store, callbacks: true, approvers: ["u:alice"], channels: ["slack"], identity: people() });
  try {
    const p = await second.h.engine.projection(runId as RunId);
    assert.equal(p?.status, "awaiting_gate", "the gate is still open on the restarted plane");
    const gateId = Object.values(p!.gates).find((g) => g.state === "open")!.gateId;

    const body = JSON.stringify({ runId, gateId, actor: "u:alice", decision: { kind: "approve" } });
    const ts = String(Math.floor(NOW / 1000));
    const res = await fetch(`${second.base}/runs/${runId}/callbacks/slack`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-loom-timestamp": ts, "x-loom-signature": second.channel.sign(body, ts) },
      body,
    });
    assert.equal(res.status, 200, await res.text());

    const rejects: unknown[] = [];
    for await (const e of second.h.store.read(runId as RunId, 1 as never)) {
      if (e.type === "gate.callback_rejected") rejects.push(e.payload);
    }
    assert.deepEqual(rejects, [], "no false rejection row for a callback that verified");
  } finally {
    await second.close();
  }
});

/**
 * A gated run that is DONE with its gate — the shape that fills the boot scan's window.
 *
 * `raisedAGate` means "has EVER raised one", and the listing is ordered by the most recent
 * `gate.raised`, so on any deployment that uses gates these outnumber the open ones by
 * whatever the ratio of finished to live runs is. Folded status is `queued`, which is what
 * `#armGatedRuns` throws each one away for after paying for the fold.
 */
async function decidedGatedRun(store: StateStore, n: number, ts: number): Promise<void> {
  await store.append({
    runId: `decided-${String(n).padStart(4, "0")}` as RunId,
    expectedSeq: 0 as Seq,
    now: ts,
    events: [
      {
        type: "run.submitted",
        payload: { workflow: "skeleton-summarize", inputs: {}, graphHash: "sha256:absent", idempotencyKey: `decided-${n}`, configDigest: "sha256:absent" },
        actor: SYSTEM_ACTOR("test"),
      },
      {
        type: "gate.raised",
        payload: { gateId: `g-${n}` as GateId, nodeId: "approve" as never, policyRef: "policy/x@1", contentDigest: "sha256:absent" },
        actor: SYSTEM_ACTOR("test"),
      },
      { type: "gate.decided", payload: { gateId: `g-${n}` as GateId, decision: "approve", latencyMs: 1 }, actor: { kind: "human", subject: "u:alice", via: "api" } },
    ],
  });
}

test("THE BOOT ARM PAGES PAST DECIDED GATES — its 500-run window was spent on runs that had already been answered", async () => {
  // `listRuns(MAX_QUEUE_SCAN, { raisedAGate: true })` read 500 rows and then discarded
  // everything not `awaiting_gate`. On a deployment that uses gates, that budget goes almost
  // entirely on finished runs: with 600 newer decided gates in the journal, a plain restart
  // left a genuinely OPEN gate unarmed — no bound graph, no rehydrated gate clock, so nothing
  // in the process to escalate or expire it.
  //
  // `rehydrateGates` is the probe because it is the thing the arm is FOR: it throws
  // E_RUN_NOT_FOUND on a run this engine has not attached, and returns the count of gates it
  // re-armed on one it has.
  const first = await rig({ approvers: ["u:alice"], identity: people() });
  let runId: RunId;
  try {
    runId = String((await submit(first, { authorization: "Bearer alice-token" }))["runId"]) as RunId;
    await gateOn(first, runId);
  } finally {
    await first.close();
  }

  // THE ORDINARY CASE — one page, nothing in front of the open gate.
  const plain = await rig({ store: first.h.store, approvers: ["u:alice"], identity: people() });
  try {
    assert.equal(await plain.h.engine.rehydrateGates(runId), 1, "a restart with a short journal arms the open gate");
  } finally {
    await plain.close();
  }

  // AND THE DEFECT ONE — 600 decided gates, every one of them newer.
  for (let i = 0; i < 600; i++) await decidedGatedRun(first.h.store, i, NOW + 1_000 + i);
  const buried = await rig({ store: first.h.store, approvers: ["u:alice"], identity: people() });
  try {
    assert.equal(
      // 500 is `MAX_QUEUE_SCAN`, the window the un-paged version read and stopped at.
      (await buried.h.store.listRuns(500, { raisedAGate: true })).some((s) => s.runId === runId),
      false,
      "the open gate is past the first page, which is what made this reachable",
    );
    assert.equal(await buried.h.engine.rehydrateGates(runId), 1, "…and the paged arm still reaches it");
  } finally {
    await buried.close();
  }
});

/**
 * A run that raised a gate and whose journal this binary cannot fold.
 *
 * ONE ROW DOES IT: `state.reduced`'s fold iterates `payload.channels`, so a payload whose
 * `channels` is not iterable throws out of `projection`. A future version's event, a row
 * written by hand, a payload shape this binary predates — the arm has no business deciding
 * which, and every one of them is one run's problem.
 */
async function unfoldableGatedRun(store: StateStore, ts: number): Promise<void> {
  await store.append({
    runId: "zz-unfoldable" as RunId,
    expectedSeq: 0 as Seq,
    now: ts,
    events: [
      {
        type: "run.submitted",
        payload: { workflow: "skeleton-summarize", inputs: {}, graphHash: "sha256:absent", idempotencyKey: "zz-unfoldable", configDigest: "sha256:absent" },
        actor: SYSTEM_ACTOR("test"),
      },
      {
        type: "gate.raised",
        payload: { gateId: "g-zz" as GateId, nodeId: "approve" as never, policyRef: "policy/x@1", contentDigest: "sha256:absent" },
        actor: SYSTEM_ACTOR("test"),
      },
      { type: "state.reduced", payload: { channels: 7 } as never, actor: SYSTEM_ACTOR("test") },
    ],
  });
}

test("ONE UNFOLDABLE RUN DOES NOT DISARM THE GATES BEHIND IT", async () => {
  // The whole paging walk sat in one `try`, and the fold that decides whether a run is still
  // waiting sat inside it — so the first row this binary cannot fold ended the scan for every
  // run behind it, silently, at boot. It sorts ahead by construction: `raisedAGate` orders by
  // the most recent `gate.raised`. Measured on one plane over one journal: the open gate
  // armed on a clean journal, and the SAME gate unarmed with one unfoldable run appended.
  //
  // `rehydrateGates` is the probe because it is what the arm is FOR: it throws
  // E_RUN_NOT_FOUND on a run this engine has not attached, and answers the count of gate
  // clocks it re-armed on one it has.
  const first = await rig({ approvers: ["u:alice"], identity: people() });
  let runId: RunId;
  try {
    runId = String((await submit(first, { authorization: "Bearer alice-token" }))["runId"]) as RunId;
    await gateOn(first, runId);
  } finally {
    await first.close();
  }
  const armedAtBoot = async (): Promise<string[]> => {
    const r = await rig({ store: first.h.store, approvers: ["u:alice"], identity: people() });
    try {
      return (await r.h.engine.rehydrateGates(runId)) > 0 ? [String(runId)] : [];
    } catch {
      return [];
    } finally {
      await r.close();
    }
  };

  // THE ORDINARY CASE — a clean journal, one open gate, armed.
  assert.deepEqual(await armedAtBoot(), [String(runId)]);

  // AND THE DEFECT ONE — the same journal with one unfoldable run in front.
  await unfoldableGatedRun(first.h.store, NOW + 5_000);
  assert.deepEqual(
    (await first.h.store.listRuns(10, { raisedAGate: true })).map((s) => String(s.runId)),
    ["zz-unfoldable", String(runId)],
    "the unfoldable run is ahead of the open gate, which is what made this reachable",
  );
  assert.deepEqual(await armedAtBoot(), [String(runId)], "the run behind it is still armed");
});

test("A SECOND REPLICA ANSWERS A GATE RAISED AFTER IT BOOTED — the boot scan is a warm start, not the perimeter", async () => {
  // The arm was a one-shot at `listen()`. Behind a load balancer the published callback URL
  // is sprayed across replicas, so a gate raised on replica A after replica B booted is not
  // in B's scan and never will be: B answered 404 E_RUN_NOT_FOUND and wrote a durable
  // `gate.callback_rejected {reason:"not_found"}` while the gate was open and on its expiry
  // clock. That is the deployment `#armGatedRuns` names as its own motivation.
  const a = await rig({ callbacks: true, approvers: ["u:alice"], channels: ["slack"], identity: people() });
  // B boots over the SAME journal while it is still empty. Nothing to arm, and nothing that
  // will ever be armed at boot again.
  const b = await rig({ store: a.h.store, callbacks: true, approvers: ["u:alice"], channels: ["slack"], identity: people() });
  const post = async (rig_: Rig, runId: string, gateId: GateId): Promise<Response> => {
    const body = JSON.stringify({ runId, gateId, actor: "u:alice", decision: { kind: "approve" } });
    const ts = String(Math.floor(NOW / 1000));
    return fetch(`${rig_.base}/runs/${runId}/callbacks/slack`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-loom-timestamp": ts, "x-loom-signature": rig_.channel.sign(body, ts) },
      body,
    });
  };
  const rejections = async (store: Rig["h"]["store"], runId: RunId): Promise<unknown[]> => {
    const out: unknown[] = [];
    for await (const e of store.read(runId, 1 as Seq)) if (e.type === "gate.callback_rejected") out.push(e.payload);
    return out;
  };
  try {
    // THE ORDINARY CASE: the plane that submitted the run answers its own callback, which is
    // every single-process deployment and must not have been traded away for the replica.
    const own = String((await submit(a, { authorization: "Bearer alice-token" }))["runId"]) as RunId;
    const ownGate = await gateOn(a, own);
    const owned = await post(a, own, ownGate);
    assert.equal(owned.status, 200, await owned.text());
    assert.deepEqual(await rejections(a.h.store, own), []);

    // AND THE REPLICA: raised on A, minutes after B booted, answered on B.
    const runId = String((await submit(a, { authorization: "Bearer alice-token" }))["runId"]) as RunId;
    const gateId = await gateOn(a, runId);
    const res = await post(b, runId, gateId);
    assert.equal(res.status, 200, await res.text());
    assert.deepEqual(await rejections(b.h.store, runId), [], "no false rejection row for a callback that verified");
    assert.deepEqual(await decidedKinds(b, runId), ["approve"], "…and the decision the vendor sent is the one on the record");
  } finally {
    await b.close();
    await a.close();
  }
});

// ── the console ──────────────────────────────────────────────────────────────

test("THE CONSOLE CAN STOP A RUN — the goal's fifth verb had no control on the shipped page", async () => {
  // `POST /runs/:id/commands` implements cancel, pause, resume, steer, rewind and advance,
  // and the console referenced that route zero times: it could submit, watch, approve and
  // reject. CLAUDE.md's goal sentence lists five verbs and the UI implemented three.
  assert.match(CONSOLE_HTML, /\/commands/, "the page must reach the commands route");
  for (const kind of ["cancel", "pause", "resume", "advance"]) {
    assert.match(CONSOLE_HTML, new RegExp(`kind: *"${kind}"|"${kind}"`), `the page must offer ${kind}`);
  }

  // And it must be able to DISPLAY a pause, which is the half the verifier amplified:
  // `applySnapshot` never read `run.paused` and `applyEvent` handled neither
  // `run.suspended` nor `run.resumed`, so a run paused from the CLI looked identical to one
  // that had silently stalled.
  assert.match(CONSOLE_HTML, /current\.paused = /, "applySnapshot must read run.paused");
  assert.match(CONSOLE_HTML, /run\.suspended/, "applyEvent must handle run.suspended");
  assert.match(CONSOLE_HTML, /run\.resumed/, "applyEvent must handle run.resumed");
});

test("THE RUN LIST ESCAPES ITS SERVER VALUES — one unescaped insertion among a dozen escaped ones", async () => {
  // `loadRuns` built `'<code>' + r.runId.slice(0,12) + '</code>…' + r.headSeq` with no
  // `esc()`, the one unescaped server value on a page that holds the operator's bearer token
  // in `localStorage` and has approve buttons wired to it. Safe only because run ids are
  // engine-minted ULIDs — a property of the ID FORMAT, not of the code.
  const bare = CONSOLE_HTML.split("\n").filter((l) => /innerHTML *= /.test(l) && /\+ *[a-z]\.[a-zA-Z]/.test(l) && !/esc\(/.test(l));
  assert.deepEqual(bare, [], "every innerHTML that concatenates a server field must route it through esc()");
});

/**
 * The console's own script, running against a live plane.
 *
 * NOT A BROWSER, and it does not pretend to be one: the DOM here is a bag of properties, so
 * nothing about rendering is under test. What IS under test is the half a `assert.match` on
 * the HTML cannot reach — that `command()` builds the right request, sends the credential the
 * page holds, and applies the reply the route sends back. A test that issues the request
 * ITSELF pins the route, which `http.test.ts` already does; only this pins the page.
 *
 * `alert` and the timer are captured rather than ignored. The page reports every failure
 * through `alert(e.message)` and repaints through a 60 ms `setTimeout`, so an error in either
 * is the page not working — silently, if nothing is watching.
 */
interface Page {
  run: (expr: string) => Promise<unknown>;
  alerts: string[];
  errors: string[];
  answers: string[];
}

function openConsole(base: string, token: string, answer: () => string): Page {
  const script = CONSOLE_HTML.split("<script>")[1]!.split("</script>")[0]!;
  const alerts: string[] = [];
  const errors: string[] = [];
  const answers: string[] = [];
  const elements = new Map<string, Record<string, unknown>>();
  const element = (): Record<string, unknown> => {
    const children: Record<string, unknown>[] = [];
    // `innerHTML` is a real setter here, not a plain field. `drawControls` and the non-empty
    // branch of `drawGates` each clear it to `""` and then re-populate via `appendChild` —
    // exactly what a browser's `innerHTML = ""` does by removing every child node first.
    // Without this, a SECOND render of the same cached element (this mock reuses one object
    // per id — see `getElementById` below) appends onto whatever the first render already
    // left in `children`, instead of replacing it. That is what produced
    // `pause,advance,cancel,pause,advance,cancel`: `command()`'s own coalescing timer
    // (`invalidate()`, 60 ms) can fire a stray extra `draw()` after the last `command()` call
    // and before the test's own explicit render, and the mock's un-cleared `children` array
    // accumulated it. See `.agent/flake/plan.md` for the full trace.
    let html = "";
    const el: Record<string, unknown> = {
      textContent: "",
      title: "",
      className: "",
      value: "",
      placeholder: "",
      onclick: null,
      onchange: null,
      children,
      appendChild: (c: Record<string, unknown>) => void children.push(c),
      // `drawGates` calls `actions.append(yes, no)` (plural, `Element.append`), not
      // `appendChild` — a real DOM element has both, and this mock previously had neither
      // defined for `append`, which threw `TypeError: actions.append is not a function` the
      // moment a leftover `draw()` (the same coalescing-timer race above) landed while a gate
      // was open. That is a SECOND, independent way the same test could fail under load;
      // confirmed reachable by forcing a run to `awaiting_gate` before issuing any command and
      // calling `draw()` directly, which threw exactly that error before this line existed.
      append: (...cs: Record<string, unknown>[]) => void children.push(...cs),
    };
    Object.defineProperty(el, "innerHTML", {
      get: () => html,
      set: (v: string) => { html = String(v); children.length = 0; },
      enumerable: true,
      configurable: true,
    });
    return el;
  };
  const store = new Map<string, string>([["loom.token", token]]);
  const ctx = vm.createContext({
    document: {
      getElementById: (id: string) => {
        const found = elements.get(id) ?? element();
        elements.set(id, found);
        return found;
      },
      createElement: () => element(),
    },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    // RELATIVE, exactly as the page writes them — the base is the browser's, not the page's.
    fetch: (path: string, init?: RequestInit) => fetch(base + String(path), init),
    // Contained rather than ignored: a throw inside a repaint is an uncaught exception that
    // would take down the test file with no attribution.
    setTimeout: (fn: () => void, ms: number) => setTimeout(() => { try { fn(); } catch (e) { errors.push(String(e)); } }, ms),
    // A NO-OP. The page's 4 s poll would outlive the test and keep the process alive.
    setInterval: () => 0,
    AbortController,
    TextDecoder,
    alert: (m: string) => void alerts.push(String(m)),
    prompt: () => { const a = answer(); answers.push(a); return a; },
    console,
  });
  vm.runInContext(script, ctx);
  return { run: async (expr) => vm.runInContext(expr, ctx), alerts, errors, answers };
}

test("THE CONSOLE'S OWN command() STOPS A RUN — the page's script, not a request written by the test", async () => {
  // This used to drive `POST /runs/:id/commands` with `fetch` written here, which pins the
  // ROUTE — and `http.test.ts` already pins the route. Every defect in the console half
  // (a missing credential, a body the route refuses, a reply `applySnapshot` drops on the
  // floor) survived it. So the page's own script runs, and the page's own `command()` is
  // what issues the three requests.
  const r = await rig({ identity: people() });
  try {
    const { runId } = await submit(r, { authorization: "Bearer alice-token" });
    const page = openConsole(r.base, "alice-token", () => "wrong inputs");
    const select = `selected = ${JSON.stringify(String(runId))};`;

    // PAUSE, and the page must SHOW it — `applySnapshot` dropped `run.paused`, so a paused
    // run looked identical to one that had silently stalled.
    assert.equal(await page.run(`(async () => { ${select} await command("pause", "paused from the console"); return current.paused; })()`), true);
    assert.equal((await r.h.engine.projection(runId as RunId))?.paused, true, "…and the journal agrees");

    assert.equal(await page.run(`(async () => { await command("resume", "carry on"); return current.paused; })()`), false);
    assert.equal((await r.h.engine.projection(runId as RunId))?.paused, false);

    // CANCEL through the BUTTON's own handler, prompt and all — the reason it asks for is
    // journaled on `operator.command` and quoted into every gate the cancel closes, and
    // asking IS the confirmation, so a cancel that skipped the prompt would be a different
    // control from the one the page ships.
    assert.equal(
      await page.run(`(() => { drawControls(); return $("controls").children.map((b) => b.textContent).join(","); })()`),
      "pause,advance,cancel",
      "a running, unpaused run offers exactly these three",
    );
    // The handler is a plain `onclick` and returns no promise — a button cannot be awaited —
    // so this polls the page's own state the way `gateOn` polls the journal, bounded.
    await page.run(`$("controls").children[2].onclick()`);
    assert.deepEqual(page.answers, ["wrong inputs"], "the cancel button asked for its reason");
    for (let i = 0; i < 400 && (await page.run(`current.status`)) !== "cancelled"; i++) await new Promise((x) => setTimeout(x, 10));
    assert.equal(await page.run(`current.status`), "cancelled");
    assert.equal((await r.h.engine.projection(runId as RunId))?.status, "cancelled");

    assert.deepEqual(page.alerts, [], "the page must have reported no failure to the operator");
    assert.deepEqual(page.errors, [], "…and nothing must have thrown out of a repaint");
  } finally {
    await r.close();
  }
});

/**
 * A0.18 · TODO.md — pinned deterministically, not by looping the suite.
 *
 * "THE CONSOLE'S OWN command() STOPS A RUN" once collected
 * `'pause,advance,cancel,pause,advance,cancel'` instead of `'pause,advance,cancel'`, one failure
 * in six full-suite runs and none in isolation — a flake, not a deterministic defect on its own.
 * `.agent/flake/plan.md` traces the cause: `command()`'s coalescing timer (`invalidate()`, a
 * real 60 ms `setTimeout` in this harness) can fire a stray extra `draw()` after the last
 * `command()` call and before the test's own explicit render, under load, and the harness's DOM
 * mock never cleared an element's `children` on `innerHTML = ""` the way a real browser does —
 * so that second, otherwise-benign render ACCUMULATED into the collection instead of replacing
 * it. A second, independent way the same stray `draw()` could fail this test is also fixed
 * alongside it: `drawGates`'s `actions.append(yes, no)` had no mock counterpart at all (only
 * `appendChild` existed), which threw the moment that stray render landed while a gate was
 * open — reachable in the ordinary run this file submits, since it reaches its `approve` gate
 * well within this test's own timeline. See `openConsole`'s `element()` for both.
 *
 * This test forces the first failure mode on demand, with no timing dependency at all, so the
 * defect is red at base by ASSERTION rather than by repetition: two direct `drawControls()`
 * calls on one selection must still collect exactly one set of controls, because that is what
 * a real DOM shows after any number of renders of the same state.
 */
test("THE CONTROLS COLLECT FROM ONE RENDER EVEN WHEN drawControls() RUNS TWICE — A0.18, forced deterministically", async () => {
  const r = await rig({ identity: people() });
  const page = openConsole(r.base, "alice-token", () => "");
  try {
    const { runId } = await submit(r, { authorization: "Bearer alice-token" });
    const select = `selected = ${JSON.stringify(String(runId))};`;
    await page.run(`(() => { ${select} current.status = "running"; current.paused = false; })()`);

    const collected = await page.run(
      `(() => { drawControls(); drawControls(); return $("controls").children.map((b) => b.textContent).join(","); })()`,
    );
    assert.equal(
      collected,
      "pause,advance,cancel",
      "a second render of the same state must REPLACE the controls, not append to them",
    );
    assert.deepEqual(page.alerts, [], "the page must have reported no failure to the operator");
    assert.deepEqual(page.errors, [], "…and nothing must have thrown out of a repaint");
  } finally {
    // `openConsole` fires the page's own boot sequence (`/health`, `whoami()`, `loadRuns()`,
    // `loadGraphs()`) the instant its script runs — the same as a browser loading the page —
    // and this test does none of the extra round trips the command-driving test above does to
    // let them land first. This has to run BEFORE `r.close()`, in the `finally` rather than
    // after the assertions: a failing assertion above must still drain these, or `r.close()`
    // races an in-flight `fetch` into an unhandled rejection that reports as a second, unrelated
    // failure. Polling all three writes — not just `whoami()`'s — is what makes the wait a
    // guarantee rather than a coincidence of response ordering.
    for (
      let i = 0;
      i < 200 &&
      ((await page.run(`$("who").textContent`)) === "" ||
        (await page.run(`$("runs").innerHTML`)) === "" ||
        (await page.run(`$("conn").textContent`)) === "connecting");
      i++
    ) {
      await new Promise((x) => setTimeout(x, 5));
    }
    await r.close();
  }
});

// ── the graph inventory ──────────────────────────────────────────────────────

test("THE GRAPH ROUTES ARE OPEN TO EVERY CREDENTIAL — a standing property, and NOT a defect this change closed", async () => {
  // SAID PLAINLY, because a pass here is not evidence of anything the audit found: no code
  // changed, this passes on both trees, and it would have passed a year ago. The audit item
  // was a DOCSTRING — `#requiresBearer`'s enumerated "WHAT IS STILL NOT SCOPED" omitted these
  // two routes, so a deliberate choice read as an oversight — and a docstring is not a thing
  // a test can assert.
  //
  // What this pins is the sentence that replaced it, so a later narrowing of `/graphs` has to
  // be a decision someone makes here rather than a silent drift out from under the paragraph.
  // A graph has no owner to scope by — `#graphByHash` scans the constructor-supplied
  // inventory and never reaches the store — and `POST /runs` applies no per-workflow
  // predicate, so the inventory names actions every credential can already take.
  const r = await rig({ identity: people() });
  try {
    const asBob = { authorization: "Bearer bob-token" };
    const list = await fetch(`${r.base}/graphs`, { headers: asBob });
    assert.equal(list.status, 200);
    const graphs = (await json(list))["graphs"] as { graphHash: string }[];
    assert.equal(graphs.length, 1);
    const byHash = await fetch(`${r.base}/graphs/by-hash/${encodeURIComponent(graphs[0]!.graphHash)}`, { headers: asBob });
    assert.equal(byHash.status, 200, "…and the structure, which the console needs before it has a run");
    assert.equal((await fetch(`${r.base}/graphs`)).status, 401, "…but never without a credential");
  } finally {
    await r.close();
  }
});

// ── the gate queue's cost ────────────────────────────────────────────────────

/** The skeleton with TWO gates in series, so a run can sit between them with none open. */
function twoGateSpec(): GraphSpec {
  const base = skeletonSpec();
  const approve = base.nodes.find((n) => n.id === "approve")!;
  return {
    ...base,
    nodes: [...base.nodes, { ...approve, id: "approve2" as typeof approve.id }],
    edges: [
      ...base.edges.filter((e) => e.id !== "e4"),
      { id: "e4" as never, from: "approve" as never, to: "approve2" as never, kind: "seq" },
      { id: "e5" as never, from: "approve2" as never, to: "write" as never, kind: "seq" },
    ],
  };
}

test("GET /gates DOES NOT REFOLD A RUN WHOSE HEAD HAS NOT MOVED — and refolds the moment it does", async () => {
  // The candidate set is every run that has EVER raised a gate, so it only grows, and the
  // route folded all of it on every poll to discover that nothing was open. Measured on 8
  // gated runs after a restart with ZERO open gates: 1184 journal events read per poll,
  // returning `gates: []`, against a console that polls every 4 seconds.
  //
  // The memo is keyed by the run's HEAD, so the half that has to be shown is not the saving
  // — it is that a gate raised after a memo was taken still reaches the queue.
  const h = harness();
  const graph = compileSkeleton(twoGateSpec());
  const plane = new ControlPlane({
    engine: h.engine,
    store: h.store,
    bus: h.bus,
    graphs: { "two-gates": graph },
    now: () => NOW,
    identity: people(),
  });
  const { port } = await plane.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const asAlice = { authorization: "Bearer alice-token", "content-type": "application/json" };

  // Count every event the store yields, so "did it fold" is measured and not inferred.
  let read = 0;
  const realRead = h.store.read.bind(h.store);
  (h.store as { read: unknown }).read = async function* (...args: Parameters<typeof realRead>) {
    for await (const e of realRead(...args)) {
      read++;
      yield e;
    }
  };
  const queue = async (): Promise<{ cost: number; gates: { gateId: string }[] }> => {
    read = 0;
    const body = (await json(await fetch(`${base}/gates`, { headers: asAlice }))) as unknown as { gates: { gateId: string }[] };
    return { cost: read, gates: body.gates };
  };
  const openOn = async (runId: RunId): Promise<string | undefined> => {
    for (let i = 0; i < 400; i++) {
      const p = await h.engine.projection(runId);
      const open = Object.values(p?.gates ?? {}).find((g) => g.state === "open");
      if (open !== undefined) return open.gateId;
      await new Promise((x) => setTimeout(x, 10));
    }
    return undefined;
  };

  try {
    const res = await fetch(`${base}/runs`, {
      method: "POST",
      headers: asAlice,
      body: JSON.stringify({ workflow: "two-gates", inputs: { paths: DOCS } }),
    });
    const runId = String((await json(res))["runId"]) as RunId;
    const first = await openOn(runId);
    assert.notEqual(first, undefined, "the run parks on its first gate");

    // AN OPEN GATE IS NEVER MEMOED: poll twice and it is still there, at full cost.
    const a = await queue();
    const b = await queue();
    assert.deepEqual([a.gates.length, b.gates.length], [1, 1], "a question must not disappear from the queue it is asked in");
    assert.ok(b.cost > 0, "a run with an open gate is folded every time");

    // Park it BETWEEN the two gates: pause, then answer the first. The run is alive, is in
    // the candidate set, and has nothing open — the shape the whole set degenerates to.
    await fetch(`${base}/runs/${runId}/commands`, { method: "POST", headers: asAlice, body: JSON.stringify({ kind: "pause", reason: "hold" }) });
    await fetch(`${base}/runs/${runId}/gates/${first!}`, { method: "POST", headers: asAlice, body: JSON.stringify({ decision: { kind: "approve" } }) });
    assert.equal((await h.engine.projection(runId))?.paused, true, "the pause holds the run between the two gates");

    // WARM, the projection is already incremental — `Engine.#project` folds from its own
    // cursor — so both polls are near-free and the memo is not what makes them so. The
    // saving is measured on a COLD plane below; what this pair pins is the ANSWER.
    const gapFold = await queue();
    const gapMemo = await queue();
    assert.deepEqual([gapFold.gates.length, gapMemo.gates.length], [0, 0], "nothing is open between the two gates");

    // AND THE MEMO EXPIRES WITH THE HEAD. Resume: the run raises its second gate, the head
    // moves, and the queue must show the new question rather than the remembered answer.
    await fetch(`${base}/runs/${runId}/commands`, { method: "POST", headers: asAlice, body: JSON.stringify({ kind: "resume", reason: "carry on" }) });
    // `advance` is the console's third button and what a resumed run needs: `Engine.resume`
    // clears the pause and does not itself offer work.
    await fetch(`${base}/runs/${runId}/commands`, { method: "POST", headers: asAlice, body: JSON.stringify({ kind: "advance" }) });
    const second = await openOn(runId);
    assert.notEqual(second, undefined, "the run parks on its second gate");
    assert.notEqual(second, first);

    const after = await queue();
    assert.deepEqual(
      after.gates.map((g) => g.gateId),
      [second],
      "a gate raised after the memo was taken must still reach the person being asked",
    );
    assert.ok(after.cost > 0, "…because the head moved, so the memo missed and the run was folded");

    // AND NOW THE SAVING, on the plane state that has it: a RESTART holds no RunContext for
    // anything, so every candidate is folded from seq 1. Answer the last gate so the run
    // finishes and the candidate set degenerates to what a real deployment accumulates —
    // runs that gated once, months ago, and are done.
    await fetch(`${base}/runs/${runId}/gates/${second!}`, { method: "POST", headers: asAlice, body: JSON.stringify({ decision: { kind: "approve" } }) });
    for (let i = 0; i < 400; i++) {
      if ((await h.engine.projection(runId))?.status === "succeeded") break;
      await new Promise((x) => setTimeout(x, 10));
    }
    await plane.close();

    const h2 = harness({ store: h.store });
    const cold = new ControlPlane({ engine: h2.engine, store: h2.store, bus: h2.bus, graphs: { "two-gates": graph }, now: () => NOW, identity: people() });
    const { port: p2 } = await cold.listen(0);
    let coldRead = 0;
    const coldReal = h2.store.read.bind(h2.store);
    (h2.store as { read: unknown }).read = async function* (...args: Parameters<typeof coldReal>) {
      for await (const e of coldReal(...args)) {
        coldRead++;
        yield e;
      }
    };
    const coldQueue = async (): Promise<number> => {
      coldRead = 0;
      await json(await fetch(`http://127.0.0.1:${p2}/gates`, { headers: asAlice }));
      return coldRead;
    };
    try {
      const one = await coldQueue();
      const two = await coldQueue();
      assert.ok(one > 0, "the first poll on a cold plane folds the finished run to discover it has nothing open");
      assert.equal(two, 0, "…and every poll after it reads nothing, which is the 4-second console tick");
    } finally {
      await cold.close();
    }
  } finally {
    await plane.close();
  }
});

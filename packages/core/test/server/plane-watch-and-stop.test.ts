/**
 * The control plane's "watch it, stop it" half, and the durable state three doors read.
 *
 * Every test here reproduces a defect the 2026-09-02 audit measured against a real socket:
 * a HEAD liveness probe answered 404; a second, DIFFERENT gate decision answered 200 with a
 * decision the journal never recorded; an `Idempotency-Key` that deduplicated only until the
 * process restarted; a signed gate callback refused 404 by a plane that did not submit the
 * run; a shipped console with no control that stops anything; and a gate queue that refolded
 * every journal it has ever seen on every four-second poll.
 *
 * They are here rather than in `http.test.ts` so the file that pins the perimeter stays about
 * the perimeter, and so a reader looking for "what the audit closed" finds one place.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BearerTokenIdentity, ControlPlane, type IdentitySource } from "../../src/server/http.ts";
import { CONSOLE_HTML } from "../../src/server/console.ts";
import { GateDispatcher, ConsoleChannel, SignedWebhookChannel } from "../../src/run/delivery.ts";
import type { GateId, RunId } from "../../src/ids.ts";
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

test("THE CONSOLE'S STOP CONTROLS DRIVE THE REAL ROUTE — cancel, pause and resume over HTTP", async () => {
  // The page issues exactly these three requests with the console's own credential. Driving
  // them here is what makes the buttons a claim about the product rather than about the HTML.
  const r = await rig({ identity: people() });
  const asAlice = { authorization: "Bearer alice-token", "content-type": "application/json" };
  const command = async (runId: string, kind: string, reason?: string): Promise<Response> =>
    fetch(`${r.base}/runs/${runId}/commands`, { method: "POST", headers: asAlice, body: JSON.stringify({ kind, ...(reason === undefined ? {} : { reason }) }) });
  try {
    const { runId } = await submit(r, { authorization: "Bearer alice-token" });
    const paused = await command(String(runId), "pause", "hold it");
    assert.equal(paused.status, 200);
    assert.equal((await json(paused))["paused"], true, "the summary the page applies must carry the pause");

    const resumed = await command(String(runId), "resume", "carry on");
    assert.equal(resumed.status, 200);
    assert.equal((await json(resumed))["paused"], false);

    const cancelled = await command(String(runId), "cancel", "wrong inputs");
    assert.equal(cancelled.status, 200);
    assert.equal((await json(cancelled))["status"], "cancelled");
  } finally {
    await r.close();
  }
});

// ── the graph inventory ──────────────────────────────────────────────────────

test("EVERY CREDENTIAL READS THE GRAPH INVENTORY, AND THAT IS THE DELIBERATE CHOICE", async () => {
  // A graph has no owner to scope by — `#graphByHash` scans the constructor-supplied
  // inventory and never reaches the store — and `POST /runs` applies no per-workflow
  // predicate, so the inventory names actions every credential can already take. What was
  // wrong is that the docstring's enumerated "WHAT IS STILL NOT SCOPED" omitted both routes,
  // so a deliberate choice read as an oversight. This test is the enumeration's other half.
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

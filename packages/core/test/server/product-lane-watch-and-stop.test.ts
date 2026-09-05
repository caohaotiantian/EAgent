/**
 * The plane and the page, on the four things an operator does after `loom serve`.
 *
 *   - WATCH IT. The SSE handler set its headers and sent no bytes until the first EVENT, so a
 *     client reconnecting caught up at head got a socket with a request on it and nothing coming
 *     back — measured, five seconds and zero bytes, not even the status line. The console's
 *     connection pill is set after `res.ok`, so it never reached "live", and an intermediary with
 *     an idle-response timeout cuts a stream that has emitted nothing.
 *   - ANSWER A CHILD'S GATE. A gate raised inside a `subgraph` was listed by `GET /gates` and
 *     answerable by nothing: the child compiled a `resources/subgraph/` spec, the plane's
 *     inventory held only `graphs/`, and `POST /runs/<child>/gates/<id>` answered 404
 *     `E_RUN_NOT_FOUND "… is not attached"`.
 *   - ARM BEFORE ANSWERING. `listen()` said "BEFORE THE FIRST REQUEST" above a line that ran
 *     after the socket was accepting, so `/health` answered 200 while the arming was in flight.
 *   - STOP MEANS STOPPED. The page's fold dropped the terminal guard `projection.ts` keeps, so a
 *     `run.resumed` after `run.cancelled` put the stop controls back on screen for a run that had
 *     ended.
 *
 * Offline: `MemoryStateStore`, loopback sockets, a `function` node for the leaf's work, and — for
 * the page — the fold lifted out of `CONSOLE_HTML` and evaluated, so the assertion is about
 * behaviour rather than about the presence of a string.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer, type AddressInfo } from "node:net";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";
import type { NodeId, RunId, Seq } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { StateStore } from "../../src/journal/store.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { CONSOLE_HTML } from "../../src/server/console.ts";
import { BearerTokenIdentity, ControlPlane } from "../../src/server/http.ts";

const NOW = 1_700_000_000_000;
const LEAF_REF = "subgraph/leaf@stable";
const OWNER = "owner-t0ken";

const n = (id: string): NodeId => id as NodeId;
const policy = { posture: "out", expansion: { maxNodes: 32, maxDepth: 4, maxFanout: 4, maxLoopIterations: 1 } } as const;
const channels = {
  amount: { type: "number", reduce: "replace" },
  doubled: { type: "number", reduce: "replace" },
  ok: { type: "array", reduce: "append_ordered" },
} as const;

/** A leaf that asks a person before it does its work — the gate this file is about. */
function leafSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "leaf", project: "lane-p", version: 1 },
    policy,
    channels,
    inputs: ["amount"],
    outputs: ["doubled"],
    nodes: [
      { id: n("ask"), type: "human_gate", reads: ["amount"], writes: ["ok"], humanGate: { ref: "oversight/ship@stable" } },
      { id: n("double"), type: "function", reads: ["amount"], writes: ["doubled"], function: { ref: "function/double@stable" } },
    ],
    edges: [{ id: "e1", from: n("ask"), to: n("double"), kind: "seq" }],
  } as unknown as GraphSpec;
}

function parentSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "top", project: "lane-p", version: 1 },
    policy,
    channels,
    inputs: ["amount"],
    outputs: ["doubled"],
    nodes: [
      {
        id: n("delegate"),
        type: "subgraph",
        reads: ["amount"],
        writes: ["doubled"],
        subgraph: { ref: LEAF_REF, inputs: { amount: "amount" }, outputs: { doubled: "doubled" }, budgetShare: 0.5 },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

const resolver: ResourceResolver = {
  resolve: (ref) => (/^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref) ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" } : undefined),
  subgraph: (ref) => (ref === LEAF_REF ? leafSpec() : undefined),
};

interface Rig {
  base: string;
  parentRunId: RunId;
  childRunId: RunId;
  store: MemoryStateStore;
  close: () => Promise<void>;
}

/**
 * A parent that delegated to a gated leaf, then a SECOND plane over the same store.
 *
 * The second plane is the whole point: it never submitted anything, so it holds no `RunContext`
 * for either run and has to find the graph in its own inventory — which is the state every plane
 * is in after a restart, and the state `#armGatedRuns` and `#bindFromIndex` exist for.
 */
async function rig(opts: { readonly declareSubgraph: boolean }): Promise<Rig> {
  const now = (): number => NOW;
  const store = new MemoryStateStore({ now });
  const functions = new FunctionRegistry();
  functions.register("function/double@stable", (view) => ({ writes: { doubled: (view.get<number>("amount") ?? 0) * 2 } }));
  const bus = new InProcessEventBus({ store });
  const engine = new Engine({
    store,
    bus,
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now,
    resolver,
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 10 } },
  });
  const graph = compileOrThrow({ spec: parentSpec(), resolver, tools: {}, tenantCapabilities: [] });
  const leaf = compileOrThrow({ spec: leafSpec(), resolver, tools: {}, tenantCapabilities: [] });
  const parentRunId = await engine.submit({ graph, inputs: { amount: 21 }, submittedBy: { kind: "human", subject: "owner", method: "bearer-token" } });
  const p = await engine.advance(parentRunId);
  assert.equal(p.status, "awaiting_gate", JSON.stringify(p.error ?? {}));

  // The child's id comes off the parent's journal, never from string-building here.
  const events: JournalEvent[] = [];
  for await (const e of store.read(parentRunId, 1 as Seq)) events.push(e);
  const started = events.find((e) => e.type === "subgraph.started");
  assert.ok(started !== undefined, "the parent must have journaled subgraph.started");
  const childRunId = (started as Extract<JournalEvent, { type: "subgraph.started" }>).payload.childRunId;

  // A FRESH ENGINE over the same journal — no attachment, no context, nothing warm.
  const restarted = new Engine({
    store,
    bus,
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now,
    resolver,
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 10 } },
  });
  const plane = new ControlPlane({
    engine: restarted,
    store,
    bus,
    graphs: { top: graph },
    ...(opts.declareSubgraph ? { subgraphs: [leaf] as readonly RunGraph[] } : {}),
    now,
    identity: new BearerTokenIdentity({ subjects: [{ token: OWNER, subject: "owner", kind: "human" }] }),
  });
  const { port } = await plane.listen(0);
  return { base: `http://127.0.0.1:${port}`, parentRunId, childRunId, store, close: () => plane.close() };
}

const as = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

// ── answer a child's gate ────────────────────────────────────────────────────

test("A CHILD RUN'S GATE CAN BE DECIDED OVER HTTP AFTER A RESTART, which is what the console renders buttons for", async () => {
  const r = await rig({ declareSubgraph: true });
  try {
    // The premise, read off the plane rather than assumed: the queue lists a gate on a run whose
    // id is not the parent's.
    const queue = await fetch(`${r.base}/gates`, { headers: as(OWNER) });
    assert.equal(queue.status, 200, await queue.clone().text());
    const gates = ((await queue.json()) as { gates: readonly { runId: string; gateId: string }[] }).gates;
    const childGate = gates.find((g) => g.runId === r.childRunId);
    assert.ok(childGate !== undefined, `the child's gate must be in the queue: ${JSON.stringify(gates)}`);
    assert.ok(r.childRunId.includes("#"), `a delegated id carries a '#': ${r.childRunId}`);

    const res = await fetch(`${r.base}/runs/${encodeURIComponent(r.childRunId)}/gates/${childGate.gateId}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...as(OWNER) },
      body: JSON.stringify({ decision: { kind: "approve" } }),
    });
    assert.equal(res.status, 200, `the child's gate must be answerable: ${await res.clone().text()}`);

    // AND IT IS JOURNALED, on the child's own log, which is what makes it fold the same way a
    // decision taken through `loom approve` does.
    const decided: JournalEvent[] = [];
    for await (const e of r.store.read(r.childRunId, 1 as Seq)) decided.push(e);
    const row = decided.filter((e) => e.type === "gate.decided");
    assert.equal(row.length, 1, `exactly one gate.decided on the child: ${JSON.stringify(decided.map((e) => e.type))}`);
  } finally {
    await r.close();
  }
});

test("THE CONTROL IS THE SAME PLANE WITHOUT THE SUBGRAPH DECLARED — it still refuses, so the fix is the inventory", async () => {
  // Without this, the test above would pass on a plane that had simply stopped checking, and the
  // 404 it replaces would be unexplained.
  const r = await rig({ declareSubgraph: false });
  try {
    const queue = await fetch(`${r.base}/gates`, { headers: as(OWNER) });
    const gates = ((await queue.json()) as { gates: readonly { runId: string; gateId: string }[] }).gates;
    const childGate = gates.find((g) => g.runId === r.childRunId);
    assert.ok(childGate !== undefined, "the queue lists it either way — that is what made the 404 absurd");
    const res = await fetch(`${r.base}/runs/${encodeURIComponent(r.childRunId)}/gates/${childGate.gateId}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...as(OWNER) },
      body: JSON.stringify({ decision: { kind: "approve" } }),
    });
    assert.equal(res.status, 404, "a plane that holds no graph for the child cannot attach it");
    assert.match((await res.text()).toString(), /is not attached/);
  } finally {
    await r.close();
  }
});

// ── watch it ─────────────────────────────────────────────────────────────────

test("THE SSE STREAM SENDS ITS HEADERS BEFORE ITS FIRST EVENT, so a caught-up client sees a live connection", async () => {
  const r = await rig({ declareSubgraph: true });
  try {
    const head = await r.store.head(r.parentRunId);
    // Caught up at head: there is no backlog to flush the headers, which is exactly the state a
    // console reconnect is in and exactly where this used to send nothing at all.
    const ac = new AbortController();
    // AN ABSOLUTE BOUND WITH AN ORDER-OF-MAGNITUDE MARGIN, never a ratio: flushing a header is
    // microseconds, and without the flush this request produced nothing for as long as anything
    // waited. The timeout is what turns the defect into a FAILURE rather than a hung suite —
    // measured on the tree before the fix, this fetch never settled.
    const timeout = setTimeout(() => ac.abort(), 3000);
    let res: Response;
    try {
      res = await fetch(`${r.base}/runs/${encodeURIComponent(r.parentRunId)}/events`, {
        headers: { accept: "text/event-stream", "last-event-id": String(head), ...as(OWNER) },
        signal: ac.signal,
      });
    } catch (e) {
      assert.fail(`the stream sent no headers within 3s to a client caught up at head: ${String(e)}`);
    } finally {
      clearTimeout(timeout);
    }
    // Reaching here at all is the assertion: `fetch` resolves on the response HEAD, so before the
    // flush this await parked until an event arrived or the socket timed out.
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    ac.abort();
    await res.body?.cancel().catch(() => undefined);
  } finally {
    await r.close();
  }
});

// ── arm before answering ─────────────────────────────────────────────────────

test("`listen()` ARMS BEFORE THE SOCKET ACCEPTS — nothing is answered by a plane that has not scanned", async () => {
  const now = (): number => NOW;
  const store = new MemoryStateStore({ now });
  const bus = new InProcessEventBus({ store });
  const engine = new Engine({
    store,
    bus,
    tools: new ToolRegistry(),
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now,
    resolver,
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 10 } },
  });
  // A store whose LISTING takes a turn of the event loop, so "the arming scan is still running"
  // is a state this test can be in without depending on how long a fold happens to take.
  let scanning = false;
  let sawScan = false;
  const slow: StateStore = {
    append: (input) => store.append(input),
    read: (runId, from, to) => store.read(runId, from, to),
    head: (runId) => store.head(runId),
    listRuns: async (limit, filter) => {
      scanning = true;
      sawScan = true;
      await new Promise((res) => setTimeout(res, 200));
      scanning = false;
      return await store.listRuns(limit, filter);
    },
    close: () => store.close(),
  };
  // A FIXED PORT, LEARNED FROM THE OS. The whole question is whether the socket answers DURING
  // the scan, and with `listen(0)` the port is not knowable until `listen` resolves — which is
  // after the scan either way, so the two orderings would be indistinguishable.
  const port = await freePort();
  const plane = new ControlPlane({ engine, store: slow, bus, now, token: "t" });
  const listening = plane.listen(port);
  try {
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(scanning, true, "the arming scan must be in flight — otherwise this measures nothing");
    // MID-SCAN, THE PORT MUST REFUSE. Before this change `listen()` bound the socket and then
    // awaited the scan, so `/health` answered 200 while the arming that the unauthenticated
    // callback route depends on was still running. A refused connection is the honest answer and
    // the one every load balancer already understands.
    const midScan = await fetch(`http://127.0.0.1:${port}/health`).then(
      (r) => `answered ${r.status}`,
      () => "refused",
    );
    assert.equal(midScan, "refused", "a plane that has not finished arming must not be accepting");
    await listening;
    assert.equal(sawScan, true, "the scan must have run at all");
    assert.equal(scanning, false, "listen() must not resolve mid-scan");
    // AND IT SERVES ONCE ARMED, so the fix is an ordering and not a removal.
    const after = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(after.status, 200);
  } finally {
    await plane.close();
  }
});

test("close() DURING THE ARMING SCAN LEAVES NOTHING BOUND — the scan is not a window to leak a socket through", async () => {
  // The failure this pins was introduced by moving the scan in front of the bind and was found by
  // a `node --test` run that passed all 128 of `http.test.ts` and then never exited, holding one
  // TCPServerWrap. Any await before `#server` is claimed reopens the hole the already-listening
  // guard exists to close, and `close()` arriving in that window resolves against a socket that
  // has not been created yet.
  const now = (): number => NOW;
  const store = new MemoryStateStore({ now });
  const bus = new InProcessEventBus({ store });
  const engine = new Engine({
    store,
    bus,
    tools: new ToolRegistry(),
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now,
    resolver,
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 10 } },
  });
  let scanning = false;
  const slow: StateStore = {
    append: (input) => store.append(input),
    read: (runId, from, to) => store.read(runId, from, to),
    head: (runId) => store.head(runId),
    listRuns: async (limit, filter) => {
      scanning = true;
      await new Promise((res) => setTimeout(res, 200));
      scanning = false;
      return await store.listRuns(limit, filter);
    },
    close: () => store.close(),
  };
  const port = await freePort();
  const plane = new ControlPlane({ engine, store: slow, bus, now, token: "t" });
  const listening = plane.listen(port).then(
    () => "bound",
    (e: unknown) => e,
  );
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(scanning, true, "close() has to arrive while the scan is running, or this measures nothing");
  await plane.close();
  const outcome = await listening;
  assert.equal(outcome === "bound", false, `listen() must not bind after close(): ${String(outcome)}`);

  // THE PROOF IS THE PORT, not the rejection: a leaked socket is one nothing holds a handle to,
  // so the only way to see it is to ask whether anything is still listening there.
  const reachable = await fetch(`http://127.0.0.1:${port}/health`).then(
    () => true,
    () => false,
  );
  assert.equal(reachable, false, "a socket was left bound with no way to close it");

  // A SECOND listen IS STILL REFUSED WHILE ONE IS PENDING, which is the other half of claiming
  // the field synchronously.
  const again = new ControlPlane({ engine, store: slow, bus, now, token: "t" });
  const first = again.listen(0);
  await assert.rejects(() => again.listen(0), /already listening/, "the guard must hold before the scan, not after it");
  await first;
  await again.close();
});

/** A port the OS is willing to give out, released before it is used. */
async function freePort(): Promise<number> {
  const probe = createNetServer();
  const port = await new Promise<number>((res, rej) => {
    probe.once("error", rej);
    probe.listen(0, "127.0.0.1", () => res((probe.address() as AddressInfo).port));
  });
  await new Promise<void>((res) => probe.close(() => res()));
  return port;
}

test("THE ARMING SCAN SKIPS A RUN ITS LAST EVENT PROVES TERMINAL, without folding it", async () => {
  // `raisedAGate` is "has EVER raised one", so on a deployment that uses gates the candidate set
  // fills with runs that gated once and finished — and the whole read budget went on folding
  // their journals to conclude they were not waiting on anybody.
  const now = (): number => NOW;
  const store = new MemoryStateStore({ now });
  const bus = new InProcessEventBus({ store });
  const functions = new FunctionRegistry();
  functions.register("function/double@stable", (view) => ({ writes: { doubled: (view.get<number>("amount") ?? 0) * 2 } }));
  const engine = new Engine({
    store,
    bus,
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now,
    resolver,
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 10 } },
  });
  const graph = compileOrThrow({ spec: leafSpec(), resolver, tools: {}, tenantCapabilities: [] });
  // Two runs, both gated: one answered and finished, one still open.
  const finished = await engine.submit({ graph, inputs: { amount: 1 } });
  await engine.advance(finished);
  const open = (await engine.openGates(finished))[0];
  assert.ok(open !== undefined, "the first run must have raised a gate");
  await engine.resolveGate(finished, { gateId: open.gateId, decision: { kind: "approve" }, actor: { kind: "human", subject: "u:a", via: "cli" }, idempotencyKey: "lane-p-1" });
  await engine.advance(finished);
  const waiting = await engine.submit({ graph, inputs: { amount: 2 } });
  await engine.advance(waiting);

  const folded: string[] = [];
  const counted: StateStore = {
    append: (input) => store.append(input),
    read: (runId, from, to) => {
      // A FOLD reads from seq 1; the prefilter asks for the head row alone.
      if (from === 1) folded.push(String(runId));
      return store.read(runId, from, to);
    },
    head: (runId) => store.head(runId),
    listRuns: (limit, filter) => store.listRuns(limit, filter),
    close: () => store.close(),
  };
  const restarted = new Engine({
    store: counted,
    bus,
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now,
    resolver,
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 10 } },
  });
  const plane = new ControlPlane({ engine: restarted, store: counted, bus, graphs: { leaf: graph }, now, token: "t" });
  await plane.listen(0);
  try {
    // THE FINISHED RUN'S JOURNAL IS NEVER FOLDED. It was skipped on its last event alone, which
    // is the saving; the counter is per run rather than a total because arming the OTHER run
    // legitimately reads it more than once (`compiledGraphHash`, then `rehydrateGates`).
    assert.equal(
      folded.includes(String(finished)),
      false,
      `a run whose last event is terminal must not be folded at boot: ${JSON.stringify(folded)}`,
    );
    // AND THE UNDECIDED ONE IS. A prefilter that skipped everything would pass the line above.
    assert.equal(folded.includes(String(waiting)), true, `the run with an open gate must still be folded: ${JSON.stringify(folded)}`);
    // AND IT IS ARMED, which is the whole reason the scan exists: the gate is answerable on a
    // plane that never submitted the run.
    const armed = await restarted.openGates(waiting);
    assert.equal(armed.length, 1, "the still-open gate must have been armed");
  } finally {
    await plane.close();
  }
});

// ── stop means stopped ───────────────────────────────────────────────────────

test("THE PAGE'S FOLD REFUSES A STATUS CHANGE OUT OF A TERMINAL RUN, as `foldRun` does", () => {
  // The fold is lifted out of the served document and evaluated with a `current` of this test's
  // own, so this asserts what the browser would do rather than that a string is present.
  const src = /const TERMINAL = [\s\S]*?\n\}\n/.exec(CONSOLE_HTML);
  assert.ok(src !== null, "expected the terminal guard and applyEvent to be liftable from the page");
  const foldFor = (current: Record<string, unknown>): ((ev: unknown) => void) =>
    (new Function("current", `${src[0]}\nreturn applyEvent;`) as (c: unknown) => (ev: unknown) => void)(current);

  const ended: Record<string, unknown> = { status: "running", paused: false, tasks: new Map(), gates: [], channels: {} };
  const fold = foldFor(ended);
  fold({ type: "run.cancelled", payload: {} });
  assert.equal(ended["status"], "cancelled");
  fold({ type: "run.resumed", payload: { by: "operator" } });
  assert.equal(ended["status"], "cancelled", "a resume after a cancel must not un-cancel the run");
  fold({ type: "run.failed", payload: {} });
  assert.equal(ended["status"], "cancelled", "nor may a later failure erase the cancellation");

  // THE ORDINARY HALF: a run that has NOT ended still moves, and the pause still renders.
  const live: Record<string, unknown> = { status: "running", paused: false, tasks: new Map(), gates: [], channels: {} };
  const foldLive = foldFor(live);
  foldLive({ type: "run.suspended", payload: { reason: "operator" } });
  assert.equal(live["paused"], true);
  assert.equal(live["status"], "interrupted");
  foldLive({ type: "run.resumed", payload: { by: "operator" } });
  assert.equal(live["status"], "running");
  assert.equal(live["paused"], false);
});

test("EVERY RUN-ID PATH THE PAGE BUILDS IS ENCODED — a child run id truncates at its '#' otherwise", () => {
  // The page is JavaScript in a string, so this is a text assertion by construction. It is
  // written as "no raw concatenation survives" rather than "the helper is called N times",
  // because the failure is a site that forgot the helper.
  const raw = [...CONSOLE_HTML.matchAll(/"\/runs\/" \+/g)];
  assert.deepEqual(raw, [], "a run id must never be concatenated into a path unencoded");
  assert.match(CONSOLE_HTML, /const path = \(\.\.\.segments\) =>/, "the helper the page routes every id through");
});

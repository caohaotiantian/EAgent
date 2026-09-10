/**
 * The embedded console.
 *
 * These do not drive a browser. They assert the things a browser CANNOT recover from
 * if they are wrong: that the page is served at all, that the structure endpoint
 * carries the compiler's layout (so the browser never lays out a 500-node graph), and
 * that the page's escaping and cache keys are right.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { CONSOLE_HTML } from "../../src/server/console.ts";
import { BearerTokenIdentity, ControlPlane } from "../../src/server/http.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { RunId } from "../../src/ids.ts";
import { compileSkeleton, harness, skeletonSpec, DOCS } from "../run/skeleton.ts";
import { openConsole } from "./console-page.ts";

async function rig(opts: { approvers?: readonly string[]; token?: string; failBranch?: number } = {}) {
  const h = harness(opts.failBranch === undefined ? {} : { failBranch: opts.failBranch });
  const spec: GraphSpec =
    opts.approvers === undefined
      ? skeletonSpec()
      : {
          ...skeletonSpec(),
          nodes: skeletonSpec().nodes.map((n) =>
            n.id !== "approve"
              ? n
              : { ...n, humanGate: { ref: n.humanGate!.ref, approval: { approvers: opts.approvers! } } },
          ),
        };
  const graph = compileSkeleton(spec);
  const plane = new ControlPlane({
    engine: h.engine,
    store: h.store,
    bus: h.bus,
    graphs: { "skeleton-summarize": graph },
    // What a single-binary deployment actually has: one token per person, plus a shared
    // one for services. The console holds a person's.
    identity: new BearerTokenIdentity({ subjects: [{ token: "lead-token", subject: "u:security-lead", via: "console" }] }),
    ...(opts.token === undefined ? {} : { token: opts.token }),
  });
  const { port } = await plane.listen(0);
  return { base: `http://127.0.0.1:${port}`, h, graph, close: () => plane.close() };
}

/** Exactly the headers the page sends: a credential, and never an identity claim. */
const asLead = { "content-type": "application/json", authorization: "Bearer lead-token" };

test("the console is served at / as one self-contained document", async () => {
  const r = await rig();
  try {
    const res = await fetch(`${r.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /<!doctype html>/i);
    // Self-contained: no external script or stylesheet to fetch.
    assert.equal(/<script[^>]+src=/.test(html), false, "no external scripts");
    assert.equal(/<link[^>]+stylesheet/.test(html), false, "no external stylesheets");

    // AND NOTHING ELSE REACHES THE NETWORK EITHER, which is the property the README's "ships
    // inside the binary" actually asserts — and the two checks above are narrower than it. A
    // CDN font in `@import url(…)`, a `background: url(https://…)`, an `<img src>`, a telemetry
    // `fetch("https://…")`: each passes both, and each breaks an air-gapped deployment the first
    // time somebody opens the page, with a blank panel and no error the operator can act on.
    //
    // An `<a href>` is exempt: a link is not a load, and a docs link on the page is fine offline.
    // Everything else that names an absolute URL is refused, so adding one is a decision rather
    // than an accident.
    const withoutLinks = html.replace(/<a\b[^>]*>/gi, "<a>");
    const absolute = [...withoutLinks.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]);
    assert.deepEqual(absolute, [], "the console must load nothing from the network");
  } finally {
    await r.close();
  }
});

test("the structure endpoint carries the COMPILER's layout, so the browser never lays out", async () => {
  const r = await rig();
  try {
    const g = (await (await fetch(`${r.base}/graphs/by-hash/${encodeURIComponent(r.graph.graphHash)}`, { headers: asLead })).json()) as {
      nodes: { id: string }[];
      edges: unknown[];
      plans: Record<string, { layoutRank: number; maxInstances: number }>;
    };
    assert.equal(g.nodes.length, r.graph.spec.nodes.length);
    assert.equal(g.edges.length, r.graph.spec.edges.length);
    // Ranks are present and increase along the graph — the client just reads them.
    assert.equal(g.plans["start"]?.layoutRank, 0);
    assert.ok((g.plans["write"]?.layoutRank ?? 0) > 0);
    // And the fan-out width is known ahead of time, so the collapsed badge is right
    // before a single branch has run.
    assert.equal(g.plans["summarize"]?.maxInstances, 5);
  } finally {
    await r.close();
  }
});

test("structure is addressed by hash, so a client can cache it forever", async () => {
  const r = await rig();
  try {
    const a = await (await fetch(`${r.base}/graphs/by-hash/${encodeURIComponent(r.graph.graphHash)}`, { headers: asLead })).json();
    const b = await (await fetch(`${r.base}/graphs/by-hash/${encodeURIComponent(r.graph.graphHash)}`, { headers: asLead })).json();
    assert.deepEqual(a, b, "immutable by construction — a hash cannot mean two things");
    const miss = await fetch(`${r.base}/graphs/by-hash/sha256%3Anope`, { headers: asLead });
    assert.equal(miss.status, 404);
  } finally {
    await r.close();
  }
});

test("the graph list is available for the run form", async () => {
  const r = await rig();
  try {
    const { graphs } = (await (await fetch(`${r.base}/graphs`, { headers: asLead })).json()) as { graphs: { name: string }[] };
    assert.deepEqual(graphs.map((g) => g.name), ["skeleton-summarize"]);
  } finally {
    await r.close();
  }
});

/** The page's own sequence: submit, poll the run, read the gate, decide. */
async function drive(r: Awaited<ReturnType<typeof rig>>): Promise<{ runId: string; gateId: string }> {
  const accepted = (await (
    await fetch(`${r.base}/runs`, {
      method: "POST",
      headers: asLead,
      body: JSON.stringify({ workflow: "skeleton-summarize", inputs: { paths: DOCS } }),
    })
  ).json()) as { runId: string };

  for (let i = 0; i < 50; i++) {
    const p = await r.h.engine.projection(accepted.runId as RunId);
    if (p?.status === "awaiting_gate") break;
    await new Promise((res) => setTimeout(res, 20));
  }

  const run = (await (await fetch(`${r.base}/runs/${accepted.runId}`, { headers: asLead })).json()) as {
    gates: { gateId: string }[];
  };
  assert.equal(run.gates.length, 1, "the oversight panel has something to show");
  return { runId: accepted.runId, gateId: run.gates[0]!.gateId };
}

test("the console can drive a full run: submit, watch, approve", async () => {
  const r = await rig();
  try {
    const at = await drive(r);
    const done = (await (
      await fetch(`${r.base}/runs/${at.runId}/gates/${at.gateId}`, {
        method: "POST",
        headers: asLead,
        body: JSON.stringify({ decision: { kind: "approve" } }),
      })
    ).json()) as { status: string };
    assert.equal(done.status, "succeeded");
  } finally {
    await r.close();
  }
});

test("THE CONSOLE CAN ANSWER A GATE THAT NAMES AN APPROVER — the case that could not work at all", async () => {
  // The shipped UI posted `actor: "console"`, so a gate declaring approvers answered it
  // with `E_GATE_NOT_AUTHORIZED: does not name "console" as an approver`. Every graph
  // with an approvers list was therefore unanswerable from the console and answerable by
  // anyone who hand-rolled the POST. Both halves are fixed by the same change: the page
  // sends its credential and no name.
  const r = await rig({ approvers: ["u:security-lead"] });
  try {
    const at = await drive(r);
    const res = await fetch(`${r.base}/runs/${at.runId}/gates/${at.gateId}`, {
      method: "POST",
      headers: asLead,
      body: JSON.stringify({ decision: { kind: "approve" } }),
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { status: string }).status, "succeeded");

    const decided = [];
    for await (const e of r.h.store.read(at.runId as RunId, 1)) if (e.type === "gate.decided") decided.push(e.actor);
    assert.deepEqual(decided, [{ kind: "human", subject: "u:security-lead", via: "console" }]);
    assert.equal(r.h.writes.length, 1, "and the action behind the gate really ran");
  } finally {
    await r.close();
  }
});

test("the console's own credential cannot answer for somebody else", async () => {
  const r = await rig({ approvers: ["u:security-lead", "u:alice"] });
  try {
    const at = await drive(r);
    const res = await fetch(`${r.base}/runs/${at.runId}/gates/${at.gateId}`, {
      method: "POST",
      headers: asLead,
      body: JSON.stringify({ decision: { kind: "approve" }, actor: "u:alice" }),
    });
    assert.equal(res.status, 403, "a named approver, a valid credential — and the wrong person");
    assert.equal(r.h.writes.length, 0);
  } finally {
    await r.close();
  }
});

// ── the page's own invariants ────────────────────────────────────────────────

test("the page escapes node ids before injecting them into SVG", () => {
  // The graph is authored data, and an id containing markup must not become markup.
  assert.match(CONSOLE_HTML, /function esc\(s\)/);
  assert.match(CONSOLE_HTML, /esc\(node\.id\)/, "the node label");
  assert.match(CONSOLE_HTML, /esc\(node\.type\)/, "and its type");
  assert.match(CONSOLE_HTML, /esc\(g\.nodeId\)/, "and the gate's node");
});

test("the page coalesces deltas rather than repainting per event", () => {
  assert.match(CONSOLE_HTML, /function invalidate\(\)/);
  assert.match(CONSOLE_HTML, /setTimeout\(\(\) => \{ pending = false; draw\(\); \}, 60\)/);
});

test("the page caches structure by graphHash and streams only deltas", () => {
  assert.match(CONSOLE_HTML, /const graphCache = new Map\(\)/);
  assert.match(CONSOLE_HTML, /graphCache\.has\(hash\)/);
});

test("the page reconnects from the seq it has rather than starting over", () => {
  // The mechanism changed — EventSource cannot carry a credential, so the stream is a
  // fetch — but the property must not: resume from lastSeq, and understand a snapshot
  // frame as a fresh baseline rather than a delta.
  assert.match(CONSOLE_HTML, /"last-event-id": String\(lastSeq\)/, "resumes where it left off");
  assert.match(CONSOLE_HTML, /name === "snapshot"/, "and knows a baseline from a delta");
  assert.doesNotMatch(CONSOLE_HTML, /new EventSource/, "which it cannot do while authenticating by query string");
});

test("THE STREAM CARRIES THE CREDENTIAL IN A HEADER, never in the URL", () => {
  // The alternative to a fetch-based stream is `?token=…`, which writes a credential
  // into every access log and proxy trace between the browser and here.
  assert.match(CONSOLE_HTML, /accept: "text\/event-stream", "last-event-id": String\(lastSeq\), \.\.\.auth\(\)/);
  assert.doesNotMatch(CONSOLE_HTML, /token=/, "no credential in a query string");
});

test("the page collapses fan-out into one shape with a count", () => {
  assert.match(CONSOLE_HTML, /count > 1/, "a badge only when there is more than one");
  assert.match(CONSOLE_HTML, /function dominant\(states\)/);
});

test("THE PAGE CLAIMS NO IDENTITY IN THE REQUEST BODY", () => {
  // It used to post `actor: "console"`, which is the same forgery the API now refuses —
  // and, because "console" is nobody's subject id, it made every gate that named an
  // approver answer the shipped UI with 403. The page sends its CREDENTIAL and lets the
  // server say who that is.
  assert.doesNotMatch(CONSOLE_HTML, /actor: *"console"/, "identity comes from the credential, never the body");
  assert.match(CONSOLE_HTML, /authorization/i, "…and the credential really is sent");
});

test("rejecting from the console requires a reason", () => {
  // The server refuses a reasonless rejection; asking in the UI keeps decision
  // provenance meaningful instead of a shrug.
  assert.match(CONSOLE_HTML, /Why are you rejecting this\?/);
  assert.match(CONSOLE_HTML, /if \(reason\) decide/);
});

test("THE OVERSIGHT PANEL IS READ FROM THE RANKED QUEUE, not from the run summary", async () => {
  // Two endpoints carry this run's gates and they are two different ORDERINGS of one set:
  // `GET /runs/:id` goes through `summarise`, which sends `Object.values(p.gates)` — journal
  // order, and no rank at all — while `GET /runs/:id/gates` carries D7.9 row 5's, most urgent
  // first, plus each gate's rendered payload. The page read the first one, so the ordering
  // was built, tested, and rendered by nobody.
  //
  // The page's own sequence is asserted in the same order it performs it: `applySnapshot`
  // seeds from the run summary, then `loadGates` corrects. Both halves matter — the seed is
  // what keeps a failed queue request from blanking the panel.
  assert.match(CONSOLE_HTML, /async function loadGates\(runId, mine\)/);
  // Through `path(...)`, which percent-encodes every segment: a delegated run's id carries a
  // hash, and concatenated raw the browser truncates the URL at it.
  assert.match(CONSOLE_HTML, /api\(path\("runs", runId, "gates"\)\)/, "the ranked endpoint, by name");
  assert.match(CONSOLE_HTML, /await loadGates\(runId, mine\);/, "…called on selection");
  assert.match(CONSOLE_HTML, /"gate\.raised" \|\| data\.type === "gate\.decided"\) void loadGates/, "…and whenever the queue's membership moves");

  // AND THE TWO ENDPOINTS REALLY DO CARRY DIFFERENT THINGS, over real HTTP, so this is a
  // fact about the wire rather than about which string the page contains. Without the second
  // half the first one is a test that a page calls a URL.
  //
  // The ORDER half needs two gates of different urgency and is pinned where that graph
  // lives — *THE QUEUE'S ORDER REACHES THE API* in `test/server/http.test.ts`. What one gate
  // shows is the other difference, and it is the one this page renders next to the buttons:
  // the run summary has never carried what a gate is ASKING.
  const r = await rig();
  try {
    const at = await drive(r);
    const summary = (await (await fetch(`${r.base}/runs/${at.runId}`, { headers: asLead })).json()) as {
      gates: { gateId: string; payload?: unknown }[];
    };
    const queue = (await (await fetch(`${r.base}/runs/${at.runId}/gates`, { headers: asLead })).json()) as {
      gates: { gateId: string; payload?: unknown }[];
    };
    assert.deepEqual(queue.gates.map((g) => g.gateId), [at.gateId], "the same gate, from the queue");
    assert.equal(summary.gates[0]?.payload, undefined, "the run summary has never carried the question");
    assert.notEqual(queue.gates[0]?.payload, undefined, "…and the queue does");
  } finally {
    await r.close();
  }
});

test("THE PAGE COMPUTES NO POSITIONS — geometry arrives from the server", () => {
  // The content of "the browser never runs graph layout", checked rather than claimed.
  // Layout lives in `server/layout.ts`, is measured at 500 nodes, and ships with the
  // structure payload keyed by graphHash.
  assert.doesNotMatch(CONSOLE_HTML, /layoutRank/, "rank-to-row assignment is the server's job");
  assert.doesNotMatch(CONSOLE_HTML, /GAPX|GAPY/, "and so is spacing");
  assert.match(CONSOLE_HTML, /translate\(' \+ node\.x \+ ',' \+ node\.y \+ '\)/, "it places what it is given");
  assert.match(CONSOLE_HTML, /e\.midY/, "including the edge control points");
});

// ── A.45: the live fold must say the same word the projection does ──────────

/**
 * `server/console.ts`'s `applyEvent` had arms for `task.leased`, `task.committed` and
 * `task.failed`, and none for `task.skipped` or `task.cancelled` — so a branch a `skip` join
 * absorbed (journalled `task.skipped` since `a5937fe`) stayed `failed` on the live SSE view
 * forever, while `GET /runs/:id` (`run/projection.ts`'s fold) correctly said `skipped`. It was
 * fail-safe only because `STATE_PRIORITY` ranks `failed` above `skipped` — see
 * `join-absorbed-branch-is-skipped.test.ts`'s header for the wire half of that history.
 *
 * This drives the page's OWN script (`openConsole`, from `./console-page.ts` — shared with
 * `plane-watch-and-stop.test.ts` so there is one DOM mock, not two) against a real run that hits
 * BOTH missing arms in one pass: `harness({ failBranch: 0 })` makes `skeletonSpec()`'s fan-out
 * fail branch 0, which its `collect` join (already `onBranchError: "skip"`) absorbs as
 * `task.skipped`; the run then parks on `approve`'s gate, and cancelling from there — over a
 * raw `fetch`, never through the page, so the console's only route to that fact is its own SSE
 * stream — journals `task.cancelled` for the still-open gate task (REGISTER E6 in
 * `run/engine.ts`).
 *
 * `select()` is called immediately after submission, before anything has been polled to
 * completion, so the console's `follow()` loop is the thing racing the run rather than trailing
 * a foregone conclusion — and whichever of `applySnapshot` or `applyEvent` happens to observe
 * either transition first, the ASSERTION is the same one the row asks for: the console's final
 * state for each task equals what `GET /runs/:id` reports for that same task.
 */
test("A.45 — task.skipped and task.cancelled fold to the SAME state GET /runs/:id reports, over a real SSE stream", async () => {
  const r = await rig({ failBranch: 0 });
  // Declared OUTSIDE the try block: `finally` is a separate block scope, and a `const` from
  // inside `try {}` is not visible there — referencing it anyway is a `ReferenceError` that
  // fires whether or not the try block itself succeeded, which also skipped `r.close()` below.
  let page: ReturnType<typeof openConsole> | undefined;
  try {
    const accepted = (await (
      await fetch(`${r.base}/runs`, {
        method: "POST",
        headers: asLead,
        body: JSON.stringify({ workflow: "skeleton-summarize", inputs: { paths: DOCS } }),
      })
    ).json()) as { runId: string };
    const runId = accepted.runId;

    // Selected BEFORE the run is polled to any particular point — see the docstring above.
    page = openConsole(r.base, "lead-token", () => "cancelled by the console");
    await page.run(`select(${JSON.stringify(runId)})`);

    for (let i = 0; i < 400 && (await page.run("current.status")) !== "awaiting_gate"; i++) {
      await new Promise((res) => setTimeout(res, 10));
    }
    assert.equal(await page.run("current.status"), "awaiting_gate", "the console's own fold must reach the gate");

    const atSkip = (await r.h.engine.projection(runId as RunId))!;
    const skippedTaskId = Object.values(atSkip.tasks).find((t) => t.nodeId === "summarize" && t.state === "skipped")?.taskId;
    assert.ok(skippedTaskId, `the projection must have an absorbed branch: ${JSON.stringify(Object.values(atSkip.tasks).map((t) => [t.nodeId, t.state]))}`);
    const pageSkipState = await page.run(`current.tasks.get(${JSON.stringify(skippedTaskId)})?.state`);
    assert.equal(pageSkipState, "skipped", "the console must not still say `failed` for a branch the join absorbed");

    const gateTaskId = Object.values(atSkip.tasks).find((t) => t.nodeId === "approve")?.taskId;
    assert.ok(gateTaskId, "the gate node must have its own task");

    // Cancelled over a RAW fetch, never `page.run("command(...)")` — the console must learn this
    // only from its own stream, or the test would pass on a page that never folds the event.
    const cancelled = await fetch(`${r.base}/runs/${runId}/commands`, {
      method: "POST",
      headers: asLead,
      body: JSON.stringify({ kind: "cancel", reason: "A.45 fixture" }),
    });
    assert.equal(cancelled.status, 200, await cancelled.text());

    for (let i = 0; i < 400 && (await page.run("current.status")) !== "cancelled"; i++) {
      await new Promise((res) => setTimeout(res, 10));
    }
    assert.equal(await page.run("current.status"), "cancelled");

    const atCancel = (await r.h.engine.projection(runId as RunId))!;
    assert.equal(atCancel.tasks[gateTaskId as never]?.state, "cancelled", "the projection's own word for the gate task");
    const pageCancelState = await page.run(`current.tasks.get(${JSON.stringify(gateTaskId)})?.state`);
    assert.equal(pageCancelState, "cancelled", "the console must not still show `awaiting_gate`/`leased` for a cancelled run");

    assert.deepEqual(page.errors, [], "no uncaught exception in a repaint");
  } finally {
    // `select()` is the only test in this file that starts the page's real `follow()` loop
    // (every other one sets `selected` directly and calls `command()`, which never touches it).
    // `follow()` reconnects on a 1 s timer forever until `selected`/`epoch` change out from under
    // it — closing the plane alone leaves that timer, and the process, alive.
    if (page !== undefined) await page.run("(() => { epoch++; selected = null; if (stream) stream.abort(); })()");
    await r.close();
  }
});

/**
 * A SECOND GAP OF THE SAME SHAPE, found by a fresh reviewer of the diff above: `gate.decided`
 * does not only close the gate. `run/projection.ts`'s arm also returns the RAISING TASK to
 * `ready` (`upsertTask(p, g.taskId, { state: "ready" })`), because the decision rides on the
 * gate record and the scheduler re-leases the task rather than re-raising the gate. The console
 * had no line for that half — only the gate-list trim — so an approved or rejected task kept
 * showing `awaiting_gate` on screen after the projection already said `ready`, for as long as it
 * took the next `task.leased`/`task.ready` frame to arrive.
 *
 * A live SSE race is the wrong tool to pin this: with a synchronous mock model and tool
 * execution, the window between `gate.decided` and the NEXT frame that would independently move
 * the task off `awaiting_gate` (`task.ready`/`task.leased` for the following node) can be a
 * single tick, so polling `current.status` live could pass even with the fix reverted. Instead
 * this drives the page's own real `applyEvent` directly against a `gate.decided` event CAPTURED
 * from a real run's journal — deterministic, and still the shipped function and the shipped
 * event shape, not a copy of either.
 */
test("A.45, gap 2 — gate.decided returns the gate's task to `ready`, the way projection.ts does", async () => {
  const r = await rig();
  try {
    const at = await drive(r);
    const decided = await fetch(`${r.base}/runs/${at.runId}/gates/${at.gateId}`, {
      method: "POST",
      headers: asLead,
      body: JSON.stringify({ decision: { kind: "approve" } }),
    });
    assert.equal(decided.status, 200, await decided.text());

    const log = [];
    for await (const ev of r.h.store.read(at.runId as RunId, 1)) log.push(ev);
    const gateDecided = log.find((ev) => ev.type === "gate.decided");
    assert.ok(gateDecided, "the approval must have journalled gate.decided");
    assert.ok(gateDecided.taskId, "gates.ts's decidedEvent carries the gate's own taskId on the envelope");

    const page = openConsole(r.base, "lead-token", () => "");
    // Seeded to the state the task was ACTUALLY in the instant before this event, rather than
    // relying on a live stream to have put it there — isolating the one arm under test.
    await page.run(
      `current.tasks.set(${JSON.stringify(gateDecided.taskId)}, ` +
        `{ taskId: ${JSON.stringify(gateDecided.taskId)}, nodeId: "approve", state: "awaiting_gate", take: [] })`,
    );
    await page.run(`applyEvent(${JSON.stringify(gateDecided)})`);
    const state = await page.run(`current.tasks.get(${JSON.stringify(gateDecided.taskId)})?.state`);
    assert.equal(state, "ready", "the console must not still say `awaiting_gate` once the gate is decided");
    assert.deepEqual(page.errors, [], "no uncaught exception folding a real gate.decided event");
  } finally {
    await r.close();
  }
});

test("THE FOLD ARMS THEMSELVES — a regression pin independent of any race the integration tests above cannot fully control", () => {
  // Deterministic backstop: whatever the timing of the tests above, these five lines existing
  // in `applyEvent` is what the fix actually is. Matches the same style as the other `assert.match`
  // pins in this file (e.g. "the page must handle run.suspended").
  assert.match(CONSOLE_HTML, /ev\.type === "task\.skipped" && ev\.taskId/, "applyEvent must handle task.skipped");
  assert.match(CONSOLE_HTML, /ev\.type === "task\.cancelled" && ev\.taskId/, "applyEvent must handle task.cancelled");
  assert.match(CONSOLE_HTML, /ev\.type === "task\.retry_scheduled" && ev\.taskId/, "applyEvent must handle task.retry_scheduled");
  assert.match(
    CONSOLE_HTML,
    /if \(ev\.taskId\) \{ const t = current\.tasks\.get\(ev\.taskId\); if \(t\) t\.state = "awaiting_gate"; \}/,
    "gate.raised must also update the raising TASK's own state, the way projection.ts's arm does",
  );
  assert.match(
    CONSOLE_HTML,
    /if \(ev\.taskId\) \{ const t = current\.tasks\.get\(ev\.taskId\); if \(t\) t\.state = "ready"; \}/,
    "gate.decided must return the gate's own task to ready, the way projection.ts's arm does",
  );
});

test("THE HEALTH CHECK NO LONGER LEAVES AN UNCAUGHT PROMISE — a second reviewer found the actual cause of a flake this file's own tests had papered over", () => {
  // Every OTHER startup fetch on this page (`whoami`, `loadRuns`, `loadGraphs`) already wraps its
  // `await api(...)` in its own try/catch; `api("/health").then(...)` was the one bare `.then`
  // with no `.catch`, called unconditionally the instant the script loads. A test that closes the
  // plane before this settles — the A.45 "gap 2" test above did, at ~10ms, well inside a loopback
  // round trip — turned that into an unhandled rejection. The first fix for that was a bounded
  // `setTimeout` before `r.close()`; a second reviewer correctly called that a probabilistic
  // work-around rather than a structural fix (it narrows the race, it does not close it), so the
  // actual bare `.then` is fixed here instead and the timer was deleted.
  assert.match(CONSOLE_HTML, /api\("\/health"\)\.then\(\(h\) => \{[\s\S]*?\}\)\.catch\(/, "the health check's promise chain must end in a .catch");
});

test("THE CONSOLE'S FAN-OUT PRIORITY ORDER AGREES WITH server/layout.ts'S STATE_PRIORITY — one copy, watched", () => {
  // `dominant()`'s priority list is a hand-copy of `server/layout.ts`'s `STATE_PRIORITY` — it
  // cannot be a shared import, because this text ships to a browser and that array is not
  // exported (adding a new export would move the pinned surface count in `scripts/surface.json`
  // off 541 for no functional reason). Per CLAUDE.md's rule for an unavoidable copy, this census
  // pins the two textual representations together — `registries.test.ts`'s pattern, applied here.
  const layoutSrc = readFileSync(new URL("../../src/server/layout.ts", import.meta.url), "utf8");
  const layoutMatch = /const STATE_PRIORITY: readonly TaskState\[\] = \[([\s\S]*?)\];/.exec(layoutSrc);
  assert.ok(layoutMatch, "server/layout.ts no longer declares STATE_PRIORITY in a shape this test can read");
  const layoutOrder = [...layoutMatch![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);

  const consoleMatch = /function dominant\(states\) \{\s*for \(const s of \[([\s\S]*?)\]\)/.exec(CONSOLE_HTML);
  assert.ok(consoleMatch, "console.ts's dominant() changed shape — update this census alongside it");
  const consoleOrder = [...consoleMatch![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);

  // Not vacuous: an empty parse on both sides would compare [] to [] and report green.
  assert.ok(layoutOrder.length >= 5, `the priority scan found only ${layoutOrder.length} members — the regex broke, not the list`);
  assert.deepEqual(consoleOrder, layoutOrder, "the console's fan-out priority order has drifted from the server's STATE_PRIORITY");
});


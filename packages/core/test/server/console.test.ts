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

import { CONSOLE_HTML } from "../../src/server/console.ts";
import { BearerTokenIdentity, ControlPlane } from "../../src/server/http.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { RunId } from "../../src/ids.ts";
import { compileSkeleton, harness, skeletonSpec, DOCS } from "../run/skeleton.ts";

async function rig(opts: { approvers?: readonly string[]; token?: string } = {}) {
  const h = harness();
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
  assert.match(CONSOLE_HTML, /api\("\/runs\/" \+ runId \+ "\/gates"\)/, "the ranked endpoint, by name");
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


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
import { ControlPlane } from "../../src/server/http.ts";
import { compileSkeleton, harness, DOCS } from "../run/skeleton.ts";

async function rig() {
  const h = harness();
  const graph = compileSkeleton();
  const plane = new ControlPlane({ engine: h.engine, store: h.store, bus: h.bus, graphs: { "skeleton-summarize": graph } });
  const { port } = await plane.listen(0);
  return { base: `http://127.0.0.1:${port}`, h, graph, close: () => plane.close() };
}

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
  } finally {
    await r.close();
  }
});

test("the structure endpoint carries the COMPILER's layout, so the browser never lays out", async () => {
  const r = await rig();
  try {
    const g = (await (await fetch(`${r.base}/graphs/by-hash/${encodeURIComponent(r.graph.graphHash)}`)).json()) as {
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
    const a = await (await fetch(`${r.base}/graphs/by-hash/${encodeURIComponent(r.graph.graphHash)}`)).json();
    const b = await (await fetch(`${r.base}/graphs/by-hash/${encodeURIComponent(r.graph.graphHash)}`)).json();
    assert.deepEqual(a, b, "immutable by construction — a hash cannot mean two things");
    const miss = await fetch(`${r.base}/graphs/by-hash/sha256%3Anope`);
    assert.equal(miss.status, 404);
  } finally {
    await r.close();
  }
});

test("the graph list is available for the run form", async () => {
  const r = await rig();
  try {
    const { graphs } = (await (await fetch(`${r.base}/graphs`)).json()) as { graphs: { name: string }[] };
    assert.deepEqual(graphs.map((g) => g.name), ["skeleton-summarize"]);
  } finally {
    await r.close();
  }
});

test("the console can drive a full run: submit, watch, approve", async () => {
  const r = await rig();
  try {
    // Exactly the calls the page makes, in order.
    const accepted = (await (
      await fetch(`${r.base}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow: "skeleton-summarize", inputs: { paths: DOCS } }),
      })
    ).json()) as { runId: string };

    for (let i = 0; i < 50; i++) {
      const p = await r.h.engine.projection(accepted.runId as never);
      if (p?.status === "awaiting_gate") break;
      await new Promise((res) => setTimeout(res, 20));
    }

    const run = (await (await fetch(`${r.base}/runs/${accepted.runId}`)).json()) as {
      graphHash: string;
      gates: { gateId: string }[];
    };
    assert.equal(run.gates.length, 1, "the oversight panel has something to show");

    const done = (await (
      await fetch(`${r.base}/runs/${accepted.runId}/gates/${run.gates[0]!.gateId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: { kind: "approve" }, actor: "console" }),
      })
    ).json()) as { status: string };
    assert.equal(done.status, "succeeded");
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

test("the page reconnects with lastEventId rather than starting over", () => {
  assert.match(CONSOLE_HTML, /lastEventId=/);
  assert.match(CONSOLE_HTML, /addEventListener\("snapshot"/);
});

test("the page collapses fan-out into one shape with a count", () => {
  assert.match(CONSOLE_HTML, /count > 1/, "a badge only when there is more than one");
  assert.match(CONSOLE_HTML, /function dominant\(states\)/);
});

test("rejecting from the console requires a reason", () => {
  // The server refuses a reasonless rejection; asking in the UI keeps decision
  // provenance meaningful instead of a shrug.
  assert.match(CONSOLE_HTML, /Why are you rejecting this\?/);
  assert.match(CONSOLE_HTML, /if \(reason\) decide/);
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


/**
 * The control plane, over real HTTP on an ephemeral port.
 *
 * No mocks: these bind a socket and speak the protocol, because the two contracts
 * being tested — what is durable at ACK, and gap-free reconnect — are protocol
 * properties, not function-call properties.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ControlPlane } from "../../src/server/http.ts";
import { compileSkeleton, harness, DOCS } from "../run/skeleton.ts";

interface Rig {
  base: string;
  plane: ControlPlane;
  h: ReturnType<typeof harness>;
  close: () => Promise<void>;
}

async function rig(opts: { token?: string } = {}): Promise<Rig> {
  const h = harness();
  const graph = compileSkeleton();
  const plane = new ControlPlane({
    engine: h.engine,
    store: h.store,
    bus: h.bus,
    graphs: { "skeleton-summarize": graph },
    ...(opts.token === undefined ? {} : { token: opts.token }),
  });
  const { port } = await plane.listen(0);
  return { base: `http://127.0.0.1:${port}`, plane, h, close: () => plane.close() };
}

const json = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;

async function submit(r: Rig, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const res = await fetch(`${r.base}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ workflow: "skeleton-summarize", inputs: { paths: DOCS } }),
  });
  assert.equal(res.status, 202);
  return json(res);
}

// ── auth ─────────────────────────────────────────────────────────────────────

test("health needs no token; everything else does", async () => {
  const r = await rig({ token: "s3cret" });
  try {
    assert.equal((await fetch(`${r.base}/health`)).status, 200);
    assert.equal((await fetch(`${r.base}/runs`)).status, 401);
    const ok = await fetch(`${r.base}/runs`, { headers: { authorization: "Bearer s3cret" } });
    assert.equal(ok.status, 200);
  } finally {
    await r.close();
  }
});

test("a wrong token is rejected before routing, so routes cannot be probed", async () => {
  const r = await rig({ token: "s3cret" });
  try {
    const res = await fetch(`${r.base}/runs/does-not-exist`, { headers: { authorization: "Bearer wrong" } });
    assert.equal(res.status, 401, "401, not 404 — an unauthenticated caller learns nothing");
  } finally {
    await r.close();
  }
});

test("health reports whether the plane is open", async () => {
  const open = await rig();
  try {
    assert.equal((await json(await fetch(`${open.base}/health`)))["auth"], "open");
  } finally {
    await open.close();
  }
});

// ── submit: what is durable at ACK ───────────────────────────────────────────

test("202 states exactly what is durable, and it is not execution", async () => {
  const r = await rig();
  try {
    const body = await submit(r);
    assert.deepEqual(body["durable"], ["run.submitted", "run.compiled"]);
    assert.match(String(body["note"]), /WILL run, not that it HAS run/);
    assert.match(String(body["graphHash"]), /^sha256:/);
  } finally {
    await r.close();
  }
});

test("the journal really does contain those events at ACK", async () => {
  const r = await rig();
  try {
    const { runId } = await submit(r);
    const p = await r.h.engine.projection(runId as never);
    assert.ok(p, "the run exists the moment the client is told 202");
    assert.equal(p.graphHash, compileSkeleton().graphHash);
  } finally {
    await r.close();
  }
});

test("a duplicate Idempotency-Key returns the ORIGINAL runId and creates nothing", async () => {
  const r = await rig();
  try {
    const first = await submit(r, { "idempotency-key": "abc" });
    const second = await submit(r, { "idempotency-key": "abc" });
    assert.equal(first["runId"], second["runId"]);
    const runs = (await json(await fetch(`${r.base}/runs`)))["runs"] as unknown[];
    assert.equal(runs.length, 1, "one run, not two");
  } finally {
    await r.close();
  }
});

test("an unknown workflow is a clean 404", async () => {
  const r = await rig();
  try {
    const res = await fetch(`${r.base}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "nope", inputs: {} }),
    });
    assert.equal(res.status, 404);
    assert.equal(((await json(res))["error"] as { code: string }).code, "E_RESOURCE_NOT_FOUND");
  } finally {
    await r.close();
  }
});

test("malformed JSON and oversized bodies are rejected with 400", async () => {
  const r = await rig();
  try {
    const bad = await fetch(`${r.base}/runs`, { method: "POST", body: "{not json" });
    assert.equal(bad.status, 400);
  } finally {
    await r.close();
  }
});

// ── reading a run ────────────────────────────────────────────────────────────

test("a run's projection is readable and reaches its gate", async () => {
  const r = await rig();
  try {
    const { runId } = await submit(r);
    await settle(r, runId as string);
    const p = await json(await fetch(`${r.base}/runs/${String(runId)}`));
    assert.equal(p["status"], "awaiting_gate");
    assert.equal((p["gates"] as unknown[]).length, 1);
    assert.equal((p["tasks"] as unknown[]).length > 5, true, "the fan-out is visible as separate tasks");
  } finally {
    await r.close();
  }
});

test("an unknown run is 404 with a typed error body", async () => {
  const r = await rig();
  try {
    const res = await fetch(`${r.base}/runs/01JNOPE`);
    assert.equal(res.status, 404);
    assert.equal(((await json(res))["error"] as { code: string }).code, "E_RUN_NOT_FOUND");
  } finally {
    await r.close();
  }
});

// ── gates over HTTP ──────────────────────────────────────────────────────────

test("a gate can be listed and resolved through the API", async () => {
  const r = await rig();
  try {
    const { runId } = await submit(r);
    await settle(r, runId as string);

    const gates = (await json(await fetch(`${r.base}/runs/${String(runId)}/gates`)))["gates"] as { gateId: string }[];
    assert.equal(gates.length, 1);

    const res = await fetch(`${r.base}/runs/${String(runId)}/gates/${gates[0]!.gateId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: { kind: "approve" }, actor: "u:alice" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await json(res))["status"], "succeeded");
    assert.equal(r.h.writes.length, 1, "approving over HTTP really ran the write");
  } finally {
    await r.close();
  }
});

test("rejecting over HTTP fails the run and writes nothing", async () => {
  const r = await rig();
  try {
    const { runId } = await submit(r);
    await settle(r, runId as string);
    const gates = (await json(await fetch(`${r.base}/runs/${String(runId)}/gates`)))["gates"] as { gateId: string }[];

    const res = await fetch(`${r.base}/runs/${String(runId)}/gates/${gates[0]!.gateId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: { kind: "reject", reason: "not good enough" }, actor: "u:alice" }),
    });
    assert.equal((await json(res))["status"], "failed");
    assert.equal(r.h.writes.length, 0);
  } finally {
    await r.close();
  }
});

// ── commands ─────────────────────────────────────────────────────────────────

test("cancel is reachable and reports cleanliness honestly", async () => {
  const r = await rig();
  try {
    const { runId } = await submit(r);
    await settle(r, runId as string);
    const res = await fetch(`${r.base}/runs/${String(runId)}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "cancel", reason: "operator stopped it" }),
    });
    const body = await json(res);
    assert.equal(body["status"], "cancelled");
    assert.deepEqual(body["unknownEffects"], []);
  } finally {
    await r.close();
  }
});

test("an unknown command is a 400, not a silent no-op", async () => {
  const r = await rig();
  try {
    const { runId } = await submit(r);
    const res = await fetch(`${r.base}/runs/${String(runId)}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "explode" }),
    });
    assert.equal(res.status, 400);
  } finally {
    await r.close();
  }
});

// ── SSE ──────────────────────────────────────────────────────────────────────

/** Read SSE frames until `until` matches or the budget runs out. */
async function readSse(url: string, until: (frames: SseFrame[]) => boolean, budgetMs = 4000): Promise<SseFrame[]> {
  const controller = new AbortController();
  const res = await fetch(url, { headers: { accept: "text/event-stream" }, signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffer = "";
  const deadline = Date.now() + budgetMs;

  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut = buffer.indexOf("\n\n");
      while (cut >= 0) {
        frames.push(parse(buffer.slice(0, cut)));
        buffer = buffer.slice(cut + 2);
        cut = buffer.indexOf("\n\n");
      }
      if (until(frames)) break;
    }
  } finally {
    controller.abort();
  }
  return frames;
}

interface SseFrame {
  id?: number;
  event?: string;
  data?: unknown;
}

function parse(raw: string): SseFrame {
  const out: SseFrame = {};
  for (const line of raw.split("\n")) {
    if (line.startsWith("id: ")) out.id = Number(line.slice(4));
    else if (line.startsWith("event: ")) out.event = line.slice(7);
    else if (line.startsWith("data: ")) out.data = JSON.parse(line.slice(6)) as unknown;
  }
  return out;
}

test("SSE replays the journal from the beginning by default", async () => {
  const r = await rig();
  try {
    const { runId } = await submit(r);
    await settle(r, runId as string);

    const frames = await readSse(`${r.base}/runs/${String(runId)}/events`, (f) =>
      f.some((x) => (x.data as { type?: string } | undefined)?.type === "gate.raised"),
    );
    const types = frames.map((f) => (f.data as { type?: string } | undefined)?.type);
    assert.ok(types.includes("run.submitted"));
    assert.ok(types.includes("gate.raised"));
    // Gap-free: ids are contiguous from 1.
    const ids = frames.filter((f) => f.event === "event").map((f) => f.id!);
    assert.deepEqual(ids, ids.map((_, i) => i + 1));
  } finally {
    await r.close();
  }
});

test("Last-Event-ID resumes without a gap and without repeating", async () => {
  const r = await rig();
  try {
    const { runId } = await submit(r);
    await settle(r, runId as string);

    const frames = await readSse(`${r.base}/runs/${String(runId)}/events?lastEventId=3`, (f) =>
      f.some((x) => (x.data as { type?: string } | undefined)?.type === "gate.raised"),
    );
    const ids = frames.filter((f) => f.event === "event").map((f) => f.id!);
    assert.equal(ids[0], 4, "resumes at seq+1");
    assert.deepEqual(ids, ids.map((_, i) => i + 4), "contiguous from there");
  } finally {
    await r.close();
  }
});

test("a Last-Event-ID outside the hot window gets a SNAPSHOT, not a silent gap", async () => {
  const h = harness();
  const plane = new ControlPlane({
    engine: h.engine,
    store: h.store,
    bus: h.bus,
    graphs: { "skeleton-summarize": compileSkeleton() },
    hotWindow: 1, // force the snapshot path
  });
  const { port } = await plane.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${base}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "skeleton-summarize", inputs: { paths: DOCS } }),
    });
    const { runId } = (await res.json()) as { runId: string };
    await new Promise((r) => setTimeout(r, 150));

    const frames = await readSse(`${base}/runs/${runId}/events?lastEventId=1`, (f) => f.length > 0, 2000);
    assert.equal(frames[0]?.event, "snapshot", "the client is told it is looking at a fresh baseline");
    assert.ok((frames[0]?.data as { status?: string }).status);
  } finally {
    await plane.close();
  }
});

/** Give the engine's background advance a moment to reach the gate. */
async function settle(r: Rig, runId: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const p = await r.h.engine.projection(runId as never);
    if (p !== undefined && (p.status === "awaiting_gate" || p.status === "succeeded" || p.status === "failed")) return;
    await new Promise((res) => setTimeout(res, 20));
  }
}

// ── geometry ships with structure ────────────────────────────────────────────

test("THE STRUCTURE PAYLOAD CARRIES GEOMETRY — the browser never lays out", async () => {
  // The content of D8's claim, as a fact about the wire rather than about code inside an
  // HTML string. Positions and edge control points are computed server-side and cached
  // by graphHash, so a run streaming a thousand task updates recomputes zero of them.
  const r = await rig();
  const graph = compileSkeleton();
  const res = await fetch(`${r.base}/graphs/by-hash/${encodeURIComponent(graph.graphHash)}`);
  assert.equal(res.status, 200);
  const body = (await json(res)) as unknown as {
    graphHash: string;
    width: number;
    height: number;
    nodes: { id: string; x: number; y: number; rank: number }[];
    edges: { id: string; x1: number; midY: number }[];
  };

  assert.equal(body.graphHash, graph.graphHash);
  assert.ok(body.width > 0 && body.height > 0, "a canvas the client sizes to, not one it computes");
  assert.equal(body.nodes.length, graph.spec.nodes.length);
  assert.equal(body.edges.length, graph.spec.edges.length);
  for (const node of body.nodes) {
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), `${node.id} has no position`);
  }
  for (const edge of body.edges) assert.ok(Number.isFinite(edge.midY), `${edge.id} has no control point`);
  r.close();
});

test("an unknown graph hash is a clean 404, not an empty canvas", async () => {
  const r = await rig();
  const res = await fetch(`${r.base}/graphs/by-hash/sha256%3Adeadbeef`);
  assert.equal(res.status, 404);
  r.close();
});


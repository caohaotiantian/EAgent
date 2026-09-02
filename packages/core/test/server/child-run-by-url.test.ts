/**
 * A SUBGRAPH'S CHILD RUN, FETCHED BY URL — TODO §A.36, over a real socket.
 *
 * `Engine` mints a delegated run's id as `${parent}~${task.taskId}`, and a `TaskId` is
 * `nodeId@branchPath#iteration`. Both `@` and `#` are characters `encodeURIComponent`
 * escapes, and every by-id route on the control plane read its `([^/]+)` capture straight
 * out of `params[0]` — so `%23` never became `#`, no store held that key, and the plane
 * answered `E_RUN_NOT_FOUND` for a run `GET /runs` had listed one request earlier. Measured
 * on the unfixed tree: `GET /runs` 200 with both ids in the body, parent trace 200, child
 * trace 404, child summary 404.
 *
 * THREE PROPERTIES, because the fix is a decode and a decode is exactly the kind of change
 * that can buy reachability with authorization:
 *
 *  1. **The child is reachable.** Its trace and its summary answer 200 for its owner, and the
 *     `runId` they echo is the real, decoded id rather than the escaped one — an assertion
 *     the old behaviour could not pass by accident, since it never reached a handler at all.
 *  2. **Ownership still decides, on the child as on the parent.** A second authenticated
 *     principal gets 404 — not 403 — on the child's summary and trace, from the same
 *     `ownsRun` check the parent uses, so decoding did not turn a percent-encoded id into a
 *     key to somebody else's delegation.
 *  3. **Every by-id route decodes, not just the one the row named.** The row said three; the
 *     grep said nine. This drives the child id through each of the eight that take a
 *     credential and asserts none of them answers `E_RUN_NOT_FOUND` — several answer other
 *     refusals (a bad body, a missing `atSeq`), and that is the point: a route that got as
 *     far as validating its own input resolved the id.
 *
 * Offline: a loopback `node:http` server, a `MemoryStateStore`, and a `function` node for the
 * leaf's work. No clock is read.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";
import type { NodeId, RunId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { BearerTokenIdentity, ControlPlane } from "../../src/server/http.ts";

const NOW = 1_700_000_000_000;
const LEAF_REF = "graph/leaf@stable";
const OWNER_TOKEN = "owner-t0ken";
const STRANGER_TOKEN = "stranger-t0ken";

const n = (id: string): NodeId => id as NodeId;

const policy = { posture: "out", expansion: { maxNodes: 32, maxDepth: 4, maxFanout: 4, maxLoopIterations: 1 } } as const;
const channels = { amount: { type: "number", reduce: "replace" }, doubled: { type: "number", reduce: "replace" } } as const;

function leafSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "leaf", project: "a36", version: 1 },
    policy,
    channels,
    inputs: ["amount"],
    outputs: ["doubled"],
    nodes: [{ id: n("double"), type: "function", reads: ["amount"], writes: ["doubled"], function: { ref: "function/double@stable" } }],
    edges: [],
  } as unknown as GraphSpec;
}

function parentSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "top", project: "a36", version: 1 },
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
  resolve: (ref) =>
    /^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref) ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" } : undefined,
  subgraph: (ref) => (ref === LEAF_REF ? leafSpec() : undefined),
};

interface Rig {
  base: string;
  parentRunId: RunId;
  childRunId: RunId;
  close: () => Promise<void>;
}

/** A parent run that delegated once, already advanced to completion, behind a live plane. */
async function rig(): Promise<Rig> {
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
  const parentRunId = await engine.submit({
    graph,
    inputs: { amount: 21 },
    // The HTTP door always records one, so the ownership arm below is the real rule and not
    // the grandfather case an unowned run would have exercised.
    submittedBy: { kind: "human", subject: "owner", method: "bearer-token" },
  });
  const p = await engine.advance(parentRunId);
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));

  // The child's id comes off the parent's journal, which is where a caller following a
  // `SpanLink` would get it too — never from string-building in the test.
  const events: JournalEvent[] = [];
  for await (const e of store.read(parentRunId, 1 as JournalEvent["seq"])) events.push(e);
  const started = events.find((e) => e.type === "subgraph.started");
  assert.ok(started !== undefined, "the parent must have journaled subgraph.started");
  const childRunId = (started as Extract<JournalEvent, { type: "subgraph.started" }>).payload.childRunId;

  const plane = new ControlPlane({
    engine,
    store,
    bus,
    graphs: { top: graph },
    now,
    identity: new BearerTokenIdentity({
      subjects: [
        { token: OWNER_TOKEN, subject: "owner", kind: "human" },
        { token: STRANGER_TOKEN, subject: "stranger", kind: "human" },
      ],
    }),
  });
  const { port } = await plane.listen(0);
  return { base: `http://127.0.0.1:${port}`, parentRunId, childRunId, close: () => plane.close() };
}

const as = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

test("A.36: a child run id survives percent-encoding on the by-id routes", async () => {
  const r = await rig();
  try {
    // The premise: the id really does carry the two characters that broke this.
    assert.ok(r.childRunId.includes("#"), `expected a '#' in ${r.childRunId}`);
    assert.ok(r.childRunId.includes("@"), `expected an '@' in ${r.childRunId}`);
    const enc = encodeURIComponent(r.childRunId);
    assert.ok(enc.includes("%23"), `expected the '#' to be escaped in ${enc}`);

    // It was always listed — that half was never broken, and it is what made the 404 absurd.
    const list = await fetch(`${r.base}/runs`, { headers: as(OWNER_TOKEN) });
    assert.equal(list.status, 200);
    const listed = (await list.json()) as { runs: readonly { runId: string }[] };
    assert.ok(
      listed.runs.some((x) => x.runId === r.childRunId),
      `GET /runs did not list the child: ${JSON.stringify(listed)}`,
    );

    const trace = await fetch(`${r.base}/runs/${enc}/trace`, { headers: as(OWNER_TOKEN) });
    assert.equal(trace.status, 200, `child trace: ${await trace.clone().text()}`);
    const body = (await trace.json()) as { runId: string; spans: readonly unknown[] };
    // ECHOED DECODED. The escaped form reaching the body would mean the route had answered
    // about a run named `…%230`, which is not the run the link points at.
    assert.equal(body.runId, r.childRunId);
    assert.ok(body.spans.length > 0, "the child's trace must have spans");

    const summary = await fetch(`${r.base}/runs/${enc}`, { headers: as(OWNER_TOKEN) });
    assert.equal(summary.status, 200, `child summary: ${await summary.clone().text()}`);
    assert.equal(((await summary.json()) as { runId: string }).runId, r.childRunId);
  } finally {
    await r.close();
  }
});

test("A.36: decoding does not hand a child run to a caller who does not own it", async () => {
  const r = await rig();
  try {
    const enc = encodeURIComponent(r.childRunId);
    for (const path of [`/runs/${enc}`, `/runs/${enc}/trace`, `/runs/${encodeURIComponent(r.parentRunId)}`]) {
      const res = await fetch(`${r.base}${path}`, { headers: as(STRANGER_TOKEN) });
      // 404 AND NOT 403 — the sibling routes' rule, which the decode must not soften into an
      // existence oracle for delegated runs.
      assert.equal(res.status, 404, `${path} answered ${res.status} to a stranger`);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, "E_RUN_NOT_FOUND");
    }
  } finally {
    await r.close();
  }
});

test("A.36: every credentialed by-id route resolves the escaped child id", async () => {
  const r = await rig();
  try {
    const enc = encodeURIComponent(r.childRunId);
    const json = { "content-type": "application/json", ...as(OWNER_TOKEN) };
    // Seven of the eight that take a credential. Several refuse for their own reasons — a
    // finished run cannot be advanced, `rewind-plan` wants an `atSeq` — and the assertion is
    // only that the refusal is never "no such run", which is what an undecoded id produced on
    // all of them.
    const probes: readonly { readonly what: string; readonly res: Response }[] = [
      { what: "GET /runs/:id", res: await fetch(`${r.base}/runs/${enc}`, { headers: as(OWNER_TOKEN) }) },
      { what: "GET /runs/:id/trace", res: await fetch(`${r.base}/runs/${enc}/trace`, { headers: as(OWNER_TOKEN) }) },
      { what: "GET /runs/:id/gates", res: await fetch(`${r.base}/runs/${enc}/gates`, { headers: as(OWNER_TOKEN) }) },
      { what: "GET /runs/:id/rewind-plan", res: await fetch(`${r.base}/runs/${enc}/rewind-plan`, { headers: as(OWNER_TOKEN) }) },
      { what: "POST /runs/:id/commands", res: await fetch(`${r.base}/runs/${enc}/commands`, { method: "POST", headers: json, body: "{}" }) },
      { what: "POST /runs/:id/oversight", res: await fetch(`${r.base}/runs/${enc}/oversight`, { method: "POST", headers: json, body: "{}" }) },
      {
        what: "POST /runs/:id/gates/:gateId",
        res: await fetch(`${r.base}/runs/${enc}/gates/gate_01HF00000000000000000000`, { method: "POST", headers: json, body: "{}" }),
      },
    ];
    for (const { what, res } of probes) {
      if (res.status === 404) {
        const code = ((await res.json()) as { error: { code: string } }).error.code;
        assert.notEqual(code, "E_RUN_NOT_FOUND", `${what} still cannot resolve the escaped child id`);
      } else {
        await res.text();
      }
    }

    // The eighth is SSE, which writes its 200 itself and would stream forever, so it is
    // aborted as soon as the status line is in hand.
    const ac = new AbortController();
    const events = await fetch(`${r.base}/runs/${enc}/events`, { headers: as(OWNER_TOKEN), signal: ac.signal });
    assert.equal(events.status, 200, "GET /runs/:id/events must resolve the escaped child id");
    ac.abort();
  } finally {
    await r.close();
  }
});

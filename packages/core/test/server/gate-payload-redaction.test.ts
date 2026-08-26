/**
 * The gate routes' own guarantee, over real HTTP.
 *
 * `server/http.ts` has promised since it was written that "gate payloads reaching a caller
 * admitted by `mayReachGates` are redacted per the GRAPH's declared classification, never per
 * viewer". Nothing did it: `redactPayload` was called on the event stream and on a
 * projection's channels, and at NEITHER gate route — so a channel declared `secret_ref`, read
 * by a `human_gate` node, came back in full on `GET /runs/:id/gates` and on `GET /gates`.
 *
 * This suite exists because that is a promise a reader of the file would rely on and a
 * `grep` for `redactPayload` would appear to confirm. It drives a real socket rather than
 * calling the helper, because the defect was in the WIRING and a unit test of the helper
 * would have passed on the broken build.
 *
 * A redactor that redacts everything is not a redactor, so every test here asserts both
 * halves: the `secret_ref` channel is gone and the `pii` one is a token, AND the `public` and
 * the unclassified ones arrive byte-identical. All four classifications are named rather than
 * sampled — a claim that names its members can be checked.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";
import type { RunId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { StateStore } from "../../src/journal/store.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { ControlPlane } from "../../src/server/http.ts";

const NOW = 1_700_000_000_000;

/** The three values that must never reach the wire, and the two that must. */
const SECRET = "sk-live-DO-NOT-DISCLOSE";
const PERSON = "ada@example.com";
const PUBLIC = "quarterly refresh";
/**
 * The value behind a classification the vocabulary has never heard, and DELIBERATELY not
 * credential-shaped: with `SECRET` here the test passed either way, because the detector
 * backstop caught the `sk-` prefix on its own. Ordinary prose is what makes this assertion
 * about the classification lookup rather than about `DETECTORS`.
 */
const LEGACY = "the third quarter reconciliation figures";
const UNCLASSIFIED = "ordinary note";

function resolver(child?: GraphSpec): ResourceResolver {
  return {
    resolve: (ref) => (/^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref) ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" } : undefined),
    ...(child === undefined ? {} : { subgraph: (ref: string) => (ref === "graph/child@stable" ? child : undefined) }),
  };
}

/**
 * One gate node reading five channels that differ ONLY in their declared classification.
 *
 * Same node, same `reads`, same shape on the wire — so anything that comes out different
 * came out of the classification and nowhere else.
 */
function classifiedGateSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "classified-gate", project: "demo", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 16, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: {
      topic: { type: "string", reduce: "replace", classification: "public" },
      apiKey: { type: "string", reduce: "replace", classification: "secret_ref" },
      owner: { type: "string", reduce: "replace", classification: "pii" },
      // A CLASSIFICATION THAT IS NOT ONE — declared CLEAN here and doctored after compile by
      // `fromAnOlderBuild` below. It used to be written `classification: "confidential"`
      // straight into this spec, and that no longer compiles: `validate.ts` gained
      // `GRAPH003_UNKNOWN_CLASSIFICATION` and it covers a resolved CHILD spec too. What it
      // does NOT cover is the graph objects `ControlPlane` is handed — `ControlPlaneOptions`
      // takes already-compiled `RunGraph`s and re-validates nothing — so the reachable shape
      // is a graph compiled by a build older than that check, which is what this rig builds.
      legacy: { type: "string", reduce: "replace" },
      note: { type: "string", reduce: "replace" },
      done: { type: "array", reduce: "append_ordered" },
    },
    inputs: ["topic", "apiKey", "owner", "note", "legacy"],
    outputs: ["done"],
    nodes: [
      { id: "start", type: "function", reads: ["topic"], function: { ref: "function/passthrough@stable" } },
      {
        id: "approve",
        type: "human_gate",
        reads: ["topic", "apiKey", "owner", "note", "legacy"],
        humanGate: { ref: "oversight/demo-write@stable", sla: { respondWithinMs: 900_000, onTimeout: "fail" } },
      },
      { id: "finish", type: "function", reads: ["topic"], writes: ["done"], function: { ref: "function/passthrough@stable" } },
    ],
    edges: [
      { id: "e1", from: "start", to: "approve", kind: "seq" },
      { id: "e2", from: "approve", to: "finish", kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

interface Wired {
  readonly engine: Engine;
  readonly store: StateStore;
  readonly bus: InProcessEventBus;
}

/**
 * An engine with a RESOLVER, which the shared skeleton harness does not build.
 *
 * A `subgraph` node compiles its child when it is delegated to, and that compile reads the
 * engine's resolver — so a harness without one fails the child at `GRAPH015` and the mirror
 * gate this file has to reach is never raised. Nothing else here needs a tool or a model.
 */
function wired(child?: GraphSpec): Wired {
  const now = (): number => NOW;
  const store = new MemoryStateStore({ now });
  const bus = new InProcessEventBus({ store });
  const functions = new FunctionRegistry();
  functions.register("function/passthrough@stable", () => ({}));
  const engine = new Engine({
    store,
    bus,
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now,
    sleep: async () => {},
    resolver: resolver(child),
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 1 } },
  });
  return { engine, store, bus };
}

interface Rig {
  base: string;
  w: Wired;
  runId: string;
  close: () => Promise<void>;
}

async function rigFor(name: string, graph: RunGraph, inputs: Record<string, unknown>, w: Wired): Promise<Rig> {
  const plane = new ControlPlane({ engine: w.engine, store: w.store, bus: w.bus, graphs: { [name]: graph }, now: () => NOW });
  const { port } = await plane.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const accepted = (await (
    await fetch(`${base}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: name, inputs }),
    })
  ).json()) as { runId: string };
  for (let i = 0; i < 100; i++) {
    const p = await w.engine.projection(accepted.runId as RunId);
    if (p?.status === "awaiting_gate" && Object.values(p.gates).some((g) => g.state === "open")) break;
    await new Promise((res) => setTimeout(res, 20));
  }
  return { base, w, runId: accepted.runId, close: () => plane.close() };
}

/**
 * The same compiled graph, with ONE channel carrying a classification the vocabulary has
 * never heard — the only shape that still reaches the redactor now that the compiler refuses
 * the word.
 *
 * `graphHash` is deliberately left alone: it is the hash of the clean spec, which is exactly
 * the story — the hash was computed by a build whose validator did not yet have this check,
 * and `ControlPlane` scans `#graphs` by that hash and re-validates nothing on the way past.
 */
function fromAnOlderBuild(g: RunGraph): RunGraph {
  const channels = g.spec.channels as unknown as Record<string, Record<string, unknown>>;
  return {
    ...g,
    spec: {
      ...g.spec,
      channels: { ...channels, legacy: { ...channels["legacy"], classification: "confidential" } },
    } as unknown as GraphSpec,
  };
}

const gateRig = async (): Promise<Rig> =>
  rigFor(
    "classified-gate",
    fromAnOlderBuild(compileOrThrow({ spec: classifiedGateSpec(), resolver: resolver(), tools: {}, tenantCapabilities: [] })),
    { topic: PUBLIC, apiKey: SECRET, owner: PERSON, note: UNCLASSIFIED, legacy: LEGACY },
    wired(),
  );

interface WireGate {
  readonly runId?: string;
  readonly gateId: string;
  readonly nodeId: string;
  readonly payload?: { readonly state?: Record<string, unknown>; readonly channels?: Record<string, unknown> };
}

async function gatesOn(base: string, path: string): Promise<WireGate[]> {
  const res = await fetch(`${base}${path}`);
  assert.equal(res.status, 200, `${path} answered ${res.status}`);
  return ((await res.json()) as { gates: WireGate[] }).gates;
}

test("EVERY DECLARED CLASSIFICATION DECIDES, ON BOTH GATE ROUTES — and two of the four are not redactions", async () => {
  // Reproduced over real HTTP before the fix, both routes, the same run:
  //
  //     GET /runs/:id/gates → payload.state.apiKey === "sk-live-DO-NOT-DISCLOSE"
  //     GET /gates          → payload.state.apiKey === "sk-live-DO-NOT-DISCLOSE"
  //
  // while the file's header claimed the opposite. The control matters as much as the
  // finding: a redactor that hides everything hides the question the human is being asked.
  const r = await gateRig();
  try {
    for (const path of ["/runs/" + r.runId + "/gates", "/gates"]) {
      const gates = await gatesOn(r.base, path);
      assert.equal(gates.length, 1, `${path} served ${gates.length} gates`);
      const state = gates[0]!.payload?.state;
      assert.ok(state !== undefined, `${path} lost the question the gate is asking`);
      assert.equal(state["apiKey"], "[secret]", `${path} served the secret_ref channel`);
      // ALL FOUR CLASSIFICATIONS, named rather than sampled. `pii` tokenises irreversibly, so
      // the assertion is on the SHAPE — the token's value is an HMAC under a per-process key
      // and pinning it would make this test depend on entropy.
      assert.match(String(state["owner"]), /^pii:[0-9a-f]{12}:string$/, `${path} did not tokenise a pii channel`);
      assert.equal(JSON.stringify(state).includes(SECRET), false, `${path} carries the secret somewhere else`);
      assert.equal(JSON.stringify(state).includes(PERSON), false, `${path} carries the person somewhere else`);
      assert.equal(state["legacy"], "[secret]", `${path} read an unknown classification as \`internal\``);
      assert.equal(state["topic"], PUBLIC, `${path} redacted a public channel`);
      assert.equal(state["note"], UNCLASSIFIED, `${path} redacted an unclassified channel`);
    }
  } finally {
    await r.close();
  }
});

test("THE REST OF THE GATE SURVIVES — redaction is not allowed to become a filter", async () => {
  // The gate RECORD is what makes a queue usable: which node, which id, who may answer.
  // None of it is channel data and none of it may be withheld, or the fix for a disclosure
  // becomes a denial of oversight.
  const r = await gateRig();
  try {
    for (const path of ["/runs/" + r.runId + "/gates", "/gates"]) {
      const g = (await gatesOn(r.base, path))[0]!;
      assert.equal(g.nodeId, "approve");
      assert.match(g.gateId, /\S/);
      const p = g.payload as Record<string, unknown>;
      assert.equal(p["node"], "approve");
      assert.equal(p["posture"], "in", "a secret_ref read floors the node at `in`; that fact is not channel data");
      assert.equal(typeof p["costSoFarUsd"], "number");
    }
  } finally {
    await r.close();
  }
});

test("A PLANE THAT DOES NOT HOLD THE GRAPH WITHHOLDS THE CHANNELS — it cannot know what is secret", async () => {
  // The fail-closed half of the same rule. A second plane over the SAME store, configured
  // with no graphs, cannot look up a classification — so it serves the gate and withholds
  // every channel value rather than guessing `internal`, which is the leak being fixed.
  const r = await gateRig();
  const blind = new ControlPlane({ engine: r.w.engine, store: r.w.store, bus: r.w.bus, graphs: {}, now: () => NOW });
  const { port } = await blind.listen(0);
  try {
    const gates = await gatesOn(`http://127.0.0.1:${port}`, `/runs/${r.runId}/gates`);
    const state = gates[0]!.payload?.state as Record<string, unknown>;
    assert.deepEqual(state, { topic: "[secret]", apiKey: "[secret]", owner: "[secret]", note: "[secret]", legacy: "[secret]" });
    assert.equal(gates[0]!.nodeId, "approve", "the gate itself is still served — only the channel values are withheld");
  } finally {
    await blind.close();
    await r.close();
  }
});

// ── the mirror gate: the child's whole channel map, keyed by the CHILD's spec ─────────────

/** The child declares the secret; the parent's mirror gate is where a human reads it. */
function childSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "child", project: "demo", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 16, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: {
      seed: { type: "string", reduce: "replace", classification: "public" },
      childKey: { type: "string", reduce: "replace", classification: "secret_ref" },
      out: { type: "string", reduce: "replace" },
    },
    inputs: ["seed", "childKey"],
    outputs: ["out"],
    nodes: [
      { id: "ask", type: "human_gate", reads: ["seed", "childKey"], humanGate: { ref: "oversight/demo-write@stable", sla: { respondWithinMs: 900_000, onTimeout: "fail" } } },
      { id: "tail", type: "function", reads: ["seed"], writes: ["out"], function: { ref: "function/passthrough@stable" } },
    ],
    edges: [{ id: "c1", from: "ask", to: "tail", kind: "seq" }],
  } as unknown as GraphSpec;
}

function parentSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "parent", project: "demo", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 32, maxDepth: 3, maxFanout: 2, maxLoopIterations: 1 } },
    channels: {
      // THE PARENT DOES NOT KNOW IT IS CARRYING A SECRET. Neither channel is classified
      // here; `childKey` is `secret_ref` in the CHILD's spec, which is the whole point — the
      // classification that decides is the one belonging to the spec that named the channel.
      topic: { type: "string", reduce: "replace" },
      apiKey: { type: "string", reduce: "replace" },
      result: { type: "string", reduce: "replace" },
    },
    inputs: ["topic", "apiKey"],
    outputs: ["result"],
    nodes: [
      {
        id: "delegate",
        type: "subgraph",
        reads: ["topic", "apiKey"],
        writes: ["result"],
        subgraph: { ref: "graph/child@stable", inputs: { seed: "topic", childKey: "apiKey" }, outputs: { result: "out" }, budgetShare: 0.5 },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

test("A MIRROR GATE IS REDACTED BY THE CHILD'S SPEC — the payload is another run's whole channel map", async () => {
  // `#runSubgraph` puts `channels: childP.channels` in the mirror gate's payload: the child's
  // ENTIRE channel map, not the child gate node's `reads`. Those names belong to the child's
  // spec, which the parent's compiled graph froze under `subgraphs[ref]`, so the lookup that
  // decides here is a different one from the `state` case — and getting it wrong publishes a
  // whole delegated run.
  const child = childSpec();
  const parent = compileOrThrow({ spec: parentSpec(), resolver: resolver(child), tools: {}, tenantCapabilities: [] });
  const r = await rigFor("parent", parent, { topic: PUBLIC, apiKey: SECRET }, wired(child));
  try {
    for (const path of ["/runs/" + r.runId + "/gates", "/gates"]) {
      const gates = await gatesOn(r.base, path);
      // `/gates` is CROSS-RUN, and a delegated run is a run: the child's own gate is in the
      // queue too. It is served by a plane holding only the parent graph, so it is also the
      // fail-closed case — hence the check across every gate the queue returned.
      assert.equal(JSON.stringify(gates).includes(SECRET), false, `${path} carries the child's secret`);
      const mirror = gates.find((g) => g.payload?.channels !== undefined);
      assert.ok(mirror !== undefined, `${path} lost the child's state`);
      const channels = mirror.payload!.channels!;
      assert.equal(channels["childKey"], "[secret]", `${path} served the child's secret_ref channel`);
      assert.equal(channels["seed"], PUBLIC, `${path} redacted the child's public channel`);
    }
  } finally {
    await r.close();
  }
});

/**
 * `ControlPlane#graphByHash`, the lookup its own docstring calls a disclosure decision.
 *
 * It had NO TEST. A verifier mutated it to ignore the hash entirely —
 *
 *     #graphByHash(hash) { return Object.values(this.#graphs)[0]; }
 *
 * — and every redaction test in the tree stayed green, because every one of those rigs holds
 * exactly ONE graph, so "the first graph" and "the run's graph" are the same object. A lookup
 * that answers too generously hands a run's channel values over under a STRANGER'S
 * classifications: a name the run's own spec declares `secret_ref` is served in the clear the
 * moment some other graph in the deployment declares it `public`.
 *
 * So the fixture here is TWO graphs that disagree, in ONE plane, with a run of each. Nothing
 * about it can be satisfied by returning "a graph":
 *
 *   - return the FIRST  → the beta run is redacted by alpha's spec and its secret leaks;
 *   - return the LAST   → the alpha run is redacted by beta's spec and its public value is
 *                         withheld, and its alpha-only channel falls closed;
 *   - return UNDEFINED  → both runs withhold everything, including the public channel.
 *
 * SIX callers read this lookup and all six are driven: `GET /runs/:id/gates`, `GET /gates`,
 * `#summary` (`GET /runs/:id` and the three command replies), `#streamEvents`,
 * `GET /graphs/by-hash/:hash`, and `#bindFromIndex`. The set is named so it can be checked
 * against `grep -an '#graphByHash(' packages/core/src/server/http.ts`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";
import type { RunId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import type { RunProjection } from "../../src/run/projection.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { ControlPlane } from "../../src/server/http.ts";

const NOW = 1_700_000_000_000;

/**
 * One value, two graphs, opposite verdicts.
 *
 * NOT CREDENTIAL-SHAPED, deliberately: `DETECTORS` would catch `sk-live-…` under any
 * classification at all, and this suite is about which SPEC was consulted, not about the
 * backstop.
 */
const VALUE = "the vault passphrase is grandmothers pocket watch";
/** Declared only by alpha. On beta's spec this name is undeclared, which falls closed. */
const ALPHA_ONLY = "alpha knows what this is";

const resolver: ResourceResolver = {
  resolve: (ref) =>
    /^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref) ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" } : undefined,
};

/**
 * Two graphs whose only meaningful difference is what `payload` is classified as.
 *
 * `alpha` calls it `public` and also declares a channel `beta` has never heard of; `beta`
 * calls it `secret_ref`. Same node ids would make `GET /graphs/by-hash` untestable, so the
 * gate node's id differs too and is the second, independent witness of which graph came back.
 */
function spec(which: "alpha" | "beta"): GraphSpec {
  const alpha = which === "alpha";
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: which, project: "demo", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: {
      payload: { type: "string", reduce: "replace", classification: alpha ? "public" : "secret_ref" },
      ...(alpha ? { onlyAlpha: { type: "string", reduce: "replace", classification: "public" } } : {}),
      done: { type: "array", reduce: "append_ordered" },
    },
    inputs: alpha ? ["payload", "onlyAlpha"] : ["payload"],
    outputs: ["done"],
    nodes: [
      {
        id: alpha ? "askAlpha" : "askBeta",
        type: "human_gate",
        reads: alpha ? ["payload", "onlyAlpha"] : ["payload"],
        humanGate: { ref: "oversight/demo-write@stable", sla: { respondWithinMs: 900_000, onTimeout: "fail" } },
      },
      { id: "tail", type: "function", reads: ["payload"], writes: ["done"], function: { ref: "function/passthrough@stable" } },
    ],
    edges: [{ id: "e1", from: alpha ? "askAlpha" : "askBeta", to: "tail", kind: "seq" }],
  } as unknown as GraphSpec;
}

interface Two {
  readonly base: string;
  readonly alphaRun: string;
  readonly betaRun: string;
  readonly alpha: RunGraph;
  readonly beta: RunGraph;
  readonly store: MemoryStateStore;
  readonly bus: InProcessEventBus;
  readonly engine: Engine;
  readonly close: () => Promise<void>;
}

async function settle(engine: Engine, runId: RunId): Promise<RunProjection> {
  for (let i = 0; i < 400; i++) {
    const p = await engine.projection(runId);
    if (p?.status === "awaiting_gate" && Object.values(p.gates).some((g) => g.state === "open")) return p;
    await new Promise((res) => setTimeout(res, 5));
  }
  assert.fail(`run ${runId} never raised its gate`);
}

/**
 * A plane holding BOTH graphs, with one run of each parked on its gate.
 *
 * The insertion order is alpha-then-beta and it is load-bearing in one direction only: it is
 * what makes "return the first" a WRONG answer for the beta run. The alpha run covers the
 * other direction, so no mutant is right by accident.
 */
async function two(): Promise<Two> {
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
    resolver,
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 1 } },
  });

  const alpha = compileOrThrow({ spec: spec("alpha"), resolver, tools: {}, tenantCapabilities: [] });
  const beta = compileOrThrow({ spec: spec("beta"), resolver, tools: {}, tenantCapabilities: [] });
  assert.notEqual(alpha.graphHash, beta.graphHash, "the two graphs hash the same; this whole suite would be vacuous");

  const plane = new ControlPlane({ engine, store, bus, graphs: { alpha, beta }, now });
  const { port } = await plane.listen(0);
  const base = `http://127.0.0.1:${port}`;

  const start = async (workflow: string, inputs: Record<string, unknown>): Promise<string> => {
    const acc = (await (
      await fetch(`${base}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workflow, inputs }) })
    ).json()) as { runId: string };
    await settle(engine, acc.runId as RunId);
    return acc.runId;
  };
  const alphaRun = await start("alpha", { payload: VALUE, onlyAlpha: ALPHA_ONLY });
  const betaRun = await start("beta", { payload: VALUE });
  return { base, alphaRun, betaRun, alpha, beta, store, bus, engine, close: () => plane.close() };
}

const get = async (base: string, path: string): Promise<Record<string, unknown>> => {
  const res = await fetch(`${base}${path}`);
  assert.equal(res.status, 200, `${path} answered ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
};

// ── the disclosure the lookup decides ─────────────────────────────────────────────────────

test("TWO RUNS, TWO SPECS, ONE PLANE — each run's channels are redacted by ITS OWN graph", async () => {
  // Neither verdict can be reached by returning "a graph": alpha's `payload` must survive and
  // beta's must not, off the same channel name, the same value, and the same plane.
  const t = await two();
  try {
    const a = (await get(t.base, `/runs/${t.alphaRun}`))["channels"] as Record<string, unknown>;
    const b = (await get(t.base, `/runs/${t.betaRun}`))["channels"] as Record<string, unknown>;
    assert.equal(a["payload"], VALUE, "the alpha run was redacted by somebody else's spec");
    assert.equal(b["payload"], "[secret]", "the beta run's secret_ref channel was served under alpha's `public`");
    // AND THE NAME ONLY ALPHA DECLARES. A lookup that returned beta for the alpha run would
    // find `onlyAlpha` undeclared and fall closed — a different failure from the one above,
    // caught by a different assertion.
    assert.equal(a["onlyAlpha"], ALPHA_ONLY, "a channel the run's own spec declares was treated as undeclared");
  } finally {
    await t.close();
  }
});

test("THE CROSS-RUN GATE QUEUE LOOKS THE GRAPH UP PER RUN — one queue spans two specs", async () => {
  // `GET /gates` is the one route that mixes runs, so hoisting the lookup out of its loop
  // would redact one run's channels by another's spec. The queue carries both gates and each
  // one has to be answered by its own graph.
  const t = await two();
  try {
    const gates = (await get(t.base, "/gates"))["gates"] as { nodeId: string; payload?: { state?: Record<string, unknown> } }[];
    assert.equal(gates.length, 2, `the queue served ${gates.length} gates`);
    const byNode = new Map(gates.map((g) => [g.nodeId, g]));
    assert.equal(byNode.get("askAlpha")?.payload?.state?.["payload"], VALUE, "alpha's gate was redacted by beta's spec");
    assert.equal(byNode.get("askBeta")?.payload?.state?.["payload"], "[secret]", "beta's gate was served under alpha's `public`");

    // The per-run route agrees with the cross-run one, gate for gate.
    const perRun = async (id: string): Promise<Record<string, unknown>> => {
      const gs = (await get(t.base, `/runs/${id}/gates`))["gates"] as { payload?: { state?: Record<string, unknown> } }[];
      return gs[0]!.payload!.state!;
    };
    assert.equal((await perRun(t.alphaRun))["payload"], VALUE);
    assert.equal((await perRun(t.betaRun))["payload"], "[secret]");
  } finally {
    await t.close();
  }
});

test("THE EVENT STREAM LOOKS THE GRAPH UP PER RUN TOO — the hash comes off the projection", async () => {
  // `#streamEvents` reads the hash once, off the projection it already had to read for its
  // ownership scope. Once, and off the RIGHT run.
  const t = await two();
  try {
    const inputsOn = async (id: string): Promise<Record<string, unknown>> => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 5_000);
      try {
        const res = await fetch(`${t.base}/runs/${id}/events`, { signal: ctl.signal });
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (!buf.includes("run.submitted")) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
        }
        await reader.cancel().catch(() => {});
        const line = buf.split("\n").find((l) => l.startsWith("data: ") && l.includes("run.submitted"));
        assert.ok(line !== undefined, `run ${id} never streamed its run.submitted`);
        return (JSON.parse(line.slice(6)) as { payload: { inputs: Record<string, unknown> } }).payload.inputs;
      } finally {
        clearTimeout(timer);
        ctl.abort();
      }
    };
    assert.equal((await inputsOn(t.alphaRun))["payload"], VALUE, "the alpha stream was redacted by beta's spec");
    assert.equal((await inputsOn(t.betaRun))["payload"], "[secret]", "the beta stream served its secret under alpha's `public`");
  } finally {
    await t.close();
  }
});

// ── the other two callers ─────────────────────────────────────────────────────────────────

test("`GET /graphs/by-hash/:hash` ANSWERS WITH THE GRAPH THAT HASH NAMES, not with whichever is first", async () => {
  // The structure route is what a console caches forever, keyed by hash. Handing back the
  // wrong graph under the right hash poisons that cache with another workflow's shape.
  const t = await two();
  try {
    for (const [g, node] of [
      [t.alpha, "askAlpha"],
      [t.beta, "askBeta"],
    ] as const) {
      const body = await get(t.base, `/graphs/by-hash/${encodeURIComponent(g.graphHash)}`);
      assert.equal(body["graphHash"], g.graphHash, "the route answered under a hash it was not asked for");
      const ids = (body["nodes"] as { id: string }[]).map((n) => n.id);
      assert.ok(ids.includes(node), `the route returned the other graph: ${ids.join(", ")}`);
    }
    // A hash NOBODY holds is a 404, not the first graph on the shelf.
    const missing = await fetch(`${t.base}/graphs/by-hash/${encodeURIComponent(`sha256:${"e".repeat(64)}`)}`);
    assert.equal(missing.status, 404, "an unknown hash was answered with a graph");
  } finally {
    await t.close();
  }
});

test("`#bindFromIndex` ATTACHES THE RUN'S OWN GRAPH — a second plane, cold, over the same journal", async () => {
  // The fourth caller, and the one whose failure is not a disclosure but a wrong execution:
  // a command route binds the graph before it acts. `Engine.attach` refuses any graph that is
  // not the one the run compiled, so a lookup that answered generously turns an ordinary
  // `advance` into an error on a run that is perfectly fine.
  const t = await two();
  const cold = new ControlPlane({ engine: t.engine, store: t.store, bus: t.bus, graphs: { alpha: t.alpha, beta: t.beta }, now: () => NOW });
  const { port } = await cold.listen(0);
  try {
    for (const id of [t.alphaRun, t.betaRun]) {
      const res = await fetch(`http://127.0.0.1:${port}/runs/${id}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "advance" }),
      });
      const text = await res.text();
      assert.equal(res.status, 200, `advance on ${id} answered ${res.status}: ${text}`);
      // AND THE ANSWER IS THAT RUN'S OWN SUMMARY, redacted by that run's own spec — the
      // command routes go through `#summary` like every other projection route.
      const body = JSON.parse(text) as { runId: string; channels: Record<string, unknown> };
      assert.equal(body.runId, id);
      assert.equal(body.channels["payload"], id === t.alphaRun ? VALUE : "[secret]", "a command reply was redacted by the wrong spec");
    }
  } finally {
    await cold.close();
    await t.close();
  }
});

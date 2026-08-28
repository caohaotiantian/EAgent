/**
 * A STEP WHOSE OUTPUT WAS TOO BIG TO STAY IN THE JOURNAL LOOKED LIKE A STEP THAT WROTE NOTHING.
 *
 * Payload externalisation moves a `replace` channel whose canonical value is strictly above
 * `EXTERNALISE_ABOVE_BYTES` out of `task.committed.writes` and into `task.committed.external`,
 * as `{digest, bytes}`. The two maps are disjoint by construction. `foldTrajectory` read only
 * `writes`, so the self-improvement evidence under-counted exactly the runs that moved the most
 * data: `channelsWritten` came back empty, `observationDigest` collapsed to the digest of `{}`
 * — the same value for every such run — and `score.ts`'s `didWork` therefore read `delivered:
 * false`, the verdict it reserves for a body that returned `{}`.
 *
 * The rule these tests pin is the same one `journal/events.ts` states for the projection: the
 * fold learns which channels are handles from the DECLARATION, never from the shape of a value.
 * A node body that writes a literal `{$payload: {...}}` is an ordinary value and stays one.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { digest } from "../../src/canonical.ts";
import { DEFAULT_WEIGHTS, cohortKeyOf, measureCohort, scoreTrajectory } from "../../src/evolution/score.ts";
import { foldTrajectory } from "../../src/evolution/trajectory.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { RunId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { EXTERNALISE_ABOVE_BYTES, memoryPayloads, payloadHandle, type PayloadStore } from "../../src/journal/payloads.ts";
import type { StateStore } from "../../src/journal/store.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "../run/skeleton.ts";

const NOW = 1_700_000_000_000;

/** Well over the 64 KiB threshold, and with no shorter canonical form. */
const BIG = "x".repeat(300_000);
/** Under it, so the identical graph journals the value inline. */
const SMALL = "x".repeat(64);

/**
 * One `function` node whose ONLY commit is the big channel, so there is nothing else for the
 * fold to notice the step by. `report` is `replace`, is not an output, and is named by no
 * expression, so `externalisableChannels` keeps it; `note` is the run's tiny answer and is an
 * output, which removes it from the eligible set.
 */
function spec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "big-writer", project: "evolution", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: {
      src: { type: "string", reduce: "replace" },
      report: { type: "string", reduce: "replace" },
      note: { type: "string", reduce: "replace" },
    },
    inputs: ["src"],
    outputs: ["note"],
    nodes: [
      { id: "write", type: "function", reads: ["src"], writes: ["report"], function: { ref: "function/expand@stable" } },
      { id: "note", type: "function", reads: ["report"], writes: ["note"], function: { ref: "function/note@stable" } },
    ],
    edges: [{ id: "e0", from: "write", to: "note", kind: "seq" }],
  } as unknown as GraphSpec;
}

function functions(): FunctionRegistry {
  const f = new FunctionRegistry();
  f.register("function/expand@stable", (view) => ({ writes: { report: view.get<string>("src") } }));
  f.register("function/note@stable", (view) => ({ writes: { note: `${(view.get<string>("report") ?? "").length}` } }));
  return f;
}

function rig(payloads?: PayloadStore): { engine: Engine; store: StateStore } {
  const store = new MemoryStateStore({ now: () => NOW });
  const engine = new Engine({
    store,
    tools: new ToolRegistry(),
    functions: functions(),
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: [], systemFloor: "out" },
    ...(payloads === undefined ? {} : { payloads }),
  });
  return { engine, store };
}

const compile = (s: GraphSpec) => compileOrThrow({ spec: s, resolver: resolver(), tools: {}, tenantCapabilities: [] });

async function eventsOf(store: StateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const e of store.read(runId, 1)) out.push(e);
  return out;
}

async function run(doc: string, payloads?: PayloadStore) {
  const graph = compile(spec());
  const { engine, store } = rig(payloads);
  const runId = await engine.submit({ graph, inputs: { src: doc } });
  const p = await engine.advance(runId);
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  const events = await eventsOf(store, runId);
  return { events, trajectory: foldTrajectory(events, { graph }), graph };
}

// ── V4: the fold never learned about the `external` map ──────────────────────

test("a step whose write was externalised is not a step that wrote nothing", async () => {
  const big = await run(BIG, memoryPayloads());

  // The premise: the engine really did externalise, and `writes` really is empty.
  const committed = big.events.find((e) => e.type === "task.committed" && String(e.taskId).startsWith("write@"));
  assert.ok(committed !== undefined && committed.type === "task.committed");
  assert.deepEqual(Object.keys(committed.payload.writes), []);
  assert.deepEqual(Object.keys(committed.payload.external ?? {}), ["report"]);
  assert.ok((committed.payload.external ?? {})["report"]!.bytes > EXTERNALISE_ABOVE_BYTES);

  const step = big.trajectory.steps.find((s) => String(s.nodeId) === "write");
  assert.ok(step !== undefined);
  assert.equal(step.status, "succeeded");
  assert.deepEqual(step.channelsWritten, ["report"]);
});

test("the same graph, inline and externalised, reports the same channel names", async () => {
  const inline = await run(SMALL);
  const big = await run(BIG, memoryPayloads());
  assert.deepEqual(
    big.trajectory.steps.map((s) => s.channelsWritten),
    inline.trajectory.steps.map((s) => s.channelsWritten),
  );
});

test("the observation digest still distinguishes two different large documents", async () => {
  const a = await run(`a${BIG}`, memoryPayloads());
  const b = await run(`b${BIG}`, memoryPayloads());
  const empty = digest({});
  const da = a.trajectory.steps.find((s) => String(s.nodeId) === "write")!.observationDigest;
  const db = b.trajectory.steps.find((s) => String(s.nodeId) === "write")!.observationDigest;
  assert.notEqual(da, empty, "an externalised write folded to the digest of nothing");
  assert.notEqual(da, db, "two different documents folded to one observation");
});

/**
 * ONE NODE, ONE COMMIT, AND THAT COMMIT EXTERNALISED. The two-node graph above still has a
 * tiny `note` write for `didWork` to find, which is exactly why it hid this: the distortion
 * only becomes a score when the externalised channel is the run's WHOLE product. A `function`
 * node bills nothing, so `modelCalls`, `toolCalls` and `subgraphRuns` are all zero and
 * `steps[].channelsWritten` is the only evidence of work left in the journal.
 */
function soloSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "solo-writer", project: "evolution", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: {
      src: { type: "string", reduce: "replace" },
      report: { type: "string", reduce: "replace" },
    },
    inputs: ["src"],
    outputs: [],
    nodes: [
      { id: "write", type: "function", reads: ["src"], writes: ["report"], function: { ref: "function/expand@stable" } },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

test("a run whose only product was externalised is still a run that did work", async () => {
  const graph = compile(soloSpec());
  const { engine, store } = rig(memoryPayloads());
  const runId = await engine.submit({ graph, inputs: { src: BIG } });
  const p = await engine.advance(runId);
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  const t = foldTrajectory(await eventsOf(store, runId), { graph });

  // A `function` node bills nothing, so there is no other member of `didWork` to fall back on.
  assert.deepEqual({ m: t.usage.modelCalls, c: t.usage.toolCalls, s: t.usage.subgraphRuns }, { m: 0, c: 0, s: 0 });

  const cohort = measureCohort(cohortKeyOf(t), [t], { weights: DEFAULT_WEIGHTS });
  const scored = scoreTrajectory(t, cohort);
  assert.equal(scored.components.delivered, true);
});

// ── The declaration is the authority, not the shape ──────────────────────────

test("a node body that writes a literal handle shape is an ordinary value", async () => {
  const graph = compile(spec());
  const f = new FunctionRegistry();
  // The exact shape `payloadHandle` produces, written by a body that externalised nothing.
  f.register("function/expand@stable", () => ({ writes: { report: { $payload: { digest: "deadbeef", bytes: 9 } } } }));
  f.register("function/note@stable", () => ({ writes: { note: "ok" } }));
  const store = new MemoryStateStore({ now: () => NOW });
  const engine = new Engine({
    store,
    tools: new ToolRegistry(),
    functions: f,
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: [], systemFloor: "out" },
    payloads: memoryPayloads(),
  });
  const runId = await engine.submit({ graph, inputs: { src: "seed" } });
  const p = await engine.advance(runId);
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  const t = foldTrajectory(await eventsOf(store, runId), { graph });
  const step = t.steps.find((s) => String(s.nodeId) === "write")!;
  assert.deepEqual(step.channelsWritten, ["report"]);
  // The value was never externalised, so the fold must digest the value it actually holds —
  // not the substitute it would build for a declared handle.
  assert.equal(step.observationDigest, digest({ report: { $payload: { digest: "deadbeef", bytes: 9 } } }));
});

// ── The shape the two folds agree on ─────────────────────────────────────────

/**
 * THE DESIGN ARGUMENT FOR `observed()` IS THAT IT USES `payloadHandle`, THE SAME FUNCTION
 * `run/projection.ts` BUILDS `withHandles` FROM — "so the two folds describe an externalised
 * channel one way rather than two". Nothing pinned it. A reviewer replaced `payloadHandle(ref)`
 * in `observed()` with `{ $payload: { digest: ref.digest } }`, dropping `bytes` and diverging
 * from `projection.ts:withHandles`, and all five tests above stayed green.
 *
 * The digest is over the WHOLE handle, so `bytes` is inside it — which is what makes one
 * assertion enough, and which is also why the divergence was invisible: every test above
 * compares a digest to another digest built the same wrong way, or to `digest({})`. This one
 * compares it to the handle rebuilt from the JOURNAL's own `{digest, bytes}` instead.
 */
test("an externalised channel folds to the handle shape the projection uses, `bytes` included", async () => {
  const graph = compile(spec());
  const { engine, store } = rig(memoryPayloads());
  const runId = await engine.submit({ graph, inputs: { src: BIG } });
  assert.equal((await engine.advance(runId)).status, "succeeded");
  const events = await eventsOf(store, runId);

  const committed = events.find((e) => e.type === "task.committed" && String(e.taskId).startsWith("write@"));
  assert.ok(committed !== undefined && committed.type === "task.committed");
  const ref = (committed.payload.external ?? {})["report"];
  assert.ok(ref !== undefined && typeof ref.bytes === "number" && ref.bytes > 0, "the journal records digest AND bytes");

  const step = foldTrajectory(events, { graph }).steps.find((s) => String(s.nodeId) === "write")!;
  assert.equal(
    step.observationDigest,
    digest({ report: payloadHandle(ref) }),
    "the trajectory's handle must be the projection's handle — same function, same fields, `bytes` too",
  );
  assert.notEqual(
    step.observationDigest,
    digest({ report: { $payload: { digest: ref.digest } } }),
    "…and specifically not a handle with `bytes` dropped, which is the mutation nothing caught",
  );
});

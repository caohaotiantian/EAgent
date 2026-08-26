/**
 * A COHORT HAS TO BE ABLE TO ASSEMBLE, or P3's promotion path is unreachable arithmetic.
 *
 * `isGolden` condition 4 needs `n >= 30` comparable runs. `cohortKeyOf` keys on
 * `workflow|graphHash|tenantTier|inputBucket`, and the default `inputBucket` used to be
 * `digest(inputs).slice(7, 15)` — a digest of the WHOLE input — so every distinct input was
 * its own cohort of one. Measured on five live GLM-5.2 runs of one graph over five diffs:
 * five distinct cohort keys, every one `n = 1`, and the verdict said so
 * (`goldenBlockers: ["cohort large enough: n = 1 (need ≥ 30)"]`). A code-review workflow
 * reviews a different diff every time, by definition, so no real workflow could ever qualify.
 *
 * The default is now the input's SHAPE. What these tests hold down:
 *
 * 1. Five runs of ONE graph over five DIFFERENT inputs share one cohort key, and
 *    `measureCohort` counts all five.
 * 2. The bucket is not a constant — a different input SHAPE is still a different cohort.
 *    This is the assertion that goes red if somebody "fixes" a future cohort problem by
 *    flattening the bucket, which would make `n >= 30` meet itself by mixing everything.
 * 3. Two different WORKFLOWS still do not share a cohort.
 * 4. The seam is REACHABLE: `loom score --bucket` reaches the fold of the run being judged
 *    AND the fold of every peer. Wiring it to one of the two silently splits the cohort it
 *    was supposed to join, so `fields:` is checked by the count it produces.
 *
 * THE COST OF (1), STATED: a cohort of five runs over one to five documents mixes genuinely
 * different work, so `p50Cost` is a median over a spread. Measured by the first test itself —
 * it asserts the spread exists rather than pretending it does not.
 *
 * Offline and deterministic: the mock model adapter, a local tool closure, an injected clock.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { NodeId, RunId } from "../../src/ids.ts";
import type { EventPayloads, JournalEvent } from "../../src/journal/events.ts";
import { isEvent } from "../../src/journal/events.ts";
import { main, openWorkspace, parseArgs } from "../../src/cli.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import { cohortKeyOf, measureCohort, scoreTrajectory } from "../../src/evolution/score.ts";
import { foldTrajectory, type Trajectory } from "../../src/evolution/trajectory.ts";
import { agent } from "../../src/agent.ts";
import { MockModelAdapter } from "../../src/run/registry.ts";
import { SKELETON_TENANT_CAPS, SKELETON_TOOLS, compileSkeleton, harness, resolver, skeletonSpec } from "../run/skeleton.ts";

// ---------------------------------------------------------------------------
// 1 · one graph, different inputs, one cohort — on a real Engine
// ---------------------------------------------------------------------------

/** One complete run of the walking skeleton over `paths`, folded. */
async function skeletonRun(paths: readonly string[], graph = compileSkeleton()): Promise<Trajectory> {
  const h = harness();
  const runId = await h.engine.submit({ graph, inputs: { paths: [...paths] } });
  let p = await h.engine.advance(runId);
  const gate = Object.values(p.gates).find((g) => g.state === "open");
  if (gate !== undefined) {
    p = await h.engine.resolveGate(runId, {
      gateId: gate.gateId,
      decision: { kind: "approve" },
      actor: { kind: "human", subject: "u:a", via: "console" },
      idempotencyKey: "k",
    });
  }
  assert.equal(p.status, "succeeded");
  const events: JournalEvent[] = [];
  for await (const e of h.store.read(runId, 1)) events.push(e);
  return foldTrajectory(events, { graph });
}

const docs = (k: number): string[] => Array.from({ length: k }, (_, i) => `doc-${String(i)}.md`);

test("FIVE RUNS OVER FIVE DIFFERENT INPUTS ASSEMBLE INTO ONE COHORT", async () => {
  const trajectories: Trajectory[] = [];
  for (const k of [1, 2, 3, 4, 5]) trajectories.push(await skeletonRun(docs(k)));

  // The inputs really are five different inputs — the premise, not an assumption.
  assert.equal(new Set(trajectories.map((t) => t.inputDigest)).size, 5);

  const keys = new Set(trajectories.map(cohortKeyOf));
  assert.equal(keys.size, 1, `five runs of one graph must share one cohort key; got ${JSON.stringify([...keys])}`);

  const key = [...keys][0]!;
  const cohort = measureCohort(key, trajectories);
  assert.equal(cohort.n, 5, "and every one of them counts toward MIN_COHORT_SIZE");

  // THE COST OF THE COARSER BUCKET, MEASURED RATHER THAN ASSERTED AWAY. One document and
  // five documents are the same SHAPE and genuinely different work, so the cohort's medians
  // are medians over a spread. That is the trade this default makes; the number is real and
  // the test says so out loud instead of the docstring claiming it.
  const costs = trajectories.map((t) => t.usage.costUsd);
  assert.ok(Math.min(...costs) < Math.max(...costs), "the cohort mixes work of different sizes");
  assert.ok(cohort.p50Cost > Math.min(...costs) && cohort.p50Cost < Math.max(...costs));
  assert.equal(Math.max(...costs) / Math.min(...costs) > 4, true, "a 5x spread, and the fold's docstring says so");

  // THE TRADE, BOTH HALVES — the numbers `trajectory.ts:defaultBucket` cites, pinned here so a
  // change that makes them false goes red instead of leaving a comment that lies.
  //
  // Every one of these five runs has outcome 1.000. Under the merged cohort they no longer
  // score alike, because `costNormalized` is `clamp01(cost / p50Cost)` and the term is
  // `weights.cost * (1 - costNormalized)` — that is the noise the coarser bucket buys. What it
  // buys it WITH is the other half: in a cohort of one a run is compared against itself, so
  // `costNormalized` is exactly 1 and 20% of the metric contributes exactly 0 to every run.
  assert.deepEqual(trajectories.map((t) => scoreTrajectory(t, cohort).outcome), [1, 1, 1, 1, 1]);
  assert.deepEqual(
    trajectories.map((t) => Number(scoreTrajectory(t, cohort).score.toFixed(3))),
    [0.833, 0.767, 0.7, 0.7, 0.7],
    "the cost term now separates runs the old rule could not…",
  );
  const alone = trajectories.map((t) => scoreTrajectory(t, measureCohort(cohortKeyOf(t), [t])));
  assert.deepEqual(
    alone.map((x) => Number(x.score.toFixed(3))),
    [0.7, 0.7, 0.7, 0.7, 0.7],
    "…and a cohort of one never could, whatever the run spent",
  );
  assert.deepEqual(alone.map((x) => x.components.costNormalized), [1, 1, 1, 1, 1], "a run is always exactly at its own median");
});

test("CONTROL · a different input SHAPE is still a different cohort", async () => {
  // Same graph, same workflow: only the shape of the input differs. If the bucket were a
  // constant — the cheap way to make any cohort assemble — these would collide.
  const spec: GraphSpec = {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "shape-probe", project: "demo", version: 1 },
    policy: { posture: "out", capabilities: [] },
    channels: {
      payload: { type: "object", reduce: "replace" },
      seen: { type: "object", reduce: "replace" },
    },
    inputs: ["payload"],
    outputs: ["seen"],
    nodes: [
      {
        id: "note" as NodeId,
        type: "function",
        reads: ["payload"],
        writes: ["seen"],
        function: { ref: "function/note@stable" },
      },
    ],
    edges: [],
  };

  async function run(payload: Record<string, unknown>): Promise<Trajectory> {
    const h = harness();
    h.functions.register("function/note@stable", () => ({ writes: { seen: { ok: true } } }));
    const graph = compileOrThrow({ spec, resolver: resolver(), tools: {}, tenantCapabilities: [] });
    const runId = await h.engine.submit({ graph, inputs: { payload } });
    const p = await h.engine.advance(runId);
    assert.equal(p.status, "succeeded");
    const events: JournalEvent[] = [];
    for await (const e of h.store.read(runId, 1)) events.push(e);
    return foldTrajectory(events, { graph });
  }

  const a = await run({ diff: "one line" });
  const b = await run({ diff: "a completely different, much longer diff" });
  const c = await run({ diff: "x", verbose: true });

  assert.equal(cohortKeyOf(a), cohortKeyOf(b), "same shape, different value — one cohort");
  assert.notEqual(cohortKeyOf(a), cohortKeyOf(c), "a different shape is different work");
  assert.match(a.cohort.inputBucket, /^shape:/, "the key says which rule bucketed it");
});

test("CONTROL · two different WORKFLOWS do not share a cohort", async () => {
  const mine = await skeletonRun(docs(3));
  const other = await skeletonRun(docs(3), compileSkeleton(skeletonSpec({ metadata: { name: "other-workflow", project: "demo", version: 1 } })));

  assert.equal(mine.cohort.inputBucket, other.cohort.inputBucket, "the inputs ARE the same shape…");
  assert.notEqual(cohortKeyOf(mine), cohortKeyOf(other), "…and they are still different work");
  // `measureCohort` measures a population the CALLER selected — it filters on status and
  // "did work", never on the key — so the selection is what has to be right here.
  const key = cohortKeyOf(mine);
  assert.equal(measureCohort(key, [mine, other].filter((t) => cohortKeyOf(t) === key)).n, 1, "a cohort is not just anything that ran");
});

test("the THIRD product-path caller, agent(), needed no change at all", async () => {
  // `agent.ts:334` folds without `bucketInput` too, and it stays that way on purpose: a second
  // knob with no caller is the exact mistake this task exists to fix. Under the shape default
  // its runs already share a cohort, which is a fact to measure rather than reason about.
  const a = agent({
    prompt: "answer the question",
    model: "mock-1",
    adapter: new MockModelAdapter({ script: () => ({ text: "done", inputTokens: 10, outputTokens: 2 }), pricePerMTok: 1 }),
  });
  const short = await a.run("why?");
  const long = await a.run("why, at considerably greater length and about something else entirely?");
  assert.equal(short.status, "succeeded");
  assert.equal(long.status, "succeeded");

  const t1 = await a.trajectory(short.runId);
  const t2 = await a.trajectory(long.runId);
  assert.notEqual(t1.inputDigest, t2.inputDigest, "two different questions…");
  assert.equal(cohortKeyOf(t1), cohortKeyOf(t2), "…one cohort, with no option set anywhere");
  assert.equal(measureCohort(cohortKeyOf(t1), [t1, t2]).n, 2);
});

// ---------------------------------------------------------------------------
// 2 · the seam, wired through the CLI, reaching BOTH folds
// ---------------------------------------------------------------------------

const CLI_GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "read-file", project: "demo", version: 1 },
  policy: { posture: "out", capabilities: ["fs:read"] },
  channels: {
    source: { type: "string", reduce: "replace" },
    tier: { type: "string", reduce: "replace" },
    body: { type: "string", reduce: "replace" },
  },
  inputs: ["source", "tier"],
  outputs: ["body"],
  nodes: [
    {
      id: "read",
      type: "tool",
      reads: ["source", "tier"],
      writes: ["body"],
      tool: { name: "fs.read", version: "1.0", args: { path: "${source}" } },
      unhandled: true,
    },
  ],
  edges: [],
};

function workspace(): { dir: string; graphFile: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-bucket-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  const graphFile = join(dir, "graphs", "read.json");
  writeFileSync(graphFile, JSON.stringify(CLI_GRAPH));
  for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(dir, name), `contents of ${name}`);
  return { dir, graphFile, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const errOut: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => (errOut.push(String(c)), true)) as typeof process.stderr.write;
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: errOut.join("") };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

async function drive(dir: string, graphFile: string, inputs: Record<string, string>): Promise<string> {
  const r = await cli(["run", graphFile, "--workspace", dir, "--input", JSON.stringify(inputs)]);
  assert.equal(r.code, 0, r.err);
  const { runId, status } = JSON.parse(r.out) as { runId: string; status: string };
  assert.equal(status, "succeeded", r.out);
  return runId;
}

async function score(dir: string, runId: string, bucket?: string): Promise<EventPayloads["evolution.scored"]> {
  const r = await cli(["score", runId, "--workspace", dir, ...(bucket === undefined ? [] : ["--bucket", bucket])]);
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out) as EventPayloads["evolution.scored"];
}

test("loom score: the DEFAULT groups three runs on three different files into one cohort", async () => {
  const w = workspace();
  try {
    const ids = [
      await drive(w.dir, w.graphFile, { source: "a.txt", tier: "gold" }),
      await drive(w.dir, w.graphFile, { source: "b.txt", tier: "gold" }),
      await drive(w.dir, w.graphFile, { source: "c.txt", tier: "silver" }),
    ];
    const last = await score(w.dir, ids[2]!);
    assert.equal(last.cohort.n, 3, `three runs of one graph are one cohort; key ${last.cohortKey}`);
    assert.ok(last.cohortKey.endsWith(`|shape:${last.cohortKey.split("|shape:")[1]!}`));
  } finally {
    w.dispose();
  }
});

test("loom score --bucket exact: the OLD rule is still available, and it is one cohort per input", async () => {
  const w = workspace();
  try {
    const ids = [
      await drive(w.dir, w.graphFile, { source: "a.txt", tier: "gold" }),
      await drive(w.dir, w.graphFile, { source: "b.txt", tier: "gold" }),
    ];
    const row = await score(w.dir, ids[1]!, "exact");
    assert.equal(row.cohort.n, 1, "a workflow drawn from a small fixed set may WANT this");
    assert.match(row.cohortKey, /\|exact:[0-9a-f]{8}$/);
  } finally {
    w.dispose();
  }
});

test("loom score --bucket fields: reaches the peer fold too, or the cohort it joins is empty", async () => {
  const w = workspace();
  try {
    const ids = [
      await drive(w.dir, w.graphFile, { source: "a.txt", tier: "gold" }),
      await drive(w.dir, w.graphFile, { source: "b.txt", tier: "gold" }),
      await drive(w.dir, w.graphFile, { source: "c.txt", tier: "silver" }),
    ];
    // Two gold runs on different files are one cohort; the silver run is its own.
    const gold = await score(w.dir, ids[1]!, "fields:tier");
    assert.equal(gold.cohort.n, 2, "the flag has to reach BOTH folds — a peer folded under the default never matches");
    const silver = await score(w.dir, ids[2]!, "fields:tier");
    assert.equal(silver.cohort.n, 1);
    assert.notEqual(gold.cohortKey, silver.cohortKey);
    // A DIGEST, never the value: `cohortKey` is journaled, and input values in a journal are
    // a second copy of production data.
    assert.equal(gold.cohortKey.includes("gold"), false, "the tier's VALUE never reaches the key");
    assert.match(gold.cohortKey, /\|fields\[tier\]:[0-9a-f]{8}$/);
  } finally {
    w.dispose();
  }
});

test("loom score --bucket fields: a channel no run supplied is a BUCKET, not a crash", async () => {
  // `digest` refuses `undefined` inside an array — measured: "undefined array element at [0][1]"
  // — so passing `inputs[k]` straight through took `loom score` down with a canonicalization
  // error for any run that did not carry the named channel.
  const w = workspace();
  try {
    const a = await drive(w.dir, w.graphFile, { source: "a.txt", tier: "gold" });
    await drive(w.dir, w.graphFile, { source: "b.txt", tier: "silver" });
    const row = await score(w.dir, a, "fields:nosuch");
    assert.equal(row.cohort.n, 2, "nobody has it, so everybody shares the bucket");
    assert.match(row.cohortKey, /\|fields\[nosuch\]:[0-9a-f]{8}$/);
  } finally {
    w.dispose();
  }
});

test("loom score --bucket: a mode nobody defined is REFUSED, not absorbed", async () => {
  const w = workspace();
  try {
    const runId = await drive(w.dir, w.graphFile, { source: "a.txt", tier: "gold" });
    for (const bad of ["everything", "fields:", "fields"]) {
      await assert.rejects(
        () => cli(["score", runId, "--workspace", w.dir, "--bucket", bad]),
        (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && e.message.includes("--bucket"),
        `--bucket ${bad} must not silently fall back to the default`,
      );
    }
    // A run scored under a refused flag is a run nobody judged.
    const ws = openWorkspace(parseArgs(["gates", "--workspace", w.dir]));
    try {
      const events: JournalEvent[] = [];
      for await (const e of ws.store.read(runId as RunId, 1)) events.push(e);
      assert.equal(events.some((e) => isEvent(e, "evolution.scored")), false);
    } finally {
      ws.close();
    }
  } finally {
    w.dispose();
  }
});

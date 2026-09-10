/**
 * A GATE INSIDE A FAN-OUT READ A VALUE ITS OWN BRANCH HAD ALREADY REPLACED, AND SAID NOTHING.
 *
 * `TODO.md` §A.58(4). `#executeTask` composes three layers —
 * `#withBranchWrites(ctx, await #resolveReads(ctx, leased, w), w.task.branch)` — and `loom gates`
 * reproduces the inner one only. `#withBranchWrites` folds every SUCCEEDED task at EXACTLY the
 * gate's own branch path through `reduceState`, so for a `replace` channel it REPLACES the value.
 * A fan-out holds a branch's writes until its join folds them, so the stored projection this door
 * reads still carries the pre-branch value.
 *
 * THE DIRECTION IS THE FINDING. Two earlier drafts of the enumeration in `cli.ts` called this "a
 * sibling's write" and "shows LESS than the console, never more"; both are false. It is the gate's
 * OWN branch's earlier nodes, and what is printed is a DIFFERENT, OLDER value — not a subset of
 * the truth. Measured on the fixture below, before the notice existed:
 *
 *     loom gates    →  reads = {"mid":"BASE-VALUE-BEFORE-THE-BRANCH-WROTE"}
 *                      readsTruncated = {}     stderr = ""
 *     loom approve  →  succeeded, outputs = {"mid":"BUMPED-VALUE-THE-CONSOLE-SEES"}
 *
 * An operator answered for a value the door never put in front of them, and `#approvalStillCovers`
 * does not fire: nothing changed between raise and dispatch, so the disagreement is between two
 * RENDERINGS rather than across time. On that same row, `contentDigest` is `digest(#gateBinding)`
 * over the OVERLAID projection, so the binding does not describe the `reads` beside it.
 *
 * WHAT IS FIXED HERE AND WHAT IS NOT. Computing the overlaid value needs `reduceState` in `cli.ts`
 * — a second copy of the engine's reducer, which is the drift `gatesWithReads` refuses by design —
 * so the VALUE is still wrong and §A.58(4) stays open. What is closed is the SILENCE: whether a
 * held write exists on a printed channel is decidable from `p.tasks` alone, so the row now carries
 * `readsMayBeStale` and stderr says so. These tests pin the notice, the field, and the control that
 * keeps it from becoming a warning printed on every gate.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_SRC = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

const BASE = "BASE-VALUE-BEFORE-THE-BRANCH-WROTE";
const BUMPED = "BUMPED-VALUE-THE-CONSOLE-SEES";

/**
 * `seed --fanout--> bump --seq--> approve`, with `bump` and `approve` both members of `gather`.
 *
 * The gate sits INSIDE the branch and behind `bump` on a `seq` edge, so by the time it is raised
 * `bump` has succeeded and is holding `mid` for the join. `maxWidth: 1` keeps the fan to one
 * branch, which is all this needs and makes the output a single row.
 */
const FANOUT_GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "branch-gate", project: "demo", version: 1 },
  policy: { posture: "on", capabilities: [], expansion: { maxNodes: 64, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
  channels: {
    items: { type: "array", reduce: "replace" },
    item: { type: "string", reduce: "replace" },
    mid: { type: "string", reduce: "replace" },
  },
  inputs: ["mid"],
  outputs: ["mid"],
  nodes: [
    { id: "seed", type: "function", reads: ["mid"], writes: ["items"], function: { ref: "function/seed@stable" } },
    { id: "bump", type: "function", reads: ["mid", "item"], writes: ["mid"], function: { ref: "function/bump@stable" } },
    { id: "approve", type: "human_gate", reads: ["mid"], writes: [], humanGate: { ref: "oversight/publish@stable" } },
    { id: "gather", type: "join", reads: ["mid"], writes: ["mid"], join: { branches: ["bump", "approve"], mode: "all", onBranchError: "fail" } },
  ],
  edges: [
    { id: "fan", from: "seed", to: "bump", kind: "fanout", over: "items", as: "item", maxWidth: 1 },
    { id: "toGate", from: "bump", to: "approve", kind: "seq" },
    { id: "cb", from: "bump", to: "gather", kind: "join" },
    { id: "ca", from: "approve", to: "gather", kind: "join" },
  ],
};

/**
 * THE CONTROL — the same shape with no fan-out, so no write is ever held.
 *
 * `bump` runs at the ROOT coordinate, where `writesHeldForJoin` is false and writes apply at
 * commit, so `loom gates` reads the CURRENT value and there is nothing to warn about. Without
 * this, a `readsMayBeStale` that simply listed every channel the run had ever written — or a
 * notice printed on every gate — would pass the test above and be useless.
 */
const ROOT_GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "root-gate", project: "demo", version: 1 },
  policy: { posture: "on", capabilities: [] },
  channels: { mid: { type: "string", reduce: "replace" } },
  inputs: ["mid"],
  outputs: ["mid"],
  nodes: [
    { id: "bump", type: "function", reads: ["mid"], writes: ["mid"], function: { ref: "function/bump@stable" } },
    { id: "approve", type: "human_gate", reads: ["mid"], writes: [], humanGate: { ref: "oversight/publish@stable" } },
  ],
  edges: [{ id: "toGate", from: "bump", to: "approve", kind: "seq" }],
};

interface Cap {
  code: number;
  out: string;
  err: string;
}

async function cli(argv: string[]): Promise<Cap> {
  return await new Promise<Cap>((resolve) => {
    execFile(
      process.execPath,
      [CLI_SRC, ...argv],
      { cwd: dirname(CLI_SRC), timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
      (e, stdout, stderr) => {
        resolve({ code: e === null ? 0 : ((e as NodeJS.ErrnoException & { code?: number }).code ?? 1), out: stdout, err: stderr });
      },
    );
  });
}

function workspace(graph: unknown): { dir: string; graphFile: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-branch-stale-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  mkdirSync(join(dir, "resources", "function"), { recursive: true });
  const graphFile = join(dir, "graphs", "g.json");
  writeFileSync(graphFile, JSON.stringify(graph));
  writeFileSync(join(dir, "resources", "function", "seed.js"), 'function (view) { return { writes: { items: ["only"] } }; }\n');
  writeFileSync(join(dir, "resources", "function", "bump.js"), `function (view) { return { writes: { mid: ${JSON.stringify(BUMPED)} } }; }\n`);
  return { dir, graphFile, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

interface GateRow {
  gateId: string;
  nodeId: string;
  contentDigest: string;
  reads?: Record<string, unknown>;
  readsTruncated?: Record<string, { bytes: number; shown: number }>;
  readsMayBeStale?: readonly string[];
}

async function park(w: { dir: string; graphFile: string }): Promise<{ runId: string; row: GateRow; err: string }> {
  const started = await cli(["run", w.graphFile, "--workspace", w.dir, "--input", JSON.stringify({ mid: BASE })]);
  assert.equal(started.code, 0, `${started.out}${started.err}`);
  const p = JSON.parse(started.out) as Record<string, unknown>;
  assert.equal(p["status"], "awaiting_gate", `the fixture must park for this to mean anything: ${started.out}`);
  const listed = await cli(["gates", String(p["runId"]), "--workspace", w.dir]);
  assert.equal(listed.code, 0, listed.err);
  const rows = JSON.parse(listed.out) as GateRow[];
  assert.equal(rows.length, 1, `expected one open gate: ${listed.out}`);
  return { runId: String(p["runId"]), row: rows[0]!, err: listed.err };
}

test("A GATE INSIDE A FAN-OUT SAYS ITS `reads` MAY BE STALE, on the row and on stderr", async () => {
  const w = workspace(FANOUT_GRAPH);
  try {
    const { row, err } = await park(w);
    assert.equal(row.nodeId, "approve");

    // THE FIELD, naming the channel and not merely raising a flag: an operator has to know WHICH
    // of the values in front of them is the doubtful one.
    assert.deepEqual(row.readsMayBeStale, ["mid"], JSON.stringify(row));

    // THE NOTICE, on stderr so `loom gates | jq` is unaffected — the same split the other three
    // "content" arms use. It names the gate and the channel, because a run can park several.
    assert.match(err, /! MAY BE STALE — gate_\S+ \(`mid`\)/, err);
    assert.match(err, /own branch/i, "the notice must say WHOSE write it is: not a sibling's");
    assert.match(err, /contentDigest/, "and that the binding on the row describes the other value");
    assert.ok(!/MAY BE STALE/.test(JSON.stringify(row)), "the prose is on stderr, not in the document");

    // THE RESIDUE IS STILL THERE, and this is what says so rather than pretending otherwise: the
    // printed value is the PRE-BRANCH one. If this ever starts failing because `reads.mid` is
    // `BUMPED`, the overlay has been closed and §A.58(4) is done — delete the field, not this
    // assertion's expectation.
    assert.equal(row.reads?.["mid"], BASE, "the value is still the stale one — only the silence is fixed");

    // AND THE TRUNCATION FIELD IS UNCHANGED BESIDE IT. `readsTruncated: {}` is a claim about
    // CUTTING and says nothing about currency; the two are separate axes and both are present.
    assert.deepEqual(row.readsTruncated, {}, "nothing was cut, which remains true and is not the point");
  } finally {
    w.dispose();
  }
});

test("THE CONTROL — a gate at the ROOT branch warns about nothing", async () => {
  // `writesHeldForJoin` is `branch.segments.length > 0`, so a root task applies its writes at
  // commit and this door reads the current value. A warning here would be noise on the ordinary
  // gate, which is how an operator learns to stop reading stderr.
  const w = workspace(ROOT_GRAPH);
  try {
    const { row, err } = await park(w);

    assert.deepEqual(row.readsMayBeStale, [], "nothing is held at the root, and the field says so rather than being absent");
    assert.ok(Object.hasOwn(row, "readsMayBeStale"), `the field is the authority, so it is always beside \`reads\`: ${Object.keys(row).join(",")}`);
    assert.ok(!/MAY BE STALE/.test(err), `no fan-out, so no notice: ${err}`);

    // AND THE VALUE REALLY IS THE FRESH ONE HERE, which is what makes the empty field a
    // measurement rather than an accident of a fixture that never wrote anything.
    assert.equal(row.reads?.["mid"], BUMPED, "at the root the write is already in the projection");
  } finally {
    w.dispose();
  }
});

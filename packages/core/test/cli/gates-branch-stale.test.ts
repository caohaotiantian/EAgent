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

const SEED_ONE = 'function (view) { return { writes: { items: ["only"] } }; }\n';
const BUMP_MID = `function (view) { return { writes: { mid: ${JSON.stringify(BUMPED)} } }; }\n`;

function workspace(graph: unknown, fns: Record<string, string> = {}): { dir: string; graphFile: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-branch-stale-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  mkdirSync(join(dir, "resources", "function"), { recursive: true });
  const graphFile = join(dir, "graphs", "g.json");
  writeFileSync(graphFile, JSON.stringify(graph));
  for (const [name, src] of Object.entries({ seed: SEED_ONE, bump: BUMP_MID, ...fns })) {
    writeFileSync(join(dir, "resources", "function", `${name}.js`), src);
  }
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

async function parkAll(
  w: { dir: string; graphFile: string },
  input: unknown = { mid: BASE },
): Promise<{ runId: string; rows: GateRow[]; err: string }> {
  const started = await cli(["run", w.graphFile, "--workspace", w.dir, "--input", JSON.stringify(input)]);
  assert.equal(started.code, 0, `${started.out}${started.err}`);
  const p = JSON.parse(started.out) as Record<string, unknown>;
  assert.equal(p["status"], "awaiting_gate", `the fixture must park for this to mean anything: ${started.out}`);
  const listed = await cli(["gates", String(p["runId"]), "--workspace", w.dir]);
  assert.equal(listed.code, 0, listed.err);
  return { runId: String(p["runId"]), rows: JSON.parse(listed.out) as GateRow[], err: listed.err };
}

async function park(w: { dir: string; graphFile: string }, input?: unknown): Promise<{ runId: string; row: GateRow; err: string }> {
  const { runId, rows, err } = await parkAll(w, input);
  assert.equal(rows.length, 1, `expected one open gate: ${JSON.stringify(rows)}`);
  return { runId, row: rows[0]!, err };
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
    assert.match(err, /! MAY BE STALE — gate_\S+ prints an OLDER value for `mid`/, err);
    assert.match(err, /own branch/i, "the notice must say WHOSE write it is: not a sibling's");
    // MAY, not DOES: this door names a held write without folding it, so a held value equal to
    // the base would make "does not describe" a false statement about a correct row.
    assert.match(err, /`contentDigest` may not describe the values printed above/, "the binding may describe the other value");
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

/**
 * THE BRANCH'S WRITE IS THE FIRST VALUE THE CHANNEL EVER HAD — `mid` is not an input, and no
 * root node writes it. `viewFor`'s `visible` therefore does not carry it, and the first draft of
 * `heldOnThisBranch` filtered against `visible`: the channel was in neither `reads` nor the
 * warning. Measured before the fix, on exactly this graph:
 *
 *     reads = {}   readsMayBeStale = []   stderr = ""
 *     loom approve …  →  succeeded, outputs = {"mid":"BUMPED-VALUE-THE-CONSOLE-SEES"}
 *
 * A BLANK where the subject of the approval should be, with nothing anywhere saying so — worse
 * than the stale value that opened §A.58(4), because there is not even a wrong value to doubt.
 */
const NO_BASE_GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "no-base", project: "demo", version: 1 },
  policy: { posture: "on", capabilities: [], expansion: { maxNodes: 64, maxDepth: 2, maxFanout: 4, maxLoopIterations: 1 } },
  channels: {
    items: { type: "array", reduce: "replace" },
    item: { type: "string", reduce: "replace" },
    mid: { type: "string", reduce: "replace" },
    seedin: { type: "string", reduce: "replace" },
  },
  inputs: ["seedin"],
  outputs: ["mid"],
  nodes: [
    { id: "seed", type: "function", reads: ["seedin"], writes: ["items"], function: { ref: "function/seed@stable" } },
    { id: "bump", type: "function", reads: ["item"], writes: ["mid"], function: { ref: "function/bump@stable" } },
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

test("A HELD WRITE ON A CHANNEL WITH NO BASE VALUE IS NAMED — the row prints NOTHING for it", async () => {
  const w = workspace(NO_BASE_GRAPH);
  try {
    const { row, err } = await park(w, { seedin: "x" });

    // `reads` is genuinely empty — the channel has no stored value to print, and that half is
    // not a defect. The defect was that nothing said so.
    assert.deepEqual(row.reads, {}, JSON.stringify(row.reads));
    assert.deepEqual(row.readsMayBeStale, ["mid"], "a channel the gate READS, held by its own branch, is named whether or not it prints");

    // AND THE NOTICE SAYS WHICH OF THE TWO CASES THIS IS. "Prints an older value" would be a
    // false statement here: there is no value above at all.
    assert.match(err, /! MAY BE STALE — gate_\S+ prints NOTHING for `mid`, whose only value is held/, err);
    assert.ok(!/prints an OLDER value/.test(err), `nothing was printed for it, so it is not the OLDER-value case: ${err}`);
  } finally {
    w.dispose();
  }
});

/** `bump` writes `mid` AND `other`; the gate reads only `mid`. `other` must never be named. */
const UNREAD_GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "unread", project: "demo", version: 1 },
  policy: { posture: "on", capabilities: [], expansion: { maxNodes: 64, maxDepth: 2, maxFanout: 4, maxLoopIterations: 1 } },
  channels: {
    items: { type: "array", reduce: "replace" },
    item: { type: "string", reduce: "replace" },
    mid: { type: "string", reduce: "replace" },
    other: { type: "string", reduce: "replace" },
  },
  inputs: ["mid", "other"],
  outputs: ["mid"],
  nodes: [
    { id: "seed", type: "function", reads: ["mid"], writes: ["items"], function: { ref: "function/seed@stable" } },
    { id: "bump", type: "function", reads: ["item"], writes: ["mid", "other"], function: { ref: "function/bump@stable" } },
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

test("THE OTHER BOUND — a held write on a channel the gate does NOT read is not named", async () => {
  // Moving the filter from `view.visible` to `observedChannels` widened the set, and this is the
  // assertion that it did not widen to "every channel the branch wrote". `other` is held exactly
  // as `mid` is; the gate does not read it, so it is not this operator's business.
  const w = workspace(UNREAD_GRAPH, {
    bump: `function (view) { return { writes: { mid: ${JSON.stringify(BUMPED)}, other: "OTHER-BUMPED" } }; }\n`,
  });
  try {
    const { row, err } = await park(w, { mid: BASE, other: "BASE-OTHER" });

    assert.deepEqual(row.readsMayBeStale, ["mid"], "only the channel the gate reads");
    assert.ok(!/other/.test(err), `a channel the gate does not read must not reach the notice: ${err}`);
    assert.ok(!Object.hasOwn(row.reads ?? {}, "other"), "and it is not in `reads` either — the two sets agree");
  } finally {
    w.dispose();
  }
});

/**
 * TWO SIBLING BRANCHES, AND ONLY ONE OF THEM WROTE. This is what pins PATH EQUALITY rather than
 * prefix: `#withBranchWrites` folds tasks at exactly one branch path, so branch `#0`'s gate must
 * NOT be warned about a write branch `#1` is holding. A predicate written with `startsWith`, or
 * one that asked "is any write held anywhere in this run", passes every other test in this file
 * and fails this one.
 */
const SIBLING_GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "sib", project: "demo", version: 1 },
  policy: { posture: "on", capabilities: [], expansion: { maxNodes: 64, maxDepth: 2, maxFanout: 4, maxLoopIterations: 1 } },
  channels: {
    items: { type: "array", reduce: "replace" },
    item: { type: "string", reduce: "replace" },
    acc: { type: "array", reduce: "append_ordered" },
  },
  inputs: ["acc"],
  outputs: ["acc"],
  nodes: [
    { id: "seed", type: "function", reads: ["acc"], writes: ["items"], function: { ref: "function/seed@stable" } },
    { id: "bump", type: "function", reads: ["item"], writes: ["acc"], function: { ref: "function/bump@stable" } },
    { id: "approve", type: "human_gate", reads: ["acc"], writes: [], humanGate: { ref: "oversight/publish@stable" } },
    { id: "gather", type: "join", reads: ["acc"], writes: ["acc"], join: { branches: ["bump", "approve"], mode: "all", onBranchError: "fail" } },
  ],
  edges: [
    { id: "fan", from: "seed", to: "bump", kind: "fanout", over: "items", as: "item", maxWidth: 4 },
    { id: "toGate", from: "bump", to: "approve", kind: "seq" },
    { id: "cb", from: "bump", to: "gather", kind: "join" },
    { id: "ca", from: "approve", to: "gather", kind: "join" },
  ],
};

test("A SIBLING'S HELD WRITE IS NOT THIS GATE'S PROBLEM — exactly one of two branches is named", async () => {
  const w = workspace(SIBLING_GRAPH, {
    seed: 'function (view) { return { writes: { items: ["a", "b"] } }; }\n',
    bump: 'function (view) { var it = view.require("item"); return it === "b" ? { writes: { acc: ["WROTE-IN-BRANCH-B"] } } : { writes: {} }; }\n',
  });
  try {
    const { rows, err } = await parkAll(w, { acc: ["BASE"] });
    assert.equal(rows.length, 2, `both branches must park for this to discriminate: ${JSON.stringify(rows)}`);

    const named = rows.filter((r) => (r.readsMayBeStale ?? []).length > 0);
    assert.equal(named.length, 1, `exactly the branch whose OWN node wrote: ${JSON.stringify(rows.map((r) => r.readsMayBeStale))}`);
    assert.deepEqual(named[0]!.readsMayBeStale, ["acc"]);

    // The other one is warned about NOTHING, though a sibling is holding a write to the very
    // channel it reads — and both print the same base value, so the difference is the predicate
    // and not the data.
    const quiet = rows.find((r) => r !== named[0])!;
    assert.deepEqual(quiet.readsMayBeStale, []);
    assert.deepEqual(quiet.reads?.["acc"], ["BASE"]);
    assert.deepEqual(named[0]!.reads?.["acc"], ["BASE"]);

    // Exactly one gate id in the notice.
    assert.equal(err.match(/gate_\w+/g)?.length, 1, err);
    assert.match(err, new RegExp(`${named[0]!.gateId} prints an OLDER value for \`acc\``), err);
  } finally {
    w.dispose();
  }
});

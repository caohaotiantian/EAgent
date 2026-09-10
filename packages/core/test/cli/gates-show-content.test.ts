/**
 * A HUMAN APPROVES THE THING, NOT ITS HASH.
 *
 * `loom gates <runId>` printed `{gateId, nodeId, policyRef, contentDigest, approvers, …}` and no
 * channel value, because `GateSummary.payload` — the rendered half — lives in the broker's
 * in-process map and a fresh CLI process raised none of these gates. So on the documented CLI
 * path the only thing an approver saw about the content was a digest, which is a BINDING (what
 * `loom approve` later checks the graph against) and not a summary anybody could recognise.
 *
 * Three things are pinned here, and the third is the one a later change is likeliest to break:
 *
 *   1 · a fresh process — no engine context, journal only — prints the channel the gate node
 *       reads, with its value;
 *   2 · `contentDigest` is untouched, and `loom approve` still succeeds afterwards, so the
 *       binding was not disturbed by the thing printed beside it;
 *   3 · a workspace whose graph is GONE still lists its gates. The content half is best effort;
 *       "is anything waiting on me" must never start refusing because it is unavailable.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";

/**
 * A gate that reads one channel whose value is a sentence, plus a `tool` node after it. The
 * gate's `reads` is the point: `body` holds text an approver could recognise, and the digest
 * over it could not be recognised by anyone.
 */
const GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "gated-copy", project: "demo", version: 1 },
  policy: { posture: "out", capabilities: ["fs:read", "fs:write"] },
  channels: {
    source: { type: "string", reduce: "replace" },
    body: { type: "string", reduce: "replace" },
    written: { type: "object", reduce: "replace" },
  },
  inputs: ["source"],
  outputs: ["written"],
  nodes: [
    {
      id: "read",
      type: "tool",
      reads: ["source"],
      writes: ["body"],
      tool: { name: "fs.read", version: "1.0", args: { path: "${source}" } },
    },
    {
      id: "approve",
      type: "human_gate",
      reads: ["body"],
      writes: ["body"],
      humanGate: { ref: "oversight/publish@stable" },
    },
    {
      id: "write",
      type: "tool",
      reads: ["body"],
      writes: ["written"],
      tool: { name: "fs.write", version: "1.0", args: { path: "out/copy.txt", body: "${body}" } },
      unhandled: true,
    },
  ],
  edges: [
    { id: "e1", from: "read", to: "approve", kind: "seq" },
    { id: "e2", from: "approve", to: "write", kind: "seq" },
  ],
};

const BODY = "ship the release notes for 4.2, including the migration section";

interface Cap {
  code: number;
  out: string;
  err: string;
}

async function cli(argv: string[]): Promise<Cap> {
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

function workspace(): { dir: string; graphFile: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-gate-reads-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  const graphFile = join(dir, "graphs", "gated.json");
  writeFileSync(graphFile, JSON.stringify(GRAPH));
  writeFileSync(join(dir, "input.txt"), BODY);
  return { dir, graphFile, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

interface GateRow {
  gateId: string;
  nodeId: string;
  contentDigest: string;
  reads?: Record<string, unknown>;
}

async function park(w: { dir: string; graphFile: string }): Promise<string> {
  const started = await cli(["run", w.graphFile, "--workspace", w.dir, "--input", JSON.stringify({ source: "input.txt" })]);
  assert.equal(started.code, 0, started.err);
  const p = JSON.parse(started.out) as Record<string, unknown>;
  assert.equal(p["status"], "awaiting_gate", "the fixture must park for this to mean anything");
  return String(p["runId"]);
}

test("loom gates prints the channels the gate node reads, from the journal alone", async () => {
  const w = workspace();
  try {
    const runId = await park(w);

    // A SEPARATE `main` CALL IS A SEPARATE WORKSPACE. `openWorkspace` runs per command, so this
    // engine holds no context for the run and the broker's ephemeral payload map is empty —
    // which is the exact condition that made this command print a hash and nothing else.
    const listed = await cli(["gates", runId, "--workspace", w.dir]);
    assert.equal(listed.code, 0, listed.err);
    const rows = JSON.parse(listed.out) as GateRow[];
    assert.equal(rows.length, 1, listed.out);

    assert.deepEqual(rows[0]!.reads, { body: BODY }, "the value being approved must be on the row");
    assert.equal(rows[0]!.nodeId, "approve");
    assert.match(rows[0]!.contentDigest, /\S/, "the binding stays, beside the content and not replaced by it");
  } finally {
    w.dispose();
  }
});

test("the binding still binds — approve succeeds after the content was shown", async () => {
  const w = workspace();
  try {
    const runId = await park(w);
    const listed = await cli(["gates", runId, "--workspace", w.dir]);
    const before = (JSON.parse(listed.out) as GateRow[])[0]!;

    const approved = await cli(["approve", runId, before.gateId, "--workspace", w.dir, "--as", "ops"]);
    assert.equal(approved.code, 0, approved.err);
    assert.equal((JSON.parse(approved.out) as Record<string, unknown>)["status"], "succeeded", approved.out);

    // AND THE DIGEST WAS NOT RECOMPUTED OVER THE NEW SHAPE. `#dispatchApproved` re-derives the
    // binding from a fresh projection and refuses a mismatch, so a `reads` field that had leaked
    // into what is digested would have failed the approval above rather than this assertion —
    // this one names the claim anyway, because a future change could make both agree on a wrong
    // value.
    const decided = await cli(["gates", runId, "--workspace", w.dir]);
    assert.deepEqual(JSON.parse(decided.out), [], "an answered gate is no longer open");
  } finally {
    w.dispose();
  }
});

test("a workspace whose graph is gone still lists its gates, without the content", async () => {
  const w = workspace();
  try {
    const runId = await park(w);
    // The one input `gatesWithReads` needs and cannot journal. `loom approve` refuses outright
    // here — the approval binds the bytes — but LISTING must not: an operator asking whether
    // anything is waiting on them gets an answer either way.
    unlinkSync(w.graphFile);

    const listed = await cli(["gates", runId, "--workspace", w.dir]);
    assert.equal(listed.code, 0, listed.err);
    const rows = JSON.parse(listed.out) as GateRow[];
    assert.equal(rows.length, 1, listed.out);
    assert.equal(rows[0]!.reads, undefined, "absent rather than guessed");
    assert.match(rows[0]!.contentDigest, /\S/);

    // AND THE ABSENCE IS EXPLAINED. `undefined` here would otherwise be indistinguishable from
    // "this gate reads nothing" — this command's own `absence is not zero` trap, one field
    // over from the `?? {}` that used to answer "no such run" with "you are clear".
    assert.match(listed.err, /! CONTENT NOT SHOWN — 1 open gate\(s\) below print no `reads`/, listed.err);
    // AND IT NAMES EVERY DIRECTORY THE SEARCH WALKED, not just `graphs/` — `graphsByHash` is
    // that plus one per spec resource kind, and sending an operator to one of three places is a
    // correction that replaces a false claim with a differently-false one.
    assert.match(listed.err, /no graph under .*\/graphs, .*\/resources\/subgraph.* has the hash this run compiled/, listed.err);
    // ON STDERR, so `loom gates | jq` is untouched by it — the assertion above already parsed
    // stdout, and this names the property rather than leaving it to that parse.
    assert.ok(!/CONTENT NOT SHOWN/.test(listed.out), listed.out);
  } finally {
    w.dispose();
  }
});

test("an UNREADABLE graphs/ is the same answer — the lookup may not turn listing into a refusal", async () => {
  // A DIFFERENT SHAPE FROM THE ONE ABOVE, and it was a real regression: `indexGraphs` wraps
  // `compiledFile` and not `readdirSync`, so before the try/catch in `gatesWithReads` this threw
  // `EACCES: permission denied, scandir` straight out of a command that had just promised, in
  // its own docstring, not to start refusing when the content half is unavailable.
  //
  // The directory is unreadable rather than missing, because `indexGraphs` skips a directory
  // that does not exist and this arm is about one that does and cannot be read.
  const w = workspace();
  try {
    const runId = await park(w);
    chmodSync(join(w.dir, "graphs"), 0o000);
    try {
      const listed = await cli(["gates", runId, "--workspace", w.dir]);
      assert.equal(listed.code, 0, `listing must survive an unreadable graphs/: ${listed.err}`);
      const rows = JSON.parse(listed.out) as GateRow[];
      assert.equal(rows.length, 1, listed.out);
      assert.equal(rows[0]!.reads, undefined);
      // AND THE REASON IS CARRIED, not swallowed — a `catch` that could not tell "unreadable"
      // from "not there" and answered both with silence is the shape this file keeps refusing.
      assert.match(listed.err, /! CONTENT NOT SHOWN — .*the search could not be run: .*EACCES/, listed.err);
    } finally {
      chmodSync(join(w.dir, "graphs"), 0o755);
    }
  } finally {
    w.dispose();
  }
});

/**
 * ONE GATE READING TWO CHANNELS: one declared `secret_ref`, one declared nothing.
 *
 * Both halves of the rule in one row, which is the point — a sweep that blanked the whole map
 * would satisfy "the secret is hidden" and silently reinstate A.43 for every ordinary channel.
 *
 * The gate is the ENTRY node and no tool reads `credential`, deliberately. `dataFloorOf` floors
 * any node observing a `secret_ref` channel at posture `in`, so a `tool` node reading it would
 * raise its own gate first and the run would park one node earlier, on a task where the channel
 * being measured has no value yet. That is how the first version of this fixture measured
 * nothing while passing.
 */
const CLASSIFIED = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "gated-secret", project: "demo", version: 1 },
  policy: { posture: "out", capabilities: ["fs:write"] },
  channels: {
    credential: { type: "string", reduce: "replace", classification: "secret_ref" },
    note: { type: "string", reduce: "replace" },
    written: { type: "object", reduce: "replace" },
  },
  inputs: ["credential", "note"],
  outputs: ["written"],
  nodes: [
    {
      id: "approve",
      type: "human_gate",
      reads: ["credential", "note"],
      writes: ["note"],
      humanGate: { ref: "oversight/publish@stable" },
    },
    {
      id: "write",
      type: "tool",
      reads: ["note"],
      writes: ["written"],
      tool: { name: "fs.write", version: "1.0", args: { path: "out/note.txt", body: "${note}" } },
      unhandled: true,
    },
  ],
  edges: [{ id: "e1", from: "approve", to: "write", kind: "seq" }],
};

const SECRET = "sk-live-DO-NOT-DISCLOSE";

test("a channel the graph declared secret_ref is swept, and its unclassified neighbours are not", async () => {
  // THE FIRST VERSION OF THIS CHANGE PRINTED IT IN THE CLEAR, on the argument that `loom run`
  // already prints `p.outputs` raw. `outputs` is `spec.outputs` — a PUBLISHED subset an author
  // chose — while `reads` is `observedChannels`, which includes inputs, so that would have made
  // this the first CLI path to print an input channel a graph declared `secret_ref`.
  // `server/http.ts` had already written the sentence for both doors: "serving that value in
  // the clear at the gate the classification demanded is the one place it must not happen".
  const dir = mkdtempSync(join(tmpdir(), "loom-gate-secret-"));
  try {
    mkdirSync(join(dir, "graphs"), { recursive: true });
    const graphFile = join(dir, "graphs", "gated.json");
    writeFileSync(graphFile, JSON.stringify(CLASSIFIED));

    const started = await cli([
      "run",
      graphFile,
      "--workspace",
      dir,
      "--input",
      JSON.stringify({ credential: SECRET, note: "ship the 4.2 notes" }),
    ]);
    assert.equal(started.code, 0, started.err);
    const p = JSON.parse(started.out) as Record<string, unknown>;
    assert.equal(p["status"], "awaiting_gate", started.out);
    const runId = String(p["runId"]);

    const listed = await cli(["gates", runId, "--workspace", dir]);
    assert.equal(listed.code, 0, listed.err);
    const row = (JSON.parse(listed.out) as GateRow[])[0]!;
    assert.equal(row.nodeId, "approve", "the gate measured must be the one reading both channels");
    const reads = row.reads!;

    assert.ok(!listed.out.includes(SECRET), `a secret_ref value must not reach stdout: ${listed.out}`);
    assert.equal(reads["credential"], "[secret]", JSON.stringify(reads));

    // AND THE UNCLASSIFIED NEIGHBOUR IS UNTOUCHED, in the SAME row. The sweep blanks what the
    // author DECLARED and nothing else, so A.43 stays closed for every ordinary channel —
    // without this half, a redaction that blanked the whole map would pass the assertion above
    // and quietly reinstate the defect.
    assert.equal(reads["note"], "ship the 4.2 notes", JSON.stringify(reads));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

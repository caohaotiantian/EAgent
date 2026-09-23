/**
 * A BY-HASH GRAPH LOOKUP IS SILENT ABOUT CANDIDATES THE OPERATOR DID NOT NAME — TODO.md §A.91.
 *
 * `loom replay`, `loom trace` and `loom approve` find a run's graph by the hash `run.compiled`
 * recorded, and the search compiles EVERY file in `graphs/` (plus the resource subgraph
 * directories) to find the one match. Before this row closed, every one of those compiles wrote
 * its diagnostics to stderr through `loadGraph` — including the candidates that were NOT the
 * run's graph and NEVER printed the "which one resolved" line at all. So `loom approve <run>
 * <gate>`, the highest-consequence command in the product, could print `✗ GRAPH017_…` about an
 * unrelated file sitting in `graphs/` directly above a successful approval, and the approver had
 * no way to tell whether the line was about the graph they were approving.
 *
 * `indexGraphs`/`compiledFile`/`loadGraph` now take a `silent` flag, and `graphsByHash` — the
 * function EVERY by-hash lookup shares — passes it. The search still finds the right graph (or
 * correctly fails to, `indexGraphs`' `failed` list intact for whichever caller wants to report
 * it), it just does not narrate every candidate it rejected along the way. `loom compile` on the
 * SAME broken file, asked for directly, is unaffected — that is a graph the operator DID name.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";

/** A graph of built-in tools only, so nothing has to be registered to compile or run it. */
const GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "copy-file", project: "lane-d", version: 1 },
  policy: { posture: "out", capabilities: ["fs:read", "fs:write"] },
  channels: {
    source: { type: "string", reduce: "replace" },
    body: { type: "string", reduce: "replace" },
    written: { type: "object", reduce: "replace" },
  },
  inputs: ["source"],
  outputs: ["written"],
  nodes: [
    { id: "read", type: "tool", reads: ["source"], writes: ["body"], tool: { name: "fs.read", version: "1.0", args: { path: "${source}" } } },
    {
      id: "write",
      type: "tool",
      reads: ["body"],
      writes: ["written"],
      unhandled: true,
      tool: { name: "fs.write", version: "1.0", args: { path: "out/copy.txt", body: "${body}" } },
    },
  ],
  edges: [{ id: "e1", from: "read", to: "write", kind: "seq" }],
};

/** A graph declaring a capability an unflagged workspace does not hold — it cannot compile here. */
const UNCOMPILABLE = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "needs-net", project: "lane-d", version: 1 },
  policy: { posture: "out", capabilities: ["net:fetch"], budget: { costUsd: 1 } },
  channels: { url: { type: "string", reduce: "replace" }, body: { type: "object", reduce: "replace" } },
  inputs: ["url"],
  outputs: ["body"],
  nodes: [{ id: "get", type: "tool", reads: ["url"], writes: ["body"], unhandled: true, tool: { name: "net.fetch", version: "1.0", args: { url: "${url}" } } }],
  edges: [],
};

interface Cap {
  code: number;
  out: string;
  err: string;
}

async function run(argv: string[]): Promise<Cap> {
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

function workspace(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-lookup-silent-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  writeFileSync(join(dir, "graphs", "copy.json"), JSON.stringify(GRAPH));
  writeFileSync(join(dir, "input.txt"), "hello");
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

test("`loom trace` DOES NOT PRINT ANOTHER GRAPH'S DIAGNOSTICS WHILE RESOLVING THIS RUN'S", async () => {
  const w = workspace();
  try {
    writeFileSync(join(w.dir, "graphs", "needs-net.json"), JSON.stringify(UNCOMPILABLE));

    const started = await run(["run", join(w.dir, "graphs", "copy.json"), "--workspace", w.dir, "--input", '{"source":"input.txt"}']);
    assert.equal(started.code, 0, started.err);
    const runId = (JSON.parse(started.out) as { runId: string }).runId;

    // `trace` resolves the run's graph by hash, which sweeps every file in graphs/ — including
    // needs-net.json — to find it. Before §A.91 closed, that sweep's own diagnostics reached
    // stderr; now the search is silent about the candidate it rejected.
    const traced = await run(["trace", runId, "--workspace", w.dir]);
    assert.equal(traced.code, 0, traced.err);
    assert.doesNotMatch(
      traced.err,
      /GRAPH017_CAPABILITY_NOT_GRANTED/,
      `a candidate the operator did not name leaked onto stderr:\n${traced.err}`,
    );
    assert.doesNotMatch(traced.err, /needs-net\.json/, `the by-hash sweep named a file nobody asked about:\n${traced.err}`);
    // THE RESOLUTION ITSELF STILL SAYS WHAT IT FOUND — silence is about the REJECTED candidates,
    // not about the one that matched.
    assert.match(traced.err, /graph copy-file v1/, `trace must still say which graph it resolved:\n${traced.err}`);

    // AND THE SAME FILE, COMPILED DIRECTLY, IS UNCHANGED — this is a graph the operator DID name.
    await assert.rejects(
      () => run(["compile", join(w.dir, "graphs", "needs-net.json"), "--workspace", w.dir]),
      /GRAPH017_CAPABILITY_NOT_GRANTED/,
      "an EXPLICIT compile must still refuse and narrate its own diagnostics",
    );
  } finally {
    w.dispose();
  }
});

test("`loom replay` IS SILENT ABOUT THE SAME REJECTED CANDIDATE, AND STILL VERIFIES THE RUN", async () => {
  const w = workspace();
  try {
    writeFileSync(join(w.dir, "graphs", "needs-net.json"), JSON.stringify(UNCOMPILABLE));

    const started = await run(["run", join(w.dir, "graphs", "copy.json"), "--workspace", w.dir, "--input", '{"source":"input.txt"}']);
    assert.equal(started.code, 0, started.err);
    const runId = (JSON.parse(started.out) as { runId: string }).runId;

    const replayed = await run(["replay", runId, "--workspace", w.dir]);
    assert.equal(replayed.code, 0, replayed.err);
    assert.doesNotMatch(
      replayed.err,
      /GRAPH017_CAPABILITY_NOT_GRANTED|needs-net\.json/,
      `replay's own by-hash sweep must not narrate a candidate it rejected:\n${replayed.err}`,
    );
  } finally {
    w.dispose();
  }
});

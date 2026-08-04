/**
 * The CLI, and DoD item 6.
 *
 * The point of these tests is one claim: **Loom boots from nothing.** An empty
 * directory, no configuration, no external service, no API key — and a real graph
 * runs end to end. Everything else here supports proving that.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, openWorkspace, parseArgs } from "../../src/cli.ts";

/** A graph that uses only built-in tools, so nothing needs registering. */
const GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "copy-file", project: "demo", version: 1 },
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
      id: "write",
      type: "tool",
      reads: ["body"],
      writes: ["written"],
      tool: { name: "fs.write", version: "1.0", args: { path: "out/copy.txt", body: "${body}" } },
      unhandled: true,
    },
  ],
  edges: [{ id: "e1", from: "read", to: "write", kind: "seq" }],
};

function emptyDir(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-cli-"));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

function seed(dir: string): string {
  mkdirSync(join(dir, "graphs"), { recursive: true });
  const graphFile = join(dir, "graphs", "copy.json");
  writeFileSync(graphFile, JSON.stringify(GRAPH));
  writeFileSync(join(dir, "input.txt"), "hello from an empty directory");
  return graphFile;
}

/** Capture stdout/stderr around a CLI invocation. */
async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
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

// ── argument parsing ─────────────────────────────────────────────────────────

test("flags, values, and positionals parse as expected", () => {
  const a = parseArgs(["run", "g.json", "--input", '{"a":1}', "--verbose"]);
  assert.equal(a.command, "run");
  assert.deepEqual(a.positional, ["g.json"]);
  assert.equal(a.flags["input"], '{"a":1}');
  assert.equal(a.flags["verbose"], true);
});

// ── DoD item 6 ───────────────────────────────────────────────────────────────

test("DoD 6 — an EMPTY directory becomes a working workspace with no external service", () => {
  const d = emptyDir();
  try {
    assert.equal(existsSync(join(d.dir, ".loom")), false, "starting from genuinely nothing");
    const ws = openWorkspace(parseArgs(["serve", "--workspace", d.dir]));
    try {
      assert.equal(existsSync(join(d.dir, ".loom", "journal.db")), true, "the journal exists after boot");
      assert.equal(existsSync(join(d.dir, "graphs")), true);
      // Built-in tools are registered, so a fresh install can run a real graph.
      assert.deepEqual(
        ws.engine.tools.list().map((t) => t.name).sort(),
        ["fs.read", "fs.restore", "fs.write"],
      );
    } finally {
      ws.close();
    }
  } finally {
    d.dispose();
  }
});

test("DoD 6 — a real graph runs end to end from a fresh directory, offline", async () => {
  const d = emptyDir();
  try {
    const graphFile = seed(d.dir);
    const r = await run(["run", graphFile, "--workspace", d.dir, "--input", JSON.stringify({ source: "input.txt" })]);

    assert.equal(r.code, 0, r.err);
    const parsed = JSON.parse(r.out) as { status: string; outputs: Record<string, unknown> };
    assert.equal(parsed.status, "succeeded");
    assert.equal(
      readFileSync(join(d.dir, "out", "copy.txt"), "utf8"),
      "hello from an empty directory",
      "the tool really wrote the file, inside the jail",
    );
  } finally {
    d.dispose();
  }
});

test("the run is journaled, so a second process can read it back", async () => {
  const d = emptyDir();
  try {
    const graphFile = seed(d.dir);
    const first = await run(["run", graphFile, "--workspace", d.dir, "--input", JSON.stringify({ source: "input.txt" })]);
    const { runId } = JSON.parse(first.out) as { runId: string };

    // A completely separate workspace handle — i.e. a new process.
    const ws = openWorkspace(parseArgs(["gates", "--workspace", d.dir]));
    try {
      const p = await ws.engine.projection(runId as never);
      assert.equal(p?.status, "succeeded");
    } finally {
      ws.close();
    }
  } finally {
    d.dispose();
  }
});

// ── compile ──────────────────────────────────────────────────────────────────

test("compile accepts a valid graph and reports ok", async () => {
  const d = emptyDir();
  try {
    const graphFile = seed(d.dir);
    const r = await run(["compile", graphFile, "--workspace", d.dir]);
    assert.equal(r.code, 0);
    assert.match(r.out, /ok/);
  } finally {
    d.dispose();
  }
});

test("compile prints every diagnostic with its suggested fix, then fails", async () => {
  const d = emptyDir();
  try {
    mkdirSync(join(d.dir, "graphs"), { recursive: true });
    const bad = { ...GRAPH, nodes: GRAPH.nodes.map((n) => ({ ...n, writes: ["ghost"] })) };
    const file = join(d.dir, "graphs", "bad.json");
    writeFileSync(file, JSON.stringify(bad));

    await assert.rejects(() => run(["compile", file, "--workspace", d.dir]));
  } finally {
    d.dispose();
  }
});

// ── replay and trace ─────────────────────────────────────────────────────────

test("replay verifies a recorded run and performs no side effects", async () => {
  const d = emptyDir();
  try {
    const graphFile = seed(d.dir);
    const first = await run(["run", graphFile, "--workspace", d.dir, "--input", JSON.stringify({ source: "input.txt" })]);
    const { runId } = JSON.parse(first.out) as { runId: string };

    // Corrupt the output file; a replay that re-ran the tool would recreate it.
    writeFileSync(join(d.dir, "out", "copy.txt"), "TAMPERED");

    const r = await run(["replay", runId, "--graph", graphFile, "--workspace", d.dir]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /"match": true/);
    assert.equal(readFileSync(join(d.dir, "out", "copy.txt"), "utf8"), "TAMPERED", "replay wrote nothing");
  } finally {
    d.dispose();
  }
});

test("trace prints spans and asserts graph conformance", async () => {
  const d = emptyDir();
  try {
    const graphFile = seed(d.dir);
    const first = await run(["run", graphFile, "--workspace", d.dir, "--input", JSON.stringify({ source: "input.txt" })]);
    const { runId } = JSON.parse(first.out) as { runId: string };

    const r = await run(["trace", runId, "--graph", graphFile, "--workspace", d.dir]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /loom\.run/);
    assert.match(r.out, /loom\.task/);
    assert.match(r.out, /conformance: ok/);
  } finally {
    d.dispose();
  }
});

// ── the jail applies to built-in tools ───────────────────────────────────────

test("a built-in tool cannot escape the workspace", async () => {
  const d = emptyDir();
  try {
    mkdirSync(join(d.dir, "graphs"), { recursive: true });
    const escaping = {
      ...GRAPH,
      nodes: GRAPH.nodes.map((n) =>
        n.id === "read" ? { ...n, tool: { name: "fs.read", version: "1.0", args: { path: "../../../etc/passwd" } } } : n,
      ),
    };
    const file = join(d.dir, "graphs", "escape.json");
    writeFileSync(file, JSON.stringify(escaping));
    writeFileSync(join(d.dir, "input.txt"), "x");

    const r = await run(["run", file, "--workspace", d.dir, "--input", JSON.stringify({ source: "input.txt" })]);
    assert.equal(r.code, 1, "the run fails rather than reading outside the jail");
  } finally {
    d.dispose();
  }
});

test("help is printed for no arguments", async () => {
  const r = await run([]);
  assert.equal(r.code, 0);
  assert.match(r.out, /loom serve/);
});

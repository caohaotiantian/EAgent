/**
 * `loom run`'s STDOUT IS THE JSON AND NOTHING ELSE — on every status, including the one that
 * parks.
 *
 * The gate hint used to be printed on stdout after the object, so `loom run … | jq .status`
 * worked for a run that succeeded and broke for a run that stopped at a human gate. That is the
 * one status a script most needs to branch on: `awaiting_gate` exits 0, so a caller that cannot
 * parse the object cannot tell "done" from "waiting on a person" without reading the exit code
 * and guessing.
 *
 * This suite pins the property a caller actually depends on — `JSON.parse(stdout)` succeeds —
 * rather than the absence of one string, because the next line printed on the wrong stream
 * breaks the same caller in the same way and a `grep` for `^gate ` would not see it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";

/**
 * Two built-in tools with a human gate between them, and no model — the smallest graph that
 * can park. `unhandled` on the last node keeps the compiler quiet about its error edge.
 */
const GATED = {
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

/** The same graph with the gate removed, so both statuses are measured through one door. */
const PLAIN = {
  ...GATED,
  metadata: { name: "plain-copy", project: "demo", version: 1 },
  nodes: GATED.nodes.filter((n) => n.type !== "human_gate"),
  edges: [{ id: "e1", from: "read", to: "write", kind: "seq" }],
};

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

function workspace(): { dir: string; gated: string; plain: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-gate-hint-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  const gated = join(dir, "graphs", "gated.json");
  const plain = join(dir, "graphs", "plain.json");
  writeFileSync(gated, JSON.stringify(GATED));
  writeFileSync(plain, JSON.stringify(PLAIN));
  writeFileSync(join(dir, "input.txt"), "the body to be approved");
  return { dir, gated, plain, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

test("loom run's stdout is parseable JSON on the awaiting_gate path", async () => {
  const w = workspace();
  try {
    const r = await cli(["run", w.gated, "--workspace", w.dir, "--input", JSON.stringify({ source: "input.txt" })]);
    assert.equal(r.code, 0, r.err);

    // THE WHOLE STREAM, not a prefix of it. `JSON.parse` on the entire capture is exactly what
    // `| jq .status` does, and it is the assertion the old behaviour failed.
    const parsed = JSON.parse(r.out) as Record<string, unknown>;
    assert.equal(parsed["status"], "awaiting_gate", "the fixture must park for this to mean anything");
    assert.equal(typeof parsed["runId"], "string");

    // THE HINT IS NOT GONE, it moved. A fix that deleted it would pass the assertion above and
    // take away the one line telling an operator the command that answers the gate.
    assert.match(
      r.err,
      /^gate gate_\S+ on node approve — loom approve \S+ gate_\S+ --as YOUR_ID$/m,
      `the gate hint must still be printed, on stderr: ${r.err}`,
    );
    assert.ok(!/^gate /m.test(r.out), `no gate hint may reach stdout: ${r.out}`);
  } finally {
    w.dispose();
  }
});

test("the succeeding path is byte-identical in shape — one parser for both statuses", async () => {
  const w = workspace();
  try {
    const r = await cli(["run", w.plain, "--workspace", w.dir, "--input", JSON.stringify({ source: "input.txt" })]);
    assert.equal(r.code, 0, r.err);
    const parsed = JSON.parse(r.out) as Record<string, unknown>;
    assert.equal(parsed["status"], "succeeded");
  } finally {
    w.dispose();
  }
});

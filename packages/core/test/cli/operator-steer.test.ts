/**
 * `loom steer` — and the one thing about it a workspace has to get right.
 *
 * Steer is the only operator verb that needs the compiled graph: `Engine.steer` refuses a run
 * this process has not attached, because the declared edge set it confines the operator to
 * lives in the artifact and there is nothing else to check a route against. Every `loom`
 * invocation is a fresh process holding nothing, so without the `graphs/` lookup this command
 * would answer `E_RUN_NOT_FOUND` for every run that is not being submitted right now — the
 * honest answer only when the graph is genuinely absent, and here it is on disk.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, openWorkspace, parseArgs } from "../../src/cli.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import type { RunId } from "../../src/ids.ts";

/** Built-in tools with a gate between them, so the run parks where an operator can act. */
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
    { id: "approve", type: "human_gate", reads: ["body"], writes: ["body"], humanGate: { ref: "oversight/publish@stable" } },
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

function workspace(): { dir: string; graphFile: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-steer-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  const graphFile = join(dir, "graphs", "gated.json");
  writeFileSync(graphFile, JSON.stringify(GRAPH));
  writeFileSync(join(dir, "input.txt"), "the body to be approved");
  return { dir, graphFile, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

function firstJson(out: string): Record<string, unknown> {
  const end = out.indexOf("\n}");
  assert.ok(end > 0, `no JSON object in CLI output: ${out}`);
  return JSON.parse(out.slice(0, end + 2)) as Record<string, unknown>;
}

test("loom steer reaches a run this process never submitted, and refuses an edge the author did not write", async () => {
  const w = workspace();
  try {
    const started = await run(["run", w.graphFile, "--workspace", w.dir, "--input", JSON.stringify({ source: "input.txt" })]);
    assert.equal(started.code, 0, started.err);
    const runId = String(firstJson(started.out)["runId"]);

    // A SEPARATE INVOCATION — a fresh workspace, nothing attached. This is the case the
    // `graphs/` bind exists for, and without it the next line is `E_RUN_NOT_FOUND`.
    const ok = await run([
      "steer", runId, "--workspace", w.dir, "--as", "ops", "--node", "approve", "--take", "e2", "--reason", "keep it on the write",
    ]);
    assert.equal(ok.code, 0, ok.err);
    assert.deepEqual(firstJson(ok.out)["take"], ["e2"]);

    // `e1` EXISTS AND LEAVES A DIFFERENT NODE. Taking it from `approve` would activate
    // `approve` itself — the shape that jumps whatever sits between two nodes.
    await assert.rejects(
      () => run(["steer", runId, "--workspace", w.dir, "--as", "ops", "--node", "approve", "--take", "e1"]),
      (thrown: unknown) => isLoomError(thrown) && thrown.code === CODES.E_ROUTE_INVALID,
    );
    await assert.rejects(
      () => run(["steer", runId, "--workspace", w.dir, "--as", "ops", "--node", "approve", "--take", "e_nope"]),
      (thrown: unknown) => isLoomError(thrown) && thrown.code === CODES.E_ROUTE_INVALID,
    );
    // A steer with no node is a configuration error, not a route refusal — nothing was
    // refused on authority, the command was not given.
    await assert.rejects(
      () => run(["steer", runId, "--workspace", w.dir, "--as", "ops", "--take", "e2"]),
      (thrown: unknown) => isLoomError(thrown) && thrown.code === CODES.E_CONFIG_INVALID,
    );

    const ws = openWorkspace(parseArgs(["gates", "--workspace", w.dir]));
    try {
      const log: JournalEvent[] = [];
      for await (const ev of ws.store.read(runId as RunId, 1)) log.push(ev);
      const steers = log.filter((ev) => ev.type === "operator.command" && (ev.payload as { kind: string }).kind === "steer");
      assert.equal(steers.length, 1, "only the accepted steer is on the record");
      assert.equal((steers[0]!.actor as { subject?: string }).subject, "ops");
      assert.deepEqual((steers[0]!.payload as unknown as { args: { take: unknown } }).args.take, ["e2"]);
    } finally {
      ws.close();
    }
  } finally {
    w.dispose();
  }
});

/**
 * `loom run` TIMES ITS OWN COMPILE, AND THE TRACE DRAWS IT — the CLI half of `loom.compile`.
 *
 * The engine half is pinned in `compile-span-and-node-type.test.ts` with an injected number.
 * This is the one caller that measures a real compile for a real run: `loadGraph` times
 * `compile()` and the `run` verb hands the result to `SubmitInput.compileDurationMs`. Without the
 * hand-off the engine still works and every engine test stays green, so the wiring needs a test
 * of its own that goes through `main`.
 *
 * Offline: a `function` node over a workspace body. The duration is asserted by SHAPE — a
 * non-negative whole number of milliseconds — never by size, because it is a real clock reading.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, openWorkspace, parseArgs } from "../../src/cli.ts";
import type { RunId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { spansFrom } from "../../src/telemetry/spans.ts";

async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => (err.push(String(c)), true)) as typeof process.stderr.write;
  try {
    return { code: await main(argv), out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

test("`loom run` JOURNALS ITS COMPILE TIME ON run.compiled, AND THE TRACE HAS A loom.compile FOR IT", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "loom-compile-span-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "resources", "function"), { recursive: true });
  writeFileSync(join(dir, "resources", "function", "double.js"), `function (view) { return { writes: { doubled: (view.get("amount") ?? 0) * 2 } }; }`);
  writeFileSync(
    join(dir, "g.json"),
    JSON.stringify({
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "g", project: "compile-span", version: 1 },
      channels: { amount: { type: "number", reduce: "replace" }, doubled: { type: "number", reduce: "replace" } },
      inputs: ["amount"],
      outputs: ["doubled"],
      nodes: [{ id: "double", type: "function", function: { ref: "function/double@stable" }, reads: ["amount"], writes: ["doubled"] }],
      edges: [],
    }),
  );

  const r = await cli(["run", join(dir, "g.json"), "--workspace", dir, "--input", '{"amount":21}']);
  // Matched out of the stream, not parsed: under `node --test` the runner writes to stdout too.
  const printed = /\{\n  "runId": "([0-9A-Z]+)",\n  "status": "([a-z_]+)"/.exec(r.out);
  assert.ok(printed, `\`loom run\` printed no run summary:\n${r.out}\n${r.err}`);
  assert.equal(printed[2], "succeeded", r.err);

  const ws = openWorkspace(parseArgs(["gates", "--workspace", dir]));
  const events: JournalEvent[] = [];
  try {
    for await (const e of ws.store.read(printed[1] as RunId, 1) as AsyncIterable<JournalEvent>) events.push(e);
  } finally {
    ws.close();
  }

  const compiled = events.find((e) => e.type === "run.compiled");
  const took = (compiled?.payload as { durationMs?: unknown } | undefined)?.durationMs;
  assert.equal(typeof took, "number", "`loom run` compiled this graph for this run, so it must say how long that took");
  assert.ok(Number.isInteger(took) && (took as number) >= 0, `whole milliseconds, the journal's resolution; got ${String(took)}`);

  const [compile] = spansFrom(events).filter((s) => s.name === "loom.compile");
  assert.ok(compile !== undefined, "the measured compile is on the trace");
  assert.equal(compile.endTime - compile.startTime, took);
  const [task] = spansFrom(events).filter((s) => s.name === "loom.task");
  assert.equal(task?.attributes["node.type"], "function");
});

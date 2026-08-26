/**
 * A replay must run the SAME PROGRAM the recording ran — hooks included.
 *
 * `cli.ts`'s `replay` case built its Engine from `{tools, functions, models, policy}` and no
 * `hooks`. `Engine.#hooks` is therefore `undefined`, `#hooksFor` answers `[]` at all eight
 * points, and a replay of a hooked run executes a DIFFERENT program than the one in the journal.
 * That is the same class of defect as the `policy` line right beside it, which was fixed for the
 * same reason: a harness that answers a different question than the one asked is worse than one
 * that fails.
 *
 * Measured before the repair, on a run whose `preNode` hook skipped a node and supplied its `out`
 * through `overrideWrites`:
 *
 *     ✗ task.committed write@root#0 : expected succeeded, got failed
 *     ✗ state.reduced               : expected {"note":"n","out":{"skipped":true}}, got {"note":"n"}
 *     ✗ run.completed               : expected succeeded, got failed
 *
 * `match: false` blamed on the run, when the replayer was what differed.
 *
 * THE CLI IS THE SUBJECT, not `replayRun`. `replayRun` always accepted `hooks` — `EngineOptions`
 * carries the field and `Omit<…, "store"|"bus"|"gates">` keeps it — so a test that passes hooks
 * by hand cannot see this defect. The first test here drives `main(["replay", …])`, which is the
 * code that was wrong.
 *
 * A SKIPPING HOOK IS THE SHARPEST PROBE and not an arbitrary one: `skip` means the node's work
 * does not happen, so a replay that lost the hook does not merely disagree — it PERFORMS the
 * action the recording deliberately did not. The write lands on disk, and the assertion on the
 * missing file is the one that says so.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, parseArgs, openWorkspace } from "../../src/cli.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { RunId } from "../../src/ids.ts";
import { replayRun } from "../../src/run/replay.ts";
import { ToolRegistry } from "../../src/run/registry.ts";

/** One `fs.write` node, gated by a `preNode` hook the workspace publishes. */
const GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "hooked-write", project: "demo", version: 1 },
  policy: { posture: "out", capabilities: ["fs:write"] },
  channels: {
    body: { type: "string", reduce: "replace" },
    written: { type: "object", reduce: "replace" },
  },
  inputs: ["body"],
  outputs: ["written"],
  hooks: { preNode: ["hook/skip-write@stable"] },
  nodes: [
    {
      id: "write",
      type: "tool",
      reads: ["body"],
      writes: ["written"],
      tool: { name: "fs.write", version: "1.0", args: { path: "out/copy.txt", body: "${body}" } },
      unhandled: true,
    },
  ],
  edges: [],
};

/**
 * `skip` plus `overrideWrites` — "already done, here is the answer". Strictly LESS action than
 * running the node, which is why `preNode` is allowed to do it at all.
 */
const HOOK = `(input, ctx) => ({ skip: true, overrideWrites: { written: { skippedBy: "hook" } } })`;

function workspace(): { dir: string; graphFile: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-replay-hooks-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  mkdirSync(join(dir, "resources", "hook"), { recursive: true });
  const graphFile = join(dir, "graphs", "hooked.json");
  writeFileSync(graphFile, JSON.stringify(GRAPH));
  // `<workspace>/resources/hook/skip-write.js` publishes `hook/skip-write@stable`.
  writeFileSync(join(dir, "resources", "hook", "skip-write.js"), HOOK);
  return { dir, graphFile, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

async function cli(argv: readonly string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const errOut: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => (errOut.push(String(c)), true)) as typeof process.stderr.write;
  try {
    const code = await main([...argv]);
    return { code, out: out.join(""), err: errOut.join("") };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

test("`loom replay` OF A HOOKED RUN RUNS THE HOOKED PROGRAM", async () => {
  const w = workspace();
  try {
    const first = await cli(["run", w.graphFile, "--workspace", w.dir, "--input", JSON.stringify({ body: "hello" })]);
    assert.equal(first.code, 0, first.err);
    const { runId, status, outputs } = JSON.parse(first.out) as {
      runId: string;
      status: string;
      outputs: Record<string, unknown>;
    };
    assert.equal(status, "succeeded", first.err);

    // The recording proves the hook FIRED: the write never happened and the channel carries the
    // hook's answer. Without these two the replay assertion below would be vacuous.
    assert.deepEqual(outputs["written"], { skippedBy: "hook" });
    assert.equal(existsSync(join(w.dir, "out", "copy.txt")), false, "the hook skipped the node, so nothing was written");

    const r = await cli(["replay", runId, "--graph", w.graphFile, "--workspace", w.dir]);
    assert.equal(r.code, 0, `${r.err}\n${r.out}`);
    assert.match(r.out, /"match": true/);
    // The half a frame comparison cannot state: a replay that lost the hook does not disagree
    // quietly, it PERFORMS the write the recording refused.
    assert.equal(existsSync(join(w.dir, "out", "copy.txt")), false, "the replay executed a node the recording skipped");
  } finally {
    w.dispose();
  }
});

test("CONTROL — THE SAME REPLAY WITH THE HOOKS LEFT OUT REPORTS `match: false`", async () => {
  // If a hookless replay ALSO matched, the test above would prove nothing about hooks: the
  // assertion would be satisfied by a graph whose hook does not change the outcome. This runs
  // `cli.ts`'s OLD engine options — the four fields it passed before `hooks` was added — against
  // the same journal and the same graph.
  const w = workspace();
  try {
    const first = await cli(["run", w.graphFile, "--workspace", w.dir, "--input", JSON.stringify({ body: "hello" })]);
    assert.equal(first.code, 0, first.err);
    const { runId } = JSON.parse(first.out) as { runId: string };

    const ws = openWorkspace(parseArgs(["replay", "--workspace", w.dir]));
    try {
      assert.notEqual(ws.hooks.get("hook/skip-write@stable"), undefined, "the workspace publishes the hook");
      // The same compile `loadGraph` performs, so the graph hash and resolution manifest bind and
      // `graph.bound` stays out of the verdict.
      const graph = compileOrThrow({
        spec: GRAPH as unknown as GraphSpec,
        resolver: ws.resolver,
        tools: (ws.engine.tools as ToolRegistry).manifests(),
        tenantCapabilities: ws.granted,
      });

      const withHooks = await replayRun({
        store: ws.store,
        runId: runId as RunId,
        graph,
        engine: {
          tools: ws.engine.tools,
          functions: ws.engine.functions,
          models: ws.engine.models,
          hooks: ws.hooks,
          policy: { granted: ws.granted },
        },
      });
      assert.equal(withHooks.match, true, JSON.stringify(withHooks.frames.filter((f) => !f.match)));
      assert.equal(withHooks.graph.match, true);

      const without = await replayRun({
        store: ws.store,
        runId: runId as RunId,
        graph,
        engine: {
          tools: ws.engine.tools,
          functions: ws.engine.functions,
          models: ws.engine.models,
          policy: { granted: ws.granted },
        },
      });
      assert.equal(without.match, false, "a replay running a different program reported agreement");
      assert.equal(without.graph.match, true, "the graph bound; what differed is the program that ran it");
      const reduced = without.frames.filter((f) => f.kind === "state.reduced" && !f.match);
      assert.equal(reduced.length, 1, JSON.stringify(without.frames));
      assert.match(String(reduced[0]!.expected), /skippedBy/);
    } finally {
      ws.close();
    }
  } finally {
    w.dispose();
  }
});

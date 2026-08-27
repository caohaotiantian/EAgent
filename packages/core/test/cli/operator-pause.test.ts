/**
 * PAUSE AND RESUME REACH AN OPERATOR, or they are a library method and not an intervention.
 *
 * `Engine.pause` exists because somebody has to be able to stop a running graph without
 * ending it. That somebody holds a terminal, so the verb has to be at the door they actually
 * use — the same argument `loom cancel`'s own comment makes about the exit that was
 * "reachable only over HTTP" while the refusal text told operators to use a command that did
 * not exist.
 *
 * The graph parks on a human gate, which is the state an operator most wants to pause from
 * and the one that is hardest to get right: the gate's answer carries `run.resumed{by:"gate"}`,
 * so a pause that were only the run's status would be undone by the approval. Here that is
 * checked through the binary rather than through the fold.
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

/**
 * Two built-in tools with a human gate between them. NO MODEL and no function bodies — this
 * suite is about the door, so the graph is the smallest thing that can be parked.
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

function workspace(): { dir: string; graphFile: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-pause-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  const graphFile = join(dir, "graphs", "gated.json");
  writeFileSync(graphFile, JSON.stringify(GRAPH));
  writeFileSync(join(dir, "input.txt"), "the body to be approved");
  return { dir, graphFile, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The last JSON object the CLI printed. `loom run` follows its object with gate hints. */
function firstJson(out: string): Record<string, unknown> {
  const end = out.indexOf("\n}");
  assert.ok(end > 0, `no JSON object in CLI output: ${out}`);
  return JSON.parse(out.slice(0, end + 2)) as Record<string, unknown>;
}

test("loom pause / loom resume are the operator's door, and the journal names who used it", async () => {
  const w = workspace();
  try {
    const started = await run([
      "run",
      w.graphFile,
      "--workspace",
      w.dir,
      "--input",
      JSON.stringify({ source: "input.txt" }),
    ]);
    assert.equal(started.code, 0, started.err);
    const runId = String(firstJson(started.out)["runId"]);
    assert.equal(firstJson(started.out)["status"], "awaiting_gate", "the fixture must park for this to mean anything");

    const paused = await run(["pause", runId, "--workspace", w.dir, "--as", "ops", "--reason", "checking the body"]);
    assert.equal(paused.code, 0, paused.err);
    assert.equal(firstJson(paused.out)["paused"], true);

    // THE PAUSE OUTLIVES THE PROCESS THAT MADE IT. Every `run(...)` here opens its own
    // workspace and closes it, so the second command reaches this run holding nothing but
    // the journal — which is the restart, at the door rather than in the fold.
    const resumed = await run(["resume", runId, "--workspace", w.dir, "--as", "ops"]);
    assert.equal(resumed.code, 0, resumed.err);
    assert.equal(firstJson(resumed.out)["paused"], false);

    // A SECOND RESUME IS A REFUSAL, not a courtesy. `run.resumed` folds the status to
    // `running` whatever the run was doing, so a `resume` that accepted an unpaused run
    // would take one out of `awaiting_gate` with nobody having answered the gate.
    await assert.rejects(
      () => run(["resume", runId, "--workspace", w.dir, "--as", "ops"]),
      (thrown: unknown) =>
        isLoomError(thrown) && thrown.code === CODES.E_ILLEGAL_TRANSITION && /is not paused/.test(thrown.message),
      "resuming a run that is not paused must be refused",
    );

    // WHO DID IT, from the journal alone — the whole reason these go through
    // `operator.command` rather than a lifecycle event on their own.
    const ws = openWorkspace(parseArgs(["gates", "--workspace", w.dir]));
    try {
      const log: JournalEvent[] = [];
      for await (const ev of ws.store.read(runId as RunId, 1)) log.push(ev);
      const commands = log
        .filter((ev) => ev.type === "operator.command")
        .map((ev) => ({ kind: (ev.payload as { kind: string }).kind, actor: ev.actor }));
      assert.deepEqual(
        commands.map((c) => c.kind),
        ["pause", "resume"],
        "both interventions are on the record, in order",
      );
      for (const c of commands) {
        assert.equal(c.actor.kind, "human");
        assert.equal((c.actor as { subject?: string }).subject, "ops", "--as is what makes the record name a person");
      }
      const reasons = log
        .filter((ev) => ev.type === "operator.command")
        .map((ev) => (ev.payload as { args: { reason?: unknown } }).args.reason);
      assert.deepEqual(reasons, ["checking the body", "operator"], "a bare command still journals a reason");
    } finally {
      ws.close();
    }
  } finally {
    w.dispose();
  }
});

test("pausing a run that has already ended is refused at the door too", async () => {
  const w = workspace();
  try {
    const started = await run([
      "run",
      w.graphFile,
      "--workspace",
      w.dir,
      "--input",
      JSON.stringify({ source: "input.txt" }),
    ]);
    const runId = String(firstJson(started.out)["runId"]);
    await run(["cancel", runId, "--workspace", w.dir, "--as", "ops"]);

    await assert.rejects(
      () => run(["pause", runId, "--workspace", w.dir, "--as", "ops"]),
      (thrown: unknown) =>
        isLoomError(thrown) && thrown.code === CODES.E_ILLEGAL_TRANSITION && /cannot be paused/.test(thrown.message),
      "an operator told 'paused' about a cancelled run has been told something false",
    );
  } finally {
    w.dispose();
  }
});

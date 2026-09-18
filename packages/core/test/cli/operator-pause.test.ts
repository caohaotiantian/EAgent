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

/**
 * A BARE `--reason` AND A BARE `--reject` ARE DELIBERATE DEFAULTS, and until this test they were
 * three docstrings and no assertion.
 *
 * TODO.md §H.12 gave every flag whose value argv can judge a door reader, and left `--reason` and
 * `--reject` with `null` on the ground that neither has a shape it refuses: `cancel`, `pause`,
 * `resume` and `steer` read `typeof raw === "string" && raw.trim() !== "" ? raw : "operator"`, and
 * `approve` reads a bare `--reject` as the reason "(no reason given)". That argument is the reason
 * those two flags are NOT refused at the door, so it had better be true.
 *
 * WHAT THE TEST ABOVE DOES NOT COVER, and why this one exists. It asserts the journaled reason for
 * a `resume` whose `--reason` was OMITTED. Omitted and BARE are different inputs and the defect
 * class lives in the difference: rewriting the read as `String(raw ?? "operator")` keeps the
 * omitted case answering "operator" and makes a bare `--reason` journal the four letters "true" —
 * the `String(true)` family this CLI has now been bitten by for `--token`, `--port`, `--input`,
 * `--as`, `--host` and `--otlp`. That mutation passes every other test in this repository.
 *
 * THE JOURNAL IS THE ASSERTION, not the exit code: a reason nobody can read back is not a reason.
 */
test("A BARE `--reason` JOURNALS \"operator\", AND A BARE `--reject` JOURNALS \"(no reason given)\"", async () => {
  const w = workspace();
  try {
    const started = await run(["run", w.graphFile, "--workspace", w.dir, "--input", JSON.stringify({ source: "input.txt" })]);
    assert.equal(started.code, 0, started.err);
    const runId = String(firstJson(started.out)["runId"]);
    assert.equal(firstJson(started.out)["status"], "awaiting_gate", "the fixture must park for this to mean anything");

    // `--reason` WITH NO VALUE AT ALL — `parseArgs` makes it `true`, and `String(true)` is what
    // this is here to catch. The trailing position is the shape an operator actually types.
    const paused = await run(["pause", runId, "--workspace", w.dir, "--as", "ops", "--reason"]);
    assert.equal(paused.code, 0, paused.err);
    const resumed = await run(["resume", runId, "--workspace", w.dir, "--as", "ops", "--reason"]);
    assert.equal(resumed.code, 0, resumed.err);

    // AND THE SAME FLAG ON `cancel`, because "the set" here is four verbs sharing one read and a
    // claim about one of them is not a claim about the other three.
    const cancelled = await run(["cancel", runId, "--workspace", w.dir, "--as", "ops", "--reason"]);
    assert.equal(cancelled.code, 0, cancelled.err);

    const ws = openWorkspace(parseArgs(["gates", "--workspace", w.dir]));
    try {
      const log: JournalEvent[] = [];
      for await (const ev of ws.store.read(runId as RunId, 1)) log.push(ev);
      const reasons = log
        .filter((ev) => ev.type === "operator.command")
        .map((ev) => (ev.payload as { args: { reason?: unknown } }).args.reason);
      assert.deepEqual(reasons, ["operator", "operator", "operator"], "a bare --reason must journal the default, never the four letters \"true\"");
      for (const r of reasons) assert.notEqual(r, "true", "`String(true)` reached the journal as an operator's stated reason");
    } finally {
      ws.close();
    }
  } finally {
    w.dispose();
  }
});

test("...and a bare `--reject` is the rejection reason, not the word \"true\"", async () => {
  const w = workspace();
  try {
    const started = await run(["run", w.graphFile, "--workspace", w.dir, "--input", JSON.stringify({ source: "input.txt" })]);
    assert.equal(started.code, 0, started.err);
    const runId = String(firstJson(started.out)["runId"]);

    // The gate id comes from the binary rather than from a constant here: `loom gates` is the
    // command an operator runs to find it, and a fixture that hard-coded it would stop exercising
    // the door the moment gate ids changed shape.
    const listed = await run(["gates", runId, "--workspace", w.dir]);
    assert.equal(listed.code, 0, `\`loom gates\` failed: ${listed.err}`);
    const gateId = /"gateId":\s*"([^"]+)"/.exec(listed.out)?.[1];
    assert.ok(gateId !== undefined, `no gateId in \`loom gates\` output:\n${listed.out}`);

    // EXIT 1 IS THE RIGHT ANSWER HERE and is asserted as such: this fixture's `write` node is
    // `unhandled`, so a rejected gate runs the error edges, the run ends `failed`, and `main`
    // reports that. A test expecting 0 would be asserting that rejecting a gate is a no-op.
    const rejected = await run(["approve", runId, gateId, "--workspace", w.dir, "--as", "ops", "--reject"]);
    assert.equal(rejected.code, 1, `a rejection ends this run as failed; stderr:\n${rejected.err}`);

    const ws = openWorkspace(parseArgs(["gates", "--workspace", w.dir]));
    try {
      const log: JournalEvent[] = [];
      for await (const ev of ws.store.read(runId as RunId, 1)) log.push(ev);
      const decided = log.filter((ev) => ev.type === "gate.decided");
      assert.equal(decided.length, 1, `exactly one decision expected, got ${String(decided.length)}`);
      const payload = decided[0]!.payload as { decision: string; justification?: unknown };
      assert.equal(payload.decision, "reject", "a bare --reject must still be a rejection");
      // `justification` IS WHERE THE REASON LANDS on this row — `loom approve --reject <text>`
      // passes it as the decision's reason and the engine journals it here. The default is the
      // thing being pinned; `"true"` is what it would be if the flag were coerced with `String`.
      assert.equal(payload.justification, "(no reason given)", "a bare --reject must journal the stated default");
      assert.notEqual(payload.justification, "true", "`String(true)` reached the journal as a rejection reason");
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

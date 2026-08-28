/**
 * DESIGN.MD ITEM 2'S OWN SENTENCE, EXECUTED — the one nothing kept passing.
 *
 * "A script that starts `serve` over a journal holding more than 200 runs and one open gate,
 * restarts the process, and answers that gate from a second host." It was written as a
 * `Fails today`, and by the time this file was written all four defects it targeted were
 * fixed and the scenario PASSED — driven by hand, in a third of a second. That is exactly the
 * situation in which a scenario rots: it is the product claim the roadmap makes, it works, and
 * nothing runs it. So it is here, in `npm test`, once.
 *
 * WHY IT IS ONE TEST AND NOT THE LANE. It reproduces nothing — every defect it composes is
 * already fixed, and the ones this lane FOUND were found by `two-planes.test.ts` and
 * `run-clock-survives-restart.test.ts`, neither of which needs a socket. What this adds is the
 * one axis two in-process planes cannot reach: a real OS process, a real exit path, and an
 * address something off this machine could route to. It is regression armour for four fixes at
 * the level they were found, and it is deliberately the only file in this directory that pays
 * for a spawn.
 *
 * WHAT IS SPLIT AND WHY. A second PROCESS is always available; a second ADDRESS is not — a
 * container with one interface has no non-internal IPv4 and may have no `::1`. The two halves
 * are separate tests, so a machine that cannot check the second still checks the first, and
 * the skip NAMES what went unchecked rather than reporting a green tick for it.
 *
 * OFFLINE AND DETERMINISTIC. Every address dialled is one this machine answers on, and there
 * is no sleep anywhere: `until` polls for a JOURNALED FACT under a FAILURE deadline, and
 * nothing asserts how long anything took. The deadlines exist because the failure mode of a
 * test that drives a real socket and a real child is a HANG, and a hang reports less than no
 * test at all — `reach`'s docstring in `harness.ts` records the 600-second one that got through.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_RUN_CLOCK_LIMIT, main } from "../../src/cli.ts";
import type { RunId } from "../../src/ids.ts";
import { deployment, fillRuns, journalTypes, origin, publishGraph, quiet, secondAddress, serving, speak, until, type Deployment } from "./harness.ts";

const TOKEN = "s3cret-not-a-real-token";

/** One gate in front of one `fs.write`, so "the run resumed" and "the action ran" are different facts. */
const GATED = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "restart-and-answer", project: "deployment", version: 1 },
  policy: { posture: "on", capabilities: ["fs:write"], expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
  channels: { note: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
  inputs: ["note"],
  outputs: ["out"],
  nodes: [
    {
      id: "approve",
      type: "human_gate",
      reads: ["note"],
      writes: ["note"],
      humanGate: {
        ref: "oversight/ship@stable",
        approval: { approvers: ["u:alice"] },
        sla: { respondWithinMs: 3_600_000, onTimeout: "fail" },
      },
    },
    {
      id: "apply",
      type: "tool",
      reads: ["note"],
      writes: ["out"],
      tool: { name: "fs.write", version: "1.0", args: { path: "out/applied.txt", body: "${note}" } },
    },
  ],
  edges: [{ id: "e1", from: "approve", to: "apply", kind: "seq" }],
};

/**
 * The scenario's PRECONDITIONS, built and then MEASURED rather than assumed.
 *
 * "More than 200 runs" is the half that is easy to get wrong: `gate-clock-restart.test.ts`
 * records a version of itself sized at 250 against a window of 500, where deleting the filter
 * left the test green. So the fill is sized off the clock's own constant and the assertion
 * below re-takes the measurement: the gated run is NOT in an unfiltered `listRuns(limit)`, and
 * IS in the filtered one the sweep takes.
 */
async function scenario(d: Deployment): Promise<{ runId: RunId; gateId: string; identityFile: string }> {
  const file = publishGraph(d, "restart-and-answer", GATED);
  const { value: code } = await quiet(() => main(["run", file, "--workspace", d.dir, "--input", '{"note":"ship it"}']));
  assert.equal(code, 0, "`loom run` parks on a gate and that is a success");

  const w = d.open();
  try {
    const gated = (await w.store.listRuns(10, { raisedAGate: true }))[0];
    assert.notEqual(gated, undefined, "the run that gated must be findable by the sweep's own listing");
    const runId = gated!.runId;
    const p = await w.engine.projection(runId);
    const open = Object.values(p?.gates ?? {}).filter((g) => g.state === "open");
    assert.equal(open.length, 1, "exactly one gate is open");

    await fillRuns(w.store, DEFAULT_RUN_CLOCK_LIMIT + 20, gated!.lastTs);
    const unfiltered = (await w.store.listRuns(DEFAULT_RUN_CLOCK_LIMIT)).map((r) => r.runId);
    assert.equal(unfiltered.includes(runId), false, `${DEFAULT_RUN_CLOCK_LIMIT + 20} newer runs must push the gated one out of an unfiltered window`);
    const filtered = (await w.store.listRuns(DEFAULT_RUN_CLOCK_LIMIT, { raisedAGate: true })).map((r) => r.runId);
    assert.equal(filtered.includes(runId), true, "…while the gate clock's own listing still holds it");

    const identityFile = join(d.dir, "identities.json");
    writeFileSync(identityFile, JSON.stringify({ subjects: [{ subject: "u:alice", token: TOKEN, via: "console" }] }));
    return { runId, gateId: open[0]!.gateId, identityFile };
  } finally {
    w.close();
  }
}

/** Poll the JOURNAL — the only authoritative state — for the run's end. Never a sleep. */
async function ended(d: Deployment, runId: RunId, deadlineMs: number): Promise<string> {
  return await until(`run ${runId} to reach a terminal event`, deadlineMs, async () => {
    const w = d.open();
    try {
      const types = await journalTypes(w.store, runId);
      return types.find((t) => t === "run.completed" || t === "run.failed" || t === "run.cancelled");
    } finally {
      w.close();
    }
  });
}

test("A RESTARTED `loom serve` ANSWERS A GATE IT DID NOT RAISE, OVER A JOURNAL PAST THE WINDOW", { timeout: 90_000 }, async () => {
  const d = deployment();
  try {
    const { runId, gateId, identityFile } = await scenario(d);

    // ── plane 1: boot over the directory, then GO AWAY. The restart is the point: the process
    // that raised this gate has already exited, and this one exits too, so whatever answers it
    // holds none of the broker state the raise created.
    const first = await serving(["serve", "--workspace", d.dir, "--port", "0", "--token", TOKEN, "--identity-file", identityFile]);
    assert.equal((await speak(`${origin(first.host, first.port)}/health`, { method: "GET", token: TOKEN })).status, 200, "it must serve before it is restarted");
    assert.equal(await first.stop(), 0, "and a SIGINT must be a clean exit, not a crash");

    // ── plane 2: a second process over the same directory.
    const second = await serving(["serve", "--workspace", d.dir, "--port", "0", "--token", TOKEN, "--identity-file", identityFile]);
    try {
      // THE APPROVER'S ENTRY POINT, and it is what makes "past the window" load-bearing: a
      // person who is not the submitter finds their question through `GET /gates`, across runs,
      // not by being told a run id.
      const queue = await speak(`${origin(second.host, second.port)}/gates`, { method: "GET", token: TOKEN });
      assert.equal(queue.status, 200, `GET /gates must answer: ${queue.body}`);
      const listed = (JSON.parse(queue.body) as { gates: { gateId: string; runId: string }[] }).gates;
      assert.equal(
        listed.some((g) => g.gateId === gateId),
        true,
        `the open gate must still be in the approver's queue after ${DEFAULT_RUN_CLOCK_LIMIT + 20} newer runs: ${queue.body.slice(0, 400)}`,
      );

      const answered = await speak(`${origin(second.host, second.port)}/runs/${runId}/gates/${gateId}`, {
        method: "POST",
        token: TOKEN,
        body: { decision: { kind: "approve" } },
      });
      assert.equal(answered.status, 200, `the decision must be accepted: ${answered.body}`);

      // AND THE ACTION BEHIND THE GATE ACTUALLY RAN. "The run resumed" is not the claim; the
      // file is. Polled for a journaled fact under a failure deadline — no sleep, and nothing
      // asserted about how long it took.
      assert.equal(await ended(d, runId, 30_000), "run.completed", "the run must finish, not fail");
      const applied = join(d.dir, "out", "applied.txt");
      assert.equal(existsSync(applied), true, `the tool behind the gate must have written ${applied}`);
      assert.equal(readFileSync(applied, "utf8"), "ship it");
    } finally {
      await second.stop();
    }
  } finally {
    d.dispose();
  }
});

test("…AND FROM AN ADDRESS A SECOND HOST COULD ROUTE TO", { timeout: 90_000 }, async (t) => {
  const other = await secondAddress();
  if (other === undefined) {
    // Not a silent skip. A machine with one bindable address cannot tell an answer that came
    // over a routable interface from one that came over loopback, and saying so beats a tick.
    t.skip("no bindable address other than 127.0.0.1 — the second-HOST half is not checkable here; the second-PROCESS half ran above");
    return;
  }
  const d = deployment();
  try {
    const { runId, gateId, identityFile } = await scenario(d);
    const s = await serving(["serve", "--workspace", d.dir, "--port", "0", "--host", other, "--token", TOKEN, "--identity-file", identityFile]);
    try {
      assert.equal(s.host, other, `the banner must name the address bound, not ${s.host}`);
      const answered = await speak(`${origin(other, s.port)}/runs/${runId}/gates/${gateId}`, {
        method: "POST",
        token: TOKEN,
        body: { decision: { kind: "approve" } },
      });
      assert.equal(answered.status, 200, `answered from ${other}: ${answered.body}`);
      assert.equal(await ended(d, runId, 30_000), "run.completed");
      assert.equal(readFileSync(join(d.dir, "out", "applied.txt"), "utf8"), "ship it");
    } finally {
      await s.stop();
    }
  } finally {
    d.dispose();
  }
});

/**
 * The pause an operator can reach over HTTP, and the field a console has to read to know it.
 *
 * `POST /runs/:id/commands` is the plane's one operator door — `cancel`, `rewind`, `advance`
 * — and stopping a run without ending it belongs on it rather than behind a route of its own,
 * because "what did a human do to this run" is one audit question and `operator.command` is
 * one answer.
 *
 * THE SUMMARY FIELD IS THE POINT OF THE SECOND ASSERTION. A pause is deliberately not the
 * run's status (see `RunProjection.paused`), so a plane that answered with `status` alone
 * would report `running` for a run that is taking no work — the operator who just paused it
 * having no way to confirm the pause landed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ControlPlane } from "../../src/server/http.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import type { RunId } from "../../src/ids.ts";
import { compileSkeleton, DOCS, harness } from "../run/skeleton.ts";

const NOW = 1_700_000_000_000;

interface Rig {
  base: string;
  h: ReturnType<typeof harness>;
  close: () => Promise<void>;
}

async function rig(): Promise<Rig> {
  const h = harness();
  const plane = new ControlPlane({
    engine: h.engine,
    store: h.store,
    bus: h.bus,
    graphs: { "skeleton-summarize": compileSkeleton() },
    now: () => NOW,
  });
  const { port } = await plane.listen(0);
  return { base: `http://127.0.0.1:${port}`, h, close: () => plane.close() };
}

const json = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;

async function command(r: Rig, runId: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${r.base}/runs/${runId}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Park the skeleton on its gate. The plane submits asynchronously, so this waits on state. */
async function parked(r: Rig): Promise<string> {
  const res = await fetch(`${r.base}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workflow: "skeleton-summarize", inputs: { paths: DOCS.slice(0, 2) } }),
  });
  assert.equal(res.status, 202);
  const runId = String((await json(res))["runId"]);
  for (let i = 0; i < 50; i++) {
    const p = await r.h.engine.projection(runId as RunId);
    if (p !== undefined && p.status !== "queued" && p.status !== "running") break;
    await new Promise((done) => setTimeout(done, 20));
  }
  return runId;
}

test("pause and resume are commands on the plane, and `paused` is on the wire", async () => {
  const r = await rig();
  try {
    const runId = await parked(r);

    const paused = await json(await command(r, runId, { kind: "pause", reason: "holding for review" }));
    assert.equal(paused["paused"], true);
    assert.equal(paused["status"], "interrupted");

    // A GET has to say the same thing, or a console polling the run would disagree with the
    // command that made it true.
    const got = await json(await fetch(`${r.base}/runs/${runId}`));
    assert.equal(got["paused"], true);

    const resumed = await json(await command(r, runId, { kind: "resume" }));
    assert.equal(resumed["paused"], false);

    // WHO, AND WHY, FROM THE JOURNAL ALONE.
    const log: JournalEvent[] = [];
    for await (const ev of r.h.store.read(runId as RunId, 1)) log.push(ev);
    const cmds = log.filter((ev) => ev.type === "operator.command");
    assert.deepEqual(
      cmds.map((ev) => (ev.payload as { kind: string }).kind),
      ["pause", "resume"],
    );
    assert.equal(
      (cmds[0]!.payload as { args: { reason?: unknown } }).args.reason,
      "holding for review",
      "the stated reason is journaled, not discarded at the route",
    );
  } finally {
    await r.close();
  }
});

test("resuming a run that is not paused is a 409, not a silent unblock", async () => {
  const r = await rig();
  try {
    const runId = await parked(r);
    // The run is suspended on its GATE, which is the state a careless `resume` would take it
    // out of — `run.resumed` folds the status to `running` whatever raised the suspension.
    const res = await command(r, runId, { kind: "resume" });
    assert.equal(res.status, 409);
    const p = await r.h.engine.projection(runId as RunId);
    assert.equal(p?.status, "awaiting_gate", "the refusal left the gate standing");
  } finally {
    await r.close();
  }
});

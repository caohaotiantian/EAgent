/**
 * STEER OVER HTTP, AND THE ONE THING THAT SEPARATES IT FROM EVERY OTHER COMMAND ON THIS ROUTE.
 *
 * `cancel`, `pause`, `resume` and `rewind` all accept `commandActor`'s answer whatever it is —
 * a plane with no identity source yields `SYSTEM_ACTOR("operator")` and every one of them
 * works. `steer` does not, and that is deliberate: choosing a route is a decision the program
 * otherwise makes for itself, and an author may declare one arm carrying a `human_gate` and one
 * without. Forcing the ungated arm lowers this run's oversight. A HUMAN may do that; a bearer
 * token shared by a deployment is not a human, and `commandActor` is precisely where the
 * difference is already known.
 *
 * So the same request succeeds or is refused on who sent it, which is what these two rigs are.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ControlPlane, type IdentitySource } from "../../src/server/http.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import type { RunId } from "../../src/ids.ts";
import { compileSkeleton, DOCS, harness } from "../run/skeleton.ts";

const NOW = 1_700_000_000_000;

/** A source that says the caller is a person. Nothing else in this file differs between rigs. */
const ops: IdentitySource = {
  name: "sso",
  identify: () => ({ kind: "human", subject: "u:ops", via: "console", method: "sso" }),
};

interface Rig {
  base: string;
  h: ReturnType<typeof harness>;
  close: () => Promise<void>;
}

async function rig(identity?: IdentitySource): Promise<Rig> {
  const h = harness();
  const plane = new ControlPlane({
    engine: h.engine,
    store: h.store,
    bus: h.bus,
    graphs: { "skeleton-summarize": compileSkeleton() },
    now: () => NOW,
    ...(identity === undefined ? {} : { identity }),
  });
  const { port } = await plane.listen(0);
  return { base: `http://127.0.0.1:${port}`, h, close: () => plane.close() };
}

async function parked(r: Rig): Promise<string> {
  const res = await fetch(`${r.base}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer anything" },
    body: JSON.stringify({ workflow: "skeleton-summarize", inputs: { paths: DOCS.slice(0, 2) } }),
  });
  assert.equal(res.status, 202);
  const runId = String(((await res.json()) as Record<string, unknown>)["runId"]);
  for (let i = 0; i < 50; i++) {
    const p = await r.h.engine.projection(runId as RunId);
    if (p !== undefined && p.status !== "queued" && p.status !== "running") break;
    await new Promise((done) => setTimeout(done, 20));
  }
  return runId;
}

async function steer(r: Rig, runId: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${r.base}/runs/${runId}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer anything" },
    body: JSON.stringify({ kind: "steer", ...body }),
  });
}

test("A PLANE WITH NO HUMAN BEHIND THE REQUEST CANNOT STEER, THOUGH IT CAN CANCEL", async () => {
  const r = await rig();
  try {
    const runId = await parked(r);
    // The route, the run and the edge are all valid. The only thing wrong is who is asking.
    const refused = await steer(r, runId, { node: "approve", take: ["e4"] });
    assert.equal(refused.status, 403);

    // THE CONTROL, and it is the whole argument: the same anonymous caller on the same run
    // may still STOP it. Refusing is always allowed; it is the route-choosing that is not.
    const cancelled = await fetch(`${r.base}/runs/${runId}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "cancel" }),
    });
    assert.equal(cancelled.status, 200);

    const log: JournalEvent[] = [];
    for await (const ev of r.h.store.read(runId as RunId, 1)) log.push(ev);
    assert.deepEqual(
      log.filter((ev) => ev.type === "operator.command").map((ev) => (ev.payload as { kind: string }).kind),
      ["cancel"],
      "the refused steer left nothing on the record; the cancel that was allowed is there",
    );
  } finally {
    await r.close();
  }
});

test("a human's steer is taken, and an edge that does not leave the node is not", async () => {
  const r = await rig(ops);
  try {
    const runId = await parked(r);

    // `merge`, NOT `approve`. This test used to steer the human_gate, and `#dispatchNode`
    // never consults a gate's steer — a gate SUSPENDS and resumes through `resolveGate`, so
    // the override was recorded and never read while the plane answered 200. Steering the
    // function node ahead of it is a steer that can actually be taken.
    const ok = await steer(r, runId, { node: "merge", take: ["e3"], reason: "keep it on the gate" });
    assert.equal(ok.status, 200);

    // A GATE IS NOT STEERABLE and the plane says so rather than accepting a no-op.
    assert.equal((await steer(r, runId, { node: "approve", take: ["e4"] })).status, 403);

    // An edge that exists but leaves a DIFFERENT node. This is the shape that jumps whatever
    // sits between here and there — a human gate included — and it is not a typo.
    assert.equal((await steer(r, runId, { node: "merge", take: ["e1"] })).status, 403);
    // And one the graph does not contain at all.
    assert.equal((await steer(r, runId, { node: "merge", take: ["e_nope"] })).status, 403);
    // A body that is not a steer is a 400, not a 403: nothing was refused on authority.
    assert.equal((await steer(r, runId, { node: "merge" })).status, 400);
    assert.equal((await steer(r, runId, { take: ["e4"] })).status, 400);

    const log: JournalEvent[] = [];
    for await (const ev of r.h.store.read(runId as RunId, 1)) log.push(ev);
    const steers = log.filter(
      (ev) => ev.type === "operator.command" && (ev.payload as { kind: string }).kind === "steer",
    );
    assert.equal(steers.length, 1, "exactly the accepted one is on the record");
    assert.equal(steers[0]!.actor.kind, "human");
    assert.equal((steers[0]!.actor as { subject?: string }).subject, "u:ops");
  } finally {
    await r.close();
  }
});

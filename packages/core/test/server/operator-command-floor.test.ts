/**
 * WHICH COMMANDS ON `POST /runs/:id/commands` NEED A PERSON BEHIND THE REQUEST.
 *
 * `cancel`, `pause` and `resume` accept `commandActor`'s answer whatever it is — a plane with no
 * identity source yields `SYSTEM_ACTOR("operator")` and all three work. **`steer` and `rewind` do
 * not**, and that is the split this file exists to hold. Each refuses for its own reason:
 *
 *   - **steer** — choosing a route is a decision the program otherwise makes for itself, and an
 *     author may declare one arm carrying a `human_gate` and one without. Forcing the ungated arm
 *     lowers this run's oversight.
 *   - **rewind** — it DISPATCHES real-world undos, and the range it suppresses may hold the very
 *     `gate.decided` a person spent their judgement on. `b90b137`'s fifth decision requires the
 *     same oversight floor an irreversible action gets, and at `in` that floor is a human.
 *
 * A HUMAN may do either; a bearer token shared by a deployment is not a human, and `commandActor`
 * is precisely where the difference is already known. So the same request succeeds or is refused
 * on who sent it, which is what these two rigs are.
 *
 * THE FILE USED TO SAY `rewind` WAS IN THE FIRST GROUP, and it was right when it was written:
 * `Engine.rewind` took `by: CommandActor = SYSTEM_ACTOR("operator")` and checked it nowhere.
 * Measured on this rig with an `identify` returning `{kind: "service", subject: "svc:deployer"}`,
 * a rewind to seq 2 answered **200** and journaled `system:principal:svc:deployer`. It answers
 * 403 now, which is a tightening an operator meets in production — so the refusal names both ways
 * out, and the `cancel` control below shows the second one really is open.
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

/**
 * A source that says the caller is a NAMED SERVICE, which is the case no rig here had.
 *
 * It matters separately from "no identity source at all": `commandActor` maps an anonymous plane
 * to `SYSTEM_ACTOR("operator")` and a service principal to `SYSTEM_ACTOR("principal:<subject>")`,
 * two different actors that a reader could easily assume land on different sides of the floor.
 * They do not — neither is a human — and this is what shows it.
 */
const deployer: IdentitySource = {
  name: "token",
  identify: () => ({ kind: "service", subject: "svc:deployer", method: "token" }),
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

async function command(r: Rig, runId: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${r.base}/runs/${runId}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer anything" },
    body: JSON.stringify(body),
  });
}

test("NEITHER AN ANONYMOUS PLANE NOR A SERVICE TOKEN MAY REWIND, AND BOTH MAY STILL CANCEL", async () => {
  // TWO RIGS, because they produce two different non-human actors and only one of them was ever
  // obviously non-human. An anonymous plane journals `system:operator` — a marker for "the
  // perimeter concluded an operator did it" — and a named service journals
  // `system:principal:svc:deployer`. Before the floor existed both rewound and answered 200.
  for (const [what, identity] of [
    ["an anonymous plane", undefined],
    ["a named service token", deployer],
  ] as const) {
    const r = await rig(identity);
    try {
      const runId = await parked(r);

      const refused = await command(r, runId, { kind: "rewind", atSeq: 2, reason: "roll it back" });
      assert.equal(refused.status, 403, `${what} must not rewind`);
      const body = (await refused.json()) as { error?: { code?: string; message?: string } };
      assert.equal(body.error?.code, "E_HUMAN_APPROVAL_REQUIRED", what);
      // THE REFUSAL SAYS WHAT TO DO, because this is a 403 where the same request used to get a
      // 200 and the caller is an operator who has a run in front of them, not a test.
      // NAMES THE FLAG, not a posture: this 403 reaches an operator on a plane that may have no
      // identity source at all, where "authenticate as a person" is not something they can act on.
      assert.match(String(body.error?.message), /--identity-file/, what);
      // AND SAYS WHAT `cancel` IS NOT. README's crash-recovery row sends an operator to rewind
      // precisely because it re-arms a stuck lease, which cancel does not — so offering cancel as
      // the alternative would name a way out that is not one for the case they arrived from.
      assert.match(String(body.error?.message), /not a substitute/, what);

      // THE CONTROL, and it is the same one `steer` has: the identical caller on the identical
      // run may still STOP it. Refusing is always allowed; it is the undoing that is not.
      assert.equal((await command(r, runId, { kind: "cancel" })).status, 200, what);

      const log: JournalEvent[] = [];
      for await (const ev of r.h.store.read(runId as RunId, 1)) log.push(ev);
      assert.equal(
        log.filter((ev) => ev.type === "checkpoint.restored").length,
        0,
        `${what}: the refused rewind left no marker`,
      );
      assert.deepEqual(
        log.filter((ev) => ev.type === "operator.command").map((ev) => (ev.payload as { kind: string }).kind),
        ["cancel"],
        `${what}: and only the command that was allowed is on the record`,
      );
    } finally {
      await r.close();
    }
  }
});

test("a person's rewind over the same route is taken, and journaled under their name", async () => {
  // The control for the two refusals above: nothing about the request changed except who sent it.
  const r = await rig(ops);
  try {
    const runId = await parked(r);
    const ok = await command(r, runId, { kind: "rewind", atSeq: 2, reason: "start it again" });
    assert.equal(ok.status, 200);

    const log: JournalEvent[] = [];
    for await (const ev of r.h.store.read(runId as RunId, 1)) log.push(ev);
    const marks = log.filter((ev) => ev.type === "checkpoint.restored");
    assert.equal(marks.length, 1);
    assert.equal(marks[0]!.actor.kind, "human");
    assert.equal((marks[0]!.actor as { subject?: string }).subject, "u:ops");
  } finally {
    await r.close();
  }
});

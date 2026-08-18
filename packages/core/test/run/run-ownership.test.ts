/**
 * WHO started a run, and who stopped it — the durable half.
 *
 * These pin A4: before it, `run.submitted` carried a system control-plane actor and
 * `Engine.cancel`/`rewind` took a string, so "who started this run that spent money" and
 * "who cancelled it" were unanswerable from the journal even in a deployment where the
 * control plane knew both. Nothing here is about ACCESS — that is A3, one phase up. This
 * file only asks whether the journal can answer the question.
 *
 * The shape being pinned is a split, and it is the part a reader is most likely to
 * "simplify": the SUBMITTER rides in the payload because the control plane is genuinely what
 * appended the row, and the CANCELLER rides on the envelope because the caller causes that
 * event directly. Collapsing either into the other is what these tests exist to catch.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { ControlPlane, BearerTokenIdentity, type IdentitySource } from "../../src/server/http.ts";
import { foldRun } from "../../src/run/projection.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import type { RunId } from "../../src/ids.ts";
import { compileSkeleton, harness, skeletonSpec, DOCS } from "./skeleton.ts";

const NOW = 1_700_000_000_000;

const people = (): IdentitySource =>
  new BearerTokenIdentity({
    subjects: [
      { token: "alice-token", subject: "u:alice", via: "console" },
      { token: "ci-token", subject: "svc:ci", kind: "service" },
    ],
  });

interface Rig {
  readonly base: string;
  readonly h: ReturnType<typeof harness>;
  readonly close: () => Promise<void>;
}

async function rig(): Promise<Rig> {
  const h = harness();
  const plane = new ControlPlane({
    engine: h.engine,
    store: h.store,
    bus: h.bus,
    graphs: { "skeleton-summarize": compileSkeleton(skeletonSpec()) },
    now: () => NOW,
    identity: people(),
  });
  const { port } = await plane.listen(0);
  return { base: `http://127.0.0.1:${port}`, h, close: () => plane.close() };
}

async function submit(r: Rig, token: string): Promise<RunId> {
  const res = await fetch(`${r.base}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ workflow: "skeleton-summarize", inputs: { paths: DOCS } }),
  });
  assert.equal(res.status, 202);
  return ((await res.json()) as { runId: RunId }).runId;
}

/**
 * Park the run so a cancel has something to cancel — and ASSERT that it parked.
 *
 * Returning quietly on timeout is what makes the strongest assertion below evaporate: an
 * unparked run has no open gate, `cancelOpenGates` emits nothing, and the one check that
 * pins "a person's cancel closes an approver's question under their name" would pass by
 * being skipped.
 */
async function settle(r: Rig, runId: RunId): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const p = await r.h.engine.projection(runId);
    if (p !== undefined && (p.status === "awaiting_gate" || p.status === "succeeded" || p.status === "failed")) return;
    await new Promise((res) => setTimeout(res, 20));
  }
  assert.fail(`run ${runId} never settled; every assertion after this would be about a run that is still going`);
}

async function events(r: Rig, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const e of r.h.store.read(runId, 1)) out.push(e);
  return out;
}

async function cancelAs(r: Rig, runId: RunId, token: string): Promise<Response> {
  return fetch(`${r.base}/runs/${runId}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ kind: "cancel", reason: "not needed" }),
  });
}

// ── the submitter ────────────────────────────────────────────────────────────

test("a run submitted over HTTP names the AUTHENTICATED principal, and the envelope stays honest", async () => {
  const r = await rig();
  try {
    const runId = await submit(r, "alice-token");
    const submitted = (await events(r, runId)).find((e) => e.type === "run.submitted")!;
    const payload = submitted.payload as { submittedBy?: unknown };

    assert.deepEqual(payload.submittedBy, { kind: "human", subject: "u:alice", method: "bearer-token" });
    // NOT the human. The control plane is what appended this row and says so; the principal
    // is a fact ABOUT the run, the same shape `gate.raised.approvers` has. Collapsing the two
    // would mean widening `Actor`, whose human arm requires a `via` a service has none of.
    assert.deepEqual(submitted.actor, { kind: "system", component: "control-plane" });
  } finally {
    await r.close();
  }
});

test("a SERVICE credential is recorded as a service, not promoted to a person", async () => {
  const r = await rig();
  try {
    const runId = await submit(r, "ci-token");
    const submitted = (await events(r, runId)).find((e) => e.type === "run.submitted")!;
    // `kind` survives the trip. A service principal that folded to `human` would be a
    // credential able to satisfy an approvers list by owning the run it approves.
    assert.deepEqual(submitted.payload["submittedBy"], { kind: "service", subject: "svc:ci", method: "bearer-token" });
  } finally {
    await r.close();
  }
});

test("the principal reaches the PROJECTION, not only the journal", async () => {
  const r = await rig();
  try {
    const runId = await submit(r, "alice-token");
    const p = (await r.h.engine.projection(runId))!;
    // `freeze` enumerates every field explicitly, so a field added to the fold and not to
    // `freeze` is invisible to every consumer with no error and no failing test. This is that
    // test.
    assert.equal(p.submittedBy?.subject, "u:alice");
  } finally {
    await r.close();
  }
});

// ── the canceller ────────────────────────────────────────────────────────────

test("a human cancel journals the HUMAN, on every event the cascade writes", async () => {
  const r = await rig();
  try {
    const runId = await submit(r, "alice-token");
    await settle(r, runId);
    assert.equal((await cancelAs(r, runId, "alice-token")).status, 200);

    const evs = await events(r, runId);
    const cmd = evs.find((e) => e.type === "operator.command")!;
    const cancelled = evs.find((e) => e.type === "run.cancelled")!;
    const gates = evs.filter((e) => e.type === "gate.cancelled");

    const alice = { kind: "human", subject: "u:alice", via: "console" };
    assert.deepEqual(cmd.actor, alice, "the command");
    assert.deepEqual(cancelled.actor, alice, "the terminal event");
    // The gates go with the run, and they go with it under the SAME actor. Before this, a
    // person's cancel closed an approver's open question as `system:operator`.
    //
    // UNCONDITIONAL. Guarding this on "if any gate was cancelled" would let the assertion
    // disappear the day the fixture graph stops gating, which is the shape of covered-test
    // rot this repo has already been bitten by.
    assert.equal(gates.length, 1, "the skeleton parks on exactly one gate, and cancelling closes it");
    assert.deepEqual(gates[0]!.actor, alice, "and every gate it closed");
  } finally {
    await r.close();
  }
});

test("a SERVICE cancel is journaled as a named principal, never as a person", async () => {
  const r = await rig();
  try {
    const runId = await submit(r, "alice-token");
    await settle(r, runId);
    assert.equal((await cancelAs(r, runId, "ci-token")).status, 200);

    const cmd = (await events(r, runId)).find((e) => e.type === "operator.command")!;
    // `Actor` has no service arm, and a named service principal IS a system component in its
    // vocabulary. The `principal:` prefix is what keeps a service subject from colliding with
    // a built-in component name — `GATE_SYSTEM_ACTORS` holds no `principal:*`, so this actor
    // grants nothing anywhere it might later be read.
    assert.deepEqual(cmd.actor, { kind: "system", component: "principal:svc:ci" });
  } finally {
    await r.close();
  }
});

// ── what the fold does with what it is given ─────────────────────────────────

const base = (payload: Record<string, unknown>): JournalEvent[] =>
  [
    { seq: 1, runId: "r" as RunId, ts: 1, type: "run.submitted", actor: { kind: "system", component: "control-plane" }, payload },
  ] as unknown as JournalEvent[];

test("a journal written before the field existed still folds, and claims nobody", () => {
  const p = foldRun(base({ workflow: "w", graphHash: "h", inputs: {}, idempotencyKey: "i", configDigest: "c" }))!;
  // Absent is a real answer and means "nobody was recorded". A synthetic placeholder here
  // would be a name that matches nothing while reading like one that does — and every reader
  // that scopes on this treats absence as PERMISSIVE, so inventing a value would silently
  // hide every historical run instead.
  assert.equal(p.submittedBy, undefined);
});

test("a SECOND run.submitted cannot rewrite the owner", () => {
  const evs = [
    ...base({
      workflow: "w",
      graphHash: "h",
      inputs: {},
      idempotencyKey: "i",
      configDigest: "c",
      submittedBy: { kind: "human", subject: "u:alice", method: "sso" },
    }),
    ...(base({
      workflow: "w",
      graphHash: "h",
      inputs: {},
      idempotencyKey: "i",
      configDigest: "c",
      submittedBy: { kind: "human", subject: "u:mallory", method: "sso" },
    }).map((e) => ({ ...e, seq: 2 })) as unknown as JournalEvent[]),
  ];
  const p = foldRun(evs)!;
  // FIRST WINS, because the `run_head.submitted_by` column is written on the row-creating
  // INSERT and never on the update. If the fold took the later value, the list route (the
  // column) and the detail route (this fold) would disagree about who owns a run — in a field
  // that decides access.
  assert.equal(p.submittedBy?.subject, "u:alice");
});

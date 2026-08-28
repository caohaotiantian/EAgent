/**
 * A CEILING SET THROUGH THE NEW DOOR SURVIVES THE PROCESS THAT SET IT.
 *
 * `POST /runs/:id/oversight` is the only route on this plane that LOWERS anything, and the
 * class it has to be proved against is named in CLAUDE.md: "the journal is the only
 * authoritative state… this has been violated six times and each violation silently switched
 * off a guard". Every one of those six was a value a decision read that a restart could not
 * rebuild, and five of them were on this exact mechanism — see
 * `test/run/oversight-survives-restart.test.ts`. So the assertion that matters here is not
 * that the route answers 200; it is that a SECOND process, over the same store, with no
 * memory of the request, folds the same ceiling.
 *
 * The refusals are the other half. `PolicyEngine.deescalate` refuses a non-`human` actor, and
 * over HTTP that is stronger than it looks: `#decider` collapses every non-human credential —
 * the shared bearer token included — to `(unidentified)`, so the route refuses it before the
 * engine is reached. That refusal is the ONE this route adds; everything else it inherits.
 *
 * IN-PROCESS PLANES AND A REAL SOCKET. `serving` spawns a `loom serve`, which this file does
 * not need: the restart it is about is a second `openWorkspace` over the same directory, and
 * the route is exercised through a bound socket either way. Offline and deterministic — the
 * only address dialled is 127.0.0.1, and nothing reads a clock.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { controlPlaneOptions, main } from "../../src/cli.ts";
import { parseArgs } from "../../src/cli.ts";
import { ControlPlane, BearerTokenIdentity } from "../../src/server/http.ts";
import type { RunId } from "../../src/ids.ts";
import { deployment, origin, publishGraph, quiet, speak, type Deployment } from "./harness.ts";

const TOKEN = "s3cret-not-a-real-token";
const ALICE = "alice-token-not-a-real-one";

/** A gate in front of a `fs.write`, so the run parks and is still there to be de-escalated. */
const GATED = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "oversight-door", project: "deployment", version: 1 },
  policy: { posture: "on", capabilities: ["fs:write"] },
  channels: { note: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
  inputs: ["note"],
  outputs: ["out"],
  nodes: [
    {
      id: "approve",
      type: "human_gate",
      reads: ["note"],
      writes: ["note"],
      humanGate: { ref: "oversight/ship@stable", approval: { mode: "single", approvers: ["u:alice"] } },
    },
    { id: "apply", type: "tool", reads: ["note"], writes: ["out"], tool: { name: "fs.write", version: "1.0", args: { path: "out/x.txt", body: "${note}" } } },
  ],
  edges: [{ id: "e1", from: "approve", to: "apply", kind: "seq" }],
};

async function parked(d: Deployment): Promise<{ runId: RunId; identityFile: string }> {
  const file = publishGraph(d, "oversight-door", GATED);
  const { value: code } = await quiet(() => main(["run", file, "--workspace", d.dir, "--input", '{"note":"ship it"}']));
  assert.equal(code, 0, "`loom run` parks on a gate and that is a success");
  const w = d.open();
  try {
    const gated = (await w.store.listRuns(10, { raisedAGate: true }))[0];
    assert.notEqual(gated, undefined, "the fixture must have gated");
    const identityFile = join(d.dir, "identities.json");
    // `operator: true` is what lets alice reach a run the CLI submitted with no principal —
    // and it is beside the point of every assertion below, all of which are about `human`.
    writeFileSync(identityFile, JSON.stringify({ subjects: [{ subject: "u:alice", token: ALICE, via: "console", operator: true }] }));
    return { runId: gated!.runId, identityFile };
  } finally {
    w.close();
  }
}

/** A plane over this directory, bound on loopback. Two of these in a row IS the restart. */
async function plane(d: Deployment, identityFile: string): Promise<{ url: string; close(): Promise<void> }> {
  const ws = d.open();
  const opts = controlPlaneOptions(ws, parseArgs(["serve", "--workspace", d.dir, "--token", TOKEN, "--identity-file", identityFile]));
  const p = new ControlPlane(opts);
  const bound = await p.listen(0, "127.0.0.1");
  return {
    url: origin(bound.host, bound.port),
    close: async () => {
      await p.close();
      ws.close();
    },
  };
}

test("POST /runs/:id/oversight lowers a posture, and a RESTARTED plane folds the same ceiling", async () => {
  const d = deployment();
  try {
    const { runId, identityFile } = await parked(d);
    const first = await plane(d, identityFile);
    let before: unknown;
    try {
      const r = await speak(`${first.url}/runs/${runId}/oversight`, {
        method: "POST",
        token: ALICE,
        body: { scope: `run:${runId}`, to: "on", why: "incident 4471: on-the-loop for the next hour" },
      });
      assert.equal(r.status, 200, `the route must accept an identified human: ${r.body}`);
      const answered = JSON.parse(r.body) as Record<string, unknown>;
      assert.equal(answered["ceiling"], "on");
      assert.equal(answered["scope"], `run:${runId}`);
      before = answered["ceiling"];
    } finally {
      await first.close();
    }

    // THE RESTART. A new `Engine`, a new `PolicyEngine`, a new SQLite handle, folding the same
    // journal — and the ceiling has to come back out of it. If it does not, the guard the
    // de-escalation is scoped by is silently different after a redeploy, which is the shape of
    // all six named violations of the journal non-negotiable.
    const second = await plane(d, identityFile);
    try {
      const ws = d.open();
      try {
        const p = await ws.engine.projection(runId);
        assert.equal(p?.ceilings[`run:${runId}`], before, "the ceiling is a pure function of the log, across a restart");
      } finally {
        ws.close();
      }
      // AND THE DOOR AGREES WITH THE FOLD. `Engine.deescalate` reads `ceilingFor` for the
      // `from` it journals, and a second plane whose `PolicyEngine.restore` did not re-seed
      // would report `in` — the default — rather than the `on` that is on the record.
      const r = await speak(`${second.url}/runs/${runId}/oversight`, {
        method: "POST",
        token: ALICE,
        body: { scope: `run:${runId}`, to: "out", why: "the window is over; unsupervised for the drain" },
      });
      assert.equal(r.status, 200, r.body);
      assert.equal((JSON.parse(r.body) as Record<string, unknown>)["from"], "on", "the restarted plane knew the ceiling the first one set");
    } finally {
      await second.close();
    }
  } finally {
    d.dispose();
  }
});

test("no credential that names nobody may lower a posture, and the refusal appends nothing", async () => {
  const d = deployment();
  try {
    const { runId, identityFile } = await parked(d);
    const p = await plane(d, identityFile);
    try {
      const body = { scope: `run:${runId}`, to: "out", why: "because I can" };

      // THE SHARED BEARER TOKEN. It authenticates a DEPLOYMENT — every service in it holds the
      // same string — so `#decider` mints `(unidentified)` for it and this route refuses.
      const shared = await speak(`${p.url}/runs/${runId}/oversight`, { method: "POST", token: TOKEN, body });
      assert.equal(shared.status, 403, `the shared token must not lower oversight: ${shared.body}`);
      assert.match(shared.body, /E_OVERSIGHT_LOOSEN_FORBIDDEN/);
      assert.match(shared.body, /identifies no person/);

      // NO CREDENTIAL AT ALL is 401 before routing — the perimeter, not this route.
      const anon = await speak(`${p.url}/runs/${runId}/oversight`, { method: "POST", body });
      assert.equal(anon.status, 401, anon.body);

      // AND THE REFUSAL IS NOT A NO-OP THAT LEFT A CEILING BEHIND.
      const ws = d.open();
      try {
        const proj = await ws.engine.projection(runId);
        assert.deepEqual(proj?.ceilings, {}, "a refused loosening installs nothing");
      } finally {
        ws.close();
      }
    } finally {
      await p.close();
    }
  } finally {
    d.dispose();
  }
});

test("the body's three fields are checked, and none of them has a permissive fallback", async () => {
  const d = deployment();
  try {
    const { runId, identityFile } = await parked(d);
    const p = await plane(d, identityFile);
    try {
      const post = async (body: unknown): Promise<{ status?: number; body: string }> =>
        await speak(`${p.url}/runs/${runId}/oversight`, { method: "POST", token: ALICE, body });

      const noWhy = await post({ scope: `run:${runId}`, to: "out" });
      assert.equal(noWhy.status, 400, noWhy.body);
      assert.match(noWhy.body, /why.{0,3} must be a non-empty justification/);

      const blankWhy = await post({ scope: `run:${runId}`, to: "out", why: "   " });
      assert.equal(blankWhy.status, 400, blankWhy.body);

      const badPosture = await post({ scope: `run:${runId}`, to: "off", why: "x" });
      assert.equal(badPosture.status, 400, badPosture.body);
      assert.match(badPosture.body, /to.{0,3} must be one of/);

      const crossRun = await post({ scope: "run:01OTHERRUNIDOTHERRUNIDOTHER", to: "out", why: "x" });
      assert.equal(crossRun.status, 400, crossRun.body);
      assert.match(crossRun.body, /names run 01OTHERRUNIDOTHERRUNIDOTHER/);

      const noScope = await post({ to: "out", why: "x" });
      assert.equal(noScope.status, 400, noScope.body);
      assert.match(noScope.body, /There is no default scope/);

      // A CLAIMED ACTOR IS REFUSED FOR WHAT IT IS. `#decider`'s rule — the subject comes from
      // the credential, never from the body — reaches this route unchanged.
      const claimed = await post({ scope: `run:${runId}`, to: "out", why: "x", actor: "u:someone-else" });
      assert.equal(claimed.status, 403, claimed.body);

      const ws = d.open();
      try {
        assert.deepEqual((await ws.engine.projection(runId))?.ceilings, {}, "six refusals, nothing appended");
      } finally {
        ws.close();
      }
    } finally {
      await p.close();
    }
  } finally {
    d.dispose();
  }
});

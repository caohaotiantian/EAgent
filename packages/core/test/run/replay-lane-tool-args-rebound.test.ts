/**
 * A recorded tool result is bound to the ARGUMENTS it answered, not only to the tool's name,
 * version and argument shape.
 *
 * The effect key is positional (`write@root#0:tool:0`) and `reboundEffects` compared
 * `name@version(argsShape)`, so a candidate graph that called `fs.write` with a different `path`
 * kept the key and the shape `{body:string,path:string}`, was served the recorded write, and
 * replayed `match: true, reboundEffects: []` under `onGraphChange: "allow"` — which is what
 * `evolution/gate.ts` reads to certify that a candidate was measured. The discriminator was in
 * the same event all along: `tool.called.argsDigest`, written since 2026-08-27 and read by the
 * live re-execution path only. Measured at 95a3dde, with the first test below.
 *
 * The third test is the population the fix must not break: a journal recorded BEFORE
 * `argsDigest` existed. Absence of the field is not evidence that the calls agree, and it is not
 * evidence that they differ — so such keys are named in `unverifiedToolEffects`, the same third
 * state the model arm already keeps for a missing `requestDigest`, and the journal still folds
 * and still replays against its own graph.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { RunGraph } from "../../src/graph/spec.ts";
import type { NodeId, RunId } from "../../src/ids.ts";
import { replayRun } from "../../src/run/replay.ts";
import { DOCS, compileSkeleton, harness, skeletonSpec } from "./skeleton.ts";
import { withoutArgsDigest } from "./replay-lane-filtered-store.ts";

const WRITE_KEY = "write@root#0:tool:0";
const FULL_IDENTITY = /^fs\.write@1\.0\(\{body:string,path:string\}\) sha256:[0-9a-f]{64}$/;

const REPLAY_ENGINE = (h: ReturnType<typeof harness>) => ({
  tools: h.engine.tools,
  functions: h.engine.functions,
  models: h.engine.models,
  policy: { granted: ["fs:read", "fs:write"] },
});

async function recorded(): Promise<{ h: ReturnType<typeof harness>; graph: RunGraph; runId: RunId }> {
  const h = harness();
  const graph = compileSkeleton();
  const runId = await h.engine.submit({ graph, inputs: { paths: DOCS } });
  let p = await h.engine.advance(runId);
  if (p.status === "awaiting_gate") {
    const gate = Object.values(p.gates).find((g) => g.state === "open")!;
    p = await h.engine.resolveGate(runId, {
      gateId: gate.gateId,
      decision: { kind: "approve" },
      actor: { kind: "human", subject: "u:alice", via: "console" },
      idempotencyKey: "k1",
    });
  }
  assert.equal(p.status, "succeeded");
  return { h, graph, runId };
}

/** The same tool, the same version, the same argument SHAPE — a different argument VALUE. */
function writesElsewhere(): RunGraph {
  const base = skeletonSpec();
  return compileSkeleton(
    skeletonSpec({
      nodes: base.nodes.map((x) =>
        x.id === ("write" as NodeId)
          ? { ...x, tool: { name: "fs.write", version: "1.0", args: { path: "out/SOMEWHERE-ELSE.md", body: "${merged.markdown}" } } }
          : x,
      ),
    }),
  );
}

test("THE SAME TOOL WITH DIFFERENT ARGUMENT VALUES IS A REBOUND EFFECT, not a clean replay", async () => {
  const { h, runId } = await recorded();
  const writesBefore = h.writes.length;

  // `"allow"` on purpose: it is the one setting under which the graph hash cannot notice, and it
  // is the setting a candidate is judged under.
  const report = await replayRun({ store: h.store, runId, graph: writesElsewhere(), engine: REPLAY_ENGINE(h), onGraphChange: "allow" });

  assert.equal(h.writes.length, writesBefore, "no live write happened — the recorded one was served to the wrong call");
  assert.deepEqual(report.unservedEffects, [], "the same keys were consumed, which is the whole problem");
  assert.equal(report.match, false, "a result served to a call with other arguments is a divergence");

  const rebound = report.reboundEffects.find((r) => r.key === WRITE_KEY);
  assert.ok(rebound, `the write is named: ${JSON.stringify(report.reboundEffects)}`);
  assert.equal(rebound.field, "tool");
  assert.match(rebound.recorded, FULL_IDENTITY, "the identity carries the WHOLE digest, not a prefix");
  assert.match(rebound.replayed, FULL_IDENTITY);
  assert.notEqual(rebound.recorded, rebound.replayed);
  assert.equal(rebound.recorded.split(" ")[0], rebound.replayed.split(" ")[0], "name, version and shape agree — only the arguments moved");
  assert.ok(
    report.frames.some((f) => f.kind === "effect.rebound" && !f.match && f.expected === rebound.recorded && f.actual === rebound.replayed),
    "…and it is a frame, so `loom replay` prints it and exits non-zero",
  );
  assert.deepEqual(report.unverifiedToolEffects, [], "this recording carries every digest, so nothing is undecidable");
});

test("ORDINARY HALF — the unchanged graph rebinds nothing and serves every tool from the record", async () => {
  const { h, graph, runId } = await recorded();
  const writes = h.writes.length;
  const reads = [...h.reads];
  const turns = h.model.seen.length;

  const report = await replayRun({ store: h.store, runId, graph, engine: REPLAY_ENGINE(h) });

  assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match), null, 1));
  assert.deepEqual(report.reboundEffects, []);
  assert.deepEqual(report.unverifiedToolEffects, []);
  assert.equal(h.writes.length, writes, "zero live writes");
  assert.deepEqual(h.reads, reads, "zero live reads");
  assert.equal(h.model.seen.length, turns, "zero live model calls");
});

test("A RECORDING WITHOUT argsDigest IS NOT EVIDENCE OF SAMENESS — it folds, replays, and is named unverified", async () => {
  const { h, graph, runId } = await recorded();
  const old = withoutArgsDigest(h.store);
  let toolCalls = 0;
  for await (const e of old.read(runId, 1 as never)) {
    if (e.type === "tool.called") {
      toolCalls++;
      assert.equal("argsDigest" in (e.payload as object), false, "the fixture really is the old shape");
    }
  }
  assert.ok(toolCalls > 1, "the skeleton makes several tool calls, or the list below proves little");

  const same = await replayRun({ store: old, runId, graph, engine: REPLAY_ENGINE(h) });
  assert.equal(same.match, true, `an old journal still folds and replays against its own graph: ${JSON.stringify(same.frames.filter((f) => !f.match))}`);
  assert.deepEqual(same.reboundEffects, [], "nothing measured, so nothing claimed");
  assert.equal(same.unverifiedToolEffects.length, toolCalls, "every tool key is undecidable, and every one is named");
  assert.ok(same.unverifiedToolEffects.includes(WRITE_KEY));
  assert.deepEqual(same.unverifiedModelEffects, [], "the model arm is untouched — its digests are present");

  const other = await replayRun({ store: old, runId, graph: writesElsewhere(), engine: REPLAY_ENGINE(h), onGraphChange: "allow" });
  assert.deepEqual(other.reboundEffects, [], "a difference nothing measured is not reported as a difference…");
  assert.ok(other.unverifiedToolEffects.includes(WRITE_KEY), "…and the undecidable key is named rather than passed as clean");
});

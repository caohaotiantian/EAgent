/**
 * `checkpoint.created.atSeq` is a REWIND TARGET, and that is the whole content of this file.
 *
 * The field reads like "the seq this checkpoint is at" and is not: the event lands at seq 9
 * and `atSeq` says 8. An audit that took it for the event's own position would be off by
 * one, and a tool that used it as a rewind argument would be exactly right — which is the
 * reason the value is what it is, and the reason nothing noticed it was undocumented.
 *
 * `rewind(runId, atSeq)` suppresses `(atSeq, marker)` exclusive at both ends, so this value
 * recovers the state the checkpoint captured. Passing the checkpoint's own seq instead would
 * keep the checkpoint and everything the same append wrote after it.
 *
 * Pinned here because the arithmetic that produces it — `p.seq + events.length`, evaluated
 * before the activation events are pushed — is the kind a later edit changes silently.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

async function runWithCheckpoint(): Promise<{ own: number; atSeq: number; store: MemoryStateStore; runId: string }> {
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const functions = new FunctionRegistry();
  functions.register("function/a@stable", () => ({ writes: { out: "ok" } }));
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models,
    now,
    maxParallelism: 1,
    policy: { granted: [], budget: { runUsd: 1 } },
  });

  const spec = {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "cp", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { seed: { type: "string", reduce: "replace" }, out: { type: "string", reduce: "replace" } },
    inputs: ["seed"],
    outputs: ["out"],
    nodes: [
      {
        id: "a",
        type: "function",
        reads: ["seed"],
        writes: ["out"],
        function: { ref: "function/a@stable" },
        checkpoint: "after",
      },
    ],
    edges: [],
  } as unknown as GraphSpec;

  const graph = compileOrThrow({ spec, resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { seed: "go" } });
  await engine.advance(runId);

  let own = -1;
  let atSeq = -1;
  for await (const ev of store.read(runId, 1)) {
    if (ev.type !== "checkpoint.created") continue;
    own = ev.seq;
    atSeq = (ev.payload as { atSeq: number }).atSeq;
  }
  return { own, atSeq, store, runId };
}

test("atSeq NAMES THE EVENT BEFORE THE CHECKPOINT, not the checkpoint itself", async () => {
  const { own, atSeq } = await runWithCheckpoint();
  assert.ok(own > 0, "the graph must actually produce a checkpoint");
  assert.equal(
    atSeq,
    own - 1,
    `atSeq is a rewind target: it must name the last event BEFORE the checkpoint. ` +
      `checkpoint at seq ${String(own)}, atSeq ${String(atSeq)}`,
  );
});

test("AND IT IS A VALID REWIND TARGET — the property that makes the off-by-one correct", async () => {
  const { atSeq } = await runWithCheckpoint();
  // `rewind` refuses anything below the run's first event, and refuses a target that would
  // suppress `run.submitted`. A checkpoint's `atSeq` must never be one of those, or the
  // field would name a value the only API that consumes it rejects.
  assert.ok(atSeq >= 1, `a rewind target must be at least 1; got ${String(atSeq)}`);
});

/**
 * Retry is refused by what a Task CALLED, not by what its node declares it may call.
 *
 * The reachable-tool set is the right question for a POSTURE — what a node might do
 * decides how closely it is watched. It is the wrong question for this refusal, which is
 * about an action that already happened. Asking it here cost an agent its retry policy the
 * moment its first MODEL call started, because `#effectStarted` matches any effect key
 * prefixed by the taskId, `:model:` included — so a transport blip on turn one looked like
 * a non-idempotent tool that might have rung the bell.
 *
 * This is the same declared-versus-invoked distinction the rewind scan needed, in the
 * function twenty lines away from it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { RunId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { compileSkeleton, DOCS, harness } from "./skeleton.ts";

async function events(store: { read(r: RunId, f: number): AsyncIterable<JournalEvent> }, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const e of store.read(runId, 1)) out.push(e);
  return out;
}

test("A MODEL BLIP IS STILL RETRYABLE when the declared tool was never called", async () => {
  let firstCall = true;
  const h = harness({
    script: (req) => {
      // The agent declares `fs.read` (non-idempotent in no sense that matters here) and
      // never reaches for it: the turn dies in the provider.
      if (firstCall) {
        firstCall = false;
        throw new Error("transient upstream reset");
      }
      const path = (JSON.parse(req.messages[0]?.content ?? "{}") as { state?: { path?: string } }).state?.path ?? "?";
      return { text: JSON.stringify({ path, summary: "recovered" }), finishReason: "stop" };
    },
  });

  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS.slice(0, 1) } });
  await h.engine.advance(runId).catch(() => undefined);

  const log = await events(h.store, runId);
  const started = log.filter((e) => e.type === "effect.started" && (e.payload as { kind: string }).kind === "tool");
  assert.deepEqual(started, [], "precondition: no tool body was ever entered");

  // Nothing reached the sandbox, so nothing can have rung a bell — the refusal must not
  // fire on the mere DECLARATION of a tool the model never chose.
  const retried = log.some((e) => e.type === "task.retry_scheduled");
  const failed = log.some((e) => e.type === "run.failed");
  assert.ok(retried || !failed, "a transport blip before any tool call must remain retryable");
});

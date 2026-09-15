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

import { CODES, err } from "../../src/errors.ts";
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
      //
      // A RETRYABLE BLIP, AND THAT MATTERS. This threw a bare `Error` until 2026-09-15 —
      // `toLoomError` makes that `E_INTERNAL`/`internal`, which is not in `RETRYABLE`, so
      // `#retryDecision` returned at its SECOND line and never reached `#mayHaveRungABell` at
      // all. The assertion below then passed on `!failed` alone, with ZERO retry rows on the
      // log: measured on the fixture as it stood, `status: awaiting_gate | retry rows: 0 |
      // run.failed: 0 | gates: ["open"]` — the one branch died, the join folded nothing, and the
      // run parked on the skeleton's human gate, which is not `failed` and so satisfied the
      // disjunction. (It was §D.9's answer, turning that same run `failed`, that surfaced it.)
      // `E_PROVIDER_TRANSPORT`/`unavailable` is what a transport blip actually is, and with it
      // this file at least reaches a retry decision.
      //
      // WHAT IT STILL DOES NOT REACH, said plainly rather than left to be inferred:
      // `#mayHaveRungABell` returns `false` on its FIRST line here, because `fs.read` is
      // registered `idempotent: true` in `skeleton.ts` — so `nonIdempotentReachable` is false and
      // `#unfinishedToolEffect`'s `:tool:` narrowing, which this file is NAMED for, is never
      // consulted. Broadening that prefix back to `${taskId}:` leaves this test green. Driving it
      // needs an agent node reaching a NON-idempotent tool; until one exists here, what this file
      // pins is the outer claim — a transport blip before any tool call is retried.
      if (firstCall) {
        firstCall = false;
        throw err.unavailable(CODES.E_PROVIDER_TRANSPORT, "transient upstream reset");
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
  //
  // THE RETRY ROW ITSELF, not `retried || !failed`. That disjunction was satisfiable without a
  // retry ever being scheduled, and for two years it was: see the script above.
  const retried = log.filter((e) => e.type === "task.retry_scheduled");
  assert.equal(retried.length, 1, "a transport blip before any tool call must remain retryable");
  assert.equal(
    (retried[0] as { payload: { code: string } }).payload.code,
    "E_PROVIDER_TRANSPORT",
    "and the retry is scheduled on the blip's own code",
  );
  assert.ok(
    log.some((e) => e.type === "task.ready" && e.taskId === retried[0]!.taskId),
    "and the Task is put back on the ready set rather than the run being ended",
  );
});

/**
 * THE PERSON A TEST'S OPERATOR COMMAND IS ATTRIBUTED TO.
 *
 * It exists because `Engine.rewind` stopped having a `SYSTEM_ACTOR` default. That default was
 * the whole defect — it made an actor look optional at 34 of 36 call sites and then checked it
 * nowhere — so replacing it with a per-file `const OPERATOR = ...` in eleven files would put
 * the same easy shortcut back where the next writer will copy it. One constant, imported, and
 * the fact it encodes is stated once: a rewind and a steer are things a HUMAN does, and a test
 * that drives one has to say which human, exactly as an operator at a console would.
 *
 * `via: "console"` rather than `"api"` because these are direct in-process calls, not requests
 * that crossed the control plane. Nothing folds it today; it is here so the audit trail a test
 * writes is the shape a real one would be.
 */

import type { HumanActor } from "../../src/journal/events.ts";
import type { RunId, Seq } from "../../src/ids.ts";
import type { Engine } from "../../src/run/engine.ts";
import type { RunProjection } from "../../src/run/projection.ts";

export const OPERATOR: HumanActor = { kind: "human", subject: "u:alice", via: "console" };

/**
 * A `planHash` for a call that must be refused BEFORE the hash is looked at.
 *
 * A.34's floor is the FIRST check in `Engine.rewind`, ahead of A.35's plan check, and the tests
 * that pin that ordering have to pass SOMETHING for the fifth argument. A named constant says
 * which of the two refusals the test is about; a plausible-looking digest literal there would
 * read like a stale plan and make the next reader wonder which check fired.
 */
export const NEVER_READ = "sha256:this-hash-is-never-read-because-the-actor-is-refused-first";

/**
 * THE TWO-PHASE REWIND, AS ONE CALL, FOR A TEST THAT IS NOT ABOUT THE HANDSHAKE.
 *
 * A.35 made `planHash` a required fifth argument, and 39 call sites across 13 files drive a
 * rewind for a reason that has nothing to do with the preview — a stuck lease, a cancelled
 * cascade, a gate re-armed. Rewriting each of them to call `planRewind` inline would be 39
 * hand-edits through assertion-bearing code, which is how an assertion goes missing; it would
 * also put "preview, then confirm" in 39 places where the next writer copies whichever one they
 * land on.
 *
 * SO IT IS A HELPER AND NOT A DEFAULT ARGUMENT. `Engine.rewind` deliberately has no default for
 * `auth` — a default is precisely how A.34's actor floor came to be checked nowhere at 34 of 36
 * sites — and a test helper is the right place for the shortcut because it is visible in the
 * call: `rewindWithPlan` says a plan was fetched and passed. The tests that are ABOUT the
 * handshake (`rewind-plan.test.ts`) call the two methods directly and must keep doing so.
 */
export async function rewindWithPlan(
  engine: Engine,
  runId: RunId,
  atSeq: Seq,
  reason: string,
  by: HumanActor = OPERATOR,
): Promise<RunProjection> {
  const plan = await engine.planRewind(runId, atSeq, by);
  return engine.rewind(runId, atSeq, reason, by, { planHash: plan.planHash });
}

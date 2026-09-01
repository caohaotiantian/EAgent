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

export const OPERATOR: HumanActor = { kind: "human", subject: "u:alice", via: "console" };

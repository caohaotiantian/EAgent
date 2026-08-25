/**
 * A millisecond is too coarse to order Tasks, and the tie-break was a digest.
 *
 * `spansFrom` sorted by `startTime` and broke ties on `spanId` — which is a hash of the run and
 * task ids, so two Tasks that begin in the same millisecond came out in an order with no meaning.
 *
 * Measured by driving a four-node graph through `bin/loom`: `collect` (a join) and `write` (the
 * only node that reads what it produces) both reached `task.ready` at ts …882080, and `loom trace`
 * printed `write` ABOVE `collect` — reversing the one edge between them. Five of that run's Tasks
 * fell inside nine milliseconds, so the collision is the normal case rather than a race.
 *
 * `conformance: ok` still passed, correctly: conformance is set-membership plus a graph hash and
 * says nothing about order. Nothing else looks at it, which is why the output was wrong in the one
 * command whose entire job is to say what happened.
 *
 * THE FIX RECOVERS AN ORDER THAT ALREADY EXISTED. `seq` totally orders a journal, this fold
 * consumes events in `seq` order, so the order spans are STARTED in is journal order is causal
 * order. The tie-break is now that ordinal.
 *
 * Every `ts` below is a literal and every Task shares one, so the sort is decided ENTIRELY by the
 * tie-break — the test cannot pass by accident of the clock.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { spansFrom } from "../../src/telemetry/spans.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import type { RunId, TaskId } from "../../src/ids.ts";

const RUN = "01JRUNORDER000000000000000" as RunId;

/** One timestamp for the whole run. Real runs collide within a millisecond; this guarantees it. */
const TS = 1_700_000_000_000;

function ev(seq: number, type: string, payload: unknown, taskId: TaskId | null): JournalEvent {
  return {
    runId: RUN,
    seq,
    ts: TS,
    type,
    payload,
    actor: { kind: "system", component: "fixture" },
    ...(taskId === null ? {} : { taskId }),
    classification: "internal",
  } as unknown as JournalEvent;
}

/**
 * `a` → `b` → `c`, committed in that order, every event in the same millisecond.
 *
 * The ids are chosen so LEXICOGRAPHIC order disagrees with causal order at the task level, which
 * is what the old tie-break ultimately sorted by. It cannot be relied on to disagree at the
 * SPAN-id level — those are digests — so the test asserts the property that matters and the
 * mutation check is what proves the assertion has teeth.
 */
const journal = (): readonly JournalEvent[] => {
  const t = (n: string) => `${n}@root#0` as TaskId;
  const out: JournalEvent[] = [
    ev(1, "run.submitted", { graphHash: "sha256:x", configDigest: "sha256:y" }, null),
    ev(2, "run.started", {}, null),
  ];
  let seq = 3;
  for (const n of ["c_first", "b_second", "a_third"]) {
    out.push(ev(seq++, "task.ready", { nodeId: n, branchPath: "root", edgesIn: [] }, t(n)));
    out.push(ev(seq++, "task.leased", { attempt: 1, workerId: "w1" }, t(n)));
    out.push(ev(seq++, "task.committed", { take: [], status: "succeeded", writes: {} }, t(n)));
  }
  out.push(ev(seq++, "run.completed", { usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }, null));
  return out;
};

const taskNodes = (): readonly string[] =>
  spansFrom(journal())
    .filter((s) => s.name === "loom.task")
    .map((s) => String(s.attributes?.["node.id"] ?? ""));

test("TASKS COME OUT IN JOURNAL ORDER when every timestamp is identical", () => {
  // The property the trace renderer relies on. Causal order here is the order they were readied:
  // c_first, then b_second, then a_third — deliberately the reverse of their alphabetical order.
  assert.deepEqual(
    taskNodes(),
    ["c_first", "b_second", "a_third"],
    "a tie on startTime must fall back to the order the journal already established",
  );
});

test("THE ORDER IS STABLE ACROSS FOLDS — determinism is not traded for it", () => {
  // `spansFrom` opens by claiming two folds of one journal are byte-identical. A tie-break that
  // depended on Map iteration or insertion of a mutable structure would break that quietly.
  assert.deepEqual(taskNodes(), taskNodes());
  assert.deepEqual(JSON.stringify(spansFrom(journal())), JSON.stringify(spansFrom(journal())));
});

test("A REAL TIMESTAMP DIFFERENCE STILL WINS — the tie-break is only a tie-break", () => {
  // The control. If the ordinal replaced `startTime` rather than following it, a span that
  // genuinely started later would sort by when it was first SEEN, and a waterfall would be wrong
  // in a new way. Here `late` is readied first and starts a full second afterwards.
  const t = (n: string) => `${n}@root#0` as TaskId;
  const bump = (e: JournalEvent, ts: number) => ({ ...e, ts }) as JournalEvent;
  const evs: JournalEvent[] = [
    ev(1, "run.submitted", { graphHash: "sha256:x", configDigest: "sha256:y" }, null),
    ev(2, "run.started", {}, null),
    bump(ev(3, "task.ready", { nodeId: "late", branchPath: "root", edgesIn: [] }, t("late")), TS + 1000),
    bump(ev(4, "task.committed", { take: [], status: "succeeded", writes: {} }, t("late")), TS + 1000),
    ev(5, "task.ready", { nodeId: "early", branchPath: "root", edgesIn: [] }, t("early")),
    ev(6, "task.committed", { take: [], status: "succeeded", writes: {} }, t("early")),
    ev(7, "run.completed", { usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }, null),
  ];
  const got = spansFrom(evs)
    .filter((s) => s.name === "loom.task")
    .map((s) => String(s.attributes?.["node.id"] ?? ""));
  assert.deepEqual(got, ["early", "late"], "startTime must still decide when it actually differs");
});

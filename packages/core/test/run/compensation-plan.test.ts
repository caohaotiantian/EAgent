/**
 * THE ROLLBACK DECISION, WITHOUT LETTING IT ACT.
 *
 * `compensation-fires.test.ts` drives a real run and judges the world afterwards. This judges the
 * branches that run cannot reach — a registry that changed under a committed run, a rewind
 * boundary, a second rollback pass over a journal that already carries records — and it judges
 * them on a pure function, which is why `planCompensation` is one. A decision you can only
 * observe by letting it undo something is not one anybody will trust with an undo.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { JournalEvent } from "../../src/journal/events.ts";
import { BLOCK_REASON, attemptable, planCompensation, type CompensationLookup } from "../../src/run/compensation.ts";

let seq = 0;
function ev(type: string, payload: unknown, extra: Record<string, unknown> = {}): JournalEvent {
  seq += 1;
  return {
    runId: "run_1",
    seq,
    ts: 1_700_000_000_000,
    type,
    payload,
    actor: { kind: "system", component: "tool-executor" },
    classification: "internal",
    ...extra,
  } as unknown as JournalEvent;
}

/** A `tool.called` as `#invokeTool` writes one. Only the fields the planner reads matter. */
function called(
  name: string,
  over: { irreversibility?: string; ok?: boolean; task?: string } = {},
): JournalEvent {
  const task = over.task ?? "n@root#0";
  return ev(
    "tool.called",
    {
      key: `${task}:tool:0`,
      name,
      version: "1.0",
      irreversibility: over.irreversibility ?? "reversible_write",
      idempotent: true,
      ok: over.ok ?? true,
      ms: 1,
      argsShape: "{}",
      argsDigest: "sha256:x",
    },
    { taskId: task },
  );
}

/** `db.insert` undoes to `db.delete`; `note.append` undoes to nothing; `gone.tool` is unregistered. */
const TOOLS: CompensationLookup = {
  get: (name) =>
    ({
      "db.insert": { compensation: { tool: "db.delete" } },
      "db.delete": {},
      "note.append": {},
      "orphan.write": { compensation: { tool: "never.registered" } },
    })[name],
};

function plan(events: JournalEvent[], sinceSeq?: number): ReturnType<typeof planCompensation> {
  return planCompensation({ events, tools: TOOLS, ...(sinceSeq === undefined ? {} : { sinceSeq }) });
}

test("ORDER IS REVERSE-SEQ, AND SEQ IS THE ONLY TOTAL ORDER THE JOURNAL HAS", () => {
  seq = 0;
  // Two branches interleaved, which is the case branch-major ordering gets wrong. `a` and `b`
  // ran concurrently; the journal is the only record of which write landed first, so the
  // rollback unwinds them interleaved rather than pretending they were sequential.
  const p = plan([
    called("db.insert", { task: "w@a#0" }),
    called("db.insert", { task: "w@b#0" }),
    called("db.insert", { task: "w@a#1" }),
  ]);
  assert.deepEqual(
    p.steps.map((s) => s.taskId),
    ["w@a#1", "w@b#0", "w@a#0"],
    "last appended, first undone — across branches, not within them",
  );
});

test("READ-ONLY IS NOT A CANDIDATE; A FAILED CALL STILL IS", () => {
  seq = 0;
  const p = plan([
    called("db.insert", { irreversibility: "read_only" }),
    called("db.insert", { ok: false }),
  ]);
  // A read changed nothing, so saying nothing about it is honest rather than a gap — and a plan
  // that emitted a row per `fs.read` would bury the rows that matter.
  assert.equal(p.steps.length, 1, "the read_only call is not in the plan at all");
  // `ok: false` means the tool RETURNED an error — its body ran to completion and may have acted
  // partway. A body that threw gets `effect.failed` and no `tool.called` at all, so this is not
  // that case. Leaving a possible effect standing is the loosening; a redundant undo is not.
  assert.equal(p.steps[0]!.ok, false, "and the failed one is still planned");
  assert.equal(p.steps[0]!.undo, "db.delete");
});

test("THREE BLOCKS, THREE REASONS — `not_attempted` that cannot say why is `failed` with manners", () => {
  seq = 0;
  const p = plan([
    called("note.append"), // registered, declares no undo
    called("orphan.write"), // declares an undo that is not registered
    called("gone.tool"), // not in the registry at all
  ]);
  assert.deepEqual(
    p.steps.map((s) => [s.tool, s.blocked]),
    [
      ["gone.tool", "unknown_tool"],
      ["orphan.write", "unknown_compensation"],
      ["note.append", "no_compensation"],
    ],
    "each blocked for its own reason, in rollback order",
  );
  assert.deepEqual(attemptable(p), [], "and none of them will dispatch anything");

  // The reasons must be distinguishable prose, not one string three times: "the author forgot an
  // undo" and "the deployment dropped the tool" are different problems for whoever reads the run.
  const said = p.steps.map((s) => BLOCK_REASON[s.blocked!](s));
  assert.equal(new Set(said).size, 3, "three distinct reasons");
  assert.match(said[0]!, /no longer a registered tool/);
  assert.match(said[1]!, /not a registered tool/);
  assert.match(said[2]!, /declares no compensation/);
});

test("`sinceSeq` SCOPES THE ROLLBACK TO WHAT A REWIND WOULD ACTUALLY SUPPRESS", () => {
  seq = 0;
  const events = [called("db.insert"), called("db.insert"), called("db.insert")];
  // Same reason `Engine.rewind`'s refusal is scoped to `atSeq`: only effects the operation would
  // undo are its business. Rewinding to seq 2 leaves seqs 1 and 2 standing.
  assert.deepEqual(plan(events, 2).steps.map((s) => s.seq), [3], "only what lands after the boundary");
  assert.deepEqual(plan(events).steps.map((s) => s.seq), [3, 2, 1], "and omitting it means the whole run");
});

test("A SETTLED CALL IS NOT RE-PLANNED — AND THE IDENTITY IS THE SEQ, NOT THE EFFECT KEY", () => {
  seq = 0;
  const first = called("db.insert");
  const second = called("db.insert");
  const record = ev("compensation.recorded", {
    compensates: (first.payload as { key: string }).key,
    compensatesSeq: first.seq,
    tool: "db.insert",
    undo: "db.delete",
    outcome: "compensated",
    trigger: "run_failed",
  });
  const p = plan([first, second, record]);
  assert.deepEqual(p.settled, [first.seq], "the journal, not a flag, is what remembers");
  assert.deepEqual(p.steps.map((s) => s.seq), [second.seq], "and the settled one is dropped rather than repeated");

  // THE KEY WOULD HAVE BEEN WRONG. Both calls above sit at the SAME effect key — the key is
  // positional (`taskId:tool:<ordinal>`) and a rewind-then-redo reuses it. A `settled` fold keyed
  // on it would treat the redo's fresh write as already rolled back, which is the exact failure
  // this feature exists to prevent: a rollback that looks done.
  assert.equal(
    (first.payload as { key: string }).key,
    (second.payload as { key: string }).key,
    "the fixture's two calls really do share a key, or the claim above is untested",
  );
});

test("A `not_attempted` RECORD SETTLES TOO — refusing once is a decision, not a retry loop", () => {
  seq = 0;
  const call = called("note.append");
  const p = plan([
    call,
    ev("compensation.recorded", {
      compensates: (call.payload as { key: string }).key,
      compensatesSeq: call.seq,
      tool: "note.append",
      outcome: "not_attempted",
      reason: "declares no compensation",
      trigger: "run_failed",
    }),
  ]);
  // Otherwise every later pass would re-append the same "nothing can undo this" row forever, and
  // the operator's evidence would be buried under repetitions of it.
  assert.deepEqual(p.steps, [], "a decided step stays decided, whatever it was decided to be");
});

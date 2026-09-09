/**
 * EVERY EVENT TYPE IS EITHER CONSTRAINED BY AN AUDIT RULE OR EXCUSED IN WRITING.
 *
 * `auditRun` shipped with eight rules, and two of them were built on event types nothing in
 * `src/` ever appends — permanently inert, and reported as `checked` on every terminal run. The
 * information that would have caught that at birth was already in this repo: `docs-drift.test.ts`
 * pins those types in a never-appended registry. Nothing connected the two.
 *
 * This is that connection, and it is the half that makes the rule set stick. The vocabulary MOVES
 * — 51 types today, and it has moved in both directions — and without a gate the rules silently
 * cover a smaller and smaller fraction of it while the report keeps saying `ok`. That is the same
 * decay `check-surface.mjs` exists to stop for the public API, and it made this repo pay the same
 * bill once already.
 *
 * The excuse list is deliberately uncomfortable to write. An entry saying "todo" is a promise
 * somebody has to keep; an entry saying "no relation" is a claim that can be argued with. Both
 * are better than an event type nobody has looked at.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AUDIT_RULES } from "../../src/journal/audit.ts";
import { EVENT_TYPES } from "../../src/journal/events.ts";

const AUDIT_SRC = readFileSync(fileURLToPath(new URL("../../src/journal/audit.ts", import.meta.url)), "utf8");

/**
 * What the auditor actually branches on, read from the SOURCE rather than declared beside it.
 *
 * A hand-maintained "these are the types my rules read" list is a second copy that drifts from
 * the switch statement the moment somebody edits one and not the other — which is the failure
 * this whole file exists to prevent, so it must not be the mechanism.
 */
function constrainedTypes(): Set<string> {
  const out = new Set<string>();
  for (const m of AUDIT_SRC.matchAll(/case "([a-z_]+\.[a-z_]+)"/g)) out.add(m[1]!);
  for (const m of AUDIT_SRC.matchAll(/e\.type === "([a-z_]+\.[a-z_]+)"/g)) out.add(m[1]!);
  return out;
}

type Excuse =
  // `never-appended` WAS A MEMBER HERE and is deliberately not one now. Every declared type has an
  // appender (asserted as a rule over the empty set in `registries.test.ts`), so no row can
  // legitimately carry that kind — and a kind nothing can legitimately carry is a door left ajar
  // for the next member declared ahead of its writer. Re-adding it is the thing to argue in a
  // commit message.
  /** Read by the auditor, but not through a branch of its own. */
  | "indirect"
  /** There is no relation to check: the event constrains nothing another event must satisfy. */
  | "no-relation"
  /** There IS a relation and no rule for it yet. This list must not grow. */
  | "todo";

const EXCUSED: Readonly<Record<string, { readonly kind: Excuse; readonly why: string }>> = {
  // ── nothing writes these: NONE, and the category is gone ────────────────────
  //
  // THE PEAK WAS SEVEN — counted, not remembered: at `d113c2a` this list held `budget.reserved`,
  // `budget.settled`, `channel.written`, `config.reloaded`, `task.cancelled`, `task.skipped` and
  // `task.started`. All seven have left, by exactly TWO doors, which is the whole lesson: an
  // excuse ends when the member gains a WRITER, or when the member goes.
  //
  //   - GAINED A WRITER, AND SO GAINED A RULE — `task.cancelled` (E6), `budget.reserved` and
  //     `budget.settled` (the reservation wiring), `task.skipped` (`Engine.#skippedByJoin`, which
  //     appends it from both of `#commit`'s terminal-failure exits). Each left BY BEING
  //     CONSTRAINED: `constrainedTypes()` finds it, so an excuse would now fail the "excused AND
  //     constrained" assertion below. Each also cost a rule —
  //     `task.cancelled-not-after-commit`, `budget.reservation-is-settled`,
  //     `task.skipped-follows-a-failed-commit` — because the `todo` ratchet was AT its cap of five
  //     every time and would not let one be deferred. Three rules rather than three excuses; that
  //     is what the ratchet is for.
  //   - DELETED — `config.reloaded`, `channel.written` and `task.started`. Nothing referred to the
  //     first and no reload path was planned; the second's authoritative value always rode
  //     `task.committed.writes`; the third named a moment `task.leased` already records, and while
  //     it stood a concurrency test filtered for it and compared 0 to 0. Rows in a closed
  //     vocabulary promising a fact nobody records — `journal/events.ts` says a row's test is a
  //     WRITER, not a design.
  //
  // So `EVERY DECLARED EVENT TYPE HAS AN APPENDER` is now a rule over the empty set in
  // `registries.test.ts`, and the `never-appended` excuse KIND is gone from the union above: a
  // kind no row can legitimately carry is a door left ajar. An excuse that a rule set can hold
  // forever is what this file exists to make uncomfortable.

  // ── read, but not through a branch of its own ───────────────────────────────
  "checkpoint.restored": {
    kind: "indirect",
    why: "consumed by `suppressedRanges`, which decides what the auditor can see at all — the strongest constraint here, and it applies before any rule runs",
  },

  // ── genuinely nothing to relate ─────────────────────────────────────────────
  "run.compiled": { kind: "no-relation", why: "carries the graph hash; that binding is checked by replay and by #assertBound, not by a sequence relation" },
  // `run.suspended` AND `run.resumed` BOTH LEFT THIS LIST, and both excuses were true about
  // the wrong half. "A suspend/resume pair is a lifecycle nicety, not an obligation — a run
  // may end suspended" is still true, and so is "a resume with no prior suspend is legal: a
  // fresh process attaching a live run appends one". Neither is the relation that was there
  // to check. The gate broker's rows (`reason: "gate"`, `by: "gate"`) really are
  // unconstrained — several may ride one wave, and none of them touches `p.paused`. THE
  // OPERATOR's rows are not: `projection.ts` sets `p.paused` on `run.suspended{reason:
  // "operator"}` and clears it only on `run.resumed{by:"operator"}`, and `Engine.pause` and
  // `Engine.resume` are both guarded on that flag, so the two ALTERNATE by construction.
  // Falsified by producing a journal with two operator suspensions and no resume between —
  // two Engines over one store, `Promise.allSettled` over two pauses, both fulfilled — which
  // every rule in this file called fine. `run.operator-pause-alternates` constrains the
  // operator half now, and the gate half is still excused by being outside it.
  // `run.failed` and `run.cancelled` LEFT THIS LIST, and what they said while they were on it
  // was false. The entry read "a terminal marker; the auditor reads its ABSENCE (via
  // run.completed) to decide whether `eventually` rules apply" — i.e. there is no relation to
  // check. There is: a run reaches a terminal state ONCE, and nothing that moves it may follow.
  // Falsified by producing a journal with two `run.failed` rows in it — two planes over one
  // SQLite file, `Promise.allSettled` over two decisions on one gate — which `loom audit`
  // called `ok`, exit 0. `run.terminal-is-last-and-once` constrains all three terminals now.
  "task.retry_scheduled": { kind: "no-relation", why: "advisory: the lease that follows is what actually re-runs the task" },
  "task.progress": { kind: "no-relation", why: "free-form progress text from a tool; constrains nothing" },
  "action.pending": { kind: "no-relation", why: "an intervention-window marker; the hold either elapses or is interrupted, and both are legal" },
  "budget.exhausted": { kind: "no-relation", why: "a terminal budget fact; what follows it is the run's own failure path" },
  "checkpoint.created": { kind: "no-relation", why: "a marker a rewind may or may not ever target; an unused checkpoint is not a defect" },
  "operator.command": { kind: "no-relation", why: "an audit trail of what a human asked for; the effect of each command is constrained by its own events" },
  "gate.delivered": { kind: "no-relation", why: "delivery is best-effort by design — a gate with no successful delivery still stands and still expires" },
  "gate.delivery_failed": { kind: "no-relation", why: "the same: a failed channel never auto-approves, and the ConsoleChannel fallback cannot fail" },
  "gate.callback_rejected": { kind: "no-relation", why: "a refusal of an inbound callback; by construction it changed nothing, which is the point of recording it" },
  "gate.claimed": { kind: "no-relation", why: "a soft lock that grants nothing and blocks nothing; it expires by being ignored" },
  "gate.reminded": { kind: "no-relation", why: "a nudge that resets no clock and no tier; the fold counts rows and that is its whole contract" },

  // ── deserves a rule, and does not have one ──────────────────────────────────
  "run.started": { kind: "todo", why: "must follow run.submitted and precede any task event" },
  "task.ready": { kind: "todo", why: "a task must be ready before it is leased, and leased before it commits" },
  "fanout.planned": { kind: "todo", why: "the planned width should bound the branch coordinates that actually appear" },
  "gate.escalated": { kind: "todo", why: "tiers should be non-decreasing per gate, and bounded by the declared escalation chain" },
  "graph.mutated": { kind: "todo", why: "an added edge should be the only kind a later take may name that the compiled graph does not" },
};

test("EVERY EVENT TYPE IS CONSTRAINED OR EXCUSED — and nothing is both", () => {
  const constrained = constrainedTypes();
  const universe = new Set<string>(EVENT_TYPES);

  // The scanner must not have broken: if it finds nothing, every type looks unconstrained and
  // the excuse list would have to grow to 51 to keep this green — a failure that reads like work.
  assert.ok(constrained.size >= 8, `the source scan found only ${constrained.size} branches — the regex broke, not the rules`);

  const unexcused = [...universe].filter((t) => !constrained.has(t) && EXCUSED[t] === undefined).sort();
  assert.deepEqual(
    unexcused,
    [],
    "a new event type appeared with no audit rule and no written excuse — constrain it in src/journal/audit.ts, or say here why there is nothing to constrain",
  );

  const both = [...constrained].filter((t) => EXCUSED[t] !== undefined).sort();
  assert.deepEqual(both, [], "these are excused AND constrained — delete the excuse, the rule covers them now");

  const stale = Object.keys(EXCUSED).filter((t) => !universe.has(t)).sort();
  assert.deepEqual(stale, [], "these excuse an event type that no longer exists — the vocabulary moved under this list");

  const constrainedInUniverse = [...constrained].filter((t) => universe.has(t));
  assert.equal(
    constrainedInUniverse.length + Object.keys(EXCUSED).length,
    universe.size,
    "every type is accounted for exactly once",
  );
});

test("every excuse says something", () => {
  for (const [type, e] of Object.entries(EXCUSED)) {
    assert.ok(e.why.length > 30, `${type}: an excuse under 30 characters is a shrug, not a reason`);
  }
  // THE CROSS-REGISTRY DRIFT CHECK WENT WITH ITS SUBJECT. It parsed `registries.test.ts``s
  // `NEVER_APPENDED` block and asserted that anything excused HERE as never-appended was pinned
  // THERE too, so the two could not disagree about who has a writer. That list is now empty and
  // gone — every declared type has an appender, asserted there as a rule over the empty set — so
  // the parse had nothing left to read and would have reported green over an absent block, which
  // is the shape this whole file exists to refuse. The `never-appended` excuse KIND is gone from
  // the union above for the same reason: a kind no row can legitimately carry is a door left ajar.
  assert.ok(Object.keys(EXCUSED).length > 0, "an empty excuse list would make the assertions above vacuous");
});

test("THE `todo` LIST MUST NOT GROW", () => {
  // A floor, not an equality: writing a rule and deleting its todo is ordinary work and should
  // not cost a test edit. Adding a todo is how a rule set decays quietly, and that has to fail.
  const todos = Object.entries(EXCUSED).filter(([, e]) => e.kind === "todo").length;
  assert.ok(todos <= 5, `${todos} event types are marked todo; it was 15 when this gate was written, 5 now, and may only shrink`);
  assert.ok(AUDIT_RULES.length >= 19, `${AUDIT_RULES.length} rules; deleting one needs a reason in the journal, not a quiet edit`);
});

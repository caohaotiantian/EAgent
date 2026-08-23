/**
 * A CLAIM ABOUT EVERY MEMBER OF A REGISTRY IS VACUOUS IF THE REGISTRY IS EMPTY.
 *
 * The suite makes a lot of "every X" claims by iterating a table exported from `src/`:
 *
 *     for (const rule of Object.values(ESCALATION_RULES)) assert.ok(postureRank(rule.to) > …)
 *     for (const [key, value] of Object.entries(CODES)) assert.equal(key, value)
 *
 * Each of those passes if the table it iterates is empty. That is not a hypothetical failure —
 * this repo has already shipped the same shape twice and found it both times by mutation: an
 * "every real flag is accepted" test that iterated the list under test, so removing an entry
 * also removed it from the loop; and `audit-coverage.test.ts`'s source scan, which carries
 * `assert.ok(constrained.size >= 8, "the regex broke, not the rules")` for exactly this reason.
 *
 * Three such loops had no floor. Rather than repeat one in each — and in every "every X" test
 * written later — the floors live here, once, over the tables those claims are made about. A
 * scan looking for `.length >=` in each test would be a heuristic; this is a fact.
 *
 * **The numbers are floors, not counts.** Growth is ordinary and must not cost a test edit;
 * collapse is the failure. Each is set below today's size on purpose.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { AUDIT_RULES } from "../src/journal/audit.ts";
import { CODES } from "../src/errors.ts";
import { EVENT_TYPES } from "../src/journal/events.ts";
import { ESCALATION_RULES } from "../src/run/escalation.ts";
import { HOOK_POINTS } from "../src/run/hooks.ts";
import { CLASS_DEFAULT_POSTURE, CLASSIFICATION_POSTURE_FLOOR } from "../src/vocab.ts";

/** Every table an "every member…" claim in this suite iterates, and the floor under it. */
const REGISTRIES: readonly (readonly [string, number, Record<string, unknown> | readonly unknown[]])[] = [
  ["CODES", 50, CODES],
  ["EVENT_TYPES", 45, EVENT_TYPES],
  ["ESCALATION_RULES", 8, ESCALATION_RULES],
  ["AUDIT_RULES", 15, AUDIT_RULES],
  ["HOOK_POINTS", 8, HOOK_POINTS],
  ["CLASS_DEFAULT_POSTURE", 4, CLASS_DEFAULT_POSTURE],
  ["CLASSIFICATION_POSTURE_FLOOR", 4, CLASSIFICATION_POSTURE_FLOOR],
];

const sizeOf = (v: Record<string, unknown> | readonly unknown[]): number =>
  Array.isArray(v) ? v.length : v instanceof Set ? v.size : Object.keys(v).length;

/**
 * THE comparison, named so the self-test below exercises the real one.
 *
 * It was written inline first, and the self-test asserted an inline COPY of it — so inverting
 * the real comparison to `n >= 0` left the gate green. Asserting a restatement of the logic is
 * not asserting the logic, which is the same trap this whole file is about one level up.
 */
function belowFloor(table: Record<string, unknown> | readonly unknown[], floor: number): boolean {
  return sizeOf(table) < floor;
}

test("EVERY REGISTRY AN \"EVERY X\" CLAIM ITERATES IS NON-EMPTY", () => {
  for (const [name, floor, table] of REGISTRIES) {
    assert.equal(
      belowFloor(table, floor),
      false,
      `${name} holds ${sizeOf(table)} entries, below its floor of ${floor} — every test that ` +
        `iterates it is now making a claim about nothing, and each would still pass`,
    );
  }
});

test("the floors are floors, and the assertion can fail", () => {
  // A gate whose comparison is inverted, or whose list is empty, reports success forever.
  assert.ok(REGISTRIES.length >= 7, "the registry list itself shrank");
  for (const [name, floor] of REGISTRIES) assert.ok(floor > 0, `${name} has a floor of ${floor}, which asserts nothing`);

  // And THE comparison discriminates — the real one, not a copy of it.
  assert.equal(belowFloor({}, 1), true, "an empty table must be below any positive floor");
  assert.equal(belowFloor([], 1), true, "and an empty array too");
  assert.equal(belowFloor({ a: 1, b: 2 }, 2), false, "a table at its floor is not below it");
  assert.equal(belowFloor({ a: 1 }, 2), true, "one short is below it");
});

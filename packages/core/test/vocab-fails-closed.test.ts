/**
 * The oversight vocabularies must not resolve an unreadable member to the weakest one.
 *
 * `Posture`, `Classification` and `IrreversibilityClass` are unions of string literals, and
 * TypeScript erases all three. A graph is JSON, a journal event is JSON, a de-escalation
 * arrives over HTTP and a tool manifest is registered at run time, so every value reaching
 * these functions has been cast and never checked. The folds read them through a rank table,
 * a miss came back `undefined`, and every comparison against `undefined` is false — so a miss
 * lost every comparison it entered and the fold kept its identity, which for `max` is the
 * WEAKEST member. Measured before the fix, one call each:
 *
 *     maxPosture("strict")           → "out"       nobody watching
 *     maxPosture("out", "strict")    → "out"
 *     isLoosening("in", "IN")        → false       said the loosening guard
 *     maxClassification("SECRET")    → "public"    redacts nothing
 *
 * EVERY TEST HERE HAS ITS CONTROL, because a vocabulary that answers `in` to everything is not
 * a vocabulary — it is a broken one that happens to look safe, and it would refuse every graph
 * in the tree.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CLASSIFICATION_POSTURE_FLOOR,
  CLASS_DEFAULT_POSTURE,
  POSTURES,
  isLoosening,
  isPosture,
  maxClassification,
  maxPosture,
  postureRank,
} from "../src/vocab.ts";

test("the vocabulary still works for its real members — the control", () => {
  assert.deepEqual([...POSTURES], ["out", "on", "in"]);
  assert.equal(maxPosture(), "out", "the empty fold is the identity, and callers rely on it");
  assert.equal(maxPosture("in"), "in");
  assert.equal(maxPosture("out", "on"), "on");
  assert.equal(maxPosture("on", "in"), "in");
  assert.equal(maxPosture("in", "out"), "in");
  assert.equal(isLoosening("in", "out"), true);
  assert.equal(isLoosening("out", "in"), false);
  assert.equal(maxClassification("public", "pii"), "pii");
  assert.equal(maxClassification(), "public");
  for (const p of POSTURES) assert.ok(isPosture(p), `${p} is a posture`);
});

test("AN UNREADABLE POSTURE RANKS AT `in`, THE STRONGEST — never at `out`", () => {
  assert.equal(maxPosture("strict" as never), "in");
  assert.equal(maxPosture("IN" as never), "in", "the vocabulary is case-sensitive, and a near miss is still a miss");
  // The one that decides whether a human sees the action: a typo beside a real declaration must
  // not lower it, and a typo alone must not read as `out`.
  assert.equal(maxPosture("in", "strict" as never), "in");
  assert.equal(maxPosture("out", "strict" as never), "in", "a typo used to leave the floor at `out`");
  assert.equal(postureRank("strict" as never), postureRank("in"));
  for (const bad of [undefined, null, "", "On", " in", 2, {}, []]) {
    assert.equal(isPosture(bad), false, `${JSON.stringify(bad)} is not a posture`);
    assert.equal(maxPosture(bad as never), "in", `${JSON.stringify(bad)} must floor at in`);
  }
});

test("A LOOSENING GUARD THAT CANNOT READ ITS ARGUMENT REPORTS A LOOSENING", () => {
  // The two arguments play opposite roles, so no single rank for a non-member is fail-closed
  // for both: rank it low and a bad baseline hides a real loosening, rank it high and a bad
  // candidate walks past. A guard that cannot decide fails closed.
  assert.equal(isLoosening("in", "IN" as never), true);
  assert.equal(isLoosening("STRICT" as never, "in"), true);
  assert.equal(isLoosening("out", "nonsense" as never), true);
});

test("THE OTHER TWO VOCABULARIES GET THE SAME ANSWER THROUGH THE SAME FOLD", () => {
  // `CLASS_DEFAULT_POSTURE` and `CLASSIFICATION_POSTURE_FLOOR` are plain tables: a tool
  // manifest declaring `irreversibility: "nuclear"` or a channel declaring
  // `classification: "SECRET"` reads `undefined` out of them. Every such lookup in this tree
  // is an argument to `maxPosture` (run/policy.ts, graph/compile.ts, graph/spec.ts), so the
  // fold is where they stop being free — without those call sites changing.
  assert.equal(CLASS_DEFAULT_POSTURE["nuclear" as never], undefined);
  assert.equal(maxPosture(CLASS_DEFAULT_POSTURE["nuclear" as never]), "in");
  assert.equal(maxPosture(CLASSIFICATION_POSTURE_FLOOR["SECRET" as never]), "in");
  // Control: the real classes still contribute what they always did.
  assert.equal(maxPosture(CLASS_DEFAULT_POSTURE.read_only), "out");
  assert.equal(maxPosture(CLASS_DEFAULT_POSTURE.irreversible), "in");
  assert.equal(maxPosture(CLASSIFICATION_POSTURE_FLOOR.pii), "on");

  // And the classification fold itself, which decides how much `redact()` removes.
  assert.equal(maxClassification("SECRET" as never), "secret_ref");
  assert.equal(maxClassification("public", "Secret_Ref" as never), "secret_ref");
});

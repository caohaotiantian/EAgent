/**
 * Tests for the shared lexical scorer extracted from handoff into
 * `src/extensions/lib/relevance.ts`. `salientTokens` parity is covered by
 * `test/handoff.test.ts` (re-exported); this file pins the new `overlapScore`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { overlapScore, salientTokens } from "../src/extensions/lib/relevance.ts";

test("overlapScore counts shared salient tokens", () => {
  // "login" and "auth" overlap; "fix"/"debug"/"flow" do not.
  assert.equal(overlapScore("fix the login auth", "debug the auth login flow"), 2);
});

test("overlapScore drops stopwords and short tokens before counting", () => {
  // Only "the" (stopword) and "of" (< 3 chars) are shared — both dropped → 0.
  assert.equal(overlapScore("the cat of x", "the dog of y"), 0);
});

test("overlapScore is zero when no salient tokens are shared", () => {
  assert.equal(overlapScore("database migration", "login auth refactor"), 0);
});

test("salientTokens is re-exported from the shared lib", () => {
  const toks = salientTokens("Fix the Login-bug");
  assert.ok(toks.has("fix"));
  assert.ok(toks.has("login"));
  assert.ok(!toks.has("the"), "stopword dropped");
});

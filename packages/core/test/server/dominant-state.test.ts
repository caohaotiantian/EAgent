/**
 * A.52 — `dominantState` used to rank only seven of `TaskState`'s nine members.
 *
 * `STATE_PRIORITY` (`server/layout.ts`) was `["failed", "awaiting_gate", "leased", "ready",
 * "cancelled", "skipped", "succeeded"]` while `run/projection.ts`'s `TaskState` union has nine
 * members — `pending` and `retrying` were on neither list, so `dominantState` fell through to
 * `states[0] ?? ""` for them. That fallback saves the HOMOGENEOUS case (a fan-out entirely
 * `retrying` still shows `retrying`), which is why the bug reads as "priority", not "absence":
 * a fan-out with 23 succeeded branches and one retrying rendered `succeeded` whenever
 * `retrying` did not happen to be `states[0]`.
 *
 * This file pins the row's three cases directly, plus the two structural properties that keep
 * a tenth `TaskState` (or a re-ordering that drops one of the nine) from compiling silently:
 * `STATE_RANK` is a `Record<TaskState, number>`, so TypeScript itself refuses a missing or
 * unknown key — checked here by exercising every member, not by re-typing the type.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { dominantState } from "../../src/server/layout.ts";
import type { TaskState } from "../../src/run/projection.ts";

// Named rather than re-derived from the union (TypeScript unions have no runtime form) —
// the point of this list is that it is spelled out by a human and can be checked against.
const ALL_NINE: readonly TaskState[] = [
  "pending",
  "ready",
  "leased",
  "awaiting_gate",
  "retrying",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
];

test("A.52 — only retrying renders retrying (the states[0] fallback already saved this case)", () => {
  assert.equal(dominantState(["retrying"]), "retrying");
});

test("A.52 — 23 succeeded + 1 retrying renders retrying, not succeeded", () => {
  const states: TaskState[] = [...Array(23).fill("succeeded" as TaskState), "retrying"];
  assert.equal(dominantState(states), "retrying");
});

test("A.52 — pending + succeeded renders pending, not succeeded", () => {
  assert.equal(dominantState(["pending", "succeeded"]), "pending");
});

test("A.52 — retrying and pending both outrank every terminal state they can appear beside", () => {
  // Not just succeeded: a fan-out that is still unfinished must not be reported as any of the
  // three terminal-but-not-succeeded readings either.
  for (const terminal of ["succeeded", "skipped", "cancelled"] as const) {
    assert.equal(dominantState(["retrying", terminal]), "retrying", `retrying vs ${terminal}`);
    assert.equal(dominantState(["pending", terminal]), "pending", `pending vs ${terminal}`);
  }
});

test("A.52 — failed and awaiting_gate still outrank retrying and pending", () => {
  // The fix must not have overcorrected: retrying/pending are "unfinished", not "worse than a
  // state that needs a human or already failed".
  assert.equal(dominantState(["retrying", "failed"]), "failed");
  assert.equal(dominantState(["pending", "failed"]), "failed");
  assert.equal(dominantState(["retrying", "awaiting_gate"]), "awaiting_gate");
  assert.equal(dominantState(["pending", "awaiting_gate"]), "awaiting_gate");
});

test("A.52 — every one of the nine TaskState members has a rank; dominantState never falls to the [0]?? fallback for a mixed set", () => {
  // If any member of ALL_NINE were unranked, mixing it with "succeeded" would fall through to
  // states[0] and this equality would depend on array order — this checks it does not, in
  // BOTH orders, for every member.
  for (const s of ALL_NINE) {
    if (s === "succeeded") continue;
    assert.equal(dominantState([s, "succeeded"]), s, `${s} must outrank succeeded regardless of order`);
    assert.equal(dominantState(["succeeded", s]), s, `${s} must outrank succeeded regardless of order`);
  }
});

test("A.52 — STATE_PRIORITY (read from source) names exactly the nine TaskState members, once each", () => {
  // `dominantState` doesn't export its priority list, so this reads the source text the way
  // console.test.ts's drift census already does for the SAME array, rather than adding a
  // second export purely for a test (which would move scripts/surface.json's pinned count).
  const src = readFileSync(new URL("../../src/server/layout.ts", import.meta.url), "utf8");
  const match = /const STATE_RANK: Record<TaskState, number> = \{([\s\S]*?)\};/.exec(src);
  assert.ok(match, "server/layout.ts no longer declares STATE_RANK in a shape this test can read");
  const ranked = [...match![1]!.matchAll(/(\w+):\s*\d+/g)].map((m) => m[1]!);
  assert.equal(ranked.length, 9, `expected 9 ranked states, found ${ranked.length}: ${ranked.join(",")}`);
  assert.deepEqual([...ranked].sort(), [...ALL_NINE].sort(), "STATE_RANK's keys must be exactly TaskState's nine members");
  assert.equal(new Set(ranked).size, 9, "no repeated key");
});

/**
 * ONE UNREADABLE NUMBER PERMANENTLY DISABLED THE BUDGET, AND THE DIMENSION WAS MONEY.
 *
 * Every ceiling in `PolicyEngine.reserve` is an inequality, and `NaN > limit` is FALSE. So a
 * single NaN entering `#spentUsd` or `#reservedUsd` did not fail one check — it made every
 * later dollar and token check pass for the rest of the run, which is `AgentOptions.budgetUsd`'s
 * "an agent loop with no ceiling is the classic incident" arriving through the guard itself.
 *
 * Two doors reach it, and both were open at `7eaa206` and at `dbe0528`:
 *
 *   1. `settle`. `costUsd` is typed `number` but is computed by an adapter from a remote
 *      party's JSON, so an `{"output_tokens":"abc"}` frame made it NaN. Measured — settle a
 *      NaN against a $1.00 budget, then `reserve($1000)`: RESERVED, `spentUsd = NaN`.
 *   2. `reserve` itself. A NaN `estimateUsd` poisons `#reservedUsd` with no settlement
 *      involved at all, and `remainingUsd` reads NaN from then on.
 *
 * A NEGATIVE is the same defect with its sign flipped — it CREDITS the budget — and it is not
 * hypothetical: the same malformed frame that produced NaN produces `-5` one character away.
 *
 * The rule this restores is the repo's: a guard that cannot decide fails CLOSED. A ledger that
 * cannot say what it holds refuses the next reservation instead of granting it, and a bill it
 * cannot read is charged at the worst case it had already reserved.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PolicyEngine } from "../../src/run/policy.ts";
import type { UsageRecord } from "../../src/vocab.ts";

const usage = (costUsd: number, over: Partial<UsageRecord> = {}): UsageRecord => ({
  inputTokens: 1,
  outputTokens: 1,
  costUsd,
  wallMs: 1,
  ...over,
});

const engine = (): PolicyEngine => new PolicyEngine({ granted: ["*"], budget: { runUsd: 1 } });

test("A BILL THAT IS NOT A NUMBER DOES NOT SWITCH THE CEILING OFF", () => {
  for (const bad of [Number("abc"), Number.POSITIVE_INFINITY, -5]) {
    const p = engine();
    p.settle(p.reserve("n", 0.001), usage(bad));
    assert.ok(
      Number.isFinite(p.spentUsd) && p.spentUsd >= 0,
      `costUsd ${String(bad)} left spentUsd = ${String(p.spentUsd)}`,
    );
    assert.throws(
      () => p.reserve("n", 1000),
      (e: unknown) => (e as { code?: string }).code === "E_BUDGET_EXHAUSTED",
      `$1000 against a $1.00 budget must be refused after a ${String(bad)} bill`,
    );
  }
});

test("...and it is charged the worst case it was already holding, not nothing", () => {
  // The reservation is released before the charge is applied, so THROWING here would leave the
  // call billed at zero — the loosest outcome available. The estimate is the defensible number:
  // it is what the run had already committed for this call.
  const p = engine();
  p.settle(p.reserve("n", 0.25), usage(Number("abc")));
  assert.equal(p.spentUsd, 0.25, "the worst case stands when the actual cannot be read");
  assert.equal(p.reservedUsd, 0, "and the hold is still released");
  assert.equal(p.remainingUsd, 0.75);
});

test("an unreadable TOKEN count is charged the same way, and an unreadable wallMs adds none", () => {
  const p = new PolicyEngine({ granted: ["*"], budget: { runUsd: 1, runTokens: 100 } });
  p.settle(p.reserve("n", 0.001, 40), usage(0.001, { outputTokens: Number("abc"), wallMs: Number("abc") }));
  assert.equal(p.spentTokens, 40, "the reserved worst case, because the bill was unreadable");
  assert.equal(p.spentWallMs, 0, "nothing reserves wall time, so there is no worst case to fall back to");
  assert.throws(
    () => p.reserve("n", 0.001, 100),
    (e: unknown) => (e as { code?: string }).code === "E_BUDGET_EXHAUSTED",
    "the token ceiling still binds",
  );
});

test("A RESERVATION IS THE OTHER DOOR — an estimate that is not a number is refused outright", () => {
  for (const bad of [Number("abc"), Number.POSITIVE_INFINITY, -5]) {
    const p = engine();
    assert.throws(
      () => p.reserve("n", bad),
      (e: unknown) => (e as { code?: string }).code === "E_BUDGET_EXHAUSTED",
      `reserve($${String(bad)}) must refuse`,
    );
    assert.equal(p.reservedUsd, 0, `and leave nothing behind — got ${String(p.reservedUsd)}`);
    assert.equal(p.remainingUsd, 1, `remainingUsd must still be readable — got ${String(p.remainingUsd)}`);
  }
  const p = engine();
  assert.throws(() => p.reserve("n", 0.001, Number("abc")), (e: unknown) => (e as { code?: string }).code === "E_BUDGET_EXHAUSTED");
  assert.equal(p.reservedUsd, 0, "a bad token estimate debits no dollars either — every throw precedes every mutation");
});

// ── the ordinary arms, which none of this may touch ──────────────────────────

test("the ORDINARY reserve/settle arithmetic is unchanged", () => {
  const p = engine();
  const r = p.reserve("n", 0.4, 30);
  assert.equal(p.reservedUsd, 0.4);
  assert.equal(p.remainingUsd, 0.6);
  p.settle(r, usage(0.25, { inputTokens: 5, outputTokens: 6, wallMs: 120 }));
  assert.equal(p.spentUsd, 0.25, "the bill, not the estimate");
  assert.equal(p.reservedUsd, 0, "and the hold comes back");
  assert.equal(p.spentTokens, 11);
  assert.equal(p.spentWallMs, 120);
  assert.equal(p.remainingUsd, 0.75);

  // A bare number is still dollars only, and settling twice is still a no-op.
  const r2 = p.reserve("n", 0.1);
  p.settle(r2, 0.05);
  p.settle(r2, 0.05);
  assert.equal(p.spentUsd, 0.3);

  // Zero is a legal bill — a failed call really did cost nothing.
  const r3 = p.reserve("n", 0.1);
  p.settle(r3, 0);
  assert.equal(p.spentUsd, 0.3);

  // And the ceiling still fires on ordinary arithmetic.
  assert.throws(() => p.reserve("n", 0.8), (e: unknown) => (e as { code?: string }).code === "E_BUDGET_EXHAUSTED");
});

test("...and an engine with NO budget still reserves freely", () => {
  const p = new PolicyEngine({ granted: ["*"] });
  const r = p.reserve("n", 1_000_000, 1_000_000);
  p.settle(r, usage(999));
  assert.equal(p.spentUsd, 999);
  assert.equal(p.remainingUsd, Number.POSITIVE_INFINITY, "no ceiling is not the same as a ceiling of zero");
  assert.throws(
    () => p.reserve("n", Number("abc")),
    (e: unknown) => (e as { code?: string }).code === "E_BUDGET_EXHAUSTED",
    "an unreadable estimate is refused even with no ceiling declared — it would poison the total",
  );
});

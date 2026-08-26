/**
 * What a PARTIALLY-POPULATED `interventionWindowMs` may answer.
 *
 * `policy.test.ts` covers who may lower a posture. This file covers the number that comes
 * back once someone has: `holdMs`, the interruption window `Engine` sleeps on and journals
 * verbatim as `action.pending`'s `windowMs`.
 *
 * The window is read through two steps that used to disagree about totality. `boundedWindows`
 * merged the supplied table over the defaults with a spread, which copies a key that is
 * PRESENT whatever it holds — so `{irreversible: undefined}` deleted a default instead of
 * leaving it alone. `windowFor` then folded the remaining hard windows with
 * `Math.max(0, ...hard)`, and `Math.max` is `NaN` if a single element is `undefined`. One
 * hole therefore poisoned every class that fell back, not only the class that was missing.
 * Measured before the fix, systemFloor `out`, one human de-escalation of the run scope to
 * `out`, `interventionWindowMs: {irreversible: undefined}`:
 *
 *     irreversible        allow  on  holdMs='NaN'   holds=false
 *     externally_visible  allow  on  holdMs='5000'  holds=true
 *     nuclear             allow  on  holdMs='NaN'   holds=false
 *
 * `NaN > 0` is false, and `Engine` journals `action.pending`, sleeps, and re-checks the abort
 * signal only inside that test (`run/engine.ts:2563`, `:4248`), so the action starts at once,
 * uninterruptible, with nothing in the journal to show a window was ever declared. That is the
 * fail-open the hard floor and the unreadable-class fallback were both written to close,
 * arriving through the table they read.
 *
 * The property these tests pin is not "the fallback is filtered" — that is an
 * implementation. It is: **no subset of a supplied table can make `holdMs` non-finite, and
 * no subset can drop a hard-to-undo class's window to zero.** The control at the bottom is
 * the other half: a table with no holes answers exactly what it did before.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { PolicyEngine } from "../../src/run/policy.ts";
import type { RunId, NodeId } from "../../src/ids.ts";
import type { Posture } from "../../src/vocab.ts";

const RUN = "01JRUNWINDOW00000000000000" as RunId;
const NODE = "n1" as NodeId;
const HUMAN = { kind: "human", id: "u:alice" } as const;

/** The four the vocabulary knows, plus two it does not. Both unreadable ones are hard-to-undo. */
const HARD = ["irreversible", "externally_visible", "nuclear", "IRREVERSIBLE"] as const;
const EASY = ["read_only", "reversible_write"] as const;

type Windows = Record<string, number | undefined>;

/**
 * `holdMs` for one class, at `on`.
 *
 * `on` is the only posture that reads a window — `in` gates instead and `out` has nobody
 * watching — so every case here has to get there. A hard-to-undo class computes to `in`, so
 * a human ceiling of `out` is needed to land it on `on` (the hard floor stops it at `on`);
 * an easy one needs `systemFloor: "on"` and no ceiling, since a ceiling would take it to `out`.
 */
function holdMsAt(windows: Windows, cls: string, systemFloor: Posture, ceiling?: Posture): number | undefined {
  const p = new PolicyEngine({
    granted: ["*"],
    systemFloor,
    interventionWindowMs: windows as Record<string, number>,
  });
  if (ceiling !== undefined) p.deescalate(`run:${RUN}`, ceiling, "operator is watching this one", HUMAN);
  const d = p.decide({
    runId: RUN,
    nodeId: NODE,
    kind: "tool",
    irreversibility: cls as "irreversible",
    capabilities: [],
    declaredPosture: "out",
  });
  assert.equal(d.effect, "allow", `${cls} did not reach an allow, so no window was read`);
  assert.equal(d.posture, "on", `${cls} is not at "on", which is the only posture that reads a window`);
  return d.effect === "allow" ? d.holdMs : undefined;
}

/** The reported case: hard classes, systemFloor `out`, one human de-escalation to `out`. */
const hardHold = (windows: Windows, cls: string) => holdMsAt(windows, cls, "out", "out");

// ── the reported table, re-measured ──────────────────────────────────────────

test("ONE undefined KEY CANNOT MAKE ANY CLASS'S WINDOW NaN", () => {
  // The exact input from the report. Every row was measured above; every row is a real
  // number now, and `holds` — which is what `decide` and `Engine` actually branch on — is
  // true for all three rather than for the one class that happened to keep its default.
  const windows: Windows = { irreversible: undefined };
  const measured = HARD.slice(0, 3).map((c) => [c, hardHold(windows, c)] as const);

  assert.deepEqual(measured, [
    ["irreversible", 5000],
    ["externally_visible", 5000],
    ["nuclear", 5000],
  ]);
  for (const [cls, ms] of measured) {
    assert.ok(Number.isFinite(ms), `${cls} answered ${String(ms)}, which is not a number a timer can hold`);
    assert.ok((ms ?? 0) > 0, `${cls} answered ${String(ms)}, so \`holdMs > 0\` is false and nothing holds`);
  }
});

test("a hole in the table does not delete the default it was merged over", () => {
  // The root of it: `{...DEFAULT_WINDOWS, ...supplied}` copied the key, so the stored table
  // had a hole and `irreversible` — a class the vocabulary reads perfectly well — fell back
  // at all. It should never reach the fallback: it has a default of its own.
  assert.equal(hardHold({ irreversible: undefined }, "irreversible"), 5000);
  assert.equal(hardHold({ externally_visible: undefined }, "externally_visible"), 5000);

  // And an easy class keeps ITS default, which is 0 — before the fix `{read_only: undefined}`
  // sent read_only through the hard-class fold and held a read for five seconds.
  assert.equal(holdMsAt({ read_only: undefined }, "read_only", "on"), 0);
  assert.equal(holdMsAt({ reversible_write: undefined }, "reversible_write", "on"), 0);
});

test("no subset of the table can make holdMs non-finite, or drop a hard window to zero", () => {
  // Every subset of the four known keys, blanked. 16 tables × 6 classes, two of which are
  // outside the union. A claim that names its members: this is all of them.
  const keys = [...EASY, ...HARD.slice(0, 2)];
  const violations: string[] = [];
  for (let mask = 0; mask < 1 << keys.length; mask++) {
    const windows: Windows = {};
    const blanked: string[] = [];
    keys.forEach((k, i) => {
      if (mask & (1 << i)) {
        windows[k] = undefined;
        blanked.push(k);
      }
    });
    const label = blanked.length === 0 ? "{}" : `{${blanked.join(", ")}: undefined}`;

    for (const cls of HARD) {
      const ms = hardHold(windows, cls);
      if (ms !== 5000) violations.push(`${label} → ${cls} answered ${String(ms)}, not the 5000 every hard class declares`);
    }
    for (const cls of EASY) {
      const ms = holdMsAt(windows, cls, "on");
      if (ms !== 0) violations.push(`${label} → ${cls} answered ${String(ms)}, a hold it never declared`);
    }
  }
  // EVERY violating pair, not the first. The two halves of this fix fail on different
  // subsets — a hole in an easy key on any subset that blanks one, an empty hard fold only
  // on the subset that blanks BOTH — and a bare `assert` inside the loop reports whichever
  // comes first and hides the other.
  assert.deepEqual(violations, [], `${violations.length} of ${1 << keys.length} tables answered wrongly`);
});

// ── the control: a table with no holes is untouched ──────────────────────────

test("CONTROL — a fully-populated table answers exactly what it answered before", () => {
  // Measured on the unfixed code, same three rows, and reproduced here unchanged. The fix
  // may only remove NaN; it may not move a number an operator chose. Note 7000 for
  // `nuclear`: the strictest window any hard class carries, NOT a constant — an operator who
  // widened `externally_visible` is not narrowed behind their back.
  const full: Windows = { read_only: 0, reversible_write: 0, irreversible: 1000, externally_visible: 7000 };
  assert.deepEqual(
    HARD.slice(0, 3).map((c) => [c, hardHold(full, c)] as const),
    [
      ["irreversible", 1000],
      ["externally_visible", 7000],
      ["nuclear", 7000],
    ],
  );
  assert.equal(holdMsAt(full, "read_only", "on"), 0);
  assert.equal(holdMsAt(full, "reversible_write", "on"), 0);

  // Defaults, supplied nothing at all — the other fully-populated table.
  assert.deepEqual(
    HARD.slice(0, 3).map((c) => [c, hardHold({}, c)] as const),
    [
      ["irreversible", 5000],
      ["externally_visible", 5000],
      ["nuclear", 5000],
    ],
  );

  // A deliberate 0 is still honoured. It is the operator's number, and refusing to hold is
  // what they asked for; only a hole picks up a window it did not declare.
  assert.equal(hardHold({ irreversible: 0, externally_visible: 0 }, "irreversible"), 0);

  // …and an explicit 0 on every hard class does NOT make an unreadable class fall to 0
  // through an empty fold: it folds over the numbers that ARE there, which are 0s.
  assert.equal(hardHold({ irreversible: 0, externally_visible: 0 }, "nuclear"), 0);
});

test("the refusal for an out-of-range window still fires, holes and all", () => {
  // `boundedWindows` refuses rather than clamps, in both directions. The merge changed under
  // it; the validation loop it sits in did not, and a hole must not be a way past it.
  const bad = (windows: Windows) =>
    assert.throws(
      () => new PolicyEngine({ granted: ["*"], systemFloor: "out", interventionWindowMs: windows as Record<string, number> }),
      (e: unknown) => (e as { code?: string }).code === "E_CONFIG_INVALID",
    );
  bad({ irreversible: undefined, externally_visible: 2 ** 31 });
  bad({ irreversible: -1 });
  bad({ irreversible: undefined, reversible_write: 1.5 });
});

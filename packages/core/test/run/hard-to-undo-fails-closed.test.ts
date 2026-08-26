/**
 * What a human de-escalation may reach, for a class the vocabulary cannot read.
 *
 * `oversight.test.ts` covers the lattice and `policy.test.ts` covers who may loosen. This file
 * covers one question neither asks: when the irreversibility class is a word in no vocabulary —
 * a manifest typo, a hostile manifest — is it MORE protected than a correctly spelled one, or
 * less?
 *
 * It was less. `isHardToUndo` read its two members as an allow-list in the negative, so the hard
 * floor that stops a human lowering a hard-to-undo action below `on` did not recognise `nuclear`
 * or `IRREVERSIBLE` and let both reach `out`, where nobody is watching. The floor was already
 * right — a sibling change ranks an unreadable class at `in` — and the ceiling walked past it.
 *
 * The control matters as much as the table: a guard that refuses EVERY de-escalation has broken
 * the feature rather than closed the hole, so `read_only` and `reversible_write` must still fall
 * all the way to `out`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { PolicyEngine, isHardToUndo, type PolicyActor } from "../../src/run/policy.ts";
import type { IrreversibilityClass } from "../../src/vocab.ts";
import type { NodeId, RunId } from "../../src/ids.ts";

const RUN = "01JRUNHARDTOUNDO00000000000" as RunId;
const NODE = "n-sink" as NodeId;
const SCOPE = `run:${RUN}`;
const HUMAN: PolicyActor = { kind: "human", id: "u:alice" };

/** `systemFloor: "out"` so nothing but the class itself and the hard floor is holding anything. */
const engine = () => new PolicyEngine({ granted: ["*"], systemFloor: "out" });

const req = (c: string, over: { tainted?: boolean } = {}) => ({
  runId: RUN,
  nodeId: NODE,
  kind: "tool" as const,
  // The point of the file: `c` is a plain string cast in, exactly as a manifest field arrives.
  irreversibility: c as IrreversibilityClass,
  capabilities: [] as readonly string[],
  declaredPosture: "out" as const,
  ...over,
});

/** floor with no ceiling, then the same class after a human lowers the run scope to `out`. */
function measure(c: string): { floor: string; after: string; effect: string; holdMs: number | null } {
  const floor = engine().effectivePosture(req(c));
  const p = engine();
  p.deescalate(SCOPE, "out", "incident window, operator watching", HUMAN);
  const after = p.effectivePosture(req(c));
  const d = p.decide(req(c));
  return { floor, after, effect: d.effect, holdMs: d.effect === "allow" ? d.holdMs : null };
}

test("AN UNREADABLE IRREVERSIBILITY CLASS IS HELD AT `on`, NOT LET THROUGH TO `out`", () => {
  const rows = ["irreversible", "externally_visible", "nuclear", "IRREVERSIBLE"].map((c) => ({
    class: c,
    ...measure(c),
  }));
  // Printed because this table IS the finding; the assertions below only pin it.
  console.table(rows);

  for (const r of rows) {
    assert.equal(r.floor, "in", `${r.class}: an unreadable class must FLOOR at in`);
    assert.equal(
      r.after,
      "on",
      `${r.class}: a human may lower a hard-to-undo action to on, never to out — ` +
        `and "unreadable" must count as hard-to-undo`,
    );
    assert.equal(r.effect, "allow");
  }
});

test("the unknown class gets a REAL intervention window, not `undefined` journaled as one", () => {
  // `#windows` is a plain table lookup, so the class the vocabulary cannot read used to yield
  // `undefined` — `holdMs > 0` false, nothing held, and `undefined` written to the journal as
  // the window an operator had to hit stop.
  for (const c of ["nuclear", "IRREVERSIBLE"]) {
    const { holdMs } = measure(c);
    assert.equal(typeof holdMs, "number", `${c}: holdMs must be a number`);
    assert.equal(holdMs, 5000, `${c}: and the strictest window any hard-to-undo class carries`);
  }
});

test("an operator's widened window is what the unknown class inherits", () => {
  const p = new PolicyEngine({
    granted: ["*"],
    systemFloor: "out",
    interventionWindowMs: { irreversible: 30_000 },
  });
  p.deescalate(SCOPE, "out", "incident window", HUMAN);
  const d = p.decide(req("nuclear"));
  assert.equal(d.effect, "allow");
  assert.equal(d.effect === "allow" ? d.holdMs : null, 30_000);
});

// ── the control: de-escalation still works ───────────────────────────────────

test("CONTROL — `read_only` and `reversible_write` still de-escalate all the way to `out`", () => {
  const rows = ["read_only", "reversible_write"].map((c) => ({ class: c, ...measure(c) }));
  console.table(rows);

  for (const r of rows) {
    assert.equal(r.after, "out", `${r.class}: a guard that refuses every de-escalation is broken`);
    assert.equal(r.effect, "allow");
    assert.equal(r.holdMs, 0, `${r.class}: and pays nothing for it`);
  }
  assert.equal(isHardToUndo("read_only"), false);
  assert.equal(isHardToUndo("reversible_write"), false);
});

test("E8 still reads the unknown class: taint holds it at `in`, above the hard floor", () => {
  const p = engine();
  p.deescalate(SCOPE, "out", "incident window", HUMAN);
  const d = p.decide(req("nuclear", { tainted: true }));
  assert.equal(d.effect, "gate");
  assert.ok(
    d.reasons.some((r) => r.includes("tainted input feeding an nuclear action (E8)")),
    `E8 must name the unreadable class too; reasons were ${JSON.stringify(d.reasons)}`,
  );
});

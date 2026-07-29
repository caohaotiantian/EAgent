/**
 * Permission-mode cycling (AC13).
 *
 * The assertion that matters is the revocation: cycling away from a mode must
 * drop what it granted, or the indicator says one thing while the capability
 * layer does another — exactly the class of bug the kernel review found in
 * `setFallback`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { applyMode, cycle, MODES, MODE_INFO, type Mode, type ModeTarget } from "./modes.js";

function spy(): ModeTarget & { fallbacks: string[]; granted: string[]; revoked: string[]; plans: boolean[] } {
  const fallbacks: string[] = [];
  const granted: string[] = [];
  const revoked: string[] = [];
  const plans: boolean[] = [];
  return {
    fallbacks,
    granted,
    revoked,
    plans,
    setFallback: (d) => void fallbacks.push(d),
    grant: (p) => {
      granted.push(p);
      return { dispose: () => void revoked.push(p) };
    },
    setPlanMode: (on) => void plans.push(on),
  };
}

test("AC13: Shift+Tab cycles forward through every mode and wraps", () => {
  let m: Mode = "manual";
  const seen: Mode[] = [m];
  for (let i = 0; i < MODES.length; i++) {
    m = cycle(m);
    seen.push(m);
  }

  assert.deepEqual(seen, ["manual", "plan", "yolo", "manual"]);
});

test("cycling backwards is symmetric", () => {
  assert.equal(cycle("manual", -1), "yolo");
  assert.equal(cycle(cycle("plan"), -1), "plan");
});

test("AC13: each mode installs its own fallback", () => {
  for (const mode of MODES) {
    const t = spy();
    applyMode(mode, t);
    assert.deepEqual(t.fallbacks, [MODE_INFO[mode].fallback], `${mode} sets its fallback`);
  }
});

test("AC13: cycling away REVOKES the previous mode's grants", () => {
  const t = spy();

  const disposers = applyMode("plan", t);
  assert.deepEqual(t.granted, ["fs:read"]);

  applyMode("manual", t, disposers);

  assert.deepEqual(t.revoked, ["fs:read"], "leaving plan mode drops its grant");
  assert.deepEqual(t.granted, ["fs:read"], "and manual grants nothing new");
});

test("there is no mode whose grants the host already provides", () => {
  // An "accept edits" mode was dropped for exactly this: the host pre-grants
  // fs:read/fs:write/skill:read, and grants are checked BEFORE the fallback, so
  // a mode granting one of them would be indistinguishable from manual.
  const hostPreGrants = ["fs:write", "skill:read"];
  for (const mode of MODES) {
    for (const g of MODE_INFO[mode].grants) {
      assert.ok(!hostPreGrants.includes(g), `${mode} grants ${g}, which the host already grants`);
    }
  }
});

test("plan mode is read-only and turns the approval gate on", () => {
  const t = spy();

  applyMode("plan", t);

  assert.deepEqual(t.granted, ["fs:read"], "reading is free");
  assert.deepEqual(t.plans, [true], "the mutating-call gate is on");
});

test("leaving plan mode turns the gate back off", () => {
  const t = spy();
  const d = applyMode("plan", t);

  applyMode("manual", t, d);

  assert.deepEqual(t.plans, [true, false]);
});

test("yolo allows everything and grants nothing individually", () => {
  const t = spy();

  applyMode("yolo", t);

  assert.deepEqual(t.fallbacks, ["allow"]);
  assert.deepEqual(t.granted, [], "an allow fallback needs no per-pattern grant");
});

test("every mode has a label and a hint for the indicator", () => {
  for (const mode of MODES) {
    assert.ok(MODE_INFO[mode].label.length > 0, `${mode} has a label`);
    assert.ok(MODE_INFO[mode].hint.length > 0, `${mode} has a hint`);
  }
});

test("a target without plan-mode support does not break applyMode", () => {
  const t = spy();
  const { setPlanMode: _drop, ...withoutPlan } = t;

  assert.doesNotThrow(() => applyMode("plan", withoutPlan));
});

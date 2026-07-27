import assert from "node:assert/strict";
import { test } from "node:test";
import { planClear, shouldAcceptFrame, newSessionId } from "./session.js";
import { initialModel, reduce, applyControl, type TaggedEvent } from "@eagent/view-model";
import { reduceAsk } from "./ask-state.js";

test("AC11: multi-turn accumulates without agent_start", () => {
  let m = initialModel("auto");
  const tag = { actingId: "s", rootId: "s", at: 1 };
  const t1: TaggedEvent[] = [
    { kind: "text_delta", text: "a", ...tag },
    { kind: "agent_end", reason: "end_turn", ...tag },
  ];
  for (const e of t1) m = reduce(m, e);
  const n1 = m.sections.length;
  assert.ok(n1 >= 1);
  for (const e of [
    { kind: "text_delta" as const, text: "b", ...tag, at: 2 },
    { kind: "agent_end" as const, reason: "end_turn" as const, ...tag, at: 3 },
  ]) {
    m = reduce(m, e);
  }
  assert.ok(m.sections.length > n1, "second turn adds sections");
});

test("AC11: Clear mints new session; old binding rejected", () => {
  const id0 = newSessionId();
  const plan = planClear(id0, 0);
  assert.notEqual(plan.currentId, plan.previousId);
  assert.equal(plan.generation, 1);
  assert.equal(shouldAcceptFrame(id0, 0, plan.currentId, plan.generation), false);
  assert.equal(shouldAcceptFrame(plan.currentId, 1, plan.currentId, plan.generation), true);
  let m = initialModel("full");
  m = applyControl(m, { kind: "mode", mode: "collapsed" });
  m = initialModel(m.mode);
  assert.equal(m.sections.length, 0);
  assert.equal(m.mode, "collapsed");
});

test("AC6: ask dismiss rules", () => {
  let s = reduceAsk({ kind: "idle" }, { type: "show", ask: { id: 1, question: "?", options: null } });
  assert.equal(s.kind, "pending");
  s = reduceAsk(s, { type: "retry_error" });
  assert.equal(s.kind, "pending");
  s = reduceAsk(s, { type: "stream_frame" });
  assert.equal(s.kind, "idle");
  s = reduceAsk({ kind: "pending", ask: { id: 1, question: "?", options: ["y"] } }, { type: "gone" });
  assert.equal(s.kind, "idle");
});

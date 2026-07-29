/**
 * The permission-mode seams (AC6, AC13).
 *
 * A front end's mode control needs two things the capability layer did not
 * expose: a runtime fallback swap, and a way to un-remember an answer. Without
 * `forget`, cycling a mode back to `ask` is silently a no-op — every prior
 * answer still short-circuits the prompt, so the UI would show "ask" while
 * behaving like "allow". `UI.decide` adds the third answer ("allow once") that a
 * boolean `confirm` cannot express.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CapabilityError, CapabilityManager } from "../src/kernel/capabilities.js";
import type { DecisionChoice, DecisionRequest, UI } from "../src/kernel/types.js";

/** A UI that records what it was asked and answers with a scripted sequence. */
function scriptedUI(answers: DecisionChoice[]): UI & { seen: DecisionRequest[] } {
  const seen: DecisionRequest[] = [];
  return {
    seen,
    confirm: async () => true,
    notify: () => {},
    decide: async (req) => {
      seen.push(req);
      return answers.shift() ?? "reject";
    },
  };
}

/** A UI with no `decide` — the historical boolean-only front end. */
const confirmingUI = (answer: boolean): UI => ({
  confirm: async () => answer,
  notify: () => {},
});

test("AC6: setFallback swaps the policy at runtime", async () => {
  const caps = new CapabilityManager({ fallback: "deny" });

  await assert.rejects(() => caps.require("fs:write", "t"), CapabilityError, "deny mode rejects");

  caps.setFallback("allow");
  await assert.doesNotReject(() => caps.require("fs:write", "t"), "allow mode passes");

  caps.setFallback("deny");
  await assert.rejects(() => caps.require("fs:write", "t"), CapabilityError, "and swaps back");
});

test("AC6: an `always` answer is remembered; `once` is not", async () => {
  const ui = scriptedUI(["once", "always"]);
  const caps = new CapabilityManager({ fallback: "ask", ui });

  await caps.require("shell:exec", "bash");
  assert.equal(ui.seen.length, 1, "first call prompts");

  // `once` granted only that call, so the second must prompt again.
  await caps.require("shell:exec", "bash");
  assert.equal(ui.seen.length, 2, "an `once` answer does not silence the next call");

  // That second answer was `always`, so the third must not prompt.
  await caps.require("shell:exec", "bash");
  assert.equal(ui.seen.length, 2, "an `always` answer is remembered");
});

test("AC13: forget() makes a remembered answer prompt again", async () => {
  const ui = scriptedUI(["always", "always"]);
  const caps = new CapabilityManager({ fallback: "ask", ui });

  await caps.require("fs:write", "write");
  await caps.require("fs:write", "write");
  assert.equal(ui.seen.length, 1, "remembered, so only one prompt");

  caps.forget();
  await caps.require("fs:write", "write");
  assert.equal(ui.seen.length, 2, "forgetting re-opens the question");
});

test("AC13: forget(pattern) drops only the matching answers", async () => {
  const ui = scriptedUI(["always", "always", "always"]);
  const caps = new CapabilityManager({ fallback: "ask", ui });

  await caps.require("fs:write", "a");
  await caps.require("shell:exec", "b");
  assert.equal(ui.seen.length, 2);

  caps.forget("fs:*");

  await caps.require("shell:exec", "b");
  assert.equal(ui.seen.length, 2, "shell:exec is still remembered");
  await caps.require("fs:write", "a");
  assert.equal(ui.seen.length, 3, "fs:write was forgotten and prompts again");
});

test("AC13: a rejected answer is remembered as a denial and forget() clears it too", async () => {
  const ui = scriptedUI(["reject", "always"]);
  const caps = new CapabilityManager({ fallback: "ask", ui });

  await assert.rejects(() => caps.require("net:fetch", "web"), CapabilityError);
  await assert.rejects(() => caps.require("net:fetch", "web"), CapabilityError, "still denied, unprompted");
  assert.equal(ui.seen.length, 1, "the denial was remembered");

  caps.forget();
  await assert.doesNotReject(() => caps.require("net:fetch", "web"), "a fresh answer can reverse it");
});

test("AC6: the request carries the tool arguments, not just the capability name", async () => {
  const ui = scriptedUI(["always"]);
  const caps = new CapabilityManager({ fallback: "ask", ui });

  await caps.require("shell:exec", "bash", { command: "rm -rf build" });

  assert.deepEqual(ui.seen[0], {
    capability: "shell:exec",
    source: "bash",
    arguments: { command: "rm -rf build" },
  });
});

test("a UI without `decide` still works, and its `true` keeps meaning `always`", async () => {
  const caps = new CapabilityManager({ fallback: "ask", ui: confirmingUI(true) });

  await assert.doesNotReject(() => caps.require("fs:read", "read"));
  assert.equal(caps.isGranted("fs:read"), true, "confirm(true) is remembered, as it always was");
});

test("a UI without `decide` answering false still denies and is remembered", async () => {
  const caps = new CapabilityManager({ fallback: "ask", ui: confirmingUI(false) });

  await assert.rejects(() => caps.require("fs:write", "write"), CapabilityError);
  assert.equal(caps.isGranted("fs:write"), false);
});

test("concurrent callers for the same capability share one prompt", async () => {
  const ui = scriptedUI(["always"]);
  const caps = new CapabilityManager({ fallback: "ask", ui });

  await Promise.all([
    caps.require("fs:write", "a"),
    caps.require("fs:write", "b"),
    caps.require("fs:write", "c"),
  ]);

  assert.equal(ui.seen.length, 1, "three concurrent callers, one prompt");
});

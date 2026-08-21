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

import { CapabilityError, CapabilityManager } from "../src/kernel/capabilities.ts";
import type { DecisionChoice, DecisionRequest, UI } from "../src/kernel/types.ts";

/** A UI that records what it was asked and answers with a scripted sequence. */
function scriptedUI(answers: DecisionChoice[]): UI & { seen: DecisionRequest[] } {
  const seen: DecisionRequest[] = [];
  return {
    seen,
    confirm: async () => true,
    notify: () => {},
    decide: async (req) => {
      seen.push(req);
      const next = answers.shift();
      if (next === undefined) throw new Error("scripted UI exhausted — the test asked more times than it scripted");
      return next;
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

test("a UI without `decide` answering false denies, and the denial is remembered", async () => {
  let prompts = 0;
  const caps = new CapabilityManager({
    fallback: "ask",
    ui: { confirm: async () => (prompts++, false), notify: () => {} },
  });

  await assert.rejects(() => caps.require("fs:write", "write"), CapabilityError);
  await assert.rejects(() => caps.require("fs:write", "write"), CapabilityError);
  // "Remembered" means the second call did not re-prompt. `isGranted` alone
  // cannot show that — it also returns false for a capability never asked about.
  assert.equal(prompts, 1, "the denial was remembered, not re-asked");
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

// -- regressions found by kernel review -------------------------------------

test("an unrecognized answer DENIES — the decision whitelist fails closed", async () => {
  // A `decide` that falls off the end of an async fn, or one whose answer is a
  // `null` deserialized off a wire. Blacklisting ("anything but reject allows")
  // would grant here; only a whitelist is safe.
  for (const bad of [undefined, null, "", "deny", "no", "REJECT", 0]) {
    const caps = new CapabilityManager({
      fallback: "ask",
      ui: { confirm: async () => false, notify: () => {}, decide: (async () => bad) as never },
    });

    await assert.rejects(
      () => caps.require("shell:exec", "bash"),
      CapabilityError,
      `decide() -> ${JSON.stringify(bad)} must deny, not allow`,
    );
  }
});

test("setFallback('deny') locks down a capability that was already approved", async () => {
  const caps = new CapabilityManager({ fallback: "ask", ui: confirmingUI(true) });

  await caps.require("shell:exec", "bash");

  // `require` consults the memo BEFORE the fallback, so without clearing it a
  // lock-down mode would leave every prior approval silently in force.
  caps.setFallback("deny");
  await assert.rejects(() => caps.require("shell:exec", "bash"), CapabilityError);
});

test("setFallback('allow') releases a capability that was already refused", async () => {
  const caps = new CapabilityManager({ fallback: "ask", ui: confirmingUI(false) });

  await assert.rejects(() => caps.require("fs:write", "write"), CapabilityError);

  caps.setFallback("allow");
  await assert.doesNotReject(() => caps.require("fs:write", "write"));
});

test("`once` does not leak across concurrent calls with different arguments", async () => {
  const ui = scriptedUI(["once", "reject"]);
  const caps = new CapabilityManager({ fallback: "ask", ui });

  const [benign, dangerous] = await Promise.allSettled([
    caps.require("shell:exec", "bash", { command: "ls" }),
    caps.require("shell:exec", "bash", { command: "rm -rf /" }),
  ]);

  // Each distinct argument set gets its own prompt: a human approving `ls` must
  // never thereby authorize an `rm -rf /` they were never shown.
  assert.equal(ui.seen.length, 2, "different arguments are prompted separately");
  assert.equal(benign?.status, "fulfilled");
  assert.equal(dangerous?.status, "rejected");
});

test("identical concurrent calls still share one prompt", async () => {
  const ui = scriptedUI(["always"]);
  const caps = new CapabilityManager({ fallback: "ask", ui });

  await Promise.all([
    caps.require("fs:write", "a", { path: "x.ts" }),
    caps.require("fs:write", "b", { path: "x.ts" }),
  ]);

  assert.equal(ui.seen.length, 1, "same capability, same arguments -> one prompt");
});

test("a prompt answered after forget() does not repopulate the cleared memo", async () => {
  let resolve!: (c: DecisionChoice) => void;
  const seen: DecisionRequest[] = [];
  const caps = new CapabilityManager({
    fallback: "ask",
    ui: {
      confirm: async () => true,
      notify: () => {},
      decide: (req) => (seen.push(req), new Promise<DecisionChoice>((r) => (resolve = r))),
    },
  });

  const inflight = caps.require("fs:write", "write");
  caps.forget(); // the human resets the mode while the dialog is still open
  resolve("always");
  await inflight;

  assert.equal(caps.isGranted("fs:write"), false, "the stale answer did not stick");
  assert.equal(seen.length, 1);
});

test("a rejecting decide() surfaces as a rejection, not an unhandled one", async () => {
  const caps = new CapabilityManager({
    fallback: "ask",
    ui: {
      confirm: async () => true,
      notify: () => {},
      decide: async () => {
        throw new Error("dialog cancelled");
      },
    },
  });

  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown): void => void unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    await assert.rejects(() => caps.require("fs:write", "write"), /dialog cancelled/);
    // Let the microtask queue drain so a stray derived promise would surface.
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  assert.deepEqual(unhandled, [], "the .finally() chain must not orphan the rejection");
});

test("setFallback writes an audit entry — a policy change is never silent", () => {
  const caps = new CapabilityManager({ fallback: "ask" });

  caps.setFallback("allow");
  caps.setFallback("deny");

  const policy = caps.audit().filter((a) => a.source === "setFallback");
  assert.equal(policy.length, 2, "both switches are recorded");
  assert.deepEqual(policy.map((a) => a.decision), ["allow", "deny"]);
});

/**
 * Tests for the autocontinue extension (Design D4): an opt-in observer that, when
 * a turn ends on `max_tokens` with no tool call, injects a "continue" follow-up so
 * the agent loop resumes instead of stopping on a truncated answer.
 *
 * The suite is offline: a scriptable `MockProvider` drives multi-turn sequences
 * (a truncated turn, then a clean end) via D5's `stopReason` field. The extension
 * is loaded with `host.use("autocontinue", activate)` and does NOT depend on
 * BUILTIN_EXTENSIONS. It ships OFF; tests enable it through the store flag or the
 * `/autocontinue` command, exactly as a user would.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import autocontinue, { NUDGE, CAP } from "../src/extensions/autocontinue.ts";
import { defineTool, ok } from "../src/kernel/define.ts";
import type { Agent } from "../src/kernel/agent.ts";
import type { Message } from "../src/kernel/types.ts";
import { makeHarness, type Harness } from "./helpers.ts";

// -- helpers ----------------------------------------------------------------

/** Concatenate the text blocks of a message. */
function msgText(m: Message): string {
  let s = "";
  for (const b of m.content) if (b.type === "text") s += b.text;
  return s;
}

/** How many injected NUDGE follow-up user messages are in the transcript. */
function countNudges(agent: Agent): number {
  return agent.messages.filter((m) => m.role === "user" && msgText(m) === NUDGE).length;
}

/** Activate autocontinue, optionally enabling it via its store flag first. */
async function activate(h: Harness, opts: { enabled?: boolean } = {}): Promise<void> {
  await h.host.use("autocontinue", (e) => {
    if (opts.enabled !== undefined) e.store.set("enabled", opts.enabled);
    return autocontinue(e);
  });
}

/** Dispatch the `/autocontinue` command, collecting printed lines. */
function runCommand(h: Harness, args: string): string[] {
  const lines: string[] = [];
  const cmd = h.commands.get("autocontinue");
  assert.ok(cmd, "autocontinue command is registered");
  cmd.run({ agent: h.agent, args, print: (s) => lines.push(s) });
  return lines;
}

// ===========================================================================
// AC3 — resume a truncated run when enabled
// ===========================================================================

test("AC3: an enabled max_tokens turn is continued to a clean end_turn", async () => {
  // Turn 1 is truncated (max_tokens, no tool call); turn 2 finishes cleanly.
  const h = makeHarness({
    responder: [
      { text: "part one", stopReason: "max_tokens" },
      { text: "part two" }, // inferred end_turn
    ],
  });
  await activate(h, { enabled: true });

  const result = await h.agent.run("write a long answer");

  assert.equal(result.reason, "end_turn", "the truncated run resumes to a clean end");

  const msgs = h.agent.messages;
  const firstAssistant = msgs.findIndex(
    (m) => m.role === "assistant" && msgText(m).includes("part one"),
  );
  assert.ok(firstAssistant >= 0, "the first (truncated) assistant turn is present");
  const between = msgs[firstAssistant + 1];
  assert.ok(
    between && between.role === "user" && msgText(between) === NUDGE,
    "a role:user follow-up (the NUDGE) was injected between the two assistant turns",
  );
  const secondAssistant = msgs
    .slice(firstAssistant + 1)
    .find((m) => m.role === "assistant" && msgText(m).includes("part two"));
  assert.ok(secondAssistant, "the continuation produced 'part two'");
  assert.equal(countNudges(h.agent), 1, "exactly one continuation was injected");
});

// ===========================================================================
// AC4 — cap at 3 continuations, reset per top-level run
// ===========================================================================

test("AC4: at most CAP continuations, and the count resets each top-level run", async () => {
  // Every turn is truncated forever, so only the cap stops the loop.
  const h = makeHarness({
    responder: () => ({ text: "still going", stopReason: "max_tokens" }),
  });
  await activate(h, { enabled: true });

  const first = await h.agent.run("keep going");
  assert.equal(first.reason, "max_tokens", "the run ends max_tokens once the cap is hit");
  assert.equal(countNudges(h.agent), CAP, `exactly ${CAP} continuations before the cap stops it`);

  // A SECOND run on the SAME agent must continue again — proving agent_start
  // resets the per-run count (per-run, not per-session). The transcript
  // accumulates, so assert the delta.
  const before = countNudges(h.agent);
  const second = await h.agent.run("keep going again");
  assert.equal(second.reason, "max_tokens", "the second run also ends max_tokens at the cap");
  assert.equal(
    countNudges(h.agent) - before,
    CAP,
    `the second run injects a fresh ${CAP} continuations (per-run reset)`,
  );
});

// ===========================================================================
// AC5 — inert cases: disabled / kill-switched / tool-call path
// ===========================================================================

test("AC5a: disabled by default — a max_tokens turn stops with no follow-up", async () => {
  const h = makeHarness({
    responder: [{ text: "truncated", stopReason: "max_tokens" }],
  });
  await activate(h); // NOT enabled

  const result = await h.agent.run("go");

  assert.equal(result.reason, "max_tokens", "the run stops on max_tokens when disabled");
  assert.equal(countNudges(h.agent), 0, "no follow-up injected when disabled");
});

test("AC5b: EAGENT_AUTOCONTINUE=off vetoes even /autocontinue on", async () => {
  const saved = process.env.EAGENT_AUTOCONTINUE;
  process.env.EAGENT_AUTOCONTINUE = "off";
  try {
    const h = makeHarness({
      responder: [{ text: "truncated", stopReason: "max_tokens" }],
    });
    await activate(h);
    runCommand(h, "on"); // sets the store flag, but the env veto must win

    const result = await h.agent.run("go");

    assert.equal(result.reason, "max_tokens", "the kill switch keeps the run stopping");
    assert.equal(countNudges(h.agent), 0, "no follow-up under the kill switch");
  } finally {
    if (saved === undefined) delete process.env.EAGENT_AUTOCONTINUE;
    else process.env.EAGENT_AUTOCONTINUE = saved;
  }
});

test("AC5c: a max_tokens turn that carries a tool call injects no follow-up", async () => {
  const h = makeHarness({
    responder: [
      { text: "using a tool", toolCalls: [{ name: "noop" }], stopReason: "max_tokens" },
      { text: "done" }, // inferred end_turn
    ],
  });
  h.agent.tools.register(
    defineTool({
      name: "noop",
      description: "a no-op tool",
      parameters: { type: "object", properties: {} },
      execute: () => ok("ok"),
    }),
  );
  await activate(h, { enabled: true });

  const result = await h.agent.run("go");

  // The loop continues via the tool-call path on its own; autocontinue must NOT
  // also drive it (no double-drive) — the truncated turn carried a tool_call.
  assert.equal(result.reason, "end_turn", "the tool-call path carried the loop to a clean end");
  assert.equal(countNudges(h.agent), 0, "no follow-up injected on the tool-call path");
});

// ===========================================================================
// /autocontinue command
// ===========================================================================

test("/autocontinue on|off|status toggles the flag and reports state + cap", async () => {
  const h = makeHarness();
  await activate(h);

  const status0 = runCommand(h, "status");
  assert.ok(status0.some((l) => /off/.test(l)), "status reports off by default");
  assert.ok(status0.some((l) => new RegExp(String(CAP)).test(l)), "status reports the cap");

  const on = runCommand(h, "on");
  assert.ok(on.some((l) => /on/.test(l)), "on prints on");
  const status1 = runCommand(h, "status");
  assert.ok(status1.some((l) => /on/.test(l)), "status reports on after /autocontinue on");

  const off = runCommand(h, "off");
  assert.ok(off.some((l) => /off/.test(l)), "off prints off");
  assert.ok(runCommand(h, "status").some((l) => /off/.test(l)), "status reports off again");

  assert.doesNotThrow(() => runCommand(h, ""), "a bare command does not throw");
  assert.doesNotThrow(() => runCommand(h, "bogus"), "an unknown arg does not throw");
});

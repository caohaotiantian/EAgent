/**
 * ask — agent→host elicitation via the `ask_user_question` tool.
 *
 * All offline, via `makeHarness` + `MockProvider`, loading the extension with
 * `host.use("ask", ask)` (NOT `BUILTIN_EXTENSIONS`). The scripted responder
 * drives a single `ask_user_question` call then `{ text: "done" }` to end the
 * run; the assertions read the resulting `tool_result` block in the transcript.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Agent } from "../src/kernel/agent.ts";
import type { UI } from "../src/kernel/types.ts";
import { makeHarness } from "./helpers.ts";
import ask from "../src/extensions/ask.ts";

/** The `tool` message's first `tool_result` block, or undefined if none. */
function toolResult(agent: Agent): { content: string; isError?: boolean } | undefined {
  const toolMsg = agent.messages.find((m) => m.role === "tool");
  const block = toolMsg?.content.find((b) => b.type === "tool_result");
  return block && block.type === "tool_result" ? { content: block.content, isError: block.isError } : undefined;
}

// -- AC 1 + AC 7: scripted-ask UI returns the chosen answer; options forwarded --

test("scripted-ask UI returns the chosen answer and forwards options verbatim", async () => {
  let askArgs: { q: string; opts: string[] | undefined } | undefined;
  const ui: UI = {
    confirm: async () => true,
    notify: () => {},
    ask: async (q, opts) => {
      askArgs = { q, opts };
      return "Postgres";
    },
  };
  const h = makeHarness({
    ui,
    responder: [
      { toolCalls: [{ name: "ask_user_question", arguments: { question: "Which DB?", options: ["Postgres", "MySQL"] } }] },
      { text: "done" },
    ],
  });
  await h.host.use("ask", ask);
  await h.agent.run("set up the db");

  const res = toolResult(h.agent);
  assert.ok(res, "a tool_result block exists");
  assert.match(res.content, /Postgres/, "the chosen answer flows back as the tool result"); // AC 1
  assert.deepEqual(askArgs?.opts, ["Postgres", "MySQL"], "options are forwarded to ui.ask verbatim"); // AC 7
});

// -- AC 2: ask-absent UI → proceed-with-assumption fallback (non-error) -------

test("ask-absent UI returns the proceed-with-assumption fallback (non-error)", async () => {
  // Default harness UI is autoUI(): only confirm + notify, no `ask`. fallback
  // defaults to "allow", so ui:ask is allowed; the absence-fallback fires, not
  // the capability deny of AC 3.
  const h = makeHarness({
    responder: [
      { toolCalls: [{ name: "ask_user_question", arguments: { question: "Which env?" } }] },
      { text: "done" },
    ],
  });
  await h.host.use("ask", ask);
  await h.agent.run("deploy it");

  const res = toolResult(h.agent);
  assert.ok(res, "a tool_result block exists");
  assert.match(res.content, /proceed.*assumption/i, "the fallback instructs proceed-with-assumption");
  assert.notEqual(res.isError, true, "the fallback is a non-error result");
});

// -- AC 3: ui:ask-denied run auto-declines (no hang, error result) ------------

test("ui:ask-denied run auto-declines with a capability error (no hang)", async () => {
  // Default non-interactive UI (no `ask`) → the conditional grant does NOT
  // fire, so ui:ask falls through to the `deny` fallback.
  const h = makeHarness({
    fallback: "deny",
    responder: [
      { toolCalls: [{ name: "ask_user_question", arguments: { question: "Which env?" } }] },
      { text: "done" },
    ],
  });
  await h.host.use("ask", ask);
  await h.agent.run("deploy it");

  const res = toolResult(h.agent);
  assert.ok(res, "a tool_result block exists");
  assert.equal(res.isError, true, "a denied capability yields an error result");
  assert.match(res.content, /capability "ui:ask"/, "the error names the ui:ask capability");
});

// -- AC 4: interactive run does not double-prompt (confirm 0×, ask 1×) --------

test("interactive run does not double-prompt: confirm 0x, ask 1x", async () => {
  let confirmCount = 0;
  let askCount = 0;
  const ui: UI = {
    confirm: async () => {
      confirmCount++;
      return true;
    },
    notify: () => {},
    ask: async () => {
      askCount++;
      return "Postgres";
    },
  };
  // `fallback: "ask"` is load-bearing: it is the only fallback under which the
  // conditional grant is *observable*. Absent the grant, `require("ui:ask")`
  // would reach the confirm-fallback (capabilities.ts:111-119) and call
  // `confirm`, so `confirmCount == 0` proves the grant pre-allowed ui:ask and
  // `require` never reached the ratify prompt — the exact AC 4 mechanism. Under
  // the harness default `fallback: "allow"`, require resolves to ALLOW via the
  // allow-fallback regardless of the grant, so the assertion would pass even if
  // the grant were deleted (vacuous).
  const h = makeHarness({
    ui,
    fallback: "ask",
    responder: [
      { toolCalls: [{ name: "ask_user_question", arguments: { question: "Which DB?" } }] },
      { text: "done" },
    ],
  });
  await h.host.use("ask", ask);
  await h.agent.run("set up the db");

  assert.equal(confirmCount, 0, "the human is never asked to ratify the capability");
  assert.equal(askCount, 1, "the human is asked the question exactly once");
});

// -- AC 5: kill switch — EAGENT_ASK=off registers no tool ---------------------

test("EAGENT_ASK=off registers no ask_user_question tool", async () => {
  const prev = process.env.EAGENT_ASK;
  process.env.EAGENT_ASK = "off";
  try {
    const h = makeHarness();
    await h.host.use("ask", ask);
    assert.equal(h.agent.tools.get("ask_user_question"), undefined, "no tool is registered under the kill switch");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_ASK;
    else process.env.EAGENT_ASK = prev;
  }
});

// -- AC 6: clean teardown — tool removed, dispose never throws, grant revoked --

test("unload removes the tool and never throws; the ui:ask grant is revoked", async () => {
  const ui: UI = {
    confirm: async () => true,
    notify: () => {},
    ask: async () => "Postgres",
  };
  // `fallback: "deny"` is load-bearing: under it `isGranted` reduces to
  // `matchesAny(capability, #grant)` (capabilities.ts:124-128), so the two
  // grant assertions below are non-vacuous — they pass only if the conditional
  // grant pattern is genuinely present/persisted. Under the harness default
  // `fallback: "allow"`, `isGranted` returns true via the allow-fallback
  // (capabilities.ts:128) regardless of the grant, making both assertions pass
  // even if `grantCapability("ui:ask")` were deleted (vacuous) — the same defect
  // round 2 (e097d1b) fixed for AC 4.
  const h = makeHarness({ ui, fallback: "deny" });
  await h.host.use("ask", ask);

  // The conditional grant fired (the UI can ask), so ui:ask is allowed now.
  assert.equal(h.agent.capabilities.isGranted("ui:ask"), true, "the grant fired for an ask-capable UI");

  await h.host.unload("ask"); // must not throw

  assert.equal(h.agent.tools.get("ask_user_question"), undefined, "the tracked tool disposable removed the tool");
  // grantCapability is now tracked for disposal, so unload revokes the grant
  // alongside the tool.
  assert.equal(h.agent.capabilities.isGranted("ui:ask"), false, "the ui:ask grant is reversed by unload");
});

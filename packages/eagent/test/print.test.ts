/**
 * The headless plain printer (AC4).
 *
 * The load-bearing assertion is the negative one: no machine path may emit a
 * cursor, alt-screen, or spinner byte. That property used to be pinned against
 * the deleted `EngineRenderer`; it now belongs to `src/print.ts`, which is the
 * only human-readable output the engine itself produces.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Agent } from "../src/kernel/agent.ts";
import { ProviderRegistry } from "../src/kernel/registry.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { summarizeArgs, wirePlainPrinting } from "../src/print.ts";
import { makeHarness } from "./helpers.ts";

/** Every escape family a piped consumer must never receive. */
const CURSOR_BYTES = [
  /\x1b\[\?1049[hl]/, // alt screen enter/leave
  /\x1b\[\?25[hl]/, // cursor hide/show
  /\x1b\[\d*[ABCD]/, // cursor motion
  /\x1b\[2J/, // clear screen
  /\x1b\[\d*K/, // erase line
];
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function collect(): { out: string[]; err: string[]; sink: { out: (s: string) => void; err: (s: string) => void } } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, sink: { out: (s) => void out.push(s), err: (s) => void err.push(s) } };
}

test("AC4: assistant text streams to stdout verbatim", async () => {
  const { agent } = makeHarness({ responder: [{ text: "Hello, world." }] });
  const { out, sink } = collect();
  wirePlainPrinting(agent, sink);

  await agent.run("hi");

  assert.equal(out.join("").trimEnd(), "Hello, world.");
});

test("AC4: no cursor, alt-screen, or spinner byte reaches either stream", async () => {
  const { agent } = makeHarness({ responder: [{ text: "some answer" }] });
  const { out, err, sink } = collect();
  wirePlainPrinting(agent, sink);

  await agent.run("hi");

  const everything = out.join("") + err.join("");
  for (const re of CURSOR_BYTES) {
    assert.doesNotMatch(everything, re, `machine stream leaked ${re}`);
  }
  for (const frame of SPINNER_FRAMES) {
    assert.ok(!everything.includes(frame), `machine stream leaked spinner frame ${frame}`);
  }
});

test("AC4: annotations go to stderr so redirected stdout stays a clean transcript", async () => {
  const { agent } = makeHarness({ responder: [{ text: "answer" }] });
  const { out, err, sink } = collect();
  wirePlainPrinting(agent, sink);

  await agent.hooks.emit("error", { error: new Error("boom"), where: "tool" });
  await agent.run("hi");

  assert.ok(err.join("").includes("boom"), "the error reached stderr");
  assert.ok(!out.join("").includes("boom"), "stdout carries only the answer");
});

test("summarizeArgs bounds the one-line summary and never throws on odd values", () => {
  assert.equal(summarizeArgs({}), "");
  assert.equal(summarizeArgs({ a: "b" }), "a=b");
  assert.equal(summarizeArgs({ n: 1, ok: true }), "n=1 ok=true");

  const long = summarizeArgs({ path: "x".repeat(500) });
  assert.ok(long.length <= 80, `summary must stay bounded, got ${long.length}`);
  assert.ok(long.endsWith("…"), "a clipped summary is marked with an ellipsis");
});

test("tool calls are annotated on stderr, never on the answer stream", async () => {
  const { agent } = makeHarness({ responder: [{ text: "answer" }] });
  const { out, err, sink } = collect();
  wirePlainPrinting(agent, sink);

  await agent.hooks.emit("tool_start", {
    call: { type: "tool_call" as const, id: "1", name: "read", arguments: { file: "a.ts" } },
  });

  assert.match(err.join(""), /read/, "the tool call is annotated on stderr");
  assert.equal(out.join("").includes("read"), false, "stdout carries only the answer");
});

test("a failing tool result is annotated; a successful one stays quiet", async () => {
  const { agent } = makeHarness({ responder: [{ text: "answer" }] });
  const { err, sink } = collect();
  wirePlainPrinting(agent, sink);
  const call = { type: "tool_call" as const, id: "1", name: "bash", arguments: {} };

  await agent.hooks.emit("tool_end", { call, result: { content: "ok", isError: false }, step: 0 });
  assert.equal(err.join("").includes("✗"), false, "a success is not annotated");

  await agent.hooks.emit("tool_end", { call, result: { content: "boom", isError: true }, step: 0 });
  assert.match(err.join(""), /✗ bash: boom/, "a failure names the tool and its first line");
});

test("reasoning is annotated on stderr (the docstring's claim is real)", async () => {
  const { agent } = makeHarness({ responder: [{ text: "answer" }] });
  const { out, err, sink } = collect();
  wirePlainPrinting(agent, sink);

  await agent.hooks.emit("reasoning_delta", { text: "thinking hard" });

  assert.match(err.join(""), /thinking hard/, "reasoning reached stderr");
  assert.equal(out.join("").includes("thinking"), false, "reasoning never pollutes the answer");
});

// The silent-truncation guard :
// an abnormal, otherwise-silent stop reason must warn. The negative half matters
// as much — the clean ends already carry their own signal, so warning there would
// be noise on every successful run.
for (const [reason, pattern] of [
  ["max_tokens", /truncated/],
  ["content_filter", /content_filter/],
  ["refusal", /refusal/],
] as const) {
  test(`agent_end warns on the abnormal-and-silent reason ${reason}`, async () => {
    const { agent } = makeHarness({ responder: [{ text: "answer" }] });
    const { err, sink } = collect();
    wirePlainPrinting(agent, sink);

    await agent.hooks.emit("agent_end", { reason });

    assert.match(err.join(""), pattern, `${reason} must warn`);
  });
}

for (const reason of ["end_turn", "tool_use", "stop", "error"] as const) {
  test(`agent_end stays quiet on ${reason} (already-signalled or clean)`, async () => {
    const { agent } = makeHarness({ responder: [{ text: "answer" }] });
    const { err, sink } = collect();
    wirePlainPrinting(agent, sink);

    await agent.hooks.emit("agent_end", { reason });

    assert.equal(err.join("").includes("⚠"), false, `${reason} must not warn`);
  });
}

test("a tool-only turn contributes no stray blank line to stdout", async () => {
  const { agent } = makeHarness({ responder: [{ text: "answer" }] });
  const { out, sink } = collect();
  wirePlainPrinting(agent, sink);

  await agent.hooks.emit("agent_end", { reason: "end_turn" });

  assert.equal(out.join(""), "", "no answer text means no terminating newline");
});

test("summarizeArgs collapses newlines and survives an unserializable value", () => {
  assert.equal(summarizeArgs({ cmd: "a\nb" }), "cmd=a b", "a multi-line arg stays one line");

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.doesNotThrow(() => summarizeArgs({ circular }), "an annotation must never kill a run");
  assert.doesNotThrow(() => summarizeArgs({ big: 1n }), "a BigInt must not throw");
});

// The sub-agent leak: `childScope()` shares the parent's hook bus and suppresses
// only the run-lifecycle events, so a fork's `text_delta` reaches the same sink
// as the root's. Without an acting-agent filter every child's tokens interleave
// into the piped answer — garbled character-block by block under parallel forks.
test("a sub-agent's text is annotated on stderr, never mixed into the answer", async () => {
  const { agent: root } = makeHarness({ responder: [{ text: "ROOT-ANSWER" }] });
  const { out, err, sink } = collect();
  wirePlainPrinting(root, sink);

  const providers = new ProviderRegistry();
  providers.register(new MockProvider([{ text: "CHILD-TEXT" }]), { default: true });
  const child = new Agent({
    providers,
    capabilities: root.capabilities,
    ui: root.ui,
    logger: root.logger,
    model: "mock",
    provider: "mock",
    hooks: root.hooks.childScope(),
  });

  await child.run("child work");
  await root.run("root work");

  assert.equal(out.join("").includes("CHILD-TEXT"), false, "the child never reaches stdout");
  assert.match(err.join(""), /CHILD-TEXT/, "the child is annotated on stderr instead");
  assert.match(out.join(""), /ROOT-ANSWER/, "the root's answer still reaches stdout");
});

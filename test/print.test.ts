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

import { summarizeArgs, wirePlainPrinting } from "../src/print.js";
import { makeHarness } from "./helpers.js";

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

test("annotate:false suppresses tool lines (the --json path keeps stdout pure)", async () => {
  const { agent } = makeHarness({ responder: [{ text: "answer" }] });
  const { err, sink } = collect();
  wirePlainPrinting(agent, { ...sink, annotate: false });

  await agent.hooks.emit("tool_start", { call: { type: "tool_call" as const, id: "1", name: "read", arguments: { file: "a.ts" } } });

  assert.equal(err.join("").includes("read"), false, "tool annotation suppressed");
});

test("summarizeArgs bounds the one-line summary and never throws on odd values", () => {
  assert.equal(summarizeArgs({}), "");
  assert.equal(summarizeArgs({ a: "b" }), "a=b");
  assert.equal(summarizeArgs({ n: 1, ok: true }), "n=1 ok=true");

  const long = summarizeArgs({ path: "x".repeat(500) });
  assert.ok(long.length <= 80, `summary must stay bounded, got ${long.length}`);
  assert.ok(long.endsWith("…"), "a clipped summary is marked with an ellipsis");
});

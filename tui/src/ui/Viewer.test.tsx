/**
 * The full-screen transcript viewer.
 *
 * The scroll arithmetic is pure and tested directly; the component tests cover
 * what a user sees and the keys that get them there.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";

import { initialState, reduce, type TranscriptEvent, type TranscriptState } from "../model/transcript.js";
import { clampScroll, itemLines, jumpPrompt, transcriptLines, Viewer } from "./Viewer.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

function fold(events: TranscriptEvent[]): TranscriptState {
  let at = 0;
  return events.reduce<TranscriptState>((s, e) => reduce(s, { actingId: "root", ...e, at: ++at }), initialState());
}

const session = fold([
  { kind: "user", text: "first question" },
  { kind: "agent_start" },
  { kind: "reasoning_delta", text: "deliberating\nat length" },
  { kind: "tool_start", callId: "c1", name: "read", arguments: { file: "a.ts" } },
  { kind: "tool_end", callId: "c1", content: "file body line", isError: false },
  { kind: "text_delta", text: "the answer" },
  { kind: "agent_end", reason: "end_turn" },
  { kind: "user", text: "second question" },
]);

// -- pure scroll arithmetic --------------------------------------------------

test("clampScroll never scrolls past the end or before the start", () => {
  assert.equal(clampScroll(-5, 100, 10), 0);
  assert.equal(clampScroll(500, 100, 10), 90);
  assert.equal(clampScroll(20, 100, 10), 20);
});

test("a transcript shorter than the window cannot scroll at all", () => {
  assert.equal(clampScroll(5, 3, 10), 0);
});

test("jumpPrompt moves between user turns and stops at the ends", () => {
  const prompts = [0, 40, 90];

  assert.equal(jumpPrompt(prompts, 0, 1), 40);
  assert.equal(jumpPrompt(prompts, 40, 1), 90);
  assert.equal(jumpPrompt(prompts, 90, 1), 90, "no wrap past the last");
  assert.equal(jumpPrompt(prompts, 90, -1), 40);
  assert.equal(jumpPrompt(prompts, 0, -1), 0, "no wrap before the first");
});

// -- flattening --------------------------------------------------------------

test("collapsed shows a tool card as one line; full reveals args and result", () => {
  const card = session.items.find((i) => i.kind === "tool")!;

  assert.deepEqual(itemLines(card, false), ["✓ read"]);

  const full = itemLines(card, true);
  assert.ok(full.some((l) => l.includes("a.ts")), "arguments are revealed");
  assert.ok(full.some((l) => l.includes("file body line")), "and the result");
});

test("committed reasoning IS expandable here — unlike the main view", () => {
  const reasoning = session.items.find((i) => i.kind === "reasoning")!;

  assert.deepEqual(itemLines(reasoning, false), ["◆ Reasoning"]);
  assert.ok(itemLines(reasoning, true).some((l) => l.includes("at length")));
});

test("transcriptLines records where each user turn begins", () => {
  const { lines, prompts } = transcriptLines(session, true);

  assert.equal(prompts.length, 2, "two user turns");
  assert.equal(prompts[0], 0, "the first is at the top");
  assert.ok(lines[prompts[1]!]?.includes("second question"));
});

// -- the component -----------------------------------------------------------

test("the viewer renders the transcript and a position indicator", () => {
  const { lastFrame } = render(<Viewer state={session} onClose={() => {}} rows={40} />);
  const out = lastFrame() ?? "";

  assert.match(out, /first question/);
  assert.match(out, /the answer/);
  assert.match(out, /q close/);
});

test("q, Esc, and Ctrl+C all close it", async () => {
  for (const keys of ["q", "\x1b", "\x03"]) {
    let closed = 0;
    const { stdin } = render(<Viewer state={session} onClose={() => closed++} rows={40} />);

    stdin.write(keys);
    await tick();

    assert.equal(closed, 1, `${JSON.stringify(keys)} closes the viewer`);
  }
});

test("? shows the key reference", async () => {
  const { stdin, lastFrame } = render(<Viewer state={session} onClose={() => {}} rows={40} />);

  stdin.write("?");
  await tick();

  assert.match(lastFrame() ?? "", /previous \/ next prompt/);
});

test("Ctrl+E collapses the detail back down", async () => {
  const { stdin, lastFrame } = render(<Viewer state={session} onClose={() => {}} rows={40} />);
  assert.match(lastFrame() ?? "", /file body line/, "full by default");

  stdin.write("\x05"); // Ctrl+E
  await tick();

  assert.doesNotMatch(lastFrame() ?? "", /file body line/, "collapsed");
  assert.match(lastFrame() ?? "", /collapsed/, "and the indicator says so");
});

test("a short window scrolls, and G jumps to the bottom", async () => {
  const { stdin, lastFrame } = render(<Viewer state={session} onClose={() => {}} rows={5} />);
  assert.match(lastFrame() ?? "", /first question/, "starts at the top");

  stdin.write("G");
  await tick();

  assert.doesNotMatch(lastFrame() ?? "", /first question/, "scrolled away from the top");
  assert.match(lastFrame() ?? "", /second question/, "and the end is visible");
});

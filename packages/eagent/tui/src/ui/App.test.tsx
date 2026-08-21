/**
 * The app root's rendered output (AC10).
 *
 * Rendered through ink-testing-library, so these are assertions about what a
 * user actually sees — not about component internals. Offline by construction:
 * the state is built by folding events through the pure reducer, so no agent,
 * provider, or terminal is involved.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";

import { initialState, reduce, type TranscriptEvent, type TranscriptState } from "../model/transcript.js";
import { App } from "./App.js";

const status = { model: "mock", provider: "mock", live: false };

function fold(events: TranscriptEvent[]): TranscriptState {
  let at = 0;
  return events.reduce<TranscriptState>(
    (s, e) => reduce(s, { actingId: "root", ...e, at: ++at }),
    initialState(),
  );
}

function draw(state: TranscriptState): string {
  const { lastFrame } = render(
    <App state={state} onInterrupt={() => {}} onExit={() => {}} status={status} frame={0} />,
  );
  return lastFrame() ?? "";
}

test("AC10: a user turn and the streaming answer both render", () => {
  const out = draw(fold([{ kind: "user", text: "explain this" }, { kind: "text_delta", text: "Because…" }]));

  assert.match(out, /explain this/);
  assert.match(out, /Because…/);
});

test("AC10: a running tool renders as a card with its name and bounded args", () => {
  const out = draw(
    fold([
      { kind: "agent_start" },
      { kind: "tool_start", callId: "c1", name: "bash", arguments: { command: "npm test" } },
    ]),
  );

  assert.match(out, /bash/);
  assert.match(out, /command=npm test/);
});

test("AC10: live tool progress shows while running and the result marks failure", () => {
  const running = draw(
    fold([
      { kind: "agent_start" },
      { kind: "tool_start", callId: "c1", name: "bash", arguments: {} },
      { kind: "tool_progress", callId: "c1", chunk: "compiling\n" },
    ]),
  );
  assert.match(running, /compiling/, "progress is visible while the call runs");

  const failed = draw(
    fold([
      { kind: "tool_start", callId: "c1", name: "bash", arguments: {} },
      { kind: "tool_end", callId: "c1", content: "exit 1: boom", isError: true },
    ]),
  );
  assert.match(failed, /✗/, "a failed call is marked");
  assert.match(failed, /boom/);
});

test("a long build log is tailed, not dumped in full", () => {
  const chunks: TranscriptEvent[] = [
    { kind: "agent_start" },
    { kind: "tool_start", callId: "c1", name: "bash", arguments: {} },
  ];
  for (let i = 0; i < 50; i++) chunks.push({ kind: "tool_progress", callId: "c1", chunk: `line ${i}\n` });

  const out = draw(fold(chunks));

  assert.match(out, /line 49/, "the newest output is visible");
  assert.doesNotMatch(out, /line 0\b/, "the oldest is not — the card is bounded");
});

test("AC10: the spinner and interrupt hint show only while running", () => {
  const running = draw(fold([{ kind: "agent_start" }, { kind: "text_delta", text: "…" }]));
  assert.match(running, /esc to interrupt/);

  const idle = draw(fold([{ kind: "agent_start" }, { kind: "agent_end", reason: "end_turn" }]));
  assert.doesNotMatch(idle, /esc to interrupt/, "an idle TUI is quiet");
  assert.match(idle, /ctrl\+c to exit/);
});

test("finished reasoning collapses to a header; streaming reasoning shows", () => {
  const streaming = draw(fold([{ kind: "agent_start" }, { kind: "reasoning_delta", text: "deliberating" }]));
  assert.match(streaming, /deliberating/);

  const finished = draw(
    fold([
      { kind: "agent_start" },
      { kind: "reasoning_delta", text: "deliberating at length" },
      { kind: "agent_end", reason: "end_turn" },
    ]),
  );
  assert.match(finished, /Reasoning/, "collapsed to a header");
  assert.doesNotMatch(finished, /deliberating/, "the body is not flooding the window");
});

test("an abnormal stop reason surfaces as a notice", () => {
  const out = draw(fold([{ kind: "notice", text: "response truncated (max_tokens)" }]));

  assert.match(out, /response truncated/);
});

test("the status line names the model and flags the offline mock", () => {
  const out = draw(initialState());

  assert.match(out, /mock/);
  assert.match(out, /offline mock/);
});

// Ink parses input on its own tick; a bare ESC is ambiguous (it starts every
// escape sequence) so it is delivered only after the parser settles.
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

test("Esc interrupts a running turn and is inert when idle", async () => {
  let interrupts = 0;
  const running = fold([{ kind: "agent_start" }]);
  const { stdin } = render(
    <App state={running} onInterrupt={() => interrupts++} onExit={() => {}} status={status} frame={0} />,
  );

  stdin.write("\x1b");
  await tick();
  assert.equal(interrupts, 1, "Esc while running aborts the turn");

  const idle = render(
    <App state={initialState()} onInterrupt={() => interrupts++} onExit={() => {}} status={status} frame={0} />,
  );
  idle.stdin.write("\x1b");
  await tick();
  assert.equal(interrupts, 1, "Esc at idle does nothing");
});

test("Ctrl+C interrupts a running turn rather than exiting", async () => {
  let interrupts = 0;
  let exits = 0;
  const { stdin } = render(
    <App
      state={fold([{ kind: "agent_start" }])}
      onInterrupt={() => interrupts++}
      onExit={() => exits++}
      status={status}
      frame={0}
    />,
  );

  stdin.write("\x03");
  await tick();

  assert.equal(interrupts, 1, "the first Ctrl+C interrupts");
  assert.equal(exits, 0, "and does not exit");
});

test("Ctrl+C at idle exits", async () => {
  let exits = 0;
  const { stdin } = render(
    <App state={initialState()} onInterrupt={() => {}} onExit={() => exits++} status={status} frame={0} />,
  );

  stdin.write("\x03");
  await tick();

  assert.equal(exits, 1);
});

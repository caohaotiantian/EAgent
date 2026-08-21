/**
 * App WITH a live Prompt inside it.
 *
 * The gap a review found: every other App test omits `onSubmit`/`history`, so
 * the Prompt is never mounted, and every Prompt test renders it standalone. The
 * two `useInput` handlers were therefore never co-mounted anywhere in the suite
 * — and Ink fans each keypress to EVERY active handler with no way to stop
 * propagation, so a shared binding fires twice.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";

import { initialHistory } from "../input/history.js";
import type { SuggestContext } from "../input/suggest.js";
import { initialState, reduce, type TranscriptEvent, type TranscriptState } from "../model/transcript.js";
import type { Mode } from "../modes.js";
import { App } from "./App.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 60));
const status = { model: "mock", provider: "mock", live: false };

const suggestions: SuggestContext = {
  commands: () => [{ name: "help", description: "Show commands." }],
  readDir: () => [{ name: "README.md", isDirectory: false }],
};

function fold(events: TranscriptEvent[]): TranscriptState {
  let at = 0;
  return events.reduce<TranscriptState>((s, e) => reduce(s, { actingId: "root", ...e, at: ++at }), initialState());
}

function mount(state: TranscriptState = initialState()) {
  const modes: Mode[] = [];
  const submitted: string[] = [];
  const r = render(
    <App
      state={state}
      onInterrupt={() => {}}
      onExit={() => {}}
      status={status}
      frame={0}
      mode="manual"
      onModeChange={(m) => modes.push(m)}
      history={initialHistory()}
      onHistoryChange={() => {}}
      onSubmit={(t) => submitted.push(t)}
      suggestions={suggestions}
    />,
  );
  return { ...r, modes, submitted };
}

test("Shift+Tab cycles the mode when no popup is open", async () => {
  const { stdin, modes } = mount();

  stdin.write("\x1b[Z");
  await tick();

  assert.deepEqual(modes, ["plan"]);
});

test("Shift+Tab does NOT change the permission mode while the popup is open", async () => {
  const { stdin, modes, lastFrame } = mount();

  stdin.write("/h");
  await tick();
  assert.match(lastFrame() ?? "", /tab or enter to accept/, "the popup is open");

  stdin.write("\x1b[Z");
  await tick();

  // One keypress must not both accept a completion and silently change the
  // security posture behind a popup covering the mode indicator.
  assert.deepEqual(modes, [], "the mode was left alone");
});

test("after the popup closes, Shift+Tab cycles again", async () => {
  const { stdin, modes } = mount();

  stdin.write("/h");
  await tick();
  stdin.write("\x1b"); // dismiss
  await tick();
  stdin.write("\x1b[Z");
  await tick();

  assert.deepEqual(modes, ["plan"]);
});

test("typing reaches the prompt and Enter submits, with App mounted around it", async () => {
  const { stdin, submitted } = mount();

  stdin.write("a real question");
  await tick();
  stdin.write("\r");
  await tick();

  assert.deepEqual(submitted, ["a real question"]);
});

test("Ctrl+O opens the viewer and closing it PRESERVES the typed draft", async () => {
  const { stdin, lastFrame } = mount();

  stdin.write("half written thought");
  await tick();

  stdin.write("\x0f"); // Ctrl+O
  await tick();
  assert.match(lastFrame() ?? "", /q close/, "the viewer opened");

  stdin.write("q");
  await tick();

  // The prompt is unmounted while the viewer is up, so its buffer has to live
  // above it or the draft is silently lost.
  assert.match(lastFrame() ?? "", /half written thought/, "the draft survived");
});

test("a running turn disables the prompt but leaves Ctrl+O working", async () => {
  const { stdin, submitted, lastFrame } = mount(fold([{ kind: "agent_start" }]));

  stdin.write("ignored while running");
  await tick();
  stdin.write("\r");
  await tick();
  assert.deepEqual(submitted, [], "the transcript owns the keyboard mid-turn");

  stdin.write("\x0f");
  await tick();
  assert.match(lastFrame() ?? "", /q close/, "the viewer still opens");
});

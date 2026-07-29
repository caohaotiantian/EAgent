/**
 * The status area: mode indicator, task list, verbose toggle (AC13).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";

import { initialState, reduce, type TranscriptEvent, type TranscriptState } from "../model/transcript.js";
import { App } from "./App.js";
import { Status, TaskList, type Task } from "./Status.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 60));
const status = { model: "mock", provider: "mock", live: false };

function fold(events: TranscriptEvent[]): TranscriptState {
  let at = 0;
  return events.reduce<TranscriptState>((s, e) => reduce(s, { actingId: "root", ...e, at: ++at }), initialState());
}

test("AC13: the status bar names the active mode", () => {
  const { lastFrame } = render(
    <Status model="m" provider="p" live mode="plan" tokens={0} verbose={false} />,
  );

  assert.match(lastFrame() ?? "", /\[plan\]/);
});

test("the status bar shows tokens once a turn has used any", () => {
  const zero = render(<Status model="m" provider="p" live mode="manual" tokens={0} verbose={false} />);
  assert.doesNotMatch(zero.lastFrame() ?? "", /tok/);

  const some = render(<Status model="m" provider="p" live mode="manual" tokens={512} verbose={false} />);
  assert.match(some.lastFrame() ?? "", /512 tok/);
});

test("the offline mock is flagged so a missing API key is never silent", () => {
  const { lastFrame } = render(
    <Status model="m" provider="mock" live={false} mode="manual" tokens={0} verbose={false} />,
  );

  assert.match(lastFrame() ?? "", /offline mock/);
});

// -- task list --------------------------------------------------------------

const tasks: Task[] = [
  { content: "done thing", status: "completed" },
  { content: "current thing", status: "in_progress" },
  { content: "later thing", status: "pending" },
];

test("AC13: the task list renders each item with a status mark", () => {
  const { lastFrame } = render(<TaskList tasks={tasks} />);
  const out = lastFrame() ?? "";

  assert.match(out, /current thing/);
  assert.match(out, /✓ done thing/);
  assert.match(out, /◐ current thing/);
  assert.match(out, /○ later thing/);
});

test("unfinished work sorts above completed work", () => {
  const { lastFrame } = render(<TaskList tasks={tasks} />);
  const out = lastFrame() ?? "";

  assert.ok(
    out.indexOf("current thing") < out.indexOf("done thing"),
    "a long completed prefix must not bury what is in progress",
  );
});

test("AC13: the list is bounded to five rows with an overflow hint", () => {
  const many: Task[] = Array.from({ length: 9 }, (_, i) => ({
    content: `task ${i}`,
    status: "pending" as const,
  }));

  const out = render(<TaskList tasks={many} />).lastFrame() ?? "";

  assert.match(out, /… 4 more/, "the overflow is stated, not silently dropped");
  assert.doesNotMatch(out, /task 8/, "and the prompt is not pushed off screen");
});

test("an empty checklist renders nothing at all", () => {
  assert.equal((render(<TaskList tasks={[]} />).lastFrame() ?? "").trim(), "");
});

// -- keybindings ------------------------------------------------------------

test("AC13: Shift+Tab cycles the mode", async () => {
  const modes: string[] = [];
  const { stdin } = render(
    <App
      state={initialState()}
      onInterrupt={() => {}}
      onExit={() => {}}
      status={status}
      frame={0}
      mode="manual"
      onModeChange={(m) => modes.push(m)}
    />,
  );

  stdin.write("\x1b[Z"); // Shift+Tab
  await tick();

  assert.deepEqual(modes, ["acceptEdits"]);
});

test("AC13: Ctrl+T hides and shows the task list", async () => {
  const { stdin, lastFrame } = render(
    <App
      state={initialState()}
      onInterrupt={() => {}}
      onExit={() => {}}
      status={status}
      frame={0}
      tasks={tasks}
    />,
  );
  assert.match(lastFrame() ?? "", /current thing/, "shown by default");

  stdin.write("\x14"); // Ctrl+T
  await tick();
  assert.doesNotMatch(lastFrame() ?? "", /current thing/, "hidden");

  stdin.write("\x14");
  await tick();
  assert.match(lastFrame() ?? "", /current thing/, "and back");
});

test("AC13: Ctrl+O opens the full-screen transcript viewer", async () => {
  const { stdin, lastFrame } = render(
    <App state={fold([{ kind: "user", text: "a question" }])} onInterrupt={() => {}} onExit={() => {}} status={status} frame={0} />,
  );
  assert.doesNotMatch(lastFrame() ?? "", /q close/, "not open yet");

  stdin.write("\x0f"); // Ctrl+O
  await tick();

  assert.match(lastFrame() ?? "", /q close/, "the viewer took over the screen");
  assert.match(lastFrame() ?? "", /a question/);
});

test("AC13: Ctrl+V toggles verbose, revealing a live tool call's full result", async () => {
  // Verbose applies to the LIVE region and to items rendered from now on.
  // Committed history is painted once through <Static> and never repainted —
  // that is what keeps native scrollback intact, and it is the deliberate cost.
  const state = fold([
    { kind: "agent_start" },
    { kind: "tool_start", callId: "c1", name: "read", arguments: {} },
    { kind: "tool_end", callId: "c1", content: "the full file body", isError: false },
    { kind: "text_delta", text: "still streaming" },
  ]);
  const { stdin, lastFrame } = render(
    <App state={state} onInterrupt={() => {}} onExit={() => {}} status={status} frame={0} />,
  );
  assert.doesNotMatch(lastFrame() ?? "", /full file body/, "results are collapsed by default");

  stdin.write("\x16"); // Ctrl+V
  await tick();

  assert.match(lastFrame() ?? "", /full file body/, "verbose reveals the result");
});

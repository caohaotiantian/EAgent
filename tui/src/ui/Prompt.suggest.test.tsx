/**
 * The suggestion popup as a user drives it (AC12).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";

import { initialHistory } from "../input/history.js";
import type { SuggestContext } from "../input/suggest.js";
import { Prompt } from "./Prompt.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

const suggestions: SuggestContext = {
  commands: () => [
    { name: "help", description: "Show available commands." },
    { name: "model", description: "Get or set the model." },
  ],
  readDir: () => [
    { name: "src", isDirectory: true },
    { name: "README.md", isDirectory: false },
  ],
};

function mount() {
  const submitted: string[] = [];
  const r = render(
    <Prompt
      history={initialHistory()}
      onHistoryChange={() => {}}
      onSubmit={(t) => submitted.push(t)}
      suggestions={suggestions}
    />,
  );
  return { ...r, submitted };
}

test("AC12: typing / opens the command menu and filters as you type", async () => {
  const { stdin, lastFrame } = mount();

  stdin.write("/");
  await tick();
  assert.match(lastFrame() ?? "", /\/help/);
  assert.match(lastFrame() ?? "", /\/model/);

  stdin.write("mo");
  await tick();
  assert.match(lastFrame() ?? "", /\/model/);
  assert.doesNotMatch(lastFrame() ?? "", /\/help/, "filtered down");
});

test("AC12: Tab accepts the highlighted command", async () => {
  const { stdin, lastFrame } = mount();

  stdin.write("/mo");
  await tick();
  stdin.write("\t");
  await tick();

  assert.match(lastFrame() ?? "", /\/model/);
  assert.doesNotMatch(lastFrame() ?? "", /tab or enter to accept/, "the popup closed");
});

test("AC12: Enter accepts a suggestion rather than submitting the turn", async () => {
  const { stdin, submitted } = mount();

  stdin.write("/mo");
  await tick();
  stdin.write("\r");
  await tick();

  assert.deepEqual(submitted, [], "the first Enter took the suggestion");

  // A second Enter — with the popup now closed — submits.
  stdin.write("\r");
  await tick();
  assert.deepEqual(submitted, ["/model"]);
});

test("AC12: arrows move the highlight inside the popup, not the cursor", async () => {
  const { stdin, lastFrame } = mount();

  stdin.write("/");
  await tick();
  stdin.write("\x1b[B"); // Down
  await tick();
  stdin.write("\t");
  await tick();

  assert.match(lastFrame() ?? "", /\/model/, "the second entry was taken");
});

test("AC12: @ opens file suggestions inside a sentence", async () => {
  const { stdin, lastFrame } = mount();

  stdin.write("please read @RE");
  await tick();

  assert.match(lastFrame() ?? "", /README\.md/);
});

test("AC12: accepting a file splices it into the sentence", async () => {
  const { stdin, lastFrame } = mount();

  stdin.write("read @RE");
  await tick();
  stdin.write("\t");
  await tick();

  assert.match(lastFrame() ?? "", /read @README\.md/);
});

test("Esc dismisses the popup and lets the next Enter submit", async () => {
  const { stdin, lastFrame, submitted } = mount();

  stdin.write("/help");
  await tick();
  stdin.write("\x1b");
  await tick();
  assert.doesNotMatch(lastFrame() ?? "", /tab or enter to accept/);

  stdin.write("\r");
  await tick();
  assert.deepEqual(submitted, ["/help"]);
});

test("a query matching nothing shows no popup and does not block submission", async () => {
  const { stdin, lastFrame, submitted } = mount();

  stdin.write("/zzz");
  await tick();
  assert.doesNotMatch(lastFrame() ?? "", /tab or enter to accept/);

  stdin.write("\r");
  await tick();
  assert.deepEqual(submitted, ["/zzz"]);
});

test("ordinary prose never opens a popup", async () => {
  const { stdin, lastFrame } = mount();

  stdin.write("what does src/cli.ts do");
  await tick();

  assert.doesNotMatch(lastFrame() ?? "", /tab or enter to accept/);
});

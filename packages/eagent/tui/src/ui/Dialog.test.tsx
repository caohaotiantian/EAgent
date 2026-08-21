/**
 * The permission and elicitation dialogs (AC12).
 *
 * The security-relevant assertion here is `sanitize`: `decide` receives raw
 * model-authored arguments, and SECURITY.md says the kernel does not sanitize
 * them. A `command` carrying ANSI or carriage returns could otherwise repaint
 * the dialog's own chrome and change what the human believes they are approving.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";

import { Dialog, sanitize } from "./Dialog.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

const permissionChoices = [
  { value: "once", label: "Yes, once" },
  { value: "always", label: "Yes, and don't ask again" },
  { value: "reject", label: "No" },
];

function mount(props: Partial<Parameters<typeof Dialog<string>>[0]> = {}) {
  const answers: string[] = [];
  const r = render(
    <Dialog
      question={'Allow bash to use "shell:exec"?'}
      choices={permissionChoices}
      onAnswer={(v) => answers.push(v)}
      {...props}
    />,
  );
  return { ...r, answers };
}

test("AC12: the dialog shows the question and every choice", () => {
  const { lastFrame } = mount();
  const out = lastFrame() ?? "";

  assert.match(out, /Allow bash/);
  assert.match(out, /Yes, once/);
  assert.match(out, /don't ask again/);
  assert.match(out, /No/);
});

test("AC12: Enter answers with the highlighted choice", async () => {
  const { stdin, answers } = mount();

  stdin.write("\r");
  await tick();

  assert.deepEqual(answers, ["once"], "the first choice is highlighted by default");
});

test("AC12: arrows move the highlight", async () => {
  const { stdin, answers } = mount();

  stdin.write("\x1b[B"); // Down
  await tick();
  stdin.write("\r");
  await tick();

  assert.deepEqual(answers, ["always"]);
});

test("AC12: a digit picks a choice directly", async () => {
  const { stdin, answers } = mount();

  stdin.write("3");
  await tick();

  assert.deepEqual(answers, ["reject"]);
});

test("Up from the first choice wraps to the last", async () => {
  const { stdin, answers } = mount();

  stdin.write("\x1b[A");
  await tick();
  stdin.write("\r");
  await tick();

  assert.deepEqual(answers, ["reject"]);
});

test("AC12: the tool arguments render as the dialog's detail", () => {
  const { lastFrame } = mount({ detail: JSON.stringify({ command: "rm -rf build" }) });

  assert.match(lastFrame() ?? "", /rm -rf build/, "the human sees what is being authorized");
});

test("AC12: an elicitation accepts a free-text answer", async () => {
  const { stdin, answers, lastFrame } = mount({
    question: "Which database?",
    choices: [{ value: "postgres", label: "postgres" }],
    allowFreeText: true,
  });

  stdin.write("sqlite");
  await tick();
  assert.match(lastFrame() ?? "", /sqlite/, "typing switched to a free-text field");

  stdin.write("\r");
  await tick();
  assert.deepEqual(answers, ["sqlite"]);
});

test("free text is not offered when the caller did not allow it", async () => {
  const { stdin, answers } = mount();

  stdin.write("x");
  await tick();

  assert.deepEqual(answers, [], "a stray keystroke does not answer a permission ask");
});

// -- the security-relevant half ---------------------------------------------

test("sanitize strips control characters that could repaint the dialog", () => {
  const spoof = "ls\r\x1b[2K\x1b[Ayes, safe";

  const out = sanitize(spoof);

  assert.doesNotMatch(out, /\x1b/, "no escape sequences survive");
  assert.doesNotMatch(out, /\r/, "no carriage returns survive");
  assert.match(out, /ls/, "the real content is still shown");
});

test("sanitize bounds the length so a huge argument cannot scroll the choices away", () => {
  const out = sanitize("x".repeat(5000));

  assert.ok(out.length <= 400);
  assert.ok(out.endsWith("…"));
});

test("sanitize collapses newlines so a multi-line command stays one line", () => {
  assert.equal(sanitize("a\nb\n\nc"), "a b c");
});

test("a detail carrying ANSI renders it inert, as visible text", () => {
  const { lastFrame } = mount({ detail: "safe\x1b[31mRED" });
  const out = lastFrame() ?? "";

  // The ESC byte is removed, so what is left ("[31m") is ordinary characters the
  // terminal prints rather than a color command it obeys. That is the point: the
  // argument can no longer influence how the dialog is drawn.
  assert.doesNotMatch(out, /\x1b\[31m/, "the injected escape sequence did not survive");
  assert.match(out, /\[31mRED/, "its bytes render as inert text instead");
});

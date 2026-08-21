/**
 * The modal dialogs — permission requests and mid-turn elicitation.
 *
 * Both are the same shape: a question, a list of choices, arrow keys, Enter.
 * `Choice` is generic so the permission dialog's three-way answer and the ask
 * tool's arbitrary option list share one component and one set of keybindings.
 *
 * The permission dialog renders the tool's ARGUMENTS, which is the whole reason
 * `UI.decide` takes a structured request rather than `confirm`'s pre-formatted
 * sentence. Those arguments are model-authored and therefore attacker-influenced
 * under prompt injection, so they are escaped and bounded here — `SECURITY.md`
 * says the kernel does not sanitize them and the renderer must.
 */

import { Box, Text, useInput } from "ink";
import { useState, type ReactElement } from "react";

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
}

export interface DialogProps<T> {
  question: string;
  choices: Choice<T>[];
  onAnswer: (value: T) => void;
  /** Rendered above the choices — the tool arguments, for a permission ask. */
  detail?: string;
  /** Free-text answers are allowed (the ask tool); typing switches to a field. */
  allowFreeText?: boolean;
  /** Answer used when the dialog is cancelled with Esc. A permission ask passes
   *  a value that denies; an elicitation passes its "no answer" sentinel. */
  cancelValue?: T;
}

/**
 * Strip control characters and bound the length. A `command` containing ANSI or
 * `\r` could otherwise redraw the dialog's own chrome and spoof what the human
 * believes they are approving.
 */
export function sanitize(text: string, max = 400): string {
  const flat = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

export function Dialog<T>({
  question,
  choices,
  onAnswer,
  detail,
  allowFreeText = false,
  cancelValue,
}: DialogProps<T>): ReactElement {
  const [index, setIndex] = useState(0);
  const [free, setFree] = useState<string | null>(null);

  useInput((input, key) => {
    if (free !== null) {
      if (key.return) {
        // A free-text answer is only meaningful when the caller accepts one, and
        // the ask tool's contract takes the string itself as the value.
        onAnswer(free as unknown as T);
        return;
      }
      if (key.escape) return setFree(null);
      if (key.backspace || key.delete) return setFree(free.slice(0, -1));
      if (input && !key.ctrl && !key.meta) setFree(free + input);
      return;
    }

    // Esc and Ctrl+C cancel. A modal with no escape hatch is a trap: App's
    // handler is inert while one is open, and exitOnCtrlC is off, so without
    // this the only way out of a permission prompt is to answer it.
    if (key.escape || (key.ctrl && input === "c")) {
      if (cancelValue !== undefined) onAnswer(cancelValue);
      return;
    }
    if (key.upArrow) return setIndex((i) => (i === 0 ? choices.length - 1 : i - 1));
    if (key.downArrow) return setIndex((i) => (i + 1) % choices.length);
    if (key.return) {
      const chosen = choices[index];
      if (chosen) onAnswer(chosen.value);
      return;
    }
    // Free text wins when it is allowed: an elicitation answer may legitimately
    // begin with a digit, and shadowing it would make that answer untypeable.
    if (allowFreeText && input && !key.ctrl && !key.meta) return setFree(input);
    // Otherwise a single digit picks a choice — faster than arrowing for a
    // three-way answer. Matched strictly, since Number() also accepts "1e0".
    if (/^[1-9]$/.test(input)) {
      const chosen = choices[Number(input) - 1];
      if (chosen) onAnswer(chosen.value);
    }
  });

  if (free !== null) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="yellow">? {question}</Text>
        <Text>
          <Text color="cyan">› </Text>
          {free}
        </Text>
        <Text dimColor>enter to answer · esc to go back to the options</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="yellow">? {question}</Text>
      {detail ? <Text dimColor>{sanitize(detail)}</Text> : null}
      {choices.map((c, i) => (
        <Text key={c.label} color={i === index ? "cyan" : undefined}>
          {i === index ? "❯" : " "} {i + 1}. {c.label}
          {c.hint ? <Text dimColor> — {c.hint}</Text> : null}
        </Text>
      ))}
      <Text dimColor>
        ↑↓ to move · enter to choose{allowFreeText ? " · or type your own answer" : ""}
      </Text>
    </Box>
  );
}

/**
 * The prompt editor — a pure reducer over (text, cursor).
 *
 * Every keybinding is a state transition here, so the whole editing surface is
 * testable without a terminal, a component, or a keypress parser. The Ink layer
 * above only translates Ink's `(input, key)` into these actions and draws the
 * result.
 *
 * Text is held as one string with a character offset rather than a line array:
 * the readline bindings (`Ctrl+A`, `Ctrl+W`, kill-ring) are defined over a flat
 * buffer, and multiline is just a buffer containing `\n`. Converting to lines
 * happens only for display and for the up/down-arrow boundary rule.
 */

export interface EditorState {
  text: string;
  /** Character offset of the cursor within `text`. */
  cursor: number;
  /** Kill ring — what `Ctrl+Y` pastes. Most recent first. */
  kills: string[];
  /** Undo stack of prior (text, cursor) pairs, for `Ctrl+_`. */
  history: { text: string; cursor: number }[];
}

export type Action =
  | { kind: "insert"; text: string }
  | { kind: "newline" }
  | { kind: "backspace" }
  | { kind: "delete" }
  | { kind: "left" }
  | { kind: "right" }
  | { kind: "wordLeft" }
  | { kind: "wordRight" }
  | { kind: "lineStart" }
  | { kind: "lineEnd" }
  | { kind: "killToEnd" }
  | { kind: "killToStart" }
  | { kind: "killWord" }
  | { kind: "yank" }
  | { kind: "undo" }
  | { kind: "clear" }
  | { kind: "set"; text: string };

export function initialEditor(text = ""): EditorState {
  return { text, cursor: text.length, kills: [], history: [] };
}

const MAX_UNDO = 100;

/** Snapshot for undo. Only mutating actions call this. */
function remember(s: EditorState): { text: string; cursor: number }[] {
  return [...s.history, { text: s.text, cursor: s.cursor }].slice(-MAX_UNDO);
}

/** Start of the logical line containing `cursor` (multiline-aware `Ctrl+A`). */
export function lineStartOf(text: string, cursor: number): number {
  const nl = text.lastIndexOf("\n", cursor - 1);
  return nl === -1 ? 0 : nl + 1;
}

/** End of the logical line containing `cursor`. */
export function lineEndOf(text: string, cursor: number): number {
  const nl = text.indexOf("\n", cursor);
  return nl === -1 ? text.length : nl;
}

/** Offset of the previous word boundary, skipping trailing whitespace first. */
function prevWord(text: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && /\s/.test(text[i - 1]!)) i--;
  while (i > 0 && !/\s/.test(text[i - 1]!)) i--;
  return i;
}

function nextWord(text: string, cursor: number): number {
  let i = cursor;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  while (i < text.length && !/\s/.test(text[i]!)) i++;
  return i;
}

/** Push onto the kill ring, skipping empty kills so `Ctrl+Y` is never a no-op. */
function kill(s: EditorState, removed: string): string[] {
  return removed === "" ? s.kills : [removed, ...s.kills].slice(0, 20);
}

export function reduceEditor(s: EditorState, a: Action): EditorState {
  const before = s.text.slice(0, s.cursor);
  const after = s.text.slice(s.cursor);

  switch (a.kind) {
    case "insert":
      return { ...s, history: remember(s), text: before + a.text + after, cursor: s.cursor + a.text.length };

    case "newline":
      return { ...s, history: remember(s), text: before + "\n" + after, cursor: s.cursor + 1 };

    case "backspace": {
      if (s.cursor === 0) return s;
      return { ...s, history: remember(s), text: before.slice(0, -1) + after, cursor: s.cursor - 1 };
    }

    case "delete": {
      if (s.cursor >= s.text.length) return s;
      return { ...s, history: remember(s), text: before + after.slice(1) };
    }

    case "left":
      return s.cursor === 0 ? s : { ...s, cursor: s.cursor - 1 };

    case "right":
      return s.cursor >= s.text.length ? s : { ...s, cursor: s.cursor + 1 };

    case "wordLeft":
      return { ...s, cursor: prevWord(s.text, s.cursor) };

    case "wordRight":
      return { ...s, cursor: nextWord(s.text, s.cursor) };

    case "lineStart":
      return { ...s, cursor: lineStartOf(s.text, s.cursor) };

    case "lineEnd":
      return { ...s, cursor: lineEndOf(s.text, s.cursor) };

    case "killToEnd": {
      const end = lineEndOf(s.text, s.cursor);
      // At the end of a line, kill the newline itself so repeated Ctrl+K joins
      // lines the way readline does rather than stalling.
      const to = end === s.cursor ? Math.min(end + 1, s.text.length) : end;
      const removed = s.text.slice(s.cursor, to);
      if (removed === "") return s;
      return { ...s, history: remember(s), kills: kill(s, removed), text: before + s.text.slice(to) };
    }

    case "killToStart": {
      const start = lineStartOf(s.text, s.cursor);
      // On an empty line the cursor is already at the start; consume the newline
      // so repeated Ctrl+U clears upward instead of stalling.
      const from = start === s.cursor ? Math.max(start - 1, 0) : start;
      const removed = s.text.slice(from, s.cursor);
      if (removed === "") return s;
      return { ...s, history: remember(s), kills: kill(s, removed), text: s.text.slice(0, from) + after, cursor: from };
    }

    case "killWord": {
      const from = prevWord(s.text, s.cursor);
      const removed = s.text.slice(from, s.cursor);
      if (removed === "") return s;
      return { ...s, history: remember(s), kills: kill(s, removed), text: s.text.slice(0, from) + after, cursor: from };
    }

    case "yank": {
      const top = s.kills[0];
      if (top === undefined) return s;
      return { ...s, history: remember(s), text: before + top + after, cursor: s.cursor + top.length };
    }

    case "undo": {
      const prev = s.history[s.history.length - 1];
      if (prev === undefined) return s;
      return { ...s, text: prev.text, cursor: prev.cursor, history: s.history.slice(0, -1) };
    }

    case "clear":
      return s.text === "" ? s : { ...s, history: remember(s), text: "", cursor: 0 };

    case "set":
      return { ...s, history: remember(s), text: a.text, cursor: a.text.length };
  }
}

// -- cursor geometry, for the up/down-arrow boundary rule --------------------

/** Which logical line the cursor sits on, and its column. */
export function cursorRowCol(text: string, cursor: number): { row: number; col: number } {
  const upto = text.slice(0, cursor);
  const row = upto.split("\n").length - 1;
  return { row, col: cursor - lineStartOf(text, cursor) };
}

export const lineCount = (text: string): number => text.split("\n").length;

/**
 * Up/Down move within a multiline prompt until the cursor is on the first or
 * last line; only then do they reach command history. Returns the new cursor, or
 * `null` meaning "this keypress belongs to history".
 */
export function verticalMove(text: string, cursor: number, dir: -1 | 1): number | null {
  const { row, col } = cursorRowCol(text, cursor);
  const target = row + dir;
  if (target < 0 || target >= lineCount(text)) return null;

  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < target; i++) offset += (lines[i]?.length ?? 0) + 1;
  return offset + Math.min(col, lines[target]?.length ?? 0);
}

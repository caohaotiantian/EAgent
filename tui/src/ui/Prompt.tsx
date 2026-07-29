/**
 * The prompt input.
 *
 * This component owns no editing logic — it translates Ink's `(input, key)` into
 * editor and history actions and draws the result. Every behaviour worth testing
 * lives in `input/editor.ts` and `input/history.ts`, which is why this file has
 * no branching beyond key dispatch.
 *
 * Newline bindings follow the terminal reality that plain `Enter` must submit:
 * `Ctrl+J` works everywhere, and a trailing backslash before `Enter` is the
 * escape hatch for emulators that send nothing distinguishable for the rest.
 */

import { Box, Text, useInput } from "ink";
import { useState, type ReactElement } from "react";

import {
  initialEditor,
  reduceEditor,
  verticalMove,
  type Action,
  type EditorState,
} from "../input/editor.js";
import {
  initialSearch,
  matchText,
  navigate,
  searchBackward,
  type HistoryState,
  type SearchState,
} from "../input/history.js";

export interface PromptProps {
  history: HistoryState;
  onHistoryChange: (h: HistoryState) => void;
  onSubmit: (text: string) => void;
  /** Shown dimmed when the buffer is empty. */
  placeholder?: string;
  /** Disabled while a turn runs — the transcript owns the keyboard then. */
  disabled?: boolean;
}

export function Prompt({
  history,
  onHistoryChange,
  onSubmit,
  placeholder = "ask anything · ctrl+j for a newline · ctrl+r to search",
  disabled = false,
}: PromptProps): ReactElement {
  const [ed, setEd] = useState<EditorState>(() => initialEditor());
  const [search, setSearch] = useState<SearchState | null>(null);

  const apply = (a: Action): void => setEd((s) => reduceEditor(s, a));

  useInput(
    (input, key) => {
      // -- reverse search owns the keyboard while it is open ------------------
      if (search !== null) {
        if (key.escape || (key.ctrl && input === "g")) {
          setSearch(null);
          return;
        }
        if (key.return || key.tab) {
          const picked = matchText(history.entries, search.match);
          if (picked) apply({ kind: "set", text: picked });
          setSearch(null);
          return;
        }
        if (key.ctrl && input === "r") {
          // Cycle to the next older match, keeping the query.
          const next = searchBackward(history.entries, search.query, search.match);
          setSearch({ ...search, match: next === -1 ? search.match : next });
          return;
        }
        if (key.backspace || key.delete) {
          const query = search.query.slice(0, -1);
          setSearch({ query, match: searchBackward(history.entries, query) });
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          const query = search.query + input;
          setSearch({ query, match: searchBackward(history.entries, query) });
        }
        return;
      }

      if (key.ctrl && input === "r") {
        setSearch(initialSearch());
        return;
      }

      // -- submission ---------------------------------------------------------
      if (key.return) {
        // A trailing backslash means "newline", not "submit" — the escape hatch
        // for terminals that cannot send a distinguishable Shift+Enter.
        if (ed.text.endsWith("\\")) {
          setEd((s) => reduceEditor(reduceEditor(s, { kind: "backspace" }), { kind: "newline" }));
          return;
        }
        const text = ed.text.trim();
        if (text === "") return;
        onSubmit(text);
        setEd(initialEditor());
        return;
      }
      if (key.ctrl && input === "j") return apply({ kind: "newline" });

      // -- readline motion and killing ---------------------------------------
      if (key.ctrl && input === "a") return apply({ kind: "lineStart" });
      if (key.ctrl && input === "e") return apply({ kind: "lineEnd" });
      if (key.ctrl && input === "k") return apply({ kind: "killToEnd" });
      if (key.ctrl && input === "u") return apply({ kind: "killToStart" });
      if (key.ctrl && input === "w") return apply({ kind: "killWord" });
      if (key.ctrl && input === "y") return apply({ kind: "yank" });
      if (key.ctrl && input === "_") return apply({ kind: "undo" });
      if (key.meta && input === "b") return apply({ kind: "wordLeft" });
      if (key.meta && input === "f") return apply({ kind: "wordRight" });

      if (key.leftArrow) return apply({ kind: "left" });
      if (key.rightArrow) return apply({ kind: "right" });
      if (key.backspace) return apply({ kind: "backspace" });
      if (key.delete) return apply({ kind: "delete" });

      // -- history, but only once the cursor is on the first/last visual row ---
      if (key.upArrow || key.downArrow) {
        const dir = key.upArrow ? -1 : 1;
        const moved = verticalMove(ed.text, ed.cursor, dir);
        if (moved !== null) {
          setEd((s) => ({ ...s, cursor: moved }));
          return;
        }
        const step = navigate(history, dir, ed.text);
        if (step) {
          onHistoryChange(step.state);
          apply({ kind: "set", text: step.text });
        }
        return;
      }

      // Printable text — including a bracketed paste, which Ink delivers as one
      // multi-character `input`, so a pasted block arrives intact.
      if (input && !key.ctrl && !key.meta) apply({ kind: "insert", text: input });
    },
    { isActive: !disabled },
  );

  if (search !== null) {
    const hit = matchText(history.entries, search.match);
    return (
      <Box>
        <Text color="yellow">(reverse-i-search)`{search.query}': </Text>
        <Text>{hit || <Text dimColor>no match</Text>}</Text>
      </Box>
    );
  }

  const lines = ed.text.split("\n");
  return (
    <Box flexDirection="column">
      {ed.text === "" ? (
        <Text>
          <Text color="cyan">› </Text>
          <Text dimColor>{placeholder}</Text>
        </Text>
      ) : (
        lines.map((line, i) => (
          <Text key={i}>
            <Text color="cyan">{i === 0 ? "› " : "  "}</Text>
            {line}
          </Text>
        ))
      )}
    </Box>
  );
}

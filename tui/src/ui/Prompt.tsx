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
import { accept, findTrigger, suggest, type SuggestContext } from "../input/suggest.js";
import { Suggestions } from "./Suggestions.js";

export interface PromptProps {
  history: HistoryState;
  onHistoryChange: (h: HistoryState) => void;
  onSubmit: (text: string) => void;
  /** Shown dimmed when the buffer is empty. */
  placeholder?: string;
  /** Disabled while a turn runs — the transcript owns the keyboard then. */
  disabled?: boolean;
  /** Suggestion sources. Omitted in tests that only exercise editing. */
  suggestions?: SuggestContext;
  /** Ctrl+G: hand the buffer to $EDITOR and resolve with what came back.
   *  Injected so tests never spawn a process. */
  externalEdit?: (text: string) => Promise<string | null>;
}

export function Prompt({
  history,
  onHistoryChange,
  onSubmit,
  placeholder = "ask anything · ctrl+j for a newline · ctrl+r to search",
  disabled = false,
  suggestions,
  externalEdit,
}: PromptProps): ReactElement {
  const [ed, setEd] = useState<EditorState>(() => initialEditor());
  const [search, setSearch] = useState<SearchState | null>(null);
  const [pick, setPick] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const apply = (a: Action): void => setEd((s) => reduceEditor(s, a));

  // Recomputed every render from the buffer, so the popup can never disagree
  // with what is typed — there is no separate popup state to fall out of sync.
  const trigger = suggestions && !dismissed ? findTrigger(ed.text, ed.cursor) : null;
  const hits = trigger && suggestions ? suggest(trigger, suggestions) : [];
  const popupOpen = hits.length > 0;
  const chosen = hits[Math.min(pick, hits.length - 1)];

  const take = (): void => {
    if (!trigger || !chosen) return;
    const next = accept(ed.text, ed.cursor, trigger, chosen);
    setEd((s) => ({ ...s, text: next.text, cursor: next.cursor, history: [...s.history, { text: s.text, cursor: s.cursor }] }));
    setPick(0);
  };

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

      // -- the suggestion popup owns arrows, tab, and enter while open --------
      if (popupOpen) {
        if (key.escape) {
          setDismissed(true);
          return;
        }
        if (key.tab || key.return) {
          take();
          return;
        }
        if (key.upArrow) {
          setPick((i) => (i === 0 ? hits.length - 1 : i - 1));
          return;
        }
        if (key.downArrow) {
          setPick((i) => (i + 1) % hits.length);
          return;
        }
      }
      // Typing after a dismissal re-opens the popup for the NEXT trigger.
      if (dismissed && (key.backspace || input)) setDismissed(false);

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
      if (key.ctrl && input === "g" && externalEdit) {
        void externalEdit(ed.text).then((edited) => {
          if (edited !== null) apply({ kind: "set", text: edited });
        });
        return;
      }

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

      // Printable text, which may arrive as one multi-character chunk: a paste,
      // or fast typing the terminal coalesced. Ink reports such a chunk with
      // `key.return === false` even when it ENDS in a carriage return, so the
      // submit branch above never sees it — inserting it verbatim would leave a
      // stray control character in the buffer and silently swallow the Enter.
      // Split it: interior newlines are real (a multi-line paste), a trailing
      // one is the submit the user pressed.
      if (input && !key.ctrl && !key.meta) {
        // A SINGLE character is a keypress, not a chunk. A lone newline is
        // Ctrl+J (which some terminals deliver as a bare \n with no ctrl flag),
        // so it inserts a line break rather than submitting.
        if (input.length === 1) {
          if (input === "\n" || input === "\r") return apply({ kind: "newline" });
          return apply({ kind: "insert", text: input });
        }

        const trailing = /[\r\n]$/.test(input);
        const normalized = input.replace(/[\r\n]+$/, "").replace(/\r\n?/g, "\n");
        if (normalized) apply({ kind: "insert", text: normalized });
        if (trailing) {
          const text = (ed.text + normalized).trim();
          if (text !== "") {
            onSubmit(text);
            setEd(initialEditor());
          }
        }
      }
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

  const shell = ed.text.startsWith("!");
  const glyph = shell ? "! " : "› ";
  const glyphColor = shell ? "magenta" : "cyan";
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
            <Text color={glyphColor}>{i === 0 ? glyph : "  "}</Text>
            {i === 0 && shell ? line.slice(1) : line}
          </Text>
        ))
      )}
      <Suggestions items={hits} index={Math.min(pick, Math.max(hits.length - 1, 0))} />
    </Box>
  );
}

/**
 * Prompt history and reverse search — pure, like the editor.
 *
 * Two behaviours a user notices immediately if they are wrong: submitting the
 * same prompt twice must record one entry (so Up steps to the previous
 * *distinct* prompt), and starting to navigate must stash the draft so
 * navigating back returns what was being typed rather than losing it.
 */

export interface HistoryState {
  /** Newest last. */
  entries: string[];
  /** How far back the user has navigated; 0 means "at the live draft". */
  offset: number;
  /** The draft stashed when navigation began, restored on the way back. */
  draft: string;
}

export function initialHistory(entries: string[] = []): HistoryState {
  return { entries, offset: 0, draft: "" };
}

/** Record a submitted prompt. A consecutive duplicate does not add an entry. */
export function record(s: HistoryState, text: string): HistoryState {
  const trimmed = text.trim();
  if (trimmed === "") return { ...s, offset: 0, draft: "" };
  if (s.entries[s.entries.length - 1] === trimmed) return { ...s, offset: 0, draft: "" };
  return { entries: [...s.entries, trimmed], offset: 0, draft: "" };
}

/**
 * Step through history. `dir` is -1 for older (Up) and 1 for newer (Down).
 * Returns the new state and the text to place in the editor, or `null` when the
 * move is not possible — already at the oldest entry, or at the live draft.
 */
export function navigate(
  s: HistoryState,
  dir: -1 | 1,
  currentText: string,
): { state: HistoryState; text: string } | null {
  const next = s.offset - dir;
  if (next < 0 || next > s.entries.length) return null;

  // Entering history stashes the draft so coming back restores it.
  const draft = s.offset === 0 ? currentText : s.draft;
  if (next === 0) return { state: { ...s, offset: 0, draft: "" }, text: draft };

  const text = s.entries[s.entries.length - next];
  if (text === undefined) return null;
  return { state: { ...s, offset: next, draft }, text };
}

export interface SearchState {
  query: string;
  /** Index into `entries` of the current match, or -1 for none. */
  match: number;
}

export const initialSearch = (): SearchState => ({ query: "", match: -1 });

/**
 * Reverse-incremental search: newest first, duplicates collapsed to the newest
 * occurrence. `from` is exclusive, so pressing `Ctrl+R` again cycles to the next
 * older match rather than re-finding the current one.
 */
export function searchBackward(entries: string[], query: string, from?: number): number {
  if (query === "") return -1;
  const start = from === undefined ? entries.length - 1 : from - 1;
  const needle = query.toLowerCase();
  for (let i = start; i >= 0; i--) {
    if ((entries[i] ?? "").toLowerCase().includes(needle)) return i;
  }
  return -1;
}

/** The match text, or the empty string when nothing matches. */
export const matchText = (entries: string[], match: number): string =>
  match >= 0 ? entries[match] ?? "" : "";

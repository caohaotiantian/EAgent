/**
 * The full-screen transcript viewer (`Ctrl+O`).
 *
 * Opens the terminal's ALTERNATE screen, so the whole conversation can be
 * scrolled without disturbing the scrollback the main view has been writing.
 * Leaving restores the previous screen exactly — which is the entire reason to
 * use the alternate buffer rather than painting over the session in place.
 *
 * This is the one place a display toggle can reveal committed history: the main
 * view's `<Static>` region is written once and never repainted, so expanding a
 * finished card there is impossible by construction. Here the transcript is
 * re-rendered from the model, so everything is expandable.
 */

import { Box, Text, useInput, useStdout } from "ink";
import { useEffect, useState, type ReactElement } from "react";

import type { Item, TranscriptState } from "../model/transcript.js";

/** Enter / leave the alternate screen buffer. */
const ENTER_ALT = "\x1b[?1049h";
const LEAVE_ALT = "\x1b[?1049l";

export interface ViewerProps {
  state: TranscriptState;
  onClose: () => void;
  /** Terminal height; injected in tests, which have no real window. */
  rows?: number;
}

/** Flatten one item into display lines. `showAll` reveals what a card collapses. */
export function itemLines(item: Item, showAll: boolean): string[] {
  if (item.kind === "tool") {
    const mark = item.status === "error" ? "✗" : "✓";
    const head = `${mark} ${item.name}`;
    if (!showAll) return [head];
    const out = [head, `  args: ${JSON.stringify(item.arguments)}`];
    if (item.progress) out.push(...item.progress.split("\n").filter(Boolean).map((l) => `  ${l}`));
    if (item.result) out.push(...item.result.content.split("\n").map((l) => `  ${l}`));
    return out;
  }
  if (item.kind === "user") return [`› ${item.text}`];
  if (item.kind === "notice") return [`⚠ ${item.text}`];
  if (item.kind === "reasoning") {
    return showAll ? ["◆ Reasoning", ...item.text.split("\n").map((l) => `  ${l}`)] : ["◆ Reasoning"];
  }
  return item.text.split("\n");
}

/** Every line of the transcript, plus the offsets where a user turn begins —
 *  what `{` and `}` jump between, like vim's paragraph motion. */
export function transcriptLines(
  state: TranscriptState,
  showAll: boolean,
): { lines: string[]; prompts: number[] } {
  const lines: string[] = [];
  const prompts: number[] = [];
  for (const item of state.items) {
    if (item.kind === "user") prompts.push(lines.length);
    lines.push(...itemLines(item, showAll));
  }
  return { lines, prompts };
}

/** Clamp a scroll offset to the scrollable range. */
export const clampScroll = (offset: number, total: number, height: number): number =>
  Math.max(0, Math.min(offset, Math.max(0, total - height)));

/** The next prompt offset in `dir`, or the current one when there is none. */
export function jumpPrompt(prompts: number[], current: number, dir: -1 | 1): number {
  if (dir === 1) return prompts.find((p) => p > current) ?? current;
  return [...prompts].reverse().find((p) => p < current) ?? current;
}

export function Viewer({ state, onClose, rows }: ViewerProps): ReactElement {
  const { stdout } = useStdout();
  const [scroll, setScroll] = useState(0);
  const [showAll, setShowAll] = useState(true);
  const [help, setHelp] = useState(false);

  // Entered on mount, left on unmount, so every exit path — q, Esc, Ctrl+C —
  // restores the session view without extra bookkeeping.
  //
  // Written to the real terminal rather than through `useStdout()`: that stream
  // is Ink's frame buffer, and a raw escape pushed into it would BE the frame.
  // Guarded on isTTY so a test (or a pipe) never receives the sequence at all.
  useEffect(() => {
    if (!process.stdout.isTTY) return;
    process.stdout.write(ENTER_ALT);
    return () => {
      process.stdout.write(LEAVE_ALT);
    };
  }, []);

  const height = Math.max(1, (rows ?? stdout?.rows ?? 24) - 2);
  const { lines, prompts } = transcriptLines(state, showAll);
  const max = Math.max(0, lines.length - height);

  useInput((input, key) => {
    if (input === "q" || key.escape || (key.ctrl && input === "c")) return onClose();
    if (input === "?") return setHelp((v) => !v);
    if (key.ctrl && input === "e") return setShowAll((v) => !v);

    if (key.upArrow || input === "k") return setScroll((s) => clampScroll(s - 1, lines.length, height));
    if (key.downArrow || input === "j") return setScroll((s) => clampScroll(s + 1, lines.length, height));
    if (key.pageUp) return setScroll((s) => clampScroll(s - height, lines.length, height));
    if (key.pageDown) return setScroll((s) => clampScroll(s + height, lines.length, height));
    if (input === "g") return setScroll(0);
    if (input === "G") return setScroll(max);
    if (input === "{") return setScroll((s) => clampScroll(jumpPrompt(prompts, s, -1), lines.length, height));
    if (input === "}") return setScroll((s) => clampScroll(jumpPrompt(prompts, s, 1), lines.length, height));
  });

  if (help) {
    return (
      <Box flexDirection="column">
        <Text bold>transcript viewer</Text>
        <Text>↑↓ / j k   scroll</Text>
        <Text>pgup pgdn  page</Text>
        <Text>g / G      top / bottom</Text>
        <Text>{"{ / }      previous / next prompt"}</Text>
        <Text>ctrl+e     toggle full detail</Text>
        <Text>? q esc    help off / close</Text>
      </Box>
    );
  }

  const window = lines.slice(scroll, scroll + height);
  return (
    <Box flexDirection="column">
      {window.map((l, i) => (
        <Text key={i}>{l}</Text>
      ))}
      <Text dimColor>
        {scroll + window.length}/{lines.length} · {showAll ? "full" : "collapsed"} · ? help · q close
      </Text>
    </Box>
  );
}

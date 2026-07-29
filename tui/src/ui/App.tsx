/**
 * The app root.
 *
 * Two regions, which is the whole architecture:
 *   - `<Static>` — finished items, written to the terminal exactly once and
 *     never repainted, so native scrollback stays intact and a long session
 *     costs nothing to re-render.
 *   - the live tail — the items still streaming, plus the status line. Only this
 *     repaints.
 *
 * The reducer guarantees the boundary never moves backwards (a committed item
 * cannot re-enter the tail), which is exactly the invariant `<Static>` requires
 * and what `transcript.test.ts` pins.
 */

import { Box, Static, Text, useApp, useInput } from "ink";
import { useEffect, useState, type ReactElement } from "react";

import { partition, type TranscriptState } from "../model/transcript.js";
import { ItemView } from "./items.js";

/** Braille spinner frames — the same set the old renderer used. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export interface AppProps {
  state: TranscriptState;
  /** Abort the in-flight turn (Esc, or the first Ctrl+C). */
  onInterrupt: () => void;
  /** Leave the program (Ctrl+C at idle, Ctrl+D). */
  onExit: () => void;
  status: { model: string; provider: string; live: boolean };
  /** Injected in tests so the spinner does not need a real timer. */
  frame?: number;
}

function Spinner({ frame }: { frame: number }): ReactElement {
  return <Text color="cyan">{FRAMES[frame % FRAMES.length]}</Text>;
}

export function App({ state, onInterrupt, onExit, status, frame }: AppProps): ReactElement {
  const { exit } = useApp();
  const [tick, setTick] = useState(0);

  // The spinner is the only thing driving repaints while a tool runs, so it is
  // stopped the moment the turn ends — an idle TUI must be completely quiet.
  useEffect(() => {
    if (!state.running || frame !== undefined) return;
    const t = setInterval(() => setTick((n) => n + 1), 80);
    return () => clearInterval(t);
  }, [state.running, frame]);

  useInput((input, key) => {
    if (key.escape) {
      if (state.running) onInterrupt();
      return;
    }
    if (key.ctrl && input === "c") {
      // First press interrupts a running turn; at idle it leaves.
      if (state.running) onInterrupt();
      else {
        onExit();
        exit();
      }
      return;
    }
    if (key.ctrl && input === "d" && !state.running) {
      onExit();
      exit();
    }
  });

  const { committed, live } = partition(state);
  const spinnerFrame = frame ?? tick;

  return (
    <Box flexDirection="column">
      <Static items={committed}>{(item) => <ItemView key={item.id} item={item} />}</Static>

      {live.map((item) => (
        <ItemView key={item.id} item={item} live />
      ))}

      {state.running ? (
        <Box marginTop={1}>
          <Spinner frame={spinnerFrame} />
          <Text dimColor>
            {" "}
            working · {state.tokens} tok · esc to interrupt
          </Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text dimColor>
            {status.model} · {status.provider}
            {status.live ? "" : " (offline mock)"} · ctrl+c to exit
          </Text>
        </Box>
      )}
    </Box>
  );
}

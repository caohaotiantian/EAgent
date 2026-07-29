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

import type { HistoryState } from "../input/history.js";
import type { SuggestContext } from "../input/suggest.js";
import { cycle, type Mode } from "../modes.js";
import { partition, type TranscriptState } from "../model/transcript.js";
import { Dialog, type Choice } from "./Dialog.js";
import { Status, TaskList, type Task } from "./Status.js";
import { ItemView } from "./items.js";
import { Prompt } from "./Prompt.js";

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
  /** Prompt history; omitted in render-only tests that do not need input. */
  history?: HistoryState;
  onHistoryChange?: (h: HistoryState) => void;
  /** A submitted prompt. Absent means the input box is not shown at all.  */
  onSubmit?: (text: string) => void;
  /** Suggestion sources for the / and @ popups. */
  suggestions?: SuggestContext;
  /** A modal question awaiting an answer — a permission ask or an elicitation.
   *  While one is open it owns the keyboard and the prompt is hidden. */
  pending?: PendingQuestion | null;
  /** The active permission mode, and the sink for Shift+Tab. */
  mode?: Mode;
  onModeChange?: (m: Mode) => void;
  /** Read fresh each render — the model rewrites the whole list per turn. */
  tasks?: Task[];
  /** Ctrl+G handler, threaded to the prompt. */
  externalEdit?: (text: string) => Promise<string | null>;
}

/** A question the agent is blocked on. `detail` renders the tool arguments. */
export interface PendingQuestion {
  question: string;
  detail?: string;
  choices: Choice<string>[];
  allowFreeText?: boolean;
  answer: (value: string) => void;
}

function Spinner({ frame }: { frame: number }): ReactElement {
  return <Text color="cyan">{FRAMES[frame % FRAMES.length]}</Text>;
}

export function App({
  state,
  onInterrupt,
  onExit,
  status,
  frame,
  history,
  onHistoryChange,
  onSubmit,
  suggestions,
  pending,
  mode = "manual",
  onModeChange,
  tasks = [],
  externalEdit,
}: AppProps): ReactElement {
  const { exit } = useApp();
  const [tick, setTick] = useState(0);
  const [showTasks, setShowTasks] = useState(true);
  const [verbose, setVerbose] = useState(false);

  // The spinner is the only thing driving repaints while a tool runs, so it is
  // stopped the moment the turn ends — an idle TUI must be completely quiet.
  useEffect(() => {
    if (!state.running || frame !== undefined) return;
    const t = setInterval(() => setTick((n) => n + 1), 80);
    return () => clearInterval(t);
  }, [state.running, frame]);

  useInput((input, key) => {
    // A modal question owns the keyboard; Esc must close it, not interrupt the
    // turn that is blocked ON it.
    if (pending) return;
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
      return;
    }
    // Shift+Tab cycles the permission mode. Ink reports it as tab with shift.
    if (key.tab && key.shift) {
      onModeChange?.(cycle(mode));
      return;
    }
    if (key.ctrl && input === "t") {
      setShowTasks((v) => !v);
      return;
    }
    if (key.ctrl && input === "o") setVerbose((v) => !v);
  });

  const { committed, live } = partition(state);
  const spinnerFrame = frame ?? tick;

  return (
    <Box flexDirection="column">
      <Static items={committed}>{(item) => <ItemView key={item.id} item={item} />}</Static>

      {live.map((item) => (
        <ItemView key={item.id} item={item} live verbose={verbose} />
      ))}

      {showTasks ? <TaskList tasks={tasks} /> : null}

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
          <Status
            model={status.model}
            provider={status.provider}
            live={status.live}
            mode={mode}
            tokens={state.tokens}
            verbose={verbose}
          />
        </Box>
      )}

      {/* The input box stays mounted while a turn runs — disabled, so the
          transcript owns the keyboard, but visible so the layout does not jump
          every time a turn starts and ends. */}
      {pending ? (
        <Dialog
          question={pending.question}
          detail={pending.detail}
          choices={pending.choices}
          allowFreeText={pending.allowFreeText}
          onAnswer={pending.answer}
        />
      ) : onSubmit && history && onHistoryChange ? (
        <Prompt
          history={history}
          onHistoryChange={onHistoryChange}
          onSubmit={onSubmit}
          disabled={state.running}
          suggestions={suggestions}
          externalEdit={externalEdit}
        />
      ) : null}
    </Box>
  );
}

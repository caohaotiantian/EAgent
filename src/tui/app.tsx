/**
 * The Ink single-session client components (design D1/D3/D4, AC2/AC3/AC4).
 *
 * `Transcript` renders the shared `ViewModel` section tree — reasoning headers,
 * tool cards, and nested subagent cards — as Ink's flat column of `<Text>` rows,
 * windowed to the terminal `rows` (AC4). Collapse/expand and the three display
 * modes are the reducer's `applyControl`; this layer only styles + windows, so it
 * can never diverge from the engine plain renderer on ordering or nesting.
 *
 * `App` drives a `SessionSource` through the `Coalescer` (AC3) into a single piece
 * of React state, tracks live status/usage for the status bar + side panel (shown
 * at >= 100 cols), and routes typed input: `/details`/`/expand`/`/collapse` apply
 * a display control, `/quit` exits, anything else runs a turn. `useInput` needs a
 * raw-mode TTY, so `main.tsx` renders this only on an interactive terminal.
 *
 * The only `ink`/`react` importers in the engine repo live under `src/tui/`
 * (AC9); the model this consumes (`../view-model.js`) stays dependency-free.
 */

import type { ReactElement } from "react";
import { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";

import type { Usage } from "../kernel/types.js";
import { initialModel, type DisplayMode, type ViewModel } from "../view-model.js";
import { Coalescer } from "./coalesce.js";
import { transcriptLines, windowLines, type DisplayLine } from "./lines.js";
import type { SessionSource } from "../session-source.js";

/** Width reserved for the >=100-col side panel (carried from the superseded design). */
const PANEL_WIDTH = 28;

interface LiveStatus {
  running: boolean;
  usage?: Usage;
  /** The most recent elicitation awaiting an answer, surfaced in the status bar. */
  ask?: { id: number; question: string };
}

/** Per-line Ink styling: headers by section kind/status, bodies dimmed. */
function styleFor(line: DisplayLine): { color?: string; dimColor?: boolean; bold?: boolean } {
  if (!line.header) return { dimColor: true };
  switch (line.kind) {
    case "reasoning":
      return { color: "cyan" };
    case "answer":
      return { color: "green", bold: true };
    case "tool":
      return { color: line.status === "error" ? "red" : line.status === "success" ? "green" : "yellow" };
  }
}

export function Transcript({
  model,
  rows,
  columns,
}: {
  model: ViewModel;
  rows?: number;
  columns?: number;
}): ReactElement {
  const all = transcriptLines(model);
  const visible = rows !== undefined ? windowLines(all, rows) : all;
  return (
    <Box flexDirection="column" width={columns}>
      {visible.map((line, i) => {
        const s = styleFor(line);
        return (
          <Text key={i} color={s.color} dimColor={s.dimColor} bold={s.bold}>
            {"  ".repeat(line.indent) + line.text}
          </Text>
        );
      })}
    </Box>
  );
}

function StatusBar({ model, status }: { model: ViewModel; status: LiveStatus }): ReactElement {
  const tokens = status.usage ? status.usage.inputTokens + status.usage.outputTokens : undefined;
  const parts = [
    status.running ? "● running" : "○ idle",
    `mode ${model.mode}`,
    `${model.sections.length} sections`,
  ];
  if (tokens !== undefined) parts.push(`${tokens} tok`);
  return (
    <Box>
      <Text dimColor>{parts.join("  ·  ")}</Text>
    </Box>
  );
}

function InputBar({ value, status }: { value: string; status: LiveStatus }): ReactElement {
  if (status.ask) {
    return (
      <Box>
        <Text color="yellow">? </Text>
        <Text>
          {status.ask.question} {value}
        </Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text bold>{status.running ? "… " : "› "}</Text>
      <Text>{value}</Text>
    </Box>
  );
}

function SidePanel({ model, status }: { model: ViewModel; status: LiveStatus }): ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} marginLeft={1} width={PANEL_WIDTH}>
      <Text bold>Session</Text>
      <Text dimColor>state: {status.running ? "running" : "idle"}</Text>
      <Text dimColor>mode: {model.mode}</Text>
      <Text dimColor>sections: {model.sections.length}</Text>
      {status.usage ? <Text dimColor>tokens: {status.usage.inputTokens + status.usage.outputTokens}</Text> : null}
    </Box>
  );
}

/** Map a typed `/details|/expand|/collapse` line to a control action, or null. */
export function parseControl(line: string): Parameters<Coalescer["applyControl"]>[0] | null {
  const [cmd, arg] = line.slice(1).split(/\s+/, 2);
  if (cmd === "details") {
    if (arg === "full" || arg === "collapsed" || arg === "auto") return { kind: "mode", mode: arg as DisplayMode };
    return null;
  }
  const n = Number(arg);
  if ((cmd === "expand" || cmd === "collapse") && Number.isInteger(n) && n >= 1) return { kind: cmd, n };
  return null;
}

export function App({ source, mode = "auto" }: { source: SessionSource; mode?: DisplayMode }): ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;

  const [model, setModel] = useState<ViewModel>(() => initialModel(mode));
  const [status, setStatus] = useState<LiveStatus>({ running: false });
  const [input, setInput] = useState("");
  // `setModel` is referentially stable (React guarantees), so the coalescer built
  // here commits straight into this component's state.
  const coalescer = useMemo(() => new Coalescer((m) => setModel(m), { mode }), [source, mode]);

  useEffect(() => {
    const sub = source.subscribe((ev) => {
      coalescer.push(ev);
      switch (ev.kind) {
        case "agent_start":
          setStatus((s) => ({ ...s, running: true }));
          break;
        case "agent_end":
          coalescer.flush();
          setStatus((s) => ({ ...s, running: false }));
          break;
        case "usage":
          setStatus((s) => ({ ...s, usage: ev.cumulative }));
          break;
        case "action_required":
          setStatus((s) => ({ ...s, ask: { id: ev.id, question: ev.question } }));
          break;
        default:
          break;
      }
    });
    return () => {
      sub.dispose();
      coalescer.flush();
    };
  }, [source, coalescer]);

  useInput((char, key) => {
    if (key.return) {
      const line = input.trim();
      setInput("");
      if (line === "") return;
      if (status.ask) {
        const { id } = status.ask;
        setStatus((s) => ({ ...s, ask: undefined }));
        void source.answer(id, line);
        return;
      }
      if (line === "/quit" || line === "/exit") {
        source.close();
        exit();
        return;
      }
      if (line.startsWith("/")) {
        const control = parseControl(line);
        if (control) coalescer.applyControl(control);
        return;
      }
      void source.run(line);
      return;
    }
    if (key.ctrl && char === "c") {
      void source.stop();
      return;
    }
    if (key.backspace || key.delete) {
      setInput((s) => s.slice(0, -1));
      return;
    }
    if (char && !key.ctrl && !key.meta) setInput((s) => s + char);
  });

  const wide = columns >= 100;
  // Reserve two rows of chrome (status + input) so the transcript window fits.
  const transcriptRows = Math.max(1, rows - 2);
  const transcriptCols = wide ? columns - PANEL_WIDTH - 1 : columns;

  return (
    <Box flexDirection="column" width={columns}>
      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1}>
          <Transcript model={model} rows={transcriptRows} columns={transcriptCols} />
        </Box>
        {wide ? <SidePanel model={model} status={status} /> : null}
      </Box>
      <StatusBar model={model} status={status} />
      <InputBar value={input} status={status} />
    </Box>
  );
}

export type { DisplayLine, LiveStatus };

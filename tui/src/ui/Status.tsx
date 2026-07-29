/**
 * The footer status area: mode indicator, task checklist, and session facts.
 *
 * The task list is bounded to five rows, like Claude Code's — an agent that
 * plans twenty steps must not push the prompt off the screen.
 */

import { Box, Text } from "ink";
import type { ReactElement } from "react";

import { MODE_INFO, type Mode } from "../modes.js";

export interface Task {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

const MARK: Record<Task["status"], string> = {
  pending: "○",
  in_progress: "◐",
  completed: "✓",
  cancelled: "✗",
};

const COLOR: Record<Task["status"], string | undefined> = {
  pending: undefined,
  in_progress: "cyan",
  completed: "green",
  cancelled: "red",
};

const MAX_TASKS = 5;

export function TaskList({ tasks }: { tasks: Task[] }): ReactElement | null {
  if (tasks.length === 0) return null;

  // Show the unfinished work first: a long completed prefix is the least
  // interesting part of a checklist.
  const ordered = [...tasks].sort((a, b) => Number(a.status === "completed") - Number(b.status === "completed"));
  const shown = ordered.slice(0, MAX_TASKS);
  const hidden = tasks.length - shown.length;

  return (
    <Box flexDirection="column" marginTop={1}>
      {shown.map((t, i) => (
        <Text key={i} color={COLOR[t.status]} dimColor={t.status === "completed"}>
          {MARK[t.status]} {t.content}
        </Text>
      ))}
      {hidden > 0 ? <Text dimColor>… {hidden} more</Text> : null}
    </Box>
  );
}

export interface StatusProps {
  model: string;
  provider: string;
  live: boolean;
  mode: Mode;
  /** Cumulative tokens this session. */
  tokens: number;
  verbose: boolean;
}

export function Status({ model, provider, live, mode, tokens, verbose }: StatusProps): ReactElement {
  const info = MODE_INFO[mode];
  const color = mode === "yolo" ? "red" : mode === "plan" ? "yellow" : "cyan";

  return (
    <Box>
      <Text color={color}>[{info.label}]</Text>
      <Text dimColor>
        {" "}
        {model} · {provider}
        {live ? "" : " (offline mock)"}
        {tokens > 0 ? ` · ${tokens} tok` : ""}
        {verbose ? " · verbose" : ""} · shift+tab mode · ctrl+o verbose · ctrl+c to exit
      </Text>
    </Box>
  );
}

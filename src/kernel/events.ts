/**
 * The kernel's hook contract: the named points at which extensions observe and
 * intervene. This is the agent equivalent of Emacs's standard hooks.
 *
 * `KernelEvents` are notifications (observe). `KernelFilters` are advice
 * (intervene): a value threaded through handlers that may transform or veto.
 */

import type { Message, StopReason, ToolCallBlock, ToolResult, Usage } from "./types.js";

export type KernelEvents = {
  /** A fresh extension runtime has come up (also fired after a reload). */
  session_start: Record<string, never>;
  /** The current extension runtime is tearing down (also before a reload). */
  session_shutdown: Record<string, never>;
  /** A hot reload occurred. */
  reload: { id?: string };

  agent_start: { input: Message };
  agent_end: { reason: StopReason };
  turn_start: { turn: number };
  turn_end: { turn: number };

  /** A completed message was appended to the transcript. */
  message: { message: Message };
  /** Incremental assistant text during streaming. */
  text_delta: { text: string };
  /** Incremental reasoning ("thinking") text, for models that expose it. */
  reasoning_delta: { text: string };

  tool_start: { call: ToolCallBlock };
  tool_end: { call: ToolCallBlock; result: ToolResult };
  /** A parallel tool wave settled; carries the ordered {call,result} pairs. */
  tool_batch_end: { batch: { call: ToolCallBlock; result: ToolResult }[] };

  /** Token usage for the just-finished model call, plus the running total. */
  usage: { usage: Usage; cumulative: Usage };

  error: { error: unknown; where: string };
};

/** The decision object that `beforeToolCall` filters refine. */
export interface ToolDecision {
  block: boolean;
  reason?: string;
  /** Arguments may be rewritten by a guard before execution. */
  arguments: Record<string, unknown>;
}

export type KernelFilters = {
  /** Rewrite the message list just before it is sent to the model. */
  transformContext: {
    value: Message[];
    context: { turn: number; model: string };
  };
  /** Approve, rewrite, or veto a tool call before it runs. */
  beforeToolCall: {
    value: ToolDecision;
    context: { call: ToolCallBlock };
  };
  /** Transform a tool's result before it is appended to the transcript. */
  afterToolCall: {
    value: ToolResult;
    context: { call: ToolCallBlock };
  };
};

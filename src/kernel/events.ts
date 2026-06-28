/**
 * The kernel's hook contract: the named points at which extensions observe and
 * intervene. This is the agent equivalent of Emacs's standard hooks.
 *
 * `KernelEvents` are notifications (observe). `KernelFilters` are advice
 * (intervene): a value threaded through handlers that may transform or veto.
 */

import type {
  Message,
  StopReason,
  ThinkingLevel,
  ToolCallBlock,
  ToolChoice,
  ToolResult,
  ToolSpec,
  Usage,
} from "./types.js";

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
  /** `step` carries the per-run counter after this turn's increment. */
  turn_end: { turn: number; step: number };

  /** A completed message was appended to the transcript. */
  message: { message: Message };
  /** Incremental assistant text during streaming. */
  text_delta: { text: string };
  /** Incremental reasoning ("thinking") text, for models that expose it. */
  reasoning_delta: { text: string };

  tool_start: { call: ToolCallBlock };
  /** `step` carries the call-time (pre-increment) per-run counter. */
  tool_end: { call: ToolCallBlock; result: ToolResult; step: number };
  /** A parallel tool wave settled; carries the ordered {call,result} pairs and the call-time `step`. */
  tool_batch_end: { batch: { call: ToolCallBlock; result: ToolResult }[]; step: number };

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
  /**
   * Reshape the whole outbound request (system prompt, messages, tools, model,
   * toolChoice, thinking) right before the provider call. `transformContext`
   * runs first, so its messages flow in here as `value.messages`. `signal` is
   * excluded — it is abort control, re-attached by the loop after the hook. The
   * `tools` list is advisory to the model: dropping a tool withholds it from the
   * model but does not gate dispatch (resolution stays by name).
   */
  transformRequest: {
    value: {
      systemPrompt: string;
      messages: Message[];
      tools: ToolSpec[];
      model: string;
      toolChoice?: ToolChoice;
      thinking?: ThinkingLevel;
    };
    context: { turn: number; cumulativeUsage: Usage };
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

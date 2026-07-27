/**
 * Pure wire → SourceEvent mapping shared by Node RemoteSource and the web client.
 * No I/O, no Node APIs — browser-safe.
 *
 * Input is a parsed JSON object (one JSONL line or SSE data payload), not raw SSE framing.
 * Prefer wire `actingId`/`rootId` when present (server tags sub-agents); fall
 * back to session for both (flat transcript on older servers).
 */

import type { Role, StopReason, ToolCallBlock, ToolResult, Usage } from "./kernel/types.js";
import type { TaggedEvent } from "./view-model.js";

export type SourceEvent =
  | TaggedEvent
  | { kind: "connected"; session: string | null }
  | { kind: "reconnected"; session: string | null }
  | { kind: "usage"; usage: Usage; cumulative: Usage }
  | { kind: "error"; where: string; message: string }
  | { kind: "action_required"; id: number; question: string; options: string[] | null };

export interface WireEventContext {
  session: string;
  at: number;
}

/**
 * Map a wire JSON object (`type` discriminator from eventToJsonl) to a SourceEvent.
 * Returns undefined for unknown types (ignore, do not throw).
 */
export function wireObjectToSourceEvent(
  p: Record<string, unknown>,
  ctx: WireEventContext,
): SourceEvent | undefined {
  const actingId = typeof p.actingId === "string" && p.actingId ? p.actingId : ctx.session;
  const rootId = typeof p.rootId === "string" && p.rootId ? p.rootId : ctx.session;
  const tag = { actingId, rootId, at: ctx.at };
  switch (p.type) {
    case "text_delta":
      return { kind: "text_delta", text: String(p.text ?? ""), ...tag };
    case "reasoning_delta":
      return { kind: "reasoning_delta", text: String(p.text ?? ""), ...tag };
    case "message":
      return { kind: "message", role: p.role as Role, ...tag };
    case "tool_start": {
      const call: ToolCallBlock = {
        type: "tool_call",
        id: String(p.id ?? ""),
        name: String(p.name ?? ""),
        arguments: (p.arguments as Record<string, unknown>) ?? {},
      };
      return { kind: "tool_start", call, ...tag };
    }
    case "tool_end": {
      const call: ToolCallBlock = {
        type: "tool_call",
        id: String(p.id ?? ""),
        name: String(p.name ?? ""),
        arguments: {},
      };
      const result: ToolResult = {
        content: String(p.content ?? ""),
        isError: Boolean(p.isError),
      };
      return { kind: "tool_end", call, result, ...tag };
    }
    case "agent_end":
      return { kind: "agent_end", reason: p.reason as StopReason, ...tag };
    case "usage":
      return {
        kind: "usage",
        usage: p.usage as Usage,
        cumulative: p.cumulative as Usage,
      };
    case "error":
      return {
        kind: "error",
        where: String(p.where ?? ""),
        message: String(p.message ?? ""),
      };
    case "action_required":
      return {
        kind: "action_required",
        id: Number(p.id),
        question: String(p.question ?? ""),
        options: Array.isArray(p.options) ? (p.options as string[]) : null,
      };
    default:
      return undefined;
  }
}

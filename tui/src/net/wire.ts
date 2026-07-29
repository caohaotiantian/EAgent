/**
 * Wire → transcript-event mapping for the monitor.
 *
 * Re-established in `tui/` per decision D5: the deleted `src/wire-events.ts` was
 * typed against the old view model, so the transport survives but its event
 * vocabulary is the TUI's. Pure — the input is a parsed JSON object (one JSONL
 * line, or one SSE `data:` payload), never raw framing — so the whole mapping is
 * testable with no server.
 *
 * The server tags sub-agent frames with `actingId`/`rootId`; when they are
 * absent (an older server, or a flat transcript) everything reads as the root.
 */

import type { Tagged } from "../model/transcript.js";

/** What the monitor surfaces beyond the transcript itself. */
export type MonitorEvent =
  | Tagged
  | { kind: "connected"; session: string | null }
  | { kind: "action_required"; id: number; question: string; options: string[] | null };

export interface WireContext {
  /** The session this frame belongs to; also the fallback identity. */
  session: string;
  at: number;
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

/**
 * Map one wire object to a monitor event, or `undefined` for a frame this client
 * does not render. Unknown types are IGNORED rather than thrown on: a newer
 * server must not be able to crash an older client.
 */
export function wireToEvent(p: Record<string, unknown>, ctx: WireContext): MonitorEvent | undefined {
  const actingId = str(p["actingId"]) || ctx.session;
  const tag = { actingId, at: ctx.at };

  switch (p["type"]) {
    case "agent_start":
      return { kind: "agent_start", ...tag };
    case "text_delta":
      return { kind: "text_delta", text: str(p["text"]), ...tag };
    case "reasoning_delta":
      return { kind: "reasoning_delta", text: str(p["reasoning"], str(p["text"])), ...tag };
    case "tool_start":
      return {
        kind: "tool_start",
        callId: str(p["id"], str(p["callId"])),
        name: str(p["name"]),
        arguments: (p["arguments"] as Record<string, unknown>) ?? {},
        ...tag,
      };
    case "tool_progress":
      return { kind: "tool_progress", callId: str(p["id"], str(p["callId"])), chunk: str(p["chunk"]), ...tag };
    case "tool_end":
      return {
        kind: "tool_end",
        callId: str(p["id"], str(p["callId"])),
        content: str(p["content"], str(p["result"])),
        isError: p["isError"] === true,
        ...tag,
      };
    case "usage": {
      const u = (p["cumulative"] ?? p["usage"]) as { inputTokens?: number; outputTokens?: number } | undefined;
      return { kind: "usage", total: (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0), ...tag };
    }
    case "error":
      return { kind: "notice", text: `${str(p["where"], "error")}: ${str(p["message"])}`, ...tag };
    case "agent_end":
      return { kind: "agent_end", reason: str(p["reason"], "end_turn"), ...tag };
    case "action_required":
      return {
        kind: "action_required",
        id: typeof p["id"] === "number" ? p["id"] : 0,
        question: str(p["question"]),
        options: Array.isArray(p["options"]) ? (p["options"] as string[]) : null,
      };
    default:
      return undefined;
  }
}

/** True when a monitor event is a transcript event the reducer accepts. */
export const isTranscriptEvent = (e: MonitorEvent): e is Tagged =>
  e.kind !== "connected" && e.kind !== "action_required";

/**
 * Split an SSE buffer into complete `data:` payloads, returning the parsed
 * objects and whatever partial frame is left over. SSE frames are separated by a
 * blank line and can arrive split across chunks, so the remainder must be
 * carried forward rather than dropped.
 */
export function parseSse(buffer: string): { events: Record<string, unknown>[]; rest: string } {
  const events: Record<string, unknown>[] = [];
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";

  for (const frame of parts) {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "") continue;
      try {
        const parsed: unknown = JSON.parse(payload);
        if (parsed && typeof parsed === "object") events.push(parsed as Record<string, unknown>);
      } catch {
        // A malformed frame is skipped, never fatal: one bad line must not kill
        // a long-running monitor session.
      }
    }
  }
  return { events, rest };
}

/** A session as the monitor list shows it. */
export interface SessionSummary {
  id: string;
  running: boolean;
  costUsd?: number;
  tokens?: number;
}

/** Map `GET /sessions` to summaries, tolerating a partial or older payload. */
export function parseSessions(body: unknown): SessionSummary[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((raw): SessionSummary[] => {
    if (raw === null || typeof raw !== "object") return [];
    const o = raw as Record<string, unknown>;
    const id = str(o["id"]);
    if (id === "") return [];
    const usage = o["usage"] as { inputTokens?: number; outputTokens?: number } | undefined;
    return [
      {
        id,
        running: o["running"] === true,
        costUsd: typeof o["costUsd"] === "number" ? o["costUsd"] : undefined,
        tokens: usage ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) : undefined,
      },
    ];
  });
}

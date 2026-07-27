/**
 * The single source of shape truth for the JSONL event stream shared by the CLI
 * `--json` renderer and the HTTP `/run` streamer.
 *
 * `eventToJsonl` is a pure mapper: it turns a lifecycle event (plus the two
 * front-end-supplied terminal/elicitation events) into the exact canonical object
 * both front ends serialize. Key insertion order is load-bearing — `JSON.stringify`
 * emits keys in insertion order, and the front ends' output must stay byte-identical.
 * Kernel-only fields the serializers drop are omitted here: `tool_end.step` and
 * `usage.model`.
 *
 * `wireJsonl` registers the six common streaming handlers on a bus and returns their
 * subscriptions; the terminal (`agent_end`), `error`, and `action_required` events are
 * sourced differently per front end and stay wired by the caller, shaped through this
 * same mapper.
 */

import { currentActingAgent, currentRootAgent, type Agent } from "./kernel/index.js";
import type { ContentBlock, Disposable, Message, Role, StopReason, ToolCallBlock, ToolResult, Usage } from "./kernel/types.js";

/** The `(type, payload)` pairs the mapper accepts. As a rest-parameter tuple union,
 *  switching on `args[0]` narrows `args[1]` — no cast needed. */
type JsonlArgs =
  | [type: "text_delta", payload: { text: string }]
  | [type: "reasoning_delta", payload: { text: string }]
  | [type: "message", payload: { message: Message }]
  | [type: "tool_start", payload: { call: ToolCallBlock }]
  | [type: "tool_end", payload: { call: ToolCallBlock; result: ToolResult; step?: number }]
  | [type: "usage", payload: { usage: Usage; cumulative: Usage; model?: string }]
  | [type: "agent_end", payload: { reason: StopReason; usage: Usage; session?: string }]
  | [type: "error", payload: { where: string; message: string }]
  | [type: "action_required", payload: { id: number; question: string; options?: string[] }];

/** A serialized JSONL event, one shape per event type. */
export type JsonlEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "message"; role: Role; content: ContentBlock[] }
  | { type: "tool_start"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_end"; id: string; name: string; isError: boolean; content: string }
  | { type: "usage"; usage: Usage; cumulative: Usage }
  | { type: "agent_end"; reason: StopReason; usage: Usage; session?: string }
  | { type: "error"; where: string; message: string }
  | { type: "action_required"; id: number; question: string; options: string[] | null };

/** Map one event to its canonical JSONL object. Object literals below fix the key
 *  insertion order the front ends serialize; do not reorder. */
export function eventToJsonl(...args: JsonlArgs): JsonlEvent {
  switch (args[0]) {
    case "text_delta":
      return { type: "text_delta", text: args[1].text };
    case "reasoning_delta":
      return { type: "reasoning_delta", text: args[1].text };
    case "message":
      return { type: "message", role: args[1].message.role, content: args[1].message.content };
    case "tool_start":
      return { type: "tool_start", id: args[1].call.id, name: args[1].call.name, arguments: args[1].call.arguments };
    case "tool_end":
      return {
        type: "tool_end",
        id: args[1].call.id,
        name: args[1].call.name,
        isError: args[1].result.isError ?? false,
        content: args[1].result.content,
      };
    case "usage":
      return { type: "usage", usage: args[1].usage, cumulative: args[1].cumulative };
    case "agent_end": {
      const { reason, usage, session } = args[1];
      return session === undefined
        ? { type: "agent_end", reason, usage }
        : { type: "agent_end", reason, usage, session };
    }
    case "error":
      return { type: "error", where: args[1].where, message: args[1].message };
    case "action_required":
      return { type: "action_required", id: args[1].id, question: args[1].question, options: args[1].options ?? null };
  }
}

/**
 * Register the six common streaming handlers on `agent.hooks`, each emitting its
 * canonical JSONL object, and return their subscriptions for the caller to dispose.
 * The terminal, `error`, and `action_required` events stay wired per front end.
 *
 * When handlers run inside an agent ALS context (`currentActingAgent` /
 * `currentRootAgent`), each object is tagged with stable string `actingId` and
 * `rootId` so remote clients can nest sub-agent work (same identity scheme as
 * `src/attribution.ts`). Outside ALS (unit mocks) the canonical object is
 * emitted unchanged so byte-stable tests keep their golden strings.
 */
export function wireJsonl(emit: (obj: unknown) => void, agent: Agent): Disposable[] {
  const ids = new WeakMap<Agent, string>();
  let counter = 0;
  const idOf = (a: Agent | undefined): string => {
    if (!a) return "root";
    let id = ids.get(a);
    if (id === undefined) {
      id = "a" + counter++;
      ids.set(a, id);
    }
    return id;
  };
  const withActor = (obj: JsonlEvent): unknown => {
    const acting = currentActingAgent();
    const root = currentRootAgent();
    // No ALS → leave the object byte-identical to eventToJsonl alone.
    if (!acting && !root) return obj;
    const rootId = idOf(root ?? acting);
    const actingId = acting ? idOf(acting) : rootId;
    return { ...obj, actingId, rootId };
  };
  return [
    agent.hooks.on("text_delta", (p) => emit(withActor(eventToJsonl("text_delta", p)))),
    agent.hooks.on("reasoning_delta", (p) => emit(withActor(eventToJsonl("reasoning_delta", p)))),
    agent.hooks.on("message", (p) => emit(withActor(eventToJsonl("message", p)))),
    agent.hooks.on("tool_start", (p) => emit(withActor(eventToJsonl("tool_start", p)))),
    agent.hooks.on("tool_end", (p) => emit(withActor(eventToJsonl("tool_end", p)))),
    agent.hooks.on("usage", (p) => emit(withActor(eventToJsonl("usage", p)))),
  ];
}

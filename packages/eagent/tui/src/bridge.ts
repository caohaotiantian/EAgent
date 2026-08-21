/**
 * The agent → transcript bridge.
 *
 * The one place that knows both the kernel's lifecycle events and the reducer's
 * vocabulary. It tags every event with its acting agent — `childScope()` shares
 * the parent's bus, so without this a sub-agent's tokens would merge into the
 * root's answer — and stamps the clock, which the reducer refuses to invent.
 *
 * `subscribe` returns a dispose function that removes every handler, so a
 * remount or a hot reload cannot leave two bridges feeding one reducer.
 */

import { currentActingAgent, type Agent } from "@eagent/core";
import type { Tagged, TranscriptEvent } from "./model/transcript.ts";

export interface BridgeOptions {
  /** Called with each tagged event; the caller folds it into React state. */
  emit: (ev: Tagged) => void;
  /** Injected in tests so ordering assertions do not depend on a real clock. */
  now?: () => number;
}

export function subscribe(agent: Agent, opts: BridgeOptions): () => void {
  const now = opts.now ?? Date.now;

  /** The emitting agent's identity — its own id when a fork is acting. */
  const actor = (): string => {
    const acting = currentActingAgent();
    return acting === undefined || acting === agent ? "root" : "sub";
  };

  const send = (ev: TranscriptEvent): void => opts.emit({ ...ev, actingId: actor(), at: now() });

  const offs = [
    agent.hooks.on("agent_start", () => send({ kind: "agent_start" })),
    agent.hooks.on("reasoning_delta", ({ text }) => send({ kind: "reasoning_delta", text })),
    agent.hooks.on("text_delta", ({ text }) => send({ kind: "text_delta", text })),
    agent.hooks.on("tool_start", ({ call }) =>
      send({ kind: "tool_start", callId: call.id, name: call.name, arguments: call.arguments }),
    ),
    agent.hooks.on("tool_progress", ({ call, chunk }) =>
      send({ kind: "tool_progress", callId: call.id, chunk }),
    ),
    agent.hooks.on("tool_end", ({ call, result }) =>
      send({ kind: "tool_end", callId: call.id, content: result.content, isError: result.isError ?? false }),
    ),
    agent.hooks.on("usage", ({ cumulative }) =>
      send({ kind: "usage", total: cumulative.inputTokens + cumulative.outputTokens }),
    ),
    agent.hooks.on("error", ({ error, where }) =>
      send({ kind: "notice", text: `${where}: ${error instanceof Error ? error.message : String(error)}` }),
    ),
    agent.hooks.on("agent_end", ({ reason }) => {
      // The abnormal-and-otherwise-silent reasons; the clean ends carry their own
      // signal, and an interrupt already showed one.
      if (reason === "max_tokens") send({ kind: "notice", text: "response truncated (max_tokens)" });
      else if (reason === "content_filter") send({ kind: "notice", text: "stopped by the provider content filter" });
      else if (reason === "refusal") send({ kind: "notice", text: "the model declined to answer" });
      send({ kind: "agent_end", reason });
    }),
  ];

  return () => {
    for (const off of offs) off.dispose();
  };
}

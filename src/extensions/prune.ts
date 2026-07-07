/**
 * Token-budget tool-output pruning — the `transformContext` seam.
 *
 * `compact` defends against a long *conversation* by folding the old prefix into
 * a structured summary once the estimated transcript crosses a *token* budget. It
 * does not defend against a *heavy* one: an agentic run can blow the model's
 * context window with only a handful of messages when those messages carry
 * enormous tool outputs — several whole-file reads, a giant grep, a verbose bash
 * dump. Such a run never trips the conversation budget yet still overflows.
 *
 * This extension is the complementary, token-size defense. It walks the
 * transcript backward, keeps the most recent tool outputs verbatim, and
 * truncates the older, oversized ones — a cheap, provider-free trim that targets
 * the single biggest space consumer in agentic context (tool results) without
 * summarizing or calling the model. It returns a NEW message array and never
 * mutates the durable transcript, the same contract `compact` holds.
 */

import type { ExtensionAPI } from "../kernel/extension.js";
import type { Config } from "../kernel/store.js";
import type { Message, ToolResultBlock } from "../kernel/types.js";

/** Cumulative-token budget below which recent tool outputs are kept verbatim. */
const PRUNE_PROTECT = 40_000;
/** Reclaimable-token floor: trim only when this much can actually be freed. */
const PRUNE_MINIMUM = 20_000;
/** Each pruned output is truncated to this many leading characters. */
const TOOL_OUTPUT_MAX_CHARS = 2_000;

/** A tokenizer-free estimate matching opencode's `chars / 4` heuristic. */
function est(s: string): number {
  return Math.max(0, Math.round(s.length / 4));
}

/** Keep the head plus a marker line naming how many characters were elided. */
function truncate(s: string): string {
  return (
    s.slice(0, TOOL_OUTPUT_MAX_CHARS) +
    "\n… [pruned " +
    (s.length - TOOL_OUTPUT_MAX_CHARS) +
    " chars to free context]"
  );
}

/**
 * Truncate old, oversized `tool_result` content beyond a protected recent
 * window, returning a new message array. A pure, synchronous function: it reads
 * its own kill switch (`prune`) through the supplied `config`, never mutates the
 * input, and reuses untouched messages and blocks by reference. With no `config`
 * (direct callers/tests) it is unconditionally enabled.
 */
export function pruneMessages(messages: Message[], config?: Config): Message[] {
  if (config && !config.enabled("prune", { default: true })) return messages;

  let turns = 0;
  let total = 0;
  let pruned = 0;
  const targets = new Set<ToolResultBlock>();

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user") turns++;
    if (m.meta?.kind === "summary") break;
    if (turns < 2) continue;

    for (const block of m.content) {
      if (block.type !== "tool_result") continue;
      total += est(block.content);
      if (total <= PRUNE_PROTECT) continue;
      pruned += est(block.content);
      if (block.content.length > TOOL_OUTPUT_MAX_CHARS) targets.add(block);
    }
  }

  if (pruned <= PRUNE_MINIMUM || targets.size === 0) return messages;

  return messages.map((m) => {
    if (!m.content.some((b) => b.type === "tool_result" && targets.has(b))) return m;
    const content = m.content.map((b) =>
      b.type === "tool_result" && targets.has(b) ? { ...b, content: truncate(b.content) } : b,
    );
    return { ...m, content };
  });
}

export default function activate(e: ExtensionAPI): void {
  e.hook("transformContext", (messages) => pruneMessages(messages, e.config));
}

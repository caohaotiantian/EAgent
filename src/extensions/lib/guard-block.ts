/**
 * Guard-block detection — recognize a dispatcher "tool call blocked" result on
 * `tool_end`, with zero kernel change.
 *
 * When a `beforeToolCall` guard vetoes a call, the kernel dispatcher returns a
 * bare error result whose content leads with a fixed prefix. That prefix is the
 * one free, reliable signal that distinguishes a guard block from an ordinary
 * tool error on the `tool_end` event. This helper isolates the coupling to that
 * message format in ONE place, so telemetry consumers (`otel-exporter`, `trace`)
 * share a single detection point instead of each re-inlining the brittle string.
 *
 * CO-MAINTENANCE: `GUARD_BLOCK_PREFIX` mirrors the literal produced at TWO
 * byte-identical sites — keep all three in sync:
 *   - `src/kernel/agent.ts` (the dispatcher; the ONLY producer that reaches
 *     `tool_end`, hence the telemetry source).
 *   - `src/extensions/dynamic-workflow.ts` (the workflow guard mirror; it emits
 *     no `tool_start`/`tool_end`, so its blocks never reach telemetry).
 * A kernel message change breaks `test/guard-block.test.ts` loudly (fast signal).
 *
 * Detection reads the POST-`afterToolCall` result: current `afterToolCall`
 * filters only append to or replace a block result, never prepend, so a
 * leading-prefix check stays robust.
 */

import type { ToolResult } from "../../kernel/types.js";

/** The kernel dispatcher's block-message prefix (see `src/kernel/agent.ts`). */
export const GUARD_BLOCK_PREFIX = "Tool call blocked: ";

/** True when `result` is a dispatcher guard-block: an error whose content leads with the prefix. */
export function isGuardBlock(result: ToolResult): boolean {
  return (
    !!result.isError &&
    typeof result.content === "string" &&
    result.content.startsWith(GUARD_BLOCK_PREFIX)
  );
}

/** The block reason — the text after the prefix; an empty string for a non-block result. */
export function blockReason(result: ToolResult): string {
  return isGuardBlock(result) ? result.content.slice(GUARD_BLOCK_PREFIX.length) : "";
}

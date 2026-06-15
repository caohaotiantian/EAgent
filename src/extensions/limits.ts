/**
 * Resource guardrails as a pure hook consumer.
 *
 * A long-running or adversarial agent can blow up two budgets that the minimal
 * core deliberately holds no opinion about: the size of any single tool output
 * (a `bash cat bigfile` can dump megabytes straight into the context window) and
 * the number of tool calls a single run may make (a buggy or hostile model can
 * loop on a tool forever). This extension caps both — it truncates oversized
 * tool outputs via `afterToolCall` and enforces a per-run tool-call budget via
 * `agent_start` plus `beforeToolCall` — entirely through the public hook surface.
 *
 * This is exactly the kind of policy that belongs in an extension, not the
 * kernel: the loop stays small and unopinionated while the guardrails live,
 * observably and replaceably, out here. Limits read from `e.store`, so a host or
 * the `/limits` command can retune them at runtime. Every hook is defensive and
 * never throws, because a guardrail that crashes the run it guards is worse than
 * no guardrail at all.
 */

import type { ExtensionAPI } from "../kernel/extension.js";
import type { ToolResult } from "../kernel/types.js";
import type { ToolDecision } from "../kernel/events.js";

/** Cap on a single tool's output, in bytes, before it is truncated. */
const DEFAULT_MAX_TOOL_OUTPUT_BYTES = 16384;
/** Cap on how many tool calls a single `agent.run` may make. */
const DEFAULT_MAX_TOOL_CALLS_PER_RUN = 100;

interface LimitsConfig {
  maxToolOutputBytes: number;
  maxToolCallsPerRun: number;
}

/** The store keys the config is persisted under. */
const KEYS = {
  maxToolOutputBytes: "maxToolOutputBytes",
  maxToolCallsPerRun: "maxToolCallsPerRun",
} as const;

export default function activate(e: ExtensionAPI): () => void {
  /**
   * Per-run tool-call counter. In-memory and reset on `agent_start`, because it
   * is meaningful only within a single run — it must not survive across runs or
   * a reload (the budget is "this run", not "ever").
   */
  let toolCallsThisRun = 0;

  /**
   * Read a positive-integer config value from the store, falling back to its
   * default for anything missing, non-numeric, NaN, or non-positive. Limits are
   * a safety mechanism, so an odd value can never silently disable a cap.
   */
  const readPositiveInt = (key: string, fallback: number): number => {
    const raw = e.store.get<unknown>(key);
    const n =
      typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return Math.floor(n);
    return fallback;
  };

  const config = (): LimitsConfig => ({
    maxToolOutputBytes: readPositiveInt(KEYS.maxToolOutputBytes, DEFAULT_MAX_TOOL_OUTPUT_BYTES),
    maxToolCallsPerRun: readPositiveInt(KEYS.maxToolCallsPerRun, DEFAULT_MAX_TOOL_CALLS_PER_RUN),
  });

  // --- 1. Tool-output truncation ------------------------------------------
  //
  // Transform an oversized result's `content` down to the byte cap, appending a
  // clear marker so the model knows the output was clipped. `isError` and the
  // structured `details` are preserved — truncation is about the context window,
  // not about changing the meaning of the result.
  const offTruncate = e.hook("afterToolCall", (result: ToolResult): ToolResult => {
    try {
      const limit = config().maxToolOutputBytes;
      const content = result.content ?? "";
      const total = Buffer.byteLength(content, "utf8");
      if (total <= limit) return result;
      const shown = truncateToBytes(content, limit);
      const shownBytes = Buffer.byteLength(shown, "utf8");
      return {
        ...result,
        content: `${shown}\n\n[output truncated: ${shownBytes} of ${total} bytes shown]`,
      };
    } catch (err) {
      e.log.warn("limits: truncation hook error:", err);
      return result;
    }
  });

  // --- 2. Per-run tool-call budget ----------------------------------------
  //
  // Reset the counter at the start of every run, then count and gate each call.
  const offReset = e.on("agent_start", () => {
    toolCallsThisRun = 0;
  });

  const offBudget = e.hook("beforeToolCall", (decision: ToolDecision): ToolDecision => {
    try {
      if (decision.block) return decision; // already vetoed by another guard
      const max = config().maxToolCallsPerRun;
      toolCallsThisRun += 1;
      if (toolCallsThisRun > max) {
        return {
          ...decision,
          block: true,
          reason: `tool-call budget (${max}) exceeded for this run`,
        };
      }
      return decision;
    } catch (err) {
      e.log.warn("limits: budget hook error:", err);
      return decision;
    }
  });

  // --- 3. /limits command --------------------------------------------------
  const offCommand = e.registerCommand({
    name: "limits",
    description:
      "Show or set resource guardrails (e.g. /limits maxToolOutputBytes=1024 maxToolCallsPerRun=50).",
    run: (ctx) => {
      const args = ctx.args.trim();
      if (args.length > 0) {
        // Parse simple key=value pairs, validate, and persist the recognized ones.
        for (const pair of args.split(/\s+/)) {
          const eq = pair.indexOf("=");
          if (eq <= 0) {
            ctx.print(`limits: ignoring "${pair}" (expected key=value)`);
            continue;
          }
          const key = pair.slice(0, eq);
          const value = pair.slice(eq + 1);
          if (key !== KEYS.maxToolOutputBytes && key !== KEYS.maxToolCallsPerRun) {
            ctx.print(`limits: unknown key "${key}"`);
            continue;
          }
          const n = Number(value);
          if (!Number.isFinite(n) || n <= 0) {
            ctx.print(`limits: "${key}" must be a positive number (got "${value}")`);
            continue;
          }
          e.store.set(key, Math.floor(n));
        }
      }
      const cfg = config();
      ctx.print(`maxToolOutputBytes=${cfg.maxToolOutputBytes}`);
      ctx.print(`maxToolCallsPerRun=${cfg.maxToolCallsPerRun}`);
      ctx.print(`toolCallsThisRun=${toolCallsThisRun}`);
    },
  });

  return () => {
    for (const d of [offCommand, offBudget, offReset, offTruncate]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}

/**
 * Truncate a string so its UTF-8 byte length is at most `limit`, without
 * splitting a multi-byte character. We slice optimistically by code units, then
 * trim back one code point at a time until the byte budget is met.
 */
function truncateToBytes(s: string, limit: number): string {
  if (limit <= 0) return "";
  if (Buffer.byteLength(s, "utf8") <= limit) return s;
  // Each char is at most 4 UTF-8 bytes, so `limit` code units is a safe upper
  // bound to start from; then shrink until we fit.
  let end = Math.min(s.length, limit);
  let out = s.slice(0, end);
  while (end > 0 && Buffer.byteLength(out, "utf8") > limit) {
    end -= 1;
    out = s.slice(0, end);
  }
  return out;
}
